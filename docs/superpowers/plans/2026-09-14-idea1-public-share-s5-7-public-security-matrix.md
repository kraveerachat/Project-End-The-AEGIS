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
   - Reviewed `origin/main` advancement 4: `509723680207b6fb8cbbe409d19ac7ad7dd9cc8a` (IDEA3 PR #132 repository-only preparation (source/tests/container artifacts/docs within IDEA3 scope), zero IDEA1/Gateway runtime overlap, no Production mutation)
   - Normal merge commit: `2bcafca30736ab685339da0bd4ff9e3a239108ff`
   - Status: `MAIN_RECONCILED=YES` (all four reconciliations verified cleanly, zero conflicts).

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
- **Class 0 Scope**: Class 0 only. Bounded non-share HTTP -> HTTPS 308 redirect and query evaluation. No Class 1 `/s/<synthetic-id>` share-redemption request was authorized or executed. `METHOD=GET_ONLY`, `REDIRECT_FOLLOWING=NO`, `TEST_AUDIT_SIDE_EFFECT_ALLOWED=NO`, `LIVE_CLASS1_SECURITY_PROBES_ALLOWED=NO`.

- [x] Test same-host HTTP -> HTTPS 308 redirect with inert query parameters on non-share path (`?url=https%3A%2F%2Funapproved.example.invalid`, `?ip=172.31.240.2`) — **PASS** (both E01 and E02 returned HTTP `308`, CURL_EXIT 0, `Server: cloudflare`, CF-RAY present).
- [x] Evaluate `Location.scheme`, `Location.authority`, `Location.host`. Verify authority remains strictly `share.aegistk-pb.com` and no open redirect or private origin disclosure occurs — **PASS** (both Location headers strictly targeted `https://share.aegistk-pb.com/...`; no redirect to `unapproved.example.invalid` or `172.31.240.2`; query preservation inside Location is expected and is not an open redirect; private IP appearing only as the supplied query value is not private-origin disclosure).
- [x] Verify query data does not alter authorization or reflect unescaped payloads — **PASS** (body did not reflect unescaped input; zero unexpected leaks detected; no share-redemption path exercised).
- [x] Record structured 14-field metadata per row — **PASS** (E01 client target UNPROVEN / normalization UNKNOWN due to trace parser limitation; E02 exact client target `/redirect-safety-probe?ip=172.31.240.2`, normalization NONE; redirect generation layer recorded as `REDIRECT_GENERATION_LAYER=NOT_UNIQUELY_ATTRIBUTED`).

#### Accepted S5.7-E Evidence Summary (Verified by Human Owner 2026-09-14):
- **Execution Window**: UTC `2026-09-14T21:08:00Z` through `2026-09-14T21:08:01Z`.
- **Scope & Budget**: Exactly 2 Class-0 GET requests against non-share path `/redirect-safety-probe` (`S5_7_E_CLASS0_BATCH=COMPLETE`).
- **Probes & Results (E01–E02)**:
  - **E01**:
    - `RAW_TARGET=/redirect-safety-probe?url=https%3A%2F%2Funapproved.example.invalid`
    - `CLIENT_SENT_TARGET=UNPROVEN`
    - `CLIENT_NORMALIZATION=UNKNOWN` *(Trace parser failed to capture the request-line target; absence of proof is not proof of normalization, so script-produced `PATH_NORMALIZED` is corrected to `UNKNOWN`)*.
    - HTTP `308`, `CURL_EXIT=0`, `Server: cloudflare`, `CF-RAY` present.
    - `Location: https://share.aegistk-pb.com/redirect-safety-probe?url=https%3A%2F%2Funapproved.example.invalid`
    - `LOCATION_SCHEME_OK=True` (HTTPS), `LOCATION_HOST_OK=True` (`share.aegistk-pb.com`), `LOCATION_PORT_OK=True`, `LOCATION_PATH_OK=True`, `LOCATION_QUERY_SEMANTICS_OK=True`.
    - `BODY_REFLECTS_UNESCAPED_INPUT=False`, `UNEXPECTED_LEAK=False`.
  - **E02**:
    - `RAW_TARGET=/redirect-safety-probe?ip=172.31.240.2`
    - `CLIENT_SENT_TARGET=/redirect-safety-probe?ip=172.31.240.2`
    - `CLIENT_NORMALIZATION=NONE`
    - HTTP `308`, `CURL_EXIT=0`, `Server: cloudflare`, `CF-RAY` present.
    - `Location: https://share.aegistk-pb.com/redirect-safety-probe?ip=172.31.240.2`
    - `LOCATION_SCHEME_OK=True` (HTTPS), `LOCATION_HOST_OK=True` (`share.aegistk-pb.com`), `LOCATION_PORT_OK=True`, `LOCATION_PATH_OK=True`, `LOCATION_QUERY_SEMANTICS_OK=True`.
    - `BODY_REFLECTS_UNESCAPED_INPUT=False`, `UNEXPECTED_LEAK=False`.
- **Attribution & Metadata**:
  - `OBSERVED_LAYER=Cloudflare Edge`, `ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY`.
  - `REDIRECT_GENERATION_LAYER=NOT_UNIQUELY_ATTRIBUTED` *(Cloudflare edge traversal proven, but exact component generating the redirect is not uniquely attributed)*.
  - `APPLICATION_SIDE_EFFECT_EXPECTED=NO`, `APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED`.
  - `SNI=NOT_APPLICABLE(PLAINTEXT_HTTP_REQUEST)`, `REDIRECT_FOLLOWED=NO`, `CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN`.
- **Accepted Security Interpretation**:
  - Both requests returned HTTP 308 to approved HTTPS authority `share.aegistk-pb.com`.
  - No open redirect; no redirect to `unapproved.example.invalid` or `172.31.240.2`.
  - User-supplied URL and private-IP-looking query values remained inert query data preserved in Location.
  - Private IP in query parameter is not private-origin disclosure.
  - No unescaped reflection in body; no unexpected leak in headers/body.
  - No redirect followed; zero Production/Cloudflare/DNS/TLS mutation.
  - Zero audit side effects; no Class 1 share-redemption path exercised.
- **Outcome**: S5.7-E is **CLOSED / ACCEPTED / PASS**.

### Task 6 — S5.7-F: Information leakage / response hygiene

**Boundary:** Read-only inspection of response headers and bounded bodies gathered in B–E. Zero new network requests.

- [x] Check for private IP CIDRs (`172.31.*`, `172.18.*`, `192.168.*`, `10.*`), database errors, stack traces, internal paths, container names (`aegis-prod-*`), `X-Powered-By` — **PASS** (zero leaks detected across 47 accepted requests in B [20 reqs], C [17 reqs], D [8 reqs], and E [2 reqs]).
- [x] Confirm `Server: cloudflare` is treated as expected edge metadata, not origin leak — **PASS** (`Server: cloudflare` and `CF-RAY` present across B–E confirmed as expected edge traversal metadata, not internal/origin disclosures).
- [x] Redact any sensitive material locally; never commit secrets to Git or Obsidian — **PASS** (zero secrets, bearer tokens, or user credentials present in test traces or docs; user-supplied query in E02 preserved as inert data).
- [x] Record structured metadata per row — **PASS** (14-field aggregate metadata model recorded for F review, explicitly referencing B–E provenance with `NOT_APPLICABLE` semantics for aggregate fields).

#### Accepted S5.7-F Evidence Summary (Reviewed 2026-09-15):
- **Evidence Provenance & Scope**: Read-only inspection and consolidation of response headers and bounded bodies already gathered and accepted across S5.7-B (20 requests), S5.7-C (17 requests), S5.7-D (8 requests), and S5.7-E (2 requests) — total 47 live HTTP requests.
- **New Live Requests**: Exactly `0` (`NEW_LIVE_REQUESTS=0`). No new network activity, no probe reruns, no Production access, no database access.
- **Leakage Class Review**:
  1. *Private IP / origin disclosure*: `NO LEAK DETECTED` across all 47 requests. Special case E02: query parameter `ip=172.31.240.2` preserved in Location header is expected inert user data, not private-origin disclosure (scanner intentionally excluded Location query preservation).
  2. *Database / SQL errors*: `NO LEAK DETECTED` (no SQL syntax, schema details, or error codes).
  3. *Stack traces / exceptions*: `NO LEAK DETECTED` (no language/runtime stack traces or unhandled exception messages).
  4. *Internal file paths*: `NO LEAK DETECTED` (no `/opt/aegis`, `node_modules`, or host file path disclosures).
  5. *Container / internal service names*: `NO LEAK DETECTED` (no `aegis-prod-*`, `aegis_drive`, or internal container names).
  6. *X-Powered-By / framework disclosure*: `NO LEAK DETECTED` (`X-Powered-By` absent on all responses).
  7. *Unsafe reflection*: `NO LEAK DETECTED` (`BODY_REFLECTS_UNESCAPED_INPUT=False` on all inspected bodies).
  8. *Redirect Location handling*: Preserved approved HTTPS authority `https://share.aegistk-pb.com/...` exclusively on authorized redirect probes (E01, E02); absent on all other 45 requests; no open redirect.
  9. *Expected Cloudflare metadata*: `Server: cloudflare` and `CF-RAY` present on all 47 responses confirmed as expected edge metadata, not origin leaks.
- **Structured 14-Field Metadata (Aggregate Evidence Model)**:
  - `OBSERVED_LAYER=Cloudflare Edge / Bounded Evidence Consolidation`
  - `ATTRIBUTION_BASIS=Accepted S5.7-B through S5.7-E response headers and bodies`
  - `APPLICATION_SIDE_EFFECT_EXPECTED=NO`
  - `APPLICATION_SIDE_EFFECT_OBSERVED=NONE`
  - `VANTAGE_POINT=Local Evidence Consolidation (Evidence derived from External Windows client)`
  - `UTC_TIMESTAMP=UNKNOWN(AGGREGATE_REVIEW_EXACT_UTC_NOT_RETAINED)`
  - `PR_SHA=11dd451c7bcba5e70fb22173e7571b69bf803633`
  - `METHOD=NOT_APPLICABLE(AGGREGATE_EVIDENCE_INSPECTION)`
  - `RAW_TARGET=NOT_APPLICABLE(AGGREGATE_EVIDENCE_INSPECTION)`
  - `HOST_OR_AUTHORITY=share.aegistk-pb.com`
  - `SNI=NOT_APPLICABLE(AGGREGATE_EVIDENCE_INSPECTION)`
  - `REDIRECT_FOLLOWED=NOT_APPLICABLE(AGGREGATE_EVIDENCE_INSPECTION)`
  - `CLIENT_NORMALIZATION=NOT_APPLICABLE(AGGREGATE_EVIDENCE_INSPECTION)`
  - `CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(AGGREGATE_EVIDENCE_INSPECTION)`
- **Accepted Security Interpretation**:
  - *Scoped statement*: "No information leak was detected within the bounded leak classes and response evidence actually inspected in S5.7-B through S5.7-E."
  - Attribution limitations from B–E are fully preserved.
  - Zero secrets, tokens, or credentials copied into docs.
  - `RUNTIME_SOURCE_CHANGED=NO`, `GATEWAY_CHANGED=NO`, `PRODUCTION_MUTATION=NO`, `CLOUDFLARE_MUTATION=NO`.
- **Outcome**: S5.7-F is **CLOSED / ACCEPTED / PASS**.

### Task 7 — S5.7-G: Security matrix consolidation

**Boundary:** Documentation only. Strictly consolidates already accepted evidence from S5.7-A through S5.7-F. Zero new network requests.

- [x] Consolidate all rows under exact columns: `TEST | REQUEST | EXPECTED | ACTUAL | STATUS | EVIDENCE | SECURITY_BOUNDARY` — **PASS** (exactly 75 rows consolidated across A–F).
- [x] Ensure all 14 metadata fields are populated in every `EVIDENCE` entry, applying `NOT_APPLICABLE(<reason>)` semantics for non-HTTP evidence categories — **PASS** (all 75 rows verified; zero omitted or blank fields).
- [x] Ensure allowed statuses are strictly `PASS`, `FAIL`, `NOT TESTED` — **PASS** (74 PASS, 0 FAIL, 1 NOT TESTED).
- [x] If any attack class failed, ensure post-defect rerun policy was followed — **PASS** (`SECURITY_ATTACK_CLASS_FAILURES=0`; `POST_DEFECT_RERUN_POLICY=NOT_APPLICABLE(NO_SECURITY_ATTACK_CLASS_FAIL)`).

#### Accepted S5.7-G Matrix Summary Metrics:
- `MATRIX_ROW_COUNT=75`
- `MATRIX_PASS_COUNT=74`
- `MATRIX_FAIL_COUNT=0`
- `MATRIX_NOT_TESTED_COUNT=1`
- `ALL_ROWS_HAVE_14_METADATA_FIELDS=YES`
- `STATUS_VOCABULARY_VALID=YES`
- `ATTRIBUTION_BOUNDARIES_PRESERVED=YES`
- `SECURITY_ATTACK_CLASS_FAILURES=0`
- `POST_DEFECT_RERUN_POLICY=NOT_APPLICABLE(NO_SECURITY_ATTACK_CLASS_FAIL)`
- *Known NOT TESTED Limitation*: Row `A-UI-DIRECT-RUNTIME` remains `STATUS=NOT TESTED` under the secret-safe inspection boundary restriction; governance truth (G5 APPROVED, G6 OPEN, UI mutation prohibited) is retained.
- *Outcome*: S5.7-G is **CLOSED / ACCEPTED / PASS**.

#### Consolidated Public Security Matrix (75 Rows):

| TEST | REQUEST | EXPECTED | ACTUAL | STATUS | EVIDENCE | SECURITY_BOUNDARY |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| A01-REPO-PREFLIGHT | git status --short; git branch --show-current; git rev-parse HEAD | Clean working tree on feat/idea1-public-share-s5-7-public-security-matrix | Clean worktree, correct branch and commit verified | PASS | OBSERVED_LAYER=Host OS<br>ATTRIBUTION_BASIS=Git status and commit verification<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Host OS<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(CLI_COMMAND)<br>RAW_TARGET=NOT_APPLICABLE(CLI_COMMAND)<br>HOST_OR_AUTHORITY=NOT_APPLICABLE(CLI_COMMAND)<br>SNI=NOT_APPLICABLE(CLI_COMMAND)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(CLI_COMMAND)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(CLI_COMMAND)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(CLI_COMMAND) | Repository preflight proves local workspace clean baseline; does not test network or runtime state. |
| A02-CF-CONTROL-PLANE | Cloudflare API read-only query for zone and tunnel routes | Zone Active, tunnel AEGIS-PUBLIC-SHARE Healthy, 1 replica, 1 published route | Zone Active, Tunnel Healthy, 1 replica, 1 route to http://172.31.240.2:8080, 0 wildcards | PASS | OBSERVED_LAYER=Cloudflare Control Plane<br>ATTRIBUTION_BASIS=Cloudflare API read-only response<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Cloudflare Control Plane<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(CONTROL_PLANE_QUERY)<br>RAW_TARGET=NOT_APPLICABLE(CONTROL_PLANE_QUERY)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(CONTROL_PLANE_QUERY)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(CONTROL_PLANE_QUERY)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(CONTROL_PLANE_QUERY)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(CONTROL_PLANE_QUERY) | Cloudflare control plane proves configured route to edge ingress; does not prove origin gateway rejection behavior. |
| A03-PUBLIC-DNS | DoH queries (1.1.1.1, 8.8.8.8) for share.aegistk-pb.com (A, AAAA) | Cloudflare Anycast IPs only; zero private origin IP disclosure | Anycast A (104.21.40.88, 172.67.183.68) and AAAA records; no origin IP visible | PASS | OBSERVED_LAYER=Resolver<br>ATTRIBUTION_BASIS=DNS DoH responses from Cloudflare and Google<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Public Internet<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(DNS_QUERY)<br>RAW_TARGET=NOT_APPLICABLE(DNS_QUERY)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(DNS_QUERY)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(DNS_QUERY)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(DNS_QUERY)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(DNS_QUERY) | Proves DNS resolves to Cloudflare proxy; does not prove origin connectivity or gateway enforcement. |
| A04-PUBLIC-TLS | TLS handshake against share.aegistk-pb.com (TLS 1.0, 1.1, 1.2, 1.3) | TLS 1.0/1.1 rejected with alert; TLS 1.2/1.3 negotiated | TLS 1.0/1.1 rejected with protocol version alert; TLS 1.2/1.3 passed | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=TLS ClientHello handshake negotiation<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Public Internet<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(TLS_HANDSHAKE)<br>RAW_TARGET=NOT_APPLICABLE(TLS_HANDSHAKE)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(TLS_HANDSHAKE)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(TLS_HANDSHAKE)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(TLS_HANDSHAKE) | Cloudflare edge terminates public TLS; edge cipher/protocol configuration proven; origin TLS not exercised. |
| A05-HTTP-REDIRECT | GET http://share.aegistk-pb.com/ (redirect not followed) | HTTP 308 redirect to https://share.aegistk-pb.com/ | HTTP 308, Location: https://share.aegistk-pb.com/, Server: cloudflare | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=HTTP response code 308 and Location header<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Public Internet<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=GET<br>RAW_TARGET=/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(PLAINTEXT_HTTP_REQUEST)<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Edge HTTP-to-HTTPS redirect enforced; origin gateway not contacted on plaintext port. |
| A06-SYSTEMD-SERVICES | systemctl is-active aegis-public-share-s5-5-firewall.service aegis-public-share-connector.service aegis-public-share-drift.timer | All 3 units active/enabled | All 3 units active and enabled (unit name procedure defect corrected) | PASS | OBSERVED_LAYER=Host OS<br>ATTRIBUTION_BASIS=systemctl status and is-active output<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Host OS<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(SYSTEMD_QUERY)<br>RAW_TARGET=NOT_APPLICABLE(SYSTEMD_QUERY)<br>HOST_OR_AUTHORITY=NOT_APPLICABLE(SYSTEMD_QUERY)<br>SNI=NOT_APPLICABLE(SYSTEMD_QUERY)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(SYSTEMD_QUERY)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(SYSTEMD_QUERY)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(SYSTEMD_QUERY) | Host service lifecycle supervision proven; does not prove traffic filtering correctness. |
| A07-FIREWALL-VALIDATE | sudo /opt/aegis/runtime/public-share/s5-5-firewall.sh validate | S5.5-FIREWALL=VALID | Returned S5.5-FIREWALL=VALID | PASS | OBSERVED_LAYER=Host OS<br>ATTRIBUTION_BASIS=nftables validation script exit code 0 and stdout<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Host OS<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(FIREWALL_VALIDATION)<br>RAW_TARGET=NOT_APPLICABLE(FIREWALL_VALIDATION)<br>HOST_OR_AUTHORITY=NOT_APPLICABLE(FIREWALL_VALIDATION)<br>SNI=NOT_APPLICABLE(FIREWALL_VALIDATION)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(FIREWALL_VALIDATION)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(FIREWALL_VALIDATION)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(FIREWALL_VALIDATION) | Proves nftables rules match S5.5 egress isolation specification; does not test Gateway application rules. |
| A08-CONTAINER-STATE | sudo docker ps --format "{{.Names}}	{{.Status}}" | All 7 protected containers running and healthy | All 7 running/healthy (connector running, gateway/drive/monitor/hub/postgres/twingate healthy) | PASS | OBSERVED_LAYER=Host OS<br>ATTRIBUTION_BASIS=Docker engine status inspection<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Host OS<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>RAW_TARGET=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>HOST_OR_AUTHORITY=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>SNI=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(CONTAINER_INSPECTION) | Container daemon state verified; does not prove network level isolation between containers. |
| A09-CONNECTOR-ISOLATION | docker inspect aegis-prod-public-share-connector-1 (security options) | PortBindings={}, User=65532:65532, ReadonlyRootfs=true, CapDrop=ALL, no-new-privileges=true | Confirmed PortBindings={}, User=65532:65532, ReadonlyRootfs=true, CapDrop=["ALL"], no-new-privileges:true | PASS | OBSERVED_LAYER=Host OS<br>ATTRIBUTION_BASIS=Docker container security option inspection<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Host OS<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>RAW_TARGET=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>HOST_OR_AUTHORITY=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>SNI=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(CONTAINER_INSPECTION) | Connector container privilege boundaries proven; egress kernel network policy proven in A07. |
| A10-GATEWAY-NO-HOST-PORT | docker inspect aegis-prod-public-share-gateway-1 (PortBindings) | PortBindings={} (no published host ports) | Confirmed PortBindings={} | PASS | OBSERVED_LAYER=Host OS<br>ATTRIBUTION_BASIS=Docker container port binding inspection<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Host OS<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>RAW_TARGET=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>HOST_OR_AUTHORITY=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>SNI=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(CONTAINER_INSPECTION)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(CONTAINER_INSPECTION) | Confirms Gateway is unreachable from host external interfaces; accessible only via dedicated internal Docker network. |
| A11-CONNECTOR-READY | docker exec aegis-prod-public-share-connector-1 cloudflared tunnel --metrics 127.0.0.1:20241 ready | EXIT 0 | Returned EXIT=0 | PASS | OBSERVED_LAYER=Host OS<br>ATTRIBUTION_BASIS=cloudflared internal readiness probe exit code<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Host OS<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(PROCESS_PROBE)<br>RAW_TARGET=NOT_APPLICABLE(PROCESS_PROBE)<br>HOST_OR_AUTHORITY=NOT_APPLICABLE(PROCESS_PROBE)<br>SNI=NOT_APPLICABLE(PROCESS_PROBE)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(PROCESS_PROBE)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(PROCESS_PROBE)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(PROCESS_PROBE) | Tunnel daemon connectivity to Cloudflare edge proven; does not test HTTP request routing. |
| A12-RELEASE-DIRECTORY | git rev-parse HEAD in /opt/aegis/releases/public-share/99a6f916f5b4aa20da2a1c2ee68e75162f7e23b7 | Commit 99a6f916f5b4aa20da2a1c2ee68e75162f7e23b7 | Exact match 99a6f916f5b4aa20da2a1c2ee68e75162f7e23b7 | PASS | OBSERVED_LAYER=Host OS<br>ATTRIBUTION_BASIS=Git commit verification in release path<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Host OS<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(CLI_COMMAND)<br>RAW_TARGET=NOT_APPLICABLE(CLI_COMMAND)<br>HOST_OR_AUTHORITY=NOT_APPLICABLE(CLI_COMMAND)<br>SNI=NOT_APPLICABLE(CLI_COMMAND)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(CLI_COMMAND)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(CLI_COMMAND)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(CLI_COMMAND) | Release provenance verified to S5.5 merge commit; does not test runtime divergence without daemon checks. |
| A-UI-DIRECT-RUNTIME | Direct runtime container environment inspection of PUBLIC_SHARE_UI_ENABLED | Fresh direct runtime proof of UI disabled state | Inspection waived under secret-safe boundary; governance truth retained (G5 APPROVED, G6 OPEN, UI mutation prohibited) | NOT TESTED | OBSERVED_LAYER=Host OS<br>ATTRIBUTION_BASIS=Secret-safe inspection boundary restriction<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Host OS<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=2504b04c8f04fbf561301fb8475c120271a329f6<br>METHOD=NOT_APPLICABLE(GOVERNANCE_CHECK)<br>RAW_TARGET=NOT_APPLICABLE(GOVERNANCE_CHECK)<br>HOST_OR_AUTHORITY=NOT_APPLICABLE(GOVERNANCE_CHECK)<br>SNI=NOT_APPLICABLE(GOVERNANCE_CHECK)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(GOVERNANCE_CHECK)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(GOVERNANCE_CHECK)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(GOVERNANCE_CHECK) | Fresh direct container runtime inspection NOT TESTED under secret-safe inspection boundary; governance policy enforces UI OFF; UI remains disabled. |
| P01-LOCAL-GATEWAY-TRACE | TRACE /s/invalid-token-probe in publicShareGatewayRuntime.test.js | HTTP 405 Method Not Allowed; upstream contact = 0 | HTTP 405; ZERO_UPSTREAM_CONTACT_ASSERTED=YES (PS3-RUNTIME-5) | PASS | OBSERVED_LAYER=Public Share Gateway<br>ATTRIBUTION_BASIS=Isolated local node:http Gateway runtime harness<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Test Harness<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=7f628fb16f51a718fe7ef3d0a2f584d44ef3e932<br>METHOD=TRACE<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(LOCAL_HTTP_HARNESS)<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(DIRECT_GATEWAY_HARNESS) | Gateway isolated runtime fail-closed behavior proven; does not prove Cloudflare edge behavior. |
| P02-LOCAL-GATEWAY-DOUBLE-ENCODED | GET /s/%252e%252e%252fhealthz in publicShareGatewayRuntime.test.js | HTTP 404; upstream contact = 0 | HTTP 404; ZERO_UPSTREAM_CONTACT_ASSERTED=YES (PS3-RUNTIME-6) | PASS | OBSERVED_LAYER=Public Share Gateway<br>ATTRIBUTION_BASIS=Isolated local node:http Gateway runtime harness<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Test Harness<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=7f628fb16f51a718fe7ef3d0a2f584d44ef3e932<br>METHOD=GET<br>RAW_TARGET=/s/%252e%252e%252fhealthz<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(LOCAL_HTTP_HARNESS)<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(DIRECT_GATEWAY_HARNESS) | Gateway raw-request target handling proven with zero upstream contact; does not prove public edge receipt of double-encoded bytes. |
| P03-LOCAL-GATEWAY-ENCODED-SLASH | GET /s/%2finvalid-token-probe in publicShareGatewayRuntime.test.js | HTTP 404; upstream contact = 0 | HTTP 404; ZERO_UPSTREAM_CONTACT_ASSERTED=YES (PS3-RUNTIME-6) | PASS | OBSERVED_LAYER=Public Share Gateway<br>ATTRIBUTION_BASIS=Isolated local node:http Gateway runtime harness<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Test Harness<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=7f628fb16f51a718fe7ef3d0a2f584d44ef3e932<br>METHOD=GET<br>RAW_TARGET=/s/%2finvalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(LOCAL_HTTP_HARNESS)<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(DIRECT_GATEWAY_HARNESS) | Gateway raw-request target handling proven with zero upstream contact; does not prove public edge receipt of encoded slash. |
| P04-LOCAL-GATEWAY-ENCODED-BACKSLASH | GET /s/%5cinvalid-token-probe in publicShareGatewayRuntime.test.js | HTTP 404; upstream contact = 0 | HTTP 404; ZERO_UPSTREAM_CONTACT_ASSERTED=YES (PS3-RUNTIME-6) | PASS | OBSERVED_LAYER=Public Share Gateway<br>ATTRIBUTION_BASIS=Isolated local node:http Gateway runtime harness<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Test Harness<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=7f628fb16f51a718fe7ef3d0a2f584d44ef3e932<br>METHOD=GET<br>RAW_TARGET=/s/%5cinvalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(LOCAL_HTTP_HARNESS)<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(DIRECT_GATEWAY_HARNESS) | Gateway raw-request target handling proven with zero upstream contact; does not prove public edge receipt of encoded backslash. |
| P05-LOCAL-GATEWAY-DUPLICATE-SLASH | GET /s//invalid-token-probe in publicShareGatewayRuntime.test.js | HTTP 404; upstream contact = 0 | HTTP 404; ZERO_UPSTREAM_CONTACT_ASSERTED=YES (PS3-RUNTIME-6) | PASS | OBSERVED_LAYER=Public Share Gateway<br>ATTRIBUTION_BASIS=Isolated local node:http Gateway runtime harness<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Test Harness<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=7f628fb16f51a718fe7ef3d0a2f584d44ef3e932<br>METHOD=GET<br>RAW_TARGET=/s//invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(LOCAL_HTTP_HARNESS)<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(DIRECT_GATEWAY_HARNESS) | Gateway raw-request target handling proven with zero upstream contact; does not prove public edge receipt of duplicate slash. |
| P06-LOCAL-FULL-REGRESSION | npm test in IDEA1-AEGIS_Drive_LC/ | Full regression bar completed; NEW_FAILURES=0; accepted historical failures unchanged | 1309 total, 1228 pass, 9 fail, 72 skip; NEW_FAILURES=0; accepted historical failures unchanged | PASS | OBSERVED_LAYER=Drive Application<br>ATTRIBUTION_BASIS=npm test suite exit summary<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Test Harness<br>UTC_TIMESTAMP=UNKNOWN(EXACT_UTC_NOT_RETAINED)<br>PR_SHA=7f628fb16f51a718fe7ef3d0a2f584d44ef3e932<br>METHOD=NOT_APPLICABLE(NPM_TEST_RUN)<br>RAW_TARGET=NOT_APPLICABLE(NPM_TEST_RUN)<br>HOST_OR_AUTHORITY=NOT_APPLICABLE(NPM_TEST_RUN)<br>SNI=NOT_APPLICABLE(NPM_TEST_RUN)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(NPM_TEST_RUN)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(NPM_TEST_RUN)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(NPM_TEST_RUN) | Application-layer regression suite completed with zero new failures; non-canonical --test-force-exit incident isolated as runner artifact. |
| B01-SURFACE-GET-_ | GET / | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=GET<br>RAW_TARGET=/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B02-SURFACE-HEAD-_ | HEAD / | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=HEAD<br>RAW_TARGET=/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B03-SURFACE-GET-_drive_ | GET /drive/ | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=GET<br>RAW_TARGET=/drive/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B04-SURFACE-HEAD-_drive_ | HEAD /drive/ | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=HEAD<br>RAW_TARGET=/drive/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B05-SURFACE-GET-_api_ | GET /api/ | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=GET<br>RAW_TARGET=/api/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B06-SURFACE-HEAD-_api_ | HEAD /api/ | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=HEAD<br>RAW_TARGET=/api/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B07-SURFACE-GET-_api_audit | GET /api/audit | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=GET<br>RAW_TARGET=/api/audit<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B08-SURFACE-HEAD-_api_audit | HEAD /api/audit | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=HEAD<br>RAW_TARGET=/api/audit<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B09-SURFACE-GET-_healthz | GET /healthz | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=GET<br>RAW_TARGET=/healthz<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B10-SURFACE-HEAD-_healthz | HEAD /healthz | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=HEAD<br>RAW_TARGET=/healthz<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B11-SURFACE-GET-_admin | GET /admin | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=GET<br>RAW_TARGET=/admin<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B12-SURFACE-HEAD-_admin | HEAD /admin | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=HEAD<br>RAW_TARGET=/admin<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B13-SURFACE-GET-_settings | GET /settings | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=GET<br>RAW_TARGET=/settings<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B14-SURFACE-HEAD-_settings | HEAD /settings | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=HEAD<br>RAW_TARGET=/settings<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B15-SURFACE-GET-_login | GET /login | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=GET<br>RAW_TARGET=/login<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B16-SURFACE-HEAD-_login | HEAD /login | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=HEAD<br>RAW_TARGET=/login<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B17-SURFACE-GET-_monitor_ | GET /monitor/ | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=GET<br>RAW_TARGET=/monitor/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B18-SURFACE-HEAD-_monitor_ | HEAD /monitor/ | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=HEAD<br>RAW_TARGET=/monitor/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B19-SURFACE-GET-_internal_ | GET /internal/ | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=GET<br>RAW_TARGET=/internal/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| B20-SURFACE-HEAD-_internal_ | HEAD /internal/ | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=UNCHECKED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T14:51:56Z-14:51:59Z)<br>PR_SHA=a5ff07b0a12d139c0b544fe5392439dffcbc4ac3<br>METHOD=HEAD<br>RAW_TARGET=/internal/<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare edge traversal proven; exact Gateway rejection attribution NOT TESTED unless separately evidenced. |
| C01-METHOD-HOST-DEFAULT_HOST | GET /s/invalid-token-probe | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; consistent with confirmed DENIED audit row | PASS | OBSERVED_LAYER=Drive Application<br>ATTRIBUTION_BASIS=HTTP response + Drive audit log DENIED row<br>APPLICATION_SIDE_EFFECT_EXPECTED=YES<br>APPLICATION_SIDE_EFFECT_OBSERVED=AUDIT_ROW_CONFIRMED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Drive application reached generating DENIED audit row; proves Gateway permitted redemption target through to Drive; spoof source IP not persisted. |
| C02-METHOD-HOST-HEAD_METHOD | HEAD /s/invalid-token-probe | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=HEAD<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare or Gateway fail-closed rejection observed; zero SHARE_REDEEM audit rows generated; exact rejection layer not uniquely attributed. |
| C03-METHOD-HOST-PUT_METHOD | PUT /s/invalid-token-probe | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=PUT<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare or Gateway fail-closed rejection observed; zero SHARE_REDEEM audit rows generated; exact rejection layer not uniquely attributed. |
| C04-METHOD-HOST-PATCH_METHOD | PATCH /s/invalid-token-probe | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=PATCH<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare or Gateway fail-closed rejection observed; zero SHARE_REDEEM audit rows generated; exact rejection layer not uniquely attributed. |
| C05-METHOD-HOST-DELETE_METHOD | DELETE /s/invalid-token-probe | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=DELETE<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare or Gateway fail-closed rejection observed; zero SHARE_REDEEM audit rows generated; exact rejection layer not uniquely attributed. |
| C06-METHOD-HOST-OPTIONS_METHOD | OPTIONS /s/invalid-token-probe | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=OPTIONS<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare or Gateway fail-closed rejection observed; zero SHARE_REDEEM audit rows generated; exact rejection layer not uniquely attributed. |
| C07-METHOD-HOST-TRACE_METHOD | TRACE /s/invalid-token-probe | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 405, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=TRACE<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare or Gateway fail-closed rejection observed; zero SHARE_REDEEM audit rows generated; exact rejection layer not uniquely attributed. |
| C08-METHOD-HOST-HOST_WITH_PORT_443 | GET /s/invalid-token-probe (Host: share.aegistk-pb.com:443) | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; consistent with confirmed DENIED audit row | PASS | OBSERVED_LAYER=Drive Application<br>ATTRIBUTION_BASIS=HTTP response + Drive audit log DENIED row<br>APPLICATION_SIDE_EFFECT_EXPECTED=YES<br>APPLICATION_SIDE_EFFECT_OBSERVED=AUDIT_ROW_CONFIRMED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com:443<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Drive application reached generating DENIED audit row; proves Gateway permitted redemption target through to Drive; spoof source IP not persisted. |
| C09-METHOD-HOST-UPPERCASE_HOST | GET /s/invalid-token-probe (Host: SHARE.AEGISTK-PB.COM) | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; consistent with confirmed DENIED audit row | PASS | OBSERVED_LAYER=Drive Application<br>ATTRIBUTION_BASIS=HTTP response + Drive audit log DENIED row<br>APPLICATION_SIDE_EFFECT_EXPECTED=YES<br>APPLICATION_SIDE_EFFECT_OBSERVED=AUDIT_ROW_CONFIRMED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=SHARE.AEGISTK-PB.COM<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Drive application reached generating DENIED audit row; proves Gateway permitted redemption target through to Drive; spoof source IP not persisted. |
| C10-METHOD-HOST-UNAPPROVED_HOST | GET /s/invalid-token-probe (Host: unapproved-host.example.invalid) | HTTP 403, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 403, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=unapproved-host.example.invalid<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare or Gateway fail-closed rejection observed; zero SHARE_REDEEM audit rows generated; exact rejection layer not uniquely attributed. |
| C11-METHOD-HOST-IP_HOST_HEADER | GET /s/invalid-token-probe (Host: 172.31.240.2) | HTTP 403, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 403, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=172.31.240.2<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare or Gateway fail-closed rejection observed; zero SHARE_REDEEM audit rows generated; exact rejection layer not uniquely attributed. |
| C12-METHOD-HOST-FORWARDED_SPOOF | GET /s/invalid-token-probe (Forwarded: for=198.51.100.77;proto=http;host=unapproved-host.example.invalid) | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; consistent with confirmed DENIED audit row | PASS | OBSERVED_LAYER=Drive Application<br>ATTRIBUTION_BASIS=HTTP response + Drive audit log DENIED row<br>APPLICATION_SIDE_EFFECT_EXPECTED=YES<br>APPLICATION_SIDE_EFFECT_OBSERVED=AUDIT_ROW_CONFIRMED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Drive application reached generating DENIED audit row; proves Gateway permitted redemption target through to Drive; spoof source IP not persisted. |
| C13-METHOD-HOST-X_FORWARDED_FOR_SPOOF | GET /s/invalid-token-probe (X-Forwarded-For: 198.51.100.77) | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; consistent with confirmed DENIED audit row | PASS | OBSERVED_LAYER=Drive Application<br>ATTRIBUTION_BASIS=HTTP response + Drive audit log DENIED row<br>APPLICATION_SIDE_EFFECT_EXPECTED=YES<br>APPLICATION_SIDE_EFFECT_OBSERVED=AUDIT_ROW_CONFIRMED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Drive application reached generating DENIED audit row; proves Gateway permitted redemption target through to Drive; spoof source IP not persisted. |
| C14-METHOD-HOST-X_FORWARDED_HOST_SPOOF | GET /s/invalid-token-probe (X-Forwarded-Host: unapproved-host.example.invalid) | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; consistent with confirmed DENIED audit row | PASS | OBSERVED_LAYER=Drive Application<br>ATTRIBUTION_BASIS=HTTP response + Drive audit log DENIED row<br>APPLICATION_SIDE_EFFECT_EXPECTED=YES<br>APPLICATION_SIDE_EFFECT_OBSERVED=AUDIT_ROW_CONFIRMED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Drive application reached generating DENIED audit row; proves Gateway permitted redemption target through to Drive; spoof source IP not persisted. |
| C15-METHOD-HOST-X_FORWARDED_PROTO_SPOOF | GET /s/invalid-token-probe (X-Forwarded-Proto: http) | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; consistent with confirmed DENIED audit row | PASS | OBSERVED_LAYER=Drive Application<br>ATTRIBUTION_BASIS=HTTP response + Drive audit log DENIED row<br>APPLICATION_SIDE_EFFECT_EXPECTED=YES<br>APPLICATION_SIDE_EFFECT_OBSERVED=AUDIT_ROW_CONFIRMED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Drive application reached generating DENIED audit row; proves Gateway permitted redemption target through to Drive; spoof source IP not persisted. |
| C16-METHOD-HOST-X_REAL_IP_SPOOF | GET /s/invalid-token-probe (X-Real-IP: 198.51.100.77) | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; consistent with confirmed DENIED audit row | PASS | OBSERVED_LAYER=Drive Application<br>ATTRIBUTION_BASIS=HTTP response + Drive audit log DENIED row<br>APPLICATION_SIDE_EFFECT_EXPECTED=YES<br>APPLICATION_SIDE_EFFECT_OBSERVED=AUDIT_ROW_CONFIRMED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Drive application reached generating DENIED audit row; proves Gateway permitted redemption target through to Drive; spoof source IP not persisted. |
| C17-METHOD-HOST-CF_CONNECTING_IP_SPOOF | GET /s/invalid-token-probe (CF-Connecting-IP: 198.51.100.77) | HTTP 403, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 403, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:24:46Z-20:24:54Z)<br>PR_SHA=17b1165a295a24a66ee04330ece81aead6c788fc<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Cloudflare or Gateway fail-closed rejection observed; zero SHARE_REDEEM audit rows generated; exact rejection layer not uniquely attributed. |
| D01-PATH-NORMALIZATION | GET /s/invalid-token-probe | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; audit row 856 DENIED | PASS | OBSERVED_LAYER=Drive Application<br>ATTRIBUTION_BASIS=HTTP response + Drive audit row 856<br>APPLICATION_SIDE_EFFECT_EXPECTED=YES<br>APPLICATION_SIDE_EFFECT_OBSERVED=AUDIT_ROW_CONFIRMED<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:53:14Z-20:53:19Z)<br>PR_SHA=58f31190ea0e03714c3fa83f0e918e0d589ab482<br>METHOD=GET<br>RAW_TARGET=/s/invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Canonical token reaches Drive generating DENIED audit row; proves Gateway allows share redemption route to Drive. |
| D02-PATH-NORMALIZATION | GET /s/../healthz | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:53:14Z-20:53:19Z)<br>PR_SHA=58f31190ea0e03714c3fa83f0e918e0d589ab482<br>METHOD=GET<br>RAW_TARGET=/s/../healthz<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | External fail-closed HTTP 404 observed with zero audit rows; Gateway raw receipt NOT PROVEN; local Gateway harness provides raw-path evidence. |
| D03-PATH-NORMALIZATION | GET /s/%2e%2e/healthz | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:53:14Z-20:53:19Z)<br>PR_SHA=58f31190ea0e03714c3fa83f0e918e0d589ab482<br>METHOD=GET<br>RAW_TARGET=/s/%2e%2e/healthz<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | External fail-closed HTTP 404 observed with zero audit rows; Gateway raw receipt NOT PROVEN; local Gateway harness provides raw-path evidence. |
| D04-PATH-NORMALIZATION | GET /s/%2e%2e%2fhealthz | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:53:14Z-20:53:19Z)<br>PR_SHA=58f31190ea0e03714c3fa83f0e918e0d589ab482<br>METHOD=GET<br>RAW_TARGET=/s/%2e%2e%2fhealthz<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | External fail-closed HTTP 404 observed with zero audit rows; Gateway raw receipt NOT PROVEN; local Gateway harness provides raw-path evidence. |
| D05-PATH-NORMALIZATION | GET /s/%252e%252e%252fhealthz | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:53:14Z-20:53:19Z)<br>PR_SHA=58f31190ea0e03714c3fa83f0e918e0d589ab482<br>METHOD=GET<br>RAW_TARGET=/s/%252e%252e%252fhealthz<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | External fail-closed HTTP 404 observed with zero audit rows; Gateway raw receipt NOT PROVEN; local Gateway harness provides raw-path evidence. |
| D06-PATH-NORMALIZATION | GET /s//invalid-token-probe | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:53:14Z-20:53:19Z)<br>PR_SHA=58f31190ea0e03714c3fa83f0e918e0d589ab482<br>METHOD=GET<br>RAW_TARGET=/s//invalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | External fail-closed HTTP 404 observed with zero audit rows; Gateway raw receipt NOT PROVEN; local Gateway harness provides raw-path evidence. |
| D07-PATH-NORMALIZATION | GET /s/%2finvalid-token-probe | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:53:14Z-20:53:19Z)<br>PR_SHA=58f31190ea0e03714c3fa83f0e918e0d589ab482<br>METHOD=GET<br>RAW_TARGET=/s/%2finvalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | External fail-closed HTTP 404 observed with zero audit rows; Gateway raw receipt NOT PROVEN; local Gateway harness provides raw-path evidence. |
| D08-PATH-NORMALIZATION | GET /s/%5cinvalid-token-probe | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare | HTTP 404, CURL_EXIT 0, zero leaks, Server: cloudflare, CF-RAY present; 0 audit rows | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=UNKNOWN(BATCH_WINDOW:2026-09-14T20:53:14Z-20:53:19Z)<br>PR_SHA=58f31190ea0e03714c3fa83f0e918e0d589ab482<br>METHOD=GET<br>RAW_TARGET=/s/%5cinvalid-token-probe<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=share.aegistk-pb.com<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=PERCENT_HEX_CASE_CANONICALIZED<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | External fail-closed HTTP 404 observed with zero audit rows; Gateway raw receipt NOT PROVEN; local Gateway harness provides raw-path evidence. |
| E01-REDIRECT-UNAPPROVED-URL-QUERY | GET /redirect-safety-probe?url=https%3A%2F%2Funapproved.example.invalid (HTTP port 80) | HTTP 308 redirect preserving approved HTTPS authority; no open redirect | HTTP 308, Location: https://share.aegistk-pb.com/redirect-safety-probe?url=..., CURL_EXIT 0, no open redirect | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=2026-09-14T21:08:00Z<br>PR_SHA=4f9087c03635b18f18d0533c6db38b8116bea421<br>METHOD=GET<br>RAW_TARGET=/redirect-safety-probe?url=https%3A%2F%2Funapproved.example.invalid<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(PLAINTEXT_HTTP_REQUEST)<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=UNKNOWN(TRACE_PARSER_LIMITATION)<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Approved same-host HTTP->HTTPS 308 redirect observed; query parameter preserved as inert data; redirect generation layer NOT_UNIQUELY_ATTRIBUTED; no open redirect. |
| E02-REDIRECT-PRIVATE-IP-QUERY | GET /redirect-safety-probe?ip=172.31.240.2 (HTTP port 80) | HTTP 308 redirect preserving approved HTTPS authority; query preserved as inert data | HTTP 308, Location: https://share.aegistk-pb.com/redirect-safety-probe?ip=172.31.240.2, CURL_EXIT 0, no private origin disclosure | PASS | OBSERVED_LAYER=Cloudflare Edge<br>ATTRIBUTION_BASIS=Server_cloudflare+CF-RAY<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=External Windows client<br>UTC_TIMESTAMP=2026-09-14T21:08:01Z<br>PR_SHA=4f9087c03635b18f18d0533c6db38b8116bea421<br>METHOD=GET<br>RAW_TARGET=/redirect-safety-probe?ip=172.31.240.2<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(PLAINTEXT_HTTP_REQUEST)<br>REDIRECT_FOLLOWED=NO<br>CLIENT_NORMALIZATION=NONE<br>CLOUDFLARE_NORMALIZATION_KNOWN=UNKNOWN | Approved same-host HTTP->HTTPS 308 redirect observed; user query IP is inert parameter data, not private-origin disclosure; redirect generation layer NOT_UNIQUELY_ATTRIBUTED. |
| F01-PRIVATE-IP-LEAK | Review of accepted evidence across B-E responses for PRIVATE-IP-LEAK | Zero information leakage in defined class | NO LEAK DETECTED (E02 query IP is user-supplied inert query parameter data) | PASS | OBSERVED_LAYER=Cloudflare Edge / Bounded Evidence Consolidation<br>ATTRIBUTION_BASIS=Accepted S5.7-B through S5.7-E response headers and bodies<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Evidence Consolidation (Evidence derived from External Windows client)<br>UTC_TIMESTAMP=UNKNOWN(AGGREGATE_REVIEW_EXACT_UTC_NOT_RETAINED)<br>PR_SHA=11dd451c7bcba5e70fb22173e7571b69bf803633<br>METHOD=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>RAW_TARGET=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW) | No information leak was detected within the bounded leak classes and response evidence actually inspected in S5.7-B through S5.7-E; does not constitute a universal security guarantee. |
| F02-DATABASE-ERROR-LEAK | Review of accepted evidence across B-E responses for DATABASE-ERROR-LEAK | Zero information leakage in defined class | NO LEAK DETECTED (no SQL syntax, schema details, or DB error codes) | PASS | OBSERVED_LAYER=Cloudflare Edge / Bounded Evidence Consolidation<br>ATTRIBUTION_BASIS=Accepted S5.7-B through S5.7-E response headers and bodies<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Evidence Consolidation (Evidence derived from External Windows client)<br>UTC_TIMESTAMP=UNKNOWN(AGGREGATE_REVIEW_EXACT_UTC_NOT_RETAINED)<br>PR_SHA=11dd451c7bcba5e70fb22173e7571b69bf803633<br>METHOD=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>RAW_TARGET=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW) | No information leak was detected within the bounded leak classes and response evidence actually inspected in S5.7-B through S5.7-E; does not constitute a universal security guarantee. |
| F03-STACK-TRACE-LEAK | Review of accepted evidence across B-E responses for STACK-TRACE-LEAK | Zero information leakage in defined class | NO LEAK DETECTED (no runtime traces or unhandled exception patterns) | PASS | OBSERVED_LAYER=Cloudflare Edge / Bounded Evidence Consolidation<br>ATTRIBUTION_BASIS=Accepted S5.7-B through S5.7-E response headers and bodies<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Evidence Consolidation (Evidence derived from External Windows client)<br>UTC_TIMESTAMP=UNKNOWN(AGGREGATE_REVIEW_EXACT_UTC_NOT_RETAINED)<br>PR_SHA=11dd451c7bcba5e70fb22173e7571b69bf803633<br>METHOD=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>RAW_TARGET=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW) | No information leak was detected within the bounded leak classes and response evidence actually inspected in S5.7-B through S5.7-E; does not constitute a universal security guarantee. |
| F04-INTERNAL-PATH-LEAK | Review of accepted evidence across B-E responses for INTERNAL-PATH-LEAK | Zero information leakage in defined class | NO LEAK DETECTED (no /opt/aegis, node_modules, or host paths disclosed) | PASS | OBSERVED_LAYER=Cloudflare Edge / Bounded Evidence Consolidation<br>ATTRIBUTION_BASIS=Accepted S5.7-B through S5.7-E response headers and bodies<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Evidence Consolidation (Evidence derived from External Windows client)<br>UTC_TIMESTAMP=UNKNOWN(AGGREGATE_REVIEW_EXACT_UTC_NOT_RETAINED)<br>PR_SHA=11dd451c7bcba5e70fb22173e7571b69bf803633<br>METHOD=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>RAW_TARGET=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW) | No information leak was detected within the bounded leak classes and response evidence actually inspected in S5.7-B through S5.7-E; does not constitute a universal security guarantee. |
| F05-CONTAINER-NAME-LEAK | Review of accepted evidence across B-E responses for CONTAINER-NAME-LEAK | Zero information leakage in defined class | NO LEAK DETECTED (no aegis-prod-*, aegis_drive, or container strings) | PASS | OBSERVED_LAYER=Cloudflare Edge / Bounded Evidence Consolidation<br>ATTRIBUTION_BASIS=Accepted S5.7-B through S5.7-E response headers and bodies<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Evidence Consolidation (Evidence derived from External Windows client)<br>UTC_TIMESTAMP=UNKNOWN(AGGREGATE_REVIEW_EXACT_UTC_NOT_RETAINED)<br>PR_SHA=11dd451c7bcba5e70fb22173e7571b69bf803633<br>METHOD=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>RAW_TARGET=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW) | No information leak was detected within the bounded leak classes and response evidence actually inspected in S5.7-B through S5.7-E; does not constitute a universal security guarantee. |
| F06-X-POWERED-BY-LEAK | Review of accepted evidence across B-E responses for X-POWERED-BY-LEAK | Zero information leakage in defined class | NO LEAK DETECTED (X-Powered-By header absent on all responses) | PASS | OBSERVED_LAYER=Cloudflare Edge / Bounded Evidence Consolidation<br>ATTRIBUTION_BASIS=Accepted S5.7-B through S5.7-E response headers and bodies<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Evidence Consolidation (Evidence derived from External Windows client)<br>UTC_TIMESTAMP=UNKNOWN(AGGREGATE_REVIEW_EXACT_UTC_NOT_RETAINED)<br>PR_SHA=11dd451c7bcba5e70fb22173e7571b69bf803633<br>METHOD=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>RAW_TARGET=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW) | No information leak was detected within the bounded leak classes and response evidence actually inspected in S5.7-B through S5.7-E; does not constitute a universal security guarantee. |
| F07-UNSAFE-REFLECTION | Review of accepted evidence across B-E responses for UNSAFE-REFLECTION | Zero information leakage in defined class | NO LEAK DETECTED (BODY_REFLECTS_UNESCAPED_INPUT=False across all inspected bodies) | PASS | OBSERVED_LAYER=Cloudflare Edge / Bounded Evidence Consolidation<br>ATTRIBUTION_BASIS=Accepted S5.7-B through S5.7-E response headers and bodies<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Evidence Consolidation (Evidence derived from External Windows client)<br>UTC_TIMESTAMP=UNKNOWN(AGGREGATE_REVIEW_EXACT_UTC_NOT_RETAINED)<br>PR_SHA=11dd451c7bcba5e70fb22173e7571b69bf803633<br>METHOD=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>RAW_TARGET=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW) | No information leak was detected within the bounded leak classes and response evidence actually inspected in S5.7-B through S5.7-E; does not constitute a universal security guarantee. |
| F08-REDIRECT-LOCATION-HYGIENE | Review of accepted evidence across B-E responses for REDIRECT-LOCATION-HYGIENE | Zero information leakage in defined class | PASS (Location present only on E01/E02 targeting approved authority; absent on 45 requests) | PASS | OBSERVED_LAYER=Cloudflare Edge / Bounded Evidence Consolidation<br>ATTRIBUTION_BASIS=Accepted S5.7-B through S5.7-E response headers and bodies<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Evidence Consolidation (Evidence derived from External Windows client)<br>UTC_TIMESTAMP=UNKNOWN(AGGREGATE_REVIEW_EXACT_UTC_NOT_RETAINED)<br>PR_SHA=11dd451c7bcba5e70fb22173e7571b69bf803633<br>METHOD=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>RAW_TARGET=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW) | No information leak was detected within the bounded leak classes and response evidence actually inspected in S5.7-B through S5.7-E; does not constitute a universal security guarantee. |
| F09-EXPECTED-EDGE-METADATA | Review of accepted evidence across B-E responses for EXPECTED-EDGE-METADATA | Zero information leakage in defined class | PASS (confirmed expected edge traversal metadata on all 47 responses, not origin leaks) | PASS | OBSERVED_LAYER=Cloudflare Edge / Bounded Evidence Consolidation<br>ATTRIBUTION_BASIS=Accepted S5.7-B through S5.7-E response headers and bodies<br>APPLICATION_SIDE_EFFECT_EXPECTED=NO<br>APPLICATION_SIDE_EFFECT_OBSERVED=NONE<br>VANTAGE_POINT=Local Evidence Consolidation (Evidence derived from External Windows client)<br>UTC_TIMESTAMP=UNKNOWN(AGGREGATE_REVIEW_EXACT_UTC_NOT_RETAINED)<br>PR_SHA=11dd451c7bcba5e70fb22173e7571b69bf803633<br>METHOD=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>RAW_TARGET=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>HOST_OR_AUTHORITY=share.aegistk-pb.com<br>SNI=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>REDIRECT_FOLLOWED=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLIENT_NORMALIZATION=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW)<br>CLOUDFLARE_NORMALIZATION_KNOWN=NOT_APPLICABLE(AGGREGATE_EVIDENCE_REVIEW) | No information leak was detected within the bounded leak classes and response evidence actually inspected in S5.7-B through S5.7-E; does not constitute a universal security guarantee. |


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

