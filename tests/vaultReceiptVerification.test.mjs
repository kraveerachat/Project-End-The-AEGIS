import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { validateVault } from '../scripts/validate-vault.mjs';

const RECEIPT_PATH = '90-Status/logs/2026-10-08_210831_music_idea3-pr405-b1-review.md';

function receipt(verification, ending = '\n') {
  return [
    '---',
    'title: Test receipt',
    'owner: music',
    'area: idea3',
    'branch: codex/pr405-b1-fix',
    'status: partial',
    'edit_policy: append-by-new-file',
    '---',
    '# Test receipt',
    '',
    '## What changed',
    '- Fixture.',
    '',
    '## Source files changed',
    '- `scripts/validate-vault.mjs`',
    '',
    '## Verification evidence',
    verification,
    '',
    '## Canonical notes updated',
    '- None.',
    '',
    '## Shared surfaces touched',
    '- None.',
    '',
    '## Integration requests',
    '- None.',
    '',
    '## Known limitations',
    '- None.',
  ].join('\n') + ending;
}

function withReceipt(content, run) {
  const root = mkdtempSync(join(tmpdir(), 'aegis-vault-receipt-'));
  try {
    const path = join(root, RECEIPT_PATH);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content, 'utf8');
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function errorsFor(content) {
  let result;
  withReceipt(content, (root) => { result = validateVault({ vaultDir: root }); });
  return result.errors;
}

function assertValid(content) {
  assert.deepEqual(errorsFor(content), []);
}

function assertInvalidVerification(content) {
  assert.ok(
    errorsFor(content).some((error) => error.includes('Verification evidence')),
  );
}

test('accepts multiline verification evidence after a blocked first entry', () => {
  assertValid(receipt([
    '- `python3 -m pytest ...` — blocked: pytest unavailable.',
    '- `/usr/bin/pytest tests/...` — pass: 33 passed, 1 xfailed.',
    '- `git diff --check` — pass.',
  ].join('\n')));
});

test('accepts valid single-line verification evidence', () => {
  assertValid(receipt('- `node --test tests/vaultStructure.test.mjs` — pass: 1 passed.'));
});

test('rejects verification evidence with no command', () => {
  assertInvalidVerification(receipt('- blocked: pytest unavailable.'));
});

test('rejects verification evidence with no genuine pass/fail result', () => {
  assertInvalidVerification(receipt('- `node --test tests/example.test.mjs` — blocked before collection.'));
});

test('rejects an empty verification evidence section', () => {
  assertInvalidVerification(receipt(''));
});

test('does not borrow PASS from the next H2 section', () => {
  assertInvalidVerification(receipt([
    '- `python3 -m pytest ...` — blocked: pytest unavailable.',
    '',
    '## Later section',
    '- `node --test` — pass.',
  ].join('\n')));
});

test('accepts multiple commands when at least one has a genuine result', () => {
  assertValid(receipt([
    '- `python3 -m pytest ...` — blocked: pytest unavailable.',
    '- `git diff --check` — pass.',
  ].join('\n')));
});

test('handles CRLF receipt line endings', () => {
  assertValid(receipt([
    '- `node --test tests/vaultReceiptVerification.test.mjs` — pass: 8 passed.',
    '- `git diff --check` — pass.',
  ].join('\n'), '\r\n').replace(/\n/g, '\r\n'));
});

test('accepts the PR405 receipt evidence shape without changing the receipt', () => {
  assertValid(receipt([
    '- `python3 -m pytest tests/test_pr11_phase4_lvr_l8_l9_offline_contract.py -q -rx` — blocked: pytest unavailable.',
    '- `/usr/bin/pytest tests/test_pr11_phase4_lvr_l8_l9_offline_contract.py -q -rx` — pass: 33 passed, 1 strict expected xfail.',
    '- `git diff --check` — pass.',
  ].join('\n')));
});
