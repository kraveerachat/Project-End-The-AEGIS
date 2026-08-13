# Contributing to AEGIS

AEGIS is a monorepo. IDEA1, IDEA2, IDEA3, Infrastructure, and the Obsidian
knowledge base travel together so integration can be tested before `main`
changes.

## First setup

```bash
git clone https://github.com/kraveerachat/Project-End-The-AEGIS.git
cd Project-End-The-AEGIS
git remote -v
```

Contributors need Write access to push a branch to the main repository. A fork
may be used instead, but it must be synchronized from this repository's `main`
before each task.

## Start one task

Always start from current `main`:

```bash
git fetch origin
git switch main
git pull --ff-only origin main
```

IDEA1 example:

```bash
git switch -c feat/idea1-file-verification
```

IDEA2 example:

```bash
git switch -c feat/idea2-camera-routing
```

Infrastructure example:

```bash
git switch -c infra/twingate-server-path
```

Use one task branch for one outcome. Do not combine unrelated fixes.

## Work and verify

1. Read `AGENTS.md` and its required Obsidian notes.
2. Make the scoped source changes.
3. Run the affected tests/builds.
4. Review all changed paths:

```bash
git status --short
git diff --name-status origin/main...HEAD
```

5. Create exactly one Obsidian task receipt from
   `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/_template.md`.
6. Update the selected area's canonical note only when implementation facts changed.
7. Declare every path outside the selected area as a shared surface.

## Commit and publish the task branch

Stage explicit paths; do not use `git add .` until you have reviewed every
untracked file:

```bash
git add path/to/source path/to/test path/to/receipt
git diff --cached --check
git diff --cached --stat
git commit -m "feat(idea1): describe the outcome"
git push -u origin HEAD
```

Open a Pull Request into `main` and complete every section of the template.
The policy check requires a valid task area/owner, concrete verification,
exactly one new receipt, and declared shared paths.

## When another Pull Request merges first

Bring the new integration state into your task branch without rewriting the
published branch history:

```bash
git fetch origin
git merge origin/main
```

Resolve conflicts by reconciling both changes, run the affected tests again,
update the Pull Request verification, and push normally.

## Review and merge

The integration reviewer checks:

- task scope and changed paths;
- test/build evidence;
- Obsidian task receipt and canonical-note ownership;
- shared contracts, database, gateway, network, and deployment impact;
- absence of secrets/local/generated artifacts.

Merge only after checks pass. Delete the merged task branch. Do not force-push
or push directly to `main`.
