# AEGIS IDEA3 PR11 — Phase 2 Live Evidence Reconciliation and Kla Decision Package (P2-E1)

> **Status:** documentation only. This package records the owner-run P2-E1
> read-only Production evidence, classifies the Phase 2 integration items, and
> asks Kla for the owner-held decisions. It is **not** Phase 2 runtime
> execution. It authorizes no Production mutation, and none occurred.

```text
PHASE2_REPOSITORY_PREPARATION  = COMPLETE (PR #132, merged at 50972368)
P2_E1_READ_ONLY_EVIDENCE       = PARTIAL_COMPLETE
K1                             = FAIL_LIVE_DRIFT
K3_PUBLIC_SHARE_BASELINE       = PASS
K3_NON_OVERLAP_WINDOW          = NOT_PROVEN
K4_LIVE_COLLISION_RECHECK      = PASS
K7                             = BLOCKED_RECONCILIATION_REQUIRED
K8                             = BLOCKED
K9                             = BLOCKED
K10                            = BLOCKED
K12                            = NOT_PROVEN
PHASE2_RUNTIME_COMPLETE        = NO
PHASE3_RUNTIME_COMPLETE        = NO
PHASE4_RUNTIME_COMPLETE        = NO
PRODUCTION_MUTATION_AUTHORIZED = NO
IDEA3_PRODUCTION_DEPLOYED      = NO
```

## 1. Authoritative starting state

```text
CURRENT_MAIN = f0a87ee1eb119a5107b63df008218a6163661123 (merge of PR #135, 2026-09-15T14:23:12Z, human merge)
PR132        = MERGED — Phase 2 repository package (design, overlay, image inputs, integration requests IR-1..IR-6)
PR133        = MERGED at 2742be27 — Phase 3 Core-only repository package
PR135        = MERGED at f0a87ee1 — Phase 4 Protocol v1 repository package
P2_E1        = prepared in the Phase 2 design §6.1; not run before this record
```

The Phase 2 design is
`IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-15-idea3-pr11-phase2-server-integration-design.md`.
Its §6.1 lists the read-only commands, and its §7 lists the evidence state these
results update. The carried-forward decisions in its §2 are not reopened here.

## 2. Evidence provenance and boundary

| Label | Meaning in this package |
|---|---|
| **OWNER-RUN** | The owner ran the §6.1 read-only command in their own session on the Production host `aegis-system` (`192.168.10.10`) and reported the result to the agent on 2026-09-15. The agent did not observe the server directly. The exact collection timestamp was not supplied |
| **AGENT-VERIFIED (REPO)** | The agent verified it against Git at `f0a87ee1` in this task |
| **AGENT-RUN (CORE)** | The agent observed it with unprivileged read-only commands on the candidate Core host on 2026-09-15 |

- **No Production mutation occurred.** The owner session was read-only.
- **The agent had no server path in this task.** In its own read-only session on 2026-09-15 the Core host's Twingate client was inactive, and it was not started, because a service start was outside that authorization. The server's SSH and HTTPS ports were not reachable from the Core's current LAN. Every server fact below is therefore OWNER-RUN.
- **No private-key content, credential, token, or secret was read or recorded.** Certificate evidence is metadata only.

Invariants carried from the Phase 2 design §8:

```text
Absence of output != PASS
nginx -T digest != SAME_ARTIFACT_HASH evidence
Architecture Approved != Production Mutation Authorized
Reference != Ownership
```

## 3. Evidence by item

### 3.1 K1 — HUB NGINX artifact (method: SAME_ARTIFACT_HASH)

| Artifact | SHA-256 | Source |
|---|---|---|
| Running HUB container `/etc/nginx/conf.d/default.conf` | `16cee16232f5636eb11dd434d43ba42c6314d75a2b306265ee62032b84fb3722` | OWNER-RUN |
| Host `/opt/aegis/runtime/nginx/nginx.production.conf` | `16cee16232f5636eb11dd434d43ba42c6314d75a2b306265ee62032b84fb3722` | OWNER-RUN |
| Reviewed Git artifact `HUB-AEGIS_Entry/nginx.conf` at `f0a87ee1` (blob `5028b6afe49742fd6d4c36eab48691c24e00be2f`, last changed `cafa4e61`, 2026-08-29) | `ac70bfbaf2254b3a878924635e8c76cb97961f8c464ae1de3ba61325c94668c6` | AGENT-VERIFIED (REPO) |

