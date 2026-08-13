# Obsidian Workspace Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Core, IDEA1, IDEA2, IDEA3, and Infrastructure visibly and operationally separate in Obsidian while preserving reviewed cross-area links and immutable history.

**Architecture:** Keep one Git repository and one Vault. Each workstream uses a substantial MOC as its dashboard and owns its canonical notes; Core and the integration queue are the only planned bridges. Resolve historical top-level wikilinks with YAML aliases, configure Global Graph by path, and validate the workspace contract automatically.

**Tech Stack:** Obsidian Markdown/YAML/Wikilinks, Obsidian `graph.json`, Node.js `node:test`, Git/GitHub Pull Requests

**Spec:** `docs/superpowers/specs/2026-08-13-obsidian-workspace-separation-design.md`

## Global Constraints

- Open the Vault at `Obsidian_AEGIS_Vault/AEGIS_Knowledge`, never at repository root.
- Keep frozen `Obsidian_AEGIS_Vault/AEGIS_Knowledge/log.md` byte-for-byte unchanged.
- Preserve every non-empty user-authored note and every named project Canvas.
- Remove a legacy-name note or untitled Canvas only after verifying it is empty.
- Keep one task, one branch, one Pull Request, and one immutable receipt.
- Do not add a Dataview or other community-plugin dependency; dashboards use native Markdown and Obsidian search queries.
- Global Graph colors aid navigation; ownership remains enforced by frontmatter, Git policy, and review.

## File map

- `scripts/validate-vault.mjs`: owns general Vault validation and the new workspace-layout contract.
- `tests/vaultStructure.test.mjs`: owns regression tests for aliases, entry points, graph settings, and accidental empty files.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/.obsidian/graph.json`: owns the default Global Graph presentation.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/START_HERE.md`: routes a user or Agent into one workspace.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/core-moc.md`: new shared/Core dashboard and integration entry point.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/{idea1,idea2,idea3}/*-moc.md`: owner-specific operating dashboards.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/infrastructure-moc.md`: infrastructure operating dashboard.
- Seven canonical notes listed in Task 3: own aliases for former top-level names.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md` and `.schema.md`: catalog and document the workspace contract.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_162340_kla_obsidian-workspace-separation.md`: immutable task receipt.

---

### Task 1: Add failing workspace-contract tests

**Files:**
- Modify: `tests/vaultStructure.test.mjs`
- Test: `tests/vaultStructure.test.mjs`

**Interfaces:**
- Consumes: existing `withVault(files, run)` fixture helper.
- Produces: test contract for exported `validateWorkspaceLayout({ vaultDir })` returning `{ errors: string[], warnings: string[] }`.

- [ ] **Step 1: Import the new validator and add a complete workspace fixture**

Extend the import and add helpers with exact canonical aliases and graph groups:

```js
import { detectCaseCollisions, validateVault, validateWorkspaceLayout } from '../scripts/validate-vault.mjs';

const legacyAliases = {
  'core/system-overview.md': '00 - 🗺️ AEGIS System Overview',
  'core/hub-aegis-entry.md': '01 - 🚪 HUB-AEGIS Entry',
  'idea1/idea1-status.md': '02 - 💾 IDEA1 AEGIS Drive LC',
  'idea2/idea2-status.md': '03 - 📹 IDEA2 AEGIS Monitor',
  'idea3/idea3-status.md': '04 - 🔒 IDEA3 AEGIS Lockdown',
  'core/security-architecture.md': '05 - 🛡️ Security Architecture',
  'core/agent-operating-rules.md': '06 - 🤖 Agent Operating Rules',
  'core/design-system-ui-language.md': '07 - 🎨 Design System & UI Language',
};

