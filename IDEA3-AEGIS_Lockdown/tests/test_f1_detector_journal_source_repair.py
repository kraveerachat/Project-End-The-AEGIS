"""F1 attempt-1 failure repair (repository only): the detector unit must not hide /proc/sys from its own journalctl, and the detector must never
exit successfully when its journal follower dies.

Live attempt 1 (2026-10-04, consumed, rolled back) ended ``F1_APPLY=FAIL reason=DETECTOR_NOT_RUNNING``: ``journalctl -f`` under ``ProcSubset=pid``
printed "Failed to get boot ID: No such file or directory" (``/proc/sys/kernel/random/boot_id`` is not visible with ``subset=pid``), exited, and
``production_detector.main`` returned 0 on the resulting EOF, so systemd logged "Deactivated successfully". These tests prove REPOSITORY behavior
only: no systemd, no real journalctl and no host state is touched, and none of them claims a live PASS.
"""

from __future__ import annotations

import hashlib
import importlib.util
import re
import subprocess
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from aegis_soc import alert_sink, production_detector  # noqa: E402

UNIT_EXAMPLE = ROOT / "deploy" / "aegis-idea3-detector.service.example"
TOOL_PATH = ROOT / "deploy" / "pr11-phase4" / "p4-f1-alert-source.py"

#: The unit contract the consumed attempt 1 installed (historical; never reinstall).
ATTEMPT1_UNIT_SHA256 = "748a4c5bd3d6c30a23324819609ad89bcb4e8c4710cb775ab2c0d789a211772a"
#: The corrected unit (only the ProcSubset line is gone). Derived from the exact bytes below, never typed from memory.
CORRECTED_UNIT_SHA256 = "da40399ef57b1e29cf30dc63792f67ded15333faacd8a3e04feb1c8e60d419b9"


