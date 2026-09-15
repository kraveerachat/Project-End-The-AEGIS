# AEGIS IDEA3 PR11 Phase 4 Protocol v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.
>
> **Gate:** G1 was APPROVED on 2026-09-15, and Music authorized autonomous
> repository continuation. Design §18 records the binding decisions and the
> continuation validation order. Where this plan's G1-draft details differ
> from design §18, §6, or §4, the design governs. Three changes follow:
>
> - Task 13 (the legacy mode) is folded into Tasks 6–7, because the controller
>   and the MQTT client need the mode switch.
> - Task 9 is fixture and tests only, because the IDEA3 Web validator already
>   accepts `CORE_TIME_UNTRUSTED` by pattern.
> - The negative-control matrix adds Music's continuation list, executed by a
>   restoring harness.

**Goal:** implement Protocol v1 on both sides — the Python Core and the ESP32
firmware — with Core-side TLS MQTT, deny-by-default broker templates, durable
replay/sequence state, and trusted time. Prove it locally with golden vectors,
Python/C++ parity, and negative controls, without any live or Production
mutation.

**Architecture:** the pure codec `aegis_soc/protocol_v1.py` is shared by an
inbound verifier and the command controller. Durable state lives in a new
`core-protocol.sqlite3`, committed in order around the existing dispatch
ledger (R13). A portable C++17 library under `firmware/lib/aegis_protocol/`
mirrors the codec and is proven byte-identical against the same golden vectors.

**Tech stack:**
- Python 3.14, pytest, Ruff, SQLite, stdlib `ssl`/`hmac`/`secrets`/`ctypes`, paho-mqtt 2.1.0;
- C++17 on the Arduino-ESP32 2.0.17 framework, with mbedTLS, PubSubClient 2.8, and Preferences/NVS;
- host g++ with OpenSSL for parity;
- Mosquitto 2.x configuration syntax.

**Spec:**
`IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-15-idea3-pr11-phase4-protocol-v1-design.md`

## Global constraints

- `PHASE4_LIVE_ALLOWED=NO`, `PRODUCTION_MUTATION_AUTHORIZED=NO`, `IDEA3_PRODUCTION_DEPLOYED=NO`.
- Forbidden live actions:
  - no `systemctl`, hostapd, DHCP/DNS, firewall, IP forwarding, or Mosquitto service change;
  - no real certificate, credential, or key generation or provisioning;
  - no flashing, serial access, `pio run -t upload`, `pio device monitor`, or ESP32 reset;
  - no Wi-Fi/AP mutation, CUT, RESTORE, reboot, or Production SSH.
- Only test keys may appear in the repository. They are the golden-vector keys, and they are denylisted by preflight.
- Never commit `secrets.h`, private keys, generated certificates, or `.pio/`.
- Owned paths are the only change surface (design §17). A cross-owner need stops that path with `INTEGRATION_CHANGE_REQUIRED=YES`.
- Interpreters:
  - `/usr/bin/python3` remains the baseline-comparable interpreter;
  - paho-dependent adapter tests are *also* run under `~/.venvs/aegis-idea3-core/bin/python` (paho 2.1.0);
  - every new pure-logic module must be testable without paho.
- Accepted baseline, in environment E-LOCAL (design §1.1):
  - `/usr/bin/python3`: 8 failed / 340 passed / 6 skipped. The 8 failures are the `test_mqtt_client.py` paho 1.6.1 environmental class.
  - Pinned venv: 0 failed / 348 passed / 6 skipped.
  - Vitest: 545/545. Vault validation PASS (2 pre-existing warnings). Node suites: 63/63.
- Any new failure is a regression unless it is proven to be in the same environmental class, and each such exception is recorded individually.
- Every RED step records the exact failing command and count before any production code is written.

---

## Change map