function workspaceFiles() {
  const files = {
    'START_HERE.md': note({ policy: 'owner-only', body: '[[core/core-moc]]' }),
    'core/core-moc.md': note({ policy: 'owner-only' }),
    'idea1/idea1-moc.md': note(),
    'idea2/idea2-moc.md': note({ owner: 'pub' }),
    'idea3/idea3-moc.md': note({ owner: 'music' }),
    'infrastructure/infrastructure-moc.md': note(),
    '.obsidian/graph.json': JSON.stringify({
      search: '-path:"90-Status/logs" -file:"log" -path:"raw"',
      hideUnresolved: true,
      showOrphans: false,
      showArrow: true,
      colorGroups: ['core', 'idea1', 'idea2', 'idea3', 'infrastructure'].map((path) => ({
        query: `path:"${path}"`, color: { a: 1, rgb: 1 },
      })),
    }),
  };
  for (const [path, alias] of Object.entries(legacyAliases)) {
    const owner = path.startsWith('idea2/') ? 'pub' : path.startsWith('idea3/') ? 'music' : 'kla';
    const policy = path.startsWith('core/') ? 'owner-only' : 'owner-writable';
    files[path] = `---\ntitle: Test\naliases: ["${alias}"]\nowner: ${owner}\nedit_policy: ${policy}\n---\n# Test\n`;
  }
  return files;
}
```

- [ ] **Step 2: Test acceptance of the complete workspace contract**

```js
test('accepts separated workspaces, canonical aliases, and grouped graph settings', () => {
  withVault(workspaceFiles(), (root) => {
    assert.deepEqual(validateWorkspaceLayout({ vaultDir: root }).errors, []);
  });
});
```

- [ ] **Step 3: Test rejection of phantom legacy files and unsafe graph settings**

```js
test('rejects phantom legacy notes, empty untitled canvases, and an ungrouped graph', () => {
  const files = workspaceFiles();
  files['02 - 💾 IDEA1 AEGIS Drive LC.md'] = '';
  files['ยังไม่ได้ตั้งชื่อ.canvas'] = '{}';
  files['.obsidian/graph.json'] = JSON.stringify({
    search: '', hideUnresolved: false, showOrphans: true, showArrow: false, colorGroups: [],
  });
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('phantom legacy note')));
    assert.ok(result.errors.some((error) => error.includes('empty untitled canvas')));
    assert.ok(result.errors.some((error) => error.includes('hide unresolved')));
    assert.ok(result.errors.some((error) => error.includes('color group')));
  });
});
```

- [ ] **Step 4: Test preservation of non-empty owner files**

```js
test('warns instead of approving deletion when an untitled canvas contains data', () => {
  const files = workspaceFiles();
  files['ยังไม่ได้ตั้งชื่อ.canvas'] = '{"nodes":[{"id":"owner-data"}],"edges":[]}';
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.equal(result.errors.some((error) => error.includes('empty untitled canvas')), false);
    assert.ok(result.warnings.some((warning) => warning.includes('owner review')));
  });
});
```

- [ ] **Step 5: Run the tests and verify RED**

Run: `node --test tests/vaultStructure.test.mjs`

Expected: FAIL because `validateWorkspaceLayout` is not exported.

- [ ] **Step 6: Commit the failing tests**

```bash
git add tests/vaultStructure.test.mjs
git commit -m "test(vault): define workspace separation contract"
```

### Task 2: Implement the workspace validator

**Files:**
- Modify: `scripts/validate-vault.mjs`
- Test: `tests/vaultStructure.test.mjs`

**Interfaces:**
- Consumes: a Vault directory containing Markdown, Canvas, and `.obsidian/graph.json`.
- Produces: `validateWorkspaceLayout({ vaultDir }): { errors: string[], warnings: string[] }` and combines these results in the CLI output.

- [ ] **Step 1: Add exact workspace constants**

```js
const WORKSPACE_ENTRY_POINTS = [
  'START_HERE.md',
  'core/core-moc.md',
  'idea1/idea1-moc.md',
  'idea2/idea2-moc.md',
  'idea3/idea3-moc.md',
  'infrastructure/infrastructure-moc.md',
];

