#!/usr/bin/env python3
"""
test_update_data.py — regression tests for pipeline/update_data.py (G-1 / G-2).

Fully deterministic: probe_colo is monkeypatched (no network), ranges come from
a per-run TEMP-DIR fixture (TEST-NET CIDRs; never touches the project tree),
and random sampling is seeded.

Covers the mandated matrix:
  G-1: first run, second run, 10 consecutive runs, empty audit, missing audit,
       corrupt audit, rows-as-dict structure assertion.
  G-2: partial probe failure, total probe failure (STALE keep, last_checked
       preserved), source unavailable, source empty, history file corruption,
       next-round recovery, multi-failure recovery.

Run: python3 pipeline/test_update_data.py   (exit 0 = all pass)
"""

import json
import random
import shutil
import sys
import tempfile
import io
import contextlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import update_data  # noqa: E402  (importable: guarded by __main__)


PASS, FAIL = [], []


def ok(name, cond, detail=""):
    PASS.append(name) if cond else FAIL.append(name)
    detail = str(detail) if detail else ""
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  — ' + detail) if detail else ''}")


def write_fixture_ranges(path, cidrs):
    path.write_text("\n".join(cidrs) + "\n", encoding="utf-8")


def make_probe_map(good_us=(), good_de=(), everything_else_fail=True):
    """ip -> fake trace result."""
    m = {}
    for ip in good_us:
        m[ip] = {"ip": ip, "colo": "EWR", "loc": "US", "ok": True}
    for ip in good_de:
        m[ip] = {"ip": ip, "colo": "FRA", "loc": "DE", "ok": True}
    return m


class FakeProber:
    """Monkeypatch target: deterministic per-IP results with an outage switch."""

    def __init__(self):
        self.results = {}
        self.outage = False  # True => every probe fails

    def __call__(self, ip, timeout):
        if self.outage:
            return {"ip": ip, "colo": "", "loc": "", "ok": False, "error": "simulated outage"}
        r = self.results.get(ip)
        if r is not None:
            return dict(r)
        return {"ip": ip, "colo": "", "loc": "", "ok": False, "error": "unreachable"}


def run_pipeline(data_dir, prober, ranges=None, extra=None):
    if ranges is None:
        ranges = default_ranges(data_dir)
    """Run update_data.main() with patched probing; capture output; return (rc, out)."""
    orig = update_data.probe_colo
    update_data.probe_colo = prober
    update_data.random.seed(1234)
    argv = ["--data-dir", str(data_dir), "--ranges-file", str(ranges),
            "--probe-limit", "6", "--per-net", "3", "--timeout", "1", "--workers", "4"]
    if extra:
        argv += extra
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc = update_data.main(argv)
    finally:
        update_data.probe_colo = orig
    return rc, buf.getvalue()


def seed_audit(data_dir, us_rows, de_rows=()):
    """Write an audit.json in the exact format write_outputs produces."""
    audit = {
        "meta": {"updated_at": "2026-11-19T00:00:00Z", "source": "seed"},
        "stats": {},
        "rows": {
            "hk": [], "jp": [], "sg": [], "nl": [],
            "us": [dict(r) for r in us_rows],
            "de": [dict(r) for r in de_rows],
        },
        "unknown_sample": [],
    }
    (Path(data_dir) / "audit.json").write_text(json.dumps(audit), encoding="utf-8")


def row(ip, region="us", colo="EWR", status="OK",
        first="2026-11-18T00:00:00Z", checked="2026-11-19T00:00:00Z"):
    return {"ip": ip, "region": region, "colo": colo, "source": "seed",
            "first_seen": first, "last_checked": checked, "status": status}


def data_lines(data_dir, region):
    p = Path(data_dir) / f"{region.upper()}.txt"
    if not p.exists():
        return None
    return [l for l in p.read_text(encoding="utf-8").splitlines()
            if l.strip() and not l.startswith("#")]


def audit_of(data_dir):
    return json.loads((Path(data_dir) / "audit.json").read_text(encoding="utf-8"))


