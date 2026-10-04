---
title: Task Receipt — IDEA3 F1r LIVE closeout (current switched to the repaired release; pointer only)
date: 2026-10-04T22:29:50+07:00
owner: music
area: idea3
branch: docs/idea3-f1r-live-closeout
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 F1r LIVE closeout (current switched to the repaired release; pointer only)

> [!important] This PR is documentation only (receipt + canonical status). The live F1r attempt itself was run once by the owner under written authorization on 2026-10-04; this task only verified its evidence and recorded it. **F1r LIVE did mutate Production by changing ONLY the `/opt/aegis-idea3/current` symlink.** It did NOT install or delete a release, did NOT restart the Core, did NOT move the already-running Core process to the NEW release, did NOT start the detector, did NOT execute F1 attempt 2, did NOT run Recovery and did NOT touch the ESP32. This closeout PR performs no additional Production mutation. F1r proves POINTER ACTIVATION only.

## Authoritative result fields

The two fields below are the authoritative F1r result (whole lines, each exactly once in this receipt); the F1 receipt gate reads them from the pinned commit.

```text
F1R_LIVE_EXECUTED=YES
F1R_CURRENT_SWITCHED=YES
```

Supporting result fields (separate whole lines):

```text
F1R_APPLY=PASS
F1R_VERIFY=PASS
F1R_PRE_POST_COMPARE=PASS
PRESERVATION_S10=PASS
CURRENT_OLD_RELEASE_ID=55c7d18135142293267e8d1ea943d3639358d634
CURRENT_NEW_RELEASE_ID=c2238375de14678f2a67c039282d9aeff6d553e5
CORE_RESTARTED=NO
CORE_MOVED_TO_NEW_RELEASE=NO
F1_DETECTOR_STARTED=NO
F1_ATTEMPT_2_PERFORMED=NO
ROLLBACK_EXECUTED=NO
RETRY_PERMITTED=NO
```

## What changed

