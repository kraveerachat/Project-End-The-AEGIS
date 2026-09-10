# AEGIS Dedicated Public Share Gateway

This directory is the source and isolated runtime harness for
**PUBLIC-SHARE-3**. It is deliberately separate from `gateway/nginx.conf` and
the root development stack.

Current truth:

- gateway source: implemented for local verification;
- Production gateway/deployment: no;
- TLS, DNS, NAT, tunnel, firewall, VLAN, or Internet ingress: no;
- public scope in the IDEA1 UI: disabled;
- PUBLIC-SHARE-4/5/6/7: not started by this work.

PUBLIC-SHARE-7 later added the managed-proxy edge trust adapter to this same
image. It is **off by default**: with `PUBLIC_SHARE_EDGE_MODE` unset the gateway
behaves exactly as described below, and the direct-peer model in
"Limitation — the header and rate-limit model assumes a direct peer" is what
runs. See `managed-tunnel/README.md` for the managed model, and the note at the
end of that section for what PUBLIC-SHARE-7 does and does not settle.

The public listener accepts only `GET|POST /s/[A-Za-z0-9_-]+/?`, for the
configured `PUBLIC_SHARE_HOST`, and terminates everything else locally. It
overwrites forwarding identity, streams responses without proxy buffering,
limits bodies to 16 KiB, and applies an edge limit of 5 requests/second with a
burst of 10 per observed edge address. That rate is a conservative tunable
implementation default, not business policy or large-transfer evidence.

## `PUBLIC_SHARE_HOST` is a validated allowlist boundary

`PUBLIC_SHARE_HOST` is **a hostname only**:

```text
PUBLIC_SHARE_BASE_URL=https://share.example.invalid   # backend (PUBLIC-SHARE-2)
PUBLIC_SHARE_HOST=share.example.invalid               # gateway (this directory)
```

It must equal the **hostname component** of the backend's already-validated
`PUBLIC_SHARE_BASE_URL`. No scheme, port, path, query, fragment, credential,
wildcard, nginx regex prefix, or list of names.

The value is not a secret, but it is substituted into nginx *directive context*
(`server_name`, `proxy_set_header Host`, `proxy_set_header X-Forwarded-Host`),
so a malformed value is a configuration-injection and allowlist-integrity
problem, not a cosmetic one. Left unchecked it could widen the accepted `Host`
set, alter nginx parsing, inject an extra directive or `location`, turn this
single-host gateway into virtual-host multiplexing, or make the generated
config ambiguous.

`validate-public-share-host.sh` therefore runs **before** the template is
rendered, from the wrapper `entrypoint.sh`, and **refuses to start** rather
than sanitising a bad value:

| File | Installed as | Role |
| --- | --- | --- |
| `validate-public-share-host.sh` | `/usr/local/bin/aegis-validate-public-share-host.sh` | Fail-closed hostname grammar check |
| `entrypoint.sh` | `/usr/local/bin/aegis-public-share-entrypoint.sh` | Image `ENTRYPOINT`; validates, then hands over to the stock nginx entrypoint |

Gating in the wrapper — rather than only in `/docker-entrypoint.d/` — keeps the
refusal independent of the base image's own error handling. On refusal
`/tmp/nginx.conf` is never rendered, so nginx cannot start with a config the
value could have altered, and the container exits non-zero.

The image also sets `NGINX_ENVSUBST_FILTER=^PUBLIC_SHARE_HOST$`, so
`PUBLIC_SHARE_HOST` is the **only** variable envsubst may substitute. By default
the base image feeds every defined environment variable to envsubst, so a
variable that happens to be named after an nginx variable used in the template
would silently rewrite it — an environment with `remote_addr=...` set turns
`proxy_set_header X-Forwarded-For $remote_addr;` into a fixed attacker-chosen
string, breaking G3 attribution and the T-05 rate-limit axis. `PS3-RUNTIME-13b`
proves this cannot happen.

The grammar accepts one RFC 1123 host name: the characters `A-Za-z0-9.-` only,
labels of 1–63 characters that neither begin nor end with `-`, no empty label,
no leading or trailing dot, at most 253 characters in total, and no all-numeric
final label (which also keeps bare IP literals out of the hostname-only
contract). Everything else — including whitespace, multiple names, `;`, `{`,
`}`, `$`, `/`, backslash, newline, carriage return, tab, `*`, `~`, a scheme, a
path, a query, a fragment, credentials, and `host:port` — fails startup.
The refusal message never echoes the rejected value back into the log.

If a future public origin needs a non-default port, PUBLIC-SHARE-6 / G4 must
explicitly reconcile the public `Host` / `X-Forwarded-Host` contract. **No
deployment port is invented here.**

