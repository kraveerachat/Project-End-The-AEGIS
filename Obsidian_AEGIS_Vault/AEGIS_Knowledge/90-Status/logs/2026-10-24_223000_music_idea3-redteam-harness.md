---
title: Task Receipt — IDEA3 lab red-team harness (write-only, not run)
date: 2026-10-24T22:30:00+07:00
owner: music
area: idea3
branch: feat/idea3-graduated-response
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 lab red-team harness

## What changed

- Wrote (did not run) a lab red-team harness for the graduated response under `~/aegis-live-run/review/redteam/`
  (review-only) with a matching copy of the committable scripts under
  `IDEA3-AEGIS_Lockdown/deploy/live-lab/redteam/`.
- `attacker-ns-up.sh` / `attacker-ns-down.sh`: create/remove a Linux network namespace `aegis-att` (veth
  `aegis-att-h`/`aegis-att-n`, addressing `10.90.90.0/30`) reachable only to `10.77.30.1` (the Core); the up
  script proves `10.77.30.10` (ESP32) and the Internet are unreachable before it will finish, and rolls back on
  any failure. No attack tooling in either script.
- `collect-evidence.sh`: read-only snapshot of the defender side (Core events, journal, projections, the
  containment block list read-only) plus attacker-side files you saved by hand, into
  `~/aegis-live-run/evidence/redteam/<scenario>-<UTC>/`, with a decision timeline and a secret-pattern self-check.
- `capture-owner-reported.sh`: read-only archival of already-existing evidence for doc 21 rows marked
  "owner-reported"; **run once this session** (strictly read-only, writes only under `evidence/`): captured
  `fz-01-a1-deadman`, `rc-01-stale-restore-record`, `rc-04-g6-restore-pending`, `op-02-restore-with-evidence`;
  11 rows reported "no archived source found" (report at `evidence/redteam-capture-report.txt`).
- `PATCH_PROPOSAL-with-attacker-veth.md`: `setup-graduated.sh` has no `--with-attacker-veth` flag; a minimal
  unified-diff proposal is written, **not applied**, pending owner review.
- `design-G3-critical.md`: analysis only, comparing two safe ways to produce `ssh_login_after_failures` for a
  CRITICAL decision; **nothing built**, pending owner approval of one option.
- `README.md` (review-only): session order, tool checklist, and the exact `nmap`/`hydra`/`hping3` commands for
  G1/G2a/G2b/G2c as copy-paste text for the owner to run by hand — no runnable attacker script was authored.

## Source files changed

- New: `IDEA3-AEGIS_Lockdown/deploy/live-lab/redteam/{attacker-ns-up.sh,attacker-ns-down.sh,collect-evidence.sh,capture-owner-reported.sh,PATCH_PROPOSAL-with-attacker-veth.md}`.
- New (review-only, not committed): `~/aegis-live-run/review/redteam/{README.md,design-G3-critical.md,summary.md}` plus a copy of the five files above.
- New (from running `capture-owner-reported.sh`): `~/aegis-live-run/evidence/{fz-01-a1-deadman,rc-01-stale-restore-record,rc-04-g6-restore-pending,op-02-restore-with-evidence}/`, `~/aegis-live-run/evidence/redteam-capture-report.txt`.

## Verification evidence

- `bash -n` on all four shell scripts; the embedded Python in `collect-evidence.sh` parsed with `ast.parse`.
- `capture-owner-reported.sh` was run (read-only; see above) and its own secret-pattern self-check passed.
- The namespace scripts, the evidence collector and the live attack commands were **not run**.

## Canonical notes updated

- None yet; the open decisions below (the veth patch, the G3 option) need your review first.

## Shared surfaces touched

- None — task stayed inside its selected area.

## Integration requests

- None.

## Known limitations

- The attacker is co-located (same laptop, a veth, not the AP radio); see the README's "one honest limitation".
- G1 and G2b (and the scan half of G2a/G2c) need `--with-attacker-veth` or the proposed patch before the Core's
  log rule can see them at all; this is recorded in the patch proposal.
- G3 (CRITICAL) has no implementation yet, by design, pending your choice in `design-G3-critical.md`.
- 11 doc-21 rows have no archived source anywhere on disk and stay "owner-reported" (listed in the capture report).
