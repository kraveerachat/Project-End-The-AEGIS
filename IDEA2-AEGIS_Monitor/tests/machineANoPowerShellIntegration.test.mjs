import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { withMachineANoPowerShellHarness } from './fixtures/machineANoPowerShellHarness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const monitorRoot = path.resolve(here, '..')
const engineRoot = path.resolve(monitorRoot, '..', 'IDEA2-AEGIS_CCTV-Operator', 'detection-engine')
const databaseUrl = process.env.AEGIS_MONITOR_TEST_DATABASE_URL
const pythonExecutable = process.env.AEGIS_TASK13_PYTHON

const integrationOptions = {
  databaseUrl,
  pythonExecutable,
  monitorRoot,
  engineRoot,
}

test('built Monitor serves the production shell and applies every migration twice', {
  skip: !databaseUrl || !pythonExecutable,
}, async () => {
  await withMachineANoPowerShellHarness(integrationOptions, async (harness) => {
    const shell = await fetch(`${harness.monitorUrl}/monitor/`)
    assert.equal(shell.status, 200)
    assert.match(await shell.text(), /<div id="root"><\/div>/)
    assert.equal(harness.migrationRuns, 2)
    assert.deepEqual(harness.reservedPorts.sort((a, b) => a - b), [...new Set(harness.reservedPorts)].sort((a, b) => a - b))
    for (const protectedPort of [8077, 8078, 18078]) {
      assert.equal(harness.reservedPorts.includes(protectedPort), false)
    }
  })
})

test('operator and operator2 demand the same Machine A physical Engine under different aliases', {
  skip: !databaseUrl || !pythonExecutable,
}, async () => {
  await withMachineANoPowerShellHarness(integrationOptions, async (harness) => {
    for (const [username, password, alias] of [
      ['operator', 'task13-operator-password', 'CAM-01'],
      ['operator2', 'task13-operator2-password', 'CAM-02'],
    ]) {
      const browser = await harness.login(username, password)
      assert.deepEqual(await harness.engineHealth(), {
        cameraDemanded: false,
        streamViewers: 0,
      })

      const association = await browser.associate()
      assert.equal(association.status, 200)
      assert.equal(association.body.associated, true)
      assert.deepEqual(await harness.engineHealth(), {
        cameraDemanded: false,
        streamViewers: 0,
      }, 'login and local-node association must not create demand')

      const link = await browser.get('/api/link')
      assert.equal(link.status, 200)
      assert.equal(link.body.cameras[0].cam, alias)
      assert.equal(link.body.cameras[0].nodeId, 'machine-a-node')

      const stream = await browser.openStream(alias)
      assert.equal(stream.status, 200)
      assert.match(stream.contentType, /^multipart\/x-mixed-replace;/)
      await harness.waitForEngineState({ cameraDemanded: true, streamViewers: 1 })
      assert.equal(stream.firstChunk.length > 0, true)
      await stream.close()
      await harness.waitForEngineState({ cameraDemanded: false, streamViewers: 0 })
      await browser.logout()
    }

    assert.equal(await harness.physicalCameraForNode('machine-a-node'), 41)
  })
})

test('forged identity and stale verified-node authority fail before Engine demand', {
  skip: !databaseUrl || !pythonExecutable,
}, async () => {
  await withMachineANoPowerShellHarness(integrationOptions, async (harness) => {
    const browser = await harness.login('operator', 'task13-operator-password')

    const forged = await browser.associate({ nodeId: 'forged-machine' })
    assert.equal(forged.status, 403)
    assert.deepEqual(await harness.engineHealth(), { cameraDemanded: false, streamViewers: 0 })

    const valid = await browser.associate()
    assert.equal(valid.status, 200)
    await harness.rotateNodeKeyVersion()

    const stale = await browser.get('/api/cameras/CAM-01/stream?nodeId=forged-machine&physicalCameraId=999')
    assert.equal(stale.status, 403)
    assert.equal(stale.body.error, 'LOCAL_NODE_ASSOCIATION_DENIED')
    assert.deepEqual(await harness.engineHealth(), { cameraDemanded: false, streamViewers: 0 })
  })
})

test('Agent outage recovers without demand and stale heartbeat blocks the physical stream', {
  skip: !databaseUrl || !pythonExecutable,
}, async () => {
  await withMachineANoPowerShellHarness(integrationOptions, async (harness) => {
    const browser = await harness.login('operator2', 'task13-operator2-password')
    await harness.stopAgent()
    await assert.rejects(browser.associate(), /loopback Agent unavailable/)
    assert.deepEqual(await harness.engineHealth(), { cameraDemanded: false, streamViewers: 0 })

    await harness.startAgent()
    assert.equal((await browser.associate()).status, 200)
    assert.deepEqual(await harness.engineHealth(), { cameraDemanded: false, streamViewers: 0 })

    await harness.agePhysicalHeartbeat(60_000)
    const stale = await browser.get('/api/cameras/CAM-02/stream')
    assert.equal(stale.status, 503)
    assert.equal(stale.body.error, 'PHYSICAL_STREAM_UNAVAILABLE')
    assert.deepEqual(await harness.engineHealth(), { cameraDemanded: false, streamViewers: 0 })

    await harness.agePhysicalHeartbeat(0)
    const stream = await browser.openStream('CAM-02')
    await harness.waitForEngineState({ cameraDemanded: true, streamViewers: 1 })
    await stream.close()
    await harness.waitForEngineState({ cameraDemanded: false, streamViewers: 0 })
  })
})

test('integration path has no diagnostic bridge or manual runtime helper dependency', {
  skip: !databaseUrl || !pythonExecutable,
}, async () => {
  await withMachineANoPowerShellHarness(integrationOptions, async (harness) => {
    assert.deepEqual(harness.forbiddenHarnessRequirements, {
      temporaryBridge: false,
      manualCam01Heartbeat: false,
      manualCam02Heartbeat: false,
      manualNpmRuntime: false,
      manualPythonHelperRuntime: false,
    })
  })
})
