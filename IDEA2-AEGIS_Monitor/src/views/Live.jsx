import { useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ListTree, Maximize2, ShieldCheck, WifiOff } from 'lucide-react'
import {
  bboxesFor, eventText,
  fmtDate, fmtTime, hasUnk, ini,
} from '../data.js'
import { BBox, EmptyState, FeedChrome, StaleBadge } from '../components/ui.jsx'
import LiveFeed from '../components/LiveFeed.jsx'
import CameraSelector from '../components/CameraSelector.jsx'
import { selectedCamera, cameraDetections, cameraHeartbeat } from '../lib/liveCamera.js'

// ⚠️ `cameras` มาจาก GET /api/cameras — กรองผ่าน camera_assignment "ฝั่งเซิร์ฟเวอร์"
// SOC-Responder ได้ทุกกล้อง; CCTV-Operator ได้เฉพาะกล้องที่มอบหมาย
// วิวนี้ไม่กรองสิทธิ์เอง (และต้องไม่ทำ) — แค่ render ขอบเขตที่ได้รับ
export default function Live({ now, link, detections, cameras, heroCam, setHeroCam }) {
  const heroRef = useRef(null)
  const [feedStatus, setFeedStatus] = useState(null)

  if (cameras === null) {
    return (
      <div className="pagehead">
        <div>
          <h1 className="h1">Live canvas</h1>
          <p className="sub">Connecting to AEGIS Monitor feed server...</p>
        </div>
      </div>
    )
  }

  const cam = selectedCamera(cameras, heroCam)
  const camBeat = cameraHeartbeat(link, cam?.id)
  const lost = !camBeat?.hasStream
  const stale = lost || camBeat?.status !== 'online'

  if (!cam) {
    // บัญชีนี้ไม่มีกล้องที่มอบหมาย
    return (
      <>
        <div className="pagehead">
          <div>
            <h1 className="h1">Live canvas</h1>
            <p className="sub">Scoped to the cameras this account is assigned server-side.</p>
          </div>
        </div>
        <EmptyState
          title="No cameras assigned"
          hint="Contact an administrator to assign a camera."
        />
      </>
    )
  }

  // All camera-context panels derive from the same authorized selection.
  const scoped = cameraDetections(detections, cam.id)

  // overlay = detection "ล่าสุดจริง" ของกล้องที่กำลังโฟกัส (ไม่มี = ไม่วาดอะไรเลย)
  // เดิมบรรทัดนี้คือ HERO_SCENES[cam.id] ซึ่งเป็นฉากที่แต่งไว้ตายตัวต่อ camera id
  const heroFrame = scoped[0] ?? null
  const heroBoxes = bboxesFor(heroFrame)
  const subjects = heroFrame?.people?.length ?? 0
  const hasUnknownNow = Boolean(heroFrame && hasUnk(heroFrame))

  // fps จริงจาก heartbeat ของกล้องนี้ (link.cameras[] ← ตาราง camera_heartbeat)
  // ไม่มี heartbeat = ไม่มีตัวเลข = ไม่แสดง (ห้ามเดา)
  const fpsText = camBeat?.captureFps != null ? `${camBeat.captureFps.toFixed(1)}fps` : null

  // Never substitute a clean result from another camera or an older detection.
  const grant = heroFrame && !hasUnk(heroFrame) ? heroFrame : null
  const grantPerson = grant?.people?.[0]

  const rows = [
    ...scoped.map((d) => ({
      id: d.id, at: d.at,
      dot: hasUnk(d) ? 'warn' : 'ok', text: eventText(d),
    })),
  ].sort((a, b) => b.at - a.at).slice(0, 12)

  const toggleFullscreen = () => {
    if (document.fullscreenElement) document.exitFullscreen()
    else heroRef.current?.requestFullscreen?.()
  }

  return (
    <>
      {/* ⚠️ .pagehead เดิมเป็น motion.div ที่ fade+slide ทุกครั้งที่ mount วิวนี้ —
          นั่นคือ "page-load choreography" (การไล่โผล่ทีละส่วนตอนเปิดหน้า) ที่ brief
          บอกห้ามทำโดยตรง เพราะทำให้ operator รอภาพนิ่งช้าลงทุกครั้งที่สลับมาหน้านี้
          ตัดออกเหลือ static header — ข้อมูลสำคัญ (สถานะกล้อง) ต้องขึ้นทันที ไม่รอ 400ms */}
      <div className="pagehead">
        <div>
          <h1 className="h1">Live canvas</h1>
          {/* ⚠️ เดิมบรรทัดนี้ประกาศว่า "AI auto-elevated CAM-02 on unknown detection"
              ทุกครั้งที่โฟกัส CAM-02 โดยอิง scene.aiFocus ที่ตั้งค่าไว้ตายตัวใน data.js
              — ไม่มีกลไก auto-elevate อยู่จริงในระบบเลย ตอนนี้บอกแค่ที่เป็นจริง */}
          <p className="sub">
            Manual focus · {cam.name}. Scoped to the cameras this account is assigned server-side.
          </p>
        </div>
      </div>
      <div className="canvas">
        <div className="canvasL">
          <motion.div
            // ⚠️ key={cam.id} บังคับ remount ทุกครั้งที่สลับกล้อง (คลิก tile หรือ
            // ตอน hero เปลี่ยน) — initial/animate ตอนนี้ "ต่างค่ากันจริง" (0 → 1)
            // จึงเป็น fade transition ของจริงตอนสลับกล้อง ไม่ใช่ no-op เหมือนเดิม
            // (เดิม initial/animate ทั้งคู่เป็น opacity:1 = ไม่มีอะไรเกิดขึ้นเลย)
            // 200ms อยู่ในกรอบ 150–250ms ตามที่ brief กำหนด และเร็วพอไม่ทำให้
            // operator รู้สึกหน่วงตอนไล่ดูหลายกล้องต่อกัน
            key={cam.id}
            className={`hero${lost ? ' hero--lost' : ''}`}
            ref={heroRef}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
          >
            {/* ⚠️ Phase B: ภาพจริงมาแทนลาย hatch แล้ว — LiveFeed วางภาพที่
                inset:0 กินกรอบเดียวกับ .hero เป๊ะ ๆ พิกัด % ของ BBox ด้านล่างจึง
                อ้างอิงกรอบใบเดิมไม่เปลี่ยน (ดูคอมเมนต์ .feedimg ใน index.css) */}
            <LiveFeed
              cameraId={cam.id}
              cameraName={cam.name}
              hasStream={Boolean(camBeat?.hasStream)}
              lost={lost}
              hideStatus={lost}
              onStateChange={setFeedStatus}
            />
            <FeedChrome /><div className="scanline" /><div className="vign" />
            <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
            <div className="herotop absolute top-4 left-4 flex items-center gap-2 z-10">
              {lost ? (
                <span className="htag lost bg-rose-950/90 border border-rose-500/50 text-rose-300 px-2 py-1 rounded font-mono text-xs font-bold">LINK LOST</span>
              ) : hasUnknownNow ? (
                <span className="htag focus"><span className="rec" />UNKNOWN IN FRAME</span>
              ) : (
                <span className="htag manual">MANUAL FOCUS</span>
              )}
              <span className="hchip mono text-white font-mono text-xs font-semibold bg-black/40 px-2 py-1 rounded backdrop-blur-sm">{cam.id} · {cam.name}</span>
            </div>
            <div className="heroright absolute top-4 right-4 flex items-center gap-2 z-10">
                {camBeat?.status === 'degraded' && <StaleBadge label="Link degraded" />}
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
                  transition={{ duration: 0.15 }}
                >
                  <Maximize2 aria-hidden="true" />
                </motion.button>
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
              {!lost && `${fmtDate(now)} ${fmtTime(now)}`}
            </span>
            {lost && (
              <div className="lostwrap flex flex-col items-center justify-center gap-3" role="alert">
                <WifiOff aria-hidden="true" />
                <span className="lost-t text-rose-500 font-bold tracking-widest text-lg">Camera offline</span>
                <span className="lost-state text-slate-300">NO LIVE STREAM</span>
                <span className="lost-s mono text-slate-300">Waiting for Detection Engine heartbeat...</span>
                <span className="lost-detail mono text-white/80"> {cam.id}</span>
                <span className="lost-r text-slate-300">Reconnecting</span>
              </div>
            )}
          </motion.div>
          <CameraSelector cameras={cameras} selectedId={cam.id} link={link}
            streamState={feedStatus?.cameraId === cam.id ? feedStatus.state : null}
            onSelect={setHeroCam} />
        </div>
        {/* ⚠️ เดิม canvasR เป็น motion.div ที่ fade+slide เข้ามาช้ากว่าฝั่งซ้าย
            150ms (delay: 0.15) โดยเจตนา — นี่คือ staggered page-load choreography
            ชัด ๆ (ไล่โผล่ทีละฝั่งตอนเปิดหน้า) ตัดออกเหมือนกับ .pagehead:
            Access control + Event stream ต้องขึ้นพร้อมกล้องหลักทันที ไม่ใช่รอ
            ให้ตาสังเกตเห็นการเลื่อนเข้ามาก่อน — panel เหล่านี้คือข้อมูลปฏิบัติการ
            ไม่ใช่ของตกแต่งที่ควร "reveal" ให้ดูสวย */}
        <div className="canvasR">
          <section className={stale ? 'panel glass acpanel isstale' : 'panel glass acpanel'}>
            <div className="acglow" />
            <div className="ptitle" style={{ justifyContent: 'space-between' }}>
              <span className="fx ac gap9">
                <ShieldCheck aria-hidden="true" />
                Access control · result
              </span>
              {stale ? <StaleBadge red={lost} label="Stale" /> : <span className="acdot" />}
            </div>
            <p className="live-camera-context">{cam.id} · {cam.name} · Latest detection</p>
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
                <p className="sub">{fmtDate(grant.at)} {fmtTime(grant.at)}</p>
              </div>
            ) : (
              <p className="sub" style={{ margin: 0 }}>{heroFrame
                ? 'No authorization in the latest detection.' : 'No recent detection'}</p>
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
            <p className="live-camera-context">{cam.id} · {cam.name} · Selected camera only</p>
            <div className="streamlist">
              {!rows.length && <p className="sub">No recent detection</p>}
              {rows.map((r, i) => (
                <motion.div
                  key={r.id}
                  className={i === 0 ? 'srow live-event-row newflag' : 'srow live-event-row'}
                  whileHover={{ x: 4, backgroundColor: 'rgba(255, 255, 255, 0.07)' }}
                  transition={{ duration: 0.15 }}
                >
                  <span className="sts mono">{fmtTime(r.at)}</span>
                  <span className={`sdot ${r.dot}`} aria-hidden="true" />
                  <span className="stext">{r.text}</span>
                </motion.div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  )
}
