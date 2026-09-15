# AEGIS IDEA3 PR11 Phase 4 Protocol v1 Design

> Status: **G1 APPROVED FOR REPOSITORY IMPLEMENTATION (2026-09-15)**. The
> binding decisions and the continuation validation order are in §18; they
> are applied throughout this document and supersede the G1 draft wherever
> the two differ.
>
> Area / owner: `idea3` / `music`
>
> Branch: `feat/idea3-pr11-phase4-protocol-v1`, created from `origin/main`
> `2742be27d9a904cf73378724ea831d9ef385948b`
>
> `PHASE4_REPOSITORY_IMPLEMENTATION=AUTHORIZED`
>
> `PHASE4_LIVE_ALLOWED=NO`
>
> `PRODUCTION_MUTATION_AUTHORIZED=NO`
>
> `IDEA3_PRODUCTION_DEPLOYED=NO`

This design turns the approved Phase 4 architecture into a precise, testable
repository contract for Protocol v1. It covers:

- the MQTT envelope, signing, and keys;
- replay protection and trusted time;
- the TLS broker profile, ACL, and identities;
- firmware and broker migration;
- rollback.

It changes no host, broker, firmware image, certificate, key, access point,
network, CUT, or RESTORE state.

Companion plan:
`IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-15-idea3-pr11-phase4-protocol-v1.md`.

Notation:

- **BINDING**: approved Phase 4 architecture or a G1 decision. It must not be weakened.
- **APPROVED (G1)**: a concrete choice approved at G1 for repository implementation.

## 1. Authoritative starting state

The following values were verified on 2026-09-15:

```text
CURRENT_MAIN                     = 2742be27d9a904cf73378724ea831d9ef385948b
BRANCH                           = feat/idea3-pr11-phase4-protocol-v1 (HEAD = CURRENT_MAIN at start)
WORKTREE_CLEAN                   = YES at start
PR133                            = MERGED at 2742be27 by pubpup2006p-design, 2026-09-15T08:13:27Z
PR133_REVIEWS                    = pubpup2006p-design APPROVED 08:09:21Z; kraveerachat APPROVED 08:12:49Z
KLA_REVIEW                       = APPROVED (GitHub review on PR #133)
PUB_D6_REVIEW                    = APPROVED / RECORDED (Pub's GitHub APPROVED review on PR #133,
                                   which requested Pub for D6; the review body is empty)
PR130                            = MERGED at 7022641263c7b3275259d281602428e99d90c4b6, 2026-09-15T06:37:58Z
K3                               = REPOSITORY_CONFLICT_CLOSED / LIVE_WINDOW_NOT_PROVEN
PHASE3_REPOSITORY_PREPARATION    = COMPLETE
PHASE3_RUNTIME_COMPLETE          = NO
PHASE2_RUNTIME_COMPLETE          = NO
PRODUCTION_MUTATION_AUTHORIZED   = NO
IDEA3_PRODUCTION_DEPLOYED        = NO
```

### 1.1 Step 0 baseline, re-proved on this main

Environment:

```text
host                 = local Arch Linux workstation, kernel 7.2.3-arch1-2 (not a Core host)
/usr/bin/python3     = Python 3.14.7, pytest 9.1.0, system paho-mqtt 1.6.1
pinned venv          = ~/.venvs/aegis-idea3-core: Python 3.14.7, pytest 9.1.1, paho-mqtt 2.1.0
                       (matches requirements.txt / requirements-dev.txt pins)
default python3      = ~/.platformio/penv (PlatformIO venv, no pytest) — not a test interpreter
ruff                 = 0.16.2 (requirements-dev pins 0.16.3)
node / npm           = v24.16.0 / 11.13.0
PlatformIO Core      = 6.1.19; platform espressif32 7.0.1;
                       framework-arduinoespressif32 3.20017.241212 (Arduino-ESP32 2.0.17);
                       toolchain-xtensa-esp32 8.4.0+2021r2-patch5 (xtensa-esp32-elf-gcc 8.4.0)
host g++             = GCC 16.2.1; OpenSSL 3.6.4; mosquitto 2.1.2 binary (no service used)
```

```text
ruff check aegis_soc tests --no-cache                          = PASS
python -m compileall -q aegis_soc tests                        = PASS (pycache prefix outside the tree)
/usr/bin/python3 -m pytest -p no:cacheprovider -q              = 8 failed, 340 passed, 6 skipped
~/.venvs/aegis-idea3-core/bin/python -m pytest ... -q          = 0 failed, 348 passed, 6 skipped
~/.venvs/aegis-idea3-core/bin/python -m pytest tests/test_mqtt_client.py = 8 passed
web: npx vitest run                                            = 30 files, 545 passed, 0 failed
node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
                                                               = PASS, 2 pre-existing canvas owner warnings
node --test tests/*.test.mjs                                   = 63 passed, 0 failed
```

The eight system-interpreter failures were re-proved on this main:

