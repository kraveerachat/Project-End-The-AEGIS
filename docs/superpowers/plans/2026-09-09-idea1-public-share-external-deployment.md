# IDEA1 Public Share External Deployment & Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy and externally accept the existing IDEA1 Public Share capability through an owner-approved named Cloudflare Tunnel without exposing any private AEGIS surface, then enable the UI only after rollback and external acceptance pass.

**Architecture:** Cloudflare terminates public HTTPS and forwards a named-tunnel route to one isolated `cloudflared` connector. The connector reaches only a dedicated Public Share Gateway; the gateway reaches only Drive on a separate two-member network; Drive remains the sole authorization authority. Production preparation is separated from G5 exposure, and rollback removes exposure before withdrawing lower layers.

**Tech Stack:** Git/GitHub, Docker Engine 29.7.1 and Compose, nginx Public Share Gateway, Cloudflare Tunnel (`cloudflared` pinned by digest), Node/Express IDEA1 Drive, PostgreSQL 15 migration 009, Linux firewall or dedicated VLAN isolation, Obsidian governance.

**Spec:** `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md`

## Global Constraints

- Task: `PUBLIC-SHARE-7 External Deployment & Acceptance`.
- Branch: `feat/idea1-public-share-external-deployment` from `d32885b36c08c71dc5719109de12ed8ac8f6589e`.
- One task, one branch, one Draft PR, multiple S5 sessions, exactly one final immutable receipt at S5.12.
- S5.1 is documentation/planning only: `PRODUCTION MUTATION ALLOWED = NO`.
- G4 is approved for Option B / Managed Tunnel; G5 and G6 remain open.
- G5 is the only gate that authorises an actual public hostname/tunnel route.
- `PUBLIC_SHARE_UI_ENABLED=false` until G6; UI activation is last.
- Deployment order is Drive first, Gateway second; rollback reverses that order.
- Never expose `.env`, credentials, tunnel tokens, private keys, cookies, raw share tokens, public bearer URLs, or password bodies in Git, chat, screenshots, command output, or logs.
- Never add Cloudflare/provider ranges to Drive trust. Drive trusts HUB `/32` plus one gateway `/32` only.
- Never rebuild/recreate Monitor or HUB as a side effect of this task.
- Never run `git pull` followed by whole-stack `docker compose up --build -d` on Production.
- Never delete/prune `aegis_drive_storage`, `aegis_postgres_data`, the Monitor clip bind, existing backups, or unknown volumes.
- No task step is evidence until its command, environment, source SHA, result and cleanup are recorded.

---

## 1. Owner-approved decision and evidence classes

### G4 decision

On 2026-09-09 the owner approved §13 Option B:

```text
External recipient
→ Cloudflare Edge HTTPS
→ named Cloudflare Tunnel
→ isolated outbound-only cloudflared connector
→ dedicated Public Share Gateway
→ dedicated Gateway→Drive network
→ AEGIS Drive
```

The decision accepts two residual risks rather than pretending they disappear:

- **T-14:** Cloudflare/provider infrastructure may observe or log the bearer URL because the token is in the path.
- **T-27:** recipient attribution depends on provider-asserted `CF-Connecting-IP`, accepted only from one pinned connector by the pre-exposure-tested adapter.

G4 does not mean G5. It creates no tunnel, DNS, TLS, connector, public route or Production capability.

### Evidence labels

Use these labels exactly:

| Label | Meaning |
| :--- | :--- |
| Owner-supplied Production evidence | Measurement supplied in the S5.1 brief; not reproduced from Windows |
| Source implemented | Present in a reviewed Git tree; not proof of deployment |
| Pre-exposure verified | Isolated Docker/runtime evidence with no public route |
| Production deployed | Exact image/config/migration identity observed on the Beelink |
| Real external acceptance | Twingate-off ordinary Internet client evidence |
| Closed | Canonical docs, rollback evidence, final receipt and owner gates complete |

## 2. Frozen owner-supplied Production baseline

S5.1 must not attempt to reproduce these values from Windows:

