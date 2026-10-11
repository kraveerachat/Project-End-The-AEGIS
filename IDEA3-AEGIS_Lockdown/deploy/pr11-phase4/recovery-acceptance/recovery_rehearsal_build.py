#!/usr/bin/env python3
"""Recovery NON-CONSUMING rehearsal builder (repository tooling; authorises nothing, runs nothing, writes only into a private directory it is given).

It derives a REHEARSAL COPY of a frozen Recovery runner:

    DERIVED = (frozen runner up to, but excluding, its final ``if recovery_run_attempt`` block)
              + the reviewed rehearsal driver library (read from the EXPECTED_MAIN Git object, replacement objects disabled)
              + one call to ``recovery_rehearse``

The frozen runner is only READ: it is never modified, renamed, re-moded or executed. Before anything is derived the frozen runner must be byte-for-byte the
reviewed template plus ONLY the approved pin substitutions (the existing freeze tool's check), and its tail must be exactly the known attempt block, so any
future change to that block makes this builder refuse until the rehearsal is re-reviewed. The derived copy has a different SHA-256 from the frozen runner; the
driver is told the FROZEN digest, which is the one an Authorization names.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import recovery_runner_freeze as freeze  # noqa: E402  (the existing reviewed freeze/verify tool; this file must sit next to it)

DRIVER_REL = "IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/recovery-acceptance/recovery_preflight_rehearsal.sh"
MAX_RUNNER_BYTES = 1_000_000
# The ONLY tail the builder understands: the attempt block, and nothing after it.
TAIL = re.compile(
    r'if recovery_run_attempt; then\n'
    r'  echo "RECOVERY_AUTOMATIC_RESULT_ONLY=YES"\n'
    r'  echo "RECOVERY_CLAIM_BOUNDARY: [^\n]*"\n'
    r'  exit 0\n'
    r'fi\n'
    r'exit 1\n\Z'
)


class BuildError(ValueError):
    pass


def read_frozen(path: Path) -> tuple[str, str]:
    st = path.lstat()
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
        raise BuildError("FROZEN_RUNNER_NOT_A_REGULAR_FILE")
    if st.st_size > MAX_RUNNER_BYTES:
        raise BuildError("FROZEN_RUNNER_TOO_LARGE")
    raw = path.read_bytes()
    return raw.decode("utf-8"), hashlib.sha256(raw).hexdigest()


def derive(repo: Path, frozen_text: str, frozen_sha: str) -> str:
    try:
        values = freeze.check_equivalence(freeze.read_template(repo, freeze.extract(frozen_text)["EXPECTED_MAIN"]), frozen_text)
    except freeze.FreezeError as exc:
        raise BuildError(f"FROZEN_RUNNER_NOT_THE_REVIEWED_TEMPLATE:{exc}") from None
    main = values["EXPECTED_MAIN"]
    marker = "\nif recovery_run_attempt; then\n"
    if frozen_text.count(marker) != 1:
        raise BuildError("ATTEMPT_BLOCK_NOT_UNIQUE")
    cut = frozen_text.index(marker) + 1
    prefix, tail = frozen_text[:cut], frozen_text[cut:]
    if not TAIL.match(tail):
        raise BuildError("ATTEMPT_BLOCK_NOT_THE_KNOWN_TAIL")
    if "recovery_run_attempt" in prefix:
        raise BuildError("ATTEMPT_CALL_REACHABLE_BEFORE_THE_TAIL")
    try:
        driver = freeze._git(Path(repo), "show", f"{main}:{DRIVER_REL}")
    except freeze.FreezeError:
        raise BuildError("REHEARSAL_DRIVER_NOT_IN_THE_PINNED_MAIN") from None
    if not driver.strip():
        raise BuildError("REHEARSAL_DRIVER_EMPTY")
    return (
        prefix
        + "\n# ======== REHEARSAL DRIVER (derived copy; the frozen runner is NOT modified and its attempt block is NOT present) ========\n"
        + f"RECOVERY_REHEARSAL_FROZEN_RUNNER_SHA256={frozen_sha}\n"
        + driver.rstrip("\n")
        + "\n\nrecovery_rehearse\nexit $?\n"
    )


def write_private(out_dir: Path, text: str) -> Path:
    st = out_dir.lstat()
    if stat.S_ISLNK(st.st_mode) or not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise BuildError("OUT_DIR_NOT_A_PRIVATE_OWN_DIRECTORY")
    target = out_dir / "rehearsal-runner.sh"
    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o500)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(text)
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", required=True)
    parser.add_argument("--frozen", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args(argv)
    try:
        for value in (args.repo, args.frozen, args.out_dir):
            if not value.startswith("/") or ".." in value.split("/"):
                raise BuildError("PATH_NOT_ABSOLUTE")
        text, frozen_sha = read_frozen(Path(args.frozen))
        derived = derive(Path(args.repo), text, frozen_sha)
        target = write_private(Path(args.out_dir), derived)
    except (BuildError, OSError, UnicodeDecodeError) as exc:
        print(f"RECOVERY_REHEARSAL_BUILD=FAIL reason={str(exc)[:160]}", file=sys.stderr)
        return 1
    print("RECOVERY_REHEARSAL_BUILD=OK")
    print(f"RECOVERY_REHEARSAL_FROZEN_RUNNER_SHA256={frozen_sha}")
    print(f"RECOVERY_REHEARSAL_DERIVED_PATH={target}")
    print(f"RECOVERY_REHEARSAL_DERIVED_SHA256={hashlib.sha256(derived.encode()).hexdigest()}")
    print("RECOVERY_REHEARSAL_FROZEN_RUNNER_MODIFIED=NO")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