- all eight are in `tests/test_mqtt_client.py`;
- each raises `AttributeError: module 'paho.mqtt.client' has no attribute 'CallbackAPIVersion'`;
- the same tests pass under the repository-pinned paho-mqtt 2.1.0.

Their class is therefore **PRE-EXISTING ENVIRONMENTAL**.

## 2. Reconciliation of prior read-only P4 planning against merged main

### 2.1 Provenance

The earlier Phase 4 planning packages came from read-only chat sessions and
were never recorded in the repository or the vault. This design reconstructs
them from four sources:

- the binding decision list in the Phase 4 implementation kickoff;
- the R1, R3, R7, R8, R13, R15, R16, and R18 closeouts;
- the Phase 1 decision package's D1, D2, and D4 design scope;
- the source on `2742be27`.

Music supplied the binding validation order and the OD dispositions at G1
approval (§18).

### 2.2 Source facts on `2742be27` that Protocol v1 replaces

| # | Current fact (file) | Why it is insufficient |
|---|---|---|
| F1 | ESP32 connects with `WiFiClient` to `172.20.10.2:1883`; the Core's default port is `1883` (`firmware/src/main.cpp`, `aegis_soc/config.py`) | plaintext MQTT |
| F2 | one shared key, `SECRET_HMAC_KEY` / `AEGIS_HMAC_SECRET`, with a `DEMO_SECRET` fallback | no direction separation; a demo fallback |
| F3 | signing string `value|nonce|ts` (`security.py`, `main.cpp`) | ambiguous delimiter concatenation; no domain, device, or topic binding |
| F4 | nonce is `uuid4()[:8]` (32 bits); the device keeps a RAM ring of 20 nonces | weak ID space; replay protection is lost on device reboot |
| F5 | ACK and STATUS are unsigned JSON objects | the Core cannot authenticate device evidence |
| F6 | firmware answers unauthenticated input with `BAD_HMAC` / `BAD_FORMAT` ACKs | unauthenticated input produces device output |
| F7 | `MQTTManager._on_message` marks the device seen and forwards ACK/STATUS before any authentication; a STATUS without `state` becomes `NORMAL` | liveness, state, and evidence come from unauthenticated or malformed data |
| F8 | ESP32 time comes from `pool.ntp.org` / `time.nist.gov` in a blocking loop with no holdover limit | not Core-local trusted time (D1) |
| F9 | the Core sends heartbeats whatever the state of its own clock | violates R7 |
| F10 | GUI Telegram `/restore <PIN>` issues `RESTORE_UPLINK` with `origin="telegram"` | violates R8 and D4 |
| F11 | client ID is random (`AEGIS-ESP32-<rand>`); the paho client uses defaults | identities are neither fixed nor distinct |
| F12 | the Core subscribes to the unauthenticated `aegis/attacker_ip` | incompatible with the exact two-identity ACL (OD-4) |
| F13 | PubSubClient keeps its default 256-byte buffer | a signed v1 STATUS does not fit (R15) |

The ledger keeps the firmware correlation value in its `nonce` column. The
shared contract fixture lists `detail: {"nonce": …}` under `invalidEntries`,
so the correlation ID never leaves the Core. The IDEA3 Web evidence validator
accepts any stable reason code matching `^[A-Z][A-Z0-9_]{0,63}$`, and its
runtime-status normalizer drops unknown issue codes.

### 2.3 Stale facts reconciled

- IDEA3 text saying the K3 IDEA1 window is ACTIVE on Draft PR #130 is stale. PR #130 merged at `7022641`. Whether a live IDEA1 window is active (S5.8) is **NOT PROVEN**. That text lives in the merged Phase 2 design and in the dated Phase 2 status section, both kept as history.
- The Phase 3 canonical block says `PR133 = OPEN / READY` and `PUB_D6_REVIEW = NOT_RECORDED`. Both are superseded by §1.
- The accepted Python baseline was `326 passed` on the PR #132 main. On this main it is `340 passed`.

## 3. Binding architecture and closeouts

```text
MQTT 3.1.1 | QoS 0 | non-retained | clean sessions | no offline command queue
TLS-only Production MQTT | no Production port 1883
exact-topic deny-by-default ACL | distinct Core and ESP32 broker identities
Protocol v1 fixed JSON array envelope | deterministic length-prefixed signing input
two independent per-device HMAC keys | CORE_TO_DEVICE and DEVICE_TO_CORE signing domains
signed COMMAND / HEARTBEAT / ACK / STATUS
authentication before any Core liveness/state/evidence effect
128-bit message IDs | durable per-device uint64 command sequence
durable Core ACK/STATUS replay protection | trusted-time model
no automatic RESTORE | D4 RESTORE authority unchanged
Requested != Published != ACK != Executed != Relay Confirmation != Physical Evidence
validation order: §6 (Music, G1 continuation)
```

