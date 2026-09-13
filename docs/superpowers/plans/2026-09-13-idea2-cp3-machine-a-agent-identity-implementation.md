# AEGIS IDEA2 CP3 Machine A Agent Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated Machine A Windows Identity Agent that owns the Ed25519 application key and authenticates Monitor ingest while the interactive Detection Engine remains the sole webcam/AI owner and Detector B remains on explicitly bounded legacy authentication.

**Architecture:** Monitor adds a dual-mode, fail-closed authentication boundary for four internal write routes, with in-memory challenge, Agent-session, sequence, and nonce state backed by live registry revalidation. A separate Python Windows service owns DPAPI-protected key material, canonical signing, HTTPS transport, and a four-operation named pipe; the Detection Engine becomes a structured pipe client and never receives keys, signatures, or Agent sessions. CP3 authenticates physical provenance only and does not create browser association, logical producers, stream demand, or camera lifecycle behavior.

**Tech Stack:** Node.js ESM, Express 4, PostgreSQL 15, Node `crypto` Ed25519, Python 3, `cryptography`, `requests`, `pywin32`, Windows DPAPI and named pipes, `node:test`, Python `unittest`, Playwright, PowerShell 5.1+.

**Spec:** docs/superpowers/specs/2026-09-13-idea2-cp3-machine-a-agent-identity-design.md

## Global Constraints

- Work only on `codex/idea2-lr1-current-main-reconciliation`; use coherent commits on this branch and never push directly to `main`.
- Migrations 001–003 remain byte-identical. Migration 004 is additive and idempotent; it must not drop, truncate, recreate, or rewrite existing rows.
- Challenge TTL is 60 seconds. Agent session TTL is 10 minutes. Renewal begins with 2 minutes remaining.
- Request timestamps accept exactly `now - 30_000 <= timestamp_ms <= now + 10_000`; both boundaries pass.
- Request nonce is 128-bit random. Agent session ID is 256-bit random. Sequence is decimal uint64, starts at 1, and uses `BigInt` in JavaScript.
- Replay state uses a 64-sequence bitmap plus one-use nonce digests; challenge, session, sequence, and nonce state remain in process memory.
- Proof domains are exactly `AEGIS-AGENT-AUTH-V1`, `AEGIS-AGENT-HEARTBEAT-V1`, `AEGIS-ENGINE-DETECTION-V1`, `AEGIS-ENGINE-ALERT-V1`, and `AEGIS-ENGINE-CLIP-V1`.
- Auth routes are `POST /internal/agent-auth/challenge` and `POST /internal/agent-auth/verify`. Signed write routes are `POST /internal/heartbeat`, `/internal/detections`, `/internal/alerts`, and `/internal/clips`.
- Canonical bytes are UTF-8, LF-separated, without BOM or trailing LF. Signatures/tokens use unpadded Base64URL; tokens begin with ASCII alphanumeric. Hashes are 64 lowercase hexadecimal characters.
- Signed routes reject query strings. They hash exact transmitted raw body bytes captured under the existing 16 KiB JSON limit and still expose parsed JSON to handlers.
- A partial Agent-proof header set fails closed. A complete set selects Ed25519 only. Zero Agent-proof headers may enter legacy compatibility only when the relevant node mode allows it. No Agent proof error falls back to the shared key.
- `detection_nodes.ingest_auth_mode` values are exactly `legacy_shared_key` and `ed25519_required`; migration default is `legacy_shared_key`, and migration 004 changes no node-specific row.
- `req.verifiedNode` is server-derived. Body/query/header `nodeId`, `physicalCameraId`, hostname, IP, browser storage, or User-Agent never establishes identity.
- Ed25519 writes persist server-resolved physical provenance. Legacy writes remain `legacy_unverified` with nullable trusted provenance.
- The Identity Agent uses `AEGIS_AGENT_MONITOR_BASE_URL`, requires certificate-validated HTTPS, and never disables TLS verification.
- The private key is unrelated to SSH and must not enter the browser, Detection Engine, environment variables, logs, tests, receipts, Git, or Monitor.
- The Identity Agent runs as `NT SERVICE\AEGISIdentityAgent`; its DPAPI CurrentUser behavior must pass a human runtime preflight before real key generation. There is no LocalMachine, plaintext, or broader-ACL fallback.
- The Engine remains interactive and owns webcam/AI processing. Agent startup, auth, heartbeat, renewal, failures, and retries open no camera and create no stream demand.
- Machine identity fixes physical camera: A→physical A, B→physical B, C→physical C. Account identity fixes logical alias: `operator`→`CAM-01`, `operator2`→`CAM-02`.
- SOC remains passive. CP4 browser association and CP5 demand/producer/camera lifecycle are excluded.
- No UI, model, training, biometric data, camera device selection, Docker, gateway, Twingate, firewall, Production database, or Production runtime mutation is authorized by this coding plan.
- Human runtime gates are performed by the owner with ChatGPT guidance. Codex prepares source/scripts and stops at each named gate.
- One task branch, one eventual Pull Request, and exactly one immutable receipt at final task closeout. Intermediate tasks create checkpoints, not receipts.

---

## Checkpoint Strategy

Each task ends in a focused commit after its RED/GREEN cycle and scoped review. The executor stages named paths only, runs `git diff --cached --check` and `git diff --cached --name-status`, and records the resulting SHA in the next canonical documentation checkpoint. Full regressions are required at Tasks 4, 5, 7, 12, 14, 16, and 17; other tasks run focused plus directly affected suites. No checkpoint creates a receipt.

| Boundary | Commit intent | Full gate | Canonical status action |
|---|---|---|---|
| Tasks 1–2 | protocol vectors; migration/auth mode | Monitor registry + disposable PostgreSQL at Task 2 | record protocol/schema checkpoint SHA |
| Tasks 3–5 | state; Agent auth; request proof | full Monitor/UI-freeze/build at Tasks 4–5 | record Monitor authentication checkpoint SHA |
| Tasks 6–7 | provenance; Detector B transition | full Monitor/browser/build + PostgreSQL | record dual-mode ingest checkpoint SHA |
| Tasks 8–11 | Agent core; DPAPI; service; pipe | full Python + static Windows; H1 remains external | record Agent source checkpoint SHA and acceptance pending |
| Tasks 12–14 | Engine IPC; heartbeat; events | full Engine/Monitor + camera freeze | record Engine/Agent integration checkpoint SHA |
| Task 15 | Windows lifecycle tools | full Python/PowerShell static gates | record tooling checkpoint SHA |
| Task 16 | complete verification/security review | all source/disposable integration gates | record local verification SHA and remaining human gates |
| Task 17 | human acceptance preparation/closeout | H1–H10 evidence when authorized | one final receipt only at task closeout |

## Human Runtime Gates

These gates are not Codex execution steps. A human runs the named scripts/commands with ChatGPT guidance, captures redacted evidence, and stops on every abort condition.

### HUMAN RUNTIME GATE H1 — Service Identity and DPAPI Preflight

- **Prerequisites:** Tasks 9, 10, 11, and 15 source verified; elevated PowerShell; expected branch/SHA recorded; Docker/Production untouched; Identity Agent service installed but stopped; no application key exists.
- **Expected command:** `powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\identity-agent\invoke_dpapi_preflight.ps1 -ServiceName AEGISIdentityAgent -DataRoot 'C:\ProgramData\AEGIS\IdentityAgent'` from the verified installed source.
- **Evidence:** service SID/account, profile-loaded state, disposable round-trip digest equality, target owner/inheritance/explicit ACE summary, temporary artifact cleanup, exit code; never ciphertext/plaintext values.
- **PASS:** DPAPI CurrentUser protect/unprotect succeeds under `NT SERVICE\AEGISIdentityAgent`, profile remains usable across service restart, exact service-SID+SYSTEM ACL passes, and no marker remains.
- **ABORT:** impersonation/profile/DPAPI/DACL/restart/cleanup failure or any request for LocalMachine/plaintext/broader ACL.
- **Rollback:** stop/remove only the unkeyed Agent service and staged Agent directories; preserve existing Engine/tunnel/config.

### HUMAN RUNTIME GATE H2 — Real Encrypted Key Generation

- **Prerequisites:** H1 PASS marker matches current installed SHA, service identity, and data root; key path absent; owner explicitly authorizes generation.
- **Expected command:** `powershell -NoProfile -ExecutionPolicy Bypass -File .\windows\identity-agent\provision_identity_key.ps1 -NodeId '<verified-machine-a-node>' -KeyVersion <verified-version>`.
- **Evidence:** encrypted blob exists, owner/inheritance/ACE summary, non-secret fingerprint, public export path, no plaintext artifact scan.
- **PASS:** one create-new DPAPI blob, valid Ed25519 self-test, exact ACL, public export only, zero plaintext key files.
- **ABORT:** existing blob, H1 mismatch, identity mismatch, ACL drift, self-test failure, or secret output.
- **Rollback:** stop service; preserve encrypted blob for reviewed recovery; delete only disposable public export when approved.

### HUMAN RUNTIME GATE H3 — Public-Key Export

- **Prerequisites:** H2 PASS; Agent stopped or export command serialized by tooling.
- **Expected command:** invoke `run_identity_agent.py --export-public-key` through `provision_identity_key.ps1` into an explicit temporary public-only path.
- **Evidence:** node ID, key version, SHA-256 fingerprint, PEM public-key parse result, output ACL, and digest; no private blob content.
- **PASS:** exported public key verifies an Agent self-test signature and fingerprint equals H2.
- **ABORT:** fingerprint mismatch, private PEM marker, unexpected owner/ACE, or output outside approved temporary directory.
- **Rollback:** remove public export only; preserve encrypted blob.

### HUMAN RUNTIME GATE H4 — Live Registry Inspection

- **Prerequisites:** reviewed server CLI available on controlled Monitor admin host; read-only access; exact live database selected by human; no mode mutation.
- **Expected command:** after the human supplies `DATABASE_URL` through the approved secret-bearing environment, run `python server/cli/manage_nodes.py list`; the CLI prints only its redacted listing.
- **Evidence:** exact Machine A and Detector B node IDs, active flag, physical mapping, key version, auth mode, fingerprint metadata; no public-key payload or database credential.
- **PASS:** one unambiguous active Machine A node/physical camera and one confirmed Detector B row; Detector B mode is recorded, not inferred from documentation.
- **ABORT:** ambiguity, missing/inactive mapping, duplicate physical ownership, unexpected required mode, or database target uncertainty.
- **Rollback:** not applicable because inspection is read-only; stop without registration.

### HUMAN RUNTIME GATE H5 — Machine A Registration and Key-Version Confirmation

