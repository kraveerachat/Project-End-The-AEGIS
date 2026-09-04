// tests/tools.test.js — restic and pg_dump wrappers: fixed binaries, discrete arguments, no secrets in argv
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createRestic, parseJsonLines, summarizeBackupOutput } from '../src/restic.js'
import { dumpDatabase, verifyDumpReadable } from '../src/pgdump.js'
import { forgetArgsFor, nextRunAfter } from '../src/schedule.js'

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

const RESTIC_BACKUP_OUTPUT = [
  '{"message_type":"status","percent_done":0.5,"total_files":10}',
  'not json at all',
  '{"message_type":"summary","files_new":3,"files_changed":1,"files_unmodified":6,"data_added":250000000,"total_bytes_processed":18300000000,"snapshot_id":"9f2c1a7b3d4e5f60"}',
].join('\n')

test('TOOL-1 restic backup output reduces to the allowlisted summary', () => {
  assert.equal(parseJsonLines(RESTIC_BACKUP_OUTPUT).length, 2)
  assert.deepEqual(summarizeBackupOutput(RESTIC_BACKUP_OUTPUT), {
    snapshotId: '9f2c1a7b3d4e5f60', bytesScanned: 18_300_000_000, bytesBackedUp: 250_000_000,
    filesNew: 3, filesChanged: 1, filesUnmodified: 6,
  })
  assert.equal(summarizeBackupOutput('{"message_type":"status"}'), null, 'no summary means no snapshot')
})

test('TOOL-2 restic is invoked as the fixed binary with discrete arguments and the password via a FILE env var', async () => {
  const calls = []
  const exec = async (file, args, options) => { calls.push({ file, args, env: options.env }); return { stdout: RESTIC_BACKUP_OUTPUT, stderr: '', exitStatus: 0 } }
  const restic = createRestic({ binary: '/usr/bin/restic', passwordFile: '/etc/aegis/restic-pw', repository: '/mnt/aegis-backup/aegis-restic', cacheDir: '/var/lib/aegis-backup/cache', exec })
  const result = await restic.backup(['/var/lib/aegis-backup/dump', '/data/uploads'])
  assert.equal(result.ok, true)
  assert.equal(result.summary.snapshotId, '9f2c1a7b3d4e5f60')
  assert.equal(calls[0].file, '/usr/bin/restic')
  assert.deepEqual(calls[0].args, ['backup', '--json', '--tag', 'aegis-drive', '--one-file-system', '/var/lib/aegis-backup/dump', '/data/uploads'])
  assert.equal(calls[0].env.RESTIC_PASSWORD_FILE, '/etc/aegis/restic-pw')
  assert.equal(calls[0].env.RESTIC_REPOSITORY, '/mnt/aegis-backup/aegis-restic')
  assert.equal('RESTIC_PASSWORD' in calls[0].env, false, 'the password value itself is never placed in the environment')
  assert.ok(calls[0].args.every((a) => !a.includes('restic-pw')), 'the password file path is not an argument either')
})

test('TOOL-3 restic check / forget / restore / ls carry the intended shapes', async () => {
  const calls = []
  const exec = async (file, args) => { calls.push(args); return { stdout: '{"struct_type":"node","path":"/a"}\n', stderr: '', exitStatus: 0 } }
  const restic = createRestic({ binary: '/usr/bin/restic', passwordFile: '/p', repository: '/r', cacheDir: '/c', exec })
  await restic.check({ readDataSubset: '10%' })
  await restic.forget(forgetArgsFor('keep-7d-4w'))
  await restic.restoreTo('/var/lib/aegis-backup/verify/x', { include: ['/dump/aegis_drive.pgdump'] })
  const listing = await restic.listSnapshot('latest')
  assert.deepEqual(calls[0], ['check', '--read-data-subset=10%'])
  assert.deepEqual(calls[1], ['forget', '--prune', '--json', '--tag', 'aegis-drive', '--group-by', 'tags', '--keep-daily', '7', '--keep-weekly', '4'])
  assert.deepEqual(calls[2], ['restore', 'latest', '--target', '/var/lib/aegis-backup/verify/x', '--include', '/dump/aegis_drive.pgdump'])
  assert.deepEqual(listing, { ok: true, paths: ['/a'] })
  assert.deepEqual(forgetArgsFor('keep-14d-8w-6m'), ['--keep-daily', '14', '--keep-weekly', '8', '--keep-monthly', '6'])
})

