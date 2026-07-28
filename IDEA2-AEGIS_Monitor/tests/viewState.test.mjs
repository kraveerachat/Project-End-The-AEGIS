import assert from 'node:assert/strict'
import test from 'node:test'
import { VIEW_STATE, getViewState } from '../src/lib/viewState.js'

test('classifies request lifecycle into four mutually exclusive UI states', () => {
  assert.equal(getViewState({ loading: true, data: null, error: null }), VIEW_STATE.LOADING)
  assert.equal(getViewState({ loading: false, data: null, error: 'network' }), VIEW_STATE.ERROR)
  assert.equal(getViewState({ loading: false, data: { alerts: [] }, error: null }, (data) => data.alerts.length === 0), VIEW_STATE.SUCCESS_EMPTY)
  assert.equal(getViewState({ loading: false, data: { alerts: [{ id: 1 }] }, error: null }, (data) => data.alerts.length === 0), VIEW_STATE.SUCCESS_DATA)
})

test('never selects a data state when a request error is present', () => {
  assert.equal(
    getViewState({ loading: false, data: { alerts: [{ id: 1 }] }, error: 'server' }, (data) => data.alerts.length === 0),
    VIEW_STATE.ERROR,
  )
})
