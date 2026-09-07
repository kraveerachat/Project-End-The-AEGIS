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

The Compose harness creates `aegis_public_share` as a dedicated `/29` bridge
with exactly two source/test identities. Each harness service joins only that
network; this is not a claim that Docker's `internal: true` mode is enabled:

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

Run the focused checks from `IDEA1-AEGIS_Drive_LC`:

```powershell
node --test tests/publicShareGatewayStructure.test.js
$env:PUBLIC_SHARE_GATEWAY_RUNTIME='1'
node --test tests/publicShareGatewayRuntime.test.js
Remove-Item Env:PUBLIC_SHARE_GATEWAY_RUNTIME
```

The runtime suite chooses a free localhost port, builds a unique Compose
project, refuses to adopt a pre-existing `aegis_public_share` network, and
removes only its own throwaway containers/network afterwards.
