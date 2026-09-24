# IDEA3 PR11 Phase 4 L7 — Core Credential Delivery / Core Start Operational Design

Date: 2026-09-21
Owner: Music (Kla reviewing)
Task: PR11 Phase 4 L7 Core Credential Delivery / Core Start Operational Design
Branch: `feat/idea3-pr11-phase4-l7-handler`
Status: OWNER DECISION INPUTS RESOLVED FOR REPOSITORY DESIGN
Scope: PR11 Phase 4 L7 repository operational design
Owner-approved decisions:
- `OD-L7-02 Production key generation policy`
- `OD-L7-08 D4 first-start policy`
Merged-authority reconciliations:
- `Phase 3 PR #149 credential delivery`
- `Admin PIN file delivery`
- `Core systemd service model`
Repository Implementation: NOT STARTED
Live L7: NOT AUTHORIZED / NOT RUN
Production Mutation: NO
Network Configuration Mutation: NO
Systemd Mutation: NO
ETC Mutation: NO
OPT Mutation: NO
ESP32 Mutation: NO

> [!IMPORTANT]
> **Repository design definition does NOT constitute live L7 authorization.**
> Merged repository behavior is not retroactively labelled as explicit owner approval unless an explicit approval record exists. Owner-approved decisions in this document authorize repository design, acceptance tests, and staging handlers using synthetic fixture credentials only. Live execution of L7 remains strictly unauthorized and gated by live predecessor PASS milestones (L2..L6b), fresh authorization (`A-L7`), fresh `K3`, Pub D6 notice, owner-supplied operational secrets (`OV-09`, `OV-10`, `OV-11`), and resolution of the IDEA2 §10 preservation caveat.

---

## 1. Canonical State & Authority Markers

```text
POST_L6A_MAIN_SHA=0ad3f4c19107ce790d4043118fc5d7387fb84d87
PR149_MERGED=YES
PR163_MERGED=YES

G11_CURRENT_STATE=PARTIAL_REPOSITORY
G12_CURRENT_STATE=CLOSED_REPOSITORY
G13_CURRENT_STATE=CLOSED_REPOSITORY

OD10_CURRENT_STATE=MERGED_AUTHORITY_RECONCILED
OD11_CURRENT_STATE=MERGED_AUTHORITY_RECONCILED
OD17_CURRENT_STATE=MERGED_INTEGRATION_COMPLETE

OD_L7_02_KEY_GENERATION_POLICY=OWNER_APPROVED
PRODUCTION_KEY_GENERATION=OWNER_CONTROLLED_OFFLINE
REPOSITORY_PRODUCTION_KEY_GENERATOR=NO
TEST_KEYS=FIXTURE_ONLY

OD_L7_08_D4_POLICY=OWNER_APPROVED
D4_FIRST_CORE_START_POLICY=REQUIRE_RESTORE_CREDENTIAL_BEFORE_START

L7_HANDLER_REGISTERED=NO
L7_IMPLEMENTATION_STARTED=NO

L7_LIVE_AUTHORIZED=NO
LIVE_L7=NOT_RUN

L2_LIVE=NOT_RUN
L3_LIVE=NOT_RUN
L4_LIVE=NOT_RUN
L5_LIVE=NOT_RUN
L6A_LIVE=NOT_RUN
L6B_LIVE=NOT_RUN

PRODUCTION_MUTATION=NO
NETWORK_CONFIGURATION_MUTATION=NO
SYSTEMD_MUTATION=NO
ETC_MUTATION=NO
OPT_MUTATION=NO
ESP32_MUTATION=NO

PHASE4_RUNTIME_COMPLETE=NO
PHASE4_LIVE_READINESS=NOT_READY
```

---

## 2. Context, History, and Scope

### 2.1 Stage Scope & Distinction
In the AEGIS Phase 4 deployment framework (`deploy/pr11-phase4/p4-lib.sh`), Stage **L7** defines the Core credential staging and Core daemon startup validation gate:
- **Preceding Stages (L2..L6b)**: Establish host firewall (`L2`), AP Wi-Fi radio (`L3`), AP IPv4 addressing & DNS (`L4`), Core NTP time serving (`L5`), isolated TLS/PKI validation (`L6a`), and the live TLS broker instance on 8883 (`L6b`).
- **Stage L7 (This Scope)**: Stages production credential material into the persistent Core host credential directory (`/etc/aegis-idea3/credentials/`), verifies credential permissions and Protocol v1 key integrity, installs and verifies the Core systemd environment (`/etc/aegis-idea3/core.env`) and unit (`aegis-idea3-core.service`), stages the immutable application release (`/opt/aegis-idea3/current`), starts the Core service, and verifies preflight success and outbound TLS connectivity to the L6b broker.
- **Subsequent Stages (L8..L9)**: Flash, provision, and join the physical ESP32 relay hardware (`L8`), and verify authenticated command roundtrips (`L9`).

### 2.2 Historical Planning vs Merged Reality
Historical Phase 4 documentation (`2026-09-17-idea3-pr11-phase4-runtime-prerequisites.md`) classified PR #149 as an open draft and listed Core credential delivery (`OD-10`), Admin PIN delivery (`OD-11`), and Phase 3 integration (`OD-17`) as open decisions.

