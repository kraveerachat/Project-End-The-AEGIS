# AEGIS IDEA3 PR11 — Phase 1 Owner Decision Package

> Status: **PENDING OWNER REVIEW**
>
> Scope: **documentation / owner decisions only**
>
> `PRODUCTION_MUTATION_AUTHORIZED = NO`
>
> Merge of this decision package records architecture, ownership, operational values, or explicit deferrals only. It does **not** authorize any Production mutation.

## Current baseline

```text
BASE_MAIN = fe75bc53c1fd3a3103708470dfb7111996b80eff
PR11_PHASE0A = PASS
PR11_PHASE0B = PASS
PR11_PHASE0 = EVIDENCE COMPLETE
PR11_PHASE1A = PASS
PR11_PHASE1B = PASS (with claim corrections)
PHASE1_OWNER_DECISIONS = PENDING REVIEW
PHASE2 = BLOCKED
PHASE3 = BLOCKED
PHASE4_PLUS = BLOCKED
PRODUCTION_MUTATION_AUTHORIZED = NO
IDEA3_PRODUCTION_DEPLOYED = NO
```

Relevant merged dependency checkpoints:

- PR #125 — IDEA3 PR11 Phase 0 closeout.
- PR #118 — IDEA1 S5.5 closed / passed.
- PR #126 — IDEA1 S5.6 closed / passed; current Public Share runtime is active.

## Required interpretation rules

### K3

```text
K3_S5_5_DEPENDENCY = RESOLVED / SUPERSEDED
CURRENT_IDEA1_PRODUCTION_WINDOW_COORDINATION = STILL REQUIRED
```

The old dependency on unfinished S5.5 is closed. This does not mean IDEA3 Production work may overlap an IDEA1 Production mutation or verification window.

### K12

```text
PHASE0_K12_DOCUMENTATION_CONFLICT = SUPERSEDED
PHASE0_ARTIFACT_PROVENANCE = NOT PROVEN
CURRENT_S5_6_REBOOT_PERSISTENCE = NOT PROVEN
K12_CURRENT = PARTIALLY RESOLVED / RESIDUAL GATE OPEN
```

Later canonical IDEA1 records supersede the old documentation conflict, but they do not retroactively prove who deployed the Phase 0 artifacts or from which exact revision.

A reboot is a Production-affecting action. Any K12 reboot evidence must come from a separately authorized or already-planned reboot, followed by read-only verification.

### Authorization invariant

```text
Architecture Approved != Production Mutation Authorized
```

K1–K12 already received architecture/integration approval during PR10. This PR collects reconfirmations, concrete values, owner assignments, operational rules, and deferrals only.

## Current collision constraints for K4

The future IDEA3 /29 must not overlap these current ranges:

```text
172.31.240.0/29   aegis_public_share_edge
172.31.241.0/29   aegis_public_share_upstream
172.31.242.0/29   aegis_public_share_egress
172.19.255.0/29   aegis_drive_proxy
172.18.0.0/16     aegis_internal
192.168.10.0/24   aegis_vlan10_macvlan
```

No IDEA3 subnet is allocated in this document.

---

## Kla review required

### K1 — HUB Git/runtime reconciliation

Architecture is already approved; the closure method remains open.

```text
K1_RECONCILIATION_METHOD =
  SAME_ARTIFACT_HASH
  MARKER_LEVEL
  DEFER
```

- `SAME_ARTIFACT_HASH`: compare the live `/etc/nginx/conf.d/default.conf` artifact against Git `HUB-AEGIS_Entry/nginx.conf`.
- `MARKER_LEVEL`: compare equivalent resolver / proxy_pass / location markers without claiming byte identity.
- `DEFER`: keep K1 open.

No live check is performed by this PR.

### K2 — browser `/security/` route contract

```text
K2_ROUTE_CONTRACT_RECONFIRMED =
APPROVE / REJECT / DEFER
```

Proposed contract:

- HUB NGINX owns `/security/`.
- No new public host port.
- Prefix behavior is explicit.
- HUB owns security headers.
- Browser route remains separate from the machine route.
- No browser fallback into the machine-authentication path.
- K1 must close before Production implementation.

