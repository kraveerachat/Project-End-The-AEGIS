# AEGIS IDEA3 PR11 — Phase 1 Post-Merge Reconciliation

> Status: **COMPLETE — DECISION DOCUMENTATION CLOSED / AWAITING HUMAN REVIEW**
>
> Scope: **documentation / owner-decision reconciliation only**
>
> `PRODUCTION_MUTATION_AUTHORIZED = NO`
>
> This workstream is not Phase 2 and does not authorize a reboot, deployment,
> live infrastructure change, or other Production mutation.

## Purpose and authoritative state

PR #127 merged into `main` at
`90efbc8ec95aa026ca7dd8f12f8de91a99d1645b`. Its purpose was to publish the
PR11 Phase 1 owner-decision package. It fulfilled that documentation purpose;
this reconciliation must not be interpreted as an implementation-failure
report for PR #127.

Music owns the IDEA3 decision package and its internal checklist. On 2026-09-15,
Music supplied the complete K1, K2, K3, K4, K5, K7, K9, K10, K12, and D6
architecture/integration decisions recorded below. Kla and Pub are reviewers,
not manual template authors. Their normal GitHub reviews are the acceptance
gate: `APPROVE` accepts the recorded integration decision package, while
`REQUEST_CHANGES` asks Music to correct it. Neither review outcome authorizes
Production mutation. Runtime evidence remains separate from decision
completion.

Therefore:

```text
BASE_MAIN                             = 90efbc8ec95aa026ca7dd8f12f8de91a99d1645b
PR127                                = MERGED
PR11_PHASE1A                         = PASS
PR11_PHASE1B                         = PASS
MUSIC_DECISION_PACKAGE                = COMPLETE
MUSIC_DECISIONS_REQUIRED              = NONE
KLA_REVIEW_GATE                       = PENDING
PUB_REVIEW_GATE                       = PENDING
FINAL_PHASE1_RECEIPT_COUNT            = 1
PR11_PHASE1_CLOSEOUT                  = COMPLETE / DECISION DOCUMENTATION CLOSED
PHASE2                                = BLOCKED / PENDING PREREQUISITES
PRODUCTION_MUTATION_AUTHORIZED        = NO
IDEA3_PRODUCTION_DEPLOYED             = NO
```

This follow-up workstream now reconciles the completed Music decision package
and the evidence required for Phase 1 closeout.

`Architecture Approved != Production Mutation Authorized`

## Workstream separation and scope

PR #129 is a separate Python Desktop UX/UI workstream. Its known remote head at
handoff is `39da0c133331536dc146511829bf4ea96bf3a438`. This reconciliation does not
modify or consume PR #129, cherry-pick from it, edit its source or tests, alter
its receipt, or rewrite its task history.

The only intended reconciliation files are:

- this specification;
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`;
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md`.

No IDEA1 or IDEA2 file, historical receipt, governance script, shared runtime
surface, Production configuration, or IDEA3 Python/Web UX/UI file is in scope.
Reference to another owner's system does not transfer ownership.

## Music-owned decision package — complete 2026-09-15

These are architecture/integration decisions. They do not prove that later
runtime prerequisites passed and do not authorize Production mutation.

### K1 — Git/runtime reconciliation

```text
K1_RECONCILIATION_METHOD = SAME_ARTIFACT_HASH
K1_LIVE_ARTIFACT_COMPARISON = NOT YET PERFORMED
```

Before any Phase 2 Production mutation, compare the live
`/etc/nginx/conf.d/default.conf` artifact against Git
`HUB-AEGIS_Entry/nginx.conf` using equivalent content/hash evidence. Do not
claim that comparison passed until it is actually performed.

### K2 — browser route contract

```text
K2_ROUTE_CONTRACT_RECONFIRMED = APPROVE
```

Accepted contract:

- HUB NGINX owns `/security/`;
- no new public host port;
- prefix behavior is explicit;
- HUB owns security headers;
- browser and machine-authentication routes remain separate;
- no browser fallback enters the machine-authentication path.

### K3 — Production window and shared rollback risk

```text
K3_CURRENT_WINDOW_RULE = APPROVE
K3_ROLLBACK_RELATION = SHARED_RISK
K3_PUBLIC_SHARE_PROTECTION = APPROVE
```

