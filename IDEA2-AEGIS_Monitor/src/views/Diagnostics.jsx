import { motion } from 'framer-motion'
import { Activity, HardDriveDownload, HeartPulse } from 'lucide-react'
import { fmtTime } from '../data.js'
import { EmptyState, Ping } from '../components/ui.jsx'

// Camera diagnostics — จอสุขภาพกล้องของ Scoped View (สเปกของ CCTV-Operator)
// ⚠️ `cameras` มาจาก GET /api/cameras — กรองผ่าน camera_assignment ฝั่งเซิร์ฟเวอร์แล้ว
// ค่าทางไกล (latency/fps/uptime) มาจาก Edge link ปัจจุบัน; Phase ถัดไปตัวเลขเหล่านี้
// จะมาจาก API ของ Detection Engine — โครง UI คงเดิม
const LAT_SERIES = {
  operational: [5, 6, 4, 5, 7, 4, 5, 4, 6, 4, 3, 4],
  degraded: [4, 5, 6, 5, 8, 7, 11, 9, 13, 10, 14, 12],
  offline: [4, 5, 4, 6, 5, 7, 9, 14, 22, 40, 60, 80],
}

function sparkOf(series) {
  const W = 300; const H = 66; const pad = 8
  const min = Math.min(...series); const max = Math.max(...series)
  const span = (max - min) || 1
  const pts = series.map((v, i) => {
    const x = (i / (series.length - 1)) * W
    const y = H - pad - ((v - min) / span) * (H - pad * 2)
    return [x, y]
  })
  return {
    points: pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' '),
    cx: pts[pts.length - 1][0].toFixed(1),
    cy: pts[pts.length - 1][1].toFixed(1),
  }
}

export default function Diagnostics({ now, link, cameras = [] }) {
  const health = link.status === 'online' ? 'operational' : link.status === 'degraded' ? 'degraded' : 'offline'
  const series = LAT_SERIES[health]
  const sp = sparkOf(series)
  const latencyNow = health === 'offline' ? '—' : `${series[series.length - 1]} ms`
  const heartbeat = health === 'offline' ? 'no signal' : '2s ago'
  const tone = health === 'operational' ? 'ok' : health === 'degraded' ? 'amb' : 'down'
  const label = health === 'operational' ? 'Operational' : health === 'degraded' ? 'Degraded' : 'Offline'

  const checks = [
    { name: 'Heartbeat received', ok: health !== 'offline' },
    { name: 'Frame received from sensor', ok: health !== 'offline' },
    { name: 'NAS clip sync', ok: health !== 'offline' },
    { name: 'Recognition engine reachable', ok: health === 'operational' },
    { name: 'Edge AI node link', ok: health !== 'offline' },
  ]

  return (
    <>
      <div className="pagehead">
        <div>
          <h1 className="h1">Camera diagnostics</h1>
          <p className="sub">
            Health of your assigned cameras. If one degrades or goes offline, the responsible operator is alerted.
          </p>
        </div>
      </div>

      {cameras.length === 0 ? (
        <EmptyState
          title="No cameras available to this account"
          hint="Camera assignment is managed in AEGIS Monitor by a SOC-Responder. Contact your administrator."
        />
      ) : (
        <div className="settings-grid">
          {cameras.map((cam, i) => (
            <motion.section
              key={cam.id}
              className="panel glass set-card"
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.06 * i, ease: [0.16, 1, 0.3, 1] }}
            >
              <div className="set-card-header">
                <HeartPulse aria-hidden="true" className="w-5 h-5 shrink-0" />
                <h2 className="set-card-title mono">{cam.id} · {cam.name}</h2>
                <span className={`pill mono ${tone === 'ok' ? '' : tone === 'amb' ? 'warn' : 'down'}`} style={{ marginLeft: 'auto' }}>
                  <Ping tone={tone} />{label}
                </span>
              </div>

              <div className="info-kv-grid">
                <div className="info-kv-item">
                  <span className="kv-label">Last heartbeat</span>
                  <span className="kv-val mono">{heartbeat}</span>
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">Latency (now)</span>
                  <span className="kv-val mono">{latencyNow}</span>
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">Stream</span>
                  <span className="kv-val mono">{cam.res} · 24fps</span>
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">Uptime · disconnects (24h)</span>
                  <span className="kv-val mono">{health === 'offline' ? '—' : '99.2%'} · {health === 'operational' ? 0 : 1}</span>
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">NAS clip sync</span>
                  <span className={`kv-val status-tag mono ${health === 'offline' ? '' : 'online'}`}>
                    <HardDriveDownload aria-hidden="true" style={{ width: 13, height: 13 }} />
                    {health === 'offline' ? 'Paused — link down' : 'Synced'}
                  </span>
                </div>
              </div>

              <div className="ptitle" style={{ marginTop: 14 }}>
                <Activity aria-hidden="true" /> Latency — last 12 samples
              </div>
              <svg viewBox="0 0 300 66" className="w-full" role="img" aria-label={`Latency trend — ${label}`} style={{ display: 'block' }}>
                <polyline
                  points={sp.points}
                  fill="none"
                  stroke={tone === 'ok' ? 'var(--teal)' : tone === 'amb' ? 'var(--amber)' : 'var(--red)'}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <circle cx={sp.cx} cy={sp.cy} r="3.2" fill={tone === 'ok' ? 'var(--teal)' : tone === 'amb' ? 'var(--amber)' : 'var(--red)'} />
              </svg>

              <div className="clipdetail" style={{ marginTop: 12 }}>
                {checks.map((c) => (
                  <div key={c.name} className={c.ok ? 'mkrow' : 'mkrow warn'}>
                    <span className="mkdot" />
                    <span className="mono">{fmtTime(now)}</span>
                    <span>{c.name}</span>
                    <span className="mono" style={{ marginLeft: 'auto', color: c.ok ? 'var(--teal)' : 'var(--red)' }}>
                      {c.ok ? 'Pass' : 'Fail'}
                    </span>
                  </div>
                ))}
              </div>
            </motion.section>
          ))}
        </div>
      )}
    </>
  )
}