const LEGACY_ALIAS_TARGETS = new Map([
  ['00 - 🗺️ AEGIS System Overview', 'core/system-overview.md'],
  ['01 - 🚪 HUB-AEGIS Entry', 'core/hub-aegis-entry.md'],
  ['02 - 💾 IDEA1 AEGIS Drive LC', 'idea1/idea1-status.md'],
  ['03 - 📹 IDEA2 AEGIS Monitor', 'idea2/idea2-status.md'],
  ['04 - 🔒 IDEA3 AEGIS Lockdown', 'idea3/idea3-status.md'],
  ['05 - 🛡️ Security Architecture', 'core/security-architecture.md'],
  ['06 - 🤖 Agent Operating Rules', 'core/agent-operating-rules.md'],
  ['07 - 🎨 Design System & UI Language', 'core/design-system-ui-language.md'],
]);

const GRAPH_PATH_GROUPS = ['core', 'idea1', 'idea2', 'idea3', 'infrastructure'];
```

- [ ] **Step 2: Add `validateWorkspaceLayout`**

Implement the exported function so it:

1. verifies every entry point exists;
2. parses each canonical target and requires exactly one matching alias;
3. rejects root files named after legacy aliases;
4. rejects untitled Canvas files only when trimmed content is empty or `{}`;
5. warns when an untitled Canvas has real content;
6. parses `.obsidian/graph.json` and requires:
   - `hideUnresolved === true`;
   - `showOrphans === false`;
   - `showArrow === true`;
   - search exclusions for `90-Status/logs`, `log`, and `raw`;
   - one color group for every value in `GRAPH_PATH_GROUPS`.

Use stable messages beginning with:

```text
Missing workspace entry point:
Missing canonical legacy alias:
Root phantom legacy note must be removed:
Empty untitled canvas must be removed:
Global Graph must hide unresolved links.
Global Graph is missing path color group:
```

- [ ] **Step 3: Combine workspace validation in CLI mode**

After `validateVault`, run `validateWorkspaceLayout`, merge deduplicated errors and
warnings, and preserve the current non-zero exit behavior when any error exists.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `node --test tests/vaultStructure.test.mjs`

Expected: all Vault structure tests PASS.

- [ ] **Step 5: Run collaboration regression tests**

Run: `node --test tests/collaborationPolicy.test.mjs tests/vaultMultiWriter.test.mjs`

Expected: all tests PASS; receipt ownership and concurrent-writer behavior remain unchanged.

- [ ] **Step 6: Commit the validator**

```bash
git add scripts/validate-vault.mjs
git commit -m "feat(vault): validate separated workspaces"
```

### Task 3: Build operational dashboards and graph grouping

**Files:**
- Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/core-moc.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/START_HERE.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-moc.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/infrastructure-moc.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/.schema.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/.obsidian/graph.json`
- Test: `tests/vaultStructure.test.mjs`

**Interfaces:**
- Consumes: ownership model in `AGENTS.md` and existing canonical status notes.
- Produces: five workspace dashboards plus a grouped, filtered Global Graph.

- [ ] **Step 1: Create the Core/shared MOC**

Create `core/core-moc.md` with frontmatter:

```yaml
---
title: AEGIS Core and Integration MOC
tags: [aegis, core, shared, integration, moc]
type: moc
created: 2026-08-13
updated: 2026-08-13
owner: kla
edit_policy: owner-only
---
```

Its sections must be `Purpose`, `Owner and write boundary`, `Canonical contracts`,
`Integration queue`, `Shared verification`, and `Finish a shared task`. Link only
Core notes, `.schema.md`, `90-Status/integration-queue.md`, receipt template, and
the four area MOCs.

- [ ] **Step 2: Expand each area MOC into an operating dashboard**

Use the same section contract in IDEA1, IDEA2, IDEA3, and Infrastructure:

```markdown
## Start here
## Owned source and canonical notes
## Current state and open work
## Shared dependencies
## Recent task receipts
## Finish an area task
```

