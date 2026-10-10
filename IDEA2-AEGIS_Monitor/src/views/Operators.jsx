// src/views/Operators.jsx — AEGIS Monitor (IDEA2) · View #6
//
// ⚠️ วิวนี้ "ขาดหายไป" มานาน: server/rbac/permissions.js ส่ง id 'operators' มาใน
//    เมนูของ SOC-Responder อยู่แล้ว, README.md ระบุสเปกไว้เป็น View #6, src/index.css
//    มีบล็อก /* operators */ (.tablewrap/.dt/.opav/.opassign/.edrow/.camopts) รออยู่ครบ
//    และ PUT /api/assignments ก็มีฝั่งเซิร์ฟเวอร์แล้ว — ขาดแค่ component ตัวนี้ตัวเดียว
//    ผลคือเมนูถูก src/nav.js ทิ้งเงียบ ๆ และ endpoint assignment ไม่มีผู้เรียกเลย
//    ไฟล์นี้ปิดช่องว่างนั้น: ทั้งสามชั้นที่สร้างไว้แล้วถูกต่อเข้าหากันจริง
//
// ขอบเขต: SOC-Responder เท่านั้น — บังคับฝั่งเซิร์ฟเวอร์สองชั้น (เมนูไม่ถูกส่งให้
// operator เลย + ทุก endpoint ที่นี่ผ่าน requireRole(ROLES.SOC)) ไม่มี role check ฝั่ง client
import { useMemo, useState } from 'react'
import { RefreshCw, ServerOff, UserPlus, Users } from 'lucide-react'
import { ini } from '../data.js'
import { EmptyState } from '../components/ui.jsx'
import { useApi } from '../lib/hooks.js'
import { apiFetch } from '../lib/api.js'
import { AddOperatorModal, TempPasswordModal } from '../components/AddOperator.jsx'
import { getViewState, VIEW_STATE } from '../lib/viewState.js'
import { useLocale } from '../lib/Locale.jsx'
import { adminErrorMessage } from '../lib/localeAdmin.js'

