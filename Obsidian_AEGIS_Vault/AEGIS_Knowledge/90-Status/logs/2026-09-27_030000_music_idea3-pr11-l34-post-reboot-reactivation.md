---
title: Task Receipt — IDEA3 PR11 Phase 4 L3/L4 post-reboot runtime reactivation (repository implementation)
date: 2026-09-27T03:00:00+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l34-post-reboot-reactivation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L3/L4 post-reboot runtime reactivation (repository implementation)

> [!important] Repository implementation only
> **The reactivation was NOT executed and is NOT authorized.** No rfkill, NetworkManager, systemd, nftables, forwarding, Twingate, Mosquitto or ESP32 state was changed; no L3/L4 `apply.sh`, no L6b, no authorization records. This is `L3_L4_RUNTIME_REACTIVATION` (RUNTIME_ONLY) and it claims no new `L3_LIVE_ACCEPTANCE` or `L4_LIVE_ACCEPTANCE`.

## What changed

- New dedicated handlers `reactivation/l34/{apply,verify,rollback}.sh` with exact allow files: exact-ID rfkill unblock, bounded NetworkManager readiness, one `ifname`-bound activation of the existing `aegis-idea3-ap`, `reset-failed` + `start` of only `aegis-idea3-dnsmasq.service`; every change journaled first; rollback undoes exactly the journal and never recreates the stale `start-limit-hit`.
- Persistent accepted files (profile, dnsmasq config, dnsmasq unit, nft file) are never written; snapshots fail closed on any rewrite; the PSK is never printed or digested.
- New gate library `p4-l34-reactivation-lib.sh` (static config gates including bare dnsmasq directives, fresh L2/PF-01/no-NAT/forwarding proof, one-attempt marker, receipt gate, PSK leak scan).
- New unpinned owner runner template `owner-run/run-l34-reactivation-owner.sh` (refuses to run until frozen).
- **Comparator design gap, resolved narrowly:** `p4-compare.sh` gains the opt-in `ALLOW_DYNAMIC_TRANSITIONS_FILE`, a closed catalog of exact key/before/after transitions (dnsmasq `failed/failed/start-limit-hit` → `active/running/success`, rollback → `inactive/dead/success`, and only the `WIFI` field of the protected `nm.general`). Default behaviour is unchanged.
- Authorization reuses `AEGIS_P4_AUTHORIZATION_V1` + fresh K3 with `stage=L4` and an exact scope line.
- Design, README section and canonical status updated; K12 stays `NOT_PROVEN`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34/apply.sh`, `verify.sh`, `rollback.sh` — handlers (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/reactivation/l34/allow-keys.txt`, `allow-keys-rollback.txt`, `allow-listeners.txt`, `allow-transitions.txt`, `allow-dynamic-transitions.txt`, `allow-dynamic-transitions-rollback.txt` — exact allowances (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — gate library (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-l34-reactivation-owner.sh` — unpinned runner template (new).
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-compare.sh` — opt-in dynamic-transition catalog.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md` — reactivation section.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-post-reboot-reactivation-design.md` — design (new).
- `IDEA3-AEGIS_Lockdown/tests/l34_sim.py`, `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_reactivation.py` — simulator and tests (new).
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new status section.

## Verification evidence

- `pytest tests/test_pr11_phase4_l34_reactivation.py` — pass: all tests passed against the simulated host.
- `pytest tests -k "pr11_phase4 or broker or mqtt"` — pass: 1566 passed, 2 skipped, 0 failed (includes L3/L4, capture/compare/harness and L6b regressions).
- `bash -n` on all new and changed scripts — pass.
- `bash run-l34-reactivation-owner.sh <dir>` on the committed template — pass: refuses with exit 2 (not pinned).
- `git diff --check` — pass.
- `node scripts/validate-vault.mjs` — pass (see PR checks).
- Live reactivation, sudo nft proof, real NetworkManager/rfkill behaviour — not run: repository-only task.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — records the reactivation as implemented in the repository only, not run, not authorized; L3/L4 runtime `NOT_APPLIED`; L2 reproven.

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None — no cross-scope or shared path changed.

## Known limitations

- Nothing was proven on the real host: the simulator models NetworkManager, rfkill, systemd and nft.
- After a failed run, the phy may still report `type AP` after rollback; the rollback proof and PRE→RB comparison would then fail closed and escalate (no `iw set type` is authorized).
- The runner is a template: the owner freeze workflow must pin the merged main SHA and freeze it outside the repository.
- Automatic reboot persistence (K12) is not addressed.
