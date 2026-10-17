"""Real Core supervisor -> read-only bridge -> Web and Purple Desktop observer, all on one locally generated status file.

Software integration only.  The Core is the real ``aegis_soc.supervisor`` started as an isolated subprocess in the
development profile with a minimal, explicit environment: dry-run, headless, no detector/GUI/voice, no broker, no
credentials, no dispatch, no local CUT/RESTORE, no Production paths.  If the safety preflight cannot prove that, the
Core is not started.  Nothing here touches an already-running Core, a LAB service, the network, or hardware.
"""

from __future__ import annotations

import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

from tools import live_purple_observer as live
from tools import local_stack

pytestmark = [
    pytest.mark.usefixtures("restore_aegis_soc_imports"),
    pytest.mark.skipif(sys.platform != "linux", reason="inspects /proc"),
]

LOCKDOWN_ROOT = Path(__file__).resolve().parents[1]
OPERATIONAL_ENV_MARKERS = ("DISPATCH", "LOCAL_CUT", "RESTORE", "RECOVERY", "ALERT", "R1D", "MQTT_CA", "P1_", "PROTOCOL_DB")
STARTUP_TIMEOUT_S = 20.0
STOP_TIMEOUT_S = 15.0
SNAPSHOT = "/security/api/security/snapshot"


def _core_env(root: Path) -> dict[str, str]:
    """The complete environment of the test Core: nothing is inherited."""

    for name in ("home", "data", "log", "run"):
        (root / name).mkdir(parents=True, exist_ok=True)
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(root / "home"),
        "LANG": "C.UTF-8",
        "AEGIS_PROFILE": "development",
        "AEGIS_DRY_RUN": "true",
        "AEGIS_AUTO_CONTAIN": "false",
        "AEGIS_START_DETECTOR": "false",
        "AEGIS_START_GUI": "false",
        "AEGIS_VOICE_ENABLE": "false",
        "AEGIS_DATA_DIR": str(root / "data"),
        "AEGIS_RUNTIME_DIR": str(root / "run"),
        "AEGIS_RUNTIME_LOG_DIR": str(root / "log"),
        "AEGIS_DB_PATH": str(root / "data" / "core.sqlite3"),
        "AEGIS_LOG_PATH": str(root / "log" / "core.log"),
        "AEGIS_BROKER_IP": "",
        "AEGIS_MQTT_USER": "",
        "AEGIS_MQTT_PASS": "",
        "AEGIS_TG_TOKEN": "",
        "AEGIS_TG_CHAT": "",
        "AEGIS_HMAC_SECRET": "isolated-test-only",
        "AEGIS_ADMIN_PIN": "isolated-test-only",
        "AEGIS_HEALTH_INTERVAL": "1",
    }


EFFECTIVE_CONFIGURATION = """
import json, os
from aegis_soc import config, local_cut
from aegis_soc.runtime import RuntimeSettings
s = RuntimeSettings.from_profile("development", dry_run=True, start_gui=False, start_detector=False, voice_enabled=False)
errors, _ = s.preflight()
print(json.dumps({
    "profile": s.profile, "dry_run": s.dry_run, "auto_contain": s.auto_contain, "detector": s.start_detector,
    "gui": s.start_gui, "voice": s.voice_enabled, "broker_configured": config.BROKER_CONFIGURED,
    "mqtt_credentials": bool(config.MQTT_USER or config.MQTT_PASS), "telegram": bool(config.TELEGRAM_BOT_TOKEN),
    "dispatch_enabled": os.getenv("AEGIS_CORE_DISPATCH_ENABLED"), "local_cut": local_cut.enabled(config.LOCAL_CUT_ENABLED),
    "restore_credential": config.RESTORE_CREDENTIAL_FILE, "recovery_uid": config.RECOVERY_OPERATOR_UID,
    "alert_uid": config.ALERT_SOURCE_UID, "r1d": config.R1D_DISPOSITION_ENABLED,
    "runtime_dir": str(s.runtime_dir), "preflight_errors": errors,
}))
"""