On 2026-09-18, PR #149 was merged to `main` at commit `42b136251c5090fb56f41651b5b86da5448ad4e5`. It delivered commit `5a422ea2` ("feat(idea3): add PR11 T9 systemd credential delivery") and task receipt `2026-09-18_000451_music_idea3-pr11-phase3-t9-credentials.md`. This established the merged repository authority for systemd `LoadCredential=` injection, fail-closed credential reading, and file-based Admin PIN delivery.

### 2.3 Registration Mechanics
In `deploy/pr11-phase4/p4-lib.sh`, `P4_STAGES` already contains `L7`. The function `p4_stage_handler_status L7` evaluates to `REGISTERED` if and only if all five handler files are present:
1. `stages/L7/apply.sh`
2. `stages/L7/verify.sh`
3. `stages/L7/rollback.sh`
4. `stages/L7/allow-keys.txt`
5. `stages/L7/allow-listeners.txt`

Zero changes to `p4-lib.sh` are required to register L7.

---

## 3. Operational Decisions (OD-L7-01 through OD-L7-08)

### OD-L7-01 — Credential Source, Staging, and Custody

- **DECISION**:
  All Core runtime secrets are supplied from an owner-controlled authority host (`OV-09`, `OV-10`, `OV-11`) and staged into the persistent directory `/etc/aegis-idea3/credentials/`.
  The directory must be a regular directory (non-symlink) owned by `root:root` with exact mode `0700`.
  Credential source files (`k_c2d`, `k_d2c`, `mqtt-core.pass`, `admin.pin`, `restore.credential`) must be regular files owned by `root:root` with mode `0600`. The Core runtime credential reader accepts files when `mode & 0o077 == 0`.
- **BASIS**:
  PR #149 T9 credential contract; `IDEA3-AEGIS_Lockdown/docs/operations/production-runtime.md`; `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-18_000451_music_idea3-pr11-phase3-t9-credentials.md`.
- **OWNER_STATUS**:
  `MERGED_AUTHORITY_RECONCILED`
- **CURRENTLY_PROVEN**:
  Proven in repository by `tests/test_systemd_credentials.py` and `tests/test_systemd_config_credentials.py`.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**:
  Stage handler `apply.sh` must validate source directory and file permissions, enforce non-symlink constraints, and stage files into `/etc/aegis-idea3/credentials/` (or fixture equivalent) before service activation.
- **LIVE_PROOF_REQUIRED**:
  Live inspection of `/etc/aegis-idea3/credentials/` metadata matching `root:root 0700` directory and `0600` owner-only file permissions.
- **SECURITY_SAFETY_EFFECT**:
  Prevents unprivileged host users from reading sensitive protocol keys, MQTT credentials, and Admin PINs. Symlink rejection prevents arbitrary file read attacks through credential projection.
- **TEST_IMPLICATION**:
  Tests must assert failure when any source credential is a symlink, FIFO, directory, or has group/other read permissions (`mode & 0o077 != 0`).
- **OPEN_QUESTION**:
  None. Reconciled by merged authority.

---

### OD-L7-02 — Protocol Key Generation and Core↔ESP32 Parity

- **DECISION**:
  Production keys (`K_C2D` and `K_D2C`) are generated strictly OFFLINE on an owner-controlled authority host. The repository contains NO production key generator CLI tool.
  The repository's role is strictly to validate key format, stage keys for Core consumption, supply identical key bytes into ESP32 NVS provisioning inputs (`p4-nvs-provision.py`), and prove byte-for-byte parity using synthetic fixture keys.
  Keys must be 32 raw bytes (256 bits), represented canonically as 64 lowercase hexadecimal characters (`^[0-9a-f]{64}$`), non-zero, independent (`K_C2D != K_D2C`), and not present in `FORBIDDEN_PROTOCOL_KEYS`.
- **BASIS**:
  Owner decision approved 2026-09-21; `IDEA3-AEGIS_Lockdown/aegis_soc/protocol_v1.py`; `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-nvs-provision.py`.
- **OWNER_STATUS**:
  `OWNER_APPROVED`
- **CURRENTLY_PROVEN**:
  Both `protocol_v1.py load_protocol_keys()` and `p4-nvs-provision.py validate_protocol_keys()` independently enforce the identical 64 lowercase hex, non-zero, independent, and non-forbidden constraints.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**:
  Stage handler must accept `--c2d-key-file` and `--d2c-key-file`, validate them against canonical rules, and verify that the exact same key bytes ingested by Core match the input contract for `p4-nvs-provision.py`.
- **LIVE_PROOF_REQUIRED**:
  Proof that Core preflight accepts the owner-staged key files without error and logs no key content.
- **SECURITY_SAFETY_EFFECT**:
  Prevents repository-side key leakage, ensures cryptographic randomness by keeping generation on the owner authority host, and guarantees mutual authentication between Core and ESP32 without key collisions.
- **TEST_IMPLICATION**:
  Repository tests must use deterministic synthetic fixture keys (e.g. `012345...`) and assert rejection of: uppercase hex, length != 64, all-zero keys, identical keys (`c2d == d2c`), and well-known forbidden test keys.
- **OPEN_QUESTION**:
  None. Explicitly approved by owner.

---

### OD-L7-03 — Core Systemd LoadCredential Delivery

