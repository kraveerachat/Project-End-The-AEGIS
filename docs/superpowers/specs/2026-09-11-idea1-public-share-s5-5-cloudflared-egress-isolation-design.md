# IDEA1 Public Share S5.5 Cloudflared / Egress / Firewall Isolation Design

**Date:** 2026-09-11

**Task:** PUBLIC-SHARE-7 / S5.5

**Phase:** S5.5-B — Design / Repository Preparation

**Area / owner:** `idea1` / `kla`

**Branch:** `feat/idea1-public-share-s5-5-cloudflared-egress-isolation`

**Draft PR:** #118

**Status:** OWNER-APPROVED DESIGN; NOT IMPLEMENTED; PRODUCTION ACCEPTANCE REQUIRED

## 1. Decision and safety boundary

The owner approved this design on 2026-09-11. This document closes the S5.5-B
design question only. It does not authorise S5.5-C, create a connector or
network, install a firewall rule, create a Cloudflare Tunnel or route, publish
DNS, enable the Public Share UI, or establish Internet exposure.

```text
PRODUCTION_MUTATION_ALLOWED=NO
DOCKER_MUTATION_PERFORMED=NO
FIREWALL_MUTATION_PERFORMED=NO
CLOUDFLARE_MUTATION_PERFORMED=NO
DNS_MUTATION_PERFORMED=NO
PUBLIC_SHARE_UI=OFF
INTERNET_EXPOSURE=NONE
G5=OPEN
```

The accepted S5.4 overlay remains immutable:

```text
gateway/public-share/production/docker-compose.s5-4.yml
```

S5.5 will be expressed later as a separate overlay:

```text
gateway/public-share/production/docker-compose.s5-5.yml
```

This preserves the accepted S5.4 baseline, makes the S5.4 → S5.5 change
reviewable, and lets rollback remove only S5.5 objects.

## 2. Verified current state

S5.5-A is **CLOSED / PASS**. The following are measured Production facts, not
design assumptions:

| Boundary | Verified current state |
| :--- | :--- |
| Docker | Engine/client `29.7.1`; the real root Docker API and container inventory passed |
| Firewall | `iptables v1.8.11 (nf_tables)` through iptables-nft/nftables; `INPUT DROP`, `FORWARD DROP`; forwarding traverses `DOCKER-USER` before `DOCKER-FORWARD` |
| UFW | active; default incoming deny, outgoing allow, routed deny |
| IPv4 forwarding | `net.ipv4.ip_forward=1` |
| Edge | `aegis_public_share_edge`, internal, `172.31.240.0/29`; Gateway only at `.2`; `.3` reserved for the connector |
| Upstream | `aegis_public_share_upstream`, internal, `172.31.241.0/29`; Gateway `.2`; Drive `.3` |
| Gateway | healthy; edge + upstream only; no host-published port |
| Drive | healthy in accepted State B; upstream plus its existing private networks; no egress attachment |
| Future egress | named network, bridge, host address, host route and Docker subnet all absent; `172.31.242.0/29` has no measured collision |
| cloudflared | container, systemd service and host binary absent |
| Cloudflare transport | region1/region2 DNS and TCP/7844 passed; UDP/7844 not tested; TCP/443 not approved |
| Public state | `share.aegistk-pb.com` has no public DNS answer; UI is false; exposure is none |

These facts agree with the load-bearing S5.2 firewall assumptions and the
accepted S5.4 runtime topology. S5.2's former backend/forwarding uncertainty is
resolved by S5.5-A measurement. S5.4's connector and egress reservations remain
unconsumed.

## 3. Designed target topology

