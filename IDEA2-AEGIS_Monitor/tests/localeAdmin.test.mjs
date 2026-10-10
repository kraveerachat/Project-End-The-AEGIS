import test from 'node:test'
import assert from 'node:assert/strict'
import * as admin from '../src/lib/localeAdmin.js'
const { adminMessages } = admin

test('admin copy has Thai and Chinese translations including interpolated identity and age labels', () => {
  for (const source of ['Nodes & routing', 'Camera diagnostics', 'Add operator', 'Cameras for {name}', '{count}s ago']) {
    assert.equal(adminMessages[source]?.length, 2, `missing translations for ${source}`)
    for (const translated of adminMessages[source]) assert.ok(translated && translated !== source)
  }
})

test('admin errors localize only known server messages and preserve camera identifiers', () => {
  assert.equal(typeof admin.adminErrorMessage, 'function')
  const translate = (source, values = {}) => {
    const message = adminMessages[source]?.[0] ?? source
    return message.replace(/\{(\w+)\}/g, (_, key) => String(values[key]))
  }
  assert.equal(admin.adminErrorMessage('Username already exists', translate), 'ชื่อผู้ใช้นี้มีอยู่แล้ว')
  assert.equal(admin.adminErrorMessage('Unknown camera: CAM-02', translate), 'ไม่รู้จักกล้อง: CAM-02')
  assert.equal(admin.adminErrorMessage('Camera CAM-02 is already assigned to an operator', translate), 'กล้อง CAM-02 ถูกมอบหมายให้ผู้ปฏิบัติงานแล้ว')
  assert.equal(admin.adminErrorMessage('Arbitrary upstream detail', translate), 'Arbitrary upstream detail')
})

test('admin translation templates preserve every data placeholder', () => {
  for (const [source, translations] of Object.entries(adminMessages)) {
    const parameters = source.match(/\{\w+\}/g)?.sort() ?? []
    for (const translation of translations) {
      assert.deepEqual(translation.match(/\{\w+\}/g)?.sort() ?? [], parameters, source)
    }
  }
})