- **DECISION**:
  The production Core daemon consumes its runtime secrets (`k_c2d`, `k_d2c`, `mqtt-core.pass`, `admin.pin`) strictly through systemd `LoadCredential=` directives projected into `$CREDENTIALS_DIRECTORY`.
  The runtime reader (`aegis_soc/systemd_credentials.py`) resolves paths from `$CREDENTIALS_DIRECTORY`, verifying `mode & 0o077 == 0`, regular file status, non-symlink status, and non-empty content.
  Legacy inline secret environment variables (`AEGIS_MQTT_PASS`, `AEGIS_ADMIN_PIN`, `AEGIS_P1_C2D_KEY_FILE`, `AEGIS_P1_D2C_KEY_FILE`) remain stripped from `core.env.example` and are ignored in production systemd mode.
- **BASIS**:
  PR #149 merged implementation (`deploy/aegis-idea3-core.service.example`, `aegis_soc/config.py`, `aegis_soc/systemd_credentials.py`).
- **OWNER_STATUS**:
  `MERGED_AUTHORITY_RECONCILED`
- **CURRENTLY_PROVEN**:
  `tests/test_systemd_credentials.py` and `tests/test_core_service.py` pass cleanly in current `main`.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**:
  Stage verify handler must assert that the active Core service process environment does NOT contain plaintext secret variables and that `$CREDENTIALS_DIRECTORY` is populated.
- **LIVE_PROOF_REQUIRED**:
  `systemctl show aegis-idea3-core.service -p LoadCredential` confirms the 4 active credential bindings.
- **SECURITY_SAFETY_EFFECT**:
  Secrets never appear in environment variables, command-line arguments, process status listings (`/proc/<pid>/cmdline`, `/proc/<pid>/environ`), or systemd journal logs.
- **TEST_IMPLICATION**:
  Tests must verify that Python fails closed if any credential is missing, a symlink, or group/world-accessible, while accepting owner-only modes (0400 or 0600).
- **OPEN_QUESTION**:
  None. Reconciled by merged authority.

---

### OD-L7-04 — MQTT Password and Admin PIN Semantics

- **DECISION**:
  The MQTT password is read from `$CREDENTIALS_DIRECTORY/mqtt-core.pass` and passed in-memory to the MQTT client for TLS authentication to Mosquitto on port 8883.
  The Admin PIN is read from `$CREDENTIALS_DIRECTORY/admin.pin`. Production preflight strictly rejects the default PIN `"1234"` and unconfigured PINs. In-memory representation computes `ADMIN_PIN_HASH = hashlib.sha256(_ADMIN_PIN.encode("utf-8")).hexdigest()`.
  `verify_pin(candidate)` compares the SHA-256 hex digest of the candidate string against `ADMIN_PIN_HASH` using standard string equality (`==`).
  The repository makes NO claim of constant-time digest comparison, nor any claim that Python process memory has forensically erased plaintext PIN strings.
- **BASIS**:
  `IDEA3-AEGIS_Lockdown/aegis_soc/config.py`; `IDEA3-AEGIS_Lockdown/aegis_soc/runtime.py`; correction audit `C-L7-02`.
- **OWNER_STATUS**:
  `MERGED_AUTHORITY_RECONCILED`
- **CURRENTLY_PROVEN**:
  Verified by source inspection of `config.py` and `test_systemd_config_credentials.py`.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**:
  Stage handler must stage a non-default PIN file and non-empty MQTT password file, asserting failure if default PIN `"1234"` or an empty file is provided.
- **LIVE_PROOF_REQUIRED**:
  Core service starts successfully, MQTT client authenticates on port 8883, and journal contains no PIN or password strings.
- **SECURITY_SAFETY_EFFECT**:
  Prevents factory default credential exploitation. Does not overclaim memory-erasure guarantees.
- **TEST_IMPLICATION**:
  Negative test asserting preflight failure on PIN `"1234"`, empty PIN, and empty MQTT password. Tests do not assert memory scrubbing.
- **OPEN_QUESTION**:
  None. Reconciled by merged authority and correction audit.

---

### OD-L7-05 — Immutable Release + Core Start + Heartbeat/No-Actuation Boundary

- **DECISION**:
  Stage L7 starts `aegis-idea3-core.service` pointing to a reviewed, immutable release directory (`/opt/aegis-idea3/<release-id>`) referenced by the symlink `/opt/aegis-idea3/current`.
  Service execution parameters are strictly:
  ```text
  /opt/aegis-idea3/current/venv/bin/python -m aegis_soc.supervisor \
    --profile production --live --headless --no-detector --no-voice
  ```
  `AEGIS_AUTO_CONTAIN=0` is enforced via `core.env`.
  **Expected Application Network Activity**:
  Core daemon establishes an outbound TLS connection to the Mosquitto broker on AP port 8883, subscribes to `aegis/idea3/v1/<device_id>/ack` and `status`, and—if and only if `TrustedClock` reports a trusted state (`SYNCED` or bounded `HOLDOVER`)—periodically publishes authenticated `HEARTBEAT` messages every 15 seconds to topic `aegis/idea3/v1/<device_id>/heartbeat`. Heartbeat is withheld if `TrustedClock` reports `UNSYNCED` or `UNINITIALIZED`.
  **Strict No-Actuation Safety Boundary**:
  L7 strictly forbids relay actuation. Core sends ZERO `CUT_UPLINK` messages, ZERO `RESTORE_UPLINK` messages, and ZERO operator commands. No physical hardware is connected or actuated (ESP32 is not present). Network configuration is NOT mutated (`NETWORK_CONFIGURATION_MUTATION=NO`).