| Concern | Frozen planning evidence |
| :--- | :--- |
| GitHub main | `d32885b36c08c71dc5719109de12ed8ac8f6589e` |
| Production checkout | `/opt/aegis/Project-End-The-AEGIS`, clean `main`, HEAD `2806373bb300728a0babb953a63f98bcd714ffef`, intentionally stale |
| Runtime Compose | `/opt/aegis/runtime/docker-compose.production.yml`, SHA-256 `5aae5cd7ded537f9124d2af8733d076f177871e0d3757208bf0c4a61fc635193` |
| Production `.env` | `/opt/aegis/Project-End-The-AEGIS/.env`, `root:root`, mode `0600`; contents forbidden from evidence |
| Drive | healthy; image `sha256:fd9d8f74f0d3df73c21cdb46256f2afb101b7b9fbf1d4e3d95142c22712e23a1`; OCI revision `913758a3111fb74e31eb55b7982a84d127cae8f5` |
| Monitor | healthy; `aegis-prod-monitor:single-camera-ui-20260906-204814`; image `sha256:9a3c20428308ab685a2037b72953adaa9621f327e88a9c6ea600f1bebbb4a4d9`; active overlay `/opt/aegis/runtime/monitor-single-camera-ui-20260906-204814/compose.active.yml` |
| HUB | healthy; image `sha256:8c365f8c8ae82b61d9e9048cb05afccb2e580b03b73a849edc8d830f99d560fc`; OCI revision unavailable |
| PostgreSQL / Twingate | `aegis-prod-postgres-1` and `twingate-aegis-connector-02` healthy |
| Protected volumes | `aegis_drive_storage`, `aegis_postgres_data` present |
| Database | `shares_scope_check` allows `any`, `zones`, `vlan`, `subnet`; migration 009 not applied |
| Public runtime | no Public Share Gateway/network; `cloudflared` not installed; systemd service inactive |
| UFW | active; incoming deny, outgoing allow, routed deny; no Public Share rule |
| Public DNS | `aegistk-pb.com` and `share.aegistk-pb.com` are NXDOMAIN via Cloudflare and Google DoH; ownership/zone not verified |
| Provenance classification | **PARTIALLY KNOWN** |

Before any later Production mutation, repeat this inventory read-only and stop if container IDs, images, compose digest, protected volumes, health, database constraint, network state or public DNS differ without an approved explanation.

## 3. Hard dependencies and owner gates

| Gate | Required evidence | What it blocks |
| :--- | :--- | :--- |
| Source freeze | approved merge SHA/tree and a fresh release checkout outside the stale Production checkout | every image build |
| Runtime freeze | current runtime Compose digest, overlays, image IDs, health and rollback tags | every Production change |
| Backup boundary | successful current backup, integrity result, protected-volume presence and restorable database artifact | migration 009 |
| Domain/zone | owner proves control of a usable domain and active Cloudflare zone; hostname chosen without creating a route | named public hostname activation |
| Connector isolation | reviewed exact network/firewall design plus positive egress and negative private-reachability tests | starting the real connector and G5 |
| G5 | explicit owner approval after the connector/gateway path is deployed but has no public route | tunnel route, DNS and public exposure |
| External acceptance | security, byte-integrity, resilience and rollback evidence | G6 |
| G6 | explicit owner completion/activation approval | `PUBLIC_SHARE_UI_ENABLED=true` |

The current NXDOMAIN result and unverified domain ownership are blockers, not defects to work around. Do not invent a Cloudflare zone or use a temporary public hostname as acceptance evidence.

## 4. Source and runtime strategy

The stale Production checkout is evidence, not a build workspace.

