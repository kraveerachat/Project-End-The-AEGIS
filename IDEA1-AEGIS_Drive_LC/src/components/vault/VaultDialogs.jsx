// src/components/vault/VaultDialogs.jsx — AEGIS Drive (IDEA1) · PR #157 Task 6.2 · hierarchy dialogs (DG-*)
//
// ไดอะล็อกทั้งหมดของจอต้นไม้: New Folder / Rename / Move / Details / Trash / Restore / Conflict / Permanent Delete
// กติกากลาง:
//   • ตรวจทุกอย่างฝั่ง client ก่อนปล่อย intent เสมอ (collisionKey ตัวเดียวกับ manifest — ชื่อพิมพ์ผิด
//     ตัวพิมพ์/พยัญชนะไทยที่ fold แล้วชนกันก็ถูกจับที่นี่ ไม่ต้องรอเซิร์ฟเวอร์บอก)
//   • ปุ่มส่งถูกปิดตามความจริงของค่าปัจจุบัน — ไม่มีการกดผ่านช่องว่างหรือชื่อชน
//   • ทุกไดอะล็อกถือ plaintext ไว้ในมือ (ชื่อที่พิมพ์/รายละเอียดที่ถอดแล้ว) จึงลงทะเบียน disposer
//     กับ unlockedState: purge = ล้างค่าในเครื่อง + onClose() ไปพร้อมกุญแจ (DG-9)
//   • Details แสดงเฉพาะช่องที่ "ฝั่ง client รู้จริง" — ห้ามวาด node id / storage key / โครงต้นไม้
import { useEffect, useRef, useState } from 'react'
import { Modal, ModalClose, Btn } from '../ui.jsx'
import { collisionKey, nameProblem } from '../../lib/vaultTreeManifest.js'
import { VAULT_TREE_CLIENT_LIMITS } from '../../lib/vaultTreeLimits.js'
import { fmtBytes, fmtDateTime } from '../../lib/format.js'

/* ทุกไดอะล็อกลงทะเบียน disposer ตัวเดียวกับ unlockedState — purge เรียก onPurge แล้ว
   ผู้เรียกปิดไดอะล็อกเอง ตัวล้างจังหวะถูกเรียกเฉพาะตอน purge (ไม่ใช่ unmount ปกติ)
   ⚠️ effect ต้องคืน undefined เสมอ — registerDisposer คืนตัวฟังก์ชันเอง ถ้าให้ React ถือ
   เป็น cleanup มันจะถูกเรียกตอน unmount ปกติด้วย (ผิดจังหวะโดยเด็ดขาด) */
function usePurgeAwareDialog(unlockedState, onPurge) {
  const ref = useRef(onPurge)
  ref.current = onPurge
  useEffect(() => {
    if (!unlockedState?.registerDisposer) return undefined
    try { unlockedState.registerDisposer(() => ref.current()) } catch { /* state ตายแล้ว */ }
    return undefined
  }, [unlockedState])
}

/** ปัญหาของชื่อ: null = ใช้ได้ / 'collision' / 'invalid' — กฎเดียวกับ manifest โดยตรง */
function nameState(name, siblingNames) {
  if (!name) return 'empty'
  const p = nameProblem(name, VAULT_TREE_CLIENT_LIMITS)
  if (p === 'LIMIT_NAME_BYTES' || p === 'NAME_INVALID') return 'invalid'
  const key = collisionKey(name)
  if (siblingNames.some((s) => collisionKey(s) === key)) return 'collision'
  return null
}

const ERROR_KEYS = { collision: 'vaultTreeNameCollision', invalid: 'vaultTreeNameEmpty' }

