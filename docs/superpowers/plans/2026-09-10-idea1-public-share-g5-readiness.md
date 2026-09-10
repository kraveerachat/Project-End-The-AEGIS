# PUBLIC-SHARE-7 S5.2 — G5 Readiness Design

**Date:** 2026-09-10
**Area / owner:** `idea1` / `kla`
**Task branch:** `docs/idea1-public-share-g5-readiness`
**Repository base:** `618543ee0d88613a651305962b5ed64c8593c2e5`
**Production mutation allowed:** **NO**

## 1. Decision and present result

This document freezes the candidate Production network topology, trust
boundaries, backend-neutral firewall contract, probes, rollback order, and the
next mutation boundaries for PUBLIC-SHARE-7. It is a design/readiness artifact,
not an executable deployment script.

The repository collision review found no tracked Production use of the three
candidate `/29` ranges below. They are therefore frozen for this design,
subject to a fresh read-only runtime collision check before any network is
created. The exact host-firewall commands remain **BLOCKED / PENDING
MEASUREMENT** because the Docker firewall backend, nftables/iptables hook path,
UFW forwarding integration, real bridge interfaces, IPv4 forwarding state, and
connector DNS path have not yet been measured on Production.

Consequently:

- S5.2 documentation/design = delivered;
- G5 readiness = **BLOCKED / NOT READY**;
- domain ownership = **NOT VERIFIED**;
- Cloudflare zone = **NOT VERIFIED**;
- G5 = **OPEN**;
- G6 = **OPEN**;
- Public Internet Share = **NOT IMPLEMENTED**.

No Production host, provider account, DNS zone, firewall, Docker runtime,
database, tunnel, secret, or feature flag was accessed or changed in S5.2.

## 2. Frozen candidate network baseline

| Network | Subnet | Docker behavior | Members and static addresses |
| :--- | :--- | :--- | :--- |
| edge | `172.31.240.0/29` | `internal: true`; `gateway_mode_ipv4=isolated`; no host-published ports | Gateway `.2`; connector `.3` |
| upstream | `172.31.241.0/29` | `internal: true`; `gateway_mode_ipv4=isolated`; no host-published ports | Gateway `.2`; Drive `.3` |
| egress | `172.31.242.0/29` | dedicated NAT bridge; no inbound published ports; stable bridge interface `aegis-ps-eg` | connector `.2` only |

The egress bridge identity is part of the policy contract and must be verified
after Docker creates it. A different or missing bridge identity is fail-closed,
not a reason to substitute a guessed interface.

```text
Cloudflare edge
       ^ TCP/UDP 7844 only
       |
cloudflared
  edge 172.31.240.3 ──────> Gateway 172.31.240.2:8080
  egress 172.31.242.2          |
                               | upstream only
                               v
                         Drive 172.31.241.3:8001
```

Drive retains every existing private Production membership needed by HUB and
current private workflows. The gateway joins only edge and upstream. The
connector joins only edge and egress. No Public Share component publishes a
host port.

Before S5.4, read-only runtime evidence must prove that all three ranges are
unused by host routes, Docker networks, VPN/Twingate routes, VLANs, or other
site networks. Any collision reopens subnet selection and requires owner
review; it must not be worked around during mutation.

## 3. Exact application trust boundaries

Drive may trust only these reverse-proxy peers:

- existing HUB: `172.19.255.2/32`;
- Public Share Gateway: `172.31.241.2/32`.

The intended Drive contract is therefore an exact `TRUSTED_PROXY_CIDRS` set of
those two `/32` values and `PUBLIC_SHARE_GATEWAY_CIDR=172.31.241.2/32`.
Cloudflare/provider ranges must never be included in Drive proxy trust.

The Public Share Gateway may trust provider attribution headers only when its
direct edge peer is the connector at `172.31.240.3/32`. The connector origin is
the gateway at `172.31.240.2:8080`; it never targets Drive directly.

Wider CIDRs, bridge subnets, provider CIDRs, a second gateway peer, or a direct
connector-to-Drive path fail the gate.

## 4. Backend-neutral connector isolation contract

The connector egress policy is host-enforced and defaults to deny. It is not a
`DOCKER-USER`-only design: the enforcement attachment point must match the
firewall backend and effective host hook path measured in the owner-run
preflight.

Required logical order:

1. Match the exact egress bridge and connector source `172.31.242.2`.
2. Drop invalid state; allow only return traffic for explicitly permitted
   connector flows.
3. Allow DNS only through the measured, explicitly approved resolver path.
4. Allow connector egress over **TCP and UDP 7844** only to the current official
   Cloudflare Tunnel endpoint allowlist.
5. Deny loopback, link-local, multicast, RFC1918, other Docker bridges, site
   LAN/VLAN/VPN ranges, host-private addresses, and all AEGIS service networks.
6. Deny all other connector egress by default.
7. Deny new inbound or forwarded flows to the connector.
8. Keep TCP 443 denied. It may be added only by a separate reviewed change that
   proves an optional Cloudflare feature requires it.

The policy must not permit the gateway to use the Internet. The internal edge
path permits only connector-to-gateway on the approved listener; the internal
upstream path permits only gateway-to-Drive on the approved listener.

### Backend-specific attachment — pending measurement

- If Docker is using the iptables backend, use a dedicated task-owned chain
  reached from the measured effective Docker/UFW forwarding path. Do not assume
  that a named `DOCKER-USER` chain alone covers host-local traffic or every
  relevant path.
- If Docker is using the nftables backend, use a separate task-owned nftables
  table and base chains with explicitly reviewed hooks and priorities. Never
  edit Docker-owned nftables tables, and do not invent a `DOCKER-USER`
  equivalent.
