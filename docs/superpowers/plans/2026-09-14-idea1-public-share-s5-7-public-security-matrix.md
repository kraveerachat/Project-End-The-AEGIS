# AEGIS IDEA1 Public Share S5.7 Public Internet Security Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This checkpoint hardens the plan only; it does NOT execute S5.7-A or authorize live public security probes.

**Goal:** Verify the narrow public redemption boundary at `share.aegistk-pb.com` through a bounded, evidence-backed negative security matrix before real external acceptance.

**Architecture:** The existing Cloudflare Published application route reaches `http://172.31.240.2:8080` through the isolated connector; the Gateway permits only the share-redemption route to reach Drive. S5.7 measures the current public surface without changing Production configuration, Cloudflare, DNS, TLS, or the UI. Every live-state claim requires fresh evidence and every matrix row has an explicit result and attribution layer.

**Tech Stack:** Git/GitHub CLI, Node.js documentation and contract tests, read-only Cloudflare/Production inventory, bounded `curl`/TLS/DNS observations, Markdown evidence matrix.

**Spec:** `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` and `docs/superpowers/plans/2026-09-13-idea1-public-share-s5-6-cloudflare-public-activation.md`; accepted S5.6 evidence is in `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-14_020000_kla_public-share-s5-6-cloudflare-public-activation.md`.

---

## 1. Security Model & Mutation Category Split

To prevent ambiguity, S5.7 splits operational permissions into distinct security gates:

- `PRODUCTION_CONFIGURATION_MUTATION_ALLOWED=NO`
- `TEST_INDUCED_APPLICATION_SIDE_EFFECT_ALLOWED=NO`
- `TEST_AUDIT_SIDE_EFFECT_ALLOWED=NO`
- `LIVE_PUBLIC_SECURITY_PROBES_ALLOWED=NO`

### Definition: Production Configuration Mutation
`PRODUCTION_CONFIGURATION_MUTATION` includes changes such as:
- Service configuration files or environment variables
- Docker state (`docker run`, `docker compose up`, `docker rm`, container recreation)
- Firewall rules (`s5-5-firewall.sh apply`, iptables/nft mutations)
- Systemd service or timer state (`start`, `stop`, `restart`, `enable`, `disable`)
- Cloudflare routes, DNS records, or TLS settings
- Reverse proxy or redirect rules
- Database schema, table structures, or system data
- Public Share UI enablement (`PUBLIC_SHARE_UI_ENABLED=true`)

**Policy:** `PRODUCTION_CONFIGURATION_MUTATION` remains **STRICTLY PROHIBITED** throughout all S5.7 phases. S5.7 is a verification-only phase.

### Definition: Test-Induced Application Side Effect
`TEST_INDUCED_APPLICATION_SIDE_EFFECT` refers to persistent application or database state created solely as a consequence of receiving security test requests.

**Finding A (Audit Side Effect Model):**
A request reaching Drive at `/s/invalid-token-probe` calls `resolveShare()`. For the fixed unknown token, `GET` and `POST` may attempt `SHARE_REDEEM` audit recording. With healthy PostgreSQL, this normally creates an `audit_log` row.
- The audit writer catches database failure; therefore, an HTTP response alone does **NOT** prove that an audit row persisted.
- The fixed token `invalid-token-probe` is **NOT** considered a meaningful collision risk with currently generated share tokens (which use 32 cryptographically secure random bytes encoded as 43-character base64url strings). No collision-risk claim is retained.
- Deleting test audit rows afterward would itself constitute an unauthorized Production database mutation. Test audit rows must **NOT** be automatically cleaned up/deleted.

**Policy:** `TEST_INDUCED_APPLICATION_SIDE_EFFECT_ALLOWED=NO` and `TEST_AUDIT_SIDE_EFFECT_ALLOWED=NO` at default S5.7 state.

### Future Audit-Side-Effect Gate
Before any request that can reach Drive (`Class 1` probes) is executed live, a separate explicit authorization gate from ChatGPT + Human Owner is required:
`TEST_AUDIT_SIDE_EFFECT_ALLOWED=YES`
This gate must explicitly define:
1. Exact synthetic identifier (`invalid-token-probe`)
2. Exact allowed HTTP methods (`GET`, `HEAD`; `POST` prohibited by default)
3. Exact target endpoint class (`/s/:token`)
4. Exact finite request budget (e.g., maximum 5 requests)
5. Expected maximum audit side effects (e.g., maximum 5 `SHARE_REDEEM` rows)
6. Explicit start/stop conditions
7. Evidence collection procedure
8. Whether direct DB audit log observation is required or waived
9. Explicit affirmation that no cleanup/delete database mutation will be performed

At the current plan reconciliation checkpoint, **NO** audit-side-effect gate is granted.

---

## 2. README Provenance Rule

The following rule governs procedural references:

> "The immutable accepted S5.6 receipt and fresh S5.7 Human Owner evidence define current state. `gateway/public-share/production/README.md` is a historical/reviewed procedure reference, not current-state authority and not execution authorization. Historical README statements such as PUBLIC_DNS_TLS=NOT CONFIGURED, G5=OPEN, or 'nothing applied' must not override the accepted S5.6 receipt. S5.7-A may execute only commands explicitly enumerated in this S5.7 plan as read-only. README create, start, apply, enable, rollback, or other mutation commands remain unauthorized unless a later explicit gate says otherwise."

`gateway/public-share/production/README.md` must not be modified in this task.

---

## 3. Main Divergence & Reconciliation Policy

If `origin/main` advances during S5.7:
1. **FIRST** inspect the changed paths between current branch base and `origin/main`:
   ```bash
   git diff --name-status <base>..origin/main
   ```
