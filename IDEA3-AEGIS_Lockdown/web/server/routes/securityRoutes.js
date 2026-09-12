import { Router } from 'express'
import { z } from 'zod'
import { requireAdmin } from '../security/auth.js'
import { requireCsrf, requireSameOrigin } from '../security/csrf.js'
import {
  CONTAINMENT_DECISIONS,
  containmentDecisionRecord,
  containmentResponse,
  evaluateContainmentDecision,
} from '../domain/containment.js'

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
  source: z.enum(['IDEA1', 'IDEA2', 'IDEA3']).optional(),
  severity: z.enum(['INFO', 'WARNING', 'HIGH', 'CRITICAL']).optional(),
}).strict()

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(250).default(100),
}).strict()

const noteSchema = z.object({ note: z.string().trim().min(1).max(500) }).strict()
const containmentSchema = z.object({ decision: z.enum(CONTAINMENT_DECISIONS) }).strict()
const INCIDENT_ID = /^[a-z0-9-]{1,80}$/
const recoverySchema = z.object({
  incidentId: z.string().regex(/^[a-z0-9-]{1,80}$/),
  confirmation: z.literal('VALIDATE ONLY'),
}).strict()
const settingsSchema = z.object({
  dedupWindowSeconds: z.number().int().min(10).max(600).optional(),
  correlationWindowMinutes: z.number().int().min(1).max(60).optional(),
  escalationThreshold: z.number().int().min(1).max(100).optional(),
  eventRetentionDays: z.number().int().min(1).max(365).optional(),
  auditRetentionDays: z.number().int().min(30).max(2555).optional(),
  exportLimit: z.number().int().min(1).max(10_000).optional(),
}).strict()

function invalid(res, code = 'REQUEST_INVALID') {
  return res.status(400).json({ error: { code, message: 'ข้อมูลคำขอไม่ถูกต้อง' } })
}

