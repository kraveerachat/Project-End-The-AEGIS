# AEGIS IDEA3 PR11 Phase 4 T4 — G-07 Broker Migration Implementation Plan

Date: 2026-09-19
Owner: Music
Branch: `feat/idea3-pr11-phase4-t4-broker-migration`
Base: `0b6aea61556371140813cb63747170de7be84be6`
Design: `docs/superpowers/specs/2026-09-19-idea3-pr11-phase4-t4-broker-migration-design.md`

## Goal

Close the T4/G-07 repository gap for the owner-approved OD-08 topology:
a separate TLS-only IDEA3 Mosquitto instance on 8883, while preserving the
legacy wildcard 1883 broker and `aegis` identity unchanged.

This plan performs no live L6a/L6b action.

## Global constraints

- repository-first, TDD, fail closed;
- no Production/network/service mutation during implementation;
- no real credentials, passwords, private keys, or Production PKI in Git;
- no modification of the legacy live Mosquitto tree;
- no live AP, chrony, broker, ESP32, CUT/RESTORE, or reboot action;
- no weakening of §10/S-03 IDEA2 preservation;
- no claim that zero observed 1883 clients proves no consumer ever exists.

## Task 1 — Design/plan checkpoint

Create and review the T4 design and this plan.

Verify:

- exact branch/base;
- OD-08 recorded;
- fresh L0 boundary recorded;
- `git diff --check`;
- no runtime/source files changed yet.

Commit only after review.

## Task 2 — RED: separate-instance repository contract

Add focused tests before implementation for a new repository-safe T4
renderer/validator.

Tests must require:

- service name `aegis-idea3-mosquitto.service`;
- direct launch of Mosquitto with the IDEA3 rendered config;
- no dependency on or mutation command for `mosquitto.service`;
- IDEA3-only config/password/ACL paths;
- no `listener 1883`;
- exact 8883 loopback + AP bindings;
- rejection of wildcard/uplink binds;
- rejection of legacy `/etc/mosquitto/passwd`;
- rejection of `aegis` in the IDEA3 identity contract;
- deterministic render and strict validation;
- live-state flags remain `NO` / `NOT RUN`.

Record the RED failures.

## Task 3 — GREEN: render/validate separate instance

Implement the minimum repository-safe renderer/validator and example unit
needed to satisfy Task 2.

The renderer must accept only owner/live values needed for rendering and must
not execute systemctl, package-manager, nft, ip, NetworkManager, Mosquitto
service mutation, or host writes outside its explicit output directory.

Run focused tests, Ruff, compileall, and `git diff --check`.

## Task 4 — RED: L6b stage-handler contract

Add fixture-root tests for `stages/L6b/` requiring all five G-15 handler files.

Tests must prove:

- apply refuses missing prerequisite artifacts/baseline references;
- apply installs/starts only the separate IDEA3 service in the fixture;
- verify requires legacy broker preservation plus exact IDEA3 8883 scope;
- rollback is idempotent and removes only T4-owned artifacts;
- no handler contains a plaintext fallback or legacy broker restart/stop;
- allow files contain only the exact approved service/listener changes;
- real-host execution is refused in tests.

Record RED.

## Task 5 — GREEN: L6b handler + capture integration

Implement the reviewed L6b handler set and extend the L0 harness only as needed
to capture `aegis-idea3-mosquitto.service`.

Do not relax existing comparison rules.

Run focused T1/T4 tests and `git diff --check`.

## Task 6 — PF-01 regression

Add/extend tests proving AP-side TCP/1883 remains explicitly denied while T4
adds no AP-side 1883 allow rule.

Re-run the T5 firewall/PF-01 suite.

## Task 7 — Broker/PKI regression acceptance

Run at minimum:

- T4 focused tests;
- T2 broker material tests;
- T2 isolated broker validator tests;
- T3 MQTT PKI tests;
- broker config/loopback tests;
- T1 Phase 4 harness tests;
- T5 AP/firewall tests;
- all `test_pr11_phase4_*.py`;
- full IDEA3 pytest;
- compileall;
- focused Ruff;
- `git diff --check`;
- secret/material scan;
- host-mutation-token scan;
- vault validation;
- collaboration-policy validation.

Any new failure stops closeout.

## Task 8 — Repository closeout

Only after Task 7 PASS:

- update Phase 4 README;
- update canonical IDEA3 status;
- create exactly one immutable T4 final receipt;
- verify receipt count and validators;
- commit closeout;
- push branch;
- open human-review PR;
- human merge only.

Closeout must keep:

```text
L6A                     = NOT RUN
L6B                     = NOT RUN
PRODUCTION_MUTATION     = NO
PHASE4_RUNTIME_COMPLETE = NO
PHASE4_LIVE_READINESS   = NOT READY
```

A merged T4 PR still does not authorize live L6a/L6b.