- **BASIS**:
  `deploy/aegis-idea3-core.service.example`; `aegis_soc/supervisor.py`; `aegis_soc/controller.py`; `aegis_soc/protocol_v1.py`; `aegis_soc/trusted_time.py`; correction audits `C-L7-05` and `C-L7-07`.
- **OWNER_STATUS**:
  `SAFETY_INVARIANT`
- **CURRENTLY_PROVEN**:
  Supervisor code review proves that initialization does not trigger commands, detector events are disabled (`--no-detector`), and heartbeats publish exclusively to the heartbeat topic when clock reports a trusted state (`SYNCED` or bounded `HOLDOVER`).
- **REPOSITORY_IMPLEMENTATION_REQUIRED**:
  Stage `verify.sh` must check: (1) service is active; (2) `status.json` reports `state != FAILED`; (3) protocol SQLite store records ZERO published command messages; (4) audit SQLite DB contains ZERO `CUT_UPLINK` or `RESTORE_UPLINK` events.
- **LIVE_PROOF_REQUIRED**:
  Journal logs verify startup, broker connection, and complete absence of containment actuation.
- **SECURITY_SAFETY_EFFECT**:
  Prevents accidental uplink disconnection or network partition during Core software deployment before hardware validation (L8).
- **TEST_IMPLICATION**:
  Test fixture must assert that Core execution in L7 produces heartbeat activity if clock reports a trusted state (`SYNCED` or bounded `HOLDOVER`), withholds heartbeat if `UNSYNCED` or `UNINITIALIZED`, and produces zero actuation records in the database.
- **OPEN_QUESTION**:
  None. Core architecture enforces this boundary.

---

### OD-L7-06 — G-15 Capture/Compare, Shared Harness Amendment, and Exact Drift Contract

- **DECISION**:
  Stage L7 drift is strictly restricted to service runtime status and explicitly captured host filesystem entries.

  **G-15 Shared Harness Amendment (Option A — Exact Narrow Host Exception)**:
  In the baseline harness, `deploy/pr11-phase4/p4-compare.sh` line 57 included `host\.` in `PROTECTED`, unconditionally rejecting any key starting with `host.` from `allow-keys.txt` (exit code 2). Because `p4-l0-capture.sh` records filesystem drift under `host.aegis_idea3.file.*` and `host.path.*`, neither L6b (`/etc/aegis-idea3/mqtt/`) nor L7 (`/etc/aegis-idea3/credentials/`, `core.env`) could be approved through `allow-keys.txt` without triggering this harness rejection.
  Under owner approval (`G15_SHARED_HARNESS_AMENDMENT=OWNER_APPROVED`), `p4-compare.sh` is amended to permit exact host keys matching:
  - `host.aegis_idea3.file.<EXACT_PATH>.<class|meta|sha256>`
  - `host.path.<EXACT_PATH>`
  - `host.symlink.<EXACT_PATH>.target`
  - `host.unit_file.<EXACT_PATH>.<class|meta|sha256>`
  while maintaining strict default-deny on all other `host.*` keys (such as `host.boot_id`, `host.identity`, `host.kernel`, `host.twingate.status`, `disk.*`). No wildcards or prefix-based approvals are permitted. This harness fix also resolves the pending G-15 unapprovability for L6b.

  **Capture Enhancements (`p4-l0-capture.sh`)**:
  1. *Release Pointer Symlink Target Capture*: `p4-lib.sh` whitelists `readlink` in `P4_RO_ALLOW`, and `p4-l0-capture.sh` records the exact symlink target of `/opt/aegis-idea3/current` under `host.symlink./opt/aegis-idea3/current.target`.
  2. *Core Unit File Capture*: `p4-l0-capture.sh` records `/etc/systemd/system/aegis-idea3-core.service` presence, metadata, and sha256 under `host.unit_file./etc/systemd/system/aegis-idea3-core.service.(class|meta|sha256)` via `rec_file`.

  **`allow-keys.txt` Contract**:
  Must contain ONLY the exact service keys recorded by `p4-l0-capture.sh` (`unit_props` in `services.tsv`) and filesystem metadata keys in `host.tsv`:
  ```text
  svc.aegis-idea3-core.service.ActiveState
  svc.aegis-idea3-core.service.SubState
  svc.aegis-idea3-core.service.MainPID
  svc.aegis-idea3-core.service.ExecMainStartTimestamp
  svc.aegis-idea3-core.service.Result
  svc.aegis-idea3-core.service.LoadState
  svc.aegis-idea3-core.service.NRestarts
  svc.aegis-idea3-core.service.UnitFileState
  host.path./opt/aegis-idea3/current
  host.path./run/aegis-idea3
  host.path./var/lib/aegis-idea3
  host.path./var/log/aegis-idea3
  host.symlink./opt/aegis-idea3/current.target
  host.unit_file./etc/systemd/system/aegis-idea3-core.service.class
  host.unit_file./etc/systemd/system/aegis-idea3-core.service.meta
  host.unit_file./etc/systemd/system/aegis-idea3-core.service.sha256
  host.aegis_idea3.file./etc/aegis-idea3/core.env.class
  host.aegis_idea3.file./etc/aegis-idea3/core.env.meta
  host.aegis_idea3.file./etc/aegis-idea3/credentials/k_c2d.class
  host.aegis_idea3.file./etc/aegis-idea3/credentials/k_c2d.meta
  host.aegis_idea3.file./etc/aegis-idea3/credentials/k_d2c.class
  host.aegis_idea3.file./etc/aegis-idea3/credentials/k_d2c.meta
  host.aegis_idea3.file./etc/aegis-idea3/credentials/mqtt-core.pass.class
  host.aegis_idea3.file./etc/aegis-idea3/credentials/mqtt-core.pass.meta
  host.aegis_idea3.file./etc/aegis-idea3/credentials/admin.pin.class
  host.aegis_idea3.file./etc/aegis-idea3/credentials/admin.pin.meta
  host.aegis_idea3.file./etc/aegis-idea3/credentials/restore.credential.class
  host.aegis_idea3.file./etc/aegis-idea3/credentials/restore.credential.meta
  ```
  **`allow-listeners.txt` Contract**:
  MUST BE EMPTY. Core opens NO TCP or UDP listening sockets.
  Wildcard allow-keys are strictly forbidden.
