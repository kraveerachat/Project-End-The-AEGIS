# AEGIS IDEA2 Machine A No-PowerShell Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a repository-native Machine A runtime where the Engine, Identity Agent, and tunnel start automatically, the idle camera stays closed, the authenticated account selects CAM-01 or CAM-02, and the verified Machine A identity always selects the same physical Camera A without manual terminals, heartbeat loops, or the diagnostic `:18078` bridge.

**Architecture:** A dedicated Windows Identity Agent owns a DPAPI-protected Ed25519 key, authenticates physical provenance, and exposes one strict loopback browser-association endpoint. Monitor binds the verified Node and physical camera to the server-side login session, resolves the account's logical alias from PostgreSQL, and proxies only the registered physical stream. The interactive Detection Engine remains the sole webcam owner and opens capture only while authorized demanding viewers exist.

**Tech Stack:** Node.js ESM, Express 4, PostgreSQL 15, Node `crypto` Ed25519, React 19, Python 3.14-compatible code, `cryptography`, `pywin32`, Windows DPAPI and services, named pipes, PowerShell 5.1 installer/operator tooling, `node:test`, Python `unittest`, Playwright, Vite.

**Specs:**
- `docs/superpowers/specs/2026-09-13-idea2-cp3-machine-a-agent-identity-design.md`
- `docs/superpowers/specs/2026-09-14-idea2-camera-first-slice1-machine-association-design.md`
- Human-owner master requirement dated 2026-09-19, which defines No-PowerShell as zero manual terminal workflow rather than the absence of a background PowerShell process.

## Global Constraints

- Work only on `feat/idea2-machine-a-no-powershell-runtime`, based on `origin/main` `c5468c520f24d29fb37fefcf7c4411b91d4087f4` at task start.
- Do not open a Pull Request until automated verification and Human Machine A local acceptance both pass.
- Do not deploy or mutate Production, Production PostgreSQL, Docker, gateway, Twingate, firewall, network, camera hardware, model weights, training data, or biometric data.
- Do not mutate the installed Machine A runtime before the explicit installation gate.
- Do not create a second Engine startup owner; preserve HKCU Run for the interactive Engine and the SYSTEM Scheduled Task for the SSH tunnel.
- The Identity Agent binds exactly `127.0.0.1:8078`; the Engine remains on `127.0.0.1:8077`.
- The private Ed25519 key never enters browser JavaScript, Detection Engine memory, logs, fixtures, or the repository.
- Browser fields, IP, hostname, User-Agent, storage, query parameters, heartbeat payloads, and arbitrary headers never establish Node, physical-camera, or alias authority.
- Machine identity selects physical camera. Live authenticated account policy selects logical alias. `camera_assignment` remains responsibility/admin/notification state.
- Machine A + operator resolves physical A/CAM-01; Machine A + operator2 resolves the same physical A/CAM-02. No Machine-A-to-CAM-01 hardcoding is permitted.
- Authentication, Agent startup, heartbeat, association, renewal, and retry traffic create no stream demand and never open the camera.
- Preserve PR #134's stream watchdog and idempotent asynchronous cleanup behavior.
- Preserve explicit Detector B `legacy_shared_key` compatibility until a separately approved migration.
- Do not implement final SOC passive/no-wake, Machines B/C rollout, archival footage, Telegram completion, or Production acceptance in this task.
- Create no immutable receipt until Human Machine A acceptance passes and the task reaches final PR handoff.
- Stage exact paths only. Never use `git add .`, `git add -A`, rebase, force-push, direct push to `main`, or agent merge.

## Review Focus

1. Duplicate JSON keys, oversized/chunked bodies, malformed Base64URL, and exact-expiry boundaries must fail closed before expensive parsing or signature work; Tasks 2, 3, and 7 own these tests.
2. Node disable, key rotation, physical-camera remap/deactivation, account disable/role change, and Monitor restart must invalidate existing authority; Tasks 3 and 7 own these tests.
3. A shared-key caller, logical heartbeat, or forged request body must never acquire trusted physical provenance or redirect the strict physical stream; Tasks 4, 6, and 9 own these tests.
4. Service restart, user login, Agent renewal failure, Engine reconnect, and browser retry must never open the camera or leak viewer demand; Tasks 5, 10, and 11 own these tests.
5. Two tabs, account switching, aborted MJPEG upstreams, and logout during streaming must release exactly the appropriate demand without negative counters or stale session inheritance; Tasks 8 and 10 own these tests.

---

### Task 1: Record the Session Boundary and Characterize Current Main

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- Test: repository status, current-main source inventory, and protected-path hashes

**Interfaces:**
- Consumes: current `origin/main`, the two approved specs, the completed Machine A prerequisite preflight.
- Produces: one canonical `IN PROGRESS` Current Task and Session Register entry with branch, start SHA, scope, safety boundary, and evidence targets.

- [ ] **Step 1: Capture protected baselines**

Run:

```powershell
git branch --show-current
git rev-parse HEAD
git rev-parse origin/main
git status --short
git diff --check
Get-FileHash IDEA2-AEGIS_Monitor/server/routes/api.js -Algorithm SHA256
Get-FileHash IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py -Algorithm SHA256
```

Expected: branch is `feat/idea2-machine-a-no-powershell-runtime`, HEAD equals the recorded start SHA, and worktree changes contain only this plan before the status edit.