### K3 — current Production-window rule

```text
K3_CURRENT_WINDOW_RULE =
APPROVE / REJECT / MODIFY

Proposed rule:
No IDEA3 Production mutation while IDEA1 has an active Production mutation
or verification window.

K3_ROLLBACK_RELATION =
INDEPENDENT / SHARED_RISK

K3_PUBLIC_SHARE_PROTECTION =
APPROVE / REJECT / MODIFY
```

Default protection proposal: IDEA3 activity does not modify the current Public Share connector, egress network, firewall policy, or public route.

### K4 — final IDEA3 /29

```text
K4_IDEA3_SUBNET =
<CIDR> / DEFER
```

Kla owns the final allocation. Do not invent a value.

### K5 — dedicated IDEA3 Docker network

```text
K5_NETWORK_TOPOLOGY_RECONFIRMED =
APPROVE / REJECT / DEFER
```

Proposed topology:

- dedicated IDEA3 network;
- `internal: true`;
- HUB + IDEA3 Web only;
- no public port;
- no Public Share connector membership;
- no Drive / Monitor / PostgreSQL membership unless separately approved.

### K7 — HUB recreate and rollback ownership

```text
K7_HUB_RECREATE_PLAN_RECONFIRMED =
APPROVE / REJECT / DEFER

K7_ROLLBACK_OWNER =
<owner> / DEFER
```

Architecture remains: controlled Compose recreate, rollback prepared first, HUB-only scope, separate IDEA1/IDEA3 mutation windows, current Public Share runtime protected.

### K9 — machine route / SNI / mTLS

```text
K9_MACHINE_ROUTE_RECONFIRMED =
APPROVE / REJECT / DEFER

K9_MACHINE_SNI =
<hostname> / DEFER
```

Architecture:

- separate machine SNI/server block;
- required client certificate;
- browser path remains separate;
- trusted HUB overwrites identity headers;
- no browser fallback into the machine route.

`K9` blocks **Phase 2–3**.

### K10 — client CA / certificate custody

```text
K10_DEDICATED_CLIENT_CA =
YES / NO / DEFER

K10_CA_KEY_CUSTODIAN =
<owner> / DEFER

K10_CORE_KEY_CUSTODIAN =
<owner> / DEFER

K10_CERT_VALIDITY_POLICY =
<policy> / DEFER

K10_EXPIRY_BEHAVIOR =
PAUSE_DISPATCH / MODIFY / DEFER
```

Previously accepted architecture proposed a dedicated IDEA3 client CA, offline CA-key custody by Kla, Core client key kept on Core, approximately 90-day validity, and fail-closed dispatch pause on expiry.

> **Forward reference (added 2026-09-16):** for future execution, the K10 CA key custody recorded here is superseded by `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-16-idea3-pr11-k10-server-held-ca-amendment.md` (server-held dedicated client CA), **subject to Kla review**. This record is unchanged and remains accurate for its date.

No certificate is issued by this PR.

### K12 — reboot-persistence disposition

```text
K12_REBOOT_PERSISTENCE_DISPOSITION =
VERIFY_AT_NEXT_PLANNED_REBOOT
SCHEDULE_SEPARATELY_AUTHORIZED_REBOOT_WINDOW
DEFER_AND_KEEP_PHASE2_BLOCKED
```

This is a disposition decision only. It does not schedule or authorize a reboot.

---

## Pub / IDEA2 review required

### D6 — IDEA2 co-residence on candidate Core

```text
D6_IDEA2_CORE_CORESIDENCE =
APPROVE / REJECT / DEFER
```

If approved:

```text
D6_ALLOWED_IDEA2_SERVICES =
<services>

D6_RESOURCE_LIMITS_REQUIRED =
YES / NO

D6_PORT_NETWORK_CONSTRAINTS =
<constraints>

D6_RESTART_ORDER_CONSTRAINTS =
<constraints>

D6_FAILURE_ISOLATION_REQUIREMENTS =
<constraints>
```

This is ownership/architecture review only and changes no IDEA2 service.

---

## Music-owned design work allowed while review is pending