def _prove_core_configuration_is_inert(root: Path, env: dict[str, str]) -> dict:
    """Ask a child with the Core's exact environment for its effective settings; refuse to launch on any doubt."""

    child = subprocess.run([sys.executable, "-c", EFFECTIVE_CONFIGURATION], cwd=LOCKDOWN_ROOT, env=env, text=True,
                           capture_output=True, timeout=30, check=False)
    assert child.returncode == 0, child.stderr[-400:]
    config = json.loads(child.stdout.strip().splitlines()[-1])
    blockers = []
    expected = {
        "profile": "development", "dry_run": True, "auto_contain": False, "detector": False, "gui": False,
        "voice": False, "broker_configured": False, "mqtt_credentials": False, "telegram": False,
        "dispatch_enabled": None, "local_cut": False, "restore_credential": "", "recovery_uid": None,
        "alert_uid": None, "r1d": "", "preflight_errors": [],
    }
    for key, value in expected.items():
        if config[key] != value:
            blockers.append(f"{key}={config[key]!r}")
    for key, value in env.items():
        if key == "AEGIS_DRY_RUN" and value != "true":
            blockers.append("AEGIS_DRY_RUN is not true")
        if key == "AEGIS_AUTO_CONTAIN" and value != "false":
            blockers.append("AEGIS_AUTO_CONTAIN is not false")
        if value and any(marker in key for marker in OPERATIONAL_ENV_MARKERS):
            blockers.append(f"{key} is set")
    if not Path(config["runtime_dir"]).resolve().is_relative_to(root.resolve()):
        blockers.append("runtime_dir is outside the test directory")
    if blockers:
        pytest.fail("refusing to start the Core, operational channel not proven inert: " + ", ".join(blockers))
    return config


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _socket_inodes(pid: int) -> set[str]:
    inodes = set()
    for fd in Path(f"/proc/{pid}/fd").iterdir():
        try:
            target = os.readlink(fd)
        except OSError:
            continue
        if target.startswith("socket:["):
            inodes.add(target[8:-1])
    return inodes


def _network_or_unix_sockets(pid: int) -> list[str]:
    owned = _socket_inodes(pid)
    found = []
    for table in ("tcp", "tcp6", "udp", "udp6", "raw", "raw6", "unix"):
        try:
            lines = Path(f"/proc/net/{table}").read_text(encoding="utf-8").splitlines()[1:]
        except OSError:
            continue
        for line in lines:
            fields = line.split()
            inode = fields[9] if table != "unix" else fields[6]
            if inode in owned:
                found.append(table)
    return found