## Limitation — the header and rate-limit model assumes a direct peer

The delivered PR3 header/rate-limit model assumes the gateway is the immediate
recipient-facing HTTP peer. It authors `X-Forwarded-For` and `X-Real-IP` from
`$remote_addr` and keys the edge limit on `$binary_remote_addr`.

If G4 later selects a managed reverse proxy/tunnel that inserts an HTTP hop,
PUBLIC-SHARE-6 / the ingress integration task must define and review the
provider trust/attribution adapter before deployment. Otherwise `$remote_addr`
identifies the tunnel/provider connector rather than the actual recipient,
which would cause incorrect G3 attribution, collapse every recipient onto one
address, and re-create the T-05 rate-limit self-DoS.

PR3 does not authorize trusting provider headers and does not claim Option B is
deployable unchanged. **G4 remains open and is not chosen here.**

### PUBLIC-SHARE-7 answers that limitation in source, and only in source

The adapter the paragraph above demanded now exists in this image, as a second
fail-closed startup gate plus a generated nginx include:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_SHARE_EDGE_MODE` | `direct` | `direct` keeps the model above, unchanged. `cloudflare` inserts the managed-proxy trust model. Anything else refuses to start. |
| `PUBLIC_SHARE_EDGE_PROXY_CIDR` | unset | Required **iff** the mode is `cloudflare`: exactly one pinned tunnel-connector identity as an IPv4 `/32`. Set without that mode, it refuses to start rather than being silently ignored. |

| File | Installed as | Role |
| --- | --- | --- |
| `validate-public-share-edge.sh` | `/usr/local/bin/aegis-validate-public-share-edge.sh` | Validates both values fail-closed, then generates `/tmp/aegis-edge/http.conf` |

`entrypoint.sh` runs it after the host validator and before the handover, so
neither value can reach a rendered config unless both are valid. The template
includes the generated file at an **exact** path, so a gateway whose trust model
was never generated does not start.

`NGINX_ENVSUBST_FILTER=^PUBLIC_SHARE_HOST$` is **unchanged**: the new values
never pass through envsubst. The one value that reaches nginx directive context —
the connector address — is validated character by character and emitted by the
validator itself, not substituted into a template.

In `cloudflare` mode nginx's own `realip` module canonicalises `$remote_addr` and
`$binary_remote_addr` from `CF-Connecting-IP`, but **only** behind the pinned
peer, so the authored `X-Forwarded-For`/`X-Real-IP` and the `$binary_remote_addr`
edge limit keep their spelling above and become per-recipient. Because `realip`
does nothing at all when the header is missing or unparsable — and reads only the
FIRST matching header when several arrive — four independent controls gate the
share route and all four must pass: the peer must be the pinned connector, the
provider header must be present, it must not be ambiguous (more than one claim),
and canonicalisation must actually have happened. The gate returns 403 in the rewrite phase, before `limit_req` and
before `proxy_pass`.

The provider identity headers are also stripped before Drive in **both** modes
(`CF-Connecting-IP`, `CF-Connecting-IPv6`, `CF-Pseudo-IPv4`, `True-Client-IP`,
`CF-Visitor`, `CF-IPCountry`, `CF-Ray`, `CF-Worker`, `CDN-Loop`).

⚠️ **This is source and local acceptance, not an ingress decision.** G4 is still
not recorded as chosen by this work, no tunnel exists, and nothing is exposed.
`managed-tunnel/` measures the adapter against the real Drive on an isolated
Docker topology; it is not evidence that a real tunnel, DNS name or certificate
works. G5 and G6 remain **OPEN**.

## Local harness

The Compose harness creates `aegis_public_share` as a dedicated `/29` bridge
with exactly two source/test identities. Each harness service joins only that
network:

| Service | Address | Host-published port |
| --- | --- | --- |
| `public-share-gateway` | `172.31.254.2` | none |
| `drive` test recorder | `172.31.254.3` | none |

These addresses are source/test identities, not evidence of a deployed
Production network. The isolated harness uses `172.31.254.0/29` because an
existing local test network owns `172.19.0.0/16`; Docker correctly refuses an
overlapping `172.19.254.0/29`. No existing network is modified or removed. The
recorder proves gateway routing and header behavior; it does not prove real
Drive authorization.

### B5 is enforced by two network controls

Architecture boundary **B5** is `Gateway -> PostgreSQL, Monitor, HUB, host =
nothing`. `internal: true` alone does **not** prove that statement, and the
harness does not claim it does:

```text
internal: true
  -> removes normal external/default-route connectivity

com.docker.network.bridge.gateway_mode_ipv4: "isolated"
  -> removes the Docker-host bridge address for the internal network