- **BASIS**:
  `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l0-capture.sh` lines 554, 587-596; `deploy/pr11-phase4/p4-compare.sh`; correction audit `C-L7-06`; G-15 Shared Harness Amendment (Option A).
- **OWNER_STATUS**:
  `OWNER_APPROVED`
- **CURRENTLY_PROVEN**:
  Harness gap identified and analyzed against G-15 capture logic; Option A approved by owner.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**:
  Update `p4-compare.sh` with Option A exact narrow host exception, update `p4-lib.sh` to allow `readlink`, update `p4-l0-capture.sh` with symlink target and unit file capture, and populate `stages/L7/allow-keys.txt` and `stages/L7/allow-listeners.txt`.
- **LIVE_PROOF_REQUIRED**:
  `p4-compare.sh PRE POST stages/L7/allow-keys.txt stages/L7/allow-listeners.txt` exits 0.
- **SECURITY_SAFETY_EFFECT**:
  Prevents unreviewed modifications to network listeners, firewall rules, broker instances, or system daemons from passing L7 unnoticed, while providing rigorous capture of immutable release pointers and service unit integrity.
- **TEST_IMPLICATION**:
  Compare tests must prove that:
  1. Exact allowed host keys pass compare when declared in `allow-keys.txt`.
  2. Protected host keys (`host.boot_id`, `host.identity`, etc.) continue to be rejected if present in `allow-keys.txt`.
  3. Symlink target drift and unit file changes are accurately captured and compared.
  4. L6b allow-keys pass compare without harness rejection.
- **OPEN_QUESTION**:
  None. Option A explicitly approved by owner.

---

### OD-L7-07 — Rollback / Pre-State Preservation

- **DECISION**:
  Stage L7 rollback (`stages/L7/rollback.sh`) must be idempotent and restore the PRE-L7 baseline state without damaging pre-existing files or predecessor stage configurations.
  **Prestate Capture**:
  `apply.sh` captures a pre-stage manifest recording: (1) whether `aegis-idea3-core.service` was absent, inactive, active, disabled, or enabled; (2) which credential files already existed; (3) the pre-existing target of `/opt/aegis-idea3/current`.
  **Rollback Scope**:
  - Stops `aegis-idea3-core.service`.
  - Disables the service only if L7 enabled it.
  - Removes `/etc/systemd/system/aegis-idea3-core.service` only if L7 installed it.
  - Removes staged credential files created by L7; strictly preserves pre-existing files.
  - Restores `/opt/aegis-idea3/current` symlink to previous release if L7 changed it.
  - Cleans transient runtime PID/socket files in `/run/aegis-idea3/`.
  - PRESERVES durable audit database `/var/lib/aegis-idea3/data/core-audit.sqlite3` and logs for post-incident analysis (design §14).
  - NEVER rolls back Mosquitto broker (L6b), NTP (L5), AP (L3/L4), firewall (L2), IDEA1, or IDEA2.
  - NEVER issues `RESTORE_UPLINK` or `CUT_UPLINK`.
- **BASIS**:
  `deploy/pr11-phase4/p4-lib.sh`; correction audit `C-L7-04`.
- **OWNER_STATUS**:
  `SAFETY_INVARIANT`
- **CURRENTLY_PROVEN**:
  Pattern proven across existing L2, L3, L4, L5, and L6a rollback handlers.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**:
  Implementation of prestate tracking in `apply.sh` and surgical restoration in `rollback.sh`.
- **LIVE_PROOF_REQUIRED**:
  `p4-compare.sh PRE RB` with empty allow-keys exits 0, proving zero residual drift.
- **SECURITY_SAFETY_EFFECT**:
  Guarantees that a failed Core start leaves the system cleanly recoverable without tearing down shared infrastructure.
- **TEST_IMPLICATION**:
  Rollback idempotency test (running rollback twice in succession) and PRE→RB zero-drift compare test.
- **OPEN_QUESTION**:
  None. Follows standard Phase 4 handler governance.

