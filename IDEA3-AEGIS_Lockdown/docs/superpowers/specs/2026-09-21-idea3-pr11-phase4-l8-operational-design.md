# IDEA3 PR11 Phase 4 L8 — ESP32 Inspection / NVS Provisioning / Flash Operational Design

Date: 2026-09-21
Owner: Music (Kla reviewing)
Task: PR11 Phase 4 L8 ESP32 inspection, NVS provisioning, and firmware flash operational design
Branch: `feat/idea3-pr11-phase4-l8-handler`
Status: REPOSITORY DESIGN AND IMPLEMENTATION COMPLETE — LIVE L8 NOT AUTHORIZED
Scope: PR11 Phase 4 L8 repository operational design
Owner-approved decisions:
- `OD-14 L8 recovery policy` (`D4_ONLY`, interim recovery NOT approved)
- `G-15 hardware evidence model` (`STAGE_LOCAL_PRIVATE_JSON_BUNDLE`, `WRITE_ONCE_NO_OVERWRITE`)
- `L8 inspection classification` (`NON_WRITING_BUT_DEVICE_RESETTING`)
- `Production key generation policy` (`OWNER_CONTROLLED_OFFLINE`, carried from OD-L7-02)
Merged-authority reconciliations:
- `G-16` firmware non-blocking Wi-Fi join (`CLOSED_REPOSITORY`)
- `G-11` NVS provisioning tool (`PARTIAL_REPOSITORY`, `p4-nvs-provision.py` render-only)
- `G-04` static addressing (`NOT_APPLICABLE_UNDER_SELECTED_ADDRESS_MODEL`; address model is DHCP)
Repository Implementation: COMPLETE (fixture backend only)
Live L8: NOT AUTHORIZED / NOT RUN
Production Mutation: NO
ESP32 Mutation: NO
Serial Port Opened: NO
Firmware Flashed: NO

> [!IMPORTANT]
> **Repository design definition does NOT constitute live L8 authorization.**
> Every decision below authorizes repository design, acceptance tests, and a
> stage handler exercised against **fixture/mock hardware only**. No decision
> here authorizes opening a real serial device, resetting a real ESP32, writing
> real NVS, flashing firmware, erasing flash, burning eFuse, or actuating the
> relay. `LIVE_L8_PHYSICAL_PROOF_REQUIRED=YES` and that proof does not exist.

---

## 1. Canonical State & Authority Markers

```text
POST_L7_MAIN_SHA=0544f1cc620b82482cdc9dcc474bed7a66ba6ead
PR164_MERGED=YES

L2_HANDLER=REGISTERED
L3_HANDLER=REGISTERED
L4_HANDLER=REGISTERED
L5_HANDLER=REGISTERED
L6A_HANDLER=REGISTERED
L6B_HANDLER=REGISTERED
L7_HANDLER=REGISTERED
L8_HANDLER=REGISTERED

L8_INVENTORY_COMPLETE=YES
G04_CURRENT_STATE=NOT_APPLICABLE_UNDER_SELECTED_ADDRESS_MODEL
ESP32_ADDRESS_MODEL_CURRENT=DHCP
G11_CURRENT_STATE=PARTIAL_REPOSITORY
G16_CURRENT_STATE=CLOSED_REPOSITORY

OD14_L8_RECOVERY_POLICY=D4_ONLY
INTERIM_RECOVERY_PROCEDURE=NOT_APPROVED
D4_LIVE_REQUIRED_BEFORE_L8_FLASH=YES

L8_INSPECTION_CLASS=NON_WRITING_BUT_DEVICE_RESETTING
L8_INSPECTION_REQUIRES_MAINTENANCE_WINDOW=YES

PRODUCTION_KEY_GENERATION=OWNER_CONTROLLED_OFFLINE
REPOSITORY_PRODUCTION_KEY_GENERATOR=NO
TEST_KEYS=FIXTURE_ONLY

NVS_NAMESPACE=aegis-p1
NVS_SCHEMA=1
PLATFORMIO_ENV=esp32dev
PLATFORM=espressif32@7.0.1
FRAMEWORK=arduino
MQTT_TLS_PORT=8883
RELAY_GPIO=27
RELAY_TRIGGER=LOW
RELAY_RELEASE=HIGH
DEADMAN_SECONDS=60
BOOT_GRACE_SECONDS=90

L2_LIVE=NOT_RUN
L3_LIVE=NOT_RUN
L4_LIVE=NOT_RUN
L5_LIVE=NOT_RUN
L6A_LIVE=NOT_RUN
L6B_LIVE=NOT_RUN
L7_LIVE=NOT_RUN
L8_LIVE=NOT_RUN

L7_LIVE_AUTHORIZED=NO
L8_LIVE_AUTHORIZED=NO
PRODUCTION_MUTATION=NO
ESP32_MUTATION=NO
PHASE4_RUNTIME_COMPLETE=NO
PHASE4_LIVE_READINESS=NOT_READY
```

