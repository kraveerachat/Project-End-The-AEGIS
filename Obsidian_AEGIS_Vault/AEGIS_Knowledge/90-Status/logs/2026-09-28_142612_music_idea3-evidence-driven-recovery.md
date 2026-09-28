---
title: Task Receipt — IDEA3 Evidence-Driven Recovery (R1-R8)
date: 2026-09-28T14:26:12+07:00
owner: music
area: idea3
branch: feat/idea3-evidence-driven-recovery
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Evidence-Driven Recovery (R1-R8)

> [!important] This receipt closes out the R1-R8 evidence-driven recovery implementation task only. It records that the new logic is production-capable and thoroughly tested against real Protocol v1 / MQTT / containment plumbing, but no live physical recovery evidence was collected. LIVE_RECOVERY_VALIDATION=NOT_PERFORMED. No Production, live MQTT, live ESP32, live UFW, live CUT, or live RESTORE action was performed or attempted anywhere in this task.

## What changed

Replaced the old five-step Recovery checklist (wizard.py), which let a single button press stand in for physical/network/service recovery, with an eight-gate evidence-driven state machine that a UI can observe but cannot force past an unverified gate.

- New module IDEA3-AEGIS_Lockdown/aegis_soc/recovery.py -- RecoveryCoordinator and GateEvidence/GateStatus/Gate types implementing:
  - R1 Incident Context -- binds to an existing incident via database.get_open_incident(); never calls create_incident(). A closed or missing incident yields FAILED and blocks every later gate.
  - R2 Safe Management Access -- a bounded, dependency-injectable TCP probe against AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET (new, no prior equivalent existed); unset gives NOT_CONFIGURED, never treated as passing.
  - R3 Attacker Isolation -- apply is separated from verify: ip_containment.ContainmentClient.block() then an independent .contains() read-back must confirm the exact attacker IP before VERIFIED.
  - R4 Restore Authorization -- explicit PIN-based authorization per incident via config.verify_pin; origin="telegram" is rejected outright; resets automatically when the bound incident changes.
  - R5 Physical Restore -- tracks controller.issue("RESTORE_UPLINK", ...) through REQUESTED to PUBLISHED to (independently) correlated ACK and correlated STATUS=NORMAL to VERIFIED, using only evidence already correlated by ProtocolStore/MQTTManager (no independent MQTT parsing). A dry-run result is SIMULATED, never VERIFIED. RESTORE cannot even be requested unless R1-R4 are all VERIFIED.
  - R6 Network Recovery -- bounded, read-only TCP probes against AEGIS_RECOVERY_NETWORK_PROBE_TARGETS; unset gives NOT_CONFIGURED.
  - R7 Service Recovery -- Core (new database.ping() self-check), MQTT (MQTTManager.is_connected), and Web (AEGIS_RECOVERY_WEB_READINESS_URL) are mandatory; IDEA1/IDEA2 readiness URLs are optional and report ADAPTER_UNAVAILABLE when unconfigured, never counted toward mandatory readiness.
  - R8 Incident Closure -- fail-closed: refuses to close unless every mandatory gate (R1-R7) is VERIFIED or explicitly NOT_APPLICABLE; requires a non-empty lessons-learned summary; writes the closure via database.close_incident() exactly once (idempotent on repeat calls).
  - No gate evidence ever carries a PIN, password, key, token, or MQTT credential.
- IDEA3-AEGIS_Lockdown/aegis_soc/config.py -- five new, explicitly opt-in, default-empty probe targets (AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET, AEGIS_RECOVERY_NETWORK_PROBE_TARGETS, AEGIS_RECOVERY_WEB_READINESS_URL, AEGIS_RECOVERY_IDEA1_READINESS_URL, AEGIS_RECOVERY_IDEA2_READINESS_URL). No authoritative equivalent existed anywhere in the repository's desktop configuration.
- IDEA3-AEGIS_Lockdown/aegis_soc/database.py -- added ping(), a bounded, read-only self-check used as R7's Core probe.
- IDEA3-AEGIS_Lockdown/aegis_soc/gui.py -- AegisAdminGUI gained register_recovery_observer()/unregister_recovery_observer(); on_ack/on_status now forward already store-correlated evidence to registered Recovery observers before their existing pending_cmd handling. mqtt.ack_callback/mqtt.status_callback remain the GUI's sole, unchanged single-slot ownership -- no second raw MQTT consumer was introduced. on_status's command_nonce, previously dropped by main()'s lambda before reaching on_status, is now passed through (new parameter defaults to "", so every existing caller/test is unaffected).
- IDEA3-AEGIS_Lockdown/aegis_soc/wizard.py -- full UI rebuild: eight gate cards rendering live RecoveryCoordinator evidence (status color, summary, detail), one action button per gate calling the matching coordinator method, a visible SIMULATION/DRY RUN banner when AEGIS_DRY_RUN=1 stating physical RESTORE will not execute and cannot be marked VERIFIED, and observer registration on open / unregistration on destroy().
- IDEA3-AEGIS_Lockdown/aegis_soc/i18n.py -- added recovery.evidence_heading, recovery.no_incident, recovery.dry_run_banner, recovery.gate_r1..r8_title, and per-gate button keys in English, Thai, and Chinese. The old recovery.step* keys are left in place (unused, harmless; i18n.translate() never raises on a removed reference).
- IDEA3-AEGIS_Lockdown/tests/test_recovery.py -- new, 43 tests covering every gate's pass/fail/not-configured/not-applicable path, including true end-to-end R5 correlation built on the same real ProtocolStore + MQTTManager + AegisCommandController fixtures used by tests/test_mqtt_client.py/tests/test_controller.py (not hand-rolled MQTT parsing).

