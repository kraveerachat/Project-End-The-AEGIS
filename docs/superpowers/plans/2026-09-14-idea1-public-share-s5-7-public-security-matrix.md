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
   - Reviewed `origin/main` advancement: `13d8fef6e464ecdbc96d466306dbc5aff3c2ae9a` (IDEA2-only)
   - Normal merge commit: `2f73d08062c5a066943c4eafca0908d9d0985d1e`
   - Status: `MAIN_RECONCILED=YES`.

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
The repository already contains raw-request-target-preserving test harnesses in existing Node HTTP tests. Do **NOT** invent a new harness. Existing patterns must be reused.

**Finding C (Local Coverage Gaps):**
Relevant local disposable tests do not yet cover all planned:
- `TRACE` method fail-closed handling
- Double-encoded traversal (`/s/%252e%252e%252f...`)
- Encoded slash (`/s/%2f...`)
- Encoded backslash (`/s/%5c...`)
- Duplicate slash (`/s//...`)

**Prerequisite Gate:**
Before running live public C or D probes against `share.aegistk-pb.com`, these edge cases must be implemented and pass in the local disposable Gateway/Express test suites.
- Tests must assert: expected fail-closed behavior, zero upstream contact where applicable, and raw request target preservation.
- **Implementation Boundary:** These test suites will be implemented by **Codex or Claude Code** under a separate ChatGPT code-change gate. Gemini docs tasks do **NOT** implement tests.

---

## 6. Evidence Attribution Model & Metadata (Finding E)

Cloudflare-edge responses do not automatically prove Gateway behavior, and Drive application responses do not prove Gateway boundary enforcement.

### Attribution Rules:
1. **Cloudflare Rejections (403/404/405):** Do not prove Gateway internal behavior. If Cloudflare blocks a request at the edge, the Gateway boundary for that request must be recorded as `NOT TESTED`.
2. **Drive Rejections (404 Unknown Token):** Proves that Gateway **allowed** the request through to Drive, not that Gateway denied it.
3. **Normalization Attribution:** If client libraries or Cloudflare edge normalize path bytes before Gateway receives them, the Gateway raw-path behavior must be recorded as `NOT TESTED` unless Gateway-level receipt of raw bytes is proven.
4. **Host Header Attribution:** Distinguish incoming Host representations (port representation, case variation) from the Gateway's configured canonical upstream Host.
5. **Redirect Safety:** A same-host HTTP -> HTTPS 308 redirect that preserves query strings is **NOT** an open redirect. Redirect safety evaluates `Location.scheme`, `Location.authority`, and `Location.host`. User-supplied query parameters looking like URLs or IP addresses are inert data.

### Mandatory Structured Evidence Metadata:
Every row in the consolidation matrix must contain:
```text
OBSERVED_LAYER=<Cloudflare Edge | Public Share Gateway | Drive Application | Resolver>
ATTRIBUTION_BASIS=<Header fingerprint | Response body | Connector logs | Firewall counter>
APPLICATION_SIDE_EFFECT_EXPECTED=<YES | NO>
APPLICATION_SIDE_EFFECT_OBSERVED=<NONE | AUDIT_ROW_CONFIRMED | UNCHECKED>
VANTAGE_POINT=<External IPv4/v6 | Twingate Off | Location>
UTC_TIMESTAMP=<YYYY-MM-DDTHH:MM:SSZ>
PR_SHA=<git-commit-sha>
METHOD=<GET | HEAD | POST | PUT | etc.>
RAW_TARGET=<exact-raw-target-sent>
HOST_OR_AUTHORITY=<exact-host-header>
SNI=<exact-tls-sni>
REDIRECT_FOLLOWED=<YES | NO>
CLIENT_NORMALIZATION=<NONE | PATH_NORMALIZED>
CLOUDFLARE_NORMALIZATION_KNOWN=<YES | NO | UNKNOWN>
```

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
| `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayStructure.test.js` | Existing local Gateway structural contracts. |
| `IDEA1-AEGIS_Drive_LC/tests/publicShareSecurityRegression.test.js` | Existing local raw-target-preserving negative test harness. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` | Live task/session register, evidence classification, and closeout records. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` | Canonical architecture, trust boundaries, and phase status. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md` | Area-level status and MOC entry. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_kla_public-share-s5-7-public-security-matrix.md` | Exactly one immutable **final** task receipt, created only at S5.7-H closeout. |

---

## Phase Execution Details

### Task 1 — S5.7-A: Bootstrap / fresh read-only preflight

**Boundary:** Class 0 only. Strictly read-only. Does **NOT** send `/s/invalid-token-probe` or any share-redemption request.
**Authorized Command Scope:**
- Repository: `git status --short`, `git rev-parse HEAD`, `git rev-parse origin/main`, `git merge-base --is-ancestor`
- Cloudflare Control Plane (Read-Only via Owner): tunnel status, replica count, hostname route inspection
- Public Edge / DNS: DoH queries (`1.1.1.1`, `8.8.8.8`), TLS handshake validation, HTTP redirect check
- Production Host (Read-Only via Owner):
  - `systemctl is-active <unit>`
  - `systemctl is-enabled <unit>`
  - `docker inspect <container>`
  - `docker ps`
  - Approved connector readiness inspection (`127.0.0.1:2000/ready`)
  - `s5-5-firewall.sh validate`
  - Read-only `git rev-parse`
- **FORBIDDEN:** `systemctl start/stop/restart/enable/disable`, `docker start/stop/restart/up/create/rm`, firewall apply/remove, rollback scripts, Compose mutations, database writes, Cloudflare mutations, DNS/TLS mutations.

