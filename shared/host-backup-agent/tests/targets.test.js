// tests/targets.test.js — failure-domain classification against the production layout
import test from 'node:test'
import assert from 'node:assert/strict'

import { PROTECTION, classifyTarget, isProtected, mountEntryFor, parseMountInfo, physicalDisksOf } from '../src/targets.js'
import { PRODUCTION_MOUNTINFO, fixtureConfig, productionSys, productionTargetDeps } from './helpers.js'

const DATALAKE = '/var/lib/docker/volumes/aegis_drive_storage/_data'
const targetById = (id) => fixtureConfig().targets.find((t) => t.id === id)

test('TARGET-1 mountinfo parses into mount point, fstype and source', () => {
  const entries = parseMountInfo(PRODUCTION_MOUNTINFO)
  assert.equal(entries.length, 5)
  assert.deepEqual(entries[0], { mountPoint: '/', fstype: 'ext4', source: '/dev/mapper/ubuntu--vg-ubuntu--lv' })
  assert.deepEqual(entries[3], { mountPoint: '/mnt/aegis-backup', fstype: 'ext4', source: '/dev/sdb1' })
  assert.equal(parseMountInfo('garbage without separator').length, 0)
})

test('TARGET-2 the longest mount-point prefix wins', () => {
  const entries = parseMountInfo(PRODUCTION_MOUNTINFO)
  assert.equal(mountEntryFor(DATALAKE, entries).mountPoint, '/')
  assert.equal(mountEntryFor('/mnt/aegis-backup/aegis-restic', entries).mountPoint, '/mnt/aegis-backup')
  assert.equal(mountEntryFor('/mnt/aegis-backup', entries).mountPoint, '/mnt/aegis-backup')
  assert.equal(mountEntryFor('/mnt/aegis-backupX', entries).mountPoint, '/', 'a sibling name must not match by string prefix')
  assert.equal(mountEntryFor('/srv/backup', entries).mountPoint, '/')
})

test('TARGET-3 LVM over a partition resolves to the physical disk; a USB partition resolves to its own', async () => {
  const sys = productionSys()
  assert.deepEqual([...await physicalDisksOf('/dev/mapper/ubuntu--vg-ubuntu--lv', sys)], ['sda'])
  assert.deepEqual([...await physicalDisksOf('/dev/sdb1', sys)], ['sdb'])
  assert.deepEqual([...await physicalDisksOf('tmpfs', sys)], [], 'a non-device source resolves to nothing')
})

test('TARGET-4 the production Data Lake and a USB SSD are DIFFERENT_DEVICE', async () => {
  const result = await classifyTarget(targetById('usb-external-1'), { datalakePath: DATALAKE, ...productionTargetDeps() })
  assert.equal(result.protection, PROTECTION.DIFFERENT_DEVICE)
  assert.equal(result.fstype, 'ext4')
  assert.equal(isProtected(result.protection), true)
})

test('TARGET-5 a directory on the system SSD with nothing mounted at it is NOT_MOUNTED, not a backup', async () => {
  const result = await classifyTarget(targetById('same-disk-dir'), { datalakePath: DATALAKE, ...productionTargetDeps() })
  assert.equal(result.protection, PROTECTION.NOT_MOUNTED)
  assert.equal(isProtected(result.protection), false)
})

test('TARGET-6 a second filesystem on the SAME physical disk is SAME_FAILURE_DOMAIN', async () => {
  // Pretend /srv/backup is its own ext4 filesystem on sda4 — still sda.
  const mountinfo = PRODUCTION_MOUNTINFO + '130 25 8:4 / /srv/backup rw,relatime - ext4 /dev/sda4 rw\n'
  const sys = productionSys()
  const original = sys.realpath
  sys.realpath = async (p) => (p === '/sys/class/block/sda4' ? '/sys/devices/pci0000:00/ata1/host0/target0:0:0/0:0:0:0/block/sda/sda4' : original(p))
  const result = await classifyTarget(targetById('same-disk-dir'), { datalakePath: DATALAKE, readMountInfo: async () => mountinfo, sys })
  assert.equal(result.protection, PROTECTION.SAME_FAILURE_DOMAIN)
  assert.equal(result.detail, 'shares-physical-disk:sda')
  assert.equal(isProtected(result.protection), false)
})

test('TARGET-7 a network filesystem mount and a remote repository are OFF_HOST', async () => {
  const nfsTarget = { id: 'nas', label: 'NAS', type: 'external-mount', mountPoint: '/mnt/nas', repository: '/mnt/nas/aegis-restic' }
  const nfs = await classifyTarget(nfsTarget, { datalakePath: DATALAKE, ...productionTargetDeps() })
  assert.equal(nfs.protection, PROTECTION.OFF_HOST)
  assert.equal(nfs.fstype, 'nfs4')
  const sftp = await classifyTarget(targetById('offsite-sftp'), { datalakePath: DATALAKE, ...productionTargetDeps() })
  assert.equal(sftp.protection, PROTECTION.OFF_HOST)
  assert.equal(isProtected(sftp.protection), true)
})

test('TARGET-8 unreadable mountinfo or an unresolvable device is UNKNOWN, never READY', async () => {
  const unreadable = await classifyTarget(targetById('usb-external-1'), { datalakePath: DATALAKE, readMountInfo: async () => { throw new Error('EACCES') }, sys: productionSys() })
  assert.equal(unreadable.protection, PROTECTION.UNKNOWN)
  const sys = productionSys()
  sys.realpath = async () => { throw new Error('ENOENT') }
  const unresolved = await classifyTarget(targetById('usb-external-1'), { datalakePath: DATALAKE, readMountInfo: async () => PRODUCTION_MOUNTINFO, sys })
  assert.equal(unresolved.protection, PROTECTION.UNKNOWN)
  assert.equal(isProtected(PROTECTION.UNKNOWN), false)
})
