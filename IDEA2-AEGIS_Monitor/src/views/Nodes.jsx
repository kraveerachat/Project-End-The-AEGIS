import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, RefreshCw, ServerOff, UserPlus, X } from 'lucide-react'
import { ini } from '../data.js'
import { EmptyState, FeedChrome, StaleBadge } from '../components/ui.jsx'
import { useApi } from '../lib/hooks.js'
import { apiFetch } from '../lib/api.js'

// ⚠️ Phase 2: SOC-only view — self-fetches GET /api/nodes (cameras + assignments +
// operators + link, all pre-scoped/joined server-side). No props from App.jsx;
// this view owns its own data lifecycle like Live/Archive/Settings do.
//
// "Add operator" อยู่ในวิวนี้เพราะทั้งวิวถูกส่งให้เฉพาะ SOC-Responder ผ่าน menu payload
// ฝั่งเซิร์ฟเวอร์ (permissions.js) — ไม่มี client-side role check ที่ไหน CCTV-Operator
// ไม่เคยได้รับวิวนี้ใน DOM เลย และ POST /api/operators ยังบังคับ requireRole ซ้ำอีกชั้น
export default function Nodes() {
  const api = useApi('/api/nodes', { refreshMs: 30_000 })
  // null = ปิด · 'form' = ฟอร์มเพิ่ม operator · { username, tempPassword } = โชว์รหัสครั้งเดียว
  const [modal, setModal] = useState(null)

  const onCreated = (result) => setModal(result) // สลับจากฟอร์มไปหน้าโชว์รหัสชั่วคราว
  const closeAndRefresh = () => {
    const wasSuccess = modal && modal !== 'form'
    setModal(null)
    if (wasSuccess) api.retry() // รีเฟรช Nodes list ให้ operator ใหม่โผล่โดยไม่ต้อง reload เอง
  }

  const head = <PageHead link={api.data?.link} onAdd={api.loading || api.error ? null : () => setModal('form')} />

  if (api.loading) {
    return (
      <>
        {head}
        <div className="nodegrid" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <article key={i} className="node glass rise" style={{ opacity: 0.45 }}>
              <div className="nodefeed"><FeedChrome /></div>
            </article>
          ))}
        </div>
      </>
    )
  }

  if (api.error) {
    return (
      <>
        {head}
        <EmptyState
          icon={ServerOff}
          title="Could not load nodes"
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

  if (cameras.length === 0) {
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
            <article key={c.id} className="node glass rise" style={{ '--i': Math.min(i, 8) }}>
              <div className="nodefeed">
                <FeedChrome />
                {c.online ? (
                  <>
                    <span className="clipid mono">{c.id}</span>
                    <span className="sflive"><span className="rec" />LIVE</span>
                  </>
                ) : (
                  <div className="nodeoff">
                    <span className="offbadge">Signal lost</span>
                    <span>Camera offline</span>
                  </div>
                )}
              </div>
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

// ── ฟอร์มเพิ่ม operator ─────────────────────────────────────────────────────
// username + dropdown ของกล้องที่ "ว่างจริง" (ดึงสด GET /api/operators/available-cameras
// ทุกครั้งที่เปิด — ไม่คำนวณจาก state เก่าของ Nodes) รหัสผ่านชั่วคราวสร้างฝั่งเซิร์ฟเวอร์
const USERNAME_RE = /^[a-z][a-z0-9._-]{2,39}$/ // = server USERNAME_RE (validate ฝั่ง client แค่เพื่อ UX)

function AddOperatorModal({ onClose, onCreated }) {
  const [username, setUsername] = useState('')
  const [cameraId, setCameraId] = useState('')
  const [cams, setCams] = useState(null)        // null = กำลังโหลด · [] = โหลดแล้ว
  const [camsError, setCamsError] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const res = await apiFetch('/api/operators/available-cameras')
      if (!alive) return
      if (res.ok) setCams(res.data?.cameras ?? [])
      else { setCams([]); setCamsError(true) }
    })()
    return () => { alive = false }
  }, [])

  const uname = username.trim().toLowerCase()
  const usernameValid = USERNAME_RE.test(uname)
  const canSubmit = usernameValid && !submitting && !camsError

  const submit = async (e) => {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    const res = await apiFetch('/api/operators', {
      method: 'POST',
      body: { username: uname, cameraId: cameraId || undefined },
    })
    setSubmitting(false)
    if (res.ok && res.data?.tempPassword) {
      onCreated({ username: res.data.operator?.name ?? uname, tempPassword: res.data.tempPassword })
      return
    }
    setError(res.data?.error || (res.errorKind === 'network' ? 'Network error — try again' : 'Could not add operator'))
  }

  return (
    <ModalShell titleId="aop-title" onClose={onClose}>
      <div className="aop-head">
        <div>
          <div className="edtitle" id="aop-title">Add operator</div>
          <p className="sub" style={{ margin: '4px 0 0' }}>
            Creates a CCTV-Operator with a server-generated temporary password.
          </p>
        </div>
        <button type="button" className="iconbtn" onClick={onClose} aria-label="Close">
          <X aria-hidden="true" size={16} />
        </button>
      </div>

      <form className="aop-body" onSubmit={submit}>
        <div className="aop-field">
          <label className="flbl" htmlFor="aop-username">Username</label>
          <input
            id="aop-username"
            className="edin aop-in"
            type="text"
            autoComplete="off"
            autoFocus
            placeholder="e.g. m.reyes"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-invalid={username.length > 0 && !usernameValid ? 'true' : undefined}
            aria-describedby="aop-username-hint"
          />
          <span className="aop-hint" id="aop-username-hint">
            lowercase, starts with a letter · a–z 0–9 . _ - · 3–40 chars
          </span>
        </div>

        <div className="aop-field">
          <label className="flbl" htmlFor="aop-camera">Assign camera (optional)</label>
          <select
            id="aop-camera"
            className="edin aop-in"
            value={cameraId}
            onChange={(e) => setCameraId(e.target.value)}
            disabled={cams === null || camsError}
          >
            <option value="">
              {cams === null ? 'Loading available cameras…' : 'No camera — assign later'}
            </option>
            {(cams ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.id} · {c.name}</option>
            ))}
          </select>
          {camsError && <span className="ederr">Could not load cameras — you can still create the account without one.</span>}
          {cams !== null && !camsError && cams.length === 0 && (
            <span className="aop-hint">Every camera is already assigned to an operator.</span>
          )}
        </div>

        {error && <p role="alert" aria-live="assertive" className="ederr">{error}</p>}

        <div className="aop-actions">
          <button type="button" className="ackbtn" onClick={onClose} disabled={submitting}>Cancel</button>
          <button type="submit" className="ackbtn aop-primary" disabled={!canSubmit}>
            {submitting ? 'Adding…' : 'Add operator'}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