def load_tool():
    spec = importlib.util.spec_from_file_location("p4_f1_alert_source_repair", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tool = load_tool()


def active_lines(text: str) -> list[str]:
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


# ═══ unit: the incompatible restriction is gone, everything else is kept ═════════════════════════════════════════════════════


def test_the_detector_unit_no_longer_hides_proc_sys_from_its_own_journalctl():
    lines = active_lines(UNIT_EXAMPLE.read_text())
    assert not any(line.startswith("ProcSubset=") for line in lines)  # subset=pid hides /proc/sys/kernel/random/boot_id, which journalctl -f needs
    assert "ExecStart=/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.production_detector" in lines


#: Every active line of the corrected unit, pinned exactly: the ONLY difference from attempt 1's unit is the removed ProcSubset=pid.
EXPECTED_ACTIVE_LINES = [
    "[Unit]", "Description=AEGIS IDEA3 F1 production detector (Core alert source)", "Requires=aegis-idea3-core.service", "After=aegis-idea3-core.service",
    "StartLimitIntervalSec=300", "StartLimitBurst=3",
    "[Service]", "Type=simple", "User=aegis-idea3-detector", "UMask=0077", "WorkingDirectory=/opt/aegis-idea3/current",
    "SupplementaryGroups=aegis-idea3-alert systemd-journal",
    "ExecStartPre=/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.alert_sink check-socket --wait-sec 15",
    "ExecStart=/opt/aegis-idea3/current/venv/bin/python -m aegis_soc.production_detector",
    "Restart=no", "TimeoutStartSec=30", "TimeoutStopSec=15", "KillMode=control-group",
    "NoNewPrivileges=true", "PrivateTmp=true", "PrivateDevices=true", "ProtectSystem=strict", "ProtectHome=true", "ProtectKernelTunables=true",
    "ProtectKernelModules=true", "ProtectKernelLogs=true", "ProtectControlGroups=true", "ProtectClock=true", "ProtectHostname=true",
    "ProtectProc=invisible", "RestrictAddressFamilies=AF_UNIX", "RestrictNamespaces=true", "RestrictRealtime=true", "RestrictSUIDSGID=true",
    "LockPersonality=true", "CapabilityBoundingSet=", "AmbientCapabilities=", "SystemCallArchitectures=native",
    "MemoryAccounting=true", "TasksAccounting=true",
    "[Install]", "WantedBy=multi-user.target",
]


def test_all_other_hardening_is_preserved_exactly():
    assert active_lines(UNIT_EXAMPLE.read_text()) == EXPECTED_ACTIVE_LINES


@pytest.mark.parametrize("required", [
    "NoNewPrivileges=true", "ProtectSystem=strict", "ProtectHome=true", "ProtectKernelTunables=true", "ProtectKernelModules=true", "ProtectKernelLogs=true",
    "ProtectControlGroups=true", "ProtectClock=true", "ProtectHostname=true", "ProtectProc=invisible", "RestrictAddressFamilies=AF_UNIX",
    "RestrictNamespaces=true", "CapabilityBoundingSet=", "AmbientCapabilities=", "Restart=no", "User=aegis-idea3-detector",
])
def test_each_named_hardening_line_is_still_present_and_no_capability_is_held(required):
    lines = active_lines(UNIT_EXAMPLE.read_text())
    assert required in lines
    assert not any(line.startswith(("CapabilityBoundingSet=", "AmbientCapabilities=")) and line.split("=", 1)[1].strip() for line in lines)


def test_protect_proc_invisible_is_kept_because_only_proc_subset_breaks_the_journal_reader():
    # ProtectProc=invisible hides OTHER users' processes and keeps /proc/sys; only ProcSubset=pid removes /proc/sys.
    lines = active_lines(UNIT_EXAMPLE.read_text())
    assert "ProtectProc=invisible" in lines and not any(line.startswith("ProcSubset=") for line in lines)


def test_other_services_using_proc_subset_are_not_touched_by_this_repair():
    for rel in ("deploy/aegis-idea3-core.service.example", "deploy/network/aegis-idea3-containment.service.example"):
        assert "ProcSubset=pid" in (ROOT / rel).read_text(), rel  # out of scope: the defect is the detector's journalctl reader only


# ═══ renderer / verifier / pinned digest ════════════════════════════════════════════════════════════════════════════════════


def test_the_unit_verifier_accepts_the_corrected_unit_and_renders_it_byte_exactly():
    data = UNIT_EXAMPLE.read_bytes()
    tool.verify_unit(data)
    assert tool.render_unit(data) == data


def test_the_unit_verifier_now_refuses_the_attempt_1_proc_subset_contract():
    text = UNIT_EXAMPLE.read_text().replace("ProtectProc=invisible\n", "ProtectProc=invisible\nProcSubset=pid\n")
    with pytest.raises(tool.Refusal) as exc:
        tool.verify_unit(text.encode())
    assert str(exc.value) == "UNIT_PROC_SUBSET_BREAKS_JOURNAL_READER"
    assert hashlib.sha256(text.encode()).hexdigest() != CORRECTED_UNIT_SHA256


def test_the_rendered_unit_sha_changed_and_is_derived_from_the_exact_corrected_bytes():
    data = UNIT_EXAMPLE.read_bytes()
    digest = hashlib.sha256(tool.render_unit(data)).hexdigest()
    assert digest == hashlib.sha256(data).hexdigest() == CORRECTED_UNIT_SHA256
    assert digest != ATTEMPT1_UNIT_SHA256  # a frozen runner pinned to attempt 1's digest can never install the corrected unit by accident
    assert not any(line.startswith("ProcSubset") for line in active_lines(data.decode()))  # the explanatory comment may name it; no active line may


def test_the_cli_render_and_verify_accept_the_corrected_unit(tmp_path):
    out = tmp_path / "unit.service"
    done = subprocess.run([sys.executable, str(TOOL_PATH), "render-unit", "--output", str(out)], capture_output=True, text=True, check=False)
    assert done.returncode == 0 and out.read_bytes() == UNIT_EXAMPLE.read_bytes()
    ok = subprocess.run([sys.executable, str(TOOL_PATH), "verify-unit", "--file", str(out)], capture_output=True, text=True, check=False)
    assert ok.returncode == 0 and "F1_VERIFY_UNIT=PASS" in ok.stdout


# ═══ detector: journal source loss is a failure, never a clean exit ════════════════════════════════════════════════════════


class FakeJournal:
    """Stands in for the journalctl child: its stdout is any iterable, ``wait`` reports a chosen exit status."""

    def __init__(self, lines=(), status=0):
        self.stdout = iter(lines)
        self.status = status
        self.terminated = False
        self.killed = False

    def wait(self, timeout=None):
        return self.status

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.killed = True


@pytest.fixture
def fake_popen(monkeypatch):
    created: list[FakeJournal] = []
    argvs: list[list[str]] = []

    def install(process):
        def popen(argv, **kwargs):
            argvs.append(list(argv))
            created.append(process)
            return process

        monkeypatch.setattr(production_detector.subprocess, "Popen", popen)
        return created, argvs

    return install


def make_detector():
    sent: list[str] = []
    clock = type("C", (), {"t": 1000.0})()
    detector = production_detector.ProductionDetector(lambda ip: sent.append(ip) or alert_sink.AlertResult(True, "SENT_BOUND"), clock=lambda: clock.t)
    return detector, sent


def test_a_dedicated_nonzero_exit_code_exists_and_the_transport_code_is_unchanged():
    assert production_detector.EXIT_TRANSPORT_UNAVAILABLE == 2
    assert production_detector.EXIT_JOURNAL_SOURCE_UNAVAILABLE == 3
    assert len({0, production_detector.EXIT_TRANSPORT_UNAVAILABLE, production_detector.EXIT_JOURNAL_SOURCE_UNAVAILABLE}) == 3


def test_the_detector_stays_alive_while_its_journal_source_is_alive():
    detector, _ = make_detector()
    gate, consumed, result = threading.Event(), threading.Event(), []

    def source():
        yield "unrelated line"
        consumed.set()
        gate.wait(10)  # the journal is still open: no line, no EOF
        return

    thread = threading.Thread(target=lambda: result.append(production_detector.run(source(), detector)), daemon=True)
    thread.start()
    assert consumed.wait(5)
    thread.join(0.3)
    assert thread.is_alive() and result == []  # a live, idle journal never ends the detector
    gate.set()
    thread.join(5)
    assert result == [production_detector.EXIT_JOURNAL_SOURCE_UNAVAILABLE]  # only the source ending ends it, and as a failure


@pytest.mark.parametrize("lines", [[], ["a line"], ["Failed password for x from 203.0.113.9 port 22 ssh2"]])
def test_journal_eof_is_classified_fail_closed_never_zero(lines):
    detector, _ = make_detector()
    assert production_detector.run(iter(lines), detector) == production_detector.EXIT_JOURNAL_SOURCE_UNAVAILABLE


@pytest.mark.parametrize("status", [0, 1, 2, 127, -9, -15])
def test_an_unexpected_journalctl_exit_cannot_produce_detector_exit_zero(fake_popen, capsys, status):
    created, argvs = fake_popen(FakeJournal(status=status))
    assert production_detector.main() == production_detector.EXIT_JOURNAL_SOURCE_UNAVAILABLE != 0
    out = capsys.readouterr().out
    assert "[F1-DETECTOR] stopping reason=JOURNAL_SOURCE_UNAVAILABLE" in out and f"journal_exit={status}" in out
    assert len(argvs) == 1 and tuple(argvs[0]) == production_detector.JOURNAL_ARGV  # one follower, never restarted or retried
    assert created[0].terminated  # the child is always reaped on the way out


def test_a_journalctl_that_cannot_even_start_is_a_bounded_explicit_failure_not_a_traceback(monkeypatch, capsys):
    calls = []

    def popen(argv, **kwargs):
        calls.append(argv)
        raise FileNotFoundError("journalctl")

    monkeypatch.setattr(production_detector.subprocess, "Popen", popen)
    assert production_detector.main() == production_detector.EXIT_JOURNAL_SOURCE_UNAVAILABLE
    out = capsys.readouterr().out
    assert "reason=JOURNAL_SOURCE_UNAVAILABLE" in out and "Traceback" not in out and len(calls) == 1


def test_the_failure_output_is_fixed_and_non_secret(fake_popen, capsys):
    fake_popen(FakeJournal(["Failed password for secretuser from 203.0.113.1 port 22 ssh2"], status=1))
    production_detector.main()
    out = capsys.readouterr().out
    stopping = [line for line in out.splitlines() if "stopping" in line]
    assert stopping == ["[F1-DETECTOR] stopping reason=JOURNAL_SOURCE_UNAVAILABLE journal_exit=1"]
    assert "secretuser" not in out and "password" not in out.lower()


def test_transport_unavailable_still_wins_and_keeps_its_exit_code(fake_popen):
    fail = alert_sink.AlertResult(False, "SOCKET_MISSING")
    sent: list[str] = []
    detector = production_detector.ProductionDetector(lambda ip: sent.append(ip) or fail, clock=lambda: 5.0)
    lines = [f"Failed password for x from 203.0.113.{n} port 22 ssh2" for n in range(1, 10) for _ in range(production_detector.FAIL_THRESHOLD)]
    assert production_detector.run(iter(lines), detector) == production_detector.EXIT_TRANSPORT_UNAVAILABLE
    assert len(sent) == production_detector.MAX_CONSECUTIVE_TRANSPORT_FAILURES


_RealDetector = production_detector.ProductionDetector


def test_main_keeps_the_transport_exit_code_and_does_not_relabel_it(monkeypatch, fake_popen, capsys):
    lines = [f"Failed password for x from 203.0.113.{n} port 22 ssh2" for n in range(1, 10) for _ in range(production_detector.FAIL_THRESHOLD)]
    fake_popen(FakeJournal(lines, status=0))
    fail = alert_sink.AlertResult(False, "SOCKET_MISSING")
    monkeypatch.setattr(production_detector, "ProductionDetector", lambda: _RealDetector(lambda ip: fail, clock=lambda: 5.0))
    assert production_detector.main() == production_detector.EXIT_TRANSPORT_UNAVAILABLE
    out = capsys.readouterr().out
    assert "reason=ALERT_SINK_UNAVAILABLE" in out and "JOURNAL_SOURCE_UNAVAILABLE" not in out


def test_alert_detection_still_works_while_the_source_is_alive(fake_popen):
    sent: list[str] = []
    detector = _RealDetector(lambda ip: sent.append(ip) or alert_sink.AlertResult(True, "SENT_BOUND"), clock=lambda: 7.0)
    lines = ["Failed password for x from 203.0.113.50 port 22 ssh2"] * production_detector.FAIL_THRESHOLD
    assert production_detector.run(iter(lines), detector) == production_detector.EXIT_JOURNAL_SOURCE_UNAVAILABLE
    assert sent == ["203.0.113.50"]  # detection, cooldown and the single outbound path are unchanged


def test_the_repair_adds_no_network_retry_alert_or_containment_surface():
    source = (ROOT / "aegis_soc" / "production_detector.py").read_text()
    code = re.sub(r'""".*?"""', "", source, flags=re.S)
    code = "\n".join(line.split("#", 1)[0] for line in code.splitlines()).lower()
    for token in ("socket.socket", "while true", "time.sleep", "mqtt", "paho", "restore", "containment", "serial", "systemctl", "esp32", "requests", "urllib"):
        assert token not in code, token
    assert code.count("popen(") == 1  # a single follower start: no restart loop
