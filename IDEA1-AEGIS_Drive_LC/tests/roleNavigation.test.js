import test from 'node:test'
import assert from 'node:assert/strict'

import { getNavForRole, ROLES } from '../server/rbac/permissions.js'

const ids = (role) => getNavForRole(role).map((item) => item.id)

test('Admin receives the server-wide Storage & Backup navigation entry', () => {
  assert.equal(ids(ROLES.ADMIN).includes('storage'), true)
})

test('DataLake-User does not receive the server-wide Storage & Backup navigation entry', () => {
  assert.equal(ids(ROLES.USER).includes('storage'), false)
})

test('unknown roles remain default-deny', () => {
  assert.deepEqual(getNavForRole('Unknown'), [])
  assert.deepEqual(getNavForRole(null), [])
  assert.deepEqual(getNavForRole(undefined), [])
})
