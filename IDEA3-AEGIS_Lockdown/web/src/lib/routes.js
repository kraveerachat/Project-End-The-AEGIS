import {
  Activity, Bell, Boxes, ChartNoAxesCombined, ClipboardList, Gauge, LifeBuoy,
  Network, Radar, Settings, ShieldCheck,
} from 'lucide-react'

export const APP_ROUTES = Object.freeze([
  { id: 'dashboard', label: 'แดชบอร์ด', eyebrow: 'Workspace', group: 'พื้นที่ทำงาน', icon: Gauge },
  { id: 'overview', label: 'ภาพรวมระบบ', eyebrow: 'Workspace', group: 'พื้นที่ทำงาน', icon: ChartNoAxesCombined },
  { id: 'idea1', label: 'IDEA1 Security', eyebrow: 'Evidence', group: 'หลักฐาน', icon: ShieldCheck },
  { id: 'idea2', label: 'IDEA2 Detection', eyebrow: 'Evidence', group: 'หลักฐาน', icon: Radar },
  { id: 'lockdown', label: 'IDEA3 Lockdown', eyebrow: 'Evidence', group: 'หลักฐาน', icon: Network },
  { id: 'alerts', label: 'การแจ้งเตือน', eyebrow: 'Response', group: 'การตอบสนอง', icon: Bell },
  { id: 'incidents', label: 'เหตุการณ์', eyebrow: 'Response', group: 'การตอบสนอง', icon: Activity },
  { id: 'audit', label: 'บันทึกตรวจสอบ', eyebrow: 'Response', group: 'การตอบสนอง', icon: ClipboardList },
  { id: 'devices', label: 'อุปกรณ์', eyebrow: 'System', group: 'ระบบ', icon: Boxes },
  { id: 'recovery', label: 'การกู้คืน', eyebrow: 'System', group: 'ระบบ', icon: LifeBuoy },
  { id: 'settings', label: 'ตั้งค่า', eyebrow: 'System', group: 'ระบบ', icon: Settings },
])

export function routeFromPath(pathname = window.location.pathname) {
  const candidate = pathname.replace(/^\/security\/?/, '').split('/')[0]
  return APP_ROUTES.some((route) => route.id === candidate) ? candidate : 'dashboard'
}

export function routeById(id) {
  return APP_ROUTES.find((route) => route.id === id) ?? APP_ROUTES[0]
}
