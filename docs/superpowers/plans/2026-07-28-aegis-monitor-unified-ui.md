# AEGIS Monitor Unified UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify AEGIS Monitor's seven authenticated views with the approved Drive-inspired dark/light cyber-physical visual system without changing its API, RBAC, or data states.

**Architecture:** Keep React view structure intact. Consolidate palette, surface, typography, responsive, motion, and semantic-state rules in `src/index.css`; make only focused component class/semantic adjustments where a view needs a state or control treatment. Existing `dark` root-class behavior remains the theme contract.

**Tech Stack:** React 19, Vite, CSS custom properties, Framer Motion, Lucide React.

## Global Constraints

- Preserve existing routes, state-machine rendering, RBAC, and API payloads.
- Use violet/cyan only as accents; green/amber/rose only for semantic state.
- Respect `prefers-reduced-motion`; do not add dependencies or mock data.
- Verify `npm test`, `npm run build`, and Docker Monitor health before handoff.

---

### Task 1: Establish theme and shell tokens

**Files:**
- Modify: `IDEA2-AEGIS_Monitor/src/index.css`

- [x] Define light/dark canvas, panel, border, text, semantic-status, radius, and motion tokens.
- [x] Restyle app shell, topbar, sidebar, workspace glow, status pills, navigation selection, and focus states.
- [x] Add reduced-motion overrides and responsive shell rules.

### Task 2: Unify data-view components

**Files:**
- Modify: `IDEA2-AEGIS_Monitor/src/index.css`
- Modify: `IDEA2-AEGIS_Monitor/src/components/ui.jsx`

- [x] Refine empty/error/loading surfaces, filters, buttons, tables, badges, and toggle rails with shared classes.
- [x] Add semantic node-card, feed, alert, and operator-row hover treatments without changing rendered data.

### Task 3: Verify the seven views

**Files:**
- Test: `IDEA2-AEGIS_Monitor/tests/*.test.mjs`

- [x] Run `npm test` and `npm run build`.
- [x] Rebuild Docker Monitor and verify `GET /monitor/healthz`.
- [x] Update AEGIS Obsidian Monitor and overview notes plus the vault log.
