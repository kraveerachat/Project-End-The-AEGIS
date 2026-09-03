// tests/diskHealthCollector.test.js — AEGIS host disk-health collector · the privileged edge
//
// The collector is the only AEGIS host component that executes a binary. These
// tests pin what it may execute (one fixed path, fixed arguments, one validated
// device), what it does when the binary or device is not there, and that its
// file write is atomic. No real smartctl is ever run.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_OUTPUT_PATH, DEFAULT_SMARTCTL_PATH, SMARTCTL_ARGS,
  collectDiskHealth, devicePathFor, loadCollectorConfig, resolveDeviceName, writeEvidenceFile,
} from '../collectors/disk-health.js'

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixtureText = (name) => fs.readFile(path.join(FIXTURES, name), 'utf8')

const CONFIG = { device: 'sda', devicePath: '/dev/sda', smartctlPath: DEFAULT_SMARTCTL_PATH, outputPath: DEFAULT_OUTPUT_PATH }
const NOW = () => Date.parse('2026-09-03T02:00:00.000Z')

test('COLLECT-1 only whole block devices are accepted; partitions and paths are refused', () => {
  for (const ok of ['sda', 'sdb', 'sdaa', 'vda', 'nvme0n1', 'nvme1n2', 'mmcblk0']) {
    assert.equal(resolveDeviceName(ok), ok, `${ok} should be accepted`)
    assert.equal(devicePathFor(ok), `/dev/${ok}`)
  }
  for (const bad of ['sda1', '/dev/sda', '../sda', 'sda;rm', 'nvme0n1p1', '', ' ', 'loop0', 'dm-0', 'sd', null, 42]) {
    assert.equal(resolveDeviceName(bad), null, `${String(bad)} must be refused`)
  }
  assert.throws(() => devicePathFor('sda1'))
})

test('COLLECT-2 configuration refuses to run without a usable device', () => {
  assert.throws(() => loadCollectorConfig({}), /AEGIS_DISK_HEALTH_DEVICE/)
  assert.throws(() => loadCollectorConfig({ AEGIS_DISK_HEALTH_DEVICE: '/dev/sda' }), /AEGIS_DISK_HEALTH_DEVICE/)
  assert.throws(() => loadCollectorConfig({ AEGIS_DISK_HEALTH_DEVICE: 'sda', AEGIS_DISK_HEALTH_SMARTCTL: 'smartctl' }), /absolute/)
  assert.throws(() => loadCollectorConfig({ AEGIS_DISK_HEALTH_DEVICE: 'sda', AEGIS_DISK_HEALTH_OUTPUT: 'relative.json' }), /absolute/)
  const config = loadCollectorConfig({ AEGIS_DISK_HEALTH_DEVICE: ' nvme0n1 ' })
  assert.deepEqual(config, { device: 'nvme0n1', devicePath: '/dev/nvme0n1', smartctlPath: DEFAULT_SMARTCTL_PATH, outputPath: DEFAULT_OUTPUT_PATH })
})

test('COLLECT-3 the collector executes exactly the fixed binary with the fixed arguments', async () => {
  const calls = []
  const stdout = await fixtureText('smartctl-sata-healthy.json')
  const evidence = await collectDiskHealth(CONFIG, {
    execFile: async (file, args) => { calls.push({ file, args }); return { stdout, exitStatus: 0 } },
    now: NOW,
  })
  assert.deepEqual(calls, [{ file: '/usr/sbin/smartctl', args: [...SMARTCTL_ARGS, '/dev/sda'] }])
  // No flag that could write to, self-test, or reconfigure the device.
  for (const forbidden of ['-t', '-s', '-X', '--test', '--smart=', '--set=']) {
    assert.ok(!SMARTCTL_ARGS.some((arg) => arg.startsWith(forbidden)), `${forbidden} must not be passed`)
  }
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.measuredAt, '2026-09-03T02:00:00.000Z')
  assert.equal(evidence.device, 'sda')
  assert.equal(evidence.disk.available, true)
  assert.equal(evidence.disk.model, 'AEGIS-FIXTURE M.2 2280 128GB')
  assert.equal(JSON.stringify(evidence).includes('FIXTURE-SERIAL'), false)
})