export function createSecurityRouter({ config, demoProvider, liveProvider, repository }) {
  const router = Router()
  router.use(requireAdmin)

  router.get('/snapshot', async (req, res, next) => {
    const query = querySchema.safeParse(req.query)
    if (!query.success) return invalid(res, 'QUERY_INVALID')
    try {
      const provider = req.session.demoMode ? demoProvider : liveProvider
      const snapshot = await provider.getSnapshot(query.data)
      // Demo Mode must never advance live source lifecycle, event, or correlation state.
      if (!req.session.demoMode) {
        await repository.recordOperationalErrors(snapshot.operationalErrors)
        if (snapshot.integration) {
          await repository.recordIntegrationOutcome({
            sources: [snapshot.integration.idea1, snapshot.integration.idea2].filter(Boolean),
            conflicts: snapshot.integration.conflicts ?? [],
            incidents: snapshot.incidents ?? [],
          })
        }
      }
      res.json(await repository.apply(snapshot))
    } catch (error) {
      next(error)
    }
  })

  router.get('/audit', async (req, res, next) => {
    const query = auditQuerySchema.safeParse(req.query)
    if (!query.success) return invalid(res, 'QUERY_INVALID')
    try {
      res.json({ audit: await repository.queryAudit(query.data) })
    } catch (error) {
      next(error)
    }
  })

  router.use(requireSameOrigin, requireCsrf)

  router.post('/demo-mode', async (req, res, next) => {
    try {
      const body = z.object({ enabled: z.boolean() }).strict().safeParse(req.body)
      if (!body.success) return invalid(res)
      if (body.data.enabled && !config.demoAllowed) {
        return res.status(403).json({ error: { code: 'DEMO_DISABLED', message: 'Demo Mode ถูกปิดใช้งานโดยนโยบาย' } })
      }
      const audit = await repository.recordAction({ category: 'SETTINGS', action: 'DEMO_MODE', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'session', resourceId: 'current' })
      req.session.demoMode = body.data.enabled
      return res.json({ mode: body.data.enabled ? 'DEMO' : 'LIVE', audit })
    } catch (error) {
      next(error)
    }
  })

  router.post('/alerts/:id/acknowledge', async (req, res, next) => {
    try {
      if (!/^[a-z0-9-]{1,80}$/.test(req.params.id)) return invalid(res)
      const audit = await repository.acknowledgeAlert(req.params.id)
      res.json({ alert: { id: req.params.id, status: 'ACKNOWLEDGED' }, audit })
    } catch (error) {
      next(error)
    }
  })

  router.post('/incidents/:id/notes', async (req, res, next) => {
    try {
      if (!/^[a-z0-9-]{1,80}$/.test(req.params.id)) return invalid(res)
      const body = noteSchema.safeParse(req.body)
      if (!body.success) return invalid(res)
      const audit = await repository.addIncidentNote(req.params.id, body.data.note)
      res.json({ incident: { id: req.params.id, analystNote: body.data.note }, audit })
    } catch (error) {
      next(error)
    }
  })

  /**
   * Record an Admin containment decision for a current containment candidate.
   *
   * This is the end of the PR7 boundary. It reads the current live correlation,
   * writes one durable decision, and returns every downstream command and physical
   * stage as not reached. It publishes nothing and touches no hardware path.
   *
   * When PR10 S2 dispatch is enabled, a newly recorded acceptance also mints one
   * pending CUT_UPLINK dispatch action in the same transaction. The route still
   * publishes nothing; only the Core can claim and publish it.
   */
  router.post('/incidents/:id/containment', async (req, res, next) => {
    try {
      if (!INCIDENT_ID.test(req.params.id)) return invalid(res)
      const body = containmentSchema.safeParse(req.body)
      if (!body.success) return invalid(res, 'DECISION_INVALID')
      if (req.session.demoMode) {
        return res.status(409).json({ error: { code: 'DEMO_MODE_ACTIVE', message: 'Demo Mode ไม่สามารถบันทึกการตัดสินใจจริงได้' } })
      }

      const snapshot = await liveProvider.getSnapshot({ limit: 250 })
      const incident = snapshot.incidents.find((candidate) => candidate.id === req.params.id)
      const evaluation = evaluateContainmentDecision({ incident, decision: body.data.decision })
      if (!evaluation.ok) {
        const status = evaluation.error.code === 'DECISION_INVALID' ? 400 : 409
        return res.status(status).json({ error: { code: evaluation.error.code, message: 'เหตุการณ์นี้ไม่อยู่ในสถานะที่ตัดสินใจได้' } })
      }

      const stored = await repository.recordContainmentDecision(
        containmentDecisionRecord({ incident, decision: body.data.decision, state: evaluation.state }),
        { mintDispatch: config.dispatch?.enabled === true },
      )
      if (stored.status === 'CONFLICT') {
        return res.status(409).json({
          error: { code: 'CONTAINMENT_DECISION_CONFLICT', message: 'มีการตัดสินใจก่อนหน้าที่ขัดแย้งกันอยู่แล้ว' },
        })
      }

      return res.json({ containment: containmentResponse(incident.id, stored.state, stored.dispatch), audit: stored.audit })
    } catch (error) {
      next(error)
    }
  })

  router.post('/recovery/dry-run', async (req, res, next) => {
    try {
      const body = recoverySchema.safeParse(req.body)
      if (!body.success) return invalid(res)
      const audit = await repository.recordAction({ category: 'RECOVERY', action: 'DRY_RUN', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'incident', resourceId: body.data.incidentId })
      res.json({ dryRun: true, hardwareAction: false, publishAttempted: false, incidentId: body.data.incidentId, validation: 'PRECONDITIONS_EVALUATED', audit })
    } catch (error) {
      next(error)
    }
  })

  router.patch('/settings', async (req, res, next) => {
    try {
      const body = settingsSchema.safeParse(req.body)
      if (!body.success) return invalid(res)
      const settings = await repository.updateSettings(body.data)
      const audit = await repository.recordAction({ category: 'SETTINGS', action: 'UPDATE_POLICY', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'policy', resourceId: 'security-center' })
      res.json({ settings, audit })
    } catch (error) {
      next(error)
    }
  })

  router.post('/audit/export', async (req, res, next) => {
    try {
      const audit = await repository.recordAction({ category: 'AUDIT', action: 'EXPORT_REQUEST', outcome: 'SUCCESS', actorRef: 'session-admin', resourceType: 'audit', resourceId: 'bounded-export' })
      res.status(202).json({ accepted: true, format: 'json', bounded: true, audit })
    } catch (error) {
      next(error)
    }
  })

  return router
}