```text
Cloudflare network
        ^
        | outbound HTTP/2 tunnel over TCP/7844
        |
public-share-connector (cloudflared)
        +-- aegis_public_share_edge:   172.31.240.3
        +-- aegis_public_share_egress: 172.31.242.2
                    |
                    | NAT through the Docker host, policy-filtered
                    |
Public Share Gateway
        +-- aegis_public_share_edge:     172.31.240.2
        +-- aegis_public_share_upstream: 172.31.241.2
                    |
Drive
        +-- aegis_public_share_upstream: 172.31.241.3
        +-- existing private networks only
```

Exact attachment invariants:

| Service | Required networks | Forbidden additions |
| :--- | :--- | :--- |
| `public-share-connector` | edge + egress, exactly two | upstream, Drive/private networks, database, HUB, Monitor, Twingate and default network |
| `public-share-gateway` | edge + upstream, exactly two | egress, database/private networks and default network |
| `drive` | accepted S5.4 upstream plus existing private networks | edge and egress |

An attachment mismatch is an unsafe topology. Pre-start validation must refuse
to start the connector; runtime validation must stop it if an unsafe attachment
is discovered.

## 4. S5.5 egress network contract

The future `aegis_public_share_egress` network has this exact model:

| Property | Design |
| :--- | :--- |
| Compose/network name | `aegis_public_share_egress` |
| Driver | Docker user-defined `bridge` |
| `internal` | explicitly `false` |
| IPv4 subnet | `172.31.242.0/29` |
| Gateway | `172.31.242.1` |
| Connector address | `172.31.242.2` |
| Linux bridge | `aegis-ps-eg` through `com.docker.network.bridge.name` |
| Masquerading | enabled; `com.docker.network.bridge.enable_ip_masquerade=true` |
| Gateway mode | Docker bridge default `nat`; it must not be `routed`, `nat-unprotected`, or `isolated` |
| IPv6 | not enabled or used by this S5.5 contract |
| Host-published ports | none |

Docker documents `com.docker.network.bridge.name`, default bridge masquerading,
and default `nat` gateway mode. Compose documents that `internal: true` removes
external connectivity; this network is deliberately `false` because
cloudflared requires outbound transport.

The existing host forwarding setting permits the bridge path, while Docker's
NAT rewrites outbound connector traffic to a host egress address. The S5.5
firewall contract below restricts what may traverse that path.

This does not add an inbound listener. No `ports` entry is permitted for the
connector, and the named tunnel is initiated outbound. Direct-routed access is
not part of the design. A compose-model test and Production socket/port
inventory must prove this rather than relying on the explanation alone.

References:

- <https://docs.docker.com/engine/network/drivers/bridge/>
- <https://docs.docker.com/engine/network/port-publishing/>
- <https://docs.docker.com/reference/compose-file/networks/>

## 5. Connector container contract

The future Compose service name is `public-share-connector`. It must not set
`container_name`; under the canonical `aegis-prod` project its expected generated
name is `aegis-prod-public-share-connector-1`.

| Control | Approved design |
| :--- | :--- |
| Image | official `cloudflare/cloudflared:<tested-version>@sha256:<tested-digest>`; never `latest`; exact value selected in S5.5-C |
| Version floor | at least `2026.5.2`, subject to pinned-image tests; this includes current startup connectivity pre-check behavior and exceeds the `--token-file` minimum |
| User | explicit numeric `65532:65532`, but only after the pinned image proves that identity |
| Filesystem | `read_only: true`; add only a bounded, `noexec,nosuid,nodev` tmpfs if the pinned image proves one is required |
| Privileges | `cap_drop: [ALL]`; `no-new-privileges:true`; no privileged mode, devices, Docker socket, host namespaces or added capabilities |
| Restart | bounded `on-failure:5`; no unconditional daemon-level auto-start ahead of firewall reconciliation |
| Networks | edge `.3` and egress `.2`, exactly |
| Ports | no published ports; no host-network mode |
| Metrics | fixed loopback-only endpoint inside the container; never published or exposed to another network |
| Health | container-native `cloudflared tunnel ready` against that loopback endpoint; exact flag order and exit behavior must pass pinned-image smoke testing |
| Logs | `info` or stricter; never `debug`; bounded Docker rotation; token, bearer path, password and recipient sentinels must remain absent |
| Updates | `--no-autoupdate`; upgrades occur only through a reviewed tag/digest change |

