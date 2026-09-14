# AEGIS IDEA2 Camera-First Slice 1 Machine Association Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind an authenticated Monitor Operator browser session to the verified local Node, resolve that Node's registered physical camera and the account's server-authorized logical alias, and open Machine A's existing Engine stream without changing camera core or visible UI.

**Architecture:** Monitor issues a one-time, session-bound challenge and verifies a fixed-domain Ed25519 assertion relayed from a dedicated loopback Identity Agent on `127.0.0.1:8078`. Monitor stores Node and physical-camera authority only in the server session, resolves the logical alias from live account-policy rows, and opens the existing Engine stream through `streamSourceForPhysicalCamera()`. Startup, login, and association create no demand; only the existing authorized stream proxy opens the camera.

**Tech Stack:** Node.js ESM, Express 4, PostgreSQL 15 adapters, Node `crypto` Ed25519, React 19, Python 3, `cryptography`, Windows DPAPI/`pywin32`, `node:test`, Python `unittest`, Playwright, PowerShell 5.1+.

**Spec:** `docs/superpowers/specs/2026-09-14-idea2-camera-first-slice1-machine-association-design.md`

## Global Constraints

- Work only on `codex/idea2-lr1-current-main-reconciliation`; keep one branch and one eventual Pull Request. Every reviewed task is committed and pushed to this branch, never to `main`.
- Machine identity fixes the physical source: A→physical A, B→physical B, C→physical C. Account policy fixes the logical alias: `operator`→`CAM-01`, `operator2`→`CAM-02`. Route code uses live user IDs and policy rows, not hardcoded usernames.
- The browser may relay public challenge/assertion data but never supplies Node, physical-camera, or logical-alias authority. Client IP, hostname, User-Agent, storage, query strings, unsigned headers, heartbeat, and `camera_assignment` are non-authoritative.
- The only Slice 1 proof domain is `AEGIS-BROWSER-NODE-ASSOCIATION-V1`. CP3 authentication/ingest domains, Agent sessions, outbound transport, and named-pipe operations remain paused.
- The Identity Agent binds exactly `127.0.0.1:8078`, signs only the fixed browser-association structure, returns no private material, accesses no camera, and creates no demand.
- `AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION` defaults to false. When true, Operator stream access has no legacy fallback. Machine A acceptance uses true; fleet-wide enablement is blocked until B/C have compatible Agents or a separately reviewed isolated canary.
- `AEGIS_CAPTURE_ON_DEMAND=true` is a human-verified Machine A runtime prerequisite. The repository default remains unchanged.
- `IDEA2-AEGIS_Monitor/server/streamLifecycle.js` is a stop-for-review boundary. CP5 producer leases, epochs, alias exclusivity, multi-tab reference counting, and final SOC passive remediation are excluded.
- These files remain byte-identical:
  - `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py`
  - `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/video_catcher.py`
  - `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/camera_devices.py`
- Model source, weights, training data, biometric enrollment/data, camera selection, visual components, CSS, Production, Docker, gateway, Twingate, firewall, and Production PostgreSQL are not changed.
- Use ephemeral keypairs and disposable databases in tests. Never commit or print a private key, credential, session secret, database URL, signature bearer value, recording, clip, model, enrollment asset, dependency directory, or build output.
- Human runtime mutations occur only at S1-H1 through S1-H5 after explicit approval. Cod task commits do not create receipts; Task 5 creates the single final task receipt only when the branch is ready for review.

## Authoritative Interface Contract

```js
// Monitor wire/service contract
export const BROWSER_ASSOCIATION_PURPOSE = 'AEGIS-BROWSER-NODE-ASSOCIATION-V1'
export function canonicalizeBrowserAssociationClaims(claims) // -> Buffer
export function verifyBrowserAssociationProof({ claims, signature, publicKey }) // -> boolean
export function createBrowserAssociationService(dependencies)
// -> { issue(session, nowMs), verify(session, assertion, nowMs), clear(session) }

// Monitor session contract
export function currentNodeSessionBinding(req) // -> string | null
export function bindLocalNode(req, verifiedNode) // -> void
export function currentLocalNode(req) // -> object | null
export function clearLocalNode(req) // -> void

// Server authorization contract
export function createCameraAccessResolver(dependencies)
// -> { resolveOperatorAccess(req, requestedLogicalCameraId, nowMs) }

// Browser orchestration contract
export function maintainLocalNodeAssociation(options)
// -> { stop(): void, associateNow(): Promise<'associated'|'retry'|'ineligible'> }
```

