import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "deploy" / "pr11-phase4" / "flash-backup-diagnostics.py"
SPEC = importlib.util.spec_from_file_location("flash_backup_diagnostics", MODULE_PATH)
DIAGNOSTICS = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(DIAGNOSTICS)


def make_backup(tmp_path: Path) -> tuple[Path, str]:
    data = bytearray(b"\xff") * DIAGNOSTICS.EXPECTED_FLASH_SIZE
    data[DIAGNOSTICS.BOOTLOADER_OFFSET] = 0xE9  # ESP32 bootloader header magic.
    data[DIAGNOSTICS.PARTITION_TABLE_OFFSET:DIAGNOSTICS.PARTITION_TABLE_OFFSET + 2] = b"\xaa\x50"  # Partition-table magic.
    path = tmp_path / "flash.bin"
    path.write_bytes(data)
    return path, hashlib.sha256(data).hexdigest()


def valid_evidence(digest: str) -> dict:
    return {
        "flash_size_bytes": 4194304,
        "read_mode": "rom/no-stub",
        "baud": 115200,
        "sha256": digest,
        "sha256_verification": "PASS",
        "bootloader_header": "EXPECTED",
        "partition_header": "EXPECTED",
        "firmware_writing": "NO",
        "flash_erasing": "NO",
        "backup_restoration_tested": "NO",
        "historical_attempts": [{"baud": 460800, "result": "FAIL"}],
    }


def test_valid_read_only_backup_is_pass_and_preserves_historical_failure(tmp_path):
    backup, digest = make_backup(tmp_path)

    result = DIAGNOSTICS.validate_backup(valid_evidence(digest), backup)

    assert result == {
        "verdict": "PASS",
        "flash_size_bytes": 4194304,
        "sha256": digest,
        "offline_validation_scope": "OWNER_SUPPLIED_ARTIFACTS_ONLY",
        "owner_declared_evidence": {
            "firmware_writing": "NO",
            "flash_erasing": "NO",
            "backup_restoration_tested": "NO",
        },
        "hardware_behavior_observed": "NOT_OBSERVED",
        "historical_460800_failure_preserved": True,
    }

    assert "write_or_erase_detected" not in result
    assert "restore_tested" not in result


def test_digest_or_header_mismatch_fails_closed(tmp_path):
    backup, digest = make_backup(tmp_path)
    evidence = valid_evidence(digest)
    evidence["sha256"] = "0" * 64

    with pytest.raises(DIAGNOSTICS.DiagnosticError, match="sha256"):
        DIAGNOSTICS.validate_backup(evidence, backup)

    broken = bytearray(backup.read_bytes())
    broken[DIAGNOSTICS.BOOTLOADER_OFFSET] = 0
    backup.write_bytes(broken)
    changed_digest = hashlib.sha256(backup.read_bytes()).hexdigest()
    with pytest.raises(DIAGNOSTICS.DiagnosticError, match="bootloader header"):
        DIAGNOSTICS.validate_backup(valid_evidence(changed_digest), backup)


def test_bootloader_magic_at_esp32_flash_offset_0x1000_is_required(tmp_path):
    backup, digest = make_backup(tmp_path)

    assert DIAGNOSTICS.validate_backup(valid_evidence(digest), backup)["verdict"] == "PASS"

    broken = bytearray(backup.read_bytes())
    broken[0x1000] = 0
    backup.write_bytes(broken)
    changed_digest = hashlib.sha256(backup.read_bytes()).hexdigest()
    with pytest.raises(DIAGNOSTICS.DiagnosticError, match="bootloader header"):
        DIAGNOSTICS.validate_backup(valid_evidence(changed_digest), backup)


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        ("baud", 460800, "115200"),
        ("read_mode", "stub", "ROM/no-stub"),
        ("firmware_writing", "YES", "writing"),
        ("flash_erasing", "YES", "erasing"),
        ("backup_restoration_tested", "YES", "restoration"),
    ],
)
def test_unsafe_or_unverified_boundary_is_rejected(tmp_path, field, value, message):
    backup, digest = make_backup(tmp_path)
    evidence = valid_evidence(digest)
    evidence[field] = value

    with pytest.raises(DIAGNOSTICS.DiagnosticError, match=message):
        DIAGNOSTICS.validate_backup(evidence, backup)


def test_cli_reads_json_and_emits_machine_readable_result(tmp_path, capsys):
    backup, digest = make_backup(tmp_path)
    evidence = tmp_path / "evidence.json"
    evidence.write_text(json.dumps(valid_evidence(digest)), encoding="utf-8")

    assert DIAGNOSTICS.main(["--evidence", str(evidence), "--backup", str(backup)]) == 0
    output = json.loads(capsys.readouterr().out)
    assert output["verdict"] == "PASS"
    assert output["offline_validation_scope"] == "OWNER_SUPPLIED_ARTIFACTS_ONLY"
    assert output["owner_declared_evidence"] == {
        "firmware_writing": "NO",
        "flash_erasing": "NO",
        "backup_restoration_tested": "NO",
    }
    assert output["hardware_behavior_observed"] == "NOT_OBSERVED"
    assert "write_or_erase_detected" not in output
    assert "restore_tested" not in output
    assert output["historical_460800_failure_preserved"] is True
