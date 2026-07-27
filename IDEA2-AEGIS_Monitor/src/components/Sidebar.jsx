import { motion } from 'framer-motion'

// ⚠️ Sidebar ไม่รู้จัก "รายการเมนูทั้งหมด" อีกต่อไป — รับ sections ที่สร้างจาก
// เมนูของเซิร์ฟเวอร์ (ผ่าน buildSections) แล้ว render เท่าที่ได้รับเท่านั้น
// วิวที่ role ไม่มีสิทธิ์ไม่เคยมาถึง component นี้ จึงไม่มีวันอยู่ใน DOM
// canLinkTest = role นี้ยิง POST /api/link/outage ได้ไหม (SOC-Responder เท่านั้น)
// — ใช้ตัดสินแค่ว่าจะ "โฆษณา" คีย์ลัด L หรือไม่ ตัวควบคุมจริงคือ requireRole ฝั่งเซิร์ฟเวอร์
export default function Sidebar({ sections, view, setView, unacked, viewCount = 0, canLinkTest = false }) {
  return (
    <nav className="side glass" aria-label="Console sections">
      {sections.map((sec) => (
        <div key={sec.label} style={{ display: 'contents' }}>
          <div className="navsec">{sec.label}</div>
          {sec.items.map((item) => {
            const Icon = item.icon
            const on = view === item.id
            return (
              <motion.button
                key={item.id}
                type="button"
                className={on ? 'nav on' : 'nav'}
                aria-current={on ? 'page' : undefined}
                onClick={() => setView(item.id)}
                whileHover={{ scale: 1.02, x: 3 }}
                whileTap={{ scale: 0.96 }}
                transition={{ duration: 0.15 }}
              >
                <Icon aria-hidden="true" />
                {item.label}
                {item.badge && unacked > 0 && (
                  <span className="unread" aria-label={`${unacked} unacknowledged`}>{unacked}</span>
                )}
              </motion.button>
            )
          })}
        </div>
      ))}
      <div className="sidefoot">
        AEGIS Monitor · standalone edge deployment. Operators and camera assignments are managed within this app.
        <div className="kbdrow" aria-hidden="true">
          <kbd>1</kbd>–<kbd>{viewCount || 1}</kbd> views
          {canLinkTest && <> · <kbd>L</kbd> link test</>}
        </div>
      </div>
    </nav>
  )
}

export function MobileNav({ sections, view, setView, unacked }) {
  return (
    <nav className="mobilenav" aria-label="Console sections">
      {sections.flatMap((s) => s.items).map((item) => {
        const Icon = item.icon
        const on = view === item.id
        return (
          <motion.button
            key={item.id}
            type="button"
            className={on ? 'mnavbtn on' : 'mnavbtn'}
            aria-current={on ? 'page' : undefined}
            onClick={() => setView(item.id)}
            whileHover={{ scale: 1.04 }}
            whileTap={{ scale: 0.95 }}
          >
            <Icon aria-hidden="true" />
            {item.label}
            {item.badge && unacked > 0 && (
              <span className="unread" aria-label={`${unacked} unacknowledged`}>{unacked}</span>
            )}
          </motion.button>
        )
      })}
    </nav>
  )
}
