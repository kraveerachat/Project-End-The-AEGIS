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
| pip cache | `~/.cache/pip` | 3.1G | High | Yes (repopulates on next install) | user | No |
| pacman package cache | `/var/cache/pacman/pkg` | 2.9G | Medium (`paccache -r` keeps recent versions) | Yes | system | Yes — package management is out of scope for this campaign |
| codex-runtimes cache | `~/.cache/codex-runtimes` | 1.8G | High | Yes | user | No |
| stacked git worktrees for merged branches | `Projects/Project-End-The-AEGIS-{P4L*,PR10,PR11,D4,P2RUNTIME,P3*,PYUX,RUNTIME}` | ~1.6G | Medium | Yes (`git worktree remove`, if branch is confirmed merged) | user | Yes — confirm each branch is actually merged before removal |
| systemd journal | archived+active journals | 1G | Low (destroys log history) | Partial | system | Yes — journal vacuum is explicitly out of scope for this campaign |
| yay cache | `~/.cache/yay` | 546M | High | Yes | user | No |
| Brave browser cache | `~/.cache/BraveSoftware` | 683M | High | Yes | user | No |
| Puppeteer cache | `~/.cache/puppeteer` | 652M | Medium (re-downloads browser binaries on next use) | Yes | user | No |

## Assessment

The five safest, no-owner-auth candidates (pip, codex-runtimes, yay, Brave,
Puppeteer caches) sum to roughly **6.7G**, which alone would move root usage
from 96% to roughly the mid-80s if reclaimed — comfortably past both the
90%-usage and 95%-usage thresholds under discussion in the parallel
[disk-threshold conflict doc](2026-09-21-idea3-pr11-phase4-l1-disk-threshold-conflict.md).

No cleanup was performed. This campaign is documentation-only for this
workstream; deletion requires explicit owner execution (or an owner-authorized
follow-on task).

```text
DISK_BLOCKER          = BLOCKING_L1 (unchanged)
CLEANUP_PERFORMED     = NO
SAFE_CANDIDATES_FOUND = YES
OWNER_ACTION_REQUIRED = YES (execute cleanup; this doc only inventories it)
```

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
