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

from aegis_soc.paths import RuntimePaths
from aegis_soc.windows_launcher import (
    LauncherSettings,
    doctor_command,
    logs_command,
    open_command,
    status_command,
    write_configuration,
)

DEFAULT_WEB_PORT = 8003
DEFAULT_CONTROL_PORT = 8103


def _settings(arguments: argparse.Namespace) -> LauncherSettings:
    application_root = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent.parent))
    settings = LauncherSettings(
        application_root=application_root,
        paths=RuntimePaths.resolve(),
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


def _configure(settings: LauncherSettings, arguments: argparse.Namespace) -> int:
    import getpass

    password = getpass.getpass("Admin password: ")
    confirmation = getpass.getpass("Confirm password: ")
    if password != confirmation:
        print("configure: PASSWORD_MISMATCH")
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
    parser.add_argument("--profile", default="production", choices=["development", "lab", "production"])
    parser.add_argument("--web-port", type=int, default=DEFAULT_WEB_PORT)
    parser.add_argument("--dry-run", action="store_true", default=True)
    subcommands = parser.add_subparsers(dest="command", required=True)

    configure = subcommands.add_parser("configure", help="write the external configuration")
    configure.add_argument("--username", default="admin")
    configure.add_argument("--force", action="store_true")

    subcommands.add_parser("status", help="report launcher status")
    subcommands.add_parser("open", help="open the Security Center after Web health succeeds")
    subcommands.add_parser("doctor", help="validate configuration, payload, paths, and ports")
    logs = subcommands.add_parser("logs", help="tail the external Core log")
    logs.add_argument("--lines", type=int, default=200)
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    settings = _settings(arguments)

    if arguments.command == "configure":
        return _configure(settings, arguments)
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