- **Prerequisites:** H3/H4 PASS; public key fingerprint reviewed; exact Machine A node selected; backup/query evidence captured; Machine A remains `legacy_shared_key`.
- **Expected command:** existing reviewed `manage_nodes.py rotate-key` or registration command with exact node ID, public-key file, and expected current key version; follow with redacted list.
- **Evidence:** before/after node ID, key version increment/expected version, fingerprint, active physical mapping, auth mode still legacy, transaction result.
- **PASS:** registry public key/fingerprint/version match H3 and physical mapping is unchanged.
- **ABORT:** row count other than one, key-version race, fingerprint mismatch, physical remap, Detector B change, or mode change.
- **Rollback:** restore prior public key/version only through a separately reviewed exact-node rotation; do not expose or delete local encrypted key.

### HUMAN RUNTIME GATE H6 — Local Agent Authentication Acceptance

- **Prerequisites:** H1–H5 PASS; certificate-validated internal HTTPS dependency complete; `AEGIS_AGENT_MONITOR_BASE_URL` uses approved HTTPS; Machine A still legacy-compatible; camera baseline closed.
- **Expected command:** start `AEGISIdentityAgent`, run redacted `status_identity_agent.ps1`, and invoke the Agent's authenticated health/self-test operation without Engine camera start.
- **Evidence:** challenge issued/verified categories, Agent session created/renew-after/expiry metadata without session value, server node/fingerprint category, HTTP statuses, TLS certificate validation result, camera connected/demand/viewer metrics.
- **PASS:** one Agent session succeeds with correct node/key/physical identity and camera remains closed with zero demand/viewers.
- **ABORT:** TLS bypass/prompt, wrong identity, fallback to shared key, session/key value logged, camera open/demand, or registry uncertainty.
- **Rollback:** stop Agent; leave Machine A legacy mode; preserve key; restore no Production state because no mode changed.

### HUMAN RUNTIME GATE H7 — Service Restart Acceptance

- **Prerequisites:** H6 PASS and no active camera demand.
- **Expected command:** restart only `AEGISIdentityAgent`; run status and one authenticated heartbeat/self-test.
- **Evidence:** service PID/start time changed, same public fingerprint, new in-memory Agent session, successful signed request, camera-closed metrics.
- **PASS:** key decrypts under same service identity, old session is absent/replaced, new auth succeeds, camera remains closed.
- **ABORT:** key regeneration, ACL/profile drift, old session reuse, Engine restart, camera open, or shared-key fallback.
- **Rollback:** stop Agent and keep Machine A legacy mode.

### HUMAN RUNTIME GATE H8 — Windows Reboot Acceptance

- **Prerequisites:** H7 PASS, all other user work saved, reboot explicitly approved, Machine A still legacy mode.
- **Expected command:** normal Windows restart; after login, run `status_identity_agent.ps1` and existing Engine/tunnel status script without changing configuration.
- **Evidence:** Agent service identity/start mode, same fingerprint, new authenticated session, interactive Engine ownership, tunnel status, camera closed until real demand.
- **PASS:** Agent auto-starts, DPAPI blob decrypts, auth/heartbeat succeed, Engine/tunnel roles remain unchanged, no camera demand.
- **ABORT:** service/profile/key failure, identity change, Engine converted to service, persistent config drift, or camera opens without demand.
- **Rollback:** stop/disable Agent service using reviewed uninstall while preserving key; leave legacy Engine/tunnel path intact.

### HUMAN RUNTIME GATE H9 — Camera-Stays-Closed Acceptance

- **Prerequisites:** H8 PASS; no browser Operator demand; Engine and Agent running in their approved identities; baseline metrics captured.
- **Expected command:** observe local Engine `/healthz`/metrics plus Agent auth, heartbeat, one real renewal after the two-minute-remaining threshold, an intentionally failed IPC request, and recovery while keeping the fixed production protocol timings.
- **Evidence:** `camera_connected=false`, `camera_demanded=false`, zero demanding/passive viewers, zero capture/detect FPS, no producer/demand rows from CP3 traffic, Agent/Monitor auth categories.
- **PASS:** startup, auth, heartbeat, renewal, failure, and recovery leave camera closed and producer/demand state unchanged.
- **ABORT:** any camera open, demand/producer acquisition, alias switch, SOC demand, or lifecycle counter change.
- **Rollback:** stop Agent and revert only Machine A Engine transport configuration if it was enabled for the local test; retain source/key evidence.

### HUMAN RUNTIME GATE H10 — Controlled Switch to `ed25519_required`

- **Prerequisites:** H1–H9 PASS, HTTPS dependency complete, rollback operator present, live registry rechecked, Detector B exact row confirmed legacy and healthy, Production mutation separately authorized.
- **Expected command:** `python server/cli/manage_nodes.py set-auth-mode --node-id '<verified-machine-a-node>' --mode ed25519_required` against the explicitly approved database, followed by redacted list and four-operation acceptance.
- **Evidence:** exactly one changed row, Machine A mode/version/fingerprint/physical mapping, signed heartbeat/detection/alert/clip results, shared-key downgrade rejection, Detector B legacy health, camera lifecycle metrics.
- **PASS:** Machine A accepts all four signed operations, rejects its shared-key attempt, trusted physical provenance is correct, Detector B remains operational, and camera behavior is unchanged.
- **ABORT:** row-count ambiguity, unexpected node change, any automatic downgrade, Detector B impact, trusted identity from body/shared key, or camera lifecycle change.
- **Rollback:** first stop/disable Machine A ingest. Changing the exact row back to `legacy_shared_key` requires separate human approval as a documented security exception; Monitor never performs it automatically. Migration 004 remains installed.

## Internal HTTPS Dependency Gate

Tasks 1–16 can be implemented and verified with loopback fakes plus disposable PostgreSQL because they do not need live Machine A transport. H6–H10 and any claim of real Agent authentication are blocked until infrastructure review provides a certificate-validated internal HTTPS origin in `AEGIS_AGENT_MONITOR_BASE_URL` exposing only the Agent auth and four signed ingest routes. The Agent rejects non-HTTPS production URLs and uses the platform trust store or an explicitly provisioned reviewed CA bundle; it never uses `verify=False`, an unverified certificate, or HTTP-over-SSH as a substitute. Gateway, Twingate, TLS issuance, firewall, and Production routing are separate infrastructure work and are not changed by this plan.

## Camera Contract Regression Matrix

Task 16 reruns the existing authority/lifecycle tests and records these rows without adding CP5 behavior:

| Machine | Account | Trusted physical camera | Logical alias | CP3 activation |
|---|---|---|---|---|
| A | operator | physical A | CAM-01 | none |
| A | operator2 | physical A | CAM-02 | none |
| B | operator | physical B | CAM-01 | none |
| B | operator2 | physical B | CAM-02 | none |
| C | operator | physical C | CAM-01 | none |
| C | operator2 | physical C | CAM-02 | none |

SOC can observe an already active logical producer under existing lifecycle behavior but CP3 auth/heartbeat never wakes, owns, or retains it. One physical camera never emits both aliases concurrently.

## Spec Coverage Matrix

| Spec section | Plan coverage |
|---|---|
| 1 Goals | Goal, Tasks 1–17 |
| 2 Non-goals | Global Constraints, DO_NOT_TOUCH, CP4/CP5 boundaries |
| 3 Threat model | Tasks 4, 5, 7, 9, 11, 16 |
| 4 Current architecture | File Map and Tasks 2, 7, 12 |
| 5 Target architecture | Architecture and Tasks 3–14 |
| 6 Windows process/identity | Tasks 10, 15; H1/H7/H8 |
| 7 DPAPI/key lifecycle | Task 9; H1–H3/H5/H7/H8 |
| 8 Named pipe | Task 11; Task 12 integration |
| 9 Agent authentication | Tasks 1, 3, 4, 8 |
| 10 Agent session | Tasks 3, 5, 8 |
| 11 Request proof | Tasks 1, 5, 8, 13, 14 |
| 12 Canonical serialization | Task 1 and shared vectors |
| 13 Replay protection | Tasks 3, 5, 8, 16 |
| 14 Key rotation | Tasks 2, 5, 8; H5 |
| 15 Detector B transition | Tasks 2, 7, 16; H4/H10 |
| 16 Physical provenance | Tasks 5, 6, 13, 14 |
| 17 Error behavior | Tasks 3–5, 8, 11, 12 |
| 18 Camera invariants | Global Constraints, Tasks 10, 12–16, H6–H10 |
| 19 Database/migration | Tasks 2, 6, 7, 16 |
| 20 Test strategy | Every task RED/GREEN plus Task 16 |
| 21 Rollout boundaries | H1–H10 and HTTPS gate |
| 22 Rollback | Every human gate and Task 17 runbook |
| 23 CP4 boundary | Global Constraints and DO_NOT_TOUCH |
| 24 CP5 boundary | Global Constraints, DO_NOT_TOUCH, camera matrix |
| 25 Known limitations | Limitations below and Task 17 handoff |

## Plan Self-Review and Validation Commands

- [ ] Confirm every spec row above names at least one executable task or gate.
- [ ] Search the plan for forbidden placeholder vocabulary without embedding those words as contiguous plan text:

```powershell
$bad = @('T'+'ODO','T'+'BD','implement '+'later','similar '+'to','appropriate '+'handling')
Select-String -LiteralPath 'docs/superpowers/plans/2026-09-13-idea2-cp3-machine-a-agent-identity-implementation.md' -Pattern $bad -CaseSensitive:$false
```

Expected: no matches.
- [ ] Compare all interface names in Tasks 1–17 with the Shared Interface Contract using `rg -n "canonicalizeAgent|createChallengeStore|advanceReplayWindow|createAgentSessionStore|verifyEd25519|getDetectionNodeIdentity|AgentSessionClient|AgentTransport|AgentOperationRequest|IdentityKeyStore|IdentityAgentClient"` on this plan. Expected: no alternate spellings for the same interface.
- [ ] Run `git diff --check` and verify changed paths are only this plan plus the canonical IDEA2 status update for the planning session.
- [ ] Run `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` and `node --test --test-concurrency=1 tests/*.test.mjs` from repository root. Record pre-existing warnings separately.
- [ ] Scan changed files for secret material and artifacts using repository ignore/policy patterns; inspect every match. The plan/status must contain no credential, private key, token, cookie, database URL, biometric payload, or real Machine A/B identity.
- [ ] Verify runtime/test source did not change:

```powershell
git diff --name-only -- IDEA2-AEGIS_Monitor IDEA2-AEGIS_CCTV-Operator
```

Expected: empty during this planning checkpoint.
- [ ] Stage only the plan and canonical status note, run cached diff checks, commit `docs(idea2): plan cp3 machine-a agent identity implementation`, and push the same task branch. Do not create/update a PR or begin implementation.

## Known Limitations Before Implementation

