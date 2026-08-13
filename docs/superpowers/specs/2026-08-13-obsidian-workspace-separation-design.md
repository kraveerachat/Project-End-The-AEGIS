# Obsidian Workspace Separation Design

Date: 2026-08-13
Status: approved direction; implementation pending
Owner: Kla
Branch: `codex/obsidian-workspace-separation`

## 1. Problem statement

The previous restructure moved canonical notes into `core/`, `idea1/`, `idea2/`,
`idea3/`, and `infrastructure/`, and introduced immutable per-task receipts. That
solved the file-level multi-writer problem, but the Obsidian user experience still
looks and behaves like one dense knowledge cluster.

Evidence from the live vault shows three separate causes:

1. `.obsidian/graph.json` has no color groups, shows orphan nodes, and shows
   unresolved links. Therefore folder ownership is invisible in Global Graph.
2. Frozen `log.md` contains historical links such as
   `[[02 - 💾 IDEA1 AEGIS Drive LC]]` and `[[03 - 📹 IDEA2 AEGIS Monitor]]`.
   These old names appear as unresolved graph nodes even though their canonical
   notes moved to `idea1/idea1-status.md` and `idea2/idea2-status.md`.
3. Clicking an unresolved historical node causes Obsidian to create a new empty
   Markdown file at the vault root. The observed IDEA1 and IDEA2 legacy-name files
   are empty and are not the real status notes. Three untitled Canvas files contain
   only an empty Canvas object.

The goal is not to force all legitimate relationships apart. The goal is to make
each workstream independently navigable and writable while preserving a small,
intentional integration layer.

## 2. Chosen architecture

Use one Git repository and one Obsidian vault with five clearly bounded workspaces:

```text
AEGIS_Knowledge/
├── core/                 # shared system contracts and governance
├── idea1/                # Kla-owned IDEA1 workspace
├── idea2/                # Pub-owned IDEA2 workspace
├── idea3/                # Music-owned IDEA3 workspace
├── infrastructure/       # Kla-owned runtime/network/server workspace
└── 90-Status/
    ├── logs/             # immutable per-task receipts
    └── integration-queue.md
```

Each workstream gets one primary MOC as its human and agent entry point. Cross-area
links remain valid only when they represent a real shared contract. `core/` and
`90-Status/integration-queue.md` are the intended bridges between workstreams.

Separate physical Vaults were rejected because they would duplicate Core knowledge,
make cross-module contracts drift, and complicate Git review. Disconnecting all
links was rejected because it would make the graph visually tidy by destroying real
architecture information.

## 3. Workspace entry points

`START_HERE.md` remains the only repository-wide entry point. It routes users and
agents to one of these operational dashboards:

- `idea1/idea1-moc.md`
- `idea2/idea2-moc.md`
- `idea3/idea3-moc.md`
- `infrastructure/infrastructure-moc.md`
- a Core/shared MOC for integration and governance

Each area MOC will provide:

- ownership and writable boundary;
- source-code directories;
- current status and open work;
- area-owned canonical notes;
- latest area receipts or a query/filter for them;
- cross-area dependencies;
- exact integration path when another owner must act.

The MOCs are operating dashboards, not small link lists. A contributor should be
able to start and finish an area task without consulting Global Graph.

## 4. Graph behavior

Global Graph becomes a system overview, not the work queue.

The shared graph configuration will:

- color `path:core` as the shared/core group;
- color `path:idea1`, `path:idea2`, and `path:idea3` distinctly;
- color `path:infrastructure` distinctly;
- color shared Concepts/Entities/Ethics separately;
- hide unresolved links so old aliases cannot masquerade as real notes;
- hide orphans so empty Canvas/accidental files do not dominate the graph;
- hide attachments;
- filter immutable receipts and frozen legacy history from the default overview;
- keep arrows enabled so dependency direction is easier to interpret.

Area-level work is viewed through an area MOC and Local Graph. The local depth will
be intentionally small so a contributor sees owned notes and immediate integration
boundaries rather than the entire vault.

Folder color is a navigation aid, not an ownership control. Git policy and note
frontmatter remain the source of enforcement.

## 5. Legacy-link and empty-file handling

Historical evidence must remain readable without generating phantom nodes.

The migration will replace only obsolete wikilink targets with their canonical
targets, including:

- `[[02 - 💾 IDEA1 AEGIS Drive LC]]` → `[[idea1/idea1-status|02 - 💾 IDEA1 AEGIS Drive LC]]`
- `[[03 - 📹 IDEA2 AEGIS Monitor]]` → `[[idea2/idea2-status|03 - 📹 IDEA2 AEGIS Monitor]]`
- equivalent moved Core and IDEA3 legacy names where still present

Visible historical wording remains unchanged through link aliases. Commit hashes,
dates, commands, and task evidence in frozen `log.md` remain untouched.

Before removal, each suspected accidental file will be checked for size and content.
Only files proven empty will be removed:

- root-level legacy-name IDEA1/IDEA2 notes containing zero bytes;
- untitled Canvas files containing only an empty JSON object.

Canonical moved notes and named project canvases will never be removed.

## 6. Parallel-work workflow

Each contributor selects one area before creating a branch:

| Contributor | Area | Canonical writes | Task receipt pattern |
|---|---|---|---|
| Kla | IDEA1 | `idea1/**` | `90-Status/logs/*_kla_*.md` |
| Pub | IDEA2 | `idea2/**` | `90-Status/logs/*_pub_*.md` |
| Music | IDEA3 | `idea3/**` | `90-Status/logs/*_music_*.md` |
| Kla/integration reviewer | Infrastructure/Core | `infrastructure/**`, reviewed `core/**` | `*_kla_*.md` |

An area branch may read all workspaces but writes only its owned canonical notes.
Required changes outside that area are declared as exact paths in the PR and receipt.
The receiving owner reconciles durable facts through the integration queue. Every
branch creates a unique receipt, so concurrent tasks do not append to the same log.

## 7. Validation and acceptance criteria

Automated validation will verify:

- every canonical Markdown note has valid `owner` and `edit_policy` metadata;
- the five workspace entry points exist and link to their area status;
- obsolete unresolved legacy targets are absent from active Markdown links;
- no zero-byte root legacy notes or empty untitled Canvas files remain;
- graph configuration defines the expected path color groups;
- graph configuration hides unresolved links and orphan nodes by default;
- existing wikilinks resolve;
- collaboration and multi-writer tests continue to pass.

Manual acceptance in Obsidian:

1. Open `Obsidian_AEGIS_Vault/AEGIS_Knowledge` as the Vault.
2. Restart or reload Obsidian so it re-indexes links and graph settings.
3. Open Global Graph and see distinct Core, IDEA1, IDEA2, IDEA3, Infrastructure,
   and supporting-knowledge colors without empty legacy/Canvas nodes.
4. Open each area MOC and use Local Graph to see that area's notes plus only its
   immediate shared boundaries.
5. Click IDEA1/IDEA2 links and confirm they open the canonical status notes with
   content, not blank root-level files.

## 8. Git rollout

This task is stacked on the existing Obsidian restructure and collaboration-policy
branches. Implementation will remain on `codex/obsidian-workspace-separation`, add
one immutable task receipt, run all vault/collaboration tests, push the branch, and
open a Pull Request against its current dependency branch. It must not be merged to
`main` before the prerequisite restructure and guardrail PRs are merged or rebased
cleanly.

No user-authored non-empty note will be deleted automatically. If an apparently
accidental file contains content at implementation time, the migration stops for
that file and reports it for owner review.
