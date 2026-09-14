# AEGIS IDEA3 PR11 — Phase 2 Server Integration Design (Repository Preparation)

> Status: **IN PROGRESS — repository preparation only**
>
> Area / owner: `idea3` / `music`
>
> Branch: `feat/idea3-pr11-phase2-server-integration`, created from `origin/main`
> `c448dfb914d2480f81fbc35abfbc8e5633dd3a38`
>
> `PRODUCTION_MUTATION_AUTHORIZED = NO`
>
> This design changes IDEA3-owned repository files only. It edits no HUB,
> NGINX, Production Compose, network, firewall, certificate, DNS, IDEA1, IDEA2,
> or shared file. Every shared change below is an **integration request**, not
> an edit. `Architecture Approved != Production Mutation Authorized`.

Companion plan:
`IDEA3-AEGIS_Lockdown/docs/superpowers/plans/2026-09-15-idea3-pr11-phase2-server-integration.md`.

## 1. Authoritative starting state

```text
CURRENT_MAIN                    = c448dfb914d2480f81fbc35abfbc8e5633dd3a38 (merge of PR #131, 2026-09-14T18:49:47Z, human merge)
BRANCH_REPAIR                   = the stale local branch (base 9ea9bbfc, 0 unique commits) was renamed to
                                  local/idea3-pr11-phase2-stale-base-20260915; the task branch was recreated from origin/main
PR131                           = MERGED
KLA_PHASE1_REVIEW               = APPROVED (kraveerachat GitHub review on PR #131)
PUB_D6_REVIEW                   = NOT RECORDED (residual Phase 3/4 integration gate; never claimed as approved)
K3_CURRENT_IDEA1_WINDOW         = ACTIVE (Draft PR #130, IDEA1 S5.7 Production verification)
PRODUCTION_MUTATION_AUTHORIZED  = NO
IDEA3_PRODUCTION_DEPLOYED       = NO
```

No IDEA3 Production mutation may overlap the active IDEA1 window. Before any
future authorization, PR #130 and the live IDEA1 window are re-checked.

## 2. Carried-forward decisions (unchanged)

```text
K1_RECONCILIATION_METHOD         = SAME_ARTIFACT_HASH
K2_ROUTE_CONTRACT_RECONFIRMED    = APPROVE
K3_CURRENT_WINDOW_RULE           = APPROVE
K3_ROLLBACK_RELATION             = SHARED_RISK
K3_PUBLIC_SHARE_PROTECTION       = APPROVE
K4_IDEA3_SUBNET                  = 172.31.243.0/29
K5_NETWORK_TOPOLOGY_RECONFIRMED  = APPROVE
K7_HUB_RECREATE_PLAN_RECONFIRMED = APPROVE
K7_ROLLBACK_OWNER                = kraveerachat
K9_MACHINE_ROUTE_RECONFIRMED     = APPROVE
K9_MACHINE_SNI                   = idea3-core.aegis.internal
K10_DEDICATED_CLIENT_CA          = YES
K10_CA_KEY_CUSTODIAN             = kraveerachat
K10_CORE_KEY_CUSTODIAN           = music
K10_CERT_VALIDITY_POLICY         = approximately 90 days; renew around day 60 with a short overlap
K10_EXPIRY_BEHAVIOR              = PAUSE_DISPATCH
K12_REBOOT_PERSISTENCE           = VERIFY_AT_NEXT_PLANNED_REBOOT
D6_IDEA2_CORE_CORESIDENCE        = APPROVE in Music's decision package (Pub review NOT RECORDED)
```

These decisions are not reopened here. This design implements the IDEA3 side
and records exact requests for the parts other owners hold.

## 3. Verified source findings (at `c448dfb9`)