test('TOOL-4 pg_dump uses PGPASSFILE and never a password argument; pg_restore --list proves readability', async () => {
  const calls = []
  const exec = async (file, args, options) => {
    calls.push({ file, args, env: options.env })
    if (file.endsWith('pg_restore')) return { stdout: ';\n; Archive created\n;\n2; 3079 16385 EXTENSION - plpgsql\n3512; 0 16400 TABLE DATA public files drive_app\n', stderr: '', exitStatus: 0 }
    return { stdout: '', stderr: '', exitStatus: 0 }
  }
  const connection = { host: '172.18.0.2', port: 5432, database: 'aegis_drive', user: 'drive_backup', passwordFile: '/etc/aegis/pgpass' }
  assert.deepEqual(await dumpDatabase({ binary: '/usr/bin/pg_dump', connection, outputFile: '/var/lib/aegis-backup/dump/aegis_drive.pgdump', exec }), { ok: true })
  assert.equal(calls[0].file, '/usr/bin/pg_dump')
  assert.ok(calls[0].args.includes('--format=custom'))
  assert.ok(calls[0].args.every((a) => !/password/i.test(a)))
  assert.equal(calls[0].env.PGPASSFILE, '/etc/aegis/pgpass')
  assert.equal('PGPASSWORD' in calls[0].env, false)

  const readable = await verifyDumpReadable({ binary: '/usr/bin/pg_restore', file: '/x.pgdump', exec })
  assert.deepEqual(readable, { ok: true, entries: 2 })
  const noData = await verifyDumpReadable({ binary: '/usr/bin/pg_restore', file: '/x.pgdump', exec: async () => ({ stdout: '2; 3079 16385 EXTENSION - plpgsql\n', stderr: '', exitStatus: 0 }) })
  assert.equal(noData.ok, false, 'an archive with no TABLE DATA is not a usable dump')
  const broken = await verifyDumpReadable({ binary: '/usr/bin/pg_restore', file: '/x.pgdump', exec: async () => ({ stdout: '', stderr: 'pg_restore: error: input file does not appear to be a valid archive', exitStatus: 1 }) })
  assert.equal(broken.ok, false)
})

test('TOOL-5 schedules: disabled is null, daily rolls to tomorrow, interval anchors to the last run', () => {
  const at = (iso) => Date.parse(iso)
  assert.equal(nextRunAfter('disabled', at('2026-09-03T02:00:00Z')), null)
  const from = new Date(2026, 8, 3, 5, 0, 0, 0).getTime() // 05:00 local
  const daily = new Date(nextRunAfter('daily-02:00', from))
  assert.equal(daily.getHours(), 2)
  assert.equal(daily.getDate(), 4)
  const interval = nextRunAfter('every-6h', from, { lastRunMs: from - 5 * 60 * 60 * 1000 })
  assert.equal(interval, from + 60 * 60 * 1000)
  const never = nextRunAfter('every-6h', from)
  assert.equal(never, from + 6 * 60 * 60 * 1000, 'a never-run interval schedule does not fire immediately on boot')
  const weekly = new Date(nextRunAfter('weekly-sun-03:00', from))
  assert.equal(weekly.getDay(), 0)
  assert.ok(weekly.getTime() > from)
})

test('TOOL-6 exec.js is the only module that spawns, and it never uses a shell', async () => {
  const files = await fs.readdir(SRC_DIR)
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    const source = await fs.readFile(path.join(SRC_DIR, file), 'utf8')
    if (file === 'exec.js') {
      assert.ok(source.includes("from 'node:child_process'"))
      assert.ok(!/shell:\s*true|\bexec\(|spawn\(/.test(source))
      continue
    }
    assert.ok(!source.includes('child_process'), `${file} must not spawn directly`)
  }
})
