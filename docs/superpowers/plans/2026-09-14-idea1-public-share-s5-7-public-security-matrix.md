# AEGIS IDEA1 Public Share S5.7 Public Internet Security Matrix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This bootstrap writes the plan only; it does not execute S5.7-A or authorize probes.

**Goal:** Verify the narrow public redemption boundary at `share.aegistk-pb.com` through a bounded, evidence-backed negative security matrix before real external acceptance.

**Architecture:** The existing Cloudflare Published application route reaches `http://172.31.240.2:8080` through the isolated connector; the Gateway permits only the share-redemption route to reach Drive. S5.7 measures the current public surface without changing Production, Cloudflare, DNS, TLS, or the UI. Every live-state claim requires fresh evidence and every matrix row has an explicit result.

**Tech Stack:** Git/GitHub CLI, Node.js documentation and contract tests, read-only Cloudflare/Production inventory, bounded `curl`/TLS/DNS observations, Markdown evidence matrix.

**Spec:** `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` and `docs/superpowers/plans/2026-09-13-idea1-public-share-s5-6-cloudflare-public-activation.md`; accepted S5.6 evidence is in `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-14_020000_kla_public-share-s5-6-cloudflare-public-activation.md`.

## Global constraints and evidence boundary

- At S5.7 start: `PRODUCTION_MUTATION_ALLOWED=NO`, `CLOUDFLARE_MUTATION_ALLOWED=NO`, `DNS_MUTATION_ALLOWED=NO`, `TLS_MUTATION_ALLOWED=NO`, `PUBLIC_SHARE_UI_MUTATION_ALLOWED=NO`.
- Approved hostname is exactly `share.aegistk-pb.com`; approved Published application origin is exactly `http://172.31.240.2:8080`. No wildcard, root-domain, or alternate-host route is approved.
- S5.6 is **MERGED / CLOSED / PASS** at merge commit `fe75bc53c1fd3a3103708470dfb7111996b80eff`; G5 is **APPROVED**, G6 **OPEN**, and `PUBLIC_SHARE_UI_ENABLED=false`. Its Production, Cloudflare, DNS, TLS, and smoke evidence is carried forward as a baseline, **not** fresh S5.7 PASS.
- Public route and proxied DNS were active, tunnel healthy with one replica and one route, TLS 1.0/1.1 rejected, TLS 1.2/1.3 passed, and hostname-scoped HTTP→HTTPS 308 worked at S5.6 closeout. Re-prove the applicable facts in S5.7-A before any later security test.
- S5.6 rollback script was verified executable; a fresh S5.6 full rollback rehearsal was **NOT RUN** and rollback under two minutes was **NOT REPROVEN**. S5.10 owns rollback execution.
- Testing is bounded, low-volume, manually attributable, and non-destructive. No brute force, credential guessing, DoS, sustained concurrency, high-rate fuzzing, unrelated-host or Cloudflare-infrastructure scans, real user data, real bearer/share tokens, or secret-bearing output. A later explicit gate is required before any real token use.
- Use a fixed synthetic identifier such as `invalid-token-probe`; do not send `CONNECT` without a documented safe reason and later explicit ChatGPT authorization. Do not interpret a Cloudflare rejection as proof of the Gateway's internal behavior without origin-bound evidence.
- If a security-critical failure appears, stop that attack class, preserve sanitized evidence, and return to ChatGPT for a separately scoped remediation gate. No defect discovered here authorizes Production or Cloudflare mutation.
- This phase is **not** launch, G6, real Twingate-OFF Wi-Fi/4G/5G acceptance (S5.8), 64 MiB/SHA-256/interruption/slow-client/concurrency acceptance (S5.9), full exposure rollback/private regression (S5.10), or UI activation/final restoration after G6 (S5.11).

## File and evidence map

