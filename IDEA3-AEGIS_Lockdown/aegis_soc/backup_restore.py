"""PR12 operator backup and restore for the durable IDEA3 data root.

The unit of work is one explicitly selected data root, the same root that
``paths.RuntimePaths`` resolves for the running Core and Security Center. Every
included component is a SQLite database captured through the online backup API,
so a live WAL database is snapshotted consistently and the archive never carries
a ``-wal``/``-shm`` pair that could be restored out of step with its main file.

Three rules shape the whole module:

1. Only the four logical databases are ever copied. Every other path in the
   root is either matched by a named exclusion class or refuses the backup.
   Unclassified means fail closed, never "include it and hope".
2. Secret-bearing material — configuration, credentials, keys, certificates — is
   excluded by class, recorded only as a class and a count, never read, never
   named in the manifest, and never printed.
3. Restore trusts nothing in the archive. Member names, manifest paths, digests,
   formats, and the destination itself are all validated before a single byte
   reaches the destination, and the live data root is refused by default.

The manifest digest chain (``manifest.sha256`` over ``manifest.json``, and one
SHA-256 per component inside the manifest) detects corruption and after-the-fact
tampering of an archive. It is deliberately not a signature: no key material may
travel with a backup, so an adversary who can rewrite the whole archive can also
rewrite the digests. Authenticity comes from where the archive is stored, not
from this format.

This module implements and locally verifies the PR12-D repository work. It does
not perform, authorize, or evidence any Production backup or restore.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tarfile
import tempfile
import urllib.parse
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from .paths import RuntimePaths

FORMAT = "aegis-idea3-backup"
FORMAT_VERSION = 1
MANIFEST_MEMBER = "manifest.json"
MANIFEST_DIGEST_MEMBER = "manifest.sha256"
COMPONENT_PREFIX = "components/"
ARCHIVE_SUFFIX = ".tar.gz"

MAX_MANIFEST_BYTES = 4 * 1024 * 1024
MAX_COMPONENT_BYTES = 8 * 1024**3
MAX_MEMBERS = 64
MAX_REPORTED_PATHS = 20
SQLITE_TIMEOUT_SEC = 30.0
CHUNK_BYTES = 1024 * 1024

#: The exact phrase an operator must supply to restore over the live data root.
LIVE_OVERWRITE_CONFIRMATION = "OVERWRITE LIVE DATA ROOT"

# ---------------------------------------------------------------------------
# Refusal codes. Every refusal is one of these; nothing fails with prose alone.
# ---------------------------------------------------------------------------

REFUSE_SOURCE_NOT_ABSOLUTE = "SOURCE_NOT_ABSOLUTE"
REFUSE_SOURCE_NOT_A_DIRECTORY = "SOURCE_NOT_A_DIRECTORY"
REFUSE_UNCLASSIFIED_PATH = "UNCLASSIFIED_PATH"
REFUSE_UNSAFE_SOURCE_ENTRY = "UNSAFE_SOURCE_ENTRY"
REFUSE_REQUIRED_COMPONENT_MISSING = "REQUIRED_COMPONENT_MISSING"
REFUSE_OUTPUT_EXISTS = "OUTPUT_EXISTS"
REFUSE_OUTPUT_NOT_ABSOLUTE = "OUTPUT_NOT_ABSOLUTE"
REFUSE_ARCHIVE_INSIDE_SOURCE = "ARCHIVE_INSIDE_SOURCE"
REFUSE_SOURCE_DATABASE_UNREADABLE = "SOURCE_DATABASE_UNREADABLE"

REFUSE_ARCHIVE_UNREADABLE = "ARCHIVE_UNREADABLE"
REFUSE_UNSUPPORTED_FORMAT = "UNSUPPORTED_FORMAT"
REFUSE_UNSUPPORTED_FORMAT_VERSION = "UNSUPPORTED_FORMAT_VERSION"
REFUSE_MALFORMED_MANIFEST = "MALFORMED_MANIFEST"
REFUSE_MANIFEST_DIGEST_MISMATCH = "MANIFEST_DIGEST_MISMATCH"
REFUSE_COMPONENT_DIGEST_MISMATCH = "COMPONENT_DIGEST_MISMATCH"
REFUSE_MEMBER_PATH_TRAVERSAL = "MEMBER_PATH_TRAVERSAL"
REFUSE_MANIFEST_PATH_TRAVERSAL = "MANIFEST_PATH_TRAVERSAL"
REFUSE_UNSAFE_MEMBER_TYPE = "UNSAFE_MEMBER_TYPE"
REFUSE_UNEXPECTED_MEMBER = "UNEXPECTED_MEMBER"
REFUSE_MISSING_COMPONENT_MEMBER = "MISSING_COMPONENT_MEMBER"
REFUSE_COMPONENT_TOO_LARGE = "COMPONENT_TOO_LARGE"
REFUSE_SECRET_MATERIAL_IN_BACKUP = "SECRET_MATERIAL_IN_BACKUP"
REFUSE_RESTORED_DATABASE_UNREADABLE = "RESTORED_DATABASE_UNREADABLE"
REFUSE_DESTINATION_NOT_ABSOLUTE = "DESTINATION_NOT_ABSOLUTE"
REFUSE_DESTINATION_NOT_A_DIRECTORY = "DESTINATION_NOT_A_DIRECTORY"
REFUSE_DESTINATION_EQUALS_SOURCE = "DESTINATION_EQUALS_SOURCE"
REFUSE_DESTINATION_NOT_EMPTY = "DESTINATION_NOT_EMPTY"
REFUSE_DESTINATION_IS_LIVE_ROOT = "DESTINATION_IS_LIVE_ROOT"

# ---------------------------------------------------------------------------
# Exclusion classes
# ---------------------------------------------------------------------------

CLASS_CONFIGURATION_SECRET = "configuration-secret"
CLASS_CREDENTIAL_MATERIAL = "credential-material"
CLASS_KEY_MATERIAL = "key-material"
CLASS_CERTIFICATE_MATERIAL = "certificate-material"
CLASS_EPHEMERAL_RUNTIME = "ephemeral-runtime"
CLASS_SQLITE_SIDECAR = "sqlite-sidecar"
CLASS_OPERATIONAL_LOG = "operational-log"

#: Classes that must never be read, named, or restored. Recorded by class only.
SECRET_CLASSES = frozenset(
    {
        CLASS_CONFIGURATION_SECRET,
        CLASS_CREDENTIAL_MATERIAL,
        CLASS_KEY_MATERIAL,
        CLASS_CERTIFICATE_MATERIAL,
    }
)

_SECRET_DIRECTORIES = frozenset({"credentials", "pki", "secrets", "private"})
_KEY_SUFFIXES = frozenset({".key", ".pem", ".p12", ".pfx", ".jks", ".gpg", ".asc"})
_CERTIFICATE_SUFFIXES = frozenset({".crt", ".cer", ".der", ".csr"})
_KEY_NAMES = frozenset({"k_c2d", "k_d2c", "id_rsa", "id_ed25519"})
_RUNTIME_SUFFIXES = frozenset({".sock", ".socket", ".pid", ".lock"})
_LOG_SUFFIXES = frozenset({".log", ".jsonl"})


class BackupError(RuntimeError):
    """The backup or restore cannot continue safely."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


