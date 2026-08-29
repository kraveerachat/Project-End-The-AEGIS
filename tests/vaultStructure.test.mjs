import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectCaseCollisions, validateVault, validateWorkspaceLayout } from '../scripts/validate-vault.mjs';

function withVault(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'aegis-vault-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(root, relativePath);
      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, content, 'utf8');
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const note = ({ owner = 'kla', policy = 'owner-writable', body = '' } = {}) => `---
title: Test
owner: ${owner}
edit_policy: ${policy}
---
# Test
${body}
`;

const receipt = ({ owner, area }) => `---
title: Test receipt
owner: ${owner}
area: ${area}
branch: feat/idea2-canonical-runtime-main-reconcile
status: complete
edit_policy: append-by-new-file
---
## What changed
Done.
## Source files changed
- \`test\`
## Verification evidence
- \`node --test\` — pass.
## Canonical notes updated
None.
## Shared surfaces touched
- \`scripts/validate-vault.mjs\`
## Integration requests
Review required.
## Known limitations
None.
`;

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
    'START_HERE.md': note({
      policy: 'owner-only',
      body: '[[core/core-moc]] [[idea1/idea1-moc]] [[idea2/idea2-moc]] [[idea3/idea3-moc]] [[infrastructure/infrastructure-moc]]',
    }),
    'core/core-moc.md': note({
      policy: 'owner-only',
      body: '[[core/system-overview]] [[idea1/idea1-moc]] [[idea2/idea2-moc]] [[idea3/idea3-moc]] [[infrastructure/infrastructure-moc]]',
    }),
    'idea1/idea1-moc.md': note({ body: '[[idea1/idea1-status]]' }),
    'idea2/idea2-moc.md': note({ owner: 'pub', body: '[[idea2/idea2-status]]' }),
    'idea3/idea3-moc.md': note({ owner: 'music', body: '[[idea3/idea3-status]]' }),
    'infrastructure/infrastructure-moc.md': note({ body: '[[90-Status/Open-Items-Backlog]]' }),
    '.obsidian/graph.json': JSON.stringify({
      search: '-path:"90-Status/logs" -file:"log" -path:"raw"',
      showAttachments: false,
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

test('accepts owned notes and resolvable wikilinks', () => {
  withVault({
    'core/system-overview.md': note({ policy: 'owner-only', body: '[[idea1/idea1-status]]' }),
    'idea1/idea1-status.md': note(),
  }, (root) => {
    const result = validateVault({ vaultDir: root });
    assert.deepEqual(result.errors, []);
  });
});

test('rejects missing ownership metadata and broken wikilinks', () => {
  withVault({ 'bad.md': '# Bad\n[[missing-note]]\n' }, (root) => {
    const result = validateVault({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('owner')));
    assert.ok(result.errors.some((error) => error.includes('edit_policy')));
    assert.ok(result.errors.some((error) => error.includes('Unresolved wikilink')));
  });
});

test('rejects case-colliding note paths', () => {
  assert.deepEqual(detectCaseCollisions([
    'concepts/Status.md',
    'concepts/status.md',
  ]), [['concepts/Status.md', 'concepts/status.md']]);
});

test('validates immutable task receipt naming and required sections', () => {
  withVault({
    '90-Status/logs/2026-08-13_180000_pub_monitor-ui.md': `---
title: Monitor UI task receipt
owner: pub
area: idea2
branch: feat/monitor-ui
status: complete
edit_policy: append-by-new-file
---
## What changed
Done.
`,
  }, (root) => {
    const result = validateVault({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('Verification evidence')));
    assert.ok(result.errors.some((error) => error.includes('Canonical notes updated')));
  });
});

test('accepts task receipts only when owner matches the policy mapping for their area', () => {
  const areaOwners = new Map([
    ['idea1', 'kla'],
    ['idea2', 'pub'],
    ['idea3', 'music'],
    ['infrastructure', 'kla'],
    ['shared', 'kla'],
  ]);

  for (const [area, owner] of areaOwners) {
    withVault({
      [`90-Status/logs/2026-08-29_180000_${owner}_${area}-task.md`]: receipt({ owner, area }),
    }, (root) => {
      const result = validateVault({ vaultDir: root });
      assert.deepEqual(result.errors, [], `${area} should require ${owner}`);
    });
  }
});

test('rejects a receipt owner that matches the filename but not the receipt area', () => {
  withVault({
    '90-Status/logs/2026-08-29_180000_pub_wrong-area-owner.md': receipt({ owner: 'pub', area: 'idea1' }),
  }, (root) => {
    const result = validateVault({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('owner for area idea1 must be kla, received pub')));
  });
});

test('rejects a receipt without a recognized task area', () => {
  withVault({
    '90-Status/logs/2026-08-29_180000_kla_unknown-area.md': receipt({ owner: 'kla', area: 'unknown' }),
  }, (root) => {
    const result = validateVault({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('receipt area must be one of')));
  });
});

test('rejects writes to the frozen legacy log', () => {
  withVault({ 'log.md': note({ policy: 'owner-only' }) }, (root) => {
    const result = validateVault({ vaultDir: root, changedFiles: ['Obsidian_AEGIS_Vault/AEGIS_Knowledge/log.md'] });
    assert.ok(result.errors.some((error) => error.includes('Legacy log.md is frozen')));
  });
});

test('reports orphan notes as warnings, not errors', () => {
  withVault({
    'START_HERE.md': note({ policy: 'owner-only' }),
    'concepts/orphan.md': note(),
  }, (root) => {
    const result = validateVault({ vaultDir: root });
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some((warning) => warning.includes('orphan')));
  });
});

test('accepts separated workspaces, canonical aliases, and grouped graph settings', () => {
  withVault(workspaceFiles(), (root) => {
    assert.deepEqual(validateWorkspaceLayout({ vaultDir: root }).errors, []);
  });
});

test('rejects a missing or wrong canonical alias', () => {
  const missingAliasFiles = workspaceFiles();
  missingAliasFiles['core/system-overview.md'] = missingAliasFiles['core/system-overview.md']
    .replace('00 - 🗺️ AEGIS System Overview', 'Not the canonical alias');
  withVault(missingAliasFiles, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('Missing canonical legacy alias')));
  });
});

