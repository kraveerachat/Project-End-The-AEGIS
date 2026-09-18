// tests/mediaProcessRunner.test.js — AEGIS Drive (IDEA1) · bounded child-process runner for the media subsystem (Task 3)
//
// ⚠️ ใช้ Node เองเป็น child (process.execPath) จึงรันได้ทุกเครื่องโดยไม่ต้องมี FFmpeg — สิ่งที่ตรึง:
//    ไม่มี shell, env ขั้นต่ำ (ไม่มี secret ของ parent), เพดาน stdio ที่ยังระบายท่อต่อ, timeout
//    TERM→KILL จริง ๆ (ไม่ใช่แค่ดู string), AbortSignal, ไม่มี Buffer ของ media ในผลลัพธ์, metrics
//    จาก /proc บน Linux (spec §10.3, §17.7)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createProcessRunner, MINIMAL_CHILD_ENV } from '../server/media/processRunner.js'

const NODE = process.execPath
const LINUX = process.platform === 'linux'
const runner = createProcessRunner()

test('PR-1 no shell: arguments are passed verbatim; NUL / non-string arguments are rejected', async () => {
  const r = await runner.run({ bin: NODE, args: ['-e', 'console.log(process.argv.length)', '$(echo x)', 'a b'], timeoutMs: 10_000 })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.trim(), '3', 'argv is [node, "$(echo x)", "a b"] — both literal args survive unexpanded (the plan text said 5; the measured argv shape is 3)')
  const echoArgs = await runner.run({ bin: NODE, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', '$(echo x)', 'a b', '*'], timeoutMs: 10_000 })
  assert.deepEqual(JSON.parse(echoArgs.stdout), ['$(echo x)', 'a b', '*'])
  assert.throws(() => runner.run({ bin: NODE, args: ['-e', 'x\0y'] }), TypeError)
  assert.throws(() => runner.run({ bin: NODE, args: ['-e', 42] }), TypeError)
  assert.throws(() => runner.run({ bin: NODE, args: 'not-an-array' }), TypeError)
})

test('PR-2 minimal env: only PATH/HOME/LANG reach the child even when the parent holds secrets', async () => {
  process.env.DATABASE_URL = 'postgresql://u:p@localhost/db'
  process.env.SESSION_SECRET = 'top-secret'
  try {
    assert.deepEqual(Object.keys(MINIMAL_CHILD_ENV).sort(), ['HOME', 'LANG', 'PATH'])
    assert.equal(MINIMAL_CHILD_ENV.HOME, '/tmp')
    assert.equal(MINIMAL_CHILD_ENV.LANG, 'C')
    assert.equal(Object.isFrozen(MINIMAL_CHILD_ENV), true)
    process.env.AEGIS_TEST_PARENT_ONLY = 'must-not-leak'
    const r = await runner.run({ bin: NODE, args: ['-e', 'console.log(JSON.stringify(Object.keys(process.env).sort()))'], timeoutMs: 10_000 })
    assert.equal(r.code, 0, r.stderr)
    const keys = JSON.parse(r.stdout)
    for (const secret of ['DATABASE_URL', 'SESSION_SECRET', 'AEGIS_TEST_PARENT_ONLY']) assert.ok(!keys.includes(secret), `${secret} leaked to the child`)
    if (LINUX) {
      assert.deepEqual(keys, ['HOME', 'LANG', 'PATH'], 'authoritative (Linux): exactly the minimal env')
    } else {
      // Windows process creation (libuv) injects a fixed system set (SYSTEMROOT, USERPROFILE, …) that
      // node needs to start; nothing from the parent beyond MINIMAL_CHILD_ENV may appear.
      const WINDOWS_INJECTED = new Set(['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR', 'COMSPEC', 'PATHEXT', 'ALLUSERSPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PUBLIC'])
      const unexpected = keys.filter((k) => !['HOME', 'LANG', 'PATH'].includes(k) && !WINDOWS_INJECTED.has(k))
      assert.deepEqual(unexpected, [], 'no parent variable beyond the minimal env and the OS-injected set')
      assert.ok(keys.includes('HOME') && keys.includes('LANG') && keys.includes('PATH'))
    }
  } finally {
    delete process.env.DATABASE_URL
    delete process.env.SESSION_SECRET
    delete process.env.AEGIS_TEST_PARENT_ONLY
  }
})

test('PR-3 stdio cap: 1 MiB of stdout is capped at 65536 bytes, flagged truncated, and the child still exits 0', async () => {
  const script = 'const chunk = "x".repeat(65536); for (let i = 0; i < 16; i++) process.stdout.write(chunk); process.stdout.write("\\n", () => process.exit(0))'
  const r = await runner.run({ bin: NODE, args: ['-e', script], timeoutMs: 20_000 })
  assert.equal(r.code, 0)
  assert.equal(r.stdout.length, 65_536)
  assert.equal(r.stdoutTruncated, true)
  assert.equal(r.stderrTruncated, false)
})

test('PR-3B UTF-8 byte cap: multibyte output is bounded by raw bytes, not by JavaScript string length', async () => {
  // 'é' = 2 UTF-8 bytes, 1 UTF-16 code unit: 65536 chars = 131072 bytes on each stream.
  // The cap is a resource bound on retained source bytes, so the retained text must be 65536 bytes (32768 chars),
  // never 65536 chars (131072 bytes). The boundary falls on a complete codepoint by construction.
  const script = [
    'const s = "\\u00e9".repeat(65536);',
    'process.stdout.write(s);',
    'process.stderr.write(s);',
    'process.stdout.write("", () => process.stderr.write("", () => process.exit(0)))',
  ].join(' ')
  const r = await runner.run({ bin: NODE, args: ['-e', script], timeoutMs: 20_000, stdioCapBytes: 65_536 })
  assert.equal(r.code, 0, 'child terminates normally: the parent kept draining both pipes after the cap')
  assert.equal(typeof r.stdout, 'string')
  assert.equal(typeof r.stderr, 'string')
  assert.equal(Buffer.byteLength(r.stdout, 'utf8'), 65_536, 'stdout retained bytes == cap')
  assert.equal(Buffer.byteLength(r.stderr, 'utf8'), 65_536, 'stderr retained bytes == cap')
  assert.equal(r.stdoutTruncated, true)
  assert.equal(r.stderrTruncated, true)
  assert.ok(!r.stdout.includes('�') && !r.stderr.includes('�'), 'cap boundary lands on a whole codepoint for this fixture')
  for (const [k, v] of Object.entries(r)) assert.ok(!Buffer.isBuffer(v) && !(v instanceof Uint8Array), `field ${k} must not be a Buffer`)
})

test('PR-4 timeout TERM→KILL: a child ignoring SIGTERM is SIGKILLed after the grace period', { skip: !LINUX && 'linux-only (Windows cannot ignore SIGTERM)' }, async () => {
  const started = Date.now()
  const r = await runner.run({
    bin: NODE, args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    timeoutMs: 300, killGraceMs: 200,
  })
  assert.ok(Date.now() - started < 1500, 'resolved promptly')
  assert.equal(r.timedOut, true)
  assert.equal(r.killed, true)
  assert.equal(r.signal, 'SIGKILL')
  assert.equal(r.code, null)
})

test('PR-5 timeout TERM honoured: a child that exits on SIGTERM reports SIGTERM without waiting for the grace period', async () => {
  const r = await runner.run({ bin: NODE, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 300, killGraceMs: 2000 })
  assert.equal(r.timedOut, true)
  assert.equal(r.killed, true)
  assert.equal(r.signal, 'SIGTERM')
  assert.ok(r.durationMs < 2000 + 300, `durationMs ${r.durationMs} must not include the grace period`)
})

test('PR-6 AbortSignal: aborting kills the child and resolves with killed true', async () => {
  const ctrl = new AbortController()
  const p = runner.run({ bin: NODE, args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 30_000, signal: ctrl.signal })
  setTimeout(() => ctrl.abort(), 150)
  const r = await p
  assert.equal(r.killed, true)
  assert.equal(r.timedOut, false)
  assert.ok(['SIGTERM', 'SIGKILL'].includes(r.signal))
  assert.ok(r.durationMs < 5000)
})

test('PR-7 no media bytes: results carry only strings/numbers/booleans; 4 MiB of binary stdout becomes a capped string', async () => {
  const script = 'const b = Buffer.alloc(1048576, 0xff); for (let i = 0; i < 4; i++) process.stdout.write(b); process.stdout.write("", () => process.exit(0))'
  const r = await runner.run({ bin: NODE, args: ['-e', script], timeoutMs: 20_000 })
  assert.equal(r.code, 0)
  for (const [k, v] of Object.entries(r)) {
    assert.ok(!Buffer.isBuffer(v) && !(v instanceof Uint8Array), `field ${k} must not be a Buffer`)
    if (v && typeof v === 'object') for (const [mk, mv] of Object.entries(v)) assert.ok(!Buffer.isBuffer(mv), `metrics.${mk} must not be a Buffer`)
  }
  assert.equal(typeof r.stdout, 'string')
  assert.ok(r.stdout.length <= 65_536)
  assert.equal(r.stdoutTruncated, true)
})

test('PR-8 metrics on Linux: /proc io + VmHWM are sampled for a child that reads 3 MiB', { skip: !LINUX && 'linux-only (/proc metrics)' }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-runner-io-'))
  const big = path.join(dir, 'big.bin')
  await fs.writeFile(big, Buffer.alloc(3 * 1_048_576, 1))
  try {
    const script = `const fs=require('fs');const fd=fs.openSync(${JSON.stringify(big)},'r');const buf=Buffer.alloc(65536);let n;while((n=fs.readSync(fd,buf))>0){} fs.closeSync(fd); setTimeout(()=>{},120)`
    const r = await runner.run({ bin: NODE, args: ['-e', script], timeoutMs: 20_000 })
    assert.equal(r.code, 0, r.stderr)
    assert.ok(r.metrics, 'metrics present on linux')
    assert.ok(r.metrics.rchar >= 3 * 1_048_576, `rchar ${r.metrics.rchar}`)
    assert.ok(r.metrics.readBytes >= 0)
    assert.ok(r.metrics.vmHwmKb > 0)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('PR-9 cwd: the child runs in the runner cwd; metrics are null off Linux', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-runner-cwd-'))
  try {
    const local = createProcessRunner({ cwd: dir })
    const r = await local.run({ bin: NODE, args: ['-e', 'console.log(process.cwd())'], timeoutMs: 10_000 })
    assert.equal(await fs.realpath(r.stdout.trim()), await fs.realpath(dir))
    if (!LINUX) assert.equal(r.metrics, null)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
