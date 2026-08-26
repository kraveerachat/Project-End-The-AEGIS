// tests/deploy.test.js — AEGIS host telemetry agent · deployment packaging
//
// The unit file is the security boundary in production, so it is asserted here
// rather than left to a reviewer's eye. Two kinds of claim are checked:
//
//   required   directives that must be present for the boundary to hold.
//   forbidden  directives that are commonly recommended but would BREAK this
//              agent — each one is listed with the read it would break. This is
//              the half a generic hardening checklist gets wrong.
//
// What these tests cannot do is execute systemd. Running the unit and
// confirming the five reads still succeed under it remains a Linux-host step
// before deployment; see deploy/README.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_SOCKET_PATH, SOCKET_MODE } from '../src/config.js'

const DEPLOY_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'deploy')
const unit = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-telemetry.service'), 'utf8')
const sysusers = await fs.readFile(path.join(DEPLOY_DIR, 'aegis-telemetry.sysusers.conf'), 'utf8')

/** Directive lookup that ignores comments, so a commented-out line never counts. */
const directives = new Map(
  unit.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => {
      const index = line.indexOf('=')
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()]
    }),
)

test('the service runs as the dedicated unprivileged identity', () => {
  assert.equal(directives.get('User'), 'aegis-telemetry')
  assert.equal(directives.get('Group'), 'aegis-telemetry')
  assert.equal(directives.get('DynamicUser'), undefined, 'a dynamic UID cannot be joined by Drive group_add')
})

test('the socket directory is created by systemd and closed to unrelated users', () => {
  assert.equal(directives.get('RuntimeDirectory'), 'aegis-telemetry')
  // 0750: owner rwx, group r-x so Drive (joined to GID 29100) can traverse to
  // the socket, and nothing for anyone else on the host.
  assert.equal(directives.get('RuntimeDirectoryMode'), '0750')
  // 0007 makes the default creation mode 0660, matching what the agent chmods.
  assert.equal(directives.get('UMask'), '0007')
  assert.equal(SOCKET_MODE, 0o660)
  assert.ok(DEFAULT_SOCKET_PATH.startsWith('/run/aegis-telemetry/'))
})

test('sysusers pins the approved numeric GID so Drive group_add can match it', () => {
  const line = sysusers.split('\n').find((row) => row.trim().startsWith('u '))
  assert.ok(line, 'a user entry must exist')
  assert.match(line, /aegis-telemetry/)
  assert.match(line, /\b29100\b/, 'the GID Drive will be added to must be fixed, not allocated')
  assert.match(line, /nologin|false/, 'the service identity must not be able to log in')
})

test('the agent is granted no capability and cannot gain one', () => {
  assert.equal(directives.get('NoNewPrivileges'), 'true')
  assert.equal(directives.get('CapabilityBoundingSet'), '', 'the bounding set must be emptied')
  assert.equal(directives.get('AmbientCapabilities'), '')
  for (const forbidden of ['CAP_SYS_ADMIN', 'CAP_NET_ADMIN', 'CAP_SYS_RAWIO', 'CAP_DAC_READ_SEARCH']) {
    assert.ok(!unit.includes(forbidden), `${forbidden} must never appear in this unit`)
  }
})

test('only AF_UNIX is reachable, which makes a TCP listener impossible', () => {
  assert.equal(directives.get('RestrictAddressFamilies'), 'AF_UNIX')
  assert.equal(directives.get('IPAddressDeny'), 'any')
})

test('the filesystem-hardening directives proven compatible with the five reads are present', () => {
  // Each of these leaves /proc/stat, /proc/meminfo, /proc/uptime and
  // /sys/class/net/<iface>/statistics/* readable.
  const expected = {
    ProtectSystem: 'strict',      // /usr, /boot, /etc read-only; /proc and /sys unaffected
    ProtectHome: 'true',
    PrivateTmp: 'true',
    PrivateDevices: 'true',       // private /dev only; does not touch /proc or /sys
    ProtectKernelTunables: 'true',
    ProtectKernelModules: 'true',
    ProtectKernelLogs: 'true',
    ProtectControlGroups: 'true',
    ProtectHostname: 'true',
    ProtectClock: 'true',
    ProtectProc: 'invisible',     // hides other PIDs; the aggregate files are not per-PID
    RestrictNamespaces: 'true',
    RestrictRealtime: 'true',
    RestrictSUIDSGID: 'true',
    LockPersonality: 'true',
    SystemCallArchitectures: 'native',
  }
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(directives.get(key), value, `${key} must be ${value}`)
  }
})

test('directives that would break the required reads are absent, each for a stated reason', () => {
  const forbidden = {
    // Would restrict /proc to PID directories, hiding /proc/stat, /proc/meminfo
    // and /proc/uptime — the agent would report everything unavailable.
    ProcSubset: 'hides the aggregate /proc files this agent reads',
    // Would give the agent its own network namespace, where enp1s0 does not
    // exist — /sys/class/net would contain only lo.
    PrivateNetwork: 'removes the interface whose counters are being read',
    // Would make /sys entirely inaccessible.
    ProtectKernelTunablesStrict: 'not a real directive; guards against a typo',
    // V8 needs writable-executable pages; this kills Node at startup.
    MemoryDenyWriteExecute: 'breaks the V8 JIT',
    // A private mount namespace for /run would hide the socket from Drive.
    PrivateMounts: 'would hide the RuntimeDirectory from the Drive bind mount',
    // Would prevent the agent from ever being reachable by Drive.
    PrivateUsers: 'breaks the shared GID 29100 Drive relies on',
  }
  for (const [key, why] of Object.entries(forbidden)) {
    assert.equal(directives.get(key), undefined, `${key} must not be set — ${why}`)
  }
})

test('every forbidden directive is documented rather than silently omitted', async () => {
  const readme = await fs.readFile(path.join(DEPLOY_DIR, 'README.md'), 'utf8')
  for (const key of ['ProcSubset', 'PrivateNetwork', 'MemoryDenyWriteExecute', 'PrivateUsers', 'PrivateMounts']) {
    assert.ok(readme.includes(key), `README must explain why ${key} is not used`)
  }
  // The unit itself must carry the reasoning too — a reviewer reading only the
  // unit should not have to guess why an "obvious" hardening line is missing.
  for (const key of ['ProcSubset', 'PrivateNetwork', 'MemoryDenyWriteExecute']) {
    assert.ok(unit.includes(key), `the unit must comment on ${key}`)
  }
})

test('the packaging installs nothing and starts nothing by itself', async () => {
  const entries = await fs.readdir(DEPLOY_DIR)
  for (const entry of entries) {
    assert.ok(
      !entry.endsWith('.sh') || entry.startsWith('verify-'),
      `${entry}: deployment must stay declarative; only a read-only verify script is allowed`,
    )
  }
  assert.equal(directives.get('WantedBy'), 'multi-user.target')
  assert.equal(
    unit.includes('systemctl enable'), false,
    'a unit file must not try to enable itself',
  )
})