test('COLLECT-4 an absent smartctl is an explicit reason, not a crash and not a healthy disk', async () => {
  const enoent = Object.assign(new Error('spawn smartctl ENOENT'), { code: 'ENOENT' })
  const evidence = await collectDiskHealth(CONFIG, { execFile: async () => { throw enoent }, now: NOW })
  assert.deepEqual(evidence.disk, { available: false, reason: 'smartctl-absent' })
  assert.equal(evidence.device, 'sda')
})

test('COLLECT-5 permission, timeout and unknown spawn failures each carry their own reason', async () => {
  const withCode = (code) => async () => { throw Object.assign(new Error(code), { code }) }
  assert.equal((await collectDiskHealth(CONFIG, { execFile: withCode('EACCES'), now: NOW })).disk.reason, 'smartctl-not-executable')
  assert.equal((await collectDiskHealth(CONFIG, { execFile: withCode('ETIMEDOUT'), now: NOW })).disk.reason, 'smartctl-timeout')
  assert.equal((await collectDiskHealth(CONFIG, { execFile: async () => { throw new Error('boom') }, now: NOW })).disk.reason, 'smartctl-failed')
})

test('COLLECT-6 a failing disk exit status is read as evidence, not treated as a tool error', async () => {
  const stdout = await fixtureText('smartctl-sata-failing.json')
  const evidence = await collectDiskHealth(CONFIG, { execFile: async () => ({ stdout, exitStatus: 8 }), now: NOW })
  assert.equal(evidence.disk.available, true)
  assert.equal(evidence.disk.smart.passed, false)
  assert.ok(evidence.disk.warnings.includes('smart-failed'))
})

test('COLLECT-7 a device the tool could not open is unavailable with reason device-open-failed', async () => {
  const stdout = JSON.stringify({ smartctl: { exit_status: 2, messages: [{ string: 'Permission denied', severity: 'error' }] } })
  const evidence = await collectDiskHealth(CONFIG, { execFile: async () => ({ stdout, exitStatus: 2 }), now: NOW })
  assert.deepEqual(evidence.disk, { available: false, reason: 'device-open-failed' })
})

test('COLLECT-8 non-JSON or oversized output is unsupported-output', async () => {
  assert.equal((await collectDiskHealth(CONFIG, { execFile: async () => ({ stdout: 'smartctl 7.4 (text mode)', exitStatus: 0 }), now: NOW })).disk.reason, 'unsupported-output')
  assert.equal((await collectDiskHealth(CONFIG, { execFile: async () => ({ stdout: 'x'.repeat(1024 * 1024 + 1), exitStatus: 0 }), now: NOW })).disk.reason, 'unsupported-output')
})

test('COLLECT-9 the evidence file is written to a temp name and renamed into place', async () => {
  const ops = []
  const fakeFs = {
    writeFile: async (p, body, opts) => { ops.push(['write', p, opts.mode]); JSON.parse(body) },
    rename: async (from, to) => { ops.push(['rename', from, to]) },
  }
  await writeEvidenceFile('/var/lib/aegis-disk-health/disk-health.json', { schemaVersion: 1 }, { fs: fakeFs })
  assert.equal(ops.length, 2)
  assert.equal(ops[0][0], 'write')
  assert.ok(ops[0][1].startsWith('/var/lib/aegis-disk-health/disk-health.json.tmp-'))
  assert.equal(ops[0][2], 0o640, 'group-readable (aegis-telemetry) and nothing for others')
  assert.deepEqual(ops[1], ['rename', ops[0][1], '/var/lib/aegis-disk-health/disk-health.json'])
})

test('COLLECT-10 the collector is the only module allowed to reference child_process', async () => {
  const collectorsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'collectors')
  const smart = await fs.readFile(path.join(collectorsDir, 'smart.js'), 'utf8')
  assert.ok(!smart.includes('child_process'), 'the parser must stay pure')
  const collector = await fs.readFile(path.join(collectorsDir, 'disk-health.js'), 'utf8')
  assert.ok(collector.includes("from 'node:child_process'"))
  // execFile, never a shell: no `exec(`, no `spawn(` with shell, no string command.
  assert.ok(!/\bexec\(|shell:\s*true|spawn\(/.test(collector), 'no shell interpretation of any argument')
})