- **What happened (live, 2026-10-04 22:27 +07, main `139c7285c509b9bd40dcc5eeaa8ce98f22ce794a`):** the frozen F1r runner (SHA-256 `98b40a1fb30ee73661b22c8da61a8a120432235ecc4acbed6d6b68a108593acf`, pins: OLD release `55c7d18135142293267e8d1ea943d3639358d634`, NEW release and source SHA `c2238375de14678f2a67c039282d9aeff6d553e5`, `production_detector.py` SHA-256 `a91bcfc228c6e0892d019923b51b33d3545c685e2b5fed229f1ad8f980db9332`, operator `kittipat`/1000) ran once with fresh same-day F1r Authorization + K3. Sequence: pre-gates → PRE capture → re-proof → `F1R-ATTEMPT-CONSUMED` (`consumed_at=2026-10-04T15:27:12Z`) → apply once (journal OLD, temp symlink + atomic rename) → verify → exact current-transition proof → POST capture → comparator → secret scan → success. The only persistent mutation is the `current` symlink.
- **Evidence directly verified for this closeout** (not taken from pasted output): `/home/kittipat/Workspace/idea3-p4-evidence/2026-10-04-f1r-20261004-222707` (outside the repository). Exactly one `F1R-ATTEMPT-CONSUMED` marker exists under the owner-run tree; the evidence copies of `authorization-F1r.txt` and `k3-F1r.txt` are byte-equal to the fresh F1r records (`stage=F1r`, 2026-10-04); `F1R_APPLY=COMPLETE` and `F1R_VERIFY=PASS` each appear once in the owner-run log; PRE and POST captures are `L0_CAPTURE=COMPLETE` and `sha256sum -c` over each bundle passes (67 entries each, 0 mismatches); the comparator reports `FINDINGS_NEW_OR_WORSENED_DRIFT=0`, `FINDINGS_INCOMPARABLE=0`, `FINDINGS_APPROVED_CHANGE=1`, `PRESERVATION_S10=PASS`, `COMPARE_RESULT=PASS`; no rollback artifacts (no `rb-root`, no rollback line in the log; journal `phase=switched`); runner secret scan 145 files, 0 hits, and an independent pattern grep over the readable evidence files also found 0.
- **Current transition re-derived from the raw captures:** key `host.symlink./opt/aegis-idea3/current.target` is exactly `/opt/aegis-idea3/releases/55c7d18135142293267e8d1ea943d3639358d634` in PRE `host.tsv` and exactly `/opt/aegis-idea3/releases/c2238375de14678f2a67c039282d9aeff6d553e5` in POST `host.tsv`. The comparator approved exactly that one key (`APPROVED_CHANGE KEY_APPROVED`). A line diff of the two `host.tsv` files shows only that key plus the three disk free-space lines (about 8 KB, INFO under the existing semantics).
- **No release-catalog change:** the PRE and POST `host.tsv` release records are identical (no addition, removal or mutation). The live `releases` directory holds the same five release ids as before.
- **NEW release remains valid (live, read-only):** release guard PASS root-owned; `release_id` and `source_git_sha` exact `c2238375de14678f2a67c039282d9aeff6d553e5`; `production_detector.py` SHA-256 `a91bcfc2…db9332`; tree-state digest `e1915797e5115818a0b252e6a8898f9cc33429f94a00f4e16ed3f945e2b31fc2` (equal to the F1i-recorded digest).
- **Core:** `aegis-idea3-core.service` is the same process in PRE, POST and live: active/running, MainPID `896`, NRestarts `0`, ExecMainStartTimestamp `2026-10-04 13:14:06 +07`. The journal recorded the Core working directory as the OLD release and the runner's verify (run as root) reported `CORE_CWD=UNCHANGED`, `CORE_MAIN_PID_UNCHANGED=YES`, `CORE_N_RESTARTS_UNCHANGED=YES`, `CORE_MOVED_TO_NEW_RELEASE=NO`. This agent could not independently read `/proc/896/cwd` (root-only; sudo needs the owner's password), so the cwd claim rests on the runner's root-run verification. The running Core is NOT claimed to run the NEW release; it keeps its old working directory until a separately authorized restart.
- **Detector:** unit `not-found`/inactive with no unit file, no standalone `production_detector` process now, and the runner's verify reported `DETECTOR_PRESENT=NO`. The detector was never started.
- **Preserved state:** `services`, `listeners`, `firewall`, `idea2`, `mqtt`, `network`, `wifi` and `capabilities` PRE/POST records are byte-identical. Live `current` still resolves exactly to the NEW release (the link's own mtime is 2026-10-04 22:27:12 +07, i.e. this run); no `.current.f1r-tmp` residue.
- **Authorization caveat (carried forward honestly):** the K3 is the merged contract's V2 owner self-attestation (`idea1_window_overlap=NONE_KNOWN`), authored on the owner's instruction; it is not an independent IDEA1-owner confirmation. The written owner decision (`Authorize F1r LIVE — one attempt only`) and all pins are recorded in `OWNER-AUTHORIZATION-F1r.txt` in the (owner-private) authorization directory.
- **Boundaries and next steps:** this authorization is consumed; there is no retry under it and the frozen runner is not re-run. F1 attempt 2 (which starts the production detector from the NEW release) has its F1r predecessor receipt once this PR is merged, but it needs its own owner decision, fresh same-day records and a frozen runner pinned to the then-current main; it is NOT authorized by this receipt. The Core restart needed for the running Core to use the NEW release, real detector acceptance, Recovery R1-R8, LVR, L8 and L9 remain unproven and unexecuted.

## Source files changed

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new F1r LIVE closeout section (documentation only)
- This receipt (new). No source, test, deploy or runner file changed.

## Verification evidence

- `git fetch origin && git rev-parse origin/main` — pass: `139c7285c509b9bd40dcc5eeaa8ce98f22ce794a` (exact, before creating this receipt).
- Direct evidence checks listed above (attempt marker count and content; `cmp` of authorization/K3 copies; `grep -cx` of apply/verify lines; `sha256sum -c SHA256SUMS` for `pre-root` and `post-root`; absence of `rb-root`; raw `host.tsv` diff; `p4-l7-release-guard.py check --expect-owner root`; `production_detector.py` SHA-256; `p4-l6c-tree-digest.py` on the live release; `readlink /opt/aegis-idea3/current`; `systemctl show` of the Core; detector unit and process checks) — pass: every one matched its expected value.
- Key evidence file SHA-256 (outside the repo): `owner-run.log` `63f7476c5a170c2d6957a4e3e5305b7f7bfcfd31beedf78ab43f4be1671381a8`; `compare-pre-post.txt` `a7ca0d973c1f942c62fa4f67f29a0de6ee11967d8b5dc8239fe1083c2b93f343`; `f1r-journal.json` `2b3ea8bff54d4c219f3ed160d8056e2a20b6c5061f5f6906f7c0d1729b3fa168`; `pre-root/SHA256SUMS` `aeaca8ead7e71db91a616ac96dca6dafa8f04ca2745cdd67fc26ec4be3466fa2`; `post-root/SHA256SUMS` `f4e573cb38c4c334ebc25916f0c2660f2692830f24ec2b471ea162b6caeef1c2`.
- `node scripts/validate-vault.mjs`, the collaboration-policy check and the F1 receipt-gate dry runs against this branch's commit — see the PR body for the results.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new "IDEA3 F1r LIVE closeout" section.

## Shared surfaces touched

- `None` — IDEA3 canonical note and this receipt only.

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- This is a closeout of ONE live attempt; it proves the `current` pointer was switched atomically and everything else was preserved, and nothing about the running Core's release, the detector or Recovery.
- The Core working directory was verified by the runner's root-run check, not independently by this agent (see the Core bullet).
- The L0 IDEA2 baseline in the captures reads `tunnel_healthy=NO_FAILURE_OBSERVED` and `runtime_healthy=NOT_PROVEN` (existing separate verdict semantics; unchanged between PRE and POST).