The following may proceed only as non-mutating specification/design work:

### D1 — ESP32 private AP and trusted Core-local time

Design scope:

- Core-hosted private ESP32 Wi-Fi AP;
- no forwarding/routing from the AP to other networks;
- Core-local trusted time source;
- explicit interface/binding boundary;
- fail-closed behavior when AP/time is unavailable.

### D2 — MQTT hardening

Design scope:

- broker TLS;
- CA verification/pinning;
- separate device credentials;
- topic ACLs;
- AP + loopback/private-interface binding;
- signed ACK;
- signed STATUS;
- Core-side evidence verification;
- nonce/timestamp/replay behavior.

Current observed state remains plain MQTT 1883, no TLS, no ACL, shared broker credential use, inbound HMAC verification only, and unsigned outbound ACK/STATUS.

### CORE-RT — dedicated IDEA3 Core runtime

Design scope:

- dedicated systemd unit;
- dedicated service user and data root;
- dispatch disabled by default;
- local durable dispatch DB;
- startup dependencies;
- recovery/backoff;
- logging and permissions;
- no dependency on desktop login.

### D4 — Core-local RESTORE CLI

Design scope:

- Core-local only;
- authenticated operator;
- explicit confirmation;
- required reason;
- audited;
- never automatic;
- never browser-triggered;
- never Telegram-triggered.

`D4` blocks **Phase 5–6**, not Phase 4.

---

## Decision / blocker matrix

| ID | Owner | Current state | Required answer | Blocks |
|---|---|---|---|---|
| K1 | Kla | pending | reconciliation method | Phase 2 |
| K2 | Kla | pending reconfirmation | route contract | Phase 2 |
| K3 | Kla + IDEA1 | pending | Production-window rule | Phase 2 |
| K4 | Kla | pending | final IDEA3 /29 | Phase 2 |
| K5 | Kla | pending reconfirmation | network topology | Phase 2 |
| K7 | Kla | pending | rollback owner + reconfirmation | Phase 2 |
| K8 | Kla + Music | blocked | VLAN20/Core path later | Phase 3 |
| K9 | Kla | pending | machine SNI / route | Phase 2–3 |
| K10 | Kla | pending | CA/cert values | Phase 3 |
| K11 | Kla | deferred | optional source-IP allowlist only after source preservation is proven | optional |
| K12 | Kla + IDEA1 | residual open | reboot disposition | Phase 2 if retained |
| D6 | Pub | pending | IDEA2 co-residence | Phase 3–4 |
| CORE-RT | Music | design allowed | implementation later | Phase 3 |
| D1 | Music | design allowed | implementation later | Phase 4 |
| D2 | Music | design allowed | implementation later | Phase 4 |
| HW | Music | NOT PROVEN | physical inspection later | Phase 4–6 |
| D4 | Music | design allowed | implementation later | Phase 5–6 |

No later phase is READY.

---

## Evidence invariants

```text
Requested != Published != ACK != Executed != Relay Confirmation != Physical Evidence
Admin Accepted != MQTT Published
MQTT Connected != ESP32 Online
ESP32 Online != Relay Success
Relay LED != Ethernet Continuity
Ethernet Continuity != Real Traffic Isolation
Protocol STATUS != Direct Electrical Relay Proof
Repository Implemented != Production Deployed
Architecture Approved != Production Mutation Authorized
TLS != mTLS
Route Present != Machine Authentication
Historical PR5 hardware evidence != PR11 live evidence
```

---

## Review workflow

Initial Draft PR state:

```text
OWNER_DECISION_STATE = PENDING_REVIEW
FINAL_RECEIPT_CREATED = NO
PHASE2 = BLOCKED
PRODUCTION_MUTATION_AUTHORIZED = NO
```

Required reviewers:

- **Kla:** K1, K2, K3, K4, K5, K7, K9, K10, K12.
- **Pub:** D6.

After actual reviewer decisions exist, update this same branch, preserve explicit DEFER values honestly, validate again, and create exactly one immutable Phase 1 receipt at final closeout.

Do not mark Ready or merge until the decision state is reconciled. Human review and human merge remain required.