| ID | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | The browser listener accepts only a loopback bind address | `web/server/config.js` `loopbackHost()` throws for anything other than `127.0.0.1` / `::1` | The D3 container (browser listener on `172.31.243.3`) cannot start. A proxied mode is required |
| F2 | Production marks every loopback peer as HTTPS and sets express-session `proxy: true` | `web/server/createApp.js` loopback middleware plus `sessionOptions.proxy = true` | Safe only while the bind is loopback. With `proxy: true`, express-session trusts `X-Forwarded-Proto` from **any** peer, so a non-loopback bind must not reuse this path |
| F3 | The session cookie has no `Path` (defaults to `/`) | `createApp.js` cookie options | On the shared HUB origin, the IDEA3 session identifier would also be sent to `/drive/` and `/monitor/` backends. D3 requires scoping to `/security`; identity decoupling requires it too |
| F4 | D8 is not implemented; the default express-session `MemoryStore` is used | `createApp.js` uses a store only when one is injected; `index.js`/`runtime.js` inject none | Unbounded, not intended for Production, and no periodic pruning |
| F5 | Secrets can be supplied only as environment values | `config.js` reads `SESSION_SECRET` and `AEGIS_IDEA3_ADMIN_PASSWORD_HASH` from the environment | In a container, environment values are visible through `docker inspect` and a rendered Compose model. The accepted S5.5 overlay uses a read-only secret file instead |
| F6 | No container artifacts exist | no `web/Dockerfile`, `web/.dockerignore`, or IDEA3 Compose overlay on `main` | D3 packaging is not implemented |
| F7 | Listener ports | `PORT` defaults to `8003` (browser, VERIFIED). `AEGIS_IDEA3_DISPATCH_PORT` has **no default** and must differ from `PORT` | `8004` is a deployment value proposed by this design, not a source default. It satisfies the source rules |
| F8 | The browser app already serves no machine path, in any case variant, even with an Admin session and identity headers | `web/tests/server/machineRoutes.test.js` W10 | Unchanged; re-asserted in proxied mode |
| F9 | Security headers IDEA3 actually emits (K2 enumeration) | characterization run against `createApp` / `createMachineApp`, recorded as a test in this task | See §4.10; the HUB must hide or own each one |
| F10 | `HUB-AEGIS_Entry/tests/idea3RoutingContract.mjs` does not exist on `main` | `git ls-files HUB-AEGIS_Entry` | It is a proposed new shared file (IR-3), not an existing one |
| F11 | K1 Git artifact | `git rev-parse origin/main:HUB-AEGIS_Entry/nginx.conf` = `5028b6afe49742fd6d4c36eab48691c24e00be2f`; SHA-256 `ac70bfbaf2254b3a878924635e8c76cb97961f8c464ae1de3ba61325c94668c6`; last changed `cafa4e61` (2026-08-29) | Re-verified; matches the previous audit. Live comparison still NOT PROVEN |
| F12 | K4 repository collision scan | exact `172.31.243.` matches are only IDEA1 S5.5 negative fixtures and IDEA3 decision records. Wider ranges that contain the subnet (`172.16.0.0/12`) appear only as an allowlist (`shared/host-backup-agent`) or as rejected test fixtures; no allocation overlaps. `172.31.250.x` and `172.31.254.0/29` are IDEA1 test harness values and do not overlap | `K4_REPOSITORY_COLLISION_SCAN = PASS`; the live recheck is still required |

## 4. Design

### 4.1 Topology (D3, K4, K5)

```text
Browser ─443─▶ HUB NGINX (browser block, default_server)
                  │  /security/  full path, no rewrite
                  ▼
        aegis_idea3_internal  172.31.243.0/29  internal, not attachable
          .1 gateway   .2 HUB (pinned trusted proxy)   .3 IDEA3 Web   .4–.6 reserved
                  ▼
        IDEA3 Web container
          browser listener  172.31.243.3:8003  (Express app, session/CSRF/RBAC)
          machine listener  172.31.243.3:8004  (Phase 2B only; dispatch disabled in 2A)
          data volume       aegis_idea3_web_data → /var/lib/aegis-idea3/data

Core ─443 SNI idea3-core.aegis.internal─▶ HUB machine block (Phase 2B, mTLS) ─▶ 172.31.243.3:8004
```

- IDEA3 Web joins only `aegis_idea3_internal`: no Drive, Monitor, Public Share,
  PostgreSQL, shared application bridge, or VLAN macvlan membership.
- No host `ports:` entry. HUB 443 remains the only external entry.
- `internal: true` blocks IDEA3 Web outbound traffic; the IDEA1/IDEA2 adapters
  stay `NOT_CONFIGURED` (fail closed), as today.

### 4.2 Browser listener configuration contract

| Key | Unset (current behaviour, unchanged) | Set (proxied mode, new) |
|---|---|---|
| `AEGIS_WEB_TRUSTED_PROXY` | loopback mode | one IP literal, the pinned HUB address. Unspecified addresses, CIDRs, ports, host names, and IPv4-mapped IPv6 forms are rejected |
| `AEGIS_BIND_HOST` | `127.0.0.1` or `::1` only | **required**; one IP literal naming one interface: not unspecified, not loopback, not equal to the trusted proxy |

When dispatch is enabled and proxied mode is on, `AEGIS_IDEA3_DISPATCH_TRUSTED_PROXY`
must equal `AEGIS_WEB_TRUSTED_PROXY` (D3: IDEA3 trusts **one** pinned proxy).
Loopback mode keeps every PR9 and Windows-standalone behaviour byte-for-byte.

