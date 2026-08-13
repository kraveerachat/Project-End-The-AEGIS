# AGENTS.md — AEGIS Professional Collaboration Runbook

This is the canonical repository-wide workflow for Codex, Claude, Gemini,
Copilot, and every other coding agent. Tool-specific files may add commands,
but they must not weaken or bypass these rules.

## 1. Non-negotiable outcomes

Every task follows **one task → one branch → one Pull Request → one immutable
Obsidian receipt**. Never push directly to `main`.

The workflow is designed to let IDEA1, IDEA2, IDEA3, and infrastructure work in
parallel without losing another person's code or overwriting shared project
knowledge.

An agent must not claim a task is complete unless:

- the implementation and documentation describe the same current state;
- affected verification has run and the real result is recorded;
- every changed path outside the selected area is explicitly declared;
- exactly one new task receipt exists; and
- the branch is ready for owner and integration review.

## 2. Read first, every task

Before editing, read in this order:

1. `Obsidian_AEGIS_Vault/AEGIS_Knowledge/START_HERE.md`
2. `Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/08_Outstanding_Items_Consolidated.md`
3. The selected area's MOC and status note from the ownership table below
4. The 3–5 newest files in `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/`
5. The source files, tests, deployment files, and open PR dependencies directly
   related to the task

Do not infer current status from the Obsidian graph, filenames, screenshots, or
old chat history alone. Verify claims against source, tests, deployment evidence,
and the latest receipts.

## 3. Classify the task before editing

Select exactly one task area and functional owner:

| Area | Receipt owner | Primary code boundary | Canonical knowledge | Current maturity |
|---|---|---|---|---|
| `idea1` | `kla` | `IDEA1-AEGIS_Drive_LC/` | `idea1/idea1-moc.md`, `idea1/idea1-status.md`, `summaries/04_*` | UI largely stable; backend and server deployment evolving |
| `idea2` | `pub` | `IDEA2-AEGIS_CCTV-Operator/`, `IDEA2-AEGIS_Monitor/`, `AEGIS_Camera/` | `idea2/idea2-moc.md`, `idea2/idea2-status.md`, `summaries/05_*` | UI largely stable; identity and backend integration evolving |
| `idea3` | `music` | `IDEA3-AEGIS_Lockdown/` | `idea3/idea3-moc.md`, `idea3/idea3-status.md` | Design/report knowledge exists; repository implementation is not established |
| `infrastructure` | `kla` | `HUB-AEGIS_Entry/`, `gateway/`, `postgres/`, `shared/`, `docker-compose.yml`, `.env.example` | `infrastructure/infrastructure-moc.md` and its subfolders | Server, Docker, VLAN, remote access, and deployment are still evolving |
| `shared` | `kla` | Cross-module contracts and governance | `core/`, `START_HERE.md`, `index.md`, `.schema.md`, `.github/` | Always requires integration review |

Kla maps to GitHub user `kraveerachat`; Pub maps to
`pubpup2006p-design`. Music's GitHub username is not recorded yet, so Kla is the
temporary GitHub reviewer for IDEA3 while receipts continue to use `music`.

Definitions:

- **Owned path**: a path inside the selected area's primary code or knowledge
  boundary.
- **Cross-scope path**: any changed path outside that boundary.
- **Shared surface**: a path whose behavior or contract affects more than one
  area, including deployment, gateway, database, authentication, network, CI,
  shared schema, and Core knowledge.
- **Canonical note**: the owner-maintained note describing durable current state.
- **Task receipt**: the immutable record of one completed, partial, or blocked
  task. It is never used as a second canonical architecture document.

## 4. Start safely from Git

### Normal task based on current `main`

```bash
git fetch origin
git switch main
git pull --ff-only origin main
git status --short
git switch -c feat/idea2-short-task-name
```

The status must be understood before switching. Do not delete, stage, or include
unrelated local files merely to make the tree look clean.

Allowed branch prefixes are `feat/`, `fix/`, `docs/`, `infra/`, `deploy/`,
`chore/`, and `codex/`. The part after `/` must use lowercase ASCII, digits, and
hyphens. Include `idea1`, `idea2`, or `idea3` in an IDEA task slug.

Examples:

```text
feat/idea1-drive-search
fix/idea2-live-stream-reconnect
deploy/idea2-server-runtime
infra/twingate-routing
docs/idea3-architecture-status
codex/collaboration-workflow-rules
```

### Task that depends on an unmerged Pull Request

Do not pretend an unmerged dependency is already in `main`. Create the branch
from that dependency branch, open a stacked PR against the dependency branch,
and state the dependency in the PR summary. After the dependency merges, change
the PR base to `main`, update the branch, and rerun verification.

## 5. Declare scope before and after implementation

Before editing, identify:

- selected `area` and `owner`;
- intended owned paths;
- possible cross-scope/shared paths;
- expected tests or deployment checks; and
- the canonical note that may need a durable fact update.

Cross-scope work is allowed when necessary to deliver a working system. It is
not blanket permission to refactor unrelated areas.

For example, an IDEA2 task that must run on the real server may need:

| Path | Classification for an IDEA2 task | Required action |
|---|---|---|
| `IDEA2-AEGIS_Monitor/**` | Owned | Implement and test normally |
| `docker-compose.yml` | Cross-scope infrastructure | Declare exact path and request integration review |
| `gateway/nginx.conf` | Cross-scope infrastructure | Declare route, downstream effect, and rollback |
| `postgres/init/**` | Cross-scope data/infrastructure | Declare migration and compatibility impact |
| `.env.example` | Cross-scope deployment contract | Document variable only; never commit a secret |
| `infrastructure/**` note | Another owner's canonical knowledge | Request owner update through the receipt unless explicitly co-reviewed |

