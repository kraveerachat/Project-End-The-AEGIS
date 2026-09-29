// src/components/vault/VaultMigrationDialog.jsx — AEGIS Drive (IDEA1) · PR #157 Task 3.3
// ไดอะล็อกอัปเกรด FLAT → TREE_V1 (Tranche A: genesis migration เท่านั้น)
//
// ⚠️ ความจริงใจต่อผู้ใช้คือสัญญาของไฟล์นี้:
//   - ขณะ "กำลังทำ" จอแสดงจำนวนรายการเท่านั้น — ชื่อไฟล์ปรากฏเฉพาะขั้นแก้ชื่อชนกัน
//     (ขณะนั้นผู้ใช้ยังปลดล็อกอยู่และตั้งใจให้เห็น) และหายไปพร้อมกุญแจทันทีที่ล็อก
//   - ทุกข้อความล้มเหลวแสดงโค้ดจริงจากเซิร์ฟเวอร์ (เช่น TREE_LEASE_STALE) ไม่เรียบเรียงใหม่
//   - lease คนอื่นที่ยังไม่หมดอายุ = บอกตรง ๆ ว่าอีกอุปกรณ์กำลังทำอยู่พร้อมเวลาหมดอายุ
//     ไม่มีปุ่มหลอกให้กด — เมื่อหมดอายุจึงเสนอ "ทำต่อ" ซึ่งเดินผ่าน takeover ของ runGenesis
// ⚠️ เส้นทางนี้ไม่เข้ารหัส/อัปโหลดเนื้อหาไฟล์ใหม่ และไม่ลบ blob ใด ๆ — runGenesis ตัวจริงคือผู้ขับ
// ⚠️ ปิด/ล็อก = ยกเลิกงาน + ละทิ้ง lease ที่ยังถืออยู่ (ถ้ายังไม่ commit) — เซิร์ฟเวอร์ไม่ค้าง lease แขวน
//    lease ของอุปกรณ์อื่นไม่เคยถูกละทิ้งจากที่นี่ (heldLeaseRef มีค่าเฉพาะ lease ที่ begin/takeover ของเราได้มา)
// ⚠️ lease คนอื่น (PR220-R1): "ตรวจสอบอีกครั้ง" อ่าน GET /tree/state สดจริง ไม่ใช่ render prop เดิมซ้ำ
//    และมี timer หนึ่งตัวต่อเวลาหมดอายุที่แสดงอยู่ (ไม่ใช่ polling) — เซิร์ฟเวอร์ยังเป็นผู้ตัดสินเสมอ
//    ก่อนหมดอายุไม่มีทาง takeover; หลังหมดอายุเสนอ "ทำต่อ" ซึ่งเดินผ่าน takeover ของ runGenesis
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Btn, Modal, ModalClose } from '../ui.jsx'
import { fmtDateTime } from '../../lib/format.js'
import {
  getTreeState, beginMigration, takeoverMigration,
  publishRevision, putRevisionCiphertext, commitGenesis, abandonMigration,
} from '../../lib/vaultTreeApi.js'
import { runGenesis, resolveCollisions, MigrationError } from '../../lib/vaultTreeMigration.js'
import { nameProblem } from '../../lib/vaultTreeManifest.js'
import { collisionStepProblem, suggestCollisionNames } from '../../lib/vaultNameSuggestions.js'

const foreignLeaseActive = (state, now = Date.now()) =>
  state?.protocolState === 'MIGRATING_TREE_V1' && state.lease?.held === true && state.lease.expiresAt > now

// timer หมดอายุ: เผื่อ clock skew เล็กน้อย และไม่เกินขีด setTimeout ของเบราว์เซอร์
const EXPIRY_RECHECK_MARGIN_MS = 1_000
const MAX_TIMER_MS = 2_147_483_647