together
  -> source/test enforcement of the PR3 B5 Docker-network boundary
```

An ordinary internal bridge still keeps the Docker-host bridge address, and
appropriately configured host services stay reachable through it. Docker Engine
28 adds `gateway_mode_ipv4: isolated`, valid alongside `internal`, which removes
that address; the engine here is 28.3.2.

Measured side by side on this host, same subnet, same settings apart from the
option — this is why both controls are required:

```text
internal only            ARP 172.31.x.1 -> 96:f2:69:3e:4a:47 (complete)
                         http://172.31.x.1/ -> "Connection refused"
                         (address is LIVE; a host service bound there is reachable)

internal + isolated      ARP 172.31.x.1 -> 00:00:00:00:00:00 (incomplete)
                         http://172.31.x.1/ -> "Host is unreachable"
                         (nothing holds the address at all)
```

Measured on the real harness (Docker 28.3.2, Docker Desktop, linux containers):

```text
docker network inspect aegis_public_share
  Internal                                -> true
  Options[...gateway_mode_ipv4]           -> "isolated"
  members                                 -> 2
                                             172.31.254.2  public-share-gateway
                                             172.31.254.3  drive
gateway networks                          -> 1 (aegis_public_share)
drive networks                            -> 1 (aegis_public_share)
gateway published ports                   -> {}   (docker port: empty)
drive published ports                     -> {}   (docker port: empty)
gateway -> drive:8001                     -> {"ok":true}
drive -> gateway:8080                     -> 200
gateway -> 1.1.1.1 / 8.8.8.8              -> "Network unreachable"
ip route (gateway)                        -> 172.31.254.0/29 dev eth0 scope link
                                             src 172.31.254.2      (no default route)
172.31.254.1 tcp 22/53/80/443/445/3389/5432/8080 -> all unreachable
http://172.31.254.1/                      -> "Host is unreachable"
host.docker.internal                      -> SERVFAIL (does not resolve)
gateway.docker.internal                   -> SERVFAIL (does not resolve)
nginx -t                                  -> test is successful
```

No probe demonstrated a usable host-service path. This is a **Docker-network**
claim only: it is not MikroTik, UFW, VLAN, Twingate, or any Production perimeter
isolation, none of which was configured or measured.

**Neither member publishes a host port, and that is deliberate.** Docker cannot
publish a port from an internal network — it accepts the request and silently
drops it, leaving `NetworkSettings.Ports` empty with no warning — and B5 forbids
a host path to the gateway in any case. `PS3-STRUCT-1` pins **both**
`internal: true` and the isolated gateway mode, so removing either fails the
suite; `PS3-RUNTIME-1` re-checks `Internal=true`, the `isolated` option, both
membership counts, and the absence of published ports on the real network;
`PS3-RUNTIME-1b` checks the route table and egress; `PS3-RUNTIME-1c` runs the
host-path probes above.

Because there is no host listener, the runtime suite generates every HTTP
request **from inside the network, using only the two existing members**:

- the `drive` test recorder drives the gateway at `http://public-share-gateway:8080`
  (raw `node:http`, not `fetch`, so a request target such as `/s/token/../api`
  reaches the traversal guard unnormalised);
- the gateway drives its own listener over `127.0.0.1:8080` for the
  upstream-failure and token-log check, where the recorder must be stopped.

No third client container is added.

Disabling masquerading instead (`com.docker.network.bridge.enable_ip_masquerade:
"false"`) was also measured and does **not** block egress here, so it is not a
substitute for `internal: true`.

## Running the focused checks

Run from `IDEA1-AEGIS_Drive_LC`:

```powershell
node --test tests/publicShareGatewayStructure.test.js
$env:PUBLIC_SHARE_GATEWAY_RUNTIME='1'
node --test tests/publicShareGatewayRuntime.test.js
Remove-Item Env:PUBLIC_SHARE_GATEWAY_RUNTIME
```

The runtime suite builds a unique Compose project, refuses to adopt a
pre-existing `aegis_public_share` network, drives the gateway only from inside
that network, and removes only its own throwaway containers/network afterwards.
It needs no host port and opens none.

The PUBLIC-SHARE-7 managed-proxy adapter has its own suite. Its static half runs
by default; its Docker half is opt-in the same way:

```bash
cd IDEA1-AEGIS_Drive_LC
node --test tests/publicShareManagedTunnelIntegration.test.js          # PS7-STRUCT only
PUBLIC_SHARE_MANAGED_TUNNEL_RUNTIME=1 node --test --test-concurrency=1 \
  --test-timeout=1800000 tests/publicShareManagedTunnelIntegration.test.js
```