- Host-local INPUT, forwarded egress, return traffic, UFW integration, and
  Docker daemon restart behavior must each be covered where the measured packet
  path requires it.

No executable `iptables`, `nft`, or UFW command is approved by this document.
Producing one before preflight would guess at security-critical state.

## 5. Required owner-run read-only preflight

The owner must capture a narrow, redacted snapshot on Production before exact
commands can be reviewed:

- Docker version, daemon configuration/flags, and selected firewall backend;
- `iptables` implementation/version, `FORWARD` and effective `DOCKER-USER`
  path, plus relevant iptables-nft state;
- nftables tables, relevant base chains, hooks, and priorities;
- UFW status and its real forwarding integration/default policy;
- `net.ipv4.ip_forward` and relevant IPv6 state;
- host routes, Docker network subnets/options/IDs, and actual bridge interface
  names;
- connector namespace resolver configuration, Docker embedded-DNS behavior,
  upstream resolver, and the observed source/interface used by DNS traffic.

The capture must not print `.env` contents, tunnel credentials, tokens,
passwords, cookies, private keys, or full unrelated rulesets. If a fact cannot
be measured safely, the corresponding rule stays blocked.

Immediately before S5.5 mutation, refresh Cloudflare's official Tunnel endpoint
and port documentation. The allowlist used in the reviewed rules must be bound
to that dated evidence; stale copied provider ranges are not accepted.

## 6. Persistence and fail-closed startup

After preflight, the executable design must provide one task-owned policy unit
that runs after Docker and the egress network exist but before the connector can
start. It must:

- verify backend, subnet, bridge identity, connector address, and expected rule
  attachment points;
- install rules atomically or leave the connector stopped;
- verify the installed policy before allowing connector startup;
- prevent an independent container restart from racing ahead of policy after a
  Docker or host restart;
- remove only task-owned rules during rollback; and
- fail closed when any expected identity or rule differs.

Exact systemd dependencies and restart behavior remain pending the same
preflight and the later pinned connector image/runtime contract.

## 7. Acceptance probes before G5

### Positive controls

- connector → Gateway `172.31.240.2:8080` = ALLOW;
- connector DNS resolution through the one approved measured path = ALLOW;
- connector → every current required Cloudflare endpoint on TCP 7844 = ALLOW;
- connector → every current required Cloudflare endpoint on UDP 7844 = ALLOW;
- Gateway → Drive `172.31.241.3:8001` = ALLOW;
- Drive observes the gateway as direct proxy peer while the validated adapter
  handles provider-asserted recipient attribution.

### Negative controls

- connector → Drive direct = DENY;
- connector → PostgreSQL = DENY;
- connector → HUB = DENY;
- connector → Monitor = DENY;
- connector → host-private services = DENY;
- connector → private Docker/LAN/VLAN/VPN ranges = DENY;
- connector → Internet TCP 443 and every non-approved port/destination = DENY;
- Gateway → Internet = DENY;
- Gateway → every private service except Drive's approved listener = DENY;
- wider Drive proxy trust = FAIL;
- provider CIDR in Drive trust = FAIL;
- public host listener, inbound NAT, or public route before G5 = FAIL.

Use known-live targets where safe so a transport denial is distinguishable from
an absent service. A successful TCP/HTTP exchange is a failure. For a known-live
target, `Connection refused` also proves that the route reached the target and
therefore fails an isolation negative; timeout/unreachable plus packet/rule
counters are the expected denial evidence. Any unexpected private reachability
stops the session; no exception may be added merely to make a probe pass.

## 8. Mutation boundaries after this task

- **S5.3 (not authorised):** freeze exact release/image provenance, take the
  approved backup, apply migration 009, and deploy only Drive in private mode
  with `PUBLIC_SHARE_UI_ENABLED=false`.
- **S5.4 (not authorised):** create edge/upstream, attach Drive at the exact
  reviewed trust boundary, deploy the gateway, and verify private/internal
  behavior with no public route.
- **S5.5 (not authorised):** recheck the Cloudflare allowlist, create egress,
  apply the measured backend-specific policy, start the digest-pinned connector
  without a hostname route, and run every positive/negative isolation probe.
- **G5:** remains a separate explicit owner decision after S5.3–S5.5 evidence.
  It is the first authority for a public hostname route; this document does not
  grant it.

## 9. Reverse-order rollback contract

Rollback starts at the highest deployed layer:

1. Remove/disable any public hostname route and DNS record first if they exist.
2. Stop the connector.
3. Remove only the task-owned connector policy using the backend-specific
   rollback reviewed after preflight; prove no residue.
4. Remove the connector and egress network.
5. Stop/remove the gateway, then edge.
6. Detach Drive from upstream and restore its captured prior private proxy
   configuration/image; then remove upstream.
7. Keep `PUBLIC_SHARE_UI_ENABLED=false`.
8. Keep migration 009 unless measured corruption/data loss triggers a separate
   owner-approved restore.
9. Verify PostgreSQL, Drive, HUB, Monitor, Twingate, private login/shares/audit,
   protected volumes, host listeners, routes, rules, networks, DNS, and tunnel
   state.

Never run whole-stack `down`, `down -v`, prune, broad firewall flushes, or
destructive database/volume cleanup.

## 10. References checked for this design

- Docker with nftables: <https://docs.docker.com/engine/network/firewall-nftables/>
- Docker port publishing and gateway modes: <https://docs.docker.com/engine/network/port-publishing/>
- Cloudflare Tunnel firewall requirements: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/>
- Cloudflare Tunnel connectivity prechecks: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/>

These references inform the design but do not replace the required Production
measurement or the immediate pre-S5.5 allowlist freshness check.
