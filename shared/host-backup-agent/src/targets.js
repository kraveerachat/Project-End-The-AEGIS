// src/targets.js — AEGIS host backup agent · failure-domain classification
//
// A backup that lives on the same physical disk as the data it protects is not
// a backup; it is a second copy that dies in the same event. This module
// decides, from kernel evidence only, whether a configured target actually
// sits on different hardware:
//
//   /proc/self/mountinfo        which block device backs the mount under a path
//   /sys/class/block/<dev>      partition -> parent disk, and for device-mapper
//   /sys/class/block/<dev>/slaves  (LVM, dm-crypt) the physical members underneath
//
// The production layout is exactly the hard case: /var/lib/docker sits on
// ubuntu--vg-ubuntu--lv (dm-0) whose only slave is sda3, on sda. A USB disk
// mounted at /mnt/aegis-backup resolves to sdb1 -> sdb. Same disk == same
// failure domain, and the agent says so instead of reporting READY.
//
// Everything is injected so the resolution can be tested against a fixture
// of the real host's mountinfo and sysfs on any platform.
import path from 'node:path'

export const PROTECTION = Object.freeze({
  OFF_HOST: 'OFF_HOST',
  DIFFERENT_DEVICE: 'DIFFERENT_DEVICE',
  SAME_FAILURE_DOMAIN: 'SAME_FAILURE_DOMAIN',
  NOT_MOUNTED: 'NOT_MOUNTED',
  UNKNOWN: 'UNKNOWN',
})

/** Filesystem types that are, by construction, on another machine. */
const NETWORK_FSTYPES = new Set(['nfs', 'nfs4', 'cifs', 'smb3', 'fuse.sshfs', 'ceph', 'glusterfs', '9p'])

/** Unescape the octal sequences mountinfo uses for spaces and tabs in paths. */
const unescapeMount = (value) => value.replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))

/**
 * Parse /proc/self/mountinfo into entries.
 *
 * Field layout: `id parent maj:min root mountPoint options [optional...] - fstype source superOptions`.
 */
export function parseMountInfo(text) {
  const entries = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) continue
    const separator = line.indexOf(' - ')
    if (separator === -1) continue
    const head = line.slice(0, separator).split(' ')
    const tail = line.slice(separator + 3).split(' ')
    if (head.length < 6 || tail.length < 2) continue
    entries.push({
      majorMinor: head[2],
      mountPoint: unescapeMount(head[4]),
      fstype: tail[0],
      source: unescapeMount(tail[1]),
    })
  }
  return entries
}

/** The mount entry holding `target`: longest mount point that is a prefix of it. */
export function mountEntryFor(target, entries) {
  const normalized = path.posix.normalize(target)
  let best = null
  for (const entry of entries) {
    const mp = entry.mountPoint === '/' ? '/' : entry.mountPoint.replace(/\/+$/, '')
    const matches = mp === '/' || normalized === mp || normalized.startsWith(mp + '/')
    if (matches && (!best || mp.length > best.mountPoint.length)) best = { ...entry, mountPoint: mp }
  }
  return best
}

/**
 * Resolve a block device node to the set of physical disk names beneath it.
 *
 * @param {string} source the mount source, e.g. /dev/mapper/ubuntu--vg-ubuntu--lv or /dev/sdb1
 * @param {object} sys injected sysfs access
 * @param {(p: string) => Promise<string>} sys.realpath
 * @param {(p: string) => Promise<string[]>} sys.readdir rejects when absent
 * @returns {Promise<Set<string>>}
 */
