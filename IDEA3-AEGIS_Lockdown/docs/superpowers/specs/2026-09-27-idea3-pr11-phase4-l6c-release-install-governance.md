# IDEA3 PR11 Phase 4 L6c — Immutable Release Install Governance (repository design/implementation)

Date: 2026-09-27 (Asia/Bangkok). Owner: music. Status: repository design/implementation only. Live execution NOT authorized.

## 1. Owner decision (approved; repository design/implementation only)

```text
PRE_L7_RELEASE_INSTALL_GOVERNANCE = SEPARATE_G15_STAGE
CANONICAL_STAGE_ID   = L6c
CANONICAL_STAGE_NAME = Immutable Release Install
AUTHORIZATION        = A-L6c
K3                   = FRESH_STAGE_L6c
```

This decision authorizes repository design and implementation ONLY. It does not authorize a live L6c run. A-L7 must never
be created, consumed, or reused by L6c, and A-L6c must never be created, consumed, or reused by L7 or any other stage —
`p4-stage-gate.sh`'s `stage=` field match already enforces this structurally (proven by
`tests/test_pr11_phase4_l6c_runner.py`); no new authority is invented here.

## 2. Purpose, boundary, forbidden surfaces, success state

```text
L6C_PURPOSE = install one already-built, already-reviewed immutable Core release only

L6C_MUTATION_BOUNDARY = /opt/aegis-idea3/releases/<release-id>
                        plus only the parent directories (/opt/aegis-idea3, /opt/aegis-idea3/releases)
                        that L6c itself had to create

L6C_FORBIDDEN = /opt/aegis-idea3/current, /etc/aegis-idea3, systemd, the Core service, network, broker,
                NTP, Twingate, IDEA1, IDEA2, ESP32, L8, Production credentials

L6C_SUCCESS_STATE = one immutable root-owned guarded release installed;
                    Core not started; current symlink untouched; L7 not started
```

L6c never builds code (the builder is `p4-l7-build-release.py`, PR #208, run separately by the owner into a user-owned
staging directory), never accepts a secret, and never generates or chowns a source directory as a workaround for an
ownership check.

## 3. Registration audit (before this change)

- `L6c` did not exist anywhere in the repository (grep of scripts, docs, tests, owner-run tooling).
- `deploy/pr11-phase4/p4-lib.sh`'s `P4_STAGES` went `... L6a L6b L7 ...` with no L6c.
- The gap was already recorded: the L7 design (2026-09-21, amended 2026-09-27 §7/§8) explicitly named "an owner decision
  on the release installer" as open, and PR #208's own receipt listed "the release/venv installer" as still missing.
- No owner-run release-install workflow existed anywhere (no `run-*-owner.sh` referenced `/opt/aegis-idea3/releases`
  as a destination).
- No name collision: `L6c` was free.

## 4. G-15 observability gap and fix (Phase 2)

Before this fix, `p4-l0-capture.sh` recorded only `host.path./opt/aegis-idea3/current` and NOTHING about the release
catalog under `/opt/aegis-idea3/releases/`. A PRE→POST comparison of an L6c-style install could PASS with zero reported
drift while a whole new release tree — or a byte-level mutation of an EXISTING release — went completely unrecorded.
RED proof: `tests/test_pr11_phase4_l6c_capture_gap.py` (18 failed against the unmodified capture/compare).