| Path | Role in S5.7 |
| :--- | :--- |
| `gateway/public-share/nginx.conf.template` | Reviewed Gateway route, Host, method, and raw-path policy; read only unless a later defect gate approves a fix. |
| `gateway/public-share/production/README.md` | Existing four-layer runtime and read-only inspection contract; read only. |
| `IDEA1-AEGIS_Drive_LC/tests/publicShareSecurityRegression.test.js` | Existing local negative-control context; not a substitute for public-edge evidence. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` | Live task/session status, evidence classification, and final closeout. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` | Canonical trust-boundary and phase map. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md` | Area-level current-state pointer. |
| `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_kla_public-share-s5-7-public-security-matrix.md` | Exactly one immutable **final** task receipt, created only in S5.7-H. |

For live probes, record a sanitized matrix in the canonical status note or a narrowly scoped reviewed evidence artifact on this same branch. Each row must bind request shape, vantage point, timestamp, status, expected/actual, and a non-secret evidence reference. Never store raw bearer URLs, cookies, credentials, response bodies containing secrets, or container environments.

---

### Task 1 — S5.7-A: Bootstrap / fresh read-only preflight

**Files:** Read the S5.6 plan and receipt, `gateway/public-share/production/README.md`, the Gateway template, and current IDEA1 notes. Update the canonical status only after evidence review; no runtime source change.

- [ ] Verify branch/HEAD, clean worktree, current `origin/main`, and S5.6 merge ancestry with `git status --short`, `git rev-parse HEAD`, `git rev-parse origin/main`, and `git merge-base --is-ancestor fe75bc53c1fd3a3103708470dfb7111996b80eff HEAD`. Record exit codes and stop on divergence.
- [ ] Obtain fresh **read-only** owner/control-plane evidence: tunnel `HEALTHY`, exactly one approved Published application route, hostname exactly `share.aegistk-pb.com`, no wildcard/root/alternate hostname, origin exactly `http://172.31.240.2:8080`; record route type and timestamp without credentials.
- [ ] Obtain fresh public DNS and edge evidence from the approved hostname only: A/AAAA resolve through Cloudflare proxies without private origin IP, HTTPS reaches the edge with normal certificate validation, TLS 1.0/1.1 rejected and 1.2/1.3 accepted, and HTTP redirects to the same HTTPS hostname with 308. Do not treat an inability to test a protocol as a rejection PASS.
- [ ] Obtain fresh **read-only** Production owner evidence using the inspected procedures in `gateway/public-share/production/README.md`: connector running and attached only as approved, firewall `validate` successful, drift timer active, Gateway/connector `PortBindings={}`, protected Drive/Gateway/PostgreSQL/Monitor/HUB/Twingate healthy, and `PUBLIC_SHARE_UI_ENABLED=false`. Do not print container environment or token metadata beyond approved non-secret flags.
- [ ] Confirm G5 **APPROVED** and G6 **OPEN** from canonical governance. Mark each subcheck `PASS`, `FAIL`, or `NOT TESTED`; any missing critical state blocks S5.7-B. No Production, Cloudflare, DNS, or TLS mutation in A.

### Task 2 — S5.7-B: Public surface / boundary enumeration

**Files:** Read `gateway/public-share/nginx.conf.template` and `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayStructure.test.js`; record bounded public-edge evidence only after Task 1 PASS.

- [ ] From one identified public vantage point, send one bounded `GET` and, if needed, one `HEAD` to `https://share.aegistk-pb.com/`, `/drive/`, `/api/`, `/healthz`, `/monitor/`, and `/internal/`; add any other **known** private application surface from current source, not a broad crawl. Use a short timeout and no authentication.
- [ ] Expect default deny (`403` or `404` where the route is unapproved); compare with S5.6's observed 404 baseline, but do not require a false exact code if Cloudflare legitimately rejects before Gateway. Confirm no Drive, HUB, Monitor, private health payload, management interface, or upstream URL is returned.
- [ ] Record each path, method, status, redirect target if any, sanitized response fingerprint, vantage point, and boundary conclusion. Stop this class if an internal surface is exposed.

### Task 3 — S5.7-C: HTTP method / Host / forwarding-header abuse

**Files:** Read `gateway/public-share/nginx.conf.template` and the existing Gateway/managed-tunnel tests; no source edits under this authorization.

- [ ] Against `/s/invalid-token-probe`, test a small fixed set: `GET`, `HEAD`, `POST` only with a harmless empty/synthetic body, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, and `TRACE`. Expect no unsupported method to reach private application behavior; the current Gateway allows only `GET|POST` on the share route, so unsupported methods should be denied (`405` at Gateway when reached). Do not send `CONNECT` absent later authorization.
- [ ] Compare the valid hostname, a clearly invalid `Host`, a Host with unexpected port, and a standards-safe uppercase variant. Invalid Host must not confer access; record whether Cloudflare or Gateway generated the rejection without guessing.
- [ ] In separate low-rate requests, supply synthetic `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, and `CF-Connecting-IP` values. Use only documentation-range addresses (for example `198.51.100.30`), never real client identities. Verify no spoofed header grants private/internal trust or changes the approved public route. Cloudflare may rewrite/drop headers: do not claim a Gateway header proof unless measured at that boundary.
- [ ] Record request headers by **name and synthetic value only**, observed response, attribution limits, and status per row. Stop on a critical bypass.

### Task 4 — S5.7-D: Path normalization / traversal matrix

**Files:** Read the raw-request-target guard in `gateway/public-share/nginx.conf.template`; record public-edge negative evidence only.

- [ ] Use only invalid-token paths in a fixed list: `/s/invalid-token-probe`, `/s/../healthz`, `/s/%2e%2e/healthz`, `/s/%2e%2e%2fhealthz`, `/s/%252e%252e%252fhealthz`, `/s//invalid-token-probe`, `/s/%2finvalid-token-probe`, and `/s/%5cinvalid-token-probe`. Configure the client to preserve the path bytes where supported; record if a client normalized a path before sending it.
- [ ] Expect bounded rejection and no internal endpoint, Drive UI, filesystem path, stack trace, or redirect to a private resource. Do not attempt real host files, filesystem exploitation, or an open-ended payload generator.
- [ ] Record raw request target, client normalization behavior, status, sanitized outcome, and boundary; stop on any internal exposure.

