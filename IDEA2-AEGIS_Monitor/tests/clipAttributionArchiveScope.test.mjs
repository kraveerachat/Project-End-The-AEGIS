import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { register } from 'node:module'
import test from 'node:test'
import express from 'express'

// Exercise the real HTTP routes. Only the database's clip rows and current
// assignment lookup are substituted; no Engine, NAS, or PostgreSQL is touched.
const routeUrl = new URL('../server/routes/api.js?archive-scope-fixture', import.meta.url)
const storeSource = `
  export async function listClips(visibleIds) {
    return globalThis.archiveScopeFixture.clips
      .filter(clip => visibleIds.has(clip.cam) && clip.storedOnNas)
      .map(({ id, node, cam, start, durationSec, storedOnNas }) =>
        ({ id: String(id), nodeId: `node-${node.toLowerCase()}`, cam, start, durationSec,
          storedOnNas, kind: 'auth', hasAuthorized: true, hasUnknown: false, live: false, segs: [] }));
  }
  export async function getClipById(id) {
    globalThis.archiveScopeFixture.clipLookups.push(String(id));
    const clip = globalThis.archiveScopeFixture.clips.find(row => String(row.id) === String(id));
    return clip && { id: String(clip.id), cam: clip.cam, filePath: clip.filePath,
      storedOnNas: clip.storedOnNas, durationSec: clip.durationSec };
  }
`
const connectionSource = `
  const cameras = [{ id: 'CAM-01', name: 'One' }, { id: 'CAM-02', name: 'Two' }];
  export async function getVisibleCameras(user) {
    const allowed = user.role === 'SOC-Responder' ? ['CAM-01', 'CAM-02']
      : user.id === 1 ? ['CAM-01'] : user.id === 2 ? ['CAM-02'] : [];
    return cameras.filter(camera => allowed.includes(camera.id));
  }
  export async function canSeeCamera(user, cameraId) {
    globalThis.archiveScopeFixture.scopeChecks.push([user.id, cameraId]);
    return (await getVisibleCameras(user)).some(camera => camera.id === cameraId);
  }
  export async function getUserById() { return null; }
  export async function getUserByUsername() { return null; }
  export async function getDetectionNode() { return null; }
  export async function getPhysicalCameraForNode() { return null; }
  export async function updatePasswordHash() { return false; }
`
const loader = `
  export function resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes('/server/routes/api.js?archive-scope-fixture')) {
      if (specifier === '../db/store.js')
        return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(storeSource)}) };
      if (specifier === '../db/connection.js')
        return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(connectionSource)}) };
    }
    return nextResolve(specifier, context);
  }
`
register(`data:text/javascript,${encodeURIComponent(loader)}`)
const { apiRouter } = await import(routeUrl.href)

const generation = '9007199254740993'
const physicalByNode = { A: 41, B: 42, C: 43 }
const clips = Object.entries(physicalByNode).flatMap(([node, physicalCameraId], index) => [
  { id: index * 100 + 1, node, physicalCameraId, producerGeneration: generation,
    cam: 'CAM-01', filePath: `/private/nas/${node}/operator-${node}.mp4`, storedOnNas: true,
    start: 1_760_000_000_000, durationSec: 300 },
  { id: index * 100 + 2, node, physicalCameraId, producerGeneration: generation,
    cam: 'CAM-02', filePath: `/private/nas/${node}/operator2-${node}.mp4`, storedOnNas: true,
    start: 1_760_000_000_000, durationSec: 83 },
])
const users = {
  operator: { id: 1, username: 'operator', role: 'CCTV-Operator' },
  operator2: { id: 2, username: 'operator2', role: 'CCTV-Operator' },
  soc: { id: 3, username: 'soc', role: 'SOC-Responder' },
}

async function archiveHarness(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'aegis-archive-scope-'))
  const fileNames = clips.map(clip => path.basename(clip.filePath))
  for (const name of fileNames) writeFileSync(path.join(directory, name), `verified ${name}`)
  const priorStorage = process.env.CLIPS_STORAGE_DIR
  process.env.CLIPS_STORAGE_DIR = directory
  globalThis.archiveScopeFixture = { clips, clipLookups: [], scopeChecks: [] }
  const app = express()
  app.use((req, _res, next) => {
    const user = users[req.headers['x-test-account']]
    if (user) req.session = { createdAt: Date.now(), user }
    next()
  })
  app.use('/api', apiRouter)
  app.use((_error, _req, res, _next) => res.status(500).json({ error: 'Internal error' }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    for (const name of fileNames) unlinkSync(path.join(directory, name))
    rmdirSync(directory)
    if (priorStorage === undefined) delete process.env.CLIPS_STORAGE_DIR
    else process.env.CLIPS_STORAGE_DIR = priorStorage
    delete globalThis.archiveScopeFixture
  })
  const request = (account, resource) => fetch(`http://127.0.0.1:${server.address().port}/api${resource}`, {
    headers: account ? { 'x-test-account': account } : {},
  })
  return { request, fixture: globalThis.archiveScopeFixture }
}