2. If the advancement touches any of:
   - `IDEA1-AEGIS_Drive_LC/`
   - `gateway/public-share/`
   - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/`
   - Drive public-share security behavior or routing contracts
   - Shared security or collaboration policy relevant to S5.7
   **STOP immediately** and return to ChatGPT. Do not merge automatically.
3. If the advancement is confirmed to be strictly non-overlapping work from another area (e.g., IDEA2):
   - Do not silently continue.
   - Record the advancement scope and obtain an explicit ChatGPT reconciliation gate.
   - When authorized, synchronize using a **NORMAL merge** (`git merge --no-edit origin/main`).
   - **FORBIDDEN:** `git rebase`, `git commit --amend`, `git reset --hard`, `git push --force`.
4. **Current Status:**
   - S5.6 merge baseline: `fe75bc53c1fd3a3103708470dfb7111996b80eff`
   - Reviewed `origin/main` advancement 1: `13d8fef6e464ecdbc96d466306dbc5aff3c2ae9a` (IDEA2-only, normal merge commit `2f73d08062c5a066943c4eafca0908d9d0985d1e`)
   - Reviewed `origin/main` advancement 2: `90efbc8ec95aa026ca7dd8f12f8de91a99d1645b` (IDEA3 PR #127 docs only, zero IDEA1/Gateway overlap, normal merge commit `c53208a64ca3b4147a0207d15d59dc9492a2f884`)
   - Reviewed `origin/main` advancement 3: `c448dfb914d2480f81fbc35abfbc8e5633dd3a38` (IDEA3 PR #131 docs only, zero IDEA1/Gateway runtime overlap)
   - Merge-base before third reconciliation: `90efbc8ec95aa026ca7dd8f12f8de91a99d1645b`
   - Normal merge commit: `17b1165a295a24a66ee04330ece81aead6c788fc`
   - Status: `MAIN_RECONCILED=YES` (all three reconciliations verified cleanly, zero conflicts).

---

## 4. Probe Classification & Risk Tiers

Live probes are categorized into three strict risk classes:

### Class 0 — Read-Only / Non-Drive-Redemption (Lowest Risk)
- Public DNS queries (`A`, `AAAA`, `CNAME`)
- TLS protocol handshakes (TLS 1.0, 1.1, 1.2, 1.3 negotiation)
- HTTP -> HTTPS 308 redirect checks
- Public root and default-deny paths (`/`, `/api/`, `/drive/`, `/admin`, `/login`, `/settings`, `/internal/`, `/healthz`, `/monitor/`)
- Production read-only runtime inspections (systemctl status, docker inspect, firewall validate)
- **Status:** Eligible for S5.7-A and S5.7-B after future ChatGPT authorization.

### Class 1 — Possibly Drive-Reaching Synthetic Share Probes (Audit Risk)
- Any request to `/s/<synthetic-id>` (e.g., `/s/invalid-token-probe`)
- Path-traversal or malformed variants that could resolve to `/s/...` before reaching Drive
- **Risk:** Drive records `SHARE_REDEEM` in `audit_log`, generating persistent database state.
- **Status:** **BLOCKED** until explicit `TEST_AUDIT_SIDE_EFFECT_ALLOWED=YES` gate is granted with defined request budget.
- **POST Method Default:** `POST_LIVE_PROBE_DEFAULT=PROHIBITED`. Initial live batch excludes `POST`. Existing local test suites already prove Gateway allows `GET|POST` to Drive; public live `POST` requires separate explicit approval.

### Class 2 — Higher Consequence / Excluded (Strictly Forbidden)
- Real bearer tokens or real user shares
- Real user data or credential guessing
- Brute-force attacks or high-rate fuzzing
- Denial of Service (DoS) or sustained concurrency
- Port scanning or network discovery across Cloudflare infrastructure
- HTTP `CONNECT` method (prohibited absent explicit documented justification and gate)
- **Status:** **STRICTLY EXCLUDED** from S5.7.

---

## 5. Local Test Prerequisites Before Live Probes (Findings B & C)

**Finding B (Raw Request Target Preservation):**
The repository already contains raw-request-target-preserving test harnesses in existing Node HTTP tests (primarily `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayRuntime.test.js` using raw `node:http`). Do **NOT** invent a new harness. Existing patterns must be reused.

**Finding C (Local Coverage Gaps — Resolved):**
The local coverage gaps for planned S5.7-C/D edge cases have been implemented and verified in the Gateway runtime test harness (`IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayRuntime.test.js`):
- `TRACE` method fail-closed handling (`PS3-RUNTIME-5`)
- Double-encoded traversal: `/s/%252e%252e%252fhealthz` (`PS3-RUNTIME-6`)
- Encoded slash: `/s/%2finvalid-token-probe` (`PS3-RUNTIME-6`)
- Encoded backslash: `/s/%5cinvalid-token-probe` (`PS3-RUNTIME-6`)
- Duplicate slash: `/s//invalid-token-probe` (`PS3-RUNTIME-6`)

**Prerequisite Verification Evidence (Commit `7f628fb16f51a718fe7ef3d0a2f584d44ef3e932`):**
- **Status:** `LOCAL_TEST_PREREQUISITE=PASS` / `COMPLETE / ACCEPTED`.
- **Targeted Scope:** Diff was +6 / -3 exclusively in `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayRuntime.test.js`. Production source changed: `NO`. Gateway config changed: `NO`.
- **Harness & Invariants:** Uses raw `node:http` to preserve byte-exact request targets without client-side normalization (`RAW_REQUEST_TARGET_HARNESS=node:http`). All forbidden paths assert `ZERO_UPSTREAM_CONTACT_ASSERTED=YES`.
- **Gateway Runtime Suite Result:** 18 passed, 0 failed (`PS3-RUNTIME-5=PASS`, `PS3-RUNTIME-6=PASS`). These tests cover existing secure behavior; no production remediation was required.
- **Canonical Full Regression:** Canonical command `npm test` completed:
  `TOTAL_TESTS=1309`, `PASSED=1228`, `FAILED=9`, `SKIPPED=72`.
  Full regression bar completed; `NEW_FAILURES=0`; accepted historical failures unchanged (`AUTOLOCK-5`, `PS6-ENV-4` through `PS6-ENV-8`, `publicShareStageBDiagnostics`, `publicShareStageBUploadClient`).
- **Non-Canonical Runner Incident Investigation:** An earlier run invoked the non-canonical command `node --test --test-concurrency=1 --test-force-exit "tests/**/*.test.js"`, causing three phantom whole-file failures on Windows/Node 24 (`contentSecurityPolicy.test.js`, `healthTelemetry.test.js`, `trustedProxy.test.js`). Investigation confirmed that each file passes individually, all three pass serially together, and all three pass inside canonical `npm test`. `--test-force-exit` reproduces a libuv forced-exit abort in Node. Classified: `NON_CANONICAL_FORCE_EXIT_FAILURES=RUNNER_ARTIFACT`, `SOURCE_REMEDIATION_REQUIRED=NO`. Do not add `--test-force-exit` to package.json or repository test scripts.

**Current Transition:**
Local test prerequisites for S5.7-C and S5.7-D are complete. Live C and D execution remains blocked pending explicit human owner / ChatGPT authorization for test audit side effects (`TEST_AUDIT_SIDE_EFFECT_AUTHORIZATION`).

---

## 6. Evidence Attribution Model & Metadata (Finding E)

Cloudflare-edge responses do not automatically prove Gateway behavior, and Drive application responses do not prove Gateway boundary enforcement.

