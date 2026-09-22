// server/routes/integration.js — AEGIS Monitor (IDEA2)
// GET /api/integration/events — bounded, read-only, privacy-safe security-alert
// feed consumed by IDEA3 (AEGIS Lockdown) for cross-IDEA visibility only.
//
// ⚠️ Scope boundary (IDEA3 PR11 combined visibility PR):
//   - Dedicated service credential only (requireIdea3IntegrationKey, checked
//     against `Authorization: Bearer <token>` — the fixed contract IDEA3's own
//     httpJsonClient.js sends) — never a human SOC session, never cookies,
//     never CSRF state.
//   - GET only; this router registers no other verb on this path.
//   - Reuses the existing alerts persistence as-is via
//     readIntegrationSecurityEvents; adds no new table, no new write path, and
//     never touches camera streams, PTZ, codecs, ML models, or operator state.
//   - Never exposes snapshot_path, matched_name, alert title, or Telegram
//     routing — only bounded, privacy-safe fields.
//   - Emits the single event_type the current IDEA3 contract accepts:
//     ACCESS_DENIED (an unauthorized/unrecognized-person detection is the
//     IDEA2 analogue of an access-denied event).
//   - `status` reuses the SAME checkDb() /healthz already calls (server/
//     index.js) plus readDetectorStatus() (server/db/store.js), which reuses
//     the SAME statusFromAge()/heartbeat-age logic /api/link already uses —
//     no new health logic, no duplicated business rule, aggregated across
//     all cameras instead of one operator's visible subset. This exists
//     because IDEA3's honest ONLINE/DEGRADED/UNKNOWN requirement (PR11 MVP
//     scope freeze §5.2) needs Monitor's OWN service AND detector-engine
//     truth, not merely "did this HTTP request succeed".
import { Router } from 'express'
import { requireIdea3IntegrationKey } from '../middleware/requireIdea3IntegrationKey.js'
import { readIntegrationSecurityEvents, readDetectorStatus } from '../db/store.js'
import { checkDb } from '../db/connection.js'

export const integrationRouter = Router()

// Bounded well under the 256 KiB envelope ceiling IDEA3 enforces on its side.
const MAX_EVENTS = 200

integrationRouter.get('/api/integration/events', requireIdea3IntegrationKey, async (req, res, next) => {
  try {
    const [rows, db, detector] = await Promise.all([
      readIntegrationSecurityEvents({ limit: MAX_EVENTS }),
      checkDb(),
      readDetectorStatus(),
    ])
    const events = rows.map((row) => ({
      source: 'IDEA2',
      event_id: `idea2-alert-${row.id}`,
      event_type: 'ACCESS_DENIED',
      severity: row.severity === 'red' ? 'HIGH' : 'WARNING',
      occurred_at: new Date(row.at).toISOString(),
      resource: row.cameraId ? `AEGIS Monitor:${row.cameraId}` : 'AEGIS Monitor',
      evidence: { result: row.severity === 'red' ? 'BLOCKED' : 'DENIED' },
      correlation_key: null,
    }))
    res.json({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      status: {
        ok: db.ok && detector.status === 'online',
        detail: {
          db: db.mode,
          detector: detector.status,
          detectorAgeMs: detector.ageMs,
          detectorCameras: detector.cameras,
        },
      },
      events,
    })
  } catch (err) {
    next(err)
  }
})