- [ ] **Step 2: Add the canonical task/session block**

Record `Production mutation allowed: NO`, the master goal, exact out-of-scope list, Phase 0 evidence, Windows preflight facts, and Session S1 as `IN PROGRESS`. Do not claim implementation or runtime acceptance.

- [ ] **Step 3: Validate documentation state**

Run:

```powershell
node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
node --test tests/vaultStructure.test.mjs tests/vaultMultiWriter.test.mjs
git diff --check
```

Expected: validators pass, apart from explicitly identified pre-existing warnings.

- [ ] **Step 4: Checkpoint planning/session start**

Stage only the plan and `idea2-status.md`; inspect cached diff; commit:

```text
docs(idea2): plan machine a permanent runtime
```

---

### Task 2: Add Canonical Agent Protocol and Per-Node Authentication Mode

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/agentProtocol.js`
- Create: `IDEA2-AEGIS_Monitor/tests/fixtures/agentProofV1.json`
- Create: `IDEA2-AEGIS_Monitor/tests/agentProtocol.test.mjs`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/__init__.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/protocol.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_protocol.py`
- Create: `IDEA2-AEGIS_Monitor/server/db/migrations/004_detection_node_ingest_auth_mode.sql`
- Modify: `IDEA2-AEGIS_Monitor/server/db/schema.sql`
- Modify: `IDEA2-AEGIS_Monitor/server/db/connection.js`
- Modify: `IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py`
- Modify: `IDEA2-AEGIS_Monitor/server/cli/README.md`
- Modify: `IDEA2-AEGIS_Monitor/tests/nodeRegistry.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/tests/registryMigrations.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/tests/test_manage_nodes.py`
- Modify: `IDEA2-AEGIS_Monitor/tests/test_manage_nodes_postgres.py`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:**
- Produces: fixed domains `AEGIS-AGENT-AUTH-V1`, `AEGIS-AGENT-HEARTBEAT-V1`, `AEGIS-ENGINE-DETECTION-V1`, `AEGIS-ENGINE-ALERT-V1`, `AEGIS-ENGINE-CLIP-V1`, canonical UTF-8 byte serialization, strict canonical token parsing, and `ingestAuthMode: 'legacy_shared_key' | 'ed25519_required'`.
- Migration 004 adds `detection_nodes.ingest_auth_mode TEXT NOT NULL DEFAULT 'legacy_shared_key'` with the exact two-value check and changes no existing row to strict mode.

- [ ] **Step 1: Write cross-language RED vectors**

Cover valid vectors plus wrong domain, reordered/altered fields, duplicate JSON keys, invalid UTF-8, malformed Base64URL, leading non-alphanumeric canonical token, body-size boundary, and nonce/sequence integer bounds.

- [ ] **Step 2: Run RED**

```powershell
cd IDEA2-AEGIS_Monitor
node --test tests/agentProtocol.test.mjs tests/nodeRegistry.test.mjs tests/registryMigrations.test.mjs
cd ../IDEA2-AEGIS_CCTV-Operator/detection-engine
python -m unittest tests.test_agent_protocol -v
```

Expected: failures identify absent protocol and auth-mode fields, not fixture or syntax errors.

- [ ] **Step 3: Implement canonical protocol and additive migration**

Both languages must produce byte-identical canonical messages. Reject unknown fields and non-canonical encodings. Keep migration additive and rerunnable; grant required application-role DML explicitly when migration ownership differs.

- [ ] **Step 4: Run GREEN and real PostgreSQL gate**

Run the focused Node/Python suites three times and run registry/migration tests against disposable PostgreSQL 15 using `AEGIS_MONITOR_TEST_DATABASE_URL`. Apply migration 004 twice and verify row stability and unchanged legacy modes.

- [ ] **Step 5: Review and checkpoint**

Review domain separation, canonical equality, migration reversibility, and Detector B compatibility. Commit:

```text
feat(idea2): define agent proof and ingest modes
```

---

### Task 3: Implement Bounded Challenges, Agent Sessions, Replay State, and Authentication

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/challengeStore.js`
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/replayWindow.js`
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/agentSessionStore.js`
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/ed25519.js`
- Create: `IDEA2-AEGIS_Monitor/server/routes/agentAuth.js`
- Create: `IDEA2-AEGIS_Monitor/tests/agentState.test.mjs`
- Create: `IDEA2-AEGIS_Monitor/tests/agentAuth.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/server/index.js`
- Modify: `IDEA2-AEGIS_Monitor/.env.example`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:**
- `POST /internal/agent-auth/challenge` issues one short-lived one-use challenge bound to Node ID, audience, purpose, and server nonce.
- `POST /internal/agent-auth/verify` returns an opaque Agent session; server state stores `nodeId`, `physicalCameraId`, `keyVersion`, issued/expiry times, and replay window.
- Live registry revalidation must reject inactive/remapped Nodes/cameras and stale key versions.

- [ ] **Step 1: Write RED state tests**

Test exact-capacity eviction, exact expiry (`now >= expiresAt`), atomic one-use consumption, concurrent duplicate verification, replay window bounds, restart loss, and no secret material in errors/logs.

- [ ] **Step 2: Write RED authentication tests**

Test valid proof; wrong Node/key/domain/audience; stale version; inactive Node/camera; remap; expired/reused challenge; altered payload; generic error responses; and challenge/session creation causing zero producer or demand writes.