```python
# Dedicated Identity Agent contract
class BrowserAssociationConfig: ...
class DpapiIdentityKeyStore: ...
def canonicalize_browser_association_claims(claims: dict) -> bytes: ...
def create_browser_association_server(config, key_store, clock): ...
```

The successful Monitor verification result and server session shape are:

```js
{
  nodeId,
  physicalCameraId,
  keyVersion,
  verifiedAt,
  expiresAt,
}
```

The browser receives only bounded association status/expiry information. It cannot write or reconstruct this authority.

## Human Runtime Gates

### S1-H1 — Identity Agent prerequisite and local key availability

- **Prerequisites:** Tasks 1–2 reviewed and pushed; exact commit recorded; elevated PowerShell; Agent absent or stopped; protected Engine hashes recorded; no plaintext key artifact.
- **Action:** Human runs the reviewed DPAPI preflight, installs only `AEGISIdentityAgent`, provisions/loads the existing CP3-compatible application identity, configures exact allowed Monitor origins, exports only the public key, and reviews service/data ACLs.
- **Evidence:** service account/start mode, exact bind address/port, DPAPI round-trip result, public fingerprint/key version, ACL summary, private-material scan, camera/demand metrics.
- **PASS:** Agent runs under its dedicated identity; DPAPI CurrentUser load/sign self-test passes; listener is only `127.0.0.1:8078`; public registration inputs are non-secret; camera remains closed.
- **ABORT:** identity/profile/DPAPI/ACL mismatch, non-loopback listener, wildcard origin, plaintext/private output, key replacement ambiguity, or camera demand.
- **Rollback:** stop/remove only the new Agent service and installed Agent files; preserve encrypted identity for reviewed recovery; do not alter Engine/tunnel/config.

### S1-H2 — Browser to Agent to Monitor proof

- **Prerequisites:** Tasks 1–3 reviewed and pushed; H1 PASS; approved local Monitor origin; active Machine A Node/public key/physical mapping; camera closed.
- **Action:** Human logs in as each Operator account, lets the invisible client request one challenge, calls the loopback Agent, returns the assertion, and observes renewal once.
- **Evidence:** generic HTTP statuses, Node/key/physical match categories, association expiry/renewal time, replay/wrong-origin denial, browser storage inspection, camera/demand metrics; no token/signature/private-key values.
- **PASS:** both accounts bind the same Machine A Node/physical camera; replay and wrong Origin fail; no browser authority is stored; camera remains closed.
- **ABORT:** browser-supplied identity accepted, cross-domain proof accepted, stale registry accepted, credentials sent to loopback, secret output, or camera demand.
- **Rollback:** stop Agent, log out/destroy session, disable strict flag in the local test environment, and preserve logs without proof material.

### S1-H3 — Machine A runtime configuration

- **Prerequisites:** Tasks 1–4 reviewed and pushed; H2 PASS; existing interactive Engine and API-key stream path healthy; no viewer open.
- **Action:** Human reads the installed Machine A configuration and confirms `AEGIS_CAPTURE_ON_DEMAND=true`, stream enabled, expected camera device, and existing Engine API-key availability. Any correction requires separate approval.
- **Evidence:** redacted variable names/boolean values, Engine health fields, zero demanding/passive viewers, zero capture/detect FPS, protected-file hashes.
- **PASS:** on-demand is true, stream path is enabled, camera is disconnected/undemanded, and protected hashes match.
- **ABORT:** value missing/false, camera already active, Engine/API-key path unhealthy, protected hash drift, or requested camera/model/model change.
- **Rollback:** none for read-only inspection; an approved correction restores only its recorded previous value.

### S1-H4 — Real Machine A local/browser stream acceptance

