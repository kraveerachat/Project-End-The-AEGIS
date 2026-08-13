import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const validatorPath = resolve('scripts/validate-collaboration-policy.mjs');

function validBody({
  area = 'idea1',
  owner = 'kla',
  integrationReview = 'no',
  sharedSurfaces = 'None',
} = {}) {
  return `<!-- collaboration-policy
area: ${area}
owner: ${owner}
integration-review: ${integrationReview}
-->

## Summary
- Implement the scoped task.

## Verification
- \`node --test\` — pass

## Obsidian receipt
- \`Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_${owner}_policy-test.md\`

## Canonical notes updated
- Relevant area status note.

## Shared surfaces touched
${sharedSurfaces}

## Known limitations
None
`;
}

function validReceipt({
  area,
  owner,
  branch,
  sharedSurfaces = '- None — scoped task.',
  integrationRequests = '- None',
}) {
  return `---
title: Task Receipt — Policy test
date: 2026-08-13T17:00:00+07:00
owner: ${owner}
area: ${area}
branch: ${branch}
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — Policy test

## What changed
- Tested the policy.

## Source files changed
- \`example.txt\` — policy fixture.

## Verification evidence
- \`node --test\` — pass.

## Canonical notes updated
- None — fixture only.

## Shared surfaces touched
${sharedSurfaces}

## Integration requests
${integrationRequests}

## Known limitations
- None
`;
}

function runPolicy({
  body = validBody(),
  branch = 'feat/idea1-policy-test',
  changes,
  receiptContent,
}) {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'aegis-policy-'));
  const eventPath = join(fixtureDir, 'event.json');
  const changedFilesPath = join(fixtureDir, 'changed-files.txt');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { body, head: { ref: branch } } }));
  writeFileSync(changedFilesPath, changes);

  const policy = Object.fromEntries(
    body
      .match(/<!--\s*collaboration-policy\s*([\s\S]*?)-->/i)?.[1]
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(':').map((part) => part.trim())) || [],
  );
  for (const line of changes.split(/\r?\n/)) {
    const [status, path] = line.split('\t');
    if (status === 'A' && /90-Status\/logs\/\d{4}-\d{2}-\d{2}_\d{6}_/.test(path || '')) {
      const absoluteReceiptPath = join(fixtureDir, path);
      mkdirSync(dirname(absoluteReceiptPath), { recursive: true });
      writeFileSync(
        absoluteReceiptPath,
        receiptContent ?? validReceipt({ area: policy.area, owner: policy.owner, branch }),
      );
    }
  }

  return spawnSync(process.execPath, [
    validatorPath,
    '--event', eventPath,
    '--changed-files', changedFilesPath,
  ], { cwd: fixtureDir, encoding: 'utf8' });
}