The official image currently uses a distroless base and numeric
`USER 65532:65532`. That is supporting evidence, not permission to skip testing
the chosen digest. The official source also defines `cloudflared tunnel ready`
as a command that returns status from `/ready`.

References:

- <https://github.com/cloudflare/cloudflared/blob/master/Dockerfile>
- <https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/tunnel/subcommands.go>
- <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/monitor-tunnels/metrics/>

## 6. Credential-delivery contract

### Recommended and approved mechanism

Use a remotely managed tunnel token through the officially supported
`--token-file` mechanism. Cloudflare documents this mechanism for cloudflared
`2025.4.0` and later and recommends remotely managed tunnels for Docker.

The future runtime contract is:

1. The owner supplies the real token only during separately authorised
   Production activation.
2. Store it outside the repository below
   `/opt/aegis/runtime/public-share/secrets/`.
3. Bind-mount the exact file read-only at
   `/run/secrets/cloudflared-token`.
4. Proposed host ownership/mode is `root:65532` / `0440`, subject to an exact
   host and pinned-image read test.
5. The Compose command carries only the non-secret file path.
6. Generated Compose output and `docker inspect` may reveal the mount path and
   `--token-file` argument, but never the token value.
7. The token must never enter Git, Compose source, an environment variable,
   shell history, chat, command output, Docker logs, Obsidian or a receipt.
8. Token rotation replaces the runtime file through an owner-controlled,
   non-echoing procedure and then restarts only the connector.

The real filename may include an operator-chosen identifier, but documentation
and tests use placeholders only. Repository tests must reject token-like values,
`TUNNEL_TOKEN`, `--token <value>`, and inline credential material.

References:

- <https://developers.cloudflare.com/tunnel/advanced/run-parameters/#token-file>
- <https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/>
- <https://developers.cloudflare.com/tunnel/downloads/update-cloudflared/>

### Alternatives considered

| Approach | Benefits | Risks / complexity | Rollback |
| :--- | :--- | :--- | :--- |
| **Approved: remotely managed token file** | smallest runtime credential; supported file interface; token content absent from inspect arguments/environment; Cloudflare's recommended Docker model | ingress configuration is Cloudflare control-plane state; token holder can run a replica; exact pinned version must be verified | stop/remove connector and remove its runtime token file; Gateway/Drive unchanged |
| Locally managed credentials JSON + local config | origin/ingress configuration is repository-reviewable and can exist without a public DNS route | broader long-lived JSON credential, local configuration lifecycle, and Cloudflare login/API creation workflow; more sensitive material to protect | remove connector, JSON file and local config mount |
| Environment or inline command token | simplest common examples | token can appear in environment/inspect/process arguments or shell history | simple operationally but rejected on leakage grounds |

## 7. Origin and Gateway contract

When G5 and the later public-route phase separately authorise a published
application route, the required provider-side origin configuration is:

| Field | Required value |
| :--- | :--- |
| Public hostname | `share.aegistk-pb.com` |
| Origin service | `http://172.31.240.2:8080` |
| HTTP Host override | `share.aegistk-pb.com` |
| Origin transport | clear HTTP only on the isolated edge bridge; TLS terminates at Cloudflare for the eventual public route |

S5.5-B/C do not create that route. A connector can be prepared only after the
firewall and topology gates; route and DNS activation remain later gated work.

The Gateway continues to enforce:

- immediate trusted peer `172.31.240.3/32`, not Cloudflare public ranges;
- exact Host validation;
- `GET` and `POST` on `/s/:token` only;
- canonical `CF-Connecting-IP` only from the pinned connector;
- rejection of absent, malformed, duplicate or untrusted provider identity;
- stripping of provider/forwarding headers before Drive;
- no private/API/health/static route forwarding;
- existing `any`, `zones` and `public` semantics without widening.

