# IDEA3 Purple Desktop Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the complete eight-page IDEA3 Purple Desktop and its surrounding offline desktop experience without changing any operational or security behavior.

**Architecture:** Extend the existing IDEA3-owned presentation helper and subclass overrides around the byte-pinned Purple GUI. Data computation and authority callbacks stay unchanged; builders consume the same snapshots and render more legible, localized structures.

**Tech Stack:** Python 3, Tkinter, pytest, existing Purple Desktop theme/i18n, ImageMagick/X11 capture when available.

**Spec:** `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-10-28-idea3-purple-desktop-refinement-design.md`

## Global Constraints

- Branch must remain `feat/idea3-ui-readability`; no branch switch, worktree, commit, push, merge, deploy, rebase, reset, or discard.
- The five files under `tools/purple_ui_source/aegis_soc/` named in the user brief remain byte-identical.
- No file under `IDEA3-AEGIS_Lockdown/aegis_soc/` may change.
- Offline/fake-control evidence only; no CUT, RESTORE, attack traffic, service, process, or hardware mutation.
- Keep the existing purple palette, dark/light support, TH/EN/ZH, callbacks, persistence, status semantics, snapshot skip, and scroll preservation.

## Review Focus

- Missing/unreadable sources must remain NOT_FOUND/UNKNOWN/NOT_AVAILABLE, never a zero count.
- Status presentation must not claim physical relay or network verification from software acknowledgement.
- Long Thai/Chinese labels and values must wrap without clipping at 1440×900 and 1920×1080.
- A refresh with an unchanged snapshot must not rebuild widgets or move scroll position.
- Settings, CUT/RESTORE, and recovery controls must retain their original callbacks and authority checks.

---

### Task 1: Shared presentation and localization contracts

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/tools/purple_design.py`
- Modify: `IDEA3-AEGIS_Lockdown/tools/live_purple_observer.py`
- Test: `IDEA3-AEGIS_Lockdown/tests/test_live_purple_observer.py`

**Interfaces:**
- Consumes: pinned palette, named fonts, status glyph/color helpers.
- Produces: shared localized page vocabulary and reusable table/fact/feedback components.

- [ ] Write failing tests for TH/EN/ZH keys, semantic status preservation, and palette-derived components.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement the minimal shared helpers and localized strings.
- [ ] Run focused tests and confirm they pass.

### Task 2: Eight operational pages

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/tools/live_purple_observer.py`
- Modify: `IDEA3-AEGIS_Lockdown/tools/live_purple_control_desktop.py`
- Modify: `IDEA3-AEGIS_Lockdown/tools/live_purple_core_records.py` only if a pure structured audit projection is required.
- Test: `IDEA3-AEGIS_Lockdown/tests/test_live_purple_observer.py`
- Test: `IDEA3-AEGIS_Lockdown/tests/test_live_purple_control_desktop.py`
- Test: `IDEA3-AEGIS_Lockdown/tests/test_live_purple_core_records.py`

**Interfaces:**
- Consumes: Task 1 presentation helpers and existing snapshots.
- Produces: consistent Overview, Incidents, Devices, Lockdown, Recovery, Audit, Diagnostics, and Settings builders.

- [ ] Write failing tests for truthful summary values, grouped device/lockdown states, structured audit rows, localized page labels, and unchanged refresh/scroll behavior.
- [ ] Run focused tests and confirm expected failures.
- [ ] Refine all eight builders using the existing data and callbacks only.
- [ ] Run the focused page/lifecycle suites and confirm they pass.

### Task 3: Shell, settings feedback, and safe surrounding experience

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/tools/live_purple_observer.py`
- Modify: `IDEA3-AEGIS_Lockdown/tools/live_purple_control_desktop.py` only where control-page integration requires it.
- Test: `IDEA3-AEGIS_Lockdown/tests/test_live_purple_observer.py`
- Test: `IDEA3-AEGIS_Lockdown/tests/test_live_purple_control_desktop.py`

**Interfaces:**
- Consumes: original shell/login/dialog/wizard widgets and callbacks.
- Produces: presentation-only post-build styling and inline settings confirmation without new settings or command paths.

- [ ] Write failing tests proving original callbacks remain bound and feedback follows language/theme changes.
- [ ] Run focused tests and confirm expected failures.
- [ ] Implement presentation-only shell/settings integration; leave accepted pinned login/auth behavior intact.
- [ ] Run focused tests and confirm they pass.

### Task 4: Offline visual evidence and final regression

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/tools/capture_purple_desktop.py` if the environment can render Tk/X11.
- Create: `IDEA3-AEGIS_Lockdown/artifacts/purple-ui-refinement/**` screenshots.
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` with actual evidence and limitations.

**Interfaces:**
- Consumes: completed desktop builders and offline fake-control fixtures.
- Produces: deterministic screenshot paths and final evidence record.

- [ ] Add a failing offline harness test for scenario enumeration and secret-free fixtures.
- [ ] Implement capture orchestration without production data or commands.
- [ ] Run focused and complete relevant desktop suites; record exact pass/fail/skip counts.
- [ ] Capture both resolutions, both themes, all pages, representative TH/EN/ZH, and reachable login/recovery/confirmation states.
- [ ] Inspect screenshots for clipping, overflow, alignment, typography, empty states, and scroll/flicker regressions.
- [ ] Re-run SHA-256 and changed-path scope checks; update the canonical session record with honest limitations.