### 4.3 Trusted-proxy boundary (browser app)

In proxied mode only:

- `app.set('trust proxy', <pinned HUB address>)` — the single IP, never a CIDR,
  `true`, or a hop count.
- express-session defers to Express's `req.secure`, so the Secure session
  cookie is issued only when the socket peer is the pinned HUB **and** the HUB
  sent `X-Forwarded-Proto: https`. The loopback HTTPS exception is not
  installed. Otherwise no session cookie is issued, which fails closed.
- `req.ip` (the login rate-limit key) comes from `X-Forwarded-For` only when
  the peer is the pinned HUB. Any other peer's forwarded headers are ignored.
- The CSRF Origin check keeps comparing `Origin` with the raw `Host` header,
  which the HUB preserves (`$http_host`).
- Browser identity is the server-side session only. The browser app never
  reads the `X-Aegis-Client-*` machine headers.

### 4.4 Session cookie scope (D3)

The session cookie is issued with `Path=<AEGIS_WEB_BASE_PATH>` (`/security` in
production; `/` when the base path is empty in development). This applies in
both modes, so the Windows standalone and PR9 composite runtimes also stop
exposing the cookie outside `/security`. The name (`aegis.idea3.sid`),
`HttpOnly`, `SameSite=Strict`, `Secure` (production), and rolling idle `maxAge`
are unchanged.

### 4.5 D8 — bounded in-memory TTL session store

A small `express-session` `Store`:

- in-memory only; nothing is written to disk. A container restart logs the
  Admin out (accepted by D8);
- each entry expires at its cookie expiry, or at `AEGIS_SESSION_IDLE_MS`
  after it was last written when no cookie expiry exists. An expired entry is
  never returned;
- capped entry count (default 256). When full, expired entries are pruned first
  and then the least-recently-written entry is evicted;
- periodic pruning on an unreferenced timer, stopped when the app closes;
- entries are stored serialized, so callers never share mutable state with the
  store.

It becomes the default store in `createApp`. An injected store (existing tests)
still wins. Login, CSRF, logout, and RBAC semantics are unchanged.

### 4.6 File-sourced secrets

`SESSION_SECRET_FILE` and `AEGIS_IDEA3_ADMIN_PASSWORD_HASH_FILE` name an
absolute file whose content (one trailing newline removed) is the value. It is
an error to set both a variable and its `_FILE` form. A read failure, relative
path, or directory fails closed. Errors never contain the file content. The
existing production secret and bcrypt policies apply to the value unchanged.

### 4.7 Image (D3)

`IDEA3-AEGIS_Lockdown/web/Dockerfile`, built with `web/` as the context:

- multi-stage: a build stage runs `npm ci` and `vite build`; the runtime stage
  installs production dependencies only and copies `server/` and `dist/`;
- base `node:22-alpine` by default (satisfies `engines.node >= 22.13.0` and
  `node:sqlite`). The Production build passes a digest-pinned `NODE_IMAGE`
  build argument and records that digest as evidence;
- application files stay root-owned and read-only to the service user. The
  runtime user is `node` (UID/GID 1000). Only `/var/lib/aegis-idea3/data`
  (the volume mount point) is owned by `node`, mode `0700`;
- no secret, `.env`, test, or local runtime file is in the context (the web
  `.dockerignore` excludes them);
- `CMD ["node", "server/index.js"]`. The server's existing SIGTERM handler
  closes both listeners and the audit repository.

### 4.8 Compose overlay (K5, K7)

`IDEA3-AEGIS_Lockdown/deploy/docker-compose.pr11-phase2.yml`. In a future
authorized window it is copied unchanged to
`/opt/aegis/runtime/idea3/idea3-phase2.yml` and appended as the fifth file of
the canonical Compose list. Ownership inside the file:

| Stanza | Owner | Review |
|---|---|---|
| `services.idea3-web`, `volumes.aegis_idea3_web_data`, `secrets.*` | Music | functional owner |
| `networks.aegis_idea3_internal` | Kla (network and address plan) | **integration review required** (IR-5) |
| `services.hub.networks.aegis_idea3_internal` | Kla (HUB membership) | **integration review required** (IR-5) |

Key properties (enforced by `web/tests/server/dockerContainerContract.test.js`):

- the network model is exactly the accepted K4/K5 model: bridge, `internal: true`,
  `attachable: false`, subnet `172.31.243.0/29`, gateway `172.31.243.1`;
- `idea3-web`: only `aegis_idea3_internal` at `172.31.243.3`; no `ports`; UID/GID
  1000; `read_only: true`; `tmpfs /tmp`; `cap_drop: ALL`; `no-new-privileges`;
  `pull_policy: never` (an unreviewed registry image can never be pulled); an
  image tag bound to the reviewed web source commit; readiness health check;
  file-sourced secrets only; dispatch disabled (Phase 2A);
