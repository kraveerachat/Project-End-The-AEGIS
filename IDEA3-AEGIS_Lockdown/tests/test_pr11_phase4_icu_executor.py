from __future__ import annotations

import importlib.util
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy/pr11-phase4"
TOOL = DEPLOY / "p4-icu-upgrade.py"
FREEZER = DEPLOY / "icu_runner_freeze.py"
P4_LIB = DEPLOY / "p4-lib.sh"
RUNNER = DEPLOY / "owner-run/run-icu-owner.sh"
STAGE_GATE = DEPLOY / "p4-stage-gate.sh"

SPEC = importlib.util.spec_from_file_location("p4_icu_upgrade", TOOL)
ICU = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ICU)
FREEZE_SPEC = importlib.util.spec_from_file_location("icu_runner_freeze", FREEZER)
FREEZER_MODULE = importlib.util.module_from_spec(FREEZE_SPEC)
assert FREEZE_SPEC.loader is not None
FREEZE_SPEC.loader.exec_module(FREEZER_MODULE)


def test_icu_is_registered_as_unique_mutating_stage_before_recovery(tmp_path: Path) -> None:
    command = (
        f'. "{P4_LIB}"; '
        'p4_stage_known ICu && p4_stage_mutates ICu && '
        'printf "STAGE_OK\\n"; p4_stage_gaps ICu; '
        'printf "AUTH_EXTRA="; p4_stage_auth_extra ICu; '
        'p4_stage_handler_status ICu'
    )
    output = subprocess.run(["bash", "-c", command], check=True, text=True, capture_output=True).stdout.splitlines()
    assert "STAGE_OK" in output
    assert "none" in output
    assert any(line.startswith("AUTH_EXTRA=") and "frozen_runner_sha256" in line for line in output)
    assert output[-1] == "REGISTERED"
    registry = next(line for line in P4_LIB.read_text().splitlines() if line.strip().startswith("readonly P4_STAGES="))
    stages = registry.split('"')[1].split()
    assert stages.index("CTv") < stages.index("ICu") < stages.index("Recovery")


def test_frozen_runner_is_pinned_and_refuses_unknown_restart_effect_before_marker() -> None:
    text = RUNNER.read_text()
    assert "EXPECTED_MAIN=PIN_MAIN_SHA" in text
    assert "OLD_RELEASE_ID=954ce1c191885e9e90198a6f54a3d990bcf144fc" in text
    assert "NEW_RELEASE_ID=idea3-core-728c2d9b-20261010" in text
    assert "SYSTEMD_RESTART_EFFECT_PROVEN=NO" in text
    assert "ACTUAL_INSTALLED_UNIT_RESTART_EFFECT_NOT_PROVEN" in text
    blocker = text.index('if [ "$SYSTEMD_RESTART_EFFECT_PROVEN" != YES ]')
    marker = text.index('consume-marker --path "$ATTEMPT_MARKER"')
    assert blocker < marker
    assert "readonly SYSTEMD_RESTART_EFFECT_PROVEN=NO" in text
    assert 'readonly AUTHORITATIVE_MAIN="4ebade39a3ae2bf2c4fd75f0ebba0edb46248e17"' in text
    rollback = (DEPLOY / "stages/ICu/rollback.sh").read_text()
    assert "readonly SYSTEMD_RESTART_EFFECT_PROVEN=NO" in rollback
    assert "${SYSTEMD_RESTART_EFFECT_PROVEN:-NO}" not in rollback
    assert "Detector command" in text


def test_attempt_marker_is_exclusive_durable_and_never_reusable(tmp_path: Path) -> None:
    marker = tmp_path / "ICU-GLOBAL-ATTEMPT-CONSUMED"
    ICU.consume_attempt_marker(marker)
    assert marker.read_text() == "stage=ICu\nattempt=1\n"
    assert marker.stat().st_mode & 0o777 == 0o600

    try:
        ICU.consume_attempt_marker(marker)
    except ICU.ICuRefused as exc:
        assert str(exc) == "ICU_ATTEMPT_ALREADY_CONSUMED"
    else:
        raise AssertionError("a second invocation must be refused")


