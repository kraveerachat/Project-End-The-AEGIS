import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
}

function statusNote(owner, title) {
  return `---
title: ${title}
owner: ${owner}
edit_policy: owner-writable
---
# ${title}
`;
}

function receipt(owner, area, branch, change) {
  return `---
title: ${area} task
owner: ${owner}
area: ${area}
branch: ${branch}
status: complete
edit_policy: append-by-new-file
---
## What changed
${change}
## Source files changed
- owned status
## Verification evidence
- \`node --test\` — pass
## Canonical notes updated
- ${area} status
## Shared surfaces touched
- None
## Integration requests
- None
## Known limitations
- None
`;
}

test('two writers can merge owned status fragments and unique receipts without conflict', () => {
  const root = mkdtempSync(join(tmpdir(), 'aegis-two-writer-'));
  try {
    mkdirSync(join(root, 'idea1'), { recursive: true });
    mkdirSync(join(root, 'idea2'), { recursive: true });
    mkdirSync(join(root, '90-Status', 'logs'), { recursive: true });
    writeFileSync(join(root, 'idea1', 'idea1-status.md'), statusNote('kla', 'IDEA1'));
    writeFileSync(join(root, 'idea2', 'idea2-status.md'), statusNote('pub', 'IDEA2'));

    git(root, 'init', '-b', 'main');
    git(root, 'config', 'user.name', 'AEGIS test');
    git(root, 'config', 'user.email', 'aegis-test@example.invalid');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'baseline');

    git(root, 'switch', '-c', 'feat/idea1-parallel');
    writeFileSync(join(root, 'idea1', 'idea1-status.md'), `${statusNote('kla', 'IDEA1')}\nKla update\n`);
    writeFileSync(
      join(root, '90-Status', 'logs', '2026-08-13_180001_kla_parallel-test.md'),
      receipt('kla', 'idea1', 'feat/idea1-parallel', 'Kla update'),
    );
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'idea1 update');

    git(root, 'switch', 'main');
    git(root, 'switch', '-c', 'feat/idea2-parallel');
    mkdirSync(join(root, '90-Status', 'logs'), { recursive: true });
    writeFileSync(join(root, 'idea2', 'idea2-status.md'), `${statusNote('pub', 'IDEA2')}\nPub update\n`);
    writeFileSync(
      join(root, '90-Status', 'logs', '2026-08-13_180002_pub_parallel-test.md'),
      receipt('pub', 'idea2', 'feat/idea2-parallel', 'Pub update'),
    );
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'idea2 update');

    git(root, 'switch', 'main');
    git(root, 'merge', '--no-ff', 'feat/idea1-parallel', '-m', 'merge idea1');
    git(root, 'merge', '--no-ff', 'feat/idea2-parallel', '-m', 'merge idea2');

    assert.match(readFileSync(join(root, 'idea1', 'idea1-status.md'), 'utf8'), /Kla update/);
    assert.match(readFileSync(join(root, 'idea2', 'idea2-status.md'), 'utf8'), /Pub update/);
    assert.equal(existsSync(join(root, '90-Status', 'logs', '2026-08-13_180001_kla_parallel-test.md')), true);
    assert.equal(existsSync(join(root, '90-Status', 'logs', '2026-08-13_180002_pub_parallel-test.md')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
