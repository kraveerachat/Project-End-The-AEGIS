# IDEA3 PR11 Phase 4 — L1 Disk-Threshold Contract Conflict (Owner Decision Required)

Date: 2026-09-21
Owner: Music (Kla reviewing)
Task: Document unresolved disk-threshold authority conflict blocking L1 repository reconciliation
Branch: `docs/idea3-pr11-phase4-l1-threshold-conflict`
Base: `origin/main` (`54ffb0c80b6e6d35821f7c23aefa9a96a003c49e`)
Mode: DOCUMENTATION-ONLY — NO CODE CHANGE, NO LIVE EXECUTION

> [!IMPORTANT]
> This document records a genuine, unresolved conflict between two same-dated
> canonical specs. It does not choose a value, does not modify
> `DISK_THRESHOLD_PCT` in code, and does not authorize L1.

## The conflict

**Source A — `2026-09-21-idea3-pr11-phase4-l1-operational-design.md`, OD-L1-05
("Disk-headroom gate")**:
- States the owner threshold `DISK_THRESHOLD_PCT` default is **90%**
  (headroom >= 10%), status `OWNER_APPROVED`.
- This is the value actually implemented: `stages/L1/apply.sh:30` and
  `p4-l1-packages.py:50` both default to `DISK_THRESHOLD_PCT=90` when the
  environment variable is unset.

**Source B — `2026-09-21-idea3-pr11-phase4-live-readiness-reconciliation.md`,
§1.3.1 and §3**:
- States live-readiness requires **>= 5% free headroom (usage < 95%)** before
  package installation, attributing this requirement to "OD-L1-07."
- This citation is itself incorrect: in the operational-design spec,
  OD-L1-07 is "Listener and unit preservation," not the disk-headroom gate
  (that is OD-L1-05). No line in the reconciliation doc states that the 95%
  figure supersedes OD-L1-05's approved 90% default.

Both documents carry the same date (2026-09-21) and neither explicitly marks
the other's numeric threshold as superseded. `idea3-status.md` (lines ~6708-6709,
6836-6837) records the discrepancy as open
(`L1_DISK_THRESHOLD_RECONCILIATION_REQUIRED = YES`) without resolving it.

## Why repository authority is insufficient to resolve this alone

- OD-L1-05 carries an explicit `OWNER_STATUS: OWNER_APPROVED` for the 90%
  default — an existing owner approval record.
- The reconciliation doc's 95%/5%-headroom figure is asserted under a
  mis-cited gate ID and does not reference or explicitly override OD-L1-05.
- Changing the implemented default from 90% to 95%-usage-equivalent (or
  vice versa) without owner confirmation would either (a) silently widen an
  owner-approved safety margin, or (b) silently discard a newer live-readiness
  constraint — both are architecture-adjacent decisions this campaign is not
  authorized to make unilaterally.

## Determination

```text
AUTHORITY_RESOLVED                = NO
OWNER_DECISION_REQUIRED           = YES
L1_DISK_THRESHOLD_RECONCILIATION_REQUIRED = YES (unchanged from prior status)
CODE_CHANGE_MADE                  = NO
LIVE_EXECUTION_PERFORMED          = NO
```

## Minimum owner decision needed

1. Confirm which numeric contract is canonical for `DISK_THRESHOLD_PCT` going
   into L1 live execution: the existing owner-approved 90% (OD-L1-05), the
   95%-usage/5%-headroom figure cited in the reconciliation doc, or a new
   explicit value.
2. If the reconciliation doc's citation of "OD-L1-07" was a typo for
   "OD-L1-05," confirm that correction, and confirm whether the reconciliation
   doc's 95% figure is intended to amend OD-L1-05's default or only to
   describe a stricter live-readiness precondition layered on top of it.

Once the owner records this decision, repository reconciliation (test
coverage plus the `DISK_THRESHOLD_PCT` default/contract update) can proceed
in a follow-on branch.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
