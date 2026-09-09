# PUBLIC-SHARE-7 · pre-exposure managed-tunnel harness

An isolated Docker stack that puts the **real** Public Share Gateway, in
**managed-proxy mode**, in front of the **real** AEGIS Drive application on a
**real** PostgreSQL 15 database — with one extra hop in front of the gateway,
standing in for a managed HTTP tunnel.

It is driven by
`IDEA1-AEGIS_Drive_LC/tests/publicShareManagedTunnelIntegration.test.js`.

```bash
cd IDEA1-AEGIS_Drive_LC
PUBLIC_SHARE_MANAGED_TUNNEL_RUNTIME=1 node --test --test-concurrency=1 \
  --test-timeout=1800000 tests/publicShareManagedTunnelIntegration.test.js
```

Without `PUBLIC_SHARE_MANAGED_TUNNEL_RUNTIME=1` only the static `PS7-STRUCT`
tests run, so `npm test` never builds an image or touches Docker implicitly.

## Read this before reading anything else

**Nothing here is external evidence.** There is no Cloudflare account, no
`cloudflared`, no tunnel, no tunnel credential, no domain, no DNS record, no TLS
certificate, no public URL, no NAT rule and no firewall change. `tunnel-connector`
is a stock `node:20-alpine` container that re-originates HTTP requests carrying
`CF-Connecting-IP`.

That single behaviour is the whole security question a managed hop raises, and
it is the only thing this harness produces evidence about. A pass here is
**PRE-EXPOSURE / LOCALLY VERIFIED**. G5 and G6 remain **OPEN** and
`Public Internet Share = NOT IMPLEMENTED`.

## Why it exists

PUBLIC-SHARE-3 shipped a gateway that is the **immediate** recipient-facing HTTP
peer: `$remote_addr` *is* the recipient, so `X-Forwarded-For`, `X-Real-IP` and
the `$binary_remote_addr` edge limit are correct by construction.
PUBLIC-SHARE-6 proved that gateway against the real Drive — still as the
immediate peer.

Both were explicit that this stops being true under a G4 Option B managed
tunnel, and that the consequences are not cosmetic:

```text
without an adapter, behind a tunnel:

  $remote_addr            = the tunnel connector, for every recipient alive
  X-Forwarded-For         = the tunnel connector
  audit source_ip         = the tunnel connector          → G3 attribution is wrong
  limit_req key           = the tunnel connector          → T-05 rate-limit self-DoS:
                                                            one abusive recipient
                                                            rate-limits everyone
```

Both notes required the provider trust/attribution adapter to be designed and
reviewed **before** deployment. This directory is that adapter's acceptance.

## Topology

```text
  external recipient          an address the provider ASSERTS. No container
        │                     in this harness holds it.
        ▼
  managed provider edge  ─┐   neither exists here: a provider edge and a real
  provider TLS / DNS     ─┘   tunnel are G5 work, not code work
        │
        ▼
  tunnel-connector ──┐
  direct-caller ─────┤ aegis_ps7_edge (172.31.240.0/29)
                     ▼
              public-share-gateway
                     │ aegis_ps7_upstream (172.31.241.0/29)
                     ▼
                   drive
                     │ aegis_ps7_data (172.31.242.0/29)
                     ├─▶ postgres
                     └─▶ private-surface
```

| Service | Address | Why it exists |
| :--- | :--- | :--- |
| `public-share-gateway` | `172.31.240.2` / `172.31.241.2` | The real image, built from the shipped `Dockerfile`, in `PUBLIC_SHARE_EDGE_MODE=cloudflare` |
| `tunnel-connector` | `172.31.240.3` | The **pinned** connector. Its only privilege is its address |
| `direct-caller` | `172.31.240.4` | The same image and privileges, **not** pinned. A trust model that cannot tell these two apart is not a trust model |
| `drive` | `172.31.241.3` / `172.31.242.3` | The real AEGIS Drive image |
| `postgres` | `172.31.242.2` | Real PostgreSQL 15, current shipped schema |
| `private-surface` | `172.31.242.4` | A stand-in for the class of surface HUB and Monitor occupy. It **listens**, and Drive reaches it, so "the public side cannot" is a measured refusal rather than a probe against a dead address |