No IDEA3 Production mutation may occur while IDEA1 has an active Production
mutation or verification window. IDEA3 and IDEA1 remain logically separate,
but HUB, NGINX, and host-level integration make rollback a shared Production
risk, so mutation windows must be coordinated.

Absent a separate reviewed cross-IDEA authorization, IDEA3 must not modify:

- the Public Share connector;
- the Public Share egress network;
- the Public Share firewall policy;
- the Public Share public route.

### K4 — IDEA3 Docker subnet

```text
K4_IDEA3_SUBNET = 172.31.243.0/29
K4_LIVE_COLLISION_RECHECK = REQUIRED BEFORE NETWORK CREATION
```

Before Phase 2 creates the network, perform a fresh read-only collision check
against Docker networks, host routes, Production Compose definitions, and known
planned/reserved infrastructure ranges. If a collision exists, stop and return
to the decision gate; do not silently choose another subnet.

Current known exclusions:

```text
172.31.240.0/29
172.31.241.0/29
172.31.242.0/29
172.19.255.0/29
172.18.0.0/16
192.168.10.0/24
```

### K5 — dedicated IDEA3 network topology

```text
K5_NETWORK_TOPOLOGY_RECONFIRMED = APPROVE
```

Accepted topology:

- dedicated IDEA3 Docker network with `internal: true`;
- only HUB and IDEA3 Web are members;
- IDEA3 Web has no public host port;
- no Public Share connector, Drive, Monitor, or PostgreSQL membership;
- no additional membership without separate review.

### K7 — HUB recreate and rollback

```text
K7_HUB_RECREATE_PLAN_RECONFIRMED = APPROVE
K7_ROLLBACK_OWNER = kraveerachat
```

Accepted model:

- use a validated Compose overlay;
- prepare rollback before mutation;
- start IDEA3 Web before recreating HUB;
- recreate HUB only;
- keep IDEA1 and IDEA3 Production mutation windows separate;
- verify HUB health and existing routes after recreation;
- rollback recreates HUB only using the previous canonical file list;
- runtime network attachment is emergency-only, not normal deployment.

The rollback owner assignment is proposed for review and does not authorize a
Production action. Kla may use `REQUEST_CHANGES` if it is unacceptable.

### K9 — machine SNI and mTLS route

```text
K9_MACHINE_ROUTE_RECONFIRMED = APPROVE
K9_MACHINE_SNI = idea3-core.aegis.internal
K9_DNS_AND_CERTIFICATE_EVIDENCE = NOT YET PROVEN
```

Accepted architecture:

- separate machine SNI server block with `ssl_verify_client on`;
- mTLS is required and the block serves the machine path only;
- every other path on the machine block returns `404`;
- the browser/default server remains separate;
- HUB overwrites trusted identity headers;
- IDEA3 accepts identity only from the trusted HUB boundary.

Before Phase 2/3 use, verify the name does not collide with existing internal
DNS/SNI, ensure the server certificate includes it, and provide controlled Core
resolution through an approved hosts entry or internal DNS. DNS and certificate
issuance are not claimed complete.

### K10 — dedicated client CA and custody

```text
K10_DEDICATED_CLIENT_CA = YES
K10_CA_KEY_CUSTODIAN = kraveerachat
K10_CORE_KEY_CUSTODIAN = music
K10_CERT_VALIDITY_POLICY = approximately 90 days; renew around day 60 with a short overlap
K10_EXPIRY_BEHAVIOR = PAUSE_DISPATCH
K10_CERTIFICATE_ISSUANCE = NOT YET PERFORMED
```

The dedicated IDEA3 machine-client CA is `clientAuth` only and separate from
the browser/server CA and MQTT CA. The CA private key remains offline and must
not be stored on the AEGIS Production Server. The Core private key is generated
and stored on Core and must not leave Core.

> **Forward reference (added 2026-09-16):** for future execution, the K10 CA key custody recorded here is superseded by `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-16-idea3-pr11-k10-server-held-ca-amendment.md` (server-held dedicated client CA), **subject to Kla review**. This record is unchanged and remains accurate for its date.

Certificate expiry or invalid machine identity fails closed for dispatch. It
must not automatically CUT, automatically RESTORE, bypass mTLS, or fall back to
browser authentication.

