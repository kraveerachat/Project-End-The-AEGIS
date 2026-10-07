import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const monitorRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

const storePath = path.join(
  monitorRoot,
  'server',
  'db',
  'store.js',
)

const schemaPath = path.join(
  monitorRoot,
  'server',
  'db',
  'schema.sql',
)

const attributionPath = path.join(
  monitorRoot,
  'server',
  'db',
  'eventAttribution.js',
)

const store = fs.readFileSync(storePath, 'utf8')
const schema = fs.readFileSync(schemaPath, 'utf8')

function block(startMarker, endMarker) {
  const start = store.indexOf(startMarker)
  assert.notEqual(start, -1, `missing ${startMarker}`)

  const end = store.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(end, -1, `missing ${endMarker}`)

  return store.slice(start, end)
}

const detection = block(
  'export async function insertDetection',
  'export async function insertClip',
)

const alert = block(
  'export async function insertAlert',
  'export async function telegramRouteFor',
)

test('schema already reserves producer_generation for detections and alerts', () => {
  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS detections[\s\S]*?producer_generation BIGINT/,
  )

  assert.match(
    schema,
    /CREATE TABLE IF NOT EXISTS alerts[\s\S]*?producer_generation BIGINT/,
  )
})

test('strict detection INSERT persists producer_generation', () => {
  assert.match(
    detection,
    /INSERT INTO detections\s*\([\s\S]*?producer_generation/,
  )
})

test('strict alert INSERT persists producer_generation', () => {
  assert.match(
    alert,
    /INSERT INTO alerts\s*\([\s\S]*?producer_generation/,
  )
})

test('detection and alert both pass through server-side event attribution validation', () => {
  assert.match(
    detection,
    /validateEventAttribution\s*\(/,
  )

  assert.match(
    alert,
    /validateEventAttribution\s*\(/,
  )
})

test('dedicated event attribution authority exists', () => {
  assert.equal(
    fs.existsSync(attributionPath),
    true,
    'server/db/eventAttribution.js must validate alias/generation against server authority',
  )
})

test('event attribution contract is live-demand fail-closed, not historical alias trust', () => {
  assert.equal(
    fs.existsSync(attributionPath),
    true,
    'event attribution helper does not exist yet',
  )

  const source = fs.readFileSync(attributionPath, 'utf8')

  assert.match(source, /camera_producer_demands/)
  assert.match(source, /camera_producer_epochs/)
  assert.match(source, /logical_camera_id/)
  assert.match(source, /physical_camera_id/)
  assert.match(source, /producerGeneration|producer_generation/)

  // Detection/alert are real-time telemetry. Unlike finalized clips,
  // stale/released/expired demand must not authorize a new event.
  assert.match(source, /released_at\s+IS\s+NULL/i)
  assert.match(source, /lease_expires_at\s*>\s*clock_timestamp\(\)/i)

  // Physical identity must come from verified Agent context.
  assert.match(source, /verifiedNode/)
  assert.match(source, /nodeId/)
})

test('strict Agent identity remains required for attributed live events', () => {
  assert.match(detection, /ingestAuth/)
  assert.match(alert, /ingestAuth/)

  // This test intentionally requires implementation to distinguish
  // strict attributed events from bounded legacy behavior.
  assert.match(
    detection,
    /ingestAuth\?\.kind\s*===\s*['"]ed25519['"]/,
  )

  assert.match(
    alert,
    /ingestAuth\?\.kind\s*===\s*['"]ed25519['"]/,
  )
})