### Attribution Rules:
1. **Cloudflare Rejections (403/404/405):** Do not prove Gateway internal behavior. If Cloudflare blocks a request at the edge, the Gateway boundary for that request must be recorded as `NOT TESTED`.
2. **Drive Rejections (404 Unknown Token):** Proves that Gateway **allowed** the request through to Drive, not that Gateway denied it.
3. **Normalization Attribution:** If client libraries or Cloudflare edge normalize path bytes before Gateway receives them, the Gateway raw-path behavior must be recorded as `NOT TESTED` unless Gateway-level receipt of raw bytes is proven.
4. **Host Header Attribution:** Distinguish incoming Host representations (port representation, case variation) from the Gateway's configured canonical upstream Host.
5. **Redirect Safety:** A same-host HTTP -> HTTPS 308 redirect that preserves query strings is **NOT** an open redirect. Redirect safety evaluates `Location.scheme`, `Location.authority`, and `Location.host`. User-supplied query parameters looking like URLs or IP addresses are inert data.

### 14 Metadata Fields & NOT_APPLICABLE Semantics:
Every row in the consolidation matrix must contain the 14 metadata fields:
```text
1.  OBSERVED_LAYER=<Cloudflare Edge | Public Share Gateway | Drive Application | Resolver | Host OS>
2.  ATTRIBUTION_BASIS=<Header fingerprint | Response body | Connector logs | Firewall counter | Process status>
3.  APPLICATION_SIDE_EFFECT_EXPECTED=<YES | NO>
4.  APPLICATION_SIDE_EFFECT_OBSERVED=<NONE | AUDIT_ROW_CONFIRMED | UNCHECKED>
5.  VANTAGE_POINT=<External IPv4/v6 | Twingate Off | Host Local | Control Plane>
6.  UTC_TIMESTAMP=<YYYY-MM-DDTHH:MM:SSZ>
7.  PR_SHA=<git-commit-sha>
8.  METHOD=<GET | HEAD | POST | PUT | etc. | NOT_APPLICABLE(...)>
9.  RAW_TARGET=<exact-raw-target-sent | NOT_APPLICABLE(...)>
10. HOST_OR_AUTHORITY=<exact-host-header | NOT_APPLICABLE(...)>
11. SNI=<exact-tls-sni | NOT_APPLICABLE(...)>
12. REDIRECT_FOLLOWED=<YES | NO | NOT_APPLICABLE(...)>
13. CLIENT_NORMALIZATION=<NONE | PATH_NORMALIZED | NOT_APPLICABLE(...)>
14. CLOUDFLARE_NORMALIZATION_KNOWN=<YES | NO | UNKNOWN | NOT_APPLICABLE(...)>
```

#### Non-HTTP Evidence & NOT_APPLICABLE Semantics:
The 14-field model is a superset used across all S5.7 evidence categories. For non-HTTP or non-redemption evidence where specific fields have no semantic meaning, fields must **NOT** be fabricated with fake HTTP data or left blank. Use the explicit syntax:
`NOT_APPLICABLE(<reason>)`

Examples:
- **Public DNS query**:
  `METHOD=NOT_APPLICABLE(DNS_QUERY)`
  `RAW_TARGET=NOT_APPLICABLE(DNS_QUERY)`
  `SNI=NOT_APPLICABLE(DNS_QUERY)`
  `REDIRECT_FOLLOWED=NOT_APPLICABLE(DNS_QUERY)`
- **TLS protocol handshake**:
  `METHOD=NOT_APPLICABLE(TLS_HANDSHAKE)`
  `RAW_TARGET=NOT_APPLICABLE(TLS_HANDSHAKE)`
  `REDIRECT_FOLLOWED=NOT_APPLICABLE(TLS_HANDSHAKE)`
- **Production systemctl / Docker runtime observation**:
  `METHOD=NOT_APPLICABLE(PRODUCTION_RUNTIME_OBSERVATION)`
  `RAW_TARGET=NOT_APPLICABLE(PRODUCTION_RUNTIME_OBSERVATION)`
  `HOST_OR_AUTHORITY=NOT_APPLICABLE(PRODUCTION_RUNTIME_OBSERVATION)`
  `SNI=NOT_APPLICABLE(PRODUCTION_RUNTIME_OBSERVATION)`
- **Governance observation**:
  `METHOD=NOT_APPLICABLE(GOVERNANCE)`
  `RAW_TARGET=NOT_APPLICABLE(GOVERNANCE)`

If a field is applicable to the test type but evidence could not be gathered, do **NOT** mark it `NOT_APPLICABLE`. Use `UNKNOWN / UNPROVEN` to signify an applicable but unestablished fact.

Allowed status values are **ONLY**: `PASS`, `FAIL`, `NOT TESTED`.

---

## 7. Post-Defect Rerun Policy

If any security-critical `FAIL` is discovered during live or local testing:
1. **Stop** the affected attack class immediately.
2. **Preserve** sanitized evidence and telemetry.
3. Do **NOT** attempt ad-hoc repairs or mutate Production/Cloudflare.
4. **Return** to ChatGPT with failure details and attribution analysis.
5. If implementation repair is needed, route to **Codex or Claude Code** under a dedicated remediation gate.
6. Independently **verify** the repair in local test suites.
7. **Re-run** the affected attack class against the deployed/verified environment with fresh evidence.
8. Historical pre-fix evidence must remain preserved in task records; do not overwrite history.
9. Continue subsequent S5.7 phases only after the rerun passes.

---

## 8. File and Evidence Map

| Path | Role in S5.7 |
| :--- | :--- |
| `gateway/public-share/nginx.conf.template` | Reviewed Gateway route, Host, method, and raw-path policy; read-only unless a defect gate authorizes a fix. |
| `gateway/public-share/production/README.md` | Historical/reviewed procedure reference; read-only reference, not execution authority. |
| `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayRuntime.test.js` | Opt-in disposable real-Gateway runtime harness. Uses raw `node:http` rather than `fetch` specifically so traversal/raw request targets can reach the Gateway without client-side normalization. Primary harness for the planned TRACE and encoded/raw-path Gateway regression deltas. |
| `IDEA1-AEGIS_Drive_LC/tests/publicShareSecurityRegression.test.js` | Recipient-facing / Drive security regression matrix covering refusal indistinguishability, audit behavior, token/password secrecy, security headers, attribution and related application-layer invariants. Useful for application behavior, but not the primary Gateway raw-request-target harness. |
| `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayStructure.test.js` | Existing local Gateway structural contracts. |
| `IDEA1-AEGIS_Drive_LC/tests/publicShareManagedTunnelIntegration.test.js` | Existing local managed-ingress / connector trust-boundary harness. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` | Live task/session register, evidence classification, and closeout records. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` | Canonical architecture, trust boundaries, and phase status. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md` | Area-level status and MOC entry. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_kla_public-share-s5-7-public-security-matrix.md` | Exactly one immutable **final** task receipt, created only at S5.7-H closeout. |

---

## Phase Execution Details

### Task 1 — S5.7-A: Bootstrap / fresh read-only preflight