| Task | Files (all under `IDEA3-AEGIS_Lockdown/` unless noted) | Responsibility |
|---|---|---|
| 0 | — | re-verify base, baseline, open-decision answers |
| 1 | `tests/protocol_v1_reference.py`, `tests/fixtures/protocol-v1-vectors.json`, `tests/test_protocol_v1_vectors.py` | independent reference + golden vectors |
| 2 | `aegis_soc/protocol_v1.py`, `tests/test_protocol_v1.py` | codec, grammar, signing, keys |
| 3 | `aegis_soc/trusted_time.py`, `tests/test_trusted_time.py` | Core trusted-time model |
| 4 | `aegis_soc/protocol_store.py`, `aegis_soc/paths.py`, `tests/test_protocol_store.py`, `tests/test_paths.py` | durable sequence, command, and seen state |
| 5 | `aegis_soc/protocol_inbound.py`, `tests/test_protocol_inbound.py` | Core validation order, auth before effect |
| 6 | `aegis_soc/controller.py`, `aegis_soc/gui.py`, `tests/test_controller.py`, `tests/test_restore_authority.py` | v1 COMMAND/HEARTBEAT, R7, R8 |
| 7 | `aegis_soc/mqtt_client.py`, `aegis_soc/config.py`, `aegis_soc/runtime.py`, `tests/test_mqtt_client.py`, `tests/test_mqtt_tls.py`, `tests/test_runtime.py` | TLS client, exact topics, retain drop, preflight, `time` status |
| 8 | `aegis_soc/supervisor.py`, `aegis_soc/dispatch_worker.py`, `aegis_soc/dispatch_ledger.py`, `tests/test_dispatch_boundary.py`, `tests/test_dispatch_ledger.py`, `tests/test_protocol_ordering.py` | msg_id correlation, R13 ordering, time-gated dispatch, evidence ladder |
| 9 (OD-7) | `tests/fixtures/dispatch-contract.json`, `web/server/domain/dispatch.js` (path confirmed in Step 1), `web/tests/server/*.test.js`, `tests/test_dispatch_contract.py` | `CORE_TIME_UNTRUSTED` FAILED reason code |
| 10 | `deploy/mosquitto/aegis-idea3-mosquitto.conf.example`, `deploy/mosquitto/aegis-idea3-mosquitto.acl.example`, `deploy/aegis-idea3-core.env.example`, `tests/test_broker_config.py`, `tests/test_broker_loopback.py` (OD-5) | broker TLS/ACL/identity templates |
| 11 | `firmware/lib/aegis_protocol/*`, `firmware/test/native/protocol_parity_main.cpp`, `firmware/test/native/crypto_openssl.cpp`, `tests/test_firmware_protocol_parity.py` | portable C++ codec + parity |
| 12 | `firmware/src/main.cpp`, `firmware/src/secrets.h.example`, `firmware/platformio.ini`, `firmware/lib/aegis_protocol/crypto_mbedtls.cpp`, `tests/test_firmware_contract.py` | firmware v1 migration + compile |
| 13 (OD-3) | `aegis_soc/security.py`, `aegis_soc/config.py`, `aegis_soc/runtime.py`, `tests/test_protocol_mode.py`, `sim_auto_detector.py`, `detector.py` (OD-4 scope only) | legacy v0 disposition, production refusal |
| 14 | — (temporary mutations only) | negative controls NC-P4-1 to NC-P4-14 |
| 15 | `README.md`, `firmware/README.md`, `docs/operations/production-runtime.md`, `.env.example` | protocol, cutover, and rollback documentation |
| 16 | `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`, `.../idea3/idea3-moc.md`, one new Music receipt | full bar, canonical closeout, Draft PR |

---

### Task 0: Re-verify the base and record decisions

- [ ] **Step 1:** Run:

  ```bash
  git fetch origin
  git status --short
  git branch --show-current
  git rev-parse HEAD
  git rev-parse origin/main
  ```

  If `origin/main` has advanced, run `git merge origin/main` (never rebase), resolve deliberately, and repeat Step 2.
- [ ] **Step 2:** Re-run the baseline commands in design §1.1 and compare the counts.
- [ ] **Step 3:** Record Music's OD-1 to OD-7 answers in the design (§15) and the canonical Session Register before Task 1. Any OD answered differently from the recommendation revises the affected task *before* its RED step.

### Task 1: Golden vectors and an independent reference

**Files:** create `tests/protocol_v1_reference.py`, `tests/fixtures/protocol-v1-vectors.json`, and `tests/test_protocol_v1_vectors.py`.

**Interfaces:**

- Produces:
  - a fixture document `{"schema": "aegis-idea3-protocol-v1-vectors/1", "testOnlyKeys": {...}, "valid": [...], "invalid": [...], "hmacPrimitive": [...]}`;
  - each valid vector holds `id`, `direction`, `topic`, `elements`, `signingInputHex`, `mac`, and `wire`;
  - each invalid vector holds `id`, `topic`, `wire`, `expectStage` (`TRANSPORT|PARSE|AUTH|FRESHNESS|REPLAY|SEMANTIC`), `expectCode`, and an optional `context` (for example a clock value or a replay pre-state).
- The reference is a deliberately literal, spec-only implementation. It uses `struct.pack(">I", len)`, `hmac.new(..., hashlib.sha256)`, and `json.dumps(separators=(",", ":"))`, and **never imports `aegis_soc`**. This avoids self-certification.

- [ ] **Step 1: Write the vector tests.** Assert:
  - every valid vector's `signingInputHex` and `mac` equal the reference output, and `wire` equals the reference compact serialization;
  - the test keys are exactly `bytes(range(0x00, 0x20))` (`K_C2D`) and `bytes(range(0x20, 0x40))` (`K_D2C`), labelled `TEST ONLY`;
  - RFC 4231 test cases 1 and 2 reproduce through the reference HMAC;
  - N-21 holds two element lists with equal plain concatenation but different splits (`["ab", "c"]` vs `["a", "bc"]`); their signing inputs and MACs differ.