---

### OD-L7-08 — D4 Credential Required Before First Start

- **DECISION**:
  A valid, pre-existing local RESTORE credential (`/etc/aegis-idea3/credentials/restore.credential`) MUST be provisioned before the first start of `aegis-idea3-core.service` in Stage L7.
  If the credential file is missing, unreadable, has invalid permissions (not regular file mode `0600` owned by `aegis-idea3`), or fails scrypt format parsing, Stage L7 `apply.sh` FAILS CLOSED and does not start Core.
  This operational policy intentionally strengthens generic runtime preflight: while generic `RuntimeSettings.preflight()` treats an unconfigured `AEGIS_RESTORE_CREDENTIAL_FILE` as a warning, L7 operational deployment requires it as a mandatory prerequisite.
  L7 rollback preserves pre-existing owner-managed D4 credentials and removes only an L7-staged fixture copy.
  L7 does NOT invoke local RESTORE and does NOT actuate the relay.
- **BASIS**:
  Owner decision approved 2026-09-21 (`D4_FIRST_CORE_START_POLICY=REQUIRE_RESTORE_CREDENTIAL_BEFORE_START`); `IDEA3-AEGIS_Lockdown/aegis_soc/local_restore.py`; `IDEA3-AEGIS_Lockdown/docs/operations/production-runtime.md`.
- **OWNER_STATUS**:
  `OWNER_APPROVED`
- **CURRENTLY_PROVEN**:
  `RestoreCredential.load()` in `local_restore.py` enforces regular file, mode 0600, owner match, non-symlink (`O_NOFOLLOW`), and valid scrypt parameters (`N`, `r`, `p`, salt, digest).
- **REPOSITORY_IMPLEMENTATION_REQUIRED**:
  `apply.sh` must include an explicit check for the presence and validity of `restore.credential` prior to `systemctl start aegis-idea3-core.service`.
- **LIVE_PROOF_REQUIRED**:
  Preflight log confirms D4 local restore channel initialization on `/run/aegis-idea3/restore.sock` without warnings.
- **SECURITY_SAFETY_EFFECT**:
  Guarantees that once Core is started, an authorized operator recovery channel exists via D4 local restore before the system proceeds to physical relay CUT testing (L8/L9).
- **TEST_IMPLICATION**:
  Negative tests must assert that L7 `apply.sh` fails closed if `restore.credential` is missing, even when `core.env` is otherwise valid.
- **OPEN_QUESTION**:
  None. Explicitly approved by owner.

---

## 4. Mutation Ownership Matrix

| Path / Resource | Pre-existence Possible? | L7 May Create? | L7 May Modify? | Backup / Prestate Required? | Rollback Action | Secret Material? | Captured by L0? | Allow-Key Required? |
|---|---|---|---|---|---|---|---|---|
| `/etc/aegis-idea3/credentials/` | YES | YES | YES | Record dir metadata | Remove if L7 created | NO (dir) | YES (`host.path`) | If absent |
| `.../k_c2d` | YES | YES | NO | Record presence | Remove if L7 created | YES | YES (`meta`) | `host.aegis_idea3.file.*` |
| `.../k_d2c` | YES | YES | NO | Record presence | Remove if L7 created | YES | YES (`meta`) | `host.aegis_idea3.file.*` |
| `.../mqtt-core.pass` | YES | YES | NO | Record presence | Remove if L7 created | YES | YES (`meta`) | `host.aegis_idea3.file.*` |
| `.../admin.pin` | YES | YES | NO | Record presence | Remove if L7 created | YES | YES (`meta`) | `host.aegis_idea3.file.*` |
| `.../restore.credential` | YES | YES | NO | Record presence | Remove if L7 created | YES | YES (`meta`) | `host.aegis_idea3.file.*` |
| `/etc/aegis-idea3/core.env` | YES | YES | NO | Backup content | Remove if L7 created | NO | YES (`meta`) | `host.aegis_idea3.file.*` |
| `/etc/aegis-idea3/pki/mqtt-ca.crt` | YES | NO | NO | None | PRESERVE (L6b owned) | NO | YES (`mqtt.tsv`) | NO |
| `aegis-idea3-core.service` (unit state) | YES | YES | NO | Record unit state | Restore pre-state | NO | YES (`svc.*`) | `svc.aegis-idea3-core.service.*` |
| `/etc/systemd/system/aegis-idea3-core.service` (unit file) | YES | YES | NO | Record unit file | Remove if L7 created | NO | YES (`host.unit_file`) | `host.unit_file.*` |
| `/opt/aegis-idea3/<release>` | YES | YES | NO | Record release | PRESERVE release tree | NO | NO | NO |
| `/opt/aegis-idea3/current` | YES | YES | YES | Record symlink target| Restore symlink target | NO | YES (`host.path`, `host.symlink`) | `host.path.*`, `host.symlink.*` |
| `/run/aegis-idea3/` | YES | YES | YES | None | Clean PID/socket | NO | YES (`host.path`) | `host.path.*` |
| `/var/lib/aegis-idea3/` | YES | YES | YES | None | PRESERVE DB/data | NO | YES (`host.path`) | `host.path.*` |
| `/var/log/aegis-idea3/` | YES | YES | YES | None | PRESERVE logs | NO | YES (`host.path`) | `host.path.*` |

