import React, { useState } from 'react'
import { ArrowRight, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react'

export function LoginPage({ onLogin }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await onLogin({ username: username.trim(), password })
      setPassword('')
    } catch (loginError) {
      setError(loginError?.message || 'เข้าสู่ระบบไม่สำเร็จ')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-context">
        <div className="login-context__content">
          <div className="login-emblem"><ShieldCheck size={30} /><span>AEGIS</span></div>
          <p className="kicker">IDEA3 · SECURITY OPERATIONS</p>
          <h1>หลักฐานชัดเจน<br />ก่อนทุกการตอบสนอง</h1>
          <p>ศูนย์รวมสถานะ ความเสี่ยง และลำดับการตอบสนองแบบ Admin-only โดยไม่เปิดเส้นทางควบคุมอุปกรณ์จากเบราว์เซอร์</p>
          <div className="login-assurance"><span><i />Server-owned evidence</span><span><i />Fail-closed status</span><span><i />Audited actions</span></div>
        </div>
        <div className="login-grid" aria-hidden="true" />
      </section>
      <section className="login-form-wrap">
        <form className="login-card" onSubmit={submit}>
          <span className="login-card__icon"><LockKeyhole /></span>
          <p className="kicker">ADMINISTRATOR ACCESS</p>
          <h2>เข้าสู่ Security Center</h2>
          <p className="login-card__intro">ใช้บัญชีผู้ดูแลระบบที่กำหนดจากฝั่งเซิร์ฟเวอร์</p>
          {error && <div className="form-error" role="alert">{error}</div>}
          <label>ชื่อผู้ดูแลระบบ<input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" maxLength={80} required /></label>
          <label>รหัสผ่าน<span className="password-field"><input type={visible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" maxLength={200} required /><button type="button" aria-label={visible ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'} onClick={() => setVisible((value) => !value)}>{visible ? <EyeOff /> : <Eye />}</button></span></label>
          <button className="button button--primary button--wide" type="submit" disabled={busy}>{busy ? 'กำลังตรวจสอบ…' : 'เข้าสู่ Security Center'}<ArrowRight size={17} /></button>
          <p className="login-footnote">Protected by Admin RBAC · CSRF · Secure session</p>
        </form>
      </section>
    </main>
  )
}