- **Prerequisites:** Tasks 1–5 green and reviewed; H1–H3 PASS; strict flag true only in controlled Machine A acceptance; Engine, Agent, and local Monitor health verified; rollback operator present.
- **Action:** Record five states: Engine start; login; association; first authorized stream; final stream disconnect/logout. Repeat the stream open once as `operator` and once as `operator2`.
- **Evidence:** Machine A physical ID/fingerprint category, logical alias, stream HTTP status, upstream physical-source category, Engine camera connected/demanded and viewer counts at each point, no secret values.
- **PASS:** start/login/association remain closed; `operator` opens physical A as CAM-01; `operator2` opens the same physical A as CAM-02; final demanding disconnect/logout closes physical A; alias mismatch and missing association fail closed.
- **ABORT:** camera opens before stream, account changes physical source, logical heartbeat redirects source, final close fails, SOC creates demand, or Production is contacted.
- **Rollback:** close browser, log out, stop Agent/local Monitor, return strict flag to its recorded prior local value, and leave Engine/camera/model files unchanged.

### S1-H5 — Production acceptance after review and merge

- **Prerequisites:** owner/integration approval, merged commit identified, CI green, one immutable receipt, Production preflight/backup/rollback reviewed, Machines B/C protected from fleet-wide strict enablement.
- **Action:** A separately approved deployment enables the reviewed Machine A canary only, repeats H2–H4, and records immutable image/source/runtime provenance.
- **Evidence:** exact image/commit IDs, pre/post health, Machine A mapping and lifecycle metrics, B/C unaffected, rollback command, no secret material.
- **PASS:** canary satisfies the contract with no unrelated runtime/config/database change.
- **ABORT:** ambiguous target, migration/config drift, B/C impact, source-image mismatch, lifecycle failure, or missing rollback.
- **Rollback:** run the pre-reviewed Machine A canary rollback only; restore prior Monitor image/flag while preserving database rows and evidence.

---

### Task 1: Verify Browser-Association Proofs and One-Time Challenges

**Files:**

- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/browserAssociationProof.js`
- Create: `IDEA2-AEGIS_Monitor/server/nodeIdentity/browserAssociationChallenges.js`
- Create: `IDEA2-AEGIS_Monitor/tests/browserAssociationProof.test.mjs`
- Create: `IDEA2-AEGIS_Monitor/tests/localNodeChallenge.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:** Implement the four Monitor proof/service exports in the Authoritative Interface Contract. `issue()` returns exactly the eight public challenge fields. `verify()` atomically consumes the matching session challenge before asynchronous registry access and returns the server-derived five-field verified result. Inject clock, random-byte source, and registry adapters for deterministic tests.

- [ ] **Step 1: Add deterministic RED proof tests.** Use ephemeral Ed25519 pairs and public registry fixtures. Cover valid Machine A proof; exact field order/canonical encoding; wrong signature/domain/audience/session binding; missing/unknown/repeated/wrong-type/oversized fields; malformed Base64URL; unsafe integers; and cross-use of every CP3 proof domain.
- [ ] **Step 2: Add deterministic RED challenge tests.** Cover 30-second exact expiry (`now >= expiresAt`), one use, replay/concurrent replay, maximum eight unexpired challenges with oldest eviction, unknown/disabled Node, wrong key version, missing/inactive/remapped physical camera, inactive/wrong-role account, registry outage, and body/query/header/browser identity override attempts.
- [ ] **Step 3: Run RED.** From `IDEA2-AEGIS_Monitor` run:

```powershell
node --test tests/browserAssociationProof.test.mjs tests/localNodeChallenge.test.mjs
```

Expected RED: imports fail because the two `server/nodeIdentity` modules do not exist. After empty shells are introduced, assertions fail because canonical proof parsing, atomic consumption, Ed25519 verification, and registry-derived physical identity are absent. Fixture/syntax errors do not count.

