---
title: Task Receipt — IDEA3 PR11 Phase 4 L7 live preparation (owner-runner readiness audit, remediation, main reconciliation, release-install gap closure)
date: 2026-09-27T16:26:37+07:00
owner: music
area: idea3
branch: feat/idea3-pr11-l7-live-preparation
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L7 live preparation (owner-runner readiness audit, remediation, main reconciliation, release-install gap closure)

> [!important] Repository preparation only — this is the single consolidated receipt for this PR's first submission
> **L7 was NOT executed and NOT authorized. No Production mutation, no sudo, no host `systemctl`, no A-L7/K3/D6 or Production secret created, no L8, no ESP32.** `L7_LIVE_EXECUTED = NO`, `L7_LIVE_AUTHORIZED = NO`, `L7_LIVE_ACCEPTANCE = NOT PROVEN`, `L8_STARTED = NO`.
> This branch accumulated two internal work sessions before its first PR: (1) the owner-runner readiness audit and remediation, at base main `1328f66cb126531a77a627a761df697a1d902c87`; (2) main reconciliation after PR #208 merged, plus release-install gap closure, at base main `653249822cf194bc0bd15f56ac0b96ac3a492f35`. Since the branch was never pushed or opened as a PR before now, both sessions are recorded in this one receipt rather than as two separate ones, per the repository's one-receipt-per-PR rule; nothing here is a rewrite of reviewed or merged history.

## What changed

Two sessions, detailed below: (1) an owner-runner readiness audit and remediation of the merged L7 handlers; (2) main reconciliation after PR #208 merged, plus closing the release-install gap.

### Session 1 — audit result: the merged L7 handlers were NOT sufficient for a safe live L7

Read-only host facts used (no mutation): no `/opt/aegis-idea3`, no L7 credentials/core.env/unit; `aegis-idea3` account present (uid 952, gid 950); `/etc/aegis-idea3/pki` present (`root:aegis-idea3 0750`); L6b broker persistent.

Gaps found (each fixed, RED-first): (1) credentials dir `root:root 0700` vs D4 credential owned by the Core account — the service could not read it; (2) 3-line `core.env` without broker address, device id, CA path or TLS server name; (3) the Core cannot verify the DNS-only broker certificate when connecting to the AP IP ("IP address mismatch", reproduced on a throwaway broker); (4) the Core CA copy under `pki/` did not exist and the L6b CA is unreadable by the Core account; (5) no release existence or provenance proof, dangling `current` possible; (6) no unit verification, no `enable`, no stability proof; (7) rollback defaulted a missing prestate to "did not exist" and could delete pre-existing files, used `rm -rf`, never disabled/cleared failed unit state (PRE→RB drift, the L6b lesson); (8) rollback would leave `/var/lib` and `/var/log/aegis-idea3` created by systemd (PRE→RB drift); (9) verify's listener check was a no-op and it proved no status, environment, LoadCredential, connection or journal property; (10) the previous negative tests were vacuous (fixture root never set, "forbidden" key not forbidden); (11) no owner-run path existed. Details: design §7.

- Rewrote `stages/L7/apply.sh`, `verify.sh`, `rollback.sh` to the L6b standard (journal-before-create, exact ownership plan, exact clean prestate, verified unit, `enable --now`, journal-driven rollback with `reset-failed <Core unit only>` and a proven `not-found/inactive/dead/success` end state, archive-then-remove of stage-caused runtime dirs). Ownership: credentials dir `root:aegis-idea3 0750`; four LoadCredential secrets `root:root 0600`; `restore.credential` `aegis-idea3:aegis-idea3 0600`; `core.env` `root:aegis-idea3 0640`; CA copy and unit `root:root 0644`.
- New tools: `p4-l7-release-guard.py`, `p4-l7-core-env.py`, `p4-l7-broker-probe.py`, `p4-l7-run-lib.sh`, unpinned `owner-run/run-l7-owner.sh`.
- Core change: `AEGIS_MQTT_TLS_SERVER_NAME` (verification stays fully on).
- `allow-keys.txt` +2 keys (pki CA copy); `allow-listeners.txt` still empty.
- Frozen-runner contract: unpinned (`PIN_MAIN_SHA`, `PIN_RELEASE_ID`), refuses to run, frozen outside the repository; normal user only; one attempt per authorization (`L7-ATTEMPT-CONSUMED`); all read-only gates before consumption; PRE capture → apply once → verify → POST capture → strict PRE→POST with the exact L7 allow files → secret scan → S10 preservation → persistent closeout; any failure after the first mutation → one bounded rollback → RB capture → zero-drift PRE→RB (no allow files); exit 3 (S-11 HOLD) if rollback or that proof fails; no automatic retry; never creates a secret, installs the release, starts L8, touches an ESP32, sends a relay command, repairs a predecessor or modifies IDEA1/IDEA2.

### Session 2 — main reconciliation after PR #208 merged; release-install gap closed