def fresh_dir():
    """
    Create an isolated temp workspace (3B-1: fixture temp-dir migration).

    The ranges fixture is written INSIDE the temp dir — the regression suite
    must never write into the project tree (previously it rewrote
    pipeline/test_ranges_fixture.txt on every run; content was identical but
    the project file mtime churned).
    """
    d = Path(tempfile.mkdtemp(prefix="cfip-test-"))
    write_fixture_ranges(d / "ranges.txt",
                         ["198.51.100.0/24", "203.0.113.0/24"])  # TEST-NET-2/3
    return d


def default_ranges(data_dir):
    """Per-workspace fixture path (temp dir only)."""
    return Path(data_dir) / "ranges.txt"


# ---------------------------------------------------------------- G-1 tests --

def t_first_run():
    d = fresh_dir()
    prober = FakeProber()
    prober.results = make_probe_map(good_us=["198.51.100.1"], good_de=["203.0.113.1"])
    rc, out = run_pipeline(d, prober)
    ok("first run: rc==0", rc == 0, f"rc={rc}")
    ok("first run: US.txt has OK line", any(l.endswith("|OK") for l in data_lines(d, "us") or []),
       str(data_lines(d, "us")))
    a = audit_of(d)
    ok("first run: audit rows is dict", isinstance(a["rows"], dict))
    ok("first run: rows keys == six regions",
       sorted(a["rows"].keys()) == sorted(update_data.REGIONS))


def t_second_run():
    d = fresh_dir()
    prober = FakeProber()
    prober.results = make_probe_map(good_us=["198.51.100.1"], good_de=["203.0.113.1"])
    rc1, _ = run_pipeline(d, prober)
    # second round: same IP healthy + one new healthy candidate
    prober.results = make_probe_map(good_us=["198.51.100.1", "198.51.100.2"],
                                    good_de=["203.0.113.1"])
    rc2, out = run_pipeline(d, prober)  # G-1: must NOT raise AttributeError
    ok("second run: no crash, rc==0", rc2 == 0, f"rc1={rc1} rc2={rc2}")
    a = audit_of(d)
    ok("second run: kept_previous>=1", a["stats"]["kept_previous"] >= 1, str(a["stats"]))
    ok("second run: new candidate added", len(a["rows"]["us"]) == 2, str(a["rows"]["us"]))


def t_ten_rounds():
    d = fresh_dir()
    prober = FakeProber()
    rcs = []
    try:
        for i in range(10):
            prober.results = make_probe_map(
                good_us=[f"198.51.100.{1 + (i % 3)}"],
                good_de=["203.0.113.1"])
            rc, _ = run_pipeline(d, prober)
            rcs.append(rc)
        ok("10 consecutive runs: no exception", True, f"rcs={rcs}")
        ok("10 consecutive runs: final US rows within 1..3", 1 <= len(audit_of(d)["rows"]["us"]) <= 3)
    except Exception as e:
        ok("10 consecutive runs: no exception", False, f"{type(e).__name__}: {e}")


def t_empty_audit_file():
    d = fresh_dir()
    (d / "audit.json").write_text("", encoding="utf-8")
    prober = FakeProber()
    prober.results = make_probe_map(good_us=["198.51.100.1"])
    rc, out = run_pipeline(d, prober)
    ok("empty audit file: tolerated, rc==0", rc == 0, f"rc={rc}")


def t_missing_audit():
    d = fresh_dir()
    prober = FakeProber()
    prober.results = make_probe_map(good_us=["198.51.100.1"])
    rc, out = run_pipeline(d, prober)
    ok("missing audit: treated as first run, rc==0", rc == 0, f"rc={rc}")


def t_corrupt_audit():
    d = fresh_dir()
    (d / "audit.json").write_text("{not json!!", encoding="utf-8")
    prober = FakeProber()
    prober.results = make_probe_map(good_us=["198.51.100.1"])
    rc, out = run_pipeline(d, prober)
    ok("corrupt audit: warning logged", "unreadable" in out, out.splitlines()[0] if out else "")
    ok("corrupt audit: fresh run succeeds rc==0", rc == 0, f"rc={rc}")