- [ ] **Step 2: RED.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_protocol_v1_vectors.py`. Expected: collection or file-not-found failure, because the fixture and reference do not exist yet.
- [ ] **Step 3:** Write the reference and generate the fixture once with a one-off script run from the scratchpad. The script is not committed; the fixture is. Review the fixture by eye for the vector set below.
- [ ] **Step 4: GREEN.** Run the same command. Expected: all pass.

**Golden vector set:**

| ID | Content |
|---|---|
| V-CMD-CUT | COMMAND `CUT_UPLINK`, seq 1, TTL 30 |
| V-CMD-RESTORE | COMMAND `RESTORE_UPLINK`, seq 2 |
| V-CMD-SEQMAX | COMMAND with seq `18446744073709551615` (wire-valid; Core allocator refuses it separately) |
| V-HB | HEARTBEAT |
| V-ACK-OK | ACK `ACCEPTED` |
| V-ACK-SEQ | ACK `REJECTED_SEQUENCE` |
| V-ACK-TIME | ACK `REJECTED_TIME_UNTRUSTED` |
| V-ST-PERIODIC | STATUS `PERIODIC`, `NORMAL`, rssi `-67` |
| V-ST-COMMAND | STATUS `COMMAND`, `LOCKDOWN`, correlated `cmd_msg_id`/`cmd_seq` |
| V-ST-UNTRUSTED | STATUS `UNTRUSTED`, `device_time "0"`, rssi `-127`, heap `0` |
| V-ST-RSSI0 | STATUS with rssi `0` |

| ID | Negative case (expected stage) |
|---|---|
| N-01 | C2D message verified with `K_D2C` (AUTH) |
| N-02 | signed with the D2C domain but sent on a C2D topic (AUTH) |
| N-03 | topic swap: valid STATUS republished on the `ack` topic (PARSE: type/topic) |
| N-04 | one-bit MAC flip (AUTH) |
| N-05 | uppercase MAC hex (PARSE) |
| N-06 | extra element (PARSE) |
| N-07 | missing element (PARSE) |
| N-08 | non-canonical integers `"01"`, `"+1"`, `"1.0"`, and JSON number `5` where a string is required (PARSE) |
| N-09 | rssi `"+5"`, `"-0"`, `"-128"`, `"1"` (PARSE, R1) |
| N-10 | `-` sign on a non-rssi field (PARSE) |
| N-11 | whitespace in the JSON (PARSE) |
| N-12 | backslash escape (PARSE) |
| N-13 | version `2` (PARSE) |
| N-14 | wrong `device_id` (PARSE) |
| N-15 | all-zero `msg_id` (PARSE) |
| N-16 | uint64 overflow `18446744073709551616` (PARSE) |
| N-17 | 513-byte payload (TRANSPORT) |
| N-18 | non-ASCII byte (PARSE) |
| N-19 | enum outside the R3 set, e.g. action `REBOOT` (PARSE) |
| N-20 | TTL 31, and `expires_at ≤ issued_at` (SEMANTIC) |
| N-21 | length-prefix ambiguity pair (above) |
| O-01 | bad MAC **and** stale time → must report AUTH, not FRESHNESS (proves auth-first order) |
| O-02 | bad MAC **and** duplicate `msg_id` → AUTH, and the seen table is unchanged |
| O-03 | valid MAC, stale time → FRESHNESS, and the seen table is unchanged |
| O-04 | valid MAC, fresh, duplicate `msg_id` → REPLAY |

### Task 2: Python codec

**Files:** create `aegis_soc/protocol_v1.py` and `tests/test_protocol_v1.py`.

**Interfaces:**

- Produces:
  - constants: `PROTOCOL_LABEL`, `DOMAIN_C2D`, `DOMAIN_D2C`, `MAX_PAYLOAD_BYTES = 512`, `TIME_FLOOR = 1789430400`, the fixed enum frozensets, and `Stage`;
  - `topics(device_id) -> Topics`;
  - `signing_input(domain, topic, elements) -> bytes`;
  - `encode_command(...)`, `encode_heartbeat(...)`, `encode_ack(...)`, `encode_status(...) -> bytes`;
  - `parse(raw, *, topic, device_id) -> Parsed | Rejection`;
  - `verify(parsed, keys) -> bool`, which uses `hmac.compare_digest`;
  - `ProtocolKeys(c2d, d2c)` and `load_protocol_keys(c2d_path, d2c_path, *, forbid) -> ProtocolKeys`;
  - `new_msg_id() -> str`.
- Consumes: the Task 1 fixture.

- [ ] **Step 1: Write failing tests.** Cover:
  - all valid vectors round-trip byte-exactly;
  - every PARSE/AUTH negative vector is rejected at the stated stage and code;
  - `verify` calls `hmac.compare_digest` (spy);
  - `load_protocol_keys` rejects a missing file, wrong length, non-hex, all-zero, equal keys, the golden-vector test keys, and `DEMO_SECRET`-derived keys, and the error text never includes key bytes;
  - `new_msg_id()` returns 32 lowercase hex characters and never all zeros (patched RNG).
- [ ] **Step 2: RED.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_protocol_v1.py`. Expected: `ModuleNotFoundError: aegis_soc.protocol_v1`.
- [ ] **Step 3:** Implement the minimum codec.
- [ ] **Step 4: GREEN.** Run the Task 1 and Task 2 commands. Expected: all pass.

### Task 3: Core trusted time

**Files:** create `aegis_soc/trusted_time.py` and `tests/test_trusted_time.py`.

**Interfaces:**

- Produces:
  - `TimeTrust` (`TRUSTED|UNTRUSTED|UNKNOWN`);
  - `adjtimex_probe() -> ClockSync(synced: bool, maxerror_us: int) | None` (Linux `ctypes` libc `adjtimex`; `None` elsewhere);
  - `TrustedClock(probe, wall=time.time, floor=TIME_FLOOR, max_error_us=1_000_000)` with `.state()` and `.trusted_now() -> int | None`.

- [ ] **Step 1: Write failing tests.** With an injected probe, cover:
  - synced, small error, above the floor → `TRUSTED`;
  - `STA_UNSYNC` or `TIME_ERROR` → `UNTRUSTED`;
  - `maxerror` too large → `UNTRUSTED`;
  - below the floor → `UNTRUSTED`;
  - probe `None` or raising → `UNKNOWN`;
  - `trusted_now()` returns `None` unless `TRUSTED`.

  Add one real `adjtimex_probe()` smoke test on Linux that only asserts the return type. It must never set the clock (a mode-0 read only; the test asserts `modes == 0`).
