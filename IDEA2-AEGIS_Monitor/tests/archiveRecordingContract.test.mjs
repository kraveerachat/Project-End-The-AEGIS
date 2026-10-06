import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = (relativePath) => readFileSync(path.join(ROOT, relativePath), 'utf8')

test('PR2 pins the full recording interval to 300 seconds and preserves measured partial duration', () => {
  const config = source('../IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py')
  const attribution = source('server/db/clipAttribution.js')
  const schema = source('server/db/schema.sql')
  const nasSync = source('../IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/nas_sync.py')

  assert.match(config, /segment_seconds:\s*int\s*=\s*300\b/)
  assert.match(attribution, /durationSec > 300 \+ toleranceMs \/ 1000/)
  assert.match(attribution, /Math\.max\(1, Math\.round\(durationSec\)\)/)
  assert.match(schema, /duration_sec\s+INTEGER\s+NOT NULL\s+DEFAULT 300/)
  assert.match(nasSync, /"-c:v", "libx264"/)
  assert.match(nasSync, /"-movflags", "\+faststart"/)
})

test('strict Archive footage burns the same detector annotation path used by Live', () => {
  const engine = source('../IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py')
  const recorder = source('../IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/segment_recorder.py')
  const stream = source('../IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py')

  assert.match(engine, /recorder\.submit_detection\(result, frame\)/)
  assert.match(engine, /if not cfg\.capture_on_demand:[\s\S]*Sink\("record"/)
  assert.match(recorder, /annotate_detection_frame\(result, frame\)/)
  assert.match(stream, /def annotate_detection_frame\(result: DetectionResult, frame: Frame\)/)
})

test('Archive displays measured duration, real video, and a same-origin download action', () => {
  const archive = source('src/views/Archive.jsx')

  assert.match(archive, /clipDurationSeconds\(cl\)/)
  assert.match(archive, /api\/clips\/\$\{cl\.id\}\/video/)
  assert.match(archive, /api\/clips\/\$\{cl\.id\}\/download/)
  assert.match(archive, /<video[\s\S]*src=\{videoUrl\}[\s\S]*controls/)
  assert.match(archive, />Download\s*</)
  assert.doesNotMatch(archive, /SEG_TOTAL_SEC\s*=\s*600/)
})

test('Archive classifies exact strict provenance and renders Thailand-local camera metadata', () => {
  const archive = source('src/views/Archive.jsx')
  const store = source('server/db/store.js')

  assert.match(store, /d\.physical_camera_id = c\.physical_camera_id/)
  assert.match(store, /d\.producer_generation = c\.producer_generation/)
  assert.match(store, /d\.at >= c\.started_at/)
  assert.match(store, /kind: hasUnknown \? 'unknown' : hasAuthorized \? 'auth' : 'unavailable'/)
  assert.match(archive, /THAILAND_TIME_ZONE = 'Asia\/Bangkok'/)
  assert.match(archive, /th-TH-u-ca-buddhist-nu-latn/)
  assert.match(archive, /\{cl\.cam\} · \{cl\.camName \?\? cl\.cam\}/)
  assert.match(archive, /cl\.nodeId/)
  assert.match(archive, /Unknown present/)
})

test('playback and download share auth, camera scope and verified-NAS storage resolution', () => {
  const api = source('server/routes/api.js')
  const store = source('server/db/store.js')

  assert.match(api, /async function resolveStoredClipFile\(user, clipId\)/)
  assert.match(api, /canSeeCamera\(user, clip\.cam\)/)
  assert.match(api, /if \(!clip\.storedOnNas\)/)
  assert.match(api, /path\.basename\(clip\.filePath\)/)
  assert.match(api, /apiRouter\.get\('\/clips\/:id\/video', requireAuth/)
  assert.match(api, /apiRouter\.get\('\/clips\/:id\/download', requireAuth/)
  assert.match(api, /res\.download\(resolved\.absPath, resolved\.filename\)/)
  assert.match(store, /AND c\.stored_on_nas = TRUE/)
})
