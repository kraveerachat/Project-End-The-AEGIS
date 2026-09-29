# IDEA3 PR11 Phase 4 L9 — Authentication Without Actuation Operational Design

Date: 2026-09-21
Owner: Music (Kla reviewing)
Task: PR11 Phase 4 L9 authentication-without-actuation repository handler
Branch: `feat/idea3-pr11-phase4-l9-handler`
Status: REPOSITORY DESIGN — IMPLEMENTATION IN PROGRESS — LIVE L9 NOT AUTHORIZED
Scope: PR11 Phase 4 L9 repository operational design
Binding authority (merged):
- `2026-09-17-idea3-pr11-phase4-runtime-prerequisites.md` §L9, §10, §11, §12 (A-L9)
- `2026-09-15-idea3-pr11-phase4-protocol-v1-design.md` §4–§6, §12, §14 (G1 approved by Music on 2026-09-15)
- `deploy/pr11-phase4/p4-lib.sh` rollback-handler contract (G-15)
Repository Implementation: fixture backend only
Live L9: NOT AUTHORIZED / NOT RUN
Production Mutation: NO
COMMAND / CUT / RESTORE issued: NO

> [!IMPORTANT]
> **Repository design does NOT authorize live L9.** Every decision below
> authorizes repository design, acceptance tests, and a stage handler exercised
> against **fixture Core/device material only**. Nothing here authorizes
> publishing to a real broker, starting or stopping the Core, injecting a probe
> into a live device, issuing any COMMAND, or actuating the relay.
> `LIVE_L9_PROOF_REQUIRED=YES` and that proof does not exist.

No decision in this document carries `OWNER_APPROVED` unless the owner
approved it in a merged authority listed above. New repository decisions are
marked `REPOSITORY_DESIGN — OWNER_REVIEW_PENDING`.

---

## 1. Canonical State & Authority Markers

```text
POST_L8_MAIN_SHA=f08d003b86ebdd950416026e6f473b6cbd7213a5
PR165_MERGED=YES

L2_HANDLER=REGISTERED
L3_HANDLER=REGISTERED
L4_HANDLER=REGISTERED
L5_HANDLER=REGISTERED
L6A_HANDLER=REGISTERED
L6B_HANDLER=REGISTERED
L7_HANDLER=REGISTERED
L8_HANDLER=REGISTERED
L9_HANDLER=REGISTERED (by this task, fixture backend only)
L1_HANDLER=NOT_REGISTERED (package installation; outside this task)

P4_STAGES=L0 L1 L2 L3 L4 L5 L6a L6b L7 L8 L9   (unchanged)
P4_STAGE_GAPS_L9=none                          (unchanged)
P4_STAGE_AUTH_EXTRA_L9=none                    (unchanged)

PROTOCOL_VERSION=1
HEARTBEAT_INTERVAL_SEC=15
SKEW_PAST_SEC=30
SKEW_FUTURE_SEC=2
DEADMAN_SECONDS=60
FIRMWARE_HEARTBEAT_REPLAY_SLOTS=20

L2..L9_LIVE=NOT_RUN
L9_LIVE_AUTHORIZED=NO
PRODUCTION_MUTATION=NO
PHASE4_RUNTIME_COMPLETE=NO
PHASE4_LIVE_READINESS=NOT_READY
```

---

## 2. Reconciliation of Prior L9 Fragments

There is **no prior standalone L9 design**. Earlier documents describe L9 in
passing, and two of those fragments conflict with the binding authority.

