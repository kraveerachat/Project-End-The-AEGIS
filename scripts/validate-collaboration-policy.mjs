#!/usr/bin/env node

import { readFileSync } from 'node:fs';

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`Missing required option: ${name}`);
  }
  return process.argv[index + 1];
}

const event = JSON.parse(readFileSync(readOption('--event'), 'utf8'));
const changedFilesText = readFileSync(readOption('--changed-files'), 'utf8');

if (!event.pull_request?.body || !event.pull_request?.head?.ref) {
  throw new Error('Event must contain pull_request.body and pull_request.head.ref');
}

const body = event.pull_request.body;
const branch = event.pull_request.head.ref;
const policyMatch = body.match(/<!--\s*collaboration-policy\s*([\s\S]*?)-->/i);
const errors = [];
let area = '';
let owner = '';
let integrationReview = '';

if (!/^(feat|fix|docs|infra|chore|codex)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch)) {
  errors.push('Branch must match <feat|fix|docs|infra|chore|codex>/<lowercase-task-slug>.');
}

if (!policyMatch) {
  errors.push('Pull Request body is missing the collaboration-policy block.');
} else {
  const metadata = Object.fromEntries(
    policyMatch[1]
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(':');
        return separator === -1
          ? [line.toLowerCase(), '']
          : [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim().toLowerCase()];
      }),
  );

  const expectedOwners = {
    idea1: 'kla',
    idea2: 'pub',
    idea3: 'music',
    infrastructure: 'kla',
    shared: 'kla',
  };
  area = metadata.area;
  owner = metadata.owner;
  integrationReview = metadata['integration-review'];

  if (!Object.hasOwn(expectedOwners, area)) {
    errors.push(`Unknown task area: ${area || '(missing)'}.`);
  } else if (owner !== expectedOwners[area]) {
    errors.push(`Area ${area} must use owner ${expectedOwners[area]}; received ${owner || '(missing)'}.`);
  }
  if (!['yes', 'no'].includes(integrationReview)) {
    errors.push('integration-review must be yes or no.');
  }
}

const changedEntries = changedFilesText
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [status, ...paths] = line.split('\t');
    return { status, path: paths.at(-1) || '' };
  });
