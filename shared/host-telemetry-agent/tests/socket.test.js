// tests/socket.test.js — AEGIS host telemetry agent · IPC surface
//
// Platform note, stated plainly because it bounds what these tests prove:
// Node maps `listen(<path>)` to an AF_UNIX socket on POSIX and to a named pipe
// on Windows. The agent code, the http client call, and every assertion below
// are identical on both; only the kernel transport differs. What is verified
// everywhere is the contract that matters here — one path-addressed listener,
// never a TCP port, and a strictly projected body. The two assertions that are
// genuinely POSIX-only (a stale socket *file* on disk, and chmod 0660) are
// marked and skipped rather than faked.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { createSampler } from '../src/sampler.js'
import { AGENT_METRIC_KEYS, AGENT_TOP_LEVEL_KEYS, createTelemetryServer, prepareSocketPath } from '../src/server.js'

const IS_WINDOWS = process.platform === 'win32'
const POSIX_ONLY = IS_WINDOWS && 'POSIX-only: needs a real AF_UNIX socket file'

let counter = 0
const nextSocketPath = () => {
  counter += 1
  return IS_WINDOWS
    ? `\\\\.\\pipe\\aegis-telemetry-test-${process.pid}-${counter}`
    : path.join(os.tmpdir(), `aegis-tel-${process.pid}-${counter}.sock`)
}

const PROC_STAT_1 = 'cpu  100 20 30 400 50 6 4 0 0 0\n'
const PROC_STAT_2 = 'cpu  200 20 30 500 50 6 4 0 0 0\n'
const MEMINFO = 'MemTotal:        8138332 kB\nMemAvailable:    5061404 kB\n'

/** A sampler with two completed cycles, so every metric is available. */
async function readySampler() {
  const state = { ms: 1_000_000, stat: PROC_STAT_1, rx: '1000', tx: '2000' }
  const sampler = createSampler({
    interfaceName: 'enp1s0',
    now: () => state.ms,
    readers: {
      procStat: async () => state.stat,
      memInfo: async () => MEMINFO,
      networkRx: async () => state.rx,
      networkTx: async () => state.tx,
      uptime: async () => '86400.55 172800.10\n',
    },
  })
  await sampler.sampleOnce()
  state.ms += 5000
  state.stat = PROC_STAT_2
  state.rx = '6000'
  state.tx = '4500'
  await sampler.sampleOnce()
  return sampler
}

/** One HTTP request over a path-addressed socket. Returns status + raw text. */
function request(socketPath, { method = 'GET', requestPath = '/internal/telemetry' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: requestPath, method }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

const started = []
async function startAgent(sampler) {
  const socketPath = nextSocketPath()
  const agent = createTelemetryServer({ sampler, socketPath })
  await agent.start()
  started.push(agent)
  return { agent, socketPath }
}

after(async () => {
  for (const agent of started) await agent.stop().catch(() => {})
})

// ── TELEM-SOCKET-1 ────────────────────────────────────────────────────
test('TELEM-SOCKET-1 GET /internal/telemetry returns the latest snapshot', async () => {
  const sampler = await readySampler()
  const { socketPath } = await startAgent(sampler)

  const res = await request(socketPath)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(res.headers['cache-control'], 'no-store')

  const body = JSON.parse(res.body)
  assert.equal(body.schemaVersion, 1)
  assert.equal(body.metrics.cpu.percent, 50)
  assert.equal(body.metrics.network.interface, 'enp1s0')
  assert.equal(body.metrics.memory.totalBytes, 8138332 * 1024)
  assert.equal(body.metrics.uptime.hostSeconds, 86400.55)
})

test('TELEM-SOCKET-1 answers 503 before the first sample exists', async () => {
  const sampler = createSampler({
    interfaceName: 'enp1s0',
    readers: {
      procStat: async () => '', memInfo: async () => '', networkRx: async () => '',
      networkTx: async () => '', uptime: async () => '',
    },
  })
  const { socketPath } = await startAgent(sampler)

  const res = await request(socketPath)
  assert.equal(res.status, 503)
  // Refusing is not the same as inventing an empty snapshot.
  assert.deepEqual(JSON.parse(res.body), { error: 'no-sample-yet' })
})

// ── TELEM-SOCKET-2 / TELEM-SOCKET-3 ───────────────────────────────────
test('TELEM-SOCKET-2 an unknown route is 404 and reveals nothing', async () => {
  const { socketPath } = await startAgent(await readySampler())
  for (const requestPath of ['/', '/metrics', '/internal', '/internal/telemetry/extra', '/../../etc/passwd']) {
    const res = await request(socketPath, { requestPath })
    assert.equal(res.status, 404, `${requestPath} must not be served`)
    assert.deepEqual(JSON.parse(res.body), { error: 'not-found' })
  }
})

test('TELEM-SOCKET-3 a non-GET method on the telemetry route is rejected', async () => {
  const { socketPath } = await startAgent(await readySampler())
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const res = await request(socketPath, { method })
    assert.equal(res.status, 405, `${method} must be rejected`)
    assert.equal(res.headers.allow, 'GET')
  }
})