export async function physicalDisksOf(source, sys, majorMinor = null) {
  const disks = new Set()

  // systemd PrivateDevices=yes intentionally hides the host block-device
  // nodes under /dev from the service. mountinfo still exposes the kernel
  // major:minor identity, and /sys/dev/block remains sufficient to resolve
  // the real backing device without weakening the service sandbox.
  let node = null

  if (typeof majorMinor === 'string' && /^\d+:\d+$/.test(majorMinor)) {
    try {
      node = await sys.realpath(`/sys/dev/block/${majorMinor}`)
    } catch {
      node = null
    }
  }

  // Backward-compatible fallback for environments where /dev is visible or
  // where /sys/dev/block is unavailable.
  if (!node) {
    if (typeof source !== 'string' || !source.startsWith('/dev/')) return disks
    try {
      node = await sys.realpath(source)
    } catch {
      return disks
    }
  }

  const start = path.posix.basename(node)
  const seen = new Set()
  const queue = [start]

  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)

    // device-mapper / md: members are listed under slaves/
    let slaves = []
    try {
      slaves = await sys.readdir(`/sys/class/block/${name}/slaves`)
    } catch {
      slaves = []
    }
    if (slaves.length) {
      queue.push(...slaves)
      continue
    }

    // partition: /sys/class/block/sda3 -> .../block/sda/sda3, parent dir is the disk
    let real
    try {
      real = await sys.realpath(`/sys/class/block/${name}`)
    } catch {
      real = null
    }
    if (real) {
      const parent = path.posix.basename(path.posix.dirname(real))
      if (parent && parent !== 'block' && parent !== name) {
        queue.push(parent)
        continue
      }
    }
    disks.add(name)
  }
  return disks
}

/**
 * Classify one target against the Data Lake source.
 *
 * @param {object} target a validated target from config.js
 * @param {object} options
 * @param {string} options.datalakePath
 * @param {() => Promise<string>} options.readMountInfo
 * @param {object} options.sys realpath/readdir over /sys and /dev
 * @returns {Promise<{ protection: string, fstype: string|null, detail: string }>}
 */
export async function classifyTarget(target, { datalakePath, readMountInfo, sys }) {
  if (target.type === 'off-host-sftp' || target.type === 'off-host-rest') {
    return { protection: PROTECTION.OFF_HOST, fstype: null, detail: 'remote-repository' }
  }

  let entries
  try {
    entries = parseMountInfo(await readMountInfo())
  } catch {
    return { protection: PROTECTION.UNKNOWN, fstype: null, detail: 'mountinfo-unreadable' }
  }

  const mount = mountEntryFor(target.mountPoint, entries)
  const normalizedMountPoint = target.mountPoint.replace(/\/+$/, '') || '/'
  // "Something is mounted at exactly this path" is the whole question. A
  // directory that merely exists on the root filesystem resolves to `/`.
  if (!mount || mount.mountPoint !== normalizedMountPoint) {
    return { protection: PROTECTION.NOT_MOUNTED, fstype: null, detail: 'no-filesystem-mounted-at-mount-point' }
  }
  if (NETWORK_FSTYPES.has(mount.fstype)) {
    return { protection: PROTECTION.OFF_HOST, fstype: mount.fstype, detail: 'network-filesystem' }
  }

  const sourceMount = mountEntryFor(datalakePath, entries)
  const targetDisks = await physicalDisksOf(mount.source, sys, mount.majorMinor)
  const sourceDisks = sourceMount
    ? await physicalDisksOf(sourceMount.source, sys, sourceMount.majorMinor)
    : new Set()
  if (targetDisks.size === 0 || sourceDisks.size === 0) {
    return { protection: PROTECTION.UNKNOWN, fstype: mount.fstype, detail: 'physical-device-unresolved' }
  }
  for (const disk of targetDisks) {
    if (sourceDisks.has(disk)) {
      return { protection: PROTECTION.SAME_FAILURE_DOMAIN, fstype: mount.fstype, detail: `shares-physical-disk:${disk}` }
    }
  }
  return { protection: PROTECTION.DIFFERENT_DEVICE, fstype: mount.fstype, detail: 'separate-physical-disk' }
}

/** Is a classification good enough to count as a protected backup target? */
export const isProtected = (protection) =>
  protection === PROTECTION.OFF_HOST || protection === PROTECTION.DIFFERENT_DEVICE

/** Default kernel access, used by the real agent. */
export async function defaultTargetDeps() {
  const fs = await import('node:fs/promises')
  return {
    readMountInfo: () => fs.readFile('/proc/self/mountinfo', 'utf8'),
    sys: {
      realpath: (p) => fs.realpath(p),
      readdir: (p) => fs.readdir(p),
    },
  }
}
