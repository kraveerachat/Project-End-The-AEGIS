---
title: Task Receipt — IDEA3 F1i LIVE closeout (repaired immutable release installed)
date: 2026-10-04T21:48:07+07:00
owner: music
area: idea3
branch: docs/idea3-f1i-live-closeout
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 F1i LIVE closeout (repaired immutable release installed)

> [!important] This PR is documentation only (receipt + canonical status). The live F1i attempt itself was run once by the owner under written authorization on 2026-10-04; this task only verified its evidence and recorded it. **F1i is NOT re-run, F1r is NOT executed, F1 is NOT executed, no detector was started, `/opt/aegis-idea3/current` was not switched, the Core was not restarted, no Recovery and no ESP32 action occurred, and this task mutated no Production state.** F1i proves INSTALLATION of one immutable release only.

## Authoritative result fields

The three fields below are the authoritative F1i result (whole lines, each exactly once in this receipt); F1r's receipt gate reads them from the pinned commit.

```text
F1I_LIVE_EXECUTED=YES
F1I_RELEASE_INSTALLED=YES
F1I_RELEASE_ID=c2238375de14678f2a67c039282d9aeff6d553e5
```

Supporting result fields (separate whole lines):

```text
F1I_APPLY=PASS
F1I_VERIFY=PASS
F1I_PRE_POST_COMPARE=PASS
CURRENT_SYMLINK_CHANGED=NO
CORE_RESTARTED=NO
F1_DETECTOR_STARTED=NO
F1R_LIVE_EXECUTED=NO
F1_ATTEMPT_2_PERFORMED=NO
RETRY_PERMITTED=NO
```

## What changed

