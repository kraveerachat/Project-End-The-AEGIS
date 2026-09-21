---
title: Task Receipt — IDEA3 PR11 Phase 4 L8 ESP32 provisioning / flash handler
date: 2026-09-21T09:14:24+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-phase4-l8-handler
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L8 ESP32 provisioning / flash handler

> Repository-only. No ESP32 hardware exists or was accessed, no serial port was
> opened, no firmware was flashed, and no live L8 stage is authorized or run.

## What changed

Stage **L8** (ESP32 inspection, NVS provisioning, firmware flash) is now a
registered Phase 4 stage handler: `p4_stage_handler_status L8` reports
`REGISTERED`. The stage is implemented against a **fixture device backend
only**; selecting the hardware backend fails closed at two independent layers,
so the repository still contains no Production write tool, no Production
readback verifier, and no Production key generator.

A formal operational design (`OD-L8-01` … `OD-L8-09`) was written first and
reconciles the previously scattered L8 design candidate against the current
owner decisions. Three fragments changed materially:

- the **static-addressing branch is dropped** — the address model is DHCP, so
  G-04 is `NOT_APPLICABLE_UNDER_SELECTED_ADDRESS_MODEL` and the design now
  asserts the *absence* of static addressing instead;
- the **interim-recovery alternative is removed** — OD-14 makes recovery
  `D4_ONLY` and `INTERIM_RECOVERY_PROCEDURE=NOT_APPROVED`;
- **"passive inspection" is withdrawn** — L8 inspection is
  `NON_WRITING_BUT_DEVICE_RESETTING` and requires a maintenance window, because
  serial/esptool access can toggle DTR/RTS and reset the device.

Security controls implemented and tested: OV-12 MAC binding aborts before any
write; D4 live attestation is required before the write path; partition
geometry is derived from the reviewed build's table with no default and no
fallback; the firmware build command is validated as compile-only and never
executed; a placeholder MQTT CA and known demo/test protocol keys are refused;
the NVS readback compares privately and records only a boolean; the hardware
evidence bundle is write-once at mode 0600 restricted to the exact eleven-field
allowlist with no secret; and rollback splits at the first hardware write, after
which it performs no device action at all and never reflashes, auto-restores, or
reopens plaintext MQTT.

## Source files changed

- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l8-operational-design.md` — new formal L8 operational design, OD-L8-01..OD-L8-09, with the prior-candidate reconciliation table
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/apply.sh` — new stage apply handler: environment gate, backend gate, input inventory and mode checks, delegation to the device helper
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/verify.sh` — new read-only post-stage verification of the evidence bundle, stage artifact modes, and the empty allow files
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/rollback.sh` — new two-branch fail-secure rollback, idempotent
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/allow-keys.txt` — new; zero active keys by contract (L8 changes the device, not the Core host)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8/allow-listeners.txt` — new; zero active entries
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8-device.py` — new device helper: identity binding, D4 attestation, partition geometry derivation, trust-anchor validation, fixture backend, private readback compare, write-once evidence bundle
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l8_handler.py` — new RED-first acceptance suite (77 tests)
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — reviewed-handler allowlist extended to include L8; the unregistered-mutating-stage example moved from L8 to L9

`p4-lib.sh` required **no change**: `L8` was already present in `P4_STAGES`,
`p4_stage_gaps` (`G-04,G-11,G-16`), and `p4_stage_auth_extra`
(`recovery_authorization`). `p4-l0-capture.sh`, `p4-compare.sh`,
`p4-stage-gate.sh`, `p4-nvs-provision.py`, and `firmware/**` are unchanged.

## Verification evidence

- `pytest tests/test_pr11_phase4_l8_handler.py` (before implementation) — **RED: 53 failed, 17 passed**, with zero `ImportError`/`SyntaxError`/`ModuleNotFoundError`; the 17 pre-satisfied tests assert already-merged firmware, NVS-schema, and `p4-lib.sh` contracts
- `pytest tests/test_pr11_phase4_l8_handler.py` — pass: **77 passed**
- `pytest tests/test_pr11_phase4_harness.py` — pass: **160 passed**
- `pytest tests/test_pr11_phase4_*.py` — pass: **542 passed**
- `pytest tests/` (full IDEA3 suite) — pass: **1522 passed, 6 skipped**; the pre-task baseline on `0544f1cc` was **1445 passed, 6 skipped**, so the delta is exactly the 77 new L8 tests and no existing test was lost or weakened
- `pytest tests/test_firmware_contract.py tests/test_firmware_protocol_parity.py tests/test_pr11_phase4_nvs_provision.py tests/test_pr11_phase4_g15_host_artifacts.py tests/test_pr11_phase4_l8_handler.py` — pass: **113 passed**
- `bash -n` on `p4-lib.sh`, `p4-l0-capture.sh`, `p4-compare.sh`, `p4-stage-gate.sh`, `stages/L8/apply.sh`, `stages/L8/verify.sh`, `stages/L8/rollback.sh` — pass: all 7 PASS
- `bash -c '. p4-lib.sh && p4_stage_handler_status L8'` — pass: `REGISTERED`
- `git diff --check` — pass
- Secret scan over every new file (private-key headers, `password=`, `passwd=`) — pass: no matches
- Negative controls, each restored and verified byte-identical, none committed:
  - evidence allowlist extra-field refusal disabled → expected test FAILED
  - OV-12 MAC equality gate disabled → expected test FAILED
  - hardcoded `0x9000` NVS offset fallback introduced → 2 expected tests FAILED
  - hardware-backend refusal removed from `apply.sh` only → **no test failed**, recorded as a finding: the refusal is genuine two-layer defense in depth
  - hardware-backend refusal removed from **both** layers → 2 expected tests FAILED
  - post-first-write rollback branch disabled → expected test FAILED

