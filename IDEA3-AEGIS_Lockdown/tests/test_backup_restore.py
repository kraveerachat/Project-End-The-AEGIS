"""PR12 backup / restore: consistent SQLite snapshots, a signed-by-digest manifest, fail-closed restore.

Every fixture is a disposable temporary data root built with the real
``DispatchLedger`` and ``ProtocolStore`` classes, so the WAL behaviour under
test is the behaviour the Core actually produces. Nothing here touches a
broker, a device, a relay, or any live runtime path.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import sqlite3
import tarfile
import time
from pathlib import Path

import pytest

from aegis_soc import backup_restore as br
from aegis_soc import cli
from aegis_soc import database as db
from aegis_soc import protocol_v1 as p1
from aegis_soc.dispatch_ledger import DispatchLedger
from aegis_soc.paths import RuntimePaths
from aegis_soc.protocol_store import ProtocolStore

DEVICE = "test-device-01"
ISSUED_AT = p1.TIME_FLOOR + 3_600
AUDIT_ROWS = 4
WEB_ROWS = 3


def _write_audit_db(path: Path, rows: int = AUDIT_ROWS) -> None:
    """Build a hash-chained Core audit database whose rows live only in the WAL."""
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT, level TEXT DEFAULT 'INFO', event_type TEXT,
            details TEXT, incident_id INTEGER, hash TEXT
        );
        CREATE TABLE IF NOT EXISTS incidents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            opened_at TEXT, closed_at TEXT, state TEXT DEFAULT 'OPEN',
            attacker_ip TEXT, summary TEXT
        );
        """
    )
    conn.commit()
    # Force the schema into the main file so a naive copy still opens.
    conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    previous = "GENESIS"
    for index in range(rows):
        stamp = f"2026-09-16 04:0{index}:00"
        row_hash = db._compute_hash(stamp, "INFO", "BACKUP_FIXTURE", f"row-{index}", previous)
        conn.execute(
            "INSERT INTO audit_logs (timestamp, level, event_type, details, incident_id, hash) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (stamp, "INFO", "BACKUP_FIXTURE", f"row-{index}", None, row_hash),
        )
        previous = row_hash
    conn.commit()
    conn.close()