- **What happened (live, 2026-10-04 21:45 +07, main `9a030ade048b7805961231d50eb1cea12487bff2`):** the frozen F1i runner (SHA-256 `d32101ced549bd8afff34487b7e4126e4e8ac8fb8d5e365ac00d4734cedd8612`, pins: release `c2238375de14678f2a67c039282d9aeff6d553e5`, source SHA `c2238375de14678f2a67c039282d9aeff6d553e5`, `production_detector.py` SHA-256 `a91bcfc228c6e0892d019923b51b33d3545c685e2b5fed229f1ad8f980db9332`, expected current release `55c7d18135142293267e8d1ea943d3639358d634`, operator `kittipat`/1000) ran once with fresh same-day F1i Authorization + K3. Sequence: pre-gates → PRE capture → re-proof → `F1I-ATTEMPT-CONSUMED` (`consumed_at=2026-10-04T14:45:15Z`) → apply once → verify → POST capture → catalog transition proof → comparator → success. The only persistent mutation is the new immutable release `/opt/aegis-idea3/releases/c2238375de14678f2a67c039282d9aeff6d553e5`.
- **Evidence directly verified for this closeout** (not taken from pasted output): `/home/kittipat/Workspace/idea3-p4-evidence/2026-10-04-f1i-20261004-214506` (outside the repository). Exactly one attempt marker exists and it is consumed once; the evidence copies of `authorization-F1i.txt` and `k3-F1i.txt` are byte-equal to the fresh F1i records (`stage=F1i`, 2026-10-04); `F1I_APPLY=COMPLETE` and `F1I_VERIFY=PASS` each appear once in the owner-run log; PRE and POST captures are `L0_CAPTURE=COMPLETE` and `sha256sum -c` over each bundle passes (67 entries each); the comparator reports `FINDINGS_NEW_OR_WORSENED_DRIFT=0`, `FINDINGS_INCOMPARABLE=0`, `PRESERVATION_S10=PASS`, `COMPARE_RESULT=PASS`; no rollback artifacts (no `rb-root`, no ROLLBACK line; journal phase `applied`); secret scan zero hits (the runner's 147 files, and an independent re-run over the 145 readable files).
- **Exactly one release-catalog addition (re-derived independently from the raw PRE/POST `host.tsv`):** PRE had 4 releases, POST has those 4 byte-identical plus exactly `c2238375de14678f2a67c039282d9aeff6d553e5` with tree-state digest `e1915797e5115818a0b252e6a8898f9cc33429f94a00f4e16ed3f945e2b31fc2`, which equals the journaled `release_tree_digest` and the digest of the live installed tree now. Nothing removed, nothing mutated.
- **Installed release verified live (read-only):** real root-owned directory (755 root:root), 54 files, 0 symlinks, release guard PASS root-owned, manifest `release_id` and `source_git_sha` exact, `source_tree_dirty=false`, `production_detector.py` SHA-256 exact (also equal to the reviewed detector at main), contents byte-identical to the staged source, no install-temp residue.
- **Preserved state:** `current` still resolves to `/opt/aegis-idea3/releases/55c7d18135142293267e8d1ea943d3639358d634` (PRE capture, POST capture and live; the link's own mtime is 2026-10-02 21:12, i.e. untouched by this run). Core `aegis-idea3-core.service`: same MainPID 896, NRestarts 0, ExecMainStartTimestamp `2026-10-04 13:14:06 +07` in PRE, POST, journal and live. `core.env` and all credential files: PRE == POST for all 12 captured records (metadata only; no content or digest persisted or read); live metadata unchanged. Detector unit `not-found`/inactive/no unit file and no standalone `production_detector` process. Other preserved services active/running; no serial device open.
- **Comparator reason code (non-blocking note):** the one APPROVED finding is labelled `L6C_RELEASE_INSTALLED`. This is a legacy/shared reason-code constant of the existing relational one-release rule in `p4-compare.sh`, not a stage mismatch: the rule accepts the stage tokens `L6c`, `L7u` and `F1i`; the runner's allowance file for this run declared `stage F1i` and the one release id; the same code was emitted by three earlier L6c and two earlier L7u live comparisons; and the rule is conditional (a removed or mutated existing release, or any unapproved addition, emits `RELEASE_REMOVED` / `RELEASE_CONTENT_DRIFT` / `RELEASE_UNAPPROVED_ADDITION` as drift, none of which occurred). The F1i comparator contract (zero allow-keys, relational catalog rule, `current`/listener/material/Core drift fail) was correctly enforced. Disk free-space changes (3 INFO findings, about 840 KB) are INFO under the existing semantics.
- **Authorization caveat (carried forward honestly):** the K3 is the merged contract's V2 owner self-attestation (`idea1_window_overlap=NONE_KNOWN`), authored on the owner's instruction; it is not an independent IDEA1-owner confirmation. The written owner decision (`Authorize F1i LIVE — one attempt only`) and all pins are recorded in `OWNER-AUTHORIZATION-F1i.txt` in the (owner-private) authorization directory.
- **Boundaries and next steps:** this authorization is consumed; there is no retry under it and the frozen runner is not re-run. F1r (the `current` switch) is a separate stage that now has its F1i predecessor receipt once this PR is merged, but it needs its own owner decision, fresh same-day records and a frozen runner pinned to the then-current main; it is NOT authorized by this receipt. F1 attempt 2, real detector acceptance, Recovery R1-R8, LVR, L8 and L9 remain unproven and unexecuted.

## Source files changed

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new F1i LIVE closeout section (documentation only)
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-10-04_214807_music_idea3-f1i-live-closeout.md` — this receipt (new). No source, test, deploy or runner file changed.

## Verification evidence

- `git fetch origin && git rev-parse origin/main` — pass: `9a030ade048b7805961231d50eb1cea12487bff2` (exact, before creating this receipt).
- Direct evidence checks listed above (attempt marker count and content; `cmp` of authorization/K3 copies; `grep -cx` of apply/verify lines; `sha256sum -c --strict SHA256SUMS` for `pre-root` and `post-root`; absence of `rb-root`; independent catalog diff from raw `host.tsv`; `p4-l7-release-guard.py check --expect-owner root`; `production_detector.py` SHA-256; `p4-l6c-tree-digest.py` on the live release; `readlink /opt/aegis-idea3/current`; `systemctl show` of the Core and detector; metadata `stat` of `core.env`/credentials; independent `l7u_secret_scan`) — pass: every one matched its expected value.
- Key evidence file SHA-256 (outside the repo): `owner-run.log` `cb5a83497d2dcd5cca2325caa7fb58ce29ab3b5c4e41d2ff502f9c92224fcd69`; `compare-pre-post.txt` `aeeef52da889f14af8a8ad8acd4f5423556b1e74d519ef4cccb59f3dee239854`; `f1i-journal.json` `cd1cda7e9e6c39debfe758296979f05c8a65bf47b65f66e8bff262c6de5ba9f6`; `pre-root/SHA256SUMS` `f564bebc297e0062dd7d887831c4d3a33dafdd87f479a06287b9aa9834857278`; `post-root/SHA256SUMS` `0e59eb144a8b6aff5c1d4de91609813ba14321e3f782da57a64cb72aba806ae3`.
- `node scripts/validate-vault.mjs`, the collaboration-policy check and the F1r receipt-gate dry run against this branch's commit — see the PR body for the results.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "IDEA3 F1i LIVE closeout" section; the earlier F1i section is marked as now executed once.

## Shared surfaces touched

- `None` — IDEA3 canonical note and this receipt only.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- This is a closeout of ONE live attempt; it proves the immutable release was installed and preserved everything else, and nothing about activation, the detector or Recovery.
- The tree-state digest of the installed release differs from the staged source's digest only because that digest includes the owner (root versus the operator); contents are byte-identical.
- The credentials directory's individual entries needed root to list; they were verified through the captured metadata records (12 records, PRE == POST), the journal's material snapshot and the unchanged directory metadata, not by this agent listing them directly.
- The L0 IDEA2 baseline in the captures reads `tunnel_healthy=NO_FAILURE_OBSERVED` and `runtime_healthy=NOT_PROVEN` (existing separate verdict semantics; unchanged between PRE and POST).
