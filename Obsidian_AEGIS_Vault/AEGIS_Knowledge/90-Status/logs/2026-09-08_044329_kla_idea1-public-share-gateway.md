---
title: Task Receipt — IDEA1 PUBLIC-SHARE-3 dedicated Public Share Gateway
date: 2026-09-08T04:43:29+07:00
owner: kla
area: idea1
branch: feat/idea1-public-share-gateway
status: partial
integration-review: yes
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 PUBLIC-SHARE-3 dedicated Public Share Gateway

## What changed

- Added a separate, share-only nginx gateway source and an isolated local
  two-container runtime harness. The only proxied surface is configured-Host
  `GET|POST /s/[A-Za-z0-9_-]+/?`; every other route, method, raw traversal form,
  and unapproved Host terminates at the gateway.
- The gateway overwrites forwarding identity, clears `Forwarded`, streams
  without proxy buffering, caps request bodies at 16 KiB, rate-limits by the
  observed edge peer, and uses URI/token/IP-free operational logs.
- Added source-structure tests and an explicit opt-in real-container runtime
  suite. The runtime suite proves positive/negative routing, header sanitation,
  body limits, throttling, self-health separation, token-safe logs, and the
  exact two-member network/container shape.
- Updated the existing IDEA1 status and architecture notes to record G3 as
  approved and distinguish locally verified gateway source from an undeployed,
  still-unavailable Public Internet Share capability. G4, G5, and G6 stay open.
- No Production action, migration, public ingress, UI enablement, root Compose,
  existing gateway, backend authorization, database, or environment change is
  included.

### PR #100 review amendment (2026-09-08)

- **Blocker A — resolved.** `PUBLIC_SHARE_HOST` reaches nginx directive context,
  so it is now validated fail-closed **before** template rendering by a new
  gateway startup script run from a new wrapper image entrypoint. A malformed
  value refuses startup instead of being sanitised, and `/tmp/nginx.conf` is
  never rendered, so nginx cannot start on an injected config. The accepted
  grammar is one RFC 1123 hostname; whitespace, multiple names, `;`, `{`, `}`,
  `$`, `/`, backslash, newline, carriage return, tab, `*`, `~`, schemes, paths,
  queries, fragments, credentials, and `host:port` all fail startup.
- **Blocker B — NOT resolved; stopped and reported as instructed.** Docker
  `internal: true` does deliver the B5 no-egress property on this host, but it
  also silently disables port publishing, which removes the localhost-only
  listener the runtime harness drives. The exact measured behavior is recorded
  under *Verification evidence* and *Known limitations*. The isolation
  requirement was **not** silently removed; the compose harness is unchanged and
  the decision is referred to owner/security review.
- **G4 neutrality documented.** The delivered header/rate-limit model is stated
  as direct-peer only in `gateway/public-share/README.md`, the architecture note,
  this receipt, and the PR body. No G4 option was chosen and no provider header
  is trusted.
- All pre-existing PR3 behavior is preserved; no backend PUBLIC-SHARE-2,
  migration, or UI change is included.

## Source files changed

