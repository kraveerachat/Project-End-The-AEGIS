import { motion } from 'framer-motion'
import { Activity, HardDriveDownload, HeartPulse } from 'lucide-react'
import { fmtDur, fmtTime } from '../data.js'
import { EmptyState, Ping } from '../components/ui.jsx'

// Camera diagnostics — จอสุขภาพกล้องของ Scoped View (สเปกของ CCTV-Operator)
// ⚠️ `cameras` มาจาก GET /api/cameras — กรองผ่าน camera_assignment ฝั่งเซิร์ฟเวอร์แล้ว
//
// ⚠️ เขียนใหม่ 2026-07-27: จอนี้เคยเป็น "ของปลอมทั้งจอ" — LAT_SERIES คืออาร์เรย์
//    latency 12 ค่าที่พิมพ์ไว้ตายตัวสามชุด, heartbeat เขียนว่า '2s ago' เสมอ,
//    uptime '99.2%' เสมอ, '24fps' เสมอ, และ health check ทั้งห้าข้อคำนวณจาก
//    link.status ตัวเดียว (ซึ่งตัวมันเองก็ปลอม) ไม่มีการวัดอะไรเลยสักค่า
//    ตอนนี้ทุกค่ามาจาก camera_heartbeat จริงผ่าน /api/link (link.cameras[])
//
// ⚠️ ค่าที่ยัง "วัดไม่ได้จริง" จะแสดงคำว่า unavailable ไม่ใช่ตัวเลขที่ดูสมเหตุสมผล:
//    - uptime % / disconnects 24h → ต้องมี time-series ของ heartbeat ซึ่ง schema
//      ปัจจุบันเก็บแค่แถวล่าสุดต่อกล้อง (UPSERT) จึงยังไม่มีประวัติให้คำนวณ
//    - latency sparkline → เหตุผลเดียวกัน; แสดงค่าปัจจุบัน + ค่าเฉลี่ยสะสมแทน

/** ค่าที่ไม่มีจริง — แสดงเป็นคำ ไม่ใช่ตัวเลขที่แต่งขึ้น */
function Unavailable({ why }) {
  return <span className="kv-val mono" style={{ opacity: 0.55 }} title={why}>unavailable</span>
}

