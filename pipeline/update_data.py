#!/usr/bin/env python3
"""
update_data.py — six-region Cloudflare candidate-IP pipeline.

Design (implements phase-2 requirements, section 4):

  Four recorded concepts, kept separate in audit JSON:
    - access PoP   : the Cloudflare colo our probe connected to (trace `colo=`)
    - worker runloc: not determinable from a probe; recorded as "not_applicable"
    - proxyip role : candidates here are *entry* IPs for WS+TLS to a Worker or
                     fallback relay; recorded in `role`
    - exit IP      : only observable by the Worker itself at runtime; recorded
                     as "not_observed_by_pipeline" (never claimed)

  Region truth: a candidate is only labeled <region> when its /cdn-cgi/trace
  response (TLS, SNI = the candidate) contains colo=<airport code for region>.
  Anything else -> UNKNOWN, and UNKNOWN rows are never written to data files.

  Update contract:
    - merge old valid rows (last_checked refreshed only after re-check);
    - keep old rows when sources fail (no wipe on outage);
    - every run writes meta (time, source, counts) + exit code reflects failure;
    - failures print GitHub Actions error annotations (no silent failure).

Usage:
    python3 pipeline/update_data.py --data-dir data --probe-limit 40 --timeout 5
"""

import argparse
import concurrent.futures as cf
import ipaddress
import json
import random
import socket
import ssl
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import urllib.request

REGIONS = ["hk", "jp", "sg", "us", "de", "nl"]
COLO_MAP = {
    "hk": {"HKG"},
    "jp": {"NRT", "KIX", "FUK"},
    "sg": {"SIN"},
    "us": {"LAX", "SJC", "SEA", "ORD", "DFW", "IAD", "MIA", "EWR", "ATL", "MCI"},
    "de": {"FRA"},
    "nl": {"AMS"},
}
PIPELINE_DIR = Path(__file__).resolve().parent
DATA_DIR_DEFAULT = PIPELINE_DIR.parent / "data"

UA = "cfip-regions-pipeline/0.1 (+https://github.com/)"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg: str) -> None:
    print(f"[{now_iso()}] {msg}", flush=True)


def gh_error(msg: str) -> None:
    """GitHub Actions error annotation — visible in the run summary."""
    print(f"::error:: {msg}", flush=True)


def gh_warn(msg: str) -> None:
    print(f"::warning:: {msg}", flush=True)


def http_get(url: str, timeout: float = 15.0) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def fetch_official_ranges(timeout: float) -> list:
    """Cloudflare official IPv4 ranges (https://www.cloudflare.com/ips-v4)."""
    text = http_get("https://www.cloudflare.com/ips-v4", timeout)
    nets = [ipaddress.ip_network(line.strip()) for line in text.splitlines() if line.strip()]
    log(f"official ranges fetched: {len(nets)} networks")
    return nets


def sample_candidates(nets: list, per_net: int, cap: int) -> list:
    """Deterministic-ish random sample: first N usable host addresses per net."""
    cands = []
    for net in nets:
        hosts = iter(list(net.hosts()))
        for _ in range(per_net):
            try:
                cands.append(str(next(hosts)))
            except StopIteration:
                break
        if len(cands) >= cap:
            break
    random.shuffle(cands)
    return cands[:cap]