Cloudflare documents `httpHostHeader` as the origin Host override:
<https://developers.cloudflare.com/tunnel/configuration/#origin-parameters>.

## 8. Firewall policy contract

### 8.1 Two enforcement surfaces are required

S5.5-A measured `DOCKER-USER` as the correct pre-Docker enforcement point for
forwarded bridge traffic. It is necessary but not sufficient: packets addressed
to the Docker host traverse host input rather than `FORWARD`. Therefore the
approved policy uses both:

1. a task-owned chain anchored from `DOCKER-USER` for connector forwarding; and
2. a narrowly scoped task-owned host `INPUT` guard for connector-to-host
   isolation.

The executable rule syntax is intentionally deferred to S5.5-D after isolated
model tests and a fresh pre-mutation snapshot. This section is the semantic
contract every implementation must satisfy.

### 8.2 Forwarding policy

The `DOCKER-USER` anchor delegates connector traffic to a dedicated,
idempotently managed `AEGIS-PS-EGRESS` chain. The chain must implement this
ordered policy:

| Order | Source | Destination | Protocol/port | Decision |
| :--- | :--- | :--- | :--- | :--- |
| 1 | established return traffic | connector | matching established/related flow only | permit as required |
| 2 | connector edge `172.31.240.3` | Gateway edge `172.31.240.2` | TCP/8080 | allow |
| 3 | connector egress `172.31.242.2` | the complete reviewed Cloudflare region1 + region2 IPv4 endpoint allowlist | TCP/7844 | allow |
| 4 | connector DNS path | exact measured resolver destination(s) | only required TCP/UDP port 53 behavior | allow only after S5.5-C measurement and model proof |
| last | either connector source address | anywhere else | any | drop and count |

Requirements:

- cloudflared is explicitly pinned to HTTP/2; UDP/7844 is not allowed;
- TCP/443 is not allowed without separate evidence, justification and owner
  approval;
- no `0.0.0.0/0` all-port allow exists;
- the Cloudflare TCP/7844 destination set is a reviewed static snapshot from
  Cloudflare's official region1/region2 list, not an unbounded provider CIDR;
- IPv6 is not an alternate bypass path;
- rule counters and exact ordering are available to read-only validation;
- the connector is not running while a rule set is missing, partial or stale.

Cloudflare documents TCP/7844 for HTTP/2 and describes TCP/443 as optional for
features such as updates and Access validation. HTTP/2 is an accepted explicit
protocol value.

References:

- <https://docs.docker.com/engine/network/firewall-iptables/>
- <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/>
- <https://developers.cloudflare.com/tunnel/advanced/run-parameters/#protocol>

### 8.3 Host-input policy

The `AEGIS-PS-INPUT` guard must match connector-sourced traffic arriving from
the S5.5 topology and deny new access to host-local addresses and services. It
must cover the egress bridge gateway, the host's other interface addresses, and
administration listeners. Only an exact resolver exception may be added if the
measured DNS design requires a host-local resolver.

This supplementary chain is mandatory. A `DOCKER-USER`-only implementation
cannot claim that host administration services are isolated.

### 8.4 Required negative evidence

From the running connector namespace, acceptance must prove refusal to:

- Drive directly, including `172.31.241.3:8001`;
- the entire upstream network;
- PostgreSQL and port 5432;
- HUB and private APIs;
- Monitor;
- Twingate resources;
- VLAN/private server networks;
- Docker host bridge and administration addresses;
- unrelated Docker networks;
- unexpected Internet destinations and outbound ports;
- UDP/7844 and TCP/443.

Negative probes must target known listening controls where safe and possible;
a timeout to an unused address alone is not sufficient evidence.

## 9. DNS decision and implementation gate