**Boundary:** Class 0 only. Strictly read-only. Does **NOT** send `/s/invalid-token-probe` or any share-redemption request.
**Fixed Redirect Target for S5.7-A:** Use fixed non-share URL `http://share.aegistk-pb.com/` without following redirects automatically. Record status, Location header, scheme, authority, and host. Expected: HTTP 308 redirect to `https://share.aegistk-pb.com/` (same approved hostname over HTTPS). Do not send any `/s/...` path during S5.7-A.

**Authorized Command Scope & Allowlisted Projections:**
- **Repository**: `git status --short`, `git rev-parse HEAD`, `git rev-parse origin/main`, `git merge-base --is-ancestor origin/main HEAD`
- **Cloudflare Control Plane (Read-Only via Owner)**: tunnel status, replica count, hostname route inspection
- **Public Edge / DNS**: DoH queries (`1.1.1.1`, `8.8.8.8`), TLS handshake validation (TLS 1.0/1.1/1.2/1.3), non-following HTTP redirect check against `http://share.aegistk-pb.com/`
- **Production Host Systemd / Firewall (Read-Only via Owner)**:
  - `systemctl is-active aegis-public-share-s5-5-firewall.service` (Procedure Correction: corrected from incorrect unit name `aegis-public-share-firewall.service` which produced inactive/not-found)
  - `systemctl is-enabled aegis-public-share-s5-5-firewall.service`
  - `systemctl is-active aegis-public-share-connector.service`
  - `systemctl is-enabled aegis-public-share-connector.service`
  - `systemctl is-active aegis-public-share-drift.timer`
  - `systemctl is-enabled aegis-public-share-drift.timer`
  - `sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh validate`
  - Read-only `git rev-parse` on frozen release directory
- **Production Container Status (Protected Services)**:
  - `sudo docker ps --format '{{.Names}}\t{{.Status}}'` (proves running/healthy for `aegis-prod-public-share-gateway-1`, `aegis-prod-drive-1`, `aegis-prod-monitor-1`, `aegis-prod-hub-1`, postgres, twingate, and connector)
- **Allowlisted Docker Inspect Projections (NO Full Inspect Output)**:
  - `FULL_DOCKER_INSPECT_OUTPUT=PROHIBITED`
  - `CONFIG_ENV_INSPECTION=PROHIBITED`
  - `CONFIG_CMD_DUMP=PROHIBITED`
  - `TOKEN_FILE_CONTENT_READ=PROHIBITED`
  - `SECRET_ENVIRONMENT_OUTPUT=PROHIBITED`
  - Allowlisted projection commands for `aegis-prod-public-share-connector-1`:
    ```bash
    sudo docker inspect aegis-prod-public-share-connector-1 \
      --format 'Status={{.State.Status}} Running={{.State.Running}} Restarting={{.State.Restarting}} RestartCount={{.RestartCount}}'

    sudo docker inspect aegis-prod-public-share-connector-1 \
      --format '{{range $net, $cfg := .NetworkSettings.Networks}}{{$net}}={{$cfg.IPAddress}} {{end}}'

    sudo docker inspect aegis-prod-public-share-connector-1 \
      --format 'PortBindings={{json .HostConfig.PortBindings}}'

    sudo docker inspect aegis-prod-public-share-connector-1 \
      --format 'User={{.Config.User}} ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}} CapDrop={{json .HostConfig.CapDrop}} SecurityOpt={{json .HostConfig.SecurityOpt}} RestartPolicy={{.HostConfig.RestartPolicy.Name}} MaxRetry={{.HostConfig.RestartPolicy.MaximumRetryCount}}'
    ```
  - Allowlisted projection for Gateway host-port absence:
    ```bash
    sudo docker inspect aegis-prod-public-share-gateway-1 \
      --format 'PortBindings={{json .HostConfig.PortBindings}}'
    ```
- **Connector Readiness Inspection Context**:
  - The connector metrics listener (`127.0.0.1:20241`) is bound **inside** the container/network namespace and is not host-published. Host-loopback requests (e.g. host `curl`) are **NOT** authorized and must not be used as evidence.
  - Authorized execution command:
    ```bash
    sudo docker exec aegis-prod-public-share-connector-1 \
      cloudflared tunnel --metrics 127.0.0.1:20241 ready
    ```
  - `DOCKER_EXEC_AUTHORIZED_FOR_S5_7_A = ONLY_THE_EXACT_CLOUDFLARED_READINESS_COMMAND_ABOVE`
  - All other `docker exec` commands remain unauthorized. If readiness fails, record `FAIL` / `NOT TESTED`; do not restart or modify the container.
- **FORBIDDEN COMMANDS**:
  - `systemctl start`, `systemctl stop`, `systemctl restart`, `systemctl enable`, `systemctl disable`, `systemctl enable --now`
  - `s5-5-firewall.sh apply`, `s5-5-firewall.sh remove`
  - Rollback scripts execution
  - `docker start`, `docker stop`, `docker restart`, `docker up`, `docker create`, `docker rm`, Compose mutations
  - Database write commands
  - Cloudflare, DNS, TLS, or UI mutations

- [x] Verify branch/HEAD, clean worktree, current `origin/main`, and merge ancestry (`git merge-base --is-ancestor origin/main HEAD`) — **PASS**.
- [x] Obtain fresh **read-only** Cloudflare control-plane evidence: tunnel `HEALTHY`, 1 replica, exactly one approved route (`share.aegistk-pb.com` -> `http://172.31.240.2:8080`) — **PASS**.
- [x] Obtain fresh public DNS and edge evidence: proxied A/AAAA, TLS 1.0/1.1 rejected, TLS 1.2/1.3 accepted, HTTP -> HTTPS 308 redirect on `http://share.aegistk-pb.com/` without following — **PASS**.
- [x] Obtain fresh **read-only** Production evidence using allowlisted projections only: connector running/isolated, firewall valid, drift timer active, protected services intact, connector readiness proven via internal container command — **PASS**.
- [x] Confirm G5 **APPROVED** and G6 **OPEN**; mark each check with structured 14-field metadata; `PUBLIC_SHARE_UI_FRESH_DIRECT_RUNTIME_PROOF=NOT TESTED` (governance preserved) — **PASS**.

