"""Nonprivileged, read-only publisher of the allowlisted Core status projection.

The Core keeps its own ``status.json`` in a private runtime directory. This tool reads that one file through the
same fail-closed gate the Purple Desktop uses, re-emits only an allowlisted, versioned document, and replaces the
output atomically in an owner-controlled directory that the operator chose explicitly.

It is deliberately small: no network listener, no subprocess, no sudo, no chmod/chown, no MQTT, no database, no
hardware. It never invents evidence: ``updated_at`` stays the Core's own timestamp, ``published_at`` is separate and is
never used for freshness, and any source that is missing, unreadable, malformed, oversized, stale, future-dated or
contradictory publishes nothing (the previous output simply ages into STALE/UNKNOWN for every consumer).

Nothing here installs or schedules itself. Running it against a real Production directory is an owner action.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import math
import os
import re
import secrets
import signal
import stat
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from aegis_soc import observer
from aegis_soc.status_projection import project_status_document

PROJECTION_SCHEMA = "aegis.idea3.status-projection"
PROJECTION_VERSION = 1
OUTPUT_NAME = "status.projection.json"
MAX_OUTPUT_BYTES = 16 * 1024
DEFAULT_INTERVAL_SECONDS = 5.0

# Private Core and system locations a projection must never be written into.
FORBIDDEN_DESTINATION_PREFIXES = (
    Path("/run/aegis-idea3"),
    Path("/var/lib/aegis-idea3"),
    Path("/etc"),
    Path("/opt"),
    Path("/usr"),
    Path("/boot"),
    Path("/proc"),
    Path("/sys"),
)
_ALLOWED_COMPONENTS = ("detector", "gui", "preflight")
_DESKTOP_FIELDS = (
    "state", "profile", "dry_run", "auto_contain", "broker", "device", "uplink", "armed", "dispatch", "time_trust",
)

PUBLISHED = "PUBLISHED"
SOURCE_REFUSED = "SOURCE_REFUSED"
DESTINATION_REFUSED = "DESTINATION_REFUSED"
WRITE_FAILED = "WRITE_FAILED"


class PublishResult:
    __slots__ = ("outcome", "reason")

    def __init__(self, outcome: str, reason: str):
        self.outcome = outcome
        self.reason = reason

    @property
    def published(self) -> bool:
        return self.outcome == PUBLISHED

    def __repr__(self) -> str:
        return f"PublishResult({self.outcome}: {self.reason})"


class DestinationRefused(ValueError):
    """The chosen destination is not an owner-controlled, plain directory."""


# --- graduated response section (optional) ---------------------------------------------------------------------------------
# The Core writes graduated-status.json next to status.json (display data only, event driven: it is rewritten when a decision
# is made, so its own age is NOT a freshness signal). It is read through the same fail-closed rules as the Desktop gate: a regular
# file (never a symlink), bounded, schema version 1. Only the fields below cross to the Web; reasons, corroboration flags and every
# unknown key are dropped. A missing or invalid file means the section is absent: nothing is ever invented.
GRADUATED_NAME = "graduated-status.json"
GRADUATED_MAX_BYTES = 64 * 1024
GRADUATED_MAX_DECISIONS = 5
GRADUATED_LEVELS = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
GRADUATED_ACTIONS = ("NONE", "SOFTWARE_BLOCK", "RECOMMEND_CUT", "AUTO_CUT")
GRADUATED_OUTCOMES = ("NONE", "BLOCKED", "BLOCK_FAILED", "DRY_RUN", "RECOMMENDED", "CUT_SENT", "CUT_QUEUED", "CUT_REFUSED", "CUT_DISARMED")
GRADUATED_KINDS = ("port_scan", "ssh_brute_force", "syn_flood", "ssh_login_after_failures", "generic")
GRADUATED_MAX_SCORE = 1000
GRADUATED_MAX_MITRE = 6
_MITRE_ID = re.compile(r"^T[0-9]{4}(\.[0-9]{3})?$")
_EPOCH_MIN, _EPOCH_MAX = 946684800.0, 4102444800.0  # 2000-01-01 .. 2100-01-01


def default_graduated_source(source: Path) -> Path:
    """The Core writes the projection beside status.json; the same directory is the only place looked at by default."""
    return Path(source).with_name(GRADUATED_NAME)


def _iso_utc(value) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not _EPOCH_MIN <= value <= _EPOCH_MAX:
        return None
    return datetime.fromtimestamp(value, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _ipv4(value) -> str | None:
    if not isinstance(value, str) or len(value) > 15:
        return None
    try:
        return str(ipaddress.IPv4Address(value))
    except ValueError:
        return None


def read_graduated(path) -> dict | None:
    """The raw Core document, or None. Regular file only (no symlink), bounded, JSON object with schema version 1; never raises."""
    if path is None:
        return None
    try:
        info = os.lstat(path)
        if not stat.S_ISREG(info.st_mode) or info.st_size > GRADUATED_MAX_BYTES:
            return None
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_CLOEXEC", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as handle:
            raw = handle.read(GRADUATED_MAX_BYTES + 1)
        if len(raw) > GRADUATED_MAX_BYTES:
            return None
        document = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None
    if not isinstance(document, dict) or document.get("v") != 1 or not isinstance(document.get("decisions"), list):
        return None
    return document


def project_graduated(document) -> dict | None:
    """The allowlisted Web section built from a raw Core document, or None when the top level is not valid.

    A decision that does not fit the vocabulary is dropped (never repaired); the newest GRADUATED_MAX_DECISIONS are kept."""
    if not isinstance(document, dict):
        return None
    highest = document.get("highest_level")
    updated = _iso_utc(document.get("updated_at"))
    recommended = document.get("cut_recommended_for")
    if highest not in GRADUATED_LEVELS or updated is None or not isinstance(document.get("auto_cut_latched"), bool):
        return None
    recommended_ip = None
    if recommended is not None:
        recommended_ip = _ipv4(recommended)
        if recommended_ip is None:
            return None
    decisions = []
    items = document.get("decisions")
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        at, address = _iso_utc(item.get("at")), _ipv4(item.get("attacker_ip"))
        outcome = item.get("outcome") or "NONE"
        score = item.get("score")
        mitre = item.get("mitre")
        if (at is None or address is None or item.get("kind") not in GRADUATED_KINDS or item.get("level") not in GRADUATED_LEVELS
                or item.get("action") not in GRADUATED_ACTIONS or outcome not in GRADUATED_OUTCOMES
                or isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= GRADUATED_MAX_SCORE
                or not isinstance(mitre, list)):
            continue
        ids = []
        for entry in mitre:
            if isinstance(entry, str) and _MITRE_ID.match(entry) and entry not in ids:
                ids.append(entry)
        decisions.append({
            "at": at, "attackerIp": address, "kind": item["kind"], "level": item["level"], "action": item["action"],
            "outcome": outcome, "score": score, "mitre": ids[:GRADUATED_MAX_MITRE],
        })
    return {
        "schemaVersion": 1,
        "updatedAt": updated,
        "highestLevel": highest,
        "cutRecommendedFor": recommended_ip,
        "autoCutLatched": document["auto_cut_latched"],
        "decisions": decisions[-GRADUATED_MAX_DECISIONS:],
    }


def load_graduated(path) -> dict | None:
    """Gate plus projection: the Web section for ``path`` or None (absent, invalid, unreadable)."""
    return project_graduated(read_graduated(path))


def build_projection(document: dict, *, published_at: float, graduated: dict | None = None) -> dict:
    """Build the versioned document from an already validated, fresh Core status document.

    Only allowlisted keys are copied. ``detail``, ``pid``, paths and every unknown key are dropped, never sanitized.
    """

    components = {
        name: document["components"][name]
        for name in _ALLOWED_COMPONENTS
        if name in document["components"]
    }
    projection = {field: document[field] for field in _DESKTOP_FIELDS}
    projection["updated_at"] = document["updated_at"]
    projection["components"] = components
    projection["projection_schema"] = PROJECTION_SCHEMA
    projection["projection_version"] = PROJECTION_VERSION
    projection["provenance"] = {
        "source": "CORE_RUNTIME_STATUS_FILE",
        "source_updated_at": document["updated_at"],
        "freshness_basis": "source_updated_at",
        "published_at": published_at,
        "physical_verification": "NOT_VERIFIED",
    }
    projection["web_projection"] = project_status_document(
        {**{field: document[field] for field in _DESKTOP_FIELDS}, "updated_at": document["updated_at"], "components": components}
    )
    if graduated is not None:
        projection["web_projection"]["graduated"] = json.loads(json.dumps(graduated))  # a copy; absent stays absent
    return projection


PUSH_SCHEMA = "aegis.idea3.status-push"
PUSH_VERSION = 1


def build_push_envelope(projection: dict, *, sent_at_ms: int) -> dict:
    """Pure builder for the Web-side ``statusIngest`` envelope (design only; nothing here sends it).

    Only the Core's own ``web_projection`` crosses; the Desktop-specific top-level fields never do.
    """

    if isinstance(sent_at_ms, bool) or not isinstance(sent_at_ms, int) or sent_at_ms <= 0:
        raise ValueError("sent_at_ms must be a positive integer")
    return {
        "schema": PUSH_SCHEMA,
        "version": PUSH_VERSION,
        "sentAtMs": sent_at_ms,
        "projection": projection["web_projection"],
    }


def validate_destination(directory: Path, *, source: Path, allow_group_readable: bool = False) -> Path:
    """Return the checked destination directory or raise :class:`DestinationRefused`.

    The directory must already exist, be an absolute plain directory (not a symlink), be owned by the current user,
    and be neither world- nor group-writable. Group read/traverse is only accepted when the operator says so
    explicitly. This tool never changes ownership or permissions.
    """

    directory = Path(directory)
    if not directory.is_absolute():
        raise DestinationRefused("destination must be an absolute path")
    if any(part == ".." for part in directory.parts):
        raise DestinationRefused("destination must not contain '..'")
    for forbidden in FORBIDDEN_DESTINATION_PREFIXES:
        if directory == forbidden or forbidden in directory.parents:
            raise DestinationRefused(f"destination is inside a protected location: {forbidden}")
    try:
        info = os.lstat(directory)
    except OSError as error:
        raise DestinationRefused(f"destination is not accessible: {error.strerror or error}") from error
    if stat.S_ISLNK(info.st_mode):
        raise DestinationRefused("destination must not be a symlink")
    if not stat.S_ISDIR(info.st_mode):
        raise DestinationRefused("destination is not a directory")
    if info.st_uid != os.geteuid():
        raise DestinationRefused("destination must be owned by the publishing user")
    if info.st_mode & 0o022:
        raise DestinationRefused("destination must not be group- or world-writable")
    if info.st_mode & 0o005:
        raise DestinationRefused("destination must not be world-accessible")
    if info.st_mode & 0o050 and not allow_group_readable:
        raise DestinationRefused("group-accessible destination requires explicit --allow-group-readable-dir")
    resolved = directory.resolve()
    for forbidden in FORBIDDEN_DESTINATION_PREFIXES:
        if resolved == forbidden or forbidden in resolved.parents:
            raise DestinationRefused(f"destination resolves into a protected location: {forbidden}")
    source_dir = Path(source).parent.resolve()
    if resolved == source_dir or source_dir in resolved.parents:
        raise DestinationRefused("destination must not be the Core status directory")
    return resolved


def _write_atomic(directory: Path, name: str, payload: bytes, mode: int) -> None:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    temporary = f".{name}.{secrets.token_hex(8)}.tmp"
    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        descriptor = os.open(temporary, flags, mode, dir_fd=directory_fd)
        try:
            try:
                os.fchmod(descriptor, mode)
                view = memoryview(payload)
                while view:
                    view = view[os.write(descriptor, view):]
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            os.replace(temporary, name, src_dir_fd=directory_fd, dst_dir_fd=directory_fd)
        except BaseException:
            try:
                os.unlink(temporary, dir_fd=directory_fd)
            except OSError:
                pass
            raise
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def publish_once(
    source: Path,
    destination_dir: Path,
    *,
    now: float | None = None,
    max_age_seconds: float = observer.DEFAULT_MAX_AGE_SECONDS,
    allow_group_readable: bool = False,
    graduated_source: Path | None = None,
) -> PublishResult:
    source = Path(source)
    if os.name != "posix" or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        return PublishResult(DESTINATION_REFUSED, "the publisher requires a POSIX host")
    if not source.is_absolute():
        return PublishResult(SOURCE_REFUSED, "source must be an absolute path")
    try:
        directory = validate_destination(destination_dir, source=source, allow_group_readable=allow_group_readable)
    except DestinationRefused as error:
        return PublishResult(DESTINATION_REFUSED, str(error))
    if directory / OUTPUT_NAME == source.resolve():
        return PublishResult(DESTINATION_REFUSED, "output would overwrite the source")

    current = time.time() if now is None else now
    document, unknown = observer.load_status_document(source, now=current, max_age_seconds=max_age_seconds)
    if document is None:
        return PublishResult(SOURCE_REFUSED, f"{unknown.freshness}: {unknown.reason}")

    graduated = load_graduated(graduated_source if graduated_source is not None else default_graduated_source(source))
    payload = (json.dumps(build_projection(document, published_at=current, graduated=graduated), sort_keys=True, indent=2) + "\n").encode("utf-8")
    if len(payload) > MAX_OUTPUT_BYTES:
        return PublishResult(SOURCE_REFUSED, "projection exceeds the output size bound")
    mode = 0o640 if allow_group_readable else 0o600
    try:
        _write_atomic(directory, OUTPUT_NAME, payload, mode)
    except OSError as error:
        return PublishResult(WRITE_FAILED, f"cannot write projection: {error.strerror or error}")
    return PublishResult(PUBLISHED, "projection published")


def run(source: Path, destination_dir: Path, *, interval: float, stop: threading.Event, **options) -> int:
    """Publish repeatedly until ``stop`` is set. A refused destination ends the loop; a bad source only skips a cycle."""

    while not stop.is_set():
        result = publish_once(source, destination_dir, **options)
        if result.outcome == DESTINATION_REFUSED:
            print(f"status projection publisher refused: {result.reason}", file=sys.stderr)
            return 2
        if not result.published:
            print(f"status projection not published: {result.reason}", file=sys.stderr, flush=True)
        stop.wait(interval)
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", required=True, type=Path, help="absolute path of the Core status.json (read only)")
    parser.add_argument("--dest-dir", required=True, type=Path, help="existing owner-controlled output directory")
    parser.add_argument("--allow-group-readable-dir", action="store_true",
                        help="accept a group-readable directory and write the file 0640 (owner decision required)")
    parser.add_argument("--graduated-source", type=Path, default=None,
                        help="absolute path of the Core graduated-status.json (default: beside --source); absent or invalid = no section")
    parser.add_argument("--max-age", type=float, default=observer.DEFAULT_MAX_AGE_SECONDS)
    parser.add_argument("--interval", type=float, default=DEFAULT_INTERVAL_SECONDS)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args(argv)
    if not (0 < args.interval <= 60) or not (0 < args.max_age <= 3600):
        print("interval must be in (0, 60] and max-age in (0, 3600]", file=sys.stderr)
        return 2
    if args.graduated_source is not None and not args.graduated_source.is_absolute():
        print("graduated-source must be an absolute path", file=sys.stderr)
        return 2
    options = {"max_age_seconds": args.max_age, "allow_group_readable": args.allow_group_readable_dir,
               "graduated_source": args.graduated_source}
    if args.once:
        result = publish_once(args.source, args.dest_dir, **options)
        print(result.reason, file=sys.stderr if not result.published else sys.stdout)
        return 0 if result.published else (2 if result.outcome == DESTINATION_REFUSED else 1)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    return run(args.source, args.dest_dir, interval=args.interval, stop=stop, **options)


if __name__ == "__main__":
    sys.exit(main())