def _authority_records(tmp_path: Path, *, k3_unit: str = "c" * 64) -> tuple[Path, Path]:
    today = subprocess.run(["date", "+%F"], check=True, text=True, capture_output=True,
                           env={**os.environ, "TZ": "Asia/Bangkok"}).stdout.strip()
    fields = {
        "expected_main": ICU.EXPECTED_MAIN,
        "frozen_runner_sha256": "a" * 64,
        "runner_template_sha256": "b" * 64,
        "unit_snapshot_sha256": "c" * 64,
        "operator_user": "kittipat",
        "operator_uid": "1000",
        "old_release_id": ICU.OLD_RELEASE_ID,
        "new_release_id": ICU.NEW_RELEASE_ID,
        "new_release_source_main": ICU.NEW_RELEASE_SOURCE_MAIN,
        "new_sums_sha256": ICU.NEW_SUMS_SHA256,
        "new_manifest_sha256": ICU.NEW_MANIFEST_SHA256,
    }
    auth = tmp_path / "authorization-ICu.txt"
    k3 = tmp_path / "k3-ICu.txt"
    common = "".join(f"{key}={value}\n" for key, value in fields.items())
    auth.write_text("AEGIS_P4_AUTHORIZATION_V1\n" + f"stage=ICu\ndate={today}\nauthorizer=music\n"
                    "scope=Governed ICu executor\nreference=https://example.test/icu\n" + common)
    k3_values = fields | {"unit_snapshot_sha256": k3_unit}
    k3_common = "".join(f"{key}={value}\n" for key, value in k3_values.items())
    k3.write_text("AEGIS_P4_K3_CONFIRMATION_V1\n" + f"stage=ICu\ndate={today}\nconfirmed_by=kraveerachat\n"
                  "idea1_window_overlap=NONE\nreference=https://example.test/icu-k3\n" + k3_common)
    return auth, k3


def test_stage_gate_accepts_only_exact_matching_icu_authority_and_k3(tmp_path: Path) -> None:
    auth, k3 = _authority_records(tmp_path)
    result = subprocess.run(["bash", str(STAGE_GATE), "--stage", "ICu", "--mode", "simulate",
                             "--authorization", str(auth), "--k3", str(k3)],
                            check=False, text=True, capture_output=True,
                            env={**os.environ, "TZ": "Asia/Bangkok"})
    assert result.returncode == 0, result.stdout + result.stderr
    assert "AUTHORIZATION_RECORD=VALID" in result.stdout
    assert "K3_CONFIRMATION=VALID" in result.stdout
    assert "LIVE_STAGE_AUTHORIZED=NO" in result.stdout


def test_stage_gate_refuses_icu_authority_k3_pin_mismatch(tmp_path: Path) -> None:
    auth, k3 = _authority_records(tmp_path, k3_unit="d" * 64)
    result = subprocess.run(["bash", str(STAGE_GATE), "--stage", "ICu", "--mode", "simulate",
                             "--authorization", str(auth), "--k3", str(k3)],
                            check=False, text=True, capture_output=True,
                            env={**os.environ, "TZ": "Asia/Bangkok"})
    assert result.returncode == 1
    assert "K3_ICU_BINDING_MISMATCH" in result.stdout


def test_exact_authority_rejects_extra_fields_and_stale_date() -> None:
    required = {
        "stage": "ICu", "expected_main": ICU.EXPECTED_MAIN,
        "frozen_runner_sha256": "a" * 64, "runner_template_sha256": "b" * 64,
        "unit_snapshot_sha256": "c" * 64, "operator_user": "kittipat", "operator_uid": "1000",
        "old_release_id": ICU.OLD_RELEASE_ID, "new_release_id": ICU.NEW_RELEASE_ID,
        "new_release_source_main": ICU.NEW_RELEASE_SOURCE_MAIN, "new_sums_sha256": ICU.NEW_SUMS_SHA256,
        "new_manifest_sha256": ICU.NEW_MANIFEST_SHA256,
    }
    auth = required | {"date": "2026-10-11", "authorizer": "music", "scope": "ICu", "reference": "https://example.test/a"}
    k3 = required | {"date": "2026-10-11", "confirmed_by": "kraveerachat", "idea1_window_overlap": "NONE",
                     "reference": "https://example.test/k"}
    ICU.validate_exact_authority(auth, k3, runner_sha256="a" * 64, runner_template_sha256="b" * 64,
                                 operator_user="kittipat", operator_uid="1000",
                                 unit_snapshot_sha256="c" * 64, today="2026-10-11")
    try:
        ICU.validate_exact_authority(auth | {"recovery_authorization": "https://example.test/recovery"}, k3,
                                     runner_sha256="a" * 64, runner_template_sha256="b" * 64,
                                     operator_user="kittipat", operator_uid="1000",
                                     unit_snapshot_sha256="c" * 64, today="2026-10-11")
    except ICU.ICuRefused as exc:
        assert str(exc) == "ICU_AUTHORIZATION_FIELDS_INVALID"
    else:
        raise AssertionError("unknown authority fields must be refused")


def test_freezer_binds_exact_main_template_operator_unit_snapshot_and_repo_path() -> None:
    template = RUNNER.read_text()
    rendered, template_sha, runner_sha = FREEZER_MODULE.render_runner(
        template,
        expected_main=ICU.EXPECTED_MAIN,
        operator_user="kittipat",
        operator_uid="1000",
        unit_snapshot_sha256="c" * 64,
        repo_path="/srv/aegis/exact-main",
    )
    assert template_sha == __import__("hashlib").sha256(template.encode()).hexdigest()
    assert runner_sha == __import__("hashlib").sha256(rendered.encode()).hexdigest()
    assert all(token not in rendered for token in FREEZER_MODULE.PIN_VALUES)
    assert f"EXPECTED_MAIN={ICU.EXPECTED_MAIN}" in rendered
    assert "readonly SYSTEMD_RESTART_EFFECT_PROVEN=NO" in rendered