1. **Main reconciliation.** Merged current `main` (`653249822cf194bc0bd15f56ac0b96ac3a492f35`, now including PR #208 merged) into this branch with a normal merge commit (not a rewrite of session 1's history). One conflict, in `deploy/pr11-phase4/README.md`: pure insertion-adjacency between this branch's "L7 live preparation" section and PR #208's "L7 release builder / verifier" section, no contested wording; resolved by keeping both sections and correcting stale "open PR #208" language to "merged". `idea3-status.md` auto-merged with no conflict markers. All L6b closeout history is unchanged; no historical receipt was edited.
2. **Release-install gap re-audited.** Searched the repository (scripts, docs, tests, owner-run tooling) for any existing safe installer of a built release into `/opt/aegis-idea3/releases/<id>`. None exists. Confirmed `stages/L7/apply.sh` already owns the `/opt/aegis-idea3/current` symlink exclusively (creates it only if absent, refuses to move it) — so any installer must never touch it.
3. **Implemented `deploy/pr11-phase4/p4-l7-install-release.py`** (RED-first: 22 failed / 6 passed before implementation, 28 passed after): copies a completed `p4-l7-build-release.py` output into `/opt/aegis-idea3/releases/<id>`. Re-validates the source with the real, imported `p4-l7-release-guard.py` (never a copied predicate) before any mutation, stages through a sibling `.install-tmp-<id>-<random>` directory, re-validates the staged copy with the same guard, and places it with one atomic `os.rename`. Refuses to overwrite an existing release, refuses a symlinked destination or ancestor, fails closed with no retry, cleans only its own temp staging on failure, never later removes an already-placed release, never touches `current`, and never names or reads a credential file. Optional `--evidence` records only `release_id`, `source_git_sha` and the logical path.
4. **Governance gap documented, not invented.** `p4-lib.sh`'s fixed stage set and `p4-stage-gate.sh`'s authorization/K3 records define no stage id or field for a pre-L7 release-install mutation. Per instruction, this was documented as an open owner decision (new G-15 stage vs. an `A-L7` extra field) rather than inventing one; **no owner-run wrapper was created** for the installer.
5. Documentation updated: `README.md` (new "L7 release installer" section + governance-gap note), the L7 operational design (new §8), and `idea3-status.md` (new dated section; all historical sections are unedited).

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L7/apply.sh`, `verify.sh`, `rollback.sh`, `allow-keys.txt` — reconciled L7 handlers.
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-l7-release-guard.py`, `p4-l7-core-env.py`, `p4-l7-broker-probe.py`, `p4-l7-run-lib.sh`, `p4-l7-install-release.py`, `owner-run/run-l7-owner.sh` — new tools.
- `IDEA3-AEGIS_Lockdown/aegis_soc/config.py`, `aegis_soc/mqtt_client.py`, `aegis_soc/runtime.py`, `deploy/aegis-idea3-core.env.example` — TLS server name.
- `IDEA3-AEGIS_Lockdown/tests/l7_support.py`, `test_pr11_phase4_l7_handler.py` (rewritten), `test_pr11_phase4_l7_runner.py`, `test_pr11_phase4_l7_runner_flow.py`, `test_pr11_phase4_l7_release_guard_helper.py`, `test_pr11_phase4_l7_core_env_helper.py`, `test_mqtt_tls_server_name.py`, `test_pr11_phase4_l7_release_installer_helper.py` — tests.
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-21-idea3-pr11-phase4-l7-operational-design.md`, `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`, `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — documentation.
- Brought in unmodified by the main merge: PR #208's `p4-l7-build-release.py`, `test_pr11_phase4_l7_release_builder.py`, and its receipt; all L3/L4/L5/L6b history since session 1.

## Verification evidence

- `pytest` RED-first (before implementation, per stage) — fail: session 1 — TLS server name 14 failed / 1 passed; release guard 41 failed / 1 passed; core.env tool 31 failed / 20 passed; L7 handler 177 failed / 19 passed; runner/lib 98 failed / 6 passed; session 2 — release installer 22 failed / 6 passed.
- `pytest` — all new/rewritten L7 focused suites combined (handler, runner, runner_flow, release_guard, core_env, TLS server name, release_builder, release_installer) — pass: 555 passed.
- `pytest tests -k phase4` — pass: 2326 passed, 2 skipped.
- `pytest tests` (full IDEA3 suite) — pass: see PR body for the exact rerun count (rerun because functional code changed in session 2).
- `bash -n`, `py_compile`, `git diff --check`, `node scripts/validate-vault.mjs` (2 pre-existing canvas warnings) — pass.
- Full-diff secret scan (against the pre-session-1 base) — synthetic test fixtures only (canary keys, placeholder PEM markers); no real secret.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L7 live preparation, main reconciliation and release-install gap closure sections.

## Shared surfaces touched

- None — the task stayed inside IDEA3.

## Integration requests

- None — no cross-scope or shared path changed. Open PR #202 (superseded by this branch's L7 handler work) is unmerged and untouched; PR #208 (release builder) is merged and its output is proven compatible with this branch's release guard and installer.

## Known limitations

- **No release is installed on the host and no owner-run installer wrapper exists.** The installer tool is repository-only and fixture-tested; live use requires an owner decision on the authorization/stage governance (documented, not invented — see design §8). Owner input (OV-09 keys, OV-11 PIN, MQTT password, D4 restore credential), Pub D6 notice, fresh same-day A-L7 and K3, IDEA2 §10 fresh state and disk headroom are still required before any live L7 attempt.
- Live-only, unproven offline: real `systemd-analyze verify`, `runuser`, `reset-failed`/`daemon-reload` semantics, `ss -p` output, the Core's real broker connection and heartbeat gating, and root ownership installs (including the real installer's `os.rename` on the live filesystem).