At this S5.7-G evidence timestamp provenance correction checkpoint:
- S5.7 is **IN PROGRESS**
- S5.7-A is **CLOSED / ACCEPTED** (preflight & runtime verified)
- S5.7-B is **CLOSED / ACCEPTED** (public surface default-deny verified across 10 paths, 20 requests, 404 on all, zero leaks)
- S5.7-C is **CLOSED / ACCEPTED** (live method/Host/header matrix: 17 requests, audit delta 8 <= 9, 8 new SHARE_REDEEM DENIED rows, spoof persistence 0, zero config mutation)
- S5.7-D is **CLOSED / ACCEPTED** (live path normalization matrix: 8 GET requests, all HTTP 404, audit delta 1 <= 8, only canonical D01 generated DENIED row, D02–D08 generated 0 audit rows, no traversal to internal endpoints, GATEWAY_RAW_RECEIPT=NOT_PROVEN, zero config mutation)
- S5.7-E is **CLOSED / ACCEPTED** (URL/query/redirect safety: 2 Class-0 GET requests, both HTTP 308 to approved HTTPS authority, path/query preserved, no open redirect, no private-origin disclosure, zero config mutation)
- S5.7-F is **CLOSED / ACCEPTED** (information leakage / response hygiene: read-only inspection of 47 responses from B–E; zero private IP, DB error, stack trace, internal path, container name, or X-Powered-By leaks; Server: cloudflare and CF-RAY edge metadata confirmed; E02 query IP is inert user data; zero new live requests; zero mutations)
- S5.7-G is **CLOSED / ACCEPTED** (strict security matrix consolidation: 75 rows total, 74 PASS, 0 FAIL, 1 NOT TESTED; all 14 metadata fields populated per row with NOT_APPLICABLE semantics; attribution boundaries preserved; zero mutations; timestamp provenance audit passed)
- S5.7-H is **NEXT** (final reconciliation / exactly one receipt / closeout; not started)
- Main reconciled to `origin/main` (`509723680207b6fb8cbbe409d19ac7ad7dd9cc8a` via normal merge commit `2bcafca30736ab685339da0bd4ff9e3a239108ff`)
- `TEST_AUDIT_SIDE_EFFECT_ALLOWED=NO`
- `LIVE_CLASS1_SECURITY_PROBES_ALLOWED=NO`
- `PRODUCTION_CONFIGURATION_MUTATION_ALLOWED=NO`
- `TEST_INDUCED_APPLICATION_SIDE_EFFECT_ALLOWED=NO`
- `POST_LIVE_PROBE_DEFAULT=PROHIBITED`
- `CONNECT=STRICTLY_PROHIBITED`
- `G5=APPROVED`
- `G6=OPEN`
- `FINAL_S5_7_RECEIPT_COUNT=0`
- PR #130 remains **DRAFT**

**Next Gate:** `S5.7-H FINAL RECONCILIATION / CLOSEOUT`.