- `hub`: the overlay adds only the network membership at `172.31.243.2`. It adds
  no `depends_on`, so an IDEA3 failure can never block the HUB;
- no other service is named;
- the overlay's environment passes the production configuration loader in
  both Phase 2A (dispatch disabled) and Phase 2B (dispatch enabled) form.

### 4.9 Staging — Phase 2A and Phase 2B (recommendation for Music)

The accepted blocker matrix places K10 (certificates) on Phase 3, while K9 DNS
and certificate evidence is not proven. NGINX cannot pass `nginx -t` with a
machine block whose server certificate, client CA, and CRL files do not exist.
This design therefore **recommends** two separately authorized windows:

- **Phase 2A — browser route.** IDEA3 Web container, the network, the HUB
  recreate, the `/security/` browser route, and the browser-block machine-path
  404. Dispatch stays disabled and there is no machine SNI block. It has no
  certificate dependency.
- **Phase 2B — machine route.** The machine SNI block with mTLS and CRL, and
  `AEGIS_IDEA3_DISPATCH_ENABLED=true` (a one-value overlay change). It starts
  only after the K9 DNS/SNI evidence and the K10 issuance evidence exist.

The 17-step execution sequence in §6 is kept. The certificate part of step 7
and step 16 run only in Phase 2B. This is a sequencing recommendation, not a
changed decision. If Music prefers a single window, 2A and 2B combine after
the K10 evidence exists.

### 4.10 IDEA3 security-header inventory (K2 enumeration)

Recorded by `web/tests/server/productionRuntime.test.js`:

| Header | Browser app value (all routes) | Edge action proposed in IR-1 |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self';base-uri 'self';font-src 'self';form-action 'self';frame-ancestors 'none';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' 'unsafe-inline';upgrade-insecure-requests;connect-src 'self'` | hide; emit the same policy (parity) |
| `Cross-Origin-Opener-Policy` | `same-origin` | hide; emit the same |
| `Cross-Origin-Resource-Policy` | `same-origin` | hide; emit the same |
| `Origin-Agent-Cluster` | `?1` | hide; emit the same |
| `Referrer-Policy` | `no-referrer` | hide; emit the same |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | hide; emit the same |
| `X-Content-Type-Options` | `nosniff` | hide; emit the same |
| `X-DNS-Prefetch-Control` | `off` | hide; emit the same |
| `X-Download-Options` | `noopen` | hide; emit the same |
| `X-Frame-Options` | `SAMEORIGIN` | hide; emit **`DENY`** (intentionally stricter; consistent with `frame-ancestors 'none'` and the HUB server policy) |
| `X-Permitted-Cross-Domain-Policies` | `none` | hide; emit the same |
| `X-XSS-Protection` | `0` | hide; emit the same |
| `Cache-Control` | `no-store` (application shell and API); `public, max-age=31536000, immutable` (hashed assets) | pass through (K2 allows it) |
| `Permissions-Policy` | not emitted by IDEA3 | edge adds the HUB policy |

The machine app emits Helmet defaults plus `Cache-Control: no-store`; its
responses are JSON for the Core, never rendered by a browser.

`style-src 'unsafe-inline'` remains IDEA3's declared policy. Whether the built
UI works under a stricter edge `style-src` stays NOT PROVEN (K2 residual);
the proposal keeps parity with IDEA3's declared policy.

## 5. Integration requests — no shared file is edited by this task

`INTEGRATION_CHANGE_REQUIRED = YES`

### IR-1 — HUB browser route `/security/` (Phase 2A)

- **Path:** `HUB-AEGIS_Entry/nginx.conf` (and its Production artifact after K1)
- **Owner / reviewer:** Kla (`kraveerachat`), K1 single editor; Music reviews the IDEA3 contract
- **Precondition:** K1 `SAME_ARTIFACT_HASH` PASS — the live
  `/etc/nginx/conf.d/default.conf` SHA-256 equals
  `ac70bfbaf2254b3a878924635e8c76cb97961f8c464ae1de3ba61325c94668c6`. Phase 0
  observed runtime drift markers, so a mismatch is likely and Kla reconciles
  first. An expanded `nginx -T` digest is never a substitute.
- **Reason:** K2 route contract, D3.
- **Proposed diff (against Git `5028b6af`):**

```diff
@@ HUB — static landing page + reverse proxy @@
 server {
-    listen 443 ssl;
-    listen [::]:443 ssl;
+    listen 443 ssl default_server;
+    listen [::]:443 ssl default_server;
     http2 on;
     server_name _;
@@ after the existing `location /monitor/ { … }` block, inside the same server @@
+    # ─── /security/* → IDEA3 Security Center (172.31.243.3:8003) ─────────
+    # Full path, no rewrite: IDEA3 mounts /security itself. One pinned proxy.
+    location = /security { return 301 /security/; }
+
+    # The browser block never serves the IDEA3 machine route, in any case
+    # variant (K2/K9). The machine route exists only on the mTLS SNI block.
+    location ~* ^/security/api/machine(/|$) { return 404; }
+
+    location /security/ {
+        proxy_pass http://172.31.243.3:8003;
+        proxy_http_version 1.1;
+        proxy_set_header Host $http_host;
+        proxy_set_header X-Forwarded-For $remote_addr;
+        proxy_set_header X-Forwarded-Proto https;
+        proxy_set_header X-Forwarded-Host "";
+        proxy_set_header X-Real-IP "";
+        proxy_set_header Forwarded "";
+        proxy_set_header X-Aegis-Client-Verify "";
+        proxy_set_header X-Aegis-Client-Dn "";
+        proxy_connect_timeout 5s;
+        proxy_read_timeout 60s;
+        client_max_body_size 64k;
+
+        proxy_hide_header Content-Security-Policy;
+        proxy_hide_header Cross-Origin-Opener-Policy;
+        proxy_hide_header Cross-Origin-Resource-Policy;
+        proxy_hide_header Origin-Agent-Cluster;
+        proxy_hide_header Referrer-Policy;
+        proxy_hide_header Strict-Transport-Security;
+        proxy_hide_header X-Content-Type-Options;
+        proxy_hide_header X-DNS-Prefetch-Control;
+        proxy_hide_header X-Download-Options;
+        proxy_hide_header X-Frame-Options;
+        proxy_hide_header X-Permitted-Cross-Domain-Policies;
+        proxy_hide_header X-XSS-Protection;
+
+        add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests; connect-src 'self'" always;
+        add_header Cross-Origin-Opener-Policy "same-origin" always;
+        add_header Cross-Origin-Resource-Policy "same-origin" always;
+        add_header Origin-Agent-Cluster "?1" always;
+        add_header Referrer-Policy "no-referrer" always;
+        add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
+        add_header X-Content-Type-Options "nosniff" always;
+        add_header X-DNS-Prefetch-Control "off" always;
+        add_header X-Download-Options "noopen" always;
+        add_header X-Frame-Options "DENY" always;
+        add_header X-Permitted-Cross-Domain-Policies "none" always;
+        add_header X-XSS-Protection "0" always;
+        add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
+    }
```

Notes for the reviewer:

- `add_header` inside the location stops inheritance from the server block, so
  the full set is declared here, as the existing `/drive/` location does.
- The literal upstream address avoids a DNS dependency. The HUB starts even
  when IDEA3 is down; only `/security/` returns 502.
- NGINX normalizes `%XX` escapes and merges slashes before location matching,
  so encoded or doubled variants of the machine path still hit the 404 block.
- `X-Forwarded-For $remote_addr` is a single-hop overwrite. IDEA3 trusts it
  only from `172.31.243.2`.

### IR-2 — HUB machine SNI block (Phase 2B)

- **Path:** `HUB-AEGIS_Entry/nginx.conf`, plus certificate files under the HUB
  certificate mount
- **Owner / reviewer:** Kla; Music reviews the IDEA3 contract
- **Preconditions:** IR-1 in place; K9 name non-collision and Core resolution
  evidence; K10 machine server certificate, client CA, and CRL present
- **Reason:** K9, K10, D5
- **Proposed block (appended after the browser server block):**

```nginx
# ─── IDEA3 machine route — idea3-core.aegis.internal (mTLS, Core only) ───
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name idea3-core.aegis.internal;

    ssl_certificate         /etc/nginx/certs/idea3-core.aegis.internal.crt;
    ssl_certificate_key     /etc/nginx/certs/idea3-core.aegis.internal.key;
    ssl_protocols           TLSv1.2 TLSv1.3;
    ssl_ciphers             HIGH:!aNULL:!MD5;
    ssl_prefer_server_ciphers on;

    ssl_client_certificate  /etc/nginx/certs/idea3-machine-client-ca.crt;
    ssl_crl                 /etc/nginx/certs/idea3-machine-client-ca.crl;
    ssl_verify_client       on;
    ssl_verify_depth        1;

    location /security/api/machine/v1/ {
        proxy_pass http://172.31.243.3:8004;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Aegis-Client-Verify $ssl_client_verify;
        proxy_set_header X-Aegis-Client-Dn $ssl_client_s_dn;
        proxy_set_header Cookie "";
        proxy_set_header Origin "";
        proxy_set_header X-Forwarded-For "";
        proxy_set_header X-Forwarded-Proto "";
        proxy_set_header X-Forwarded-Host "";
        proxy_set_header X-Real-IP "";
        proxy_set_header Forwarded "";
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        client_max_body_size 8k;
    }

    location / { return 404; }
}
```

- The machine route reaches only port 8004 (the machine app). The browser
  block reaches only port 8003 (the browser app), which has no machine route
  (W10). Route separation is enforced by listener, not only by path.
- `$ssl_client_verify` is `SUCCESS` only after verification against the
  dedicated client CA and CRL. IDEA3 additionally requires the pinned HUB peer,
  exactly one subject CN equal to `AEGIS_IDEA3_DISPATCH_EXPECTED_SUBJECT`, and
  no Cookie or Origin header.
- **Use a separate server certificate** for `idea3-core.aegis.internal`. Do not
  add the name to the browser certificate: a shared certificate lets a browser
  coalesce HTTP/2 connections across the two server blocks.
- The expected subject `idea3-core` is the S2 fixture value. The final CN is set
  at K10 issuance, and the overlay value must equal it.

### IR-3 — HUB routing and header-parity contract test (new shared file)

- **Path:** `HUB-AEGIS_Entry/tests/idea3RoutingContract.mjs` (does not exist;
  to be created with IR-1)
- **Owner / reviewer:** Kla; Music reviews
- **Contract to assert** (using the existing `tests/helpers/nginxConfig.mjs`
  parser, in the style of `driveCspParity.test.mjs`):
  1. the browser block is `default_server` on 443 (IPv4 and IPv6);
  2. `location = /security` returns `301 /security/`;
  3. `location /security/` proxies to exactly `http://172.31.243.3:8003` with
     no URI part and no `rewrite`;
  4. a `~*` location `^/security/api/machine(/|$)` returns 404 in the browser block;
  5. the `/security/` location overwrites `Host $http_host`,
     `X-Forwarded-For $remote_addr`, `X-Forwarded-Proto https`, and clears
     `X-Forwarded-Host`, `X-Real-IP`, `Forwarded`, `X-Aegis-Client-Verify`, and
     `X-Aegis-Client-Dn`;
  6. every header in §4.10 is hidden by `proxy_hide_header` and re-added with
     `always`. The edge CSP equals the CSP that IDEA3 `createApp` emits,
     compared directive by directive. `X-Frame-Options` is `DENY`;
  7. Phase 2B: exactly one server block with `server_name idea3-core.aegis.internal`
     has `ssl_verify_client on`, `ssl_client_certificate`, `ssl_crl`,
     `ssl_verify_depth 1`, one proxied location
     `/security/api/machine/v1/` → `http://172.31.243.3:8004`, identity headers
     from `$ssl_client_verify` / `$ssl_client_s_dn`, cleared Cookie, Origin, and
     forwarded headers, and `location /` returning 404;
  8. the existing `/drive/`, `/monitor/`, and `/monitor/internal` blocks are
     unchanged.