| Prior fragment | Source | Binding authority | Reconciled outcome |
|---|---|---|---|
| "Stage L9 verifies authenticated **command roundtrips** without actuation" | L8 design §3.1; L7 design "Subsequent Stages" | Prerequisites §L9: "**no COMMAND issued**" | **Withdrawn.** L9 issues no COMMAND of any kind. A command roundtrip needs a COMMAND frame, and any COMMAND frame is an actuation request. OD-L9-06. |
| L9 as a place for "physical relay CUT testing (L8/L9)" | L7 design OD-L7-08 rationale | Prerequisites §"L10 and later": the CUT test needs its own gate | **Withdrawn.** The CUT test is an L10+ gate (A-CUT), outside L9. |
| Heartbeat REPLAY by `issued_at` strictly greater than the last accepted heartbeat | Protocol v1 design §6.1 | Same | **Retained as the design rule.** The firmware implements a different rule (FIND-L9-01, OD-L9-04). |
| L9 rollback: "stop the Core; the device fails secure" | Prerequisites §L9 | G-15 runner step 5 expects PRE→RB zero drift | **Reconciled as a fail-secure hold**, not a restoration. OD-L9-08. |
| Harness uses L9 as its unregistered-mutating-stage fixture | PR #165 (`test_pr11_phase4_harness.py`) | `P4_STAGES` ends at L9; L10+ is outside the stage set | Fixture moves **L9 → L1**, the only remaining unregistered mutating stage. §3.3. |

---

## 3. Stage Scope and Registration Mechanics

### 3.1 Stage scope

- **Preceding stages:** L7 installed Core credentials and started
  `aegis-idea3-core.service`. L8 provisioned and flashed the device, which
  holds its boot CUT output until a D4 RESTORE.
- **Stage L9 (this scope):** observe that authentication works end to end in
  both directions **without asking the device to do anything**:
  - Core → device: a signed HEARTBEAT is accepted by the device, and its only
    effect is a dead-man timer reset;
  - device → Core: a signed BOOT STATUS and a signed PERIODIC STATUS are
    accepted by the Core, and only then does liveness begin;
  - negatives: replay, wrong key, tampered MAC or field, stale or future time,
    malformed frames, identity mismatch, retained frames, and untrusted time
    are rejected with no liveness, no replay row, and no state.
- **Out of scope:** COMMAND, CUT, RESTORE, D4, K12, removing 1883, and any relay
  state change. These are separate L10+ gates.

### 3.2 Registration mechanics

`p4-lib.sh` already lists `L9` in `P4_STAGES`, reports
`p4_stage_gaps L9 = none`, and requires no extra authorization field.
`p4_stage_handler_status L9` becomes `REGISTERED` when all five files exist:
`stages/L9/apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt`, and
`allow-listeners.txt`. **`p4-lib.sh` needs no change.**

### 3.3 Shared harness fixture (shared surface)

`tests/test_pr11_phase4_harness.py::test_gate_live_mode_for_mutating_stage_fails_without_registered_handler`
proves that the stage gate still refuses `--mode live` when a mutating stage has
no handler. It needs a mutating stage that `P4_STAGES` contains and that has no
handler. After this task only **L1** satisfies that:

- `p4_stage_known L1` is true, and `p4_stage_mutates L1` is true;
- L1 requires K3 and the `d6_notice=pub` extra field, and the harness's
  `auth_record` already supplies it;
- `stages/L1/` does not exist.

L10 is **not** used, because it is outside `P4_STAGES` and would fail earlier
with `STAGE_UNKNOWN`. Using it would stop the test from exercising the
handler branch at all. The move repeats the precedent of PR #164 and PR #165.
One addition keeps the guardrail load-bearing: the test first asserts that the
fixture stage has no `stages/<stage>/` directory. If a future task registers
L1, the test fails loudly instead of quietly passing without testing anything.

**Open item for Kla:** after this task L1 is the last unregistered mutating
stage. Registering L1 later needs a new fixture mechanism, such as a synthetic
copy of the harness in a temporary directory. That is a future integration
decision, not taken here.

### 3.4 Host drift contract

L9 is observational. The Core has been running since L7, and L9 changes no host
file, unit, listener, firewall, or network state. `allow-keys.txt` and
`allow-listeners.txt` therefore carry **zero active entries**, the same as L6a
and L8. A Core restart during L9 changes `MainPID` or `NRestarts`, so it appears
as drift and fails the stage, which is the intended behaviour.

