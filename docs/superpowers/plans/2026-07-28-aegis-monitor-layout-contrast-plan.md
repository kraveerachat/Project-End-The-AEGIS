# AEGIS Monitor Layout and Contrast Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix AEGIS Monitor branding placement, sidebar wrapping, vertical alignment, and theme contrast without changing application behavior.

**Architecture:** Keep the existing `AegisLockup` rendered by `TopBar`; adjust only its layout contract and the CSS that controls the three-column navbar. Make sidebar width and no-wrap behavior explicit, then add explicit theme-aware colors for the affected text surfaces. Update the existing Monitor knowledge note, overview, index only if needed, and append the required log entry.

**Tech Stack:** React 19, Vite, CSS, Tailwind utility classes inside `AegisLockup`, Node test runner, Obsidian Markdown notes.

## Global Constraints

- Do not change data fetching, state, permissions, navigation, or event-stream logic.
- Keep mobile navigation behavior unchanged.
- Do not create duplicate Obsidian notes; update existing notes in place.
- Verify with `npm test` and `npm run build` from `IDEA2-AEGIS_Monitor`.

---

### Task 1: Refine the navbar brand contract

**Files:**
- Modify: `IDEA2-AEGIS_Monitor/src/components/AegisMark.jsx`
- Modify: `IDEA2-AEGIS_Monitor/src/index.css`

- [ ] **Step 1: Make the lockup text non-shrinking and non-truncating**

Update `AegisLockup` so the outer lockup can retain its intrinsic width and the title/subtitle wrappers use `whitespace-nowrap`/`min-w-max` rather than relying on `.truncate`.

- [ ] **Step 2: Reserve a stable navbar start column**

Update the final navbar override so `.topbar-brand` uses `min-width: max-content`, `min-width: 280px`, and `white-space: nowrap` while preserving the existing compact breakpoint that hides it.

- [ ] **Step 3: Check the resulting diff**

Run `git diff -- IDEA2-AEGIS_Monitor/src/components/AegisMark.jsx IDEA2-AEGIS_Monitor/src/index.css` and confirm only layout/contrast declarations changed.

### Task 2: Widen and stabilize sidebar typography

**Files:**
- Modify: `IDEA2-AEGIS_Monitor/src/index.css`

- [ ] **Step 1: Set the desktop sidebar width**

Change the final `.side` override from `236px` to `280px`; retain the mobile breakpoint behavior that hides the desktop sidebar.

- [ ] **Step 2: Force one-line navigation content**

Set `.navsec, .nav { white-space: nowrap; }`, add `min-width: 0` to nav buttons, and use `overflow: hidden; text-overflow: ellipsis` only for menu labels if needed so section headings such as `INFRASTRUCTURE & CONFIG` remain one line.

- [ ] **Step 3: Remove obsolete sidebar-brand spacing**

Remove or neutralize `.sidebrand` styling because `Sidebar.jsx` no longer renders that block; do not alter the sidebar flex/footer structure.

### Task 3: Increase contrast for affected text surfaces

**Files:**
- Modify: `IDEA2-AEGIS_Monitor/src/index.css`

- [ ] **Step 1: Set explicit page subtitle colors**

Use `#CBD5E1` for `.sub` in dark mode and `#475569` for `html.light .sub`.

- [ ] **Step 2: Set explicit sidebar footer colors**

Use `#94A3B8` for `.sidefoot` in dark mode and `#475569` for `html.light .sidefoot`.

- [ ] **Step 3: Set explicit event-stream row colors**

Set `.srow`, `.sts`, `.scam`, and `.stext` to readable dark-theme colors, with corresponding `html.light` colors that remain legible on the light panel. Preserve semantic warning/status dot colors.

### Task 4: Verify and sync project knowledge

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/03 - 🛰️ IDEA2 AEGIS Monitor.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/00 - 🗺️ AEGIS System Overview.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/log.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md` only if an existing note reference is stale

- [ ] **Step 1: Run automated tests**

Run `npm test` from `IDEA2-AEGIS_Monitor`; expected exit code 0.

- [ ] **Step 2: Run the production build**

Run `npm run build` from `IDEA2-AEGIS_Monitor`; expected exit code 0.

- [ ] **Step 3: Update the existing Monitor note and overview in place**

Record that the brand lockup is in the top navbar start zone, the sidebar is 280px on desktop with no-wrap headings, and the affected dark/light text surfaces have explicit contrast colors. Update any stale Mermaid/UI architecture wording without adding a duplicate note.

- [ ] **Step 4: Append the required log entry**

Append a `## [2026-07-28] vibe-coding | AEGIS Monitor layout and contrast refactor` entry listing modified source paths and updated notes.

- [ ] **Step 5: Inspect final status and diff**

Run `git status --short` and `git diff --stat`; confirm the changes are scoped to the Monitor UI, approved spec/plan, and required knowledge-base sync.

