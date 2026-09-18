// tests/mediaMountInfo.test.js — AEGIS Drive (IDEA1) · mountpoint detection for the media cache directory (Task 2)
//
// ⚠️ Production ต้องพิสูจน์ว่า MEDIA_CACHE_DIR เป็น mountpoint จริง (named volume) จาก /proc/self/mountinfo
//    ไม่ใช่จากความบังเอิญของ device id — ชุดนี้ใช้ mountinfo สังเคราะห์ทั้งหมด และห้ามโค้ดใช้ st_dev
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { detectMountState, parseMountInfo } from '../server/media/mountInfo.js'

let base
before(async () => { base = await fs.mkdtemp(path.join(os.tmpdir(), 'aegis-mountinfo-')) })
after(async () => { await fs.rm(base, { recursive: true, force: true }) })

const line = (id, parent, mountPoint, extra = '') =>
  `${id} ${parent} 0:${id} / ${mountPoint} rw,relatime ${extra}- ext4 /dev/sda1 rw`
async function mountinfo(name, lines) {
  const p = path.join(base, name)
  await fs.writeFile(p, lines.join('\n') + '\n')
  return p
}
const accessOk = async () => {}
const accessFail = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) }

test('MI-1 exact mountpoint entry for the target → volume', async () => {
  const target = '/var/cache/aegis-media'
  const mi = await mountinfo('mi1', [line(20, 1, '/'), line(41, 20, '/var/cache/aegis-media')])
  assert.equal(await detectMountState({ target, mountInfoPath: mi, platform: 'linux', access: accessOk }), 'volume')
})

test('MI-2 octal escapes in mount points are decoded (\\040 \\011 \\012 \\134)', async () => {
  const target = '/var/cache/aegis media'
  const mi = await mountinfo('mi2', [line(20, 1, '/'), line(42, 20, '/var/cache/aegis\\040media')])
  assert.equal(await detectMountState({ target, mountInfoPath: mi, platform: 'linux', access: accessOk }), 'volume')
  const parsed = parseMountInfo('50 20 0:50 / /mnt/a\\040b\\011c\\012d\\134e rw - tmpfs tmpfs rw\n')
  assert.equal(parsed[0].mountPoint, '/mnt/a b\tc\nd\\e')
})

test('MI-3 nested child mount and parent mount are not the target → ephemeral', async () => {
  const target = '/var/cache/aegis-media'
  const mi = await mountinfo('mi3', [line(20, 1, '/'), line(30, 20, '/var/cache'), line(31, 30, '/var/cache/aegis-media/sub')])
  assert.equal(await detectMountState({ target, mountInfoPath: mi, platform: 'linux', access: accessOk }), 'ephemeral')
})

test('MI-4 parent mounted only, target is a writable directory → ephemeral', async () => {
  const target = '/var/cache/aegis-media'
  const mi = await mountinfo('mi4', [line(20, 1, '/'), line(30, 20, '/var/cache')])
  assert.equal(await detectMountState({ target, mountInfoPath: mi, platform: 'linux', access: accessOk }), 'ephemeral')
})

test('MI-5 unreadable mountinfo → unknown; unsupported platform → unknown without reading', async () => {
  const target = '/var/cache/aegis-media'
  assert.equal(await detectMountState({ target, mountInfoPath: path.join(base, 'does-not-exist'), platform: 'linux', access: accessOk }), 'unknown')
  let reads = 0
  const readFile = async () => { reads += 1; return '' }
  assert.equal(await detectMountState({ target, mountInfoPath: path.join(base, 'mi1'), platform: 'win32', access: accessOk, readFile }), 'unknown')
  assert.equal(await detectMountState({ target, mountInfoPath: path.join(base, 'mi1'), platform: 'darwin', access: accessOk, readFile }), 'unknown')
  assert.equal(reads, 0, 'non-linux platforms never read mountinfo')
})

test('MI-6 no entry and target missing/unwritable → unknown (never ephemeral for an unusable directory)', async () => {
  const target = '/var/cache/aegis-media'
  const mi = await mountinfo('mi6', [line(20, 1, '/')])
  assert.equal(await detectMountState({ target, mountInfoPath: mi, platform: 'linux', access: accessFail }), 'unknown')
  const enoent = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  assert.equal(await detectMountState({ target, mountInfoPath: mi, platform: 'linux', access: enoent }), 'unknown')
})

test('MI-7 parseMountInfo tolerates optional fields and whitespace; root untouched; no device-id logic in source', async () => {
  const text = [
    '36 35 98:0 /mnt1 /mnt2 rw,noatime master:1 - ext3 /dev/root rw,errors=continue',
    '40 20 0:40 / /var/cache/aegis-media rw,relatime shared:1 master:2 - ext4 /dev/mapper/vol rw   ',
    '',
    '41 20 0:41 /sub /nested rw - tmpfs tmpfs rw',
  ].join('\n')
  const parsed = parseMountInfo(text)
  assert.equal(parsed.length, 3)
  assert.deepEqual(parsed[0], { mountId: 36, parentId: 35, root: '/mnt1', mountPoint: '/mnt2' })
  assert.deepEqual(parsed[1], { mountId: 40, parentId: 20, root: '/', mountPoint: '/var/cache/aegis-media' })
  assert.deepEqual(parsed[2], { mountId: 41, parentId: 20, root: '/sub', mountPoint: '/nested' })
  const src = await fs.readFile(new URL('../server/media/mountInfo.js', import.meta.url), 'utf8')
  assert.doesNotMatch(src, /st_dev|\.dev\b|statSync\(|statfs/, 'mount detection must not use device ids')
})