---

## 2. Reconciliation of the Previous L8 Design Candidate

There is **no standalone prior L8 design document** in the repository. The
previous L8 design candidate exists only as scattered planning material, and
this section reconciles each fragment against the current owner decisions.

| Prior fragment | Source | Current owner decision | Reconciled outcome |
|---|---|---|---|
| "G-04 (if static)" precondition | `2026-09-17-…-runtime-prerequisites.md` §L8, G-04 row | Address model is DHCP | G-04 is `NOT_APPLICABLE_UNDER_SELECTED_ADDRESS_MODEL`. The static branch is dropped from L8 scope; the design instead **asserts the absence** of static-address behaviour (OD-L8-02). |
| "D4 live **or a separately authorized interim recovery**" | `…-runtime-prerequisites.md` §L8 preconditions | OD-14: `INTERIM_RECOVERY_PROCEDURE=NOT_APPROVED` | The interim-recovery alternative is **removed**. Recovery is D4 only, and D4 live is required before any L8 flash (OD-L8-08). |
| "G-16 decision merged" precondition | `…-runtime-prerequisites.md` G-16 row (`decide before L8`) | `G16_CURRENT_STATE=CLOSED_REPOSITORY` | Satisfied in repository by `tests/test_firmware_contract.py::test_firmware_wifi_join_is_non_blocking_and_fail_secure`. Recorded as closed, not re-litigated. |
| G-09 IP-literal SAN concern | `…-runtime-prerequisites.md` G-09 row | Broker host is the DNS name `mqtt.aegis.home.arpa` in `p4-nvs-provision.py` | The IP-literal branch is not selected, so G-09 is not an L8 blocker. The design asserts the broker field is a DNS name (OD-L8-03). |
| L8 treated as "passive inspection" | `…-runtime-prerequisites.md` §L8 heading | `L8_INSPECTION_CLASS=NON_WRITING_BUT_DEVICE_RESETTING` | "Passive" is **withdrawn**. Inspection is non-writing but device-resetting and requires a maintenance window (OD-L8-05). |
| T8 "provisioning tool skeleton may be repository-ready" | `…-runtime-prerequisites.md` §T8 | `G11_CURRENT_STATE=PARTIAL_REPOSITORY` | `p4-nvs-provision.py` is render-only. L8 adds the **artifact + verification contract** around it, and still adds no Production write tool, no Production readback verifier, and no Production mutation (OD-L8-03, OD-L8-07). |
| Hardware evidence model unspecified | — | `STAGE_LOCAL_PRIVATE_JSON_BUNDLE`, `WRITE_ONCE_NO_OVERWRITE`, exact field allowlist | Fully specified in OD-L8-09. |

---

## 3. Stage Scope and Registration Mechanics

### 3.1 Stage scope

- **Preceding stages (L2..L7)** establish the host firewall, AP radio, AP
  addressing/DNS, Core-local NTP, isolated TLS/PKI validation, the live TLS
  broker on 8883, and Core credential staging plus Core service start.
- **Stage L8 (this scope)** binds the physical ESP32 to its OV-12 identity,
  renders and materialises the NVS provisioning artifact for namespace
  `aegis-p1` schema 1, produces a compile-only firmware artifact with a recorded
  SHA-256, writes NVS and firmware to the device, verifies the write by private
  readback, verifies boot, and records a stage-local private hardware-evidence
  bundle. **After the flash the relay holds its boot CUT output** until a D4
  RESTORE.
