// tests/protectedTrashUi.test.js — static UI and schema contracts for Protected Trash
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const read = (path) => fs.readFile(new URL(path, import.meta.url), 'utf8')

test('Trash is a tenth real screen in server navigation and App routing', async () => {
  const [rbac, app, screen] = await Promise.all([
    read('../server/rbac/permissions.js'), read('../src/App.jsx'), read('../src/screens/Trash.jsx'),
  ])
  assert.match(rbac, /id:\s*['"]trash['"]/)
  assert.match(app, /import\(['"]\.\/screens\/Trash\.jsx['"]\)/)
  assert.match(app, /trash:\s*<Trash/)
  assert.match(screen, /\/api\/trash/)
  assert.match(screen, /type=['"]password['"]/)
  assert.doesNotMatch(screen, /window\.(alert|confirm|prompt)/)
})

test('Trash copy exists in English, Thai and Chinese and describes 30-day recovery honestly', async () => {
  const strings = await read('../src/lib/strings.js')
  assert.ok((strings.match(/navTrash:/g) ?? []).length >= 3)
  assert.ok((strings.match(/trashTitle:/g) ?? []).length >= 3)
  assert.match(strings, /30 days/)
  assert.match(strings, /30 วัน/)
  assert.match(strings, /30 天/)
})

test('schema and additive migration pin protected-trash invariants and indexes', async () => {
  const [schema, migration] = await Promise.all([
    read('../server/db/schema.sql'), read('../server/db/migrations/005_protected_trash.sql'),
  ])
  for (const source of [schema, migration]) {
    assert.match(source, /deleted_at\s+TIMESTAMPTZ/)
    assert.match(source, /purge_after\s+TIMESTAMPTZ/)
    assert.match(source, /deleted_by\s+BIGINT/)
    assert.match(source, /CHECK\s*\(\s*\(deleted_at IS NULL AND purge_after IS NULL\)/s)
    assert.match(source, /files_trash_owner_idx/)
    assert.match(source, /files_trash_expiry_idx/)
  }
})

test('Private Vault implementation remains outside Trash source', async () => {
  const trash = await read('../src/screens/Trash.jsx')
  assert.doesNotMatch(trash, /\/api\/vault/)
  assert.doesNotMatch(trash, /vault_v2|vault_blobs/)
})
