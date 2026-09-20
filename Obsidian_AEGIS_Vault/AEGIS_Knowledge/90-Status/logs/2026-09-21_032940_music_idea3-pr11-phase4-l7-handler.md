---
title: Task Receipt — IDEA3 PR11 Phase 4 L7 Core credential delivery and service startup runtime handler
date: 2026-09-21T03:29:40+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-phase4-l7-handler
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L7 Core credential delivery and service startup runtime handler

## What changed

- Registered the reviewed L7 stage handler (`stages/L7/`) under the G-15 handler framework (`apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, `allow-listeners.txt`) for Core credential delivery, release staging, and service startup per approved operational design OD-L7-01 through OD-L7-08.
- Owner-supplied Production credentials: `k_c2d`, `k_d2c`, `mqtt-core.pass`, `admin.pin`, and `restore.credential` are ingested strictly from an owner-provided private directory (`AEGIS_L7_INPUT_DIR`, mode 0600 or 0400, regular files only, no symlinks permitted).
- Zero Production key generator in repository (OD-L7-02): production keys are generated owner-controlled offline. The repository contains only synthetic test fixtures and protocol validators proving byte-for-byte ESP32 parity (`p4-nvs-provision.py`).
- D4 local restore credential prerequisite (OD-L7-08): `restore.credential` must be present in the input directory and pass cryptographic format validation before the first Core service start is permitted.
- Host staging & permissions: stages `/etc/aegis-idea3/credentials/` (directory mode 0700, secret files mode 0600), `/etc/aegis-idea3/core.env` (mode 0600), `/etc/systemd/system/aegis-idea3-core.service` (mode 0644), and immutable release pointer `/opt/aegis-idea3/current` symlink.
- Shared G-15 capture & compare amendment: implements Option A narrow exact host-file exception (`^host\.(aegis_idea3\.file\.|path\.|symlink\.|unit_file\.)`) permitting approved stage file changes while maintaining default-deny on host identity, kernel, boot ID, and twingate; captures `/opt/aegis-idea3/current` symlink target and `/etc/systemd/system/aegis-idea3-core.service` unit content sha256/metadata.
- L6b regression compatibility: L6b `allow-keys.txt` is validated regression-free under the Option A amendment.
- Listener contract: `allow-listeners.txt` has zero active entries (`L7_ALLOW_LISTENERS_EMPTY = YES`). Core daemon opens no listening sockets.
- Safety & boundary verification: zero relay actuation (`CUT_UPLINK`, `RESTORE_UPLINK`) in `core-audit.sqlite3`. Fails closed if audit SQLite DB is corrupt or unreadable.
- Rollback: `stages/L7/rollback.sh` is idempotent. Restores pre-state captured in `prestate.manifest` (unit file, core.env, credentials, symlink). Strictly preserves durable SQLite databases (`/var/lib/aegis-idea3/data/core-audit.sqlite3`) and logs.
- Hardening fixes applied:
  1. `verify.sh` SQLite audit-DB query previously caught general `Exception` and printed `0` (failing open on corrupt DB); hardened to fail closed with error code 2.
  2. `apply.sh` Python script snippets previously interpolated shell variables; hardened to pass paths safely through `sys.argv`.
- Provenance: `RED_FIRST_PROVEN = YES`. Retained RED evidence showed 28 expected failed (4 G-15 host artifacts, 24 L7 handler) before implementation existed.

Approved design authority:
- Commit: `f00230e69eb3be310829b98b4b1b11a2b780a68a`
- Subject: `docs(idea3): define PR11 Phase4 L7 operational design`

Design correction commit:
- Commit: `25011eb957022d83a0313a0764b0c460d045610b`
- Subject: `docs(idea3): correct PR11 Phase4 L7 G15 design`

RED test contract commit:
- Commit: `6aea64c6b0b9997452b6879ea43c4f4bcbc50324`
- Subject: `test(idea3): define PR11 Phase4 L7 red contract`

GREEN implementation commit:
- Commit: `2741ea3fd5a7a760cf0c39f0ca5ea8536f9810a9`
- Subject: `feat(idea3): add PR11 Phase4 L7 runtime handler`

Hardening commit:
- Commit: `77c930957489056529d28870abaf1ba8041290ca`
- Subject: `fix(idea3): harden PR11 Phase4 L7 contract`

Closeout files created/updated in this session:
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-21_032940_music_idea3-pr11-phase4-l7-handler.md` (this receipt)

```text
L2_HANDLER                   = REGISTERED
L3_HANDLER                   = REGISTERED
L4_HANDLER                   = REGISTERED
L5_HANDLER                   = REGISTERED
L6A_HANDLER                  = REGISTERED
L6B_HANDLER                  = REGISTERED
L7_HANDLER                   = REGISTERED

L2                           = NOT RUN
L3                           = NOT RUN
L4                           = NOT RUN
L5                           = NOT RUN
L6A                          = NOT RUN
L6B                          = NOT RUN
L7                           = NOT RUN

PRODUCTION_MUTATION          = NO
NETWORK_MUTATION             = NO
SYSTEMD_MUTATION             = NO
ETC_MUTATION                 = NO
OPT_MUTATION                 = NO
ESP32_MUTATION               = NO
L7_LIVE_AUTHORIZED           = NO
LIVE_L7                      = NOT RUN
ZERO_ACTUATION_CONTRACT      = PASS
LIVE_ZERO_ACTUATION_PROVEN   = NO
RED_FIRST_PROVEN             = YES
PHASE4_RUNTIME_COMPLETE      = NO
PHASE4_LIVE_READINESS        = NOT READY
```

## Source files changed

Task history commits:
- `f00230e69eb3be310829b98b4b1b11a2b780a68a` — `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md` (operational design candidate).
- `25011eb957022d83a0313a0764b0c460d045610b` — `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md` (G-15 shared harness amendment and design corrections).
- `6aea64c6b0b9997452b6879ea43c4f4bcbc50324` — RED test contract suites:
  - `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_g15_host_artifacts.py`
  - `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_handler.py`
- `2741ea3fd5a7a760cf0c39f0ca5ea8536f9810a9` — GREEN implementation:
  - `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` (Option A exact narrow host exception)
  - `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` (release symlink and Core unit file capture)
  - `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` (readlink allowlist and FS_ROOT fallback)
  - `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/allow-keys.txt` (28 approved drift keys)
  - `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/allow-listeners.txt` (empty allowlist)
  - `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/apply.sh` (credential staging & service runner)
  - `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/rollback.sh` (idempotent prestate rollback)
  - `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/verify.sh` (actuation, credential, and listener verifier)
  - `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` (stage registration harness update)
- `77c930957489056529d28870abaf1ba8041290ca` — contract hardening:
  - `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/apply.sh` (sys.argv argument safety)
  - `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/verify.sh` (fail-closed SQLite query check)
  - `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l7_handler.py` (corrupt audit-DB & actuation detection regression tests)

Closeout documentation files:
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — updated handler registration table and added L7 handler specification.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — recorded canonical L7 handler registration facts, test evidence, and safety boundaries.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-21_032940_music_idea3-pr11-phase4-l7-handler.md` — this immutable task receipt.

## Verification evidence

- G-15 focused pytest (`test_pr11_phase4_g15_host_artifacts.py`): 6 passed, 0 failed.
- L7 focused pytest (`test_pr11_phase4_l7_handler.py`): 28 passed, 0 failed.
- Phase 4 harness pytest (`test_pr11_phase4_harness.py`): 160 passed, 0 failed.
- All Phase 4 test suite (`test_pr11_phase4_*.py`): 465 passed, 0 failed, 0 skipped, 0 xfail.
- Relevant Core regression test suite: 548 passed, 0 failed.
- Bash syntax validation (`bash -n` on `p4-lib.sh`, `p4-l0-capture.sh`, `p4-compare.sh`, `apply.sh`, `verify.sh`, `rollback.sh`): PASS.
- Diff check (`git diff --check origin/main...HEAD`): PASS.
- Anti-test-weakening audit: PASS.
- Static security audit: PASS.
- Rollback idempotency audit: PASS.
- Zero-actuation repository contract audit: PASS.
- Evidence preservation audit: PASS.
- Registration matrix:
  - `L2   REGISTERED`
  - `L3   REGISTERED`
  - `L4   REGISTERED`
  - `L5   REGISTERED`
  - `L6a  REGISTERED`
  - `L6b  REGISTERED`
  - `L7   REGISTERED`

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — records repository-only L7 handler registration, test results, verification evidence, unchanged live boundaries, and the open IDEA2 preservation caveat.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — updates stage rollback handlers summary to `L2, L3, L4, L5, L6a, L6b, L7 REGISTERED` and adds the L7 handler scope/boundary documentation.

## Shared surfaces touched

The collaboration policy classifies the following changed paths as cross-scope surfaces requiring integration review:

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — shared compare harness (Option A narrow host exception).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` — shared capture harness (release pointer & unit file capture).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-lib.sh` — shared stage definition table and readlink allowlist.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — shared deployment and registration contract documentation.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_harness.py` — shared test harness registration expectation.
- L6b G15 compatibility/regression surface — verified regression-free under amended compare logic.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — canonical module status note.

Cross-area behavior:
- Legacy Mosquitto service (`mosquitto.service`) mutation = NO
- L6b production service mutation = NO
- IDEA1 mutation = NO
- IDEA2 mutation = NO

## Integration requests

- Human code-owner review required (`kraveerachat` / Kla integration review).
- Human merge required.
- `L7_PR_OPENED = NO`: Draft PR has not been opened yet by this documentation checkpoint.
- This receipt does not authorize live L7.
- Future live L7 remains separately gated by:
  - L2, L3, L4, L5, L6a, and L6b live PASS;
  - fresh same-day A-L7 authorization;
  - fresh K3 key;
  - resolution or formally accepted reconciliation of the open IDEA2 §10 caveat;
  - all standard stop conditions.

## Known limitations

- `LIVE_L7 = NOT_RUN`: L7 is repository-registered only.
- Predecessor live stages remain NOT RUN (L2, L3, L4, L5, L6a, L6b live PASS not proven).
- IDEA2 §10 preservation blocker remains open and blocking for all live mutating stages.
- Repository fixture parity is not live ESP32 parity.
- Repository zero-actuation proof is not physical hardware proof (`LIVE_ZERO_ACTUATION_PROVEN = NO`).
- L8 remains responsible for actual ESP32 provisioning.
- Production keys must be generated owner-controlled offline (`PRODUCTION_KEY_GENERATOR = NONE` in repository).
- Phase 4 runtime remains incomplete and not ready (`PHASE4_RUNTIME_COMPLETE = NO`, `PHASE4_LIVE_READINESS = NOT READY`).
- Live L7 requires fresh A-L7 + fresh K3 and all authoritative prerequisites.
- No Production credentials or private keys were used; synthetic fixture credentials only.
