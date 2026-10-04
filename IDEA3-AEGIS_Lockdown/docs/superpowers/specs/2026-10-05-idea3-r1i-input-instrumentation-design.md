# AEGIS IDEA3 R1I Input Instrumentation — Repository Design

Status: repository implementation complete, **not executed live, not deployed**.
Owner approval fixed the final stage identifier as `R1I`; it is registered in
`P4_STAGES` after F1u. R1A remains a separate, unregistered stage.

## Purpose and scope

R1I installs the trusted kernel-origin NEW-CONNECTION log source
(`AEGIS_NEWCONN`) that the later host detector acceptance (R1A) needs. The
detector's port-scan and SYN-flood rules (`production_detector`) watch
connections *to the AEGIS host*. Nothing in the repository's detector or R1
acceptance contract requires transit traffic, and the host has forwarding
disabled with no NAT, so R1I hooks **input only**. A forward hook would only add
ordinary forwarded-client browsing to the detector stream as false-positive
port-scan/SYN-flood input. The rule is also constrained to IPv4
(`meta nfproto ipv4`) because the detector's `SRC=` parser accepts IPv4 only; an
IPv6 packet would otherwise consume the log bucket and then be ignored.

## Evidence and ordering

The read-only preflight dump (2026-10-05) recorded `table inet aegis_idea3` with
`input` and `forward` base chains at priority `filter` (numeric 0), both holding
the L2-owned `@blocked_ipv4` drop. The committed test fixture
`tests/r1i/fixtures/l2_hook_priority_facts.nft.fixture` is a sanitized
**fixture authority** reduction of those facts; it is not current live evidence
and proves nothing about Production. R1I uses priority `-10`, strictly before
priority 0 and clear of the standard boundaries (raw `-300`, conntrack `-200`,
mangle `-150`, dstnat `-100`, filter `0`, security `50`, srcnat `100`). It is a
separate table, so it cannot alter the L2 set or rule ownership. Because it runs
before the L2 drop, a source that is already blocked is still logged.

## Owned nft surface

Applied as one atomic nft batch (a single transaction):

```nft
create table inet aegis_idea3_r1i
add chain inet aegis_idea3_r1i input { type filter hook input priority -10; policy accept; }
add rule inet aegis_idea3_r1i input meta nfproto ipv4 ct state new tcp flags & (syn | ack) == syn limit rate 50/second burst 60 packets log prefix "AEGIS_NEWCONN " level info
```

The rule has no verdict. It matches only initial TCP SYNs over IPv4. The token
bucket permits an initial burst of 60 events (3x the 20-event SYN threshold) and
replenishes at 50 events/second (100 tokens in the 2-second SYN window, 5x the
threshold; 500 in the 10-second port-scan window, 50x the distinct-port
threshold). This is bounded logging headroom, not an exact-threshold design. The
kernel log formatter supplies `SRC=` and `DPT=`; the source/transport properties
that `r1_acceptance.py` expects (`_TRANSPORT=kernel`, empty `_SYSTEMD_UNIT`) are
design expectations here and are **not** observed until a live run.

## Atomic creation (no check-then-act)

`create table` fails with `File exists` when the table is present, and the batch
is one transaction, so an existing (foreign) table is never merged into, flushed
or deleted. Verified against local nft 1.1.7 in a private user/network namespace
(`unshare -rn`, never the host): the first apply succeeds, a second apply fails
with `File exists` and leaves the ruleset unchanged. The earlier `nft list tables`
check remains only as an advisory early refusal; the atomic create is the
authority.

## Mutation, failure and rollback contract

The committed owner-run template remains inert. A future live use requires a
fresh authorization, K3, an exact-main pin and an owner-frozen runner outside the
repository; registration does not authorize Production execution. Live handlers
additionally require `AEGIS_R1I_LIVE_AUTHORIZED=YES`, root and a readable nft.

1. Ownership is journaled (`OWNERSHIP`, noclobber) before the first mutation. One
   attempt only; a second run fails `ONE_SHOT_ALREADY_CONSUMED`. No retry.
2. `nft -f` creates the table atomically. If it is refused, nothing was created.
3. The post-state is captured and must pass `validate-state` before it is
   recorded as `POST_STATE`.
4. If the create succeeded but capture/validation/recording fails, the handler
   re-reads the table. Only if that state is proven to be exactly the owned shape
   does it delete `inet aegis_idea3_r1i` and report
   `RESULT=ROLLED_BACK_EXACT_OWNED_STATE`. Otherwise nothing is deleted and it
   reports `RESULT=MANUAL_CLEANUP_REQUIRED`. The attempt stays consumed either way
   and an `OUTCOME` record is written.
5. `verify.sh` is read-only and requires the exact post-state plus
   `validate-state`. `rollback.sh` deletes only `inet aegis_idea3_r1i`, and only
   when the current state is byte-identical to `POST_STATE` and exactly owned.

`validate-state` accepts only the exact table: one `input` chain at priority
`-10` (nft prints `filter - 10`; both spellings accepted), policy accept, and the
single logging rule. Any extra line, chain, rule, counter, mark, verdict or log
statement is rejected; it does not rely on substring counts.

No command uses `nft flush ruleset`, edits `aegis_idea3` or `blocked_ipv4`,
restarts Core or the detector, sends an alert, creates an incident or generates
traffic.

## Output honesty

`VERIFIED_` lines are printed only after the state was examined. `EXPECTED_` and
`DESIGN_` lines are design intent that the handler did not observe.

## Verification boundary

Tests cover rendering, validator mutation rejection, the fixture and real-nft
(private namespace) apply/verify/rollback lifecycle, atomic refusal of an
existing table, the post-apply failure model, one-shot behaviour and R1A
non-registration. The private-namespace runs are local evidence only. How the
Production host's nft normalises the rendered state is a **LIVE-preflight proof
that is not claimed here**. No test touches the host ruleset, generates traffic,
or runs Core, detector, alert, recovery, ESP32 or R1A.
