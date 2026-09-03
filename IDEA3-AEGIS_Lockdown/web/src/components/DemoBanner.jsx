import React from 'react'
import { FlaskConical } from 'lucide-react'

export function DemoBanner({ mode }) {
  if (mode !== 'DEMO') return null
  return (
    <div className="demo-banner" role="status">
      <FlaskConical size={17} aria-hidden="true" />
      <strong>DEMO</strong>
      <span>ข้อมูลจำลองเพื่อสาธิต UI — ไม่ใช่สถานะระบบจริง</span>
    </div>
  )
}
