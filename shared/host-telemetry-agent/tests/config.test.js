// tests/config.test.js — AEGIS host telemetry agent · configuration boundary
//
// The interface name is the only value that becomes part of a filesystem path,
// so it is the one input that has to be proven un-abusable. It is server-side
// only: nothing in the browser or in Drive can reach these functions.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  DEFAULT_INTERFACE, DEFAULT_SOCKET_PATH, SOCKET_MODE,
  loadAgentConfig, networkStatisticsPaths, resolveInterfaceName,
} from '../src/config.js'

test('the approved production defaults are the ones the architecture fixed', () => {
  assert.equal(DEFAULT_INTERFACE, 'enp1s0')
  assert.equal(DEFAULT_SOCKET_PATH, '/run/aegis-telemetry/telemetry.sock')
  assert.equal(SOCKET_MODE, 0o660)
})

test('an explicitly configured interface name is accepted', () => {
  assert.equal(resolveInterfaceName('enp1s0'), 'enp1s0')
  assert.equal(resolveInterfaceName('eth0'), 'eth0')
  assert.equal(resolveInterfaceName('  enp1s0  '), 'enp1s0')
})

test('TELEM-4B refuses an absent or unusable interface instead of guessing one', () => {
  // No auto-selection: an agent that picks "whatever NIC is up" reports numbers
  // nobody configured, and the reader cannot tell which link they describe.
  for (const [label, value] of [
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['wildcard', '*'],
    ['not a string', 42],
    ['path traversal', '../../etc'],
    ['absolute path', '/etc/passwd'],
    ['separator', 'enp1s0/statistics'],
    ['backslash', 'enp1s0\\x'],
    ['null byte', 'enp1s0\u0000'],
    ['dot', '.'],
    ['dot dot', '..'],
    ['too long', 'e'.repeat(64)],
    ['space inside', 'enp1s0 eth0'],
  ]) {
    assert.equal(resolveInterfaceName(value), null, `${label} must be refused`)
  }
})

test('statistics paths stay inside /sys/class/net for the configured interface', () => {
  const paths = networkStatisticsPaths('enp1s0')
  assert.equal(paths.rx, path.posix.join('/sys/class/net', 'enp1s0', 'statistics', 'rx_bytes'))
  assert.equal(paths.tx, path.posix.join('/sys/class/net', 'enp1s0', 'statistics', 'tx_bytes'))
  assert.throws(() => networkStatisticsPaths('../../etc'), /interface/i)
})

test('loadAgentConfig defaults to the approved production boundary', () => {
  const config = loadAgentConfig({})
  assert.equal(config.interfaceName, 'enp1s0')
  assert.equal(config.socketPath, '/run/aegis-telemetry/telemetry.sock')
  assert.equal(config.socketMode, 0o660)
  assert.equal(config.intervalMs, 5000)
  assert.deepEqual(config.sources, {
    procStat: '/proc/stat',
    memInfo: '/proc/meminfo',
    uptime: '/proc/uptime',
    networkRx: '/sys/class/net/enp1s0/statistics/rx_bytes',
    networkTx: '/sys/class/net/enp1s0/statistics/tx_bytes',
    // The disk-health evidence file is a plain file under /var/lib, written by
    // the separate collector oneshot. It is a read, never a device.
    diskHealth: '/var/lib/aegis-disk-health/disk-health.json',
  })
  assert.equal(config.diskHealthFile, '/var/lib/aegis-disk-health/disk-health.json')
})

test('loadAgentConfig rejects a relative disk-health file and accepts an empty one as disabled', () => {
  assert.throws(() => loadAgentConfig({ AEGIS_TELEMETRY_DISK_HEALTH_FILE: 'disk-health.json' }), /absolute/)
  const disabled = loadAgentConfig({ AEGIS_TELEMETRY_DISK_HEALTH_FILE: '' })
  assert.equal(disabled.diskHealthFile, null)
  assert.equal('diskHealth' in disabled.sources, false)
})

test('loadAgentConfig honours explicit overrides and rejects unusable ones', () => {
  const config = loadAgentConfig({
    AEGIS_TELEMETRY_INTERFACE: 'eth0',
    AEGIS_TELEMETRY_SOCKET: '/run/custom/telemetry.sock',
    AEGIS_TELEMETRY_INTERVAL_MS: '7000',
  })
  assert.equal(config.interfaceName, 'eth0')
  assert.equal(config.socketPath, '/run/custom/telemetry.sock')
  assert.equal(config.intervalMs, 7000)

  assert.throws(() => loadAgentConfig({ AEGIS_TELEMETRY_INTERFACE: '../../etc' }), /interface/i)
  // A nonsense interval must fail loudly at boot, not silently become a
  // busy-loop or an hour-long window nobody notices.
  for (const bad of ['0', '-1', 'abc', '25']) {
    assert.throws(() => loadAgentConfig({ AEGIS_TELEMETRY_INTERVAL_MS: bad }), /interval/i)
  }
})