```text
K1 = FAIL / LIVE DRIFT CONFIRMED
```

- **What is proven.** The running HUB and the host runtime file are the same artifact. That artifact is not the reviewed Git artifact.
- **Git-history search (AGENT-VERIFIED (REPO)).** None of the 11 distinct `nginx*.conf` versions in any fetched Git ref hashes to `16cee162…`: 6 versions of `HUB-AEGIS_Entry/nginx.conf` and 5 of `gateway/nginx.conf`. The live artifact is not an older or newer committed version.
- **What is not proven.**
  - The content difference. Only hashes were compared, and no diff was taken.
  - Whether the difference is still limited to the historical S1 drift markers: the extra `resolver_timeout`, and `/monitor/` routed through a Docker-name variable.
  - The Phase 0 `nginx -T` digest (`a6ff6420…`) measures a different artifact and is not compared.
- **Consequence.** IR-1, the proposed `/security/` route, was drafted against the Git artifact `ac70bfba…`. Until K1 is decided, the base artifact for IR-1 is undetermined.

### 3.2 K4 — live collision recheck for `172.31.243.0/29`

Live Docker networks (OWNER-RUN):

| Network | Subnet |
|---|---|
| `aegis_drive_proxy` | `172.19.255.0/29` |
| `aegis_internal` | `172.18.0.0/16` |
| `aegis_public_share_edge` | `172.31.240.0/29` |
| `aegis_public_share_upstream` | `172.31.241.0/29` |
| `aegis_public_share_egress` | `172.31.242.0/29` |
| `aegis_vlan10_macvlan` | `192.168.10.0/24` |
| `bridge` (Docker default) | `172.17.0.0/16` |

```text
HOST_ROUTE_CHECK   = NO_172.31.243_ROUTE     (OWNER-RUN)
HOST_ADDRESS_CHECK = NO_172.31.243_ADDRESS   (OWNER-RUN)
K4                 = PASS / LIVE COLLISION RECHECK
```

- No live network, route, or address overlaps `172.31.243.0/29`.
- The K4 condition still holds: re-check immediately before the network is created.
- **IR-4 is still open (AGENT-VERIFIED (REPO)).** The infrastructure address plan does not yet record `aegis_idea3_internal` / `172.31.243.0/29`.
- The IPAM gateway column was not recorded.

### 3.3 K3 — Public Share baseline and window

| Unit | State (OWNER-RUN) |
|---|---|
| `aegis-public-share-connector.service` | active |
| `aegis-public-share-drift.timer` | active |

The connector service uses this four-layer Compose stack (OWNER-RUN):

| File | SHA-256 |
|---|---|
| `/opt/aegis/runtime/docker-compose.production.yml` | `61528b8636b560021d15fb9dd98316533447adfc348210b4da4cf5b7ea021869` |
| `/opt/aegis/runtime/public-share/drive-s5-3.yml` | `324fb5126b2f13f7b1c529ef1391131ef37f81acc8c3921b9b50f649b179de62` |
| `/opt/aegis/runtime/public-share/drive-gateway-s5-4.yml` | `cc36d08c16731f888f64cb2dcd84f1c9a41b11e9b447aa16ad67405bcdc12819` |
| `/opt/aegis/runtime/public-share/connector-s5-5.yml` | `83ad5e15e0182b794f4dd036146e19a3521b4ea298fc5f7a3df6e461c5cc962f` |

```text
K3_PUBLIC_SHARE_BASELINE = PASS (baseline captured for the Phase 2A step 17 comparison)
K3_NON_OVERLAP_WINDOW    = NOT_PROVEN
```

- The hashes are a baseline, not a comparison. Phase 2A step 17 must show them unchanged.
- **Repository state (AGENT-VERIFIED (REPO), at `f0a87ee1`):**
  - PR #130 (S5.7) is merged;
  - IDEA1's status records S5.8 (Twingate-OFF 4G/5G external acceptance) as NOT STARTED;
  - no S5.8 branch exists on `origin`;
  - the only open PR is #134, an IDEA2 Monitor Draft.