## Source files changed

- IDEA3-AEGIS_Lockdown/aegis_soc/recovery.py (new)
- IDEA3-AEGIS_Lockdown/aegis_soc/config.py
- IDEA3-AEGIS_Lockdown/aegis_soc/database.py
- IDEA3-AEGIS_Lockdown/aegis_soc/gui.py
- IDEA3-AEGIS_Lockdown/aegis_soc/wizard.py
- IDEA3-AEGIS_Lockdown/aegis_soc/i18n.py
- IDEA3-AEGIS_Lockdown/tests/test_recovery.py (new)
- Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-28_142612_music_idea3-evidence-driven-recovery.md -- this immutable final task receipt.

No protected-semantics file was modified: controller.py, protocol_v1.py, protocol_inbound.py, protocol_runtime.py, protocol_store.py, supervisor.py, local_restore.py, security.py, and production_runtime.py are all byte-identical to origin/main (12305f2d3abee6cb3aaa7b49093b00c4b51f6e79) at this branch's final HEAD.

## Verification evidence

- `python -m ruff check aegis_soc/recovery.py aegis_soc/config.py aegis_soc/database.py aegis_soc/gui.py aegis_soc/wizard.py aegis_soc/i18n.py tests/test_recovery.py --no-cache` -- passed, "All checks passed!" (TASK_SCOPED_RUFF=PASS). Repository-wide ruff over the full desktop scope carries the same 238 pre-existing errors documented in the prior Python UX/UI closeout receipt, unrelated to this task's files; not fixed here (REPOSITORY_WIDE_RUFF=PRE_EXISTING_BASELINE_DEBT_238, REPOSITORY_WIDE_RUFF_REGRESSION_INTRODUCED_BY_THIS_TASK=NO).
- `python -m compileall -q aegis_soc/recovery.py aegis_soc/config.py aegis_soc/database.py aegis_soc/gui.py aegis_soc/wizard.py aegis_soc/i18n.py tests/test_recovery.py` -- passed, exit 0.
- Targeted pytest across test_recovery.py plus every affected desktop/GUI/MQTT/controller/i18n/containment suite (test_desktop_widget_lifecycle.py, test_desktop_pages.py, test_desktop_auth.py, test_mqtt_client.py, test_controller.py, test_i18n.py, test_theme.py, test_theme_state.py, test_login_view.py, test_branding.py, test_notifications.py, test_presentation.py, test_local_restore.py, test_core.py, test_ip_containment.py, test_cli_ip_containment.py) -- passed, 449 passed total across these runs.
- Scripted safe GUI smoke test (real Tk widget tree under the live X display, AEGIS_DRY_RUN=1, no MQTT connect, no UFW, no ESP32) exercised: opening Recovery with no open incident does not fabricate one; R1 is FAILED with no recoverable incident and VERIFIED once bound to a real one; all 8 gate rows render; no untouched gate ever reads VERIFIED; opening registers exactly one observer, destroying unregisters it, reopening never accumulates observers; evidence forwarded after destroy() raises nothing; the pre-existing pending_cmd/ACK-matching behavior is unaffected -- SAFE_GUI_SMOKE_TEST=PASS. This script caught one real bug (ScrollFrame rejected a duplicate bg kwarg), fixed before any human ever saw the window. HUMAN_VISUAL_QA=NOT_RECORDED -- no human has reviewed the rendered UI for this task; that is honestly left open, not claimed.
- First full serial regression `python -m pytest -p no:cacheprovider -q` (no AEGIS_* env vars, no xdist, no timeout wrapper) surfaced 3 failures. Two were genuine task regressions, not environment flakes: tests/test_runtime.py builds AegisAdminGUI via AegisAdminGUI.__new__() (bypassing __init__) to unit-test on_ack/on_status in isolation, so the newly added self._recovery_observers attribute was never set, and on_ack/on_status raised AttributeError. These were fixed by reading the attribute via getattr(self, "_recovery_observers", ()), matching this file's existing _last_uplink_state pattern for the same kind of test double, in commit 1b41a23f9dd4a0db33152d6701a35b1eaf383a7a, and reverified individually (2 passed). The third failure, tests/test_pr11_phase4_l6c_capture_gap.py::test_real_end_to_end_capture_then_compare_requires_the_allow_file, was a separate, unrelated environment condition: `systemctl show aegis-idea3-mosquitto.service -p NRestarts` showed NRestarts=4612 and climbing with Active: activating (auto-restart) at the moment of failure -- the host's real mosquitto service was actively crash-looping on this development machine during the run, unrelated to this task's code. A single rerun of only that exact test passed (1 passed in 1.44s), consistent with the same class of host-observation flakiness previously documented for this exact test.
- Final, complete serial regression on the fully committed source (HEAD 1b41a23f9dd4a0db33152d6701a35b1eaf383a7a, after the genuine-regression fix) -- `python -m pytest -p no:cacheprovider -q`, no AEGIS_* env vars, no xdist, no timeout wrapper -- passed clean: 3782 passed, 8 skipped in 716.92s (0:11:56), zero failures, including the L6c test on this run. FULL_REGRESSION=PASS.
- `git diff --check` -- passed, no whitespace errors, rerun after every commit in this task.

