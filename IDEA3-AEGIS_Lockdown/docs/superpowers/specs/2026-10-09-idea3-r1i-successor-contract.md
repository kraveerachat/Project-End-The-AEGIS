# IDEA3 R1I-Only Governed Successor Contract

Status: repository implemented; independent review and G6 authorization
pending. This document is not a Production authorization.

## Identity and exact scope

Successor identity: R1I-SUCCESSOR-20261009.

The only intended mutation is the existing dedicated table
inet aegis_idea3_r1i, with one INPUT hook at priority -10, policy accept,
IPv4 new TCP initial-SYN matching, 50/second rate, burst 60, and kernel log
prefix AEGIS_NEWCONN. The contract is byte-bound by r1i-successor.nft and
does not touch the existing inet aegis_idea3 table, containment rules,
services, Core, detector, incidents, Recovery, MQTT, or hardware.

The historical R1I runner, authorization, marker, and consumed attempt remain
immutable. This successor is not registered in the historical Phase-4 stage
catalog and cannot promote or rewrite historical evidence.

## Canonical state path

The live successor owns the isolated canonical directory
`/var/lib/aegis-idea3-r1i-successor`. Its authorization file is
`/var/lib/aegis-idea3-r1i-successor/authorization.txt` and its durable state
is under `/var/lib/aegis-idea3-r1i-successor/state`. This path is intentionally
separate from the service-owned Core directory `/var/lib/aegis-idea3`; the
runner never modifies, migrates, or creates state in that Core directory.
Before any future G6 execution, the isolated directory must be provisioned as
a root-owned, non-symlink, non-group/world-writable directory (preferably
mode 0700) beneath trusted root-owned ancestors. The runner's existing
trusted-path and one-shot checks remain the enforcement boundary.

## Authorization and authority

A future owner authorization file must be a regular, non-group/world-writable
file containing exactly:

    successor_id=R1I-SUCCESSOR-20261009
    attempt_id=R1I-SUCCESSOR-ATTEMPT-<fresh-id>
    trusted_main_sha=<40 lowercase hex>
    runner_sha256=<64 lowercase hex>
    contract_sha256=7cb088c698d1a5fc8df62f13ec94c83ab37e974a7644588c7fd15bb9449f7888
    authorized=YES

The runner verifies the current checkout HEAD, its own bytes, and the contract
bytes against those values. It obtains the official GitHub main ref over
authenticated HTTPS through fixed `/usr/bin/curl`; the owner-provisioned token
is read only from the fixed root-owned mode-0600 path
`/etc/aegis-idea3/github-token` and delivered through curl's protected stdin
config, never argv or ordinary environment. Redirects, proxy, curl
configuration, and environment-controlled executable resolution are disabled.
An arbitrary local checkout, remote configuration, caller-provided SHA, or
local authority file is insufficient. It refuses unavailable, stale,
malformed, duplicated, or replayed authorization. It also refuses if the
canonical successor marker already exists. The historical
R1I-GLOBAL-ATTEMPT-CONSUMED marker is read only by surrounding governance and
is never changed by this runner.

The live path additionally requires root, fixed canonical/state/source/Git/nft
paths, and the explicit runtime setting AEGIS_R1I_SUCCESSOR_LIVE_AUTHORIZED=YES.
There is no production-reachable fixture option. Hermetic tests inject fake
Git authority responses and fake nft executors in-process, so tests cannot
resolve Production commands from PATH.

## Execution boundary

Before nft mutation the runner captures the complete JSON ruleset, rejects any
existing R1I table/rule/log material, including structured AEGIS_NEWCONN log
objects in foreign tables, and captures again immediately before
mutation, and stops on any difference. It then atomically consumes the fresh
successor marker, revalidates remote authority immediately before mutation,
and applies only the contract file. If that post-marker check fails, the
attempt remains durably consumed, no nft mutation occurs, and the terminal
error requires a separate governed decision; the marker is never removed or
retried automatically.

After mutation it captures the complete ruleset and the stateless dedicated
table. Comparison removes every table, chain, rule, set, or other object whose
exact family/table is inet/aegis_idea3_r1i; unrelated objects are preserved
while irrelevant metadata and dynamic counter values are normalized. The
surrounding ruleset must be byte-equivalent to the pre-state and
the owned table must have exactly the contract shape. A failed install or
ambiguous post-state consumes the attempt and never retries.

## Rollback

Verify and rollback repeat current trusted authorization, exact successor and
attempt marker binding, trusted state, snapshot hash, surrounding-state, and
exact-owned-table checks. Rollback is allowed only when those checks pass. It
deletes only inet/aegis_idea3_r1i, then requires the
complete ruleset to equal the pre-mutation snapshot. Drift, failed capture,
failed deletion, or any uncertain outcome stops and leaves manual escalation;
the runner never flushes or replaces unrelated nftables state.

## Explicit non-goals

This runner does not restart Core, start or enable the detector, publish MQTT,
send alerts, create or bind incidents, alter Recovery, control a relay, access
ESP32 hardware, generate Kali traffic, or execute CUT/ISOLATE/RESTORE. A
future G6 owner authorization is required even after independent review.
