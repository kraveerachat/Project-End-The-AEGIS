// src/components/vault/VaultRecoveryPanel.jsx — AEGIS Drive (IDEA1) · PR #157 Task 6.4 · key repair + orphan recovery (RP-*)
//
// สองเรื่องที่ผู้ใช้ต้องเห็นความจริงเสมอ:
//   1. กุญแจช่องเดียวเสีย (DEGRADED) = อ่านได้ แก้ไม่ได้ จนกว่าจะกดซ่อม (repairKeyEnvelope → casKeyEnvelope)
//      สองช่องเสีย = fail closed: ไม่วาดต้นไม้ ไม่มีควบคุมใด ไม่มีการแต่งคำสัญญา
//   2. blob UNREFERENCED (orphan จากอัปโหลดค้าง) = กู้ได้: แสดงชื่อที่ถอดได้ → เลือกโฟลเดอร์ → attach intent
// ⚠️ ข้อความความปลอดภัยต้องรับความจริงเรื่อง traffic analysis — ห้ามอ้าง "zero metadata" เด็ดขาด (RP-4)
// ⚠️ PR220-R1: orphan คือ "อัปโหลดเสร็จแล้วแต่ยังไม่ถูกเชื่อมเข้าโครงสร้างโฟลเดอร์" — ไม่ใช่อัปโหลดล้มเหลว
//    และไม่ถูกซ่อน/ลบเพื่อให้จอดูสะอาด "กู้ทั้งหมด" ผูกเข้าโฟลเดอร์หลักทีละรายการ (ไม่มี CAS พร้อมกัน)
//    ผ่าน recoverOrphan เดิม รายการที่ชนชื่อคงอยู่พร้อมเหตุผล ล็อก/unmount = ยกเลิกรายการที่เหลือทันที
// ⚠️ PR220-R2: แผงย่อเป็นสรุป "รายการรอกู้คืน (n)" จนกว่าจะกดขยาย — ไม่ให้การกู้คืนกินพื้นที่ทำงานปกติ
//    รายการที่ชนชื่อ = "มีไฟล์ชื่อนี้อยู่ในโฟลเดอร์นี้แล้ว" (ไม่ใช่อัปโหลดล้มเหลว) + "กู้ด้วยชื่อใหม่":
//    ชื่อที่เสนอใช้ collisionKey เดียวกับ TREE, แก้ไขได้, ไม่มีอะไร commit จนกว่า Human ยืนยัน และยังเป็น
//    attach blob เดิม (ไม่อัปโหลด ciphertext ใหม่ ไม่เขียนทับ ไม่ลบ) — กู้ทั้งหมดไม่เปลี่ยนชื่อเองเด็ดขาด
import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { Btn, IconBtn } from '../ui.jsx'
import { MoveDialog } from './VaultDialogs.jsx'
import { NameEntryDialog } from '../NameEntryDialog.jsx'
import { listOrphanBlobs, recoverOrphan } from '../../lib/vaultTreeUpload.js'
import * as treeApi from '../../lib/vaultTreeApi.js'
import { childrenOf, collisionKey, nameProblem } from '../../lib/vaultTreeManifest.js'
import { suggestRecoveryName } from '../../lib/vaultNameSuggestions.js'
import { VAULT_TREE_CLIENT_LIMITS } from '../../lib/vaultTreeLimits.js'

/** ตัวเลือกโฟลเดอร์สำหรับ Move/Restore/Recover: โฟลเดอร์ active ทั้งหมดยกเว้นตัวที่ถูกเลือกและลูกหลาน */
export function vaultTreeFolderOptions(index, rootId, excludeIds) {
  const excluded = new Set(excludeIds ?? [])
  const out = []
  const walk = (parentId, depth) => {
    for (const c of childrenOf(index, parentId, { view: 'active' })) {
      if (excluded.has(c.nodeId)) continue
      if (c.kind === 'folder') {
        out.push({ nodeId: c.nodeId, name: c.name, depth })
        walk(c.nodeId, depth + 1)
      }
    }
  }
  walk(rootId, 1)
  return out
}

const refKeyOf = (r) => `${r?.formatVersion ?? 1}:${String(r?.id ?? '')}`
/** D-1 D.2: unnamed (authenticated name '') or undecryptable blobs are recoverable only under an explicit user name */
const needsExplicitName = (orphan) => Boolean(orphan?.undecryptable) || typeof orphan?.name !== 'string' || orphan.name.trim() === ''

