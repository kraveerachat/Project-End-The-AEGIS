import { motion } from 'framer-motion'
import { Bell, LogOut } from 'lucide-react'
import { Ping } from './ui.jsx'

const initialsOf = (name) =>
  String(name ?? '')
    .split(/[ .-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '—'

const LINK_PILLS = {
  online: {
    node: { text: 'Edge node: online', tone: 'ok', cls: 'pill' },
    ai: { text: 'AI engine: running', tone: 'ok', cls: 'pill optional' },
    lan: { text: 'LAN · 4 ms', tone: 'ok', cls: 'pill mono optional' },
  },
  degraded: {
    node: { text: 'Edge node: degraded', tone: 'amb', cls: 'pill warn' },
    ai: { text: 'AI engine: running', tone: 'ok', cls: 'pill optional' },
    lan: { text: 'LAN · 210 ms', tone: 'amb', cls: 'pill mono warn optional' },
  },
  lost: {
    node: { text: 'Edge node: unreachable', tone: 'down', cls: 'pill down' },
    ai: { text: 'AI engine: unknown', tone: 'down', cls: 'pill down optional' },
    lan: { text: 'LAN · —', tone: 'down', cls: 'pill mono down optional' },
  },
}

export default function TopBar({ theme = 'dark', clockText, dateText, linkStatus, unacked, showBell = true, onBell, user, onSignOut }) {
  const pills = LINK_PILLS[linkStatus]
  const logoSrc = theme === 'light'
    ? '/assets/logo/aegis-mark-dark-ink.png'
    : '/assets/logo/aegis-mark-light-ink.png'

  return (
    <header className="topbar">
      {/* LEFT ZONE: Exact CCTV Metallic Emblem Logo */}
      <motion.div
        className="brandrow"
        whileHover={{ scale: 1.02 }}
        transition={{ duration: 0.2 }}
      >
        <div className="shield-img-wrap" aria-hidden="true">
          <img src={logoSrc} alt="AEGIS Logo" className="shield-img" />
        </div>
        <div>
          <div className="wordmark">AEGIS Monitor</div>
          <div className="subtitle">AI CCTV · NEXT-GEN HUD</div>
        </div>
      </motion.div>

      {/* CENTER ZONE: Centered Status Pills */}
      <div className="statrow" role="status" aria-live="polite">
        <motion.span className={pills.node.cls} whileHover={{ scale: 1.04 }} transition={{ duration: 0.15 }}>
          <Ping tone={pills.node.tone} />{pills.node.text}
        </motion.span>
        <motion.span className={pills.ai.cls} whileHover={{ scale: 1.04 }} transition={{ duration: 0.15 }}>
          <Ping tone={pills.ai.tone} />{pills.ai.text}
        </motion.span>
        <motion.span className={pills.lan.cls} whileHover={{ scale: 1.04 }} transition={{ duration: 0.15 }}>
          <Ping tone={pills.lan.tone} />{pills.lan.text}
        </motion.span>
      </div>

      {/* RIGHT ZONE: Tactical Clock, Frameless Bell, Dividers & User Avatar */}
      <div className="right-zone">
        <div className="clock-wrap">
          <span className="clock mono">{clockText}</span>
          <span className="cdate mono">{dateText}</span>
        </div>

        {/* กระดิ่ง Alerts มีเฉพาะเมื่อ role มีวิว alerts (เมนูจากเซิร์ฟเวอร์) —
            CCTV-Operator ต้องไม่พบร่องรอยของ Alerts ใน DOM เลย */}
        {showBell && (
          <>
            <div className="divider" />
            <motion.button
              type="button"
              className="iconbtn"
              onClick={onBell}
              aria-label={unacked > 0 ? `Alerts — ${unacked} awaiting acknowledgment` : 'Alerts'}
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.92 }}
            >
              <Bell aria-hidden="true" />
              {unacked > 0 && <span className="bdot" aria-hidden="true" />}
            </motion.button>
          </>
        )}

        <div className="divider" />

        {/* role chip = จอแสดงผลของสิ่งที่เซิร์ฟเวอร์ตัดสินมา — ไม่ใช่ตัวเลือก */}
        <div className="usermeta-wrap">
          <div className="avatar" aria-hidden="true">{initialsOf(user?.displayName)}</div>
          <div className="usermeta">
            <span className="username">{user?.displayName ?? '—'}</span>
            <span className="rolechip">{user?.role ?? '—'}</span>
          </div>
        </div>

        <div className="divider" />

        <motion.button
          type="button"
          className="iconbtn"
          onClick={onSignOut}
          aria-label="Sign out"
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
        >
          <LogOut aria-hidden="true" />
        </motion.button>
      </div>
    </header>
  )
}
