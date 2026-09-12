import { Router } from 'express'
import { z } from 'zod'
import { safeDispatchEvidence } from '../domain/dispatch.js'

const ACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const claimSchema = z.object({}).strict()
const CLAIM_REFUSALS = Object.freeze({
  NOT_FOUND: [404, 'ACTION_NOT_FOUND'],
  EXPIRED: [410, 'ACTION_EXPIRED'],
  ALREADY_CLAIMED: [409, 'ACTION_ALREADY_CLAIMED'],
  NOT_DISPATCHABLE: [409, 'ACTION_NOT_DISPATCHABLE'],
})
const EVIDENCE_REFUSALS = Object.freeze({
  NOT_FOUND: [404, 'ACTION_NOT_FOUND'],
  NOT_CLAIMED: [409, 'ACTION_NOT_CLAIMED'],
  CONFLICT: [409, 'EVIDENCE_CONFLICT'],
})

/**
 * PR10 S2 machine dispatch routes (spec §4.4, §4.6): list the unexpired pending
 * actions and claim one. The Core pulls; the server never calls into the Core.
 */
export function createMachineRouter({ repository }) {
  const router = Router({ caseSensitive: true })

  router.get('/dispatch/pending', async (_req, res, next) => {
    try {
      const actions = await repository.listPendingDispatchActions()
      res.json({ actions: actions.map(({ actionId, action, acceptedAt, expiresAt }) => ({ actionId, action, acceptedAt, expiresAt })) })
    } catch (error) {
      next(error)
    }
  })

  router.post('/dispatch/:actionId/claim', async (req, res, next) => {
    try {
      if (!ACTION_ID.test(req.params.actionId)) return res.status(400).json({ error: { code: 'ACTION_ID_INVALID' } })
      if (!claimSchema.safeParse(req.body ?? {}).success) return res.status(400).json({ error: { code: 'REQUEST_INVALID' } })

      const result = await repository.claimDispatchAction(req.params.actionId, { subject: req.machineSubject })
      if (result.status === 'CLAIMED') {
        const { actionId, action, state, claimedAt, expiresAt } = result.dispatch
        return res.json({ actionId, action, state, claimedAt, expiresAt })
      }
      const [status, code] = CLAIM_REFUSALS[result.status] ?? [500, 'INTERNAL_ERROR']
      return res.status(status).json({ error: { code } })
    } catch (error) {
      return next(error)
    }
  })

  /** Core → server reconciliation: append-only, idempotent by (action_id, sequence) (spec §4.7). */
  router.post('/dispatch/:actionId/evidence', async (req, res, next) => {
    try {
      if (!ACTION_ID.test(req.params.actionId)) return res.status(400).json({ error: { code: 'ACTION_ID_INVALID' } })
      if (!safeDispatchEvidence(req.body ?? {})) return res.status(400).json({ error: { code: 'EVIDENCE_INVALID' } })

      const result = await repository.recordDispatchEvidence(req.params.actionId, req.body)
      if (result.status === 'RECORDED' || result.status === 'UNCHANGED') {
        const { sequence, stage } = result.evidence
        return res.status(result.status === 'RECORDED' ? 201 : 200).json({ status: result.status, sequence, stage })
      }
      const [status, code] = EVIDENCE_REFUSALS[result.status] ?? [500, 'INTERNAL_ERROR']
      return res.status(status).json({ error: { code } })
    } catch (error) {
      return next(error)
    }
  })

  return router
}
