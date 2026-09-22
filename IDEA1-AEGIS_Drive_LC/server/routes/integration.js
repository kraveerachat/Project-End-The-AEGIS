// server/routes/integration.js — AEGIS Drive (IDEA1)
// GET /api/integration/events — bounded, read-only, privacy-safe security-event
// feed consumed by IDEA3 (AEGIS Lockdown) for cross-IDEA visibility only.
//
// ⚠️ Scope boundary (IDEA3 PR11 combined visibility PR):
//   - Dedicated service credential only (requireIdea3IntegrationKey, checked
//     against `Authorization: Bearer <token>` — the fixed contract IDEA3's own
//     httpJsonClient.js sends) — never a human Admin session, never cookies,
//     never CSRF state.
//   - GET only; this router registers no other verb on this path.
//   - Reuses the existing privacy-preserving audit_log persistence as-is; adds
//     no new table, no new write path, and mutates nothing.
//   - Emits only DENIED/BLOCKED audit rows (already stripped of actor_label,
//     role, and target_hash by readIntegrationSecurityEvents) as the single
//     event_type the current IDEA3 contract accepts: ACCESS_DENIED.
//   - `status` reuses the SAME checkDb() the unauthenticated /healthz route
//     already calls (server/app.js) — no new health logic, no duplicated
//     business rule. This exists because IDEA3's honest ONLINE/DEGRADED/
//     UNKNOWN requirement (PR11 MVP scope freeze §5.1) needs Drive's OWN
//     daemon/db truth, not merely "did this HTTP request succeed".
import { Router } from 'express'
import { requireIdea3IntegrationKey } from '../middleware/requireIdea3IntegrationKey.js'
import { readIntegrationSecurityEvents, checkDb } from '../db/connection.js'

export const integrationRouter = Router()

// Bounded well under the 256 KiB envelope ceiling IDEA3 enforces on its side.
const MAX_EVENTS = 200

integrationRouter.get('/api/integration/events', requireIdea3IntegrationKey, async (req, res, next) => {
  try {
    const [rows, db] = await Promise.all([
      readIntegrationSecurityEvents({ limit: MAX_EVENTS }),
      checkDb(),
    ])
    const events = rows.map((row) => ({
      source: 'IDEA1',
      event_id: `idea1-audit-${row.id}`,
      event_type: 'ACCESS_DENIED',
      severity: row.result === 'BLOCKED' ? 'HIGH' : 'WARNING',
      occurred_at: new Date(row.at).toISOString(),
      resource: 'AEGIS Drive',
      evidence: { result: row.result },
      correlation_key: null,
    }))
    res.json({
      schema_version: 1,
      generated_at: new Date().toISOString(),
      status: { ok: db.ok, detail: { db: db.mode } },
      events,
    })
  } catch (err) {
    next(err)
  }
})