/* แกนกลางของช่องชื่อ — New Folder กับ Rename ใช้เรือนเดียวกัน */
function NameDialogCore({
  t, title, submitLabel, open, onClose, onSubmit,
  initialName = null, siblingNames = [], noOpWhenUnchanged = false, unlockedState,
}) {
  const [name, setName] = useState(initialName ?? '')
  const [problem, setProblem] = useState(null)
  usePurgeAwareDialog(unlockedState, () => { setName(initialName ?? ''); setProblem(null); onClose() })
  useEffect(() => {
    if (open) { setName(initialName ?? ''); setProblem(null) }
  }, [open, initialName])

  const onInput = (value) => {
    setName(value)
    const st = nameState(value, siblingNames)
    setProblem(st === 'empty' ? null : st)
  }
  const unchanged = noOpWhenUnchanged && initialName !== null && collisionKey(name) === collisionKey(initialName)
  const canSubmit = problem === null && nameState(name, siblingNames) === null && !unchanged

  return (
    <Modal open={open} onClose={onClose} labelledBy="vault-dialog-title" width={420}>
      <ModalClose onClose={onClose} label={t('close')} />
      <h2 id="vault-dialog-title" className="text-[16px] font-semibold mb-4">{title}</h2>
      {problem && (
        <p data-testid="vault-dialog-error" role="alert" className="text-[12.5px] mb-2" style={{ color: 'var(--danger)' }}>
          {t(ERROR_KEYS[problem])}
        </p>
      )}
      <input
        type="text"
        data-testid="vault-dialog-name-input"
        value={name}
        onChange={(e) => onInput(e.target.value)}
        className="w-full h-10 px-3 rounded-[10px] border border-line bg-sunken text-[14px] text-ink outline-none focus:border-[var(--accent)]"
        aria-label={title}
      />
      <div className="flex justify-end gap-2 mt-5">
        <Btn variant="ghost" onClick={onClose}>{t('cancel')}</Btn>
        <Btn
          variant="primary"
          data-testid="vault-dialog-submit"
          disabled={!canSubmit}
          onClick={() => { onSubmit(name); onClose() }}
        >
          {submitLabel}
        </Btn>
      </div>
    </Modal>
  )
}

export function NewFolderDialog(props) {
  return <NameDialogCore {...props} title={props.t('vaultTreeNewFolderTitle')} submitLabel={props.t('vaultTreeNewFolderSubmit')} />
}

export function RenameDialog({ t, currentName, ...rest }) {
  return <NameDialogCore {...rest} t={t} initialName={currentName} noOpWhenUnchanged submitLabel={t('vaultTreeRenameSubmit')} title={t('vaultTreeRenameTitle')} />
}

/* ตัวเลือกโฟลเดอร์ — Move กับ Restore ใช้ร่วมกัน: รายการเดียวต่อโฟลเดอร์, เยื้องตามความลึก,
   ทำเครื่องหมายโฟลเดอร์แม่ปัจจุบัน, เลือกแล้วเปิดปุ่มส่ง */
function FolderPicker({ t, folders, currentParentNodeId = null, chosen, onChoose, emptyCopy }) {
  return (
    <div className="max-h-64 overflow-y-auto rounded-[10px] border border-line mb-4">
      {folders.length === 0 ? (
        <p className="text-[12.5px] text-ink-3 p-3">{emptyCopy ?? t('vaultTreeMoveNothing')}</p>
      ) : (
        folders.map((f) => (
          <div key={f.nodeId} data-testid="vault-dialog-move-row" data-node-id={f.nodeId} data-current-parent={f.nodeId === currentParentNodeId ? 'true' : undefined}>
            <button
              type="button"
              onClick={() => onChoose(f.nodeId)}
              className={`w-full flex items-center gap-2 text-left px-3 h-9 text-[13px] cursor-pointer transition-colors duration-[var(--dur-fast)] ${chosen === f.nodeId ? 'bg-sunken font-semibold text-ink' : 'text-ink-2 hover:bg-sunken'}`}
              style={{ paddingLeft: 12 + (f.depth ?? 0) * 16 }}
            >
              <span aria-hidden="true">{chosen === f.nodeId ? '◉' : '○'}</span>
              <span className="truncate">{f.name}</span>
              {f.nodeId === currentParentNodeId && <span className="text-[11px] text-ink-3">{t('vaultTreeRestoreChoose')}</span>}
            </button>
          </div>
        ))
      )}
    </div>
  )
}

export function MoveDialog({ t, open, onClose, onMove, folders = [], movingNames = [], currentParentNodeId = null, unlockedState }) {
  const [dest, setDest] = useState(null)
  usePurgeAwareDialog(unlockedState, () => { setDest(null); onClose() })
  useEffect(() => { if (open) setDest(null) }, [open])
  return (
    <Modal open={open} onClose={onClose} labelledBy="vault-dialog-title" width={420}>
      <ModalClose onClose={onClose} label={t('close')} />
      <h2 id="vault-dialog-title" className="text-[16px] font-semibold mb-4">
        {movingNames.length === 1 ? t('vaultTreeMoveTitleOne') : t('vaultTreeMoveTitle', { n: movingNames.length })}
      </h2>
      <p data-testid="vault-dialog-moving-names" className="text-[12.5px] text-ink-3 mb-3 truncate">{movingNames.join(', ')}</p>
      <p className="text-[12.5px] text-ink-2 font-medium mb-1">{t('vaultTreeMoveTo')}</p>
      <FolderPicker
        t={t}
        folders={folders}
        currentParentNodeId={currentParentNodeId}
        chosen={dest}
        onChoose={setDest}
      />
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>{t('cancel')}</Btn>
        <Btn variant="primary" data-testid="vault-dialog-submit" disabled={!dest} onClick={() => { onMove(dest); onClose() }}>
          {t('vaultTreeMoveSubmit')}
        </Btn>
      </div>
    </Modal>
  )
}