// ── TELEM-SOCKET-4 / TELEM-SOCKET-5 · output allowlist ────────────────
test('TELEM-SOCKET-4 the response body carries only allowlisted keys', async () => {
  const sampler = await readySampler()
  // Even if a future sampler grows a field, the projection must drop it.
  const raw = sampler.snapshot()
  raw.hostname = os.hostname()
  raw.metrics.cpu.model = 'Intel(R) Core(TM)'
  raw.metrics.docker = { containers: 7 }

  const { socketPath } = await startAgent(sampler)
  const body = JSON.parse((await request(socketPath)).body)

  assert.deepEqual(Object.keys(body).sort(), [...AGENT_TOP_LEVEL_KEYS].sort())
  assert.deepEqual(Object.keys(body.metrics).sort(), ['cpu', 'memory', 'network', 'uptime'])
  for (const [name, metric] of Object.entries(body.metrics)) {
    for (const key of Object.keys(metric)) {
      assert.ok(AGENT_METRIC_KEYS[name].includes(key), `metrics.${name}.${key} is not allowlisted`)
    }
  }
  assert.equal(body.hostname, undefined)
  assert.equal(body.metrics.cpu.model, undefined)
  assert.equal(body.metrics.docker, undefined)
})

test('TELEM-SOCKET-5 the response leaks no environment, user, path, or process detail', async () => {
  process.env.AEGIS_TELEMETRY_LEAK_CANARY = 'canary-value-must-not-appear'
  const { socketPath } = await startAgent(await readySampler())
  const body = (await request(socketPath)).body

  const forbidden = [
    'canary-value-must-not-appear',
    os.hostname(),
    os.userInfo().username,
    process.cwd(),
    process.execPath,
  ]
  for (const needle of forbidden) {
    if (!needle) continue
    assert.ok(!body.includes(needle), `response must not contain ${JSON.stringify(needle)}`)
  }
  // The PID is checked as a field rather than as a substring: a bare number
  // like 3365 legitimately occurs inside a byte count such as 8333651968, and
  // a substring scan for it would fail at random depending on the run's PID.
  const parsed = JSON.parse(body)
  const keys = JSON.stringify(Object.keys(parsed).concat(Object.keys(parsed.metrics)))
  assert.ok(!keys.toLowerCase().includes('pid'), 'no process identifier may be published')
  for (const word of ['env', 'PATH', 'token', 'password', 'secret', 'docker', 'container', 'proc/', 'sys/']) {
    assert.ok(!body.toLowerCase().includes(word.toLowerCase()), `response must not mention ${word}`)
  }
  delete process.env.AEGIS_TELEMETRY_LEAK_CANARY
})

// ── TELEM-11B · no TCP listener ───────────────────────────────────────
test('TELEM-11B the agent listens on a path, never on a TCP port', async () => {
  const { agent, socketPath } = await startAgent(await readySampler())
  const address = agent.address()
  assert.equal(typeof address, 'string', 'a TCP listener would report { address, port }')
  assert.equal(address, socketPath)
  assert.equal(agent.address()?.port, undefined)
})