---

## 5. Future RED-First Test Plan (50 Verification Points)

1. **Registration**: Verify all 5 stage handler files exist under `stages/L7/` and `p4-lib.sh` reports `REGISTERED`.
2. **Shell Syntax**: Run `bash -n` across `apply.sh`, `verify.sh`, and `rollback.sh`.
3. **Stage Contract**: Verify `apply.sh` fails closed if `AEGIS_L7_INPUT_DIR` or `AEGIS_L7_WORK_DIR` is unset.
4. **Missing `k_c2d`**: Verify `apply.sh` fails closed if `k_c2d` is absent in input directory.
5. **Missing `k_d2c`**: Verify `apply.sh` fails closed if `k_d2c` is absent in input directory.
6. **Malformed Key Length**: Verify failure when key length is 31 bytes or 33 bytes (not 64 hex characters).
7. **Uppercase Hex Key**: Verify rejection of uppercase hex strings (`A-F`).
8. **Non-Hex Key**: Verify rejection of invalid characters in key strings.
9. **Zero Key**: Verify rejection of all-zero key `0000000000000000000000000000000000000000000000000000000000000000`.
10. **Forbidden Key**: Verify rejection of well-known demo or public test keys in `FORBIDDEN_PROTOCOL_KEYS`.
11. **Key Independence**: Verify rejection when `k_c2d == k_d2c`.
12. **Key Parity**: Verify that synthetic fixture keys ingested by Core match the binary CSV output of `p4-nvs-provision.py` byte-for-byte.
13. **No Repository Generator**: Assert that no `p4-key-gen.py` or production key generator exists in the repository.
14. **No Production Keys in Tests**: Assert all repository tests use synthetic fixture keys only.
15. **Symlink Secret Rejection**: Verify `apply.sh` rejects any input credential that is a symlink (`stat.S_ISLNK`).
16. **FIFO / Non-Regular Rejection**: Verify `apply.sh` rejects named pipes, sockets, or directories passed as secret files.
17. **Loose File Permission Rejection**: Verify `apply.sh` rejects credential files with mode `0644`, `0660`, etc. (`mode & 0o077 != 0`).
18. **Loose Directory Permission Rejection**: Verify rejection if `/etc/aegis-idea3/credentials/` permits group/world write.
19. **Operational Mode 0600**: Verify `apply.sh` enforces exact mode `0600` staging on secret files.
20. **Runtime Reader Regression**: Verify `aegis_soc/systemd_credentials.py` accepts owner-only modes (`0400` and `0600`) while rejecting loose bits.
21. **MQTT Password Staging**: Verify `mqtt-core.pass` is staged to mode `0600` and loaded into `config.MQTT_PASS`.
22. **Admin PIN Staging**: Verify `admin.pin` is staged to mode `0600` and loaded into `config._ADMIN_PIN`.
23. **Default Admin PIN Rejection**: Verify preflight fails if `admin.pin` contains `"1234"`.
24. **Empty PIN Rejection**: Verify preflight fails if `admin.pin` is empty.
25. **Memory Claim Audit**: Verify test asserts Admin PIN SHA-256 digest comparison without asserting memory erasure.
26. **D4 Credential Required**: Verify `apply.sh` fails closed if `restore.credential` is missing.
27. **D4 Preflight Warning vs L7 Policy**: Verify that while runtime preflight warns on missing D4, L7 `apply.sh` aborts execution.
28. **Invalid D4 Credential**: Verify `apply.sh` fails closed if `restore.credential` contains invalid scrypt parameters or bad salt/digest.
29. **Zero Actuation on Apply**: Verify `apply.sh` causes zero relay commands (`CUT_UPLINK` / `RESTORE_UPLINK`).
30. **Zero Actuation on Verify**: Verify `verify.sh` asserts zero relay actuation records in SQLite store.
31. **No Operator Command Triggered**: Verify no external actuation or lockdown trigger is invoked.
32. **Heartbeat Topic Separation**: Verify `HEARTBEAT` publishes to `.../heartbeat` and not `.../command`.
33. **Heartbeat Trusted Time Gate**: Verify heartbeat publishes under `SYNCED` or bounded `HOLDOVER`, and is withheld if `TrustedClock` is `UNSYNCED` or `UNINITIALIZED`.
34. **No Unexpected Listeners**: Verify `ss -ltnu` records zero new listening sockets after Core start.
35. **Allow-Listeners Empty**: Verify `stages/L7/allow-listeners.txt` has zero active entries.
36. **Exact Service State Drift**: Verify compare output matches `svc.aegis-idea3-core.service.*` keys in `allow-keys.txt`.
37. **Exact Filesystem Drift**: Verify compare output matches `host.aegis_idea3.file.*`, `host.path.*`, `host.symlink.*`, and `host.unit_file.*` keys in `allow-keys.txt`.
38. **No Wildcard Allow Keys & Strict Deny on Protected Host Keys**: Verify neither `allow-keys.txt` nor `allow-listeners.txt` contains wildcard patterns (`*`), and verify `p4-compare.sh` strictly rejects protected host keys (`host.boot_id`, `host.identity`, `host.kernel`, `host.twingate.status`, `disk.*`).
39. **Pre-Existing Service State Preservation**: Verify that if service was pre-existing and active/enabled, rollback does not disable/remove it.
40. **Pre-Existing Credential Preservation**: Verify rollback preserves credentials that existed prior to L7 apply.
41. **New Credential Cleanup**: Verify rollback unlinks only files staged by L7.
42. **Release Symlink Rollback**: Verify rollback restores `/opt/aegis-idea3/current` if updated by L7.
43. **Rollback Idempotency**: Verify executing `rollback.sh` twice exits cleanly with code 0.
44. **Predecessor & Sibling Preservation**: Verify rollback leaves Mosquitto (L6b), NTP (L5), AP (L3/L4), firewall (L2), IDEA1, and IDEA2 untouched.
45. **PRE→POST and PRE→RB Compare**: Run `p4-compare.sh` proving PRE→POST matches allow-keys and PRE→RB produces zero drift.
46. **G-15 Shared Harness Exception**: Verify `p4-compare.sh` accepts exact `host.aegis_idea3.file.*`, `host.path.*`, `host.symlink.*`, and `host.unit_file.*` keys while rejecting any other `host.*` key.
47. **G-15 Symlink Target Capture**: Verify `p4-l0-capture.sh` captures exact symlink target of `/opt/aegis-idea3/current` into `host.symlink./opt/aegis-idea3/current.target`.
48. **G-15 Core Unit File Capture**: Verify `p4-l0-capture.sh` captures `/etc/systemd/system/aegis-idea3-core.service` presence, metadata, and sha256 into `host.unit_file.*`.
49. **L6b G-15 Regression Freedom**: Verify L6b host files under `/etc/aegis-idea3/mqtt/` pass compare without G-15 harness rejection.
50. **PRE→RB Zero Residual Drift**: Verify `p4-compare.sh PRE RB` with empty allow-keys exits 0 with zero residual drift while preserving durable audit DB `/var/lib/aegis-idea3/data/core-audit.sqlite3`.

