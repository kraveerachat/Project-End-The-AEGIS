"""IDEA3 graduated response detector: the reviewed F1 rules, reporting WHICH rule matched, from trusted journal records only.

A separate module on purpose: ``production_detector`` (the reviewed, pinned F1 detector) stays byte-unchanged and keeps
sending version-1 alerts. This subclass reuses its rules, thresholds, bounds, rate limit and transport-failure stop, and
changes three things:

1. each alert is version 2 and names the rule (``port_scan``, ``ssh_brute_force``, ``syn_flood``); the cooldown is per
   address *and* rule, so a second, different vector from the same address is still reported;
2. one extra rule: a successful sshd login from an address that crossed the brute-force rule in the same window
   (``ssh_login_after_failures``), the compromise signal the Core needs before it may cut automatically;
3. it follows ``journalctl -o json`` limited to the kernel and sshd, and checks journald's trusted fields (``_TRANSPORT``,
   ``_COMM``, ``_UID``) so netfilter rules only see kernel records and SSH rules only see records from sshd running as
   root. A local user writing look-alike lines with logger(1) is ignored.

It still imports no MQTT client, opens no network socket, holds no secret and requests nothing: the Core decides.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from collections.abc import Iterable

from . import alert_sink
from . import production_detector as pd

KIND_PORT_SCAN = "port_scan"
KIND_SSH_BRUTE_FORCE = "ssh_brute_force"
KIND_SYN_FLOOD = "syn_flood"
KIND_SSH_LOGIN_AFTER_FAILURES = "ssh_login_after_failures"

# A constant argv: kernel records OR sshd records, JSON so the trusted journald fields are available.
TRUSTED_JOURNAL_ARGV = ("journalctl", "-f", "-n", "0", "-o", "json", "_TRANSPORT=kernel", "+", "_COMM=sshd")
SOURCE_KERNEL = "kernel"
SOURCE_SSHD = "sshd"
RECORD_MAX_CHARS = 4 * pd.LINE_MAX_CHARS

# Anchored on sshd's own tail ("from <IP> port <n>") so text inside a user name cannot supply the address.
_SSH_ACCEPTED_RE = re.compile(r"Accepted \S+ for \S+ from (\d+\.\d+\.\d+\.\d+) port \d+", re.ASCII)


def trusted_record(raw: str) -> tuple[str, str] | None:
    """``(source, message)`` for a journald JSON record from the kernel or from sshd running as root, else None."""
    if len(raw) > RECORD_MAX_CHARS:
        return None
    try:
        record = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(record, dict):
        return None
    message = record.get("MESSAGE")
    if not isinstance(message, str):
        return None  # journald encodes non-UTF-8 messages as byte arrays: never parsed
    if record.get("_TRANSPORT") == "kernel":
        return SOURCE_KERNEL, message[: pd.LINE_MAX_CHARS]
    if record.get("_COMM") == "sshd" and record.get("_UID") == "0" and record.get("_TRANSPORT") in ("syslog", "journal", "stdout"):
        return SOURCE_SSHD, message[: pd.LINE_MAX_CHARS]
    return None


class GraduatedDetector(pd.ProductionDetector):
    def __init__(self, sender=alert_sink.send_alert, **kwargs) -> None:
        super().__init__(sender, **kwargs)
        self._kind = KIND_SSH_BRUTE_FORCE

    # -- the single outbound path, per (address, rule) ------------------------------------------------------------------
    def report(self, ip: str) -> alert_sink.AlertResult | None:
        if self.stopped:
            return None
        kind = self._kind
        key = f"{ip}|{kind}"
        now = self._clock()
        last = self._reported.get(key)
        if last is not None and now - last < pd.REPORT_COOLDOWN_SEC:
            return None
        if len(self._reported) >= pd.MAX_TRACKED_ADDRESSES:
            self._reported = {k: v for k, v in self._reported.items() if now - v < pd.REPORT_COOLDOWN_SEC}
            if len(self._reported) >= pd.MAX_TRACKED_ADDRESSES:
                pd._log("alert_dropped", reason="REPORTED_TABLE_FULL")
                return None
        if not self._take_token():
            pd._log("alert_dropped", reason="LOCAL_RATE_LIMIT")
            return None
        self._reported[key] = now  # marked before the send: a failed send is not retried for this cooldown
        result = self._send(ip, kind)
        pd._log("alert", result=result.code, detail=result.detail or "-", ip=ip, kind=kind)
        if result.code in alert_sink.TRANSPORT_FAILURES:
            self.consecutive_transport_failures += 1
            if self.consecutive_transport_failures >= pd.MAX_CONSECUTIVE_TRANSPORT_FAILURES:
                self.stopped = True
                pd._log("stopping", reason="ALERT_SINK_UNAVAILABLE")
        else:
            self.consecutive_transport_failures = 0
        return result

    # -- the reviewed rules, labelled ------------------------------------------------------------------------------------
    def process_line(self, line: str) -> None:
        self._kind = KIND_SSH_BRUTE_FORCE
        super().process_line(line)

    def process_portscan(self, line: str) -> None:
        self._kind = KIND_PORT_SCAN
        super().process_portscan(line)

    def process_synflood(self, line: str) -> None:
        self._kind = KIND_SYN_FLOOD
        super().process_synflood(line)

    def process_login(self, line: str) -> None:
        match = _SSH_ACCEPTED_RE.search(line)
        if not match:
            return
        ip, now = match.group(1), self._clock()
        queue = self._fails.get(ip)
        if queue is None:
            return
        while queue and now - queue[0] > pd.TIME_WINDOW:
            queue.popleft()
        if len(queue) >= pd.FAIL_THRESHOLD:
            self._kind = KIND_SSH_LOGIN_AFTER_FAILURES
            self.report(ip)

    def process(self, line: str) -> None:
        """Untrusted plain text is never processed by this detector; use ``process_trusted``."""

    def process_trusted(self, raw: str) -> None:
        found = trusted_record(raw)
        if found is None:
            return
        source, message = found
        if source == SOURCE_SSHD:
            self.process_line(message)
            self.process_login(message)
        else:
            self.process_portscan(message)
            self.process_synflood(message)


def run(records: Iterable[str], detector: GraduatedDetector) -> int:
    """Same exit semantics as ``production_detector.run``: the follower ending at all is a failure, never exit 0."""
    for raw in records:
        detector.process_trusted(raw)
        if detector.stopped:
            return pd.EXIT_TRANSPORT_UNAVAILABLE
    return pd.EXIT_JOURNAL_SOURCE_UNAVAILABLE


def main() -> int:
    detector = GraduatedDetector()
    pd._log("started", sink="AF_UNIX", socket=alert_sink.ALERT_SOCKET_PATH, mode="graduated-v2")
    try:
        process = subprocess.Popen(list(TRUSTED_JOURNAL_ARGV), stdout=subprocess.PIPE, text=True, errors="replace")
    except OSError:
        pd._log("stopping", reason="JOURNAL_SOURCE_UNAVAILABLE", journal_exit="not_started")
        return pd.EXIT_JOURNAL_SOURCE_UNAVAILABLE
    try:
        assert process.stdout is not None
        status = run(process.stdout, detector)
        if status == pd.EXIT_JOURNAL_SOURCE_UNAVAILABLE:
            pd._log("stopping", reason="JOURNAL_SOURCE_UNAVAILABLE", journal_exit=pd._journal_exit_status(process))
        return status
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


if __name__ == "__main__":
    sys.exit(main())