test('rejects a canonical legacy alias declared by more than one note', () => {
  const files = workspaceFiles();
  files['concepts/duplicate-overview.md'] = `---
title: Duplicate
aliases: ["00 - 🗺️ AEGIS System Overview"]
owner: kla
edit_policy: owner-writable
---
# Duplicate
`;
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('must resolve exactly once')));
  });
});

test('rejects a missing required workspace entry point', () => {
  const files = workspaceFiles();
  delete files['idea3/idea3-moc.md'];
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('Missing workspace entry point')));
  });
});

test('rejects a workspace entry point missing a required canonical route', () => {
  const cases = [
    ['START_HERE.md', '[[idea2/idea2-moc]]'],
    ['core/core-moc.md', '[[infrastructure/infrastructure-moc]]'],
    ['idea1/idea1-moc.md', '[[idea1/idea1-status]]'],
    ['idea2/idea2-moc.md', '[[idea2/idea2-status]]'],
    ['idea3/idea3-moc.md', '[[idea3/idea3-status]]'],
    ['infrastructure/infrastructure-moc.md', '[[90-Status/Open-Items-Backlog]]'],
  ];

  for (const [entryPoint, requiredLink] of cases) {
    const files = workspaceFiles();
    files[entryPoint] = files[entryPoint].replace(requiredLink, '');
    withVault(files, (root) => {
      const result = validateWorkspaceLayout({ vaultDir: root });
      assert.ok(
        result.errors.some((error) => error.includes(`Workspace entry point is missing required link: ${entryPoint}`)),
        `${entryPoint} should require ${requiredLink}`,
      );
    });
  }
});

test('rejects phantom legacy files, empty untitled canvases, and an ungrouped graph', () => {
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
    assert.ok(result.errors.some((error) => error.includes('90-Status/logs')));
    assert.ok(result.errors.some((error) => error.includes('show orphans')));
    assert.ok(result.errors.some((error) => error.includes('arrow')));
    assert.ok(result.errors.some((error) => error.includes('color group')));
  });
});