- **Why the window is still NOT_PROVEN.** No written confirmation exists that an IDEA1 (or other) Production verification or mutation window will not overlap a future IDEA3 Phase 2 window. Repository silence is not that confirmation.

### 3.4 K7 — HUB identity and Compose model

Running HUB labels (OWNER-RUN):

```text
com.docker.compose.project              = aegis-prod
com.docker.compose.service              = hub
com.docker.compose.project.config_files = /opt/aegis/runtime/docker-compose.production.yml
```

```text
K7 = BLOCKED / RUNTIME COMPOSE MODEL RECONCILIATION REQUIRED
```

- **Confirmed.** The project name `aegis-prod` and the service name `hub`, which were NOT PROVEN in the Phase 2 design.
- **Differs from the design.** The design's `F4` list (the four Public Share files) and `F5` list (`F4` plus the IDEA3 overlay) assumed the HUB's canonical Compose model included the four Public Share overlays. Compose recorded that the running HUB was created from **one** file. The connector service uses four files (§3.3).
- **Monitor overlay, referenced not verified.** IDEA1's canonical status (`idea1-status.md`) records an active Monitor overlay: `/opt/aegis/runtime/monitor-single-camera-ui-20260906-204814/compose.active.yml`. Whether it belongs in the canonical list is not known.
- **INFERRED risk.** Recreating the HUB from a file list other than the one it was created from can change its rendered service definition. The canonical list must be decided before any Phase 2A step, not discovered during one.
- **Not recorded.** The first §6.1 K7 line (image, restart policy, mounts, and networks). This is why P2-E1 is PARTIAL_COMPLETE.

### 3.5 K9 — machine SNI, server certificate, and name resolution

`nginx -T` markers (OWNER-RUN):

- Found only `server_name _;`, twice.
- No `/security` location.
- No `idea3-core.aegis.internal` `server_name`.
- No `ssl_verify_client`, `ssl_client_certificate`, or `ssl_crl`.

Current HUB certificate `/opt/aegis/runtime/certs/aegis.crt` (OWNER-RUN, metadata only):

```text
subject   = CN=aegis.internal
issuer    = CN=AEGIS Internal Root CA
notBefore = 2026-08-16
notAfter  = 2027-08-16
SAN       = DNS:aegis.internal, DNS:aegis-system, IP:192.168.10.10
```

- **Name resolution.** `getent ahosts idea3-core.aegis.internal` on the server: NOT FOUND (OWNER-RUN). On the Core host: no answer (AGENT-RUN (CORE)).

```text
K9 = BLOCKED
```

- There is no machine server block, no machine name in DNS, and no certificate for the machine name.
- K9 requires a separate server certificate for the machine name, with that name as SAN. The current browser certificate does not carry it.

### 3.6 K10 — dedicated IDEA3 machine-client CA

- **Server (OWNER-RUN).** No IDEA3 client CA, CRL, or IDEA3 PKI file was found under `/opt/aegis/runtime/certs`.
- **Core (AGENT-RUN (CORE)).** `/etc/aegis-idea3/pki` does not exist, so there is no Core key and no CSR.

```text
K10 = BLOCKED
```

Nothing was generated or installed.

### 3.7 K8 — Core → HUB 443 over VLAN 20

Core host, AGENT-RUN (CORE), 2026-09-15:

- The wired interface has a DHCP address on a non-AEGIS LAN, not VLAN 20.
- No VLAN interface exists.
- The Wi-Fi radio is soft-blocked.
- The server's SSH and HTTPS ports are unreachable from that LAN.

```text
K8 = BLOCKED
```

- The Core → HUB 443 path and the router rule remain unproven.

### 3.8 K12 — S5.5 reboot persistence

```text
K12 = NOT_PROVEN
```

- No host reboot has been observed since the S5.5 chains were applied.
- IDEA1's recorded S5.5-G persistence evidence covers service restart, drift-timer operation, and a Docker daemon reload, not a host reboot.
- The Phase 1 decision `K12_REBOOT_PERSISTENCE = VERIFY_AT_NEXT_PLANNED_REBOOT` stands.

