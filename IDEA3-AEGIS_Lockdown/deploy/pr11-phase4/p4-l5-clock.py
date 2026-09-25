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
from aegis_soc.trusted_time import ClockSync, MAX_ERROR_US, TimeTrust, TrustedClock, adjtimex_probe  # noqa: E402


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


def wait_ready(leap, probe, timeout, interval, sleep=time.sleep, now=time.monotonic, wall=time.time):
    """Poll until chronyd Leap status is Normal and evaluate() is OK. Returns (ok, reason, log_lines)."""
    log: list[str] = []
    deadline = now() + timeout
    reason = "NOT_EVALUATED"
    while True:
        lp = leap()
        reason, state, maxerr = evaluate(probe, wall=wall)
        eff = reason if lp == "Normal" or reason != "OK" else "CHRONY_LEAP_NOT_NORMAL"
        log.append(f"ts={wall():.3f} leap={lp!r} reason={eff} trustedclock={state} maxerror_us={maxerr}")
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

    return leap, probe


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe")
    p.add_argument("--fixture-probe")
    sub.add_parser("state")  # like probe, but always exits 0 (for evidence capture)
    w = sub.add_parser("wait")
    w.add_argument("--timeout", type=float, required=True)
    w.add_argument("--interval", type=float, default=1.0)
    w.add_argument("--work")
    w.add_argument("--fixture-seq")
    a = ap.parse_args(argv)

    if a.cmd == "state":
        reason, state, maxerr = evaluate(adjtimex_probe)
        print(f"state={state} reason={reason} maxerror_us={maxerr}")
        return 0
    if a.cmd == "probe":
        probe = _fixture_probe(a.fixture_probe) if a.fixture_probe else adjtimex_probe
        reason, state, maxerr = evaluate(probe)
        print(f"state={state} reason={reason} maxerror_us={maxerr}")
        return 0 if reason == "OK" else 1

    started = time.monotonic()
    if a.fixture_seq:
        leap, probe = _seq_callbacks(Path(a.fixture_seq))
    else:
        leap, probe = _live_leap, adjtimex_probe
    ok, reason, log = wait_ready(leap, probe, a.timeout, a.interval)
    if a.work:
        work = Path(a.work)
        (work / "readiness.log").write_text("\n".join(log) + "\n", encoding="utf-8")
        if not a.fixture_seq:
            _save_chronyc(work)
    print(f"L5_CLOCK_READY={'YES' if ok else 'NO'} reason={reason} waited_s={time.monotonic() - started:.2f}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
