# IDEA2 Pre-Live Windows Agent Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the two confirmed Machine A Windows runtime incompatibilities and add compare-and-swap node-key rotation without mutating any live runtime or database.

**Architecture:** Keep ACL validation fail-closed while comparing canonical SID strings supported by pywin32 312. Stage the fresh DataRoot ACL so the installer retains administrator authority until service/SYSTEM rights are installed, then remove the temporary administrator ACE. Make public-key rotation atomic by requiring an expected positive key version in the SQL predicate while preserving the reviewed reactivation behavior.

**Tech Stack:** Python 3.12-compatible code, pywin32 contract doubles, PowerShell 5.1 scripts and AST/static tests, PostgreSQL/psycopg2 CLI tests, unittest, Git/Obsidian governance.

**Spec:** Human-authorized task `(IDEA2) AEGIS IDEA2 — PRE-LIVE BLOCKER FIX A WINDOWS IDENTITY AGENT REAL-RUNTIME COMPATIBILITY + SAFE NODE KEY ROTATION`.

## Global Constraints

- Repository-only: no Machine A, Production, database, service, key, camera, tunnel, or container mutation.
- Preserve exact protected DataRoot ACL: service SID owner; exactly SYSTEM and service FullControl allow ACEs.
- Preserve `rotate-key` reactivation (`active = TRUE`) while adding expected-version CAS.
- No rebase, force-push, merge, or secret/private-key output.

## Review Focus

- pywin32 without `EqualSid` must still validate exact canonical SIDs.
- Duplicate or extra allowed SIDs must fail even when ACE count remains two.
- The installer must retain temporary administrator access until the final ACL is enforceable, then remove it.
- Stale/future key versions and missing nodes must perform zero key mutation.
- CLI output and task artifacts must contain fingerprints/metadata only, never key payloads.

---

### Task 1: Canonical Windows SID validation

**Files:**
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_key_store.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_identity_agent/key_store.py`

- [ ] Add fake-pywin32 RED tests for missing `EqualSid`, exact owner/ACEs, duplicates, inherited/deny/insufficient/unprotected/malformed cases.
- [ ] Run the focused tests and confirm pre-fix failure.
- [ ] Compare SIDs only through `ConvertSidToStringSid` and keep broad descriptor failures closed.
- [ ] Run focused GREEN tests.

### Task 2: Safe fresh DataRoot ACL installation

**Files:**
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_windows_identity_agent_lifecycle.py`
- Modify: `IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/identity-agent/install_identity_agent.ps1`

- [ ] Add RED static/AST assertions for separate checked ACL, owner, and temporary-admin-removal operations.
- [ ] Run the lifecycle test and confirm pre-fix failure.
- [ ] Install protected grants with temporary Administrators FullControl, set the service owner only after grants exist, then remove the temporary Administrators grant through checked calls.
- [ ] Run focused GREEN and PowerShell parse checks.

### Task 3: Node key-version compare-and-swap

**Files:**
- Modify: `IDEA2-AEGIS_Monitor/tests/test_manage_nodes.py`
- Modify: `IDEA2-AEGIS_Monitor/server/cli/manage_nodes.py`
- Modify: `IDEA2-AEGIS_Monitor/server/cli/README.md`

- [ ] Add RED parser and command tests for required positive expected version, v1→v2 success, stale/future/missing zero-mutation failure, atomic fields, unchanged auth/mappings, and one increment.
- [ ] Run the focused tests and confirm pre-fix failure.
- [ ] Add the required CLI argument and atomic `WHERE node_id AND key_version` update, preserving `active = TRUE`.
- [ ] Run focused GREEN and affected registry/CLI tests.

### Task 4: Final verification and publication

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- Create: one `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/*_pub_idea2-prelive-windows-agent-blockers.md`

- [ ] Run broader Agent/Windows and Monitor suites, PowerShell parsing, diff, Vault/governance, and changed-content secret scan.
- [ ] Run the authoritative Agent source-hash helper and record the new digest.
- [ ] Fetch origin and stop if `origin/main` moved from the pinned base.
- [ ] Update canonical status, create exactly one final receipt, stage exact paths, commit, push normally, publish one Draft PR, and verify its real PR-event checks.
