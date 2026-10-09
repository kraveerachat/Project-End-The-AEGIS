# R1I Successor Runner Plan

## Scope

Create one distinct repository-only successor for the consumed historical R1I
attempt. The successor owns only the dedicated inet aegis_idea3_r1i INPUT
logging table and does not register a new Phase-4 stage or alter the historical
R1I runner.

## Safety design

- A fresh authorization file binds R1I-SUCCESSOR-20261009, a new attempt ID,
  the exact trusted main SHA, the runner SHA-256, and the exact nft contract
  SHA-256.
- A canonical successor marker is created exclusively before nft mutation and
  is never removed or rewritten. Historical R1I markers remain untouched.
- Live canonical/state/source/Git/nft paths are fixed; there is no
  production-reachable fixture option. Hermetic tests inject a fake executor
  in-process and cannot resolve Production nft from PATH.
- Two complete JSON ruleset snapshots are taken before mutation; any drift
  stops before installation.
- Existing R1I material is rejected. Installation is one exact nft batch.
- Post-state removes every object belonging to the exact owned table, including
  separate table/chain/rule JSON objects, normalizes only irrelevant metadata
  and dynamic counter values, preserves unrelated objects, and validates the
  dedicated table's exact stateless shape.
- Apply, verify, and rollback require current trusted authorization, exact
  successor/attempt marker binding, trusted state ownership, and snapshot hash
  integrity. Marker and state writes are atomic and durable.
- Rollback deletes only the exact owned table after a fresh proof that both the
  surrounding ruleset and owned table are unchanged; any ambiguity stops.

## Verification

Hermetic tests use a synthetic ruleset and injected mocked nft. They cover the exact
rule, missing/existing/foreign state, source authority, authorization,
one-shot behavior, pre/post drift, install failure, preservation, rollback,
and the absence of service, detector, incident, recovery, relay, or hardware
actions. No live command or Production state is used.
