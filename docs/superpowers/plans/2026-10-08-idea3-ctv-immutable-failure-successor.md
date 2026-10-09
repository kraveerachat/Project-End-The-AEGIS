# CTv immutable-CTu-failure successor implementation plan

## Goal

Add a repository-only, one-attempt CTv successor after the consumed immutable
CTu APPLY failure without rerunning CTu, rewriting CTu markers, or executing
Production changes.

## Design

1. Keep CTu and CTv in separate marker, Authorization/K3, runner, and closeout
   namespaces. Track the actual frozen runner hash independently from the
   exact-main template, bundle manifest, and control manifest hashes.
2. Require a complete non-consuming rehearsal before CTv consumption. The
   rehearsal covers provenance, bundle/control integrity, the CTu immutable
   predecessor, Recovery-unconsumed state, baseline/runtime preconditions,
   target unit, drop-ins, L0, device, and rollback state machine.
3. Establish a durable root-trusted `consumed-no-production-mutation` journal
   immediately after a future CTv consume and before any mutation. Rollback of
   that phase reports PASS/NO_MUTATION with zero Core restart and zero Detector
   lifecycle commands.
4. Keep public CTv handlers refusal-only; the future pinned owner runner owns
   the mutation boundary, with one Core restart and no explicit Detector
   lifecycle command.
5. Allow Recovery to proceed only through a valid historical CTu PASS path or
   a separately reviewed CTv CLOSED_PASS path for this installation.

## Verification

- Hermetic CTv tests exercise real rendered runner/template hash mismatch,
  journal durability/rollback, handler refusal, stage registration, and the
  non-consuming rehearsal.
- Existing CTu, L0 dependency, Core trusted-time, RRu, Recovery, vault, and
  collaboration suites are run where the host test capability permits.
- CTu LIVE, CTv LIVE, Recovery LIVE, Production, services, Detector lifecycle,
  and governance markers remain untouched.
