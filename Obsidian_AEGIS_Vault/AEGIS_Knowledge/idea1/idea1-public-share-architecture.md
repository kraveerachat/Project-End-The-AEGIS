---
title: IDEA1 Public Share Gateway — Architecture and Threat Model
tags: [aegis, idea1, share-links, architecture, threat-model, public-gateway, security]
type: concept
created: 2026-09-07
updated: 2026-09-11
sources: ["[[idea1/idea1-status]]", "[[core/security-architecture]]"]
owner: kla
edit_policy: owner-writable
---

# 🌐 IDEA1 Public Share Gateway — Architecture and Threat Model

> [!success] S5.4 infrastructure accepted; Internet exposure remains absent
> The Public Share backend contract, managed-edge Gateway, Drive State B,
> dedicated edge network `172.31.240.0/29`, and dedicated upstream network
> `172.31.241.0/29` are **IMPLEMENTED / ACCEPTED**. S5.4 is **CLOSED / PASS**
> through merged PR #116 at `9ea9bbfcf40128f4565bc4ba37ba008a62c4879c`.
> The hardened Production Gateway runs only on edge `172.31.240.2` and upstream
> `172.31.241.2`; Drive is upstream `172.31.241.3`; connector edge
> `172.31.240.3` remains reserved. S5.4 also accepted an isolated internal
> public-scope stream through the Gateway and ended with zero active public
> shares. See
> [[90-Status/logs/2026-09-11_042000_kla_public-share-s5-4-gateway-networks]]
> and `gateway/public-share/production/README.md`.
>
> This is not Internet availability. The egress network, real `cloudflared`
> connector, host firewall S5.5 implementation, public hostname binding,
> public DNS/TLS route, external 4G/5G acceptance, and Public Share UI
> activation are **NOT IMPLEMENTED YET**. Internet exposure is **NONE**;
> Public Internet Share is **NOT IMPLEMENTED / NOT EXTERNALLY ACCEPTED**.

> [!important] S5.5 current state — S5.5-A and S5.5-B closed; implementation plan established; runtime NOT STARTED
> S5.5 is **IN PROGRESS** with S5.5-A and S5.5-B **CLOSED / PASS**. The fresh
> Production read-only firewall/runtime preflight matched S5.2 assumptions and
> the accepted S5.4 topology. The owner-approved S5.5-B specification is
> `docs/superpowers/specs/2026-09-11-idea1-public-share-s5-5-cloudflared-egress-isolation-design.md`,
> and the 16-task test-driven implementation plan mapped across canonical phases
> S5.5-C through S5.5-H is recorded at
> `docs/superpowers/plans/2026-09-11-idea1-public-share-s5-5-implementation.md`.
> `PRODUCTION MUTATION ALLOWED = NO` for this checkpoint. No S5.5 overlay,
> egress network, executable firewall policy, connector, tunnel, DNS, TLS,
> public route, or feature-flag change exists yet.
>
> The design preserves `docker-compose.s5-4.yml` unchanged and requires a new
> `docker-compose.s5-5.yml`. It freezes egress `172.31.242.0/29` / bridge
> `aegis-ps-eg`, connector edge `.240.3` + egress `.242.2`, TCP/7844-only
> HTTP/2, a file-delivered tunnel token, `DOCKER-USER` forwarding plus a
> supplemental INPUT guard, systemd fail-closed activation with periodic drift
> enforcement, and connector-only rollback. Gateway remains edge + upstream;
> Drive never joins egress. Nine pinned-image, DNS, packet-path, firewall-atomicity
> and restart gates must pass before any Production mutation. S5.5-C through S5.5-H
> remain **NOT STARTED** and require separate owner approval.

> [!important] Domain and exposure truth
> `aegistk-pb.com` is **OWNED**. `share.aegistk-pb.com` is the intended
> hostname, but `DNS_PUBLIC_ROUTE = NOT CONFIGURED`,
> `TLS_PUBLIC_ROUTE = NOT CONFIGURED`, and `INTERNET_EXPOSURE = NONE`.
> G5 and G6 remain **OPEN**, and the Public Share UI remains **OFF**.

> [!important] Current G4 decision — architecture approved; public route not deployed
> **G4 = APPROVED — §13 Option B / Managed Tunnel.** The site is behind measured
> upstream NAT/CGNAT, inbound forwarding is not practical, and the existing
> perimeter has no inbound Internet listener. The chosen path is Cloudflare Edge
> HTTPS → named Cloudflare Tunnel → isolated outbound-only `cloudflared`
> connector → dedicated Public Share Gateway → dedicated Gateway→Drive network.
> The owner accepts T-14 (the provider may observe or log the bearer URL) and
> T-27 (recipient attribution relies on provider-asserted identity accepted only
> through the pinned-connector adapter). This decision does **not** approve G5,
> prove connector isolation, or claim Internet exposure. Public Internet Share
> remains NOT IMPLEMENTED.

---

## 1. Purpose

Let an external recipient download one authorised AEGIS file over ordinary
Internet access — home Wi-Fi, someone else's Wi-Fi, a mobile hotspot, 4G/5G —
**without** Twingate, an AEGIS account, an AEGIS VLAN, or any route to
`aegis.internal`.

This note fixes the architecture, the trust boundaries, the route contract, the
scope contract, the configuration contract, the threat model, the ingress
decision matrix, and the PR sequence that gets there. Later PRs now implement
the backend contract and dedicated gateway source while keeping deployment and
Internet exposure behind their explicit gates.

The single principle everything below is derived from:

> **Expose the minimum file-redemption capability necessary for an external
> recipient, not AEGIS itself.**

A public gateway that can reach `/api/*` is not a smaller version of this
feature. It is a different, much worse feature.

---

## 2. Current verified state

### 2.1 What the code actually does today

Read from `origin/main` at `478059949d`. Paths are exact.