- [ ] **Step 2: RED.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_trusted_time.py`. Expected: module missing.
- [ ] **Step 3:** Implement the module.
- [ ] **Step 4: GREEN.** Run the same command. Expected: all pass.

### Task 4: Durable protocol store

**Files:** create `aegis_soc/protocol_store.py` and `tests/test_protocol_store.py`; modify `aegis_soc/paths.py` and `tests/test_paths.py`.

**Interfaces:**

- Produces:
  - `ProtocolStore(path, *, clock)` with:
    - `reserve_command(device_id, action, issued_at, expires_at) -> Reserved(seq, msg_id)`;
    - `mark_published(msg_id)`;
    - `consume_ack(device_id, ack_for_msg_id, ack_for_seq, result, ack_msg_id) -> bool` (one-shot);
    - `record_seen(device_id, msg_id, type) -> bool` (`False` on a duplicate);
    - `resync_forward(device_id, device_hwm) -> bool` (OD-6);
    - `prune_seen(older_than_sec=600)`;
    - `close_open_commands_after_restart() -> list[str]`;
  - `RuntimePaths.protocol_db` (`<data>/core-protocol.sqlite3`), with the `AEGIS_CORE_PROTOCOL_DB_PATH` override (absolute paths only).

- [ ] **Step 1: Write failing tests.** Using temp DB files and closing/reopening between steps, assert:
  - the sequence is strictly increasing across reopen;
  - a burned (reserved, unpublished) sequence is never reused;
  - the allocator refuses above `2**63 - 1` and allocates nothing;
  - a seen `msg_id` persists across reopen and a duplicate returns `False`;
  - `consume_ack` succeeds once, and fails for a wrong seq, a closed command, or after restart closure;
  - `resync_forward` never lowers the sequence and is idempotent;
  - `PRAGMA synchronous` is `FULL` and journal mode is WAL;
  - `protocol_db` resolves under `/var/lib/aegis-idea3/data` with the Phase 3 env example and never under `/run`.
- [ ] **Step 2: RED.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_protocol_store.py tests/test_paths.py`. Expected: module missing, plus the `protocol_db` attribute failure.
- [ ] **Step 3:** Implement the store and the path property.
- [ ] **Step 4: GREEN.** Run the same command, plus `tests/test_core_service.py` (the Phase 3 path contract must stay green).

### Task 5: Core inbound verifier (validation order)

**Files:** create `aegis_soc/protocol_inbound.py` and `tests/test_protocol_inbound.py`.

**Interfaces:**

- Produces: `InboundVerifier(keys, device_id, store, clock, open_command_lookup)`, with `.process(topic, payload: bytes, retain: bool) -> InboundResult(accepted, stage, code, message)` and bounded in-memory `counters`.
- The verifier has no paho import, so it runs under `/usr/bin/python3`.

- [ ] **Step 1: Write failing tests.** Cover:
  - every invalid vector yields its `expectStage`;
  - O-01 and O-02 report AUTH, and the store's seen table and sequence are byte-identical before and after (row counts plus the DB file hash);
  - O-03 reports FRESHNESS with no seen-table insert;
  - O-04 reports REPLAY;
  - a retained message → TRANSPORT;
  - an untrusted Core clock → STATUS and ACK rejected at FRESHNESS;
  - an ACK with no matching open command, the wrong `ack_for_seq`, or arriving after `ACK_TIMEOUT_SEC` → FRESHNESS;
  - an accepted STATUS returns the parsed message, and an accepted ACK consumes its command exactly once;
  - no audit or DB write happens for pre-AUTH rejections (spy on `db.log_event`).
- [ ] **Step 2: RED.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_protocol_inbound.py`.
- [ ] **Step 3:** Implement the verifier.
- [ ] **Step 4: GREEN.** Run the same command.

### Task 6: Controller v1, R7, and R8

**Files:** modify `aegis_soc/controller.py`, `aegis_soc/gui.py`, and `tests/test_controller.py`; create `tests/test_restore_authority.py`.

**Interfaces:**

- `AegisCommandController(mqtt, *, dry_run, audit_log, codec_context=None, restore_origins=frozenset({"gui", "recovery-wizard"}))`.
- `codec_context` bundles the keys, device, store, and `TrustedClock`.
- `issue()` reserves (commit), publishes the v1 COMMAND, and marks it published. `CommandResult.nonce` carries the `msg_id`, and a new `seq` field is added.
- `send_heartbeat()` returns `False` without publishing when the clock is not `TRUSTED` (R7).

- [ ] **Step 1: Write failing tests.** Cover:
  - the published payload parses and verifies as a v1 COMMAND on the exact command topic, with QoS 0 and `retain=False`;
  - an untrusted clock → no publish for either COMMAND or HEARTBEAT, and an audited `TIME_UNTRUSTED`;
  - `origin="telegram"` with `authorize_restore=True` → refused and audited, nothing reserved;
  - an unknown origin is refused, and `production` settings produce an empty RESTORE allowlist;
  - the GUI `_process_tg_command("/restore 1234")` sends a refusal reply and never calls `send_command` (Tk-free, via a stub-attribute instance, the same pattern as the existing GUI tests);
  - the help text no longer contains `/restore`;
  - dry run → `WOULD_SEND` with no reserve and no publish.
- [ ] **Step 2: RED.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_controller.py tests/test_restore_authority.py`.
- [ ] **Step 3:** Implement the controller and GUI changes.
- [ ] **Step 4: GREEN.** Run the same command, plus `tests/test_core.py`.