| ID | Closeout (BINDING, approved at G1) |
|---|---|
| R1 | `rssi_dbm` is the only signed numeric field; its range is `-127..0` |
| R3 | protocol enum sets are fixed and fail closed |
| R7 | the Core sends no HEARTBEAT while its time is UNTRUSTED; SYNCED and HOLDOVER behave as §5 |
| R8 | Production Telegram `/restore` is refused; RESTORE authority stays D4 Core-local only |
| R13 | cross-database commits use the fixed ordering in §7; a failure after the MQTT publish (the point of no return) becomes `OUTCOME_UNKNOWN` |
| R15 | firmware calls `setBufferSize(768)` and checks the return value; a failure fails readiness and never continues silently |
| R16 | no Phase 3 or Phase 4 live rollout before the Phase 4 repository PR is merged |
| R18 | ESP32 time holdover is at most 300 s; the SNTP sync interval is 60 s |

## 4. Protocol v1 wire contract

### 4.1 Transport profile (BINDING)

- MQTT 3.1.1 only.
  - Core: `protocol=MQTTv311`, `clean_session=True`, fixed client ID.
  - ESP32: PubSubClient's MQTT 3.1.1 CONNECT with the clean-session flag.
- Every publish uses QoS 0 with `retain=false`. Every subscription is QoS 0.
- There is no Last Will, no persistent session, and no broker queueing. A device that is offline never receives an old COMMAND.
- The Core drops any inbound message with the retain flag set (TRANSPORT stage). The broker also sets `retain_available false`.
- `Published` means only that the Core's MQTT client accepted the QoS 0 frame.

### 4.2 Topics (APPROVED)

```text
aegis/idea3/v1/<device_id>/command     Core   -> ESP32   COMMAND
aegis/idea3/v1/<device_id>/heartbeat   Core   -> ESP32   HEARTBEAT
aegis/idea3/v1/<device_id>/ack         ESP32  -> Core    ACK
aegis/idea3/v1/<device_id>/status      ESP32  -> Core    STATUS
```

Phase 4 configures exactly one device. Stores are keyed by `device_id`.

### 4.3 Envelope and canonical grammar (BINDING form; APPROVED layout)

Every message is one JSON array. Element 0 is the unsigned version integer.
Every other element is a string. The element count and order are fixed per
kind, and the MAC is always the last element.

```text
COMMAND   (9)  [1,"COMMAND",device_id,msg_id,seq,issued_at,expires_at,action,mac]
HEARTBEAT (6)  [1,"HEARTBEAT",device_id,msg_id,issued_at,mac]
ACK       (9)  [1,"ACK",device_id,msg_id,device_time,ack_for_msg_id,ack_for_seq,result,mac]
STATUS   (14)  [1,"STATUS",device_id,msg_id,device_time,time_trust,output_state,reason,
                cmd_msg_id,cmd_seq,device_seq_hwm,rssi_dbm,heap_free,mac]
```

The wire grammar is deliberately smaller than JSON. Python and C++ implement
this exact tokenizer; neither uses a general JSON parser:

```text
message = "[" version *( "," string ) "]"
version = "0" / ( %x31-39 0*9DIGIT )
string  = DQUOTE *( %x20-21 / %x23-5B / %x5D-7E ) DQUOTE
```

The grammar rules out:

- whitespace and escape sequences;
- non-ASCII bytes;
- nested values, other literals, and numbers other than element 0.

A payload is at most 512 bytes. Each string's text is identical to its
transmitted bytes, which makes the signing input deterministic.

### 4.4 Field grammar (APPROVED; R1 and R3 applied)

| Field type | Grammar / range | Used by |
|---|---|---|
| `kind` | `[A-Z_]{1,16}` (equality with the expected kind is checked in PAYLOAD) | element 1 |
| `device` | `[a-z0-9][a-z0-9-]{1,30}[a-z0-9]` | `device_id` |
| `msgid` | `[0-9a-f]{32}`, not all zeros | `msg_id`, `ack_for_msg_id` |
| `msgid_opt` | `msgid` or empty `""` | `cmd_msg_id` |
| `u64` | `0|[1-9][0-9]{0,19}` and ≤ 18446744073709551615 | times, `cmd_seq`, `device_seq_hwm` |
| `seq` | `u64` and ≥ 1 | `seq`, `ack_for_seq` |
| `rssi` (R1) | `0|-[1-9][0-9]{0,2}`, value ≥ −127 | `rssi_dbm` |
| `u32` | `0|[1-9][0-9]{0,9}` and ≤ 4294967295 | `heap_free` |
| `mac` | `[0-9a-f]{64}` | last element |
| `action` (R3) | `CUT_UPLINK`, `RESTORE_UPLINK` | COMMAND |
| `result` (R3) | `ACCEPTED`, `REJECTED_EXPIRED`, `REJECTED_SEQUENCE`, `REJECTED_PERSIST` | ACK |
| `time_trust` (R3) | `SYNCED`, `HOLDOVER`, `UNTRUSTED` | STATUS |
| `output_state` (R3) | `NORMAL`, `LOCKDOWN` | STATUS |
| `reason` (R3) | `BOOT`, `PERIODIC`, `COMMAND`, `DEADMAN`, `BOOT_GRACE`, `SEQUENCE_REJECTED` | STATUS |

