# IDEA3 PR11 Phase 4 — L1 Live Backend Owner Decision (Approved 2026-09-22)

Date: 2026-09-22
Owner: Music (decision approved 2026-09-22)
Task: Durably record the owner's disk-threshold, package-manager, and
rollback decisions before repository implementation of the L1 live backend.
Branch: `feat/idea3-pr11-phase4-l1-live-backend`
Base: `origin/main` (`c88cd04b3c171be72701982373f9062797b27cc8`)
Mode: DOCUMENTATION + REPOSITORY-ONLY — no Production mutation

> [!IMPORTANT]
> This decision resolves the disk-threshold conflict recorded in PR #174
> (`2026-09-21-idea3-pr11-phase4-l1-disk-threshold-conflict.md`) for
> repository implementation purposes. It does not authorize Production
> mutation, live L1 execution, K3, or A-L1.

## Resolved decisions

### D1 — Disk threshold contract (resolves PR #174)
- `DISK_THRESHOLD_PCT` canonical value = **90**.
- PASS only when usage is strictly below 90% (headroom > 10%).
- Usage >= 90% = fail closed.
- The prior reconciliation doc's `<95%`/`>=5%`-headroom figure is
  **superseded as the numeric L1 threshold**; it does not apply to
  `DISK_THRESHOLD_PCT`.
- That figure's citation of "OD-L1-07" was a typo — the disk-headroom gate
  is OD-L1-05 (operational design spec), not OD-L1-07 (listener/unit
  preservation).
- Reason: preserve the existing owner-approved stricter safety margin
  already recorded as `OWNER_STATUS: OWNER_APPROVED` on OD-L1-05.

### D2 — Live package-manager contract
- Package manager = **pacman only**. No yay/paru/apt/dnf.
- Stage-owned target package = **chrony only**.
- Sync database refresh is **forbidden** in-stage (`-Sy` implicitly and
  explicitly forbidden).
- System-upgrade flags `-Syu`, `-Su`, `-Sy` are **forbidden**.
- A non-mutating transaction preflight is **required** before any real
  install action.
- The preflight-accepted transaction package set must be **exactly**
  `{"chrony"}`. Any additional/unexpected/dependency package in the
  transaction fails closed.
- The real install action may run **only after** exact preflight
  acceptance.
- Service start/enable is **forbidden**.
- Any new listener is **forbidden**.
- Live execution requires an owner-supervised window (separate from this
  repository-implementation approval).

### D3 — Rollback contract
- Live rollback removes **chrony only**.
- `pacman -Rns` is **forbidden** — recursive dependency removal could
  remove packages that predate this stage.
- Cascade/recursive removal flags (`-Rs`, `-Rc`, `--recursive`,
  `--cascade`) are forbidden.
- If pacman refuses removal because another package depends on chrony,
  the rollback **fails closed**; it must not escalate to recursive/cascade
  removal.
- Rollback must preserve all packages that existed before the chrony
  install, and pre/post-rollback state comparison is required.

## What remains unauthorized

```text
PRODUCTION_MUTATION_AUTHORIZED = NO
LIVE_L1_AUTHORIZED             = NO
A_L1                           = NOT_ISSUED
K3                             = NOT_ISSUED
DISK_CURRENT_STATE             = still BLOCKING_L1 pending authorized cleanup + fresh <90% proof
IDEA2_S10                      = still BLOCKING (see PR #176)
```

This document authorizes repository code changes implementing D1-D3 above.
It does not authorize running that code against the real host, issuing K3
or A-L1, or performing any Production mutation.

## Supersession note

- `2026-09-21-idea3-pr11-phase4-l1-disk-threshold-conflict.md` (PR #174) is
  preserved as historical record of the conflict; its
  `AUTHORITY_RESOLVED = NO` / `OWNER_DECISION_REQUIRED = YES` status is now
  superseded by this document's D1 decision for repository implementation
  purposes. The original document is not rewritten.
- `idea3-status.md`'s `L1_DISK_THRESHOLD_RECONCILIATION_REQUIRED = YES` line
  should be treated as resolved by this decision going forward; status
  reconciliation is expected in a subsequent status-only update, not in
  this implementation PR.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