def test_freezer_refuses_wrong_main_and_repository_local_output() -> None:
    try:
        FREEZER_MODULE.render_runner(RUNNER.read_text(), expected_main="0" * 40, operator_user="kittipat",
                                     operator_uid="1000", unit_snapshot_sha256="c" * 64,
                                     repo_path="/srv/aegis/exact-main")
    except ValueError as exc:
        assert str(exc) == "ICU_FREEZE_MAIN_MISMATCH"
    else:
        raise AssertionError("the source pin is fixed to the specified merged main")


def test_write_ahead_journal_is_atomic_durable_and_binds_exact_release_pins(tmp_path: Path) -> None:
    journal = tmp_path / "icu-journal.json"
    ICU.write_ahead_journal(journal, "installing")
    payload = ICU.read_journal(journal)
    assert payload["stage"] == "ICu"
    assert payload["phase"] == "installing"
    assert payload["old_release_id"] == "954ce1c191885e9e90198a6f54a3d990bcf144fc"
    assert payload["new_release_id"] == "idea3-core-728c2d9b-20261010"
    assert not list(tmp_path.glob(".icu-journal.json.*.tmp"))
    ICU.write_ahead_journal(journal, "switching_current", {"current_owned_by_attempt": False})
    advanced = ICU.read_journal(journal)
    assert advanced["phase"] == "switching_current"
    assert advanced["expected_main"] == ICU.EXPECTED_MAIN
    assert advanced["current_owned_by_attempt"] is False


def test_apply_handler_requires_consumed_attempt_journal() -> None:
    apply = (DEPLOY / "stages/ICu/apply.sh").read_text()
    assert "assert-journal --path \"$AEGIS_ICU_JOURNAL\" --phase attempt_consumed" in apply


def test_unknown_restart_effect_refuses_before_marker_and_any_mutation(tmp_path: Path) -> None:
    class Backend:
        mutations: list[str]

        def __init__(self) -> None:
            self.mutations = []

        def preflight(self) -> dict[str, object]:
            return {
                "restart_effect": "NOT_PROVEN",
                "current_release_id": ICU.OLD_RELEASE_ID,
                "core_active_state": "active",
                "detector_state": "loaded/inactive/dead/disabled/pid0/process0",
                "ctu_ctv_history": "FAIL_IMMUTABLE_CONSUMED",
                "recovery_authorized": "NO",
                "preserved_services": {key: "UNCHANGED" for key in ICU.PRESERVED_KEYS},
            }

        def mutate(self, operation: str) -> None:
            self.mutations.append(operation)

    backend = Backend()
    marker = tmp_path / "ICU-GLOBAL-ATTEMPT-CONSUMED"
    try:
        ICU.execute(backend, marker)
    except ICU.ICuRefused as exc:
        assert str(exc) == "ACTUAL_INSTALLED_UNIT_RESTART_EFFECT_NOT_PROVEN"
    else:
        raise AssertionError("the executor must keep the restart blocker closed")

    assert not marker.exists()
    assert backend.mutations == []


def test_rollback_requires_exact_old_release_and_never_commands_detector(tmp_path: Path) -> None:
    class Backend:
        def __init__(self) -> None:
            self.operations: list[tuple[str, str]] = []

        def validate_rollback_preflight(self, release_id: str) -> bool:
            return release_id == ICU.OLD_RELEASE_ID

        def switch_current(self, expected: str, target: str) -> None:
            assert expected == ICU.NEW_RELEASE_ID
            self.operations.append(("switch", target))

        def restart_core_once(self, release_id: str) -> None:
            self.operations.append(("restart_core", release_id))

        def verify_rollback_and_preservation(self, release_id: str) -> bool:
            return release_id == ICU.OLD_RELEASE_ID

        def detector_command(self, *_args: object) -> None:
            raise AssertionError("the Detector is never a command target")

    backend = Backend()
    journal = {
        "stage": "ICu",
        "phase": "forward_failed",
        "old_release_id": ICU.OLD_RELEASE_ID,
        "new_release_id": ICU.NEW_RELEASE_ID,
        "current_owned_by_attempt": True,
        "forward_restart_invocations": 1,
        "rollback_restart_invocations": 0,
    }
    journal_path = tmp_path / "icu-journal.json"
    ICU.write_ahead_journal(journal_path, "forward_failed", journal)
    ICU.rollback(backend, journal, journal_path)
    assert backend.operations == [("switch", ICU.OLD_RELEASE_ID), ("restart_core", ICU.OLD_RELEASE_ID)]
    assert journal["rollback_restart_invocations"] == 1
    persisted = ICU.read_journal(journal_path)
    assert persisted["phase"] == "rolled_back"
    assert persisted["rollback_restart_invocations"] == 1