### 3.9 P2-E1 completeness

| §6.1 block | Recorded | Missing |
|---|---|---|
| K1 hashes | both | — |
| K4 networks, routes, addresses | network names and subnets; filtered route and address results for `172.31.243` | IPAM gateways; full route and address tables |
| K3 Public Share baseline | unit states; four hashes; connector file list | the `systemctl cat` text itself |
| K7 HUB identity | Compose labels | image, restart policy, mounts, networks |
| K9 markers, certificate, DNS | all | — |

```text
P2_E1_READ_ONLY_EVIDENCE = PARTIAL_COMPLETE
```

Phase 2A step 1 captures the missing K7 identity line anyway. It should also be
re-run as owner read-only evidence once Kla answers K7.

## 4. Dependency state after this record

| Gate | State | Holder | Blocks |
|---|---|---|---|
| K1 | FAIL_LIVE_DRIFT — decision requested (§5.1) | Kla | Phase 2A (IR-1 base artifact) |
| K3 | baseline PASS; non-overlap NOT_PROVEN — decision requested (§5.2) | Kla (+ IDEA1) | any Phase 2 window |
| K4 | live PASS; IR-4 record open; re-check before creation | Kla | Phase 2A network creation |
| K7 | BLOCKED — decision requested (§5.3) | Kla | Phase 2A HUB recreate and rollback |
| K8 | BLOCKED | Kla / Music | Phase 2B, Phase 3 |
| K9 | BLOCKED — later prerequisite (§5.4) | Kla | Phase 2B |
| K10 | BLOCKED — later prerequisite (§5.4) | Kla (CA) / Music (Core key) | Phase 2B, Phase 3 |
| K12 | NOT_PROVEN — verify at next planned reboot | Kla + IDEA1 | recorded per Phase 1 decision |
| IR-1, IR-3, IR-5 | awaiting Kla acceptance | Kla | Phase 2A |
| IR-2, IR-6 | awaiting Kla acceptance | Kla | Phase 2B |
| Music Production authorization | not given | Music | every Production step |

```text
P2_A_BLOCKERS = K1 decision and its separately authorized execution; K7 canonical list; K3 non-overlap;
                IR-1 (rebased if K1 so requires), IR-3, IR-4, IR-5; K4 re-check before creation;
                Music Production authorization
P2_B_BLOCKERS = every P2-A blocker; K8; K9 DNS name and machine server certificate; K10 CA, CRL, client
                certificate; IR-2; IR-6
```

## 5. Kla decision request

Kla is asked to review and answer the points below on the PR, one answer per
decision. The agent does not choose, and none of these actions happens in this
package.

### 5.1 K1 — reconciliation path for the live NGINX artifact

Evidence: §3.1. Choose one:

| Option | Meaning | Follow-on (each separately owned and authorized) |
|---|---|---|
| `ACCEPT_LIVE_AS_NEW_CANONICAL_AND_RECONCILE_GIT` | The live artifact `16cee162…` becomes the reviewed baseline | A Kla-owned change brings `HUB-AEGIS_Entry/nginx.conf` to the live content, and IR-1 is re-based on it. There is no Production change for K1 itself |
| `RESTORE_LIVE_TO_REVIEWED_GIT_ARTIFACT` | The Git artifact `ac70bfba…` is restored to Production | A Kla-run, separately authorized Production window, with `nginx -t`, rollback, and the /drive/ and /monitor/ checks. It is never combined with the IDEA3 Phase 2A window |
| `REQUEST_CHANGES` | Neither, with an explanation | as Kla states |

```text
K1_KLA_DECISION = PENDING
```

### 5.2 K3 — non-overlap of Production windows

Evidence: §3.3. Confirm that no IDEA1 (or other) Production verification or
mutation window, including S5.8, will overlap the future IDEA3 Phase 2
execution window.

```text
K3_KLA_DECISION = PENDING   (NON_OVERLAP_CONFIRMED | WINDOW_CONFLICT / REQUEST_CHANGES)
```

### 5.3 K7 — canonical Production Compose model

Evidence: §3.4. Kla is asked to:

1. confirm the canonical HUB file list for Phase 2A (the list the `F4`/`F5` variables must use);
2. explain why the running HUB's label lists only `docker-compose.production.yml` while the Public Share connector runs from four files;
3. confirm whether the Monitor overlay (`monitor-single-camera-ui-20260906-204814/compose.active.yml`) must be included in that list;
4. confirm that the K7 rollback owner remains `kraveerachat`.

```text
K7_CANONICAL_HUB_FILE_LIST = PENDING
K7_MONITOR_OVERLAY_INCLUDED = PENDING
K7_ROLLBACK_OWNER           = PENDING CONFIRMATION (recorded value: kraveerachat)
```

If the answer changes the list, Phase 2 design §6.2 and §6.3 must be updated in a
later IDEA3 task before any Phase 2A step. This package does not edit them.

### 5.4 K9 / K10 — later infrastructure prerequisites (not decision-complete)

Recorded as Phase 2B prerequisites, for Kla to schedule. There is no decision to
return now:

- DNS resolution for `idea3-core.aegis.internal`, from the Core host, via router DNS (Kla) or a Core hosts entry (Music);
- a server certificate whose SAN carries the machine name;
- the dedicated IDEA3 machine-client CA, with its key held offline by Kla;
- the CRL loaded by the HUB;
- the client certificate issued for CN `idea3-core` from a CSR generated on the Core, where the key never leaves the Core.

> **Forward reference (added 2026-09-16):** for future execution, the K10 CA key custody recorded here is superseded by `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-16-idea3-pr11-k10-server-held-ca-amendment.md` (server-held dedicated client CA), **subject to Kla review**. This record is unchanged and remains accurate for its date.

Nothing is generated or installed by this package.

## 6. Integration requests (no shared file edited)

- **Kla:** the §5.1–§5.3 decisions on this PR.
- **Kla:** IR-4, the address-plan record for `172.31.243.0/29`, in `infrastructure/network/VLAN-IP-Plan.md` (a Kla-owned file).
- **Kla + IDEA1:** the written non-overlap confirmation (§5.2), and the K12 re-check at the next planned reboot.

`HUB-AEGIS_Entry/**`, `infrastructure/**`, IDEA1, IDEA2, shared files, and all
Production files are unchanged. `Reference != Ownership`.

## 7. What this package does not do

- It runs no Production, Docker, Compose, NGINX, DNS, certificate, firewall, network, systemd, Core, broker, AP, firmware, GPIO, CUT, or RESTORE action.
- It generates or installs no PKI or key material.
- It reconciles K1 in neither direction.
- It does not choose a canonical Compose list.
- It does not edit the Phase 2 design, the overlay, or any other owner's files.
- It does not approve or merge anything.

## Appendix A — Core-side observations for later phases (AGENT-RUN (CORE), 2026-09-15)

These come from the same-day read-only Core preflight. They support §3.5–§3.7
and are recorded so the evidence is not lost. They are not P2-E1 evidence, and
they do not change Phase 3 or Phase 4 state. Runtime firewall rules were not
readable without root.

| Area | Observation | Class |
|---|---|---|
| Wi-Fi AP capability | the radio supports AP mode | PASS (hardware capability only) |
| D1 AP / NTP serving | hostapd not installed; radio soft-blocked; regulatory domain `00`; nothing serves NTP | BLOCKED |
| Forwarding | `net.ipv4.ip_forward=0`, IPv6 forwarding `0` | PASS |
| Core trusted time | `adjtimex` read-only: `STA_UNSYNC` clear, maxerror 147.5 ms | PASS (point in time) |
| D2 broker | a single plaintext `listener 1883` on all interfaces; anonymous access off; no TLS or ACL; one username shared by the ESP32 and a desktop client | BLOCKED |
| D6 host posture | graphical desktop session; sleep targets not masked; lid at its default; UFW `ENABLED=no`; sshd on all interfaces; no `aegis-idea3` account or directories; root filesystem 93% used | BLOCKED |
| IDEA2 co-residence | detector runs as the personal account and listens on all interfaces; the IDEA2 tunnel unit is restart-looping | BLOCKED (Pub-owned) |
| D4 RESTORE | `aegisctl` has no `restore` subcommand; the headless RESTORE allowlist is empty | BLOCKED (not implemented) |