- [ ] Fetch the canonical repository into a new release checkout under `/opt/aegis/releases/public-share/${DEPLOY_SOURCE_SHA}`; verify `HEAD`, tree and signature/review state.
- [ ] Record `DEPLOY_SOURCE_SHA` as the full merged commit chosen by the owner; do not build an unmerged PR head unless the owner explicitly freezes that exact SHA.
- [ ] Build only the Drive image from that release checkout, tag it immutably as `aegis-prod-drive:public-share-${DEPLOY_SOURCE_SHA:0:12}`, and add `org.opencontainers.image.revision=${DEPLOY_SOURCE_SHA}`.
- [ ] Preserve the current Drive image ID and add a local rollback tag before recreation.
- [ ] Use an image-only Compose override under `/opt/aegis/runtime/public-share/`; never use a Production `build:` directive.
- [ ] Validate Compose with `docker compose ... config --quiet`; never print a rendered config that may contain secrets.
- [ ] Recreate only Drive with `up -d --no-deps --no-build drive` when its approved session begins.
- [ ] Keep Monitor's active overlay and running image untouched; do not run a project-wide `up`, `down`, `pull`, `build`, `prune` or recreate.

Explicitly forbidden:

```text
cd /opt/aegis/Project-End-The-AEGIS
git pull
docker compose up --build -d
```

## 5. Database migration 009 plan

Migration 009 is additive: it replaces one CHECK with a strict superset and performs no row DML. Its safest rollback after successful application is normally to leave it installed.

### Before migration

- [ ] Confirm `aegis-prod-postgres-1` is healthy and `aegis_postgres_data` exists.
- [ ] Complete a current owner-approved backup through the existing Backup Agent and record job ID, `SUCCESS`, integrity `PASS`, artifact identity and retention location without credentials.
- [ ] Produce a root-protected PostgreSQL custom-format backup of `aegis_drive`; record path metadata, byte size and SHA-256, never its contents.
- [ ] Record the exact current constraint from `pg_constraint` and aggregate share counts by scope.
- [ ] Record total share rows and a stable digest over non-secret row identity/scope/lifecycle fields; never select `token_hash` or `password_hash` into logs.
- [ ] Verify no existing row uses `scope='public'`.

### Apply

From the exact frozen release tree, through the existing owner-approved database-admin mechanism:

```bash
docker exec -i aegis-prod-postgres-1 \
  psql -v ON_ERROR_STOP=1 -U aegis -d aegis_drive \
  < /opt/aegis/releases/public-share/${DEPLOY_SOURCE_SHA}/IDEA1-AEGIS_Drive_LC/server/db/migrations/009_public_share_scope.sql
```

Do not echo passwords or environment variables. Stop immediately on non-zero exit.

### After migration

- [ ] Confirm `shares_scope_check` is exactly `any`, `zones`, `public`, `vlan`, `subnet`.
- [ ] Re-run the non-secret counts/digest and prove existing rows are unchanged.
- [ ] Re-run migration 009 once with `ON_ERROR_STOP=1` and prove idempotence.
- [ ] Confirm `drive_app` still has only the expected application privileges and cannot run the migration itself.
- [ ] Confirm PostgreSQL and the current Drive remain healthy before any Drive rollout.

### Failure handling

- If the migration command fails, PostgreSQL's transaction must leave the old constraint intact; verify it and stop.
- If the migration succeeds but later deployment fails, leave 009 in place. Removing `public` from the CHECK could invalidate rows and is not an automatic rollback.
- Restore the database only after measured corruption/data loss and a separate owner decision; never restore merely because the gateway or connector failed.

## 6. Production network topology and connector-isolation gate

Target membership:

```text
cloudflared
  ├─ aegis_public_share_egress   # connector only; outbound path
  └─ aegis_public_share_edge     # connector + gateway only
gateway
  ├─ aegis_public_share_edge
  └─ aegis_public_share_upstream # gateway + Drive only
Drive
  └─ aegis_public_share_upstream
```

`aegis_public_share_edge` and `aegis_public_share_upstream` must be `internal: true` with isolated bridge gateway mode, have no host-published port, and contain exactly the named two members. The gateway never joins `aegis_internal`, `aegis_drive_proxy`, the Monitor network, or the connector's egress network.

The egress network is an unresolved Production security design, not inherited from the harness. S5.2 must review one exact implementation before S5.5:

1. **Preferred minimal-host design:** connector-only Docker bridge plus explicit host firewall/`DOCKER-USER` or nftables policy that permits required Cloudflare Tunnel egress/DNS and denies host, RFC1918, link-local, Docker private bridges and AEGIS listeners.
2. **Stronger infrastructure design:** dedicated connector VLAN/namespace with equivalent egress allow/deny policy and no route to private AEGIS networks.