- **Stage L9** verifies authenticated command roundtrips without actuation and
  is out of scope here.

### 3.2 Registration mechanics

`deploy/pr11-phase4/p4-lib.sh` already contains `L8` in `P4_STAGES`, already
reports `p4_stage_gaps L8` as `G-04,G-11,G-16`, and already requires the extra
same-day authorization field `recovery_authorization` via
`p4_stage_auth_extra L8`. `p4_stage_handler_status L8` becomes `REGISTERED`
when, and only when, all five files exist:

1. `stages/L8/apply.sh`
2. `stages/L8/verify.sh`
3. `stages/L8/rollback.sh`
4. `stages/L8/allow-keys.txt`
5. `stages/L8/allow-listeners.txt`

**Zero changes to `p4-lib.sh` are required to register L8.**

### 3.3 Host drift contract

L8 mutates the **ESP32 device**, not the Core host. Therefore
`stages/L8/allow-keys.txt` carries **zero active keys** (the L6a precedent) and
`stages/L8/allow-listeners.txt` carries zero active entries. This is the
mechanism that enforces the owner requirement `HOST_PRE_TO_RB_ZERO_DRIFT=YES`:
a PRE→POST or PRE→RB comparison with an empty allow-list fails on **any** Core
host drift whatsoever.

---

## 4. Operational Decisions (OD-L8-01 … OD-L8-09)

### OD-L8-01 — Device identity and OV-12 binding

- **DECISION**:
  `apply.sh` requires an owner-supplied OV-12 binding record
  `device.identity` inside `AEGIS_L8_INPUT_DIR`, a regular non-symlink file of
  mode `0600` or `0400`, containing exactly `expected_mac=` (lowercase,
  colon-separated, six octets) and `serial_port=` (an absolute path matching
  `/dev/ttyUSB<N>` or `/dev/ttyACM<N>`). The backend reports an observed MAC and
  chip identity; if the observed MAC does not equal `expected_mac`, the stage
  fails **before any device write is attempted**. Backend selection is explicit:
  `AEGIS_L8_BACKEND=fixture` (default) or `hardware`.
- **BASIS**:
  `…-runtime-prerequisites.md` OV-12 row and §L8 "Stop if the serial identity or
  MAC does not match OV-12"; OV-08 `device_id` pattern.
- **OWNER_STATUS**: `OWNER_APPROVED` (OV-12 is an owner-supplied value in the
  merged prerequisites table).
- **CURRENTLY_PROVEN**: Nothing. No device is present (E-08) and no OV-12 value
  has been supplied. Repository proof will be fixture-only.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Binding parse and strict validation;
  MAC-equality gate ordered ahead of every write step; fixture backend that
  resolves identity from a fixture descriptor and never opens a serial device.
- **LIVE_PROOF_REQUIRED**: Observed MAC of the real device equals the
  owner-supplied OV-12 MAC, read inside an authorized maintenance window.
- **SECURITY_SAFETY_EFFECT**: Prevents provisioning secrets and protocol keys
  into the wrong physical device.
- **TEST_IMPLICATION**: Tests for malformed MAC, wrong-case MAC, MAC mismatch
  (must fail before write), non-serial `serial_port`, and loose binding-file
  permissions.
- **OPEN_QUESTION**: The actual OV-12 MAC and serial port are not supplied; live
  binding cannot be exercised.

### OD-L8-02 — DHCP and network prerequisites

- **DECISION**:
  The selected ESP32 address model is **DHCP**. L8 therefore neither configures
  nor asserts a static address. The design instead enforces the **absence** of
  static addressing: the firmware source must contain no `WiFi.config` call, and
  the NVS field set must contain no address field (`ip`, `gw`, `mask`, `dns`,
  `netmask`, `gateway`, `static`). G-04 is closed as
  `NOT_APPLICABLE_UNDER_SELECTED_ADDRESS_MODEL`.
- **BASIS**:
  `…-runtime-prerequisites.md` G-04 row; current
  `deploy/pr11-phase4/p4-nvs-provision.py` `NVS_KEYS`; current
  `firmware/src/main.cpp`.