- DPAPI CurrentUser under the virtual service identity and exact named-pipe DACL behavior require H1 and later Windows gates; source tests cannot prove them.
- The current Machine A HTTP-over-SSH route does not satisfy the certificate-validated HTTPS contract; H6–H10 remain blocked until the separate infrastructure dependency is reviewed and delivered.
- Detector B remains `legacy_unverified` and lacks cryptographically trusted physical provenance until a separately approved migration.
- In-memory Monitor challenge/session/replay state supports one Monitor process only; horizontal scaling requires a future shared atomic store.
- Signed admission is at-most-once, but response loss after a committed write has no cross-retry application idempotency key.
- The designated interactive Engine account may submit only the four structured operations through the pipe; CP3 does not attest hardware, binary integrity, biometric accuracy, liveness, or fairness.
- CP3 does not provide browser association, stream demand, producer lease, camera activation/release, or account-driven runtime switching.

## Authoritative File Map Before Task Execution

**CREATE — Monitor**

- `IDEA2-AEGIS_Monitor/server/nodeIdentity/agentProtocol.js`
- `IDEA2-AEGIS_Monitor/server/nodeIdentity/challengeStore.js`
- `IDEA2-AEGIS_Monitor/server/nodeIdentity/replayWindow.js`
- `IDEA2-AEGIS_Monitor/server/nodeIdentity/agentSessionStore.js`
- `IDEA2-AEGIS_Monitor/server/nodeIdentity/ed25519.js`
- `IDEA2-AEGIS_Monitor/server/routes/agentAuth.js`
- `IDEA2-AEGIS_Monitor/server/middleware/authenticateDetectionIngest.js`
- `IDEA2-AEGIS_Monitor/server/db/migrations/004_detection_node_ingest_auth_mode.sql`
- `IDEA2-AEGIS_Monitor/tests/fixtures/agentProofV1.json`
- `IDEA2-AEGIS_Monitor/tests/agentProtocol.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/agentState.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/agentAuth.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/agentRequestProof.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/agentIngestProvenance.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/detectorCompatibility.test.mjs`

**CREATE — Identity Agent and Windows**

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/__init__.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/config.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/protocol.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/sequence.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/key_store.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/session_client.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/transport.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_protocol.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_server.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/windows_service.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/run_identity_agent.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements-identity-agent-windows.txt`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_protocol.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_session.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_key_store.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_pipe_protocol.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_windows_service.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_client.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/install_identity_agent.ps1`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/invoke_dpapi_preflight.ps1`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/provision_identity_key.ps1`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/status_identity_agent.ps1`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/repair_identity_agent.ps1`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/uninstall_identity_agent.ps1`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/README.md`

**MODIFY**

- `IDEA2-AEGIS_Monitor/server/index.js`
- `IDEA2-AEGIS_Monitor/server/middleware/requireDetectionEngineKey.js`
- `IDEA2-AEGIS_Monitor/server/routes/internal.js`
- `IDEA2-AEGIS_Monitor/server/db/connection.js`
- `IDEA2-AEGIS_Monitor/server/db/store.js`
- `IDEA2-AEGIS_Monitor/server/db/schema.sql`
- `IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py`
- `IDEA2-AEGIS_Monitor/server/cli/README.md`
- `IDEA2-AEGIS_Monitor/package.json`
- `IDEA2-AEGIS_Monitor/.env.example`
- `IDEA2-AEGIS_Monitor/tests/nodeRegistry.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/registryMigrations.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/test_manage_nodes.py`
- `IDEA2-AEGIS_Monitor/tests/test_manage_nodes_postgres.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/monitor_client.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/README.md`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_config.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_autostart.py`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`

**REUSE_UNCHANGED**