// ── โชว์รหัสผ่านชั่วคราว "ครั้งเดียว" — คัดลอกได้ ไม่มีการเก็บลง browser storage ใด ๆ ──
function TempPasswordModal({ result, onClose }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(result.tempPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <ModalShell titleId="aoptp-title" onClose={onClose}>
      <div className="aop-head">
        <div>
          <div className="edtitle" id="aoptp-title" style={{ color: 'var(--teal)' }}>Operator created</div>
          <p className="sub" style={{ margin: '4px 0 0' }}>
            <strong style={{ color: 'var(--white)' }}>{result.username}</strong> can sign in with the password below,
            then must set a new one.
          </p>
        </div>
      </div>

      <div className="aop-body">
        <div className="aop-field">
          <span className="flbl">Temporary password</span>
          <div className="aop-pwrow">
            <code className="aop-pw mono">{result.tempPassword}</code>
            <button type="button" className="ackbtn aop-copy" onClick={copy}>
              {copied
                ? <><Check aria-hidden="true" size={13} style={{ marginRight: 6 }} />Copied</>
                : <><Copy aria-hidden="true" size={13} style={{ marginRight: 6 }} />Copy</>}
            </button>
          </div>
        </div>

        <p className="aop-warn">
          <AlertTriangle aria-hidden="true" size={14} />
          <span>This password won’t be shown again. Copy it now and hand it to the operator out-of-band — it is not stored anywhere.</span>
        </p>

        <div className="aop-actions">
          <button type="button" className="ackbtn aop-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </ModalShell>
  )
}

// เปลือก modal ร่วม — backdrop + panel glass, ปิดด้วย Esc หรือคลิกนอกกล่อง
function ModalShell({ titleId, onClose, children }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="aop-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="panel glass aop-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {children}
      </div>
    </div>
  )
}