- `gateway/public-share/.dockerignore` — limits the dedicated image build context.
- `gateway/public-share/Dockerfile` — pins and hardens the non-root nginx gateway image.
- `gateway/public-share/validate-public-share-host.sh` — **new**: fail-closed `PUBLIC_SHARE_HOST` hostname-grammar validation that refuses startup instead of sanitising.
- `gateway/public-share/entrypoint.sh` — **new**: image entrypoint that runs the validator before handing over to the stock nginx entrypoint, so an invalid value never reaches template rendering.
- `gateway/public-share/nginx.conf.template` — implements the share-only allowlist, forwarding-header boundary, streaming/timeouts, rate limit, redacted logs, and loopback health listener.
- `gateway/public-share/docker-compose.yml` — defines the localhost-only, two-member `aegis_public_share` source/runtime harness.
- `gateway/public-share/README.md` — documents truthful scope, local operation, subnet choice, and non-Production limitations.
- `gateway/public-share/test-recorder/Dockerfile` — pins the non-root test-only Drive recorder image.
- `gateway/public-share/test-recorder/server.mjs` — records upstream contacts for deterministic boundary assertions without AEGIS data or authorization claims.
- `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayStructure.test.js` — guards the static security shape and single-proxy-location contract.
- `IDEA1-AEGIS_Drive_LC/tests/publicShareGatewayRuntime.test.js` — opt-in Docker verification of the real generated gateway behavior and cleanup.
- `IDEA1-AEGIS_Drive_LC/docs/superpowers/plans/2026-09-08-idea1-public-share-gateway.md` — records the approved implementation and verification plan.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — records the locally verified, not-deployed PUBLIC-SHARE-3 state.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — reconciles the canonical contract with PUBLIC-SHARE-2/3 source delivery and approved G3.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-08_044329_kla_idea1-public-share-gateway.md` — this one immutable task receipt.

## Verification evidence

- `git fetch origin; git rev-parse origin/main` — passed: current `origin/main` remained `c650cf2eda1c963e9f97fab8c7c34c3644022cb3`; no reconciliation was required.
- `node --test tests/publicShareGatewayStructure.test.js` — passed: 12 tests, 12 passed, 0 failed. `PS3-STRUCT-12` executes the shipped `validate-public-share-host.sh` directly against 5 valid hostnames and 30 malformed values.
- `node --test --test-concurrency=1 tests/publicShareGatewayStructure.test.js tests/publicShareGatewayRuntime.test.js tests/publicShareBackend.test.js tests/publicShareConfig.test.js tests/trustedProxy.test.js tests/shareScopeTruthUi.test.js tests/shareRedemption.test.js` — passed: 84 tests, 78 passed, 0 failed, 6 skipped (the opt-in runtime suite and PostgreSQL-only cases).
- `$env:PUBLIC_SHARE_GATEWAY_RUNTIME='1'; node --test tests/publicShareGatewayRuntime.test.js` — passed: 15 tests, 15 passed, 0 failed; includes successful `nginx -t`, exact two-member network, positive/negative/method/Host/body/isolation checks, 11 successful upstream requests versus 30 HTTP 429 responses in the deterministic 41-request rate sequence, and a 38-character sentinel absent from logs across success, denial, throttling, and upstream failure.
- `PS3-RUNTIME-13` — passed: with `PUBLIC_SHARE_HOST=share.example.invalid` the real image renders exactly one `server_name share.example.invalid;`, matching `Host`/`X-Forwarded-Host`, and no unsubstituted `$PUBLIC_SHARE_HOST`.
- `PS3-RUNTIME-14` — passed: 11 malformed values (`empty`, `evil.example another.test`, `*.example.invalid`, `~^.*$`, `evil;return 200`, `evil${host}`, `https://evil.example`, `evil.example/path`, `evil.example:8443`, an embedded newline, and `evil.example}`) each produced the refusal message, `GATE_EXIT=1`, `NOT_RENDERED` (no generated config), and no nginx `Configuration complete` line; the container also exits non-zero under its real entrypoint. The same test proves the gate is load-bearing: with the entrypoint bypassed, `evil.example;return 200 "pwned"` renders `server_name evil.example;return 200 "pwned";` into the config.
- Blocker B measurement — `internal: true` applied to the real harness, then reverted: `docker network inspect aegis_public_share` reported `Internal=true` with exactly two members, the gateway kept one Docker network, reached `drive:8001` (`{"ok":true}`), and its egress to `1.1.1.1` returned `Network unreachable`; `drive` had no host port. But `NetworkSettings.Ports` became `{"8080/tcp":[]}` while `HostConfig.PortBindings` still held `127.0.0.1:18081->8080/tcp`, `docker port` was empty, no host listener existed, and the host connection was `ECONNREFUSED` — with no Docker warning. The runtime suite went from 15/15 to 4 passed / 11 failed, every failure being `connect ECONNREFUSED`. `com.docker.network.bridge.enable_ip_masquerade: "false"` was measured separately and did **not** block egress, so it is not a substitute. `docker-compose.yml` was restored unchanged.
- `docker ps -a --format "{{.Names}}|{{.Status}}"; docker network ls --format "{{.Name}}"; docker network inspect aegis_public_share` — passed cleanup check: the original six exited AEGIS containers and original networks remained; `aegis_public_share` no longer existed after test teardown.
- `node --test --test-concurrency=1 --test-timeout=120000 "tests/**/*.test.js"` (the `npm test` script plus an explicit per-test timeout) — failed only at the accepted pre-existing `AUTOLOCK-5`: 1,112 tests, 1,041 passed, 1 failed, 70 skipped, 137.5 s; PUBLIC-SHARE-3 introduced failures = 0. The test count rose from 1,109 to 1,112 because of the three new structural checks. PostgreSQL-only tests stayed skipped without `TEST_DATABASE_URL`; pre-existing React `act(...)` warnings remained.
- The timeout was added because a first bare `npm test` run hung indefinitely in the unrelated, pre-existing `tests/vaultChunkedUploadClient.test.js` — "concurrency 2 · ส่งสอง index ที่ต่างกันพร้อมกันจริง" (line 418). `npm test` runs with `--test-timeout=0`, so that flake blocks the suite forever. The file is untouched by this branch and exists unchanged on `origin/main`; re-running it alone reproduced the hang once and then passed 20/20, confirming a pre-existing timing flake rather than a PUBLIC-SHARE-3 regression.
- `npm run build` — passed: Vite 7.3.6 transformed 2,681 modules and built in 4.14 s; retained the existing chunk-size warning for the 609.95 kB main chunk. Generated `dist/index.html` was restored and is not part of this task.
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge` — passed with two existing owner-review warnings for the architecture/network canvas files.
POLICY_PLACEHOLDER
- `git diff --check` and `git diff --cached --check` — passed after all task files and the receipt were complete.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — added the PUBLIC-SHARE-3 local evidence, approved G3, and explicit no-deployment/no-ingress/no-UI state.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-public-share-architecture.md` — replaced stale “nothing implemented” wording with the phased current state and preserved G4/G5/G6 as open.