- [ ] **Step 3: Run RED and implement minimum state/auth routes**

Use injected clocks/randomness, fixed maximum map sizes, rejection sampling for canonical tokens, timing-safe digest comparison, and no automatic legacy fallback after any Agent-proof header is present.

- [ ] **Step 4: Run GREEN repeatedly**

```powershell
node --test tests/agentState.test.mjs tests/agentAuth.test.mjs
node --test tests/agentState.test.mjs tests/agentAuth.test.mjs
node --test tests/agentState.test.mjs tests/agentAuth.test.mjs
```

- [ ] **Step 5: Security review and checkpoint**

Review memory bounds, concurrency, replay, exact expiry, response uniformity, and secret logging. Commit:

```text
feat(idea2): authenticate dedicated node agents
```

---

### Task 4: Enforce Per-Request Ed25519 Proof and Trusted Physical Provenance

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/middleware/authenticateDetectionIngest.js`
- Create: `IDEA2-AEGIS_Monitor/tests/agentRequestProof.test.mjs`
- Create: `IDEA2-AEGIS_Monitor/tests/agentIngestProvenance.test.mjs`
- Create: `IDEA2-AEGIS_Monitor/tests/detectorCompatibility.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/server/index.js`
- Modify: `IDEA2-AEGIS_Monitor/server/routes/internal.js`
- Modify: `IDEA2-AEGIS_Monitor/server/db/store.js`
- Modify: `IDEA2-AEGIS_Monitor/server/middleware/requireDetectionEngineKey.js`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:**
- `req.verifiedNode = { nodeId, keyVersion, physicalCameraId, agentSessionId }` for Ed25519 requests.
- `req.ingestAuth.kind = 'ed25519' | 'legacy_unverified'`.
- Signed writes cover exact raw body bytes for heartbeat, detection, alert, and clip routes.
- Ed25519 writes persist server-derived `physical_camera_id`; legacy writes keep trusted physical provenance null.

- [ ] **Step 1: Add RED request-proof and provenance tests**

Test missing/partial headers, duplicate headers, wrong method/path/body hash/domain, stale/future timestamps, nonce replay, out-of-order sequence, concurrent duplicate request, body Node/physical spoofing, unknown physical mapping, and zero storage calls on failure.

- [ ] **Step 2: Add RED compatibility tests**

Prove `ed25519_required` rejects shared key, `legacy_shared_key` accepts only the explicitly bounded old path, an invalid Agent proof never falls back, and Detector B behavior remains unchanged.

- [ ] **Step 3: Implement middleware and store provenance**

Capture raw body with a fixed byte cap before JSON parsing. Resolve Node and physical camera only from session+registry. Preserve logical `cameraId` solely as event-time/business alias after policy validation.

- [ ] **Step 4: Run focused and PostgreSQL GREEN**

```powershell
node --test tests/agentRequestProof.test.mjs tests/agentIngestProvenance.test.mjs tests/detectorCompatibility.test.mjs
```

Repeat against disposable PostgreSQL and verify heartbeat/detection/alert/clip physical provenance plus bounded legacy null provenance.

- [ ] **Step 5: Mutation checks and checkpoint**

Temporarily remove body hashing, live key-version validation, and server physical resolution one at a time; require matching tests to RED; restore immediately. Commit:

```text
feat(idea2): bind ingest to physical node provenance
```

---

### Task 5: Build the DPAPI-Protected Dedicated Windows Identity Agent

**Files:**
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/config.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/sequence.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/session_client.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/transport.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/key_store.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/windows_service.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/run_identity_agent.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements-identity-agent-windows.txt`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_session.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_key_store.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_windows_service.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/invoke_dpapi_preflight.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/provision_identity_key.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/install_identity_agent.ps1`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md`

**Interfaces:**
- Agent runs as `NT SERVICE\AEGISIdentityAgent`.
- Key store loads only a DPAPI CurrentUser-protected Ed25519 seed under restrictive service-owned ACLs.
- `AgentSessionClient` authenticates over certificate-validated HTTPS and renews before expiry.
- No LocalMachine/plaintext fallback and no generic sign operation.

- [ ] **Step 1: Pin reproducible Agent dependencies**

Pin Python-3.14-compatible `cryptography`, `requests`, and `pywin32` in the Agent-specific requirements file. Do not change the installed Engine environment.

- [ ] **Step 2: Write RED configuration/session tests**

Cover HTTPS-only production URL, audience, timeouts, retry bounds, renewal threshold, disabled TLS bypass, redacted diagnostics, replay-safe sequence persistence, and camera-stays-closed side effects.

- [ ] **Step 3: Write RED DPAPI/service tests**

Inject protect/unprotect/sign functions. Test corrupt/wrong-user blobs, ACL widening, symlink/reparse paths, missing key, zero plaintext writes, service identity, stop handling, and no Engine/camera imports.

- [ ] **Step 4: Implement Agent core and service**

Use lazy Windows imports so non-Windows tests collect. Provisioning outputs only public key/fingerprint metadata. The installer creates an Agent-local environment and installs the pinned Agent requirements, including pywin32, without asking the human to modify the current Engine runtime manually.

- [ ] **Step 5: Run GREEN and checkpoint**

```powershell
python -m unittest tests.test_agent_session tests.test_agent_key_store tests.test_agent_windows_service -v
```

Perform private-key marker and secret-value scans. Commit:

```text
feat(idea2): add protected windows identity agent
```

---

### Task 6: Add Bounded Agent IPC and Route Engine Ingest Through It

**Files:**
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_protocol.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/pipe_server.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/identity_agent_client.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_pipe_protocol.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_client.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/windows_service.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/transport.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/monitor_client.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/heartbeat_worker.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example`

**Interfaces:**
- Pipe operations are exactly `heartbeat`, `detection`, `alert`, and `clip`.
- Engine submits bounded structured payloads and receives bounded success/error categories; it never receives keys, signatures, Agent sessions, Node authority, or arbitrary URLs.
- One heartbeat represents one physical Engine runtime, not CAM-01/CAM-02 account aliases.

- [ ] **Step 1: Write RED IPC tests**

Test operation allowlist, byte cap, duplicate JSON keys, timeout, broken pipe, caller ACL, concurrency, response cap, secret-field rejection, and absence of generic signing.

- [ ] **Step 2: Write RED Engine adapter tests**

Test all four operations, fail-soft network behavior, stable event-time logical alias, no body physical authority, Agent unavailable behavior, no shared-key downgrade in strict mode, and zero camera demand from heartbeat/auth retries.

- [ ] **Step 3: Implement IPC and adapter**

Keep Engine startup independent enough to expose local health while Agent connectivity recovers. Avoid unbounded queues; detection/heartbeat retries must not replay stale events across sessions.

- [ ] **Step 4: Run GREEN and regression**

Run focused Agent/Engine tests, then the full applicable Engine suite. Preserve and separately classify any pre-existing baseline failures.

- [ ] **Step 5: Checkpoint**

```text
feat(idea2): route engine ingest through identity agent
```

---

### Task 7: Implement Strict Browser-to-Agent Association Proof

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/browserAssociationProof.js`
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/browserAssociationChallenges.js`
- Create: `IDEA2-AEGIS_Monitor/tests/browserAssociationProof.test.mjs`
- Create: `IDEA2-AEGIS_Monitor/tests/localNodeChallenge.test.mjs`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/browser_protocol.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/browser_server.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_browser_protocol.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_browser_server.py`
- Create: `IDEA2-AEGIS_Monitor/tests/browserAssociationCrossLanguage.test.mjs`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/config.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/windows_service.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements-identity-agent-windows.txt`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:**
- Agent exposes only `OPTIONS` and `POST /v1/browser-association/assert` on `127.0.0.1:8078`.
- Browser-association proof uses a domain distinct from every ingest proof.
- Request and response bodies are capped; exact allowed origins are configured; credentials are omitted; private material is never returned.

- [ ] **Step 1: Add deterministic RED proof tests**

Cover cross-domain rejection, session binding, exact expiry, one-use challenge, wrong origin/audience, Node/key mismatch, duplicate keys, invalid tokens, and deterministic rejection sampling for leading token characters.

- [ ] **Step 2: Add RED loopback server tests**

Cover non-loopback bind refusal, IPv6 refusal unless explicitly designed, strict Origin and PNA/CORS behavior, preflight allowlist, chunked/absent Content-Length cap, slow/oversized body, rate limiting, and no camera/Engine imports.

- [ ] **Step 3: Implement proof and endpoint**

Use the existing protected key abstraction. The browser endpoint may sign only the fixed association structure and may not expose Agent ingest sessions or arbitrary signing.

- [ ] **Step 4: Run cross-language GREEN three times**

Run Node and Python focused suites three times to eliminate nondeterministic token failures.

- [ ] **Step 5: Security review and checkpoint**

```text
feat(idea2): add loopback machine association proof
```

---

### Task 8: Bind Verified Machine Authority to Login Sessions

**Files:**
- Modify: `IDEA2-AEGIS_Monitor/server/auth/session.js`
- Modify: `IDEA2-AEGIS_Monitor/server/routes/api.js`
- Create: `IDEA2-AEGIS_Monitor/src/lib/localNode.js`
- Modify: `IDEA2-AEGIS_Monitor/src/App.jsx`
- Create: `IDEA2-AEGIS_Monitor/tests/localNodeSession.test.mjs`
- Create: `IDEA2-AEGIS_Monitor/tests/localNodeLeaseMaintenance.test.mjs`
- Create: `IDEA2-AEGIS_Monitor/tests/browser/localNodeAssociation.spec.mjs`
- Modify: `IDEA2-AEGIS_Monitor/tests/uiFreezeCurrentMain.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:**
- Each login/regeneration receives a fresh 32-byte canonical `nodeSessionBinding`.
- `POST /api/local-node/challenge` and `POST /api/local-node/verify` require authentication and CSRF.
- Successful verify stores `{ nodeId, physicalCameraId, keyVersion, verifiedAt, expiresAt }` in the server session.
- `maintainLocalNodeAssociation()` relays public data only with `credentials: 'omit'` to loopback and uses existing same-origin `apiFetch()` back to Monitor.

- [ ] **Step 1: Write RED route/session tests**

Test regeneration, logout/relogin clearing, exact expiry, restart loss, Node disable/key rotation/remap/camera disable, account disable/role change, CSRF/auth, registry failure, and browser attempts to write identity through body/query/header/storage.

- [ ] **Step 2: Write RED browser tests**

Test success, unavailable Agent, invalid assertion, retry/renewal bounds, no secret/token storage, no visible UI change, and no association request for SOC camera activation.