### Task 7: MQTT client TLS, topics, preflight, and time status

**Files:** modify `aegis_soc/mqtt_client.py`, `aegis_soc/config.py`, `aegis_soc/runtime.py`, `tests/test_mqtt_client.py`, and `tests/test_runtime.py`; create `tests/test_mqtt_tls.py`.

**Interfaces:**

- `build_mqtt_ssl_context(ca_file) -> ssl.SSLContext`: TLS 1.2 minimum, `check_hostname`, `CERT_REQUIRED`.
- `MQTTManager` uses:
  - fixed client ID `idea3-core`, `MQTTv311`, `clean_session=True`;
  - `tls_set_context`, with `tls_insecure_set` never called;
  - QoS 0 subscriptions to exactly the two D2C topics;
  - a SUBACK failure → broker state not ready.
- `_on_message` delegates to `InboundVerifier` and fires callbacks only for accepted results. Liveness comes only from accepted results.
- Production preflight errors:
  - port 1883, TLS disabled, or a missing CA/key file;
  - invalid keys, or test-vector keys;
  - a missing `AEGIS_P1_DEVICE_ID`.
- `RuntimeStatus.time` and the safe projection value `time` ∈ `{TRUSTED, UNTRUSTED, UNKNOWN}`, with issue `CORE_TIME_UNTRUSTED`.

- [ ] **Step 1: Write failing tests.**
  - `test_mqtt_tls.py`: context properties, plus a pure-function check of the preflight matrix, which runs under both interpreters.
  - `test_mqtt_client.py` (adapter): an unauthenticated STATUS on the status topic never marks the device online; an authenticated fresh STATUS does; a retained message is dropped; the legacy topics are not subscribed.
  - `test_runtime.py`: the `time` projection and allowlist.
- [ ] **Step 2: RED.** Run:

  ```bash
  /usr/bin/python3 -m pytest -p no:cacheprovider -q \
    tests/test_mqtt_tls.py tests/test_runtime.py
  ~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q \
    tests/test_mqtt_client.py
  ```

- [ ] **Step 3:** Implement the changes.
- [ ] **Step 4: GREEN.** Run the same commands. Under `/usr/bin/python3`, `test_mqtt_client.py` stays in its recorded environmental class. Any *new* test in that file that fails there only because of paho 1.6.1 is listed by name.

### Task 8: Supervisor/dispatch integration, R13, and the evidence ladder

**Files:** modify `aegis_soc/supervisor.py`, `aegis_soc/dispatch_worker.py`, `aegis_soc/dispatch_ledger.py`, `tests/test_dispatch_boundary.py`, and `tests/test_dispatch_ledger.py`; create `tests/test_protocol_ordering.py`.

**Interfaces:**

- Correlation uses the 32-hex `msg_id` (the ledger `nonce` column; no schema change).
- ACK mapping: `ACCEPTED` → `record_ack(msg_id, "OK")`; `REJECTED_*` → `"REJECTED"`, which is the existing `ACK_NOT_OK` path.
- The worker does not claim while the time is not TRUSTED, and its status is `UNAVAILABLE`.
- Trust lost after the claim and before publish → `mark_failed(action_id, "CORE_TIME_UNTRUSTED")` (OD-7; if OD-7 is declined, use `OUTCOME_UNKNOWN` with no Web change).
- On startup, `ProtocolStore.close_open_commands_after_restart()` runs alongside the ledger recovery.
- The LOCKDOWN detail text becomes "device reports LOCKDOWN output state".

- [ ] **Step 1: Write failing tests.** In `test_protocol_ordering.py`, inject failures at each numbered step of design §7 using a fault-injecting store/ledger/MQTT. Assert:
  - a failure before publish → no MQTT frame, the burned sequence is never reused, and the ledger is `FAILED` or recovers to `OUTCOME_UNKNOWN`;
  - a failure after publish → `OUTCOME_UNKNOWN` after restart and no republish;
  - the inbound seen-table insert precedes the ledger ACK write (call-order spy);
  - no test path yields `CONTAINED`, `RELAY_EVIDENCE`, or an executed/physical claim;
  - an untrusted clock → no claim, and dispatch status is `UNAVAILABLE`.