Every network is `internal: true` **with** `gateway_mode_ipv4: isolated`, for the
reason PUBLIC-SHARE-3 measured: an ordinary internal bridge still keeps the
Docker-host bridge address, through which host services stay reachable. No
service publishes a host port, and Docker cannot publish one from an internal
network anyway.

## The trust model under test

Two variables, both consumed by the **gateway image**, neither of them a secret:

```text
PUBLIC_SHARE_EDGE_MODE=direct|cloudflare      default: direct
PUBLIC_SHARE_EDGE_PROXY_CIDR=<one IPv4 /32>   required iff mode=cloudflare
```

`validate-public-share-edge.sh` validates them **before** nginx renders anything
and then *generates* `/tmp/aegis-edge/http.conf`, which the template includes at
an exact path. Two consequences worth stating:

- **`NGINX_ENVSUBST_FILTER=^PUBLIC_SHARE_HOST$` is unchanged.** No new operator
  value reaches nginx directive context through template substitution. The one
  value that does reach directive context — the connector address — is validated
  character by character and emitted by the validator itself.
- **A missing trust file is a start-up error**, because the include is an exact
  path rather than a wildcard. A gateway whose trust model was never generated
  does not start.

In managed mode the generated file configures nginx's own `realip` module:

```nginx
set_real_ip_from <connector>/32;
real_ip_header CF-Connecting-IP;
real_ip_recursive off;
```

so `$remote_addr` and `$binary_remote_addr` become the canonical recipient. That
is deliberate: every downstream directive keeps its PUBLIC-SHARE-3 spelling and
becomes per-recipient with no further change, instead of the header and the
limiter each growing a special case. If the image ever lacked the module,
`set_real_ip_from` would be an unknown directive and the gateway would fail to
start — the intended direction.

`realip` alone is **not** enough. It silently does nothing when the header is
missing or unparsable — which would attribute every recipient to the connector —
and it reads only the FIRST matching header when several arrive. So four
independent controls gate the share route, and all four must pass:

| Control | Denies when |
| :--- | :--- |
| `$aegis_edge_peer_untrusted` | the immediate TCP peer is not the pinned connector |
| `$aegis_edge_recipient_absent` | the connector sent no `CF-Connecting-IP` at all |
| `$aegis_edge_recipient_ambiguous` | more than one recipient identity arrived (`$http_cf_connecting_ip` joins repeated headers with `", "`) |
| `$aegis_edge_not_canonical` | `$remote_addr` is still the connector — an unparsable value, or a `realip` configuration that did not apply |

The ambiguity control exists because of a measured behaviour, not a
hypothetical: **nginx's `realip` module reads the first matching header and
ignores the rest.** Without it, a request carrying two `CF-Connecting-IP`
headers is accepted and attributed to whichever arrived first — a
caller-influenced choice. Refusing is the only honest answer to two different
claims about who the recipient is.

Two nginx behaviours worth recording because they were measured rather than
assumed:

- `CF-Connecting-IP: <address>:<port>` **is** accepted, and canonicalises to the
  bare address. Attribution is still the right recipient, so this is asserted as
  correct behaviour rather than refused.
- IPv6 recipients work end to end. `realip` canonicalises the address, the
  gateway authors it into `X-Forwarded-For`, Express resolves `req.ip` to it, and
  `audit_log.source_ip` is `INET`, which holds it. A `zones` share would still be
  IPv4-only in `ipAllowed()`, but a `zones` share can never be redeemed through
  the public ingress, so no IPv6 path is lossy here.