Cloudflared requires name resolution for tunnel endpoint discovery. Docker may
present an embedded resolver at `127.0.0.11` and forward queries through a host
resolver path that is not attributable in `DOCKER-USER` as ordinary connector
forwarding. S5.5-A proved endpoint resolution from the host but did not measure
the future container's complete resolver path.

Therefore S5.5-C must, before Production mutation:

1. determine the resolver configuration the pinned container will receive;
2. determine whether queries are container-forwarded, Docker-daemon-proxied or
   sent to a host-local/external resolver;
3. identify exact resolver destinations and TCP/UDP requirements;
4. prove how the connector-specific default deny interacts with that path; and
5. freeze the minimum DNS exception and its negative tests.

If the path cannot be attributed and constrained consistently with this design,
Production mutation is **BLOCKED**. No generic DNS allow is pre-approved.

## 10. Persistence and lifecycle design

### 10.1 Recommended mechanism

Use systemd-controlled firewall and connector activation with small task-owned,
idempotent artifacts:

- a firewall program supporting `apply`, `validate` and `remove` for only the
  two S5.5 chains/anchors;
- an `aegis-public-share-s5-5-firewall.service` unit ordered after Docker and
  UFW and before connector activation;
- an `aegis-public-share-connector.service` unit that requires successful
  firewall validation and starts/stops only the Compose connector service;
- bounded drift validation that stops the connector before reconciling any
  missing or incorrect rule, then permits restart only after exact validation.

Lifecycle invariants:

1. firewall fail-closed skeleton and host-input guard exist before the
   connector starts;
2. allow rules are installed only inside the task-owned chains;
3. the full policy is validated before connector activation;
4. `on-failure:5` handles bounded process failure but does not supersede
   systemd's Docker/UFW ordering;
5. Docker daemon restart, host reboot and UFW reload must be tested for a
   fail-open interval; any observed interval blocks Production acceptance;
6. a partial apply leaves the connector stopped and the deny boundary present;
7. removal is independent and occurs only after the connector is absent.

S5.5-D must test the exact atomicity available through iptables-nft on this
host. The design does not assert that a particular `iptables-restore` sequence
is atomic until this is measured.

### 10.2 Alternatives considered

| Mechanism | Benefits | Risks / complexity | Rollback |
| :--- | :--- | :--- | :--- |
| **Approved: systemd lifecycle + task-owned reconciler** | couples rule validation to connector start; explicit Docker/UFW ordering; independently auditable and removable | requires careful daemon/UFW restart tests; incorrect unit dependency can create a race | stop connector unit, remove task chains, remove task units |
| UFW `after.rules` integration | naturally participates in UFW reload | couples IDEA1 policy to shared UFW files; Docker chain creation/boot order is awkward; harder isolated rollback | edit shared UFW state and reload, increasing blast radius |
| netfilter-persistent only | familiar snapshot persistence | may restore before Docker chains exist; weak connector lifecycle coordination; stale snapshot risk | reload global firewall state, broader than this task |

## 11. Runtime validation strategy

The approved strategy combines three evidence layers:

1. **Repository/static:** merged Compose model, exact image pin, hardening,
   networks, no ports, no secrets, and firewall semantic fixtures.
2. **Activation gate:** pre-start Docker topology and firewall inspection;
   connector remains absent on any mismatch.
3. **Runtime:** loopback readiness, tunnel transport state, origin reachability,
   positive Gateway request, negative network probes, log sentinel scan, and
   rule-counter evidence.

The readiness endpoint proves at least one Cloudflare connection, not isolation.
Isolation is accepted only when the independent firewall/topology negatives pass.
A systemd drift check must stop the connector on unsafe drift rather than merely
reporting it.

Alternatives rejected as sole mechanisms:

- container health alone cannot prove egress isolation;
- a host watchdog without pre-start ordering reacts after potential exposure;
- log-only validation cannot prove topology or blocked destinations.

## 12. Fail-closed matrix