Under `Recent task receipts`, use a native Obsidian query with the correct owner:

````markdown
```query
path:"90-Status/logs" [owner:kla]
```
````

IDEA2 uses `pub`; IDEA3 uses `music`. Infrastructure uses `kla` but labels the
section as infrastructure-related receipt discovery because Kla also owns IDEA1.

- [ ] **Step 3: Route `START_HERE` through the five dashboards**

Add `[[core/core-moc]]` and make the workspace selector explicit. Preserve system
orientation and the existing architecture Mermaid diagram; do not duplicate area
implementation detail into `START_HERE.md`.

- [ ] **Step 4: Configure Global Graph**

Set:

```json
{
  "search": "-path:\"90-Status/logs\" -file:\"log\" -path:\"raw\"",
  "showTags": false,
  "showAttachments": false,
  "hideUnresolved": true,
  "showOrphans": false,
  "colorGroups": [
    { "query": "path:\"core\"", "color": { "a": 1, "rgb": 2201331 } },
    { "query": "path:\"idea1\"", "color": { "a": 1, "rgb": 2566339 } },
    { "query": "path:\"idea2\"", "color": { "a": 1, "rgb": 2924588 } },
    { "query": "path:\"idea3\"", "color": { "a": 1, "rgb": 10040012 } },
    { "query": "path:\"infrastructure\"", "color": { "a": 1, "rgb": 14652444 } },
    { "query": "path:\"concepts\" OR path:\"entities\" OR path:\"ethics\"", "color": { "a": 1, "rgb": 7161261 } }
  ],
  "showArrow": true
}
```

Preserve existing force, scale, collapse, and node/line multiplier settings.

- [ ] **Step 5: Update the catalog and schema**

Add `core/core-moc.md` to `index.md`. Update `.schema.md` to state that Global Graph
is an overview and area work starts from MOCs/Local Graph. Document aliases as the
required compatibility mechanism for frozen historical links.

- [ ] **Step 6: Run focused validation**

Run: `node --test tests/vaultStructure.test.mjs`

Expected: all fixture-based Vault structure tests PASS. The live Vault CLI check is
deferred until Task 4 because canonical aliases and accidental files are not yet handled.

- [ ] **Step 7: Commit dashboards and graph configuration**

```bash
git add Obsidian_AEGIS_Vault/AEGIS_Knowledge/.obsidian/graph.json \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/START_HERE.md \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/core-moc.md \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-moc.md \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-moc.md \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-moc.md \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/infrastructure-moc.md \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/index.md \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/.schema.md
git commit -m "docs(vault): add separated workspace dashboards"
```

### Task 4: Resolve legacy links and remove verified accidental files

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/system-overview.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/hub-aegis-entry.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/security-architecture.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/agent-operating-rules.md`
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/design-system-ui-language.md`
- Remove only if still empty: root legacy IDEA1/IDEA2 Markdown files and three untitled Canvas files
- Test: `tests/vaultStructure.test.mjs`

**Interfaces:**
- Consumes: `LEGACY_ALIAS_TARGETS` from Task 2.
- Produces: exactly one canonical resolution for each frozen historical link and no phantom root nodes.

- [ ] **Step 1: Re-check accidental-file contents immediately before removal**

Run:

```powershell
Get-Item -LiteralPath `
  'Obsidian_AEGIS_Vault/AEGIS_Knowledge/02 - 💾 IDEA1 AEGIS Drive LC.md', `
  'Obsidian_AEGIS_Vault/AEGIS_Knowledge/03 - 📹 IDEA2 AEGIS Monitor.md', `
  'Obsidian_AEGIS_Vault/AEGIS_Knowledge/ยังไม่ได้ตั้งชื่อ.canvas', `
  'Obsidian_AEGIS_Vault/AEGIS_Knowledge/ยังไม่ได้ตั้งชื่อ 1.canvas', `
  'Obsidian_AEGIS_Vault/AEGIS_Knowledge/ยังไม่ได้ตั้งชื่อ 2.canvas' `
  -ErrorAction SilentlyContinue | Select-Object FullName,Length
```