The gate returns **403 in the rewrite phase**, before `limit_req` (preaccess) and
before `proxy_pass`, so a refused request consumes no rate-limit token and never
reaches Drive.

## What Drive does *not* do

Nothing in `IDEA1-AEGIS_Drive_LC/server/` changed for this task, and that is the
design, not an omission:

- `requestSourceIp(req) → req.ip` remains the sole application client-source
  accessor. No route parses `CF-Connecting-IP` or any other forwarding header.
- `requestIngressKind(req)` still classifies the **gateway's upstream peer**,
  never the connector and never the recipient. If `realip` had leaked into
  Drive's view of the peer, a `scope=any` share would have been treated as
  private and delivered — `PS7-PRE-08` is what would catch that.
- `TRUSTED_PROXY_CIDRS` is **not** widened. It still names the HUB identity and
  the one gateway `/32`. No Cloudflare range, no RFC1918 subnet, no Docker
  bridge range and no `0.0.0.0/0` appears anywhere.

The provider identity headers are consumed at the gateway and never relayed
(`CF-Connecting-IP`, `CF-Connecting-IPv6`, `CF-Pseudo-IPv4`, `True-Client-IP`,
`CF-Visitor`, `CF-IPCountry`, `CF-Ray`, `CF-Worker`, `CDN-Loop`), in **both**
modes — so a direct caller cannot smuggle one past a direct-mode gateway either,
and no future Drive route can be tempted to parse a header it never receives.

## The database is deliberately current

Unlike the PUBLIC-SHARE-6 harness, `db-init/` does **not** roll the shares scope
CHECK back to its 008-era shape. Migration 009 is PUBLIC-SHARE-6's evidence, and
repeating it here would add no finding while coupling this task to a question it
is not asking.

## Running it on the AEGIS server host

`run-pre-exposure.sh` is the PUBLIC-SHARE-6 Stage B safety model applied to this
harness. From a quiet window:

```bash
sudo -v                                                   # the OWNER, by hand
sh gateway/public-share/managed-tunnel/run-pre-exposure.sh
```

It refuses to start unless every precondition holds, captures a read-only
Production inventory before and after, tears down everything it created, and
then verifies that:

- the Production inventory is byte-identical pre and post;
- every Production container is still healthy;
- `aegis_postgres_data` and `aegis_drive_storage` still exist;
- no PS7 container, network, volume or image survives;
- each image the project built is gone **by ID**;
- the three base images were **not** removed;
- every `aegis-prod` row is unchanged;
- the Compose env file and the temporary directory are gone.

Unlike the PS6 runner it does **not** clone: the PS7 branch is not published, so
the only honest source is the checkout the script is part of. That checkout is
used read-only, and guard 2 refuses to run at all from
`/opt/aegis/Project-End-The-AEGIS`.

`sudo -n` only. The runner never prompts for, handles, stores or echoes a
credential, and there is no `sudo -E`, no `--preserve-env`, no sudoers change, no
docker-group change and no daemon configuration change anywhere in it.

## What it does not prove

- Nothing about a **real** tunnel, a real provider edge, real DNS, real TLS, a
  real public URL, or a recipient on real Internet access.
- Nothing about the **perimeter**. The isolation claims here are Docker-network
  claims. MikroTik, UFW, VLAN and Twingate were not configured or measured.
- Nothing about **Production**. No Production gateway exists, migration 009 has
  not been applied to Production, and `PUBLIC_SHARE_UI_ENABLED` is off.
- Nothing about whether a **real** cloudflared deployment can satisfy these
  isolation properties. In this harness the connector sits on an internal,
  isolated Docker network with no route to Drive, PostgreSQL or a private
  surface. A real connector needs an outbound Internet path, so reproducing
  "the connector cannot reach anything but the gateway" in Production is a
  **deployment gate** for the external phase — host firewall and/or VLAN work,
  not something source can assert.
