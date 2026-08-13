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
    assert.ok(result.errors.some((error) => error.includes('color group')));
  });
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