class BackupRefused(BackupError):
    """The requested backup was refused before anything was written."""


class RestoreRefused(BackupError):
    """The requested restore was refused before the destination was touched."""


@dataclass(frozen=True)
class ComponentSpec:
    """One logical database, located through the canonical runtime path contract."""

    logical: str
    relative: PurePosixPath
    member: str
    required: bool


@dataclass(frozen=True)
class BackupResult:
    path: Path
    manifest: dict
    components: dict[str, dict] = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "result": "BACKUP_CREATED",
            "archive": str(self.path),
            "bytes": self.path.stat().st_size,
            "format": self.manifest["format"],
            "format_version": self.manifest["format_version"],
            "created_utc": self.manifest["created_utc"],
            "source_root": self.manifest["source_root"],
            "components": sorted(self.components),
            "absent_components": sorted(self.manifest["absent_components"]),
            "exclusions": self.manifest["exclusions"],
            "production": "NOT_RUN",
        }


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    manifest: dict
    components: dict[str, dict]

    def as_dict(self) -> dict:
        return {
            "result": "BACKUP_VERIFIED" if self.ok else "BACKUP_REJECTED",
            "created_utc": self.manifest["created_utc"],
            "source_root": self.manifest["source_root"],
            "source_version": self.manifest.get("source_version"),
            "components": self.components,
            "production": "NOT_RUN",
        }


@dataclass(frozen=True)
class RestoreResult:
    destination: Path
    manifest: dict
    components: dict[str, dict]

    def as_dict(self) -> dict:
        return {
            "result": "RESTORE_VERIFIED",
            "destination": str(self.destination),
            "created_utc": self.manifest["created_utc"],
            "source_root": self.manifest["source_root"],
            "source_version": self.manifest.get("source_version"),
            "components": self.components,
            "production": "NOT_RUN",
        }


