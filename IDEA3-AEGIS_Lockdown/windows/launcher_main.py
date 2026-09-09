"""Console entry point for the AEGIS IDEA3 Windows standalone launcher.

This is the only executable surface of the bundle. It exposes evaluator commands
over the local install and never opens a broker, device, or relay path.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from aegis_soc.paths import RuntimePaths, application_root
from aegis_soc.windows_launcher import (
    LauncherSettings,
    doctor_command,
    logs_command,
    open_command,
    start_command,
    status_command,
    stop_command,
    write_configuration,
)

DEFAULT_WEB_PORT = 8003
DEFAULT_CONTROL_PORT = 8103


def _settings(arguments: argparse.Namespace) -> LauncherSettings:
    # A one-folder bundle stages node/, server/ and web/ beside the executable;
    # sys._MEIPASS points at _internal, which holds none of them.
    settings = LauncherSettings(
        application_root=application_root(),
        paths=RuntimePaths.from_environment(),
        profile=arguments.profile,
        dry_run=arguments.dry_run,
        web_port=arguments.web_port,
        control_port=DEFAULT_CONTROL_PORT,
        bind_host="127.0.0.1",
        open_browser=False,
    )
    settings.validate()
    return settings


def _node_password_hasher(settings: LauncherSettings):
    """Hash through the bundled Node helper so bcrypt has a single implementation.

    The password is written to the helper's stdin only; it never appears in a
    command argument, an environment variable, or this process's output.
    """
    import subprocess

    def hash_password(password: str) -> str:
        completed = subprocess.run(
            [str(settings.node_executable), str(settings.application_root / "server" / "passwordHash.js")],
            input=f"{password}\n",
            capture_output=True,
            text=True,
            check=False,
        )
        digest = completed.stdout.strip()
        if completed.returncode != 0 or not digest.startswith("$2"):
            raise RuntimeError("password hashing failed")
        return digest

    return hash_password


def _read_secret(prompt: str) -> str:
    """Read one secret line without ever echoing or storing it.

    A redirected stdin is read directly: on Windows ``getpass.getpass`` calls
    ``msvcrt.getwch()``, which reads the console and never sees a pipe, so the
    documented stdin-only automation contract has to bypass it. An interactive
    console still gets hidden entry.
    """
    stream = sys.stdin
    if stream is not None and not stream.isatty():
        line = stream.readline()
        if not line:
            raise EOFError("no credential was supplied on stdin")
        return line.rstrip("\r\n")

    import getpass

    return getpass.getpass(prompt)


def _configure(settings: LauncherSettings, arguments: argparse.Namespace) -> int:
    try:
        password = _read_secret("Admin password: ")
        confirmation = _read_secret("Confirm password: ")
    except EOFError:
        print("configure: NO_CREDENTIAL_ON_STDIN")
        return 2
    if password != confirmation:
        print("configure: PASSWORD_MISMATCH")
        return 2
    if not password:
        print("configure: EMPTY_PASSWORD")
        return 2

    path = write_configuration(
        settings,
        username=arguments.username,
        password=password,
        password_hasher=_node_password_hasher(settings),
        force=arguments.force,
    )
    print(f"configure: OK ({path})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="AEGIS-IDEA3", description="AEGIS IDEA3 standalone launcher")
    parser.add_argument("--profile", default="lab", choices=["development", "lab", "production"])
    parser.add_argument("--web-port", type=int, default=DEFAULT_WEB_PORT)
    parser.add_argument("--dry-run", action="store_true", default=True)
    subcommands = parser.add_subparsers(dest="command", required=True)

    configure = subcommands.add_parser("configure", help="write the external configuration")
    configure.add_argument("--username", default="admin")
    configure.add_argument("--force", action="store_true")

    subcommands.add_parser("start", help="run Core then Web until stop is requested")
    subcommands.add_parser("stop", help="stop through the authenticated local control boundary")
    subcommands.add_parser("status", help="report launcher status")
    subcommands.add_parser("open", help="open the Security Center after Web health succeeds")
    subcommands.add_parser("doctor", help="validate configuration, payload, paths, and ports")
    logs = subcommands.add_parser("logs", help="tail the external Core log")
    logs.add_argument("--lines", type=int, default=200)
    return parser


def main(argv: list[str] | None = None) -> int:
    raw_arguments = list(sys.argv[1:] if argv is None else argv)

    # Internal child entry point: a frozen bundle is the only Python runtime it
    # has, so LauncherRuntime re-invokes this executable as Core. The supervisor
    # owns its own flags and configuration, so its argv is forwarded untouched
    # rather than reinterpreted by the launcher parser.
    if raw_arguments and raw_arguments[0] == "core":
        from aegis_soc.supervisor import main as supervisor_main

        return supervisor_main(raw_arguments[1:])

    arguments = build_parser().parse_args(argv)
    try:
        settings = _settings(arguments)
    except ValueError as error:
        # Fail closed with a diagnosable line instead of a frozen-executable traceback.
        print(f"launcher: INVALID_SETTINGS ({error})")
        return 2

    if arguments.command == "configure":
        return _configure(settings, arguments)
    if arguments.command == "start":
        return start_command(settings)
    if arguments.command == "stop":
        import urllib.error
        import urllib.request

        def post(url: str, headers: dict[str, str]) -> int:
            request = urllib.request.Request(url, method="POST", data=b"", headers=headers)
            try:
                with urllib.request.urlopen(request, timeout=10) as response:
                    return response.status
            except urllib.error.HTTPError as error:
                return error.code
            except (urllib.error.URLError, OSError):
                return 0

        return stop_command(settings, post=post)
    if arguments.command == "status":
        return status_command(settings)
    if arguments.command == "logs":
        return logs_command(settings, lines=arguments.lines)
    if arguments.command == "doctor":
        return doctor_command(settings)
    if arguments.command == "open":
        import urllib.error
        import urllib.request

        def health_check(url: str) -> bool:
            try:
                with urllib.request.urlopen(url, timeout=3) as response:
                    return 200 <= response.status < 400
            except (urllib.error.URLError, OSError):
                return False

        return open_command(settings, health_check=health_check)
    return 2


if __name__ == "__main__":
    sys.exit(main())