No sign is permitted anywhere except `rssi_dbm`.

Consistency rules, checked in the PAYLOAD stage before AUTH:

- **COMMAND:**
  - `issued_at ≥ TIME_FLOOR` (`1789430400`, 2026-09-15T00:00:00Z);
  - `issued_at < expires_at`;
  - `expires_at − issued_at ≤ 30`.
- **HEARTBEAT:** `issued_at ≥ TIME_FLOOR`.
- **ACK:** `device_time ≥ TIME_FLOOR`.
- **STATUS:**
  - `time_trust = UNTRUSTED` holds exactly when `device_time = "0"`; any other `device_time` is ≥ `TIME_FLOOR`;
  - `reason ∈ {COMMAND, SEQUENCE_REJECTED}` holds exactly when `cmd_msg_id` is non-empty;
  - an empty `cmd_msg_id` requires `cmd_seq = "0"`, and a non-empty one requires `cmd_seq ≥ 1`;
  - `reason = SEQUENCE_REJECTED` requires `device_seq_hwm ≥ cmd_seq`.

`output_state` is the device's **commanded GPIO output state**. It is never
relay confirmation or physical evidence.

`REJECTED_EXPIRED` covers any command outside the authenticated time window:
stale, expired, or future-dated.

### 4.5 Deterministic signing input and MAC (BINDING form; APPROVED bytes)

```text
LP(x)          = uint32_big_endian(len(x)) || x          (x = ASCII bytes)
signing_input  = LP("AEGIS-IDEA3-PROTOCOL")
               || LP(domain)                               ("CORE_TO_DEVICE" | "DEVICE_TO_CORE")
               || LP(topic)                                (exact topic string)
               || LP(e0) || LP(e1) || ... || LP(e[n-2])    (every element except mac; e0 = "1")
mac            = lowercase_hex(HMAC-SHA256(K_domain, signing_input))
```

- COMMAND and HEARTBEAT use domain `CORE_TO_DEVICE` with `K_C2D`.
- ACK and STATUS use domain `DEVICE_TO_CORE` with `K_D2C`.
- The kind fixes the domain.
- Verification compares the 32 raw MAC bytes in constant time: Python `hmac.compare_digest`, and a firmware fixed-length XOR accumulator.

### 4.6 Keys (BINDING: two independent per-device keys)

- `K_C2D` and `K_D2C` are independent 32-byte random keys, per device. Live generation and provisioning are deferred and forbidden in this phase.
- Core key files hold 64 lowercase hex characters. They are named by `AEGIS_P1_C2D_KEY_FILE` and `AEGIS_P1_D2C_KEY_FILE`. The future host location is `/etc/aegis-idea3/protocol/`, as a deferred value.
- The firmware reads its keys from the git-ignored `secrets.h`. The repository example holds placeholders only.
- Key loading refuses a key that:
  - is missing, unreadable, the wrong length, or not hex;
  - is all zeros;
  - equals the other key;
  - equals a golden-vector test key;
  - or derives from `DEMO_SECRET`.
- A key never appears in any log or error message.

Limitation: the scheme is symmetric. Both the Core and the device hold both
keys, so two keys give direction separation, anti-reflection, and independent
rotation, but not forgery resistance against a compromised endpoint.

### 4.7 Message IDs and sequences (BINDING)

- `msg_id` is 16 CSPRNG bytes: Python `secrets.token_bytes`, ESP32 `esp_fill_random`.
- Core command sequence:
  - it is a durable, per-device uint64, committed before publish (§7);
  - it is never reused, even after a failed publish;
  - the allocator stops at 2^63−1, the SQLite signed-integer limit, and fails closed there.
- The ESP32 keeps its last accepted `seq` in NVS. It accepts only a strictly greater `seq`, and it persists that value before actuation.
- **Sequence reconciliation (OD-6, BINDING restriction).** The Core moves its allocator **forward only**, to `device_seq_hwm + 1`, from a STATUS that meets all of the following:
  - it is signed and valid;
  - it names the configured device;
  - it passes schema and payload checks;
  - it is time-valid;
  - it is replay-accepted;
  - it has `reason = SEQUENCE_REJECTED`, with `cmd_msg_id` and `cmd_seq` identifying the Core's **currently open published command**.

  Any other STATUS never advances the sequence. That includes unsigned, stale, replayed, malformed, wrong-device, periodic, and uncorrelated STATUS.

### 4.8 Size

- The largest v1 STATUS is about 330 bytes.
- Both sides reject payloads over 512 bytes.
- The 768-byte PubSubClient buffer (R15) covers the topic, the header, and the payload.

