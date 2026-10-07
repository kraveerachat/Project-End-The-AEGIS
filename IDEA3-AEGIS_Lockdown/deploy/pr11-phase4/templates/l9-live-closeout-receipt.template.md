---
title: Task Receipt — IDEA3 L9 LIVE closeout (TEMPLATE)
status: TEMPLATE — NOT A RECEIPT
---

# L9 LIVE closeout receipt template — NOT A RECEIPT

> **NOT A RECEIPT.** This file is a template for the one immutable receipt that is written AFTER an owner-run
> L9 LIVE observation has PASSED. It is not a receipt, it records no execution, and it must never be
> committed under `90-Status/logs` in this form: the gate `p4-l9-gates.py final-closeout` finds the receipt by
> its whole-line `FIELD=VALUE` lines in that directory, so a template placed there would be treated as a claim.
> Never commit this file under 90-Status/logs; copy it to a new, correctly named receipt only after a real PASS.

**Do not hand-write the real receipt.** After a real PASS, run `p4-l9-closeout.py verify-host` and then `derive` on the host: the machine fields below are derived from
the root-owned host closeout `L9-GLOBAL-CLOSEOUT-PASS` (verified against the marker, the single-use claim, the evidence bundle and the terminal result), and
`verify-receipt` refuses any receipt whose fields were not derived that way. Git history alone (`p4-l9-gates.py final-closeout`) can verify uniqueness, immutability
and ancestry after the merge, but it cannot prove the physical host still exists.

Required file name: `YYYY-MM-DD_HHMMSS_music_idea3-l9-live-closeout.md` (the name must end with `_music_idea3-l9-live-closeout.md`).

Rules the gate enforces on the real receipt:

- exactly ONE receipt of the pinned main carries these fields, and no other receipt carries any L9-owned field (the L8 closeout may carry only `L9_LIVE_EXECUTED=NO` and `L9_ATTEMPT_CONSUMED=NO`);
- it is introduced by exactly one commit and never edited afterwards;
- `L9_EXECUTION_MAIN` is a strict ancestor of the pinned main, and the receipt does not exist at it;
- `L8_EXECUTION_MAIN` equals the one the canonical L8 closeout names, evaluated at `L9_EXECUTION_MAIN`;
- `L9_EVIDENCE_BUNDLE_SHA256` is the SHA-256 of `l9-live-evidence.json` recorded in the host closeout `L9-GLOBAL-CLOSEOUT-PASS`.

## Machine fields (whole lines, each exactly once)

- `L9_LIVE=CLOSED_PASS`
- `L9_LIVE_EXECUTED=YES`
- `L9_RESULT=PASS`
- `L9_ATTEMPT_CONSUMED=YES`
- `L9_RERUN_ALLOWED=NO`
- `L9_STAGE=L9`
- `L9_EVIDENCE_CLASS=LIVE_CORE_OBSERVATION`
- `L9_AUTHENTICATED_STATUS_OBSERVED=YES`
- `L9_DEADMAN_ABSENT_OVER_WINDOW=YES`
- `L9_COMMANDS_EMITTED=0`
- `L9_RELAY_ACTUATION=NONE`
- `L9_NEGATIVE_PROBES_INJECTED_LIVE=NO`
- `L9_PRE_POST_PRESERVATION=PASS`
- `L9_SECRET_SCAN=PASS`
- `L9_FAILURE_RESULT=NONE`
- `L9_FINAL_CLOSEOUT_EVIDENCE_COMPLETE=YES`
- `L9_EXECUTION_MAIN=<40-hex main the owner runner executed on>`
- `L8_EXECUTION_MAIN=<40-hex main the canonical L8 closeout names>`
- `L9_EVIDENCE_BUNDLE_SHA256=<64-hex digest of l9-live-evidence.json>`

## Narrative the real receipt must carry honestly

- L9 was a read-only observation of the running Core's own authenticated evidence; it sent nothing, injected nothing and changed nothing.
- Negative probes (replay, wrong key, tamper, stale/future, malformed) were **not** injected live; their coverage is `REPOSITORY_FIXTURE_ONLY`.
- The device-side heartbeat effect has no outward signal; it is evidenced only indirectly by the absence of a DEADMAN status over the window.
- Final project acceptance beyond these facts (for example a physical CUT/RESTORE test) is out of L9's scope and is not claimed.