const fmtAge = (ms) => {
  if (ms == null) return null
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

export default function Diagnostics({ now, link, cameras = [] }) {
  const beats = link?.cameras ?? []
  const beatFor = (id) => beats.find((b) => b.cam === id) ?? null

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
          {cameras.map((cam, i) => {
            const b = beatFor(cam.id)
            // ไม่มีแถว heartbeat เลย = Detection Engine ของกล้องนี้ไม่เคยติดต่อมา
            const st = b?.status ?? 'lost'
            const tone = st === 'online' ? 'ok' : st === 'degraded' ? 'amb' : 'down'
            const label = !b ? 'No engine' : st === 'online' ? 'Operational' : st === 'degraded' ? 'Degraded' : 'Offline'
            const checks = [
              { name: 'Heartbeat received from edge node', ok: b != null && st !== 'lost',
                detail: b ? fmtAge(b.ageMs) : 'never' },
              { name: 'Camera opened by engine', ok: Boolean(b?.cameraConnected),
                detail: b ? (b.cameraConnected ? 'open' : 'cannot open device') : 'unknown' },
              { name: 'Frames captured', ok: (b?.framesCaptured ?? 0) > 0,
                detail: b?.framesCaptured != null ? `${b.framesCaptured}` : 'unknown' },
              { name: 'NAS clip sync', ok: b?.nasLastStatus === 'ok',
                detail: b?.nasLastStatus ?? 'unknown' },
            ]
            return (
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

              {!b && (
                <p className="sub" style={{ margin: '0 0 10px' }}>
                  No Detection Engine has ever reported for this camera. Every field below
                  is unavailable — nothing is being measured.
                </p>
              )}

              <div className="info-kv-grid">
                <div className="info-kv-item">
                  <span className="kv-label">Last heartbeat</span>
                  {b ? <span className="kv-val mono">{fmtAge(b.ageMs)}</span>
                     : <Unavailable why="no heartbeat row for this camera" />}
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">Inference latency (now · avg)</span>
                  {b?.latencyMs != null
                    ? <span className="kv-val mono">{b.latencyMs.toFixed(1)} ms · {b.latencyMsAvg?.toFixed(1) ?? '—'} ms</span>
                    : <Unavailable why="engine has not reported latency" />}
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">Stream (capture · detect)</span>
                  {b?.captureFps != null
                    ? <span className="kv-val mono">{cam.res} · {b.captureFps.toFixed(1)}fps · {b.detectFps?.toFixed(1) ?? '—'}fps</span>
                    : <span className="kv-val mono">{cam.res} · <span style={{ opacity: 0.55 }}>fps unavailable</span></span>}
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">Uptime · disconnects (24h)</span>
                  {/* ⚠️ ไม่มีประวัติ heartbeat (เก็บแค่แถวล่าสุดต่อกล้อง) จึงคำนวณไม่ได้จริง
                      เดิมตรงนี้แสดง "99.2% · 0" ตายตัว — ตัวเลขที่ไม่มีที่มา */}
                  <Unavailable why="no heartbeat history is stored yet — camera_heartbeat keeps only the latest row per camera" />
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">Engine uptime · reconnects</span>
                  {b?.uptimeS != null
                    ? <span className="kv-val mono">{fmtDur(Math.round(b.uptimeS))} · {b.cameraReconnects}</span>
                    : <Unavailable why="engine has not reported uptime" />}
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">NAS clip sync</span>
                  {b?.nasLastStatus
                    ? (
                      <span className={`kv-val status-tag mono ${b.nasLastStatus === 'ok' ? 'online' : ''}`}>
                        <HardDriveDownload aria-hidden="true" style={{ width: 13, height: 13 }} />
                        {b.nasLastStatus}{b.nasPending ? ` · ${b.nasPending} pending` : ''}
                      </span>
                    )
                    : <Unavailable why="engine has not reported a NAS transfer yet" />}
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">Segments written</span>
                  {b?.segmentsWritten != null
                    ? <span className="kv-val mono">{b.segmentsWritten}</span>
                    : <Unavailable why="engine has not reported segment count" />}
                </div>
                <div className="info-kv-item">
                  <span className="kv-label">Edge node</span>
                  {b?.nodeId
                    ? <span className="kv-val mono">{b.nodeId}</span>
                    : <Unavailable why="engine has not identified itself" />}
                </div>
              </div>

              {/* ⚠️ sparkline "Latency — last 12 samples" ถูกถอดออก: มันวาดจากอาร์เรย์
                  ค่าคงที่ 12 ตัวใน LAT_SERIES ไม่ใช่ตัวอย่างที่วัดได้ ต้องมี time-series
                  ของ heartbeat ก่อนถึงจะวาดกราฟจริงได้ */}
              <div className="ptitle" style={{ marginTop: 14 }}>
                <Activity aria-hidden="true" /> Health checks
              </div>
              <div className="clipdetail" style={{ marginTop: 4 }}>
                {checks.map((c) => (
                  <div key={c.name} className={c.ok ? 'mkrow' : 'mkrow warn'}>
                    <span className="mkdot" />
                    <span className="mono">{b ? fmtTime(b.lastSeenAt) : fmtTime(now)}</span>
                    <span>{c.name}</span>
                    <span className="mono" style={{ opacity: 0.7, marginLeft: 8 }}>{c.detail}</span>
                    <span className="mono" style={{ marginLeft: 'auto', color: c.ok ? 'var(--teal)' : 'var(--red)' }}>
                      {c.ok ? 'Pass' : 'Fail'}
                    </span>
                  </div>
                ))}
              </div>
            </motion.section>
            )
          })}
        </div>
      )}
    </>
  )
}
