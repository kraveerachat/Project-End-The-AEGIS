// src/screens/Login.jsx — AEGIS Monitor (IDEA2) · ประตูของ Monitor เอง
// ⚠️ Identity Decoupling: หน้านี้คุยกับ /api/login ของ Monitor เท่านั้น
//    ไม่มี SSO — ไม่มีการรับช่วงเซสชันจาก HUB หรือ Drive ไม่ว่ากรณีใด
// ⚠️ ไม่มีตัวเลือก role ที่นี่โดยเจตนา — role มาจากคำตอบของเซิร์ฟเวอร์เท่านั้น
//    การให้ client เลือกสิทธิ์เอง = Broken Access Control (OWASP A01)
import { useRef, useState } from 'react'
import { Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { login } from '../lib/auth.js'

export default function Login({ theme, onAuthed }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [lockSec, setLockSec] = useState(0)
  const busyRef = useRef(false)

  const logoSrc = theme === 'light'
    ? '/assets/logo/aegis-mark-dark-ink.png'
    : '/assets/logo/aegis-mark-light-ink.png'

  async function submit(e) {
    e?.preventDefault?.()
    if (busyRef.current || !username || !password) return
    busyRef.current = true
    setBusy(true)
    setError(false)

    // ส่งแค่ { username, password } — ไม่มี role, ไม่มี redirect target จาก client
    const res = await login({ username, password })

    if (!res.ok) {
      // ข้อความล้มเหลวรูปแบบเดียวทุกกรณี — กัน username enumeration
      // (การล็อกบังคับฝั่งเซิร์ฟเวอร์ — ตรงนี้แค่รายงานเวลาที่เหลือ)
      setError(true)
      setLockSec(res.status === 429 ? Math.ceil((res.lockedMs ?? 0) / 1000) : 0)
      setBusy(false)
      busyRef.current = false
      return
    }

    setLockSec(0)
    // user + เมนูวิว (filter ตาม role ฝั่งเซิร์ฟเวอร์แล้ว) ขึ้นไปให้ App
    onAuthed({ user: res.user, menu: res.menu })
  }

  return (
    <div className="loginwrap">
      <form className="panel glass logincard" onSubmit={submit}>
        <div className="loginbrand">
          <img src={logoSrc} alt="" aria-hidden="true" className="loginmark" />
          <div>
            <div className="wordmark">AEGIS Monitor</div>
            <div className="subtitle">AI CCTV · NEXT-GEN HUD</div>
          </div>
        </div>

        <div className="edtitle" style={{ marginTop: 18 }}>Operator sign-in</div>
        <p className="sub loginsub">
          Access is decided server-side per RBAC role — Aggregate or Scoped view.
        </p>

        <label className="flbl loginlbl" htmlFor="mon-user">Username</label>
        <input
          id="mon-user"
          className="edin loginin"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          disabled={busy}
        />

        <label className="flbl loginlbl" htmlFor="mon-pass">Password</label>
        <div className="loginpwrow">
          <input
            id="mon-pass"
            className="edin loginin"
            type={showPw ? 'text' : 'password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={busy}
          />
          <button
            type="button"
            className="iconbtn"
            aria-label={showPw ? 'Hide password' : 'Show password'}
            onClick={() => setShowPw((v) => !v)}
          >
            {showPw ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
          </button>
        </div>

        {error && (
          <p role="alert" aria-live="assertive" className="ederr loginerr">
            {lockSec > 0 ? `Too many attempts — locked for ${lockSec}s` : 'Invalid credentials'}
          </p>
        )}

        <button type="submit" className="ackbtn loginbtn" disabled={busy || !username || !password}>
          <ShieldCheck aria-hidden="true" />
          {busy ? 'Verifying…' : 'Sign in'}
        </button>

        <p className="loginfoot mono">
          Standalone edge deployment · identity managed within AEGIS Monitor
        </p>
      </form>
    </div>
  )
}
