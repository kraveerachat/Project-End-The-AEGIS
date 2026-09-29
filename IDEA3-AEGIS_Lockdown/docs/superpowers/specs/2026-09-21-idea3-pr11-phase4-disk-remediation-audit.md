# IDEA3 PR11 Phase 4 — Host Disk Remediation Audit (Read-Only)

Date: 2026-09-21
Owner: Music
Task: Read-only inventory of disk-reclaim candidates on the Core-adjacent dev host
Branch: `docs/idea3-pr11-phase4-disk-audit`
Base: `origin/main` (`54ffb0c80b6e6d35821f7c23aefa9a96a003c49e`)
Mode: READ-ONLY — no deletion, no package management, no journal vacuum performed

> [!IMPORTANT]
> This audit inventories candidates only. Nothing was deleted, pruned, or
> vacuumed. `DISK_CURRENT_STATE = BLOCKING_L1` is unchanged; owner action is
> still required.

## Observed state

```text
root filesystem (/, nvme1n1p6): 59G total, 54G used, 2.3G avail, 96% used
```

Consistent with the prior Official L0 baseline (`root.use_pct = 96`).

## Candidate table

| Candidate | Path/Owner | Est. reclaim | Safety | Reversibility | Owned by | Owner auth needed |
|---|---|---|---|---|---|---|
| pip cache | `~/.cache/pip` | 3.1G | High | Yes (repopulates on next install) | user | Yes — any deletion on this host requires explicit owner authorization |
| pacman package cache | `/var/cache/pacman/pkg` | 2.9G | Medium (`paccache -r` keeps recent versions) | Yes | system | Yes — package management is out of scope for this campaign, and deletion requires explicit owner authorization |
| codex-runtimes cache | `~/.cache/codex-runtimes` | 1.8G | High | Yes | user | Yes — any deletion on this host requires explicit owner authorization |
| stacked git worktrees for merged branches | `Projects/Project-End-The-AEGIS-{P4L*,PR10,PR11,D4,P2RUNTIME,P3*,PYUX,RUNTIME}` | ~1.6G | Medium | Yes (`git worktree remove`, if branch is confirmed merged) | user | Yes — confirm each branch is actually merged, and removal requires explicit owner authorization |
| systemd journal | archived+active journals | 1G | Low (destroys log history) | Partial | system | Yes — journal vacuum is explicitly out of scope for this campaign |
| yay cache | `~/.cache/yay` | 546M | High | Yes | user | Yes — any deletion on this host requires explicit owner authorization |
| Brave browser cache | `~/.cache/BraveSoftware` | 683M | High | Yes | user | Yes — any deletion on this host requires explicit owner authorization |
| Puppeteer cache | `~/.cache/puppeteer` | 652M | Medium (re-downloads browser binaries on next use) | Yes | user | Yes — any deletion on this host requires explicit owner authorization |

## Assessment

This audit identifies candidates only; it does not authorize or perform any
deletion. Every row above requires explicit owner authorization before any
actual cleanup is executed on the host — including the user-cache rows,
which are technically reversible but still require the owner to approve and
run the deletion themselves (or explicitly authorize this campaign to do so
in a follow-on task).

The five cache candidates (pip, codex-runtimes, yay, Brave, Puppeteer) sum to
an **estimated** ~6.7G. This is an estimate only, derived from `du -sh` at
audit time; it is not a proven post-cleanup outcome. No projected post-cleanup
usage percentage is claimed here. If the owner authorizes and executes any
cleanup, a fresh `df -h /` reading must be captured afterward as the actual
evidence of reclaimed space and resulting usage percentage.

No cleanup was performed. This campaign is documentation-only for this
workstream.

```text
DISK_BLOCKER          = BLOCKING_L1 (unchanged)
CLEANUP_PERFORMED     = NO
CANDIDATES_IDENTIFIED = YES (read-only inventory; all require owner authorization to execute)
OWNER_ACTION_REQUIRED = YES (authorize and execute cleanup; this doc only inventories candidates)
POST_CLEANUP_DF       = NOT_YET_CAPTURED (required after any authorized cleanup, before relying on a new usage figure)
```

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
