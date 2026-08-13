#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const VALID_OWNERS = new Set(['kla', 'pub', 'music']);
const VALID_POLICIES = new Set([
  'owner-only',
  'owner-writable',
  'append-by-new-file',
  'immutable-source',
]);
const RECEIPT_SECTIONS = [
  'What changed',
  'Source files changed',
  'Verification evidence',
  'Canonical notes updated',
  'Shared surfaces touched',
  'Integration requests',
  'Known limitations',
];

function normalizePath(path) {
  return path.split(sep).join('/');
}

export function detectCaseCollisions(paths) {
  const collisions = [];
  const caseMap = new Map();
  for (const relativePath of paths) {
    const key = relativePath.toLocaleLowerCase('en-US');
    const existing = caseMap.get(key);
    if (existing && existing !== relativePath) collisions.push([existing, relativePath]);
    else caseMap.set(key, relativePath);
  }
  return collisions;
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) metadata[key] = value;
  }
  return metadata;
}

function extractAliases(rawValue = '') {
  const trimmed = rawValue.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((value) => value.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  return [trimmed];
}

function ownerFor(relativePath) {
  if (relativePath.startsWith('idea2/') || relativePath.startsWith('ethics/')) return 'pub';
  if (relativePath.startsWith('idea3/')) return 'music';
  if (relativePath === 'entities/Detection_Engine_Service.md') return 'pub';
  if (relativePath === 'entities/ESP32_Relay_Module.md') return 'music';
  if ([
    'concepts/Contain_Before_Notify.md',
    'concepts/Cyber-Physical_Defense.md',
    'concepts/Dead_Mans_Switch.md',
  ].includes(relativePath)) return 'music';
  if (relativePath === 'summaries/05_IDEA2_Monitor_and_Detection_Engine.md'
      || relativePath === 'summaries/07_Ethics_and_Compliance.md') return 'pub';
  return 'kla';
}

function expectedPolicy(relativePath) {
  if (relativePath.startsWith('raw/')) return 'immutable-source';
  if (/^90-Status\/logs\/\d{4}-\d{2}-\d{2}_\d{6}_(kla|pub|music)_[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(relativePath)) {
    return 'append-by-new-file';
  }
  if (relativePath === 'START_HERE.md'
      || relativePath === 'index.md'
      || relativePath === '.schema.md'
      || relativePath === 'log.md'
      || relativePath.startsWith('core/')) return 'owner-only';
  return 'owner-writable';
}

function receiptSection(content, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.match(new RegExp(`^##\\s+${escaped}\\s*\\r?\\n([\\s\\S]*?)(?=^##\\s+|$)`, 'im'))?.[1]?.trim() || '';
}

function stripLinkDecoration(value) {
  return value
    .replace(/\\\|/g, '|')
    .split('|')[0]
    .split('#')[0]
    .trim()
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '');
}

export function validateVault({ vaultDir, changedFiles = [] }) {
  const root = resolve(vaultDir);
  const errors = [];
  const warnings = [];
  if (!existsSync(root)) return { errors: [`Vault directory does not exist: ${root}`], warnings };

  const allFiles = walk(root);
  const markdownFiles = allFiles.filter((path) => extname(path).toLowerCase() === '.md');
  const notes = markdownFiles.map((path) => {
    const relativePath = normalizePath(relative(root, path));
    const content = readFileSync(path, 'utf8');
    return { path, relativePath, content, metadata: parseFrontmatter(content) };
  });

  const relativeFiles = allFiles.map((file) => normalizePath(relative(root, file)));
  for (const [first, second] of detectCaseCollisions(relativeFiles)) {
    errors.push(`Case-colliding paths: ${first} and ${second}.`);
  }

  const exactTargets = new Set(
    allFiles.map((path) => normalizePath(relative(root, path)).replace(/\.md$/i, '').toLocaleLowerCase('en-US')),
  );
  const basenameTargets = new Map();
  const aliasTargets = new Map();
  for (const note of notes) {
    const withoutExtension = note.relativePath.replace(/\.md$/i, '');
    const name = basename(withoutExtension).toLocaleLowerCase('en-US');
    const paths = basenameTargets.get(name) || [];
    paths.push(withoutExtension);
    basenameTargets.set(name, paths);
    for (const alias of extractAliases(note.metadata.aliases)) {
      aliasTargets.set(alias.toLocaleLowerCase('en-US'), withoutExtension);
    }
  }

  const inbound = new Map(notes.map((note) => [note.relativePath, 0]));
  for (const note of notes) {
    const isTemplate = note.relativePath === '90-Status/logs/_template.md';
    if (!isTemplate) {
      if (!VALID_OWNERS.has(note.metadata.owner)) {
        errors.push(`${note.relativePath}: missing or invalid owner metadata.`);
      } else {
        const expectedOwner = ownerFor(note.relativePath);
        if (note.metadata.owner !== expectedOwner) {
          errors.push(`${note.relativePath}: owner must be ${expectedOwner}, received ${note.metadata.owner}.`);
        }
      }
      if (!VALID_POLICIES.has(note.metadata.edit_policy)) {
        errors.push(`${note.relativePath}: missing or invalid edit_policy metadata.`);
      } else {
        const policy = expectedPolicy(note.relativePath);
        if (note.metadata.edit_policy !== policy) {
          errors.push(`${note.relativePath}: edit_policy must be ${policy}, received ${note.metadata.edit_policy}.`);
        }
      }
    }

    const receiptMatch = note.relativePath.match(/^90-Status\/logs\/(\d{4}-\d{2}-\d{2}_\d{6})_(kla|pub|music)_([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/);
    if (note.relativePath.startsWith('90-Status/logs/') && !isTemplate && !receiptMatch) {
      errors.push(`${note.relativePath}: malformed task receipt filename.`);
    }
    if (receiptMatch) {
      if (note.metadata.owner !== receiptMatch[2]) {
        errors.push(`${note.relativePath}: receipt filename owner does not match frontmatter owner.`);
      }
      for (const section of RECEIPT_SECTIONS) {
        if (!receiptSection(note.content, section)) {
          errors.push(`${note.relativePath}: missing required receipt section content: ${section}.`);
        }
      }
      const verification = receiptSection(note.content, 'Verification evidence');
      if (verification && (!/`[^`]+`/.test(verification) || !/\b(pass(?:ed)?|fail(?:ed)?)\b/i.test(verification))) {
        errors.push(`${note.relativePath}: Verification evidence needs a command and pass/fail result.`);
      }
    }

    if (note.relativePath === 'log.md') continue;
    const searchableContent = note.content.replace(/```[\s\S]*?```/g, '');
    const linkPattern = /!?\[\[([^\]]+)\]\]/g;
    for (const match of searchableContent.matchAll(linkPattern)) {
      const target = stripLinkDecoration(match[1]);
      if (!target) continue;
      const key = target.toLocaleLowerCase('en-US');
      if (['page name', 'wikilinks'].includes(key) || target.includes('…')) continue;
      let resolvedTarget = '';
      if (exactTargets.has(key)) {
        resolvedTarget = key;
      } else if (target.includes('/')) {
        if (exactTargets.has(key)) resolvedTarget = key;
      } else if (aliasTargets.has(key)) {
        resolvedTarget = aliasTargets.get(key).toLocaleLowerCase('en-US');
      } else {
        const candidates = basenameTargets.get(key) || [];
        if (candidates.length === 1) resolvedTarget = candidates[0].toLocaleLowerCase('en-US');
        else if (candidates.length > 1) errors.push(`${note.relativePath}: ambiguous wikilink [[${match[1]}]].`);
      }
      if (!resolvedTarget) {
        errors.push(`${note.relativePath}: Unresolved wikilink [[${match[1]}]].`);
        continue;
      }
      const targetNote = notes.find((candidate) => candidate.relativePath.replace(/\.md$/i, '').toLocaleLowerCase('en-US') === resolvedTarget);
      if (targetNote) inbound.set(targetNote.relativePath, (inbound.get(targetNote.relativePath) || 0) + 1);
    }
  }

  for (const changedFile of changedFiles.map((path) => path.replace(/\\/g, '/'))) {
    if (changedFile.endsWith('Obsidian_AEGIS_Vault/AEGIS_Knowledge/log.md') || changedFile === 'log.md') {
      errors.push('Legacy log.md is frozen; add one new task receipt under 90-Status/logs/ instead.');
    }
    const receiptPath = changedFile.split('Obsidian_AEGIS_Vault/AEGIS_Knowledge/')[1] || changedFile;
    if (/^90-Status\/logs\/.+\.md$/.test(receiptPath)
        && receiptPath !== '90-Status/logs/_template.md'
        && !/^90-Status\/logs\/\d{4}-\d{2}-\d{2}_\d{6}_(kla|pub|music)_[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(receiptPath)) {
      errors.push(`${receiptPath}: changed receipt path is not a valid immutable receipt filename.`);
    }
  }

  for (const note of notes) {
    if ((inbound.get(note.relativePath) || 0) > 0) continue;
    if (['START_HERE.md', 'index.md', '.schema.md', 'log.md', '90-Status/logs/_template.md'].includes(note.relativePath)) continue;
    if (note.relativePath.startsWith('90-Status/logs/')) continue;
    warnings.push(`${note.relativePath}: orphan note has no inbound wikilink.`);
  }

  for (const file of allFiles.filter((path) => extname(path).toLowerCase() === '.canvas')) {
    const relativePath = normalizePath(relative(root, file));
    if (/^ยังไม่ได้ตั้งชื่อ(?: \d+)?\.canvas$/u.test(relativePath)) {
      warnings.push(`${relativePath}: empty untitled canvas should remain untracked until owner-approved deletion.`);
    }
  }

  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function readOption(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const vaultDir = readOption('--vault', 'Obsidian_AEGIS_Vault/AEGIS_Knowledge');
  const changedFileList = readOption('--changed-files');
  const changedFiles = changedFileList && existsSync(changedFileList)
    ? readFileSync(changedFileList, 'utf8').split(/\r?\n/).filter(Boolean)
    : [];
  const result = validateVault({ vaultDir, changedFiles });
  for (const warning of result.warnings) console.warn(`WARNING: ${warning}`);
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  if (result.errors.length > 0) process.exitCode = 1;
  else console.log(`Vault validation passed with ${result.warnings.length} warning(s).`);
}