Expected: Markdown files are 0 bytes; Canvas files are 2 bytes and contain `{}`.
If any file differs, do not remove it; report it for owner review.

- [ ] **Step 2: Add one unique alias to each canonical note**

Use YAML list syntax, for example:

```yaml
aliases: ["02 - 💾 IDEA1 AEGIS Drive LC"]
```

Apply the exact alias map from Task 2. Do not add the same alias to both
`core/system-overview.md` and `core/system-context.md`.

- [ ] **Step 3: Remove only files proven empty in Step 1**

Delete those exact paths with a reviewed patch. Do not use wildcards or recursive
deletion. Keep `AEGIS_Architecture_Canvas.canvas` and
`AEGIS_Knowledge_Network.canvas`.

- [ ] **Step 4: Verify frozen history is unchanged**

Run: `git diff --exit-code HEAD -- Obsidian_AEGIS_Vault/AEGIS_Knowledge/log.md`

Expected: exit 0 with no output.

- [ ] **Step 5: Run workspace and full Vault validation**

Run:

```bash
node --test tests/vaultStructure.test.mjs
node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
```

Expected: both commands PASS with no workspace-contract errors. Genuine orphan
canonical notes may remain warnings only.

- [ ] **Step 6: Commit aliases and cleanup**

```bash
git add Obsidian_AEGIS_Vault/AEGIS_Knowledge/core \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md \
  Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md
git commit -m "fix(vault): resolve legacy workspace links"
```

### Task 5: Record, verify, and publish the completed migration

**Files:**
- Create: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_162340_kla_obsidian-workspace-separation.md`
- Verify: all files changed by Tasks 1–4

**Interfaces:**
- Consumes: completed workspace migration and test output.
- Produces: immutable evidence, pushed branch, and a reviewable stacked Pull Request.

- [ ] **Step 1: Create the immutable receipt**

Copy `_template.md`. Use:

```yaml
owner: kla
area: shared
branch: codex/obsidian-workspace-separation
status: complete
edit_policy: append-by-new-file
```

List every changed MOC, canonical alias target, graph config, validator, test, spec,
and plan under exact paths. Record `integration-review: yes` in the PR because this
changes shared navigation and governance surfaces.

- [ ] **Step 2: Run fresh full verification**

Run:

```bash
node --test tests/*.test.mjs
node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge
git diff --check
git diff --name-status origin/codex/obsidian-multi-writer-restructure...HEAD
git status --short
```

Expected: all tests PASS; Vault validation exits 0; no whitespace errors; only
intentional task files and the one new receipt appear.

- [ ] **Step 3: Commit the receipt and final documentation**

```bash
git add Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_162340_kla_obsidian-workspace-separation.md
git diff --cached --check
git commit -m "docs(vault): record workspace separation"
```

- [ ] **Step 4: Push the branch**

```bash
git push -u origin codex/obsidian-workspace-separation
```

- [ ] **Step 5: Open a stacked Draft Pull Request**

Base the PR on the branch that contains the accepted Obsidian restructure and latest
collaboration rules. Include:

```text
area: shared
owner: kla
integration-review: yes
```

List all cross-scope paths in both PR `Shared surfaces touched` and the receipt.
After prerequisite PRs merge, change the base to `main`, update the branch, rerun all
verification, mark Ready, obtain review, and merge through GitHub.

- [ ] **Step 6: Perform the manual Obsidian acceptance check**

Reload Obsidian, open Global Graph, and verify distinct path colors without legacy
or empty Canvas nodes. Open each MOC and confirm Local Graph shows the area plus its
immediate Core/integration boundaries. Confirm old IDEA1/IDEA2 link clicks open the
canonical populated status notes.
