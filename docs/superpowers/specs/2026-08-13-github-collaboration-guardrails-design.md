# AEGIS GitHub Collaboration Guardrails Design

**Date:** 2026-08-13
**Status:** Approved for implementation

## Goal

Make `main` the tested integration source of truth while IDEA1, IDEA2, IDEA3,
and Infrastructure contributors work concurrently on task branches. Every task
must leave an auditable Pull Request and a conflict-resistant Obsidian update.

## Owners and current maturity

| Area | Owner | Current maturity |
|---|---|---|
| Core/integration | Kla (`kraveerachat`) | Overall structure about 60–70% settled; shared contracts can still evolve |
| IDEA1 | Kla (`kraveerachat`) | UI largely settled; backend and server deployment may still change |
| IDEA2 | Pub (`pubpup2006p-design`) | UI largely settled; identity/backend integration may still change |
| IDEA3 | Music | Design/report knowledge exists; implementation is not yet present in this repository |
| Infrastructure/network | Kla as integration reviewer | Active setup; server, Docker, VLAN, remote access, and deployment are not yet stable |

The IDEA3 GitHub username is not yet available. Until it is supplied, Kla is the
GitHub review owner for IDEA3 paths; the Obsidian receipt still records `music`
as the functional owner.

## Required task lifecycle

1. Fetch current `origin/main` and create one branch for one task.
2. Read `START_HERE.md`, the relevant module note, the outstanding-items note,
   and recent task receipts before editing.
3. Work primarily in the selected area. Shared changes are permitted only when
   technically required and must be declared.
4. Run affected tests and record exact evidence.
5. Create exactly one uniquely named Obsidian task receipt.
6. Update the area's canonical note when implementation facts or maturity change.
7. Push the task branch and open a Pull Request using the repository template.
8. Re-sync with `main` and re-run tests when another Pull Request merges first.
9. Merge only after policy checks pass and the integration reviewer accepts the diff.

## Obsidian update contract before the full vault restructure

The full folder migration is deferred. This guardrail change adds only the
minimum conflict-prevention structure required immediately:

```text
Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/
├── _template.md
└── YYYY-MM-DD_HHMMSS_<owner>_<topic>.md
```

Every task adds one receipt. Existing canonical notes remain in their current
paths and are routed by area. Shared/core notes are changed only by Kla or by a
Pull Request explicitly marked for integration review. Legacy `log.md` stops
receiving per-task append entries after this policy lands.

## Enforced repository surfaces

- `.github/PULL_REQUEST_TEMPLATE.md` supplies machine-readable task metadata
  and human review sections.
- `.github/CODEOWNERS` routes review requests by area.
- `.github/workflows/collaboration-guardrails.yml` runs the validator on Pull Requests.
- `scripts/validate-collaboration-policy.mjs` rejects missing receipts, invalid
  branch/owner/area combinations, absent verification, and undeclared cross-scope changes.
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and `.github/copilot-instructions.md`
  direct supported AI agents to the same canonical workflow.
- `CONTRIBUTING.md` gives the human team the equivalent Git commands and review process.

## Pull Request policy metadata

Each Pull Request body contains one block:

```text
<!-- collaboration-policy
area: idea1
owner: kla
integration-review: no
-->
```

Valid areas are `idea1`, `idea2`, `idea3`, `infrastructure`, and `shared`.
Valid owners are `kla`, `pub`, and `music`. Owner-area mismatches fail except
that Kla may own `infrastructure` and `shared` integration tasks.

Cross-scope paths are allowed only when `integration-review: yes` and the
`Shared surfaces touched` section is not `None`.

## Acceptance criteria

1. A valid IDEA1 Pull Request with one new Kla receipt passes.
2. A valid IDEA2 Pull Request with one new Pub receipt passes.
3. A Pull Request without an Obsidian receipt fails.
4. A Pull Request with an owner-area mismatch fails.
5. A Pull Request touching another area without integration review fails.
6. A declared cross-scope Pull Request passes.
7. The existing Docker bootstrap tests remain green.
8. The policy instructions do not claim that IDEA3 code or unfinished server/network setup is complete.

## Deferred web settings

After the branch is pushed, configure GitHub repository settings to require a
Pull Request for `main`, block force-push and branch deletion, enable update
branch, and grant the IDEA2 contributor Write access. These settings are
external to version-controlled files and require an authenticated GitHub UI/API
surface with repository-settings capability.