- [ ] **Step 3: Implement invisible association**

Association may begin after authenticated Operator session establishment, but it creates no stream request or demand. Failure remains visible only through the existing honest unavailable path, not fabricated success.

- [ ] **Step 4: Run GREEN, UI freeze, and Playwright**

```powershell
node --test tests/localNodeSession.test.mjs tests/localNodeLeaseMaintenance.test.mjs
npm run test:ui-freeze
npm run test:browser
```

- [ ] **Step 5: Checkpoint**

```text
feat(idea2): bind verified machines to login sessions
```

---

### Task 9: Resolve Account Aliases and Route Only the Physical Stream

**Files:**
- Create: `IDEA2-AEGIS_Monitor/server/auth/cameraAccess.js`
- Modify: `IDEA2-AEGIS_Monitor/server/db/connection.js`
- Modify: `IDEA2-AEGIS_Monitor/server/routes/api.js`
- Modify: `IDEA2-AEGIS_Monitor/server/db/store.js`
- Modify: `IDEA2-AEGIS_Monitor/.env.example`
- Create: `IDEA2-AEGIS_Monitor/tests/deviceOwnedCameraAccess.test.mjs`
- Create: `IDEA2-AEGIS_Monitor/tests/physicalCameraStreamRouting.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/tests/liveCamera.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/tests/designContract.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:**
- `resolveOperatorAccess(req, requestedLogicalCameraId, nowMs)` returns `{ kind: 'verified-node', viewerMode: 'demanding', userId, nodeId, physicalCameraId, logicalCameraId }` only after live account, Node, key-version, physical mapping, association, and alias-policy validation.
- Strict mode calls only `streamSourceForPhysicalCamera(physicalCameraId)`.
- `AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION` defaults false and accepts only explicit true/false. Once strict mode is selected, no fallback is allowed.

- [ ] **Step 1: Add RED six-row authorization matrix**

Cover A/B/C × operator/operator2. Every machine retains its own physical camera; operator maps to CAM-01 and operator2 to CAM-02. Cover account switching, same account on different machines, wrong/missing alias, wrong role, disabled account/Node/camera, key rotation, remap, registry outage, and all browser/heartbeat/`camera_assignment` override attempts.

- [ ] **Step 2: Add RED physical stream tests**

Prove Machine A operator and operator2 use the same physical source, logical heartbeat cannot redirect it, missing/stale physical source returns `503`, forged upstream URL is ignored, and denial occurs before `fetch()`.

- [ ] **Step 3: Implement centralized resolver and route**

Preserve `camera_assignment` for existing admin/responsibility/notification behavior. Revalidate authority every existing stream interval and abort immediately on revocation/remap/alias change.

- [ ] **Step 4: Prove guards with controlled mutations**

Temporarily remove physical-mapping equality, logical-alias equality, and physical-source selection separately. Each matching test must RED. Restore immediately and verify no mutation residue.

- [ ] **Step 5: Run GREEN and checkpoint**

```text
feat(idea2): route account aliases to local physical streams
```

---

### Task 10: Replace Dual Logical Heartbeats with One Physical Availability Path

**Files:**
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/heartbeat_worker.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/monitor_client.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example`
- Modify: `IDEA2-AEGIS_Monitor/server/routes/internal.js`
- Modify: `IDEA2-AEGIS_Monitor/server/db/store.js`
- Create: `IDEA2-AEGIS_Monitor/tests/physicalCameraHeartbeat.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/tests/agentIngestProvenance.test.mjs`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_monitor_client_signing.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_config.py`

**Interfaces:**
- One Engine runtime publishes one authenticated physical-camera heartbeat through the Agent.
- Logical alias is absent from physical availability authority; event-time alias remains only on events that require it.
- Heartbeat cannot register a Node, select alias, acquire producer ownership, or create viewer demand.

- [ ] **Step 1: Write RED heartbeat tests**

Prove one physical row serves both account aliases, payload Node/physical/logical claims cannot override authenticated identity, duplicate logical heartbeat loops are unnecessary, and Agent/heartbeat activity leaves camera counters at zero.

- [ ] **Step 2: Implement single physical heartbeat path**

Remove runtime dependency on account-specific `AEGIS_CAMERA_ID` for availability without deleting bounded legacy support needed by Detector B.

- [ ] **Step 3: Add bridge-absence contract tests**

Search source/config/runbooks for any Machine A requirement on `127.0.0.1:18078`, manual CAM-01/CAM-02 heartbeat loops, or manual stream-auth proxies. Historical receipts may mention them; active runtime instructions must not.

- [ ] **Step 4: Run GREEN and checkpoint**

```text
feat(idea2): publish one physical camera heartbeat
```

---

### Task 11: Preserve Demand Lifecycle and Account Symmetry

**Files:**
- Modify only if tests prove necessary: `IDEA2-AEGIS_Monitor/server/routes/api.js`
- Modify only if tests prove necessary: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py`
- Modify only if tests prove necessary: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py`
- Modify: `IDEA2-AEGIS_Monitor/tests/streamLifecycle.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/tests/viewerDemandAvailability.test.mjs`
- Create: `IDEA2-AEGIS_Monitor/tests/machineAAccountSymmetry.test.mjs`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_viewer_demand.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_stream_lifecycle_regression.py`

