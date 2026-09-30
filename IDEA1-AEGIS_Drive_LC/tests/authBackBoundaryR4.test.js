import test from 'node:test'
import assert from 'node:assert/strict'
import {
  armAuthenticatedBackBoundary,
  authenticatedNavigationState,
  handleAuthenticatedBack,
  releaseAuthenticatedBackBoundary,
} from '../src/lib/authBackBoundary.js'

function fakeHistory() {
  const entries = [{ state: null, url: '/drive/dashboard' }]
  let at = 0
  const calls = []
  return {
    get state() { return entries[at].state },
    get length() { return entries.length },
    get at() { return at },
    get calls() { return calls },
    replaceState(state, _unused, url) { entries[at] = { state, url } },
    pushState(state, _unused, url) { entries.splice(++at, Infinity, { state, url }) },
    forward() { calls.push('forward'); at = Math.min(at + 1, entries.length - 1) },
    go(delta) { calls.push(['go', delta]); at = Math.max(0, Math.min(at + delta, entries.length - 1)) },
    back() { at = Math.max(0, at - 1) },
  }
}

test('R4 successful auth arms one bounded entry and Back returns forward without growth', () => {
  const history = fakeHistory()
  armAuthenticatedBackBoundary(history, '/drive/dashboard')
  assert.equal(history.length, 2)
  armAuthenticatedBackBoundary(history, '/drive/dashboard')
  assert.equal(history.length, 2, 'restoration/re-render cannot add a second guard')
  for (let press = 0; press < 3; press++) {
    history.back()
    assert.equal(handleAuthenticatedBack(history), true)
    assert.equal(history.at, 1)
    assert.equal(history.length, 2, 'Back must not push new entries')
  }
})

test('R4 internal navigation remains reversible inside the authenticated boundary', () => {
  const history = fakeHistory()
  armAuthenticatedBackBoundary(history, '/drive/dashboard')
  history.pushState(authenticatedNavigationState(history.state), '', '/drive/files')
  assert.equal(history.length, 3)
  history.back()
  assert.equal(handleAuthenticatedBack(history), false)
  assert.equal(history.at, 1)
  history.back()
  assert.equal(handleAuthenticatedBack(history), true)
  assert.equal(history.at, 1)
})

test('R4 logout/expiration releases boundary and lands on base without trapping Back', () => {
  const history = fakeHistory()
  armAuthenticatedBackBoundary(history, '/drive/dashboard')
  history.pushState(authenticatedNavigationState(history.state), '', '/drive/settings')
  releaseAuthenticatedBackBoundary(history)
  assert.deepEqual(history.calls.at(-1), ['go', -2])
  assert.equal(history.at, 0)
  assert.equal(handleAuthenticatedBack(history, false), false)
})
