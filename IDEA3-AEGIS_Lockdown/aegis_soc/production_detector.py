"""F1 production detector: journal lines in, at most one bounded alert per attacker out, over the Core-local AF_UNIX ingress only.

This is the Production counterpart of the legacy lab ``detector.py`` (which still publishes to the MQTT ``aegis/attacker_ip`` topic in
legacy-v0-lab mode and is unchanged). It reuses the same three rules and thresholds (SSH brute force, port scan, SYN flood) but its only
output is ``alert_sink.send_alert``. It imports no MQTT client, opens no network socket, holds no secret, reads no ``.env`` and never
requests containment, CUT or RESTORE: the Core decides what an alert means.

Bounds: each address is reported at most once per cooldown; sends are token-bucket limited below the Core's own limit; tracking tables
are size-bounded; and after a few consecutive transport failures the process exits (the unit does not restart it), so a missing or
untrusted socket can never turn into a retry storm.
"""

from __future__ import annotations

import re
import subprocess
import sys
import time
from collections import OrderedDict, deque
from collections.abc import Callable, Iterable

from . import alert_sink

# Same thresholds as the legacy detector.py (a parity test pins them together).
FAIL_THRESHOLD = 5
TIME_WINDOW = 30
SCAN_PORT_THRESHOLD = 10
SCAN_TIME_WINDOW = 10
SYN_FLOOD_THRESHOLD = 20
SYN_FLOOD_WINDOW = 2

REPORT_COOLDOWN_SEC = 300.0  # an address is reported once per cooldown, whatever the send outcome (no retry storm)
MAX_TRACKED_ADDRESSES = 4096
SEND_BURST = 3
SEND_PER_MIN = 6.0  # below the Core ingress limit (burst 5, 10/min)
MAX_CONSECUTIVE_TRANSPORT_FAILURES = 3
EXIT_TRANSPORT_UNAVAILABLE = 2
EXIT_JOURNAL_SOURCE_UNAVAILABLE = 3  # the journalctl follower ended or could not start: the detector is blind, so it must FAIL, never exit 0
LINE_MAX_CHARS = 2048

# A constant argv: no shell, nothing derived from log content, no user input.
JOURNAL_ARGV = ("journalctl", "-f", "-n", "0", "-o", "cat")

_SSH_RE = re.compile(r"Failed password.*from (\d+\.\d+\.\d+\.\d+)", re.ASCII)
_SRC_RE = re.compile(r"SRC=(\d+\.\d+\.\d+\.\d+)", re.ASCII)
_DPT_RE = re.compile(r"DPT=(\d+)", re.ASCII)

Sender = Callable[[str], alert_sink.AlertResult]


def _log(event: str, **fields: str) -> None:
    detail = " ".join(f"{key}={value}" for key, value in fields.items())
    print(f"[F1-DETECTOR] {event} {detail}".rstrip(), flush=True)