def t_rows_dict_structure():
    d = fresh_dir()
    seed_audit(d, [row("198.51.100.9"), row("198.51.100.10")])
    prober = FakeProber()
    prober.results = make_probe_map(good_us=["198.51.100.9", "198.51.100.10"])
    rc, _ = run_pipeline(d, prober)
    a = audit_of(d)
    ok("rows dict structure: every region value is a list",
       all(isinstance(v, list) for v in a["rows"].values()))
    ok("rows dict structure: row fields complete",
       all(set(r) >= {"ip", "region", "colo", "source", "first_seen", "last_checked", "status"}
           for v in a["rows"].values() for r in v))


# ---------------------------------------------------------------- G-2 tests --

def t_partial_failure():
    d = fresh_dir()
    seed_audit(d, [row("198.51.100.1"), row("198.51.100.2")])  # A healthy, B dead
    prober = FakeProber()
    prober.results = make_probe_map(good_us=["198.51.100.1", "198.51.100.3"])  # B fails, C new
    rc, out = run_pipeline(d, prober)
    a = audit_of(d)
    ips = [r["ip"] for r in a["rows"]["us"]]
    ok("partial failure: dead row evicted", "198.51.100.2" not in ips, str(ips))
    ok("partial failure: healthy kept OK", "198.51.100.1" in ips)
    ok("partial failure: new added", "198.51.100.3" in ips)
    ok("partial failure: stats.evicted_previous==1", a["stats"]["evicted_previous"] == 1)
    ok("partial failure: not an outage", a["stats"]["probe_outage"] is False)


def t_total_probe_failure():
    d = fresh_dir()
    seed_audit(d, [row("198.51.100.1", checked="2026-11-19T08:00:00Z"),
                   row("198.51.100.2", checked="2026-11-19T08:00:00Z")])
    prober = FakeProber()
    prober.outage = True  # everything fails
    rc, out = run_pipeline(d, prober)
    a = audit_of(d)
    us = a["rows"]["us"]
    ok("total failure: rc==1 (loud)", rc == 1, f"rc={rc}")
    ok("total failure: ::error annotation present", "::error" in out)
    ok("total failure: previous rows kept", len(us) == 2, str(us))
    ok("total failure: status demoted to STALE",
       all(r["status"] == "STALE" for r in us))
    ok("total failure: last_checked preserved (original verification time)",
       all(r["last_checked"] == "2026-11-19T08:00:00Z" for r in us))
    ok("total failure: stats.probe_outage true", a["stats"]["probe_outage"] is True)
    ok("total failure: data file carries STALE lines",
       any(l.endswith("|STALE") for l in data_lines(d, "us") or []), str(data_lines(d, "us")))
    ok("total failure: no eviction", a["stats"]["evicted_previous"] == 0)


def t_source_unavailable():
    d = fresh_dir()
    seed_audit(d, [row("198.51.100.1")])
    before = (d / "audit.json").read_text(encoding="utf-8")
    us_before = (d / "US.txt").read_text(encoding="utf-8") if (d / "US.txt").exists() else None
    prober = FakeProber()
    rc, out = run_pipeline(d, prober, ranges=d / "nonexistent-ranges.txt")
    ok("source unavailable: rc==2", rc == 2, f"rc={rc}")
    ok("source unavailable: ::error present", "::error" in out)
    ok("source unavailable: audit untouched", (d / "audit.json").read_text(encoding="utf-8") == before)
    after = (d / "US.txt").read_text(encoding="utf-8") if (d / "US.txt").exists() else None
    ok("source unavailable: data files untouched", after == us_before)


def t_source_empty():
    d = fresh_dir()
    seed_audit(d, [row("198.51.100.1")])
    before = (d / "audit.json").read_text(encoding="utf-8")
    empty_ranges = d / "empty-ranges.txt"
    empty_ranges.write_text("# only comments, no CIDR\n\n", encoding="utf-8")
    prober = FakeProber()
    rc, out = run_pipeline(d, prober, ranges=empty_ranges)
    ok("source empty: rc==2 (treated as source failure)", rc == 2, f"rc={rc}")
    ok("source empty: ::error mentions zero networks",
       "zero networks" in out, [l for l in out.splitlines() if "::error" in l][:1])
    ok("source empty: audit untouched", (d / "audit.json").read_text(encoding="utf-8") == before)


