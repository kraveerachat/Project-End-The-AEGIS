import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as store from '../server/db/store.js'

const monitorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repositoryRoot = path.resolve(monitorRoot, '..')

const verifiedMachineA = {
  kind: 'ed25519',
  verifiedNode: { nodeId: 'machine-a', keyVersion: 4, physicalCameraId: 41 },
}

test('strict heartbeat authority is one authenticated physical camera, independent of logical alias claims', () => {
  assert.equal(typeof store.prepareHeartbeatWrite, 'function')

  const cam01 = store.prepareHeartbeatWrite({
    cameraId: 'CAM-01', nodeId: 'forged-node', physicalCameraId: 999,
    cameraConnected: false, streamUrl: 'http://127.0.0.1:18077/stream.mjpg',
  }, verifiedMachineA)
  const cam02 = store.prepareHeartbeatWrite({
    cameraId: 'CAM-02', nodeId: 'another-forged-node', physicalCameraId: 1000,
    cameraConnected: false, streamUrl: 'http://127.0.0.1:18077/stream.mjpg',
  }, verifiedMachineA)

  assert.equal(cam01.kind, 'physical')
  assert.equal(cam01.nodeId, 'machine-a')
  assert.equal(cam01.physicalCameraId, 41)
  assert.equal(cam01.cameraId, undefined)
  assert.deepEqual(cam01, cam02)
})

test('strict heartbeat fails closed without complete authenticated physical provenance', () => {
  assert.equal(typeof store.prepareHeartbeatWrite, 'function')
  for (const verifiedNode of [
    null,
    { nodeId: '', keyVersion: 4, physicalCameraId: 41 },
    { nodeId: 'machine-a', keyVersion: 4, physicalCameraId: 0 },
    { nodeId: 'machine-a', keyVersion: 4, physicalCameraId: 'forged' },
  ]) {
    const result = store.prepareHeartbeatWrite(
      { cameraConnected: false },
      { kind: 'ed25519', verifiedNode },
    )
    assert.deepEqual(result, { error: 'invalid physical provenance', status: 401 })
  }
})

test('bounded legacy heartbeat compatibility remains logical and explicitly separate', () => {
  assert.equal(typeof store.prepareHeartbeatWrite, 'function')
  const legacy = store.prepareHeartbeatWrite({
    cameraId: 'CAM-02', nodeId: 'detector-b', cameraConnected: true,
    streamUrl: 'http://127.0.0.1:8077/stream.mjpg',
  }, { kind: 'legacy_unverified' })

  assert.equal(legacy.kind, 'legacy')
  assert.equal(legacy.cameraId, 'CAM-02')
  assert.equal(legacy.nodeId, 'detector-b')
  assert.equal(legacy.physicalCameraId, undefined)
})

test('detector status treats authenticated physical heartbeat as authoritative over stale strict-node legacy telemetry', async () => {
  const nowMs = Date.UTC(2026, 8, 29, 12, 0, 0)
  let emittedSql = ''
  const status = await store.readDetectorStatus({
    postgresEnabled: true,
    nowMs,
    executeQuery: async (sql) => {
      emittedSql = sql
      return {
        rows: [
          {
            source_kind: 'physical',
            node_id: 'machine-a',
            camera_key: '41',
            last_seen_ms: nowMs - 5_000,
            ingest_auth_mode: 'ed25519_required',
            node_active: true,
          },
          {
            source_kind: 'legacy',
            node_id: 'machine-a',
            camera_key: 'CAM-01',
            last_seen_ms: nowMs - 90_000,
            ingest_auth_mode: 'ed25519_required',
            node_active: true,
          },
        ],
      }
    },
  })

  assert.match(emittedSql, /physical_camera_heartbeat/)
  assert.match(emittedSql, /camera_heartbeat/)
  assert.deepEqual(status, { status: 'online', ageMs: 5_000, cameras: 1 })
})

test('detector status retains bounded legacy heartbeat compatibility for legacy-mode nodes without physical telemetry', async () => {
  const nowMs = Date.UTC(2026, 8, 29, 12, 0, 0)
  const status = await store.readDetectorStatus({
    postgresEnabled: true,
    nowMs,
    executeQuery: async () => ({
      rows: [
        {
          source_kind: 'legacy',
          node_id: 'legacy-detector',
          camera_key: 'CAM-02',
          last_seen_ms: nowMs - 20_000,
          ingest_auth_mode: 'legacy_shared_key',
          node_active: true,
        },
      ],
    }),
  })

  assert.deepEqual(status, { status: 'degraded', ageMs: 20_000, cameras: 1 })
})

test('active Machine A deployment contract has no diagnostic bridge or dual logical heartbeat loop', () => {
  const activePaths = [
    'IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example',
    'IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/README.md',
    'IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/install_autostart.ps1',
    'IDEA2-AEGIS_CCTV-Operator/detection-engine/windows/run_detection_tunnel.ps1',
  ]
  for (const relativePath of activePaths) {
    const source = fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8')
    assert.doesNotMatch(source, /127\.0\.0\.1:18078/)
    assert.doesNotMatch(source, /CAM-01[^\r\n]*(heartbeat|availability)[^\r\n]*CAM-02/i)
  }
})