- [ ] **Step 2: RED.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_protocol_ordering.py tests/test_dispatch_boundary.py tests/test_dispatch_ledger.py`.
- [ ] **Step 3:** Implement the changes.
- [ ] **Step 4: GREEN.** Run the same command, plus `tests/test_dispatch_contract.py tests/test_dispatch_client.py tests/test_production_runtime.py tests/test_core_service.py`.

### Task 9: Web↔Core contract reason code (only if OD-7 = YES)

**Files:** modify `tests/fixtures/dispatch-contract.json` and `tests/test_dispatch_contract.py`, plus the IDEA3 Web dispatch-evidence allowlist and its Vitest tests. Step 1 locates the exact Web file.

- [ ] **Step 1:** Run `git grep -n "MQTT_UNAVAILABLE" -- web/server web/tests tests/fixtures` to find the allowlist and every test that enumerates it.
- [ ] **Step 2: Write failing tests.** A `FAILED` entry with `reasonCode: "CORE_TIME_UNTRUSTED"` is valid, and an unlisted code is still invalid. Run:

  ```bash
  (cd web && npx vitest run tests/server/dispatchLedger.test.js tests/server/machineRoutes.test.js)
  /usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_dispatch_contract.py
  ```

  Expected: RED.
- [ ] **Step 3:** Add the code to the fixture and to the Web allowlist.
- [ ] **Step 4: GREEN.** Run the same command, then the full `(cd web && npx vitest run)`.

### Task 10: Broker TLS/ACL/identity templates

**Files:** create `deploy/mosquitto/aegis-idea3-mosquitto.conf.example`, `deploy/mosquitto/aegis-idea3-mosquitto.acl.example`, `tests/test_broker_config.py`, and, if OD-5 = YES, `tests/test_broker_loopback.py`; modify `deploy/aegis-idea3-core.env.example` (non-secret key/CA *path* variables and `AEGIS_BROKER_PORT=8883`).

- [ ] **Step 1: Write failing static tests.** Parse the configuration line by line, not by substring. Assert:
  - exactly two `listener` lines, both port 8883, bound to `127.0.0.1` and the AP placeholder;
  - every listener has `cafile`, `certfile`, `keyfile`, and `tls_version tlsv1.2`;
  - no `1883` anywhere, and no `protocol websockets`;
  - `allow_anonymous false`, `persistence false`, `retain_available false`, `per_listener_settings false`, and `allow_zero_length_clientid false`.

  Parse the ACL and assert:
  - exactly the eight §8.3 lines under exactly two users;
  - no `pattern`, `+`, `#`, `readwrite`, or `$SYS`, and no top-level topic outside a user block.

  Cross-check that the ACL topics equal `protocol_v1.topics(<placeholder>)`. Assert the env example contains no secret values.
- [ ] **Step 2 (OD-5 = YES only):** Write the loopback integration test. It is skipped with a stated reason unless `mosquitto` and `openssl` exist.
  - At test time it generates a throwaway CA and server certificate in `tmp_path`, the Core and device passwords, and a `mosquitto_passwd` file.
  - It renders the templates with `127.0.0.1` and a random high port and starts `mosquitto -c` as a child process.
  - It asserts:
    - the Core identity can publish `command` but its publish to `status` is not delivered;
    - the device identity cannot subscribe to `ack`;
    - an anonymous or plaintext connection is refused;
    - a retained publish disconnects the client;
    - a wrong-CA client fails TLS.
  - It kills the broker and deletes `tmp_path`; a residue assertion checks that no process and no files remain.
  - The test never touches a system Mosquitto service or the default port.
- [ ] **Step 3: RED.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_broker_config.py`, and `~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q tests/test_broker_loopback.py` for OD-5.
- [ ] **Step 4:** Write the templates.
- [ ] **Step 5: GREEN.** Run the same commands.

### Task 11: Portable C++ protocol library and parity

**Files:** create `firmware/lib/aegis_protocol/aegis_protocol.h`, `aegis_protocol.cpp`, and `crypto_backend.h`; `firmware/test/native/protocol_parity_main.cpp` and `crypto_openssl.cpp`; and `tests/test_firmware_protocol_parity.py`.

**Interfaces:**

- C++:
  - `aegis::p1::buildSigningInput(domain, topic, elements, out)`;
  - `aegis::p1::encode*()`;
  - `aegis::p1::parse(raw, len, topic, deviceId, Parsed&) -> Stage`;
  - `aegis::p1::verify(parsed, key32) -> bool`;
  - `aegis::p1::ctEqual32(a, b)`.
- No dynamic allocation in `parse`/`verify`: fixed buffers sized from `MAX_PAYLOAD_BYTES`.
- The parity driver reads a flat TSV that pytest derives from the vector fixture. For each vector it prints `id \t stage \t code \t signingInputHex \t mac`.

- [ ] **Step 1: Write the failing parity test.** Pytest compiles:

  ```bash
  g++ -std=c++17 -Wall -Wextra -Werror -O1 \
    firmware/lib/aegis_protocol/aegis_protocol.cpp \
    firmware/test/native/crypto_openssl.cpp \
    firmware/test/native/protocol_parity_main.cpp -lcrypto
  ```

  The compile goes to `tmp_path`, which then runs against every valid and invalid vector. The test asserts that the output equals the Python reference results exactly. A static assertion checks that `verify` calls `ctEqual32` and that no `memcmp`/`strcmp`/`==` compares MACs. The test is skipped with a stated reason if `g++` or `openssl/hmac.h` is absent; a skip is recorded as SKIP, never PASS.
- [ ] **Step 2: RED.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_firmware_protocol_parity.py`. Expected: compile failure because the sources are missing.
- [ ] **Step 3:** Implement the library and the host-only OpenSSL backend.
- [ ] **Step 4: GREEN.** Run the same command. Also compile with `-fsanitize=address,undefined` and run all vectors plus a bounded seeded fuzz (10 000 mutated vector payloads). Expected: no sanitizer report, and every mutated input rejected or equal to a valid vector.

### Task 12: Firmware v1 migration and compile

**Files:** modify `firmware/src/main.cpp`, `firmware/src/secrets.h.example`, `firmware/platformio.ini`, and `tests/test_firmware_contract.py`; create `firmware/lib/aegis_protocol/crypto_mbedtls.cpp`.