/* Details — เฉพาะช่องที่ client รู้จริงจาก manifest; node id/storage key ไม่ถูกวาดแม้ว่าจะถูกส่งเข้ามา */
export function DetailsDialog({ t, lang = 'en', open, onClose, node, cipherSize = null, unlockedState }) {
  usePurgeAwareDialog(unlockedState, onClose)
  if (!open || !node) return null
  const row = (label, value) => (
    <div className="flex justify-between gap-4 py-1.5 border-b border-line last:border-b-0">
      <span className="text-[12.5px] text-ink-3 shrink-0">{label}</span>
      <span className="text-[13px] text-ink truncate">{value}</span>
    </div>
  )
  return (
    <Modal open={open} onClose={onClose} labelledBy="vault-dialog-title" width={420}>
      <ModalClose onClose={onClose} label={t('close')} />
      <h2 id="vault-dialog-title" className="text-[16px] font-semibold mb-4">{t('vaultTreeDetailsTitle')}</h2>
      <div data-testid="vault-dialog-details">
        {row(t('vaultTreeDetailsName'), node.name)}
        {row(t('vaultTreeDetailsType'), node.kind === 'folder' ? '—' : (node.mediaType ?? '—'))}
        {node.kind !== 'folder' && row(t('vaultTreeDetailsSize'), fmtBytes(node.plainSize))}
        {row(t('vaultTreeDetailsCreated'), node.createdAtClient ? fmtDateTime(node.createdAtClient, lang) : '—')}
        {row(t('vaultTreeDetailsModified'), node.modifiedAtClient ? fmtDateTime(node.modifiedAtClient, lang) : '—')}
        {node.kind !== 'folder' && row(t('vaultTreeDetailsBlobFormat'), String(node.blobRef?.formatVersion ?? '—'))}
        {node.kind !== 'folder' && cipherSize != null && row(t('vaultTreeDetailsCipherSize'), fmtBytes(cipherSize))}
      </div>
      <div className="flex justify-end mt-5">
        <Btn variant="ghost" onClick={onClose}>{t('close')}</Btn>
      </div>
    </Modal>
  )
}

export function TrashConfirmDialog({ t, open, onClose, onConfirm, count, unlockedState }) {
  usePurgeAwareDialog(unlockedState, onClose)
  return (
    <Modal open={open} onClose={onClose} labelledBy="vault-dialog-title" width={420}>
      <ModalClose onClose={onClose} label={t('close')} />
      <h2 id="vault-dialog-title" className="text-[16px] font-semibold mb-4">{t('vaultTreeTrashTitle')}</h2>
      <div data-testid="vault-dialog-trash">
        <p className="text-[13px] text-ink-2">
          {count === 1 ? t('vaultTreeTrashBodyOne') : t('vaultTreeTrashBody', { n: count })}
        </p>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <Btn variant="ghost" onClick={onClose}>{t('cancel')}</Btn>
        <Btn variant="dangerSoft" data-testid="vault-dialog-submit" onClick={() => { onConfirm(); onClose() }}>
          {t('vaultTreeTrashConfirm')}
        </Btn>
      </div>
    </Modal>
  )
}