## Canonical notes updated

- None. Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md was not modified by this task.

## Shared surfaces touched

- None. All source changes are under IDEA3-AEGIS_Lockdown/; no IDEA1, IDEA2, HUB, firmware, or shared infrastructure path was touched.

## Integration requests

- None. This is a self-contained IDEA3 desktop recovery-logic task with no cross-scope wiring requested.

## Known limitations

- Recovery invariants, explicitly enforced and tested: REQUESTED != PUBLISHED (R5's RestorePhase.PUBLISHED only follows a real controller.issue() publish, never a bare method call); PUBLISHED != ACK_CORRELATED (on_ack_evidence requires an exact ack_for_msg_id match to the outstanding RESTORE's own msg_id, forwarded only after ProtocolStore.consume_ack already correlated it); ACK_CORRELATED != PHYSICAL_RESTORE_VERIFIED (a correlated ACK alone leaves R5 CHECKING, never VERIFIED, until STATUS also correlates); PHYSICAL_RESTORE_VERIFIED != NETWORK_RECOVERED (R6 is a separate, independently bounded probe gate that requires R5 VERIFIED first); NETWORK_RECOVERED != SERVICE_READY (R7 is a separate gate requiring R6 VERIFIED first); SERVICE_READY is required before INCIDENT_CLOSED (R8 refuses to close with any mandatory gate short of VERIFIED/NOT_APPLICABLE).
- AEGIS_RECOVERY_MANAGEMENT_PROBE_TARGET, AEGIS_RECOVERY_NETWORK_PROBE_TARGETS, and AEGIS_RECOVERY_WEB_READINESS_URL are unset by default in every environment this task touched; R2/R6/R7 will report NOT_CONFIGURED until an operator explicitly sets them for a real deployment. This is intentional fail-closed behavior, not a defect, and NOT_CONFIGURED is never converted into PASS.
- AEGIS_RECOVERY_IDEA1_READINESS_URL/AEGIS_RECOVERY_IDEA2_READINESS_URL are unset by default; R7 reports these as ADAPTER_UNAVAILABLE (optional, never mandatory, never fake PASS).
- LIVE_RECOVERY_VALIDATION=NOT_PERFORMED: the implementation is production-capable recovery logic, tested against real Protocol v1/MQTT/containment plumbing, but this receipt does NOT claim live physical recovery evidence. No live UFW mutation, live MQTT publish, live ESP32 command, live CUT_UPLINK, or live RESTORE_UPLINK was performed against real hardware or a real broker. Staged live validation on the lab environment is a separate, later, separately authorized activity.
- No live UFW mutation, no live MQTT, no live ESP32 interaction, no live CUT/RESTORE, and no Production mutation were performed or attempted anywhere in this task.
- IDEA1 and IDEA2 sources were not touched by this task (IDEA1_MUTATION=NO, IDEA2_MUTATION=NO).
- HUMAN_VISUAL_QA=NOT_RECORDED for this task's UI -- a human has not yet reviewed the rendered Recovery window; this receipt does not claim that acceptance.