Whenever one or more cross-scope paths are changed:

1. Keep the change to the minimum necessary for the task.
2. Set `integration-review: yes` in the PR policy block.
3. List **every exact changed path** under PR `## Shared surfaces touched`, with
   the reason and affected area.
4. List the same exact paths under receipt `## Shared surfaces touched`.
5. Write a meaningful receipt `## Integration requests` entry naming the review,
   decision, migration, rollout, or rollback required. `None` is invalid.
6. Explain downstream impact and rollback in the PR.
7. Run both area-level verification and applicable integration/deployment checks.
8. Do not mark the integration complete until the responsible reviewer accepts it.

The collaboration policy check rejects a cross-scope path that is missing from
either the PR or receipt.

## 6. Implement and verify honestly

Work inside the selected scope first. Preserve existing API, state, RBAC,
identity, and security behavior unless the task explicitly changes the contract.

Before recording a result:

```bash
git status --short
git diff --check
git diff --name-status origin/main...HEAD
```

Then run the affected tests/builds. Deployment work needs evidence at the level
claimed: a successful unit test does not prove that a container, gateway route,
database migration, or remote server deployment works. Record untested portions
as limitations and use `partial` or `blocked` when appropriate.

Never include `.env`, tokens, passwords, private keys, recordings, generated
clips, database dumps, dependencies, build output, or local AI settings.

## 7. Update Obsidian without multi-writer conflicts

### Always create one immutable receipt

At the end of every task, copy `90-Status/logs/_template.md` and add exactly one:

```text
Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_<owner>_<topic>.md
```

Use `kla`, `pub`, or `music`; use lowercase ASCII and hyphens for `<topic>`.
The receipt must record:

- branch and task status;
- observable outcome;
- every exact changed source path;
- exact verification commands and pass/fail results;
- canonical notes updated;
- every cross-scope path, matching the PR exactly;
- integration decisions or reviews needed; and
- honest limitations.

Receipts are **append-by-new-file**. Never edit, rename, or replace another
task's receipt. Do not append new task entries to frozen legacy `log.md`.

### Update canonical notes only under the correct ownership rule

- The functional owner updates their own area's MOC/status note in place when a
  durable implemented, tested, deployed, blocked, or maturity fact changed.
- Replace stale facts; do not create duplicate notes for the same concept.
- A non-owner does not directly rewrite another area's canonical note. Put the
  exact proposed fact and target note under receipt `Integration requests`.
- Shared/Core canonical notes require Kla's integration review.
- Update `index.md` only when a genuinely new canonical note is introduced.
- Do not create graph links merely to make the Obsidian graph look denser.

This split is intentional: parallel branches write different receipt files, so
IDEA1 and IDEA2 do not overwrite the same shared history file. Owners reconcile
durable facts into their canonical notes during review.

## 8. Commit and push the task branch

Inspect and stage only intentional paths:

```bash
git status --short
git diff
git add <exact-path-1> <exact-path-2> <receipt-path>
git diff --cached --check
git diff --cached --name-status
git commit -m "feat(idea2): describe the completed outcome"
git push -u origin <branch-name>
```

Do not use `git add .` until every untracked and modified path has been reviewed.
Do not commit unrelated user files. Never use `git push --force` on shared work.

Use focused conventional commits such as `feat(idea2):`, `fix(idea1):`,
`infra(network):`, `deploy(idea2):`, `docs(vault):`, or `chore(collaboration):`.

## 9. Open and maintain the Pull Request

Use the repository PR template. Complete all fields; do not delete the hidden
policy block.

The PR must include:

- correct `area`, `owner`, and `integration-review` metadata;
- concise summary and observable behavior;
- exact verification commands/results;
- the one new receipt path;
- canonical notes updated;
- exact shared/cross-scope paths and reasons;
- migration, rollout, rollback, known limitations, and dependencies where relevant;
- requested functional owner and integration reviewers.

Keep the PR as Draft while implementation, evidence, dependency, or receipt work
is incomplete. Mark it Ready only after local verification and policy checks pass.

If another PR merges first:

```bash
git fetch origin
git switch <branch-name>
git merge origin/main
```

Resolve each conflict by reconciling both changes; never accept all of `ours` or
`theirs` blindly. Re-run tests, update the receipt only if it is still part of the
same unmerged task, push normally, and wait for checks again.

## 10. Completion gate

A task is ready for merge only when all applicable items are true:

- [ ] work is on a correctly named non-`main` task branch;
- [ ] change stays in scope or every cross-scope path is declared twice;
- [ ] no unrelated file, secret, or local artifact is staged;
- [ ] affected tests/builds/integration checks ran;
- [ ] claims match evidence and limitations are explicit;
- [ ] exactly one new correctly owned receipt exists;
- [ ] canonical updates obey functional ownership;
- [ ] PR policy and required CI checks pass;
- [ ] functional and integration reviewers have approved where required;
- [ ] merge is performed through the Pull Request, not by direct push.

## 11. Shared UI/design workflow

For frontend design work, read `.agents/skills/impeccable/SKILL.md` before
editing. Preserve real API/state/RBAC behavior; do not add mock telemetry or
fake completeness. Use the existing `PRODUCT.md` and `DESIGN.md`, verify the
running surface when possible, and record honest status in the area receipt and
canonical note.

## 12. Security boundaries

Preserve server-side authorization, identity decoupling, fail-secure behavior,
and documented OWASP controls. Shared authentication, database, gateway,
network, and deployment edits always require explicit integration review.