**Interfaces:**
- The coherent trigger is opening the authenticated Operator Live workflow: association/login alone creates no demand; the existing Live feed request creates demand symmetrically for operator and operator2.
- Multiple demanding viewers reference-count one physical stream. Final demanding disconnect/logout closes it.

- [ ] **Step 1: Characterize and add RED lifecycle tests**

Cover Agent/Engine startup, auth, renewal, heartbeat, and association staying OFF; operator/CAM-01 ON; operator2/CAM-02 ON using the same physical camera; two viewers; one release; final release; logout; aborted upstream; reconnect; stale lifecycle generation; and non-negative counters.

- [ ] **Step 2: Apply only proven minimum fixes**

Do not redesign camera core. Preserve Task 1 generation/session isolation and PR #134 asynchronous abort containment.

- [ ] **Step 3: Run focused tests repeatedly**

Run Monitor lifecycle tests and Engine demand/generation tests three times. The two formerly documented baseline Engine failures must either remain explicitly classified or be fixed only if the current source proves they block this task.

- [ ] **Step 4: Checkpoint**

```text
fix(idea2): preserve physical camera demand lifecycle
```

---

### PRE-TASK-12 / N12 Network Gate: Permanent Machine A Stream Endpoint Contract

> **Approved plan refinement:** This prerequisite was inserted after Tasks 1–11
> exposed a deployment-network gap. It does not renumber, redefine, or rewrite
> any original task. Original Task 12 remains the Windows install/status/repair/
> uninstall/autostart lifecycle below.

```text
PLAN_REFINEMENT=APPROVED
TASKS_1_11_HISTORY_PRESERVED=YES
PRE_TASK12_GATE_ADDED=YES
PRE_TASK12_GATE_NAME=Permanent Machine A Stream Endpoint Contract
ORIGINAL_TASK12_RENUMBERED=NO
ORIGINAL_TASK12=Windows install/status/repair/uninstall/autostart lifecycle
```

**Files:**
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/config.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/install_autostart.ps1`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_tunnel.ps1`
- Modify: focused Agent and Windows contract tests as proven by RED evidence
- Modify: `IDEA2-AEGIS_Monitor/.env.example`
- Create: `IDEA2-AEGIS_Monitor/server/auth/physicalStreamSource.js`
- Modify: `IDEA2-AEGIS_Monitor/server/auth/cameraAccess.js`
- Modify: `IDEA2-AEGIS_Monitor/server/routes/api.js`
- Modify: focused Monitor endpoint/routing/lifecycle tests as proven by RED evidence
- Modify: `docker-compose.yml` (shared dev/test infrastructure surface only)
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`

**Interfaces:**
- Strict Operator routing remains `verified Node -> registered physical camera -> server-owned stream destination`; browser, heartbeat, logical alias, account name, query/header values, and client physical-camera claims never select the upstream URL.
- The application-facing destination uses a deployment-owned stable hostname. The root dev/test Compose file maps that hostname explicitly into the Monitor container; it never embeds a `172.18.x.x` gateway as application configuration.
- The server-side SSH reverse-forward bind remains a deployment value and must be explicitly supplied to the Windows tunnel tooling. It has no source default. Machine A uses its reviewed port `18077`; the former diagnostic `18078` bridge is absent.
- If Docker `host-gateway` is used, deployment preflight must prove that the configured host mapping and the SSH listener bind identify the same reachable server interface. `host-gateway == aegis_internal gateway` is never assumed.
- Missing, malformed, unresolved, wrong-Node, stale, or inconsistent endpoint configuration fails closed before Monitor sends its Engine credential.
- Machine A is the only runtime-acceptance target. The mapping is keyed by Node and physical camera so Machines B/C can later be provisioned without source rewrites, but B/C runtime acceptance is deferred.

- [x] **Step 1: Reconcile governance and classify the preserved candidate**

Update this plan and canonical IDEA2 status before further production-source
editing. Inspect every preserved endpoint path and classify it as keep, revise,
or drop. Reject the temporary `127.0.0.1:18078` bridge and every hard-coded
`172.18.x.x` application default. Record Task 11 SHA
`cb17caeecbc09b5cab224ae9369e3a29b860cbf8` as the gate base.

- [x] **Step 2: Add endpoint-contract RED tests**

Prove the current candidate lacks a stable named host mapping and explicit SSH
bind contract. Cover missing/malformed/unapproved endpoint configuration,
dynamic gateway literals, wrong Node/physical mapping, heartbeat/browser URL
override, Machine A operator/operator2 symmetry, no `18078`, and Windows tunnel
configuration with no implicit bind address.

- [x] **Step 3: Implement the minimum stable endpoint contract**

Use one validated deployment-owned hostname for Monitor's application-facing
source URL, one explicit Compose host mapping, and one explicit deployment-owned
SSH bind address. Keep the physical-camera mapping server-owned and fail closed.
Do not add a proxy service, change Production Compose, mutate a real tunnel, or
start the original Task 12 installation lifecycle.

- [x] **Step 4: Prove the network contract at the available evidence level**

Run focused endpoint/Task 8–11 regression tests and an isolated disposable
container-to-host HTTP/MJPEG hop when an approved Docker runtime is available.
Use no `18078` listener. If Docker is unavailable, record
`LIVE_CONTAINER_HOP=DEFERRED_TO_LATER_LOCAL_INTEGRATION`; static/config/preflight
proof is not real Machine A or Production network acceptance.

- [x] **Step 5: Run final gates, review, and checkpoint**

Run the full Monitor and Engine/Agent suites, UI freeze, approved browser suite,
Vite build, Vault/collaboration validation, secret scan, `git diff --check`,
negative controls, scoped security review, and shared-infrastructure review.
Require Critical=0 and Important=0. Update canonical status with exact evidence,
stage only reviewed paths, and create one coherent PRE-TASK-12 checkpoint. Do
not create a receipt, push, open a PR, mutate Production, modify the installed
Machine A runtime, or start original Task 12. Stop after reporting the checkpoint.

---

### Task 12: Complete Windows Install, Status, Repair, and Uninstall Lifecycle

**Files:**
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/install_identity_agent.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/status_identity_agent.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/repair_identity_agent.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/uninstall_identity_agent.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/verify_machine_a_no_powershell.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/README.md`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/README.md`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/install_autostart.ps1`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/status_autostart.ps1`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_windows_service.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_autostart.py`

