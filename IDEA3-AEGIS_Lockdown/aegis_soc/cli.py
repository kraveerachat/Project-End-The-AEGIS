"""User-facing lifecycle commands for the AEGIS autonomous supervisor."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

from . import config
from . import local_restore as lr
from .runtime import RuntimeSettings, read_status


def _common_start_flags(parser, *, foreground=True):
    parser.add_argument("--profile", choices=("development", "lab", "production"), default="development")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=None)
    mode.add_argument("--live", action="store_false", dest="dry_run")
    gui = parser.add_mutually_exclusive_group()
    gui.add_argument("--gui", action="store_true", default=None)
    gui.add_argument("--headless", action="store_false", dest="gui")
    detector = parser.add_mutually_exclusive_group()
    detector.add_argument("--detector", action="store_true", default=None)
    detector.add_argument("--no-detector", action="store_false", dest="detector")
    voice = parser.add_mutually_exclusive_group()
    voice.add_argument("--voice", action="store_true", default=None)
    voice.add_argument("--no-voice", action="store_false", dest="voice")
    if foreground:
        parser.add_argument("--foreground", action="store_true")


def _settings(args) -> RuntimeSettings:
    return RuntimeSettings.from_profile(
        args.profile,
        dry_run=args.dry_run,
        start_gui=args.gui,
        start_detector=args.detector,
        voice_enabled=args.voice,
    )


def _supervisor_args(args) -> list[str]:
    values = ["--profile", args.profile]
    if args.dry_run is not None:
        values.append("--dry-run" if args.dry_run else "--live")
    if args.gui is not None:
        values.append("--gui" if args.gui else "--headless")
    if args.detector is not None:
        values.append("--detector" if args.detector else "--no-detector")
    if args.voice is not None:
        values.append("--voice" if args.voice else "--no-voice")
    return values


def _pid_alive(pid: int) -> bool:
    if pid <= 1:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def _is_expected_supervisor(pid: int) -> bool:
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\x00", b" ")
    except OSError:
        return False
    return b"aegis_soc.supervisor" in cmdline


def command_start(args) -> int:
    settings = _settings(args)
    current = read_status(settings.status_path)
    if current and _pid_alive(int(current.get("pid", 0))) and _is_expected_supervisor(int(current["pid"])):
        print(f"AEGIS supervisor already running (pid {current['pid']})")
        return 2

    command = [sys.executable, "-m", "aegis_soc.supervisor", *_supervisor_args(args)]
    if args.foreground:
        return subprocess.run(command, check=False).returncode

    settings.log_dir.mkdir(parents=True, exist_ok=True)
    console_path = settings.log_dir / "aegis-supervisor.log"
    with console_path.open("a", encoding="utf-8") as output:
        process = subprocess.Popen(
            command,
            cwd=Path(__file__).resolve().parent.parent,
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        status = read_status(settings.status_path)
        if status and status.get("pid") == process.pid:
            print(f"AEGIS supervisor started (pid {process.pid}, state {status['state']})")
            return 0 if status["state"] != "FAILED" else 2
        if process.poll() is not None:
            print(f"AEGIS supervisor exited during startup; see {console_path}", file=sys.stderr)
            return process.returncode or 1
        time.sleep(0.1)
    print(f"AEGIS supervisor startup status timed out; see {console_path}", file=sys.stderr)
    return 1


def command_status(args) -> int:
    settings = RuntimeSettings.from_profile("development")
    status = read_status(settings.status_path)
    if not status:
        print("AEGIS supervisor: STOPPED (no runtime status)")
        return 3
    pid = int(status.get("pid", 0))
    live = _pid_alive(pid) and _is_expected_supervisor(pid)
    status["process"] = "RUNNING" if live else "STOPPED/STALE"
    print(json.dumps(status, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if live and status.get("state") not in {"FAILED", "DEGRADED"} else 2


def command_stop(args) -> int:
    settings = RuntimeSettings.from_profile("development")
    status = read_status(settings.status_path)
    pid = int(status.get("pid", 0)) if status else 0
    if not _pid_alive(pid):
        print("AEGIS supervisor is not running")
        return 0
    if not _is_expected_supervisor(pid):
        print(f"Refusing to signal unexpected process {pid}", file=sys.stderr)
        return 2
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + args.timeout
    while time.monotonic() < deadline:
        if not _pid_alive(pid):
            print("AEGIS supervisor stopped; uplink state was not changed")
            return 0
        time.sleep(0.1)
    print("Supervisor did not stop before timeout; no forced kill was sent", file=sys.stderr)
    return 1


def command_doctor(args) -> int:
    settings = _settings(args)
    errors, warnings = settings.preflight()
    print(f"profile={settings.profile} dry_run={settings.dry_run} auto_contain={settings.auto_contain}")
    for warning in warnings:
        print(f"WARN: {warning}")
    for error in errors:
        print(f"FAIL: {error}")
    if errors:
        print("doctor: FAILED")
        return 2
    print("doctor: PASS (broker/device reachability remains a recoverable runtime check)")
    return 0


def command_logs(args) -> int:
    settings = RuntimeSettings.from_profile("development")
    path = settings.log_dir / ("aegis-events.jsonl" if args.structured else "aegis-supervisor.log")
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        print(f"No log file yet: {path}")
        return 3
    for line in lines[-args.lines:]:
        print(line)
    return 0


def command_test(args) -> int:
    root = Path(__file__).resolve().parent.parent
    return subprocess.run([sys.executable, "-m", "pytest", "-q"], cwd=root, check=False).returncode


def _print_restore_result(response) -> None:
    print(f"RESTORE result: {response.get('code', 'INVALID_RESPONSE')}")
    detail = response.get("detail")
    if detail:
        print(detail)
    evidence = response.get("evidence") or {}
    for rung in ("requested", "published", "ack", "executed", "relay_confirmation", "physical_evidence"):
        print(f"{rung}: {evidence.get(rung, 'UNKNOWN')}")
    print("Protocol ACK/STATUS is not physical evidence.")


def command_restore(
    args,
    *,
    isatty=None,
    read_secret=getpass.getpass,
    read_line=input,
    send=lr.send_request,
    sleep=time.sleep,
    monotonic=time.monotonic,
) -> int:
    isatty = sys.stdin.isatty if isatty is None else isatty
    problem = lr.reason_problem(args.reason)
    if problem:
        print(f"RESTORE refused: {problem}", file=sys.stderr)
        return 2
    if not isatty():
        print("RESTORE refused: an interactive local terminal is required", file=sys.stderr)
        return 2
    secret = read_secret("Local RESTORE operator secret: ")
    if not secret:
        print("RESTORE refused: operator authentication is required", file=sys.stderr)
        return 2
    typed = read_line(f"Type {lr.CONFIRMATION!r} exactly to continue: ")
    if typed != lr.CONFIRMATION:
        print("RESTORE refused: confirmation did not match", file=sys.stderr)
        return 2
    if args.wait < 0 or args.wait > 300:
        print("RESTORE refused: --wait must be between 0 and 300 seconds", file=sys.stderr)
        return 2
    path = RuntimeSettings.from_profile("development").runtime_dir / lr.CHANNEL_NAME
    try:
        response = send(path, lr.restore_request(secret, typed, args.reason), timeout=5)
    except lr.ChannelUnavailable:
        print("Core-local RESTORE unavailable; nothing was sent", file=sys.stderr)
        return 1
    except lr.OutcomeUnknown:
        print("OUTCOME_UNKNOWN: the result was lost; do not re-run RESTORE", file=sys.stderr)
        return 4
    _print_restore_result(response)
    if response.get("code") == "OUTCOME_UNKNOWN":
        print("OUTCOME_UNKNOWN: do not re-run RESTORE", file=sys.stderr)
        return 4
    if not response.get("ok"):
        return 2
    if not args.wait:
        return 0

    msg_id = response.get("msg_id")
    deadline = monotonic() + args.wait
    while monotonic() < deadline:
        sleep(min(1.0, max(0.0, deadline - monotonic())))
        try:
            evidence = send(path, lr.evidence_request(msg_id), timeout=5)
        except lr.ChannelUnavailable:
            print("Evidence channel unavailable; the published outcome is unchanged", file=sys.stderr)
            return 1
        except lr.OutcomeUnknown:
            print("OUTCOME_UNKNOWN while reading evidence; RESTORE was not resent", file=sys.stderr)
            return 4
        _print_restore_result(evidence)
        ladder = evidence.get("evidence") or {}
        if str(ladder.get("ack", "")).startswith("REJECTED"):
            return 3
        if ladder.get("executed") == "DEVICE_REPORTED_NORMAL":
            return 0
        if ladder.get("executed") != "NOT_OBSERVED":
            print("RESTORE did not produce a device-reported NORMAL state", file=sys.stderr)
            return 3
    print("PENDING: RESTORE evidence deadline reached; command was not resent", file=sys.stderr)
    return 3


def command_restore_credential(args, *, isatty=None, read_secret=getpass.getpass) -> int:
    isatty = sys.stdin.isatty if isatty is None else isatty
    if not isatty():
        print("Credential provisioning requires an interactive local terminal", file=sys.stderr)
        return 2
    target = args.output or config.RESTORE_CREDENTIAL_FILE
    if not target:
        print("Credential output path is required", file=sys.stderr)
        return 2
    first = read_secret("New local RESTORE operator secret: ")
    second = read_secret("Repeat local RESTORE operator secret: ")
    if first != second or not isinstance(first, str) or len(first) < lr.SECRET_MIN_CHARS:
        print("Credential refused: secrets must match and meet the minimum length", file=sys.stderr)
        return 2
    try:
        lr.write_credential(target, first)
    except (FileExistsError, OSError, ValueError):
        print("Credential refused: output exists or cannot be written safely", file=sys.stderr)
        return 2
    print(f"Private local RESTORE credential written to {target}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="aegisctl", description="AEGIS IDEA3 autonomous runtime")
    sub = parser.add_subparsers(dest="command", required=True)
    start = sub.add_parser("start")
    _common_start_flags(start)
    start.set_defaults(handler=command_start)
    restart = sub.add_parser("restart")
    _common_start_flags(restart)
    restart.add_argument("--timeout", type=float, default=10)
    restart.set_defaults(handler=None)
    stop = sub.add_parser("stop")
    stop.add_argument("--timeout", type=float, default=10)
    stop.set_defaults(handler=command_stop)
    status = sub.add_parser("status")
    status.set_defaults(handler=command_status)
    doctor = sub.add_parser("doctor")
    _common_start_flags(doctor, foreground=False)
    doctor.set_defaults(handler=command_doctor)
    logs = sub.add_parser("logs")
    logs.add_argument("-n", "--lines", type=int, default=50)
    logs.add_argument("--structured", action="store_true")
    logs.set_defaults(handler=command_logs)
    test = sub.add_parser("test")
    test.set_defaults(handler=command_test)
    restore = sub.add_parser("restore", help="request one authenticated Core-local RESTORE")
    restore.add_argument("--reason")
    restore.add_argument("--wait", type=float, default=0.0)
    restore.set_defaults(handler=command_restore)
    credential = sub.add_parser("restore-credential", help="provision a private local RESTORE credential")
    credential.add_argument("--output")
    credential.set_defaults(handler=command_restore_credential)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "restart":
        stop_result = command_stop(args)
        return stop_result if stop_result else command_start(args)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
