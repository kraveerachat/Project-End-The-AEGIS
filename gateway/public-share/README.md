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

## Local harness

The Compose harness creates `aegis_public_share` as a dedicated `/29` bridge
with exactly two source/test identities. Each harness service joins only that
network:

| Service | Address | Host-published port |
| --- | --- | --- |
| `public-share-gateway` | `172.31.254.2` | localhost-only test listener |
| `drive` test recorder | `172.31.254.3` | none |

These addresses are source/test identities, not evidence of a deployed
Production network. The isolated harness uses `172.31.254.0/29` because an
existing local test network owns `172.19.0.0/16`; Docker correctly refuses an
overlapping `172.19.254.0/29`. No existing network is modified or removed. The
recorder proves gateway routing and header behavior; it does not prove real
Drive authorization.

### Open item — B5 no-egress is not yet enforced by the harness network

The harness proves exactly two members, gateway-joins-no-other-network, and the
absence of unrelated AEGIS DNS names. It does **not** yet set Docker
`internal: true`, so it does not enforce architecture boundary **B5**
(`Gateway -> everything else = nothing`); a normal user-defined bridge still
reaches the host/NAT boundary.

Setting `internal: true` was measured on this Docker Desktop environment
(Docker 28.3.2, linux containers) and **does** deliver the B5 property, but it
also disables port publishing entirely, which removes the localhost-only
listener the runtime suite needs:

```text
docker network inspect aegis_public_share -> Internal=true, exactly 2 members
gateway -> drive:8001                     -> works
gateway -> 1.1.1.1                        -> "Network unreachable"   (B5 holds)
HostConfig.PortBindings                   -> {"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"18081"}]}
NetworkSettings.Ports                     -> {"8080/tcp":[]}          (silently not published)
docker port <gateway>                     -> empty; no host listener
host -> 127.0.0.1:18081                   -> ECONNREFUSED
```

Docker accepts the publish request and drops it without any warning. With
`internal: true` applied, 11 of the 15 runtime checks fail at connection setup.
Disabling masquerading instead (`com.docker.network.bridge.enable_ip_masquerade:
"false"`) was also measured and does **not** block egress here, so it is not a
substitute.

Resolving this needs an owner/security decision, because every option changes
an accepted PR3 property: drive the gateway from inside the container instead
of a published port, add a third client member to the network, or accept
enforcing B5 only at the PUBLIC-SHARE-6 real-stack/perimeter phase. **The
isolation requirement is not removed here, and no option was chosen.**

## Running the focused checks

Run from `IDEA1-AEGIS_Drive_LC`:

```powershell
node --test tests/publicShareGatewayStructure.test.js
$env:PUBLIC_SHARE_GATEWAY_RUNTIME='1'
node --test tests/publicShareGatewayRuntime.test.js
Remove-Item Env:PUBLIC_SHARE_GATEWAY_RUNTIME
```

The runtime suite chooses a free localhost port, builds a unique Compose
project, refuses to adopt a pre-existing `aegis_public_share` network, and
removes only its own throwaway containers/network afterwards.