export function RestoreDialog({ t, open, onClose, onRestore, folders, originalParentAvailable, collisionForced = false, forcedReason = null, unlockedState }) {
  const forced = !originalParentAvailable || collisionForced
  const [dest, setDest] = useState(folders?.[0]?.nodeId ?? null)
  usePurgeAwareDialog(unlockedState, () => { setDest(null); onClose() })
  useEffect(() => { if (open) setDest(folders?.[0]?.nodeId ?? null) }, [open, folders])
  if (!forced) {
    return (
      <Modal open={open} onClose={onClose} labelledBy="vault-dialog-title" width={420}>
        <ModalClose onClose={onClose} label={t('close')} />
        <h2 id="vault-dialog-title" className="text-[16px] font-semibold mb-4">{t('vaultTreeRestoreTitle')}</h2>
        <button
          type="button"
          data-testid="vault-dialog-restore-one-click"
          onClick={() => { onRestore(null); onClose() }}
          className="w-full h-10 rounded-full bg-accent text-white font-semibold text-[14px] cursor-pointer"
        >
          {t('vaultTreeRestoreOneClick')}
        </button>
      </Modal>
    )
  }
  return (
    <Modal open={open} onClose={onClose} labelledBy="vault-dialog-title" width={420}>
      <ModalClose onClose={onClose} label={t('close')} />
      <h2 id="vault-dialog-title" className="text-[16px] font-semibold mb-2">{t('vaultTreeRestoreTitle')}</h2>
      {forcedReason && <p className="text-[12.5px] text-ink-3 mb-3">{forcedReason}</p>}
      <FolderPicker t={t} folders={folders} chosen={dest} onChoose={setDest} />
      <div className="flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose}>{t('cancel')}</Btn>
        <Btn variant="primary" data-testid="vault-dialog-submit" disabled={!dest} onClick={() => { onRestore(dest); onClose() }}>
          {t('vaultTreeRestoreSubmit')}
        </Btn>
      </div>
    </Modal>
  )
}

export function ConflictDialog({ t, open, onClose, conflict, choices = [], onChoice, unlockedState }) {
  usePurgeAwareDialog(unlockedState, onClose)
  if (!open || !conflict) return null
  const LABELS = { retry: t('vaultTreeConflictRetry'), discard: t('vaultTreeConflictDiscard'), chooseDestination: t('vaultTreeConflictChooseDestination') }
  return (
    <Modal open={open} onClose={onClose} labelledBy="vault-dialog-title" width={420}>
      <ModalClose onClose={onClose} label={t('close')} />
      <h2 id="vault-dialog-title" className="text-[16px] font-semibold mb-4">{t('vaultTreeConflictTitle')}</h2>
      <div data-testid="vault-dialog-conflict">
        <p className="text-[13px] text-ink-2 mb-4">{t(`vaultTreeConflictReason_${conflict.reason}`)}</p>
        <div className="flex flex-col gap-2">
          {choices.map((c) => (
            <Btn key={c} data-testid="vault-dialog-conflict-choice" data-choice={c} onClick={() => { onChoice(c); onClose() }}>
              {LABELS[c] ?? c}
            </Btn>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/* Permanent Delete — มีอยู่และทำงานเฉพาะเมื่อ Phase 8 วาดมันในถัง (จอ 6.x ไม่วาด)
   ปุ่มส่งเปิดเมื่อพิมพ์ชื่อตรงเป๊ะเท่านั้น (typed acknowledgement) */
export function PermanentDeleteDialog({ t, open, onClose, name, onConfirm, unlockedState }) {
  const [ack, setAck] = useState('')
  usePurgeAwareDialog(unlockedState, () => { setAck(''); onClose() })
  useEffect(() => { if (open) setAck('') }, [open, name])
  const canConfirm = name && ack === name
  return (
    <Modal open={open} onClose={onClose} labelledBy="vault-dialog-title" width={420}>
      <ModalClose onClose={onClose} label={t('close')} />
      <h2 id="vault-dialog-title" className="text-[16px] font-semibold mb-4">{t('vaultTreePermanentDeleteTitle')}</h2>
      <div data-testid="vault-dialog-permanent-delete">
        <p className="text-[13px] text-ink-2 mb-2">{t('vaultTreePermanentDeleteBody')}</p>
        <p className="text-[12.5px] text-ink-3 mb-2">{t('vaultTreePermanentDeleteType', { name })}</p>
        <input
          type="text"
          data-testid="vault-dialog-ack-input"
          value={ack}
          onChange={(e) => setAck(e.target.value)}
          className="w-full h-10 px-3 rounded-[10px] border border-line bg-sunken text-[14px] text-ink outline-none focus:border-[var(--accent)]"
          aria-label={t('vaultTreePermanentDeleteType', { name })}
        />
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <Btn variant="ghost" onClick={onClose}>{t('cancel')}</Btn>
        <Btn variant="danger" data-testid="vault-dialog-submit" disabled={!canConfirm} onClick={() => { onConfirm(); onClose() }}>
          {t('vaultTreePermanentDeleteSubmit')}
        </Btn>
      </div>
    </Modal>
  )
}
