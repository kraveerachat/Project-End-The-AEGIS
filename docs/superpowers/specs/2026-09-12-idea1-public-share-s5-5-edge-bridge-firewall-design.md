# AEGIS IDEA1 — PUBLIC-SHARE-7 S5.5 Edge-Bridge Firewall Correction Design

Date: 2026-09-12
Status: CHAT DESIGN APPROVED; WRITTEN SPEC PENDING OWNER REVIEW; IMPLEMENTATION NOT STARTED
Scope: IDEA1 / PUBLIC-SHARE-7 / S5.5-F Production Runtime Acceptance correction
PR: #118 (`feat/idea1-public-share-s5-5-cloudflared-egress-isolation`)

## 1. Purpose

This design corrects a Production-discovered isolation gap in S5.5 without changing the accepted S5.4 topology, public-share Gateway contract, Cloudflare transport allowlist, connector image, token boundary, DNS/TLS state, MikroTik, Twingate, or Public Share UI.

The existing S5.5 routed/egress firewall remains valid for routed traffic. The correction adds one narrowly scoped native nftables `bridge` enforcement plane for connector-to-Gateway east-west traffic that crosses the shared Docker bridge at Layer 2 and therefore does not traverse the current `FORWARD -> DOCKER-USER -> AEGIS-PS-EGRESS` path on this Production host.

The owner approved the direction in four explicit chat gates:

- `APPROVE S5.5 EDGE BRIDGE NFTABLES DESIGN`
- `APPROVE S5.5 EDGE BRIDGE ARCHITECTURE`
- `APPROVE S5.5 EDGE BRIDGE LIFECYCLE`
- `APPROVE S5.5 EDGE BRIDGE FINAL DESIGN`

This written specification is a faithful consolidation of those approved design decisions and is now awaiting owner review as a document. No implementation, Production mutation, persistence enablement, public hostname, DNS/TLS route, or PR merge is authorized by this document alone.

## 2. Production evidence and root cause

S5.5-F reached the first live isolation matrix after the connector had passed source pinning, stopped-object identity, network attachment, firewall validation, Cloudflare readiness, and functional container DNS tests.

The first F1E matrix established two different packet paths:

1. Routed/egress path worked as designed. Direct attempts from the connector egress address `172.31.242.2` to Drive `172.31.241.3:8001` and PostgreSQL `172.31.241.3:5432` timed out, and the S5.5 terminal DROP counter increased.
2. Same-bridge east-west traffic did not traverse the S5.5 iptables chain. The connector edge address `172.31.240.3` attempted Gateway `172.31.240.2:22`, received `ECONNREFUSED`, and the terminal DROP counter for `172.31.240.3` remained zero.

The safety handler stopped the connector after the failed assertion. Follow-up read-only diagnostics then established:

- connector: `exited`, not running;
- Gateway: running;
- edge Docker network: `aegis_public_share_edge`;
- measured current edge bridge: `br-c76a97580271`;
- `br_netfilter`: not loaded;
- `/proc/sys/net/bridge/bridge-nf-call-iptables`: absent;
- `/proc/sys/net/bridge/bridge-nf-call-ip6tables`: absent;
- `FORWARD` still enters `DOCKER-USER` before Docker forwarding chains;
- Docker has a same-bridge accept for `br-c76a97580271` in `DOCKER-FORWARD`;
- S5.5 `AEGIS-PS-EGRESS` had zero packets on its connector-edge allow/drop rules while the routed connector-egress rules had live counters.

Root cause: on this Production host, same-bridge Layer-2 forwarding is not passed through the iptables bridge-netfilter compatibility path. Therefore the original assumption that `DOCKER-USER` sees all connector forwarding is false for connector-to-Gateway traffic on `aegis_public_share_edge`.

This is an architectural correction, not a test-only or validator-only correction.

## 3. Non-goals and immutable boundaries

This correction MUST NOT:

- load `br_netfilter`;
- write `net.bridge.bridge-nf-call-iptables` or related bridge sysctls;
- change global Docker bridge filtering behavior;
- change the S5.4 edge/upstream topology;
- recreate Drive, Gateway, database, or unrelated containers;
- change the connector image or its two accepted attachments;
- add DNS/53 firewall exceptions;
- configure a public hostname, public DNS, TLS route, or Public Share UI;
- change MikroTik or Twingate;
- enable systemd units during S5.5-F;
- merge PR #118 or create the final immutable S5.5 receipt.

The accepted S5.4 baseline remains authoritative.

## 4. Architecture

### 4.1 Three enforcement planes

S5.5 will have three complementary enforcement planes owned by the same firewall lifecycle script:

1. `iptables-nft / DOCKER-USER / AEGIS-PS-EGRESS`
   - routed connector egress;
   - connector edge allow to Gateway TCP/8080 when the packet traverses routed forwarding;
   - exact reviewed Cloudflare `/32` TCP/7844 allowlist;
   - terminal connector-source drops.

2. `iptables-nft / INPUT / AEGIS-PS-INPUT`
   - connector-to-host deny;
   - protects host SSH and any other present or future host-local listener;
   - no DNS exception.

3. native `nftables` family `bridge`
   - same-bridge connector/Gateway east-west isolation on `aegis_public_share_edge`;
   - no global bridge-netfilter setting;
   - no effect on unrelated Docker bridges unless a rule explicitly matches them.

The existing iptables planes are retained because Production proved that they enforce routed/Internet egress correctly. The bridge plane exists only to cover the Layer-2 path the iptables planes do not see on this host.

### 4.2 Native bridge table identity

Canonical owned object:

- family: `bridge`
- table: `aegis_s55_edge`
- ownership marker/comment: `AEGIS-PUBLIC-SHARE-S5.5`
- base chain: `forward`
- hook: `forward`
- priority: `0`
- policy: `accept`

`policy accept` is deliberate. S5.5 is not a global bridge firewall; it owns only explicitly matched Public Share connector traffic. Unrelated bridge traffic must continue to the host's existing Docker behavior.

If a table named `aegis_s55_edge` already exists but ownership cannot be positively proven from the expected marker and structure, `apply` and `remove` MUST refuse to overwrite or delete it.

### 4.3 Dynamic edge bridge binding

The Linux bridge name MUST be resolved from `docker network inspect aegis_public_share_edge` at runtime.

The design MUST NOT pin the measured current name `br-c76a97580271`. Docker network IDs and derived bridge names may legitimately change if the network is recreated. The invariant is the canonical network identity and metadata, not a historical bridge suffix.

Rules use bridge metadata (`ibrname`/`obrname`, or equivalent nft bridge-family interface metadata accepted by the implementation) bound to the dynamically resolved edge bridge. veth names MUST NOT be pinned because they change across container lifecycle events.

## 5. Bridge rule model

The bridge policy is intentionally stateless for the Gateway HTTP flow. The design does not depend on bridge-family conntrack semantics.

Canonical IPv4 behavior on the resolved S5.4 edge bridge:

1. ACCEPT connector `172.31.240.3` -> Gateway `172.31.240.2`, TCP destination port `8080`.
2. ACCEPT Gateway `172.31.240.2`, TCP source port `8080` -> connector `172.31.240.3`.
3. DROP any other IPv4 frame sourced from connector `172.31.240.3` on the edge bridge.
4. DROP any other IPv4 frame destined to connector `172.31.240.3` on the edge bridge.

No other east-west TCP port is authorized.

ARP MUST remain available. Terminal rules therefore match IPv4 explicitly rather than all Ethernet frames.

The implementation MUST NOT introduce a broad ACCEPT that authorizes unrelated bridge traffic. Gateway-initiated new TCP connections to the connector are not required and MUST be denied unless they are packets matching the explicit reverse HTTP rule.

### 5.1 IPv6 fail-closed requirement

An IPv4-only bridge policy is insufficient if the connector can obtain IPv6 on the edge network. Therefore pre-start/runtime validation MUST positively prove the accepted edge network is not enabling IPv6 for this contract.

If the canonical Docker network metadata cannot prove IPv6 is disabled, the connector MUST NOT start. The correction MUST NOT silently rely on the absence of an observed IPv6 address.