- `IDEA2-AEGIS_Monitor/server/auth/cameraAccess.js`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/heartbeat_worker.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/alert_manager.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/nas_sync.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_engine.ps1`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_engine_supervisor.ps1`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_tunnel.ps1`
- `IDEA2-AEGIS_Monitor/tests/liveCamera.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/designContract.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/uiFreezeCurrentMain.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/browser/cameraSelector.spec.mjs`

**DO_NOT_TOUCH**

- `IDEA2-AEGIS_Monitor/src/**`
- `IDEA2-AEGIS_Monitor/server/streamLifecycle.js`
- `IDEA2-AEGIS_Monitor/server/auth/cameraAccess.js`
- `IDEA2-AEGIS_Monitor/server/db/migrations/001_device_owned_local_runtime.sql`
- `IDEA2-AEGIS_Monitor/server/db/migrations/002_physical_camera_logical_alias.sql`
- `IDEA2-AEGIS_Monitor/server/db/migrations/003_deprecate_node_camera_identity.sql`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/video_catcher.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/camera_devices.py`
- recognition/model source, model weights, training data, biometric enrollment, infrastructure, Docker, gateway, network, and Production paths

The Detailed File Responsibilities section repeats the staging classifications and descriptions; the explicit paths above control execution.

## Interface Name Lock Before Task Execution

| Language | Exact interface |
|---|---|
| JavaScript | `AGENT_PROTOCOL`, `validateCanonicalToken`, `parseUint64Decimal`, `sha256Hex`, `canonicalizeAgentAuth`, `canonicalizeAgentRequest` |
| JavaScript | `createChallengeStore`, `advanceReplayWindow`, `createAgentSessionStore`, `verifyEd25519` |
| JavaScript DB | `getDetectionNodeIdentity(nodeId)`, `setDetectionNodeIngestAuthMode(nodeId, ingestAuthMode)` |
| Express | `req.verifiedNode = { nodeId, keyVersion, physicalCameraId, agentSessionId }`; `req.ingestAuth.kind = 'ed25519' | 'legacy_unverified'` |
| Python protocol | `canonicalize_agent_auth`, `canonicalize_agent_request`, `serialize_json_body`, `build_proof_headers` |
| Python state/crypto | `SequenceAllocator`, `DataProtector`, `DpapiCurrentUserProtector`, `IdentityKeyStore`, `AgentSessionClient`, `AgentTransport` |
| Python pipe | `AgentOperationRequest`, `AgentOperationResponse`, `IdentityAgentClient.submit(operation, payload)` |

No task may rename one of these interfaces without first updating this lock, every consumer task, both language tests, and the golden vectors in one reviewed checkpoint.

### Task 1: Canonical Protocol and Cross-Language Golden Vectors

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/agentProtocol.js`
- Create: `IDEA2-AEGIS_Monitor/tests/fixtures/agentProofV1.json`
- Create: `IDEA2-AEGIS_Monitor/tests/agentProtocol.test.mjs`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/__init__.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/protocol.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_protocol.py`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:** Produces every constant and canonicalization signature in the Shared Interface Contract. Both languages consume the same JSON fixture; neither implementation invokes the other language.

- [ ] **Step 1: Add fixed vectors and RED tests.** Record one auth vector and one request vector for each route domain. Each fixture records input fields, expected UTF-8 canonical text as Base64, expected body SHA-256, a fixed test public key, and expected signature; the private test seed is a documented non-Production fixture value only.
- [ ] **Step 2: Exercise exact rejection cases.** Node and Python tests must name wrong domain, wrong field order, trailing LF, padded token, token beginning `_`/`-`, leading-zero integer, zero key version, non-uppercase method, non-canonical path, query string, non-lowercase hash, Unicode text without normalization, and cross-domain signature reuse.
- [ ] **Step 3: Run RED.** Run `node --test --test-name-pattern="agent protocol|golden vector" tests/agentProtocol.test.mjs` from `IDEA2-AEGIS_Monitor` and `python -m unittest tests.test_agent_protocol -v` from `detection-engine`. Expected: module import/file-not-found failures for `agentProtocol.js` and `aegis_identity_agent.protocol`, not fixture parse errors.
- [ ] **Step 4: Add the minimum canonicalizers.** Implement strict token/decimal/hash/path checks, text-to-Base64URL field encoding, LF joining without final LF, `Buffer`/`bytes` returns, exact JSON serialization using UTF-8 with compact separators, and route-domain lookup that refuses unknown paths.

```js
return Buffer.from([
  domain,
  `session_id=${sessionId}`,
  `request_nonce=${requestNonce}`,
  `timestamp_ms=${timestampMs}`,
  `sequence=${sequence}`,
  `method_b64=${textToBase64Url(method)}`,
  `path_b64=${textToBase64Url(path)}`,
  `body_sha256=${bodySha256}`,
].join('\n'), 'utf8')
```

- [ ] **Step 5: Run GREEN and parity.** Re-run both focused commands. Expected: all protocol/vector tests pass and the Node/Python canonical byte digests match every fixture value.
- [ ] **Step 6: Run related regression.** Run `npm test` and `python -m unittest discover -s tests -v`; record counts and environment-bound skips separately.
- [ ] **Step 7: Validate/checkpoint.** Run `git diff --check`; stage only the seven Task 1 paths; inspect `git diff --cached --name-status`; commit intent: `feat(idea2): define agent proof protocol vectors`.

### Task 2: Add Migration 004 and Per-Node Ingest Authentication Mode

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/db/migrations/004_detection_node_ingest_auth_mode.sql`
- Modify: `IDEA2-AEGIS_Monitor/server/db/schema.sql`
- Modify: `IDEA2-AEGIS_Monitor/server/db/connection.js`
- Modify: `IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py`
- Modify: `IDEA2-AEGIS_Monitor/server/cli/README.md`
- Modify: `IDEA2-AEGIS_Monitor/tests/nodeRegistry.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/tests/registryMigrations.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/tests/test_manage_nodes.py`
- Modify: `IDEA2-AEGIS_Monitor/tests/test_manage_nodes_postgres.py`

**Interfaces:** Produces `getDetectionNodeIdentity(nodeId)` and `setDetectionNodeIngestAuthMode(nodeId, ingestAuthMode)`. Extends node mappings with `ingestAuthMode` while preserving existing fields.

- [ ] **Step 1: Add RED migration/adapter tests.** Assert migration 004 contains only an additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, a named check constraint guarded through `pg_constraint`, default `legacy_shared_key`, and no row-specific update. Assert fresh schema parity and rejection of every third mode.
- [ ] **Step 2: Add RED CLI tests.** Test `set-auth-mode --node-id edge-node-test --mode ed25519_required`, exact-node parameter binding, unknown-node failure, idempotent same-mode success, listing that prints mode/fingerprint metadata but not `public_key`, and no implicit Machine A/Detector B mutation.
- [ ] **Step 3: Run RED.** Run `npm run test:registry` and `python -m unittest tests.test_manage_nodes tests.test_manage_nodes_postgres -v`. Expected: migration path/mode field/command assertions fail because migration 004 and mode interfaces do not exist.
- [ ] **Step 4: Add the additive schema and adapters.** Use this schema shape and no data update:

```sql
ALTER TABLE detection_nodes
  ADD COLUMN IF NOT EXISTS ingest_auth_mode TEXT NOT NULL DEFAULT 'legacy_shared_key';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'detection_nodes_ingest_auth_mode_check'
  ) THEN
    ALTER TABLE detection_nodes ADD CONSTRAINT detection_nodes_ingest_auth_mode_check
      CHECK (ingest_auth_mode IN ('legacy_shared_key', 'ed25519_required'));
  END IF;
END $$;
```

Include `ingest_auth_mode` in `detectionNodeFromRow`; implement one parameterized mode update returning non-secret metadata; leave existing rows and migrations untouched.
- [ ] **Step 5: Run focused GREEN.** Re-run Node registry and Python CLI unit tests. Expected: static/memory tests pass; PostgreSQL-only cases are reported as conditional until the disposable URL is supplied.
- [ ] **Step 6: Run disposable PostgreSQL gate.** Create a dedicated non-Production PostgreSQL 15 database, apply baseline plus 001–004 twice, seed representative A/B rows before 004, and run `AEGIS_MONITOR_TEST_DATABASE_URL=<disposable-url> npm run test:registry` plus `AEGIS_MONITOR_TEST_DATABASE_URL=<disposable-url> python -m unittest tests.test_manage_nodes_postgres -v`. Expected: legacy rows preserve `legacy_shared_key`, an exact test node can switch modes, invalid mode is rejected, the second migration run is stable, and cleanup removes only disposable resources.
- [ ] **Step 7: Regress/checkpoint.** Run `npm test`, `git diff --check`, stage exactly the nine Task 2 paths, inspect cached diff, and commit intent: `feat(idea2): add per-node ingest authentication mode`.

### Task 3: Build Bounded Challenge, Session, and Replay State

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/challengeStore.js`
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/replayWindow.js`
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/agentSessionStore.js`
- Create: `IDEA2-AEGIS_Monitor/tests/agentState.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:** Consumes Task 1 token/uint64 helpers. Produces the challenge/session/replay factory APIs in the Shared Interface Contract.

- [ ] **Step 1: Write deterministic RED tests.** Inject a millisecond clock and queued random byte values. Cover 60-second challenge expiry at `now >= expiresAt`, four live challenges per node, 1,024 total, purge before capacity check, bad-proof claim release, successful atomic consumption, and two simultaneous valid claim attempts with exactly one claim token.
- [ ] **Step 2: Add replay RED matrix.** Cover first sequence, forward delta 1/63/64/65, out-of-order offsets 1/63, duplicate, offset 64, zero, `2^64-1`, overflow, nonce reuse, exact timestamp boundaries, outside boundaries, and two concurrent admissions for the same sequence/nonce. Assert state does not advance before successful admission.
- [ ] **Step 3: Add session RED cases.** Cover 10-minute expiry, two-minute renewal metadata, one current session per node, replacement invalidation, process restart loss through a fresh store, maximum 1,024 sessions, and purge.
- [ ] **Step 4: Run RED.** Run `node --test tests/agentState.test.mjs`. Expected: imports fail because all three store modules are absent.
- [ ] **Step 5: Add the minimum state machines.** Use synchronous `Map` mutations; challenge states `LIVE`/`VERIFYING` change before signature work; `finishVerification(claimId, false)` returns unexpired entries to `LIVE`, while success deletes them. Use the exact replay transition:

```js
const MASK_64 = (1n << 64n) - 1n
if (highest === null) return { accepted: true, highest: sequence, bitmap: 1n }
if (sequence > highest) {
  const delta = sequence - highest
  return {
    accepted: true,
    highest: sequence,
    bitmap: delta >= 64n ? 1n : (((bitmap << delta) & MASK_64) | 1n),
  }
}
const offset = highest - sequence
if (offset >= 64n || (bitmap & (1n << offset)) !== 0n) return { accepted: false }
return { accepted: true, highest, bitmap: bitmap | (1n << offset) }
```

Retain nonce SHA-256 digests only through the admissible time horizon.
- [ ] **Step 6: Run GREEN and controlled mutation.** Re-run the focused file, then temporarily remove bitmap duplicate detection and successful challenge deletion one at a time. Each corresponding test must fail; restore immediately and prove `git diff` contains no mutation residue.
- [ ] **Step 7: Regress/checkpoint.** Run `npm test`, `git diff --check`, stage the five Task 3 paths, and commit intent: `feat(idea2): add bounded agent authentication state`.

### Task 4: Verify Ed25519 Agent Authentication and Issue Sessions

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/ed25519.js`
- Create: `IDEA2-AEGIS_Monitor/server/routes/agentAuth.js`
- Create: `IDEA2-AEGIS_Monitor/tests/agentAuth.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/server/index.js`
- Modify: `IDEA2-AEGIS_Monitor/.env.example`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:** Consumes Tasks 1–3 and `getDetectionNodeIdentity`. `POST challenge` returns `{ challengeId, nonce, issuedAtMs, expiresAtMs, audience, purpose, nodeId, keyVersion }`; `POST verify` accepts those public fields plus `signature` and returns `{ agentSessionId, expiresAtMs, renewAfterMs, nodeId, keyVersion, physicalCameraId }`.

- [ ] **Step 1: Add route-level RED tests.** Use an ephemeral Ed25519 pair and dependency-injected stores/registry. Cover valid proof, malformed input, unknown/disabled node, inactive physical camera, wrong key version/audience/purpose/domain/signature, exact challenge expiry, replay, bad proof remaining usable, one winner from two concurrent valid verifies, capacity failure, registry outage, and generic non-secret errors.
- [ ] **Step 2: Run RED.** Run `node --test tests/agentAuth.test.mjs`. Expected: import/404 failures for the missing auth router and verifier.
- [ ] **Step 3: Add the verification boundary.** Validate request shape before lookup; issue challenges only after live registry checks; claim the challenge; reconstruct canonical bytes server-side; verify with Node `crypto.verify(null, payloadBytes, publicKey, signature)`; release the claim on failed proof; consume on success; re-read registry before session issue; bind node/key version/physical camera into the session.
- [ ] **Step 4: Mount without shared-key middleware.** Mount `/internal/agent-auth` before authenticated ingest. Require an exact configured audience and return `503 IDENTITY_SERVICE_UNAVAILABLE` when missing or registry/store capacity is unavailable.
- [ ] **Step 5: Run GREEN and negative mutations.** Re-run focused tests. Temporarily omit audience from canonical auth and separately consume a challenge before signature success; the wrong-audience and bad-proof-retry tests must fail. Restore both changes and confirm no residue.
- [ ] **Step 6: Regress/checkpoint.** Run `npm test`, `npm run test:ui-freeze`, `npm run build`, and `git diff --check`; stage only the six Task 4 paths; commit intent: `feat(idea2): authenticate identity agents with ed25519`.

### Task 5: Enforce Per-Request Proof, Replay, Raw Bytes, and Live Revalidation

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/middleware/authenticateDetectionIngest.js`
- Create: `IDEA2-AEGIS_Monitor/tests/agentRequestProof.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/server/index.js`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:** Consumes Task 1 canonicalizer, Task 3 session/replay admission, Task 4 verifier, and Task 2 registry identity. Produces `req.verifiedNode` and `req.ingestAuth` exactly as declared above.

- [ ] **Step 1: Write RED header-selection tests.** Enumerate the five proof headers. Assert 1–4 present headers return `401 REQUEST_PROOF_FAILED`; all five select only Ed25519; zero may reach a stub legacy evaluator; an invalid complete proof never invokes legacy. Assert duplicate header values fail.
- [ ] **Step 2: Write RED proof matrix.** Sign exact bodies and cover empty body, changed whitespace/body, method, fixed path, any query string, wrong/cross-used domain, malformed/padded signature, missing/replaced/expired session, stale/future timestamp with exact boundary acceptance, duplicate/too-old/out-of-order sequences, nonce replay, uint64 maximum/exhaustion, and concurrent same-proof admission.
- [ ] **Step 3: Write RED registry-transition tests.** Session at key version N passes; rotation to N+1, disabled node, missing/inactive/remapped physical camera, and unknown version fail before handler/storage. Changing between the two supported auth modes does not invalidate an otherwise valid Ed25519 session because both modes admit Ed25519. Assert `verifiedNode` is frozen and body claims cannot alter it.
- [ ] **Step 4: Run RED.** Run `node --test tests/agentRequestProof.test.mjs`. Expected: missing middleware import and absent raw-body capture.
- [ ] **Step 5: Add exact raw-byte capture.** Add the `express.json` verify callback shown in the shared contract. Retain 16 KiB rejection and parsed `req.body`; hash only `req.rawBody`.
- [ ] **Step 6: Add proof middleware.** Restrict signed proof to the four path/domain pairs and `POST`; reject `req.originalUrl` containing `?`; parse decimal fields with `BigInt`; perform session, live registry, physical mapping, timestamp, signature, then atomic replay admission; attach server-derived contexts only after all checks.
- [ ] **Step 7: Run GREEN and load-bearing mutations.** Run focused tests. Temporarily bypass body hash, domain lookup, live key-version comparison, and replay admission separately; each named negative test must fail. Restore immediately and verify source hashes/diff.
- [ ] **Step 8: Regress/checkpoint.** Run `npm test`, `npm run test:ui-freeze`, `npm run build`, and `git diff --check`; stage only the four Task 5 paths; commit intent: `feat(idea2): verify signed agent ingest requests`.

### Task 6: Bind Server-Resolved Physical Provenance to All Four Writes

**Files:**
- Create: `IDEA2-AEGIS_Monitor/tests/agentIngestProvenance.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/server/routes/internal.js`
- Modify: `IDEA2-AEGIS_Monitor/server/db/store.js`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:** Write functions become `recordHeartbeat(body, ingestContext)`, `insertDetection(body, ingestContext)`, `insertAlert(body, ingestContext)`, and `insertClip(body, ingestContext)`, where `ingestContext` is `{ kind: 'ed25519', verifiedNode }` or `{ kind: 'legacy_unverified', verifiedNode: null }`.

- [ ] **Step 1: Add RED route/store matrix.** For each route, send a body with forged `nodeId` and `physicalCameraId`; assert Ed25519 writes use only `verifiedNode.nodeId`/`physicalCameraId`. Assert heartbeat keys `physical_camera_heartbeat` by trusted physical ID. Assert detection/alert/clip retain logical `cameraId` but persist trusted physical provenance.
- [ ] **Step 2: Add legacy RED cases.** Assert a zero-proof, allowed legacy write keeps `physical_camera_id` null, never copies a body physical ID, and is marked `legacy_unverified` in the in-process context. Existing logical body validation remains unchanged.
- [ ] **Step 3: Run RED.** Run `node --test tests/agentIngestProvenance.test.mjs`. Expected: spies observe body identity reaching stores or missing context arguments.
- [ ] **Step 4: Separate trusted context from payload.** Route handlers pass an immutable context argument. Store functions destructure logical event fields from `body` and physical provenance only from `ingestContext.verifiedNode`; heartbeat rejects Ed25519 writes when its logical alias violates existing event policy but never registers/selects identity from telemetry.

```js
const trustedPhysicalCameraId = ingestContext.kind === 'ed25519'
  ? ingestContext.verifiedNode.physicalCameraId
  : null
```

- [ ] **Step 5: Run GREEN and mutation.** Re-run focused tests; temporarily prefer `body.physicalCameraId` in one store path and prove its spoof test fails; restore immediately.
- [ ] **Step 6: Run PostgreSQL provenance gate.** Against a disposable PostgreSQL 15 database, authenticate one test node and write all four operations. Query only non-secret IDs to prove a shared physical ID for signed rows, logical alias retention, and null physical provenance for legacy fixtures.
- [ ] **Step 7: Regress/checkpoint.** Run `npm test`, `npm run test:registry`, `git diff --check`; stage exactly the four Task 6 paths; commit intent: `feat(idea2): persist verified physical ingest provenance`.

### Task 7: Preserve Detector B Legacy Compatibility and Prevent Downgrade

**Files:**
- Create: `IDEA2-AEGIS_Monitor/tests/detectorCompatibility.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/server/middleware/authenticateDetectionIngest.js`
- Modify: `IDEA2-AEGIS_Monitor/server/middleware/requireDetectionEngineKey.js`
- Modify: `IDEA2-AEGIS_Monitor/server/routes/internal.js`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:** Adds `authenticateLegacyDetectionKey(req)` as a boolean-compatible helper without changing `requireDetectionEngineKey` public behavior. `authenticateDetectionIngest` remains the sole selector for the four write routes.

- [ ] **Step 1: Add RED compatibility matrix.** Cover no Agent headers plus correct shared key, wrong/missing key, body claim for a live `ed25519_required` node, body claim for its physical camera, ambiguous/unknown legacy claim, full valid Ed25519 proof with or without shared key, and partial/invalid proof with a valid shared key.
- [ ] **Step 2: Encode Detector B boundary.** The fixture uses a generated test node, not `edge-node-02`. Assert successful legacy write sets no `verifiedNode`, creates no trusted physical provenance, and preserves the current logical-only response. Live Detector B identity remains a later human inspection.
- [ ] **Step 3: Run RED.** Run `node --test tests/detectorCompatibility.test.mjs`. Expected: current global middleware cannot distinguish node mode or prevent a claimed required-mode identity.
- [ ] **Step 4: Add the bounded selector.** Refactor timing-safe comparison into `authenticateLegacyDetectionKey`. When all Agent headers exist, invoke Ed25519 only. When some exist, reject. When none exist, require shared key; inspect claimed node/physical IDs only to reject any match to an `ed25519_required` registration; never convert those claims into trusted identity.
- [ ] **Step 5: Preserve legacy GET routing.** Keep `GET /internal/route/:cameraId` behind the existing shared-key middleware and outside Agent proof. Add a test proving the route neither creates `verifiedNode` nor alters ingest state.
- [ ] **Step 6: Run GREEN and downgrade mutation.** Re-run focused tests. Temporarily allow legacy fallback after an invalid Agent signature; the downgrade test must fail. Restore and prove no residue.
- [ ] **Step 7: Run full Monitor and PostgreSQL gates.** Run `npm test`, `npm run test:registry`, `npm run test:ui-freeze`, `npm run test:browser`, and `npm run build`. Repeat relevant compatibility cases with a disposable PostgreSQL registry containing one node per mode.
- [ ] **Step 8: Validate/checkpoint.** Run `git diff --check`; stage only the five Task 7 paths; commit intent: `feat(idea2): preserve bounded legacy detector ingest`.

### Task 8: Build Identity Agent Core Signing, Session, and HTTPS Client

**Files:**
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/config.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/sequence.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/session_client.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/transport.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_session.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements-identity-agent-windows.txt`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md`

**Interfaces:** Consumes Task 1 Python protocol and an `IdentitySigner.sign(bytes) -> bytes` supplied by Task 9. Produces `SequenceAllocator`, `AgentSessionClient`, and `AgentTransport.submit` from the Shared Interface Contract.

- [ ] **Step 1: Add RED session tests.** Mock certificate-valid HTTPS responses and signer. Cover challenge request/verify, exact canonical bytes, 10-minute in-memory session, renewal at `expiresAtMs - now <= 120_000`, no early renewal, one retry after `401`, full invalidation on Monitor/Agent restart simulation, sequence reset on new session, and no credential fields in logs.
- [ ] **Step 2: Add RED transport tests.** Assert compact UTF-8 bytes hashed equal transmitted bytes; headers contain decimal sequence and no padding; four route/domain mappings are exact; query strings are impossible; concurrent operations receive unique monotonic sequences/nonces under one lock; sequence exhaustion invalidates session.
- [ ] **Step 3: Add TLS/config RED tests.** Require `AEGIS_AGENT_MONITOR_BASE_URL` with `https://`, `AEGIS_AGENT_AUTH_AUDIENCE`, node ID, key version, physical configuration directories, timeout, and pipe name. Reject HTTP, `verify=False`, embedded credentials, fragments, or query strings. `redacted()` must omit key/session values.
- [ ] **Step 4: Run RED.** Run `python -m unittest tests.test_agent_session -v`. Expected: missing Agent config/session/transport/sequence modules.
- [ ] **Step 5: Add core state machine.** Use one `requests.Session`; send auth request JSON and signed writes as explicit `data=body_bytes` with `Content-Type: application/json`; leave default certificate verification enabled; keep `AgentSession` only in memory; serialize renewal under one lock; clear state on any registry/session proof rejection.

```python
body_bytes = serialize_json_body(operation.payload)
sequence = self._sequences.next()
proof = self._proof_for(operation, body_bytes, sequence)
response = self._http.post(url, data=body_bytes, headers=build_proof_headers(proof, signature), timeout=self._timeout)
```

- [ ] **Step 6: Run GREEN and concurrency loop.** Run the focused file three times, including a four-operation concurrent test of at least 1,000 allocations; all sequences/nonces must be unique and the serialized bytes must match the signed digest.
- [ ] **Step 7: Run Engine regression/checkpoint.** Run `python -m unittest discover -s tests -v`, `python -m compileall -q aegis_identity_agent`, and `git diff --check`; stage only the seven Task 8 paths; commit intent: `feat(idea2): add identity agent session transport`.

### Task 9: Add DPAPI CurrentUser Key Store with a Hard Preflight Gate

**Files:**
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/key_store.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_key_store.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/invoke_dpapi_preflight.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/provision_identity_key.ps1`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements-identity-agent-windows.txt`

**Interfaces:** Produces `DpapiCurrentUserProtector`, `IdentityKeyStore`, `IdentitySigner.sign(payload: bytes) -> bytes`, and `PublicIdentity(node_id, key_version, public_key_pem, fingerprint_sha256)`. Encrypted file is `%ProgramData%\AEGIS\IdentityAgent\machine-identity.dpapi`.

- [ ] **Step 1: Add RED unit tests with fake protector.** Assert envelope version/node/key version/public-key fingerprint binding; atomic create-new write; refusal to overwrite; protect/unprotect entropy binding; Ed25519 public key/fingerprint export; signature verification; corrupted/wrong-node/wrong-version blob rejection; and no plaintext seed/PKCS8 material in persisted bytes or public API.
- [ ] **Step 2: Add RED script contract tests.** In `test_agent_key_store.py`, inspect both scripts and assert preflight runs as `NT SERVICE\AEGISIdentityAgent`, writes/decrypts a disposable random marker through DPAPI CurrentUser, removes the marker, verifies profile load and target DACL, and exits nonzero before key generation on any failure.
- [ ] **Step 3: Run RED.** Run `python -m unittest tests.test_agent_key_store -v`. Expected: missing key-store classes. Run the PowerShell AST parser against the two scripts; expected before files exist: path-not-found.
- [ ] **Step 4: Add the key envelope and DPAPI adapter.** Serialize a versioned, length-bounded binary/JSON envelope before DPAPI; zero transient private buffers where Python permits; use `win32crypt.CryptProtectData`/`CryptUnprotectData` without LocalMachine flags; write with create-new temporary file plus atomic rename; export public PEM only.
- [ ] **Step 5: Add the preflight/provision split.** `invoke_dpapi_preflight.ps1` must not import/generate an application key. `provision_identity_key.ps1` first verifies a durable PASS marker bound to the current service identity/profile/DACL, then invokes `IdentityKeyStore.generate`; it prints only node ID, key version, fingerprint, and public-key export path.
- [ ] **Step 6: Run GREEN and secret scan.** Run key-store tests, PowerShell AST parsing, and `rg -n -i "PRIVATE KEY|BEGIN OPENSSH PRIVATE|CryptProtectData.*LOCAL_MACHINE"` over changed files. Expected: no persisted/plaintext private-key fixture and no LocalMachine flag; assertions describing forbidden material may appear only in tests.
- [ ] **Step 7: Stop at human gate H1.** Source implementation may proceed, but no real application key generation is allowed until H1 passes under the installed service identity.
- [ ] **Step 8: Validate/checkpoint.** Run full Python suite and `git diff --check`; stage only the five Task 9 paths (including the shared Windows test if introduced here); commit intent: `feat(idea2): protect agent identity with current-user dpapi`.

### Task 10: Host the Agent as a Dedicated Windows Service Identity

**Files:**
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/windows_service.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/run_identity_agent.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_windows_service.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/install_identity_agent.ps1`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements-identity-agent-windows.txt`

**Interfaces:** Windows service name is `AEGISIdentityAgent`, identity is `NT SERVICE\AEGISIdentityAgent`, binary root is `%ProgramFiles%\AEGIS\IdentityAgent`, mutable root is `%ProgramData%\AEGIS\IdentityAgent`, and the service host composes config/key/session/transport/pipe objects without importing Engine camera modules.

- [ ] **Step 1: Add RED service tests.** Assert service name/account/start mode/recovery actions; application and mutable directories are distinct; source-copy excludes `.env`, keys, logs, segments, snapshots, models, enrollment, Git metadata, and venv; config DACL grants service SID+SYSTEM only; key blob inherits no broader ACE; service start command uses its own venv.
- [ ] **Step 2: Add camera-isolation RED tests.** Patch/import traps for `cv2`, `VideoCatcher`, `StreamHub`, local API, and camera device modules; instantiate/stop the service composition and assert none are imported or called and no demand/producer endpoint exists in Agent code.
- [ ] **Step 3: Run RED.** Run `python -m unittest tests.test_agent_windows_service -v`. Expected: missing service host/install script and camera-isolation assertions fail.
- [ ] **Step 4: Add service lifecycle.** Implement `SvcDoRun`/`SvcStop` with a stop event, bounded shutdown, no key material logging, and nonzero startup on invalid config/key. Foreground entry supports `--service`, `--console`, `--dpapi-preflight`, `--generate-key`, and `--export-public-key`; privileged modes are invoked only by the approved scripts.
- [ ] **Step 5: Add installer staging.** PowerShell validates elevation and source SHA, copies only approved files, creates Agent venv/dependencies, registers the virtual service account, grants `SeServiceLogonRight` only as Windows requires, applies explicit non-inherited service SID+SYSTEM ACLs, and leaves the service stopped before H1.
- [ ] **Step 6: Run GREEN/static verification.** Run the focused Python test, parse every new PowerShell file via `[System.Management.Automation.Language.Parser]::ParseFile`, and run installer `-WhatIf`/validation mode that stops before machine mutation.
- [ ] **Step 7: Regress/checkpoint.** Run full Engine suite and `git diff --check`; stage only the five Task 10 paths; commit intent: `feat(idea2): host identity agent as dedicated windows service`.

### Task 11: Enforce the Four-Operation Named-Pipe Security Boundary

**Files:**
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_protocol.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_server.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_pipe_protocol.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/windows_service.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/install_identity_agent.ps1`

**Interfaces:** Pipe name is `\\.\pipe\AEGIS.IdentityAgent.v1`. Wire framing is one UTF-8 JSON object per connection, maximum 65,536 bytes before parse. Request/response dataclasses are exact as declared; allowed operation payload schemas reuse current Engine method fields and reject unknown properties.

- [ ] **Step 1: Add RED schema cases.** Valid requests cover heartbeat/detection/alert/clip. Rejections cover unknown operation/property, body `nodeId`/`physicalCameraId`, signature/session/nonce/sequence fields, raw `data`/`message`/`bytes`/`sign` requests, malformed/duplicate-key JSON, non-object roots, invalid UTF-8, empty message, and more than 64 KiB.
- [ ] **Step 2: Add RED boundary cases.** Mock pywin32 security inspection to prove allowed Engine SID accepted, unauthorized SID rejected, remote clients rejected, DACL is primary, PID/path mismatch is secondary defense, read/write timeout closes the connection, Agent unavailable maps locally, and response schema exposes no cryptographic material.
- [ ] **Step 3: Run RED.** Run `python -m unittest tests.test_agent_pipe_protocol -v`. Expected: missing protocol/server imports.
- [ ] **Step 4: Add strict parser and dispatcher.** Use `json.loads(..., object_pairs_hook=reject_duplicate_keys)`; reject before transport dispatch; map operation to a fixed AgentTransport method/path; never accept an arbitrary path, method, domain, header, or byte string.
- [ ] **Step 5: Add local pipe ACL.** Build a security descriptor that grants the configured Engine SID and service SID required pipe rights plus SYSTEM administrative control, denies network SID/remote clients, disables inheritance, impersonates the caller to inspect token SID, then reverts before outbound HTTPS.
- [ ] **Step 6: Run GREEN and signing-oracle mutation.** Re-run focused tests. Temporarily permit a `sign` property/operation; the generic-signing negative test must fail. Restore and verify no residue.
- [ ] **Step 7: Regress/checkpoint.** Run full Python suite, PowerShell parser, secret scan, and `git diff --check`; stage exactly the five Task 11 paths; commit intent: `feat(idea2): constrain engine agent named pipe`.

### Task 12: Route Detection Engine Monitor Writes Through the Agent IPC Adapter

**Files:**
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/identity_agent_client.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_client.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/monitor_client.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md`

**Interfaces:** `IdentityAgentClient.submit(operation: str, payload: dict) -> bool` writes one bounded pipe request and returns success/failure without cryptographic fields. Existing `MonitorClient.post_detection/post_clip/post_heartbeat/post_alert` signatures remain unchanged. `EngineConfig.monitor_auth_mode` is `legacy_shared_key` or `identity_agent`; default remains `legacy_shared_key` for Detector B.

- [ ] **Step 1: Add RED config tests.** Assert default legacy behavior, identity-agent mode requiring only a canonical local pipe name (not Monitor URL/shared key in Engine), unknown-mode rejection, redaction, and Linux legacy path unchanged.
- [ ] **Step 2: Add RED client tests.** Assert every public `MonitorClient` method maps to one exact pipe operation/payload, request ID correlation, timeout/broken pipe/malformed response/Agent unavailable fail soft, no retry duplicates inside Engine, and no signature/session/private-key fields enter Engine memory or logs.
- [ ] **Step 3: Add startup safety RED tests.** Construct the Engine and execute an auth-unavailable heartbeat cycle with camera mocks. Assert camera-open count and viewer/demand counts remain zero; the IPC client never imports DPAPI or `cryptography` signing primitives.
- [ ] **Step 4: Run RED.** Run `python -m unittest tests.test_config tests.test_identity_agent_client -v`. Expected: missing config mode/client and direct HTTP calls still observed.
- [ ] **Step 5: Add mode-selecting adapter.** Keep the legacy direct HTTP code as a private legacy transport. In `identity_agent` mode instantiate `IdentityAgentClient`; public MonitorClient methods build existing payloads and delegate. Do not change engine.py/heartbeat worker/camera lifecycle call sites.

```python
if self._auth_mode == "identity_agent":
    return self._agent.submit(operation, body)
return self._legacy_post(path, body)
```

- [ ] **Step 6: Run GREEN and Detector B check.** Re-run focused tests and the existing monitor-client/runtime tests. Confirm the default uses the legacy key/header and never imports pywin32 on Linux until identity-agent mode is selected.
- [ ] **Step 7: Run camera lifecycle regression.** Run `python -m unittest tests.test_engine_lifecycle tests.test_viewer_demand tests.test_stream_lifecycle_regression -v`; startup/auth/failure paths must not open the camera or change reference counts.
- [ ] **Step 8: Validate/checkpoint.** Run full Engine suite, compileall, `git diff --check`; stage only the six Task 12 paths; commit intent: `feat(idea2): route machine-a ingest through identity agent`.

### Task 13: Send Heartbeat Through the Authenticated Agent Path

**Files:**
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_protocol.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/transport.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_pipe_protocol.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_session.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_client.py`
- Modify: `IDEA2-AEGIS_Monitor/tests/agentIngestProvenance.test.mjs`

**Interfaces:** Heartbeat pipe payload keeps existing logical/metric fields only; Agent maps it to `POST /internal/heartbeat` and `AEGIS-AGENT-HEARTBEAT-V1`. Node and physical identity come only from Agent session/Monitor registry.

- [ ] **Step 1: Add RED end-to-end heartbeat test.** Compose fake Engine pipe client → Agent dispatcher → exact-byte HTTPS fake → Monitor middleware/store. Assert one heartbeat uses a unique sequence/nonce, persists trusted physical identity, preserves logical camera/stream metrics, and ignores forged identity fields because the pipe parser rejects them.
- [ ] **Step 2: Add camera-closed RED assertions.** During Agent startup, challenge, auth, renewal, heartbeat success, `401` reauth, and network failure, assert no call reaches `VideoCapture`, StreamHub viewer acquisition, producer lease, or demand API.
- [ ] **Step 3: Run RED.** Run focused Python Agent/Engine tests and `node --test --test-name-pattern="heartbeat" tests/agentIngestProvenance.test.mjs`. Expected: the four-layer heartbeat composition or camera-isolation assertion is absent/failing.
- [ ] **Step 4: Wire only the heartbeat operation.** Keep HeartbeatWorker unchanged. Pipe validator whitelists current heartbeat fields and size/range types; Agent transport selects the fixed heartbeat path/domain and uses current session proof; Monitor persists `verifiedNode.physicalCameraId`.
- [ ] **Step 5: Run GREEN and mutation.** Re-run focused tests. Temporarily change heartbeat proof domain to detection; cross-domain verification must fail and no store write may occur. Restore immediately.
- [ ] **Step 6: Regress/checkpoint.** Run full Monitor and Engine suites plus `git diff --check`; stage exactly the six Task 13 paths; commit intent: `feat(idea2): authenticate machine-a heartbeat`.

### Task 14: Send Detection, Alert, and Clip Ingest Through the Agent

**Files:**
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_protocol.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/transport.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_pipe_protocol.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_session.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_client.py`
- Modify: `IDEA2-AEGIS_Monitor/tests/agentIngestProvenance.test.mjs`

**Interfaces:** Operations map one-to-one: `detection`→`/internal/detections`/`AEGIS-ENGINE-DETECTION-V1`; `alert`→`/internal/alerts`/`AEGIS-ENGINE-ALERT-V1`; `clip`→`/internal/clips`/`AEGIS-ENGINE-CLIP-V1`.

- [ ] **Step 1: Add RED operation matrix.** For each operation, assert exact current payload schema, fixed route/domain, unique sequence/nonce, exact body bytes, server physical provenance, logical camera compatibility, non-2xx fail-soft return, and no cross-operation signature reuse.
- [ ] **Step 2: Add bounded retry semantics.** Tests prove the Agent may reauthenticate once after session rejection but never reuses a sequence/nonce and never automatically resubmits a write after an uncertain connection/response loss; that uncertainty is logged by stable category without body content.
- [ ] **Step 3: Run RED.** Run `python -m unittest tests.test_agent_pipe_protocol tests.test_agent_session tests.test_identity_agent_client -v` and `node --test --test-name-pattern="detection|alert|clip" tests/agentIngestProvenance.test.mjs`. Expected: operation dispatch/domain/schema assertions fail until all fixed mappings are present.
- [ ] **Step 4: Add fixed dispatch table.** Use an immutable operation→path/domain/schema mapping. Reject all extra properties before session/signature creation. Preserve current local recording/NAS behavior when Monitor submission fails.
- [ ] **Step 5: Run GREEN and domain/body mutations.** Temporarily swap detection/alert domains and alter serialized body after hashing; corresponding negative tests must fail with zero store writes. Restore immediately.
- [ ] **Step 6: Run related regressions.** Run Engine alert/NAS tests and Monitor full suite. Confirm clip success semantics still depend on existing NAS verification and no biometric payload/log changes occur.
- [ ] **Step 7: Validate/checkpoint.** Run full Monitor/Engine suites and `git diff --check`; stage exactly the six Task 14 paths; commit intent: `feat(idea2): authenticate machine-a event ingest`.

### Task 15: Complete Windows Install, Repair, Status, and Uninstall Tooling

**Files:**
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/status_identity_agent.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/repair_identity_agent.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/uninstall_identity_agent.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/README.md`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/install_identity_agent.ps1`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/README.md`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_windows_service.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_autostart.py`

**Interfaces:** Every script supports `-WhatIf` where mutation is possible, accepts explicit source/runtime paths, emits stable key-value evidence without secrets, and targets only service `AEGISIdentityAgent` plus `%ProgramFiles%/%ProgramData%\AEGIS\IdentityAgent`.

- [ ] **Step 1: Add RED lifecycle script tests.** Assert install refuses non-elevated execution and missing SHA/config; status reports service account/start mode/profile/DPAPI-preflight/key-blob metadata/pipe ACL without values; repair preserves encrypted key unless explicitly rotating through a separate human gate; uninstall stops/deletes only the Agent service and preserves blob by default.
- [ ] **Step 2: Add coexistence RED tests.** Hash/parse the existing Engine autostart and tunnel scripts before and after fixture execution. Assert Agent scripts never modify HKCU Engine startup, SYSTEM tunnel task/key, `.env`, camera source, models, enrollment, Telegram, or ports.
- [ ] **Step 3: Run RED.** Run `python -m unittest tests.test_agent_windows_service tests.test_windows_autostart -v`. Expected: missing status/repair/uninstall/README and incomplete lifecycle contracts.
- [ ] **Step 4: Add exact scripts.** Each script resolves literal paths, validates targets are under the two Agent roots, prints planned mutations before applying, avoids recursive deletion of broad roots, never reads private plaintext, and returns nonzero when service identity/DACL/profile/pipe prerequisites differ.
- [ ] **Step 5: Add README operator flow.** Document H1–H10 in order, certificate HTTPS dependency, rollback, no auto-downgrade, preserved Detector B, and camera-closed evidence. Commands must use placeholders supplied at execution time and never include real node IDs, keys, database URLs, or credentials.
- [ ] **Step 6: Run GREEN/static checks.** Run both focused tests, parse every identity-agent PowerShell script, execute only their read-only/status or `-WhatIf` paths in a disposable directory, and confirm no Windows service/system change occurred.
- [ ] **Step 7: Regress/checkpoint.** Run full Engine suite, changed-path secret scan, `git diff --check`; stage exactly the eight Task 15 paths; commit intent: `feat(idea2): add identity agent windows lifecycle tooling`.

### Task 16: Run Full Regression and Security Negative Controls

**Files:**
- Modify: `IDEA2-AEGIS_Monitor/package.json`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/README.md`
- Modify only if a proven test gap remains: the focused test files created in Tasks 1–15

**Interfaces:** Produces no new runtime interface. It closes source-level verification and records exact environment-bound limitations.

- [ ] **Step 1: Freeze test inventory.** Ensure `npm test` includes Agent protocol/state/auth/request/provenance/compatibility tests. Record exact Node/Python/PowerShell/PostgreSQL versions and source SHA before execution.
- [ ] **Step 2: Run Monitor suites.** From `IDEA2-AEGIS_Monitor`, run:

```text
npm test
npm run test:registry
npm run test:ui-freeze
npm run test:browser
npm run build
node --test tests/liveCamera.test.mjs tests/designContract.test.mjs
```

All must exit 0; conditional PostgreSQL cases are not counted as proven by a run without `AEGIS_MONITOR_TEST_DATABASE_URL`.
- [ ] **Step 3: Run disposable PostgreSQL 15 suites.** Apply schema/migrations 001–004 twice and run registry, CLI, Agent auth-mode, legacy compatibility, provenance, rotation/remap, and four-route writes with `AEGIS_MONITOR_TEST_DATABASE_URL` bound only to the disposable database. Verify cleanup and zero Production connection strings.
- [ ] **Step 4: Run Engine/Agent suites.** From `detection-engine`, run:

```text
python -m unittest discover -s tests -v
python -m compileall -q aegis_engine aegis_identity_agent
```

Then parse all `windows/**/*.ps1`. Every test must pass; Windows real service/DPAPI/pipe assertions remain human-gated, not inferred from mocks.
- [ ] **Step 5: Run RED controlled security mutations one at a time.** Break domain, body hash, method, path, challenge consumption, sequence replay, nonce replay, timestamp checks, live key version, required-mode legacy denial, physical provenance source, and pipe generic-signing rejection. Each named test must turn RED. Restore immediately, rerun GREEN, and prove `git diff` has no mutation residue.
- [ ] **Step 6: Inspect security boundaries.** Search changed production files for private-key literals, DPAPI plaintext logs, `verify=False`, query-capable signed URLs, browser imports, camera/lifecycle imports, raw signing operations, secret-bearing logs, and body-derived trusted identity. Review every match in context; tests may contain only clearly marked non-secret fixtures.
- [ ] **Step 7: Prove UI/camera freeze.** `git diff --name-only 8323eb8432164c4b012b8dfb8bb6cdfb2d5013fa...HEAD -- IDEA2-AEGIS_Monitor/src` must be empty. Hash the protected camera/lifecycle files and compare with that CP3 design checkpoint. Run the full six-row machine/account matrix plus SOC passive tests as regressions without changing CP5 behavior.
- [ ] **Step 8: Local code/security review.** Review all CP3 commits for Critical/Important/Minor findings. Fix Critical/Important through a new RED test and focused checkpoint before continuing; document Minor findings or fix only within scope.
- [ ] **Step 9: Validate/checkpoint.** Run `git diff --check`; update only test wiring/docs needed to record exact commands; stage exact reviewed paths; commit intent: `test(idea2): close cp3 authenticated ingest verification`.

### Task 17: Prepare Machine A Acceptance and Final Task Handoff

**Files:**
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/README.md`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md`
- Modify: `IDEA2-AEGIS_Monitor/server/cli/README.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- Create only at final task closeout: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_pub_cp3-machine-a-agent-identity.md`

**Interfaces:** Documentation invokes the exact scripts/routes/configuration defined in Tasks 2, 4, 8, 9, 10, and 15. It does not execute H1–H10 or claim their evidence.

- [ ] **Step 1: Add acceptance checklist assertions before prose changes.** Extend `test_agent_windows_service.py` to assert the runbook names every H1–H10 gate, required evidence, abort, and rollback; asserts HTTPS dependency precedes H6/H10; asserts Detector B remains legacy; and rejects commands that weaken TLS or auto-switch a node.
- [ ] **Step 2: Run RED.** Run `python -m unittest tests.test_agent_windows_service -v`. Expected: missing H-gate evidence/abort/rollback sections.
- [ ] **Step 3: Add exact acceptance preparation.** Write copy/paste-safe commands using script parameters and explicit non-secret placeholders. Include pre/post Git SHA, installed source SHA, service identity, certificate validation, public fingerprint, exact live node inspection, Agent session result, four signed operations, service/reboot persistence, camera-closed metrics, mode switch, legacy Detector B probe, rollback, and residue collection.
- [ ] **Step 4: Run GREEN and document validation.** Re-run the focused test, Vault validator, repository document tests, changed-path secret scan, and `git diff --check`.
- [ ] **Step 5: Stop for H1–H10.** Codex does not install the service, generate a real key, inspect/mutate live registry, switch auth mode, or run Production acceptance. Human evidence is appended to the canonical status only after each gate actually runs.
- [ ] **Step 6: Final receipt boundary.** Create the single Pub receipt only after all applicable human gates and source verification are complete or the owner intentionally closes the task as partial/blocked. Record exact changed/shared paths, evidence maturity, limitations, HTTPS dependency, rollout/rollback, and integration review request. Do not create a session receipt.
- [ ] **Step 7: Final PR-ready checkpoint.** Run collaboration-policy validation with the actual changed-file list, Vault validation, full regression as applicable to the final SHA, `git diff --check`, and secret/artifact scan. Stage exact status/docs/receipt paths and commit intent: `docs(idea2): close cp3 machine-a identity evidence`.
- [ ] **Step 8: Publication boundary.** Push the task branch and create/update one Draft PR only after owner approval. Never merge; the responsible human performs merge after functional/integration review.

---

## Detailed File Responsibilities

### CREATE

**Monitor protocol and authentication**

- `IDEA2-AEGIS_Monitor/server/nodeIdentity/agentProtocol.js` — constants, token/integer validation, canonical auth/request byte builders, and exact SHA-256 helper.
- `IDEA2-AEGIS_Monitor/server/nodeIdentity/challengeStore.js` — bounded challenge issuance, claim/release/consume state, TTL purge, and capacity errors.
- `IDEA2-AEGIS_Monitor/server/nodeIdentity/replayWindow.js` — pure uint64/64-bit-window transition and nonce-digest admission.
- `IDEA2-AEGIS_Monitor/server/nodeIdentity/agentSessionStore.js` — bounded Agent sessions, replacement, expiry, renewal metadata, and atomic replay admission.
- `IDEA2-AEGIS_Monitor/server/nodeIdentity/ed25519.js` — PEM public-key parsing and Ed25519 verification only.
- `IDEA2-AEGIS_Monitor/server/routes/agentAuth.js` — challenge and verification endpoints.
- `IDEA2-AEGIS_Monitor/server/middleware/authenticateDetectionIngest.js` — complete/partial/absent header selection, signed-request verification, live registry checks, and legacy compatibility.
- `IDEA2-AEGIS_Monitor/server/db/migrations/004_detection_node_ingest_auth_mode.sql` — additive per-node auth-mode column and constraint.

**Monitor tests and shared vectors**

- `IDEA2-AEGIS_Monitor/tests/fixtures/agentProofV1.json` — fixed non-secret auth/request canonical byte and signature vectors consumed by Node and Python.
- `IDEA2-AEGIS_Monitor/tests/agentProtocol.test.mjs` — canonical serialization, parser, domain, raw-body, and cross-language vector tests.
- `IDEA2-AEGIS_Monitor/tests/agentState.test.mjs` — challenge/session/replay state tests with injected clock/randomness.
- `IDEA2-AEGIS_Monitor/tests/agentAuth.test.mjs` — Agent auth route and concurrency tests.
- `IDEA2-AEGIS_Monitor/tests/agentRequestProof.test.mjs` — per-request middleware, downgrade, rotation, and negative-control tests.
- `IDEA2-AEGIS_Monitor/tests/agentIngestProvenance.test.mjs` — four-route trusted provenance and legacy-nullability tests.
- `IDEA2-AEGIS_Monitor/tests/detectorCompatibility.test.mjs` — Detector B legacy continuity and Machine A downgrade denial.

**Identity Agent**

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/__init__.py` — package marker and public API boundary.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/config.py` — Agent-only environment parsing and redacted configuration view.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/protocol.py` — Python canonicalization, exact JSON body serializer, token/integer checks, domains, and proof headers.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/sequence.py` — locked uint64 sequence allocation and session reset.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/key_store.py` — DPAPI adapter, encrypted key envelope, Ed25519 generation/load, and public-key export.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/session_client.py` — challenge/verify/renew state machine with in-memory session only.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/transport.py` — exact-byte signed HTTPS transport for the four operations.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_protocol.py` — strict four-operation request/response schemas and 64 KiB framing.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_server.py` — local named-pipe server, DACL enforcement, timeout, and dispatch.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/windows_service.py` — pywin32 `AEGISIdentityAgent` service host.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/run_identity_agent.py` — foreground diagnostic/service entry point without camera imports.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements-identity-agent-windows.txt` — pinned-range Agent dependencies, separate from Linux/core requirements.

**Agent, Engine, and Windows tests/tooling**

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_protocol.py` — Python canonical/golden-vector parity.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_session.py` — Agent authentication, renewal, restart, and fail-soft behavior.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_key_store.py` — mocked DPAPI envelope and no-plaintext guarantees.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_pipe_protocol.py` — schema/framing/security tests independent of Windows.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_windows_service.py` — Windows service/DACL/script contract tests, skipped only when a real Windows API is indispensable.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_client.py` — Engine named-pipe client and fail-soft tests.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/install_identity_agent.ps1` — non-secret files, virtual service identity, venv, DACL, and preflight provisioning.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/invoke_dpapi_preflight.ps1` — service-identity CurrentUser DPAPI round-trip gate without application key.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/provision_identity_key.ps1` — post-preflight key generation/public export invocation.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/status_identity_agent.ps1` — redacted service/profile/key-file/pipe status.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/repair_identity_agent.ps1` — in-place binary/config/ACL repair without key disclosure or replacement.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/uninstall_identity_agent.ps1` — service removal while preserving encrypted key blob unless separately authorized.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/README.md` — exact operator sequence, evidence, abort, and rollback boundaries.