### Task 5 — S5.7-E: URL / query / redirect safety

**Files:** Read current Cloudflare redirect facts in the S5.6 receipt and the Gateway share route; no redirect-rule mutation.

- [ ] Use only invalid/non-secret share identifiers and a small fixed set of harmless query strings, including an encoded external-URL value and a private-origin-looking value as inert data. Do not submit live bearer links or user content.
- [ ] Verify malformed or attacker-controlled query data does not redirect to an arbitrary domain, expose an origin/private URL, alter authorization, or reflect unsafe internal data. Compare any `Location` only against the approved public hostname.
- [ ] Recheck the existing HTTP→HTTPS 308 for `share.aegistk-pb.com` and same-host path/query preservation; no alternate hostname or redirect-rule mutation is authorized.

### Task 6 — S5.7-F: Information leakage / response hygiene

**Files:** Read Gateway header/logging rules and the Drive share error contract; inspect bounded public responses without recording secrets.

- [ ] Inspect only the headers and short bounded bodies already gathered in B–E. Check for private CIDRs (`172.31.*`, `172.18.*`, `192.168.*`, `10.*`), `postgres`, database connection strings, stack traces, `node_modules`, filesystem paths, container names (`aegis-prod-*`), Public Share Gateway internal identity, `X-Powered-By`, internal hostnames, private upstream URLs, and secret/token material.
- [ ] Treat `Server: cloudflare` as expected edge metadata, not an origin leak. Distinguish a public hostname in a same-host redirect from a private origin leak.
- [ ] If a response appears secret-bearing, stop capture and redact locally before any repository/PR/Obsidian entry. Record the category and a safe evidence pointer, never the value.

### Task 7 — S5.7-G: Security matrix consolidation

**Files:** Update `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` with reviewed evidence and status; keep raw secret-bearing captures out of Git.

- [ ] Consolidate **every** required row under exact columns `TEST | REQUEST | EXPECTED | ACTUAL | STATUS | EVIDENCE | SECURITY_BOUNDARY`. Allowed row statuses are only `PASS`, `FAIL`, and `NOT TESTED`; never coerce missing evidence into PASS.
- [ ] Bind evidence to timestamp, vantage point, branch/SHA, response status, and source (fresh S5.7 vs carried-forward S5.6). State when a Cloudflare-edge result does not prove Gateway or Drive internals.
- [ ] On security-critical `FAIL`, stop the affected class and report to ChatGPT → Codex/Claude for a separately approved remediation task; do not mutate Production or Cloudflare. If mandatory rows are `NOT TESTED`, S5.7-H cannot claim full PASS.

### Task 8 — S5.7-H: Final reconciliation / closeout

**Files:** Update `idea1-status.md`, `idea1-public-share-architecture.md`, and `idea1-moc.md` only to match accepted evidence; create exactly one new `90-Status/logs/YYYY-MM-DD_HHMMSS_kla_public-share-s5-7-public-security-matrix.md` receipt at final task handoff.

- [ ] Begin only after ChatGPT/owner acceptance of all required S5.7 evidence and no unresolved critical failures. Preserve S5.6 historical snapshots and the S5.6 receipt unchanged.
- [ ] Reconcile canonical status, architecture, and MOC with actual S5.7 evidence maturity. Do not claim S5.8 real external acceptance, S5.9 scale/resilience, S5.10 rollback, G6, or UI activation.
- [ ] Create the **one** immutable S5.7 final receipt from `90-Status/logs/_template.md`, including exact changed paths, tests, evidence boundaries, cross-scope review, limitations, and next gates. Bootstrap and intermediate sessions create zero receipts.
- [ ] Run `node scripts/validate-vault.mjs`, `node --test tests/collaborationPolicy.test.mjs`, `git diff --check`, and all affected verification required by any later approved change; inspect `git status --short` and exact paths. Push normal commits on this same branch, reconcile the Draft PR body, and mark Ready only after final receipt and policy checks pass. Human owner/reviewer alone may merge.

## Bootstrap boundary and next gate

At this document's creation S5.7 is **IN PROGRESS / PLANNING**, not A PASS. The only authorized bootstrap outputs are this plan, minimal canonical status pointers, one documentation checkpoint, and one Draft PR. Next gate: **ChatGPT review before S5.7-A fresh read-only preflight**. No public security probe is run by this bootstrap.
