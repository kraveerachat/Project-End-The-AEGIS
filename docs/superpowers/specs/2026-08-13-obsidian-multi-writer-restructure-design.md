# AEGIS Obsidian Multi-Writer Restructure Design

**Date:** 2026-08-13
**Status:** Proposed for owner review
**Repository:** `kraveerachat/Project-End-The-AEGIS`
**Target branch:** `codex/obsidian-multi-writer-restructure`

## 1. Goal

Allow the IDEA1, IDEA2, and IDEA3 owners to develop and document work concurrently without losing another branch's Obsidian updates, while preserving one trustworthy project-wide knowledge base for new AI-agent sessions.

## 2. Confirmed collaboration model

- `main` is the tested, integrated source of truth.
- Kla is the primary integrator and the IDEA1 owner.
- Pub is the IDEA2 owner.
- Music is the IDEA3 owner.
- Each task is developed on its own feature branch and proposed through a pull request.
- Module owners may update their own canonical module knowledge immediately.
- Changes to shared code or shared knowledge are allowed when technically necessary, but must be declared in the task receipt and reviewed by the integrator.

## 3. Problem being solved

The current repository-level agent rule requires every completed task to edit the same shared files:

- `00 - 🗺️ AEGIS System Overview.md`
- `index.md` when notes are created
- `log.md` for every task

When IDEA1 and IDEA2 branches start from the same commit, each branch can produce a valid but incomplete version of those files. A feature branch prevents one working copy from overwriting another during development, but it does not prevent merge conflicts or stale shared-file content when both branches later merge.

The design must therefore isolate high-frequency writes, not merely isolate Git branches.

## 4. Design principles

1. **One canonical note per subject.** Do not create a new copy of an IDEA status note for every task.
2. **One immutable receipt per completed task.** High-frequency history is written to uniquely named files instead of one shared log.
3. **One owner per canonical writing surface.** Other owners submit an integration request rather than silently rewriting another module.
4. **Shared architecture changes require integration review.** Ports, API contracts, database schemas, identity boundaries, gateway routes, Docker topology, VLAN/IP configuration, and cross-IDEA data flow are shared changes.
5. **Graph links express durable knowledge relationships.** Session receipts are linked to their module MOC; they are not all connected directly to the global overview.
6. **Claims remain evidence-based.** Planned, implemented, tested, and deployed states must remain distinguishable.
7. **Migration is phased and reversible.** Conflict control lands before broad file moves.

## 5. Target knowledge architecture

```text
AEGIS_Knowledge/
├── START_HERE.md
├── index.md
├── .schema.md
├── core/
│   ├── system-overview.md
│   ├── system-context.md
│   └── integration-points.md
├── infrastructure/
│   ├── infrastructure-moc.md
│   ├── network/
│   ├── server/
│   ├── remote-access/
│   └── deployment/
├── idea1/
│   ├── idea1-moc.md
│   └── idea1-status.md
├── idea2/
│   ├── idea2-moc.md
│   └── idea2-status.md
├── idea3/
│   ├── idea3-moc.md
│   └── idea3-status.md
├── concepts/
├── entities/
├── ethics/
├── raw/
├── summaries/
└── 90-Status/
    ├── logs/
    │   ├── _template.md
    │   └── YYYY-MM-DD_HHMMSS_<owner>_<topic>.md
    └── integration-queue.md
```

The final directory names use lowercase ASCII to avoid Windows/Linux case collisions. Existing emoji note titles may remain as aliases during migration, but all newly created paths use lowercase ASCII.

## 6. Canonical ownership