# ---------------------------------------------------------------------------
# Digests and the Core audit chain
# ---------------------------------------------------------------------------


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def audit_row_hash(timestamp, level, event_type, details, previous_hash) -> str:
    """Mirror ``database._compute_hash`` so restored audit history can be re-verified.

    ``tests/test_backup_restore.py`` asserts the two stay identical; importing the
    Core audit module here would create a rotating log file as a side effect of
    merely inspecting a backup.
    """
    data = f"{timestamp}|{level}|{event_type}|{details}|{previous_hash}"
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Path contract and classification
# ---------------------------------------------------------------------------


def _relative(path: Path, root: Path) -> PurePosixPath | None:
    try:
        return PurePosixPath(path.relative_to(root).as_posix())
    except ValueError:
        return None


def component_specs(root: Path) -> tuple[ComponentSpec, ...]:
    """Derive the logical components from ``RuntimePaths``; never hard-code filenames."""
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(root)})
    ordered = (
        ("core_audit", paths.core_db, True),
        ("core_dispatch", paths.dispatch_db, False),
        ("core_protocol", paths.protocol_db, False),
        ("web_audit", paths.web_db, False),
    )
    specs = []
    for logical, absolute, required in ordered:
        relative = _relative(absolute, paths.root)
        if relative is None:
            raise BackupRefused(
                REFUSE_SOURCE_NOT_A_DIRECTORY,
                f"the {logical} path contract resolves outside the selected data root",
            )
        specs.append(ComponentSpec(logical, relative, COMPONENT_PREFIX + relative.name, required))
    return tuple(specs)


def _excluded_directories(root: Path) -> dict[str, str]:
    """Top-level directories that are excluded wholesale when they live inside the root."""
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(root)})
    mapping: dict[str, str] = {}
    for directory, label in (
        (paths.runtime_dir, CLASS_EPHEMERAL_RUNTIME),
        (paths.log_dir, CLASS_OPERATIONAL_LOG),
        (paths.config_file.parent, CLASS_CONFIGURATION_SECRET),
    ):
        relative = _relative(directory, paths.root)
        if relative is not None and relative.parts:
            mapping.setdefault(relative.parts[0], label)
    return mapping


def classify(relative: PurePosixPath, *, components: Mapping[PurePosixPath, str], directories: Mapping[str, str]):
    """Return ``("component"|"exclude"|"unclassified", label)`` for one path under the root."""
    if relative in components:
        return "component", components[relative]

    name = relative.name
    lowered = name.lower()
    suffix = PurePosixPath(lowered).suffix
    parts = {part.lower() for part in relative.parts[:-1]}

    if relative.parts and relative.parts[0] in directories:
        return "exclude", directories[relative.parts[0]]
    if lowered == ".env" or lowered.endswith(".env") or suffix == ".env":
        return "exclude", CLASS_CONFIGURATION_SECRET
    if parts & _SECRET_DIRECTORIES:
        return "exclude", CLASS_CREDENTIAL_MATERIAL if "credentials" in parts else CLASS_KEY_MATERIAL
    if lowered.endswith((".credential", ".secret")):
        return "exclude", CLASS_CREDENTIAL_MATERIAL
    if suffix in _KEY_SUFFIXES or lowered in _KEY_NAMES:
        return "exclude", CLASS_KEY_MATERIAL
    if suffix in _CERTIFICATE_SUFFIXES:
        return "exclude", CLASS_CERTIFICATE_MATERIAL
    if suffix in _RUNTIME_SUFFIXES:
        return "exclude", CLASS_EPHEMERAL_RUNTIME
    if any(lowered.endswith(sidecar) for sidecar in ("-wal", "-shm", "-journal")):
        base = PurePosixPath(relative.parent) / lowered.rsplit("-", 1)[0]
        if PurePosixPath(base) in components:
            return "exclude", CLASS_SQLITE_SIDECAR
    if suffix in _LOG_SUFFIXES:
        return "exclude", CLASS_OPERATIONAL_LOG
    return "unclassified", ""


