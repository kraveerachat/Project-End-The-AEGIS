"""Local start/status/stop for the IDEA3 Web Security Center and its read-only Core status bridge.

Local development aid only.  It starts two loopback processes: the read-only status bridge
(``tools/local_status_bridge.py``) and the Web server (``web/server/index.js``) in development mode.  It never
runs sudo, publishes MQTT, starts the Core, or touches hardware, the broker, or the network.  The optional LAB MQTT
observer is off unless ``--lab-mqtt`` is given.  The generated development password stays in a 0600 file inside the
state directory and is never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

LOCKDOWN_ROOT = Path(__file__).resolve().parents[1]
WEB_ROOT = LOCKDOWN_ROOT / "web"
DEFAULT_STATE_DIR = Path.home() / ".local" / "state" / "aegis-idea3-local"
DEFAULT_WEB_PORT = 18195
BASE_PATH = "/security"
PROCESSES = ("bridge", "web")
STOP_TIMEOUT_S = 8.0


def _state_dir(args) -> Path:
    path = Path(args.state_dir).expanduser().resolve()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def _pid_file(state: Path, name: str) -> Path:
    return state / f"{name}.pid"


def _read_record(state: Path, name: str):
    try:
        return json.loads(_pid_file(state, name).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _cmdline(pid: int) -> str:
    try:
        return Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
    except OSError:
        return ""


def _alive(record) -> bool:
    """A recorded process counts as ours only if the pid is live and still runs the recorded command."""

    if not record:
        return False
    cmdline = _cmdline(int(record["pid"]))
    return bool(cmdline) and record["marker"] in cmdline


def _port_free(port: int) -> bool:
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _http_status(url: str, timeout: float = 2.0):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (OSError, ValueError):
        return None


def _web_env(args, state: Path, bridge_url: str) -> dict:
    env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG") if key in os.environ}
    password_file = state / "web-dev-password"
    if not password_file.exists():
        fd = os.open(password_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(secrets.token_urlsafe(18))
    env.update(
        NODE_ENV="development",
        PORT=str(args.web_port),
        AEGIS_BIND_HOST="127.0.0.1",
        AEGIS_ALLOW_DEV_LOGIN="true",
        AEGIS_IDEA3_DEV_PASSWORD=password_file.read_text(encoding="utf-8").strip(),
        AEGIS_IDEA3_AUDIT_DB_PATH=str(state / "web-audit.sqlite3"),
        AEGIS_WEB_STATIC_DIR=str(WEB_ROOT / "dist"),
        AEGIS_WEB_BASE_PATH=BASE_PATH,
        AEGIS_IDEA3_LAB_RUNTIME_STATUS="true",
        AEGIS_IDEA3_RUNTIME_STATUS_URL=bridge_url,
    )
    if args.lab_mqtt:
        env["AEGIS_IDEA3_LAB_MQTT_OBSERVER"] = "true"
    return env


def _spawn(state: Path, name: str, argv: list[str], env: dict, cwd: Path, marker: str) -> int:
    log = open(state / f"{name}.log", "ab")  # noqa: SIM115 - handed to the child
    process = subprocess.Popen(
        argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True,
    )
    log.close()
    _pid_file(state, name).write_text(json.dumps({"pid": process.pid, "marker": marker}), encoding="utf-8")
    return process.pid


def command_start(args) -> int:
    state = _state_dir(args)
    if any(_alive(_read_record(state, name)) for name in PROCESSES):
        print("already running; use 'status' or 'stop' first", file=sys.stderr)
        return 1
    if not args.status_file.is_absolute():
        print("--status-file must be an absolute path (it is only read, never written)", file=sys.stderr)
        return 2
    if not (WEB_ROOT / "dist" / "index.html").is_file():
        print("web/dist is missing: run 'npm ci && npm run build' in IDEA3-AEGIS_Lockdown/web", file=sys.stderr)
        return 2
    if not _port_free(args.web_port):
        print(f"port {args.web_port} is already in use", file=sys.stderr)
        return 2

    bridge_port = _free_port()
    bridge_url = f"http://127.0.0.1:{bridge_port}/status"
    bridge_env = {key: os.environ[key] for key in ("PATH", "HOME", "LANG") if key in os.environ}
    _spawn(
        state, "bridge",
        [sys.executable, "-m", "tools.local_status_bridge", "--status-file", str(args.status_file), "--port", str(bridge_port)],
        bridge_env, LOCKDOWN_ROOT, "tools.local_status_bridge",
    )
    _spawn(state, "web", ["node", "server/index.js"], _web_env(args, state, bridge_url), WEB_ROOT, "server/index.js")

    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        if _http_status(bridge_url) == 200 and _http_status(f"http://127.0.0.1:{args.web_port}{BASE_PATH}/") == 200:
            (state / "stack.json").write_text(
                json.dumps({"web_port": args.web_port, "bridge_port": bridge_port, "status_file": str(args.status_file)}),
                encoding="utf-8",
            )
            print(f"Web: http://127.0.0.1:{args.web_port}{BASE_PATH}/  (login user 'admin'; password file {state / 'web-dev-password'})")
            print(f"Core status bridge (read-only): {bridge_url}")
            return 0
        time.sleep(0.3)
    print("stack did not become ready; see logs in", state, file=sys.stderr)
    command_stop(args)
    return 1


def command_status(args) -> int:
    state = _state_dir(args)
    try:
        info = json.loads((state / "stack.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        info = {}
    healthy = True
    for name in PROCESSES:
        record = _read_record(state, name)
        up = _alive(record)
        healthy &= up
        print(f"{name}: {'RUNNING pid ' + str(record['pid']) if up else 'STOPPED'}")
    if info and healthy:
        web = _http_status(f"http://127.0.0.1:{info['web_port']}{BASE_PATH}/")
        bridge = _http_status(f"http://127.0.0.1:{info['bridge_port']}/status")
        print(f"web http: {web}; bridge http: {bridge}")
        healthy &= web == 200 and bridge == 200
    return 0 if healthy else 3


def command_stop(args) -> int:
    state = _state_dir(args)
    for name in reversed(PROCESSES):
        record = _read_record(state, name)
        if _alive(record):
            pid = int(record["pid"])
            os.killpg(pid, signal.SIGTERM)
            deadline = time.monotonic() + STOP_TIMEOUT_S
            while time.monotonic() < deadline and _alive(record):
                time.sleep(0.1)
            if _alive(record):
                os.killpg(pid, signal.SIGKILL)
            print(f"{name}: stopped")
        else:
            print(f"{name}: not running")
        _pid_file(state, name).unlink(missing_ok=True)
    (state / "stack.json").unlink(missing_ok=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="local_stack", description=__doc__.splitlines()[0])
    parser.add_argument("--state-dir", default=str(DEFAULT_STATE_DIR))
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start", help="start the read-only status bridge and the Web server")
    start.add_argument("--status-file", type=Path, required=True, help="absolute path of the Core status.json to project")
    start.add_argument("--web-port", type=int, default=DEFAULT_WEB_PORT)
    start.add_argument("--lab-mqtt", action="store_true", help="enable the read-only LAB MQTT observer (needs the owner-only options file)")
    start.set_defaults(handler=command_start)
    commands.add_parser("status", help="show process and HTTP health").set_defaults(handler=command_status)
    commands.add_parser("stop", help="stop both processes").set_defaults(handler=command_stop)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    sys.exit(main())
