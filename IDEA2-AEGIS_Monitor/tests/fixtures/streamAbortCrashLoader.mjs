import assert from 'node:assert/strict'

let streamIdleMs
let streamFirstByteMs
let streamRevalidateMs

export function initialize(data) {
  streamIdleMs = data.streamIdleMs
  streamFirstByteMs = data.streamFirstByteMs
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
  const idleDeclaration = original.match(/const STREAM_IDLE_MS = (6_000|20_000)/)
  assert.ok(idleDeclaration)
  assert.match(original, /const STREAM_REVALIDATE_MS = PRODUCER_REVALIDATE_MS/)
  const injectedIdleMs = streamIdleMs === 'scaled'
    ? Number(idleDeclaration[1].replaceAll('_', '')) / 200
    : streamIdleMs
  const source = original
    .replace(idleDeclaration[0], `const STREAM_IDLE_MS = ${injectedIdleMs}`)
    .replace('const STREAM_FIRST_BYTE_MS = 50_000', `const STREAM_FIRST_BYTE_MS = ${streamFirstByteMs}`)
    .replace(
      'const STREAM_REVALIDATE_MS = PRODUCER_REVALIDATE_MS',
      `const STREAM_REVALIDATE_MS = ${streamRevalidateMs}`,
    )
  assert.doesNotMatch(source, /const STREAM_IDLE_MS = (6_000|20_000)/)
  assert.doesNotMatch(source, /const STREAM_REVALIDATE_MS = PRODUCER_REVALIDATE_MS/)
  return { ...loaded, source }
}