test('accepts a scoped IDEA1 pull request with one new Kla receipt', () => {
  const result = runPolicy({
    changes: [
      'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
      'M\tObsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /collaboration policy passed/i);
});

test('rejects an owner that does not match the selected area', () => {
  const result = runPolicy({
    body: validBody({ area: 'idea1', owner: 'pub' }),
    branch: 'feat/idea1-wrong-owner',
    changes: [
      'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_pub_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /area idea1 must use owner kla/i);
});

test('rejects a task pull request without exactly one new Obsidian receipt', () => {
  const result = runPolicy({
    changes: 'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /exactly one new Obsidian task receipt/i);
});

test('rejects cross-scope changes that are not declared for integration review', () => {
  const result = runPolicy({
    changes: [
      'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
      'M\tgateway/nginx.conf',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /cross-scope paths require integration-review: yes/i);
});

test('rejects a pull request without concrete verification evidence', () => {
  const body = validBody().replace('- `node --test` — pass', 'None');
  const result = runPolicy({
    body,
    changes: [
      'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /verification must contain concrete test evidence/i);
});

test('rejects a pull request from main or a non-task branch name', () => {
  const result = runPolicy({
    branch: 'main',
    changes: [
      'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /branch must match/i);
});

test('accepts a scoped IDEA2 pull request with one new Pub receipt', () => {
  const result = runPolicy({
    body: validBody({ area: 'idea2', owner: 'pub' }),
    branch: 'feat/idea2-camera-routing',
    changes: [
      'M\tIDEA2-AEGIS_Monitor/src/App.jsx',
      'M\tObsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_pub_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('accepts a declared cross-scope change that requests integration review', () => {
  const branch = 'feat/idea1-policy-test';
  const result = runPolicy({
    branch,
    body: validBody({
      integrationReview: 'yes',
      sharedSurfaces: '- `gateway/nginx.conf` — route required by IDEA1.',
    }),
    receiptContent: validReceipt({
      area: 'idea1',
      owner: 'kla',
      branch,
      sharedSurfaces: '- `gateway/nginx.conf` — route required by IDEA1.',
      integrationRequests: '- Gateway owner must review the route and rollback behavior.',
    }),
    changes: [
      'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
      'M\tgateway/nginx.conf',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('accepts an IDEA2 server deployment when every cross-scope path is declared in PR and receipt', () => {
  const branch = 'deploy/idea2-server-runtime';
  const sharedSurfaces = [
    '- `docker-compose.yml` — connect the IDEA2 service to the deployment stack.',
    '- `gateway/nginx.conf` — expose the IDEA2 service through the shared gateway.',
  ].join('\n');
  const result = runPolicy({
    branch,
    body: validBody({
      area: 'idea2',
      owner: 'pub',
      integrationReview: 'yes',
      sharedSurfaces,
    }),
    receiptContent: validReceipt({
      area: 'idea2',
      owner: 'pub',
      branch,
      sharedSurfaces,
      integrationRequests: '- Infrastructure owner must review deployment, gateway, and rollback effects.',
    }),
    changes: [
      'M\tIDEA2-AEGIS_Monitor/src/App.jsx',
      'M\tdocker-compose.yml',
      'M\tgateway/nginx.conf',
      'M\tObsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_pub_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('rejects a cross-scope path declared in PR but missing from the Obsidian receipt', () => {
  const result = runPolicy({
    body: validBody({
      integrationReview: 'yes',
      sharedSurfaces: '- `gateway/nginx.conf` — route required by IDEA1.',
    }),
    changes: [
      'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
      'M\tgateway/nginx.conf',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /receipt shared surfaces touched must name gateway\/nginx\.conf/i);
  assert.match(result.stderr, /receipt integration requests must describe the required review/i);
});

test('rejects a cross-scope path omitted from the shared surfaces list', () => {
  const result = runPolicy({
    body: validBody({
      integrationReview: 'yes',
      sharedSurfaces: '- Shared gateway update.',
    }),
    changes: [
      'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
      'M\tgateway/nginx.conf',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /shared surfaces touched must name gateway\/nginx\.conf/i);
});

test('rejects modification of an existing task receipt even when a new receipt is added', () => {
  const result = runPolicy({
    changes: [
      'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
      'M\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-12_120000_pub_previous-task.md',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /existing Obsidian task receipts are immutable/i);
});

test('rejects future writes to the frozen legacy log', () => {
  const result = runPolicy({
    changes: [
      'M\tObsidian_AEGIS_Vault/AEGIS_Knowledge/log.md',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /legacy log\.md is frozen/i);
});

test('allows the one-time legacy-log migration only when its lock is newly added', () => {
  const body = validBody({
    area: 'shared',
    owner: 'kla',
    integrationReview: 'yes',
    sharedSurfaces: [
      '- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/log.md` — freeze legacy history.',
      '- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/legacy-log-migration.lock` — one-time migration lock.',
    ].join('\n'),
  });
  const result = runPolicy({
    body,
    branch: 'codex/obsidian-log-migration',
    changes: [
      'M\tObsidian_AEGIS_Vault/AEGIS_Knowledge/log.md',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/legacy-log-migration.lock',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('rejects a newly added receipt without the required metadata and evidence sections', () => {
  const result = runPolicy({
    receiptContent: '# Empty receipt\n',
    changes: [
      'M\tIDEA1-AEGIS_Drive_LC/src/App.jsx',
      'A\tObsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_policy-test.md',
    ].join('\n'),
  });

  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /receipt is missing required metadata/i);
  assert.match(result.stderr, /receipt is missing required section/i);
});

test('repository provides PR metadata, code-owner routing, and a read-only policy workflow', () => {
  const templatePath = resolve('.github/PULL_REQUEST_TEMPLATE.md');
  const codeownersPath = resolve('.github/CODEOWNERS');
  const workflowPath = resolve('.github/workflows/collaboration-guardrails.yml');

  assert.equal(existsSync(templatePath), true, '.github/PULL_REQUEST_TEMPLATE.md must exist');
  assert.equal(existsSync(codeownersPath), true, '.github/CODEOWNERS must exist');
  assert.equal(existsSync(workflowPath), true, 'collaboration guardrail workflow must exist');

  const template = readFileSync(templatePath, 'utf8');
  assert.match(template, /<!-- collaboration-policy/);
  assert.match(template, /area:/);
  assert.match(template, /owner:/);
  assert.match(template, /integration-review:/);
  assert.match(template, /## Obsidian receipt/);
  assert.match(template, /## Shared surfaces touched/);

  const codeowners = readFileSync(codeownersPath, 'utf8');
  assert.match(codeowners, /\*\s+@kraveerachat\s+@pubpup2006p-design/);
  assert.match(codeowners, /IDEA1-AEGIS_Drive_LC\/\s+@kraveerachat\s+@pubpup2006p-design/);
  assert.match(codeowners, /IDEA2-AEGIS_Monitor\/\s+@kraveerachat\s+@pubpup2006p-design/);
  assert.match(codeowners, /\.github\/\s+@kraveerachat\s+@pubpup2006p-design/);
  assert.match(codeowners, /AEGIS_Knowledge\/idea2\/\s+@kraveerachat\s+@pubpup2006p-design/);

  const workflow = readFileSync(workflowPath, 'utf8');
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /contents:\s*read/);
  assert.match(workflow, /validate-collaboration-policy\.mjs/);
});

test('human and AI instructions require the same branch, scope, test, receipt, and PR lifecycle', () => {
  const requiredFiles = [
    'AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.github/copilot-instructions.md',
    'CONTRIBUTING.md',
    'README.md',
  ];
  for (const path of requiredFiles) {
    assert.equal(existsSync(resolve(path)), true, `${path} must exist`);
  }

  const agents = readFileSync(resolve('AGENTS.md'), 'utf8');
  assert.match(agents, /git fetch origin/i);
  assert.match(agents, /one task.*one branch.*one pull request/is);
  assert.match(agents, /exactly one new.*90-Status\/logs/is);
  assert.match(agents, /IDEA1.*Kla.*IDEA2.*Pub.*IDEA3.*Music/is);
  assert.match(agents, /Shared surfaces touched/i);
  assert.match(agents, /UI.*largely stable.*backend.*evolving/is);
  assert.doesNotMatch(agents, /Append an entry to `log\.md`/i);

  const contributing = readFileSync(resolve('CONTRIBUTING.md'), 'utf8');
  assert.match(contributing, /git switch -c feat\/idea1-/i);
  assert.match(contributing, /git switch -c feat\/idea2-/i);
  assert.match(contributing, /Pull Request/i);
  assert.match(contributing, /Obsidian task receipt/i);

  const readme = readFileSync(resolve('README.md'), 'utf8');
  assert.match(readme, /90-Status\/logs/i);
  assert.doesNotMatch(readme, /append `log\.md`/i);

  for (const path of ['CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md']) {
    const instructions = readFileSync(resolve(path), 'utf8');
    assert.match(instructions, /AGENTS\.md/);
    assert.match(instructions, /Never push directly to `main`/i);
    assert.match(instructions, /Obsidian task receipt/i);
  }
});

test('Obsidian uses immutable per-task receipts and freezes the legacy shared log', () => {
  const templatePath = resolve(
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/_template.md',
  );
  const receiptPath = resolve(
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-08-13_170000_kla_github-guardrails.md',
  );
  const legacyLogPath = resolve('Obsidian_AEGIS_Vault/AEGIS_Knowledge/log.md');
  const operatingRulesPath = resolve(
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/core/agent-operating-rules.md',
  );
  const schemaPath = resolve('Obsidian_AEGIS_Vault/AEGIS_Knowledge/.schema.md');

  assert.equal(existsSync(templatePath), true, 'receipt template must exist');
  assert.equal(existsSync(receiptPath), true, 'this task must create its own receipt');

  const template = readFileSync(templatePath, 'utf8');
  for (const field of ['owner:', 'area:', 'branch:', 'status:', 'edit_policy: append-by-new-file']) {
    assert.match(template, new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
  for (const section of [
    'What changed',
    'Source files changed',
    'Verification evidence',
    'Canonical notes updated',
    'Shared surfaces touched',
    'Integration requests',
    'Known limitations',
  ]) {
    assert.match(template, new RegExp(`## ${section}`, 'i'));
  }

  const receipt = readFileSync(receiptPath, 'utf8');
  assert.match(receipt, /owner:\s*kla/i);
  assert.match(receipt, /area:\s*shared/i);
  assert.match(receipt, /branch:\s*codex\/github-collaboration-guardrails/i);
  assert.match(receipt, /node --test tests\/collaborationPolicy\.test\.mjs/i);

  const legacyLog = readFileSync(legacyLogPath, 'utf8');
  assert.match(legacyLog, /LEGACY LOG FROZEN/i);
  assert.match(legacyLog, /90-Status\/logs/i);

  const operatingRules = readFileSync(operatingRulesPath, 'utf8');
  assert.match(operatingRules, /one task.*one branch.*one Pull Request/is);
  assert.match(operatingRules, /one new.*90-Status\/logs/is);
  assert.doesNotMatch(operatingRules, /Append to log\.md/i);

  const schema = readFileSync(schemaPath, 'utf8');
  assert.match(schema, /90-Status\/logs/i);
  assert.match(schema, /legacy.*frozen/is);
  assert.doesNotMatch(schema, /log\.md remains the source of truth/i);
});
