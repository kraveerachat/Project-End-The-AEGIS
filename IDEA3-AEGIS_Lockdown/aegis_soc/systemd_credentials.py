"""Read runtime secrets delivered through systemd credentials."""

from __future__ import annotations

import os
import stat
from collections.abc import Mapping
from pathlib import Path

# The one, real, non-configurable directory systemd's LoadCredential= ever places credentials under
# (systemd.exec(5)): /run/credentials/<escaped-unit-name>/. It is root-owned, created exclusively by
# PID 1, and private per unit -- an unprivileged caller cannot populate a file there for a unit it
# does not own. Module-level (not a literal in the function) so tests can monkeypatch it to a tmp_path
# prefix instead of requiring real root/systemd; production code always checks this real constant.
_SYSTEMD_MANAGED_CREDENTIALS_ROOT = Path("/run/credentials")


def _is_systemd_managed_credentials_directory(root_value: str) -> bool:
    """True only when root_value resolves to exactly one path segment directly under the genuine,
    root-owned systemd credentials tree -- never true for an arbitrary caller-supplied directory,
    however it happens to be named."""
    try:
        resolved = Path(root_value).resolve(strict=True)
        managed_root = _SYSTEMD_MANAGED_CREDENTIALS_ROOT.resolve(strict=True)
    except OSError:
        return False
    try:
        relative = resolved.relative_to(managed_root)
    except ValueError:
        return False
    return len(relative.parts) == 1 and relative.parts[0] not in ("", ".", "..")


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
    # Narrow compatibility exception: modern systemd may materialize a LoadCredential= file as 0440
    # (owner+group readable) with a POSIX ACL restricting the extra grant to the exact service
    # account, rather than preserving the source file's 0600. Accept EXACTLY that mode, and only
    # under a genuine systemd-managed credentials directory -- never a looser mode, and never an
    # arbitrary caller-supplied 0440 file merely named to look right.
    if mode & 0o077 and (mode != 0o440 or not _is_systemd_managed_credentials_directory(root_value)):
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