### MODIFY

- `IDEA2-AEGIS_Monitor/server/index.js` — bounded raw-body capture, auth-route mount, and dual-mode ingest middleware mount.
- `IDEA2-AEGIS_Monitor/server/middleware/requireDetectionEngineKey.js` — expose the existing timing-safe key comparison as the bounded legacy primitive used by dual-mode middleware.
- `IDEA2-AEGIS_Monitor/server/routes/internal.js` — pass `req.ingestAuth`/`req.verifiedNode` to write operations; retain legacy GET route under the shared-key boundary.
- `IDEA2-AEGIS_Monitor/server/db/connection.js` — expose live registry identity including `ingestAuthMode` and add exact-node mode update support.
- `IDEA2-AEGIS_Monitor/server/db/store.js` — accept trusted provenance as a separate argument and never trust body identity.
- `IDEA2-AEGIS_Monitor/server/db/schema.sql` — bootstrap schema parity with migration 004.
- `IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py` — explicit `set-auth-mode --node-id --mode` command and non-secret listing.
- `IDEA2-AEGIS_Monitor/server/cli/README.md` — safe mode-transition procedure.
- `IDEA2-AEGIS_Monitor/package.json` — focused Agent-auth/protocol/provenance test scripts and inclusion in `npm test`.
- `IDEA2-AEGIS_Monitor/.env.example` — non-secret `AEGIS_AGENT_AUTH_AUDIENCE` contract only.
- `IDEA2-AEGIS_Monitor/tests/nodeRegistry.test.mjs` — registry mapping includes auth mode.
- `IDEA2-AEGIS_Monitor/tests/registryMigrations.test.mjs` — migration 004 static and disposable PostgreSQL coverage.
- `IDEA2-AEGIS_Monitor/tests/test_manage_nodes.py` — CLI parser/output/mode mutation unit coverage.
- `IDEA2-AEGIS_Monitor/tests/test_manage_nodes_postgres.py` — real PostgreSQL mode transition and Detector B preservation.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py` — explicit Monitor transport mode and pipe name while retaining legacy defaults.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/monitor_client.py` — preserve public posting API while delegating Machine A writes to the Agent pipe.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example` — documents `legacy_shared_key` versus `identity_agent`; contains no key.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md` — Agent boundary, Detector B compatibility, and HTTPS dependency.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/README.md` — links the independent Agent service lifecycle without changing Engine/tunnel ownership.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_config.py` — transport-mode validation and redaction.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_autostart.py` — existing Engine/tunnel scripts remain unchanged and key-free.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — checkpoint truth after each coherent CP3 session; no final receipt until task closeout.

### REUSE_UNCHANGED

- `IDEA2-AEGIS_Monitor/server/auth/cameraAccess.js` — server-side browser camera authorization remains separate from Agent ingest.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/heartbeat_worker.py` — public `MonitorClient.post_heartbeat` call remains stable.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/alert_manager.py` and `nas_sync.py` — keep current `MonitorClient` call sites.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_engine.ps1`, `run_engine_supervisor.ps1`, and tunnel scripts — existing interactive camera and SYSTEM SSH lifecycle.
- `IDEA2-AEGIS_Monitor/tests/liveCamera.test.mjs`, `designContract.test.mjs`, `uiFreezeCurrentMain.test.mjs`, and browser suite — regression evidence, not implementation targets.

