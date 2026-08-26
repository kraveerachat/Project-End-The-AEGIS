// tests/agent.test.js — AEGIS host telemetry agent · wiring and read surface
//
// These assert the properties that no unit test of a single module can: that
// the assembled agent reads exactly five allowlisted files, that it never
// shells out, and that it opens no network listener of any kind.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgent } from '../src/agent.js'
import { createFileReaders } from '../src/sources.js'

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

test('the agent reads exactly the five approved sources and nothing else', async () => {
  const opened = []
  const readers = createFileReaders(
    {
      procStat: '/proc/stat',
      memInfo: '/proc/meminfo',
      uptime: '/proc/uptime',
      networkRx: '/sys/class/net/enp1s0/statistics/rx_bytes',
      networkTx: '/sys/class/net/enp1s0/statistics/tx_bytes',
    },
    { readFile: async (p) => { opened.push(p); return '0' } },
  )

  for (const read of Object.values(readers)) await read()

  assert.deepEqual(opened.sort(), [
    '/proc/meminfo',
    '/proc/stat',
    '/proc/uptime',
    '/sys/class/net/enp1s0/statistics/rx_bytes',
    '/sys/class/net/enp1s0/statistics/tx_bytes',
  ])
})

test('a source read is never allowed to throw into the sampler', async () => {
  const readers = createFileReaders(
    { procStat: '/proc/stat' },
    { readFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } },
  )
  // Returning null (not throwing, not '') keeps the "unknown, never zero" rule
  // intact all the way down at the I/O edge.
  assert.equal(await readers.procStat(), null)
})

test('no module under src/ can execute a shell command', async () => {
  const files = await fs.readdir(SRC_DIR)
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    const source = await fs.readFile(path.join(SRC_DIR, file), 'utf8')
    // `child_process` is the load-bearing one: nothing can shell out without
    // it. The rest catch a re-export or a dynamic import trying to slip past.
    for (const forbidden of ['child_process', 'execSync', 'execFile', 'spawnSync', 'spawn(', 'process.binding']) {
      assert.ok(
        !source.includes(forbidden),
        `${file} must not reference ${forbidden} — metrics come from file reads only`,
      )
    }
  }
})

test('no module under src/ can open a TCP or UDP listener', async () => {
  const files = await fs.readdir(SRC_DIR)
  for (const file of files.filter((name) => name.endsWith('.js'))) {
    const source = await fs.readFile(path.join(SRC_DIR, file), 'utf8')
    for (const forbidden of ['node:dgram', 'createConnection({ port', 'listen(port', '0.0.0.0', '127.0.0.1']) {
      assert.ok(!source.includes(forbidden), `${file} must not reference ${forbidden}`)
    }
  }
})

test('createAgent assembles a sampler and a path-addressed server without starting either', async () => {
  const agent = createAgent({
    env: {
      AEGIS_TELEMETRY_INTERFACE: 'enp1s0',
      AEGIS_TELEMETRY_SOCKET: '/run/aegis-telemetry/telemetry.sock',
    },
    readFile: async () => '0',
  })

  assert.equal(agent.config.interfaceName, 'enp1s0')
  assert.equal(agent.config.socketPath, '/run/aegis-telemetry/telemetry.sock')
  assert.equal(agent.config.socketMode, 0o660)
  assert.equal(agent.config.intervalMs, 5000)
  assert.equal(agent.sampler.snapshot(), null, 'construction must not sample')
  assert.equal(agent.server.address(), null, 'construction must not listen')
})