### IR-4 — address-plan record

- **Path:** `Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/network/VLAN-IP-Plan.md`
- **Owner / reviewer:** Kla
- **Proposed record:** `aegis_idea3_internal` — bridge, internal, not
  attachable; `172.31.243.0/29`; `.1` gateway, `.2` HUB (the pinned trusted
  proxy), `.3` IDEA3 Web, `.4`–`.6` reserved; members HUB and IDEA3 Web only.
  Mark it ALLOCATED / NOT CREATED until the live network exists.

### IR-5 — Kla-owned stanzas in the IDEA3 overlay, and the canonical Compose list

- **Paths:** `IDEA3-AEGIS_Lockdown/deploy/docker-compose.pr11-phase2.yml`
  (`networks.aegis_idea3_internal`, `services.hub.networks`), and the future
  Production file `/opt/aegis/runtime/idea3/idea3-phase2.yml`
- **Owner / reviewer:** Kla (network, HUB membership, canonical file list,
  K7 rollback owner)
- **Request:** review the two Kla-owned stanzas; confirm that the HUB's
  Compose service is named `hub` and that project `aegis-prod` uses the four
  files in §6.1. Then approve the five-file canonical list for every future
  `docker compose up`.

### IR-6 — PKI and DNS (K9, K10) — no repository change

- **Owner:** Kla (CA key offline, server certificate, CRL, DNS/SNI name);
  Music (Core key and CSR generated on the Core; the key never leaves it)