#### Accepted S5.7-A Evidence Summary (Verified by Human Owner 2026-09-14):
- **A1 Repository Preflight**: PASS. Branch clean on `feat/idea1-public-share-s5-7-public-security-matrix`.
- **A2 Cloudflare Control Plane**: PASS. Zone `aegistk-pb.com` Active; tunnel `AEGIS-PUBLIC-SHARE` Healthy (activeReplicas=1); 1 Published application route (`share.aegistk-pb.com` -> `http://172.31.240.2:8080`, path <blank>); Wildcard=NO, Root=NO, Alternate=NO.
- **A3 Public DNS**: PASS. Cloudflare DoH and Google DoH agreed: A (104.21.40.88, 172.67.183.68), AAAA (2606:4700:3031::6815:2858, 2606:4700:3037::ac43:b744). PRIVATE_ORIGIN_IP_VISIBLE=NO.
- **A4 Public TLS**: PASS. TLS 1.0/1.1 rejected with TLS alert protocol version. TLS 1.2/1.3 passed.
- **A5 HTTP -> HTTPS Redirect**: PASS. GET `http://share.aegistk-pb.com/` returned HTTP 308 with Location `https://share.aegistk-pb.com/` (redirect not followed; observed layer: Cloudflare Edge).
- **A6 Systemd Services (Procedure Corrected)**: PASS. Initial query used incorrect unit name `aegis-public-share-firewall.service` producing `inactive / not-found`. Fresh retry against correct unit `aegis-public-share-s5-5-firewall.service` proved `active / enabled`. `aegis-public-share-connector.service` active/enabled; `aegis-public-share-drift.timer` active/enabled.
- **A7 Firewall Validation**: PASS. `s5-5-firewall.sh validate` returned `S5.5-FIREWALL=VALID`.
- **A8 Protected Containers**: PASS. All 7 protected containers running/healthy: connector running, public-share-gateway healthy, drive healthy, monitor healthy, hub healthy, postgres healthy, twingate healthy.
- **A9 Connector Runtime**: PASS. Status=running, Running=true, Restarting=false, RestartCount=0, aegis_public_share_edge=172.31.240.3, aegis_public_share_egress=172.31.242.2, PortBindings={}, User=65532:65532, ReadonlyRootfs=true, CapDrop=["ALL"], SecurityOpt=["no-new-privileges:true"], RestartPolicy=on-failure, MaxRetry=5.
- **A10 Gateway Host-Port Absence**: PASS. Gateway PortBindings={}.
- **A11 Connector Readiness**: PASS. Executed inside container (`cloudflared tunnel --metrics 127.0.0.1:20241 ready`); exit code 0.
- **A12 Frozen Release Directory**: PASS. Git rev-parse on `/opt/aegis/releases/public-share/99a6f916f5b4aa20da2a1c2ee68e75162f7e23b7` verified commit `99a6f916f5b4aa20da2a1c2ee68e75162f7e23b7`.
- **Public Share UI Direct Runtime Proof**: `PUBLIC_SHARE_UI_FRESH_DIRECT_RUNTIME_PROOF=NOT TESTED`. Reason: Fresh direct runtime proof was intentionally not obtained because unrestricted container environment/config inspection is prohibited by the S5.7 secret-safe inspection boundary. Retain governance truth only: G5=APPROVED, G6=OPEN, PUBLIC_SHARE_UI_MUTATION_ALLOWED=NO. Do not claim UI disabled as freshly proven runtime evidence.
- **Outcome**: S5.7-A is **CLOSED / ACCEPTED**. S5_7_A_ACCEPTED_TO_PROCEED=YES. SECURITY_CRITICAL_FAILURES=0.

### Task 2 — S5.7-B: Public surface / boundary enumeration

**Boundary:** Class 0 only. Finite public surface list. Bounded `GET` / `HEAD` requests. Short timeout. No authentication.

- [x] Test bounded default-deny surface list (Root: `/`, Drive: `/drive/`, `/api/`, `/api/audit`, `/healthz`, Admin: `/admin`, `/settings`, `/login`, Internal: `/monitor/`, `/internal/`) — **PASS (all 10 paths tested via GET and HEAD, total 20 requests)**.
- [x] Verify default-deny response (`403` or `404`); verify no private origin IP, stack trace, or internal service information leaked — **PASS (all 20 returned HTTP 404, CURL_EXIT=0, zero leaks)**.
- [x] Record structured metadata per row; confirm boundary attribution (Cloudflare edge vs Gateway) — **PASS (PUBLIC_DEFAULT_DENY=PASS, CLOUDFLARE_PATH_OBSERVED=YES, GATEWAY_REJECTION_ATTRIBUTION=NOT TESTED)**.

#### Accepted S5.7-B Evidence Summary (Verified by Human Owner 2026-09-14):
- **Execution Status**: COMPLETE / PASS.
- **UTC Window**: `2026-09-14T14:51:56Z` through `2026-09-14T14:51:59Z`.
- **PR SHA Used**: `a5ff07b0a12d139c0b544fe5392439dffcbc4ac3`.
- **Request Budget & Methods**: Total 20 requests (10 GET, 10 HEAD) across 10 finite paths (`/`, `/drive/`, `/api/`, `/api/audit`, `/healthz`, `/admin`, `/settings`, `/login`, `/monitor/`, `/internal/`).
- **Authentication**: NONE. **Redirect Following**: NO (`REDIRECT_FOLLOWED=NO`).
- **Response Codes**: All 20 requests returned HTTP `404` (`CURL_EXIT=0`).
- **Hygiene & Information Leak Checks**:
  - `PRIVATE_IP_LEAK=NO` (no private CIDRs in response)
  - `STACK_TRACE_LEAK=NO` (no traces or internal exceptions)
  - `DATABASE_ERROR_LEAK=NO` (no SQL errors or DB schema details)
  - `CONTAINER_NAME_LEAK=NO` (no `aegis-prod-*` strings)
  - `INTERNAL_PATH_LEAK=NO` (no internal file paths disclosed)
  - `X_POWERED_BY=<none>` (header absent)
  - `APPLICATION_SIDE_EFFECT_EXPECTED=NO`
  - `APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED`
  - `Server=cloudflare`, `CF-RAY` present on all 20 responses.
- **Attribution Analysis**:
  - `PUBLIC_DEFAULT_DENY=PASS`
  - `CLOUDFLARE_PATH_OBSERVED=YES`
  - `GATEWAY_REJECTION_ATTRIBUTION=NOT TESTED`
  - *Attribution boundary*: `Server: cloudflare` and `CF-RAY` establish traversal through the Cloudflare edge, but do not independently identify whether the 404 originated at Cloudflare edge or was proxied from the Public Share Gateway. This attribution limitation is NOT a S5.7-B security failure.
- **Failures**: `SECURITY_CRITICAL_FAILURES=0`.
- **Outcome**: S5.7-B is **CLOSED / ACCEPTED**.

### Task 3 — S5.7-C: HTTP method / Host / forwarding-header abuse

**Boundary:** Class 1 for share target; explicitly authorized single finite batch; local test prerequisite completed. `POST=PROHIBITED`, `CONNECT=PROHIBITED`.

