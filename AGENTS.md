# AGENTS.md — AEGIS Collaboration Rules for AI Coding Agents

This file is the canonical repository-wide workflow for Codex, Claude, Gemini,
Copilot, and other coding agents. Tool-specific instruction files may add
tooling details but must not weaken these rules.

## Read first, every task

Before editing, read in this order:

1. `Obsidian_AEGIS_Vault/AEGIS_Knowledge/START_HERE.md`
2. `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
3. The canonical note for the selected task area from the ownership table below
4. The 3–5 newest files in `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/`
5. The source files and tests directly affected by the task

Do not infer current implementation status from the global graph alone. Verify
claims against source, tests, deployment evidence, and the latest task receipts.

## Git lifecycle — one task, one branch, one Pull Request

Never push directly to `main`. One task uses one branch and one Pull Request.

Start from current `main`:

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git switch -c feat/idea1-short-task-name
```

Allowed branch prefixes are `feat/`, `fix/`, `docs/`, `infra/`, `chore/`, and
`codex/`. Use lowercase ASCII and hyphens after the slash. IDEA task branches
should include `idea1`, `idea2`, or `idea3` in the slug.

Before requesting merge:

1. Run the affected tests/builds.
2. Review `git diff --name-status origin/main...HEAD` for accidental scope expansion.
3. Add exactly one new Obsidian task receipt under `90-Status/logs/`.
4. Push the task branch and open a Pull Request using the repository template.
5. If another Pull Request merged first, merge current `origin/main` into the
   task branch and re-run the affected verification.

Never use `git push --force`. Never resolve a conflict by selecting an entire
side without reconciling both sets of facts.

## Current ownership and maturity routing

The Obsidian ownership migration is active. Use these canonical paths:

| Area | Functional owner | Primary code | Canonical knowledge | Current maturity |
|---|---|---|---|---|
| IDEA1 | Kla | `IDEA1-AEGIS_Drive_LC/` | `idea1/idea1-moc.md`, `idea1/idea1-status.md`, `summaries/04_*` | UI is largely stable; backend and server deployment are still evolving |
| IDEA2 | Pub | `IDEA2-AEGIS_CCTV-Operator/`, `IDEA2-AEGIS_Monitor/`, `AEGIS_Camera/` | `idea2/idea2-moc.md`, `idea2/idea2-status.md`, `summaries/05_*` | UI is largely stable; identity and backend integration are still evolving |
| IDEA3 | Music | `IDEA3-AEGIS_Lockdown/` | `idea3/idea3-moc.md`, `idea3/idea3-status.md` | Design/report knowledge only; repository implementation is not established |
| Infrastructure/network | Kla as integration reviewer | `HUB-AEGIS_Entry/`, `gateway/`, `postgres/`, `shared/`, `docker-compose.yml` | `infrastructure/infrastructure-moc.md` and its subfolders | Active setup; server, Docker, VLAN, remote access, and deployment are not stable |
| Core/shared | Kla | Cross-module contracts and governance | `core/`, `START_HERE.md`, `index.md`, `.schema.md`, `90-Status/integration-queue.md` | Shared edits require integration review |

Kla maps to GitHub user `kraveerachat`; Pub maps to
`pubpup2006p-design`. Music's GitHub username is not recorded yet, so Kla is the
temporary GitHub review owner for IDEA3 while receipts continue to use `music`.

## Mandatory Obsidian update after every completed task

Every completed task must update the knowledge base. This does not mean every
Agent edits every related note.

### Always do

Create exactly one new file:

```text
Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_<owner>_<topic>.md
```

Use owner `kla`, `pub`, or `music`; use lowercase ASCII for `<topic>`. Copy
`90-Status/logs/_template.md`. Record the task branch, exact source paths,
verification evidence, Shared surfaces touched, integration requests, and
known limitations. Receipts are append-by-new-file: never edit another task's
receipt merely to add later work.

### Update when facts changed

Update the selected area's canonical note in place when the task changes its
implemented, tested, deployed, blocked, or maturity state. Replace stale facts;
do not create a duplicate canonical note.

### Do not edit without ownership/integration review

Non-owners must not directly update another area's canonical note or Core files.
Write the exact requested correction under `## Integration requests` in the
task receipt instead. Kla reconciles Core/shared facts during integration review.

Do not append new task entries to legacy `log.md`. It is frozen history after
the collaboration guardrails land. Update `index.md` only when a genuinely new
knowledge note is created, and route that change through integration review.

## Shared and cross-scope changes

Agents may change files outside their primary area when required for a working
system. Examples include `docker-compose.yml`, gateway routes, database schema,
shared contracts, authentication boundaries, ports, IP/VLAN configuration, and
Core knowledge.

When any such path changes:

1. Set `integration-review: yes` in the Pull Request policy block.
2. List every exact path under `## Shared surfaces touched` with the reason.
3. Record downstream effects and owner requests in the Obsidian receipt.
4. Do not mark the task complete until the integration reviewer accepts it.

## Completion gate

A task is complete only when all applicable items are true:

- implementation is scoped and no secret/local artifact is included;
- affected tests/builds ran and exact results are recorded;
- exactly one new Obsidian receipt exists;
- changed canonical notes are owner-writable or integration-reviewed;
- shared paths are declared;
- the Pull Request policy check passes;
- the Pull Request is reviewed before merge.

## Shared UI/design workflow

For frontend design work, read `.agents/skills/impeccable/SKILL.md` before
editing. Preserve real API/state/RBAC behavior; do not add mock telemetry or
fake completeness. Use the existing `PRODUCT.md` and `DESIGN.md`, verify the
running surface when possible, and record honest implementation status in the
area receipt/canonical note.

## Security boundaries

Keep `.env`, tokens, passwords, private keys, recordings, generated clips,
database dumps, dependencies, and local AI settings out of commits. Preserve
server-side authorization, identity decoupling, fail-secure behavior, and the
documented OWASP controls.
