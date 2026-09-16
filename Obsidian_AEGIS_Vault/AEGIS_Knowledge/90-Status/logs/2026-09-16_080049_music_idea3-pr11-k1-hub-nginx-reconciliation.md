---
title: Task Receipt — IDEA3 PR11 K1 HUB NGINX reconciliation and IDEA3 edge routes
date: 2026-09-16T08:00:49+07:00
owner: music
area: idea3
branch: infra/idea3-k1-hub-nginx-reconciliation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 K1 HUB NGINX reconciliation and IDEA3 edge routes

## What changed

- Executed the accepted K1 decision `ACCEPT_LIVE_AS_NEW_CANONICAL_AND_RECONCILE_GIT` in the repository, in two separate commits so review can read them apart:
  - `1ccde5b7` replaces the stale reviewed artifact (`ac70bfba…`) with the owner-captured live bytes (`16cee162…`), unmodified;
  - the closeout commit adds the IDEA3 edge routes on top of that baseline.
- Production was not touched, and Production was never rolled back to the stale Git artifact.
- **Live-vs-Git delta adopted** (IDEA1/infrastructure drift; no IDEA3 content was live): `resolver_timeout 5s` added and the resolver comment reworded; `/monitor/` upstream moved from the literal `192.168.10.12:8002` to the Docker name `monitor:8002` through `$monitor_upstream`; `/drive/` CSP commentary trimmed while the CSP directive itself stayed identical; two blank-line differences.
- **IR-1 added to `nginx.conf`:** `default_server` on both 443 listeners; `location = /security` → 301; a case-insensitive `^/security/api/machine(/|$)` → 404 guard in the browser block; and `location /security/` proxying the full path to `172.31.243.3:8003` with no rewrite, single-hop forwarded headers, cleared `X-Aegis-Client-*`, and the twelve IDEA3 headers hidden and re-declared (`X-Frame-Options: DENY`).
- **IR-2 prepared but inactive:** the machine mTLS server block lives in `HUB-AEGIS_Entry/nginx.idea3-machine-phase2b.conf` and is **not** included by `nginx.conf`. Including it now would make `nginx -t` fail on the absent certificate, client-CA, and CRL files, and Phase 2A installs `nginx.conf` as it stands.
- **IR-3 added:** `HUB-AEGIS_Entry/tests/idea3RoutingContract.test.mjs` asserts preservation of Drive, Monitor, `/monitor/internal`, health, landing, TLS and resolver behavior, the IR-1 contract, the IR-2 file contract, and that the browser artifact never references port 8004 or `ssl_verify_client`.
- K3 is recorded CLEAR from merged IDEA1 evidence (PR #141 at `721b7978`), which supersedes the PR #140 request for a separate written confirmation.
- Base SHA: `721b797860063729b7c3c280161dcb908d0ff7f5`. Implementation checkpoint: `1ccde5b7` (live baseline); the closeout commit SHA is recorded in the PR.

## Source files changed

- `HUB-AEGIS_Entry/nginx.conf` — live artifact adopted as the baseline, then the IR-1 `/security` route, the machine-path 404 guard, and `default_server` added.
- `HUB-AEGIS_Entry/nginx.idea3-machine-phase2b.conf` — new; the reviewed Phase 2B mTLS server block, not included by `nginx.conf`.
- `HUB-AEGIS_Entry/tests/idea3RoutingContract.test.mjs` — new; the HUB routing and preservation contract.

## Verification evidence

- `node --test HUB-AEGIS_Entry/tests/*.test.mjs` — pass: 31 tests, 31 passed, 0 failed (includes the pre-existing `driveCspParity` and `driveTransferEdge` suites).
- `node --test tests/*.test.mjs` (5 repository policy files) — pass: 63 passed, 0 failed.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — pass, with the two pre-existing canvas owner-data warnings.
- `node scripts/validate-collaboration-policy.mjs --event <synthetic event with the PR body> --changed-files <git diff --cached --name-status origin/main>` — pass, for both a Draft and a Ready event.
- `sha256sum` of the owner-captured artifact — pass: `16cee162…3722`, equal to the value the owner reported and to the running HUB and host file recorded in PR #136 and PR #140.
- `git show 1ccde5b7:HUB-AEGIS_Entry/nginx.conf | sha256sum` — pass: `16cee162…3722`, so the baseline commit holds the live bytes unmodified.
- `diff <(git show 1ccde5b7:HUB-AEGIS_Entry/nginx.conf) HUB-AEGIS_Entry/nginx.conf` — pass: 82 added lines and 2 removed lines, the removals being only the two `listen 443 ssl` lines replaced by their `default_server` forms.
- `git diff --check` and `git diff --cached --check` — pass.
- Secret scan of the three changed paths — pass: 0 matches in both NGINX artifacts. The single hit in the test file is line 229, the literal `-----BEGIN` inside the test's own assertion that the artifact contains no key material; it is a self-match of the scan pattern, not credential material.
- Binary/artifact scan of the changed paths — pass: 0 binary files.
- Receipt count — pass: exactly 1 added receipt (this file), 0 modified.
- `nginx -t` — **NOT RUN.** The workstation has no nginx binary and no Docker daemon. Syntax validation runs against the HUB image in an isolated, network-less container before any Production install (Phase 2A step S6).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — adds the K1 section as the current entry point with its state block, Current Task and Session Register; records K3 CLEAR from PR #141; demotes the PR #140 pre-mutation package section to history; updates the lead paragraph.

## Shared surfaces touched

- `HUB-AEGIS_Entry/nginx.conf` — the shared HUB edge artifact. K1 makes the reviewed file equal the accepted live artifact and adds the IDEA3 browser route. Kla owns this surface; review is requested here. Rollback is `git revert` of this PR, which restores the stale artifact in Git only and changes nothing in Production.
- `HUB-AEGIS_Entry/nginx.idea3-machine-phase2b.conf` — new shared HUB file, reviewed now and activated only in the separately authorized Phase 2B window.
- `HUB-AEGIS_Entry/tests/idea3RoutingContract.test.mjs` — new shared HUB test that pins both the preserved IDEA1/IDEA2 routes and the IDEA3 additions.

## Integration requests

- **Kla (`kraveerachat`) — approve-only review.** APPROVE accepts this reconciliation exactly as written at the approved head; REQUEST_CHANGES rejects it. No comment or decision line is required, and an empty approval body is valid.
- **Kla — Phase 2A operational note.** Installing this artifact is a separate authorized window. `nginx -t` must pass in the HUB image first, and the HUB is recreated with the accepted two-file Compose model.
- **Kla — Phase 2B prerequisites (K9, K10).** The machine block activates only once the server certificate with SAN `idea3-core.aegis.internal`, the dedicated IDEA3 client CA, and its CRL exist under the HUB certificate mount, and the Core certificate has been issued from a CSR generated on the Core.
- **IDEA1/IDEA2 owners — no action required.** Their routes are unchanged; the contract test now fails if a future change alters them.

## Known limitations

- `nginx -t` has not run anywhere. Syntax is proven only structurally, by the parser-based contract test.
- The IR-1 route is repository-reviewed only. Until the Phase 2A window creates `aegis_idea3_internal` and the IDEA3 Web container, `/security/` would answer 502.
- The Phase 2B file is inert: no certificate, client CA, or CRL exists, and nothing includes it yet.
- K8, K9 and K10 remain BLOCKED; K12 remains NOT PROVEN.
- K3 is CLEAR from merged owner records; the execution-time recheck immediately before any Production mutation still applies.
- No Production, Docker, Compose, NGINX, DNS, certificate, PKI, firewall, network, systemd, Core, broker, AP, firmware, GPIO, CUT, RESTORE, or reboot action occurred.