Whichever design the owner accepts must include commands, interface/container identity, rule order, persistence mechanism and exact rollback. UFW's current routed-deny policy is not assumed to police Docker forwarding.

Required proof before G5:

- connector resolves and reaches required Cloudflare endpoints on the approved outbound ports;
- connector reaches the gateway listener on the edge network;
- connector cannot directly reach Drive, PostgreSQL, HUB, Monitor, host-private listeners, Docker bridge gateways or Twingate resources;
- gateway reaches only Drive on its upstream network;
- Drive sees only the gateway as ingress provenance and the provider-asserted recipient as client source;
- Drive trusts only HUB `/32` plus gateway `/32`; no provider CIDR is present;
- no host port or inbound NAT/firewall rule exists.

Any unexpected reachable private address is a failed gate. Do not add exceptions to make the test pass.

## 7. Drive and gateway rollout before exposure

- [ ] Deploy the new Drive image first in legacy/private proxy mode, with migration 009 present and `PUBLIC_SHARE_UI_ENABLED=false`.
- [ ] Verify private HUB login, Files, private `zones`/`any` share creation/redemption/revoke, health, storage and audit before changing proxy state.
- [ ] Create the two internal isolated Public Share networks with exact reviewed `/29` subnets that do not overlap any runtime, VPN, VLAN or Docker network.
- [ ] Apply the Drive-only runtime override that attaches Drive to `aegis_public_share_upstream`, sets one gateway `/32`, and sets `TRUSTED_PROXY_CIDRS` to exactly HUB `/32` plus that gateway `/32`.
- [ ] Set `PUBLIC_SHARE_BASE_URL` only to the owner-controlled hostname selected after domain/zone proof; the hostname may remain NXDOMAIN before G5.
- [ ] Keep `PUBLIC_SHARE_UI_ENABLED=false`.
- [ ] Recreate only Drive with `--no-deps --no-build`; prove health and private regression again.
- [ ] Deploy the pinned Public Share Gateway image second, read-only, non-root, all capabilities dropped, no secrets, no Data Lake/database mounts, on edge + upstream networks only.
- [ ] Configure `PUBLIC_SHARE_EDGE_MODE=cloudflare` and pin exactly the connector's edge-network `/32`; do not configure a Cloudflare range.
- [ ] From an internal test member only, verify the gateway route/method/Host allowlist, provider-header stripping, token-safe logs, per-recipient rate limiting, streaming and default deny.

No Internet route exists in this phase.

## 8. `cloudflared` connector plan

- [ ] Resolve the official `cloudflared` image and record an immutable digest; mutable tags are not accepted for Production.
- [ ] Inspect the pinned image's numeric runtime UID/GID and create a dedicated host identity/file ownership contract without adding privileges.
- [ ] The owner creates one named tunnel in an authenticated private terminal. Credentials never pass through chat or a repository file.
- [ ] Store the credential in `/opt/aegis/runtime/public-share/secrets/` with a dedicated owner, directory mode `0700`, file mode no broader than `0400`, and mount it read-only only into the connector.
- [ ] Run one connector container with read-only root filesystem, tmpfs for required writable state, `cap_drop: ALL`, `no-new-privileges`, no Docker socket, no host network, no host PID/IPC, no AEGIS volume and no published port.
- [ ] Configure only the named tunnel and local gateway origin; do not create the public hostname route before G5.
- [ ] Configure bounded restart behavior and a liveness/readiness signal that exposes no tunnel credential or bearer URL.
- [ ] Verify connector-to-Cloudflare control connection and all isolation negatives in §6.
- [ ] Record connector container/image ID, tunnel UUID or non-secret name, network memberships and health; never record credential contents.

## 9. Domain, DNS, Cloudflare and TLS

The currently proposed names are NXDOMAIN. Before activation:

- [ ] Owner proves registration/control of a usable domain and an active Cloudflare zone.
- [ ] Select one exact share hostname; no wildcard and no public `aegis.internal` record.
- [ ] Confirm the gateway's `PUBLIC_SHARE_HOST` equals the hostname component of Drive's `PUBLIC_SHARE_BASE_URL`.
- [ ] Configure Cloudflare cache bypass/no-store handling for the share hostname/path and verify no edge cache serves redemption content.
- [ ] Confirm provider logging/privacy settings and retain T-14 as accepted residual risk; do not claim the provider cannot log the bearer URL.
- [ ] Prepare the named-tunnel hostname route but do not activate it before G5.

After G5 only:

- [ ] Activate the tunnel route and the single DNS record.
- [ ] Verify public DNS through at least Cloudflare and Google resolvers.
- [ ] Verify a publicly trusted certificate, hostname match, chain, TLS 1.2/1.3, redirect behavior where applicable, HSTS and no plaintext token path.
- [ ] Prove `/`, `/drive/`, `/api/`, `/healthz`, `/monitor/`, `/internal/` and unexpected Host/method forms terminate without reaching private services.

## 10. Exact fail-closed deployment sequence

| Order | Session | Action | Production mutation | Gate/result required before next step |
| :--- | :--- | :--- | :--- | :--- |
| 1 | S5.2 | Refresh read-only baseline; prove domain/zone control; approve exact connector isolation and rollback commands | No | owner accepts evidence and mutation scope |
| 2 | S5.3 | Freeze release SHA/tree and rollback images/config | Yes: release artifacts only | provenance and rollback IDs recorded |
| 3 | S5.3 | Complete backup boundary | Yes: backup artifact | backup/integrity evidence PASS |
| 4 | S5.3 | Apply migration 009 and verify rows/constraint/idempotence | Yes: additive DB constraint | database verification PASS |
| 5 | S5.3 | Deploy Drive image in private mode, UI off | Yes: Drive only | health/private regression PASS |
| 6 | S5.4 | Create edge/upstream networks; deploy Drive State B then gateway | Yes: Drive/network/gateway | gateway and private regression PASS |
| 7 | S5.5 | Apply approved connector egress isolation and start pinned named-tunnel connector without hostname route | Yes: connector/firewall or VLAN | all positive/negative isolation probes PASS |
| 8 | G5 | Owner reviews steps 1–7 and explicitly authorises actual Internet exposure | No | **G5 APPROVED** |
| 9 | S5.6 | Activate named-tunnel hostname route and DNS; verify public TLS | Yes: first public exposure | DNS/TLS/default-deny PASS |
| 10 | S5.7 | Run public security matrix from ordinary Internet | Test data only | private surfaces unreachable; controls PASS |
| 11 | S5.8 | Run Twingate-OFF Wi-Fi and 4G/5G recipient workflow | Test data only | external functional acceptance PASS |
| 12 | S5.9 | Run 64 MiB SHA-256, interruption, slow path and concurrency acceptance | Test data/traffic only | integrity/resilience PASS |
| 13 | S5.10 | Execute and verify full exposure rollback, then private-system regression | Yes: controlled rollback | no public path; private system healthy |
| 14 | G6 | Owner accepts all evidence and authorises product availability | No | **G6 APPROVED** |
| 15 | S5.11 | Re-establish accepted public path and set `PUBLIC_SHARE_UI_ENABLED=true` last | Yes: UI activation | final public + private E2E PASS |
| 16 | S5.12 | Final canonical docs, exactly one immutable receipt, policy/vault/diff checks | Repository only | task ready for human review/merge |

If a step fails, stop at that layer. Never advance a later layer to compensate for an earlier failure.

## 11. External acceptance matrix

From an ordinary external client with Twingate off and no AEGIS account:

- [ ] Public URL resolves and presents the expected password page without scripts.
- [ ] Wrong password is denied and rate-limited without affecting private redemption or login.
- [ ] Correct password downloads exact bytes with attachment, `nosniff`, `no-store` and no public cache hit.
- [ ] Expected byte length and SHA-256 match for the normal probe and deterministic 64 MiB artifact.
- [ ] Audit records the canonical recipient address and no raw token/password/bearer URL.
- [ ] Hit counter changes according to the existing authorised-redemption semantic.
- [ ] Revoke immediately prevents another redemption.
- [ ] Unknown/expired/revoked/trashed/Vault-backed links remain recipient-indistinguishable.
- [ ] `/`, `/drive/`, `/api/`, `/healthz`, `/monitor/`, `/internal/` and traversal/method variants expose no private surface.
- [ ] Separate Wi-Fi and 4G/5G paths pass where practical.
- [ ] One interrupted transfer does not damage Drive/Gateway and a later full transfer is intact.
- [ ] Slow-client and bounded-concurrency probes do not cross the already accepted resource boundary.