def _scan(root: Path, specs: tuple[ComponentSpec, ...]) -> tuple[dict[str, Path], dict[str, int]]:
    components = {spec.relative: spec.logical for spec in specs}
    directories = _excluded_directories(root)
    present: dict[str, Path] = {}
    exclusions: dict[str, int] = {}
    unclassified: list[str] = []
    unsafe: list[str] = []

    for current, _directories, filenames in os.walk(root, followlinks=False):
        for filename in filenames:
            absolute = Path(current) / filename
            relative = _relative(absolute, root)
            if relative is None:
                unsafe.append(filename)
                continue
            kind, label = classify(relative, components=components, directories=directories)
            if kind == "unclassified":
                unclassified.append(str(relative))
            elif kind == "component":
                if absolute.is_symlink() or not absolute.is_file():
                    unsafe.append(str(relative))
                else:
                    present[label] = absolute
            else:
                exclusions[label] = exclusions.get(label, 0) + 1

    if unsafe:
        raise BackupRefused(
            REFUSE_UNSAFE_SOURCE_ENTRY,
            "only regular files may be backed up: " + ", ".join(sorted(unsafe)[:MAX_REPORTED_PATHS]),
        )
    if unclassified:
        raise BackupRefused(
            REFUSE_UNCLASSIFIED_PATH,
            "refusing to guess whether these paths are safe to copy: "
            + ", ".join(sorted(unclassified)[:MAX_REPORTED_PATHS]),
        )
    return present, exclusions


# ---------------------------------------------------------------------------
# SQLite snapshot and inspection
# ---------------------------------------------------------------------------


def _connect_readonly(path: Path) -> tuple[sqlite3.Connection, str]:
    """Prefer a read-only connection; a WAL database without a shared-memory file needs read-write."""
    uri = "file:" + urllib.parse.quote(str(path)) + "?mode=ro"
    for candidate, mode in ((uri, "ro"), (str(path), "rw")):
        try:
            conn = sqlite3.connect(candidate, uri=mode == "ro", timeout=SQLITE_TIMEOUT_SEC)
            conn.execute("PRAGMA schema_version").fetchone()
            return conn, mode
        except sqlite3.Error:
            try:
                conn.close()
            except (sqlite3.Error, UnboundLocalError, NameError):
                pass
    raise BackupRefused(REFUSE_SOURCE_DATABASE_UNREADABLE, f"{path.name} could not be opened as a SQLite database")


def snapshot_database(source: Path, target: Path) -> str:
    """Copy a possibly-live WAL database consistently through the SQLite online backup API."""
    connection, mode = _connect_readonly(source)
    try:
        destination = sqlite3.connect(target, timeout=SQLITE_TIMEOUT_SEC)
        try:
            connection.backup(destination)
            # A snapshot must be one self-contained file: no -wal/-shm may follow it.
            destination.execute("PRAGMA journal_mode = DELETE")
            destination.commit()
        finally:
            destination.close()
    except sqlite3.Error as error:
        raise BackupRefused(REFUSE_SOURCE_DATABASE_UNREADABLE, f"{source.name}: {type(error).__name__}") from error
    finally:
        connection.close()
    return mode


def inspect_database(path: Path) -> dict:
    """Collect non-secret structural evidence: integrity, schema version, tables, row counts."""
    connection, _ = _connect_readonly(path)
    try:
        integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
        tables = {}
        names = [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]
        for name in names:
            quoted = '"' + name.replace('"', '""') + '"'
            tables[name] = connection.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0]
        report = {
            "integrity_check": integrity,
            "user_version": connection.execute("PRAGMA user_version").fetchone()[0],
            "application_id": connection.execute("PRAGMA application_id").fetchone()[0],
            "page_size": connection.execute("PRAGMA page_size").fetchone()[0],
            "tables": tables,
        }
        if "audit_logs" in tables:
            report["audit_chain"] = _audit_chain(connection)
        return report
    except sqlite3.Error as error:
        raise BackupError(REFUSE_SOURCE_DATABASE_UNREADABLE, f"{path.name}: {type(error).__name__}") from error
    finally:
        connection.close()


def _audit_chain(connection: sqlite3.Connection) -> dict:
    previous = "GENESIS"
    rows = 0
    valid = True
    for _id, timestamp, level, event_type, details, stored in connection.execute(
        "SELECT id, timestamp, level, event_type, details, hash FROM audit_logs ORDER BY id ASC"
    ):
        if stored != audit_row_hash(timestamp, level, event_type, details, previous):
            valid = False
            break
        previous = stored
        rows += 1
    return {"rows": rows, "valid": valid, "head": previous}


# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------


def _resolved_directory(path: Path | str, *, code_relative: str, code_kind: str, error) -> Path:
    candidate = Path(path)
    if not candidate.is_absolute():
        raise error(code_relative, f"{candidate} must be an absolute path")
    candidate = candidate.resolve()
    if not candidate.is_dir():
        raise error(code_kind, f"{candidate} is not a directory")
    return candidate


