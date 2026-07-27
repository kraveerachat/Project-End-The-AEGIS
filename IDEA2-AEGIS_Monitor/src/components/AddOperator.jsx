// src/components/AddOperator.jsx — AEGIS Monitor (IDEA2)
// ⚠️ ย้ายมาจาก src/views/Nodes.jsx (2026-07-27) เพื่อให้วิว Operators ที่เพิ่งสร้าง
//    ใช้ฟอร์มเดียวกันได้โดยไม่ก๊อปโค้ด — พฤติกรรมเดิมทุกประการ ไม่มีการแก้ตรรกะ
//    (แหล่งความจริงของ provisioning ยังเป็น store.provisionOperator ฝั่งเซิร์ฟเวอร์)
import { useEffect, useState } from 'react'
import { AlertTriangle, Check, Copy, X } from 'lucide-react'
import { apiFetch } from '../lib/api.js'

// ── ฟอร์มเพิ่ม operator ─────────────────────────────────────────────────────
// username + dropdown ของกล้องที่ "ว่างจริง" (ดึงสด GET /api/operators/available-cameras
// ทุกครั้งที่เปิด — ไม่คำนวณจาก state เก่าของ Nodes) รหัสผ่านชั่วคราวสร้างฝั่งเซิร์ฟเวอร์
const USERNAME_RE = /^[a-z][a-z0-9._-]{2,39}$/ // = server USERNAME_RE (validate ฝั่ง client แค่เพื่อ UX)

export function AddOperatorModal({ onClose, onCreated }) {
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
export function TempPasswordModal({ result, onClose }) {
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
