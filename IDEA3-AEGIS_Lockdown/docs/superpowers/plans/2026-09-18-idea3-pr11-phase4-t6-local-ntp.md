# IDEA3 PR11 Phase 4 T6 — Local Trusted NTP Implementation Plan

Date: 2026-09-18
Owner: Music
Task: T6 / G-05
Dependency: merged T5 repository contract + owner-decided OD-06

## Goal

Implement the repository-only local trusted NTP contract without performing
any live Core, network, Production, or ESP32 mutation.

## Planned paths

Create:

- `deploy/pr11-phase4/p4-ntp.py`
- `tests/test_pr11_phase4_ntp.py`

Modify:

- `deploy/chrony/aegis-idea3-chrony.conf.example`
- `tests/test_private_ap_contract.py`
- `deploy/pr11-phase4/README.md`

Documentation already planned in this task:

- this implementation plan;
- the T6 design specification;
- Music-owned `idea3-status.md`;
- exactly one final receipt only at task closeout.

## TDD sequence

### Task 1 — RED: T6 tool and upstream contract

Add focused failing tests proving that:

- `p4-ntp.py` must exist;
- trusted upstream is required;
- AP address and subnet are required and valid;
- AP address must belong to the supplied subnet;
- the chrony template must expose a deferred trusted-upstream placeholder.

Run the focused tests and record the real RED result before implementation.

### Task 2 — GREEN: deterministic renderer

Implement the minimum renderer required to satisfy Task 1.

Required behavior:

- deterministic output;
- owner-supplied upstream;
- exact AP bind;
- exact AP-subnet allow;
- refuse non-empty output directory;
- no live service or network mutation.

### Task 3 — RED/GREEN: unsafe configuration rejection

Add tests for and then implement rejection of:

- wildcard bind;
- `allow all`;
- unresolved placeholders;
- unsafe chrony local/local-stratum mode;
- malformed or injected upstream value;
- extra serving bind;
- mismatched AP address/subnet.

### Task 4 — Handoff and TrustedClock contract

Add repository tests proving the rendered contract declares:

- pre-handoff TrustedClock state `SYNCED`;
- final state `SYNCED`;
- maxerror bound equals `MAX_ERROR_US`;
- holdover limit equals `HOLDOVER_SEC`;
- rollback owner is systemd-timesyncd;
- no weakening of TrustedClock semantics.

Do not modify TrustedClock thresholds to make these tests pass.

### Task 5 — T5 regression preservation

Reconcile the historical private-AP test that previously required no upstream
line at all. Replace that pre-T6 assumption with the T6 contract: an upstream
is required but must remain deferred/owner-supplied rather than hardcoded.

Prove the existing T5 firewall still:

- allows AP-side UDP/123;
- contains no NAT contract;
- preserves forwarding isolation.

Do not modify T5 nftables unless a real repository defect is proven.

### Task 6 — README reconciliation

Document the T6 repository contract and explicitly separate it from future L5.

State that no chrony installation, chronyd activation, timesyncd handoff,
live NTP query, or Production mutation has occurred.

### Task 7 — focused regression

Run:

- T6 focused tests;
- private AP contract tests;
- TrustedClock tests;
- T5 AP-network tests;
- Phase 4 harness and other affected Phase 4 tests.

Record actual counts/results; do not predict PASS.

### Task 8 — acceptance regression

Run the full IDEA3 pytest suite, compileall, focused Ruff checks,
`git diff --check`, vault validation, collaboration validation, and scans for
live upstream values, credentials, private keys, PSKs, and other secrets.

### Task 9 — final closeout

Only after all acceptance evidence passes:

- set `T6_REPOSITORY_IMPLEMENTED = YES`;
- set `G05_REPOSITORY_CONTRACT = CLOSED`;
- preserve `L5 = NOT RUN`;
- preserve `PHASE4_RUNTIME_COMPLETE = NO`;
- create exactly one final immutable T6 receipt;
- prepare the PR for human review and human merge.

## Explicit non-goals

- no chrony package installation;
- no live `/etc/chrony.conf` write;
- no timesyncd stop/disable;
- no chronyd start/enable/restart;
- no AP/network mutation;
- no nftables mutation;
- no ESP32 flash/NVS operation;
- no L5 execution;
- no Production completion claim.
