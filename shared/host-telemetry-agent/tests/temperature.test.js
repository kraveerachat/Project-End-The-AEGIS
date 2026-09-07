// tests/temperature.test.js — CPU package thermal source through the real agent assembly
import test from 'node:test'
import assert from 'node:assert/strict'

import { createAgent } from '../src/agent.js'

const FIXED_SOURCE = new Map([
  ['/proc/stat', 'cpu  100 20 30 400 50 6 4 0 0 0\n'],
  ['/proc/meminfo', 'MemTotal: 8138332 kB\nMemAvailable: 5061404 kB\n'],
  ['/proc/uptime', '86400.55 172800.10\n'],
  ['/sys/class/net/enp1s0/statistics/rx_bytes', '1000\n'],
  ['/sys/class/net/enp1s0/statistics/tx_bytes', '2000\n'],
  ['/var/lib/aegis-disk-health/disk-health.json', null],
  ['/var/lib/aegis-twingate-health/twingate-health.json', null],
])

function assembledAgent({ entries, thermalFiles = new Map() }) {
  const openedFiles = []
  const openedDirectories = []
  const agent = createAgent({
    env: { AEGIS_TELEMETRY_INTERFACE: 'enp1s0' },
    readdir: async (directory) => {
      openedDirectories.push(directory)
      return entries
    },
    readFile: async (filePath) => {
      openedFiles.push(filePath)
      if (thermalFiles.has(filePath)) {
        const value = thermalFiles.get(filePath)
        if (value instanceof Error) throw value
        return value
      }
      if (FIXED_SOURCE.has(filePath)) return FIXED_SOURCE.get(filePath)
      throw Object.assign(new Error('unexpected path'), { code: 'ENOENT' })
    },
  })
  return { agent, openedFiles, openedDirectories }
}

test('HOST-TEMP-1 exact x86_pkg_temp selection is independent of thermal zone numbering', async () => {
  const { agent, openedFiles, openedDirectories } = assembledAgent({
    entries: ['thermal_zone0', 'thermal_zone37', 'cooling_device0', '../etc'],
    thermalFiles: new Map([
      ['/sys/class/thermal/thermal_zone0/type', 'acpitz\n'],
      ['/sys/class/thermal/thermal_zone0/temp', '27800\n'],
      ['/sys/class/thermal/thermal_zone37/type', 'x86_pkg_temp\n'],
      ['/sys/class/thermal/thermal_zone37/temp', '54123\n'],
    ]),
  })

  await agent.sampler.sampleOnce()

  assert.deepEqual(agent.sampler.snapshot().metrics.temperature, {
    available: true,
    celsius: 54.123,
    sensor: 'x86_pkg_temp',
  })
  assert.deepEqual(openedDirectories, ['/sys/class/thermal'])
  assert.ok(openedFiles.includes('/sys/class/thermal/thermal_zone37/type'))
  assert.ok(openedFiles.includes('/sys/class/thermal/thermal_zone37/temp'))
  assert.equal(openedFiles.includes('/sys/class/thermal/thermal_zone0/temp'), false, 'non-package temperature is never read as a fallback')
})

test('HOST-TEMP-2 an absent preferred sensor is unavailable and never falls back to acpitz', async () => {
  const { agent, openedFiles } = assembledAgent({
    entries: ['thermal_zone0'],
    thermalFiles: new Map([
      ['/sys/class/thermal/thermal_zone0/type', 'acpitz\n'],
      ['/sys/class/thermal/thermal_zone0/temp', '27800\n'],
    ]),
  })
  await agent.sampler.sampleOnce()
  assert.deepEqual(agent.sampler.snapshot().metrics.temperature, { available: false })
  assert.equal(openedFiles.includes('/sys/class/thermal/thermal_zone0/temp'), false)
})

test('HOST-TEMP-3 an unreadable package sensor is unavailable', async () => {
  const { agent } = assembledAgent({
    entries: ['thermal_zone9'],
    thermalFiles: new Map([
      ['/sys/class/thermal/thermal_zone9/type', 'x86_pkg_temp\n'],
      ['/sys/class/thermal/thermal_zone9/temp', Object.assign(new Error('EACCES'), { code: 'EACCES' })],
    ]),
  })
  await agent.sampler.sampleOnce()
  assert.deepEqual(agent.sampler.snapshot().metrics.temperature, { available: false })
})

test('HOST-TEMP-4 malformed, negative and non-finite readings are unavailable', async () => {
  for (const raw of ['', '-1000', '54000.5', 'NaN', 'Infinity', '54 C']) {
    const { agent } = assembledAgent({
      entries: ['thermal_zone4'],
      thermalFiles: new Map([
        ['/sys/class/thermal/thermal_zone4/type', 'x86_pkg_temp\n'],
        ['/sys/class/thermal/thermal_zone4/temp', raw],
      ]),
    })
    await agent.sampler.sampleOnce()
    assert.deepEqual(agent.sampler.snapshot().metrics.temperature, { available: false }, `raw=${JSON.stringify(raw)}`)
  }
})

test('HOST-TEMP-5 a measured zero remains a real reading rather than becoming unavailable', async () => {
  const { agent } = assembledAgent({
    entries: ['thermal_zone4'],
    thermalFiles: new Map([
      ['/sys/class/thermal/thermal_zone4/type', 'x86_pkg_temp\n'],
      ['/sys/class/thermal/thermal_zone4/temp', '0\n'],
    ]),
  })
  await agent.sampler.sampleOnce()
  assert.deepEqual(agent.sampler.snapshot().metrics.temperature, {
    available: true,
    celsius: 0,
    sensor: 'x86_pkg_temp',
  })
})