- [x] Verify local test prerequisite passed (Finding B & C: local TRACE test passing in Gateway suite) — **PASS** (implemented in commit `7f628fb16f51a718fe7ef3d0a2f584d44ef3e932` in `publicShareGatewayRuntime.test.js`; `PS3-RUNTIME-5=PASS` with zero upstream contact).
- [x] Obtain explicit `TEST_AUDIT_SIDE_EFFECT_ALLOWED=YES` gate with finite request budget before sending live requests to `/s/invalid-token-probe` — **PASS** (explicitly authorized by Human Owner / ChatGPT: budget=17, hard max audit rows=9, POST/CONNECT prohibited, audit cleanup prohibited).
- [x] Execute bounded method matrix against `/s/invalid-token-probe`: `GET`, `HEAD`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `TRACE` (`POST` prohibited; `CONNECT` strictly prohibited) — **PASS** (C01 GET: 404; C02-C07 HEAD, PUT, PATCH, DELETE, OPTIONS, TRACE: 405; all CURL_EXIT=0).
- [x] Test Host header variations (Approved hostname `share.aegistk-pb.com`, standard port `:443`, case variation `SHARE.AEGISTK-PB.COM`, unapproved host `unapproved-host.example.invalid`, IP Host `172.31.240.2`; TLS SNI preserved) — **PASS** (C08 :443: 404; C09 uppercase: 404; C10 unapproved: 403; C11 IP host: 403; invalid Host confers zero access; all CURL_EXIT=0).
- [x] Test spoofed forwarding headers (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, `CF-Connecting-IP` using `198.51.100.77`) — **PASS** (C12-C16: 404; C17 CF-Connecting-IP: 403; spoofed headers do not bypass Gateway or alter trust; spoof IP 198.51.100.77 was NOT persisted; SPOOF_DELTA=0; all CURL_EXIT=0).
- [x] Record structured metadata per row; verify audit side-effect limits and attribution boundaries — **PASS** (Audit delta 8 <= hard max 9; all 8 target rows DENIED; zero leaks; temporary authorization revoked).

#### Accepted S5.7-C Evidence Summary (Verified by Human Owner 2026-09-14):
- **Execution Window**: UTC `2026-09-14T20:24:46Z` through `2026-09-14T20:24:54Z`.
- **Target URL**: `https://share.aegistk-pb.com/s/invalid-token-probe` (synthetic token, no auth, no redirect follow).
- **Requests Executed**: Exactly 17 of 17 planned requests (`S5_7_C_WINDOWS_BATCH=COMPLETE`).
- **HTTP Method Matrix (C01–C07)**:
  - C01 GET (default Host): HTTP `404`, CURL_EXIT 0, `Server: cloudflare`, CF-RAY present, Location absent.
  - C02 HEAD: HTTP `405`, CURL_EXIT 0.
  - C03 PUT: HTTP `405`, CURL_EXIT 0.
  - C04 PATCH: HTTP `405`, CURL_EXIT 0.
  - C05 DELETE: HTTP `405`, CURL_EXIT 0.
  - C06 OPTIONS: HTTP `405`, CURL_EXIT 0.
  - C07 TRACE: HTTP `405`, CURL_EXIT 0.
- **Host Header Matrix (C08–C11)**:
  - C08 GET (`Host: share.aegistk-pb.com:443`): HTTP `404`, CURL_EXIT 0.
  - C09 GET (`Host: SHARE.AEGISTK-PB.COM`): HTTP `404`, CURL_EXIT 0.
  - C10 GET (`Host: unapproved-host.example.invalid`): HTTP `403`, CURL_EXIT 0.
  - C11 GET (`Host: 172.31.240.2`): HTTP `403`, CURL_EXIT 0.
- **Forwarding Header Matrix (C12–C17)**:
  - C12 GET (`Forwarded: for=198.51.100.77;proto=http;host=unapproved-host.example.invalid`): HTTP `404`, CURL_EXIT 0.
  - C13 GET (`X-Forwarded-For: 198.51.100.77`): HTTP `404`, CURL_EXIT 0.
  - C14 GET (`X-Forwarded-Host: unapproved-host.example.invalid`): HTTP `404`, CURL_EXIT 0.
  - C15 GET (`X-Forwarded-Proto: http`): HTTP `404`, CURL_EXIT 0.
  - C16 GET (`X-Real-IP: 198.51.100.77`): HTTP `404`, CURL_EXIT 0.
  - C17 GET (`CF-Connecting-IP: 198.51.100.77`): HTTP `403`, CURL_EXIT 0.
- **General Response Hygiene**: All 17 requests: no curl transport error, no redirect, no 2xx/3xx, no 5xx, `Server: cloudflare`, CF-RAY present, zero leaks under bounded checks.
- **Audit Verification (Before vs After)**:
  - Before (2026-09-14T20:14:09Z): `BASELINE_GLOBAL_MAX_AUDIT_ID=847`, `BASELINE_TEST_TARGET_COUNT=1`, `BASELINE_TEST_SPOOF_SOURCE_COUNT=0`.
  - After (2026-09-14T20:27:40Z): `AFTER_GLOBAL_MAX_AUDIT_ID=855`, `GLOBAL_NEW_ROWS=8`, `TARGET_DELTA=8`, `HARD_MAX_AUDIT_ROWS=9` (`AUDIT_LIMIT=PASS`).
  - Target Rows 848–855: Exactly 8 new rows, all `SHARE_REDEEM` with outcome `DENIED` (`NEW_TARGET_DENIED_ROWS=8`, `NEW_TARGET_NON_DENIED_ROWS=0`). All recorded with `spoof_source=NO`.
  - Spoof Persistence: `BASELINE_SPOOF_COUNT=0`, `AFTER_SPOOF_COUNT=0`, `SPOOF_DELTA=0`, `SPOOF_SOURCE_PERSISTED=NO`.
  - Consistent Reaching Requests: The 8 audit events correspond to requests C01, C08, C09, C12, C13, C14, C15, C16 (no over-claim of exact row-to-request mapping beyond reasonable timestamps/order).
  - Non-Reaching Requests: C02–C07, C10, C11, C17 generated zero target `SHARE_REDEEM` rows.
  - C17 Note: No `SHARE_REDEEM` audit row was created; rejection layer is not claimed uniquely between Cloudflare edge and Gateway.
  - Safe Test Evidence: Audit rows 848–855 are intentional authorized test evidence; `AUDIT_CLEANUP=PROHIBITED`.
- **Governance & Safety**:
  - `PRODUCTION_CONFIGURATION_MUTATION=NO`
  - `CLOUDFLARE_MUTATION=NO`
  - `POST_PROHIBITED=YES`
  - `CONNECT_PROHIBITED=YES`
  - Temporary authorizations REVOKED: `TEST_AUDIT_SIDE_EFFECT_ALLOWED=NO`, `LIVE_CLASS1_SECURITY_PROBES_ALLOWED=NO`.