test('six Node/account mappings retain logical Archive scope despite shared physical provenance', async t => {
  const { request } = await archiveHarness(t)
  for (const [account, expectedCamera, expectedIds] of [
    ['operator', 'CAM-01', ['1', '101', '201']],
    ['operator2', 'CAM-02', ['2', '102', '202']],
  ]) {
    const response = await request(account, '/clips?cameraId=CAM-99')
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.clips.map(clip => clip.cam), [expectedCamera, expectedCamera, expectedCamera])
    assert.deepEqual(body.clips.map(clip => clip.id), expectedIds)
    assert.equal(JSON.stringify(body).includes('/private/nas/'), false)
    assert.equal(JSON.stringify(body).includes('filePath'), false)
    assert.equal(JSON.stringify(body).includes('physicalCameraId'), false)
    assert.equal(JSON.stringify(body).includes('producerGeneration'), false)
    assert.equal(JSON.stringify(body).includes('nodeId'), false)
  }
  const soc = await request('soc', '/clips')
  assert.equal(soc.status, 200)
  const socBody = await soc.json()
  assert.equal(socBody.clips.length, 6)
  assert.deepEqual(
    [...new Set(socBody.clips.map(clip => clip.nodeId))].sort(),
    ['node-a', 'node-b', 'node-c'],
  )
  assert.equal(JSON.stringify(socBody).includes('physicalCameraId'), false)
  assert.equal(JSON.stringify(socBody).includes('producerGeneration'), false)
})

test('direct playback and download enforce logical camera scope before storage resolution', async t => {
  const { request } = await archiveHarness(t)
  for (const clip of clips) {
    for (const account of ['operator', 'operator2', 'soc']) {
      for (const suffix of ['video', 'download']) {
        const response = await request(account, `/clips/${clip.id}/${suffix}`)
        const canSee = account === 'soc' || clip.cam === (account === 'operator' ? 'CAM-01' : 'CAM-02')
        if (canSee) {
          assert.equal(response.status, 200, `${account} ${suffix} ${clip.node}/${clip.cam}`)
          assert.equal(await response.text(), `verified ${path.basename(clip.filePath)}`)
          assert.equal(JSON.stringify([...response.headers]).includes('/private/nas/'), false)
        } else {
          assert.equal(response.status, 403, `${account} ${suffix} ${clip.node}/${clip.cam}`)
          assert.deepEqual(await response.json(), { error: 'Forbidden' })
          assert.equal(response.headers.get('cache-control'), 'no-store')
        }
      }
    }
  }
  const priorStorage = process.env.CLIPS_STORAGE_DIR
  delete process.env.CLIPS_STORAGE_DIR
  try {
    for (const suffix of ['video', 'download']) {
      const forbidden = await request('operator', `/clips/2/${suffix}`)
      assert.equal(forbidden.status, 403, 'other alias must deny before consulting storage configuration')
      assert.deepEqual(await forbidden.json(), { error: 'Forbidden' })
      const own = await request('operator', `/clips/1/${suffix}`)
      assert.equal(own.status, 503, 'own alias reaches the storage boundary')
    }
  } finally {
    process.env.CLIPS_STORAGE_DIR = priorStorage
  }
})

test('unverified clip and anonymous direct ID cannot disclose bytes or a raw storage path', async t => {
  const { request, fixture } = await archiveHarness(t)
  fixture.clips.push({ ...clips[0], id: 901, filePath: '/private/nas/unverified.mp4', storedOnNas: false })
  const list = await request('operator', '/clips')
  assert.equal(list.status, 200)
  assert.equal((await list.json()).clips.some(clip => clip.id === '901'), false)
  for (const suffix of ['video', 'download']) {
    const pending = await request('operator', `/clips/901/${suffix}`)
    assert.equal(pending.status, 409)
    assert.equal(JSON.stringify(await pending.json()).includes('/private/nas/'), false)
    const anonymous = await request(null, `/clips/1/${suffix}`)
    assert.equal(anonymous.status, 401)
    assert.equal(JSON.stringify(await anonymous.json()).includes('/private/nas/'), false)
  }
})
