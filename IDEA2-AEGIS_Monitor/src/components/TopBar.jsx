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

// ⚠️ เดิมไฟล์นี้มีตาราง LINK_PILLS ที่ hardcode ทุกอย่าง รวมถึง "LAN · 4 ms" และ
//    "LAN · 210 ms" ซึ่งเป็นตัวเลขที่แต่งขึ้นล้วน ๆ (ไม่มีการวัด latency ที่ไหนเลย)
//    และ "AI engine: running" ที่เขียวตลอดแม้ engine จะไม่เคยรัน
//    ตอนนี้ทุก pill มาจาก /api/link ซึ่งอ่านตาราง camera_heartbeat จริง:
//      - node   = สถานะจากอายุ heartbeat ล่าสุด (online/degraded/lost)
//      - ai     = engine ที่ยังส่ง heartbeat อยู่ = กำลังรัน; เงียบ = unknown
//      - detect = detect_fps จริงจาก MetricsRegistry (ไม่ใช่ latency ปลอม)
//    ค่าที่ยังวัดไม่ได้ → แสดง "unavailable" ไม่ใช่ตัวเลขที่ดูสมจริง
const NODE_TEXT = {
  online: 'Edge node: online',
  degraded: 'Edge node: degraded',
  lost: 'Edge node: unreachable',
}
const NODE_CLS = { online: 'pill', degraded: 'pill warn', lost: 'pill down' }
const NODE_TONE = { online: 'ok', degraded: 'amb', lost: 'down' }

export default function TopBar({
  theme = 'dark', clockText, dateText, linkStatus, link, unacked,
  showBell = true, onBell, user, onSignOut,
}) {
  const status = linkStatus ?? 'lost'
  const beats = link?.cameras ?? []
  const live = beats.filter((b) => b.status !== 'lost')

  // latency ของ inference จริง (ms) — เฉลี่ยข้ามกล้องที่ยังมีชีวิต
  const lat = live.map((b) => b.latencyMs).filter((v) => v != null)
  const latText = lat.length
    ? `Inference · ${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(0)} ms`
    : 'Inference · unavailable'

  // engine ถือว่า "running" ก็ต่อเมื่อมี heartbeat สดอย่างน้อยหนึ่งตัว
  const aiRunning = live.length > 0
  const aiText = status === 'lost' && !aiRunning
    ? 'AI engine: unknown'
    : `AI engine: running (${live.length}/${beats.length || live.length})`

  const pills = {
    node: { text: NODE_TEXT[status], tone: NODE_TONE[status], cls: NODE_CLS[status] },
    ai: {
      text: aiText,
      tone: aiRunning ? 'ok' : 'down',
      cls: aiRunning ? 'pill optional' : 'pill down optional',
    },
    lan: {
      text: latText,
      tone: lat.length ? 'ok' : 'down',
      cls: lat.length ? 'pill mono optional' : 'pill mono down optional',
    },
  }
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