- **OWNER_STATUS**: `OWNER_APPROVED` (address model supplied as
  `ESP32_ADDRESS_MODEL_CURRENT=DHCP`).
- **CURRENTLY_PROVEN**: Repository-provable — `NVS_KEYS` holds exactly the
  eleven approved fields and none is an address field.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Assertions in the stage handler and
  tests that the NVS field set is exactly the eleven approved keys and that the
  firmware contains no `WiFi.config`.
- **LIVE_PROOF_REQUIRED**: The device obtains a DHCP lease from the L4 AP and
  reaches the broker — NOT PROVEN, and not provable in the repository.
- **SECURITY_SAFETY_EFFECT**: Removes a silent divergence between a static
  design branch and DHCP reality, and blocks address fields from entering the
  provisioning schema.
- **TEST_IMPLICATION**: Negative test that an address field added to the NVS
  schema is rejected.
- **OPEN_QUESTION**: None for the repository scope.

### OD-L8-03 — NVS schema and credential provisioning

- **DECISION**:
  Provisioning material is rendered **only** by the existing
  `deploy/pr11-phase4/p4-nvs-provision.py` `render` subcommand: namespace
  `aegis-p1`, schema `1`, exactly the eleven fields `schema`, `device_id`,
  `wifi_ssid`, `wifi_psk`, `broker`, `mqtt_user`, `mqtt_pass`, `ntp`, `k_c2d`,
  `k_d2c`, `seq_hi`. Every secret enters by owner-supplied file path with
  owner-only permission bits. The rendered CSV is secret-bearing: mode `0600`,
  created `O_EXCL | O_NOFOLLOW`, never overwritten, and never logged.
  The binary NVS partition artifact is produced by an **owner-supplied external
  generator** named by `AEGIS_L8_NVS_PARTITION_GEN`; the repository vendors no
  generator and fails closed when the variable is unset or the target is not
  executable. **The repository adds no Production key generator, no Production
  write tool, and no Production readback verifier.**
  The **geometry of every partition L8 writes** — the `nvs` entry and the
  application entry alike — is derived from the partition table of the exact
  reviewed build, supplied by `AEGIS_L8_PARTITION_TABLE`. There is **no
  default and no fallback anywhere in this path**, and in particular no
  hardcoded `0x9000` NVS offset and no hardcoded `0x10000` application offset:
  an absent, unparseable, or non-matching table fails closed. Deriving only the
  NVS offset while guessing the others would defeat the reason the rule
  exists, so the same rule covers both.
- **BASIS**:
  G-11 row (`PARTIAL_REPOSITORY`); OD-L7-02 key-generation policy; OV-09
  (`K_C2D`/`K_D2C` generated once on an owner-controlled host);
  `p4-nvs-provision.py` as merged.
- **OWNER_STATUS**: `OWNER_APPROVED` for the key-generation policy and the
  render-only capability; `REPOSITORY_DESIGN` for the artifact/offset contract.
- **CURRENTLY_PROVEN**: Render-only behaviour, key validation, demo/test-key
  rejection, and 0600/O_EXCL output are proven by
  `tests/test_pr11_phase4_nvs_provision.py`. Offset derivation is **not** proven
  — `firmware/` contains no partition table CSV, so no offset is derivable
  today.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Partition-table parsing with
  fail-closed behaviour; generator invocation contract; artifact permission and
  no-overwrite enforcement; forbidden-field assertions.
- **LIVE_PROOF_REQUIRED**: The generated partition image written at the derived
  offset is accepted by the real device.
- **SECURITY_SAFETY_EFFECT**: Keeps Production key generation offline and
  owner-controlled; prevents a wrong-offset write from corrupting an unrelated
  flash region; prevents secrets from reaching world-readable files.
- **TEST_IMPLICATION**: Tests for missing generator, missing partition table,
  a partition table without an `nvs` entry, a hardcoded-`0x9000` assertion
  (repository must contain no unproven hardcoded Production offset), CSV mode
  `0600`, refusal to overwrite an existing artifact, and byte-parity between the
  Core key loader and the NVS key validator.
- **OPEN_QUESTION**: The reviewed build's partition table has not been supplied,
  so the Production NVS offset is **UNKNOWN** and remains so.