### DO_NOT_TOUCH

- `IDEA2-AEGIS_Monitor/src/**` and all visible UI assets.
- `IDEA2-AEGIS_Monitor/server/streamLifecycle.js`, `server/auth/cameraAccess.js`, and producer/demand implementation.
- `IDEA2-AEGIS_Monitor/server/db/migrations/001_device_owned_local_runtime.sql`, `002_physical_camera_logical_alias.sql`, and `003_deprecate_node_camera_identity.sql`.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py`, `video_catcher.py`, `camera_devices.py`, recognition/model code, model weights, training data, and biometric enrollment.
- `gateway/**`, `docker-compose*.yml`, root `.env*`, Twingate, firewall, SSH keys/configuration, Docker state, and Production state.
- Browser-to-machine association (CP4) and Operator producer/demand/camera activation (CP5).

## Detailed Interface Reference

All later tasks use these names and shapes exactly.

### Monitor JavaScript interfaces

```js
// server/nodeIdentity/agentProtocol.js
export const AGENT_PROTOCOL = Object.freeze({
  authDomain: 'AEGIS-AGENT-AUTH-V1',
  routeDomains: Object.freeze({
    '/internal/heartbeat': 'AEGIS-AGENT-HEARTBEAT-V1',
    '/internal/detections': 'AEGIS-ENGINE-DETECTION-V1',
    '/internal/alerts': 'AEGIS-ENGINE-ALERT-V1',
    '/internal/clips': 'AEGIS-ENGINE-CLIP-V1',
  }),
  productionAudience: 'urn:aegis:monitor:idea2:production',
  testAudience: 'urn:aegis:monitor:idea2:test',
  challengeTtlMs: 60_000,
  sessionTtlMs: 600_000,
  renewalThresholdMs: 120_000,
  pastSkewMs: 30_000,
  futureSkewMs: 10_000,
  replayWindowSize: 64n,
})

export function validateCanonicalToken(value, fieldName) {}
export function parseUint64Decimal(value, fieldName, { positive = false } = {}) {}
export function sha256Hex(bodyBytes) {}
export function canonicalizeAgentAuth({ challengeId, nonce, issuedAtMs, expiresAtMs, audience, nodeId, keyVersion }) {}
export function canonicalizeAgentRequest({ domain, sessionId, requestNonce, timestampMs, sequence, method, path, bodySha256 }) {}

// server/nodeIdentity/challengeStore.js
export function createChallengeStore({ clock, randomBytes, maxPerNode = 4, maxTotal = 1024 }) {}
// returns { issue(input), beginVerification(challengeId), finishVerification(claimId, success), purgeExpired() }

// server/nodeIdentity/replayWindow.js
export function advanceReplayWindow({ highest, bitmap }, sequence) {}
// returns { accepted, reason, highest, bitmap }; highest/bitmap/sequence are BigInt

// server/nodeIdentity/agentSessionStore.js
export function createAgentSessionStore({ clock, randomBytes, maxSessions = 1024 }) {}
// returns { issue(identity), get(sessionId), admitReplay(sessionId, requestMeta), invalidateNode(nodeId), purgeExpired() }

// server/nodeIdentity/ed25519.js
export function verifyEd25519({ publicKeyPem, signatureBase64Url, payloadBytes }) {}

// server/db/connection.js
export async function getDetectionNodeIdentity(nodeId) {}
// -> { nodeId, publicKey, publicKeyFingerprint, keyVersion, active,
//      ingestAuthMode, physicalCameraId, physicalCameraActive } | null
export async function setDetectionNodeIngestAuthMode(nodeId, ingestAuthMode) {}

req.verifiedNode = Object.freeze({ nodeId, keyVersion, physicalCameraId, agentSessionId })
req.ingestAuth = Object.freeze({ kind: 'ed25519' })

// Legacy success sets no verified physical identity.
req.verifiedNode = null
req.ingestAuth = Object.freeze({ kind: 'legacy_unverified' })
```

### Identity Agent Python interfaces

```python
# aegis_identity_agent/protocol.py
def canonicalize_agent_auth(payload: "AgentAuthPayload") -> bytes: ...
def canonicalize_agent_request(payload: "AgentRequestProof") -> bytes: ...
def serialize_json_body(payload: Mapping[str, object]) -> bytes: ...
def build_proof_headers(proof: "AgentRequestProof", signature: bytes) -> dict[str, str]: ...

# aegis_identity_agent/sequence.py
class SequenceAllocator:
    def bind_session(self, session_id: str) -> None: ...
    def next(self) -> int: ...
    def clear(self) -> None: ...

# aegis_identity_agent/key_store.py
class DataProtector(Protocol):
    def protect(self, plaintext: bytes, entropy: bytes) -> bytes: ...
    def unprotect(self, ciphertext: bytes, entropy: bytes) -> bytes: ...

class DpapiCurrentUserProtector(DataProtector): ...
class IdentityKeyStore:
    def generate(self) -> "PublicIdentity": ...
    def load_signer(self) -> "IdentitySigner": ...
    def export_public_identity(self) -> "PublicIdentity": ...

# aegis_identity_agent/session_client.py
class AgentSessionClient:
    def ensure_session(self) -> "AgentSession": ...
    def invalidate(self) -> None: ...

# aegis_identity_agent/transport.py
class AgentTransport:
    def submit(self, request: "AgentOperationRequest") -> "AgentOperationResponse": ...

# aegis_identity_agent/pipe_protocol.py
@dataclass(frozen=True)
class AgentOperationRequest:
    request_id: str
    operation: Literal['heartbeat', 'detection', 'alert', 'clip']
    payload: Mapping[str, object]

@dataclass(frozen=True)
class AgentOperationResponse:
    request_id: str
    ok: bool
    status: Literal['ACCEPTED', 'INVALID_OPERATION', 'AGENT_UNAVAILABLE', 'UPSTREAM_REJECTED']
```

Pipe responses never contain private key bytes, public-key signatures, Agent session IDs, request nonces, or sequence values.

### Raw-body and authentication mount order

```js
app.use(express.json({
  limit: '16kb',
  verify(req, _res, buffer) {
    req.rawBody = Buffer.from(buffer)
  },
}))
app.use('/internal/agent-auth', agentAuthRouter)
app.use('/internal', authenticateDetectionIngest, internalRouter)
```

`authenticateDetectionIngest` applies to the four signed POST paths. `GET /internal/route/:cameraId` retains its current shared-key requirement because it is neither an authenticated write nor part of the Agent pipe contract.

---