- **Request:** when Phase 2B is scheduled, provide
  `idea3-core.aegis.internal.crt`/`.key` (server), `idea3-machine-client-ca.crt`,
  and `idea3-machine-client-ca.crl` under the HUB certificate mount; a
  `clientAuth`-only client certificate for CN `idea3-core` (about 90 days);
  and Core name resolution. Nothing is generated by this task.

## 6. Future Production package — PREPARED, NOT EXECUTED

No step below runs without Music's separate Production authorization, a closed
IDEA1 window (PR #130 re-checked), and Kla's integration acceptance of IR-1 and
IR-5 (plus IR-2 and IR-6 for Phase 2B).

### 6.1 Read-only owner evidence (owner-run; a missing output is never a PASS)

```bash
# K1 — SAME_ARTIFACT_HASH (compare with ac70bfbaf2254b3a878924635e8c76cb97961f8c464ae1de3ba61325c94668c6)
sudo docker exec aegis-prod-hub-1 sha256sum /etc/nginx/conf.d/default.conf
sudo sha256sum /opt/aegis/runtime/nginx/nginx.production.conf

# K4 — live collision recheck
sudo docker network ls --format '{{.ID}} {{.Name}}'
sudo docker network inspect $(sudo docker network ls -q) \
  --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{.Gateway}} {{end}}'
ip -4 route show table all
ip -4 addr show

# K3 — Public Share baseline
sudo systemctl cat aegis-public-share-connector.service
sudo sha256sum \
  /opt/aegis/runtime/docker-compose.production.yml \
  /opt/aegis/runtime/public-share/drive-s5-3.yml \
  /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
  /opt/aegis/runtime/public-share/connector-s5-5.yml
sudo systemctl is-active \
  aegis-public-share-connector.service \
  aegis-public-share-drift.timer

# K7 — HUB identity, and the canonical file list as Compose recorded it
sudo docker inspect aegis-prod-hub-1 \
  --format '{{json .Config.Image}} {{json .HostConfig.RestartPolicy}} {{json .Mounts}} {{json .NetworkSettings.Networks}}'
sudo docker inspect aegis-prod-hub-1 \
  --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{index .Config.Labels "com.docker.compose.project.config_files"}}'

# K9 — current NGINX server/mTLS markers, browser certificate, and name resolution
sudo docker exec aegis-prod-hub-1 nginx -T 2>/dev/null |
  grep -nE 'server_name|ssl_verify_client|ssl_client_certificate|ssl_crl|location .*security'
openssl x509 \
  -in /opt/aegis/runtime/certs/aegis.crt \
  -noout -subject -issuer -dates -ext subjectAltName
getent ahosts idea3-core.aegis.internal
```

The second `docker inspect` line is added by this design. It records the HUB's
service name and the config files Compose actually used. The four-file order
below is NOT PROVEN until it matches.

### 6.2 Phase 2A execution (17-step sequence)

```bash
F4="-f /opt/aegis/runtime/docker-compose.production.yml \
    -f /opt/aegis/runtime/public-share/drive-s5-3.yml \
    -f /opt/aegis/runtime/public-share/drive-gateway-s5-4.yml \
    -f /opt/aegis/runtime/public-share/connector-s5-5.yml"
F5="$F4 -f /opt/aegis/runtime/idea3/idea3-phase2.yml"
```

1. **Capture** the HUB image, mounts, networks, and configuration hashes
   (§6.1), plus `cp -p` snapshots of the NGINX artifact and the four Compose
   files. Record them.
2. **Capture** the `/drive/`, `/monitor/`, and Public Share baseline: health
   codes, connector and drift-timer state, and firewall validation output.
3. **Render and validate** the five-file model without printing values:
   `sudo docker compose -p aegis-prod $F5 config --quiet` and
   `sudo docker compose -p aegis-prod $F5 config --services` (expect the
   existing services plus `idea3-web` only). Place the overlay byte-identical to
   Git; record its SHA-256.
4. **Build** the immutable image from a web tree identical to the commit named in
   the overlay tag: `git diff --quiet <tag-sha> HEAD -- IDEA3-AEGIS_Lockdown/web`,
   then `sudo docker build --build-arg NODE_IMAGE=node:22-alpine@sha256:<verified>
   -t aegis-idea3-web:pr11-phase2-<tag-sha> IDEA3-AEGIS_Lockdown/web`. Record
   the image ID and the base digest.
5. **Start IDEA3 Web first:** `sudo docker compose -p aegis-prod $F5 up -d --no-deps idea3-web`
   (this creates `aegis_idea3_internal`).
6. **Require readiness `READY`:**
   `sudo docker exec aegis-prod-idea3-web-1 wget -qO- http://172.31.243.3:8003/security/api/readiness`
   and health status `healthy`. Also check that `docker port` is empty and that
   IDEA3 Web's only network is `aegis_idea3_internal` at `.3`.
7. **Validate the proposed NGINX configuration** with the HUB image in an
   isolated, network-less container (`--network none`, the proposed
   `default.conf` and the certificate mount read-only) and run `nginx -t`.
   *Phase 2B also:* the machine certificate, client CA, and CRL present and
   within validity.
8. **Recreate the HUB only:** `sudo docker compose -p aegis-prod $F5 up -d --no-deps --force-recreate hub`,
   with the reviewed NGINX artifact in place.
9. **Never** run `docker compose down`.
10. **Verify HUB health:** `/healthz` 200; HUB networks = previous set plus
    `aegis_idea3_internal` at `.2`.
11. **Verify** `/drive/healthz`.
12. **Verify** `/monitor/healthz`.
13. **Verify** `/monitor/internal` returns 404.
14. **Verify the `/security` redirect** (301 to `/security/`); `/security/` 200;
    `/security/api/readiness` `READY`; the session cookie is `Path=/security`,
    Secure, HttpOnly, SameSite=Strict after an owner login.
15. **Verify browser machine-route rejection:**
    `/security/api/machine/v1/dispatch/pending` and case variants return 404
    on the browser SNI.
16. *Phase 2B only:* **verify mTLS.** From the Core host (the key never leaves
    it), a valid client certificate gets 200; no certificate, a wrong-CA
    certificate, or a revoked certificate is rejected; the browser SNI with the
    machine path returns 404.
17. **Verify Public Share unchanged:** the four Compose hashes, the connector
    and drift-timer state, and firewall validation equal the step 2 baseline.

### 6.3 Rollback (Kla-owned, K7)

1. Restore the step 1 snapshot of the NGINX artifact.
2. Run `nginx -t` on the restored artifact (isolated HUB image, as in step 7).
3. Recreate the HUB only with the previous list:
   `sudo docker compose -p aegis-prod $F4 up -d --no-deps --force-recreate hub`.
4. Stop and remove IDEA3 Web only:
   `sudo docker compose -p aegis-prod $F5 stop idea3-web` then
   `sudo docker compose -p aegis-prod $F5 rm -f idea3-web`.
5. Remove `aegis_idea3_internal` only after
   `sudo docker network inspect aegis_idea3_internal --format '{{len .Containers}}'`
   prints `0`: `sudo docker network rm aegis_idea3_internal`.
6. Preserve the data volume `aegis_idea3_web_data`; never remove it.
7. Reverify Drive (`/drive/healthz`).
8. Reverify Monitor (`/monitor/healthz`, `/monitor/internal` 404).
9. Reverify the HUB (`/healthz`, networks equal the step 1 capture).
10. Reverify the Public Share connector state.
11. Reverify firewall validation.
12. Reverify the drift timer.

Rollback never sends `RESTORE_UPLINK` and never touches Core or hardware state.

## 7. Evidence state after this task

| Item | State | Note |
|---|---|---|
| K1 | NOT PROVEN | Git side re-verified (F11); the live hash is owner evidence |
| K3 current window | ACTIVE | PR #130 Draft |
| K4 repository scan | PASS | F12 |
| K4 live recheck | NOT PROVEN | owner evidence before network creation |
| K5 | MODEL IMPLEMENTED IN REPOSITORY / NOT DEPLOYED | overlay plus contract test |
| K7 | SEQUENCE AND ROLLBACK PREPARED / NOT EXECUTED | live baseline recheck required |
| K9 | ROUTE CONTRACT PROPOSED (IR-2) / DNS AND CERTIFICATE NOT PROVEN | |
| K10 | PREREQUISITES LISTED (IR-6) / NOTHING ISSUED | |
| K12 | NOT PROVEN / VERIFY AT NEXT PLANNED REBOOT | |
| D3 | SOURCE AND PACKAGING PREPARED / LOCAL TEST ONLY | image build and container run NOT RUN locally (no Docker daemon available) |
| D8 | SOURCE IMPLEMENTED / LOCAL TEST ONLY | |
| D6 | Pub review NOT RECORDED | Phase 3/4 gate; not affected by Phase 2 |

## 8. Invariants

```text
Repository Implemented != Production Deployed
Local test != Live Production evidence
Architecture Approved != Production Mutation Authorized
Route Present != Machine Authentication
TLS != mTLS
Reference != Ownership
nginx -T digest != SAME_ARTIFACT_HASH evidence
Absence of output != PASS
```