- [ ] **Step 4: Implement the minimum proof boundary.** Use strict own-key object validation, UTF-8/LF canonical bytes, decimal safe integers, canonical unpadded Base64URL beginning with ASCII alphanumeric, Node `crypto.verify`, constant error categories, 30-second challenge TTL, five-minute association TTL, and session-owned in-memory challenge arrays. Never log assertion bodies or keys.
- [ ] **Step 5: Run focused GREEN.** Run the Step 3 command until all cases pass.
- [ ] **Step 6: Prove guards.** Temporarily remove challenge consumption, signature verification, and mapping equality one at a time; require the corresponding focused test to RED; restore immediately. Do not stage mutations.
- [ ] **Step 7: Regress and review.** Run `npm test`, `npm run test:ui-freeze`, `npm run build`, and `git diff --check`. Review challenge atomicity, exact expiry, generic errors, domain separation, and absence of browser/heartbeat authority.
- [ ] **Step 8: Checkpoint.** Stage only the five Task 1 paths, run cached diff checks, commit `feat(idea2): verify browser node association proofs`, and push the same branch. Do not open/update a PR.

---

### Task 2: Add the Dedicated Loopback Identity Agent Association Endpoint

**Files:**

- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/__init__.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/config.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/browser_protocol.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/key_store.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/browser_server.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/windows_service.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/run_identity_agent.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements-identity-agent-windows.txt`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_browser_protocol.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_browser_server.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_identity_agent_key_store.py`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/invoke_dpapi_preflight.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/provision_identity_key.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/install_identity_agent.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/status_identity_agent.ps1`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/README.md`
- Create: `IDEA2-AEGIS_Monitor/tests/browserAssociationCrossLanguage.test.mjs`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:** Implement the four Python interfaces in the Authoritative Interface Contract. `BrowserAssociationConfig` accepts only exact loopback host `127.0.0.1`, port `8078`, canonical audience, Node ID/key version, protected key path, and parsed exact origins. `create_browser_association_server()` exposes only `OPTIONS`/`POST /v1/browser-association/assert`. `DpapiIdentityKeyStore` loads an existing DPAPI CurrentUser Ed25519 identity under `NT SERVICE\AEGISIdentityAgent`; tests inject protect/unprotect/sign functions and never create a real key.

- [ ] **Step 1: Add RED protocol/config tests.** Cover Python canonical bytes matching Task 1 vectors, fixed purpose, Agent-owned Node/key version, unknown/repeated fields, invalid UTF-8/JSON/root, query/path/method/content-type rejection, exact Origin parsing, HTTPS-or-loopback rule, and forbidden wildcard/credentials/path/query/`null` origins.
- [ ] **Step 2: Add RED HTTP-boundary tests.** Cover bind address, exact CORS echo, `Vary: Origin`, no credentials, PNA preflight after Origin validation, 16,384-byte total cap including chunked bodies, 12 attempts/origin/60 seconds, redirects rejected, bounded generic errors, and absence of generic signing, arbitrary domain/destination, camera, stream, CP3 session, ingest, and pipe operations.
- [ ] **Step 3: Add RED key/service tests.** Prove fail-closed behavior for missing/corrupt/wrong-owner key state; no key-generation fallback in service startup; no private-key return/log; service identity/start arguments; preflight/provision scripts use create-new semantics and exact service/SYSTEM ACL checks. Use injected cryptography/DPAPI fakes only.
- [ ] **Step 4: Run RED.** From `IDEA2-AEGIS_CCTV-Operator/detection-engine` run:

```powershell
python -m unittest discover -s tests -p "test_identity_agent_*.py"
```

Expected RED: the `aegis_identity_agent` package and runner/scripts are absent. Later failures must correspond to fixed-protocol, bounded-body, Origin/CORS, DPAPI, or service constraints, not missing optional Windows packages in non-Windows unit fixtures.

- [ ] **Step 5: Implement the minimum Agent.** Use `http.server.ThreadingHTTPServer`, a strict duplicate-key JSON loader, streaming capped reads, fixed canonicalizer, Ed25519 signing through the protected key abstraction, per-origin rolling attempt windows, loopback-only configuration, lazy Windows imports, and no Engine imports. The Windows service hosts this one endpoint only.
- [ ] **Step 6: Add cross-language proof evidence.** The Node test spawns the current Python interpreter, generates an ephemeral test-only Ed25519 assertion using the Python canonicalizer, and verifies it with Task 1 JavaScript. Reverse-vector checks compare canonical bytes without exporting a runtime signing API.
- [ ] **Step 7: Run focused GREEN.** Run the Step 4 command and, from `IDEA2-AEGIS_Monitor`, run:

```powershell
node --test tests/browserAssociationCrossLanguage.test.mjs tests/browserAssociationProof.test.mjs
```

- [ ] **Step 8: Regress and review.** Run the full Detection Engine suite, the Task 1 Monitor tests, `npm test`, `npm run test:ui-freeze`, `npm run build`, PowerShell parser checks for the four scripts, and `git diff --check`. Review loopback binding, Origin/PNA handling, body-memory bound, rate-limit cleanup, key confinement, and CP3 exclusion.
- [ ] **Step 9: Checkpoint.** Stage only the Task 2 paths, run cached diff checks, commit `feat(idea2): add loopback identity association agent`, and push the same branch. Stop for S1-H1 authorization; Codex does not install/provision the Agent.

---

### Task 3: Bind Verified Local Nodes to Server Sessions Invisibly

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

**Interfaces:** Implement the four session exports and `maintainLocalNodeAssociation()` from the Authoritative Interface Contract. Add authenticated, CSRF-protected `POST /api/local-node/challenge` and `POST /api/local-node/verify`. Successful verify stores the five server-derived fields in `session.localNode`; the response is `{ associated: true, expiresAt }`. The browser posts the public challenge to `http://127.0.0.1:8078/v1/browser-association/assert` with `credentials: 'omit'`, then returns the assertion through existing same-origin `apiFetch()`.

- [ ] **Step 1: Add RED session/route tests.** Cover a new 32-byte canonical `nodeSessionBinding` on every login regeneration, successful association, session-bound challenge, stale/exact-expiry association, logout/re-login clearing, Monitor restart behavior, Node disable, key rotation, physical remap/deactivation, live user disable/role change, registry failure, CSRF/auth enforcement, and rejection/ignoring of browser-written `localNode`, Node, physical-camera, alias, IP, hostname, header, query, and storage values.
- [ ] **Step 2: Add RED browser-maintenance tests.** With fake fetch and clock, cover Operator-only start; no SOC call; immediate attempt after login/session restore; 10-second bounded attempt; five-minute lease; renewal at 60 seconds remaining; failed renewal preserving a still-valid server association; five-second bounded retry; stop/unmount/logout cleanup; no local/session storage; no credentials to loopback; and no camera/stream request.
- [ ] **Step 3: Add RED browser acceptance.** The Playwright fixture intercepts Monitor and loopback calls and proves the current UI markup/styles remain byte-stable while the invisible association sequence occurs. It checks that Agent CORS/network failure does not log out the account or create a stream request.
- [ ] **Step 4: Run RED.** From `IDEA2-AEGIS_Monitor` run:

```powershell
node --test tests/localNodeSession.test.mjs tests/localNodeLeaseMaintenance.test.mjs
npx playwright test tests/browser/localNodeAssociation.spec.mjs
```

Expected RED: session helpers, routes, browser module, and orchestration do not exist; current login has no node binding. Browser-runner startup failures are environment blockers, not functional RED.

- [ ] **Step 5: Implement the minimum binding/orchestration.** Generate binding during `establishSession()`, clear challenge/association on regeneration/destruction, integrate Task 1 service in the two routes, and add one effect in `App.jsx` keyed by the authenticated session. Add no component, control, label, styling, selector, or visible error state.
- [ ] **Step 6: Run focused GREEN.** Run Step 4 until Node and browser processes terminate cleanly with all cases passing.
- [ ] **Step 7: Regress and review.** Run `npm test`, `npm run test:ui-freeze`, `npm run test:browser`, `npm run build`, and `git diff --check`. Review server-only authority, renewal races, timer cleanup, prior-valid-proof preservation, CSRF, and zero-demand behavior.
- [ ] **Step 8: Checkpoint.** Stage only the nine Task 3 paths, run cached diff checks, commit `feat(idea2): bind local nodes to monitor sessions`, and push the same branch. Stop for S1-H2 authorization; Codex does not mutate the Agent or browser runtime.

---

### Task 4: Resolve Account Aliases and Route the Verified Physical Stream

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

