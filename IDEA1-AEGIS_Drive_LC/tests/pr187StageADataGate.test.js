import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const runbookUrl = new URL('../docs/superpowers/plans/2026-09-23-private-vault-production-rollout-runbook.md', import.meta.url)
const statusUrl = new URL('../../Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md', import.meta.url)

const runbook = await fs.readFile(runbookUrl, 'utf8')
const status = await fs.readFile(statusUrl, 'utf8')

function sectionBetween(source, start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end, from + start.length)
  assert.notEqual(from, -1, `missing section: ${start}`)
  assert.notEqual(to, -1, `missing section boundary: ${end}`)
  return source.slice(from, to)
}

test('PR187 Stage-A protected fingerprint has one deterministic committed-Vault scope reused pre and post', () => {
  const commands = sectionBetween(runbook, '## Third Stage A — corrected Human Owner command set', '## Current stop gate')
  const functionMatch = commands.match(/vault_protected_sha256\(\) \{([\s\S]*?)^\}/m)
  assert.ok(functionMatch, 'one protected fingerprint function must define the shared PRE/POST scope')
  const fingerprint = functionMatch[1]

  for (const table of ['vault_meta', 'vault_blobs', 'vault_v2_blobs', 'vault_v2_blob_chunks']) {
    assert.match(fingerprint, new RegExp(`FROM ${table}\\b`), `${table} must be fingerprinted`)
  }
  assert.doesNotMatch(fingerprint, /FROM (?:upload_sessions|upload_session_chunks|vault_v2_upload_sessions|vault_v2_upload_chunks)\b/)
  assert.match(fingerprint, /ORDER BY section_rank, primary_key_1 COLLATE "C", primary_key_2 COLLATE "C"/)
  assert.match(fingerprint, /sha256sum \| cut/)
  assert.doesNotMatch(fingerprint, /\b(?:tee|cat)\b/)

  assert.equal((commands.match(/PRE_PROTECTED_VAULT_SHA256=\$\(vault_protected_sha256\)/g) || []).length, 1)
  assert.equal((commands.match(/POST_PROTECTED_VAULT_SHA256=\$\(vault_protected_sha256\)/g) || []).length, 1)
  assert.match(commands, /test "\$POST_PROTECTED_VAULT_SHA256" = "\$PRE_PROTECTED_VAULT_SHA256"/)
})

test('PR187 Stage-A gate keeps schema, TREE, counts, health and flags but rejects whole-database data hash equality', () => {
  const commands = sectionBetween(runbook, '## Third Stage A — corrected Human Owner command set', '## Current stop gate')

  assert.doesNotMatch(commands, /pg_dump[^\n]*--data-only/)
  assert.doesNotMatch(commands, /test "\$POST_DATA_SHA256" = "\$PRE_DATA_SHA256"/)
  assert.match(commands, /test "\$POST_SCHEMA_SHA256" = "\$PRE_SCHEMA_SHA256"/)
  assert.match(commands, /test "\$POST_TREE_TABLE_COUNT" = "\$EXPECTED_TREE_TABLE_COUNT"/)
  assert.match(commands, /test "\$POST_LEGACY_COUNTS" = "\$PRE_LEGACY_COUNTS"/)
  assert.match(commands, /test "\$POST_DRIVE_HEALTH" = 'healthy'/)
  assert.match(commands, /test "\$POST_DRIVE_RESTARTS" = '0'/)
  assert.match(commands, /test "\$POST_DRIVE_OOM" = 'false'/)
  assert.match(commands, /v\.schemaAvailable!==false/)
  assert.match(commands, /v\.protocolEnabled!==false/)
  assert.match(commands, /v\.destructivePurgeEnabled!==false/)
})

test('Second Stage-A history records the invalid whole-DB gate without unsupported causality', () => {
  for (const source of [runbook, status]) {
    assert.match(source, /SECOND_STAGE_A_CANDIDATE_RUNTIME=PASS/)
    assert.match(source, /SECOND_STAGE_A_PRE_TREE_ROLLBACK=PASS/)
    assert.match(source, /WHOLE_DATABASE_DATA_SHA_GATE=INVALID_FOR_LIVE_STAGE_A/)
    assert.match(source, /UNRELATED_DATABASE_ACTIVITY_CAUSE=NOT_PROVEN/)
    assert.match(source, /b22d….*015b….*89c…/s)
  }
})