## 6. Ownership, atomicity, and preflight

`s5-5-firewall.sh` remains the single owner of all S5.5 firewall state.

Before any mutation, `apply` MUST prove:

- the existing iptables backend is `nf_tables`;
- host chains `INPUT` and `DOCKER-USER` exist;
- the `nft` CLI exists and can inspect the relevant bridge family;
- the edge Docker network can be inspected;
- the edge Linux bridge resolves to a real host interface;
- the bridge candidate ruleset is syntactically and semantically accepted by `nft --check -f` or an equivalent no-commit validation mode;
- any pre-existing `bridge aegis_s55_edge` object is either absent or positively owned by S5.5.

The native bridge ruleset MUST be applied as a single nft batch transaction. Rule-by-rule live mutation is forbidden.

For a first install, the candidate is validated before commit. For reconciliation, the implementation MUST preserve a fail-closed boundary: it must not intentionally create a gap in which connector east-west traffic is unrestricted.

The exact implementation mechanism may use an atomic batch that deletes/recreates only the owned table or atomically replaces its owned contents. It MUST NOT flush or restore unrelated nftables tables or a whole host ruleset.

## 7. Apply, validate, and remove lifecycle

### 7.1 Apply

Canonical order:

1. full preflight;
2. load/verify Cloudflare transport allowlist;
3. resolve edge bridge;
4. build and no-commit-check the bridge candidate;
5. reconcile `AEGIS-PS-EGRESS` and `AEGIS-PS-INPUT` using the existing task-owned model;
6. atomically install/reconcile `bridge aegis_s55_edge`;
7. return success only after all required mutation steps complete.

The connector is expected to be stopped during first activation. If apply fails, the connector MUST remain stopped.

### 7.2 Validate

`validate` is read-only and MUST prove all three planes.

For the bridge plane, it MUST verify at least:

- exact family/table identity;
- S5.5 ownership marker;
- exactly one expected base forward chain;
- hook `forward`, priority `0`, policy `accept`;
- dynamic binding to the currently resolved edge bridge;
- exact connector -> Gateway TCP/8080 allow;
- exact Gateway TCP source-port 8080 -> connector reverse allow;
- terminal IPv4 connector-source drop;
- terminal IPv4 connector-destination drop;
- no unexpected ACCEPT or additional rule in the owned chain;
- no stale duplicate owned table/chain artifact.

Validation must compare canonical semantics, not depend on unstable pretty-print ordering where nft can normalize equivalent syntax.

A successful iptables validation alone is no longer sufficient for S5.5-F.

### 7.3 Remove

`remove` continues to require positive proof that the connector is inactive before removing isolation.

It MUST:

- remove only S5.5-owned iptables anchors/chains;
- remove only positively owned `bridge aegis_s55_edge`;
- refuse to delete a foreign or ambiguous table;
- never stop workloads itself;
- never flush unrelated nftables/iptables state.

An already-absent owned bridge table is an idempotent safe state only when there is no conflicting foreign object with the same name.

## 8. systemd and runtime integration

No new systemd service is introduced.

`aegis-public-share-s5-5-firewall.service` remains the lifecycle owner and keeps the existing behavior:

- `ExecStart = s5-5-firewall.sh apply`
- `ExecStartPost = s5-5-firewall.sh validate`
- `ExecStop = s5-5-firewall.sh remove`

The unit description/documentation may be updated to state that the service owns three enforcement planes, but dependency ordering does not change.

`aegis-public-share-connector.service` remains dependent on and bound to the firewall service. It still runs `s5-5-runtime-check.sh --pre-start` and starts only the already-created connector object.

`s5-5-runtime-check.sh` continues to treat `s5-5-firewall.sh validate` as the firewall safety gate. Because that validator will now prove both iptables and bridge enforcement, the existing pre-start/drift lifecycle inherits the new boundary without a second firewall service.

Runtime validation also gains the IPv6/network invariant needed to prove there is no alternate edge path outside the IPv4 bridge policy.