export function VaultRecoveryPanel({
  t, kek, session, tree, unlockedState = null, apiNamespace = treeApi, bothBad = false, onRepaired,
}) {
  const [orphans, setOrphans] = useState(null)
  const [repairBusy, setRepairBusy] = useState(false)
  const [chooser, setChooser] = useState(null)
  const [pending, setPending] = useState(() => new Map())   // refKey → { reason, destinationNodeId } ที่ยังกู้ไม่ได้ (โค้ดจริง)
  const [expanded, setExpanded] = useState(false)
  const [renaming, setRenaming] = useState(null)             // { orphan, destinationNodeId, name }
  const [bulk, setBulk] = useState(null)                     // { done, total } ระหว่างกู้ทั้งหมด
  const bulkAbortRef = useRef(null)
  const head = tree.state.head
  useEffect(() => () => bulkAbortRef.current?.abort(), [])
  const cancelled = (signal) => signal?.aborted || unlockedState?.isPurged?.() === true

  const refreshOrphans = useCallback(async () => {
    if (!head) { setOrphans([]); return }
    try {
      setOrphans(await listOrphanBlobs({ kek, api: apiNamespace, index: head.index }))
    } catch {
      setOrphans(null)
    }
  }, [kek, head, apiNamespace])
  useEffect(() => { void refreshOrphans() }, [refreshOrphans])

  const repair = async () => {
    setRepairBusy(true)
    try {
      const r = await session.repairKeyEnvelope()
      if (r?.repaired) {
        tree.setKeyStatus('HEALTHY')
        onRepaired?.()
      }
    } catch {
      // ENVELOPE_CONFLICT = ซองบนเซิร์ฟเวอร์ขยับไปแล้ว — refresh ให้เห็นความจริงก่อนลองใหม่
      onRepaired?.()
    }
    setRepairBusy(false)
  }

  /** กู้หนึ่งรายการ — คืน true เมื่อผูกสำเร็จ; ไม่สำเร็จ = คงอยู่ในรายการพร้อมเหตุผล (ไม่ลบ ciphertext)
   *  D-1 D.2: an unnamed or undecryptable blob is never given an invented name — without a user-confirmed name it stays
   *  listed with NAME_REQUIRED and nothing is committed (fail closed). */
  const attachOne = async (orphan, destinationNodeId, signal = null, confirmedName = null) => {
    const name = confirmedName ?? (needsExplicitName(orphan) ? null : orphan.name)
    const key = refKeyOf(orphan.blobRef)
    let reason = null
    if (!name) reason = 'NAME_REQUIRED'
    else try {
      const res = await recoverOrphan({
        session, blobRef: orphan.blobRef, parentNodeId: destinationNodeId,
        name, mediaType: orphan.mediaType ?? '', plainSize: orphan.plainSize, signal,
      })
      if (res?.conflict) reason = res.conflict.reason ?? 'CONFLICT'
    } catch (e) {
      if (cancelled(signal)) return false
      reason = e?.code ?? 'UNKNOWN'
    }
    setPending((prev) => {
      const next = new Map(prev)
      if (reason) next.set(key, { reason, destinationNodeId })
      else next.delete(key)
      return next
    })
    return reason === null
  }

  const recover = async (orphan, destinationNodeId, confirmedName = null) => {
    if (await attachOne(orphan, destinationNodeId, null, confirmedName)) {
      await refreshOrphans()
      onRepaired?.()
    }
  }

  /** ชื่อ active ในโฟลเดอร์ปลายทาง — ชุดเดียวกับที่ TREE ใช้ตัดสิน COLLISION */
  const siblingNamesOf = (parentNodeId) => (head
    ? childrenOf(head.index, parentNodeId, { view: 'active' }).map((c) => c.name)
    : [])
  const openRename = (orphan, destinationNodeId) => {
    setRenaming({ orphan, destinationNodeId, name: suggestRecoveryName(orphan.name, siblingNamesOf(destinationNodeId)) })
  }
  const renameProblem = (() => {
    if (!renaming) return null
    if (!renaming.name) return 'empty'
    if (nameProblem(renaming.name, VAULT_TREE_CLIENT_LIMITS)) return 'invalid'
    const key = collisionKey(renaming.name)
    return siblingNamesOf(renaming.destinationNodeId).some((n) => collisionKey(n) === key) ? 'collision' : null
  })()

  // กู้ทั้งหมดเข้าโฟลเดอร์หลัก: ทีละรายการตามลำดับ (session.commit แต่ละครั้งต่อยอด head ล่าสุด)
  const recoverAll = async () => {
    if (!head || !orphans?.length || bulk) return
    bulkAbortRef.current?.abort()
    const ctrl = new AbortController()
    bulkAbortRef.current = ctrl
    const queue = [...orphans]
    const rootNodeId = head.manifest.rootNodeId
    setBulk({ done: 0, total: queue.length })
    let attached = 0
    for (const orphan of queue) {
      if (cancelled(ctrl.signal)) return
      if (await attachOne(orphan, rootNodeId, ctrl.signal)) attached += 1
      if (cancelled(ctrl.signal)) return
      setBulk((b) => (b ? { ...b, done: b.done + 1 } : b))
    }
    setBulk(null)
    setExpanded(true)   // เหตุผลของรายการที่ยังค้างต้องมองเห็นได้ทันที
    // ความจริงจากเซิร์ฟเวอร์เป็นผู้ตัดสินว่าอะไรหายจากรายการ — ไม่ลบแถวเองจากผลฝั่ง client
    await refreshOrphans()
    if (attached > 0) onRepaired?.()
  }

  const folderOptions = head
    ? [{ nodeId: head.manifest.rootNodeId, name: t('vaultTreeRootName'), depth: 0 }, ...vaultTreeFolderOptions(head.index, head.manifest.rootNodeId, [])]
    : []

  if (!bothBad && !tree.keyDegraded && (!orphans || orphans.length === 0)) {
    return (
      <p data-testid="vault-tree-security-note" data-marquee-ignore="" className="text-[12px] text-ink-3 leading-relaxed mb-5">
        {t('vaultTreeSecurityNote')}
      </p>
    )
  }

  return (
    <div data-testid="vault-tree-recovery" data-marquee-ignore="" className="rounded-[var(--r-tile)] border border-line bg-card p-4 mb-5">
      {bothBad && (
        <p data-testid="vault-tree-key-fail-closed" className="text-[12.5px] font-medium mb-2" style={{ color: 'var(--danger)' }}>
          {t('vaultTreeKeyBothSlotsCorrupt')}
        </p>
      )}
      {!bothBad && tree.keyDegraded && (
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <p className="text-[12.5px] flex-1 min-w-0" style={{ color: 'var(--warn)' }}>
            {t('vaultTreeKeySlotCorrupt')}
          </p>
          <Btn size="sm" variant="outline" data-testid="vault-tree-key-repair" disabled={repairBusy} onClick={() => void repair()}>
            {repairBusy ? t('vaultTreeKeyRepairBusy') : t('vaultTreeKeyRepair')}
          </Btn>
        </div>
      )}
      {!bothBad && (
        <div data-testid="vault-tree-orphans" className="mb-3">
          <div className="flex items-center gap-2 flex-wrap">
            {orphans?.length > 0 ? (
              <button
                type="button"
                data-testid="vault-tree-orphans-toggle"
                aria-expanded={expanded ? 'true' : 'false'}
                aria-controls="vault-tree-orphans-details"
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex items-center gap-1.5 rounded-full px-1 -mx-1 text-[13px] font-semibold text-ink cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" className={`transition-transform duration-[var(--dur-fast)] ${expanded ? '' : '-rotate-90'}`} />
                {t('vaultTreeOrphansSummary', { count: orphans.length })}
              </button>
            ) : (
              <h3 className="text-[13px] font-semibold text-ink">{t('vaultTreeOrphansTitle')}</h3>
            )}
            <IconBtn label={t('vaultTreeOrphansRefresh')} onClick={() => void refreshOrphans()} disabled={Boolean(bulk)}>
              <RefreshCw size={13} strokeWidth={1.6} />
            </IconBtn>
            <div className="flex-1" />
            {orphans?.length > 0 && (
              <Btn
                size="sm"
                variant="primary"
                data-testid="vault-tree-orphan-recover-all"
                disabled={Boolean(tree.mutationLock ?? tree.keyDegraded) || Boolean(bulk)}
                aria-busy={bulk ? true : undefined}
                onClick={() => void recoverAll()}
              >
                {bulk ? t('vaultTreeOrphanRecoverAllBusy', { done: bulk.done, total: bulk.total }) : t('vaultTreeOrphanRecoverAll')}
              </Btn>
            )}
          </div>
          {orphans?.length > 0 && expanded && (
            <p className="text-[12px] text-ink-2 leading-relaxed mt-2 mb-2">{t('vaultTreeOrphansDescription')}</p>
          )}
          {orphans === null ? null : orphans.length === 0 ? (
            <p className="text-[12px] text-ink-3 mt-1">{t('vaultTreeOrphansEmpty')}</p>
          ) : expanded && (
            <div id="vault-tree-orphans-details">{orphans.map((o) => {
              const key = refKeyOf(o.blobRef)
              const entry = pending.get(key) ?? null
              const reason = entry?.reason ?? null
              return (
                <div key={key} data-testid="vault-tree-orphan-row" className="flex items-center gap-3 py-1.5">
                  <div className="min-w-0 flex-1">
                    <span className="block text-[12.5px] text-ink truncate">{o.name || t('vaultTreeOrphanUndecryptable')}</span>
                    {reason && (
                      <span data-testid="vault-tree-orphan-reason" className="block text-[11.5px] mt-0.5" style={{ color: 'var(--warn)' }}>
                        {reason === 'COLLISION' ? t('vaultTreeOrphanPendingCollision') : t('vaultTreeOrphanPendingFailed', { code: reason })}
                      </span>
                    )}
                  </div>
                  {reason === 'COLLISION' && o.name && (
                    <Btn
                      size="sm"
                      variant="primary"
                      data-testid="vault-tree-orphan-recover-rename"
                      disabled={Boolean(tree.mutationLock ?? tree.keyDegraded) || Boolean(bulk)}
                      onClick={() => openRename(o, entry.destinationNodeId)}
                    >
                      {t('vaultTreeOrphanRecoverRename')}
                    </Btn>
                  )}
                  <Btn
                    size="sm"
                    variant="outline"
                    data-testid="vault-tree-orphan-recover"
                    disabled={Boolean(tree.mutationLock ?? tree.keyDegraded) || Boolean(bulk)}
                    onClick={() => setChooser(o)}
                  >
                    {t('vaultTreeOrphanRecover')}
                  </Btn>
                </div>
              )
            })}</div>
          )}
        </div>
      )}
      <p data-testid="vault-tree-security-note" className="text-[12px] text-ink-3 leading-relaxed">
        {t('vaultTreeSecurityNote')}
      </p>
      {chooser && (
        <MoveDialog
          t={t}
          open
          onClose={() => setChooser(null)}
          folders={folderOptions}
          movingNames={[chooser.name || t('vaultTreeOrphanUndecryptable')]}
          onMove={(dest) => {
            const chosen = chooser
            setChooser(null)
            // D.2: no readable name → ask for one (empty, no default); nothing is committed until the Human confirms
            if (needsExplicitName(chosen)) setRenaming({ orphan: chosen, destinationNodeId: dest, name: '' })
            else void recover(chosen, dest)
          }}
          unlockedState={unlockedState}
        />
      )}
      {renaming && (
        <NameEntryDialog
          open
          onClose={() => setRenaming(null)}
          onSubmit={() => {
            const { orphan, destinationNodeId, name } = renaming
            setRenaming(null)
            void recover(orphan, destinationNodeId, name)
          }}
          id="vault-orphan-rename"
          title={t('vaultTreeOrphanRecoverRename')}
          label={t('colName')}
          submitLabel={t('vaultTreeOrphanRenameSubmit')}
          cancelLabel={t('cancel')}
          closeLabel={t('close')}
          value={renaming.name}
          onChange={(name) => setRenaming((r) => (r ? { ...r, name } : r))}
          canSubmit={renameProblem === null}
          problem={renameProblem === 'collision' ? t('vaultTreeNameCollision') : renameProblem === 'invalid' ? t('vaultTreeNameEmpty') : null}
          inputTestId="vault-dialog-name-input"
          submitTestId="vault-dialog-submit"
          problemTestId="vault-dialog-error"
        />
      )}
    </div>
  )
}