def _archive_path(output: Path, created: datetime) -> Path:
    """``output`` is the archive itself when it carries an archive suffix, otherwise a directory."""
    if not output.is_absolute():
        raise BackupRefused(REFUSE_OUTPUT_NOT_ABSOLUTE, f"{output} must be an absolute path")
    resolved = output.resolve()
    if output.name.endswith((ARCHIVE_SUFFIX, ".tgz")):
        archive = resolved
    else:
        stamp = created.strftime("%Y%m%dT%H%M%SZ")
        archive = resolved / f"aegis-idea3-backup-{stamp}{ARCHIVE_SUFFIX}"
    if archive.parent.exists() and not archive.parent.is_dir():
        raise BackupRefused(REFUSE_OUTPUT_EXISTS, f"{archive.parent} is not a directory")
    return archive


def _is_inside(candidate: Path, container: Path) -> bool:
    return candidate == container or container in candidate.parents


def _add_file(tar: tarfile.TarFile, name: str, path: Path) -> None:
    info = tar.gettarinfo(str(path), arcname=name)
    info.mode = 0o600
    info.uid = info.gid = 0
    info.uname = info.gname = ""
    with path.open("rb") as stream:
        tar.addfile(info, stream)


def create_backup(
    source_root: Path | str,
    output: Path | str,
    *,
    source_version: str | None = None,
    now: datetime | None = None,
) -> BackupResult:
    """Capture every present logical component of one data root into a new archive."""
    root = _resolved_directory(
        source_root,
        code_relative=REFUSE_SOURCE_NOT_ABSOLUTE,
        code_kind=REFUSE_SOURCE_NOT_A_DIRECTORY,
        error=BackupRefused,
    )
    created = now or datetime.now(UTC)
    archive = _archive_path(Path(output), created)
    if _is_inside(archive.parent, root):
        raise BackupRefused(REFUSE_ARCHIVE_INSIDE_SOURCE, "a backup may not be written inside the data root it copies")
    if archive.exists():
        raise BackupRefused(REFUSE_OUTPUT_EXISTS, f"{archive} already exists")

    specs = component_specs(root)
    present, exclusions = _scan(root, specs)
    missing_required = [spec.logical for spec in specs if spec.required and spec.logical not in present]
    if missing_required:
        raise BackupRefused(
            REFUSE_REQUIRED_COMPONENT_MISSING,
            "the data root has no " + ", ".join(sorted(missing_required)),
        )

    components: list[dict] = []
    reports: dict[str, dict] = {}
    with tempfile.TemporaryDirectory(prefix="aegis-backup-") as staging_name:
        staging = Path(staging_name)
        for spec in specs:
            origin = present.get(spec.logical)
            if origin is None:
                continue
            captured = staging / spec.relative.name
            open_mode = snapshot_database(origin, captured)
            report = inspect_database(captured)
            reports[spec.logical] = report
            entry = {
                "logical": spec.logical,
                "member": spec.member,
                "source": str(spec.relative),
                "bytes": captured.stat().st_size,
                "sha256": sha256_file(captured),
                "source_open_mode": open_mode,
                "schema": {
                    "integrity_check": report["integrity_check"],
                    "user_version": report["user_version"],
                    "application_id": report["application_id"],
                    "page_size": report["page_size"],
                    "tables": report["tables"],
                },
            }
            if "audit_chain" in report:
                entry["audit_chain"] = report["audit_chain"]
            components.append(entry)

        manifest = {
            "format": FORMAT,
            "format_version": FORMAT_VERSION,
            "created_utc": created.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source_root": str(root),
            "source_version": source_version,
            "components": components,
            "absent_components": [spec.logical for spec in specs if spec.logical not in present],
            # Secret classes are counted, never named: a path is itself a disclosure.
            "exclusions": [
                {"class": label, "count": count, "secret_class": label in SECRET_CLASSES}
                for label, count in sorted(exclusions.items())
            ],
            "excluded_secret_classes": sorted(SECRET_CLASSES),
        }
        payload = json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")
        (staging / MANIFEST_MEMBER).write_bytes(payload)
        (staging / MANIFEST_DIGEST_MEMBER).write_text(sha256_bytes(payload) + "\n", encoding="ascii")

        archive.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(archive, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as raw, tarfile.open(fileobj=raw, mode="w:gz") as tar:
                _add_file(tar, MANIFEST_MEMBER, staging / MANIFEST_MEMBER)
                _add_file(tar, MANIFEST_DIGEST_MEMBER, staging / MANIFEST_DIGEST_MEMBER)
                for entry in components:
                    _add_file(tar, entry["member"], staging / PurePosixPath(entry["member"]).name)
        except BaseException:
            archive.unlink(missing_ok=True)
            raise

    return BackupResult(path=archive, manifest=manifest, components=reports)


# ---------------------------------------------------------------------------
# Archive reading — nothing here trusts the archive
# ---------------------------------------------------------------------------


def _safe_member_name(name: str) -> bool:
    if not name or name.startswith(("/", "./")) or ":" in name:
        return False
    pure = PurePosixPath(name)
    return pure.is_absolute() is False and ".." not in pure.parts and "" not in pure.parts[:-1]


def _safe_relative(value: str) -> PurePosixPath | None:
    if not isinstance(value, str) or not value or value.startswith("/") or ":" in value:
        return None
    pure = PurePosixPath(value)
    if pure.is_absolute() or ".." in pure.parts:
        return None
    return pure


def _read_member(tar: tarfile.TarFile, member: tarfile.TarInfo, limit: int) -> bytes:
    stream = tar.extractfile(member)
    if stream is None:
        raise RestoreRefused(REFUSE_UNSAFE_MEMBER_TYPE, f"{member.name} has no readable content")
    payload = stream.read(limit + 1)
    if len(payload) > limit:
        raise RestoreRefused(REFUSE_COMPONENT_TOO_LARGE, f"{member.name} exceeds {limit} bytes")
    return payload


def _load_manifest(tar: tarfile.TarFile) -> tuple[dict, dict[str, tarfile.TarInfo]]:
    members = tar.getmembers()
    if len(members) > MAX_MEMBERS:
        raise RestoreRefused(REFUSE_UNEXPECTED_MEMBER, f"the archive holds {len(members)} members")

    indexed: dict[str, tarfile.TarInfo] = {}
    for member in members:
        if not _safe_member_name(member.name):
            raise RestoreRefused(REFUSE_MEMBER_PATH_TRAVERSAL, f"unsafe archive member name: {member.name!r}")
        if not member.isfile():
            raise RestoreRefused(REFUSE_UNSAFE_MEMBER_TYPE, f"{member.name} is not a regular file")
        if member.name not in (MANIFEST_MEMBER, MANIFEST_DIGEST_MEMBER):
            if not member.name.startswith(COMPONENT_PREFIX) or "/" in member.name[len(COMPONENT_PREFIX) :]:
                raise RestoreRefused(REFUSE_UNEXPECTED_MEMBER, f"unexpected archive member: {member.name}")
            component_relative = PurePosixPath(member.name[len(COMPONENT_PREFIX) :])
            kind, label = classify(component_relative, components={}, directories={})
            if kind == "exclude" and label in SECRET_CLASSES:
                raise RestoreRefused(
                    REFUSE_SECRET_MATERIAL_IN_BACKUP,
                    f"the archive carries {label}; a backup must never contain secret material",
                )
        if member.name in indexed:
            raise RestoreRefused(REFUSE_UNEXPECTED_MEMBER, f"duplicate archive member: {member.name}")
        indexed[member.name] = member

    for required in (MANIFEST_MEMBER, MANIFEST_DIGEST_MEMBER):
        if required not in indexed:
            raise RestoreRefused(REFUSE_MALFORMED_MANIFEST, f"the archive has no {required}")

    payload = _read_member(tar, indexed[MANIFEST_MEMBER], MAX_MANIFEST_BYTES)
    recorded = _read_member(tar, indexed[MANIFEST_DIGEST_MEMBER], 256).decode("ascii", "replace").strip()
    if recorded != sha256_bytes(payload):
        raise RestoreRefused(REFUSE_MANIFEST_DIGEST_MISMATCH, "the manifest does not match its recorded digest")
    try:
        manifest = json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as error:
        raise RestoreRefused(REFUSE_MALFORMED_MANIFEST, f"the manifest is not valid JSON ({type(error).__name__})") from error
    if not isinstance(manifest, dict):
        raise RestoreRefused(REFUSE_MALFORMED_MANIFEST, "the manifest is not a JSON object")
    if manifest.get("format") != FORMAT:
        raise RestoreRefused(REFUSE_UNSUPPORTED_FORMAT, f"unsupported backup format: {manifest.get('format')!r}")
    if manifest.get("format_version") != FORMAT_VERSION:
        raise RestoreRefused(
            REFUSE_UNSUPPORTED_FORMAT_VERSION,
            f"unsupported backup format version: {manifest.get('format_version')!r}",
        )
    for key in ("created_utc", "source_root", "components", "absent_components"):
        if key not in manifest:
            raise RestoreRefused(REFUSE_MALFORMED_MANIFEST, f"the manifest has no {key}")
    if not isinstance(manifest["components"], list) or not manifest["components"]:
        raise RestoreRefused(REFUSE_MALFORMED_MANIFEST, "the manifest declares no component")
    return manifest, indexed


def _planned_components(manifest: dict, specs: tuple[ComponentSpec, ...]) -> list[tuple[ComponentSpec, dict]]:
    by_logical = {spec.logical: spec for spec in specs}
    planned: list[tuple[ComponentSpec, dict]] = []
    seen: set[str] = set()
    for entry in manifest["components"]:
        if not isinstance(entry, dict):
            raise RestoreRefused(REFUSE_MALFORMED_MANIFEST, "a component entry is not a JSON object")
        logical = entry.get("logical")
        spec = by_logical.get(logical)
        if spec is None:
            raise RestoreRefused(REFUSE_MALFORMED_MANIFEST, f"unknown logical component: {logical!r}")
        if logical in seen:
            raise RestoreRefused(REFUSE_MALFORMED_MANIFEST, f"duplicate logical component: {logical}")
        seen.add(logical)
        member = _safe_relative(entry.get("member", ""))
        source = _safe_relative(entry.get("source", ""))
        if member is None or source is None:
            raise RestoreRefused(
                REFUSE_MANIFEST_PATH_TRAVERSAL,
                f"the manifest entry for {logical} names an unsafe path",
            )
        if str(member) != spec.member or str(source) != str(spec.relative):
            raise RestoreRefused(
                REFUSE_MANIFEST_PATH_TRAVERSAL,
                f"the manifest entry for {logical} does not match the runtime path contract",
            )
        digest = entry.get("sha256")
        if not isinstance(digest, str) or len(digest) != 64:
            raise RestoreRefused(REFUSE_MALFORMED_MANIFEST, f"the manifest entry for {logical} has no usable digest")
        planned.append((spec, entry))
    return planned


def _extract_and_verify(
    tar: tarfile.TarFile,
    indexed: dict[str, tarfile.TarInfo],
    planned: list[tuple[ComponentSpec, dict]],
    staging: Path,
) -> dict[str, dict]:
    declared = {spec.member for spec, _ in planned} | {MANIFEST_MEMBER, MANIFEST_DIGEST_MEMBER}
    extra = sorted(set(indexed) - declared)
    if extra:
        raise RestoreRefused(REFUSE_UNEXPECTED_MEMBER, "the archive holds undeclared members: " + ", ".join(extra))

    reports: dict[str, dict] = {}
    for spec, entry in planned:
        member = indexed.get(spec.member)
        if member is None:
            raise RestoreRefused(REFUSE_MISSING_COMPONENT_MEMBER, f"the archive has no {spec.member}")
        if member.size > MAX_COMPONENT_BYTES:
            raise RestoreRefused(REFUSE_COMPONENT_TOO_LARGE, f"{spec.member} exceeds {MAX_COMPONENT_BYTES} bytes")
        # The staged name comes from the path contract, never from the archive.
        staged = staging / spec.relative.name
        stream = tar.extractfile(member)
        if stream is None:
            raise RestoreRefused(REFUSE_UNSAFE_MEMBER_TYPE, f"{spec.member} has no readable content")
        digest = hashlib.sha256()
        written = 0
        with staged.open("wb") as target:
            while True:
                chunk = stream.read(CHUNK_BYTES)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_COMPONENT_BYTES:
                    raise RestoreRefused(REFUSE_COMPONENT_TOO_LARGE, f"{spec.member} exceeds the component limit")
                digest.update(chunk)
                target.write(chunk)
        if digest.hexdigest() != entry["sha256"]:
            raise RestoreRefused(
                REFUSE_COMPONENT_DIGEST_MISMATCH,
                f"{spec.logical} does not match the digest recorded in the manifest",
            )
        try:
            report = inspect_database(staged)
        except BackupError as error:
            raise RestoreRefused(REFUSE_RESTORED_DATABASE_UNREADABLE, error.detail) from error
        if report["integrity_check"] != "ok":
            raise RestoreRefused(REFUSE_RESTORED_DATABASE_UNREADABLE, f"{spec.logical} failed PRAGMA integrity_check")
        reports[spec.logical] = {
            "bytes": written,
            "sha256": digest.hexdigest(),
            "integrity_check": report["integrity_check"],
            "rows": report["tables"],
            **({"audit_chain": report["audit_chain"]} if "audit_chain" in report else {}),
        }
    return reports


def _open_archive(archive: Path) -> tarfile.TarFile:
    if not archive.is_file():
        raise RestoreRefused(REFUSE_ARCHIVE_UNREADABLE, f"{archive} is not a readable file")
    try:
        return tarfile.open(archive, "r:gz")
    except (tarfile.TarError, OSError) as error:
        raise RestoreRefused(REFUSE_ARCHIVE_UNREADABLE, f"{archive.name}: {type(error).__name__}") from error


def verify_backup(archive: Path | str) -> VerifyResult:
    """Prove an archive restores cleanly without writing anything outside a temporary directory."""
    path = Path(archive)
    with _open_archive(path) as tar:
        manifest, indexed = _load_manifest(tar)
        specs = component_specs(Path(manifest["source_root"]))
        planned = _planned_components(manifest, specs)
        with tempfile.TemporaryDirectory(prefix="aegis-verify-") as staging_name:
            reports = _extract_and_verify(tar, indexed, planned, Path(staging_name))
    return VerifyResult(ok=True, manifest=manifest, components=reports)


# ---------------------------------------------------------------------------
# Restore
# ---------------------------------------------------------------------------


def live_data_root(env: Mapping[str, str] | None = None) -> Path | None:
    try:
        return RuntimePaths.from_environment(env=env).root
    except (ValueError, OSError):
        return None


def _check_destination(
    destination: Path,
    manifest: dict,
    *,
    allow_non_empty: bool,
    confirm_live_overwrite: str | None,
    env: Mapping[str, str] | None,
) -> Path:
    if not destination.is_absolute():
        raise RestoreRefused(REFUSE_DESTINATION_NOT_ABSOLUTE, f"{destination} must be an absolute path")
    if destination.exists() and not destination.is_dir():
        raise RestoreRefused(REFUSE_DESTINATION_NOT_A_DIRECTORY, f"{destination} is not a directory")
    resolved = destination.resolve()

    source = Path(manifest["source_root"])
    if source.is_absolute() and (_is_inside(resolved, source.resolve()) or _is_inside(source.resolve(), resolved)):
        raise RestoreRefused(
            REFUSE_DESTINATION_EQUALS_SOURCE,
            "a restore may not overwrite or nest inside the data root the backup came from",
        )

    live = live_data_root(env)
    touches_live = live is not None and (_is_inside(resolved, live) or _is_inside(live, resolved))
    if touches_live and confirm_live_overwrite != LIVE_OVERWRITE_CONFIRMATION:
        raise RestoreRefused(
            REFUSE_DESTINATION_IS_LIVE_ROOT,
            f"{resolved} is the live data root; restore to a test location or confirm explicitly",
        )

    if resolved.is_dir() and any(resolved.iterdir()) and not allow_non_empty:
        raise RestoreRefused(REFUSE_DESTINATION_NOT_EMPTY, f"{resolved} is not empty")
    return resolved


def restore_backup(
    archive: Path | str,
    destination: Path | str,
    *,
    allow_non_empty: bool = False,
    confirm_live_overwrite: str | None = None,
    env: Mapping[str, str] | None = None,
) -> RestoreResult:
    """Restore one archive into an explicit destination and verify the result in place."""
    path = Path(archive)
    with _open_archive(path) as tar:
        manifest, indexed = _load_manifest(tar)
        target = _check_destination(
            Path(destination),
            manifest,
            allow_non_empty=allow_non_empty,
            confirm_live_overwrite=confirm_live_overwrite,
            env=env,
        )
        # The destination's own path contract decides where each component lands.
        specs = component_specs(Path(manifest["source_root"]))
        planned = _planned_components(manifest, specs)
        placement = {spec.logical: spec for spec in component_specs(target)}

        with tempfile.TemporaryDirectory(prefix="aegis-restore-") as staging_name:
            staging = Path(staging_name)
            reports = _extract_and_verify(tar, indexed, planned, staging)
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            for spec, _entry in planned:
                final = target / placement[spec.logical].relative
                final.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                staged = staging / spec.relative.name
                os.chmod(staged, 0o600)
                shutil.move(str(staged), str(final))
                # A restored database must not inherit a stale sidecar pair.
                for sidecar in ("-wal", "-shm"):
                    Path(str(final) + sidecar).unlink(missing_ok=True)

        for spec, _entry in planned:
            final = target / placement[spec.logical].relative
            report = inspect_database(final)
            if report["integrity_check"] != "ok":
                raise RestoreRefused(
                    REFUSE_RESTORED_DATABASE_UNREADABLE,
                    f"{spec.logical} failed PRAGMA integrity_check after restore",
                )
            reports[spec.logical]["restored_path"] = str(final)
            reports[spec.logical]["rows"] = report["tables"]
            if "audit_chain" in report:
                reports[spec.logical]["audit_chain"] = report["audit_chain"]

    return RestoreResult(destination=target, manifest=manifest, components=reports)
