// src/components/vault/VaultRecoveryPanel.jsx — AEGIS Drive (IDEA1) · PR #157 Task 6.4 · key repair + orphan recovery (RP-*)
//
// สองเรื่องที่ผู้ใช้ต้องเห็นความจริงเสมอ:
//   1. กุญแจช่องเดียวเสีย (DEGRADED) = อ่านได้ แก้ไม่ได้ จนกว่าจะกดซ่อม (repairKeyEnvelope → casKeyEnvelope)
//      สองช่องเสีย = fail closed: ไม่วาดต้นไม้ ไม่มีควบคุมใด ไม่มีการแต่งคำสัญญา
//   2. blob UNREFERENCED (orphan จากอัปโหลดค้าง) = กู้ได้: แสดงชื่อที่ถอดได้ → เลือกโฟลเดอร์ → attach intent
// ⚠️ ข้อความความปลอดภัยต้องรับความจริงเรื่อง traffic analysis — ห้ามอ้าง "zero metadata" เด็ดขาด (RP-4)
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Btn, IconBtn } from '../ui.jsx'
import { MoveDialog } from './VaultDialogs.jsx'
import { listOrphanBlobs, recoverOrphan } from '../../lib/vaultTreeUpload.js'
import * as treeApi from '../../lib/vaultTreeApi.js'
import { childrenOf } from '../../lib/vaultTreeManifest.js'

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

export function VaultRecoveryPanel({
  t, kek, session, tree, unlockedState = null, apiNamespace = treeApi, bothBad = false, onRepaired,
}) {
  const [orphans, setOrphans] = useState(null)
  const [repairBusy, setRepairBusy] = useState(false)
  const [chooser, setChooser] = useState(null)
  const head = tree.state.head

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

  const recover = async (orphan, destinationNodeId) => {
    const name = orphan.name ?? `orphan-${String(orphan.blobRef.id).slice(0, 8)}`
    const res = await recoverOrphan({
      session, blobRef: orphan.blobRef, parentNodeId: destinationNodeId,
      name, mediaType: orphan.mediaType ?? '', plainSize: orphan.plainSize,
    })
    if (!res?.conflict) {
      await refreshOrphans()
      onRepaired?.()
    }
  }

  const folderOptions = head
    ? [{ nodeId: head.manifest.rootNodeId, name: t('vaultTreeRootName'), depth: 0 }, ...vaultTreeFolderOptions(head.index, head.manifest.rootNodeId, [])]
    : []

  if (!bothBad && !tree.keyDegraded && (!orphans || orphans.length === 0)) {
    return (
      <p data-testid="vault-tree-security-note" className="text-[12px] text-ink-3 leading-relaxed mb-5">
        {t('vaultTreeSecurityNote')}
      </p>
    )
  }

  return (
    <div data-testid="vault-tree-recovery" className="rounded-[var(--r-tile)] border border-line bg-card p-4 mb-5">
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
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-[13px] font-semibold text-ink">{t('vaultTreeOrphansTitle')}</h3>
            <IconBtn label={t('vaultTreeRefresh')} onClick={() => void refreshOrphans()}>
              <RefreshCw size={13} strokeWidth={1.6} />
            </IconBtn>
          </div>
          {orphans?.length > 0 && (
            <p className="text-[12px] text-ink-3 leading-relaxed mb-2">{t('vaultTreeOrphansDescription')}</p>
          )}
          {orphans === null ? null : orphans.length === 0 ? (
            <p className="text-[12px] text-ink-3">{t('vaultTreeOrphansEmpty')}</p>
          ) : (
            orphans.map((o) => {
              const key = refKeyOf(o.blobRef)
              return (
                <div key={key} data-testid="vault-tree-orphan-row" className="flex items-center gap-3 py-1.5">
                  <span className="text-[12.5px] text-ink truncate flex-1">{o.name ?? t('vaultTreeOrphanUndecryptable')}</span>
                  <Btn
                    size="sm"
                    variant="outline"
                    data-testid="vault-tree-orphan-recover"
                    disabled={tree.keyDegraded}
                    onClick={() => setChooser(o)}
                  >
                    {t('vaultTreeOrphanRecover')}
                  </Btn>
                </div>
              )
            })
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
          movingNames={[chooser.name ?? t('vaultTreeOrphanUndecryptable')]}
          onMove={(dest) => {
            const chosen = chooser
            setChooser(null)
            void recover(chosen, dest)
          }}
          unlockedState={unlockedState}
        />
      )}
    </div>
  )
}
