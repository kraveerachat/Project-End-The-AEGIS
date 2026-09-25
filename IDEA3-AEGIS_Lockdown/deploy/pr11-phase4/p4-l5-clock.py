#!/usr/bin/env python3
"""AEGIS IDEA3 PR11 Phase 4 — L5 trusted-time readiness predicate (read-only).

One predicate shared by L5 apply (readiness wait) and L5 verify (acceptance), so apply can never pass on a weaker
condition than verify. Live failure l5-20260925-174630: apply passed on `chronyc tracking` Leap status Normal, verify then
failed the kernel-based TrustedClock check ~0.8 s later with no reason recorded.

Predicate (all must hold):  adjtimex probe readable, kernel synced (STA_UNSYNC clear), maxerror <= 1,000,000 us,
TrustedClock state == SYNCED.  Failure reasons: PROBE_UNAVAILABLE, KERNEL_UNSYNCED, MAXERROR_EXCEEDED,
TRUSTEDCLOCK_NOT_SYNCED (and, for the wait, CHRONY_LEAP_NOT_NORMAL).

  state                                                 like probe, always exit 0 (evidence capture)
  probe [--fixture-probe none|unsynced:N|synced:N]      one evaluation; exit 0 only when OK
  raw   [--fixture-raw RET:STATUS:MAXERROR|none]
                                                        raw adjtimex return/status/STA_UNSYNC/TIME_ERROR, always exit 0
  wait  --timeout S --interval S [--work DIR] [--fixture-seq FILE]
        bounded wait until chronyd reports Leap status Normal AND the predicate holds; writes DIR/readiness.log
        (and, live, DIR/chronyc-tracking.txt + chronyc-sources.txt). Never adjusts the clock or any service.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from aegis_soc.trusted_time import (  # noqa: E402
    STA_UNSYNC,
    TIME_ERROR,
    ClockSync,
    MAX_ERROR_US,
    RawAdjtimex,
    TimeTrust,
    TrustedClock,
    adjtimex_raw,
    clock_sync_from_raw,
)


def raw_fields(raw) -> str:
    """Raw kernel evidence, decoded but never reinterpreted: adjtimex return, status word (hex), STA_UNSYNC, TIME_ERROR."""
    if raw is None:
        return "adjtimex_ret=UNAVAILABLE"
    return (
        f"adjtimex_ret={raw.ret} status=0x{raw.status:x} sta_unsync={int(bool(raw.status & STA_UNSYNC))} "
        f"time_error={int(raw.ret == TIME_ERROR)}"
    )


def _parse_fixture_raw(spec: str):
    if spec == "none":
        return None
    ret, status, maxerr = spec.split(":")
    return RawAdjtimex(ret=int(ret), status=int(status, 0), maxerror_us=int(maxerr))


def evaluate(probe, wall=time.time):
    """Return (reason, state, maxerror_us) using exactly the acceptance predicate."""
    sample = probe()
    if sample is None:
        return "PROBE_UNAVAILABLE", "UNKNOWN", -1
    if not sample.synced:
        return "KERNEL_UNSYNCED", "UNTRUSTED", sample.maxerror_us
    if not 0 <= sample.maxerror_us <= MAX_ERROR_US:
        return "MAXERROR_EXCEEDED", "UNTRUSTED", sample.maxerror_us
    state = TrustedClock(lambda: sample, wall=wall).state()
    if state != TimeTrust.SYNCED:
        return "TRUSTEDCLOCK_NOT_SYNCED", str(state), sample.maxerror_us
    return "OK", "SYNCED", sample.maxerror_us


def wait_ready(leap, probe, timeout, interval, sleep=time.sleep, now=time.monotonic, wall=time.time, raw=None):
    """Poll until chronyd Leap status is Normal and evaluate() is OK. Returns (ok, reason, log_lines).

    `raw`, when given, is called once per poll BEFORE probe() and must return the RawAdjtimex behind that poll's probe; its
    decoded fields are appended to the log line so a failing sub-condition is never lost."""
    log: list[str] = []
    deadline = now() + timeout
    reason = "NOT_EVALUATED"
    while True:
        lp = leap()
        raw_txt = f" {raw_fields(raw())}" if raw is not None else ""
        reason, state, maxerr = evaluate(probe, wall=wall)
        eff = reason if lp == "Normal" or reason != "OK" else "CHRONY_LEAP_NOT_NORMAL"
        log.append(f"ts={wall():.3f} leap={lp!r} reason={eff} trustedclock={state} maxerror_us={maxerr}{raw_txt}")
        if eff == "OK":
            return True, "OK", log
        reason = eff
        if now() >= deadline:
            return False, reason, log
        sleep(interval)


def _fixture_probe(spec: str):
    if spec == "none":
        return lambda: None
    kind, _, val = spec.partition(":")
    return lambda: ClockSync(synced=(kind == "synced"), maxerror_us=int(val or 0))


def _live_leap() -> str:
    try:
        out = subprocess.run(["chronyc", "-n", "tracking"], capture_output=True, text=True, timeout=10, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return "UNAVAILABLE"
    for line in out.splitlines():
        k, _, v = line.partition(" : ")
        if k.strip().startswith("Leap status"):
            return v.strip()
    return "UNAVAILABLE"


def _save_chronyc(work: Path) -> None:
    for name, args in (("chronyc-tracking.txt", ["-n", "tracking"]), ("chronyc-sources.txt", ["-n", "sources"])):
        try:
            out = subprocess.run(["chronyc", *args], capture_output=True, text=True, timeout=10, check=False)
            (work / name).write_text(out.stdout + out.stderr, encoding="utf-8")
        except (OSError, subprocess.SubprocessError) as exc:
            (work / name).write_text(f"UNAVAILABLE {type(exc).__name__}\n", encoding="utf-8")


def _live_pair():
    """One adjtimex read shared by raw evidence and the predicate decision (a poll never mixes two kernel reads)."""
    cell = {"raw": None}

    def raw():
        cell["raw"] = adjtimex_raw()
        return cell["raw"]

    def probe():
        return clock_sync_from_raw(cell["raw"])

    return raw, probe


def _seq_callbacks(path: Path):
    rows = [dict(kv.split("=", 1) for kv in ln.split()) for ln in path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    idx = {"i": -1}

    def cur():
        return rows[min(max(idx["i"], 0), len(rows) - 1)]

    def leap():
        idx["i"] += 1  # one row per poll: leap() is called first in every iteration
        return cur().get("leap", "Normal")

    def probe():
        r = cur()
        p = r.get("probe", "synced")
        return None if p == "none" else ClockSync(synced=(p == "synced"), maxerror_us=int(r.get("maxerror", "0")))

    def raw():
        r = cur()
        p = r.get("probe", "synced")
        if p == "none":
            return None
        synced = p == "synced"
        ret = int(r["ret"]) if "ret" in r else (0 if synced else TIME_ERROR)
        status = int(r["status"], 0) if "status" in r else (0x2001 if synced else 0x2041)
        return RawAdjtimex(ret=ret, status=status, maxerror_us=int(r.get("maxerror", "0")))

    return leap, probe, raw


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe")
    p.add_argument("--fixture-probe")
    sub.add_parser("state")  # like probe, but always exits 0 (for evidence capture)
    rw = sub.add_parser("raw")
    rw.add_argument("--fixture-raw")
    w = sub.add_parser("wait")
    w.add_argument("--timeout", type=float, required=True)
    w.add_argument("--interval", type=float, default=1.0)
    w.add_argument("--work")
    w.add_argument("--fixture-seq")
    a = ap.parse_args(argv)

    if a.cmd == "raw":
        sample = _parse_fixture_raw(a.fixture_raw) if a.fixture_raw else adjtimex_raw()
        print(f"{raw_fields(sample)}" + (f" maxerror_us={sample.maxerror_us}" if sample else ""))
        return 0
    if a.cmd == "state":
        sample = adjtimex_raw()
        reason, state, maxerr = evaluate(lambda: clock_sync_from_raw(sample))
        print(f"state={state} reason={reason} maxerror_us={maxerr} {raw_fields(sample)}")
        return 0
    if a.cmd == "probe":
        if a.fixture_probe:
            reason, state, maxerr = evaluate(_fixture_probe(a.fixture_probe))
            spec = a.fixture_probe
            kind = spec.partition(":")[0]
            fx = None if spec == "none" else RawAdjtimex(0 if kind == "synced" else TIME_ERROR,
                                                          0x2001 if kind == "synced" else 0x2041, maxerr)
            print(f"state={state} reason={reason} maxerror_us={maxerr} {raw_fields(fx)}")
        else:
            sample = adjtimex_raw()
            reason, state, maxerr = evaluate(lambda: clock_sync_from_raw(sample))
            print(f"state={state} reason={reason} maxerror_us={maxerr} {raw_fields(sample)}")
        return 0 if reason == "OK" else 1

    started = time.monotonic()
    if a.fixture_seq:
        leap, probe, raw = _seq_callbacks(Path(a.fixture_seq))
    else:
        leap = _live_leap
        raw, probe = _live_pair()
    ok, reason, log = wait_ready(leap, probe, a.timeout, a.interval, raw=raw)
    if a.work:
        work = Path(a.work)
        (work / "readiness.log").write_text("\n".join(log) + "\n", encoding="utf-8")
        if not a.fixture_seq:
            _save_chronyc(work)
    print(f"L5_CLOCK_READY={'YES' if ok else 'NO'} reason={reason} waited_s={time.monotonic() - started:.2f}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
