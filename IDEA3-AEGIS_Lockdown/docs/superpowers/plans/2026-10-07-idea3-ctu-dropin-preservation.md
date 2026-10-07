# IDEA3 CTu Drop-in Preservation Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace CTu's empty-drop-in assumption with a fail-closed exact-two predecessor drop-in preservation contract bound to exact-main reviewed templates.

**Architecture:** Add one isolated contract verifier that resolves expected template bytes from the pinned Git object, validates regular-file/root:root/0644 metadata and SHA-256 for the two canonical host paths, and compares systemd's DropInPaths as an order-independent set. Invoke it before marker consumption and after install/reload/restart; rollback never writes either drop-in.

**Tech Stack:** POSIX/Bash governed runner, Python 3 standard library verifier, pytest, systemd fixture/static contracts, Obsidian receipts.

**Spec:** User-provided CTu pre-first-LIVE drop-in preservation repair requirements in this task.

## Global Constraints

- Exact semantic drop-in set: `10-recovery.conf` and `20-f1-alert.conf`, no third path.
- Expected bytes come from the exact-main Git object or an equivalent verified root-owned bundle; mutable working-tree bytes are not privileged authority.
- Pre-consume refusal must leave the CTu marker absent.
- Existing Core identity, detector, restart, handler provenance, rollback, and Recovery successor contracts remain unchanged.
- CTu, Recovery, and Production remain unexecuted; no live host mutation is permitted.

## Review Focus

- A missing/foreign/symlink/metadata-invalid/byte-modified drop-in must refuse before marker consumption; tests cover each case.
- Systemd ordering must not matter; a reordered equivalent set must pass.
- Post-consume drift must fail closed and rollback must preserve both predecessor files; tests cover appearance/disappearance/change and source inspection.
- Template authority must be exact-main, not mutable working-tree content; tests cover Git-object binding.
- Existing INACTIVE detector and restart/lifecycle contracts must remain green; focused and broad suites cover them.

### Task 1: Add the exact-main drop-in contract verifier

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_dropin_contract.py`
- Test: `IDEA3-AEGIS_Lockdown/tests/test_core_trusted_time_repair.py`

- [ ] Write failing tests for valid exact-two fixtures, missing each file, third file, changed bytes, symlink, wrong metadata, reordered systemd paths, and exact-main object binding.
- [ ] Run the focused new tests and confirm failure because the verifier does not exist.
- [ ] Implement `validate_dropins(repo, main, root, reported_paths)` with exact-main Git reads, semantic path comparison, regular-file/non-symlink/root:root/0644 checks, and SHA-256/byte comparison.
- [ ] Run the focused tests and confirm they pass.

### Task 2: Integrate pre/post CTu gates without widening mutation scope

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/owner-run/run-ctu-owner.sh`
- Modify: `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/CTu/verify.sh`
- Modify: `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/ctu-acceptance/ctu_verifier_snapshot.py`
- Modify: `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ctu-run-lib.sh`
- Test: `IDEA3-AEGIS_Lockdown/tests/test_ctu_blockers.py`

- [ ] Add the verifier to the root-owned trust closure and exact-main bundle checks.
- [ ] Invoke the pre-consume gate after PRE capture and before `ctu_consume_attempt`.
- [ ] Invoke the same semantic gate after daemon-reload and after Core restart/post verification.
- [ ] Preserve both drop-ins in rollback and refuse any handler path that removes/rewrites them.
- [ ] Add source-order/static tests for marker order, zero pre-consume mutation, one success restart, max-two failure restarts, and no explicit detector lifecycle commands.
- [ ] Run focused CTu/Recovery tests and confirm pass or classify environment-only failures.

### Task 3: Update truthful documentation and immutable receipt

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/README.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_music_idea3-ctu-dropin-preservation-repair.md`

- [ ] Document the exact-two predecessor topology, exact-main byte binding, and rollback preservation truthfully.
- [ ] Record exact changed paths, verification commands/results, shared surfaces, integration requests, and all required NO execution flags in exactly one new receipt.
- [ ] Run shell syntax, Python compile, diff, vault/collaboration validation, focused and broad regression checks.

### Task 4: Checkpoint and handoff

- [ ] Review status/diff/name-status and stage only intentional paths.
- [ ] Commit with a focused `fix(idea3):` message.
- [ ] Push `fix/idea3-ctu-dropin-preservation` and open/maintain a Draft PR; never mark Ready or merge.