def _port_open(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


class Web:
    """Minimal authenticated client; the generated password is read from its 0600 file and never printed."""

    def __init__(self, port: int, password_file: Path):
        self.port = port
        self._password = password_file.read_text(encoding="utf-8").strip()
        self._cookies: dict[str, str] = {}

    def call(self, method: str, path: str, body: dict | None = None):
        headers = {"Accept": "application/json", "Origin": f"http://127.0.0.1:{self.port}"}
        if self._cookies:
            headers["Cookie"] = "; ".join(f"{name}={value}" for name, value in self._cookies.items())
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        try:
            conn.request(method, path, body=data, headers=headers)
            response = conn.getresponse()
            raw = response.read()
            for header in response.msg.get_all("Set-Cookie") or []:
                name, _, rest = header.partition("=")
                self._cookies[name] = rest.split(";", 1)[0]
        finally:
            conn.close()
        return response.status, (json.loads(raw) if raw else None)

    def login(self):
        return self.call("POST", "/security/api/auth/login", {"username": "admin", "password": self._password})[0]

    def runtime(self) -> dict:
        status, snapshot = self.call("GET", SNAPSHOT)
        assert status == 200 and snapshot["mode"] == "LIVE"
        return snapshot["runtime"]


@pytest.fixture(scope="module")
def stack(tmp_path_factory):
    root = tmp_path_factory.mktemp("core-web-desktop")
    env = _core_env(root)
    configuration = _prove_core_configuration_is_inert(root, env)
    runtime_dir = Path(configuration["runtime_dir"])
    status_file = runtime_dir / "status.json"
    assert not status_file.exists(), "status.json must be produced by the Core, not pre-seeded"

    web_state = root / "web-state"
    web_port = local_stack._free_port()
    base = ["--state-dir", str(web_state)]
    launched_at = time.time()
    core = subprocess.Popen(
        [sys.executable, "-m", "aegis_soc.supervisor", "--profile", "development", "--dry-run", "--headless",
         "--no-detector", "--no-voice"],
        cwd=LOCKDOWN_ROOT, env=env, stdin=subprocess.DEVNULL,
        stdout=(root / "core.out").open("wb"), stderr=subprocess.STDOUT, start_new_session=True,
    )
    web = None
    try:
        deadline = time.monotonic() + STARTUP_TIMEOUT_S
        while time.monotonic() < deadline:
            document = _read_json(status_file)
            if document and document.get("pid") == core.pid and document.get("state") == "RUNNING":
                break
            assert core.poll() is None, f"Core exited early (rc={core.returncode})"
            time.sleep(0.2)
        else:
            pytest.fail("Core did not publish a RUNNING status.json in time")

        assert local_stack.main([*base, "start", "--status-file", str(status_file), "--web-port", str(web_port)]) == 0
        web = Web(web_port, web_state / "web-dev-password")
        assert web.login() == 200
        yield {
            "root": root, "core": core, "status_file": status_file, "web": web, "web_port": web_port,
            "web_state": web_state, "launched_at": launched_at, "bridge_port": json.loads(
                (web_state / "stack.json").read_text(encoding="utf-8"))["bridge_port"],
        }
    finally:
        if core.poll() is None:
            core.send_signal(signal.SIGTERM)
            try:
                core.wait(timeout=STOP_TIMEOUT_S)
            except subprocess.TimeoutExpired:
                core.kill()
                core.wait(timeout=5)
        local_stack.main([*base, "stop"])


def test_core_configuration_was_proven_inert_before_launch(stack):
    configuration = _prove_core_configuration_is_inert(stack["root"], _core_env(stack["root"]))
    assert configuration["profile"] == "development" and configuration["dry_run"] is True


def test_status_file_is_written_by_the_running_core_and_keeps_advancing(stack):
    core = stack["core"]
    first = _read_json(stack["status_file"])
    assert first["pid"] == core.pid, "the file names the spawned Core process"
    assert stack["status_file"].stat().st_mtime >= stack["launched_at"] - 1, "written after this test launched the Core"
    time.sleep(2.2)
    second = _read_json(stack["status_file"])
    assert second["updated_at"] > first["updated_at"], "a live Core keeps refreshing its evidence"
    assert (second["state"], second["dry_run"], second["dispatch"], second["profile"]) == ("RUNNING", True, "DISABLED", "development")
    assert second["auto_contain"] is False


def test_the_core_holds_no_network_or_unix_socket_and_no_production_channel(stack):
    assert _network_or_unix_sockets(stack["core"].pid) == [], "dry-run Core with no broker opens no socket"
    assert sorted(path.name for path in (stack["root"] / "run").iterdir()) == ["status.json", "supervisor.lock", "supervisor.pid"]


def test_web_receives_fresh_core_evidence_but_dry_run_is_never_healthy(stack):
    web = stack["web"]
    assert web.call("GET", SNAPSHOT.replace("snapshot", "lab-mqtt"))[1]["enabled"] is False, "LAB MQTT stays disabled"
    runtime = web.runtime()
    assert runtime["freshness"] == "FRESH"
    assert runtime["status"] == "UNKNOWN", "a dry-run Core is not reported as an operational runtime"
    assert runtime["modes"]["dryRun"] is True and runtime["modes"]["autoContain"] is False
    assert runtime["modes"]["recoveryAuthorized"] is False
    components = {item["id"]: item["status"] for item in runtime["components"]}
    assert components["relay"] == components["heartbeat"] == components["ack"] == "UNKNOWN", "nothing physical is inferred"
    assert components["broker"] == components["esp32"] == components["uplink"] == "UNKNOWN"


def test_web_session_is_required_for_the_snapshot(stack):
    anonymous = Web(stack["web_port"], stack["web_state"] / "web-dev-password")
    assert anonymous.call("GET", SNAPSHOT)[0] == 401


def test_purple_desktop_observer_reads_the_same_file_with_the_same_semantics(stack):
    evidence = live.reader.read_observer_status(stack["status_file"])
    assert evidence.valid and evidence.freshness == "FRESH"
    assert evidence.runtime_state == "RUNNING" and evidence.profile == "development"
    assert evidence.dry_run == "TRUE" and evidence.auto_contain == "FALSE" and evidence.dispatch == "DISABLED"
    assert evidence.broker == evidence.device == evidence.uplink == "UNKNOWN"
    assert evidence.physical_verification == "NOT_VERIFIED" and evidence.physical_source == "OPERATOR_OBSERVED_ONLY"
    values = live.evidence_values(evidence)
    assert values["runtime"] == "RUNNING" and values["dispatch"] == "DISABLED" and values["freshness"] == "FRESH"
    assert values["broker"] == values["device"] == values["uplink"] == "UNKNOWN"
    assert not any("ACK" in str(key).upper() or "HEARTBEAT" in str(key).upper() for key in values), "no ACK or heartbeat is fabricated"


def test_stopping_only_the_test_core_ends_in_shutdown_and_web_is_not_healthy(stack):
    core = stack["core"]
    core.send_signal(signal.SIGTERM)
    assert core.wait(timeout=STOP_TIMEOUT_S) == 0
    final = _read_json(stack["status_file"])
    assert final["state"] == "SHUTDOWN" and final["uplink"] == "UNKNOWN"
    assert "uplink state unchanged" in final["detail"], "shutdown never restores or changes the uplink"
    runtime = stack["web"].runtime()
    assert runtime["status"] == "FAILED" and runtime["status"] != "HEALTHY"
    assert live.reader.read_observer_status(stack["status_file"]).runtime_state == "SHUTDOWN"


def test_stale_invalid_and_missing_evidence_fail_closed_in_web_and_desktop(stack):
    status_file, web = stack["status_file"], stack["web"]
    template = _read_json(status_file)

    stale = dict(template, state="RUNNING", updated_at=time.time() - 3_600)
    status_file.write_text(json.dumps(stale), encoding="utf-8")
    assert web.runtime()["status"] == "UNKNOWN" and web.runtime()["freshness"] == "STALE"
    evidence = live.reader.read_observer_status(status_file)
    assert not evidence.valid and evidence.freshness == "STALE" and evidence.uplink == "UNKNOWN"

    status_file.write_text("{not json", encoding="utf-8")
    assert web.runtime()["status"] == "UNKNOWN"
    assert live.reader.read_observer_status(status_file).freshness == "INVALID"

    contradiction = dict(template, state="LOCKDOWN", uplink="NORMAL", updated_at=time.time())
    status_file.write_text(json.dumps(contradiction), encoding="utf-8")
    assert live.reader.read_observer_status(status_file).freshness == "CONTRADICTORY"

    status_file.unlink()
    assert web.runtime()["status"] == "UNKNOWN"
    missing = live.reader.read_observer_status(status_file)
    assert not missing.valid and missing.freshness == "MISSING"
    assert all(value == "UNKNOWN" for value in (live.evidence_values(missing)[key] for key in ("runtime", "broker", "device", "uplink", "dispatch")))


def test_cleanup_stops_every_test_owned_process_and_listener(stack):
    base = ["--state-dir", str(stack["web_state"])]
    assert local_stack.main([*base, "stop"]) == 0
    assert local_stack.main([*base, "status"]) == 3
    assert stack["core"].poll() is not None
    assert not _port_open(stack["web_port"]) and not _port_open(stack["bridge_port"])