class ProductionDetector:
    def __init__(self, sender: Sender = alert_sink.send_alert, *, clock: Callable[[], float] = time.monotonic) -> None:
        self._send = sender
        self._clock = clock
        self._fails: OrderedDict[str, deque[float]] = OrderedDict()
        self._ports: OrderedDict[str, deque[tuple[float, str]]] = OrderedDict()
        self._syns: OrderedDict[str, deque[float]] = OrderedDict()
        self._reported: dict[str, float] = {}
        self._tokens = float(SEND_BURST)
        self._stamp = clock()
        self.consecutive_transport_failures = 0
        self.stopped = False

    # -- tracking helpers -------------------------------------------------------------------------------------------------
    def _window(self, table: OrderedDict, ip: str):
        if ip not in table and len(table) >= MAX_TRACKED_ADDRESSES:
            table.popitem(last=False)  # evict the stalest entry; tracking stays bounded under spoofed-source floods
        queue = table.setdefault(ip, deque())
        table.move_to_end(ip)
        return queue

    def _take_token(self) -> bool:
        now = self._clock()
        self._tokens = min(float(SEND_BURST), self._tokens + max(0.0, now - self._stamp) * SEND_PER_MIN / 60.0)
        self._stamp = now
        if self._tokens < 1.0:
            return False
        self._tokens -= 1.0
        return True

    # -- the single outbound path -----------------------------------------------------------------------------------------
    def report(self, ip: str) -> alert_sink.AlertResult | None:
        if self.stopped:
            return None
        now = self._clock()
        last = self._reported.get(ip)
        if last is not None and now - last < REPORT_COOLDOWN_SEC:
            return None
        if len(self._reported) >= MAX_TRACKED_ADDRESSES:
            self._reported = {k: v for k, v in self._reported.items() if now - v < REPORT_COOLDOWN_SEC}
            if len(self._reported) >= MAX_TRACKED_ADDRESSES:
                _log("alert_dropped", reason="REPORTED_TABLE_FULL")
                return None
        if not self._take_token():
            _log("alert_dropped", reason="LOCAL_RATE_LIMIT")
            return None
        self._reported[ip] = now  # marked before the send: a failed send is not retried for this cooldown
        result = self._send(ip)
        _log("alert", result=result.code, detail=result.detail or "-", ip=ip)
        if result.code in alert_sink.TRANSPORT_FAILURES:
            self.consecutive_transport_failures += 1
            if self.consecutive_transport_failures >= MAX_CONSECUTIVE_TRANSPORT_FAILURES:
                self.stopped = True
                _log("stopping", reason="ALERT_SINK_UNAVAILABLE")
        else:
            self.consecutive_transport_failures = 0
        return result

    # -- rules (same logic as the legacy detector) --------------------------------------------------------------------------
    def process_line(self, line: str) -> None:
        match = _SSH_RE.search(line)
        if not match:
            return
        ip, now = match.group(1), self._clock()
        queue = self._window(self._fails, ip)
        queue.append(now)
        while queue and now - queue[0] > TIME_WINDOW:
            queue.popleft()
        if len(queue) >= FAIL_THRESHOLD:
            self.report(ip)

    def process_portscan(self, line: str) -> None:
        if "AEGIS_NEWCONN" not in line:
            return
        src, dpt = _SRC_RE.search(line), _DPT_RE.search(line)
        if not src or not dpt:
            return
        ip, now = src.group(1), self._clock()
        queue = self._window(self._ports, ip)
        queue.append((now, dpt.group(1)))
        while queue and now - queue[0][0] > SCAN_TIME_WINDOW:
            queue.popleft()
        if len({port for _, port in queue}) >= SCAN_PORT_THRESHOLD:
            self.report(ip)

    def process_synflood(self, line: str) -> None:
        if "AEGIS_NEWCONN" not in line:
            return
        src = _SRC_RE.search(line)
        if not src or src.group(1).startswith("127."):
            return
        ip, now = src.group(1), self._clock()
        queue = self._window(self._syns, ip)
        queue.append(now)
        while queue and now - queue[0] > SYN_FLOOD_WINDOW:
            queue.popleft()
        if len(queue) >= SYN_FLOOD_THRESHOLD:
            self.report(ip)

    def process(self, line: str) -> None:
        line = line[:LINE_MAX_CHARS]
        self.process_line(line)
        self.process_portscan(line)
        self.process_synflood(line)


def run(lines: Iterable[str], detector: ProductionDetector) -> int:
    """Consume journal lines. The follower is endless by design, so the iterable ending at all means the journal source was lost: that is a
    failure (``EXIT_JOURNAL_SOURCE_UNAVAILABLE``), never a clean exit 0. A stopped sink keeps its own code (``EXIT_TRANSPORT_UNAVAILABLE``)."""
    for line in lines:
        detector.process(line)
        if detector.stopped:
            return EXIT_TRANSPORT_UNAVAILABLE
    return EXIT_JOURNAL_SOURCE_UNAVAILABLE


def _journal_exit_status(process: subprocess.Popen) -> str:
    """The follower's exit status as a fixed non-secret integer (or ``unknown``): it is never reaped twice and never raises."""
    try:
        return str(process.wait(timeout=5))
    except Exception:  # noqa: BLE001 - observability only; the failure exit code does not depend on it
        return "unknown"


def main() -> int:
    detector = ProductionDetector()
    _log("started", sink="AF_UNIX", socket=alert_sink.ALERT_SOCKET_PATH)
    try:
        process = subprocess.Popen(list(JOURNAL_ARGV), stdout=subprocess.PIPE, text=True, errors="replace")
    except OSError:  # journalctl missing / not executable: one bounded explicit failure, no traceback, no retry
        _log("stopping", reason="JOURNAL_SOURCE_UNAVAILABLE", journal_exit="not_started")
        return EXIT_JOURNAL_SOURCE_UNAVAILABLE
    try:
        assert process.stdout is not None
        status = run(process.stdout, detector)
        if status == EXIT_JOURNAL_SOURCE_UNAVAILABLE:
            _log("stopping", reason="JOURNAL_SOURCE_UNAVAILABLE", journal_exit=_journal_exit_status(process))
        return status
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    sys.exit(main())