**Interfaces:** `createCameraAccessResolver({ getUserById, getDetectionNode, getPhysicalCameraForNode, getPhysicalCamera, getNodeAliasPolicy, getNodeAccountAlias })` returns `resolveOperatorAccess(req, requestedLogicalCameraId, nowMs)`. Success returns `{ kind: 'verified-node', viewerMode: 'demanding', userId, nodeId, physicalCameraId, logicalCameraId }`. Every open and each `STREAM_REVALIDATE_MS` interval repeats live account, Node, key-version, physical mapping, association-expiry, and alias-policy checks. `store.streamSourceForPhysicalCamera(physicalCameraId)` remains the only strict-mode source lookup.

- [ ] **Step 1: Add RED authorization matrix.** Use database-adapter fakes keyed by user ID. Cover A/B/C × `operator`/`operator2`: each Node retains its own physical camera while aliases are CAM-01/CAM-02. Cover account switch on one Node, same account on different Nodes, missing/stale association, wrong role, disabled account/Node/camera, key rotation, remap, fixed/wrong/missing policy, registry outage, alias mismatch, and every browser/heartbeat/`camera_assignment` override attempt.
- [ ] **Step 2: Add RED stream tests.** Cover Machine A `operator`→physical A/CAM-01 and `operator2`→the same physical A/CAM-02; strict mode calls only `streamSourceForPhysicalCamera`; missing/stale/unconnected physical source returns service unavailable; logical heartbeat cannot redirect; unauthorized input is denied before `fetch`; and long streams abort after live revocation/remap/alias change.
- [ ] **Step 3: Add RED compatibility/config tests.** Prove `AEGIS_REQUIRE_LOCAL_NODE_ASSOCIATION` accepts only explicit true/false, defaults false, preserves the current legacy route when false, and permits no fallback after strict selection. Prove current visible UI contract and `camera_assignment` admin/responsibility behavior remain unchanged.
- [ ] **Step 4: Run RED.** From `IDEA2-AEGIS_Monitor` run:

```powershell
node --test tests/deviceOwnedCameraAccess.test.mjs tests/physicalCameraStreamRouting.test.mjs tests/liveCamera.test.mjs tests/designContract.test.mjs
```

Expected RED: `cameraAccess.js` is absent; the current route authorizes the URL alias with `canSeeCamera()` and calls logical `streamSourceFor(cameraId)`. Failures must show this authority/source mismatch, not changed UI snapshots.

- [ ] **Step 5: Implement the minimum centralized resolver.** Return the live PostgreSQL `active` field from `getUserById()`, validate the Task 3 session against current registry/policy, and use the resolver once at stream open and revalidation. In strict mode compare `req.params.id` with the live alias before network I/O and call only the physical-source primitive. Keep false-mode legacy behavior isolated and unchanged.
- [ ] **Step 6: Run focused GREEN.** Run Step 4 until all cases pass.
- [ ] **Step 7: Prove guards.** Temporarily remove live physical-mapping equality, live logical-alias equality, and physical-source selection one at a time; require the matching tests to RED; restore immediately and leave mutations unstaged.
- [ ] **Step 8: Regress and review.** Run `npm test`, `npm run test:registry`, `npm run test:ui-freeze`, `npm run test:browser`, `npm run build`, and `git diff --check`. Review centralized authority, strict no-fallback behavior, physical/logical separation, revocation timing, upstream cleanup, SOC non-activation, and unchanged `streamLifecycle.js`.
- [ ] **Step 9: Checkpoint.** Stage only the ten Task 4 paths, run cached diff checks, commit `feat(idea2): route account aliases to local physical streams`, and push the same branch. Stop for S1-H3 authorization; Codex does not change Machine A configuration.

---

### Task 5: Verify Slice 1 and Prepare Controlled Machine A Acceptance

**Files:**

