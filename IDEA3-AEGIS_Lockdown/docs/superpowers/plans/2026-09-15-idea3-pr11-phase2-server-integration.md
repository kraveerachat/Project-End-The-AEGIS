# AEGIS IDEA3 PR11 — Phase 2 Server Integration Implementation Plan

> Status: **IN PROGRESS — repository preparation only**
>
> Design: `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-15-idea3-pr11-phase2-server-integration-design.md`
>
> Branch: `feat/idea3-pr11-phase2-server-integration` from `c448dfb914d2480f81fbc35abfbc8e5633dd3a38`
>
> `PRODUCTION_MUTATION_AUTHORIZED = NO`. No task below touches Production, a
> shared path, or another owner's file. Every source task is test-first: write
> the failing test, observe the failure for the stated reason, implement, and
> observe the pass.

## Task 0 — baseline (done)

```text
command     = npx vitest run   (IDEA3-AEGIS_Lockdown/web)
source_sha  = c448dfb9
result      = 28 files, 493 passed, 0 failed
environment = local Arch Linux checkout, Node v24.16.0
```

Docker: the CLI is present, but no daemon is reachable and there is no
`docker compose` plugin. Image build, container run, and Compose rendering are
therefore NOT RUN locally and remain Production-package steps.

## Change map

| Task | File | Owner | Requirement | Implementation | Test | Rollback | Evidence state |
|---|---|---|---|---|---|---|---|
| T1 | `web/server/config.js` | music | D3, K4, K5 | proxied browser mode: `AEGIS_WEB_TRUSTED_PROXY`; explicit non-loopback single-IP `AEGIS_BIND_HOST`; one pinned proxy shared with dispatch | `web/tests/server/config.test.js` (P2-C1, P2-C2) | revert commit; unset key = unchanged loopback mode | LOCAL VERIFIED (target) |
| T2 | `web/server/config.js` | music | D3 (container secrets) | `SESSION_SECRET_FILE`, `AEGIS_IDEA3_ADMIN_PASSWORD_HASH_FILE` | `config.test.js` (P2-C3) | revert commit; the variables still work | LOCAL VERIFIED (target) |
| T3 | `web/server/createApp.js` | music | D3, K2, K9 (IDEA3 side) | `trust proxy` pinned to the HUB in proxied mode; no loopback HTTPS exception there; session cookie `Path` = base path | `web/tests/server/productionRuntime.test.js` (P2-A1–P2-A4, P2-A6) | revert commit | LOCAL VERIFIED (target) |
| T4 | `web/tests/server/productionRuntime.test.js` | music | K2 enumeration | characterization of every security header IDEA3 emits (browser and machine app) | P2-A5 | revert commit | LOCAL VERIFIED (target) |
| T5 | `web/server/security/sessionStore.js` (new), `web/server/createApp.js` | music | D8 | bounded in-memory TTL store; default in `createApp`; closed with the app | `web/tests/server/sessionStore.test.js` (new, P2-S1–P2-S6); existing session/CSRF suites | revert commit; `MemoryStore` returns | LOCAL VERIFIED (target) |
| T6 | `web/Dockerfile` (new), `web/.dockerignore` (new) | music | D3 | multi-stage, non-root, production dependencies only, root-owned application files | `web/tests/server/dockerContainerContract.test.js` (new, P2-D1, P2-D2) | delete files | STATIC CONTRACT ONLY; build NOT RUN |
| T7 | `deploy/docker-compose.pr11-phase2.yml` (new) | music (service); **Kla** (network and HUB stanzas, IR-5) | K4, K5, K7, D3 | exact network model; `idea3-web` hardened, no ports, `pull_policy: never`; HUB membership only | `dockerContainerContract.test.js` (P2-D3–P2-D5) | delete file | STATIC CONTRACT ONLY; render NOT RUN |
| T8 | `.env.example`, `docs/operations/production-runtime.md` | music | D3 documentation | new keys and the container runtime section | review; vault and diff checks | revert commit | DOCUMENTED |
| T9 | `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`, `idea3-moc.md` | music | workflow §4–§10 | Current Task, Session Register, checkpoint SHAs | `node scripts/validate-vault.mjs` | revert commit | DOCUMENTED |

Shared paths needed later (never edited here): `HUB-AEGIS_Entry/nginx.conf`
(IR-1, IR-2), `HUB-AEGIS_Entry/tests/idea3RoutingContract.mjs` (IR-3, new),
`infrastructure/network/VLAN-IP-Plan.md` (IR-4), the Production canonical
Compose list (IR-5), and the PKI/DNS material (IR-6).

## T1 — proxied browser listener mode

Tests first (`config.test.js`, new `describe('PR11 Phase 2 proxied browser listener')`):

- P2-C1a: without `AEGIS_WEB_TRUSTED_PROXY`, loopback mode is unchanged and
  `webTrustedProxy` is `null`; `0.0.0.0` is still rejected.
