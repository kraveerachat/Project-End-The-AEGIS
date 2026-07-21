// src/engine.js — AEGIS Monitor (IDEA2)
//
// ⚠️ Phase 2: ตัวจำลอง heartbeat/detection ที่เคยอยู่ในไฟล์นี้ถูก "ถอนทิ้งทั้งหมด" —
// console อ่านข้อมูลจริงจาก API ของตัวเอง (ซึ่ง production อ่านจากฐานข้อมูลที่
// Detection Engine เขียน; dev fallback มีตัวแทน engine อยู่ฝั่งเซิร์ฟเวอร์):
//   - /api/link        heartbeat status (poll 5s)  → online | degraded | lost
//   - /api/detections  เฟรม recognition (poll 5s)  — กรองตาม camera_assignment แล้ว
//   - /api/alerts      (poll 10s — เฉพาะ role ที่มีวิว alerts)
// hook นี้คงสัญญาเดิมของ useMonitorEngine ไว้ให้วิวต่าง ๆ ใช้ต่อได้ทันที
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from './lib/api.js'
import { useApi } from './lib/hooks.js'

export function useMonitorEngine({ enabled = false, hasAlerts = false } = {}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const linkApi = useApi(enabled ? '/api/link' : null, { refreshMs: 5_000 })
  const detApi = useApi(enabled ? '/api/detections' : null, { refreshMs: 5_000 })
  const alertsApi = useApi(enabled && hasAlerts ? '/api/alerts' : null, { refreshMs: 10_000 })

  // link ยังไม่ตอบ = ถือว่า lost (จอแสดงสถานะจริงของการเชื่อมต่อ ไม่แสร้งว่า online)
  const link = linkApi.data ?? { status: linkApi.loading ? 'online' : 'lost', lastFrameAt: null }

  // sysEvents — บันทึกการเปลี่ยนสถานะ link ฝั่ง client (ข้อความ presentational ล้วน)
  const [sysEvents, setSysEvents] = useState([])
  const prevStatus = useRef('online')
  useEffect(() => {
    const s = link.status
    if (s === prevStatus.current) return
    const prev = prevStatus.current
    prevStatus.current = s
    const push = (text, tone) =>
      setSysEvents((es) => [{ id: `sys-${Date.now()}`, at: Date.now(), text, tone }, ...es].slice(0, 10))
    if (s === 'lost') push('Edge link lost — display is stale', 'warn')
    if (s === 'online' && prev !== 'online') push('Edge link restored — live stream resumed', 'ok')
  }, [link.status])

  const ackAlert = useCallback(async (id) => {
    // Acknowledge = การเขียนเดียวของ console — ยิงจริงแล้ว refetch
    await apiFetch(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: 'POST' })
    alertsApi.retry()
  }, [alertsApi])

  // demo control (ปุ่ม L): จำลอง link ล่มฝั่งเซิร์ฟเวอร์ — แทนการดึงสาย LAN จริง
  const toggleOutage = useCallback(async () => {
    await apiFetch('/api/link/outage', { method: 'POST' })
    linkApi.retry()
  }, [linkApi])

  return {
    now,
    link,
    linkApi,
    detections: detApi.data?.detections ?? [],
    detApi,
    alerts: alertsApi.data?.alerts ?? [],
    alertsApi,
    sysEvents,
    ackAlert,
    toggleOutage,
  }
}
