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

export default function Operators() {
  // /api/operators คืน { operators, assignments } — assignments เป็น map camId → userId|'SOC'|null
  const api = useApi('/api/operators', { refreshMs: 30_000 })
  const camsApi = useApi('/api/cameras')
  const [editing, setEditing] = useState(null)   // operator id ที่กำลังแก้ assignment
  const [modal, setModal] = useState(null)       // null | 'form' | { username, tempPassword }

  const operators = api.data?.operators ?? []
  const assignments = api.data?.assignments ?? {}
  const cameras = camsApi.data?.cameras ?? []

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
        <h1 className="h1">Operators</h1>
        <p className="sub">
          Accounts in this app&apos;s own identity store, and which cameras each one is
          responsible for. Assignment drives both Scoped View and alert routing.
        </p>
      </div>
      <div className="pagehead-actions">
        {!api.loading && !api.error && (
          <button type="button" className="ackbtn" onClick={() => setModal('form')}>
            <UserPlus aria-hidden="true" size={13} style={{ marginRight: 6 }} />Add operator
          </button>
        )}
      </div>
    </div>
  )

  if (api.error) {
    return (
      <>
        {head}
        <EmptyState
          icon={ServerOff}
          title="Could not load operators"
          hint="The Monitor backend did not respond. Check the server, then retry."
          action={
            <button type="button" className="ackbtn" onClick={api.retry}>
              <RefreshCw aria-hidden="true" size={13} style={{ marginRight: 6 }} />Retry
            </button>
          }
        />
      </>
    )
  }

  return (
    <>
      {head}
      {api.loading ? (
        <div className="tablewrap panel glass" aria-busy="true" style={{ opacity: 0.45, height: 180 }} />
      ) : operators.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No operator accounts yet"
          hint="Add one to give a CCTV-Operator a scoped view of specific cameras."
          action={
            <button type="button" className="ackbtn" onClick={() => setModal('form')}>
              <UserPlus aria-hidden="true" size={13} style={{ marginRight: 6 }} />Add operator
            </button>
          }
        />
      ) : (
        <div className="tablewrap panel glass">
          <div className="tablescroll">
            <table className="dt">
              <thead>
                <tr>
                  <th scope="col">Operator</th>
                  <th scope="col">Role</th>
                  <th scope="col">Status</th>
                  <th scope="col">Assigned cameras</th>
                  <th scope="col" style={{ textAlign: 'right' }}>Assignment</th>
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
  return (
    <>
      <tr>
        <td>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
            <span className="opav" aria-hidden="true">{ini(op.name)}</span>
            {op.name}
          </span>
        </td>
        <td><span className="badge-role font-mono">{op.role}</span></td>
        <td>
          <span className={op.active ? 'statustag on' : 'statustag off'}>
            <span className={op.active ? 'tdot on' : 'tdot off'} />
            {op.active ? 'Active' : 'Suspended'}
          </span>
        </td>
        <td className="mono">
          {held.length ? held.join(', ') : <span style={{ opacity: 0.5 }}>none</span>}
        </td>
        <td style={{ textAlign: 'right' }}>
          <button type="button" className="opassign" onClick={onToggle} aria-expanded={open}>
            {open ? 'Cancel' : 'Edit'}
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
      <div className="edtitle">Cameras for {op.name}</div>
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
              {takenByOther && <span className="from">from {nameById.get(ownerId) ?? ownerId}</span>}
              {owner === 'SOC' && <span className="from">SOC-Team</span>}
            </label>
          )
        })}
      </div>
      {error && <p role="alert" className="ederr">{error}</p>}
      <div className="edactions">
        <button type="button" className="ackbtn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className="ackbtn aop-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save assignment'}
        </button>
      </div>
    </div>
  )
}