| Condition | Required behavior |
| :--- | :--- |
| Connector missing | no tunnel; Gateway/Drive remain healthy and private; no automatic public fallback |
| Wrong connector edge IP | pre-start validation fails; connector must not run |
| Wrong connector egress IP | pre-start validation fails; connector must not run |
| Connector attached to upstream/private/default network | unsafe topology; stop/remove connector; acceptance fails |
| Firewall missing | connector start is refused or an already running connector is stopped |
| Firewall partially installed | terminal deny remains effective; connector stays stopped; reconciliation fails visibly |
| Cloudflare TCP/7844 unavailable | readiness fails and no route is served; no fallback to UDP/7844 or TCP/443 |
| Gateway unavailable | cloudflared origin fails closed; Drive is not contacted directly |
| Wrong Host | Gateway returns its existing default denial; request does not reach Drive |
| Origin unavailable | Cloudflare returns origin failure; connector does not try another AEGIS service |
| Credential absent/unreadable | connector fails to start; token is not requested interactively or taken from an environment fallback |
| DNS path unmeasured or unconstrained | S5.5-C/D Production mutation is blocked |
| Pinned-image gate fails | Production mutation is blocked; no substitute image or weakened hardening is inferred |

## 13. Repository implementation plan for later phases

S5.5-B creates only this design document and owner canonical-status updates.
Later phases may add these focused files after separate approval:

| Candidate path | Purpose | Earliest phase |
| :--- | :--- | :--- |
| `gateway/public-share/production/docker-compose.s5-5.yml` | connector and egress overlay only | S5.5-C/E |
| `gateway/public-share/production/s5-5-firewall.sh` | idempotent task-owned `apply`, `validate`, `remove`; no global flush | S5.5-D |
| `gateway/public-share/production/s5-5-runtime-check.sh` | read-only topology, isolation, readiness and leakage validation | S5.5-F |
| `gateway/public-share/production/systemd/aegis-public-share-s5-5-firewall.service` | firewall ordering/reconciliation | S5.5-D/G |
| `gateway/public-share/production/systemd/aegis-public-share-connector.service` | connector-only lifecycle after firewall validation | S5.5-E/G |
| `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js` | Compose/firewall/rollback/security contract tests | S5.5-C–G |
| `gateway/public-share/production/README.md` | exact operator activation, validation and rollback runbook | S5.5-C–G |

One firewall script with explicit subcommands is preferred over separate
apply/remove scripts so rule ownership and symmetry remain in one review unit.
The final file set may be smaller if implementation proves an existing artifact
can satisfy the same contract without widening scope.

The S5.4 overlay is not a candidate path and must remain unchanged.

## 14. Test design

### Compose contract

- render the complete Production Compose model using the canonical file order;
- prove the egress name, bridge driver, `internal: false`, subnet, gateway,
  stable bridge option, NAT/masquerade and IPv4-only contract;
- prove connector `.3` edge / `.2` egress addresses and exactly two networks;
- prove connector has no upstream/private/default attachment or published port;
- prove image uses a tag plus digest, explicit verified user, read-only root,
  all capabilities dropped and no-new-privileges;
- prove Gateway and Drive merged topology is identical to S5.4;
- prove `docker-compose.s5-4.yml` has not changed from its accepted blob.

### Credential and logging contract

- reject inline token, `TUNNEL_TOKEN`, `--token`, credential JSON and token-like
  literals in tracked/generated files;
- prove only a non-secret token-file path appears in rendered Compose/inspect;
- verify runtime token file owner/mode without printing content;
- use synthetic sentinels to prove connector and Gateway logs contain no token,
  bearer URL, link password or recipient identity;
- prove metrics and health endpoints are loopback-only and unpublished.

### Firewall contract

