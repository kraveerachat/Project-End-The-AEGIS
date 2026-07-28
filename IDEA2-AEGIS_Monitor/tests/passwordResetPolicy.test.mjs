import assert from 'node:assert/strict'
import test from 'node:test'
import { isPasswordResetEnforced } from '../server/auth/passwordResetPolicy.js'

test('keeps password-reset enforcement enabled unless explicitly disabled for a local demo stack', () => {
  assert.equal(isPasswordResetEnforced(undefined), true)
  assert.equal(isPasswordResetEnforced('true'), true)
  assert.equal(isPasswordResetEnforced('false'), false)
})
