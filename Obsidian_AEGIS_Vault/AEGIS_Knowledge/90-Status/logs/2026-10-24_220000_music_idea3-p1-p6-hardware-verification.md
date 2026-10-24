---
title: Task Receipt — IDEA3 P1-P6 hardware verification record
date: 2026-10-24T22:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-graduated-response
status: done
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 P1-P6 hardware verification record

## What changed

- Recorded the operator's hardware verification of 2026-10-24 (Core and Desktop restarted on the P1-P6 code): the recovery view, Thai wording, the Recovery, Incidents and Audit pages, RESTORE without a CUT after a Core restart, and the A2 repeat (OFFLINE and uplink UNKNOWN after 38.40 s, LOCKDOWN (BOOT) after replug, one RESTORE accepted).
- F-A1-1 (fix `16b7565`) and F-A2-1 (fix `09005c6`) are marked verified on the hardware; matrix rows RC-03, RC-08, RC-09, RC-10, PL-01 and PL-06 are PASS (owner-reported, output not archived).

## Source files changed

- None. Documentation only: `doc/Content/19_FAILURE_MODE_TESTS.md`, `doc/Content/21_TEST_EVIDENCE_MATRIX.md`, `idea3/idea3-status.md`.

## Verification evidence

- Operator report in the session; no terminal output archived.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`.

## Shared surfaces touched

- None — task stayed inside its selected area.

## Integration requests

- None.

## Known limitations

- Not repeated on the hardware: the 60 s Desktop STALE threshold with a frozen Core (A1 repeat), the 8 s expiry of an ACKed-but-unconfirmed RESTORE record, and the Chinese wording.
- Archive the operator outputs next to the lab evidence.