Fix (GREEN, 22 passed): two new fixed, deterministic `host.path.*` presence keys (`/opt/aegis-idea3`,
`/opt/aegis-idea3/releases`), plus one new deterministic, non-secret catalog key
`host.aegis_idea3.release_catalog` = sorted, comma-joined `<release-id>:<sha256 of that release's own
RELEASE-SHA256SUMS file>` pairs (never file contents, never a credential; that file's own contract already commits to
every payload file's hash — see `p4-l7-release-guard.py`). A new, narrowly scoped, opt-in `ALLOW_L6C_RELEASE_FILE`
(mirroring `ALLOW_TRANSITIONS_FILE` / `ALLOW_DYNAMIC_TRANSITIONS_FILE`) names the ONE exact new release id a run may add.
The relational rule in `p4-compare.sh` enforces, UNCONDITIONALLY and regardless of any allow file: every release id
present in BEFORE must remain present in AFTER with an IDENTICAL fingerprint, or the change is
`NEW_OR_WORSENED_DRIFT` (`RELEASE_CONTENT_DRIFT` / `RELEASE_REMOVED`) — the allow file can only approve the addition of
the id it names (`RELEASE_UNAPPROVED_ADDITION` otherwise), never a mutation or removal.

## 5. Stage registration (Phase 3)

`P4_STAGES = "L0 L1 L2 L3 L4 L5 L6a L6b L6c L7 L8 L9"` (between L6b and L7). `p4_stage_gaps L6c = none`: L6c installs code
only — it never provisions a protocol key (G-11) or wires Core `LoadCredential=` (G-12), so neither applies, and it is not
blindly copied from L7. `p4_stage_auth_extra L6c` has no extra field: no `d6_notice` (Pub is not affected by a code
install), no `integration_review`, no `recovery_authorization`. A-L6c is a normal `AEGIS_P4_AUTHORIZATION_V1` record
(`stage=L6c`, same-day, `authorizer=music`, an exact scope, a reference) and requires a fresh K3 whose `stage=L6c`.

## 6. Handler (Phase 4)

`stages/L6c/{apply,verify,rollback}.sh` + `allow-keys.txt` (`host.path./opt/aegis-idea3`,
`host.path./opt/aegis-idea3/releases` — no wildcard) + `allow-listeners.txt` (empty). The handler calls the already-merged
`p4-l7-install-release.py` (source/staged/final ownership contract, atomic placement, symlink/overwrite refusal) and
`p4-l7-release-guard.py` (provenance) exactly — it does not duplicate their predicates. `apply.sh` journals the exact
mutation boundary before the one installer call; `verify.sh` re-proves installation via the real guard and that
`/opt/aegis-idea3/current`, the Core/L6b/predecessor units, listeners and legacy Mosquitto are all unchanged;
`rollback.sh` re-proves (via the same real guard) that the target is still exactly what was placed before removing it,
never touches a pre-existing release, and removes a parent directory only if this stage created it and it is now empty.

## 7. Owner runner (Phase 5)

`p4-l6c-run-lib.sh` + `owner-run/run-l6c-owner.sh`: unpinned template (`PIN_MAIN_SHA`, `PIN_RELEASE_ID`,
`PIN_SOURCE_SHA`), frozen outside the repository; one attempt per authorization (`L6C-ATTEMPT-CONSUMED`, distinct from
every other stage's marker); every read-only gate (receipts, persistent L6b broker health, release-source guard +
on-main proof, target-absent, disk ≥ 20% free on `/` and `/opt`, IDEA2 §10 precondition, A-L6c + fresh K3) runs before
consumption; PRE capture → apply once → verify → POST capture → strict PRE→POST with the exact L6c allow files +
`ALLOW_L6C_RELEASE_FILE` → secret scan → S10 preservation → persistent closeout; any failure after the first mutation →
exactly one bounded rollback → RB capture → zero-drift PRE→RB (no allow files) → exit 3 (S-11 HOLD) if rollback or that
proof fails; no automatic retry. It never invokes L7 apply, creates A-L7, uses L7 input, creates a credential or
`core.env`, touches `current`, installs/starts/enables the Core unit, touches an ESP32, sends a command, repairs L6b, or
restarts Twingate/modifies IDEA1/IDEA2.

## 8. Relationship to L7 (Phase 6)

`L6C_RELEASE_INSTALL = PROVEN` (once a live L6c attempt has succeeded) is a PREREQUISITE fact for L7, not an
authorization. L7's own `l7_release_gate` (`p4-l7-run-lib.sh`) independently re-runs the real release guard, read-only,
before L7 ever consumes A-L7 — it does not trust L6c's past success without re-checking. **L6c PASS does NOT authorize
L7.** After a successful L6c run: A-L6c is consumed, its K3 is consumed, and a completely NEW/fresh A-L7 and a NEW/fresh
L7 K3 are still required, Pub D6 remains an L7-only requirement, and OV-09/OV-10/OV-11 and the D4 credential remain L7-only
requirements. These records are never combined — `p4-stage-gate.sh`'s `stage=` match makes an L6c or L6b K3/authorization
structurally unusable for L7 and vice versa (`tests/test_pr11_phase4_l6c_runner.py`).

## 9. Test map

`tests/test_pr11_phase4_l6c_capture_gap.py` (G-15 capture/compare, RED 18 / GREEN 22), `l6c_support.py` +
`test_pr11_phase4_l6c_handler.py` (apply/verify/rollback against a fixture root and a fake systemctl/ss that dies on any
mutating verb), `test_pr11_phase4_l6c_runner.py` (gate library, static runner contract, G-15 authorization separation).

## 10. Current state

```text
L6C_STAGE               = IMPLEMENTED_REPOSITORY
L6C_LIVE_AUTHORIZED     = NO
L6C_LIVE_EXECUTED       = NO
A_L6C_CREATED           = NO
K3_L6C_CREATED          = NO
IMMUTABLE_RELEASE_INSTALLED_LIVE = NO
L7_LIVE_EXECUTED        = NO
A_L7_CREATED            = NO
K3_L7_CREATED           = NO
D6_ISSUED               = NO
PRODUCTION_SECRETS_CREATED = NO
L8_STARTED              = NO
```
