// tests/helpers.js — shared fakes for the backup agent suite
//
// Nothing here touches a real filesystem, socket, clock, or binary.
import { validateStaticConfig } from '../src/config.js'

/** A static config shaped like the production host, with fixture paths. */
export function fixtureConfig(overrides = {}) {
  return validateStaticConfig({
    schemaVersion: 1,
    socketPath: '/run/aegis-backup/backup.sock',
    stateDir: '/var/lib/aegis-backup',
    source: { datalakePath: '/var/lib/docker/volumes/aegis_drive_storage/_data' },
    postgres: { host: '172.18.0.2', port: 5432, database: 'aegis_drive', user: 'drive_backup', passwordFile: '/etc/aegis/backup-agent.pgpass' },
    restic: { binary: '/usr/bin/restic', passwordFile: '/etc/aegis/backup-agent.restic-password' },
    targets: [
      { id: 'usb-external-1', label: 'External USB SSD', type: 'external-mount', mountPoint: '/mnt/aegis-backup', repositoryPath: '/mnt/aegis-backup/aegis-restic' },
      { id: 'same-disk-dir', label: 'Directory on the system SSD', type: 'external-mount', mountPoint: '/srv/backup', repositoryPath: '/srv/backup/aegis-restic' },
      { id: 'offsite-sftp', label: 'Off-site SFTP', type: 'off-host-sftp', repository: 'sftp:aegis@nas.internal:/aegis-restic' },
    ],
    limits: { quiesceLeaseSeconds: 600, quiesceAckTimeoutSeconds: 60 },
    ...overrides,
  })
}

/**
 * /proc/self/mountinfo as measured on the production host layout: root on
 * the LVM logical volume (dm-0 over sda3), /boot on sda2, an external USB SSD
 * on sdb1 at /mnt/aegis-backup, and a bind-less /srv/backup that is NOT a
 * mount (so it resolves to `/`).
 */
export const PRODUCTION_MOUNTINFO = [
  '25 1 253:0 / / rw,relatime - ext4 /dev/mapper/ubuntu--vg-ubuntu--lv rw',
  '31 25 8:2 / /boot rw,relatime - ext4 /dev/sda2 rw',
  '40 25 0:30 / /run rw,nosuid,nodev,noexec,relatime - tmpfs tmpfs rw,size=713800k,mode=755',
  '96 25 8:17 / /mnt/aegis-backup rw,relatime - ext4 /dev/sdb1 rw',
  '120 25 0:55 / /mnt/nas rw,relatime - nfs4 nas.internal:/export/aegis rw,vers=4.2',
].join('\n') + '\n'

/** A sysfs view matching PRODUCTION_MOUNTINFO. */
export function productionSys() {
  const slaves = { 'dm-0': ['sda3'] }
  const partitionParent = { sda1: 'sda', sda2: 'sda', sda3: 'sda', sdb1: 'sdb' }

  // major:minor values in PRODUCTION_MOUNTINFO. /sys/dev/block/<major:minor>
  // is the kernel interface available even when systemd PrivateDevices=yes
  // hides the corresponding host block nodes under /dev.
  const majorMinorDevice = {
    '253:0': 'dm-0',
    '8:2': 'sda2',
    '8:17': 'sdb1',
  }

  const sysfsPathFor = (name) => {
    if (partitionParent[name]) {
      return `/sys/devices/pci0000:00/ata1/host0/target0:0:0/0:0:0:0/block/${partitionParent[name]}/${name}`
    }

    if (name === 'dm-0') {
      return '/sys/devices/virtual/block/dm-0'
    }

    return `/sys/devices/pci0000:00/ata1/host0/target0:0:0/0:0:0:0/block/${name}`
  }

  return {
    realpath: async (p) => {
      if (p === '/dev/mapper/ubuntu--vg-ubuntu--lv') return '/dev/dm-0'
      if (p.startsWith('/dev/')) return p

      const devBlock = /^\/sys\/dev\/block\/(\d+:\d+)$/.exec(p)
      if (devBlock) {
        const name = majorMinorDevice[devBlock[1]]
        if (!name) {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        }
        return sysfsPathFor(name)
      }

      const classBlock = /^\/sys\/class\/block\/([^/]+)$/.exec(p)
      if (classBlock) {
        return sysfsPathFor(classBlock[1])
      }

      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },

    readdir: async (p) => {
      const match = /^\/sys\/class\/block\/([^/]+)\/slaves$/.exec(p)
      if (match && slaves[match[1]]) return slaves[match[1]]
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  }
}

export const productionTargetDeps = () => ({
  readMountInfo: async () => PRODUCTION_MOUNTINFO,
  sys: productionSys(),
})

/** In-memory fs for the state directory (policy.json / jobs.json). */
export function memoryFs() {
  const files = new Map()
  return {
    files,
    readFile: async (p) => {
      if (!files.has(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return files.get(p)
    },
    writeFile: async (p, body) => { files.set(p, String(body)) },
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from) },
    mkdir: async () => {},
    rm: async () => {},
    access: async () => {},
    stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
    unlink: async () => {},
    chmod: async () => {},
  }
}

/** A controllable clock plus a timer table the test fires by hand. */
export function fakeClock(startMs = Date.parse('2026-09-03T02:00:00.000Z')) {
  let t = startMs
  const timers = []
  return {
    now: () => t,
    advance(ms) { t += ms },
    set(ms) { t = ms },
    setTimer: (fn, delay) => { const h = { fn, due: t + delay, cleared: false }; timers.push(h); return h },
    clearTimer: (h) => { if (h) h.cleared = true },
    /** Fire every timer whose due time has passed. */
    fireDue() { for (const h of timers) if (!h.cleared && !h.fired && h.due <= t) { h.fired = true; h.fn() } },
    timers,
  }
}

/** Yield to the microtask queue several times so awaited chains progress. */
export const settle = async (turns = 10) => { for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setImmediate(resolve)) }

/** A restic double whose behaviour is a table of results per method. */
export function fakeRestic(results = {}) {
  const calls = []
  const r = (name, fallback) => async (...args) => {
    calls.push([name, ...args])
    const value = results[name]
    return typeof value === 'function' ? value(...args) : (value ?? fallback)
  }
  return {
    calls,
    isInitialized: r('isInitialized', true),
    init: r('init', { ok: true }),
    unlock: r('unlock', { ok: true }),
    backup: r('backup', { ok: true, summary: { snapshotId: 'abc123', bytesScanned: 18_300_000_000, bytesBackedUp: 250_000_000 } }),
    check: r('check', { ok: true }),
    forget: r('forget', { ok: true }),
    listSnapshot: r('listSnapshot', {
      ok: true,
      paths: [
        '/var/lib/aegis-backup/dump/aegis_drive.pgdump',
        '/var/lib/docker/volumes/aegis_drive_storage/_data/uploads',
        '/var/lib/docker/volumes/aegis_drive_storage/_data/versions',
        '/var/lib/docker/volumes/aegis_drive_storage/_data/vault',
        '/var/lib/docker/volumes/aegis_drive_storage/_data/avatars',
      ],
    }),
    restoreTo: r('restoreTo', { ok: true }),
    latestSnapshot: r('latestSnapshot', { snapshotId: 'abc123', time: '2026-09-03T02:00:00.000Z' }),
  }
}