| Concern | Where | Behaviour |
| :--- | :--- | :--- |
| Redemption routes | `IDEA1-AEGIS_Drive_LC/server/routes/share.js` | `GET /s/:token` and `POST /s/:token`, mounted at Express **root** by `app.use(shareRouter)` in `server/app.js` |
| Token storage | `server/db/store.js` · `schema.sql` | 256-bit `randomBytes(32).toString('base64url')`; only `sha256Hex(token)` is stored in `shares.token_hash`; the raw token is returned exactly once from `POST /api/shares` |
| Link password | `server/db/store.js` | bcrypt cost 12, minimum 8 characters (`MIN_LINK_PASSWORD`), compared server-side with `bcrypt.compare` |
| Failure disclosure | `server/routes/share.js` | Unknown, revoked, trashed, expired and Vault-backed tokens all render one identical `404` "link unavailable" page; out-of-scope renders `403` |
| Scope enforcement | `server/routes/share.js` `ipAllowed()` | `scope='zones'` snapshots `network_zones` CIDRs into `shares.vlan_scope` **at creation time** and compares them against the canonical request source |
| Request source | `server/request/sourceIp.js` | The only accessor. Returns `req.ip`; routes never parse forwarding headers themselves |
| Proxy trust | `server/config/trustedProxy.js` | `TRUSTED_PROXY_CIDRS`; in production it must be **exactly one** CIDR and it must be `172.19.255.2/32` |
| Brute force | `server/auth/rateLimit.js` | 5 attempts, then exponential lockout 1 min → 1 h, on two axes (`share\|<token-hash>` and `share\|<source-ip>`), namespaced by scope so share guessing cannot lock the login page |
| Delivery headers | `server/routes/share.js` `deliver()` | `application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''…`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` |
| Password page CSP | `server/routes/share.js` `page()` | Per-response `default-src 'none'; style-src 'nonce-…'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`, plus `Referrer-Policy: no-referrer` and `noindex,nofollow`. The page contains **zero JavaScript** |
| Vault exclusion | `store.createShare` + `resolveShare` | Enforced twice: a Vault file cannot be shared, and a stale share row pointing at a Vault file cannot be redeemed |
| Ownership | `store.createShare` / `store.revokeShare` | Creation requires `files.uploaded_by === req.user.id`; revoke is an owner-scoped atomic mutation. There is **no Admin cross-owner bypass** |
| Hit counting | `store.countShareHit` | Incremented only inside `deliver()`, after every gate passes. Seeing the password form and failing the password do not count |

Two scopes exist. `SCOPES = new Set(['any', 'zones'])` in `store.js`; the table
constraint is `CHECK (scope IN ('any','zones','vlan','subnet'))`, where `vlan`
and `subnet` are legacy values retained only so historical rows stay valid.

### 2.2 Repository-recorded acceptance

From [[idea1/idea1-status]], "Secure Share production findings (2026-08-23)" and
the B4.3 table (2026-08-24):

| Probe | Canonical source observed | Result |
| :--- | :--- | :--- |
| Restricted share from direct source `172.18.0.6` | `172.18.0.6` | 200; `SHARE_REDEEM / OK` |
| Same restricted share from `172.18.0.7` | `172.18.0.7` | 403; `SHARE_REDEEM_OUT_OF_SCOPE / BLOCKED` |
| Restricted share from Windows/Twingate endpoint `192.168.0.104` | `172.19.255.1` | 403; `SHARE_REDEEM_OUT_OF_SCOPE / BLOCKED` |
| Unrestricted `scope=any` share over Twingate | `172.19.255.1` | 200; 40 bytes delivered; `SHARE_REDEEM / OK` |

Secure Shares is **PASS / CLOSED for the private/internal scope**. Both existing
modes are production-verified and **must not regress**.

> [!note] Owner-supplied acceptance recorded separately
> The PUBLIC-SHARE-1 task brief additionally reports a VLAN30 acceptance run
> (Management VLAN30 `192.168.30.0/24`, client `192.168.30.10`, Twingate off,
> direct `192.168.10.10:443` reachable, restricted share allowed, wrong password
> denied, 1 MiB download, length `1048576`, SHA-256 match, revoke and
> revoked-link denial all PASS) and a `scope=any` remote-PC-over-Twingate run
> with the same download/integrity/hit-counter/revoke results. Those figures are
> **owner-supplied and are not reproduced by this task**; they are consistent in
> shape with the B4.3 evidence above, which is what the repository itself
> records. This note does not merge the two into a single claim.

### 2.3 Public Internet sharing today

```text
Public Internet Share = NOT IMPLEMENTED
```

With Twingate off and only ordinary remote Internet, `aegis.internal` does not
resolve and `192.168.10.10:443` is unreachable. Therefore:

```text
Any AEGIS-reachable network != Public Internet Share
```

`scope=any` means *no additional share-layer CIDR restriction*. It does **not**
mean the recipient can reach AEGIS. The UI already says this truthfully:
`strings.js` carries `publicShareUnavailable: 'NOT AVAILABLE'` and
`publicShareBody` explaining that a separate share-only public gateway would be
required, in English, Thai and Chinese, rendered by `PublicInternetNotice` in
`src/screens/Shares.jsx`. That honesty must survive every future PR until
PUBLIC-SHARE-7 actually passes.

---

## 3. Non-goals

This architecture deliberately does **not** aim to:

- publish the Drive frontend, `/api/*`, `/drive/*`, `/admin/*`, `/settings/*` or
  `/internal/*` on the Internet, in any reduced or authenticated form;
- make `aegis.internal` publicly resolvable or publicly routable;
- replace Twingate for private access, or change any Twingate policy;
- give the public gateway a database credential, a session secret, a Vault key,
  or filesystem access to the Data Lake;
- make Vault files shareable under any scope;
- introduce an Admin cross-owner share bypass;
- add Redis or any new runtime dependency in the PUBLIC-SHARE-1..3 window;
- claim 20–30 GB transfer capability, which remains untested — see
  [[concepts/Large_File_Transfer_V2]];
- change `zones` or `any` semantics, storage, or acceptance status.

---

## 4. Required target architecture

```text
External Internet recipient
        │  HTTPS (public DNS name, public certificate)
        ▼
┌───────────────────────────────────────────────┐
│ Public Share Gateway                          │
│ · default-deny route allowlist                │
│ · strips and re-writes every forwarding header│
│ · TLS termination                             │
│ · no application state, no DB, no storage     │
└───────────────────────────────────────────────┘
        │  tightly restricted internal request path
        │  (dedicated Docker network, one upstream,
        │   only /s/:token reaches it)
        ▼
AEGIS Share Redemption Backend  (existing shareRouter in Drive)
        │
        ▼
AEGIS Data Lake  (existing fileStore stream)
```

Private access is unchanged and stays on its own path:

```text
LAN / VLAN30 / Twingate ──► https://aegis.internal ──► HUB (172.19.255.2) ──► Drive
```

Four structural decisions.

**D1 — A separate nginx server, not a new `location` on HUB.** HUB's
`location /drive/` in `HUB-AEGIS_Entry/nginx.conf` forwards *everything* under
`/drive/` to Drive; it is an allow-all prefix with child locations only for
tuning. Adding a public listener to that server block would put the entire Drive
surface one nginx-config mistake away from the Internet. The public gateway is a
different container, a different config file, a different certificate, and a
different network. Its config's only job is to be small enough to audit in one
screen.

**D2 — The public gateway is stateless.** It holds no secret, no database
handle, no volume mount of `/datalake`, and no session material. Compromising it
yields the ability to make requests the Internet could already make, plus the
plaintext of downloads in flight. It must not yield anything else.

**D3 — Drive keeps every authorisation decision.** The gateway does not read
tokens, does not check expiry, does not evaluate scope, and does not decide who
gets bytes. It is a route filter and a header sanitiser. This preserves the
Server-Side Enforcement principle in [[core/security-architecture]]: the gateway
is not permitted to become a second, weaker policy engine.

**D4 — A dedicated Docker network, `aegis_public_share`.** The gateway must not
join `aegis_internal` (which reaches PostgreSQL and Monitor) and must not join
`aegis_drive_proxy` (which is HUB's private identity `172.19.255.2/29`). It gets
its own /29 with exactly two members: the gateway and Drive.

B5 is made a property of the network by **two** controls, not one:

```text
internal: true      -> removes normal external/default-route connectivity
gateway_mode_ipv4
  = "isolated"      -> removes the Docker-host bridge address for that network
together            -> source/test enforcement of the B5 Docker-network boundary
```

`internal: true` alone is necessary but not sufficient: an ordinary internal
bridge still keeps the Docker-host bridge address, and appropriately configured
host services stay reachable through it. Docker Engine 28 adds bridge gateway
mode `isolated`, valid alongside `internal`, which removes that address. No
member publishes a host port either, since Docker cannot publish one from an
internal network.

---

## 5. Trust boundaries

| # | Boundary | Left side | Right side | What crosses | What must never cross |
| :--- | :--- | :--- | :--- | :--- | :--- |
| B1 | Internet → gateway | Anyone | Public Share Gateway | `GET`/`POST /s/:token`, TLS | Any other path or method; any forwarding header the client supplies |
| B2 | Gateway → Drive | Public Share Gateway | Drive `:8001` | The rewritten `/s/:token` request plus gateway-authored `X-Forwarded-*` | Requests to `/api`, `/healthz`, static assets, or any other Drive route |
| B3 | Drive → Data Lake | Drive process | `fileStore` stream | One read stream for one authorised `file_id` | Any path derived from user input |
| B4 | HUB → Drive | HUB `172.19.255.2` | Drive `172.19.255.3` | The existing private `/drive/*` surface | Public traffic (HUB is not on the public network) |
| B5 | Gateway → everything else | Public Share Gateway | PostgreSQL, Monitor, HUB, host | **Nothing.** No network path exists | Any connection at all |

The critical property of B1/B2 together: **a request arriving at Drive on the
public path is indistinguishable, to Drive, from any other request except for its
source address.** Drive therefore cannot be asked to "trust the gateway" about
anything. Everything the gateway asserts must be either irrelevant or
independently re-derived.

### 5.1 The trusted-proxy constraint is a hard, code-level blocker

This was the single most important implementation finding of PUBLIC-SHARE-1 and
is now closed in source by PUBLIC-SHARE-2.

At the PUBLIC-SHARE-1 base, `IDEA1-AEGIS_Drive_LC/server/config/trustedProxy.js`
contained:

```js
const APPROVED_PRODUCTION_PROXY_CIDRS = new Set(['172.19.255.2/32'])
// …
if (env.NODE_ENV === 'production'
    && (cidrs.length !== 1 || !APPROVED_PRODUCTION_PROXY_CIDRS.has(cidrs[0]))) {
  throw new Error(`${REQUIRED_NAME} must contain only the approved HUB proxy identity`)
}
```

PUBLIC-SHARE-2 replaced that one-state source rule with the two explicitly
enumerated states in §5.1.1. Production still runs the first (HUB-only) state;
merely adding an environment value outside either approved state still makes
Drive **refuse to boot**.

That constraint is not an obstacle to route around; it is the control that made
B4.3's spoof resistance provable, and it exists because trusting a broad range
once already made cookie security and source attribution deployment-dependent.
Two options, and only two:

- **P1 (recommended) — widen the approved set to a second explicitly named
  identity**, e.g. `172.19.254.2/32` for the public gateway, keeping the
  "exactly N explicitly approved identities" rule rather than relaxing it to
  "any value the operator supplies". This is a deliberate, reviewed source change
  in PUBLIC-SHARE-2/3 with its own tests, not a config tweak.
- **P2 — chain the public gateway through HUB.** Rejected: it re-introduces the
  full Drive surface into the public request path at exactly the place D1 exists
  to keep it out of, and it makes HUB a public-facing component.

**Decision: P1.** The public gateway becomes a second named, pinned proxy
identity. `FORBIDDEN_SHARED_RANGES` and the "no broad CIDR" rules stay. The
existing `tests/trustedProxy.test.js` TP-R1..R8 rejection cases must all still
pass unchanged.

#### 5.1.1 Two approved production modes, not one widened rule

P1 must not become "production now requires two proxies". Drive has to keep
starting safely in the window between PUBLIC-SHARE-2 (which lands the backend
contract) and PUBLIC-SHARE-3/6 (which actually deploys a gateway), and it has to
keep starting after a gateway rollback. The approved production configuration is
therefore an **enumerated set of exactly two legal states**, not a relaxed rule:

```text
Legacy / private mode   (default, and the only state today)
  trusted set = exactly { HUB /32 }

Public-gateway-enabled mode
  trusted set = exactly { HUB /32, one approved public-gateway /32 }
```

Everything else is refused at boot, exactly as today. In particular these all
still fail: a public-gateway identity **without** HUB; an unapproved /32; any
prefix shorter than /32; any `FORBIDDEN_SHARED_RANGES` value; duplicate or
ambiguous entries; and a third proxy of any kind.

The second identity is **optional until the rollout phase that needs it**. Absent
⇒ legacy mode, `requestIngressKind()` can never return `public-gateway`, and the
§7.4 rule is inert rather than broken. That is the same fail-closed shape as
`PUBLIC_SHARE_BASE_URL` in §8.1: the feature is unavailable, not
half-configured.

---

## 6. Public route contract

### 6.1 Allowed

```text
GET  /s/:token
POST /s/:token
```

Nothing else. Default-deny, expressed as a default-deny, not as a list of
blocks — `location / { return 404; }` is the fallthrough, and the two share
routes are the only exceptions.

The gateway must serve the routes at the **public** path `/s/:token`, not
`/drive/s/:token`. Drive mounts `shareRouter` at root, so no prefix rewrite is
needed on the public path at all; the mapping is identity. The private path keeps
its existing `/drive/s/:token` → `/s/:token` rewrite through HUB, unchanged. The
two URL shapes are independent and both remain valid — a share created today
keeps working on the private path whether or not it is also public.

### 6.2 Route-matching rules the config must obey

These are not stylistic; each closes a bypass that already exists elsewhere in
this repository.

1. **Case-insensitivity.** Express matches paths case-insensitively by default.
   nginx prefix locations are case-sensitive. `HUB-AEGIS_Entry/nginx.conf` already
   documents this exact defect class for `/monitor/internal/` — and
   `gateway/nginx.conf` still carries the unfixed case-sensitive variant, tracked
   as open in [[summaries/08_Outstanding_Items_Consolidated]]. The public gateway
   must use anchored, case-insensitive regex: `location ~* ^/s/[A-Za-z0-9_-]+/?$`.
2. **Token charset anchoring.** Tokens are `base64url`, so `[A-Za-z0-9_-]+` is
   the complete alphabet. Anchoring both ends means `/s/x/../api/files` cannot
   match.
3. **Method allowlist.** `if ($request_method !~ ^(GET|POST)$) { return 405; }`
   inside the location. Drive already rejects other methods, but the public edge
   should not forward them at all.
4. **Query strings are ignored, not forwarded as routes.** Drive already splits
   on `?` before comparing paths in the telemetry agent pattern; the gateway must
   not let a query string select a different upstream location.
5. **No `proxy_pass` with a URI suffix**, and `rewrite ... break` before it, per
   the convention the existing configs already document.

### 6.3 Explicitly forbidden on the public listener

`/`, `/drive/`, `/drive/api/*`, `/api/*`, `/admin/*`, `/settings/*`,
`/internal/*`, `/healthz`, `/monitor/*`, static assets, and every path not
matching §6.1 — all `404`, from the gateway, without contacting Drive.

A gateway health check, if one is needed, is served **by the gateway itself**
(`return 200`) and must not proxy to Drive's `/healthz`, which reports database
and storage state that the Internet has no business reading.

---

## 7. Share scope contract

### 7.1 Three distinct meanings

```text
zones  = application CIDR restriction using zone CIDRs snapshotted at creation
any    = no additional share-layer CIDR restriction, but AEGIS must already be reachable
public = intentionally redeemable through the dedicated Public Share Gateway
```

**`scope=any` must never be overloaded to mean public.** They are different
decisions by the sharer: `any` says "I am not adding a network restriction";
`public` says "I accept that anyone on the Internet holding this URL can fetch
this file". Collapsing them would silently make every existing `any` share
Internet-redeemable the moment a gateway is deployed — a retroactive exposure of
links whose creators never agreed to it. This mirrors the reasoning already
recorded in `store.createShare` for snapshotting zone CIDRs instead of reading
them live.

### 7.2 Server-side representation

- `store.js`: `SCOPES = new Set(['any', 'zones', 'public'])`.
- Migration `009_public_share_scope.sql`: drop and re-add `shares_scope_check` as
  `CHECK (scope IN ('any','zones','public','vlan','subnet'))`, preserving the two
  legacy values exactly as migration `181–188` in `schema.sql` already does.
  Additive and idempotent, per the migration rule established by LFT-V2-A: the
  migration must grant `drive_app` explicitly rather than relying on
  `ALTER DEFAULT PRIVILEGES` from a possibly different superuser.
- `vlan_scope` stays `'{}'` for `public`, exactly as for `any`. `ipAllowed()`
  needs no change: an empty CIDR list already means "no share-layer restriction".
- **`users.share_default_scope` is deliberately NOT widened.** Its constraint
  stays `CHECK (share_default_scope IN ('any','zones'))`. Publishing a file to
  the Internet must be an explicit per-share choice every time, never something a
  saved preference does on the sharer's behalf.

### 7.3 Backward compatibility

Existing rows are untouched. A Drive that knows `public` and a gateway that is
not deployed yield shares that simply behave like `any` on the private path —
they are created, listed, revoked and redeemed normally, and the public URL they
advertise does not resolve. That is the correct failure: honest and inert. The
reverse (a deployed gateway with a Drive that does not know `public`) must not be
possible, which is what the rollout order in §12 enforces.

### 7.4 Does the redemption path need a scope check?

Yes, and it is the one genuinely new authorisation rule.

A `zones` or `any` share must **not** become redeemable merely because a request
arrives via the public gateway. Drive must therefore reject a non-`public` share
whenever the request **arrived through the public gateway**.

The converse is not required: a `public` share redeemed on the *private* path is
allowed, because `public` is strictly the more permissive scope and an internal
recipient could have been given an `any` link anyway.

> [!danger] Corrected during PR #97 review — do not implement this with `req.ip`
> An earlier draft of this section said the check compares the *canonical source*
> (`requestSourceIp(req)` → `req.ip`) against the public-gateway identity. **That
> is not implementable, and PUBLIC-SHARE-2 must not attempt it.**
>
> Once the gateway is a trusted proxy and correctly overwrites `X-Forwarded-For`
> with the real recipient, Express resolves `req.ip` **to the recipient**, not to
> the gateway. Measured against `express@5` + `proxy-addr` with one trusted /32
> peer that sets `X-Forwarded-For: 203.0.113.50`:
>
> ```text
> req.socket.remoteAddress = 127.0.0.1      (the trusted peer, standing in for the gateway)
> req.ip                   = 203.0.113.50   (the external recipient)
> req.ips                  = ['203.0.113.50']
> ```
>
> So `req.ip !== <gateway identity>` on every correct public request. Implementing
> the old prose literally would leave exactly two bad outcomes: non-`public`
> shares would **not** be blocked on the public ingress, or the gateway would have
> to stop forwarding the real client address — which breaks audit and rate-limit
> attribution and re-creates the T-05 self-DoS this design exists to avoid.
>
> The gateway's identity and the recipient's identity are two different facts.
> The architecture keeps them separate; see §10.1.

Concretely, in `resolveShare()`:

```text
if (share.scope !== 'public' && requestIngressKind(req) === 'public-gateway') → BLOCKED
```

`requestIngressKind()` is a **new central helper** derived from the immediate TCP
peer (`req.socket.remoteAddress`), normalised for IPv4-mapped IPv6, compared only
against explicitly pinned proxy host identities, and **never** derived from any
client-supplied header. It answers "how did this request reach me", not "who
sent it". `requestSourceIp()` is untouched and remains the sole client-source
accessor.

This is the check that makes §7.1's separation real rather than decorative, and
it is why the gateway needs its own pinned peer identity (§5.1) rather than
sharing HUB's — the pinning is what `requestIngressKind()` compares the socket
peer to.

---

## 8. Configuration contract

### 8.1 Public base URL

The backend must never hard-code a domain and must never derive the public URL
from the `Host` header. `POST /api/shares` already returns only a server-side
path (`/s/<token>`) and lets the client compose the URL; that is correct for the
private path and must stay.

For `public` shares, add one variable:

```text
PUBLIC_SHARE_BASE_URL      # e.g. https://share.example.org   (no path, no query, no trailing slash)
```

Rules:

- **Not a secret**, so it is documented in `.env.example` — but only in the
  PUBLIC-SHARE-2 implementation PR, never in this one.
- **Required if and only if** `public` is an offered scope. Absent or empty ⇒
  `public` is not selectable, `POST /api/shares` rejects `scope: 'public'` with
  the existing `400 Invalid input`, and the UI keeps showing "NOT AVAILABLE".
  Fail-closed by configuration, in the same spirit as
  `TRUSTED_PROXY_CIDRS` refusing to start rather than guessing.
- **Normalised and validated at boot**, not per request: `https://` scheme only,
  a host, no path, no query, no fragment, no credentials, no trailing slash.
  An invalid value fails startup rather than being silently coerced — the
  precedent is `MAX_SUPPORTED_LOGICAL_FILE_BYTES` failing at boot instead of
  clamping. **A trailing slash is one of those invalid values: it is rejected,
  not trimmed** (PR #99 review — PUBLIC-SHARE-2 first accepted and normalised it
  away, which would have quietly widened this already-accepted contract). The
  check runs on the raw text, because `new URL()` collapses `https://host` and
  `https://host/` to the same pathname and the distinction does not survive
  parsing. Rejecting also keeps the configured string and the emitted URL
  literally identical, so an operator reading `.env` sees exactly what recipients
  receive.
- **Used only for `public` shares.** `zones` and `any` responses keep returning
  the bare path. `POST /api/shares` returns `publicUrl` only when
  `scope === 'public'`.

```text
PUBLIC_SHARE_GATEWAY_CIDR  # e.g. 172.19.254.2/32 — the gateway's pinned PEER identity
```

This variable names **one thing used for two purposes**, and the distinction is
the correction this contract turns on:

1. it is the second entry of the approved trusted-proxy set in
   `trustedProxy.js`, which is what lets Express derive `req.ip` from the
   gateway's `X-Forwarded-For` at all (§5.1.1); and
2. it is the value `requestIngressKind()` compares the **immediate socket peer**
   against, to decide whether a request arrived through the public gateway
   (§7.4, §10.1).

It is **never** compared against `req.ip`. Same validation rules as the HUB
identity: exactly one IPv4 host CIDR (`/32`), no broad prefix, validated
independently at boot — and **not inside** any forbidden network.

> [!warning] Containment, not string equality (PR #99 review)
> "Not a forbidden range" must be evaluated by masking the host against the
> network, not by comparing the configured text to a list. Because this value is
> constrained to a single `/32`, an exact-match list only ever rejects the one
> address someone wrote down: PUBLIC-SHARE-2's first implementation refused
> `172.18.0.1/32` while accepting `172.18.0.2/32`, `172.18.1.20/32` and
> `172.18.255.254/32` — all still on the shared `aegis_internal` bridge that
> carries PostgreSQL and Monitor. The delivered code decides membership with
> `forbiddenGatewayNetworkFor(address)` and rejects every host in
> `172.18.0.0/16`.

**Optional until the gateway rollout phase needs it.** Absent or empty ⇒ legacy
private mode: the trusted set is HUB alone, `requestIngressKind()` can never
return `public-gateway`, and Drive starts exactly as it does in production today.
Drive must never be made to require a peer that has not been deployed yet.

#### 8.1.1 `PUBLIC_SHARE_HOST` — the gateway's hostname-only allowlist

The gateway container takes one variable of its own, delivered and validated by
PUBLIC-SHARE-3 in `gateway/public-share/`:

```text
PUBLIC_SHARE_HOST          # e.g. share.example.invalid — hostname ONLY
```

It must equal the **hostname component** of the backend's already-validated
`PUBLIC_SHARE_BASE_URL` (§8.1):

```text
PUBLIC_SHARE_BASE_URL=https://share.example.invalid
PUBLIC_SHARE_HOST=share.example.invalid
```

The value is not a secret, but it is substituted into nginx **directive
context** (`server_name`, `proxy_set_header Host`, `proxy_set_header
X-Forwarded-Host`), so it is an allowlist-integrity boundary in exactly the
sense §6.2 means. An operator typo or a malformed environment value must not be
able to widen the accepted `Host` set, alter nginx parsing, inject an additional
directive or `location`, turn the single-host gateway into virtual-host
multiplexing, or make the generated config ambiguous.

It is therefore **validated fail-closed before the template is rendered**, by
`gateway/public-share/validate-public-share-host.sh` running from the image's
wrapper `entrypoint.sh`. Same spirit as `PUBLIC_SHARE_BASE_URL` and
`TRUSTED_PROXY_CIDRS`: **an invalid value fails startup and is never silently
sanitised.** On refusal `/tmp/nginx.conf` is never rendered at all, so nginx
cannot start with a config the value could have altered.

The accepted grammar is one RFC 1123 host name — characters `A-Za-z0-9.-` only,
labels of 1–63 characters that neither begin nor end with `-`, no empty label,
no leading or trailing dot, at most 253 characters, and no all-numeric final
label. Whitespace, multiple names, `;`, `{`, `}`, `$`, `/`, backslash, newline,
carriage return, tab, `*`, `~`, a scheme, a path, a query, a fragment,
credentials, and `host:port` all fail startup.

**Hostname-only is a deliberate contract, not an oversight.** If the public
origin chosen at G4 needs a non-default port, PUBLIC-SHARE-6 / the ingress
integration task must explicitly reconcile the public `Host` /
`X-Forwarded-Host` contract at that point. No deployment port is invented in
advance.

#### 8.1.2 `PUBLIC_SHARE_UI_ENABLED` — the interface activation switch

The Shares screen has to answer one question: *may I offer Public Internet as a
selectable scope?* That answer belongs to the deployment, not to the bundle, so
PUBLIC-SHARE-4 adds a third optional, non-secret variable:

```text
PUBLIC_SHARE_UI_ENABLED    # exactly "true" or "false"; absent ⇒ false
```

Parsed once at boot beside the other two. Absent or empty is false; anything
that is not exactly `true` or `false` **fails the boot** rather than being
coerced, for the same reason a trailing slash on the base URL is rejected: a
truthy check turns `flase`, `0`, `yes` and `off` into silent, unreviewable
policy.

The effective answer requires all three, and each defaults to off:

```text
publicSelectable = publicShareEnabled        (PUBLIC_SHARE_BASE_URL is set)
                && publicIngressConfigured   (PUBLIC_SHARE_GATEWAY_CIDR is set)
                && publicShareUiEnabled      (this variable is "true")
```

Two properties matter more than the mechanism:

- **It is not authorization.** `POST /api/shares` still decides for itself,
  from `publicShareEnabled` alone, whether a `scope=public` share may be minted.
  Turning the interface on widens nothing; turning it off closes nothing. A test
  pins both directions, because the day this flag starts gating the API is the
  day a UI toggle silently becomes an access-control toggle.
- **It is not evidence that G6 passed.** It is the switch that G6 authorises
  someone to flip. `.env.example` ships it commented out and says so.

`GET /api/shares` carries the result to the client as one coarse boolean:

```json
{ "shares": [], "capabilities": { "publicSelectable": false } }
```

Nothing else. Not the public origin, not the pinned gateway identity, not the
dedicated Docker subnet, not the real public hostname, and not the G4 ingress
choice. The interface needs to know whether to offer the option — not where the
deployment lives. `undefined`, a missing key, a failed read and a non-boolean
all mean *unavailable*, so the client fails toward the safe answer while the
request is still in flight.

### 8.2 What must never appear in configuration or source

No certificate, no private key, no real production domain invented by an agent,
no token, no password. The hostname `share.<public-domain>` in the task brief is
a placeholder and is treated as one throughout this note.

---

## 9. Threat model

Twenty-eight threats. "Existing control" means present in `origin/main` today.
"Required additional control" is work for a later PR. "Verification test" names
the test a later PR must add or the existing test that already covers it.

### 9.1 Token and link exposure

**T-01 · Share token guessing**
- *Asset*: file bytes.
- *Attack path*: enumerate `/s/<random>` until one resolves.
- *Existing control*: 256-bit `randomBytes` base64url token; only the SHA-256 is
  stored; unknown tokens render the identical unavailable page.
- *Required additional control*: gateway-level connection/request rate limiting
  so the Internet cannot sustain high-rate enumeration against Drive.
- *Verification test*: existing `shareRedemption.test.js` "token ที่เดาสุ่ม …";
  new gateway test asserting sustained enumeration is throttled at the edge.
- *Residual risk*: negligible for guessing (2^256); the real exposure is T-02.

**T-02 · Leaked share URL**
- *Asset*: file bytes.
- *Attack path*: the URL is forwarded, posted, logged by an intermediary, or read
  from the recipient's history. The URL **is** the credential.
- *Existing control*: expiry (1 h / 24 h / 7 d / 30 d), owner revoke, optional
  link password, `Referrer-Policy: no-referrer` so the token does not leak via
  `Referer`, `noindex,nofollow`.
- *Required additional control*: the UI must require a password for `public`
  scope, or state plainly and specifically that a passwordless public link is
  readable by anyone who obtains the URL. Shorter default expiry for `public`.
- *Verification test*: UI test that `public` + `authType: 'none'` cannot be
  created silently; audit test that a redemption is recorded.
- *Residual risk*: **accepted and unavoidable.** A capability URL that works
  without login is exactly as strong as the discretion of whoever holds it.

**T-03 · Weak or reused link password**
- *Asset*: file bytes behind a password.
- *Attack path*: the sharer picks `password123`; the attacker holding the URL
  guesses it.
- *Existing control*: `MIN_LINK_PASSWORD = 8`; bcrypt cost 12; server-side
  validation.
- *Required additional control*: none mandatory. Consider a higher minimum for
  `public` scope specifically, decided by the owner rather than by an agent.
- *Verification test*: existing bcrypt-storage test.
- *Residual risk*: moderate; bounded by T-04's lockout.

**T-04 · Password brute force**
- *Asset*: file bytes behind a password.
- *Attack path*: repeated `POST /s/:token` with candidate passwords.
- *Existing control*: `rateLimit.js` — 5 attempts then 1 min → 1 h exponential
  lockout, on the token axis and the source-IP axis, scope-namespaced.
- *Required additional control*: see T-05, which is where the public path breaks
  this control.
- *Verification test*: existing "เดารหัสรัว ๆ ถูก rate limit".
- *Residual risk*: low once T-05 is resolved.

**T-05 · Rate-limit bypass and self-inflicted lockout — the public path's worst
regression risk**
- *Asset*: availability of **every** public share, plus the integrity of the
  limiter.
- *Attack path*: two directions. (a) If the gateway does not correctly attribute
  the client address, every public recipient collapses to one source IP; the
  `share|<gateway-ip>` axis then locks after any five failures **anywhere**, so
  one attacker — or one recipient mistyping a password — denies public
  redemption to everyone. This is the same class of self-DoS already found and
  fixed once in this file's history (share guessing used to lock the login page
  for a whole NAT'd office). (b) Conversely, an attacker rotating source
  addresses defeats the IP axis, leaving only the token axis.
- *Existing control*: the token axis (`share|<sha256(token)>`) is
  address-independent and still bounds per-link guessing. `X-Forwarded-For` is
  only honoured from a trusted peer.
- *Required additional control*: the gateway must set `X-Forwarded-For` to the
  real client address (§10), Drive must trust exactly that one peer so
  `requestSourceIp()` resolves to the **recipient** and not to the gateway
  (§10.1), **and** the limiter's IP axis must be scoped so that a public-path
  lockout cannot lock the private path — a distinct scope string such as
  `share-public` rather than reusing `share`. The limiter key is built from
  `requestSourceIp(req)`, never from the ingress peer; keying it on the gateway
  address *is* failure mode (a). Direction (b) is accepted: the token axis is the
  real defence.
- *Verification test*: a test proving five failures on a public share do **not**
  lock private redemption or login; a test proving forged `X-Forwarded-For` from
  a non-trusted peer does not shift the limiter key (existing B2-T11 covers the
  private shape).
- *Residual risk*: distributed guessing across many source addresses remains
  bounded only by the token axis. Documented, not eliminated.

### 9.2 Proxy, routing and surface exposure

**T-06 · Forged forwarding headers (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`)**
- *Asset*: scope enforcement, rate-limit attribution, audit truth.
- *Attack path*: client sends `X-Forwarded-For: 192.168.30.10` to appear inside an
  approved zone.
- *Existing control*: Express `trust proxy` compiled from `TRUSTED_PROXY_CIDRS`;
  `requestSourceIp()` is the only accessor and reads `req.ip`; HUB overwrites
  `X-Forwarded-For` with `$remote_addr` (not `$proxy_add_x_forwarded_for`) and
  clears `Forwarded` entirely. Proven by B4.3 and by `B2-T8`.
- *Required additional control*: the public gateway must do exactly the same —
  overwrite, never append — and additionally clear `X-Real-IP` from the client.
  See §10. Separately, **ingress provenance must not be derivable from any header
  at all** (§10.1): a forged header can at worst mis-state a client address to a
  trusted-peer walk, but it must never be able to make
  `requestIngressKind()` return `public-gateway`, because that helper reads the
  socket peer only.
- *Verification test*: existing `B2-T8`; new equivalent on the public path; plus
  a direct test that a non-gateway peer sending arbitrary `X-Forwarded-For`,
  `X-Real-IP` and `Forwarded` never yields `ingress = public-gateway`.
- *Residual risk*: low, provided the gateway config is not later "improved" to
  `$proxy_add_x_forwarded_for`, which would append attacker-controlled values.

**T-07 · Route traversal / unintended proxy routes**
- *Asset*: the entire private Drive surface.
- *Attack path*: `/s/../api/files`, `/S/<token>`, `/s/<token>/../../api`,
  encoded traversal, or a case variant slipping past a case-sensitive prefix
  location.
- *Existing control*: Drive compares exact paths and never builds filesystem
  paths from the URL. Existing tests cover `/../../etc/passwd` on the telemetry
  socket; the share route is reached only by exact match.
- *Required additional control*: §6.2 — anchored case-insensitive regex with a
  restricted token charset, and a `location / { return 404; }` fallthrough.
- *Verification test*: a negative-route suite that fires every forbidden path in
  §6.3 plus traversal and case variants against the gateway and asserts `404`
  **and** asserts Drive never received the request.
- *Residual risk*: low; this is the highest-value test in PUBLIC-SHARE-5.

**T-08 · Accidental exposure of the full AEGIS Drive**
- *Asset*: everything.
- *Attack path*: someone adds a `location /` proxy, or reuses HUB's server block,
  or the gateway is given the wrong upstream.
- *Existing control*: none — this risk is created by the feature.
- *Required additional control*: D1 (separate server/config/container), D4
  (dedicated network), the default-deny fallthrough, and a CI structural test
  that fails if the public config contains any `proxy_pass` outside the `/s/`
  location.
- *Verification test*: config-structure test in CI, plus the T-07 negative suite.
- *Residual risk*: **the dominant risk of this whole feature.** It is a
  configuration risk, not a code risk, which is why §12's gates are procedural.

**T-09 · Host header poisoning**
- *Asset*: generated URLs, CSRF origin checks, cache keys.
- *Attack path*: attacker sets `Host: evil.example` and the application echoes it
  into a link or a redirect.
- *Existing control*: `POST /api/shares` returns a path, never an absolute URL;
  the share pages contain no absolute links; `form-action 'self'`; the password
  form uses `method="post"` with no `action`, so it posts to the current URL.
- *Required additional control*: `PUBLIC_SHARE_BASE_URL` from configuration only
  (§8.1); the gateway should reject or normalise an unexpected `Host` rather than
  forward arbitrary values.
- *Verification test*: a test asserting the public URL in the create response
  equals the configured base regardless of the request `Host`.
- *Residual risk*: low.

**T-10 · Direct backend access bypassing the gateway**
- *Asset*: scope enforcement (§7.4), rate attribution.
- *Attack path*: something on the internal network calls Drive `:8001/s/<token>`
  directly, or the public gateway's upstream address is reachable from elsewhere.
- *Existing control*: Drive is `expose`-only, never `ports:`-published; only HUB
  shares its proxy network.
- *Required additional control*: the `aegis_public_share` network has exactly two
  members; Drive gains no published port; and the §7.4 check keys on the **socket
  peer** against the pinned gateway identity (§10.1), so a caller that is not
  physically the gateway cannot claim public provenance no matter what it sends.
  Note the direction of this control: it prevents a non-gateway caller from
  *gaining* public provenance. A direct internal caller is treated as private
  ingress, which is the safe default — it can still redeem a `public` share, but
  a `public` share is by definition the most permissive scope.
- *Verification test*: Compose structural test asserting Drive publishes no port
  and the public network has exactly the two expected members.
- *Residual risk*: low.

### 9.3 Content, response and cache handling

**T-11 · Malicious filename / response-header injection**
- *Asset*: the recipient's browser; response integrity.
- *Attack path*: a filename containing CR/LF or quotes breaks out of
  `Content-Disposition`.
- *Existing control*: `filename*=UTF-8''${encodeURIComponent(share.fileName)}` —
  percent-encoding removes CR, LF, quotes and semicolons. The HTML pages escape
  through `esc()`.
- *Required additional control*: none. Do not "improve" this to a plain
  `filename=` parameter.
- *Verification test*: a redemption test with a filename containing `"`, `;`,
  `\r\n` and non-ASCII, asserting one well-formed header.
- *Residual risk*: low.

**T-12 · Browser rendering of active uploaded content**
- *Asset*: the public origin; recipients.
- *Attack path*: an uploaded `.html` or `.svg` is served inline and executes in
  the gateway's origin.
- *Existing control*: `Content-Type: application/octet-stream` +
  `X-Content-Type-Options: nosniff` + `attachment` on every redemption; the
  password page's own CSP is `default-src 'none'`.
- *Required additional control*: the gateway must not add `Content-Type`
  sniffing, must not strip `nosniff`, and must not serve any file inline.
- *Verification test*: existing header assertions, repeated at the gateway
  boundary against an uploaded HTML file.
- *Residual risk*: low, and lower still because the public origin hosts no
  authenticated session to steal.

**T-13 · Cache leakage**
- *Asset*: file bytes and the password page.
- *Attack path*: a CDN, corporate proxy or browser caches a download and serves
  it to someone else, or a shared cache keys on path alone.
- *Existing control*: `Cache-Control: no-store` on both the password page and the
  download.
- *Required additional control*: the gateway must not add `proxy_cache`, must not
  rewrite `Cache-Control`, and — if Option B (a managed tunnel/CDN) is chosen —
  caching must be explicitly disabled at the vendor edge, which is a real
  operational difference between the two ingress options.
- *Verification test*: header assertion at the gateway; for Option B, a manual
  vendor-configuration check recorded as evidence.
- *Residual risk*: **elevated under Option B**, because the cache is outside this
  repository's control.

**T-14 · Token or password leakage into logs**
- *Asset*: the credential itself.
- *Attack path*: nginx `access_log` records the full request URI — which contains
  the token — on every public request.
- *Existing control*: the application never logs the raw token; audit stores
  `sha256Hex` of the token for unknown tokens and the file name hash otherwise;
  `POST /api/shares` explicitly does not audit the token.
- *Required additional control*: **the gateway's access log must not record the
  token.** Either disable `access_log` on the `/s/` location, or use a custom
  `log_format` that logs a fixed `/s/[redacted]` in place of `$request`. This is
  a new requirement that has no existing counterpart, because no existing nginx
  location handles a URL that is itself a credential. Passwords travel in the
  POST body and are never in a URI, but `error_log` must not be raised to `debug`
  on this server, which would log bodies.
- *Verification test*: a config-structure test asserting the public config
  contains no default `access_log` on the share location and no `debug` error
  level.
- *Residual risk*: TLS-terminating intermediaries under Option B may log URLs
  outside our control — a genuine argument in the decision matrix.

**T-15 · Audit-log leakage**
- *Asset*: file names, source addresses, sharer identity.
- *Attack path*: an authenticated low-privilege user reads audit rows describing
  another owner's shares.
- *Existing control*: audit stores `targetHash` (SHA-256 of the file name), not
  the name; `actorLabel: 'share-link'` carries no identity; audit reads are
  behind RBAC.
- *Required additional control*: public redemptions must use the same
  hashed-target discipline. Do not add the public URL, the token, or the
  recipient's user-agent to audit rows.
- *Verification test*: existing "audit บันทึกการไถ่ลิงก์ … โดยไม่มี token ดิบปนอยู่",
  extended to the public path.
- *Residual risk*: low.

**T-16 · Expired / revoked token enumeration**
- *Asset*: knowledge of which tokens ever existed.
- *Attack path*: compare responses for random vs. expired vs. revoked tokens.
- *Existing control*: `unavailable()` renders one identical `404` for unknown,
  revoked, trashed, expired and Vault-backed. Audit distinguishes them
  server-side; the recipient never does.
- *Required additional control*: the gateway must not add distinguishing
  behaviour — no different error page, no different timing path, no upstream
  error passthrough. `proxy_intercept_errors` must not turn Drive's 404 into a
  different gateway page.
- *Verification test*: a test asserting byte-identical responses across all five
  unavailable causes at the gateway boundary.
- *Residual risk*: timing side-channels (a DB miss vs. a bcrypt compare) are not
  equalised. Accepted; the token entropy makes the oracle useless.

### 9.4 Availability

**T-17 · Large-download denial of service**
- *Asset*: host bandwidth, Drive process, Data Lake I/O.
- *Attack path*: repeatedly fetch a large public share.
- *Existing control*: none specific — `deliver()` streams, which bounds memory
  but not bandwidth.
- *Required additional control*: gateway-level concurrent-connection and rate
  limits (`limit_conn`, `limit_rate`), and an owner decision on a maximum file
  size eligible for `public` scope.
- *Verification test*: a load check in PUBLIC-SHARE-6, before Internet exposure.
- *Residual risk*: **real.** A single public link to a large file is an
  amplification primitive. Expiry and revoke are the operator's controls.

**T-18 · Concurrent-download abuse**
- *Asset*: as T-17.
- *Attack path*: many simultaneous connections to the same or different links.
- *Existing control*: none.
- *Required additional control*: `limit_conn` per source address at the gateway.
- *Verification test*: PUBLIC-SHARE-6 concurrency check.
- *Residual risk*: moderate; per-source limits are weak against distributed
  clients.

**T-19 · Slow-client / connection exhaustion**
- *Asset*: gateway and Drive worker capacity.
- *Attack path*: Slowloris-style partial requests, or a client reading one byte
  per minute from a large download.
- *Existing control*: nginx's own `client_header_timeout` / `client_body_timeout`
  defaults on the private path.
- *Required additional control*: explicit `client_header_timeout`,
  `client_body_timeout`, `send_timeout` and `limit_conn` on the public listener,
  set deliberately rather than inherited.
- *Verification test*: PUBLIC-SHARE-6.
- *Residual risk*: moderate.

**T-20 · Upstream timeout behaviour**
- *Asset*: correctness of long downloads.
- *Attack path*: not an attack — a large legitimate download exceeds
  `proxy_read_timeout` and is truncated, which a naive client may store as a
  complete file.
- *Existing control*: the private path already tunes this per route
  (`proxy_read_timeout 600s` for commits, `proxy_buffering off` for downloads).
- *Required additional control*: the public location needs its own explicit
  `proxy_read_timeout` / `proxy_send_timeout` sized to the largest file eligible
  for `public` scope, and `proxy_buffering off`.
- *Verification test*: PUBLIC-SHARE-6 with a file large enough to exceed the
  default 60 s.
- *Residual risk*: truncation is detectable by the recipient only if they check
  the length or hash. See §11.

### 9.5 Data and lifecycle

**T-21 · Accidental Vault ciphertext exposure**
- *Asset*: Vault ciphertext.
- *Attack path*: a Vault file is shared, or a stale share row points at one.
- *Existing control*: enforced twice — `createShare` returns `null` for
  `file.vault`, and `resolveShare` blocks `share.fileVault` even if a row exists.
- *Required additional control*: none. `public` scope must reuse the same
  `createShare` path so it inherits both checks; it must not get its own creation
  function.
- *Verification test*: existing "ไฟล์ใน Vault แชร์ไม่ได้", extended to assert
  `scope: 'public'` is rejected for a Vault file.
- *Residual risk*: negligible.

**T-22 · IDOR / cross-owner create or revoke**
- *Asset*: another user's files.
- *Attack path*: supply another owner's `fileId` when creating, or another
  owner's share id when revoking.
- *Existing control*: `createShare` requires `uploaded_by === user.id`;
  `revokeShare` is owner-scoped and atomic; cross-owner revoke returns the same
  `404` as missing. This was a real historical defect, fixed and recorded in
  [[idea1/idea1-status]].
- *Required additional control*: **`public` must not introduce an Admin
  cross-owner bypass.** Only the file owner may create or revoke a public share.
- *Verification test*: existing cross-owner revoke test, plus a new one asserting
  an Admin cannot create a `public` share for another owner's file.
- *Residual risk*: negligible.

**T-23 · Stale share after trash or delete**
- *Asset*: a file the owner believes is withdrawn.
- *Attack path*: trash the file, then redeem an outstanding link.
- *Existing control*: trashing revokes live shares atomically, **and**
  `resolveShare` independently blocks `share.fileDeleted` as defence in depth.
  `deliver()` also refuses when the bytes are gone rather than returning an empty
  file.
- *Required additional control*: none.
- *Verification test*: existing revoke/trash tests, repeated on the public path.
- *Residual risk*: a download already in flight completes. Accepted and
  unavoidable.

**T-24 · Public gateway compromise**
- *Asset*: whatever the gateway can reach.
- *Attack path*: an nginx vulnerability or a supply-chain compromise of the
  gateway image.
- *Existing control*: none — the component does not exist yet.
- *Required additional control*: D2 (no secrets, no DB, no volumes) and D4 (a
  two-member network) so the blast radius is exactly "requests the Internet could
  already make, plus in-flight download plaintext". Pin the base image digest;
  run as non-root; read-only root filesystem.
- *Verification test*: Compose/Dockerfile structural test asserting no secret
  env, no volume mount of the Data Lake, no `aegis_internal` membership.
- *Residual risk*: in-flight plaintext at the TLS termination point is
  unavoidable for any reverse proxy. Accepted, and it is why B5 exists.

### 9.6 Ingress and operations

**T-25 · TLS misconfiguration**
- *Asset*: confidentiality of tokens and file bytes in transit.
- *Attack path*: weak protocol/cipher, expired certificate, or plaintext HTTP
  serving the token.
- *Existing control*: the private HUB listener pins `TLSv1.2 TLSv1.3` and
  redirects HTTP→HTTPS. That config is **not** reused here (D1).
- *Required additional control*: the public listener must pin TLS 1.2+ with a
  publicly trusted certificate, redirect `:80` → `:443`, and set HSTS. TLS
  terminates at the gateway; the gateway→Drive hop stays inside the dedicated
  Docker network. Certificates and keys are **never** committed; renewal
  ownership is named in §12.
- *Verification test*: an external TLS check in PUBLIC-SHARE-7 (protocol,
  certificate chain, expiry, HSTS).
- *Residual risk*: certificate expiry is an operational failure mode with no
  code control. Monitoring is required, not optional.

**T-26 · DNS misconfiguration**
- *Asset*: availability; potential mis-issuance.
- *Attack path*: a dangling record, a wildcard pointing at a decommissioned
  address, or a record that outlives the gateway and lets someone else claim the
  name.
- *Existing control*: none — no public DNS exists.
- *Required additional control*: one specific A/AAAA (or CNAME for Option B)
  record, no wildcard, with the removal step written into the rollback plan
  (§13) **before** the record is created.
- *Verification test*: PUBLIC-SHARE-7 resolution check; a documented post-rollback
  check that the name no longer resolves.
- *Residual risk*: dangling-record takeover is the classic failure here, which is
  why §13 removes DNS first and last.

**T-27 · Multi-proxy attribution errors**
- *Asset*: audit truth, scope enforcement, rate-limit fairness.
- *Attack path*: with two proxies now in front of Drive (HUB and the public
  gateway), a request's canonical source becomes ambiguous, or a CDN adds another
  hop whose header format differs.
- *Existing control*: exactly one approved proxy identity today, which is why
  attribution is currently unambiguous; the Twingate endpoint-IP limitation is
  already recorded honestly rather than papered over.
- *Required additional control*: exactly two pinned identities, each on its own
  network, each overwriting forwarding headers — and the §10.1 split, which is
  what actually removes the ambiguity: the *ingress* is read from the socket peer
  and the *client* from the trusted-proxy walk, so the two facts can never be
  mistaken for one another regardless of how many hops exist. Under Option B, the
  vendor edge becomes a **third** hop whose `X-Forwarded-For` the gateway must
  decide to trust or discard — an explicit decision, not a default. It does not
  change ingress provenance, because the gateway remains Drive's socket peer.
- *Verification test*: a matrix test asserting **both** identities — ingress kind
  and client source — for a request arriving via HUB, via the public gateway, and
  from a direct internal caller.
- *Residual risk*: **elevated under Option B.** Attributing a real client address
  through a vendor edge is a trust decision this project has deliberately avoided
  making twice already.

**T-28 · Rollback leaving public exposure active**
- *Asset*: everything.
- *Attack path*: the application change is rolled back but the NAT rule, DNS
  record, tunnel, or gateway container stays up — so the public path survives the
  feature it existed to serve.
- *Existing control*: none.
- *Required additional control*: §13's ordered rollback, with **ingress removed
  first**, and a post-rollback verification that the public name no longer
  resolves and the public address no longer answers.
- *Verification test*: the post-rollback check is itself the test, and it is
  mandatory evidence for the gate in §12.
- *Residual risk*: this is a process risk. It is the reason the rollback plan is
  ordered rather than a list.

---

## 10. Proxy trust and client-IP attribution

The complete chain after PUBLIC-SHARE-3, both paths:

```text
Private:  browser ──► HUB nginx (172.19.255.2) ──► Drive (172.19.255.3)
Public:   browser ──► Public Share Gateway (172.19.254.2) ──► Drive (172.19.254.3)
```

Drive trusts **exactly two** peers, each pinned to a /32, each on a separate
two-member network. Neither is a broad range; `FORBIDDEN_SHARED_RANGES` still
rejects the shared `aegis_internal` bridge.

The gateway's header handling, stated as requirements:

| Header | Gateway action | Why |
| :--- | :--- | :--- |
| `X-Forwarded-For` | **Overwrite** with `$remote_addr` | Appending (`$proxy_add_x_forwarded_for`) would preserve attacker-supplied values ahead of the real one. HUB already overwrites for `/drive/`; the public path must match. |
| `Forwarded` | Set to `""` | Clears any RFC 7239 header the client sent. HUB already does this. |
| `X-Real-IP` | **Overwrite** with `$remote_addr` | The client must not be able to supply it. |
| `X-Forwarded-Proto` | Set to `https` | Fixed, not derived from the client. |
| `X-Forwarded-Host` | Set to the configured public host | Never the raw client `Host` (T-09). |
| `Host` | Normalised to the configured public host | The public origin is single-purpose; there is no virtual-host multiplexing to preserve. |

> [!warning] The delivered PR3 model assumes the gateway is the immediate peer
> The table above, and the `$binary_remote_addr` edge rate limit that goes with
> it, are correct for a topology where the Public Share Gateway directly
> observes the recipient connection. That is the accepted direct-peer gateway
> contract, and it is what PUBLIC-SHARE-3 delivers.
>
> It must **not** be read as automatically compatible with every G4 option. A
> managed HTTP tunnel or reverse proxy (§13 Option B) inserts another trusted
> hop, and then `$remote_addr` identifies the tunnel/provider connector rather
> than the actual recipient. That would cause incorrect G3 attribution, collapse
> every recipient onto one address, and re-create the T-05 rate-limit self-DoS
> this design exists to avoid.
>
> At the PUBLIC-SHARE-3 checkpoint G4 was **OPEN**, so that phase did not trust a
> vendor header. G4 now approves Option B, and §10.2 records the subsequently
> delivered provider trust/attribution adapter. PUBLIC-SHARE-3 itself still does
> not authorize provider trust or claim a deployed tunnel.

### 10.1 Two identities, neither replacing the other

This is the single most important implementation rule in this note, and the one
PR #97's first draft got wrong.

| | **Client source identity** | **Ingress provenance** |
| :--- | :--- | :--- |
| Question it answers | *Who sent this request?* | *How did this request reach me?* |
| Accessor | `requestSourceIp(req)` → `req.ip` (unchanged) | new central helper, e.g. `requestIngressKind(req)` / `requestIngressPeerIp(req)` |
| Derived from | the trusted-proxy walk over `X-Forwarded-For` | `req.socket.remoteAddress`, the immediate TCP peer |
| Used for | `zones` CIDR enforcement, the rate-limit IP axis, the audit source address | the §7.4 `scope=public` ingress rule, and nothing else |
| For a public request | the **external recipient** | the **public gateway** |

Measured, not assumed — one trusted `/32` peer sending
`X-Forwarded-For: 203.0.113.50`:

```text
socket peer   = 172.19.254.2     # the public gateway  → ingress = public-gateway
req.ip        = 203.0.113.50     # the external client → client source
```

And with the same peer sending **no** `X-Forwarded-For`, `req.ip` falls back to
the peer address. That fallback is exactly why ingress provenance must come from
the socket peer rather than from `req.ip`: the socket peer is correct in both
cases, whereas `req.ip` is the gateway in one and the recipient in the other.

Requirements on the new helper:

- **One central helper**, in the same spirit as `sourceIp.js`. No route parses
  peer addresses ad hoc, and no route gains its own forwarding-header parsing.
- **Normalise IPv4-mapped IPv6** (`::ffff:172.19.254.2` → `172.19.254.2`) with
  the same care `share.js`'s `normalizeIp()` already applies.
- **Never** consult `X-Forwarded-For`, `Forwarded`, `X-Real-IP`, or any other
  client-supplied header. Ingress provenance is a property of the connection.
- **Compare only against explicitly pinned host identities** from configuration —
  the same values the trusted-proxy set enumerates, never a range.
- `ingress === 'public-gateway'` is true **only** when the real socket peer is
  the configured public gateway. Unknown peers are not `public-gateway`.
- `requestSourceIp()` stays the sole client-source accessor and is not modified.
- Direct tests prove the split (§16.1).

Consequences that follow, and must not be re-conflated:

- The rate-limit IP axis and the audit source address for a public redemption are
  the **recipient's** address from `requestSourceIp()` — never the gateway's
  container address. Using the gateway address there is precisely the T-05
  self-DoS.
- The §7.4 rule uses **only** ingress provenance — never `req.ip`.

Drive's side is otherwise unchanged in shape: routes still never read forwarding
headers, and `req.ip` remains the only client-source value. The Drive changes are
*which* peers are trusted (§5.1.1), the new ingress helper, and the §7.4 rule.

> [!warning] The Twingate attribution limitation is not fixed by this
> The recorded limitation — the Twingate/Docker ingress path collapses the
> Windows endpoint `192.168.0.104` into infrastructure identity `172.19.255.1`
> before Drive sees it — is a property of the private path and is **unchanged**
> by anything here. Do not present the public gateway as solving it.

### 10.2 PUBLIC-SHARE-7 managed-proxy adapter — delivered, pre-exposure PASS (2026-09-09)

> [!success] Adapter delivered and accepted pre-exposure; PS7 overall IN PROGRESS
> The adapter the warning above demanded now exists **in source** and has
> **passed its Docker runtime acceptance 20/20** against the real Drive on real
> PostgreSQL (Session S4). **PUBLIC-SHARE-7 is still NOT COMPLETE**: G4 is now
> owner-approved for Option B, **G5 and G6 remain OPEN**, and
> `Public Internet Share = NOT IMPLEMENTED`. No tunnel, domain, DNS record, TLS
> certificate, NAT rule, firewall, VLAN, Twingate or Production change was made.

**Scope.** PS7-01 measured the site behind upstream NAT/CGNAT, so Option A's
inbound port-forward is not available on the current topology. The pre-exposure
task built what Option B requires while G4 was still pending; the owner has since
approved **G4 Option B / Managed Tunnel** for the external-deployment task.

**Where the adapter lives.** Entirely in the gateway, in front of Drive. Two
validated, non-secret variables consumed by the gateway image:

```text
PUBLIC_SHARE_EDGE_MODE=direct|cloudflare      default: direct
PUBLIC_SHARE_EDGE_PROXY_CIDR=<one IPv4 /32>   required iff mode=cloudflare
```

`validate-public-share-edge.sh` validates both **before** nginx renders anything
and then *generates* the small include the template loads at an exact path. The
PUBLIC-SHARE-3 envsubst hardening is unchanged: no new operator value reaches
nginx directive context through substitution, and the one value that does reach
it — the connector address — is validated character by character and emitted by
the validator itself. A missing trust file is a start-up error, so a gateway
whose trust model was never generated does not start.

**The trust model.** In managed mode nginx's own `realip` module canonicalises
`$remote_addr`/`$binary_remote_addr` from `CF-Connecting-IP`, but only behind the
pinned peer, so the §10 header table and the `$binary_remote_addr` edge limit
keep their spelling and become per-recipient with no special case. `realip` alone
is not sufficient — it silently does nothing when the header is missing or
unparsable, and reads only the FIRST matching header when several arrive — so
**four** independent controls gate the share route and all four must pass:

| Control | Denies when |
| :--- | :--- |
| `$aegis_edge_peer_untrusted` | the immediate TCP peer is not the pinned connector |
| `$aegis_edge_recipient_absent` | the connector sent no `CF-Connecting-IP` at all |
| `$aegis_edge_recipient_ambiguous` | more than one recipient identity arrived |
| `$aegis_edge_not_canonical` | `$remote_addr` is still the connector — an unparsable value, or a `realip` configuration that did not apply |

The gate returns 403 in the rewrite phase, **before** `limit_req` and before
`proxy_pass`, so a refused request consumes no rate-limit token and never reaches
Drive. Provider identity headers are consumed at the gateway and never relayed,
in **both** modes.

**§10.1 is unchanged and was not re-conflated.** `requestSourceIp(req) → req.ip`
remains the sole client-source accessor; `requestIngressKind(req)` still reads
the immediate socket peer and still classifies the **gateway**, not the connector
and not the recipient. `server/request/sourceIp.js`, `server/request/ingress.js`
and `server/config/trustedProxy.js` are **unchanged by this work**, and
`TRUSTED_PROXY_CIDRS` is **not** widened — no Cloudflare range, RFC1918 subnet,
Docker bridge range or `0.0.0.0/0` anywhere.

**Two measured behaviours, recorded because they were measured and not assumed.**

- **Ambiguous provider identity was accepted, and is now refused.** On the real
  pinned image, two `CF-Connecting-IP` headers were accepted with HTTP 200 and
  attributed to whichever arrived first, because `realip` reads the first match
  and ignores the rest. That is a caller-influenced choice of identity. The
  ambiguity control was added in response; re-measured, a duplicated header and a
  comma-joined value both fail closed with 403 while a single recipient is still
  200 with the correct `X-Forwarded-For`.
- **`CF-Connecting-IP: <address>:<port>` is accepted and canonicalised to the
  address.** Attribution is still the correct recipient with the port dropped, so
  this is not an attribution defect. The acceptance suite's expectation was
  corrected rather than the adapter weakened.

**IPv6.** Recipients are attributable end to end: `realip` canonicalises the
address, the gateway authors it into `X-Forwarded-For`, Express resolves `req.ip`
to it, and `audit_log.source_ip` is `INET`, which holds it. `ipAllowed()` remains
IPv4-only for `zones` shares, but a `zones` share can never be redeemed through
the public ingress (§7.4), so no IPv6 path is lossy here and no lossy conversion
was invented.

**Evidence status at this checkpoint.** Source/structure suites green; five
static negative controls confirmed load-bearing and reverted; a rootless Podman
preflight against the real pinned image confirmed `--with-http_realip_module`,
`nginx -t` success in both modes, untrusted-peer denial, forged-header
resistance, IPv6 preservation and per-recipient rate-limit separation. ⚠️ **The
Podman preflight is configuration evidence only. It is not Docker acceptance**:
it cannot reproduce `internal: true` with `gateway_mode_ipv4: isolated`, and it
involved no Drive, no PostgreSQL, no audit, no isolation and no teardown
evidence.

**Docker runtime evidence (Session S4, 2026-09-09) — CLOSED / PASS.** The
runtime matrix ran against the real Drive on real PostgreSQL 15 across the
isolated topology, on **Docker Engine 29.7.1**. The first pass reported 20 tests,
18 pass, 2 fail, 0 skipped — 13 of 14 PS7-PRE subtests passing, with the one
failure being a defect in the test rather than the adapter (below). After that
fix: **20 tests, 20 passed, 0 failed, 0 skipped, acceptance exit code 0, post-run
check failures 0.** All seven runtime negative controls proved load-bearing. Attribution through the managed
hop, forged-header resistance, per-recipient limiting, the scope split,
revocation, log safety and connector-bypass denial were all measured against the
real application. Production inventory was **IDENTICAL** across both full runs
and every harness object was torn down. See [[idea1/idea1-status]] for the full
per-subtest and per-control breakdown.

⚠️ **One durable platform fact this produced.** How an isolated bridge presents
unreachability is **engine-dependent**, and a test must not encode one
platform's wording. PUBLIC-SHARE-3 measured `Host is unreachable` on Docker
Desktop 28.3.2; native Linux Docker 29.7.1 drops the packet with no ICMP reply,
so the client **times out** instead. The discriminator that actually
distinguishes a live address from a dead one is **`Connection refused`**, which
did not occur once. `PS7-PRE-11` asserted the wording rather than the property
and was corrected — asserting `Connection refused` first, accepting a timeout,
rejecting any HTTP response, and adding PUBLIC-SHARE-3's ARP corroboration.

**Pre-exposure managed-tunnel acceptance = PASS.** ⚠️ This closes the adapter
task only. **PUBLIC-SHARE-7 overall = IN PROGRESS**, real Internet acceptance =
**NOT RUN**, **G4 is APPROVED for Option B**, **G5 and G6 remain OPEN**, and
`Public Internet Share = NOT IMPLEMENTED`.

⚠️ **One deployment gate is recorded rather than faked.** In the harness the
connector sits on an internal, isolated Docker network with no route to Drive,
PostgreSQL or a private surface. A real `cloudflared` connector needs an outbound
Internet path, so reproducing "the connector can reach nothing but the gateway"
in Production is host-firewall and/or VLAN work that source cannot assert. It
must be designed and reviewed before G5. S5.2 now freezes the exact logical
topology, trust and probe contract in
`docs/superpowers/plans/2026-09-10-idea1-public-share-g5-readiness.md`; exact
backend-specific commands remain blocked until the required Production
preflight measures the real packet-filter and DNS paths.

---

## 11. Streaming and large-file considerations

`deliver()` opens a read stream and pipes it; it never buffers a whole file. The
gateway must not undo that:

- **`proxy_buffering off`** on the `/s/` location, matching what the private path
  already does for `/drive/api/files/:id/download`. Without it nginx accumulates
  the response into temp files, which for a multi-gigabyte download is both a
  disk-exhaustion vector and a latency cliff.
- **`proxy_request_buffering off`** is not needed — the only request body is a
  ≤4 KB password form.
- **`client_max_body_size`** should be small (e.g. `16k`), not inherited from the
  512 MB private upload ceiling. The public listener accepts no uploads.
- **Timeouts** must be set explicitly and sized to the largest file eligible for
  `public` scope (T-20).
- **`Content-Length`** is already set from `share.fileSize`, so a truncated
  transfer is detectable by a client that checks. It is not detectable by a client
  that does not.
- **Interrupted connections**: `stream.on('error', () => res.destroy())` already
  prevents a half-written response from hanging. The hit counter increments
  *before* streaming, so an aborted download still counts as a redemption — a
  deliberate existing choice (the bytes left the building), and one the public UI
  copy should not contradict.

**HTTP Range is not supported today.** `deliver()` sets `Content-Length` and
pipes from byte zero; there is no `Accept-Ranges`, no `206`, and no range
parsing. For a public recipient on a mobile connection, that means **an
interrupted download restarts from zero.** Adding Range support is a real
enhancement with its own risks (range-based enumeration, cache poisoning, more
complex `Content-Length` accounting) and belongs in its own PR after
PUBLIC-SHARE-7, not smuggled into the gateway work.

**No transfer above the already-recorded tested scope is claimed.** 20–30 GB
transfer acceptance and the Production 32 GiB ceiling remain **NOT TESTED / NOT
ACCEPTED**, exactly as [[concepts/Large_File_Transfer_V2]] and
[[idea1/idea1-status]] record. A public gateway does not change that and must not
be used to imply it.

---

## 12. Audit requirements

Public redemptions must produce the same audit events as private ones, through
the same `auditShare()` helper, with the same privacy discipline.

| Event | Action | Result | Target recorded |
| :--- | :--- | :--- | :--- |
| Attempt on an unknown token | `SHARE_REDEEM` | `DENIED` | `sha256Hex('unknown:' + sha256Hex(token))` shape as today |
| Password denied | `SHARE_REDEEM` | `DENIED` | hashed file name |
| Rate limited | `SHARE_REDEEM_LOCKOUT` | `BLOCKED` | rate key |
| Successful redemption | `SHARE_REDEEM` | `OK` | hashed file name |
| Revoked | `SHARE_REDEEM_REVOKED` | `BLOCKED` | hashed file name |
| Expired | `SHARE_REDEEM_EXPIRED` | `DENIED` | hashed file name |
| Trashed | `SHARE_REDEEM_TRASHED` | `BLOCKED` | hashed file name |
| Out of scope / wrong provenance (§7.4) | `SHARE_REDEEM_OUT_OF_SCOPE` | `BLOCKED` | hashed file name |

Never logged, in the application or at the gateway: the raw token, the plaintext
link password, any Vault key, the session secret, any private key.

One addition specific to the public path: the audit row's source IP will be the
recipient's real Internet address once §10 is in place. It comes from
`requestSourceIp(req)` and **never** from the ingress peer (§10.1) — an audit
trail that recorded the gateway's container address for every public redemption
would be worse than useless, because it would look like real attribution while
identifying nobody.

**G3 is APPROVED:** the existing application audit may retain the full canonical
recipient source IP for security attribution, rate-limit investigation, and
incident response. This does not authorize analytics, marketing, profiling, or
a second persistent gateway IP log. The raw share token, plaintext password, and
public URL containing the token remain forbidden. No real Internet recipient IP
has been recorded: there is still no Internet ingress.

---

## 13. Public ingress decision matrix

**G4 is APPROVED for Option B / Managed Tunnel. Nothing in this section has been
configured or exposed.**

| Dimension | Option A — Public IP + NAT / port-forward | Option B — Managed public tunnel / reverse proxy |
| :--- | :--- | :--- |
| What is exposed | A port on the site's public address, forwarded to the gateway | An outbound-initiated tunnel; no inbound port opened |
| Requires | Static or stable public IP, MikroTik NAT + firewall rule, public DNS A record, publicly trusted certificate | Vendor account, connector/agent on-site, public DNS CNAME, vendor-managed or origin certificate |
| Security boundary | Entirely ours. The gateway is the only thing between the Internet and the LAN edge | Shared with the vendor. The vendor terminates TLS (or sees SNI) and can see request URLs |
| Token-in-URL exposure (T-14) | Only our logs | **Vendor logs may record the full URL, which is the credential** |
| Attribution (T-27) | Two hops, both ours; unambiguous | Three hops; the client address is whatever the vendor asserts |
| Caching (T-13) | None unless we add it | Vendor edge may cache by default; must be explicitly disabled |
| Firewall/NAT implications | A permanent inbound hole in the perimeter; contradicts the current "no inbound" posture recorded in the UFW/MikroTik evidence | No inbound hole; egress-only |
| Control-plane dependency | None | Vendor availability and policy changes affect production |
| DDoS posture | Our bandwidth absorbs it | Vendor absorbs it |
| Operational ownership | Us: NAT, DNS, certificate renewal, monitoring | Split: vendor edge, us for the connector and origin |
| Rollback | Remove NAT rule, remove DNS, stop gateway | Delete tunnel route, remove DNS, stop connector |
| Cost | Possibly a static IP | Possibly a subscription |

**Decision record.** Option A would keep T-14/T-27 entirely inside AEGIS, but it
requires inbound forwarding that the measured NAT/CGNAT topology does not
provide and would contradict the current no-inbound-listener posture. The owner
therefore selected **Option B** on 2026-09-09: outbound connectivity through a
named Cloudflare Tunnel, with the provider trust and attribution trade-offs
accepted explicitly.

The two criteria still conflict; choosing B does not erase its residual risk.
Cloudflare/provider infrastructure may observe or log the public bearer URL
(T-14), and AEGIS relies on provider-asserted recipient identity behind one
pinned connector (T-27). The adapter's pre-exposure 20/20 result is the accepted
source/runtime control for that trust decision, not evidence of a real tunnel.

> [!danger] G4 is architecture approval, not exposure approval
> No MikroTik rule, UFW rule, VLAN change, Twingate policy, NAT entry, DNS record,
> tunnel, connector, or certificate exists because of G4. **G5 remains the only
> owner gate that authorises actual Internet exposure.**

---

## 14. Security invariants

Every future PR in this sequence must preserve all of these. A change that
weakens one is a change to be rejected, not a trade-off to be negotiated.

1. Raw share tokens are never stored; only `sha256Hex(token)`.
2. The raw token is returned exactly once, at creation.
3. Link passwords are bcrypt (cost 12), validated server-side, minimum 8 chars.
4. Expiry and revocation are evaluated server-side on every redemption.
5. Unknown, expired, revoked, trashed and Vault-backed tokens are
   indistinguishable to the recipient.
6. Vault files are never shareable or redeemable, enforced at creation **and** at
   redemption.
7. Only the file owner may create or revoke a share. No Admin bypass.
8. Trashing a file revokes its live shares, and a trashed file is never
   redeemable.
9. Successful redemption streams real bytes with `attachment`,
   `application/octet-stream`, `nosniff`, and `no-store`.
10. The hit counter increments only on successful redemption.
11. Audit never contains a raw token or a plaintext password.
12. Brute-force protection is server-side and cannot be bypassed by rotating
    forged forwarding headers.
13. `req.ip` via `requestSourceIp()` is the only source of **client** identity;
    routes never parse forwarding headers. It is used for `zones` CIDR
    enforcement, the rate-limit IP axis, and the audit source address.
14. **Ingress provenance is a separate fact from client identity**, read from the
    immediate socket peer through one central helper, never from `req.ip` and
    never from any client-supplied header. It is used for the `scope=public`
    ingress rule and for nothing else. Neither identity may be substituted for
    the other (§10.1).
15. Trusted proxies are explicitly enumerated /32 host identities; production
    refuses to start on anything outside the two approved states in §5.1.1, and
    the public-gateway identity is optional until its rollout phase.
16. `zones` and `any` keep their exact current semantics and remain
    backward-compatible.
17. `scope=any` is never redefined as public.
18. The public listener default-denies every path outside `GET|POST /s/:token`.
19. The public gateway holds no secret, no database handle, and no Data Lake
    mount.
20. The UI never presents Public Internet sharing as available before
    PUBLIC-SHARE-7 passes. PUBLIC-SHARE-4 satisfies this rather than weakening
    it: the interface *supports* `public`, but only offers it when a
    server-owned capability says so, and that capability is **off by default**
    and may only be switched on after G6 / PUBLIC-SHARE-7 acceptance. Shipping
    the interaction and activating it are two separate events — see §8.1.2.

---

## 15. Rollout sequence

Each phase is one branch, one PR, one receipt. **None of them may be combined.**

| PR | Scope | Produces | Explicitly not included |
| :--- | :--- | :--- | :--- |
| **PUBLIC-SHARE-1** *(this note)* | Architecture, threat model, contracts, gates | This document, canonical-note update, receipt | Any source, config, test or infrastructure change |
| **PUBLIC-SHARE-2** *(delivered; Production backend/DB prepared in S5.3)* | Backend public-scope contract | `SCOPES` + `public`, migration `009`, `PUBLIC_SHARE_BASE_URL` contract, `.env.example` entry, the central **ingress-provenance helper** (§10.1), the §7.4 rule built on it, `trustedProxy.js` two approved states (§5.1.1), backend tests | Any gateway, any ingress, any UI activation |
| **PUBLIC-SHARE-3** *(delivered; Production Gateway accepted in S5.4)* | Public Share Gateway | Dedicated Dockerfile + nginx config, isolated two-member `aegis_public_share` harness, header sanitation, streaming/timeout tuning, log redaction, negative-route tests, structural tests; hardened Gateway now accepted on dedicated edge + upstream networks | Internet exposure; any DNS, TLS, NAT or tunnel |
| **PUBLIC-SHARE-4** *(delivered in source, not activated)* | Secure Shares UI | `public` as a selectable scope behind the server-owned `PUBLIC_SHARE_UI_ENABLED` capability, EN/TH/ZH copy, mandatory link password, 1h transient public expiry, backend-owned public URL, `zones`/`any` preserved | Enabling the capability on any deployment; any ingress, DNS, TLS or Production change |
| **PUBLIC-SHARE-5** *(delivered in source, not deployed)* | Security regression suite | The full negative and positive matrix in §16, pinned as automated tests across backend, ingress, gateway and UI, with load-bearing negative controls | New features; any shipped source change |
| **PUBLIC-SHARE-6** *(COMPLETE — internal harness acceptance passed on server hardware)* | Internal integration acceptance | The real gateway in front of the real Drive on a real PostgreSQL 15, on three disposable internal isolated networks: 64 MiB streaming, a 75s-stall slow client, an interrupted transfer, concurrency, migration 009 applied to a real 008-era database, forbidden-route and Host termination, forged-header attribution, the ingress split, B5, revocation, and a verified teardown | The harness itself was removed; Production state is tracked by PUBLIC-SHARE-7 S5.3/S5.4 |
| **PUBLIC-SHARE-7** *(IN PROGRESS — S5.4 CLOSED/PASS; S5.5-A active)* | Managed-tunnel trust adapter, pre-exposure acceptance, owner-gated Production layers, then real external E2E | Adapter/harness delivered; S5.1–S5.3 complete; S5.4 Production Drive State B, edge/upstream networks and Gateway accepted; domain owned; G4 Option B approved | S5.5 read-only Production preflight, egress/firewall/connector implementation and isolation acceptance; G5, actual tunnel hostname/DNS/TLS exposure, external acceptance, G6 and UI activation remain open |

Deployment order at PUBLIC-SHARE-6/7 is fixed and mirrors the constraint already
proven necessary for the telemetry contract: **Drive first, then the gateway.**
A Drive that knows `public` works with no gateway (links are inert). A gateway
in front of a Drive that does not know `public` would forward requests to a
backend that rejects the scope — visible failure rather than silent exposure, but
still the wrong order. Rollback reverses it (§16.2).

---

## 16. Verification plan

### 16.1 What each phase must prove

**PUBLIC-SHARE-2** — scope and configuration: `public` accepted and stored;
migration additive and idempotent, and re-runnable by a different superuser while
still granting `drive_app`; `PUBLIC_SHARE_BASE_URL` absent ⇒ `public` rejected;
malformed base URL ⇒ boot failure; public URL independent of the `Host` header;
Vault file + `public` ⇒ rejected; cross-owner + `public` ⇒ rejected.

Plus five groups that exist specifically to pin the §10.1 split. These are the
tests that would have caught the provenance error corrected during PR #97 review,
so none of them is optional:

*Provenance / attribution split.* With the trusted public-gateway peer as the
socket peer and `X-Forwarded-For` carrying an external client address:

```text
requestIngressKind(req)  = 'public-gateway'
requestSourceIp(req)     = the external client address   (NOT the gateway address)
```

Both assertions in one test, so the two identities cannot silently converge.

*Public ingress blocks the older scopes.*

```text
scope=zones  + public-gateway ingress → DENY
scope=any    + public-gateway ingress → DENY
scope=public + public-gateway ingress → continues to the normal redemption gates
```

*Private ingress stays backward-compatible.*

```text
scope=zones  via HUB/private path → existing CIDR semantics, unchanged
scope=any    via HUB/private path → existing behaviour, unchanged
scope=public via private path     → allowed, per §7.4
```

*Forged headers never create public provenance.* A caller whose socket peer is
**not** the public gateway, sending arbitrary `X-Forwarded-For`, `X-Real-IP` and
`Forwarded`, must never yield `ingress = 'public-gateway'`.

*Trusted-proxy startup compatibility.* Both approved production states start:
HUB alone, and HUB + the approved public-gateway identity. These are rejected:
public gateway without HUB; an unapproved /32; any prefix shorter than /32; a
`FORBIDDEN_SHARED_RANGES` value; duplicate or ambiguous entries; a third proxy.
Every existing `tests/trustedProxy.test.js` rejection case (TP-R1..R8) must still
pass unchanged unless a reviewer explicitly approves a behaviour change.

**PUBLIC-SHARE-3** — for every path in §6.3, the gateway returns `404` **and**
Drive records no request; case variants and traversal forms all `404`; methods
outside `GET|POST` rejected; forged `X-Forwarded-For` / `Forwarded` / `X-Real-IP`
from the client do not change the canonical source; `proxy_buffering` off;
`access_log` does not contain the token; the config contains no `proxy_pass`
outside the share location; Compose shows no published Drive port and a
two-member public network.

**PUBLIC-SHARE-5** — the full matrix: unknown/malformed token; expiry; revoke;
correct and incorrect password; brute-force lockout; token not stored raw;
password never returned or logged; Vault denied; owner-only lifecycle; trash
revokes; forged forwarding headers; forbidden public paths; the gateway cannot
proxy private APIs; attachment/nosniff/cache headers; audit content and absence
of secrets; and — specific to this feature — a public-path lockout does not lock
private redemption or login (T-05).

> [!success] PUBLIC-SHARE-5 delivered — matrix pinned, no shipped source changed
> The matrix above is now automated. Recipient-facing indistinguishability,
> raw-token and password secrecy, password correctness and lockout, the T-05
> namespace separation in **both** directions, forged-header limiter identity,
> Vault exclusion at redemption as well as creation, owner-only lifecycle with
> object-hiding, trash, expiry, revoke, the hit counter, response security
> headers, and audit content/absence live in
> `tests/publicShareSecurityRegression.test.js`; the gateway route, header,
> rate-limit, log and B5 matrix stays in the PUBLIC-SHARE-3 suites; the UI
> matrix stays in `shareScopeTruthUi.test.js`.
>
> Seven high-risk guards were proved load-bearing by temporarily breaking the
> invariant and confirming the expected test failed: T-05 namespace separation,
> the public-ingress scope block, the gateway default deny, gateway token-safe
> logging, UI public-URL ownership, CSP nonce freshness (a constant nonce), and
> gateway password-log secrecy (`$request_body` added to the log format). Every
> mutation was reverted; **no shipped gateway, backend or UI source changed in
> that phase.**
>
> The CSP nonce is asserted **distinct across the exercised responses** — a
> freshness check, not a claim about entropy quality — and the link password is
> proven absent from the **real** gateway container's Docker logs after an
> allowed form POST, which is a request-body leak path the token sentinel never
> covered.
>
> Two gates need direct row access because a well-behaved API cannot reach them
> — a Vault-backed share row and an already-expired row (the shortest offered
> expiry is 1h). They are exercised against a disposable PostgreSQL 15.18
> instance and are reported as unavailable, not silently weakened, when only the
> in-memory store is in use.

**PUBLIC-SHARE-6** — internal integration on a non-public address: streaming a
file large enough to exceed default timeouts; an interrupted transfer; a slow
client; concurrent downloads; and confirmation that `/api`, `/drive` and
`/healthz` are unreachable through the gateway.

> [!success] PUBLIC-SHARE-6 COMPLETE — internal acceptance passed on server hardware; still no ingress, still not deployed
> `gateway/public-share/integration/` stands up the **real** PUBLIC-SHARE-3
> gateway image in front of the **real** AEGIS Drive image on a **real**
> PostgreSQL 15, and `tests/publicShareInternalIntegration.test.js` drives it.
> This is the first evidence in the repository of the two tiers actually
> connected: PUBLIC-SHARE-3 measured the gateway against a recorder, and
> PUBLIC-SHARE-5 measured the application against a modelled peer.
>
> Proven end to end across a real nginx hop: a 64 MiB (67,108,864-byte) upload on
> the private path and byte-exact SHA-256 delivery on the public one; a slow
> client that stalls **75s** mid-transfer and still receives every byte; an
> interrupted transfer that harms neither tier; four concurrent downloads all
> intact; `/`, `/api/*`, `/drive/`, `/monitor/`, `/healthz`, `/s/`, both traversal
> spellings and a `PUT` all refused **without one of them reaching the
> application**; an unknown `Host` terminated at the gateway; forged
> `X-Forwarded-For` / `X-Real-IP` / `Forwarded` unable to move attribution off the
> real recipient address; a `scope=any` link refused through the public ingress
> while still redeemable privately; revocation effective immediately; and B5
> reconfirmed with the gateway holding no default route and no path to
> PostgreSQL.
>
> Three things this phase established that were not previously recorded:
> 1. **Migration 009 is now proven against a real 008-era database**, not only
>    against `schema.sql`. The harness deliberately provisions the pre-009
>    constraint and demonstrates that a `scope=public` share **cannot** be minted
>    until 009 is applied, that re-applying it is a no-op, and that `drive_app`
>    is refused the migration.
> 2. **The production State B trusted-proxy pair is load-bearing at boot.**
>    `config/trustedProxy.js` refuses to start under `NODE_ENV=production` unless
>    `TRUSTED_PROXY_CIDRS` is exactly the approved HUB identity **and**
>    `PUBLIC_SHARE_GATEWAY_CIDR`. The first harness attempt failed the boot on
>    this, which is the control working.
> 3. **The slow-client timeout tuning is measurable, not decorative.** With
>    `proxy_buffering off`, a 75s client stall lands directly on
>    `proxy_read_timeout` and `send_timeout`, whose nginx defaults are 60s. The
>    transfer completes only because the shipped template raises both to 300s.
>
> **Stage B — the same acceptance matrix, on AEGIS server hardware (2026-09-08).**
> The matrix above was first measured on a developer machine. It has since been
> run on the Beelink host `aegis-system` itself, against the production Docker
> daemon through `sudo -n env -u DOCKER_HOST docker`, in its own throwaway
> Compose project on its own three isolated networks. Attempt #4, against source
> SHA `15c43d6bc4d5f3d7287d20e855677a44f0ec0231`, **passed 16/16 — 0 failed, 0
> skipped, acceptance exit 0, post-run check failures 0, runner RC 0.** PS6-INT-4
> streamed the full 64 MiB (67,108,864 bytes; `Content-Length` 67,109,045) in
> 262,144-byte chunks with **256 drain waits** and `responseStatus=201`.
> Three earlier attempts failed safely and are recorded in the receipt rather
> than discarded: a Compose credential stripped at the `sudo` boundary, a
> diagnostic that masked a transport failure, and a single unbounded 64 MiB
> write. Production was **IDENTICAL** pre and post on every attempt, every
> Production service stayed healthy, both protected volumes survived, and every
> PS6 container, network, volume, built image and temporary file was removed.
>
> **Historical PUBLIC-SHARE-6 boundary:** G4, G5 and G6 were open at that
> checkpoint, and `Public Internet Share = NOT IMPLEMENTED`.
> A recipient in this harness is a container on an isolated Docker network, not
> someone on ordinary Internet access — that distinction is exactly what
> PUBLIC-SHARE-7 exists to close, and **PUBLIC-SHARE-7 had not started at that
> checkpoint**. No ingress method had been chosen then, no port is published,
> and no DNS record, TLS
> certificate, NAT rule, tunnel or firewall change exists. No shipped gateway,
> backend or UI source changed in this phase, and nothing in Production was
> contacted, restarted, migrated or read.

**PUBLIC-SHARE-7** — real external E2E, client condition
`Twingate = OFF`, `AEGIS account = not required`, `network = ordinary external
Internet`, from more than one path where practical (separate Wi-Fi, mobile
hotspot, 4G/5G):

```text
public URL reachable
wrong password denied
correct password downloads
expected byte length
SHA-256 exact match
hit counter increments
revoke works
revoked URL denied
private AEGIS UI/API not publicly reachable
```

The last line is the one that matters most and must be tested from the same
external client, against `/`, `/drive/`, `/api/`, `/healthz` and `/monitor/`.

### 16.2 Rollback strategy

Ordered, because the order is the control (T-28):

1. **Remove public ingress first** — delete the NAT/firewall rule (Option A) or
   the tunnel route (Option B). The public address stops answering.
2. **Remove the public DNS record.** Verify the name no longer resolves. Removing
   DNS before the record can dangle is what prevents name takeover.
3. **Stop and remove the gateway container** and the `aegis_public_share`
   network.
4. **Roll back the Drive image** to the previous tag if the backend change is
   also being withdrawn. Drive is rolled back *after* the gateway, the mirror of
   the deploy order.
5. **Leave the database migration in place.** `009` is additive; rolling it back
   would invalidate existing rows. Existing `public` shares become
   unredeemable-from-the-Internet but remain listable and revocable by their
   owners — which is the correct end state.
6. **Verify and record**: public name does not resolve; public address does not
   answer; `zones` and `any` redemption still pass on the private path;
   `/healthz` still 200 internally.

Step 6 is mandatory evidence. A rollback without it is not a completed rollback.

---

## 17. Production decision gates

Each gate is an explicit owner decision, recorded before the work it unblocks.

- **G1 — APPROVED.** Kla accepted §6 (route contract), §7 (scope contract) and
  §8 (configuration contract); PUBLIC-SHARE-2 implements them.
- **G2 — APPROVED.** Kla, as infrastructure owner, accepted the two-state
  trusted-proxy implementation in §5.1.1; PUBLIC-SHARE-2 implements it while
  Production remains in HUB-only mode.
- **G3 — APPROVED.** The application audit may retain the full canonical
  recipient Internet address from `requestSourceIp(req)` for security
  attribution, rate-limit investigation, and incident response, under the
  restrictions in §12. No Internet recipient has been observed yet.
- **G4 — APPROVED on 2026-09-09.** Owner selected **Option B / Managed Tunnel**
  from §13 and explicitly acknowledged T-14/T-27. This permits planning and
  non-exposed preparation only; it is not G5 and creates no Internet exposure.
- **G5 — Exposure gate.** After PUBLIC-SHARE-6 passes internally, the owner
  authorises actual Internet exposure. This is the point of no return and the
  only gate that changes the perimeter.
- **G6 — Completion gate.** Public Internet Share is marked implemented **only**
  after PUBLIC-SHARE-7 passes, including the "private AEGIS UI/API not publicly
  reachable" check.

Until G6, every status note, UI string and receipt says the same thing:
`Public Internet Share = NOT IMPLEMENTED`.

---

## 18. Known limitations

- **Delivery is partial by phase.** PUBLIC-SHARE-2 backend source is merged and
  PUBLIC-SHARE-3 gateway source/runtime harness is implemented and locally
  verified. No gateway is deployed, no real Drive integration has run through
  it, and every ingress/TLS/external-acceptance control remains unbuilt.
- **Ingress method chosen, not deployed.** G4 selects Option B / Managed Tunnel,
  so T-13, T-14, T-25, T-26 and T-27 now carry the Option B residual-risk model.
  Domain/zone ownership, connector isolation, the named tunnel, DNS, TLS and G5
  remain unproven or open.
- **The trusted-proxy change is a real modification to a production-verified
  control.** B4.3's spoof resistance was proven with exactly one approved
  identity. Adding a second approved *state* (§5.1.1) is sound and keeps HUB-only
  as the default, but it is not the configuration that was accepted in
  production.
- ~~**The ingress-provenance helper does not exist yet.**~~ **Delivered by
  PUBLIC-SHARE-2** as `server/request/ingress.js` (`requestIngressKind`,
  `requestIngressPeerIp`), with `requestSourceIp()` unchanged beside it. The
  §10.1 split is now implemented and measured through the real Express stack
  rather than only specified. It returns a third value, `unknown`, when a gateway
  is configured but the peer cannot be read, so the "private only" scope rule
  fails toward denial.
- **Ingress provenance is an address comparison, not authentication.** It proves
  the socket peer is the configured gateway address, which is sound only because
  `aegis_public_share` has exactly two members and Drive publishes no port. If
  that network ever gained a third member the control would weaken silently; the
  Compose structural test named in T-10 is what keeps that from happening
  unnoticed.
- ~~**The PUBLIC-SHARE-3 header and rate-limit model is direct-peer only.**~~
  **Addressed in source and accepted in the isolated pre-exposure runtime by
  PUBLIC-SHARE-7 (§10.2); not deployed or externally accepted.**
  Direct mode is unchanged and remains the default. Managed mode canonicalises
  `$remote_addr`/`$binary_remote_addr` from the pinned connector's
  `CF-Connecting-IP`, so the authored `X-Forwarded-For`/`X-Real-IP` and the edge
  limit become per-recipient without changing their spelling. The residual limit
  is that the real connector-isolation design, Production pre/post evidence and
  ordinary-Internet acceptance are still **PENDING**, so the pre-exposure pass
  does not close this limitation.
- **B5 is enforced by the PUBLIC-SHARE-3 harness network, and the harness
  therefore has no host listener.** `aegis_public_share` is a Docker
  `internal: true` network **with bridge gateway mode `isolated`**; both are
  required, because an ordinary internal bridge still keeps the Docker-host
  bridge address through which host services stay reachable. Measured side by
  side on Docker 28.3.2: with `internal` only, the bridge address answers ARP
  and returns `Connection refused` (live); with `isolated` added, its ARP entry
  is incomplete and it returns `Host is unreachable`. On the real harness the
  gateway has no default route, cannot reach `1.1.1.1`/`8.8.8.8`, finds
  `172.31.254.1` unreachable on every probed port, and cannot resolve
  `host.docker.internal` or `gateway.docker.internal`; it reaches `drive:8001`
  and nothing else. Docker cannot publish
  a port from an internal network — it accepts the request and silently drops it
  — so **neither member publishes a host port**, and the runtime suite drives the
  gateway from inside the network using only the two existing members: the drive
  recorder calls `http://public-share-gateway:8080`, and the gateway calls its
  own `127.0.0.1:8080` for the upstream-failure/token-log check where the
  recorder must be stopped. No third client container exists. Disabling
  masquerading instead does **not** block egress and is not a substitute. This
  is owner-approved (PR #100 review): B5 is not deferred to PUBLIC-SHARE-6. The
  residual limit is that this proves the Docker network boundary, not a
  perimeter/firewall boundary, which PUBLIC-SHARE-6 still owns.
- **HTTP Range is unsupported**, so a public recipient with an unreliable
  connection restarts a large download from zero (§11).
- **Rate limiting is in-memory and per-process** (`rateLimit.js`). It resets on
  restart, is not shared across instances, and does not survive horizontal
  scaling. No Redis or shared store is introduced here, deliberately. This limits
  T-04/T-05 mitigation to a single Drive process, which is what production runs
  today — but it is a ceiling, not a solved problem.
- **Sessions are also in-memory** (`MemoryStore`), an existing tracked limitation
  in [[summaries/08_Outstanding_Items_Consolidated]] that likewise blocks running
  multiple Drive instances. It does not affect share redemption, which is
  sessionless.
- **20–30 GB and the Production 32 GiB ceiling remain NOT TESTED / NOT ACCEPTED**,
  unchanged by this note.
- **The Twingate endpoint-IP attribution limitation is unchanged** and is not
  addressed by the public path (§10).
- **A leaked public URL is unrecoverable except by revocation** (T-02). No design
  in this note changes that; it is inherent to capability URLs.
- **`gateway/nginx.conf` still carries the case-sensitive `/monitor/internal/`
  guard** that `HUB-AEGIS_Entry/nginx.conf` fixed. It is a dev-compose file, it is
  already tracked as open, and it is deliberately **not** touched here — but it is
  the exact defect class §6.2 rule 1 exists to prevent repeating.
- **The owner-supplied VLAN30 and remote-PC acceptance figures in §2.2 were not
  reproduced by this task** and are recorded as owner-supplied rather than merged
  into the repository's own B4.3 evidence.

---

## Related

[[idea1/idea1-status]] · [[idea1/idea1-moc]] · [[core/security-architecture]] ·
[[core/integration-points]] · [[concepts/OWASP_Security_Defense]] ·
[[concepts/ZTNA_Twingate_vs_OpenVPN]] ·
[[concepts/Honest_Telemetry_and_Unavailable_States]] ·
[[concepts/Large_File_Transfer_V2]] · [[concepts/Three_Layer_Data_Lake]] ·
[[infrastructure/infrastructure-moc]] ·
[[infrastructure/network/VLAN-IP-Plan]] ·
[[infrastructure/remote-access/Twingate-Setup]] ·
[[infrastructure/deployment/Docker-Stack-Plan]] ·
[[summaries/08_Outstanding_Items_Consolidated]]