Three defects were found by independent audit of the new code and fixed before
commit, each now covered by regression tests:

1. the firmware write used a hardcoded `0x10000` application offset while only
   the NVS offset was derived — this reintroduced exactly the guess OD-L8-03
   forbids; geometry derivation is now general and fail-closed for every
   partition L8 writes, including the NVS size;
2. the placeholder-CA scan uppercased the whole header and searched for `TODO`,
   `CHANGEME` and similar, which are all base64-legal, so it could have refused
   a genuine certificate during a real flash window; it now scans the
   certificate body for separator-bearing tokens plus a strict base64 alphabet
   check and a body length floor;
3. a failed device write re-raised before the evidence bundle was written,
   contradicting `FAIL_SECURE_HOLD_AND_EVIDENCE`; the failure is now recorded
   into the bundle (`flash_result=FAIL`, `failure_boundary=DEVICE_WRITE`) and
   the run exits non-zero.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — added the L8 task section: registration matrix now records `L8_HANDLER = REGISTERED`, `L8_REPOSITORY_IMPLEMENTED = YES`, `RED_FIRST_PROVEN = YES`, the L8 Task Map, the audit findings, and the negative-control table. Live state is unchanged and explicitly separate: `L2..L8 = NOT RUN`, `L8_LIVE_AUTHORIZED = NO`, `PHASE4_RUNTIME_COMPLETE = NO`, `PHASE4_LIVE_READINESS = NOT READY`.

## Shared surfaces touched

- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — the shared Phase 4 / G-15 harness carries an explicit allowlist of reviewed stage handlers (`test_only_reviewed_stage_handlers_are_registered`) and uses one unregistered mutating stage as its live-gate fixture (`test_gate_live_mode_for_mutating_stage_fails_without_registered_handler`). Registering L8 requires adding L8 to the allowlist and moving that fixture from L8 to L9. This is the identical adjustment PR #164 made for L7 in commit `2741ea3f`, and it changes a guardrail shared by every Phase 4 stage, so it needs integration-owner review.

## Integration requests

- **Kla (integration owner, temporary GitHub reviewer for IDEA3)** — review the
  single shared-harness edit to `tests/test_pr11_phase4_harness.py`. Decision
  required: confirm that L8 belongs in the reviewed-handler allowlist and that
  moving the unregistered-mutating-stage fixture to L9 is the intended
  continuation of the L7 precedent. Downstream effect: the guardrail is what
  prevents an unreviewed `stages/<STAGE>/` directory from being treated as a
  registered handler, and the live-gate fixture is what proves
  `ROLLBACK_HANDLER_NOT_REGISTERED` still fires; both must keep failing closed.
  Rollback: revert the six-line harness change and the `stages/L8/` directory,
  which returns `p4_stage_handler_status L8` to `NOT_REGISTERED`. No runtime,
  deployment, or migration effect — nothing is deployed and nothing live runs.

## Known limitations

- **Live L8 is NOT AUTHORIZED and NOT RUN.** `L2..L8` are all `NOT RUN`.
  Repository completion is not live acceptance.
  `LIVE_L8_PHYSICAL_PROOF_REQUIRED = YES`; that proof does not exist.
- **No physical device exists** (E-08). Every test runs against the fixture
  backend. Repository tests are not physical relay proof, and nothing here
  demonstrates a real flash, a real boot, a real DHCP join, or a real relay
  state.
- **The Production NVS offset is UNKNOWN.** `firmware/` contains no partition
  table, so no offset is derivable today. This is deliberate: the handler fails
  closed rather than guessing, and the owner must supply the reviewed build's
  table at flash time.
- **The real MQTT CA cannot be validated here.** `firmware/src/secrets.h` is
  gitignored and absent; only the placeholder contract is provable.
- **`p4-nvs-provision.py` remains render-only** (`G11 = PARTIAL_REPOSITORY`).
  L8 adds the artifact and verification contract around it but adds no
  Production write tool and no Production readback verifier. The NVS partition
  generator is an owner-supplied external tool and is not vendored; it is not
  installed on this machine, so only a fixture stand-in has been exercised.
- **The Python secret reader enforces owner-only mode, not exact 0600.**
  `p4-nvs-provision.read_secret_file` checks `mode & 0o077 == 0`. The L8 stage
  handler separately requires exact `0600`/`0400` on its own inputs; the
  underlying reader was not changed and should not be described as enforcing
  exact 0600.
- **Fixture-backend evidence is structurally identical to a live bundle.** The
  allowlist forbids an extra provenance field, so run context rides in `run_id`
  only. Repository runs use a `fixture` run id by convention; a reviewer must
  not read a fixture bundle as hardware evidence.
- **The §10 IDEA2 preservation caveat remains open and blocking** for any live
  Phase 4 stage.
- Live L8 additionally requires: L2..L7 live PASS, D4 live recovery operational,
  the device present, OV-08/OV-09/OV-12/OV-13, OV-14 / fresh K3, a same-day
  explicit `A-L8` carrying `recovery_authorization`, the exact reviewed
  firmware/NVS build, hardware identity verification, and all applicable
  S-01..S-12 clear. None of these is satisfied or simulated here.