- **Outcome**: S5.7-C is **CLOSED / ACCEPTED / PASS**.

### Task 4 — S5.7-D: Path normalization / traversal matrix

**Boundary:** Class 1; explicitly authorized single finite batch; local test prerequisite completed. `METHOD=GET_ONLY`, `POST=PROHIBITED`, `CONNECT=PROHIBITED`.

- [x] Verify local test prerequisite passed (Finding C: double-encoded traversal, encoded slash, encoded backslash, duplicate slash passing in local tests with raw request preservation) — **PASS** (implemented in commit `7f628fb16f51a718fe7ef3d0a2f584d44ef3e932` in `publicShareGatewayRuntime.test.js`; `PS3-RUNTIME-6=PASS` for `/s/%252e%252e%252fhealthz`, `/s/%2finvalid-token-probe`, `/s/%5cinvalid-token-probe`, `/s//invalid-token-probe` with `ZERO_UPSTREAM_CONTACT_ASSERTED=YES` and `RAW_REQUEST_TARGET_HARNESS=node:http`).
- [x] Obtain explicit `TEST_AUDIT_SIDE_EFFECT_ALLOWED=YES` gate with finite request budget — **PASS** (explicitly authorized by Human Owner / ChatGPT: budget=8, method=GET_ONLY, hard max audit rows=8, POST/CONNECT prohibited, audit cleanup prohibited).
- [x] Execute finite path list (8 GET-only probes) — **PASS** (all 8 returned HTTP `404`, CURL_EXIT 0, `Server: cloudflare`, CF-RAY present):
  - D01: `GET /s/invalid-token-probe` -> HTTP 404, CURL_EXIT 0, `CLIENT_SENT_TARGET=/s/invalid-token-probe`, `CLIENT_NORMALIZATION=NONE`
  - D02: `GET /s/../healthz` -> HTTP 404, CURL_EXIT 0, `CLIENT_SENT_TARGET=/s/../healthz`, `CLIENT_NORMALIZATION=NONE`
  - D03: `GET /s/%2e%2e/healthz` -> HTTP 404, CURL_EXIT 0, `CLIENT_SENT_TARGET=/s/%2E%2E/healthz`, `CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED`
  - D04: `GET /s/%2e%2e%2fhealthz` -> HTTP 404, CURL_EXIT 0, `CLIENT_SENT_TARGET=/s/%2E%2E%2Fhealthz`, `CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED`
  - D05: `GET /s/%252e%252e%252fhealthz` -> HTTP 404, CURL_EXIT 0, `CLIENT_SENT_TARGET=/s/%252e%252e%252fhealthz`, `CLIENT_NORMALIZATION=NONE`
  - D06: `GET /s//invalid-token-probe` -> HTTP 404, CURL_EXIT 0, `CLIENT_SENT_TARGET=/s//invalid-token-probe`, `CLIENT_NORMALIZATION=NONE`
  - D07: `GET /s/%2finvalid-token-probe` -> HTTP 404, CURL_EXIT 0, `CLIENT_SENT_TARGET=/s/%2Finvalid-token-probe`, `CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED`
  - D08: `GET /s/%5cinvalid-token-probe` -> HTTP 404, CURL_EXIT 0, `CLIENT_SENT_TARGET=/s/%5Cinvalid-token-probe`, `CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED`
- [x] Capture `INTENDED_RAW_TARGET`, `CLIENT_SENT_TARGET`, `OBSERVED_LAYER`, `NORMALIZATION_KNOWN`. If Gateway raw receipt is unproven, mark Gateway result `NOT TESTED` — **PASS** (`GATEWAY_RAW_RECEIPT=NOT_PROVEN`, `CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN`; local Gateway test prerequisite remains the evidence for raw Gateway behavior; client percent-hex case canonicalization documented for D03/D04/D07/D08 due to PowerShell case-insensitivity; not a security failure).
- [x] Record structured metadata per row; verify no traversal reaches internal endpoints — **PASS** (Zero traversal to internal endpoints; D01 canonical synthetic token reached Drive generating 1 DENIED `SHARE_REDEEM` row; D02–D08 generated 0 `SHARE_REDEEM` rows; external responses all fail-closed HTTP 404; audit delta 1 <= 8; audit row 856 preserved; temporary D permissions revoked).

#### Accepted S5.7-D Evidence Summary (Verified by Human Owner 2026-09-14):
- **Execution Window**: UTC `2026-09-14T20:53:14Z` through `2026-09-14T20:53:19Z`.
- **Requests Executed**: Exactly 8 of 8 planned GET-only requests (`S5_7_D_WINDOWS_BATCH=COMPLETE`).
- **Path Probes & Responses (D01–D08)**:
  - All 8 requests returned HTTP `404` with `CURL_EXIT=0`.
  - `Server: cloudflare` and `CF-RAY` present on all 8 responses; Location header absent.
  - Zero curl transport errors, zero redirects, zero 2xx/3xx, zero 5xx, zero information leaks.
- **Client Normalization & Raw Target Capture**:
  - D01: `CLIENT_SENT_TARGET=/s/invalid-token-probe`, `CLIENT_NORMALIZATION=NONE`
  - D02: `CLIENT_SENT_TARGET=/s/../healthz`, `CLIENT_NORMALIZATION=NONE`
  - D03: `CLIENT_SENT_TARGET=/s/%2E%2E/healthz`, `CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED`
  - D04: `CLIENT_SENT_TARGET=/s/%2E%2E%2Fhealthz`, `CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED`
  - D05: `CLIENT_SENT_TARGET=/s/%252e%252e%252fhealthz`, `CLIENT_NORMALIZATION=NONE`
  - D06: `CLIENT_SENT_TARGET=/s//invalid-token-probe`, `CLIENT_NORMALIZATION=NONE`
  - D07: `CLIENT_SENT_TARGET=/s/%2Finvalid-token-probe`, `CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED`
  - D08: `CLIENT_SENT_TARGET=/s/%5Cinvalid-token-probe`, `CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED`
  - *Client normalization note*: PowerShell `-eq` is case-insensitive; previous `CLIENT_TARGET_MATCH=True` must not be interpreted as byte-exact equality for percent-encoded rows. Percent-hex case canonicalization to uppercase is an artifact of the client tool and is NOT a security failure.
- **Attribution & Gateway Raw Receipt**:
  - `GATEWAY_RAW_RECEIPT=NOT_PROVEN`.
  - `CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN`.
  - Do NOT uniquely attribute the 404s to Gateway vs Cloudflare edge without direct evidence.
  - Local Gateway test prerequisite (`publicShareGatewayRuntime.test.js` from commit `7f628fb1...`) remains the canonical evidence for raw Gateway fail-closed behavior with zero upstream contact.
