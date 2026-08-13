import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectCaseCollisions, validateVault } from '../scripts/validate-vault.mjs';

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