The drift watchdog remains connector-only: if the complete firewall contract cannot be proven, the drift path stops only the connector and does not restart Docker, UFW, Drive, Gateway, or unrelated services.

## 9. Failure semantics

All behavior is fail closed.

- Preflight/candidate-check failure before mutation: no new mutation.
- iptables reconciliation succeeds but bridge commit fails during first activation: firewall unit fails; connector remains stopped.
- Bridge table missing or drifted at pre-start: connector must not start.
- Bridge table missing or drifted while running: drift validation fails and connector is stopped by the existing watchdog lifecycle.
- Ambiguous ownership: refuse mutation/removal.
- Edge bridge cannot be resolved: refuse apply/validate.
- IPv6 invariant cannot be proven: refuse pre-start.
- No failure path may add DNS/53, load `br_netfilter`, weaken terminal drops, or enable persistence as an emergency workaround.

## 10. Rollback contract

The existing S5.5 rollback order remains authoritative:

1. stop/disable drift timer/service;
2. stop/disable connector service;
3. stop/remove only the connector container;
4. call `s5-5-firewall.sh remove`;
5. prove egress network endpoint count is zero and remove only `aegis_public_share_egress`.

The correction changes firewall removal semantics so step 4 also removes the owned bridge table.

Rollback MUST preserve:

- S5.4 Gateway;
- Drive State B;
- database;
- protected volumes;
- edge/upstream/private networks;
- unrelated containers;
- UFW, Docker daemon, MikroTik, and Twingate configuration.

No `compose down`, prune, whole-stack restart, or volume removal is permitted.

## 11. TDD and repository verification

Implementation is test-driven. The current source MUST first fail new bridge-firewall contract tests before production code is changed.

### 11.1 New bridge-focused tests

Add `IDEA1-AEGIS_Drive_LC/tests/publicShareS55BridgeFirewallContract.test.js` with disposable mocks for `nft`, iptables, Docker network inspection, and sysfs. Tests never touch a real firewall.

Required cases include:

- current pre-correction source fails the required bridge-enforcement contract;
- missing/unusable `nft` fails before mutation;
- candidate `nft --check` failure fails before bridge commit;
- dynamic edge bridge derivation; no hard-coded Production bridge suffix;
- exact table/chain/hook/priority/policy/ownership contract;
- exact TCP/8080 forward and reverse rules;
- exact terminal IPv4 source/destination drops;
- no ARP deny;
- no broad/extra ACCEPT;
- wrong port or bridge is rejected by validate;
- missing or additional owned-chain rule is rejected;
- foreign same-name table is never overwritten or removed;
- apply is idempotent;
- remove refuses while connector active;
- remove deletes only positively owned S5.5 state;
- no `modprobe br_netfilter`;
- no write to `/proc/sys/net/bridge/*`;
- no `sysctl -w net.bridge.bridge-nf-call-iptables=1`.

### 11.2 Existing contract tests

Extend `publicShareS55FirewallContract.test.js` to cover integrated apply/validate/remove lifecycle while preserving all existing iptables expectations.

Extend `publicShareS55RuntimeContract.test.js` to verify bridge enforcement is part of the pre-start/drift safety contract and that the IPv6 invariant is fail closed.

Existing normalization regression coverage remains required.

### 11.3 Regression gates

Before any Production redeployment, the branch must pass the focused S5.5 firewall/runtime/security/Cloudflare tests, S5.4 regression tests, collaboration guardrails, repository whitespace checks, and the full IDEA1 suite with no new failures relative to the already-recorded known baseline.

The exact test counts may change because this correction adds tests; acceptance is based on zero unexpected/new failures, not preserving old test totals.

## 12. Production acceptance after repository correction

Production remains stopped at the connector boundary until exact reviewed corrected artifacts are deployed.

The redeployment sequence is:

1. prove connector is still inactive;
2. fetch/pin exact reviewed source commit;
3. install only reviewed corrected artifacts;
4. validate candidate/live firewall with connector stopped;
5. prove all systemd units remain disabled;
6. start the same connector object through the accepted systemd service;
7. prove Cloudflare readiness and functional DNS;
8. run the complete isolation matrix;
9. run two live firewall reconciliation cycles while connector remains healthy;
10. stop for F1 final acceptance review.