- P2-C1b: with the key set, `AEGIS_BIND_HOST` is required; loopback,
  unspecified, CIDR, host-and-port, host name, and IPv4-mapped values are
  rejected; a documentation address (`192.0.2.3`, `2001:db8::3`) is accepted.
- P2-C1c: the trusted proxy must be one IP literal, not unspecified, and
  different from the bind host.
- P2-C2: with dispatch enabled in proxied mode, a different
  `AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY` is rejected; an equal one is accepted.

Expected RED: `AEGIS_BIND_HOST must be a loopback address` for P2-C1b's
accepted value, and `webTrustedProxy` undefined.

## T2 — file-sourced secrets

Tests first (P2-C3), using temporary files:

- a file value is used and its trailing newline removed; the production
  policies still apply (a weak secret in a file is rejected);
- setting both `SESSION_SECRET` and `SESSION_SECRET_FILE` is rejected (the
  same for the hash);
- a relative path, a missing file, or a directory fails closed; the error names
  the variable and never contains the file content.

## T3 — trusted-proxy boundary and cookie scope

Tests first (`productionRuntime.test.js`). supertest connects from loopback,
so the trusted proxy in these tests is `127.0.0.1` (trusted peer) or
`192.0.2.2` (untrusted peer). These are fixture values only.

- P2-A1: a trusted peer with `X-Forwarded-Proto: https` gets a Secure,
  HttpOnly, SameSite=Strict cookie with `Path=/security`, and the session works.
- P2-A2: a trusted peer without `X-Forwarded-Proto` gets no session cookie (no
  loopback exception in proxied mode).
- P2-A3: an untrusted peer sending `X-Forwarded-Proto: https` gets no session
  cookie.
- P2-A4: login rate limiting is keyed by the HUB-supplied `X-Forwarded-For` for
  the trusted peer (client A locked out, client B still gets 401). For an
  untrusted peer, `X-Forwarded-For` is ignored (one bucket).
- P2-A6: machine paths still return 404 on the proxied browser app.
- Loopback mode: the existing Secure-cookie test additionally asserts
  `Path=/security`.

## T4 — security-header inventory (P2-A5)

Assert the exact security-header names and values for the application shell,
an API route, and a hashed asset on the browser app, plus the machine app's
header names. A later Helmet upgrade that changes the set fails this test and
forces an IR-1 update.

## T5 — D8 session store

Tests first (`sessionStore.test.js`):

- P2-S1: set/get/destroy/touch/length/all/clear round-trip through the
  express-session callback API;
- P2-S2: an entry past its cookie expiry is not returned and is removed;
  without a cookie expiry, the idle TTL applies;
- P2-S3: the capacity cap evicts expired entries first, then the
  least-recently-written entry;
- P2-S4: the periodic prune removes expired entries, and `close()` stops the
  timer (fake timers);
- P2-S5: a returned session is a copy; mutating it does not change the store;
- P2-S6: `createApp` uses the bounded store by default, and login, session,
  CSRF, and logout still work.

## T6 — image

Static contract (`dockerContainerContract.test.js`):

- P2-D1: multi-stage; the build stage runs `npm ci` and `npm run build`; the
  runtime stage runs `npm ci --omit=dev`, copies only `server/` and `dist/`,
  prepares only the data directory for `node`, ends with `USER node` and
  `CMD ["node", "server/index.js"]`; no `ADD`, secret `ENV`, or `EXPOSE`; the
  default `NODE_IMAGE` major version satisfies `engines.node`;
- P2-D2: `.dockerignore` excludes `node_modules`, `dist`, `tests`, `coverage`,
  `.env`/`.env.*`, SQLite files, and `.aegis-runtime`.

## T7 — Compose overlay

Static contract, read with a small strict YAML reader in the test that fails
closed on unsupported syntax:

- P2-D3: `networks.aegis_idea3_internal` equals the accepted model exactly;
- P2-D4: `idea3-web` properties per design §4.8, and `hub` has only the
  network membership at `.2`; no other service;
- P2-D5: the overlay environment, with secret paths substituted by temporary
  files, passes `loadConfig` in production for Phase 2A (dispatch disabled)
  and Phase 2B (dispatch enabled).

The image tag names the image-input checkpoint `dbc9ad92cd3e`: `web/`
excluding `web/tests/`, which `.dockerignore` keeps out of the build context.
Any later change to the image inputs must update the tag.

## Verification bar (Task 9 of the handoff)

```bash
cd IDEA3-AEGIS_Lockdown/web && npx vitest run
git diff --check
node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
node --test tests/collaborationPolicy.test.mjs
git diff --name-status origin/main...HEAD      # ownership audit
```

Plus: added-line secret/material scan, binary scan, and a historical-receipt
mutation check (`git diff --name-status origin/main...HEAD -- Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs`
must be empty). No final Phase 2 receipt is created in this session.

## Out of scope

Any Production command; any HUB, NGINX, network, firewall, certificate, DNS,
IDEA1, IDEA2, Public Share, or PR #129 file; certificate, key, or CA
generation; marking a PR Ready; merging.