def tcp_connectable(ip: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def probe_colo(ip: str, timeout: float) -> dict:
    """
    TLS-connect to the candidate IP with SNI=cloudflare.com (fronting the real
    CF edge), GET /cdn-cgi/trace, and read colo= / loc= / ip= fields.
    Returns {"ip", "colo", "loc", "ok"}.
    """
    ctx = ssl.create_default_context()
    ctx.check_hostname = False          # SNI fronting: cert is for cloudflare.com
    ctx.verify_mode = ssl.CERT_NONE     # but we do not rely on cert identity for colo truth
    out = {"ip": ip, "colo": "", "loc": "", "ok": False}
    try:
        with socket.create_connection((ip, 443), timeout=timeout) as raw:
            raw.settimeout(timeout)
            with ctx.wrap_socket(raw, server_hostname="cloudflare.com") as tls:
                tls.sendall(
                    b"GET /cdn-cgi/trace HTTP/1.1\r\n"
                    b"Host: cloudflare.com\r\n"
                    b"User-Agent: " + UA.encode() + b"\r\n"
                    b"Connection: close\r\n\r\n"
                )
                buf = b""
                while b"\r\n\r\n" not in buf and len(buf) < 8192:
                    chunk = tls.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                # body follows the header separator; trace body is key=value lines
                body = buf.split(b"\r\n\r\n", 1)[1] if b"\r\n\r\n" in buf else b""
                fields = {}
                for line in body.decode("utf-8", "replace").splitlines():
                    if "=" in line:
                        k, _, v = line.partition("=")
                        fields[k.strip()] = v.strip()
                out["colo"] = fields.get("colo", "")
                out["loc"] = fields.get("loc", "")
                out["ok"] = out["colo"] != ""
    except OSError as e:
        out["error"] = str(e)
    return out


def classify(probe: dict) -> str:
    """Return region label if the colo proves it, else UNKNOWN."""
    colo = probe.get("colo", "")
    if not colo:
        return "UNKNOWN"
    for region, codes in COLO_MAP.items():
        if colo in codes:
            return region
    return "UNKNOWN"


def load_previous(path: Path) -> dict:
    """Load previous audit state; tolerate absence/corruption (keep-last-valid)."""
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        gh_warn(f"previous audit unreadable ({e}); starting fresh, old data files kept")
        return {}


def prev_rows_flat(prev: dict) -> list:
    """
    Flatten audit['rows'] into a list of row dicts.

    G-1 regression guard: write_outputs stores rows as {region: [row, ...]} (a
    dict). This helper accepts BOTH the current dict layout and any legacy
    flat list, and skips malformed entries instead of crashing.
    """
    rows = prev.get("rows") if isinstance(prev, dict) else None
    if isinstance(rows, dict):
        out = []
        for v in rows.values():
            if isinstance(v, list):
                out.extend(x for x in v if isinstance(x, dict))
        return out
    if isinstance(rows, list):
        return [x for x in rows if isinstance(x, dict)]
    return []


def merge_rows(prev_rows: list, probes: list, timeout: float, workers: int) -> dict:
    """
    Re-check previously valid rows + probe new candidates.
    Returns {"rows": {region: [row...]}, "unknown": [row...], "stats": {...}}
    Row: {ip, region, colo, source, first_seen, last_checked, status}

    Failure policy (G-2):
      - partial probe success  -> failed previous rows are genuinely dead: evicted;
      - TOTAL probe failure    -> treated as a probe-layer outage: previous rows are
        kept and demoted to STALE with their ORIGINAL last_checked (never wiped);
      - source failures never reach this function (main returns RC=2 earlier).
    """
    candidates = {}  # ip -> row (from previous, OK or STALE) or None (new candidate)

    for r in prev_rows_flat(prev_rows):
        ip = r.get("ip", "")
        status = r.get("status", "OK")
        if ip and status in ("OK", "STALE"):
            candidates[ip] = {
                "ip": ip,
                "region": r.get("region", "UNKNOWN"),
                "colo": r.get("colo", ""),
                "source": r.get("source", "previous"),
                "first_seen": r.get("first_seen", now_iso()),
                "last_checked": r.get("last_checked", ""),
                "status": status,
            }

    # new candidates not already tracked
    for p in probes:
        if p["ip"] not in candidates:
            candidates[p["ip"]] = None

    # probe everything (old rows get refreshed last_checked; failing ones die)
    ips = list(candidates.keys())
    log(f"probing {len(ips)} unique IPs with {workers} workers")
    results = {}
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(probe_colo, ip, timeout): ip for ip in ips}
        for fut in cf.as_completed(futs):
            ip = futs[fut]
            try:
                results[ip] = fut.result()
            except Exception as e:  # defensive: probe must never kill the run
                results[ip] = {"ip": ip, "colo": "", "ok": False, "error": str(e)}

    merged = {region: [] for region in REGIONS}
    unknown_rows = []
    stats = {"probed": len(results), "reachable_colo": 0, "region_matched": 0,
             "evicted_previous": 0, "kept_previous": 0,
             "probe_outage": False, "stale_kept": 0}

    reachable = sum(1 for pr in results.values() if pr.get("ok"))

    # ---- G-2: total probe failure => probe-layer outage, keep previous as STALE ----
    if reachable == 0 and any(row is not None for row in candidates.values()):
        log("probe-layer outage: zero reachable candidates; keeping previous rows as STALE")
        stats["probe_outage"] = True
        for ip, row in candidates.items():
            if row is None:
                continue  # new candidate, unverifiable this round -> dropped
            stale = dict(row)
            stale["status"] = "STALE"
            stale["role"] = "candidate_entry"
            stale["worker_runloc"] = "not_applicable"
            stale["exit_ip"] = "not_observed_by_pipeline"
            if stale.get("region") in REGIONS:
                merged[stale["region"]].append(stale)
            stats["stale_kept"] += 1
        for region in REGIONS:
            merged[region].sort(key=lambda r: r["ip"])
        return {"rows": merged, "unknown": unknown_rows, "stats": stats}

    for ip, row in candidates.items():
        pr = results.get(ip, {"ip": ip, "colo": "", "ok": False})
        if not pr.get("ok"):
            if row is not None:
                stats["evicted_previous"] += 1
            continue  # dead candidate dropped (partial-failure: genuinely dead)
        stats["reachable_colo"] += 1
        region = classify(pr)
        new_row = {
            "ip": ip,
            "region": region,
            "colo": pr.get("colo", ""),
            "source": row["source"] if row else "colo-probe",
            "first_seen": row["first_seen"] if row else now_iso(),
            "last_checked": now_iso(),
            "status": "OK" if region != "UNKNOWN" else "UNKNOWN",
            "role": "candidate_entry",          # proxyip/candidate entry, NOT exit IP
            "worker_runloc": "not_applicable",  # worker location is a deployment fact
            "exit_ip": "not_observed_by_pipeline",
        }
        if region == "UNKNOWN":
            unknown_rows.append(new_row)
        else:
            stats["region_matched"] += 1
            if row is not None:
                stats["kept_previous"] += 1
            merged[region].append(new_row)

    for region in REGIONS:
        merged[region].sort(key=lambda r: r["ip"])
    return {"rows": merged, "unknown": unknown_rows, "stats": stats}