- verify the effective backend and exact `DOCKER-USER`/INPUT anchors;
- verify terminal deny ordering and exact source/destination/port allows;
- prove connector → Gateway TCP/8080 and required Cloudflare TCP/7844 succeed;
- prove connector → Drive, PostgreSQL, upstream, private surfaces, host services,
  unexpected Internet destinations/ports, UDP/7844 and TCP/443 fail;
- verify rule counters increment on positive and negative discriminators;
- test missing, duplicate, reordered and partial rules fail closed.

### Restart and persistence contract

- host boot, Docker restart and UFW reload never start/leave the connector
  running without the exact firewall contract;
- connector process failure is bounded by `on-failure:5`;
- firewall drift stops the connector before reactivation;
- a failed reconcile does not widen traffic or restart the connector.

### Rollback contract

- connector removal is independent;
- only S5.5 firewall anchors/chains are removed;
- egress removal occurs only when it has zero members;
- S5.4 Gateway/Drive container identity, health, networks and no-port state are
  unchanged;
- edge/upstream networks, database, protected volumes, HUB, Monitor and
  Twingate remain unchanged;
- UI remains false and public DNS remains absent.

## 15. Rollback design

Rollback never uses `docker compose down`, prune, a whole-stack restart, volume
deletion or database mutation.

Required order:

1. capture stable pre-rollback identity/health/network/volume inventory;
2. stop and remove only `public-share-connector` and disable only its task-owned
   activation unit;
3. prove no process/container holds either connector address;
4. remove only the S5.5 `DOCKER-USER` and INPUT anchors/chains using the
   task-owned firewall program;
5. verify those anchors/chains are absent and unrelated UFW/Docker rules are
   byte/semantic-equivalent to the pre-state;
6. inspect `aegis_public_share_egress` and require zero members;
7. remove only `aegis_public_share_egress` and prove `aegis-ps-eg`, the host
   `.242.1` address and `.242.0/29` route are absent;
8. verify the Gateway is still healthy on edge `.240.2` + upstream `.241.2`,
   Drive is still healthy on upstream `.241.3` plus its accepted private
   networks, and neither gained a port or attachment;
9. verify database/container/volume, HUB, Monitor and Twingate identity/health
   match the stable pre-state;
10. verify UI remains false, public DNS remains absent, and exposure is none.

The runtime token file is removed or retained only according to the owner's
credential-rotation policy, but its content is never read for evidence.

## 16. Mandatory implementation-time verification gates

Owner approval of this design does not waive any gate:

1. exact cloudflared version and immutable image digest;
2. pinned-image UID/GID verification;
3. `--token-file` smoke test;
4. read-only filesystem compatibility;
5. readiness command/endpoint syntax;
6. actual Production DNS resolver path;
7. exact INPUT/FORWARD traversal;
8. atomic firewall installation/removal behavior;
9. Docker/UFW/systemd restart and fail-closed behavior.

Any failure blocks Production mutation. A failed gate may cause the design to be
reopened; it never authorises an improvised flag, broader allow, different image,
environment token, host port, weakened container, or bypass of lifecycle
ordering.

## 17. Not yet implemented / acceptance required

At this S5.5-B checkpoint:

- `docker-compose.s5-5.yml` does not exist;
- no egress network or Linux bridge exists;
- no firewall or systemd artifact exists or is installed;
- cloudflared is absent;
- no token exists in repository scope;
- no tunnel, published application, DNS or TLS route exists;
- the Public Share UI is off;
- G5 is open;
- Internet exposure is none;
- Public Internet Share is not implemented or externally accepted.

Repository/source tests in later phases do not substitute for separately
authorised Production topology, firewall, restart, rollback and external
acceptance evidence.

## 18. Phase boundary

S5.5-B may close after this specification, canonical reconciliation, governance
validation, a focused Git checkpoint and Draft PR update pass review.

**Stop after S5.5-B.** S5.5-C may begin only after the owner reviews this written
specification and separately authorises the next phase. No Production mutation
is implicit in approving or merging documentation.
