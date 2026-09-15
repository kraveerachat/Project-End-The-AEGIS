import assert from 'node:assert/strict'

let streamIdleMs
let streamRevalidateMs

export function initialize(data) {
  streamIdleMs = data.streamIdleMs
  streamRevalidateMs = data.streamRevalidateMs
}

const storeSource = `
export async function streamSourceFor() {
  return {
    url: 'http://test.invalid/stream.mjpg',
    ageMs: 0,
    cameraConnected: true,
  }
}
export function camerasForUserId() {
  return new Set(['CAM-01'])
}
`
const storeUrl = `data:text/javascript,${encodeURIComponent(storeSource)}`

export function resolve(specifier, context, nextResolve) {
  const apiImportsStore = specifier === '../db/store.js'
    && context.parentURL?.endsWith('/server/routes/api.js')
  const connectionImportsStore = specifier === './store.js'
    && context.parentURL?.endsWith('/server/db/connection.js')
  if (apiImportsStore || connectionImportsStore) {
    return { shortCircuit: true, url: storeUrl }
  }
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  const loaded = await nextLoad(url, context)
  if (!url.endsWith('/server/routes/api.js')) return loaded

  const original = loaded.source.toString()
  assert.match(original, /const STREAM_IDLE_MS = 6_000/)
  assert.match(original, /const STREAM_REVALIDATE_MS = 10_000/)
  const source = original
    .replace('const STREAM_IDLE_MS = 6_000', `const STREAM_IDLE_MS = ${streamIdleMs}`)
    .replace(
      'const STREAM_REVALIDATE_MS = 10_000',
      `const STREAM_REVALIDATE_MS = ${streamRevalidateMs}`,
    )
  assert.doesNotMatch(source, /const STREAM_IDLE_MS = 6_000/)
  assert.doesNotMatch(source, /const STREAM_REVALIDATE_MS = 10_000/)
  return { ...loaded, source }
}