### 12.1 Positive probes

Must pass:

- connector -> Gateway `172.31.240.2:8080`;
- connector -> one or more reviewed Cloudflare `/32` endpoints TCP/7844;
- cloudflared readiness;
- DNS UDP and TCP via the measured container resolver path (`127.0.0.11` unless fresh evidence differs and is separately reconciled).

### 12.2 Negative probes

Must be blocked with firewall-counter evidence from the responsible enforcement plane:

- connector edge -> Gateway TCP/22;
- connector edge -> any other unauthorized Gateway port;
- connector egress -> Drive TCP/8001;
- connector egress -> PostgreSQL TCP/5432;
- connector egress -> reviewed Cloudflare endpoint TCP/443;
- connector egress -> arbitrary Internet `1.1.1.1:443`;
- connector -> host SSH TCP/22;
- connector -> host Docker bridge TCP/18077;
- connector -> Cloudflare UDP/7844.

For Gateway:22 specifically, `ECONNREFUSED` without a native bridge DROP-counter increase is a failure. The correction is accepted only when the bridge firewall itself is proven to block the packet.

### 12.3 Invariants that must remain true

- connector object ID/creation timestamp unchanged;
- exactly two connector networks with accepted addresses;
- Drive and Gateway remain running and unrecreated;
- no host listener on 7844 or 20241;
- public hostname still does not resolve;
- public DNS/TLS remains not configured;
- no DNS/53 exception;
- firewall/connector/drift units remain disabled during F1;
- drift timer remains inactive during F1;
- no `br_netfilter` load or global bridge sysctl mutation;
- MikroTik and Twingate remain untouched.

### 12.4 Live reconciliation

While cloudflared is healthy, run `apply -> validate` twice.

After each cycle:

- connector readiness must still pass;
- connector object must not be recreated;
- no staging or duplicate owned firewall artifact may remain;
- both iptables and bridge policy must validate exactly.

F1 remains incomplete until all of this evidence passes.

## 13. Repository files in implementation scope

Expected implementation touchpoints are limited to:

1. `gateway/public-share/production/s5-5-firewall.sh`
2. `IDEA1-AEGIS_Drive_LC/tests/publicShareS55FirewallContract.test.js`
3. `IDEA1-AEGIS_Drive_LC/tests/publicShareS55BridgeFirewallContract.test.js` (new)
4. `IDEA1-AEGIS_Drive_LC/tests/publicShareS55RuntimeContract.test.js`
5. `gateway/public-share/production/s5-5-runtime-check.sh`
6. `gateway/public-share/production/rollback-s5-5.sh`
7. `gateway/public-share/production/systemd/aegis-public-share-s5-5-firewall.service`
8. `gateway/public-share/production/README.md`
9. this design spec and the later implementation plan/status reconciliation required by the project workflow.

`docker-compose.s5-5.yml`, the connector service dependency model, Gateway implementation, Drive implementation, Cloudflare endpoint allowlist, and token contents are not planned implementation changes for this correction unless a later verified blocker proves that the approved design cannot be implemented without revisiting scope. Such a scope expansion requires a new owner approval gate.

## 14. Current operational state at design approval

At the end of the evidence-gathering sequence that motivated this design:

- connector container exists but is stopped (`exited`, not running);
- S5.5 iptables firewall service remains active/fail-closed;
- Cloudflare connector status is expected to be disconnected while the connector is stopped;
- egress network and connector object still exist from authorized F1 bootstrap;
- systemd persistence remains disabled;
- public hostname/DNS/TLS remains absent;
- Public Share UI remains off;
- S5.5-G restart/persistence/rollback acceptance has not started;
- PR #118 remains Draft and must remain unmerged.

## 15. Acceptance boundary

This written spec is ready for owner review. After owner approval of this document, the next step is to write a detailed implementation plan. No implementation may begin merely because this spec exists.

After implementation and repository verification, Production redeployment remains a separately controlled operational step within the already-approved S5.5-F correction scope. S5.5-G remains a separate owner-gated phase.