- **Audit Verification (PostgreSQL `aegis_drive` DB)**:
  - Baseline (20:43:08Z): Max ID 855, test target count 9, share redeem count 46.
  - Post-execution (20:54:43Z): Max ID 856, test target count 10, share redeem count 47.
  - Target delta: Exactly 1 row (`HARD_MAX_AUDIT_ROWS=8` satisfied, `AUDIT_LIMIT=PASS`).
  - Safe new row: `856|2026-09-14T20:53:14Z|DENIED|expected_target=YES`.
  - Reaching request: Canonical synthetic token D01 reached Drive and generated one DENIED `SHARE_REDEEM` row.
  - Non-reaching requests: D02–D08 generated zero new `SHARE_REDEEM` rows (`NEW_OTHER_SHARE_REDEEM_ROWS=0`). No evidence that malformed/traversal paths reached the Drive share-redemption path.
  - Test Evidence Preservation: Audit row 856 is intentional authorized test evidence; `AUDIT_CLEANUP=PROHIBITED`.
- **Governance & Safety**:
  - `PRODUCTION_CONFIGURATION_MUTATION_ALLOWED=NO`
  - `CLOUDFLARE_MUTATION=NO`
  - `POST_PROHIBITED=YES`
  - `CONNECT_PROHIBITED=YES`
  - Temporary authorizations REVOKED: `TEST_AUDIT_SIDE_EFFECT_ALLOWED=NO`, `LIVE_CLASS1_SECURITY_PROBES_ALLOWED=NO`.
- **Outcome**: S5.7-D is **CLOSED / ACCEPTED / PASS**.

### Task 5 — S5.7-E: URL / query / redirect safety

**Boundary & Classification Clarification:**
- **Class 0 Scope**: A Class 0 HTTP->HTTPS redirect check can prove only: redirect status, HTTPS scheme, approved authority/host, and path/query preservation behavior. It does **NOT** prove share authorization behavior.
- **Class 1 Scope**: Any S5.7-E test requiring a request to `/s/<synthetic-id>` is Class 1 and strictly requires `TEST_AUDIT_SIDE_EFFECT_ALLOWED=YES` before execution. No such gate is granted now.

- [ ] Test same-host HTTP -> HTTPS 308 redirect with inert query parameters on non-share path (e.g. `?url=https://unapproved.example.invalid`, `?ip=172.31.240.2`).
- [ ] Evaluate `Location.scheme`, `Location.authority`, `Location.host`. Verify authority remains strictly `share.aegistk-pb.com` and no open redirect or private origin disclosure occurs.
- [ ] Verify query data does not alter authorization or reflect unescaped payloads.
- [ ] Record structured 14-field metadata per row.

### Task 6 — S5.7-F: Information leakage / response hygiene

**Boundary:** Read-only inspection of response headers and bounded bodies gathered in B–E.

- [ ] Check for private IP CIDRs (`172.31.*`, `172.18.*`, `192.168.*`, `10.*`), database errors, stack traces, internal paths, container names (`aegis-prod-*`), `X-Powered-By`.
- [ ] Confirm `Server: cloudflare` is treated as expected edge metadata, not origin leak.
- [ ] Redact any sensitive material locally; never commit secrets to Git or Obsidian.
- [ ] Record structured metadata per row.

### Task 7 — S5.7-G: Security matrix consolidation

**Boundary:** Documentation only.

- [ ] Consolidate all rows under exact columns:
  `TEST | REQUEST | EXPECTED | ACTUAL | STATUS | EVIDENCE | SECURITY_BOUNDARY`
- [ ] Ensure all 14 metadata fields are populated in every `EVIDENCE` entry, applying `NOT_APPLICABLE(<reason>)` semantics for non-HTTP evidence categories.
- [ ] Ensure allowed statuses are strictly `PASS`, `FAIL`, `NOT TESTED`.
- [ ] If any attack class failed, ensure post-defect rerun policy was followed.

### Task 8 — S5.7-H: Final reconciliation / closeout

**Boundary:** Documentation and final receipt creation.

- [ ] Verify all S5.7 evidence accepted by ChatGPT + Human Owner.
- [ ] Reconcile canonical status notes (`idea1-status.md`, `idea1-public-share-architecture.md`, `idea1-moc.md`).
- [ ] Create exactly **ONE** immutable final receipt:
  `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_kla_public-share-s5-7-public-security-matrix.md`
- [ ] Run validation suite (`validate-vault.mjs`, `collaborationPolicy.test.mjs`, `git diff --check`).
- [ ] Update PR #130 body, mark Ready, await human merge. (PR must remain Draft until S5.7-H closeout).

---

## Current Status & Next Gate

At this S5.7-D live path normalization documentation checkpoint:
- S5.7 is **IN PROGRESS**
- S5.7-A is **CLOSED / ACCEPTED** (preflight & runtime verified)
- S5.7-B is **CLOSED / ACCEPTED** (public surface default-deny verified across 10 paths, 20 requests, 404 on all, zero leaks)
- S5.7-C is **CLOSED / ACCEPTED** (live method/Host/header matrix: 17 requests, audit delta 8 <= 9, 8 new SHARE_REDEEM DENIED rows, spoof persistence 0, zero config mutation)
- S5.7-D is **CLOSED / ACCEPTED** (live path normalization matrix: 8 GET requests, all HTTP 404, audit delta 1 <= 8, only canonical D01 generated DENIED row, D02–D08 generated 0 audit rows, no traversal to internal endpoints, GATEWAY_RAW_RECEIPT=NOT_PROVEN, client percent-hex case canonicalization documented for D03/D04/D07/D08, zero config mutation)
- S5.7-E is **NEXT** (URL / query / redirect safety; Class 0 redirect check; not started)
- Main reconciled to `origin/main` (`c448dfb914d2480f81fbc35abfbc8e5633dd3a38` via normal merge `17b1165a295a24a66ee04330ece81aead6c788fc`)
- Temporary S5.7-C and S5.7-D audit authorizations **REVOKED**: `TEST_AUDIT_SIDE_EFFECT_ALLOWED=NO`, `LIVE_CLASS1_SECURITY_PROBES_ALLOWED=NO`
- `PRODUCTION_CONFIGURATION_MUTATION_ALLOWED=NO`
- `TEST_INDUCED_APPLICATION_SIDE_EFFECT_ALLOWED=NO`
- `POST_LIVE_PROBE_DEFAULT=PROHIBITED`
- `CONNECT=STRICTLY_PROHIBITED`
- `G5=APPROVED`
- `G6=OPEN`
- `FINAL_S5_7_RECEIPT_COUNT=0`
- PR #130 remains **DRAFT**

**Next Gate:** `S5.7-E URL / QUERY / REDIRECT SAFETY`.