test('rejects each missing Global Graph search exclusion independently', () => {
  const cases = [
    {
      search: '-file:"log" -path:"raw"',
      matches: (error) => error.includes('90-Status/logs'),
    },
    {
      search: '-path:"90-Status/logs" -path:"raw"',
      matches: (error) => /\blog\b/.test(error),
    },
    {
      search: '-path:"90-Status/logs" -file:"log"',
      matches: (error) => error.includes('raw'),
    },
  ];

  for (const { search, matches } of cases) {
    const files = workspaceFiles();
    files['.obsidian/graph.json'] = JSON.stringify({
      search,
      hideUnresolved: true,
      showOrphans: false,
      showArrow: true,
      colorGroups: ['core', 'idea1', 'idea2', 'idea3', 'infrastructure'].map((path) => ({
        query: `path:"${path}"`, color: { a: 1, rgb: 1 },
      })),
    });
    withVault(files, (root) => {
      const result = validateWorkspaceLayout({ vaultDir: root });
      assert.ok(result.errors.some(matches));
    });
  }
});

test('warns instead of approving deletion when an untitled canvas contains data', () => {
  const files = workspaceFiles();
  files['ยังไม่ได้ตั้งชื่อ.canvas'] = '{"nodes":[{"id":"owner-data"}],"edges":[]}';
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.equal(result.errors.some((error) => error.includes('empty untitled canvas')), false);
    assert.ok(result.warnings.some((warning) => warning.includes('owner review')));
  });
});

test('blocks a non-empty legacy-name shadow while preserving owner data for review', () => {
  const files = workspaceFiles();
  files['02 - 💾 IDEA1 AEGIS Drive LC.md'] = note({ body: 'Owner-authored legacy content.' });
  files['AEGIS_Architecture_Canvas.canvas'] = '{"nodes":[{"id":"architecture"}],"edges":[]}';
  files['AEGIS_Knowledge_Network.canvas'] = '{"nodes":[{"id":"knowledge"}],"edges":[]}';
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('shadows canonical alias')));
    assert.equal(result.errors.some((error) => error.includes('empty untitled canvas')), false);
    assert.ok(result.warnings.some((warning) => warning.includes('owner review')));
  });
});

test('preserves a legacy root note whose owner content is JSON braces', () => {
  const files = workspaceFiles();
  files['02 - 💾 IDEA1 AEGIS Drive LC.md'] = '{}';
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('shadows canonical alias')));
    assert.ok(result.warnings.some((warning) => warning.includes('owner review')));
  });
});

test('validates empty and non-empty untitled canvases in nested directories', () => {
  const files = workspaceFiles();
  files['drafts/ยังไม่ได้ตั้งชื่อ.canvas'] = '{}';
  files['owner-data/ยังไม่ได้ตั้งชื่อ 1.canvas'] = '{"nodes":[{"id":"owner-data"}],"edges":[]}';
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('drafts/ยังไม่ได้ตั้งชื่อ.canvas')));
    assert.ok(result.warnings.some((warning) => warning.includes('owner-data/ยังไม่ได้ตั้งชื่อ 1.canvas')));
  });
});

test('accepts canonical aliases written as YAML block lists', () => {
  const files = workspaceFiles();
  files['core/system-overview.md'] = files['core/system-overview.md'].replace(
    'aliases: ["00 - 🗺️ AEGIS System Overview"]',
    'aliases:\n  - "00 - 🗺️ AEGIS System Overview"',
  );
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.equal(result.errors.some((error) => error.includes('Missing canonical legacy alias')), false);
  });
});

test('rejects non-object Global Graph JSON values', () => {
  for (const graphValue of ['null', 'false', '0', '[]', '"graph"']) {
    const files = workspaceFiles();
    files['.obsidian/graph.json'] = graphValue;
    withVault(files, (root) => {
      const result = validateWorkspaceLayout({ vaultDir: root });
      assert.ok(result.errors.some((error) => error.includes('non-null plain object')));
    });
  }
});

test('rejects negative Global Graph color-group queries', () => {
  const files = workspaceFiles();
  const graph = JSON.parse(files['.obsidian/graph.json']);
  graph.colorGroups[0].query = '-path:"core"';
  files['.obsidian/graph.json'] = JSON.stringify(graph);
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('missing path color group: core')));
  });
});

test('rejects a Global Graph that shows attachments', () => {
  const files = workspaceFiles();
  const graph = JSON.parse(files['.obsidian/graph.json']);
  graph.showAttachments = true;
  files['.obsidian/graph.json'] = JSON.stringify(graph);
  withVault(files, (root) => {
    const result = validateWorkspaceLayout({ vaultDir: root });
    assert.ok(result.errors.some((error) => error.includes('hide attachments')));
  });
});