def _write_web_db(path: Path, rows: int = WEB_ROWS) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS schema_meta (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS audit_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at TEXT NOT NULL,
            category TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL,
            actor_ref TEXT NOT NULL, resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL, correlation_id TEXT, detail_json TEXT NOT NULL
        );
        """
    )
    conn.execute("INSERT OR REPLACE INTO schema_meta (singleton, version) VALUES (1, 7)")
    for index in range(rows):
        conn.execute(
            "INSERT INTO audit_log (occurred_at, category, action, outcome, actor_ref, "
            "resource_type, resource_id, correlation_id, detail_json) "
            "VALUES (?, 'AUDIT', 'VIEW', 'SUCCESS', 'operator', 'incident', ?, NULL, '{}')",
            (f"2026-09-16T04:0{index}:00.000Z", f"incident-{index}"),
        )
    conn.commit()
    conn.close()


def _write_dispatch_db(path: Path) -> None:
    ledger = DispatchLedger(path)
    try:
        ledger.begin_claim("action-001", "CUT_UPLINK", time.time() + 600)
        ledger.mark_claimed("action-001")
        ledger.mark_published("action-001", "nonce-001")
    finally:
        ledger.close()


def _write_protocol_db(path: Path) -> None:
    store = ProtocolStore(path)
    try:
        reserved = store.reserve_command(DEVICE, "CUT_UPLINK", ISSUED_AT, ISSUED_AT + 60)
        store.mark_published(reserved.msg_id)
    finally:
        store.close()


def make_root(
    tmp_path: Path,
    name: str = "data-root",
    *,
    audit: bool = True,
    dispatch: bool = True,
    protocol: bool = True,
    web: bool = True,
    secrets: bool = True,
) -> Path:
    """Create a disposable IDEA3 data root shaped like the real runtime contract."""
    root = tmp_path / name
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(root)})
    (root / "data").mkdir(parents=True, exist_ok=True)
    if audit:
        _write_audit_db(paths.core_db)
    if dispatch:
        _write_dispatch_db(paths.dispatch_db)
    if protocol:
        _write_protocol_db(paths.protocol_db)
    if web:
        _write_web_db(paths.web_db)
    if secrets:
        paths.config_file.parent.mkdir(parents=True, exist_ok=True)
        paths.config_file.write_text("SESSION_SECRET=never-back-this-up-0001\n", encoding="utf-8")
        credentials = root / "credentials"
        credentials.mkdir(parents=True, exist_ok=True)
        (credentials / "restore.credential").write_text("scrypt$never-back-this-up-0002\n", encoding="utf-8")
        pki = root / "pki"
        pki.mkdir(parents=True, exist_ok=True)
        (pki / "idea3-core-client.key").write_text("never-back-this-up-0003\n", encoding="utf-8")
        paths.log_dir.mkdir(parents=True, exist_ok=True)
        (paths.log_dir / "aegis_soc.log").write_text("operational log line\n", encoding="utf-8")
        paths.runtime_dir.mkdir(parents=True, exist_ok=True)
        (paths.runtime_dir / "supervisor.pid").write_text("1234\n", encoding="utf-8")
    return root


def _rows(path: Path, table: str) -> int:
    conn = sqlite3.connect(path)
    try:
        return conn.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
    except sqlite3.DatabaseError:
        return -1
    finally:
        conn.close()


def _tree(root: Path) -> dict[str, tuple]:
    """Every entry under a root as (kind, ...) so a before/after comparison is exact."""
    snapshot: dict[str, tuple] = {}
    for path in sorted(root.rglob("*")):
        relative = str(path.relative_to(root))
        if path.is_symlink():
            snapshot[relative] = ("symlink", os.readlink(path))
        elif path.is_dir():
            snapshot[relative] = ("dir",)
        else:
            payload = path.read_bytes()
            snapshot[relative] = ("file", len(payload), hashlib.sha256(payload).hexdigest())
    return snapshot


def _members(archive: Path) -> dict[str, bytes]:
    with tarfile.open(archive, "r:gz") as tar:
        return {
            member.name: (tar.extractfile(member).read() if member.isfile() else b"")
            for member in tar.getmembers()
        }


def _repack(archive: Path, members: dict[str, bytes], *, links: dict[str, str] | None = None) -> Path:
    target = archive.parent / f"repacked-{archive.name}"
    with tarfile.open(target, "w:gz") as tar:
        for name, payload in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(payload)
            info.mode = 0o600
            info.mtime = 0
            tar.addfile(info, io.BytesIO(payload))
        for name, destination in (links or {}).items():
            info = tarfile.TarInfo(name)
            info.type = tarfile.SYMTYPE
            info.linkname = destination
            info.mode = 0o600
            info.mtime = 0
            tar.addfile(info)
    return target


def _manifest(members: dict[str, bytes]) -> dict:
    return json.loads(members[br.MANIFEST_MEMBER].decode("utf-8"))


def _reseal(members: dict[str, bytes], manifest: dict) -> dict[str, bytes]:
    """Rewrite the manifest and its self-digest so only the intended defect remains."""
    payload = json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")
    members[br.MANIFEST_MEMBER] = payload
    members[br.MANIFEST_DIGEST_MEMBER] = (br.sha256_bytes(payload) + "\n").encode("ascii")
    return members


@pytest.fixture
def backup(tmp_path):
    source = make_root(tmp_path)
    archive = br.create_backup(source, tmp_path / "out", source_version="test-sha")
    return source, archive


# --------------------------------------------------------------------------
# A. BACKUP CREATE and manifest
# --------------------------------------------------------------------------


def test_backup_create_records_every_present_component(backup):
    source, archive = backup
    assert archive.path.exists()
    assert archive.path.stat().st_mode & 0o077 == 0
    manifest = _manifest(_members(archive.path))
    assert manifest["format"] == br.FORMAT
    assert manifest["format_version"] == br.FORMAT_VERSION
    assert manifest["source_root"] == str(source)
    assert manifest["source_version"] == "test-sha"
    assert manifest["created_utc"].endswith("Z")
    logical = {component["logical"] for component in manifest["components"]}
    assert logical == {"core_audit", "core_dispatch", "core_protocol", "web_audit"}
    for component in manifest["components"]:
        assert component["sha256"] and component["bytes"] > 0
        assert component["member"].startswith(br.COMPONENT_PREFIX)
        assert component["schema"]["integrity_check"] == "ok"
        assert component["schema"]["tables"]


def test_backup_manifest_carries_row_counts_and_audit_chain(backup):
    _, archive = backup
    manifest = _manifest(_members(archive.path))
    components = {component["logical"]: component for component in manifest["components"]}
    assert components["core_audit"]["schema"]["tables"]["audit_logs"] == AUDIT_ROWS
    assert components["core_audit"]["audit_chain"] == {
        "rows": AUDIT_ROWS,
        "valid": True,
        "head": components["core_audit"]["audit_chain"]["head"],
    }
    assert components["web_audit"]["schema"]["tables"]["audit_log"] == WEB_ROWS
    assert components["core_dispatch"]["schema"]["tables"]["core_dispatch_actions"] == 1
    assert components["core_protocol"]["schema"]["tables"]["protocol_commands"] == 1


def test_audit_chain_hash_matches_the_core_audit_writer():
    # The backup verifier must never drift from the Core audit hash definition.
    assert br.audit_row_hash("t", "INFO", "E", "d", "GENESIS") == db._compute_hash("t", "INFO", "E", "d", "GENESIS")


# --------------------------------------------------------------------------
# B. SQLITE / WAL CONSISTENCY
# --------------------------------------------------------------------------


def test_wal_snapshot_captures_rows_a_file_copy_would_lose(tmp_path):
    source = make_root(tmp_path, secrets=False, dispatch=False, protocol=False, web=False)
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(source)})
    live = sqlite3.connect(paths.core_db)
    live.execute("PRAGMA journal_mode = WAL")
    live.execute(
        "INSERT INTO audit_logs (timestamp, level, event_type, details, hash) VALUES "
        "('2026-09-16 05:00:00', 'INFO', 'UNCHECKPOINTED', 'in-wal-only', 'x')"
    )
    live.commit()
    try:
        naive = tmp_path / "naive-copy.sqlite3"
        shutil.copy2(paths.core_db, naive)
        assert _rows(naive, "audit_logs") < AUDIT_ROWS + 1  # the copy misses the WAL

        archive = br.create_backup(source, tmp_path / "out")
    finally:
        live.close()

    restored = br.restore_backup(archive.path, tmp_path / "restored")
    core = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(tmp_path / "restored")}).core_db
    assert _rows(core, "audit_logs") == AUDIT_ROWS + 1
    assert restored.components["core_audit"]["rows"]["audit_logs"] == AUDIT_ROWS + 1
    # A snapshot never carries WAL sidecars into the archive.
    assert not [name for name in _members(archive.path) if name.endswith(("-wal", "-shm"))]


def test_backup_leaves_the_source_tree_byte_identical(tmp_path):
    """No writer attached: the backup must not create, remove, or alter a single entry."""
    source = make_root(tmp_path)
    before = _tree(source)
    assert before  # the fixture really did build a tree

    archive = br.create_backup(source, tmp_path / "first.tar.gz")

    assert _tree(source) == before
    # Nothing was invented beside a database, in particular no WAL sidecar.
    assert not list((source / "data").glob("*-wal"))
    assert not list((source / "data").glob("*-shm"))
    manifest = _manifest(_members(archive.path))
    modes = {component["source_open_mode"] for component in manifest["components"]}
    assert modes == {br.OPEN_MODE_IMMUTABLE}
    assert "rw" not in modes

    # A repeat backup is equally inert.
    br.create_backup(source, tmp_path / "second.tar.gz")
    assert _tree(source) == before


def test_backup_of_a_live_wal_database_reads_committed_rows_without_writing(tmp_path):
    """A writer is attached: read all committed WAL rows and touch nothing durable."""
    source = make_root(tmp_path, dispatch=False, protocol=False, web=False)
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(source)})
    live = sqlite3.connect(paths.core_db)
    live.execute("PRAGMA journal_mode = WAL")
    live.execute(
        "INSERT INTO audit_logs (timestamp, level, event_type, details, hash) VALUES "
        "('2026-09-16 05:00:00', 'INFO', 'UNCHECKPOINTED', 'in-wal-only', 'x')"
    )
    live.commit()
    try:
        assert (source / "data" / "core-audit.sqlite3-shm").exists()
        before = _tree(source)
        archive = br.create_backup(source, tmp_path / "live.tar.gz")
        after = _tree(source)
    finally:
        live.close()

    assert set(after) == set(before)
    for relative, entry in before.items():
        if relative.endswith("-shm"):
            # The wal-index is shared memory SQLite maintains for every reader,
            # including a read-only one. It holds no database content, is never
            # backed up, and SQLite rebuilds it. Its kind and size must not move.
            assert after[relative][0] == entry[0] and after[relative][1] == entry[1]
        else:
            assert after[relative] == entry, relative

    manifest = _manifest(_members(archive.path))
    assert manifest["components"][0]["source_open_mode"] == br.OPEN_MODE_WAL_INDEX
    restored = br.restore_backup(archive.path, tmp_path / "live-restore")
    assert restored.components["core_audit"]["rows"]["audit_logs"] == AUDIT_ROWS + 1


def test_backup_refuses_an_orphaned_wal_rather_than_opening_read_write(tmp_path):
    """An orphaned WAL needs a writable wal-index; the backup refuses instead."""
    source = make_root(tmp_path)
    orphan = Path(str(RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(source)}).core_db) + "-wal")
    orphan.write_bytes(b"\x00" * 32)
    before = _tree(source)
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, tmp_path / "orphan.tar.gz")
    assert error.value.code == br.REFUSE_SOURCE_REQUIRES_WRITE_ACCESS
    assert _tree(source) == before  # notably: no -shm was created


def test_backup_refuses_a_hot_rollback_journal(tmp_path):
    source = make_root(tmp_path, dispatch=False, protocol=False, web=False)
    core = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(source)}).core_db
    Path(str(core) + "-journal").write_bytes(b"\xd9\xd5\x05\xf9\x20\xa1\x63\xd7" + b"\x00" * 24)
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, tmp_path / "hot.tar.gz")
    assert error.value.code == br.REFUSE_SOURCE_REQUIRES_WRITE_ACCESS


# --------------------------------------------------------------------------
# D. SECRET FAIL-CLOSED RULE
# --------------------------------------------------------------------------


def test_secret_material_is_excluded_and_never_written_into_the_archive(backup):
    _, archive = backup
    payload = archive.path.read_bytes()
    raw = b"".join(_members(archive.path).values())
    for marker in (b"never-back-this-up-0001", b"never-back-this-up-0002", b"never-back-this-up-0003"):
        assert marker not in payload
        assert marker not in raw
    manifest = _manifest(_members(archive.path))
    classes = {entry["class"]: entry["count"] for entry in manifest["exclusions"]}
    assert classes["configuration-secret"] == 1
    assert classes["credential-material"] == 1
    assert classes["key-material"] == 1
    assert "config/.env" not in json.dumps(manifest)


def test_unclassified_source_path_fails_closed(tmp_path):
    source = make_root(tmp_path)
    (source / "data" / "operator-notes.sqlite3").write_bytes(b"unknown durable state")
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, tmp_path / "out")
    assert error.value.code == br.REFUSE_UNCLASSIFIED_PATH
    assert "data/operator-notes.sqlite3" in str(error.value)


def test_symlinked_component_is_refused(tmp_path):
    source = make_root(tmp_path, protocol=False)
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(source)})
    paths.protocol_db.symlink_to(paths.core_db)
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, tmp_path / "out")
    assert error.value.code == br.REFUSE_UNSAFE_SOURCE_ENTRY


def test_symlinked_directory_in_the_source_is_refused(tmp_path):
    """os.walk does not descend a symlinked directory, so it must be refused, not ignored."""
    source = make_root(tmp_path)
    outside = tmp_path / "somewhere-else"
    (outside / "data").mkdir(parents=True)
    (outside / "data" / "planted.sqlite3").write_bytes(b"not ours")
    (source / "smuggled").symlink_to(outside, target_is_directory=True)
    before = _tree(source)
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, tmp_path / "out")
    assert error.value.code == br.REFUSE_UNSAFE_SOURCE_ENTRY
    assert "smuggled" in str(error.value)
    assert _tree(source) == before


def test_symlinked_directory_shadowing_a_known_name_is_refused(tmp_path):
    source = make_root(tmp_path, secrets=False, dispatch=False, protocol=False, web=False)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (source / "logs").symlink_to(elsewhere, target_is_directory=True)
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, tmp_path / "out")
    assert error.value.code == br.REFUSE_UNSAFE_SOURCE_ENTRY


def test_symlinked_excluded_file_is_refused(tmp_path):
    source = make_root(tmp_path, secrets=False, dispatch=False, protocol=False, web=False)
    (source / "data" / "core-audit.sqlite3.log").symlink_to("/etc/passwd")
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, tmp_path / "out")
    assert error.value.code == br.REFUSE_UNSAFE_SOURCE_ENTRY


def test_unclassified_directory_fails_closed(tmp_path):
    source = make_root(tmp_path)
    (source / "data" / "archive-2026").mkdir()
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, tmp_path / "out")
    assert error.value.code == br.REFUSE_UNCLASSIFIED_PATH
    assert "data/archive-2026" in str(error.value)


def test_known_directories_are_preserved(tmp_path):
    """config/, logs/, runtime/, credentials/, pki/, and data/ must not trip the scan."""
    source = make_root(tmp_path)
    (source / "pki" / "nested").mkdir(parents=True)
    (source / "pki" / "nested" / "chain.crt").write_text("public cert\n", encoding="utf-8")
    archive = br.create_backup(source, tmp_path / "known.tar.gz")
    classes = {entry["class"] for entry in _manifest(_members(archive.path))["exclusions"]}
    assert {"configuration-secret", "credential-material", "key-material"} <= classes


def test_missing_required_component_is_refused(tmp_path):
    source = make_root(tmp_path, audit=False)
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, tmp_path / "out")
    assert error.value.code == br.REFUSE_REQUIRED_COMPONENT_MISSING


def test_optional_components_may_be_absent(tmp_path):
    source = make_root(tmp_path, dispatch=False, protocol=False, web=False)
    archive = br.create_backup(source, tmp_path / "out")
    manifest = _manifest(_members(archive.path))
    assert [component["logical"] for component in manifest["components"]] == ["core_audit"]
    assert sorted(manifest["absent_components"]) == ["core_dispatch", "core_protocol", "web_audit"]


def test_archive_inside_the_source_root_is_refused(tmp_path):
    source = make_root(tmp_path)
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, source / "backups")
    assert error.value.code == br.REFUSE_ARCHIVE_INSIDE_SOURCE


def test_existing_archive_is_never_overwritten(tmp_path):
    source = make_root(tmp_path)
    target = tmp_path / "already.tar.gz"
    target.write_bytes(b"existing")
    with pytest.raises(br.BackupRefused) as error:
        br.create_backup(source, target)
    assert error.value.code == br.REFUSE_OUTPUT_EXISTS
    assert target.read_bytes() == b"existing"


# --------------------------------------------------------------------------
# E/F. RESTORE and test-restore verification
# --------------------------------------------------------------------------


def test_verify_backup_reports_every_component_without_writing(tmp_path, backup):
    _, archive = backup
    report = br.verify_backup(archive.path)
    assert report.ok
    assert set(report.components) == {"core_audit", "core_dispatch", "core_protocol", "web_audit"}
    assert report.components["core_audit"]["audit_chain"]["valid"] is True
    assert report.components["core_audit"]["rows"]["audit_logs"] == AUDIT_ROWS


def test_restore_to_a_test_location_rebuilds_every_component(tmp_path, backup):
    source, archive = backup
    destination = tmp_path / "test-restore"
    result = br.restore_backup(archive.path, destination)
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(destination)})
    assert result.destination == destination
    assert _rows(paths.core_db, "audit_logs") == AUDIT_ROWS
    assert _rows(paths.web_db, "audit_log") == WEB_ROWS
    assert _rows(paths.dispatch_db, "core_dispatch_actions") == 1
    assert _rows(paths.protocol_db, "protocol_commands") == 1
    assert result.components["core_audit"]["audit_chain"] == {
        "rows": AUDIT_ROWS,
        "valid": True,
        "head": result.components["core_audit"]["audit_chain"]["head"],
    }
    # The restored copy is data only: no secret, log, or runtime material travelled.
    assert sorted(path.name for path in destination.iterdir()) == ["data"]
    assert source.exists()


def test_restored_dispatch_and_protocol_state_survive(tmp_path, backup):
    _, archive = backup
    destination = tmp_path / "state-check"
    br.restore_backup(archive.path, destination)
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(destination)})
    ledger = DispatchLedger(paths.dispatch_db)
    try:
        assert ledger.get("action-001")["state"] == "PUBLISHED"
    finally:
        ledger.close()
    store = ProtocolStore(paths.protocol_db)
    try:
        assert store.last_allocated_seq(DEVICE) == 1
    finally:
        store.close()
    assert _rows(paths.protocol_db, "protocol_sequence") == 1


# --------------------------------------------------------------------------
# Negative controls
# --------------------------------------------------------------------------


def test_tampered_component_is_rejected(tmp_path, backup):
    _, archive = backup
    members = _members(archive.path)
    manifest = _manifest(members)
    member = next(c["member"] for c in manifest["components"] if c["logical"] == "core_audit")
    members[member] = members[member][:-1] + bytes([members[member][-1] ^ 0xFF])
    tampered = _repack(archive.path, members)
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(tampered, tmp_path / "never")
    assert error.value.code == br.REFUSE_COMPONENT_DIGEST_MISMATCH
    assert not (tmp_path / "never").exists()


def test_altered_manifest_digest_field_is_rejected(tmp_path, backup):
    _, archive = backup
    members = _members(archive.path)
    manifest = _manifest(members)
    manifest["components"][0]["sha256"] = "0" * 64
    members[br.MANIFEST_MEMBER] = json.dumps(manifest, indent=2, sort_keys=True).encode("utf-8")
    altered = _repack(archive.path, members)
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(altered, tmp_path / "never")
    assert error.value.code == br.REFUSE_MANIFEST_DIGEST_MISMATCH


def test_malformed_json_manifest_is_rejected(tmp_path, backup):
    _, archive = backup
    members = _members(archive.path)
    payload = b"{ this is not json"
    members[br.MANIFEST_MEMBER] = payload
    members[br.MANIFEST_DIGEST_MEMBER] = (br.sha256_bytes(payload) + "\n").encode("ascii")
    broken = _repack(archive.path, members)
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(broken, tmp_path / "never")
    assert error.value.code == br.REFUSE_MALFORMED_MANIFEST


def test_unsupported_format_and_version_are_rejected(tmp_path, backup):
    _, archive = backup
    members = _members(archive.path)
    manifest = _manifest(members)
    manifest["format_version"] = br.FORMAT_VERSION + 1
    future = _repack(archive.path, _reseal(dict(members), manifest))
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(future, tmp_path / "never")
    assert error.value.code == br.REFUSE_UNSUPPORTED_FORMAT_VERSION

    manifest = _manifest(_members(archive.path))
    manifest["format"] = "some-other-tool"
    foreign = _repack(archive.path, _reseal(_members(archive.path), manifest))
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(foreign, tmp_path / "never")
    assert error.value.code == br.REFUSE_UNSUPPORTED_FORMAT


def test_member_path_traversal_is_rejected(tmp_path, backup):
    _, archive = backup
    members = _members(archive.path)
    members["components/../../escaped.sqlite3"] = b"escape"
    hostile = _repack(archive.path, members)
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(hostile, tmp_path / "never")
    assert error.value.code == br.REFUSE_MEMBER_PATH_TRAVERSAL
    assert not (tmp_path / "escaped.sqlite3").exists()


def test_absolute_member_and_symlink_member_are_rejected(tmp_path, backup):
    _, archive = backup
    absolute = _repack(archive.path, {**_members(archive.path), "/etc/aegis-idea3/core.env": b"x"})
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(absolute, tmp_path / "never")
    assert error.value.code == br.REFUSE_MEMBER_PATH_TRAVERSAL

    linked = _repack(archive.path, _members(archive.path), links={"components/link.sqlite3": "/etc/passwd"})
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(linked, tmp_path / "never")
    assert error.value.code == br.REFUSE_UNSAFE_MEMBER_TYPE


def test_manifest_path_traversal_is_rejected(tmp_path, backup):
    _, archive = backup
    members = _members(archive.path)
    manifest = _manifest(members)
    manifest["components"][0]["source"] = "../../etc/aegis-idea3/core.env"
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(_repack(archive.path, _reseal(members, manifest)), tmp_path / "never")
    assert error.value.code == br.REFUSE_MANIFEST_PATH_TRAVERSAL

    members = _members(archive.path)
    manifest = _manifest(members)
    manifest["components"][0]["member"] = "components/../../escaped"
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(_repack(archive.path, _reseal(members, manifest)), tmp_path / "never")
    assert error.value.code == br.REFUSE_MANIFEST_PATH_TRAVERSAL


def test_unexpected_member_is_rejected(tmp_path, backup):
    _, archive = backup
    members = {**_members(archive.path), "components/unexpected.sqlite3": b"surprise"}
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(_repack(archive.path, members), tmp_path / "never")
    assert error.value.code == br.REFUSE_UNEXPECTED_MEMBER


def test_secret_material_inside_a_backup_is_rejected(tmp_path, backup):
    _, archive = backup
    members = {**_members(archive.path), "components/core.env": b"SESSION_SECRET=x"}
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(_repack(archive.path, members), tmp_path / "never")
    assert error.value.code == br.REFUSE_SECRET_MATERIAL_IN_BACKUP


def test_missing_declared_component_member_is_rejected(tmp_path, backup):
    _, archive = backup
    members = _members(archive.path)
    manifest = _manifest(members)
    member = next(c["member"] for c in manifest["components"] if c["logical"] == "core_audit")
    members.pop(member)
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(_repack(archive.path, members), tmp_path / "never")
    assert error.value.code == br.REFUSE_MISSING_COMPONENT_MEMBER


def test_a_resealed_manifest_without_the_required_component_is_rejected(tmp_path, backup):
    """Dropping core_audit from the manifest and resealing must not produce a valid backup."""
    _, archive = backup
    members = _members(archive.path)
    manifest = _manifest(members)
    entry = next(c for c in manifest["components"] if c["logical"] == "core_audit")
    manifest["components"] = [c for c in manifest["components"] if c["logical"] != "core_audit"]
    manifest["absent_components"] = sorted([*manifest["absent_components"], "core_audit"])
    members.pop(entry["member"])
    stripped = _repack(archive.path, _reseal(members, manifest))

    with pytest.raises(br.RestoreRefused) as error:
        br.verify_backup(stripped)
    assert error.value.code == br.REFUSE_REQUIRED_COMPONENT_MISSING

    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(stripped, tmp_path / "never")
    assert error.value.code == br.REFUSE_REQUIRED_COMPONENT_MISSING
    assert not (tmp_path / "never").exists()


def test_a_backup_of_optional_components_only_still_verifies(tmp_path):
    """Optional components may legitimately be absent; core_audit may not."""
    source = make_root(tmp_path, dispatch=False, protocol=False, web=False)
    archive = br.create_backup(source, tmp_path / "audit-only.tar.gz")
    assert br.verify_backup(archive.path).ok
    restored = br.restore_backup(archive.path, tmp_path / "audit-only-restore")
    assert set(restored.components) == {"core_audit"}


def test_a_manifest_with_an_unusable_source_root_is_rejected(tmp_path, backup):
    _, archive = backup
    members = _members(archive.path)
    manifest = _manifest(members)
    manifest["source_root"] = "relative/not/absolute"
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(_repack(archive.path, _reseal(members, manifest)), tmp_path / "never")
    assert error.value.code == br.REFUSE_MALFORMED_MANIFEST


def test_restore_destination_equal_to_the_source_is_rejected(tmp_path, backup):
    source, archive = backup
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(archive.path, source)
    assert error.value.code == br.REFUSE_DESTINATION_EQUALS_SOURCE
    # The source data root is untouched.
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(source)})
    assert _rows(paths.core_db, "audit_logs") == AUDIT_ROWS
    assert paths.config_file.exists()


def test_restore_into_a_non_empty_target_needs_an_explicit_override(tmp_path, backup):
    _, archive = backup
    destination = tmp_path / "occupied"
    (destination / "data").mkdir(parents=True)
    (destination / "data" / "keep-me.txt").write_text("existing operator data\n", encoding="utf-8")
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(archive.path, destination)
    assert error.value.code == br.REFUSE_DESTINATION_NOT_EMPTY
    assert (destination / "data" / "keep-me.txt").exists()

    result = br.restore_backup(archive.path, destination, allow_non_empty=True)
    assert result.components["core_audit"]["rows"]["audit_logs"] == AUDIT_ROWS
    # The override replaces declared components only; it never prunes the target.
    assert (destination / "data" / "keep-me.txt").exists()


def test_restore_over_the_live_data_root_is_rejected_by_default(tmp_path, backup, monkeypatch):
    _, archive = backup
    live = tmp_path / "live-root"
    live.mkdir()
    monkeypatch.setenv("AEGIS_DATA_DIR", str(live))
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(archive.path, live)
    assert error.value.code == br.REFUSE_DESTINATION_IS_LIVE_ROOT
    assert not (live / "data").exists()

    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(archive.path, live, confirm_live_overwrite="yes please")
    assert error.value.code == br.REFUSE_DESTINATION_IS_LIVE_ROOT

    result = br.restore_backup(
        archive.path,
        live,
        allow_non_empty=True,
        confirm_live_overwrite=br.LIVE_OVERWRITE_CONFIRMATION,
    )
    assert result.components["core_audit"]["rows"]["audit_logs"] == AUDIT_ROWS


def test_restore_inside_the_live_data_root_is_rejected(tmp_path, backup, monkeypatch):
    _, archive = backup
    live = tmp_path / "live-root"
    live.mkdir()
    monkeypatch.setenv("AEGIS_DATA_DIR", str(live))
    with pytest.raises(br.RestoreRefused) as error:
        br.restore_backup(archive.path, live / "nested")
    assert error.value.code == br.REFUSE_DESTINATION_IS_LIVE_ROOT


# --------------------------------------------------------------------------
# CLI surface
# --------------------------------------------------------------------------


def test_cli_create_verify_and_restore(tmp_path, capsys):
    source = make_root(tmp_path)
    output = tmp_path / "cli-out"
    assert cli.main(["backup-create", "--source", str(source), "--output", str(output)]) == 0
    created = json.loads(capsys.readouterr().out)
    archive = Path(created["archive"])
    assert created["result"] == "BACKUP_CREATED"

    assert cli.main(["backup-verify", "--archive", str(archive)]) == 0
    assert json.loads(capsys.readouterr().out)["result"] == "BACKUP_VERIFIED"

    destination = tmp_path / "cli-restore"
    assert cli.main(["backup-restore", "--archive", str(archive), "--destination", str(destination)]) == 0
    restored = json.loads(capsys.readouterr().out)
    assert restored["result"] == "RESTORE_VERIFIED"
    assert restored["production"] == "NOT_RUN"
    paths = RuntimePaths.from_environment(env={"AEGIS_DATA_DIR": str(destination)})
    assert _rows(paths.core_db, "audit_logs") == AUDIT_ROWS


def test_cli_refusal_reports_the_code_and_exits_two(tmp_path, capsys, backup):
    source, archive = backup
    assert cli.main(["backup-restore", "--archive", str(archive.path), "--destination", str(source)]) == 2
    captured = capsys.readouterr()
    assert br.REFUSE_DESTINATION_EQUALS_SOURCE in captured.err


def test_cli_rejects_a_relative_source(tmp_path, capsys):
    assert cli.main(["backup-create", "--source", "relative/path", "--output", str(tmp_path / "o")]) == 2
    assert br.REFUSE_SOURCE_NOT_ABSOLUTE in capsys.readouterr().err