**Interfaces:**
- Existing Engine HKCU Run owner and tunnel Scheduled Task remain singular.
- Agent service installs separately, auto-starts, uses its own runtime/dependencies/data root, and never owns the webcam.
- Status/verification scripts emit non-secret booleans/categories/hashes only.
- Uninstall is non-destructive by default and preserves protected key material unless a separate explicit key-destruction operation is approved.

- [ ] **Step 1: Write RED static/operator tests**

Test no second Engine task, exact service identity, 8078 loopback-only, reproducible pywin32 installation, DPAPI preflight, ACL checks, repair idempotence, non-destructive uninstall, no private-key output, and no `:18078` bridge/heartbeat-loop instructions.

- [ ] **Step 2: Implement tooling**

Use PowerShell only for one-time administrator install/repair and reviewed hidden runtime helpers. Normal end-user operation requires no terminal commands.

- [ ] **Step 3: Parse and run static tests**

Run PowerShell parser validation without installing or starting anything. Run full Windows source tests under the source environment.

- [ ] **Step 4: Checkpoint**

```text
feat(idea2): install self-starting machine a runtime
```

---

### Task 13: Run Production-Like Local Integration Without the Diagnostic Harness

**Files:**
- Create: `IDEA2-AEGIS_Monitor/tests/machineANoPowerShellIntegration.test.mjs`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_machine_a_runtime_contract.py`
- Modify: `IDEA2-AEGIS_Monitor/package.json`
- Add only if required by the isolated harness: task-scoped scripts under `IDEA2-AEGIS_Monitor/tests/fixtures/`

**Interfaces:**
- Built Monitor frontend/server, disposable PostgreSQL 15, fake/protocol-real Agent transport, and Engine process form the integration path.
- No Vite acceptance, manual heartbeat loop, `:18078` bridge, manual stream-auth proxy, Production URL, or persistent Machine A mutation.

- [ ] **Step 1: Add integration RED matrix**

Cover browser→Monitor→Agent→verified Node→account alias→physical camera→Engine; operator/CAM-01 and operator2/CAM-02 using one physical source; forged identity; stale association; Agent unavailable/recovery; physical heartbeat aging; and final stream release.

- [ ] **Step 2: Build the disposable harness**

Allocate dynamic local ports other than protected 8077/8078 unless explicitly testing those binds. Ensure cleanup occurs in `finally` and report residue.

- [ ] **Step 3: Run real PostgreSQL and built-app integration**

Apply migrations twice, seed only synthetic Node/physical/user/alias rows, build Vite, launch the built server, run integration, then remove the disposable database/container/ports.

- [ ] **Step 4: Verify forbidden harness absence**

Require:

```text
TEMP_BRIDGE_REQUIRED=NO
MANUAL_CAM01_HEARTBEAT_REQUIRED=NO
MANUAL_CAM02_HEARTBEAT_REQUIRED=NO
MANUAL_NPM_REQUIRED=NO
MANUAL_PYTHON_HELPER_REQUIRED=NO
```

- [ ] **Step 5: Checkpoint**

```text
test(idea2): prove permanent machine a runtime path
```

---

### Task 14: Run Full Automated Verification and Scoped Security Review

**Files:**
- No intended source changes; findings must return to the owning task.
- Modify after evidence only: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`

**Interfaces:**
- Produces a source/local verification checkpoint suitable for the human installation gate, not a receipt or PR.

- [ ] **Step 1: Run complete Monitor gates**

```powershell
cd IDEA2-AEGIS_Monitor
npm test
npm run test:ui-freeze
npm run test:browser
npm run build
```

- [ ] **Step 2: Run complete Engine and Agent gates**

Run all Python unit tests with the configured repository runtime, including Windows static tests and all demand/generation regressions.

- [ ] **Step 3: Run disposable PostgreSQL gates**

Run migrations 001–004, registry/alias policy, auth mode, provenance, physical heartbeat, and integration suites with zero conditional PostgreSQL skips.

- [ ] **Step 4: Run governance/security gates**

Run Vault validation, collaboration-policy tests, `git diff --check`, exact changed-file review, dependency review, private-key/secret scan, log-output scan, UI-freeze comparison, and protected file/hash checks.

- [ ] **Step 5: Perform scoped code/security review**

Review cryptographic domains, raw-body verification, replay/concurrency, DPAPI/ACL, loopback Origin/CORS/PNA, session binding, live revalidation, physical-source authority, SSRF bounds, demand/release, legacy downgrade, Windows ownership, cleanup, and rollback. Fix every Critical/Important finding and rerun affected plus full gates.

