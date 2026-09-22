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
import { Router } from 'express'
import { requireIdea3IntegrationKey } from '../middleware/requireIdea3IntegrationKey.js'
import { readIntegrationSecurityEvents } from '../db/store.js'

export const integrationRouter = Router()

// Bounded well under the 256 KiB envelope ceiling IDEA3 enforces on its side.
const MAX_EVENTS = 200

integrationRouter.get('/api/integration/events', requireIdea3IntegrationKey, async (req, res, next) => {
  try {
    const rows = await readIntegrationSecurityEvents({ limit: MAX_EVENTS })
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
      events,
    })
  } catch (err) {
    next(err)
  }
})
