// src/nav.js — AEGIS Monitor (IDEA2)
// ⚠️ รายการเมนูไม่ได้ประกาศที่นี่อีกต่อไป — เซิร์ฟเวอร์เป็นผู้ส่ง "เมนูที่ role นี้
// เปิดได้" มากับ /api/login และ /api/me (server/rbac/permissions.js)
// ไฟล์นี้เหลือแค่ "พจนานุกรมแสดงผล": id → icon / label / กลุ่ม
// client จึง render ได้เฉพาะสิ่งที่ได้รับ — วิวที่ไม่มีสิทธิ์ไม่มีวันอยู่ใน DOM
// (CCTV-Operator เปิด page source แล้วต้องไม่พบสตริง "Detection stream" / "Alerts")
import {
  Activity, Archive, Cctv, LayoutGrid, ListVideo, Settings, ShieldAlert,
} from 'lucide-react'

const DISPLAY = {
  live:        { label: 'Live canvas',       icon: Cctv },
  archive:     { label: 'Archival footage',  icon: Archive },
  detection:   { label: 'Detection stream',  icon: ListVideo },
  alerts:      { label: 'Alerts',            icon: ShieldAlert, badge: true },
  nodes:       { label: 'Nodes & routing',   icon: LayoutGrid },
  diagnostics: { label: 'Camera diagnostics', icon: Activity },
  settings:    { label: 'Settings',          icon: Settings },
}

const GROUP_LABELS = {
  navObservation: 'Observation',
  navAnalytics: 'Analytics & events',
  navInfra: 'Infrastructure & config',
  navPrefs: 'Preferences',
}

/**
 * แปลงเมนูจากเซิร์ฟเวอร์ ([{ id, labelKey, group }]) เป็น sections สำหรับ Sidebar
 * รายการที่ client ไม่รู้จัก (id แปลก) ถูกทิ้ง — ไม่เดา ไม่ประดิษฐ์เมนูเอง
 */
export function buildSections(menu) {
  const sections = []
  for (const item of menu ?? []) {
    const d = DISPLAY[item.id]
    if (!d) continue
    const label = GROUP_LABELS[item.group] ?? item.group
    let sec = sections.find((s) => s.label === label)
    if (!sec) {
      sec = { label, items: [] }
      sections.push(sec)
    }
    sec.items.push({ id: item.id, label: d.label, icon: d.icon, badge: d.badge })
  }
  return sections
}

/** ลำดับวิวสำหรับคีย์ลัด 1..N — ตามเมนูที่เซิร์ฟเวอร์ส่งมาเท่านั้น */
export function viewOrderOf(menu) {
  return (menu ?? []).map((m) => m.id).filter((id) => DISPLAY[id])
}