const legacyLogPath = 'Obsidian_AEGIS_Vault/AEGIS_Knowledge/log.md';
const legacyLogLockPath = 'Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/legacy-log-migration.lock';
const legacyLogChanged = changedEntries.some(({ path }) => path === legacyLogPath);
const oneTimeMigrationLockAdded = changedEntries.some(
  ({ status, path }) => status === 'A' && path === legacyLogLockPath,
);
if (legacyLogChanged && !oneTimeMigrationLockAdded) {
  errors.push('Legacy log.md is frozen; create a new immutable task receipt instead.');
}
const receiptDirectory = 'Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/';
const receiptPattern = /^Obsidian_AEGIS_Vault\/AEGIS_Knowledge\/90-Status\/logs\/(\d{4}-\d{2}-\d{2}_\d{6})_(kla|pub|music)_([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
const changedTaskReceipts = changedEntries.filter(
  ({ path }) => path.startsWith(receiptDirectory) && !path.endsWith('/_template.md'),
);
const newReceipts = changedEntries.filter(({ status, path }) => status === 'A' && receiptPattern.test(path));

const nonAppendReceiptChanges = changedTaskReceipts.filter(
  ({ status, path }) => status !== 'A' || !receiptPattern.test(path),
);
if (nonAppendReceiptChanges.length > 0) {
  errors.push(
    `Existing Obsidian task receipts are immutable; only add a correctly named new receipt (${nonAppendReceiptChanges.map(({ path }) => path).join(', ')}).`,
  );
}

if (newReceipts.length !== 1) {
  errors.push(`Every task must add exactly one new Obsidian task receipt; found ${newReceipts.length}.`);
} else {
  const receiptPath = newReceipts[0].path;
  const receiptOwner = receiptPath.match(receiptPattern)?.[2];
  if (owner && receiptOwner !== owner) {
    errors.push(`Receipt owner ${receiptOwner} does not match Pull Request owner ${owner}.`);
  }
  if (!body.includes(receiptPath)) {
    errors.push('The Obsidian receipt section must name the newly added receipt path.');
  }

  try {
    const receipt = readFileSync(receiptPath, 'utf8');
    const frontmatter = receipt.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] || '';
    const receiptMetadata = Object.fromEntries(
      frontmatter
        .split(/\r?\n/)
        .map((line) => {
          const separator = line.indexOf(':');
          return separator === -1
            ? [line.trim().toLowerCase(), '']
            : [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
        })
        .filter(([key]) => key),
    );
    const invalidMetadata = [];
    if (receiptMetadata.owner !== owner) invalidMetadata.push('owner');
    if (receiptMetadata.area !== area) invalidMetadata.push('area');
    if (receiptMetadata.branch !== branch) invalidMetadata.push('branch');
    if (!['complete', 'partial', 'blocked'].includes(receiptMetadata.status)) invalidMetadata.push('status');
    if (receiptMetadata.edit_policy !== 'append-by-new-file') invalidMetadata.push('edit_policy');
    if (invalidMetadata.length > 0) {
      errors.push(`Receipt is missing required metadata or has mismatched values: ${invalidMetadata.join(', ')}.`);
    }

    const requiredSections = [
      'What changed',
      'Source files changed',
      'Verification evidence',
      'Canonical notes updated',
      'Shared surfaces touched',
      'Integration requests',
      'Known limitations',
    ];
    for (const title of requiredSections) {
      const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const content = receipt.match(new RegExp(`^##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|$)`, 'im'))?.[1]?.trim();
      if (!content) errors.push(`Receipt is missing required section content: ${title}.`);
    }
    const receiptVerification = receipt.match(
      /^##\s+Verification evidence\s*\r?\n([\s\S]*?)(?=^##\s+|$)/im,
    )?.[1] || '';
    if (!/`[^`]+`/.test(receiptVerification) || !/\b(pass(?:ed)?|fail(?:ed)?)\b/i.test(receiptVerification)) {
      errors.push('Receipt verification evidence must contain a command in backticks and its pass/fail result.');
    }
  } catch (error) {
    errors.push(`Unable to read the new Obsidian receipt ${receiptPath}: ${error.message}`);
  }
}

const areaPathPrefixes = {
  idea1: [
    'IDEA1-AEGIS_Drive_LC/',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/04_',
  ],
  idea2: [
    'AEGIS_Camera/',
    'IDEA2-AEGIS_CCTV-Operator/',
    'IDEA2-AEGIS_Monitor/',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/summaries/05_',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/entities/Detection_Engine_Service',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/ethics/',
  ],
  idea3: [
    'IDEA3-AEGIS_Lockdown/',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/entities/ESP32_Relay_Module',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Dead_Mans_Switch',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/concepts/Contain_Before_Notify',
  ],
  infrastructure: [
    '.env.example',
    'HUB-AEGIS_Entry/',
    'docker-compose.yml',
    'gateway/',
    'postgres/',
    'shared/',
    'Obsidian_AEGIS_Vault/AEGIS_Knowledge/infrastructure/',
  ],
  shared: [''],
};

function isReceipt(path) {
  return receiptPattern.test(path);
}

function isPathOwnedByArea(path, taskArea) {
  if (isReceipt(path)) return true;
  return (areaPathPrefixes[taskArea] || []).some((prefix) => path.startsWith(prefix));
}

function sectionText(title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return body.match(new RegExp(`^##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|$)`, 'im'))?.[1]?.trim() || '';
}

const crossScopePaths = changedEntries
  .map(({ path }) => path)
  .filter((path) => area && !isPathOwnedByArea(path, area));
const sharedSurfaces = sectionText('Shared surfaces touched');
const verification = sectionText('Verification');

if (!/`[^`]+`/.test(verification) || !/\b(pass(?:ed)?|fail(?:ed)?)\b/i.test(verification)) {
  errors.push('Verification must contain concrete test evidence: a command in backticks and its pass/fail result.');
}

if (crossScopePaths.length > 0 && integrationReview !== 'yes') {
  errors.push(`Cross-scope paths require integration-review: yes (${crossScopePaths.join(', ')}).`);
}
if ((crossScopePaths.length > 0 || area === 'shared') && /^none\.?$/i.test(sharedSurfaces || 'None')) {
  errors.push('Shared surfaces touched must list the cross-scope paths instead of None.');
}
for (const path of crossScopePaths) {
  if (!sharedSurfaces.includes(path)) {
    errors.push(`Shared surfaces touched must name ${path}.`);
  }
}
if (area === 'shared' && integrationReview !== 'yes') {
  errors.push('Shared tasks require integration-review: yes.');
}

if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exitCode = 1;
} else {
  console.log('Collaboration policy passed.');
}
