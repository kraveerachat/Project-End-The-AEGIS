---
title: Impeccable UI Design Workflow
tags: [aegis, ui, ux, design-system, impeccable]
type: workflow
created: 2026-07-28
updated: 2026-07-28
---

# Impeccable UI Design Workflow

AEGIS UI work in this task is handled through the local Impeccable skill and its official command vocabulary. Incoming English design prompts from external assistants are treated as design intent; the agent selects the most appropriate command before editing production code.

## Routing rules

| Prompt intent | Impeccable command | AEGIS use |
|---|---|---|
| Plan a new surface or major feature | `shape` / `craft` | Discover the UX and build an end-to-end surface |
| Review visual quality or usability | `critique` | Score hierarchy, persona fit, and design anti-patterns |
| Check implementation quality | `audit` | Accessibility, responsive behavior, performance, and technical UI quality |
| Fix spacing or hierarchy | `layout` | Rhythm, alignment, density, and responsive composition |
| Fix generic or inconsistent type | `typeset` | Font pairing, scale, line-height, and text wrapping |
| Add intentional color | `colorize` | Strategic semantic color while preserving AEGIS restraint |
| Tone down noisy UI | `quieter` / `distill` | Remove visual noise, repetition, or unnecessary structure |
| Increase impact or personality | `bolder` / `delight` | Add character without breaking the product register |
| Handle mobile and device contexts | `adapt` | Responsive layout, input, and interaction changes |
| Fix copy, labels, or errors | `clarify` | Thai-first UX copy and understandable states |
| Harden edge cases | `harden` | Empty, error, overflow, i18n, and production states |
| Final refinement | `polish` | Meticulous pass after the main UI change |
| Iterate against a running page | `live` | Browser-based variants and visual verification |

## AEGIS constraints

- Use the existing AEGIS product register and committed tokens; do not invent a generic SaaS visual language.
- Preserve Thai-first accessibility, WCAG AA contrast, responsive behavior, reduced motion, and the project's deliberate anti-references.
- Never apply a command mechanically: inspect the target page, its CSS/tokens, and the current design context first.
- Prefer the sequence `shape → build → critique/audit → polish` for larger changes and `audit → harden` for technical quality issues.

## Agent operating rule

The user may send a design brief from Gemini, Claude, or another assistant without naming
an Impeccable command. The coding agent must infer the primary command from the brief,
select a secondary verification command when useful, and explain the choice briefly in its
working update. A command is a means to inspect and improve the real surface, not a reason
to rewrite functional behavior. The agent must read `PRODUCT.md`, `DESIGN.md`, this note,
and the relevant module note before editing, then update existing Obsidian notes in place
afterward.

The official command source is https://impeccable.style/docs/; the repository implementation
is `.agents/skills/impeccable/SKILL.md`. Other agents should use the same routing rules so
UI decisions remain consistent across sessions and contributors.

## Applied pass: repository-wide UI directive (2026-07-28)

For the comprehensive frontend directive, the selected commands were `craft` for the production CSS implementation, `layout` for responsive composition and hierarchy, `delight` for restrained interaction feedback, and `animate` for state-oriented motion/accessibility rules. The implementation was scoped to `src/index.css` in HUB, Drive, and Monitor so functional logic, API contracts, and state machines stayed unchanged. Verification used the Impeccable detector, production builds, and module tests.

## Source of guidance

- Official docs: https://impeccable.style/docs/
- Local skill: `.agents/skills/impeccable/SKILL.md`
- Project context: `PRODUCT.md` and `DESIGN.md`