- [ ] Verify branch/HEAD, clean worktree, current `origin/main`, and merge ancestry (`git merge-base --is-ancestor origin/main HEAD`).
- [ ] Obtain fresh **read-only** Cloudflare control-plane evidence: tunnel `HEALTHY`, 1 replica, exactly one approved route (`share.aegistk-pb.com` -> `http://172.31.240.2:8080`).
- [ ] Obtain fresh public DNS and edge evidence: proxied A/AAAA, TLS 1.0/1.1 rejected, TLS 1.2/1.3 accepted, HTTP -> HTTPS 308 redirect to same host.
- [ ] Obtain fresh **read-only** Production evidence: connector running and isolated, firewall valid, drift timer active, protected services intact, `PUBLIC_SHARE_UI_ENABLED=false`.
- [ ] Confirm G5 **APPROVED** and G6 **OPEN**. Mark each check `PASS`, `FAIL`, or `NOT TESTED`.

### Task 2 — S5.7-B: Public surface / boundary enumeration

**Boundary:** Class 0 only. Finite public surface list. Bounded `GET` / `HEAD` requests. Short timeout. No authentication.

- [ ] Test bounded default-deny surface list:
  - Root: `/`
  - Drive application surfaces: `/drive/`, `/api/`, `/api/audit`, `/healthz`
  - Administrative surfaces: `/admin`, `/settings`, `/login`
  - Internal/Monitor surfaces: `/monitor/`, `/internal/`
- [ ] Verify default-deny response (`403` or `404`); verify no private origin IP, stack trace, or internal service information leaked.
- [ ] Record structured metadata per row; confirm boundary attribution (Cloudflare edge vs Gateway).

### Task 3 — S5.7-C: HTTP method / Host / forwarding-header abuse

**Boundary:** Class 1 for share target; local test prerequisite required before live execution. `POST_LIVE_PROBE_DEFAULT=PROHIBITED`.

- [ ] Verify local test prerequisite passed (Finding B & C: local TRACE test passing in Gateway suite).
- [ ] Obtain explicit `TEST_AUDIT_SIDE_EFFECT_ALLOWED=YES` gate with finite request budget before sending live requests to `/s/invalid-token-probe`.
- [ ] Execute bounded method matrix against `/s/invalid-token-probe`: `GET`, `HEAD`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, `TRACE`. (`POST` prohibited by default; `CONNECT` strictly prohibited).
- [ ] Test Host header variations:
  - Approved hostname (`share.aegistk-pb.com`)
  - Approved hostname with standard HTTPS port (`share.aegistk-pb.com:443`)
  - Case variations (`SHARE.AEGISTK-PB.COM`)
  - Unrelated/invalid Host (`attacker.com`, `172.31.240.2`)
  - Distinguish incoming Host representation from canonical upstream Host. Verify invalid Host confers no access.
- [ ] Test spoofed forwarding headers: `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, `CF-Connecting-IP` using documentation-range IPs (`198.51.100.0/24`). Verify headers do not bypass Gateway or alter trust.
- [ ] Record structured metadata per row.

### Task 4 — S5.7-D: Path normalization / traversal matrix

**Boundary:** Class 1; local test prerequisite required before live execution. Finite path list.

- [ ] Verify local test prerequisite passed (Finding C: double-encoded traversal, encoded slash, encoded backslash, duplicate slash passing in local tests with raw request preservation).
- [ ] Obtain explicit `TEST_AUDIT_SIDE_EFFECT_ALLOWED=YES` gate with finite request budget.
- [ ] Execute finite path list:
  - `/s/invalid-token-probe`
  - `/s/../healthz`
  - `/s/%2e%2e/healthz`
  - `/s/%2e%2e%2fhealthz`
  - `/s/%252e%252e%252fhealthz`
  - `/s//invalid-token-probe`
  - `/s/%2finvalid-token-probe`
  - `/s/%5cinvalid-token-probe`
- [ ] Capture `INTENDED_RAW_TARGET`, `CLIENT_SENT_TARGET`, `OBSERVED_LAYER`, `NORMALIZATION_KNOWN`. If Gateway raw receipt is unproven, mark Gateway result `NOT TESTED`.
- [ ] Record structured metadata per row; verify no traversal reaches internal endpoints.

### Task 5 — S5.7-E: URL / query / redirect safety

**Boundary:** Class 0 for redirect/query checks; Class 1 if query appended to share route.

- [ ] Test same-host HTTP -> HTTPS 308 redirect with inert query parameters (e.g. `?url=https://attacker.com`, `?ip=172.31.240.2`).
- [ ] Evaluate `Location.scheme`, `Location.authority`, `Location.host`. Verify authority remains strictly `share.aegistk-pb.com` and no open redirect or private origin disclosure occurs.
- [ ] Verify query data does not alter authorization or reflect unescaped payloads.
- [ ] Record structured metadata per row.

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
- [ ] Ensure all 12 mandatory structured metadata fields are populated in every `EVIDENCE` entry.
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

## Bootstrap & Next Gate

At this plan reconciliation checkpoint:
- S5.7 is **IN PROGRESS / PLAN RECONCILIATION**
- S5.7-A is **NOT STARTED**
- `PRODUCTION_CONFIGURATION_MUTATION_ALLOWED=NO`
- `TEST_AUDIT_SIDE_EFFECT_ALLOWED=NO`
- `LIVE_PUBLIC_SECURITY_PROBES_ALLOWED=NO`
- `FINAL_S5_7_RECEIPT_COUNT=0`

**Next Gate:** `INDEPENDENT_CORRECTED_PLAN_REVIEW`.
No public security probe is run by this checkpoint.
