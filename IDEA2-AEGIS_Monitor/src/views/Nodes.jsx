import { useEffect, useState } from 'react'
import { RefreshCw, ServerOff, UserPlus } from 'lucide-react'
import { ini } from '../data.js'
import { EmptyState, StaleBadge } from '../components/ui.jsx'
import { useApi } from '../lib/hooks.js'
import { AddOperatorModal, TempPasswordModal } from '../components/AddOperator.jsx'
import { getViewState, VIEW_STATE } from '../lib/viewState.js'

// ⚠️ Phase 2: SOC-only view — self-fetches GET /api/nodes (cameras + assignments +
// operators + link, all pre-scoped/joined server-side). No props from App.jsx;
// this view owns its own data lifecycle like Live/Archive/Settings do.
//
// "Add operator" อยู่ในวิวนี้เพราะทั้งวิวถูกส่งให้เฉพาะ SOC-Responder ผ่าน menu payload
// ฝั่งเซิร์ฟเวอร์ (permissions.js) — ไม่มี client-side role check ที่ไหน CCTV-Operator
// ไม่เคยได้รับวิวนี้ใน DOM เลย และ POST /api/operators ยังบังคับ requireRole ซ้ำอีกชั้น
export default function Nodes() {
  const api = useApi('/api/nodes', { refreshMs: 30_000 })
  const state = getViewState(api, (data) => (data?.cameras ?? []).length === 0)
  // null = ปิด · 'form' = ฟอร์มเพิ่ม operator · { username, tempPassword } = โชว์รหัสครั้งเดียว
  const [modal, setModal] = useState(null)

  const onCreated = (result) => setModal(result) // สลับจากฟอร์มไปหน้าโชว์รหัสชั่วคราว
  const closeAndRefresh = () => {
    const wasSuccess = modal && modal !== 'form'
    setModal(null)
    if (wasSuccess) api.retry() // รีเฟรช Nodes list ให้ operator ใหม่โผล่โดยไม่ต้อง reload เอง
  }

  const head = <PageHead link={api.data?.link} onAdd={api.loading || api.error ? null : () => setModal('form')} />

  if (state === VIEW_STATE.LOADING) {
    return (
      <>
        {head}
        <div className="nodegrid" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <article key={i} className="node node--routing glass rise" style={{ opacity: 0.45 }}>
              <div className="nodebody nodebody--loading" aria-hidden="true">
                <span className="node-skeleton node-skeleton--title" />
                <span className="node-skeleton" />
                <span className="node-skeleton" />
                <span className="node-skeleton" />
              </div>
            </article>
          ))}
        </div>
      </>
    )
  }

  if (state === VIEW_STATE.ERROR) {
    return (
      <EmptyState icon={ServerOff} title="Could not load nodes"
        hint="The Monitor backend did not respond. Check the server, then retry."
        action={<button type="button" className="ackbtn" onClick={api.retry}><RefreshCw aria-hidden="true" size={13} style={{ marginRight: 6 }} />Retry</button>} />
    )
  }

  const cameras = api.data?.cameras ?? []
  const operators = api.data?.operators ?? []
  const assignments = api.data?.assignments ?? {}
  const link = api.data?.link ?? { status: 'lost' }

  const resolve = (camId) => {
    const v = assignments[camId]
    if (v === 'SOC') return { name: 'SOC-Team', active: true }
    if (!v) return null
    const op = operators.find((o) => o.id === v)
    return op ? { name: op.name, active: op.active } : null
  }

  const modals = (
    <>
      {modal === 'form' && <AddOperatorModal onClose={() => setModal(null)} onCreated={onCreated} />}
      {modal && modal !== 'form' && <TempPasswordModal result={modal} onClose={closeAndRefresh} />}
    </>
  )

  if (state === VIEW_STATE.SUCCESS_EMPTY) {
    return (
      <>
        <PageHead link={link} onAdd={() => setModal('form')} />
        <EmptyState
          icon={ServerOff}
          title="No cameras registered"
          hint="No camera nodes are connected to this deployment yet."
        />
        {modals}
      </>
    )
  }

  return (
    <>
      <PageHead link={link} onAdd={() => setModal('form')} />
      <div className="nodegrid">
        {cameras.map((c, i) => {
          const op = resolve(c.id)
          return (
            <article key={c.id} className="node node--routing glass rise" style={{ '--i': Math.min(i, 8) }}>
              <div className="nodebody">
                <div className="nodename">
                  {c.name}
                  {c.online && <span className="recwrap"><span className="rec" />REC</span>}
                </div>
                <div className="nodefields">
                  <div className="nfield"><span className="nflab">Camera ID</span><span className="nfval mono">{c.id}</span></div>
                  <div className="nfield"><span className="nflab">Zone</span><span className="nfval">{c.zone}</span></div>
                  <div className="nfield"><span className="nflab">Resolution</span><span className="nfval mono">{c.res}</span></div>
                  <div className="nfield">
                    <span className="nflab">Assigned to</span>
                    {op ? (
                      <span
                        className={op.active ? 'assigned' : 'assigned un'}
                        title={op.active ? undefined : 'Suspended — alerts route to SOC-Team'}
                      >
                        <span className="av" aria-hidden="true">{ini(op.name)}</span>
                        {op.name}{!op.active && ' · suspended'}
                      </span>
                    ) : (
                      <span className="assigned un">Unassigned</span>
                    )}
                  </div>
                  <div className="nfield">
                    <span className="nflab">Status</span>
                    <span className={c.online ? 'statustag on' : 'statustag off'}>
                      <span className={c.online ? 'tdot on' : 'tdot off'} />
                      {c.online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                </div>
              </div>
            </article>
          )
        })}
      </div>
      {modals}
    </>
  )
}

function PageHead({ link, onAdd }) {
  return (
    <div className="pagehead">
      <div>
        <h1 className="h1">Nodes &amp; routing</h1>
        <p className="sub">Connected cameras and their responsible operator, per central RBAC assignment.</p>
      </div>
      <div className="pagehead-actions">
        {link && link.status !== 'online' && <StaleBadge red={link.status === 'lost'} label="Status may be stale" />}
        {onAdd && (
          <button type="button" className="ackbtn" onClick={onAdd}>
            <UserPlus aria-hidden="true" size={13} style={{ marginRight: 6 }} />Add operator
          </button>
        )}
      </div>
    </div>
  )
}