- [ ] **Step 6: Create implementation/evidence checkpoint**

Stage exact source/test paths only and commit the coherent final automated state. Then update `idea2-status.md` with exact SHA/results and create a documentation checkpoint. Do not create a receipt.

---

### Task 15: Prepare and Stop at the Human Machine A Installation Gate

**Files:**
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/README.md`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/README.md`
- Modify: `IDEA2-AEGIS_Monitor/server/cli/README.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`

**Interfaces:**
- Produces exact administrator commands and evidence forms for the human; performs no privileged mutation itself.

- [ ] **Step 1: Write the installation runbook**

Include precondition hashes/SHAs, dependency installation, Agent service installation, DPAPI CurrentUser preflight under the service identity, protected key provisioning, public-key export, disposable/local registry setup, Engine artifact refresh, Node/physical/alias configuration, service/tunnel/Engine status, abort rules, and rollback.

- [ ] **Step 2: Write the acceptance sequence**

Record exact evidence for reboot/login auto-start, idle OFF, operator physical A/CAM-01, final release OFF, operator2 same physical A/CAM-02, final release OFF, second reboot/recovery, and absence of manual bridge/heartbeat/npm/Python helpers.

- [ ] **Step 3: Verify runbook safety**

Static-scan commands for Production hosts/DBs, secret printing, broad deletion, `wsl --shutdown`, Docker prune/reset, second Engine startup ownership, and destructive key removal. Require zero matches except explicitly documented negative examples.

- [ ] **Step 4: Stop for human authorization**

Report automated evidence and exact commands. Do not install, start, provision, register, deploy, push, or open a PR.

---

### Task 16: Complete Human Acceptance, Final Documentation, Receipt, and PR

**Files:**
- Modify after successful human evidence: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- Create exactly one final receipt: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_pub_machine-a-no-powershell-runtime.md`
- Modify PR metadata/description only after branch publication.

**Interfaces:**
- Consumes: owner-run Machine A output bound to exact source/install SHA.
- Produces: final locally accepted task state, one immutable receipt, normal branch push, and one PR for human review. It never merges.

- [ ] **Step 1: Evaluate Human Machine A evidence**

If any gate fails, keep the task open, diagnose systematically on the same branch, add RED coverage, fix, rerun full automated gates, and repeat only the affected human acceptance. Do not create a PR or receipt.

- [ ] **Step 2: Record successful evidence honestly**

Record `SOURCE_IMPLEMENTED=YES`, `LOCAL_VERIFIED=YES`, and `MACHINE_A_LOCAL_NO_POWERSHELL_ACCEPTANCE=PASS`. Keep `PRODUCTION_DEPLOYED=NO`, `MACHINE_B_COMPLETE=NO`, `MACHINE_C_COMPLETE=NO`, `SOC_PASSIVE_COMPLETE=NO`, `ARCHIVAL_COMPLETE=NO`, and `TELEGRAM_COMPLETE=NO`.

- [ ] **Step 3: Create the single final receipt**

Copy the canonical template, list every changed path, exact test and runtime evidence, shared surfaces, rollback, limitations, final checkpoint SHA, and integration requests. Confirm no earlier receipt was created for this task.

- [ ] **Step 4: Run final fresh verification**

Rerun affected full suites, governance, Vault, collaboration policy, secret scan, diff/cached diff checks, receipt count, and exact PR-owned diff against current `origin/main`. Merge current `origin/main` into the branch if needed; never rebase.

- [ ] **Step 5: Publish and open PR**

Push normally, create one PR titled `IDEA2: make Machine A runtime self-starting and physically routed`, request functional/integration human review, and stop. Do not merge or deploy Production.

## Human Gates

1. Agent service identity and DPAPI CurrentUser preflight.
2. Real encrypted key generation and public-key export.
3. Exact local/disposable registry inspection and Machine A registration.
4. Local Agent authentication and physical heartbeat with camera OFF.
5. Service restart and Windows reboot recovery.
6. Browser association without secret exposure.
7. Operator/CAM-01 → physical Camera A acceptance.
8. Final release/logout → Camera A OFF.
9. Operator2/CAM-02 → the same physical Camera A acceptance.
10. Second final release and reboot recovery.
11. Explicit proof that `:18078`, heartbeat loops, npm, Vite, and manual Python helpers are unnecessary.

## Rollback Model

- Before human installation: discard only the isolated branch/worktree if the owner chooses; no installed state exists.
- Agent install failure: stop/remove only `AEGISIdentityAgent`, preserve encrypted key/data for investigation, and leave Engine/tunnel ownership unchanged.
- Association failure: disable strict association flag in the isolated local acceptance environment only after owner approval; never silently fall back after a proof error.
- Ingest failure before strict switch: leave Machine A in `legacy_shared_key`; do not affect Detector B.
- Failure after explicit local strict switch: stop Agent/Engine ingest first, collect evidence, and request approval before reverting the exact Node row.
- Engine runtime failure: restore the pre-install runtime snapshot/config while preserving the existing HKCU Run and tunnel task contract.
- Browser/stream failure: rollback the Monitor candidate in the isolated environment; Production remains untouched.
- No rollback step deletes keys, camera/model assets, recordings, Docker data, or PostgreSQL rows without separate explicit approval.