## 5. Trusted-time model (BINDING model; APPROVED mechanics)

### 5.1 Core

`TrustedClock` reports one of:

- `SYNCED`: `adjtimex()` read-only probe returns a value other than `TIME_ERROR`, `STA_UNSYNC` is clear, `maxerror ≤ 1 s`, and wall time ≥ `TIME_FLOOR`.
- `HOLDOVER`: not synced now, but the last SYNCED observation was ≤ 300 s ago (monotonic clock), and wall time ≥ `TIME_FLOOR`.
- `UNTRUSTED`: otherwise.
- `UNKNOWN`: the probe is unavailable (non-Linux, or an error) and no SYNCED observation exists. It is treated as untrusted.

Protocol time is trusted only in `SYNCED` or `HOLDOVER`. The state is exposed
as the allowlisted `time` status dimension. `UNTRUSTED` and `UNKNOWN` raise the
issue `CORE_TIME_UNTRUSTED`, and a live runtime becomes `DEGRADED`.

While time is not trusted:

- **no HEARTBEAT** is published (R7), so the ESP32 dead-man switch produces a fail-secure CUT within 60 s;
- **no COMMAND** is published, and dispatch does not claim (it reports `UNAVAILABLE`);
- trust lost between claim and publish becomes `FAILED` with `CORE_TIME_UNTRUSTED` (OD-7);
- inbound ACK and STATUS are rejected at the TIME stage, with no effect.

### 5.2 ESP32

- The sole SNTP server is the Core AP address, a deferred value.
- `sntp_set_sync_interval(60000)` runs before SNTP starts, and a sync callback records `millis()`.
- The device uses UTC.
- Time states:
  - `SYNCED`: ≤ 120 s since the last successful sync;
  - `HOLDOVER`: ≤ 300 s since the last sync (R18);
  - `UNTRUSTED`: otherwise, or no sync yet, or time below the floor.
- While `UNTRUSTED`, COMMAND and HEARTBEAT are rejected at the TIME stage **silently**, before AUTH. The dead-man switch keeps running. STATUS carries `UNTRUSTED` and `device_time="0"`.
- MQTT TLS starts only after the first trusted sync.

## 6. Validation order (BINDING — Music, G1 continuation)

Load-bearing rule:

> No liveness, relay state, notification, pending state, dispatch evidence,
> replay-store row, sequence change, or audit hash-chain row is produced
> before AUTH. On the device, no ACK and no GPIO change is produced before
> AUTH.

Every rejection before AUTH only increments a bounded in-memory counter.

### 6.1 ESP32, inbound COMMAND

| # | Stage / code | Check | On failure |
|---|---|---|---|
| 1 | TRANSPORT `TOPIC`/`SIZE` | exact subscribed topic; 1–512 bytes | drop |
| 2 | SCHEMA `SYNTAX`/`ARITY`/`FIELD` | grammar §4.3, arity, per-field types §4.4 | drop, no ACK |
| 3 | PAYLOAD `VERSION`/`KIND`/`DEVICE`/`CONSISTENCY` | version 1, kind, configured device, action enum, consistency rules | drop, no ACK |
| 4 | TIME `LOCAL_TIME_UNTRUSTED` | device time SYNCED or HOLDOVER | drop, no ACK |
| 5 | AUTH `MAC` | CORE_TO_DEVICE HMAC with `K_C2D`, compared in constant time | drop, no ACK |
| 6 | SKEW `FUTURE`/`STALE` | `issued_at ≤ now + 2`; `now ≤ expires_at` | signed `ACK REJECTED_EXPIRED` |
| 7 | REPLAY `SEQUENCE` | `seq > NVS hwm` | signed `ACK REJECTED_SEQUENCE` + signed STATUS `SEQUENCE_REJECTED` |
| 8 | PERSIST `PERSIST` | NVS write of `seq` | RESTORE: signed `ACK REJECTED_PERSIST`, no GPIO. CUT: continue (fail-secure) |
| 9 | EFFECT | GPIO actuation, then signed `ACK ACCEPTED`, then signed STATUS `COMMAND` | — |

HEARTBEAT follows stages 1–5. It then applies:

- SKEW: `abs(now − issued_at) ≤ 30`, with at most 2 s into the future;
- REPLAY: `issued_at` greater than the last accepted heartbeat's `issued_at`.

Every heartbeat failure is silent. The only effect is a dead-man timer reset,
never RESTORE.

### 6.2 Core, inbound ACK / STATUS