def write_outputs(data_dir: Path, merged: dict, meta: dict) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    for region in REGIONS:
        rows = merged["rows"][region]
        path = data_dir / f"{region.upper()}.txt"
        header = (
            f"# {region.upper()} candidates — generated by pipeline/update_data.py\n"
            f"# meta_updated={meta['updated_at']} source={meta['source']}\n"
            f"# format: address|region|source|first_seen|last_checked|status\n"
            f"# status: OK = verified this round; STALE = kept from the last successful\n"
            f"#         round after a probe-layer outage (last_checked = that round's time)\n"
            f"# truth: trace colo in {sorted(COLO_MAP[region])}; UNKNOWN rows are never written\n"
            f"# publish rule: subscriptions may only include status=OK rows\n"
        )
        if rows:
            lines = [f"{r['ip']}|{region}|{r['source']}|{r['first_seen']}|{r['last_checked']}|{r['status']}"
                     for r in rows]
            path.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")
        else:
            # honest empty: rows genuinely evicted this round -> replace file with marker.
            # (source-failure rounds never reach write_outputs; outage rounds keep STALE rows)
            path.write_text(header + "# EMPTY — no verified candidates; NOT fabricated\n",
                            encoding="utf-8")
            gh_warn(f"{region}: zero candidates after this run")

    audit = {
        "meta": meta,
        "stats": merged["stats"],
        "rows": merged["rows"],
        "unknown_sample": merged["unknown"][:50],
    }
    (data_dir / "audit.json").write_text(json.dumps(audit, indent=2), encoding="utf-8")
    log(f"audit written: {json.dumps(merged['stats'])}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", default=str(DATA_DIR_DEFAULT))
    ap.add_argument("--probe-limit", type=int, default=60,
                    help="max new candidates to probe this run")
    ap.add_argument("--per-net", type=int, default=2,
                    help="sample addresses per official /24-ish network")
    ap.add_argument("--timeout", type=float, default=5.0, help="probe timeout seconds")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--ranges-file", default=None,
                    help="optional local text file of CIDRs (offline/test mode)")
    args = ap.parse_args(argv)

    data_dir = Path(args.data_dir)
    started = now_iso()
    rc = 0

    try:
        if args.ranges_file:
            nets = []
            for line in Path(args.ranges_file).read_text().splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                nets.append(ipaddress.ip_network(line))
            log(f"offline ranges file used: {len(nets)} networks")
            source = f"ranges-file:{args.ranges_file}"
        else:
            nets = fetch_official_ranges(args.timeout)
            source = "https://www.cloudflare.com/ips-v4"
    except Exception as e:
        gh_error(f"cannot fetch Cloudflare official ranges: {e}")
        # keep-last-valid: leave data untouched, but fail loudly
        return 2

    if not nets:
        # source returned nothing usable: same policy as a source failure
        gh_error("source returned zero networks; keeping previous data untouched")
        return 2

    prev = load_previous(data_dir / "audit.json")
    candidates = sample_candidates(nets, args.per_net, args.probe_limit)
    log(f"new candidates sampled: {len(candidates)}")

    merged = merge_rows(prev, [{"ip": ip} for ip in candidates],
                        args.timeout, args.workers)

    meta = {
        "updated_at": started,
        "source": source,
        "probe_limit": args.probe_limit,
        "colo_truth": "cdn-cgi/trace colo field",
        "probe_outage": merged["stats"]["probe_outage"],
        "stale_count": merged["stats"]["stale_kept"],
        "concepts": {
            "access_pop": "trace colo (verified)",
            "worker_runloc": "not_applicable (deployment fact)",
            "proxyip_role": "candidate_entry (fallback relay when labeled)",
            "exit_ip": "not_observed_by_pipeline",
        },
    }
    write_outputs(data_dir, merged, meta)

    if merged["stats"]["probe_outage"]:
        gh_error("probe-layer outage: all probes failed; previous data kept as STALE "
                 f"({merged['stats']['stale_kept']} rows, original last_checked preserved)")
        rc = 1
    elif merged["stats"]["region_matched"] == 0:
        gh_error("no candidate matched any region colo; data files unchanged or empty")
        rc = 1
    empty = [r for r in REGIONS if not merged["rows"][r]]
    if empty:
        gh_warn(f"regions with zero candidates: {', '.join(empty)}")
    return rc


if __name__ == "__main__":
    sys.exit(main())
