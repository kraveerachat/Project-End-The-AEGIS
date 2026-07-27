import { useRef } from 'react'
import { motion } from 'framer-motion'
import { ListTree, Maximize2, ShieldCheck, WifiOff } from 'lucide-react'
import {
  bboxesFor, camShort, eventText,
  fmtDate, fmtTime, hasUnk, ini,
} from '../data.js'
import { BBox, EmptyState, FeedChrome, Ping, StaleBadge, TBox } from '../components/ui.jsx'
import LiveFeed from '../components/LiveFeed.jsx'

const SECONDARY_PRIORITY = ['CAM-01', 'CAM-05', 'CAM-04', 'CAM-06', 'CAM-02']

// ⚠️ `cameras` มาจาก GET /api/cameras — กรองผ่าน camera_assignment "ฝั่งเซิร์ฟเวอร์"
// SOC-Responder ได้ทุกกล้อง; CCTV-Operator ได้เฉพาะกล้องที่มอบหมาย
// วิวนี้ไม่กรองสิทธิ์เอง (และต้องไม่ทำ) — แค่ render ขอบเขตที่ได้รับ
export default function Live({ now, link, detections, sysEvents, cameras = [], heroCam, setHeroCam }) {
  const heroRef = useRef(null)
  const visibleIds = new Set(cameras.map((c) => c.id))
  const cam = cameras.find((c) => c.id === heroCam) ?? cameras[0] ?? null
  const lost = link.status === 'lost'
  const stale = link.status !== 'online'

  if (!cam) {
    // ยังไม่ได้กล้องจากเซิร์ฟเวอร์ (กำลังโหลด) หรือบัญชีนี้ไม่มีกล้องที่มอบหมาย
    return (
      <>
        <div className="pagehead">
          <div>
            <h1 className="h1">Live canvas</h1>
            <p className="sub">Scoped to the cameras this account is assigned server-side.</p>
          </div>
        </div>
        <EmptyState
          title="No cameras available to this account"
          hint="Camera assignment is managed in AEGIS Monitor by a SOC-Responder. Contact your administrator."
        />
      </>
    )
  }

  const secondary = SECONDARY_PRIORITY
    .filter((id) => id !== cam.id && visibleIds.has(id))
    .map((id) => cameras.find((c) => c.id === id))
    .filter((c) => c && c.online)
    .slice(0, 3)

  // เหตุการณ์ถูกจำกัดตามขอบเขตกล้องที่มองเห็น — operator ไม่เห็น event ของกล้องอื่น
  const scoped = detections.filter((d) => visibleIds.has(d.cam))

  // overlay = detection "ล่าสุดจริง" ของกล้องที่กำลังโฟกัส (ไม่มี = ไม่วาดอะไรเลย)
  // เดิมบรรทัดนี้คือ HERO_SCENES[cam.id] ซึ่งเป็นฉากที่แต่งไว้ตายตัวต่อ camera id
  const heroFrame = scoped.find((d) => d.cam === cam.id) ?? null
  const heroBoxes = bboxesFor(heroFrame)
  const subjects = heroFrame?.people?.length ?? 0
  const hasUnknownNow = Boolean(heroFrame && hasUnk(heroFrame))

  // fps จริงจาก heartbeat ของกล้องนี้ (link.cameras[] ← ตาราง camera_heartbeat)
  // ไม่มี heartbeat = ไม่มีตัวเลข = ไม่แสดง (ห้ามเดา)
  const camBeat = (link.cameras ?? []).find((h) => h.cam === cam.id)
  const fpsText = camBeat?.captureFps != null ? `${camBeat.captureFps.toFixed(1)}fps` : null

  // Latest clean authorization feeds the access-control panel.
  const grant = scoped.find((d) => !hasUnk(d))
  const grantPerson = grant?.people[0]

  const rows = [
    ...scoped.map((d) => ({
      id: d.id, at: d.at, cam: camShort(d.cam),
      dot: hasUnk(d) ? 'warn' : 'ok', text: eventText(d),
    })),
    ...sysEvents.map((e) => ({
      id: e.id, at: e.at, cam: '—',
      dot: e.tone === 'warn' ? 'warn' : 'sys', text: e.text,
    })),
  ].sort((a, b) => b.at - a.at).slice(0, 12)

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else heroRef.current?.requestFullscreen?.()
  }

  return (
    <>
      <motion.div
        className="pagehead"
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: 'easeOut' }}
      >
        <div>
          <h1 className="h1">Live canvas</h1>
          {/* ⚠️ เดิมบรรทัดนี้ประกาศว่า "AI auto-elevated CAM-02 on unknown detection"
              ทุกครั้งที่โฟกัส CAM-02 โดยอิง scene.aiFocus ที่ตั้งค่าไว้ตายตัวใน data.js
              — ไม่มีกลไก auto-elevate อยู่จริงในระบบเลย ตอนนี้บอกแค่ที่เป็นจริง */}
          <p className="sub">
            Manual focus · {cam.name}. Scoped to the cameras this account is assigned server-side.
          </p>
        </div>
      </motion.div>
      <div className="canvas">
        <motion.div
          className="canvasL"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        >
          <div className="hero" ref={heroRef}>
            {/* ⚠️ Phase B: ภาพจริงมาแทนลาย hatch แล้ว — LiveFeed วาง <img> ที่
                inset:0 กินกรอบเดียวกับ .hero เป๊ะ ๆ พิกัด % ของ BBox ด้านล่างจึง
                อ้างอิงกรอบใบเดิมไม่เปลี่ยน (ดูคอมเมนต์ .feedimg ใน index.css) */}
            <LiveFeed
              cameraId={cam.id}
              cameraName={cam.name}
              hasStream={Boolean(camBeat?.hasStream)}
              lost={lost}
            />
            <FeedChrome /><div className="scanline" /><div className="vign" />
            <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
            <div className="herotop">
              {lost ? (
                <span className="htag lost">LINK LOST</span>
              ) : hasUnknownNow ? (
                <span className="htag focus"><span className="rec" />UNKNOWN IN FRAME</span>
              ) : (
                <span className="htag manual">MANUAL FOCUS</span>
              )}
              <span className="hchip mono">{cam.id} · {cam.name}</span>
              <div className="heroright">
                {link.status === 'degraded' && <StaleBadge label="Link degraded" />}
                {/* ⚠️ เดิมตรงนี้ hardcode "REC • 1080p • 24fps" — ความละเอียดมาจากตาราง
                    cameras จริง ส่วน fps จริงมาจาก heartbeat (capture_fps) ถ้ายังไม่มี
                    heartbeat ก็ไม่แสดงตัวเลข fps ปลอม */}
                {!lost && (
                  <span className="hchip mono rec-meta">
                    {cam.res}{fpsText ? ` • ${fpsText}` : ''}
                  </span>
                )}
                <motion.button
                  type="button"
                  className="herobtn"
                  onClick={toggleFullscreen}
                  aria-label="Toggle fullscreen feed"
                  whileHover={{ scale: 1.08 }}
                  whileTap={{ scale: 0.92 }}
                >
                  <Maximize2 aria-hidden="true" />
                </motion.button>
              </div>
            </div>
            {!lost && heroBoxes.map((b, i) => <BBox key={`${b.label}-${i}`} {...b} kind={b.kind} />)}
            {/* ⚠️ เดิมประกาศชื่อรุ่นโมเดล "FACE_RECOGNITION V1.3" ที่ไม่มีอยู่จริง
                (engine ยังรัน PlaceholderRecognizer) และนับ subject จากฉากที่แต่งไว้
                ตอนนี้นับจากคนในเฟรม detection จริง และไม่เอ่ยชื่อโมเดลใด ๆ */}
            {!lost && subjects > 0 && (
              <span className="heroai mono">
                LAST DETECTION · {subjects} SUBJECT{subjects === 1 ? '' : 'S'} IN FRAME
              </span>
            )}
            <span className="herots mono">
              {lost ? `LAST FRAME ${fmtTime(link.lastFrameAt ?? now)}` : `${fmtDate(now)} ${fmtTime(now)}`}
            </span>
            {lost && (
              <div className="lostwrap" role="alert">
                <WifiOff aria-hidden="true" />
                <span className="lost-t">CONNECTION LOST</span>
                <span className="lost-s mono">Last frame {fmtTime(link.lastFrameAt ?? now)}</span>
                <span className="lost-r">Reconnecting</span>
              </div>
            )}
          </div>
          <div className="secondrow">
            {secondary.map((c, idx) => (
              <motion.button
                key={c.id}
                type="button"
                className="sfeed"
                onClick={() => setHeroCam(c.id)}
                aria-label={`Focus ${c.id} — ${c.name}`}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.1 * (idx + 1), ease: 'easeOut' }}
                whileHover={{ y: -6, boxShadow: '0 12px 30px rgba(124, 58, 237, 0.25), 0 0 18px rgba(0, 229, 255, 0.2)' }}
                whileTap={{ scale: 0.985 }}
              >
                <LiveFeed
                  cameraId={c.id}
                  cameraName={c.name}
                  hasStream={Boolean((link.cameras ?? []).find((h) => h.cam === c.id)?.hasStream)}
                  lost={lost}
                  compact
                />
                <FeedChrome />
                <span className="sfid mono">{c.id}</span>
                {lost
                  ? <span className="sflive warn">STALE</span>
                  : <span className="sflive"><span className="rec" />LIVE</span>}
                <span className="sfloc">{c.name}</span>
                {/* กล่องบน tile มาจาก detection ล่าสุดจริงของกล้องตัวนั้น (เดิมเป็น
                    TILE_BOXES ที่ตั้งไว้ตายตัว) — ไม่มี detection = ไม่มีกล่อง */}
                {!lost && bboxesFor(scoped.find((d) => d.cam === c.id)).map((b, i) => (
                  <TBox key={i} kind={b.kind} top={b.top} left={b.left} width={b.width} height={b.height} />
                ))}
              </motion.button>
            ))}
          </div>
        </motion.div>
        <motion.div
          className="canvasR"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15, ease: 'easeOut' }}
        >
          <section className={stale ? 'panel glass acpanel isstale' : 'panel glass acpanel'}>
            <div className="acglow" />
            <div className="ptitle" style={{ justifyContent: 'space-between' }}>
              <span className="fx ac gap9">
                <ShieldCheck aria-hidden="true" />
                Access control · result
              </span>
              {stale ? <StaleBadge red={lost} label="Stale" /> : <span className="acdot" />}
            </div>
            {grantPerson ? (
              <div key={grant.id}>
                <div className="acbig"><span className="accheck" aria-hidden="true">✓</span> Access authorized</div>
                <div className="acid">
                  <div className="acav" aria-hidden="true">{ini(grantPerson.name)}</div>
                  <div>
                    <div className="acname">{grantPerson.name}</div>
                    <div className="acrole">Authorized · Staff</div>
                  </div>
                </div>
                <div className="acstats">
                  <div className="acstat">
                    <div className="acslab">Camera</div>
                    <div className="acsval mono">{grant.cam}</div>
                  </div>
                  <div className="acstat">
                    <div className="acslab">Match score</div>
                    <div className="acsval mono teal">{grantPerson.conf}%</div>
                  </div>
                </div>
              </div>
            ) : (
              <p className="sub" style={{ margin: 0 }}>No authorization events yet this session.</p>
            )}
          </section>
          <section className="panel glass streampanel">
            <div className="ptitle" style={{ justifyContent: 'space-between' }}>
              <span className="fx ac gap9">
                <ListTree aria-hidden="true" />
                Event stream
              </span>
              {lost && <StaleBadge red label="Frozen" />}
            </div>
            <div className="streamlist">
              {rows.map((r, i) => (
                <motion.div
                  key={r.id}
                  className={i === 0 ? 'srow newflag' : 'srow'}
                  whileHover={{ x: 4, backgroundColor: 'rgba(255, 255, 255, 0.07)' }}
                  transition={{ duration: 0.15 }}
                >
                  <span className="sts mono">{fmtTime(r.at)}</span>
                  <span className={`sdot ${r.dot}`} aria-hidden="true" />
                  <span className="scam mono">{r.cam}</span>
                  <span className="stext">{r.text}</span>
                </motion.div>
              ))}
            </div>
          </section>
        </motion.div>
      </div>
    </>
  )
}