// ── TELEM-SOCKET-6 · stale socket handling ────────────────────────────
test('TELEM-SOCKET-6 a dead socket file is reclaimed, a live one is refused', async () => {
  const calls = []
  const fakeFs = {
    stat: async (p) => {
      calls.push(['stat', p])
      return { isSocket: () => true }
    },
    unlink: async (p) => { calls.push(['unlink', p]) },
  }

  // Nothing answering on it -> the leftover file is removed and start proceeds.
  await prepareSocketPath('/run/x.sock', { fs: fakeFs, probe: async () => false })
  assert.deepEqual(calls, [['stat', '/run/x.sock'], ['unlink', '/run/x.sock']])

  // Something *is* answering -> never unlink a live agent's socket.
  await assert.rejects(
    () => prepareSocketPath('/run/x.sock', { fs: fakeFs, probe: async () => true }),
    /already in use/i,
  )
})

test('TELEM-SOCKET-6 a non-socket at the configured path is never deleted', async () => {
  const fakeFs = {
    stat: async () => ({ isSocket: () => false }),
    unlink: async () => { throw new Error('unlink must not be called') },
  }
  await assert.rejects(
    () => prepareSocketPath('/run/aegis-telemetry/telemetry.sock', { fs: fakeFs, probe: async () => false }),
    /not a socket/i,
  )
})

test('TELEM-SOCKET-6 an absent path needs no preparation', async () => {
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  const fakeFs = {
    stat: async () => { throw enoent },
    unlink: async () => { throw new Error('unlink must not be called') },
  }
  await assert.doesNotReject(() => prepareSocketPath('/run/x.sock', { fs: fakeFs, probe: async () => false }))
})

test('TELEM-SOCKET-6 start reclaims a real stale socket file', { skip: POSIX_ONLY }, async () => {
  const socketPath = nextSocketPath()
  // A previous agent that was SIGKILLed leaves the inode behind.
  const dead = net.createServer()
  await new Promise((resolve) => dead.listen(socketPath, resolve))
  await new Promise((resolve) => dead.close(resolve))
  fs.writeFileSync(socketPath, '')            // simulate the leftover inode
  await fsp.unlink(socketPath).catch(() => {})
  const orphan = net.createServer()
  await new Promise((resolve) => orphan.listen(socketPath, resolve))
  orphan.unref()
  await new Promise((resolve) => orphan.close(resolve))

  const agent = createTelemetryServer({ sampler: await readySampler(), socketPath })
  await agent.start()
  started.push(agent)
  assert.equal((await request(socketPath)).status, 200)
})

// ── TELEM-SOCKET-7 · shutdown ─────────────────────────────────────────
test('TELEM-SOCKET-7 stop closes the listener and is idempotent', async () => {
  const socketPath = nextSocketPath()
  const agent = createTelemetryServer({ sampler: await readySampler(), socketPath })
  await agent.start()
  assert.equal((await request(socketPath)).status, 200)

  await agent.stop()
  await assert.rejects(() => request(socketPath), (err) => ['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(err.code))
  await assert.doesNotReject(() => agent.stop(), 'stopping twice must be safe')
})

test('TELEM-SOCKET-7 stop removes the socket file', { skip: POSIX_ONLY }, async () => {
  const socketPath = nextSocketPath()
  const agent = createTelemetryServer({ sampler: await readySampler(), socketPath })
  await agent.start()
  assert.equal(fs.existsSync(socketPath), true)
  await agent.stop()
  assert.equal(fs.existsSync(socketPath), false, 'a stopped agent must not leave its socket behind')
})

test('the socket is created group-readable and never world-accessible', { skip: POSIX_ONLY }, async () => {
  const socketPath = nextSocketPath()
  const agent = createTelemetryServer({ sampler: await readySampler(), socketPath })
  await agent.start()
  started.push(agent)
  const mode = fs.statSync(socketPath).mode & 0o777
  assert.equal(mode, 0o660, `expected 0660, got ${mode.toString(8)}`)
})