- Create: `IDEA2-AEGIS_Monitor/tests/cameraFirstSlice1Contract.test.mjs`
- Create: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/verify_camera_first_slice1.ps1`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/README.md`
- Modify: `IDEA2-AEGIS_Monitor/.env.example`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- Create at final branch closeout: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-14_235959_pub_idea2-camera-first-slice1.md`
- Modify: `IDEA2-AEGIS_Monitor/package.json`

**Interfaces:** `verify_camera_first_slice1.ps1` is read-only and emits only PASS/FAIL plus non-secret process/listener/config-name/boolean/health/hash evidence for S1-H1 through S1-H4. It never starts/stops services, writes configuration, opens the camera, reads secret values, or contacts Production. `cameraFirstSlice1Contract.test.mjs` enforces proof-domain separation, port/route constants, strict-flag default, protected paths, absent CP3/CP5 interfaces, and no visible UI diff.

- [ ] **Step 1: Record the Engine baseline before Slice 1 completion.** From `IDEA2-AEGIS_CCTV-Operator/detection-engine`, run the two named lifecycle tests first:

```powershell
python -m pytest -q tests/test_stream_lifecycle_regression.py -k "late_detection_from_closed_session_is_not_queued or encode_in_flight_cannot_replay_previous_session"
```

If either fails, record its exact node ID/error as `PRE-EXISTING BASELINE FAILURE`, compare protected source hashes with the pre-task values, and do not fix camera internals. If current main already passes it, record PASS and do not preserve a stale failure claim.

- [ ] **Step 2: Add RED contract/runtime-preflight tests.** Prove the verifier/documentation contains S1-H1–H4 prerequisites/actions/evidence/PASS/ABORT/rollback; enforces `AEGIS_CAPTURE_ON_DEMAND=true` without changing the default; identifies `127.0.0.1:8078`; hashes protected files; rejects secret output/runtime mutation commands; and contains no CP3 ingest/pipe or CP5 producer behavior.
- [ ] **Step 3: Run RED.** Run:

```powershell
node --test IDEA2-AEGIS_Monitor/tests/cameraFirstSlice1Contract.test.mjs
```

Expected RED: the contract test and read-only verifier do not exist; existing docs do not yet expose the bounded Slice 1 evidence contract.

- [ ] **Step 4: Implement the minimum acceptance preparation.** Add the read-only evidence collector, exact runbook, non-secret environment documentation, package test entry, canonical status update, and one final receipt marked honestly as ready-for-human-acceptance or partial if H1–H4 remain unrun. Do not claim real Windows/webcam evidence from source tests.
- [ ] **Step 5: Run all focused Slice 1 suites.** Run Task 1–4 Node tests, Agent unit tests, cross-language tests, PowerShell parser/static tests, and contract test. Every runner must terminate cleanly.
- [ ] **Step 6: Run full Monitor verification.** From `IDEA2-AEGIS_Monitor` run:

```powershell
npm test
npm run test:registry
npm run test:ui-freeze
npm run test:browser
npm run build
```

- [ ] **Step 7: Run full Engine verification.** From the Detection Engine directory run `python -m pytest -q`. Record exact totals. The two named baseline cases are reported separately if still failing and are not relabeled as Slice 1 regressions; any new failure blocks the task.
- [ ] **Step 8: Verify protected boundaries.** Run `Get-FileHash -Algorithm SHA256` for the three protected files, `git diff --exit-code <task-start> --` for those paths plus model/training/biometric paths, and `git diff --exit-code <task-start> -- IDEA2-AEGIS_Monitor/server/streamLifecycle.js`. Any change stops for owner review.
- [ ] **Step 9: Validate repository/governance/security.** From repository root run:

```powershell
git diff --check
node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
node --test --test-concurrency=1 tests/*.test.mjs
```

Run the plan's placeholder scan, inspect added lines for private-key blocks and assigned password/secret/token/API-key/session/database values, and confirm exactly one new receipt. Record the two known pre-existing Vault Canvas warnings separately if they remain.

- [ ] **Step 10: Perform final local security/code review.** Require Critical=0 and Important=0. Check challenge atomicity/domain separation, loopback boundary, key confinement, session-only authority, live revocation, strict-mode no fallback, physical/logical split, no pre-stream demand, no UI change, CP3 pause, and CP5 exclusion.
- [ ] **Step 11: Checkpoint.** Stage only Task 5 files, run cached diff checks, commit `test(idea2): verify camera-first slice one readiness`, and push the same branch. Do not create/update the PR until the owner reviews the complete Slice 1 branch.
- [ ] **Step 12: Stop for humans.** Request S1-H1, then S1-H2, S1-H3, and S1-H4 separately. S1-H5 remains blocked until PR review/merge and explicit Production authorization.

## Spec Coverage Matrix

| Approved design concern | Executable coverage |
|---|---|
| Goal/current broken boundary | Tasks 1–4 |
| Camera/account contract | Task 4 matrix; S1-H2/H4 |
| Existing registry/physical source | Tasks 1 and 4 |
| Target architecture | Tasks 1–4 |
| Browser protocol/canonical proof | Task 1; Task 2 cross-language test |
| Loopback Agent security | Task 2; S1-H1 |
| Monitor verify/session binding | Tasks 1 and 3; S1-H2 |
| Account alias authorization | Task 4 |
| Physical stream resolution | Task 4; S1-H4 |
| Capture on demand | Task 5; S1-H3/H4 |
| Error/replay/expiry/renewal | Tasks 1 and 3 |
| Historical reconciliation | Global Constraints and task-local adaptation only |
| Protected files/test strategy | Task 5 |
| Rollout/rollback | S1-H1–H5 |
| B/C forward compatibility | Task 4 six-row unit matrix; no B/C deployment |
| CP3 compatibility | Task 2 minimum key/service principles; ingest/pipe excluded |
| CP5/SOC deferral | Global Constraints, Task 5 review |
| Known limitations | Human gates and limitations below |

## Plan Self-Review and Validation Commands

- [ ] Confirm the five tasks and coverage matrix account for every approved spec section without importing CP3 ingest or CP5 lifecycle work.
- [ ] Scan this plan for unfinished-marker vocabulary without spelling those markers as contiguous literals in the command:

```powershell
$bad = @('T'+'ODO', 'T'+'BD', 'implement '+'later', 'similar '+'to', 'appropriate '+'handling')
Select-String -LiteralPath 'docs/superpowers/plans/2026-09-14-idea2-camera-first-slice1-machine-association-implementation.md' -Pattern $bad -CaseSensitive:$false
```

Expected: no matches.

- [ ] Check interface spelling exactly once across tasks:

```powershell
rg -n "canonicalizeBrowserAssociationClaims|verifyBrowserAssociationProof|createBrowserAssociationService|currentNodeSessionBinding|bindLocalNode|currentLocalNode|clearLocalNode|maintainLocalNodeAssociation|createCameraAccessResolver|BrowserAssociationConfig|DpapiIdentityKeyStore|canonicalize_browser_association_claims|create_browser_association_server" docs/superpowers/plans/2026-09-14-idea2-camera-first-slice1-machine-association-implementation.md
```

Expected: declarations and task references use these spellings; no competing interface name appears.

- [ ] Run `git diff --check`; changed paths for this planning checkpoint must be only this plan and `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`.
- [ ] Run `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` and `node --test --test-concurrency=1 tests/*.test.mjs`; record pre-existing warnings separately.
- [ ] Inspect added lines in the plan/status for secret material. No credential value, private-key block, session/token/API-key value, database URL, biometric payload, or real machine identity may appear.
- [ ] Verify planning did not touch runtime or tests:

```powershell
git diff --name-only -- IDEA2-AEGIS_Monitor IDEA2-AEGIS_CCTV-Operator AEGIS_Camera
```

Expected: empty.

- [ ] Stage only the plan and canonical IDEA2 status note, run cached diff/name checks, commit `docs(idea2): plan camera-first machine association slice`, and push the same task branch. Do not begin Task 1 in the planning session.

## Known Limitations Before Implementation

- Source tests cannot prove Windows service identity, DPAPI CurrentUser behavior, exact loopback/PNA browser behavior, webcam open/release, or installed Machine A configuration; S1-H1–H4 provide that evidence.
- The in-memory Monitor challenge/session model supports one Monitor process. Horizontal scaling requires a future shared atomic state store.
- The strict switch cannot be enabled fleet-wide until B/C have compatible Agents or an isolated Machine A canary is reviewed.
- Slice 1 proves account alias validation and local physical routing, not CP5 logical-alias producer exclusivity, complete SOC passive behavior, or multi-tab lifecycle ownership.
- Existing Machine A public-key/physical registration must be inspected during S1-H1; tests use only ephemeral identities and disposable state.
- A clean browser-suite claim requires Playwright to start, execute, and terminate successfully; otherwise the result is blocked, not passed.