---

## 4. Operational Decisions (OD-L9-01 … OD-L9-09)

### OD-L9-01 — Authentication-only scope

- **DECISION**: L9 proves authentication and freshness only. Its sole permitted
  Core → device frame is a HEARTBEAT. Its only permitted device → Core frames
  are STATUS with `reason` of `BOOT` or `PERIODIC`. The repository handler has
  exactly one backend, `fixture`. `AEGIS_L9_BACKEND=live` is refused at two
  independent layers (`apply.sh` and `p4-l9-auth.py`), whatever
  `AEGIS_L9_LIVE_AUTHORIZED` says.
- **BASIS**: Prerequisites §L9; §12 A-L9; L8 two-layer refusal precedent
  (`L8 NC-4/NC-4b`).
- **OWNER_STATUS**: Scope `OWNER_APPROVED` (merged prerequisites §L9). The
  fixture-only backend is `REPOSITORY_DESIGN — OWNER_REVIEW_PENDING`.
- **CURRENTLY_PROVEN**: Nothing live.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Backend gate in both layers; no
  broker client, no serial access, no systemd call.
- **LIVE_PROOF_REQUIRED**: A reviewed live probe mechanism does not exist. It
  must be designed and reviewed separately before A-L9 can be used.
- **SECURITY_SAFETY_EFFECT**: No repository path can reach a live broker or
  device.
- **TEST_IMPLICATION**: The live backend is refused in the shell layer, in the
  Python layer, and when both are driven directly. Unknown backends are
  refused. No broker, serial, or systemd reference appears in L9 sources.
- **OPEN_QUESTION**: What the live mechanism should be: an owner-run MQTT
  client using the Core identity, or a Core-side observation of the running
  service. Deferred to a live L9 design.

### OD-L9-02 — Heartbeat authentication (Core → device)

- **DECISION**: The Core-side HEARTBEAT is produced by the Core's own codec
  (`protocol_v1.encode(HEARTBEAT)`, the same call `Controller.send_heartbeat`
  makes) with `K_C2D`. The device-side check is a **model** of Protocol v1
  design §6.1 heartbeat stages, in this order: TRANSPORT (exact heartbeat
  topic) → SCHEMA/PAYLOAD (`protocol_v1.parse`, device identity) → device TIME
  trust → AUTH (`K_C2D`, constant time) → SKEW (`issued_at ≤ now+2`,
  `now − issued_at ≤ 30`) → REPLAY (OD-L9-04). The only effect of an accepted
  heartbeat is `DEADMAN_RESET`. There is no ACK, no STATUS, and no output
  change.