| # | Stage / code | Check | On failure |
|---|---|---|---|
| 1 | TRANSPORT `TOPIC`/`RETAINED`/`SIZE` | configured device's `ack`/`status` topic; retain false; 1–512 bytes | drop; count |
| 2 | SCHEMA `SYNTAX`/`ARITY`/`FIELD` | grammar, arity, field types | drop; count |
| 3 | PAYLOAD `VERSION`/`KIND`/`DEVICE`/`CONSISTENCY` | version, kind, device, payload rules | drop; count |
| 4 | TIME `LOCAL_TIME_UNTRUSTED` | Core time SYNCED or HOLDOVER | drop; count |
| 5 | AUTH `MAC` | DEVICE_TO_CORE HMAC with `K_D2C`, constant time | drop; count |
| 6 | SKEW `DEVICE_TIME_UNTRUSTED`/`FUTURE`/`STALE` | STATUS `time_trust ≠ UNTRUSTED`; `device_time ≤ now + 2`; `now − device_time ≤ 30` | drop; audit |
| 7 | REPLAY `DUPLICATE`/`STORE` | durable committed insert of `(device_id, msg_id)` | drop; audit |
| 8 | EFFECT | liveness → relay state → notification → pending state → dispatch evidence | — |

Rules in the EFFECT stage:

- An ACK drives pending state and dispatch evidence only when it consumes the Core's open command: matching `ack_for_msg_id`/`ack_for_seq`, exactly once.
- A STATUS confirms a command only when `reason = COMMAND` and its `cmd_msg_id`/`cmd_seq` identify an open Core command. A periodic STATUS never becomes command confirmation, even if its `output_state` matches.
- An uncorrelated but authenticated message still counts for liveness only.
- A malformed STATUS never defaults to `NORMAL`. It is dropped at SCHEMA or PAYLOAD.

## 7. Durable Core state and ordered commits (R13)

`core-protocol.sqlite3` is the durable protocol store:

- path: `RuntimePaths.protocol_db`, overridable by `AEGIS_CORE_PROTOCOL_DB_PATH`;
- Production location: `/var/lib/aegis-idea3/data/core-protocol.sqlite3`;
- never under `/run` or the runtime directory; preflight enforces this;
- WAL mode, `synchronous=FULL`.

Tables:

- `protocol_sequence(device_id PK, last_allocated_seq)`;
- `protocol_commands(msg_id PK, device_id, seq, action, issued_at, expires_at, state, ack_result, ack_msg_id, status_correlated)`, where `state ∈ {RESERVED, PUBLISHED, NOT_PUBLISHED, ACK_CONSUMED, CLOSED}`;
- `protocol_seen_d2c(device_id, msg_id, kind, received_at, PK(device_id, msg_id))`, pruned after 600 s. Replay is also bounded by the 30 s skew window and one-shot correlation.

Outbound order. Each step is committed before the next:

1. The dispatch ledger records `CLAIMED`.
2. The protocol store reserves `seq` and `msg_id` as `RESERVED`.
3. MQTT QoS 0 publish. This is the point of no return.
4. The protocol store records `PUBLISHED`.
5. The dispatch ledger records `PUBLISHED`, with the ledger `nonce` column holding `msg_id`.

Failure handling:

- A failure before step 3 means nothing was sent. The reserved `seq` is burned and never reused. The action becomes `FAILED`, or `OUTCOME_UNKNOWN` on restart.
- A failure after step 3 becomes `OUTCOME_UNKNOWN`. It is never retried or redispatched.
- On restart, every `RESERVED`, `PUBLISHED`, and `ACK_CONSUMED` command becomes `CLOSED`. Later ACKs for them are ignored. No evidence row is deleted.

Inbound: the replay-store insert commits before any ledger ACK/STATUS write
and before the audit write.

Server evidence mapping:

- `ACK ACCEPTED` → `record_ack(msg_id, "OK")`.
- `REJECTED_*` → the existing `OUTCOME_UNKNOWN / ACK_NOT_OK`.
- A correlated `STATUS LOCKDOWN` → the existing `STATUS` stage.

`CommandResult.nonce` carries the 128-bit `msg_id`. `CommandResult.seq` and
`CommandResult.reason_code` are added.

## 8. MQTT TLS, broker identities, and ACL (BINDING; APPROVED form)

### 8.1 Broker profile (repository template only)

`deploy/mosquitto/aegis-idea3-mosquitto.conf.example`:

```text
per_listener_settings false
allow_anonymous false
password_file <DEFERRED>
acl_file      <DEFERRED>
persistence false
retain_available false
queue_qos0_messages false
allow_zero_length_clientid false
max_packet_size 1024
max_keepalive 60

listener 8883 127.0.0.1
listener 8883 <AEGIS_AP_ADDRESS>
  (each) cafile/certfile/keyfile <DEFERRED>; tls_version tlsv1.2; require_certificate false
```

The template has no 1883 listener, no unbound or wildcard (`0.0.0.0`, `::`)
listener, no websockets, and no listener without TLS material.

The broker certificate comes from a **dedicated MQTT CA**, separate from the
K10 machine-client CA and the HUB browser CA.

### 8.2 Identities (BINDING: distinct)

| Identity | Username / fixed client ID | Credential |
|---|---|---|
| Core | `idea3-core` | distinct password (deferred) |
| ESP32 | `idea3-dev-<device_id>` | distinct password (deferred) |