## Shared surfaces touched

- `gateway/public-share/.dockerignore` — infrastructure-owned build boundary required for the dedicated IDEA1 share gateway; affects only the isolated PS3 image context; rollback is PR revert.
- `gateway/public-share/Dockerfile` — infrastructure-owned container boundary required to run nginx non-root with no credentials or storage; downstream is the isolated PS3 image only; rollback is PR revert.
- `gateway/public-share/validate-public-share-host.sh` — **new**; infrastructure-owned startup control required so the operator-supplied `PUBLIC_SHARE_HOST` cannot widen the accepted `Host` set or inject nginx configuration; affects only the dedicated PS3 image's startup; rollback is PR revert.
- `gateway/public-share/entrypoint.sh` — **new**; infrastructure-owned container entrypoint required to run that validation before nginx template rendering; affects only the dedicated PS3 image's startup; rollback is PR revert.
- `gateway/public-share/nginx.conf.template` — infrastructure-owned proxy policy required for the share-only route and trust boundary; affects future IDEA1 public redemption traffic only after separately approved integration/deployment; rollback is PR revert.
- `gateway/public-share/docker-compose.yml` — infrastructure-owned network/container harness required to prove T-10 locally; creates only task-owned throwaway objects and no Production integration; rollback is PR revert plus removal of only the harness objects.
- `gateway/public-share/README.md` — infrastructure-owned operational truth required to prevent local source from being mistaken for a deployed capability; no runtime effect; rollback is PR revert.
- `gateway/public-share/test-recorder/Dockerfile` — infrastructure-owned test fixture required to prove upstream contact counts without exposing real Drive; local tests only; rollback is PR revert.
- `gateway/public-share/test-recorder/server.mjs` — infrastructure-owned test fixture required to inspect forwarded requests without AEGIS data; local tests only; rollback is PR revert.

## Integration requests