export function VaultMigrationDialog({ mode = 'explicit', t, lang = 'en', kek, treeState, onClose, onCommitted, onRefreshState, stillUnlocked }) {
  const [phase, setPhase] = useState(() => (foreignLeaseActive(treeState) ? 'remote' : 'explain'))
  const [remoteLease, setRemoteLease] = useState(() => (foreignLeaseActive(treeState) ? treeState.lease : null))
  const [resumable, setResumable] = useState(mode === 'resume')
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState(null)
  const [step, setStep] = useState(null)          // null | 'lease' | 'decrypt' | 'collisions' | 'commit' | 'done'
  const [sawCollisions, setSawCollisions] = useState(false)
  const [blobCount, setBlobCount] = useState(null)
  const [plan, setPlan] = useState(null)          // แผนที่มีชื่อชน — plaintext เฉพาะขณะปลดล็อก (หายพร้อมกุญแจ)
  const [error, setError] = useState(null)
  const [decisions, setDecisions] = useState(() => new Map())

  const abortRef = useRef(null)
  const checkAbortRef = useRef(null)
  const heldLeaseRef = useRef(null)               // lease เต็ม (มี blobs) — ทำต่อ/ละทิ้งต้องใช้
  const committedRef = useRef(false)
  const autoStartedRef = useRef(false)

  const treeUiOn = treeState?.flags?.treeUiEnabled === true

  const api = useMemo(() => ({
    getTreeState: (o = {}) => getTreeState(o),
    beginMigration: (o = {}) => beginMigration(o),
    takeoverMigration: (o = {}) => takeoverMigration(o),
    publishRevision: (meta, o = {}) => publishRevision(meta, o),
    putRevisionCiphertext: (revisionId, bytes, o = {}) => putRevisionCiphertext(revisionId, bytes, o),
    commitGenesis: (body, o = {}) => commitGenesis(body, o),
  }), [])

  const start = useCallback(async ({ plan: planArg = null, lease: leaseArg = null } = {}) => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase('running')
    setStep('lease')
    try {
      const result = await runGenesis({
        kek,
        api,
        plan: planArg,
        lease: leaseArg,
        signal: ctrl.signal,
        unlockedState: { isPurged: () => !stillUnlocked() },
        onStage: (ev) => {
          if (ev.type === 'lease') {
            heldLeaseRef.current = ev.lease ?? null
            setBlobCount(ev.blobCount)
            setStep('decrypt')
          } else if (ev.type === 'plan') {
            // แผนผ่านแล้ว (ไม่ชน) = งานที่เหลือคือเตรียม/เผยแพร่โครงสร้าง — เดินหน้าเลย
            setStep(ev.collisionCount > 0 ? 'collisions' : 'commit')
          } else if (ev.type === 'commit') {
            setStep('commit')
          }
        },
      })
      committedRef.current = true
      setStep('done')
      setPhase('done')
      onCommitted?.(result)
    } catch (e) {
      // ถูกยกเลิก (ล็อก/ปิด) = ไดอะล็อกกำลังถูกถอน — เงียบไว้ cleanup เป็นคนปิดท้าย
      if (ctrl.signal.aborted || (e instanceof MigrationError && e.code === 'ABORTED')) return
      if (e instanceof MigrationError && e.code === 'COLLISION_UNRESOLVED') {
        if (e.lease) heldLeaseRef.current = e.lease
        setPlan(e.plan)
        // ข้อเสนอชื่อที่ไม่ซ้ำ (แก้ได้) — ยังไม่มีอะไรถูกเขียนจนกว่าผู้ใช้จะกดดำเนินการต่อเอง
        setDecisions(suggestCollisionNames(e.plan))
        setSawCollisions(true)
        setStep('collisions')
        setPhase('collisions')
      } else {
        setError(e)
        setPhase('error')
      }
    }
  }, [kek, api, onCommitted, stillUnlocked])

  useEffect(() => {
    if (mode !== 'auto-empty' || autoStartedRef.current) return
    autoStartedRef.current = true
    start({})
  }, [mode, start])

  // ล็อก/ปิดไดอะล็อก = หยุดงานทันที + คืน lease ถ้ายังไม่ได้ commit
  useEffect(() => () => {
    abortRef.current?.abort()
    if (heldLeaseRef.current && !committedRef.current) {
      abandonMigration({ leaseId: heldLeaseRef.current.leaseId }, {}).catch(() => {})
    }
  }, [])

  const onStart = () => start({})

  // อ่านความจริงจากเซิร์ฟเวอร์ใหม่ (ไม่ใช่ prop เดิม) แล้วเลือกสถานะตามนั้น — ไม่เริ่มงานใด ๆ เอง
  const checkState = useCallback(async () => {
    checkAbortRef.current?.abort()
    const ctrl = new AbortController()
    checkAbortRef.current = ctrl
    setChecking(true)
    setCheckError(null)
    try {
      const fresh = await api.getTreeState({ signal: ctrl.signal })
      if (ctrl.signal.aborted) return
      if (foreignLeaseActive(fresh)) {
        setRemoteLease(fresh.lease)
        setPhase('remote')
      } else {
        setRemoteLease(null)
        setResumable(fresh?.protocolState === 'MIGRATING_TREE_V1')
        setPhase('explain')
      }
      // จอแม่ประเมินสถานะใหม่ด้วย (อีกอุปกรณ์อาจทำเสร็จเป็น TREE_V1 หรือละทิ้งกลับเป็น FLAT แล้ว)
      onRefreshState?.()
    } catch (e) {
      if (ctrl.signal.aborted) return
      setCheckError(e?.code ?? 'UNKNOWN')
    } finally {
      if (!ctrl.signal.aborted) setChecking(false)
    }
  }, [api, onRefreshState])

  // หนึ่ง timer ต่อเวลาหมดอายุที่แสดงอยู่ — ครบแล้วตรวจสดหนึ่งครั้ง (ไม่ takeover เอง)
  useEffect(() => {
    if (phase !== 'remote' || !remoteLease?.expiresAt) return undefined
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, remoteLease.expiresAt - Date.now() + EXPIRY_RECHECK_MARGIN_MS))
    const timer = setTimeout(() => { void checkState() }, delay)
    return () => clearTimeout(timer)
  }, [phase, remoteLease, checkState])

  useEffect(() => () => checkAbortRef.current?.abort(), [])

  // เหตุผลที่ยังไปต่อไม่ได้ (ชื่อยังชน/ใช้ไม่ได้) — แสดงให้เห็นเสมอ ปุ่มไม่เงียบ
  const collisionProblem = phase === 'collisions' && plan
    ? collisionStepProblem(plan.entries, decisions, nameProblem)
    : null

  const onContinue = () => {
    if (collisionProblem) return
    try {
      const resolved = resolveCollisions(plan, decisions)
      if (resolved.collisions.length > 0) return // ยังชนอยู่ — คงรายการไว้ให้แก้ต่อ ไม่เขียนอะไร
      start({ plan: resolved, lease: heldLeaseRef.current })
    } catch (e) {
      setError(e)
      setPhase('error')
    }
  }

  const onRetry = () => {
    setError(null)
    setPlan(null)
    start({ lease: heldLeaseRef.current })
  }

  // ── ผังขั้นตอน (ledger) — แสดงตั้งแต่เริ่มทำจนจบ/ล้ม แต่ละขั้นมี testid ของตัวเอง ──
  const STEP_INDEX = { lease: 0, decrypt: 1, collisions: 2, commit: 3 }
  const visibleSteps = ['lease', 'decrypt', ...(sawCollisions ? ['collisions'] : []), 'commit']
  const currentIdx = step === 'done' ? 4 : (STEP_INDEX[step] ?? -1)
  const stateOf = (s) => {
    const i = STEP_INDEX[s]
    if (currentIdx >= 4 || i < currentIdx) return 'done'
    return i === currentIdx ? 'current' : 'pending'
  }
  const stepLabel = (s) => {
    if (s === 'lease') return t('vaultMigrationStepLease')
    if (s === 'decrypt') return blobCount != null ? t('vaultMigrationDecrypting', { n: blobCount }) : t('vaultMigrationStepDecrypt')
    if (s === 'collisions') return t('vaultMigrationStepCollisions')
    return t('vaultMigrationStepCommit')
  }

  return (
    <Modal open onClose={onClose} width={520} labelledBy="vault-migration-title">
      <ModalClose onClose={onClose} label={t('close')} />
      <h2 id="vault-migration-title" className="text-[18px] font-semibold text-ink">{t('vaultMigrationTitle')}</h2>

      {step !== null && phase !== 'done' && phase !== 'explain' && phase !== 'remote' && (
        <ol data-testid="vault-migration-progress" className="mt-4 space-y-1.5 text-[13px]">
          {visibleSteps.map((s) => (
            <li
              key={s}
              data-testid={`vault-migration-step-${s}`}
              data-state={stateOf(s)}
              className={stateOf(s) === 'current' ? 'text-ink font-medium' : stateOf(s) === 'done' ? 'text-ink-2' : 'text-ink-3'}
            >
              {stepLabel(s)}
            </li>
          ))}
        </ol>
      )}

      {phase === 'explain' && (
        <div data-testid="vault-migration-explain" className="mt-3">
          <p className="text-[12.5px] text-ink-2 leading-relaxed">{t('vaultMigrationExplain')}</p>
          <Btn variant="primary" className="w-full mt-5" onClick={onStart}>
            {resumable ? t('vaultMigrationResume') : t('vaultMigrationStart')}
          </Btn>
        </div>
      )}

      {phase === 'remote' && (
        <div data-testid="vault-migration-remote" className="mt-3">
          <p className="text-[12.5px] text-ink-2 leading-relaxed">{t('vaultMigrationRemote')}</p>
          <p data-testid="vault-migration-remote-until" className="text-[12px] text-ink-3 mt-2">
            {t('vaultMigrationLeaseUntil', { time: fmtDateTime(remoteLease?.expiresAt, lang) })}
          </p>
          <p className="text-[12px] text-ink-3 mt-2 leading-relaxed">{t('vaultMigrationRemoteHint')}</p>
          {checkError && (
            <p role="alert" className="text-[12px] font-medium mt-2" style={{ color: 'var(--danger)' }}>
              {t('vaultMigrationError', { code: checkError })}
            </p>
          )}
          <Btn
            variant="outline"
            className="w-full mt-4"
            data-testid="vault-migration-refresh"
            disabled={checking}
            aria-busy={checking || undefined}
            onClick={() => void checkState()}
          >
            {t('vaultMigrationRefresh')}
          </Btn>
        </div>
      )}

      {phase === 'collisions' && plan && (
        <div data-testid="vault-migration-collision-list" className="mt-4">
          <p className="text-[13px] font-medium text-ink">{t('vaultMigrationCollisionsTitle')}</p>
          <p className="text-[12px] text-ink-3 mt-1 leading-relaxed">{t('vaultMigrationCollisionNote')}</p>
          <div className="mt-3 space-y-3">
            {plan.collisions.flatMap((g) => g.entries).map((entry) => {
              const index = plan.entries.indexOf(entry)
              const value = decisions.get(entry) ?? entry.name
              return (
                <div key={entry.blobRef.id}>
                  <label htmlFor={`vault-migration-rename-${index}`} className="block text-[12px] text-ink-3 mb-1">
                    {t('vaultMigrationRenameLabel', { name: entry.name })}
                  </label>
                  <input
                    id={`vault-migration-rename-${index}`}
                    data-testid={`vault-migration-rename-${index}`}
                    type="text"
                    value={value}
                    onChange={(e) => setDecisions(new Map(decisions).set(entry, e.target.value))}
                    aria-invalid={collisionProblem?.entries.has(entry) ? 'true' : undefined}
                    aria-describedby={collisionProblem?.entries.has(entry) ? 'vault-migration-collision-error' : undefined}
                    className={`w-full h-10 px-3 rounded-lg bg-sunken border text-[13px] text-ink outline-none focus:border-accent ${collisionProblem?.entries.has(entry) ? 'border-[var(--danger)]' : 'border-line'}`}
                  />
                </div>
              )
            })}
          </div>
          {collisionProblem && (
            <p
              id="vault-migration-collision-error"
              data-testid="vault-migration-collision-error"
              role="alert"
              className="text-[12px] font-medium mt-3 leading-relaxed"
              style={{ color: 'var(--danger)' }}
            >
              {t(collisionProblem.kind === 'invalid' ? 'vaultMigrationCollisionInvalid' : 'vaultMigrationCollisionStill', { name: collisionProblem.name })}
            </p>
          )}
          <Btn
            variant="primary"
            className="w-full mt-4"
            onClick={onContinue}
            disabled={Boolean(collisionProblem)}
            aria-describedby={collisionProblem ? 'vault-migration-collision-error' : undefined}
          >
            {t('vaultMigrationContinue')}
          </Btn>
        </div>
      )}

      {phase === 'done' && (
        <div data-testid="vault-migration-done" className="mt-3">
          <p className="text-[13px] text-ink-2 leading-relaxed">{t('vaultMigrationDone')}</p>
          {!treeUiOn && (
            <p className="text-[12px] text-ink-3 mt-2 leading-relaxed">{t('vaultMigrationNoTreeUi')}</p>
          )}
          <Btn variant="outline" className="w-full mt-4" onClick={onClose}>{t('close')}</Btn>
        </div>
      )}

      {phase === 'error' && (
        <div data-testid="vault-migration-error" className="mt-3">
          <p role="alert" className="text-[12.5px] font-medium" style={{ color: 'var(--danger)' }}>
            {t('vaultMigrationError', { code: error?.code ?? 'UNKNOWN' })}
          </p>
          <div className="flex gap-2 mt-4">
            <Btn variant="primary" className="flex-1" onClick={onRetry}>{t('vaultMigrationRetry')}</Btn>
            <Btn variant="outline" onClick={onClose}>{t('close')}</Btn>
          </div>
        </div>
      )}
    </Modal>
  )
}