Core client:

- `ssl.create_default_context(cafile=…)`: minimum TLS 1.2, `check_hostname=True`, `CERT_REQUIRED`, passed through `tls_set_context`;
- `tls_insecure_set` is never called, and there is no plaintext fallback.

The `production` profile additionally refuses:

- port 1883, TLS disabled, or a missing CA;
- anonymous (empty) credentials;
- a Core username equal to, or prefixed like, a device identity.

ESP32 client: `WiFiClientSecure::setCACert`, and `setInsecure()` is never
called.

### 8.3 Exact-topic ACL (BINDING: deny by default)

```text
user idea3-core
topic write aegis/idea3/v1/<device_id>/command
topic write aegis/idea3/v1/<device_id>/heartbeat
topic read  aegis/idea3/v1/<device_id>/ack
topic read  aegis/idea3/v1/<device_id>/status

user idea3-dev-<device_id>
topic read  aegis/idea3/v1/<device_id>/command
topic read  aegis/idea3/v1/<device_id>/heartbeat
topic write aegis/idea3/v1/<device_id>/ack
topic write aegis/idea3/v1/<device_id>/status
```

- The ACL has no `pattern` line, no `+` or `#`, no `readwrite`, no anonymous block, no `$SYS` entry, and no `aegis/attacker_ip` (OD-4).
- A refused subscription marks the broker as not ready.

## 9. RESTORE authority (R8; D4 unchanged)

- The controller keeps `authorize_restore` and adds a RESTORE-origin allowlist:
  - the desktop default is `{"gui", "recovery-wizard"}`, which are local PIN-gated flows in non-production profiles;
  - `telegram` can never be allowlisted: the constructor rejects it, and `issue()` refuses it.
- The headless supervisor, in any profile, constructs the controller with an **empty** RESTORE allowlist. Production therefore has no RESTORE path until D4's `aegisctl restore` exists (Phase 5–6).
- The GUI's Telegram `/restore` handler refuses and never calls the controller, and the help text no longer advertises it.
- None of the following ever sends RESTORE:
  - reconnect, restart, or shutdown;
  - certificate recovery or time recovery;
  - heartbeat recovery or boot;
  - the Web.

## 10. Firmware migration (repository only)

- `firmware/lib/aegis_protocol/` is a portable C++17 library with no Arduino headers. It holds:
  - the §4.3 tokenizer and the §4.4 validators;
  - the signing-input builder, the encoder, and a constant-time compare;
  - a crypto-backend interface: mbedTLS on ESP32, OpenSSL for host tests;
  - `DeviceCore`, the §6.1 device decision pipeline, with injected time, persistence, and actuation callbacks.
- `main.cpp` is thin glue around that library:
  - a non-blocking Wi-Fi → Core SNTP → TLS MQTT connection sequence;
  - `setBufferSize(768)` with its return checked (R15);
  - fixed client ID and QoS 0 subscriptions;
  - signed ACK and STATUS, NVS persistence, and STATUS every 30 s.
- The following are preserved unchanged:
  - the relay output is driven to CUT before the pin is enabled;
  - `isLockedDown = true` at boot;
  - the 60 s dead-man switch and 90 s boot grace;
  - no automatic RESTORE.
- `platformio.ini` pins `espressif32@7.0.1` and `knolleary/PubSubClient@2.8`. ArduinoJson is removed.
- Evidence classes:
  - host parity and `DeviceCore` tests (g++ with OpenSSL): LOCAL VERIFIED;
  - `pio run`, compile only, in a scratch copy with a placeholder `secrets.h`: COMPILE VERIFIED, or recorded as NOT RUN;
  - flashing, serial access, and reset are forbidden.

Live cutover is documented only, as an atomic sequence: provision keys and
credentials, install the broker TLS/ACL, release the Core, flash, verify.

- It needs the D4 recovery path, or a separately authorized interim procedure.
- During the window the relay stays in its boot CUT output.

## 11. Broker migration and legacy v0 (OD-3)

- Broker: repository templates only (§8), parsed by static tests and exercised by an isolated loopback test (OD-5).
- Legacy v0:
  - v1 is the default in every profile;
  - v0 is reachable only with an explicit `AEGIS_PROTOCOL_MODE=legacy-v0-lab`, and only outside `production`. The `production` profile refuses it in preflight;
  - a process runs exactly one protocol mode, so v1 never parses v0 frames;
  - the legacy isolation keeps the malformed-STATUS fix too: a STATUS without a valid state is dropped, never treated as `NORMAL`;
  - v0 is removed after live v1 cutover evidence exists.

## 12. Evidence ladder (BINDING)

```text
Requested != Published != ACK != Executed != Relay Confirmation != Physical Evidence
```