### K12 — reboot-persistence evidence disposition

```text
K12_REBOOT_PERSISTENCE_DISPOSITION = VERIFY_AT_NEXT_PLANNED_REBOOT
K12_REBOOT_PERSISTENCE = NOT PROVEN
```

Do not reboot now and do not schedule a reboot merely because of this decision.
At the next separately planned and authorized Production reboot, verify the
relevant Docker networks, HUB/runtime state, Public Share state, firewall
persistence, and applicable IDEA3 prerequisites, then record that evidence
separately.

### D6 — IDEA2 co-residence with Pub review

```text
D6_IDEA2_CORE_CORESIDENCE = APPROVE
D6_ALLOWED_IDEA2_SERVICES = aegis-detection-engine.service, aegis-detection-tunnel.service
D6_RESOURCE_LIMITS_REQUIRED = YES
D6_RUNTIME_BEHAVIOR = NOT TESTED
```

IDEA2 may retain only its approved existing service ports and tunnel behavior.
It must not bind to the future private ESP32 AP for service exposure; join the
IDEA3 internal Docker network; modify IDEA3 routing, MQTT security policy, or
firewall state; or reuse IDEA3 credentials, certificates, data roots, or
secrets. Any new IDEA2 listener or port requires separate IDEA2 review. IDEA3
Core uses its own service user, runtime/data root, credentials, certificates,
logs, and state.

IDEA2 and IDEA3 services must remain independently restartable. Neither restart
may restart the other, and no cross-system automatic restart chain is allowed.
Both may use `network-online.target` where appropriate, but neither becomes a
hard availability dependency of the other without separate review.

Failure isolation requires separate systemd units, process ownership, writable
runtime/data directories, credentials, and secrets, with no cross-kill
behavior. IDEA2 failure/restart loops must not trigger IDEA3 CUT/RESTORE, and
IDEA3 failure/restart loops must not terminate IDEA2. Resource controls must
prevent either workload from exhausting the Core host; actual resource-limit
values must be measured and validated before Phase 3 Production installation.
Pub may use `APPROVE` or `REQUEST_CHANGES` during human review. This PR modifies
no IDEA2 file.

## Decision completion versus runtime evidence

```text
MUSIC_DECISION_PACKAGE_COMPLETE = YES
RUNTIME_NOT_YET_PROVEN = K1/K4/K8/K9/K10/K12/D6
PRODUCTION_MUTATION_AUTHORIZED = NO
```

Specifically, K1 artifact comparison, K4 collision recheck, K8 VLAN20 path,
K9 DNS/certificate evidence, K10 certificate issuance, K12 reboot persistence,
and D6 co-residence runtime behavior remain later evidence gates.

## Review and checklist model

- Music owns the decision package and internal checklist acceptance.
- The agent may verify evidence and update checklist state, using `[x]` only
  for proven items and `[ ]` for unresolved items.
- The checklist is not Kla or Pub approval.
- Kla and Pub perform normal GitHub review after Music records the package.
- `APPROVE` accepts the recorded integration decision package.
- `REQUEST_CHANGES` asks Music to correct the package.
- The agent must not approve or merge on either reviewer's behalf.
- Reviewer acceptance does not authorize Production mutation.

`Architecture/integration acceptance != Production mutation authorization`

## Phase 1 closeout gate

Music has recorded all required decisions. The decision/evidence checkpoint
`dd25e044be89fd696154ffae35c4a5a830a31770` passed validation, and the one
final Phase 1 receipt is:

`Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-15_013747_music_idea3-pr11-phase1-closeout.md`

Kla and Pub now review the recorded package through the normal GitHub review
workflow. Phase 2 remains blocked on the runtime prerequisites listed above.

```text
MUSIC_DECISION_PACKAGE_COMPLETE = YES
FINAL_PHASE1_RECEIPT_COUNT      = 1
PR11_PHASE1_CLOSEOUT            = COMPLETE / DECISION DOCUMENTATION CLOSED
PHASE2                          = BLOCKED / PENDING PREREQUISITES
PRODUCTION_MUTATION_AUTHORIZED = NO
IDEA3_PRODUCTION_DEPLOYED      = NO
```

The final receipt is immutable closeout evidence. It records decision-
documentation completion only; it is not runtime proof or authorization for
Production mutation.
