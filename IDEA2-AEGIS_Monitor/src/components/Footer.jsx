import { Ping } from './ui.jsx'

const FOOT_TEXT = {
  online: { tone: 'ok', text: 'Edge AI node · online' },
  degraded: { tone: 'amb', text: 'Edge AI node · degraded link' },
  lost: { tone: 'down', text: 'Edge AI node · unreachable' },
}

// ⚠️ เดิม APP_VERSION ประกาศแยกไว้ตายตัวเป็น 'v3.0-spatial' ที่นี่ — คนละค่ากับ
// __APP_VERSION__ ที่ Settings.jsx ใช้จริง (มาจาก vite `define` ตอน build) ทำให้
// สองที่บอกเวอร์ชันแอปไม่ตรงกัน ตอนนี้ใช้ค่าเดียวกันทั้งแอป
const APP_VERSION = __APP_VERSION__

export default function Footer({ link }) {
  const status = link?.status ?? 'lost'
  const f = FOOT_TEXT[status] ?? FOOT_TEXT.lost

  // ⚠️ เดิม "192.168.1.42 · LAN" hardcode ไว้ตายตัว ไม่มีอะไรวัดจริงเบื้องหลังเลย
  // (ต่าง IP ก็ยังขึ้นค่าเดิมทุกครั้ง) ตอนนี้ใช้ node_id จริงจาก heartbeat ที่สดที่สุด
  // (Detection Engine รายงานผ่าน AEGIS_NODE_ID — ดู aegis_scanner.py) ถ้ายังไม่เคย
  // มี heartbeat เข้ามาเลย บอกตรง ๆ ว่ายังไม่มีโหนดรายงาน แทนการโชว์ IP ที่แต่งขึ้น
  const beats = link?.cameras ?? []
  const freshest = beats.reduce(
    (best, b) => (best == null || b.lastSeenAt > best.lastSeenAt ? b : best),
    null,
  )
  const nodeText = freshest?.nodeId ? `${freshest.nodeId} · LAN` : 'No edge node reporting'

  return (
    <footer className="foot">
      <Ping tone={f.tone} />
      <span className={status === 'lost' ? 'down-t' : undefined}>{f.text}</span>
      <span className="mono">{nodeText}</span>
      <span className="footv mono">v{APP_VERSION}</span>
    </footer>
  )
}