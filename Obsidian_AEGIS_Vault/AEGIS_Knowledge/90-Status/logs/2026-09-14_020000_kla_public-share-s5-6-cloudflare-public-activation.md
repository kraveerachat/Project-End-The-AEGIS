---
title: Task Receipt — Public Share S5.6 Cloudflare Public Activation
date: 2026-09-14T02:00:00+07:00
owner: kla
area: idea1
branch: feat/idea1-public-share-s5-6-cloudflare-public-activation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — Public Share S5.6 Cloudflare Public Activation

## What changed

- Successfully executed, verified, and accepted all phases S5.6-A through S5.6-H for Public Share S5.6 (Cloudflare Public Activation) under owner-approved **GLOBAL PUBLIC SHARE G5 = APPROVED**.
- **S5.6-A (Read-Only Preflight & Baseline Inventory)**: Verified untouched baseline across Repository, Cloudflare Control Plane (zone `aegistk-pb.com` Active, tunnel `AEGIS-PUBLIC-SHARE` DOWN, 0 routes, 0 DNS records), Production host (all protected services healthy, S5.5 connector/egress/firewall absent, stale checkout `2806373b` preserved as `INTENTIONALLY_STALE`), and Public DNS (NXDOMAIN across Cloudflare and Google DoH).
- **S5.6-B (Production Runtime Restoration)**: Re-established the reviewed, isolated S5.5 connector runtime from frozen release checkout `/opt/aegis/releases/public-share/99a6f916f5b4aa20da2a1c2ee68e75162f7e23b7` matching canonical merged `main`. Token metadata validated (`0440` root:65532, unopened/unprinted). Pinned connector container `aegis-prod-public-share-connector-1` created stopped via approved four-layer Compose model with `user: "65532:65532"`, `read_only: true`, `cap_drop: ALL`, 0 host ports, attached strictly to edge (`172.31.240.3`) and dedicated egress (`172.31.242.2`, bridge `aegis-ps-eg`). Host firewall applied and validated via `s5-5-firewall.sh` (`AEGIS-PS-EGRESS` 20 Cloudflare `/32` TCP/7844 allowlist, terminal deny, native bridge table `aegis_s55_edge`). Connector started strictly via systemd unit `aegis-public-share-connector.service`; tunnel established outbound HTTP/2 transport (`readyConnections=4`, loopback readiness HTTP 200). Drift watchdog timer `aegis-public-share-drift.timer` active and validated (`DRIFT-OK`). Cloudflare tunnel transitioned to `HEALTHY` with 1 active replica, 0 public routes.
- **S5.6-C (Pre-Exposure Isolation Verification)**: Verified positive transport (connector loopback readiness HTTP 200, connector -> Gateway 172.31.240.2:8080 HTTP 404 with bridge HTTP ACCEPT delta +6, Gateway -> Drive 172.31.241.3:8001/healthz ok=true). Verified negative isolation matrix (bridge SSH :22, direct Drive :8001, host physical SSH 192.168.10.10:22, non-allowlisted 1.1.1.1:7844, wrong port 198.41.192.7:443, public TCP/80, Cloudflare UDP/7844 terminal DROP, public DNS UDP/53 terminal DROP all confirmed BLOCKED:TIMEOUT / DROP). Resolved initial PostgreSQL probe attribution gap: first probe to 172.18.0.5:5432 timed out with test harness reporting drop delta 0; connector was stopped (fail-closed); focused diagnostic S5.6-C1 proved routing table egress dev eth1 src 172.31.242.2 and confirmed `AEGIS-PS-EGRESS` terminal deny dropped the packet with delta 4 (upstream probe 172.31.241.3:5432 DROP delta +3); classified as `PROBE_HARNESS_FALSE_NEGATIVE`, not a security isolation failure; zero cross-boundary leaks; PostgreSQL was never reachable. Verified trust invariants (Gateway trusts only connector /32, Drive trusts only HUB /32 and Gateway /32) and zero host port bindings.
- **S5.6-D (Public Hostname Route Activation)**: Configured the single approved public hostname route on Cloudflare Zero Trust as a Published application: hostname `share.aegistk-pb.com` targeting service `http://172.31.240.2:8080`, path blank, default application settings preserved. Tunnel `AEGIS-PUBLIC-SHARE` active with 1 route, 1 replica, status `HEALTHY`. Zero wildcards, zero root-domain routes, zero alternate hostnames created. Cloudflare mutation occurred (`YES`); Production host mutation was `NO`.
- **S5.6-E (Public DNS Verification)**: Verified public DNS resolution across independent DoH resolvers (Cloudflare `1.1.1.1` and Google `8.8.8.8`): A records resolve to Cloudflare Anycast edge proxies `104.21.40.88`, `172.67.183.68`; AAAA records resolve to `2606:4700:3037::ac43:b744`, `2606:4700:3031::6815:2858`; CNAME answers `<none>` (expected proxied response). Zero origin IP leakage; `PUBLIC_DNS_PROPAGATED=YES`, `PRIVATE_ORIGIN_IP_LEAK=NO`.
- **S5.6-F (Public TLS / HTTPS Verification & Hardening Remediation)**: Verified TLS certificate SAN covers `share.aegistk-pb.com` and `*.aegistk-pb.com` (Let's Encrypt, valid 2026-09-10 to 2026-12-09). Initial tests discovered plaintext HTTP returned 404 without redirect (`Always Use HTTPS = OFF`) and deprecated TLS 1.0/1.1 handshakes were accepted (`Minimum TLS Version = TLS 1.0`). S5.6-F gate was held pending remediation. Following owner-authorized mutations via scoped gate, applied hostname-scoped Single Redirect rule `AEGIS Share HTTP to HTTPS` (wildcard `http://share.aegistk-pb.com/*` -> `https://share.aegistk-pb.com/${1}` with `308 Permanent Redirect`, query string preserved) and elevated zone-level Minimum TLS to `TLS 1.2`. Post-remediation verification confirmed TLS 1.0/1.1 rejected (`curl exit=35`), TLS 1.2/1.3 pass cleanly (`curl exit=0`), HTTP->HTTPS 308 redirect operational with path and query parameters preserved, and standard `curl` verification succeeded without `-k`.
- **S5.6-G (Immediate Public Default-Deny Smoke)**: Verified external black-box default-deny behavior over public edge: unapproved paths (`/`, `/drive/`, `/api/`, `/healthz`, `/monitor/`, `/internal/`) returned HTTP 404 from Gateway; invalid Host (`Host: evil.com`) returned HTTP 403; forbidden methods (`PUT`, `DELETE`, `PATCH`) against `/s/invalid-token-probe` returned HTTP 405; nonexistent share token returned safe HTTP 404 "Link unavailable". Zero internal IP or infrastructure header leakage; `Server: cloudflare` expected public-edge metadata.
- **S5.6-H (Evidence Reconciliation, Single Receipt & Closeout)**: Verified final live Production snapshot S5.6-H0 (all systemd units active and enabled, connector running healthy with 0 restarts, firewall valid, zero host ports, all protected services healthy, UI false). Verified rollback script executable at `/opt/aegis/runtime/public-share/rollback-s5-5.sh` (SHA-256 `a8c5be430b6c97d1b9e891eb4ad1a930a0580d2165b89ae44fdb200dc30923a7`). Reconciled all canonical documentation and completed PR #126 closeout.

## Source files changed

- `docs/superpowers/plans/2026-09-13-idea1-public-share-s5-6-cloudflare-public-activation.md` — cross-scope implementation plan updated to reflect S5.6-A through S5.6-H CLOSED / PASS, S5.6-D Published application terminology, S5.6-F execution deviation (hardening mutations), and S5.6-H rollback claim boundary.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — canonical status updated: Current Task table marked CLOSED / PASS, S5.6-A through S5.6-H detailed narrative sections added with fresh owner evidence summaries, S5.6 Session Register completed, main Session Register updated, and receipt link established.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — canonical architecture note updated: PUBLIC-SHARE-7 phase row marked S5.6 CLOSED / PASS with active route, DNS, and TLS parameters.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md` — canonical map of content updated: recorded S5.6-A through S5.6-H CLOSED / PASS, active public hostname route and TLS parameters, and linked final S5.6 receipt.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-14_020000_kla_public-share-s5-6-cloudflare-public-activation.md` — this single immutable task receipt.

## Verification evidence

- `node scripts/validate-vault.mjs` — pass: 0 errors, 2 pre-existing canvas warnings.
- `node --test tests/collaborationPolicy.test.mjs` — pass: 24 tests, 24 passed, 0 failed.
- `git diff --check` — pass: zero whitespace or formatting errors.
- `git diff --name-status origin/main...HEAD` — pass: strictly documentation, implementation plan, and the single final task receipt. Zero runtime application source or test contracts modified (`RUNTIME_SOURCE_CHANGED=NO`).
- Fresh Human Owner Production & Edge Evidence (S5.6-A through S5.6-H):
  - Baseline preflight (S5.6-A): pass — zone `aegistk-pb.com` Active, tunnel DOWN, 0 routes, DNS NXDOMAIN, protected services healthy, S5.5 residuals absent, checkout `2806373b` intentionally stale.
  - Runtime restoration (S5.6-B): pass — release checkout `99a6f916` verified byte-for-byte, token `0440` root:65532 unopened/unprinted, connector created stopped, non-root 65532, 0 host ports, attached to edge `172.31.240.3` and egress `172.31.242.2`, firewall apply/validate PASS (`nf_tables` backend, 20 Cloudflare `/32` TCP/7844 allowlist, terminal deny, bridge table `aegis_s55_edge`), pre-start OK, connector started via systemd, tunnel transport healthy (HTTP 200, readyConnections=4), drift watchdog active/proven (`DRIFT-OK`).
  - Pre-exposure isolation (S5.6-C): pass — positive matrix pass (readiness HTTP 200, connector -> gateway HTTP 404 with bridge ACCEPT delta +6, gateway -> drive healthz ok=true); negative isolation matrix pass (bridge SSH :22 BLOCKED:TIMEOUT delta +3, direct drive :8001 BLOCKED:TIMEOUT delta +3, host SSH 192.168.10.10:22 BLOCKED:TIMEOUT delta +3, 1.1.1.1:7844 BLOCKED:TIMEOUT delta +3, 198.41.192.7:443 BLOCKED:TIMEOUT delta +3, public TCP/80 BLOCKED:TIMEOUT delta +3, Cloudflare UDP/7844 terminal DROP delta +1, public DNS UDP/53 terminal DROP delta +1); PostgreSQL probe attribution diagnostic C1 confirmed blocked timeout via `AEGIS-PS-EGRESS` terminal deny (drop delta 4, egress source 172.31.242.2; classified `PROBE_HARNESS_FALSE_NEGATIVE`, cross-boundary leak NO); trust invariants intact (Gateway trusts connector /32 only, Drive trusts HUB/Gateway /32 only); 0 host port bindings; firewall validate PASS; connector healthy.
  - Public hostname route (S5.6-D): pass — Published application `share.aegistk-pb.com` targeting `http://172.31.240.2:8080`, path blank, default settings; tunnel `AEGIS-PUBLIC-SHARE` HEALTHY with 1 active replica, 1 route; 0 wildcards.
  - Public DNS (S5.6-E): pass — Cloudflare DoH (`1.1.1.1`) and Google DoH (`8.8.8.8`) resolve A to `104.21.40.88`, `172.67.183.68`; AAAA to `2606:4700:...`; CNAME answer=<none>; zero origin IP leaks.
  - Public TLS & hardening (S5.6-F): pass — certificate SAN valid for `share.aegistk-pb.com` and `*.aegistk-pb.com` (Let's Encrypt, valid to 2026-12-09); owner-authorized mutations applied: Single Redirect `AEGIS Share HTTP to HTTPS` (308 Permanent Redirect) + zone-level Minimum TLS 1.2; post-remediation confirmed TLS 1.0/1.1 rejected (`curl exit=35`), TLS 1.2/1.3 pass (`curl exit=0`), HTTP->HTTPS 308 active with path and query preserved, standard curl succeeded without `-k`.
  - Public default-deny smoke (S5.6-G): pass — unapproved paths (`/`, `/drive/`, `/api/`, `/healthz`, `/monitor/`, `/internal/`) return 404; invalid Host returns 403; forbidden methods PUT/DELETE/PATCH return 405; nonexistent token returns safe 404; zero internal IP or infrastructure leaks; Server: cloudflare expected; real token redemption not run.
  - Live production snapshot (S5.6-H0): pass — systemd units active/enabled, connector running healthy (0 restarts, HTTP 200, readyConnections=4), firewall valid, zero host ports, protected services healthy, UI false. Rollback script executable (`rollback-s5-5.sh`, SHA-256 `a8c5be430b6c97d1b9e891eb4ad1a930a0580d2165b89ae44fdb200dc30923a7`).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — updated Current Task to S5.6 CLOSED / PASS, added detailed S5.6-A through S5.6-H narrative sections, completed S5.6 Session Register, updated main Session Register, and established receipt link.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — updated PUBLIC-SHARE-7 row to reflect S5.6 CLOSED / PASS with active route, DNS, and TLS parameters.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md` — updated Remaining IDEA1 work with S5.6 CLOSED / PASS, active route details, and linked final S5.6 receipt.

## Shared surfaces touched

- `docs/superpowers/plans/2026-09-13-idea1-public-share-s5-6-cloudflare-public-activation.md` — cross-scope implementation plan for Gateway, Cloudflare, and Production activation.

## Integration requests

- Kla integration review for cross-scope implementation plan `docs/superpowers/plans/2026-09-13-idea1-public-share-s5-6-cloudflare-public-activation.md`. All S5.6 phases complete; live connector runtime active and isolated; single approved public route `share.aegistk-pb.com` operational; emergency rollback script verified executable.

## Known limitations

- Current phase state: S5.6-A through S5.6-H are CLOSED / PASS; S5.6 overall is CLOSED / PASS.
- Public Share UI remains OFF (`PUBLIC_SHARE_UI_ENABLED=false`). UI enablement is reserved for S5.11 following G6.
- GLOBAL PUBLIC SHARE G6 remains OPEN.
- Full Public Share product availability is NOT YET AUTHORIZED. Public Internet Share remains NOT IMPLEMENTED / NOT EXTERNALLY ACCEPTED.
- Evidence limitation in S5.6-G: `REAL_EXTERNAL_ACCEPTANCE=NOT_YET_FULLY_PROVEN`. No real share bearer token was redeemed during public default-deny smoke. External client acceptance over Twingate-OFF Wi-Fi and 4G/5G is scheduled for S5.8.
- Rollback claim boundary: `ROLLBACK_ARTIFACT_READY=YES` (script executable and hash verified), but `S5_6_ROLLBACK_REHEARSAL=NOT_RUN` and `ROLLBACK_UNDER_2_MINUTES=NOT_REPROVEN`. S5.6 did not destructively re-run the full rollback after activating the public route. Historical S5.5 clean rollback is design context only.
- Plan execution deviation in S5.6-F: originally planned as read-only, but real hardening gaps (missing HTTPS redirect, TLS 1.0/1.1 acceptance) required two owner-authorized Cloudflare mutations (Single Redirect 308 + zone-level min TLS 1.2) under explicit scoped gates.
- S5.7 (Pre-public security verification over public Internet) is the next scheduled topic.
- Secret handling: Cloudflare tunnel token, API tokens, and credentials were never read, printed, logged, or committed to repository.