def t_history_file_corrupt():
    d = fresh_dir()
    seed_audit(d, [row("198.51.100.1")])
    (d / "US.txt").write_text("GARBAGE NOT A VALID LINE\n\x00\x01binary\n", encoding="utf-8")
    prober = FakeProber()
    prober.results = make_probe_map(good_us=["198.51.100.1"])
    rc, _ = run_pipeline(d, prober)
    lines = data_lines(d, "us") or []
    ok("history file corrupt: healed by successful round",
       rc == 0 and len(lines) == 1 and lines[0].startswith("198.51.100.1|"), str(lines))


def t_recovery_next_round():
    d = fresh_dir()
    seed_audit(d, [row("198.51.100.1", checked="2026-11-19T08:00:00Z")])
    prober = FakeProber()
    prober.outage = True
    rc1, _ = run_pipeline(d, prober)
    a1 = audit_of(d)
    ok("recovery setup: round1 STALE", all(r["status"] == "STALE" for r in a1["rows"]["us"]))
    prober.outage = False
    prober.results = make_probe_map(good_us=["198.51.100.1"])
    rc2, _ = run_pipeline(d, prober)
    a2 = audit_of(d)
    r = a2["rows"]["us"][0]
    ok("recovery: rc back to 0", rc2 == 0, f"rc1={rc1} rc2={rc2}")
    ok("recovery: status promoted OK", r["status"] == "OK")
    ok("recovery: last_checked refreshed", r["last_checked"] != "2026-11-19T08:00:00Z", r["last_checked"])
    ok("recovery: data file line is OK again",
       any(l.endswith("|OK") for l in data_lines(d, "us") or []))


def t_recovery_after_multi_failures():
    d = fresh_dir()
    seed_audit(d, [row("198.51.100.1", checked="2026-11-19T08:00:00Z"),
                   row("203.0.113.5", region="de", colo="FRA", checked="2026-11-19T08:00:00Z")])
    prober = FakeProber()
    prober.outage = True
    times = set()
    try:
        for _ in range(3):
            run_pipeline(d, prober)
            a = audit_of(d)
            for r in a["rows"]["us"] + a["rows"]["de"]:
                times.add((r["ip"], r["status"], r["last_checked"]))
        ok("multi-failure: 3 outage rounds survived", True)
        ok("multi-failure: all rows STALE with frozen last_checked",
           all(s == "STALE" and t == "2026-11-19T08:00:00Z" for (_, s, t) in times),
           str(sorted(times)))
        prober.outage = False
        prober.results = make_probe_map(good_us=["198.51.100.1"], good_de=["203.0.113.5"])
        rc, _ = run_pipeline(d, prober)
        a = audit_of(d)
        ok("multi-failure: recovery rc==0", rc == 0, f"rc={rc}")
        ok("multi-failure: both rows OK with fresh timestamps",
           all(r["status"] == "OK" and r["last_checked"] != "2026-11-19T08:00:00Z"
               for r in a["rows"]["us"] + a["rows"]["de"]))
    except Exception as e:
        ok("multi-failure: 3 outage rounds survived", False, f"{type(e).__name__}: {e}")


def main():
    tests = [t_first_run, t_second_run, t_ten_rounds, t_empty_audit_file,
             t_missing_audit, t_corrupt_audit, t_rows_dict_structure,
             t_partial_failure, t_total_probe_failure, t_source_unavailable,
             t_source_empty, t_history_file_corrupt, t_recovery_next_round,
             t_recovery_after_multi_failures]
    for t in tests:
        try:
            t()
        except Exception as e:
            ok(f"{t.__name__}: EXCEPTION", False, f"{type(e).__name__}: {e}")
    print(f"\npipeline regression: {len(PASS)}/{len(PASS) + len(FAIL)} passed")
    if FAIL:
        print("failed:", FAIL)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