| Surface | Owner | Other contributors |
|---|---|---|
| `core/`, `START_HERE.md`, `index.md`, `.schema.md` | Kla | Read; submit integration request |
| `idea1/` and IDEA1 canonical notes | Kla | Read; submit integration request |
| `idea2/` and IDEA2 canonical notes | Pub | Read; submit integration request |
| `idea3/` and IDEA3 canonical notes | Music | Read; submit integration request |
| `infrastructure/` | Kla as integrator | May propose changes through task branch and receipt; Kla reviews before merge |
| `concepts/`, `entities/`, `ethics/` | Declared per-file owner | Non-owner proposes through receipt |
| `summaries/` | Owner of the covered module; cross-project summaries are Kla-owned | Non-owner submits integration request |
| `90-Status/logs/*.md` | File creator | Immutable after merge except factual correction through a new commit/receipt |
| `90-Status/integration-queue.md` | Kla | Generated from open receipt requests; not edited by every task |

Every Markdown note receives `owner:` and `edit_policy:` frontmatter. Valid policies are:

- `owner-only` — shared/core canonical note.
- `owner-writable` — module canonical note.
- `append-by-new-file` — task receipt directory policy.
- `immutable-source` — raw imported evidence.

## 7. Task receipt contract

Every completed task creates exactly one new receipt:

```text
90-Status/logs/YYYY-MM-DD_HHMMSS_<owner>_<topic>.md
```

Example:

```text
90-Status/logs/2026-08-13_143522_pub_camera-routing.md
```

Required frontmatter:

```yaml
---
title: Camera routing task receipt
date: 2026-08-13T14:35:22+07:00
owner: pub
idea: idea2
task_branch: feat/idea2-camera-routing
status: tested
edit_policy: append-by-new-file
---
```

Required sections:

```markdown
## What changed
## Source files changed
## Verification evidence
## Shared surfaces touched
## Integration requests
## Known limitations
```

`Shared surfaces touched` must list gateway, Compose, shared database schema, infrastructure, or cross-module documentation changes. `Integration requests` must name the canonical file and the exact fact that its owner should reconcile. Write `None` when a section has no entry.

Receipt filenames must be lowercase ASCII after the timestamp and owner. A receipt is never rewritten merely to summarize a later task; the later task creates another receipt.

## 8. Overview composition

The current `00 - 🗺️ AEGIS System Overview.md` is moved with Git history to
`core/system-overview.md`, keeps `AEGIS System Overview` as an Obsidian alias, and
becomes a stable composition surface rather than a multi-writer document:

```markdown
# AEGIS System Overview

## System context
![[core/system-context]]

## IDEA1 status
![[idea1/idea1-status]]

## IDEA2 status
![[idea2/idea2-status]]

## IDEA3 status
![[idea3/idea3-status]]

## Integration points
![[core/integration-points]]
```

Each module owner keeps only their own status fragment current. Kla owns system context and integration points. Agents that read an embedding note must also read the embedded notes relevant to their task.

## 9. Git workflow

One task maps to one branch and one pull request:

```text
main
├── feat/idea1-<topic>
├── feat/idea2-<topic>
├── feat/idea3-<topic>
└── infra/<topic>
```

Required sequence:

1. Fetch and create the task branch from current `origin/main`.
2. Make the scoped code and knowledge changes.
3. Run affected tests and record exact results in the receipt.
4. Review `git diff --name-status origin/main...HEAD` for accidental cross-scope changes.
5. Push the task branch and open a pull request.
6. Bring current `main` into the task branch before final verification when another PR merged first.
7. Resolve conflicts by understanding and preserving both facts; never choose an entire side blindly.
8. Merge only after the task tests and vault validation pass.

The pull request template must expose module owner, shared surfaces touched, tests, receipt path, and integration requests.

## 10. Enforcement

### Agent instructions

`AGENTS.md`, `CLAUDE.md`, and `06 - 🤖 Agent Operating Rules.md` receive the same measurable write-scope rules. The phrase “update every related file” is removed.

### Repository checks

A vault validation script and GitHub Actions workflow will fail when:

- a receipt filename does not follow the required format;
- two new receipts use the same path;
- required receipt sections are absent;
- a Markdown note lacks valid `owner` or `edit_policy` metadata after migration;
- a path differs from another tracked path only by letter case;
- a wikilink target is missing;
- a module branch changes another module's canonical note without declaring it under `Shared surfaces touched`;
- legacy `log.md` receives a new entry after its freeze marker.

The check warns, rather than fails, for orphan notes because some raw evidence and canvases may intentionally be unlinked.

### GitHub controls

Protect `main` with pull-request-based merging, disabled force pushes, and required vault/test checks. CODEOWNERS is useful for automatic review routing but does not replace the metadata and validation rules. GitHub plan limitations must be checked before making code-owner approval mandatory.

## 11. `.gitattributes` policy

- Add `*.md text eol=lf` only in a dedicated normalization commit after all current work is integrated.
- Do not combine line-ending normalization with file moves.
- Do not assign `merge=union` to Markdown tables, canonical notes, or the integration queue.
- Unique task receipts do not need `merge=union`; naming uniqueness prevents same-path conflicts.

## 12. Migration phases

### Phase 0 — Preserve current state

- Keep the current dirty vault edits on the restructure branch.
- Exclude the three empty, untracked `ยังไม่ได้ตั้งชื่อ*.canvas` files from commits until the owner confirms deletion.
- Commit the meaningful pre-restructure vault state as a reviewed baseline.

### Phase 1 — Stop new conflicts

- Create the receipt directory and template.
- Freeze legacy `log.md` without rewriting its history.
- Add ownership metadata and banners to core/module entry notes.
- Replace repository agent rules with scoped writes.
- Add the first vault validator tests.

### Phase 2 — Split high-frequency canonical status

- Create `core/`, `idea1/`, `idea2/`, and `idea3/` status fragments.
- Convert the global overview into the embedding skeleton.
- Preserve all current facts and distinguish implemented/tested/deployed status.
- Update links and verify Obsidian embeds.

### Phase 3 — Regroup infrastructure and module navigation

- Move existing `00-MOC`, `10-Network`, `20-Server`, `30-RemoteAccess`, and `40-Deployment` content under `infrastructure/` using Git moves.
- Add IDEA and infrastructure MOCs.
- Update path-qualified wikilinks, index entries, schema tree, and canvases.
- Run broken-link, duplicate-title, case-collision, and orphan reports.

### Phase 4 — GitHub team workflow

- Add pull request template, CODEOWNERS review routing, and CI validation.
- Enable practical `main` protection settings.
- Test the workflow with one small IDEA1 branch and one small IDEA2 branch created from the same `main` commit, then merge both.

### Phase 5 — Normalize line endings

- Coordinate with all contributors so no vault work is outstanding.
- Add Markdown LF policy and run one dedicated renormalization commit.
- Verify clean Windows and Arch Linux checkouts.

## 13. Verification and acceptance criteria

The restructure is accepted only when:

1. IDEA1 and IDEA2 test branches can start from one commit, create separate receipts, update separate status fragments, and merge without a vault conflict.
2. The global overview renders all four embedded sections in Obsidian.
3. Existing factual content from the 59-note pre-migration vault remains reachable.
4. No path-qualified wikilinks are broken.
5. Every Markdown note has valid ownership metadata; raw evidence uses `immutable-source`.
6. Legacy `log.md` remains historical and receives no post-freeze task entries.
7. CI catches an intentionally malformed receipt and an undeclared cross-module canonical edit.
8. IDEA3 clearly states `design/report only` until implementation evidence enters the repository.
9. Infrastructure changes are visible as shared changes and require integration review.
10. The global graph has no empty untitled canvases after the owner explicitly approves their removal.

## 14. Non-goals

- Splitting IDEA1, IDEA2, or the vault into separate repositories.
- Automatically connecting every receipt to every related note.
- Rewriting historical receipts to match later understanding.
- Treating Graph View appearance as proof that content is correct.
- Preventing legitimate shared-file changes; the goal is to make them declared, reviewed, and integrated.