- Kla infrastructure review is required for every `gateway/public-share/**` path above, especially the dedicated two-member network/container boundary, localhost-only listener, non-root/read-only execution, header overwrite policy, and absence of credentials/storage mounts.
- Confirm that neither root `docker-compose.yml` nor existing `gateway/nginx.conf`/HUB/Drive behavior changed, and that no public ingress, DNS, TLS, NAT, tunnel, firewall, VLAN, Twingate, Production environment, or Production migration was configured.
- **Open decision required — B5 network isolation for the harness.** PR #100 review asked for Docker `internal: true` on `aegis_public_share`. It was applied and measured on the real harness (Docker 28.3.2, Docker Desktop, linux containers). It **does** deliver B5: `Internal=true`, exactly two members, gateway still reaches `drive:8001`, and gateway egress to `1.1.1.1` returns `Network unreachable`. It **also** silently disables port publishing: `HostConfig.PortBindings` keeps the requested `127.0.0.1:18081->8080/tcp`, but `NetworkSettings.Ports` becomes `{"8080/tcp":[]}`, `docker port` is empty, no host listener exists, and the host connection is `ECONNREFUSED`; Docker emits no warning. With it applied, 11 of the 15 runtime checks fail at connection setup. `com.docker.network.bridge.enable_ip_masquerade: "false"` was measured as an alternative and does **not** block egress here. Every remaining option changes an accepted PR3 property — drive the gateway from inside the container rather than through a published port, add a third client member to the dedicated network, or enforce B5 only at the PUBLIC-SHARE-6 real-stack/perimeter phase — so this needs an owner/security decision. The requirement was not silently removed and no option was chosen.
- **G4 stays open and unprejudiced.** The delivered header and rate-limit model assumes the gateway is the immediate recipient-facing HTTP peer. If G4 selects a managed reverse proxy/tunnel that inserts an HTTP hop, PUBLIC-SHARE-6 / the ingress integration task must define and review the provider trust/attribution adapter before deployment. This PR does not authorize trusting provider headers and does not claim Option B is deployable unchanged.
- Confirm the documented local harness limitation: services join only the dedicated bridge and unrelated AEGIS service names do not resolve there, but Docker `internal: true` is not set, so no network-layer or firewall-level host/IP egress claim is made by this phase. PUBLIC-SHARE-6 owns real-stack/perimeter integration and stronger deployment-specific reachability proof.
- Source rollback is PR revert. Local runtime rollback is removal of only the unique PUBLIC-SHARE-3 test project containers/network; Production rollback is not applicable because nothing was deployed.

## Known limitations

- Public Internet Share remains unavailable: no Production gateway, migration 009 application, public ingress, DNS, TLS, NAT/tunnel, firewall/VLAN/Twingate change, UI public scope, or 4G/5G acceptance exists.
- The upstream recorder proves gateway routing/header behavior, not real Drive authorization, large-file delivery, range behavior, slow clients, concurrency, or real ingress source attribution. PUBLIC-SHARE-6 owns real Drive integration acceptance.
- G4 (ingress choice), G5 (Internet exposure), and G6 (final acceptance) remain open. PUBLIC-SHARE-4/5/6/7 were not started.
- The isolated local bridge has exactly two members and no unrelated AEGIS DNS entries, but is **not** configured as Docker `internal: true`, so architecture boundary **B5** (`Gateway -> everything else = nothing`) is not enforced at the network layer and no firewall-level host/IP egress claim is made by this phase. This is the unresolved PR #100 Blocker B; see *Integration requests*.
- `PUBLIC_SHARE_HOST` validation is a **startup** control on the gateway's own configuration boundary. It proves the generated nginx config cannot be widened or injected by a malformed environment value; it is not a runtime request-path control and it does not validate that the configured hostname matches any deployed DNS record, certificate, or `PUBLIC_SHARE_BASE_URL` value, because nothing is deployed.
- The delivered header/rate-limit model is **direct-peer only**: `X-Forwarded-For`/`X-Real-IP` come from `$remote_addr` and the edge limit is keyed on `$binary_remote_addr`. This is correct for a gateway that directly observes the recipient connection and is **not** claimed to be compatible with a G4 option that inserts a managed tunnel/reverse-proxy hop.
- Full `npm test` retains the unrelated, pre-existing `AUTOLOCK-5` failure and 70 skips, including PostgreSQL-only cases without `TEST_DATABASE_URL`; React `act(...)` warnings are unchanged. The build retains its existing >500 kB chunk warning.
- `tests/vaultChunkedUploadClient.test.js` carries a pre-existing timing flake that can hang the whole suite because `npm test` sets no per-test timeout. It is unrelated to this branch and is not fixed here; running the suite with `--test-timeout=120000` bounds it.
- `npm ci` reported 6 dependency audit findings (4 moderate, 2 high); no dependency or lockfile was changed and `npm audit fix` was not run.
