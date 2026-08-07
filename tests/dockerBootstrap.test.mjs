import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const ROOT = new URL('../', import.meta.url)

test('Postgres shell bootstrap scripts use Unix LF endings', async () => {
  const scripts = [
    'postgres/init/01-run-app-init.sh',
    'postgres/init/02-app-roles.sh',
  ]

  for (const script of scripts) {
    const source = await readFile(new URL(script, ROOT), 'utf8')
    assert.equal(source.includes('\r'), false, `${script} contains CRLF and will execute as /bin/sh^M in Linux`)
  }
})

test('Git preserves LF endings for shell scripts on Windows', async () => {
  const attributes = await readFile(new URL('.gitattributes', ROOT), 'utf8')
  assert.match(attributes, /^\*\.sh\s+text\s+eol=lf$/m)
})