### OD-L8-04 — Firmware build identity, MQTT CA, and no-placeholder contract

- **DECISION**:
  L8 consumes a **compile-only** firmware build. The build runs outside the
  stage handler; the handler receives the already-produced image plus the
  command that produced it, recorded in `AEGIS_L8_FIRMWARE_BUILD_CMD` for
  provenance. The handler **validates and never executes** that command, which
  must not contain any upload, flash, or erase verb (`upload`, `--target upload`, `erase_flash`, `write_flash`,
  `write_mem`, `espefuse`). The resulting firmware image is hashed with SHA-256
  and that digest is the build identity recorded in evidence.
  Before any write, the trust anchor at `firmware/src/secrets.h` must exist and
  must parse as a PEM certificate whose body is strictly base64 and long enough
  to be a certificate. Placeholder detection scans the **certificate body**
  only, and only for tokens carrying a separator outside the base64 alphabet
  (`REPLACE_WITH`, `CHANGE_ME`, …). A naive uppercase substring scan over the
  whole header would reject a valid anchor whose base64 happens to spell
  `TODO` or `CHANGEME`, because those letters are all base64 characters; the
  alphabet check plus a body length floor catches a separator-free placeholder
  instead. A firmware carrying
  a placeholder CA, or an NVS artifact carrying a demo/test protocol key, is
  rejected. The fixture NTP value `192.0.2.1` from `secrets.h.example` must
  never be promoted into a Production claim.
- **BASIS**:
  `…-runtime-prerequisites.md` §L8 "Stop if … the build contains a placeholder
  CA or a test key"; PF-03 (trust anchor compiled into firmware);
  `firmware/src/secrets.h.example`; `firmware/platformio.ini`
  (`esp32dev`, `espressif32@7.0.1`, `arduino`).
- **OWNER_STATUS**: `MERGED_AUTHORITY_RECONCILED`.
- **CURRENTLY_PROVEN**: `tests/test_firmware_contract.py` proves the example
  file carries only public placeholders and that PlatformIO pins dependencies
  without upload changes. No real build artifact exists in the repository.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Build-command verb denylist; SHA-256
  computation; placeholder-CA and PEM-shape validation; demo/test-key rejection
  carried from the NVS validator.
- **LIVE_PROOF_REQUIRED**: The SHA-256 of the exact reviewed image equals the
  image actually flashed to the device.
- **SECURITY_SAFETY_EFFECT**: Prevents shipping a device that trusts a
  placeholder anchor or a publicly known key, and prevents a test run from
  silently becoming an upload.
- **TEST_IMPLICATION**: Tests asserting that no test invokes an upload target,
  that a build command containing an upload/erase verb is rejected, that a
  placeholder CA is rejected, and that the firmware SHA-256 is recorded.
- **OPEN_QUESTION**: `firmware/src/secrets.h` is gitignored and absent, so the
  real CA cannot be validated in the repository.

### OD-L8-05 — Non-writing but device-resetting inspection