- **BASIS**: Protocol v1 design §5.2, §6.1 ("Every heartbeat failure is
  silent. The only effect is a dead-man timer reset, never RESTORE.");
  `firmware/src/main.cpp` `handleHeartbeat`.
- **OWNER_STATUS**: `OWNER_APPROVED` (Protocol v1 G1).
- **CURRENTLY_PROVEN**: The C++ parser and MAC parity with the Python codec
  (`tests/test_firmware_protocol_parity.py`, when g++/OpenSSL exist). The
  firmware's `handleHeartbeat` verifies before any effect, and its effect is a
  dead-man reset only (static source contract added by this task).
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: The device heartbeat model; static
  firmware contract tests; the recording transport that refuses every topic
  except the heartbeat topic.
- **LIVE_PROOF_REQUIRED**: The real device accepts a live Core heartbeat. Its
  dead-man switch does not fire while heartbeats flow, and its output stays
  CUT, because a heartbeat never restores.
- **SECURITY_SAFETY_EFFECT**: A forged or replayed heartbeat cannot hold off the
  dead-man switch, and even an accepted heartbeat cannot change relay output.
- **TEST_IMPLICATION**: The authenticated heartbeat is accepted exactly once.
  Replay, wrong-key (foreign and cross-direction), tampered-MAC,
  tampered-field, stale, future, malformed, device-mismatch, topic-mismatch,
  untrusted-device-time, and zero-MAC heartbeats are rejected. The accepted
  effect set is exactly `{DEADMAN_RESET}`.
- **OPEN_QUESTION**: FIND-L9-01 (OD-L9-04).

### OD-L9-03 — BOOT / PERIODIC STATUS authentication (device → Core)

- **DECISION**: The Core-side check is the Core's **real**
  `aegis_soc.protocol_inbound.InboundVerifier`, backed by a real
  `ProtocolStore` in the stage work directory and a fixture trusted clock.
  Positive frames are a signed `STATUS` with `reason=BOOT` and one with
  `reason=PERIODIC`, `time_trust=SYNCED`, and no command correlation. Liveness
  exists **only** when the verifier returns `accepted=True`, which mirrors
  `MQTTManager._on_v1_message`.
- **BASIS**: Protocol v1 design §6.2 and its load-bearing rule ("No liveness …
  before AUTH"); `aegis_soc/mqtt_client.py`.
- **OWNER_STATUS**: `OWNER_APPROVED` (Protocol v1 G1).
- **CURRENTLY_PROVEN**: The verifier stage order and rejection codes
  (`tests/test_protocol_inbound.py`).
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Exercise the real verifier and store
  from the stage helper, and prove that `MQTTManager` produces no liveness for
  any L9 negative frame.
- **LIVE_PROOF_REQUIRED**: The running Core accepts the real device's BOOT and
  PERIODIC STATUS through its broker subscription.
- **SECURITY_SAFETY_EFFECT**: Only authenticated, fresh, non-replayed device
  evidence can establish liveness.
- **TEST_IMPLICATION**: BOOT and PERIODIC are accepted; each writes exactly one
  replay row; liveness is established only after the first accepted STATUS.
- **OPEN_QUESTION**: None for the repository scope.

### OD-L9-04 — Replay rejection

- **DECISION**:
  - **Core:** replay is rejected by the durable `(device_id, msg_id)` insert in
    `protocol_seen_d2c` (REPLAY `DUPLICATE`). A replayed STATUS adds no row and
    no liveness.
  - **Device model:** implements design §6.1. A heartbeat is fresh only when
    its `msg_id` is unseen **and** its `issued_at` is strictly greater than the
    last accepted heartbeat's `issued_at`.
  - **FIND-L9-01:** `firmware/src/main.cpp` `handleHeartbeat` implements only
    the `msg_id` ring (20 slots) and not the strictly increasing `issued_at`
    rule. An authenticated, distinct-`msg_id`, older heartbeat still inside the
    30 s skew window is therefore accepted by the firmware but rejected by the
    design. The only consequence is a dead-man timer reset. It never produces
    RESTORE or any output change, and it requires a genuine Core-signed frame.
    The firmware is **not changed** by this task, because that would change
    the L8-flashed image contract.
- **BASIS**: Protocol v1 design §6.1, §6.2; `aegis_soc/protocol_store.py`
  `record_seen`; firmware source.
- **OWNER_STATUS**: The rule is `OWNER_APPROVED` (G1). The FIND-L9-01 disposition
  is `OWNER_DECISION_REQUIRED`.
- **CURRENTLY_PROVEN**: Core durable replay (`tests/test_protocol_store.py`,
  `tests/test_protocol_inbound.py`).
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Replay probes in both directions;
  replay-row accounting in evidence.
- **LIVE_PROOF_REQUIRED**: A replayed live STATUS is rejected by the running
  Core, and a replayed live heartbeat is ignored by the device.
- **SECURITY_SAFETY_EFFECT**: A captured frame cannot re-establish liveness.
- **TEST_IMPLICATION**: Replayed STATUS gives `REPLAY/DUPLICATE` with the row
  count unchanged. Replayed heartbeat gives `REPLAY/DUPLICATE`. An older
  heartbeat with a distinct `msg_id` gives `REPLAY/NOT_MONOTONIC` in the model.
  A firmware contract test pins the ring behaviour and documents FIND-L9-01.
- **OPEN_QUESTION**: Should the firmware add the strictly increasing
  `issued_at` rule (a firmware change, with a new L8 build), or should the
  design accept the `msg_id` ring as equivalent? Owner decision.

### OD-L9-05 — Wrong-key and unauthenticated rejection

- **DECISION**: Wrong-key probes are built **without generating any key**:
  - *cross-direction:* STATUS signed with `K_C2D`, and HEARTBEAT signed with
    `K_D2C` (domain/key confusion);
  - *foreign:* a copy of the correct key with one bit flipped. It exists only
    in memory for the probe and is never written or recorded.

  Unauthenticated probes are an all-zero MAC, a MAC altered by one hex digit, a
  field altered after signing, and a legacy v0 unsigned JSON STATUS. Every such
  probe must be rejected at or before AUTH, with no replay row, no liveness,
  and no audit row (pre-AUTH rejections only increment the in-memory counter).
  Keys are loaded only through `protocol_v1.load_protocol_keys`, which refuses
  the public golden-vector keys, the legacy demo secret, all-zero keys, and
  equal directional keys.
- **BASIS**: Protocol v1 design §4.5, §4.6, §6; OD-L7-02 key policy
  (`PRODUCTION_KEY_GENERATION=OWNER_CONTROLLED_OFFLINE`).
- **OWNER_STATUS**: `OWNER_APPROVED` for the rules (G1, OD-L7-02). The probe
  construction is `REPOSITORY_DESIGN — OWNER_REVIEW_PENDING`.
- **CURRENTLY_PROVEN**: MAC verification and key refusal
  (`tests/test_protocol_v1.py`).
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: The probe builders; a no-key-generator
  static scan over L9 sources.
- **LIVE_PROOF_REQUIRED**: A wrong-key frame injected in an authorized window is
  ignored by the running Core and by the device.
- **SECURITY_SAFETY_EFFECT**: Unauthenticated traffic cannot establish liveness
  or state. The probes introduce no new key material.
- **TEST_IMPLICATION**: Every wrong-key or unauthenticated probe is rejected at
  `AUTH/MAC` (or at `SCHEMA` for v0 JSON). Unsafe input keys are refused before
  any probe. No `secrets.token_*`, `os.urandom`, or `openssl rand` appears in
  L9 sources.
- **OPEN_QUESTION**: None for the repository scope.

### OD-L9-06 — Zero COMMAND / zero actuation contract

- **DECISION**: L9 emits **zero** COMMAND frames, and therefore zero CUT and
  zero RESTORE. This is enforced at four layers:
  1. The recording transport accepts only the configured device's heartbeat
     topic and raises on anything else, including the command topic.
  2. The helper never calls `reserve_command`, `mark_published`,
     `send_command`, or `encode` with a COMMAND kind, and never imports
     `local_restore`. A static scan enforces this.
  3. After the run, the fixture `ProtocolStore` must show zero
     `protocol_commands` rows and `last_allocated_seq = 0`. The evidence
     records `commands_emitted`, `cut_emitted`, and `restore_emitted`, and all
     must be `0`.
  4. `relay_actuation` is recorded as `NONE`. The device model's effect set
     has no output-changing member.
- **BASIS**: Prerequisites §L9 ("no COMMAND issued"); §11 S-12; D4 unchanged
  (Protocol v1 design §9).
- **OWNER_STATUS**: `OWNER_APPROVED` (merged prerequisites §L9, S-12).
- **CURRENTLY_PROVEN**: Nothing yet for L9.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: All four layers, plus evidence
  counters.
- **LIVE_PROOF_REQUIRED**: During a live window, the Core audit shows no
  `COMMAND_SENT`, the protocol store shows no new command row, and the relay
  output stays at its boot CUT state.
- **SECURITY_SAFETY_EFFECT**: L9 can never actuate the relay.
- **TEST_IMPLICATION**: Transport refusal of the command topic; zero store
  command rows; zero counters; static scans; a negative control that disables
  the transport guard and shows the test catching it.
- **OPEN_QUESTION**: None.

### OD-L9-07 — Core/device fixture evidence

- **DECISION**: One stage-local private JSON bundle,
  `l9-auth-evidence.json`, created write-once (`O_EXCL | O_NOFOLLOW`) at mode
  `0600`, with **exactly** these fields:
  `schema_version`, `run_id`, `evidence_class`, `device_id`,
  `heartbeat_accepted`, `heartbeat_effect`, `status_boot_accepted`,
  `status_periodic_accepted`, `liveness_before_authenticated_status`,
  `heartbeat_probes`, `status_probes`, `negative_probe_acceptances`,
  `replay_rows_from_rejected`, `commands_emitted`, `cut_emitted`,
  `restore_emitted`, `relay_actuation`, `result`, `failure_boundary`.
  `evidence_class` is always `REPOSITORY_FIXTURE` in this repository, so a
  fixture bundle can never be mistaken for live evidence (this addresses an L8
  limitation). Probe results are stable `STAGE/CODE` strings. Never recorded:
  a key, a key digest, a MAC, a `msg_id`, a raw payload, or a password.
  `device_id` is the OV-08 identifier, which is not a secret.
- **BASIS**: G-15 evidence model (`STAGE_LOCAL_PRIVATE_JSON_BUNDLE`,
  `WRITE_ONCE_NO_OVERWRITE`, OD-L8-09); `p4_is_secret_file` custody
  convention.
- **OWNER_STATUS**: The model is `OWNER_APPROVED` (G-15). The L9 field set is
  `REPOSITORY_DESIGN — OWNER_REVIEW_PENDING`.
- **CURRENTLY_PROVEN**: Nothing yet for L9.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: Exact-allowlist writer; `verify`
  subcommand; secret-exclusion check against the input keys.
- **LIVE_PROOF_REQUIRED**: A bundle produced from a live window, with
  `evidence_class` set to a live value that a separate reviewed design would
  define.
- **SECURITY_SAFETY_EFFECT**: Evidence cannot disclose authentication material.
- **TEST_IMPLICATION**: Exact field set; extra or missing field refused; mode
  `0600`; no overwrite; no key hex, MAC, or `msg_id` in the bundle or in
  stdout/stderr.
- **OPEN_QUESTION**: None for the repository scope.

### OD-L9-08 — Failure and rollback semantics

- **DECISION**:
  - Any failed expectation fails `apply.sh` non-zero. The helper still writes
    the evidence bundle with `result=FAIL` and a `failure_boundary` code
    (for example, `HEARTBEAT_NOT_ACCEPTED`, `PROBE_ACCEPTED:<name>`,
    `ACTUATION_DETECTED`), following the L8 fix for evidence on failure.
  - **Repository `rollback.sh`** removes only the stage-local fixture store
    files (`fixture-protocol.sqlite3` and its `-wal`/`-shm`), preserves the
    evidence, takes no Core action and no device action, and is idempotent.
  - **Live rollback** (not implemented) is the prerequisites §L9 action: the
    owner stops `aegis-idea3-core.service` and the device fails secure through
    its dead-man switch. The device is already CUT after L8. This is **not** a
    restoration: PRE had the Core running, so a PRE→RB comparison with no allow
    files will differ, and the runner's S-11 branch applies — hold in the
    safest state (Core stopped, device CUT) and escalate. It never sends
    RESTORE, never reopens 1883, and never runs v0.
- **BASIS**: Prerequisites §L9 rollback, §11 S-11, S-12; Protocol v1 design §14;
  `p4-lib.sh` rollback contract; OD-L8-08 precedent.
- **OWNER_STATUS**: The live rollback action is `OWNER_APPROVED` (prerequisites
  §L9). The repository split is `REPOSITORY_DESIGN — OWNER_REVIEW_PENDING`.
- **CURRENTLY_PROVEN**: Nothing yet for L9.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: The rollback script; evidence on
  failure; no `systemctl` in L9 sources.
- **LIVE_PROOF_REQUIRED**: The owner-run stop of the Core leads to a device
  dead-man CUT hold (the device is already CUT).
- **SECURITY_SAFETY_EFFECT**: Every failure path converges on fail-secure.
- **TEST_IMPLICATION**: Rollback idempotency; evidence preserved; store files
  removed; stdout declares `L9_CORE_ACTION_TAKEN=NONE` and
  `L9_COMMAND_SENT=NONE`; no `systemctl`, RESTORE, or 1883 path.
- **OPEN_QUESTION**: Whether the live runner should classify the L9 PRE→RB
  difference as an expected S-11 hold (runner design, future).

### OD-L9-09 — Live-proof boundary

- **DECISION**: Repository completion of L9 proves the **software and security
  contract only**. It is not live acceptance and not physical evidence. Live L9
  requires at least: live L2..L8 PASS; a running, authorized Core (L7) and a
  flashed device (L8); a separate same-day A-L9; fresh K3; fresh §10
  preservation evidence; the IDEA2 §10 caveat resolved or accepted by the
  owner; S-01..S-12 clear; and a reviewed live probe mechanism (OD-L9-01).
- **BASIS**: Prerequisites §9 (L9), §10, §11, §12; Protocol v1 design §12
  evidence ladder.
- **OWNER_STATUS**: `OWNER_APPROVED` (merged prerequisites).
- **CURRENTLY_PROVEN**: None of the live prerequisites.
- **REPOSITORY_IMPLEMENTATION_REQUIRED**: The stage gate still reports
  `LIVE_STAGE_AUTHORIZED=NO` for L9. The handler refuses live.
- **LIVE_PROOF_REQUIRED**: Everything listed in the DECISION.
- **SECURITY_SAFETY_EFFECT**: Prevents a repository PASS from being read as live
  readiness.
- **TEST_IMPLICATION**: Gate output for L9 still carries
  `LIVE_STAGE_AUTHORIZED=NO`, and simulation with valid records reports
  `ROLLBACK_HANDLER=REGISTERED` but never authorizes live.
- **OPEN_QUESTION**: None for the repository scope.

---

## 5. Probe Matrix (repository fixture)

| Direction | Probe | Expected result |
|---|---|---|
| C2D | authenticated heartbeat | ACCEPTED, effect `DEADMAN_RESET` |
| C2D | replay (same bytes) | `REPLAY/DUPLICATE` |
| C2D | older `issued_at`, new `msg_id` | `REPLAY/NOT_MONOTONIC` (model; FIND-L9-01) |
| C2D | foreign key | `AUTH/MAC` |
| C2D | cross-direction key (`K_D2C`) | `AUTH/MAC` |
| C2D | tampered MAC | `AUTH/MAC` |
| C2D | tampered field | `AUTH/MAC` |
| C2D | zero MAC | `AUTH/MAC` |
| C2D | stale (`now − 31`) | `SKEW/STALE` |
| C2D | future (`now + 3`) | `SKEW/FUTURE` |
| C2D | malformed | `SCHEMA/SYNTAX` |
| C2D | other device id on this topic | `PAYLOAD/DEVICE` |
| C2D | other device's topic | `TRANSPORT/TOPIC` |
| C2D | device time untrusted | `TIME/LOCAL_TIME_UNTRUSTED` |
| D2C | authenticated BOOT STATUS | ACCEPTED, liveness begins |
| D2C | authenticated PERIODIC STATUS | ACCEPTED |
| D2C | replay (same bytes) | `REPLAY/DUPLICATE` |
| D2C | foreign key | `AUTH/MAC` |
| D2C | cross-direction key (`K_C2D`) | `AUTH/MAC` |
| D2C | tampered MAC | `AUTH/MAC` |
| D2C | tampered field | `AUTH/MAC` |
| D2C | zero MAC | `AUTH/MAC` |
| D2C | stale | `SKEW/STALE` |
| D2C | future | `SKEW/FUTURE` |
| D2C | `time_trust=UNTRUSTED` | `SKEW/DEVICE_TIME_UNTRUSTED` |
| D2C | malformed | `SCHEMA/SYNTAX` |
| D2C | legacy v0 unsigned JSON | `SCHEMA/SYNTAX` |
| D2C | other device id on this topic | `PAYLOAD/DEVICE` |
| D2C | other device's topic | `TRANSPORT/TOPIC` |
| D2C | C2D kind delivered to the Core | `TRANSPORT/TOPIC` |
| D2C | retained | `TRANSPORT/RETAINED` |
| D2C | Core time untrusted | `TIME/LOCAL_TIME_UNTRUSTED` |

Every negative D2C probe runs **before** the first authenticated STATUS, so
the run proves directly that no unauthenticated or invalid frame establishes
liveness. The replay probe necessarily runs after acceptance.

---

## 6. Repository Implementation Plan

| Path | Change | Class |
|---|---|---|
| `deploy/pr11-phase4/stages/L9/apply.sh` | new — environment, backend, and input gates; delegates to the helper | stage handler (fixture-exercised only) |
| `deploy/pr11-phase4/stages/L9/verify.sh` | new — read-only evidence verification | read-only |
| `deploy/pr11-phase4/stages/L9/rollback.sh` | new — removes the stage-local fixture store; no Core or device action | stage handler |
| `deploy/pr11-phase4/stages/L9/allow-keys.txt` | new — zero active keys | contract |
| `deploy/pr11-phase4/stages/L9/allow-listeners.txt` | new — zero active entries | contract |
| `deploy/pr11-phase4/p4-l9-auth.py` | new — probe builders, device heartbeat model, recording transport, real Core verifier/store, evidence writer and verifier | repository tool, fixture backend only |
| `deploy/pr11-phase4/README.md` | edit — handler registration record | documentation |
| `tests/test_pr11_phase4_l9_handler.py` | new — RED-first acceptance suite | test |
| `tests/test_pr11_phase4_harness.py` | edit — add L9 to the reviewed-handler set; move the live-gate fixture L9 → L1 and assert it is unregistered | **shared harness guardrail** |

The following are **not modified**: `p4-lib.sh`, `p4-l0-capture.sh`,
`p4-compare.sh`, `p4-stage-gate.sh`, `p4-l8-device.py`, `aegis_soc/**`,
`firmware/**`, and the L2–L8 stage handlers.

---

## 7. Safety Boundary for This Task

```text
PRODUCTION_MUTATION_ALLOWED=NO
REAL_HARDWARE_ACCESSED=NO
SERIAL_PORT_OPENED=NO
LIVE_BROKER_CONTACTED=NO
LIVE_CORE_STARTED_OR_STOPPED=NO
COMMAND_ISSUED=NO
CUT_ISSUED=NO
RESTORE_ISSUED=NO
RELAY_ACTUATED=NO
PRODUCTION_KEYS_GENERATED=NO
TWINGATE_MUTATED=NO
NETWORK_MUTATED=NO
ETC_OPT_WRITTEN=NO
IDEA1_MODIFIED=NO
IDEA2_MODIFIED=NO
```

---

## 8. Live L9 Remains Blocked

```text
LIVE_L9=NOT_AUTHORIZED
LIVE_L9_PROOF_REQUIRED=YES
LIVE_L9_PROOF=NOT_PROVEN
```
