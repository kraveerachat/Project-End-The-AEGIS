# AEGIS IDEA3 R1A Input Instrumentation — Repository Preparation Design

Status: repository implementation complete. Owner approval fixed the final
stage identifier as `R1I`; it is registered in `P4_STAGES` after F1u. R1A
remains a separate, unregistered stage.

## Evidence and ordering

The supplied read-only dump is the authority for the current host:
`/home/kittipat/Workspace/idea3-p4-evidence/2026-10-05-shared-readonly-preflight/nft-live.txt`.
It shows `table inet aegis_idea3`, with both `input` and `forward` base chains
at priority `filter` (numeric 0). Both chains contain the L2-owned
`@blocked_ipv4` drop. The proposed table therefore uses priority `-10`, which
is strictly earlier than the existing priority 0 chains while avoiding the
standard raw (`-300`), conntrack (`-200`), mangle (`-150`), dstnat (`-100`),
filter (`0`), security (`50`), and srcnat (`100`) priority boundaries. It is a
separate table so it cannot alter the L2 set or rule ownership.

## Owned nft surface

`inet aegis_idea3_r1i` contains only two base chains: `input` and `forward`.
Each has policy `accept` and one logging rule:

```nft
ct state new tcp flags & (syn | ack) == syn \
  limit rate 50/second burst 60 packets \
  log prefix "AEGIS_NEWCONN " level info
```

The rule has no verdict. It is logging-only, matches only initial TCP SYNs
(SYN set while ACK is clear), and is installed before the current L2 drop
chains. The token bucket permits an initial burst of 60 events (3× the
20-event SYN threshold) and replenishes at 50 events/second (100 tokens in the
2-second SYN window, 5× the threshold; 500 in the 10-second port-scan window,
50× the distinct-port threshold). This is bounded logging headroom, not an
exact-threshold design. Kernel nft logging is the trusted
source expected by `r1_acceptance.py`: `_TRANSPORT=kernel` and absent/empty
`_SYSTEMD_UNIT`; the kernel formatter supplies `SRC=` and `DPT=` fields.

## Mutation and rollback contract

The committed owner-run template remains inert. A future live use requires a
fresh authorization, K3, exact-main pin, and owner-frozen runner outside the
repository; repository registration does not authorize Production execution.
The handlers require an explicit live authorization flag, root, and a readable
`nft list tables` baseline. They refuse if the owned table already exists or
the state is malformed. Before the first nft mutation, `apply.sh` atomically
writes an ownership record containing `R1I`, the exact table, absent pre-state,
and source digest. It then captures the exact post-state.

`verify.sh` is read-only and checks the ownership record, exact post-state,
both hooks, priority `-10`, exact initial-SYN predicate, threshold-preserving
rate limit, and
absence of verdict statements. `rollback.sh` deletes only
`inet/aegis_idea3_r1i`, and only when the current state is byte-identical to
the owned post-state. Any foreign drift fails closed. No command uses
`nft flush ruleset`, edits `aegis_idea3`, edits `blocked_ipv4`, restarts Core or
the detector, sends an alert, creates an incident, or generates traffic.

## Verification boundary

The focused tests exercise rendering, live-dump ordering, payload/parser
compatibility, threshold-preserving rate limits, no-verdict rules, the
fixture-only apply/verify/rollback lifecycle, pre-mutation ownership journaling,
foreign-state refusal, one-shot behavior, malformed-state refusal, and the
absence of stage registration or R1A execution. No test invokes production
`nft`, traffic generation, Core, detector, alert, recovery, ESP32, or a real
event.
