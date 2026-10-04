---
title: Task Receipt — IDEA3 L8p esptool interpreter pin (repository only)
date: 2026-10-04T02:10:00+07:00
owner: music
area: idea3
branch: fix/idea3-l8p-esptool-interpreter-pin
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 L8p esptool interpreter pin (repository only)

> [!important] Repository-only. IMPLEMENTED != DEPLOYED. **Nothing was executed live**: no Production mutation, no NTP change, no serial access, no ESP32 reset/flash/write, no MQTT publish, no CUT/RESTORE, no L8p Authorization/K3, no frozen LIVE runner, no attempt marker. The only host-side action was a read-only smoke of the new gate, which runs the pinned `esptool.py --help` (no serial open, no flash command).

```text
BASE_SHA=a47ad8f3fa3898604aef7d71e706ecfc42949525
ROOT_CAUSE=L8p orchestration Python was also the implicit esptool launcher Python
FIX=dedicated frozen esptool interpreter pin (ESPTOOL_PYTHON)
PRE_CONSUME_DEPENDENCY_GATE=YES
PRODUCTION_MUTATION_PERFORMED=NO
ESP32_TOUCHED=NO
SERIAL_ACCESSED=NO
FLASH_PERFORMED=NO
L8P_LIVE_EXECUTED=NO
L8P_ACCEPTANCE=NO
```

## What changed

- **Root cause:** the owner runner passed `AEGIS_PYTHON_BIN="$PY"` (`aegis-idea3-core`) to the handler, and the canonical flow launched `[sys.executable, <pinned esptool.py>, ...]`. That interpreter cannot import the pinned esptool's dependencies, so a live run would have failed after the one-shot attempt was consumed.
- **New pin:** `ESPTOOL_PYTHON=PIN_ESPTOOL_PYTHON` (19 pins; no local path committed) -> `AEGIS_L8P_ESPTOOL_PYTHON` -> `apply.sh` (`require_env` in hardware mode) -> `--esptool-python` -> `load_backend(esptool_python=...)` -> `HardwareDevice(python=...)` and `SubprocessExecutor`, built from one interpreter; a mismatch between them is refused. `AEGIS_PYTHON_BIN` is not repurposed. The L8p stage profile (`require_explicit_tool_python=True`) makes the explicit interpreter mandatory in hardware mode; L8 behaviour is unchanged.
- **Pre-consume gate:** `l8p_esptool_python_gate` (read-only, `--help` only, scrubbed environment, 60 s timeout) runs in the runner's pre-gates, before the PRE capture and the attempt marker. Failure: pre-gate FAIL, attempt not consumed, device untouched.
- **Governance preserved:** `FLASH_TOOL_SCRIPT` stays separately pinned; no PATH lookup, no fallback interpreter, no auto-install, no network, no device discovery, no retry, no erase, no CUT/RESTORE; allowlist of esptool commands unchanged.
- **Test contract note:** `test_the_runner_never_invokes_the_flash_tool_or_any_device_operation_itself` now exempts exactly the gate function, which a new test pins to `--help` only.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l8p-owner.sh` — new pin, env pass-through, pre-gate call (inert template)
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8p-run-lib.sh` — `l8p_esptool_python_gate`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L8p/apply.sh` — requires and passes the distinct interpreter
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8-device.py` — `resolve_esptool_python`, `load_backend(esptool_python=...)`, launcher consistency check, `StageProfile.require_explicit_tool_python`, `--esptool-python`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l8p-device.py` — profile flag only
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-02-idea3-pr11-phase4-l8p-device-provisioning-only.md` — nineteen pins, section 6
- Tests: new `tests/test_pr11_phase4_l8p_esptool_interpreter.py`; extended `…_l8p_owner_runner.py`, `…_l8p_provisioning.py`

## Verification evidence

- `pytest -q -p no:cacheprovider tests -k "pr11_phase4 or pr11_phase2 or firmware_contract"` — PASS, 4604 passed, 5 skipped, 0 failed, on the final tree (branch based on `origin/main` `a47ad8f3`; simulated host only, nothing live).
- `pytest tests/test_pr11_phase4_l8p_esptool_interpreter.py` — PASS, 18 passed (new). `pytest tests/test_pr11_phase4_l8p_owner_runner.py` — PASS, 139 passed (14 new gate/pin tests).
- `pytest tests/test_pr11_phase4_l8p_provisioning.py tests/test_pr11_phase4_l8_handler.py tests/test_pr11_phase4_l8_hardware_backend.py tests/test_pr11_phase4_l8_boot_verify.py tests/test_pr11_phase4_nvs_provision.py tests/test_firmware_contract.py` — PASS, 96 + 77 + 80 + 69 + 10 + 16 passed.
- `bash -n` on `run-l8p-owner.sh`, `p4-l8p-run-lib.sh`, `stages/L8p/{apply,verify,rollback}.sh` — PASS. `git diff --check` — PASS.
- Read-only smoke of `l8p_esptool_python_gate` against the real pinned `esptool.py --help` (no serial open, no flash command): FAIL under `aegis-idea3-core` (`No module named 'serial'`), PASS under `~/.venvs/aegis-esptool/bin/python` and the PlatformIO `penv` interpreter.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — PASS (0 errors; 2 pre-existing canvas warnings).
- `scripts/validate-collaboration-policy.mjs` needs a PR event payload; run locally against the PR body and changed paths before pushing.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "L8p esptool interpreter pin" section.

## Shared surfaces touched

- `None` — all code is under `IDEA3-AEGIS_Lockdown/`.

## Integration requests

- None

## Known limitations

- Simulated-host proof only; no live L8p attempt exists and none is claimed.
- The production `ESPTOOL_PYTHON` value is chosen by the owner at freeze time. Read-only smoke on this host: the gate fails under `aegis-idea3-core` (`No module named 'serial'`) and passes under `~/.venvs/aegis-esptool/bin/python` and the PlatformIO `penv` interpreter.
- A new L8p freeze must pin the then-current main and all 19 pins; any previously prepared 18-pin frozen runner is obsolete.