- [ ] **Step 1: Write failing structural tests.** Strip comments, then use function-scoped parsing in the style of the existing firmware tests. Assert:
  - `WiFiClientSecure` with `setCACert` is used; there is no `setInsecure` and no plain `WiFiClient` for MQTT; no `1883` appears;
  - `setBufferSize(768)` is called and its result is checked, with the failure branch not calling `mqtt.connect`;
  - `sntp_set_sync_interval(60000)` precedes `configTime`, and there is no `pool.ntp.org` or `time.nist.gov`;
  - the holdover constant is `300000` ms;
  - the MQTT connect happens only after the trusted-time state;
  - the client ID is fixed from the identity (no `random(`); subscriptions are exactly the two C2D topics at QoS 0; every `publish(` uses `retained=false`;
  - in the command handler, `aegis::p1::verify` precedes every `setLockdown(`, `sendAck(`, and `lastHeartbeatMs =`;
  - the NVS `putULong64` precedes `setLockdown(` for commands, and the RESTORE branch returns before actuation when the persist fails;
  - there is no `sendAck` in the parse- or auth-failure branches;
  - the existing fail-secure boot test stays unchanged, and there is no RESTORE in the dead-man, heartbeat, or boot paths;
  - `secrets.h.example` contains placeholders only (no 64-hex value, no PEM body);
  - `platformio.ini` pins `espressif32@7.0.1` and `PubSubClient@2.8`, and has no `upload_protocol` change task.
- [ ] **Step 2: RED.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_firmware_contract.py`.
- [ ] **Step 3:** Implement `main.cpp` v1 and the mbedTLS backend.
- [ ] **Step 4: GREEN.** Run the same command, plus the Task 11 parity test.
- [ ] **Step 5: Compile only.** Copy `firmware/` to the scratchpad and create a placeholder `secrets.h` there from the example. Its values must be obviously fake and include a syntactically valid dummy PEM header/footer without key material. Then run:

  ```bash
  pio run -d <scratch-copy> -e esp32dev
  ```

  Record flash/RAM usage. Never pass `-t upload` or `-t monitor`, and never open a serial port. A missing library download is recorded as a limitation (COMPILE NOT RUN), not as a pass. Delete the scratch copy afterwards and check for residue.

### Task 13: Legacy v0 disposition (per OD-3) and OD-4 scope

**Files:** modify `aegis_soc/security.py`, `aegis_soc/config.py`, and `aegis_soc/runtime.py`; create `tests/test_protocol_mode.py`; touch `sim_auto_detector.py` and `detector.py` only when OD-4 requires it.

- [ ] **Step 1: Write failing tests.** Cover:
  - the default mode is `v1`;
  - `AEGIS_PROTOCOL_MODE=legacy-v0-lab` is accepted only for non-production profiles;
  - `production` + `legacy-v0-lab` → a preflight error;
  - an invalid mode → an error;
  - in v1 mode `security.create_secure_payload` is never called (spy);
  - under OD-4, the `production` profile does not subscribe to `aegis/attacker_ip`.
- [ ] **Step 2: RED**, **Step 3: implement**, **Step 4: GREEN.** Run `/usr/bin/python3 -m pytest -p no:cacheprovider -q tests/test_protocol_mode.py tests/test_runtime.py`.

### Task 14: Negative controls

Each control follows the same loop:

1. Apply the single mutation in the working tree only.
2. Run the named test and record the RED output.
3. Restore the source with `git checkout -- <file>` (or edit it back for new files).
4. Re-run the test and confirm GREEN.
5. Check residue: `git status --short` and `git diff` match the pre-control state.

Mutations are never committed.

| ID | Mutation | Must fail |
|---|---|---|
| NC-P4-1 | `InboundVerifier` updates liveness/seen before AUTH | `test_protocol_inbound.py` O-01/O-02 |
| NC-P4-2 | a single key for both directions (D2C = C2D) | `test_protocol_v1.py` N-01; key-load equal-key test |
| NC-P4-3 | domain tag omitted from the signing input | vectors (MAC mismatch); N-02 |
| NC-P4-4 | length prefix replaced by plain concatenation | N-21 and all vectors |
| NC-P4-5 | `record_seen` not committed (in-memory only) | store reopen replay test |
| NC-P4-6 | sequence reserved after publish instead of before | `test_protocol_ordering.py` |
| NC-P4-7 | heartbeat sent while UNTRUSTED | `test_controller.py` R7 |
| NC-P4-8 | Telegram origin added to the RESTORE allowlist | `test_restore_authority.py` |
| NC-P4-9 | retained inbound accepted | `test_protocol_inbound.py` retain test |
| NC-P4-10 | `listener 1883` added to the template | `test_broker_config.py` |
| NC-P4-11 | `topic readwrite aegis/idea3/v1/#` added to the ACL | `test_broker_config.py` |
| NC-P4-12 | firmware MAC compare replaced by `memcmp` | parity static constant-time assertion |
| NC-P4-13 | firmware NVS persist moved after `setLockdown` | `test_firmware_contract.py` |
| NC-P4-14 | ACK `ACCEPTED` promoted to a `STATUS`/executed ledger stage | `test_protocol_ordering.py` evidence-ladder test |

Also re-run the S2 negative-control drivers, unchanged:

```bash
/usr/bin/python3 deploy/production-like-negative-controls.py
/usr/bin/python3 deploy/production-like-acceptance.py
```

They run sequentially, never concurrently. If v1 changes their assumptions, the adaptation stays inside IDEA3 and is recorded; if they cannot run locally, the reason is recorded.

### Task 15: Documentation