| Rung | Protocol v1 meaning | Recorded as |
|---|---|---|
| Requested | Admin accepted, or a local operator request | server action / audit |
| Published | Core client accepted the QoS 0 frame | ledger `PUBLISHED` |
| ACK | authenticated device acceptance (`ACCEPTED`): receipt only | ledger `ACK` (`ackCode OK`) |
| Executed | authenticated, fresh STATUS `reason=COMMAND` correlated to the open command, reporting the commanded GPIO output state | ledger `STATUS` |
| Relay Confirmation | not observable by Protocol v1 | never emitted |
| Physical Evidence | owner-observed hardware evidence only | never emitted |

The LOCKDOWN detail text reads "device reports LOCKDOWN output state".
`CORE_TIME_UNTRUSTED` only ever means "not sent". It never means containment,
CUT executed, relay truth, or physical evidence.

## 13. Negative controls

The controls are the union of the plan's NC-P4 list and Music's G1
continuation list. They are executed by a restoring harness that proves no
residue.

## 14. Rollback

- Repository: a human revert or non-merge. `core-protocol.sqlite3` is additive, and the existing ledger schema is unchanged.
- Future live rollback: stop `aegis-idea3-core.service`. The device then fails secure through the dead-man switch.
  - The rollback target is fail-secure CUT, not v0.
  - Recovery needs D4.

## 15. Open decisions at G1

Resolved; see §18.

## 16. Deferred live values

The following are never generated, guessed, or committed:

- the Core AP: SSID and PSK, subnet and gateway address (which is also the NTP and broker address);
- the ESP32 `device_id`, the board's MAC address, and its serial port;
- the MQTT CA, the broker certificate and key, and its SANs;
- the broker hostname and the password file;
- the broker passwords;
- per-device `K_C2D` and `K_D2C`;
- the key-file host locations and permissions;
- NTP serving, AP binding, and the firewall (D1/D6);
- the maintenance window;
- the flash procedure and interim recovery (the D4 dependency);
- K12 reboot persistence on the Core host.

## 17. Ownership and stop rules

Owned and changeable:

- `IDEA3-AEGIS_Lockdown/**`;
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` and `idea3-moc.md`;
- one new Music receipt, at final closeout.

Forbidden:

- `IDEA1*/**`, `IDEA2*/**`, `AEGIS_Camera/**`, `HUB-AEGIS_Entry/**`;
- `gateway/**`, `postgres/**`, `shared/**`, `infrastructure/**`;
- root `docker-compose*`, root `.env.example`, `.github/**`, `scripts/**`, root `tests/**`;
- historical receipts, including the PR #132 and PR #133 receipts;
- merged Phase 1–3 specs and plans.

`INTEGRATION_CHANGE_REQUIRED = NO`.

## 18. G1 approval record and binding amendments (2026-09-15)

Music approved G1 for repository implementation and authorized autonomous
continuation, with live work, Production mutation, and deployment remaining
**NO**.

| Decision | Disposition | Effect in this design |
|---|---|---|
| OD-1 / R-items | APPROVED | §3 table, using Music's wording |
| OD-2 validation order | `OD_2_DISPOSITION=ACCEPTED_CONSERVATIVE_REPOSITORY_DEFAULT` | §6 uses Music's continuation order. It differs from the G1 draft in three ways: local time confidence precedes HMAC on both sides; a TIME-stage rejection is silent (no `REJECTED_TIME_UNTRUSTED` ACK, which is removed from R3's result enum); and ACK gains an authenticated `device_time` so the Core can apply authenticated skew to ACK |
| OD-3 legacy v0 | `OD_3_DISPOSITION=ACCEPTED_CONSERVATIVE_REPOSITORY_DEFAULT` | §11: v1 default; v0 only as an explicit non-production lab opt-in; `production` fails closed |
| OD-4 attacker_ip | APPROVED | excluded from the ACL and from v1 subscriptions in every profile; the lab detector feed exists only in legacy lab mode |
| OD-5 test TLS | APPROVED | throwaway certificates for isolated automated tests only; never Production credentials or evidence |
| OD-6 sequence resync | APPROVED WITH RESTRICTION | §4.7: only a correlated `SEQUENCE_REJECTED` STATUS for the open command; this adds the `SEQUENCE_REJECTED` reason and an ESP32 STATUS emitted on sequence rejection |
| OD-7 CORE_TIME_UNTRUSTED | APPROVED | `FAILED` reason code only, meaning "not sent". The IDEA3 Web validator already accepts it by pattern, so only the shared fixture and tests change |

Further amendments applied during the G1 continuation:

- Time states are `SYNCED`, `HOLDOVER`, and `UNTRUSTED` on both sides. The Core's holdover mirrors R18's 300 s.
- The malformed STATUS → `NORMAL` fallback is removed (F7).
- Both implementations use one hand-written grammar instead of a general JSON parser, so the Python/C++ stage and code parity is exact.

Neither OD-2 nor OD-3 meets any HARD STOP condition:

- neither broadens RESTORE authority or weakens TLS, signature, replay, or time validation;
- neither introduces a live value or touches a cross-owner file;
- both are fail-closed.