---

## 6. Live L7 Prerequisites (Future Execution Boundary)

Live execution of Stage L7 is NOT authorized by this document and requires all of the following conditions to be satisfied:
1. **Live Predecessor PASS**: Authoritative evidence of passing live runs for `L2`, `L3`, `L4`, `L5`, `L6a`, and `L6b` recorded in canonical receipts.
2. **Fresh Same-Day Authorization (`A-L7`)**: Formal authorization from Music (Kla reviewing).
3. **Pub / D6 Notice**: Advance operational notice delivered to IDEA2 lead (`pubpup2006p-design`).
4. **Fresh `K3` Token**: Valid same-day change token with zero overlap against other ongoing work.
5. **Phase 3 Release Deployment**: Built, reviewed release package installed at `/opt/aegis-idea3/<release-id>` with `aegis-idea3:aegis-idea3` ownership.
6. **Owner-Supplied Operational Values**:
   - `OV-09`: `K_C2D` and `K_D2C` secrets generated on an owner-controlled authority host.
   - `OV-10`: Credential file locations and permissions confirmed (`root:root 0700` dir, `0600` files).
   - `OV-11`: Non-default Admin PIN secret.
   - Valid owner-controlled D4 RESTORE credential generated interactively.
7. **IDEA2 §10 Preservation**: Detection Engine and edge tunnel health check passes, or owner accepts a written, narrowed preservation criterion.
8. **Clear Stop Conditions**: All standard safety stop conditions `S-01` through `S-12` verified clear.
9. **Disk Headroom**: Minimum 20% available storage headroom on `/`, `/var`, and `/opt`.


## Amendment A1 (candidate — pending reviewer approval): release guard and credential ownership

Found while auditing the repository for the missing release/venv installer (no repository script builds `/opt/aegis-idea3/releases/<id>` or its `venv`; L7 only points `current` at it).

1. **Release prerequisite is enforced, not assumed.** `apply.sh` proves, before staging anything, that `/opt/aegis-idea3/releases/<id>` exists (single path component, not a symlink), contains an executable `venv/bin/python` and `aegis_soc/supervisor.py`, is owned by `root` (`AEGIS_L7_RELEASE_OWNER`) and is not group/world-writable; a pre-existing dangling `current` fails closed; `verify.sh` re-proves the link target and the unit `ExecStart`. Section 6 item 5 ("`aegis-idea3:aegis-idea3` ownership") is corrected to **root-owned**: `deploy/network/aegis-idea3-containment.service.example` runs this tree as root and states it must not be writable by `aegis-idea3`.
2. **D4 credential contract.** `RestoreCredential.load()` requires a regular file, exact mode 0600, owned by the Core account (`local_restore.py`), and `supervisor.py`/`runtime.py` read it directly (not via `LoadCredential=`). OV-10's `root:root 0700` directory therefore made the Core fail preflight (`D4 Core-local RESTORE credential is unsafe`). Corrected: directory `root:aegis-idea3` 0750; `restore.credential` `aegis-idea3:aegis-idea3` 0600; the other four secrets stay root 0600 (delivered by `LoadCredential=`). Apply validates the credential *format* with `RestoreCredential.parse`, not `load`.
3. **Start failures are explicit.** `systemctl start` failure and a crash loop (`NRestarts != 0` after 3 s) fail with `L7_SERVICE_START_FAILED` / `L7_SERVICE_NOT_STABLE`; verify re-checks `NRestarts`.