- [ ] Update:
  - the `README.md` MQTT topic table and security model (v1, marking v0 lab-only per OD-3);
  - `firmware/README.md`;
  - `.env.example` (no secrets; production port 8883);
  - `docs/operations/production-runtime.md`: add a "Phase 4 Protocol v1 — prepared, not deployed" section covering deferred live values, the key/credential provisioning prerequisites, the atomic cutover sequence, and the rollback target (fail-secure CUT, not v0), plus the D4 dependency for recovery. Mark every command there as not run.
- [ ] Do not edit the historical Phase 1–3 specs or plans. Run a reference scan:

  ```bash
  git grep -n -E "1883|aegis/lockdown/cmd|AEGIS_HMAC_SECRET" -- IDEA3-AEGIS_Lockdown ':!**/node_modules/**'
  ```

  Classify every hit as current (update) or historical (keep truthful).

### Task 16: Full bar, canonical closeout, and Draft PR

- [ ] **Step 1: Full Python bar.**

  ```bash
  ruff check aegis_soc tests --no-cache
  PYTHONPYCACHEPREFIX=<scratch> python -m compileall -q aegis_soc tests
  PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m pytest -p no:cacheprovider -q
  PYTHONDONTWRITEBYTECODE=1 ~/.venvs/aegis-idea3-core/bin/python -m pytest -p no:cacheprovider -q
  ```

  Every count delta is explained by the added tests. There are zero new failures under the pinned venv, and only the named environmental class under system Python.
- [ ] **Step 2: Web and repository checks.**

  ```bash
  (cd web && npx vitest run)
  node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
  node --test tests/*.test.mjs
  git diff --check
  git diff --name-status origin/main...HEAD
  ```

  Also run a secrets scan of added lines: no PEM private block, no 64-hex value outside the test-vector fixture, no password.
- [ ] **Step 3: Scope audit.** No path outside design §17. No historical receipt or Phase 1–3 doc changed. No binary. No `.pio/`, `secrets.h`, or generated certificate.
- [ ] **Step 4: Canonical notes.** Update the Phase 4 Current Task, Session Register, and status dashboard in `idea3-status.md`, and refresh the `idea3-moc.md` entry-point summary. Use the evidence classes LOCAL VERIFIED, COMPILE VERIFIED, STATIC ONLY, and SKIP. Keep `PHASE4_LIVE_ALLOWED=NO` and every live gate.
- [ ] **Step 5: One receipt.** Create exactly one `90-Status/logs/<YYYY-MM-DD_HHMMSS>_music_idea3-pr11-phase4-protocol-v1.md` from `_template.md`, using the actual Asia/Bangkok closeout time.
- [ ] **Step 6: Draft PR.** Only with the owner's instruction to push: push the task branch, open a **Draft** PR with the policy block (`area: idea3`, `owner: music`, `integration-review: no`, unless a cross-owner path appeared), and run the collaboration-policy check. Request Kla as the IDEA3 GitHub reviewer. Never mark it Ready and never merge without the owner's instruction; never merge at all.

---

## Test matrix (traceability)

| ID | Requirement | Task / test |
|---|---|---|
| P4-T1 | fixed JSON array envelope, exact element counts | T1 vectors; T2 N-06/N-07 |
| P4-T2 | deterministic length-prefixed signing input | T1 N-21; T11 parity |
| P4-T3 | two independent keys, C2D/D2C domains | T2 N-01/N-02; key-load tests |
| P4-T4 | signed COMMAND/HEARTBEAT/ACK/STATUS | T1 V-*; T5; T12 |
| P4-T5 | auth before any Core liveness/state/evidence effect | T5 O-01/O-02; T7 adapter |
| P4-T6 | 128-bit msg IDs | T2 `new_msg_id`; N-15 |
| P4-T7 | durable per-device uint64 command sequence | T4; T12 NVS; V-CMD-SEQMAX |
| P4-T8 | durable Core ACK/STATUS replay protection | T4 reopen; T5 O-04 |
| P4-T9 | trusted time, R7, R18 | T3; T6; T12 |
| P4-T10 | MQTT 3.1.1, QoS 0, non-retained, clean sessions, no queue | T7; T10 |
| P4-T11 | TLS-only, no 1883 | T7 preflight; T10; T12 |
| P4-T12 | exact-topic deny-by-default ACL, distinct identities | T10 (+ OD-5 loopback) |
| P4-T13 | no automatic RESTORE; D4 unchanged; R8 | T6; T12 |
| P4-T14 | R13 ordered commits → OUTCOME_UNKNOWN | T8 |
| P4-T15 | evidence ladder, no promotion | T8; NC-P4-14 |
| P4-T16 | Python/firmware parity | T11 |
| P4-T17 | R1 rssi sign, R3 fixed enums | T1 N-09/N-10/N-19 |
| P4-T18 | R15 buffer 768 with checked return | T12 |
| P4-T19 | legacy v0 not reachable in production | T13 |

## Rollback

- Repository: a human revert or non-merge. `core-protocol.sqlite3` is additive, and the existing ledger schema is unchanged.
- Each task is a coherent checkpoint commit, so revert is possible per task before the PR merges.
- Live rollback is documentation only (design §14): the target is fail-secure CUT, not v0.

## Ownership boundaries

As design §17. The only potential shared-contract touch is OD-7, and it
stays inside IDEA3: the Web and Core are both Music-owned. No
`HUB-AEGIS_Entry/**`, `gateway/**`, `shared/**`, `infrastructure/**`, IDEA1,
IDEA2, root Compose, `.github/**`, `scripts/**`, historical receipt, or
Phase 1–3 document change is planned. `INTEGRATION_CHANGE_REQUIRED=NO`.
