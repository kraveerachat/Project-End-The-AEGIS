// tests/agent.test.js — AEGIS host telemetry agent · wiring and read surface
//
// These assert the properties that no unit test of a single module can: that
// the assembled agent opens exactly the allowlisted files, that it never shells
// out, and that it opens no network listener of any kind.
//
// The file allowlist is asserted with the thermal reader's directory listing
// stubbed empty, so this test measures the FIXED file surface alone. The
// bounded /sys/class/thermal listing is the one dynamic read the agent makes,
// and it has its own exact-surface assertions in tests/thermal.test.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createAgent } from '../src/agent.js'
import { createFileReaders } from '../src/sources.js'

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

test('the agent reads exactly the seven approved fixed sources and nothing else', async () => {
  const opened = []
  const readers = createFileReaders(
    createAgent({ env: { AEGIS_TELEMETRY_INTERFACE: 'enp1s0' }, readFile: async () => '0' }).config.sources,
    { readFile: async (p) => { opened.push(p); return '0' } },
  )

  for (const read of Object.values(readers)) await read()

  assert.deepEqual(opened.sort(), [
    '/proc/meminfo',
    '/proc/stat',
    '/proc/uptime',
    '/sys/class/net/enp1s0/statistics/rx_bytes',
    '/sys/class/net/enp1s0/statistics/tx_bytes',
    // The sixth source is a FILE written by the separate disk-health oneshot,
    // never a device: the agent still holds no capability and opens no /dev.
    '/var/lib/aegis-disk-health/disk-health.json',
    // The seventh is the same arrangement for the local Twingate connector: a
    // plain file written by its own oneshot. The agent gains a read, not a
    // Docker socket — that stays with the collector and is never held here.
    '/var/lib/aegis-twingate-health/twingate-health.json',
  ])
  // CPU package temperature is deliberately absent from this list: it is not a
  // fixed source. It is discovered under one bounded directory, which is why
  // `thermalRoot` is a separate config field rather than a `sources` entry.
  assert.equal('hostTemperature' in createAgent({
    env: { AEGIS_TELEMETRY_INTERFACE: 'enp1s0' }, readFile: async () => '0',
  }).config.sources, false)
})

test('the thermal read surface is one fixed directory and two files per zone', async () => {
  const opened = []
  const agent = createAgent({
    env: { AEGIS_TELEMETRY_INTERFACE: 'enp1s0' },
    readFile: async (p) => { opened.push(p); return p.endsWith('/type') ? 'x86_pkg_temp' : '55000' },
    readdir: async (root) => {
      // The root is a source constant. Nothing — not the environment, not a
      // request — can point this listing somewhere else.
      assert.equal(root, '/sys/class/thermal')
      return ['thermal_zone0', 'cooling_device0']
    },
  })
  assert.equal(agent.config.thermalRoot, '/sys/class/thermal')

  await agent.sampler.sampleOnce()

  assert.deepEqual(
    opened.filter((p) => p.startsWith('/sys/class/thermal')),
    ['/sys/class/thermal/thermal_zone0/type', '/sys/class/thermal/thermal_zone0/temp'],
    'cooling_device0 must never be opened',
  )
})

test('an empty AEGIS_TELEMETRY_DISK_HEALTH_FILE disables the sixth read entirely', () => {
  const agent = createAgent({
    env: { AEGIS_TELEMETRY_INTERFACE: 'enp1s0', AEGIS_TELEMETRY_DISK_HEALTH_FILE: '' },
    readFile: async () => '0',
  })
  assert.equal(agent.config.diskHealthFile, null)
  assert.equal('diskHealth' in agent.config.sources, false)
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