export default function Operators() {
  const { t } = useLocale()
  // /api/operators คืน { operators, assignments } — assignments เป็น map camId → userId|'SOC'|null
  const api = useApi('/api/operators', { refreshMs: 30_000 })
  const camsApi = useApi('/api/cameras')
  const [editing, setEditing] = useState(null)   // operator id ที่กำลังแก้ assignment
  const [modal, setModal] = useState(null)       // null | 'form' | { username, tempPassword }

  const operators = api.data?.operators ?? []
  const assignments = api.data?.assignments ?? {}
  const cameras = camsApi.data?.cameras ?? []
  const state = getViewState(api, (data) => (data?.operators ?? []).length === 0)

  // operator id → รายการกล้องที่ถือครองอยู่ (คำนวณจาก assignments ที่เซิร์ฟเวอร์ส่งมา)
  const camsOf = useMemo(() => {
    const m = new Map()
    for (const [camId, owner] of Object.entries(assignments)) {
      if (owner == null || owner === 'SOC') continue
      const k = String(owner)
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(camId)
    }
    return m
  }, [assignments])

  const closeAndRefresh = () => {
    const wasSuccess = modal && modal !== 'form'
    setModal(null)
    if (wasSuccess) api.retry()
  }

  const head = (
    <div className="pagehead">
      <div>
        <h1 className="h1">{t('Operators')}</h1>
        <p className="sub">
          {t("Accounts in this app's own identity store, and which cameras each one is responsible for. Assignment drives both Scoped View and alert routing.")}
        </p>
      </div>
      <div className="pagehead-actions">
        {state === VIEW_STATE.SUCCESS_EMPTY || state === VIEW_STATE.SUCCESS_DATA ? (
          <button type="button" className="ackbtn" onClick={() => setModal('form')}>
            <UserPlus aria-hidden="true" size={13} style={{ marginRight: 6 }} />{t('Add operator')}
          </button>
        ) : null}
      </div>
    </div>
  )

  if (state === VIEW_STATE.ERROR) {
    return (
      <EmptyState icon={ServerOff} title={t('Could not load operators')}
        hint={t('The Monitor backend did not respond. Check the server, then retry.')}
        action={<button type="button" className="ackbtn" onClick={api.retry}><RefreshCw aria-hidden="true" size={13} style={{ marginRight: 6 }} />{t('Retry')}</button>} />
    )
  }

  if (state === VIEW_STATE.LOADING) {
    return <EmptyState icon={Users} title={t('Loading operators')} hint={t('Retrieving operator accounts and assignments.')} />
  }

  return (
    <>
      {head}
      {state === VIEW_STATE.SUCCESS_EMPTY ? (
        <EmptyState
          icon={Users}
          title={t('No operator accounts yet')}
          hint={t('Add one to give a CCTV-Operator a scoped view of specific cameras.')}
          action={
            <button type="button" className="ackbtn" onClick={() => setModal('form')}>
              <UserPlus aria-hidden="true" size={13} style={{ marginRight: 6 }} />{t('Add operator')}
            </button>
          }
        />
      ) : (
        <div className="tablewrap panel glass">
          <div className="tablescroll">
            <table className="dt">
              <thead>
                <tr>
                  <th scope="col">{t('Operator')}</th>
                  <th scope="col">{t('Role')}</th>
                  <th scope="col">{t('Status')}</th>
                  <th scope="col">{t('Assigned cameras')}</th>
                  <th scope="col" style={{ textAlign: 'right' }}>{t('Assignment')}</th>
                </tr>
              </thead>
              <tbody>
                {operators.map((op) => {
                  const held = camsOf.get(String(op.id)) ?? []
                  const open = editing === String(op.id)
                  return (
                    <Row
                      key={op.id}
                      op={op}
                      held={held}
                      open={open}
                      cameras={cameras}
                      assignments={assignments}
                      operators={operators}
                      onToggle={() => setEditing(open ? null : String(op.id))}
                      onSaved={() => { setEditing(null); api.retry() }}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal === 'form' && (
        <AddOperatorModal onClose={() => setModal(null)} onCreated={(r) => setModal(r)} />
      )}
      {modal && modal !== 'form' && (
        <TempPasswordModal result={modal} onClose={closeAndRefresh} />
      )}
    </>
  )
}

function Row({ op, held, open, cameras, assignments, operators, onToggle, onSaved }) {
  const { t } = useLocale()
  return (
    <>
      <tr>
        <td>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span className="opav" aria-hidden="true">{ini(op.name)}</span>
            {op.name}
          </span>
        </td>
        <td><span className="badge-role font-mono">{['CCTV-Operator', 'SOC-Responder'].includes(op.role) ? t(op.role) : op.role}</span></td>
        <td>
          <span className={op.active ? 'statustag on' : 'statustag off'}>
            <span className={op.active ? 'tdot on' : 'tdot off'} />
            {t(op.active ? 'Active' : 'Suspended')}
          </span>
        </td>
        <td className="mono">
          {held.length ? held.join(', ') : <span style={{ opacity: 0.5 }}>{t('none')}</span>}
        </td>
        <td style={{ textAlign: 'right' }}>
          <button type="button" className="opassign" onClick={onToggle} aria-expanded={open}>
            {t(open ? 'Cancel' : 'Edit')}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="edrow">
          <td colSpan={5}>
            <AssignEditor
              op={op}
              held={held}
              cameras={cameras}
              assignments={assignments}
              operators={operators}
              onCancel={onToggle}
              onSaved={onSaved}
            />
          </td>
        </tr>
      )}
    </>
  )
}

// ── ตัวแก้ assignment — ผู้เรียกเดียวของ PUT /api/assignments ────────────────
// ⚠️ ส่ง "ชุดกล้องทั้งหมดของ operator คนนี้" ไปแทนที่ของเดิม (semantics ของ endpoint:
//    store.assignCameras แทนที่ทั้งชุด ไม่ใช่เพิ่มทีละตัว) — UI จึงเป็น multi-select
function AssignEditor({ op, held, cameras, assignments, operators, onCancel, onSaved }) {
  const { t } = useLocale()
  const [sel, setSel] = useState(() => new Set(held))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const nameById = useMemo(
    () => new Map(operators.map((o) => [String(o.id), o.name])),
    [operators],
  )

  const toggle = (id) => setSel((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const save = async () => {
    setBusy(true)
    setError(null)
    const res = await apiFetch('/api/assignments', {
      method: 'PUT',
      body: { operatorId: op.id, cameraIds: [...sel] },
    })
    setBusy(false)
    if (res.ok) { onSaved(); return }
    setError(res.data?.error || (res.errorKind === 'network' ? 'Network error — try again' : 'Could not save assignment'))
  }

  return (
    <div className="edform">
      <div className="edtitle">{t('Cameras for {name}', { name: op.name })}</div>
      <div className="camopts">
        {cameras.map((c) => {
          const owner = assignments[c.id]
          const ownerId = owner == null || owner === 'SOC' ? null : String(owner)
          const takenByOther = ownerId != null && ownerId !== String(op.id)
          const on = sel.has(c.id)
          return (
            <label key={c.id} className={on ? 'camopt sel' : 'camopt'}>
              <input type="checkbox" checked={on} onChange={() => toggle(c.id)} />
              <span>{c.id} · {c.name}</span>
              {/* บอกตรง ๆ ว่ากล้องนี้ถูกถือครองโดยใครอยู่ — ติ๊กทับได้ แต่ต้องรู้ตัว */}
              {takenByOther && <span className="from">{t('from {name}', { name: nameById.get(ownerId) ?? ownerId })}</span>}
              {owner === 'SOC' && <span className="from">{t('SOC-Team')}</span>}
            </label>
          )
        })}
      </div>
      {error && <p role="alert" className="ederr">{adminErrorMessage(error, t)}</p>}
      <div className="edactions">
        <button type="button" className="ackbtn" onClick={onCancel} disabled={busy}>{t('Cancel')}</button>
        <button type="button" className="ackbtn aop-primary" onClick={save} disabled={busy}>
          {t(busy ? 'Saving…' : 'Save assignment')}
        </button>
      </div>
    </div>
  )
}
