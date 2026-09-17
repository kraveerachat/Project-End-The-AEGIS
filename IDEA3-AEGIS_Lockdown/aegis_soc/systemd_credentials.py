"""Read runtime secrets delivered through systemd credentials."""

from __future__ import annotations

import os
import stat
from collections.abc import Mapping
from pathlib import Path


def credential_path(
    name: str,
    *,
    environ: Mapping[str, str] | None = None,
) -> Path:
    """Resolve one private regular file from systemd's credential directory."""
    values = os.environ if environ is None else environ
    root_value = values.get("CREDENTIALS_DIRECTORY", "").strip()
    if not root_value:
        raise ValueError("CREDENTIALS_DIRECTORY is not configured")

    path = Path(root_value) / name

    try:
        metadata = path.lstat()
    except OSError:
        raise ValueError(f"credential {name} is missing or unreadable") from None

    if stat.S_ISLNK(metadata.st_mode):
        raise ValueError(f"credential {name} must not be a symlink")

    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"credential {name} must be a regular file")

    mode = stat.S_IMODE(metadata.st_mode)
    if mode & 0o077:
        raise ValueError(f"credential {name} has unsafe permission mode")

    return path


def read_text_credential(
    name: str,
    *,
    environ: Mapping[str, str] | None = None,
) -> str:
    """Read one private text credential from systemd's credential directory."""
    path = credential_path(name, environ=environ)

    try:
        value = path.read_text(encoding="utf-8").removesuffix("\n")
    except (OSError, UnicodeDecodeError):
        raise ValueError(f"credential {name} is missing or unreadable") from None

    if not value:
        raise ValueError(f"credential {name} is empty")

    return value