- **DECISION**:
  L8 inspection is classified `NON_WRITING_BUT_DEVICE_RESETTING`. Opening the
  serial port or invoking esptool may toggle DTR/RTS and reset the ESP32, which
  in turn re-enters boot with the relay held in its fail-secure CUT state.
  Inspection therefore **requires a maintenance window**
  (`L8_INSPECTION_REQUIRES_MAINTENANCE_WINDOW=YES`) and must never be described
  as side-effect-free or passive. In repository scope the refusal is
  **unconditional and structural**, not merely policy: the only implemented
  backend is `fixture`, which has no serial code path at all, and selecting
  `hardware` fails closed at two independent layers (the stage handler's
  backend gate and the device tool's backend loader). Because no hardware
  backend exists, even an explicit `AEGIS_L8_LIVE_AUTHORIZED=YES` cannot open a
  live path.
- **BASIS**: Owner classification; `firmware/platformio.ini`
  (`monitor_dtr = 0`, `monitor_rts = 0` reduce but do not eliminate the reset);
  `firmware/src/main.cpp` boot path (`BOOT_GRACE_MS`, relay driven to
  `RELAY_TRIGGER` at boot).
- **OWNER_STATUS**: `OWNER_APPROVED`.
- **CURRENTLY_PROVEN**: Repository-provable only as a refusal: fixture mode
  performs no serial access.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: A defense-in-depth live gate; a
  fixture backend with no serial code path; an explicit refusal when a real
  `/dev/tty*` path is combined with the fixture backend.
- **LIVE_PROOF_REQUIRED**: Inspection performed inside an authorized window with
  the uplink impact accepted in advance.
- **SECURITY_SAFETY_EFFECT**: Prevents an "inspection" from becoming an
  unplanned uplink cut.
- **TEST_IMPLICATION**: Tests that fixture mode never opens a serial device,
  that the live gate fails closed by default, and that a `/dev/tty*` path is
  refused under the fixture backend.
- **OPEN_QUESTION**: None for the repository scope.

### OD-L8-06 — Firmware and NVS flash procedure, and fail-secure effect

- **DECISION**:
  The ordered procedure is: (1) stage gate and live authorization; (2) OV-12
  identity binding; (3) NVS artifact generation at the derived offset; (4)
  firmware compile-only artifact and SHA-256; (5) placeholder/test-key refusal;
  (6) device write; (7) readback and boot verification. Every step before (6) is
  a hard gate — a failure there aborts with **no device write attempted**.
  A failure at or after (6) is `FAIL_SECURE_CUT`: the relay holds CUT and the
  stage stops. Forbidden at every point: `erase_flash`, `write_mem`, eFuse burn,
  any PlatformIO upload target, relay actuation, and any `CUT`/`RESTORE`
  command.
  The device write itself is `PRODUCTION_MUTATION_ALLOWED=NO` in this task and
  is exercised against the fixture backend only.
- **BASIS**: `…-runtime-prerequisites.md` §L8 impact and stop conditions;
  `firmware/src/main.cpp` boot fail-secure path; owner forbidden-operations list.
- **OWNER_STATUS**: `OWNER_APPROVED` for the fail-secure effect; `REPOSITORY_DESIGN`
  for the step ordering.
- **CURRENTLY_PROVEN**: Nothing live. The ordering and the refusals are
  repository-provable against the fixture backend.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Strict step ordering with early
  aborts; a denylist covering the forbidden verbs; a fixture write path that
  touches only files under the stage work directory.
- **LIVE_PROOF_REQUIRED**: Flash executed on the real device inside an
  authorized window, with the resulting CUT accepted.
- **SECURITY_SAFETY_EFFECT**: Guarantees that identity, schema, CA, and key
  validation all precede the irreversible step, and that no rollback path
  reopens an insecure configuration.
- **TEST_IMPLICATION**: Tests that a MAC mismatch aborts before write, that
  forbidden verbs are rejected, and that no erase/eFuse/upload call is reachable.
- **OPEN_QUESTION**: None for the repository scope.

### OD-L8-07 — Post-write readback and boot verification

- **DECISION**:
  After the write, the NVS image is read back and compared **privately**: the
  comparison happens in memory against the rendered artifact, and only the
  boolean outcome `nvs_readback_match` (`PASS`/`FAIL`) is recorded. Raw NVS
  contents, key material, and any per-field diff are never written, logged, or
  printed. Boot verification records only `boot_verification_result`.
  `HOST_PRE_TO_RB_ZERO_DRIFT=YES` is required for every L8 run: the Core host
  PRE and RB captures must compare equal under an **empty** allow-list.
  `HARDWARE_PRE_TO_RB_ZERO_DRIFT=YES` is required **before** the first hardware
  write where it is meaningful; once the flash has started it becomes
  `NOT_APPLICABLE`, because the device has been intentionally changed.
  A post-flash failure is `FAIL_SECURE_HOLD_AND_EVIDENCE`: hold the fail-secure
  state, capture evidence, escalate — never auto-recover. "Capture evidence" is
  load-bearing: a failure at or after the first write must still produce the
  evidence bundle, recording `flash_result=FAIL` and the `failure_boundary`,
  rather than aborting before the bundle is written.
- **BASIS**: Owner evidence rules; G-15 compare harness
  (`p4-compare.sh` with stage allow files); `…-runtime-prerequisites.md` §L8
  "NVS write verification fails" stop condition.
- **OWNER_STATUS**: `OWNER_APPROVED`.
- **CURRENTLY_PROVEN**: Repository-provable that the comparison emits only a
  boolean and that no secret appears in any output.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: In-memory constant-shape comparison;
  boolean-only recording; empty `allow-keys.txt`/`allow-listeners.txt` so host
  zero-drift is enforced by the existing compare harness.
- **LIVE_PROOF_REQUIRED**: Readback from the real device matches, and the device
  boots into the fail-secure CUT state as designed.
- **SECURITY_SAFETY_EFFECT**: Detects a partial or wrong-offset write without
  ever exposing the provisioned secrets in evidence.
- **TEST_IMPLICATION**: Tests that a mismatched readback yields `FAIL`, that no
  secret value appears in any emitted artifact, and that the allow files are
  empty.
- **OPEN_QUESTION**: None for the repository scope.

### OD-L8-08 — D4-only recovery and rollback

- **DECISION**:
  `L8_RECOVERY_POLICY=D4_ONLY`. `INTERIM_RECOVERY_PROCEDURE=NOT_APPROVED`.
  `D4_LIVE_REQUIRED_BEFORE_L8_FLASH=YES`: `apply.sh` requires an owner-supplied
  D4 readiness attestation and refuses the write path without it.
  `rollback.sh` behaviour is split at the first hardware write:
  - **Before the first hardware write** — remove only the stage-local artifacts
    this stage created, leaving Core host state at zero drift.
  - **At or after the first hardware write** — perform **no device action at
    all**. Forbidden without exception: automatic restore, automatic RESTORE
    after reboot or MQTT reconnect, reflashing the previous firmware, any legacy
    v0 image, and any plaintext MQTT 1883 fallback. The handler emits
    `FAIL_SECURE_HOLD_AND_EVIDENCE` and exits cleanly so the operator escalates.
  `rollback.sh` is idempotent and never touches IDEA1 or IDEA2 state.
- **BASIS**: OD-14; `…-runtime-prerequisites.md` §L8 rollback ("the device stays
  fail-secure CUT … never reflash v0 or reopen plaintext MQTT"); `p4-lib.sh`
  rollback-handler contract.
- **OWNER_STATUS**: `OWNER_APPROVED`.
- **CURRENTLY_PROVEN**: Repository-provable as refusals and idempotency. D4 live
  recovery itself is **NOT PROVEN**.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: A first-write marker written before
  the device write and read by `rollback.sh`; the two-branch rollback; a
  D4-attestation precondition on the write path.
- **LIVE_PROOF_REQUIRED**: D4 live recovery demonstrated operational before any
  L8 flash is authorized.
- **SECURITY_SAFETY_EFFECT**: Guarantees that no failure path restores the
  uplink automatically or downgrades transport security.
- **TEST_IMPLICATION**: Tests for rollback idempotency, for the pre-write branch
  leaving zero host drift, for the post-write branch performing no device
  action, and for the absence of any reflash/RESTORE/1883 path in the handler.
- **OPEN_QUESTION**: D4 live status is not established; live L8 stays blocked on
  it.

### OD-L8-09 — Stage-local hardware evidence model

- **DECISION**:
  `G15_HARDWARE_EVIDENCE=STAGE_LOCAL_PRIVATE_JSON_BUNDLE` with
  `WRITE_ONCE_NO_OVERWRITE`. The bundle is a single JSON file created under the
  stage evidence directory with mode `0600` and `O_EXCL | O_NOFOLLOW`; a second
  write to the same path fails closed rather than overwriting.
  The bundle contains **exactly and only** these eleven fields:
  `schema_version`, `run_id`, `device_mac`, `chip_identity`, `flash_size`,
  `firmware_sha256`, `nvs_schema_version`, `nvs_readback_match`, `flash_result`,
  `boot_verification_result`, `failure_boundary`.
  Never recorded, in any form: `wifi_psk`, `mqtt_password`/`mqtt_pass`, `k_c2d`,
  `k_d2c`, `admin.pin`, raw NVS contents, or any other raw secret.
- **BASIS**: Owner G-15 hardware-evidence decision; `p4_is_secret_file` custody
  convention in `p4-lib.sh` (secret-bearing files recorded by metadata only,
  never content and never a digest).
- **OWNER_STATUS**: `OWNER_APPROVED`.
- **CURRENTLY_PROVEN**: Repository-provable once implemented; nothing live.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Exact-allowlist serialisation that
  rejects any extra key; write-once creation; secret-exclusion assertions.
- **LIVE_PROOF_REQUIRED**: A real bundle produced during an authorized window.
- **SECURITY_SAFETY_EFFECT**: Bounds what hardware evidence can ever contain, so
  an evidence bundle cannot become a secret-disclosure channel.
- **TEST_IMPLICATION**: Tests for the exact field set, for rejection of an extra
  field, for `0600` mode, for no-overwrite, and for secret exclusion against
  every provisioned secret value.
- **OPEN_QUESTION**: None for the repository scope.

---

## 5. Repository Implementation Plan

| Path | Change | Class |
|---|---|---|
| `deploy/pr11-phase4/stages/L8/apply.sh` | new — gate, binding, artifact, write orchestration | MUTATING handler (fixture-exercised only) |
| `deploy/pr11-phase4/stages/L8/verify.sh` | new — read-only post-stage verification | read-only |
| `deploy/pr11-phase4/stages/L8/rollback.sh` | new — two-branch fail-secure rollback | MUTATING handler (fixture-exercised only) |
| `deploy/pr11-phase4/stages/L8/allow-keys.txt` | new — zero active keys | contract |
| `deploy/pr11-phase4/stages/L8/allow-listeners.txt` | new — zero active entries | contract |
| `deploy/pr11-phase4/p4-l8-device.py` | new — backend abstraction, partition geometry derivation, readback compare, evidence bundle | repository tool, fixture backend only |
| `tests/test_pr11_phase4_l8_handler.py` | new — RED-first acceptance suite | test |
| `tests/test_pr11_phase4_harness.py` | edit — add L8 to the reviewed-handler set; move the unregistered-mutating-stage example to L9 | shared harness guardrail |

`p4-lib.sh`, `p4-l0-capture.sh`, `p4-compare.sh`, `p4-stage-gate.sh`,
`p4-nvs-provision.py`, and `firmware/**` are **not modified** by this task.

The only shared-harness edit is `tests/test_pr11_phase4_harness.py`, which
carries an explicit allowlist of reviewed stage handlers. Registering L8
requires adding it there, exactly as PR #164 did for L7 (commit `2741ea3f`).

---

## 6. Safety Boundary for This Task

```text
PRODUCTION_MUTATION_ALLOWED=NO
REAL_HARDWARE_ACCESSED=NO
SERIAL_PORT_OPENED=NO
ESPTOOL_AGAINST_HARDWARE=NO
FIRMWARE_FLASHED=NO
FLASH_ERASED=NO
EFUSE_BURNED=NO
RELAY_ACTUATED=NO
CUT_ISSUED=NO
RESTORE_ISSUED=NO
PRODUCTION_KEYS_GENERATED=NO
D4_CREDENTIALS_GENERATED=NO
LIVE_CORE_STARTED=NO
BROKER_MUTATED=NO
NETWORK_MUTATED=NO
ETC_MUTATED=NO
OPT_MUTATED=NO
IDEA1_MODIFIED=NO
IDEA2_MODIFIED=NO
```

---

## 7. Live L8 Remains Blocked

Repository completion of L8 is **not** live acceptance. Live L8 additionally
requires, at minimum: required predecessor live stages PASS; L7 live PASS; D4
live recovery operational; the physical device present; OV-08, OV-09, OV-12,
OV-13; OV-14 / fresh K3; a same-day explicit `A-L8` authorization carrying
`recovery_authorization`; IDEA2 §10 preservation PASS or an owner-approved
narrowed criterion; the exact reviewed firmware and NVS build; hardware identity
verification; and all applicable S-01..S-12 clear.

```text
LIVE_L8=NOT_AUTHORIZED
LIVE_L8_PHYSICAL_PROOF_REQUIRED=YES
LIVE_L8_PHYSICAL_PROOF=NOT_PROVEN
```