HTTP Range remains unsupported; interrupted downloads restart from byte zero. Do not claim 20–30 GB or a Production 32 GiB ceiling from the 64 MiB probe.

## 12. Exact rollback sequence

Rollback is rehearsed in S5.10. In an incident, begin at the highest deployed layer and do not wait for lower-layer diagnosis before removing exposure.

1. Disable/remove the Cloudflare public hostname route first.
2. Remove the public DNS record and verify authoritative plus independent resolvers no longer return a usable route.
3. Stop the `cloudflared` connector; preserve credential files for controlled recovery unless compromise requires separately authorised rotation.
4. Remove connector egress firewall/VLAN rules using the exact S5.2 rollback commands; prove no stale public route/listener remains.
5. Stop/remove the Public Share Gateway container.
6. Detach/remove `aegis_public_share_edge`; remove `aegis_public_share_upstream` only after the gateway is gone and Drive rollback is ready.
7. Keep `PUBLIC_SHARE_UI_ENABLED=false`; if G6 had enabled it, return it to false before restoring service to users.
8. Recreate only Drive with the captured previous image/config, HUB-only `TRUSTED_PROXY_CIDRS`, no `PUBLIC_SHARE_GATEWAY_CIDR`, and no public network; use `--no-deps --no-build`.
9. Leave migration 009 installed unless measured database corruption/data loss triggers a separate owner-approved restore. Existing public rows remain listable/revocable but have no Internet route.
10. Verify PostgreSQL, Drive, HUB, Monitor and Twingate health; private login, Files, `zones`/`any` share redemption/revoke and audit; protected volumes present.
11. Verify no Public Share connector/gateway container, public network membership, host listener, DNS route, tunnel hostname route, NAT/firewall exception or public response remains.
12. Record exact before/after identities, rollback results and residue. A rollback without these proofs is incomplete.

Rollback never runs whole-stack `down`, never uses `-v`, never prunes, and never recreates Monitor/HUB/PostgreSQL.

## 13. S5 session checkpoints

### S5.1 — Production freeze + deployment/rollback plan

- [x] Create a clean checkout and branch from exact `d32885b36...`.
- [x] Read merged governance, canonical IDEA1 truth, architecture, newest receipts and relevant source/config.
- [x] Record G4 = approved Option B with T-14/T-27.
- [x] Freeze owner-supplied Production evidence without host access.
- [x] Write deployment, rollback, mutation, G5 and dependency boundaries.
- [ ] Run governance/vault/diff validation, create implementation/evidence checkpoint, open one Draft PR, bind the checkpoint in the Session Register and close S5.1.

### S5.2–S5.12

Each later session begins only after reviewing the prior checkpoint and obtaining the explicit mutation/gate authority named above. Every session records exact source SHA, environment, commands, pass/fail/skip counts, cleanup, limitations and next action in the same canonical Current Task/Session Register. No session creates a receipt; S5.12 creates the task's one final receipt.

## 14. S5.1 verification and stop point

Run from repository root:

```bash
node --test tests/*.test.mjs
node --test tests/collaborationPolicy.test.mjs
node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
git diff --check origin/main...HEAD
```

Run the collaboration-policy validator against the actual Draft PR body and exact changed-file list. Because the merged validator currently requires one new receipt while GOV-1 requires the receipt only at final task closeout, an in-progress S5.1 Draft PR with no receipt may report that single expected failure. Do not create an early receipt or weaken the validator to make a Draft check green; record the state and leave the task Draft.

S5.1 stops after its documentation checkpoint, normal push, Draft PR creation and CI observation. It does not begin S5.2, request G5, access the Beelink, or mutate Production.
