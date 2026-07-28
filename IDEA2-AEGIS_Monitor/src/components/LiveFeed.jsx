// src/components/LiveFeed.jsx — AEGIS Monitor (IDEA2) · Phase B
//
// MJPEG ผ่าน image element คือวิธี "พื้นเมือง" ของเบราว์เซอร์: multipart/x-mixed-replace
// ถูกถอดรหัสโดยตัวเบราว์เซอร์เอง ไม่ต้องมี player, ไม่ต้องมี JS ถอดเฟรม
//
// ⚠️ src ชี้ไปที่ origin ของ Monitor เสมอ (/monitor/api/cameras/:id/stream)
//    ไม่เคยชี้ไปหา Detection Engine ตรง ๆ — เบราว์เซอร์ไม่รู้จัก และต้องไม่รู้จัก
//    ที่อยู่ของ engine หรือ API key ของมัน
//
// ── ทำไมต้องจัดการ error เองทั้งหมด ─────────────────────────────────────────
// image element บอกเราได้แค่ 'load' กับ 'error' — อ่าน HTTP status ไม่ได้เลย ดังนั้น
// "สตรีมพัง" กับ "ไม่มีสิทธิ์" กับ "engine ตาย" หน้าตาเหมือนกันหมดในสายตา DOM
// เราจึงแยกสามกรณีด้วยข้อมูลที่ "รู้ล่วงหน้าจาก /api/link" แทนที่จะเดาจาก event:
//   - hasStream === false  → ไม่ต้องต่อเลย แสดง "ไม่มีสตรีม" ตรง ๆ (ไม่ค้าง ไม่ว่างเปล่า)
//   - hasStream === true แต่ error → ลองใหม่แบบ backoff พร้อมบอกสถานะที่จอ
//   - เซสชันหมด → apiFetch ตัวอื่น (poll /api/link ทุก 5 วิ) จะได้ 401 แล้วเด้ง
//     กลับหน้า login ทั้งแอป — สตรีมถูก unmount ไปพร้อมกัน ไม่มีกรอบดำค้างจอ
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, VideoOff, WifiOff } from 'lucide-react'

const RETRY_MS = [2_000, 4_000, 8_000, 15_000, 30_000] // backoff, หยุดที่ 30 วิ

export default function LiveFeed({ cameraId, cameraName, hasStream, lost, compact = false, hideStatus = false }) {
  // nonce เปลี่ยน = บังคับเบราว์เซอร์เปิดคำขอใหม่ (ไม่งั้นมันจะใช้ src เดิมที่ตายแล้ว)
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState('connecting') // connecting | live | error
  const attempts = useRef(0)
  const timer = useRef(0)

  const base = import.meta.env.BASE_URL
  const src = `${base}api/cameras/${encodeURIComponent(cameraId)}/stream?t=${nonce}`

  const retryNow = useCallback(() => {
    clearTimeout(timer.current)
    attempts.current = 0
    setState('connecting')
    setNonce((n) => n + 1)
  }, [])

  // เปลี่ยนกล้อง = เริ่มนับใหม่ทั้งหมด (ไม่ให้ backoff ของกล้องเก่าติดมา)
  useEffect(() => {
    clearTimeout(timer.current)
    attempts.current = 0
    setState('connecting')
    setNonce((n) => n + 1)
    return () => clearTimeout(timer.current)
  }, [cameraId])

  // กล้องที่ engine ไม่ได้รายงาน → ไม่ยิงคำขอเลย
  useEffect(() => {
    if (!hasStream) {
      clearTimeout(timer.current)
      setState('nostream')
    } else if (state === 'nostream') {
      retryNow()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStream])

  const onError = () => {
    // engine ตายกลางสตรีม / proxy คืน 5xx / เซสชันหมด — image element แยกไม่ออก
    // จึงถอยแบบ backoff แล้วลองใหม่ ไม่ปล่อยให้เป็นกรอบดำเงียบ ๆ
    setState('error')
    const wait = RETRY_MS[Math.min(attempts.current, RETRY_MS.length - 1)]
    attempts.current += 1
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setState('connecting')
      setNonce((n) => n + 1)
    }, wait)
  }

  const onLoad = () => {
    // MJPEG: 'load' ยิงเมื่อได้เฟรมแรก — ถือว่าเชื่อมต่อสำเร็จจริง
    attempts.current = 0
    setState('live')
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  // ── สถานะที่ไม่ใช่ "กำลังฉาย" — ทุกกรณีมีข้อความของตัวเอง ไม่มีกล่องว่าง ──
  if (!hasStream || state === 'nostream') {
    // ในไทล์เล็ก ๆ ไม่ยัดข้อความเต็มรูปแบบ — ป้าย NO FEED ที่ .sfeed มีอยู่แล้วพอ
    if (compact || hideStatus) return <div className="hatch" />
    return (
      <>
        <div className="hatch" />
        <div className="lostwrap flex flex-col items-center justify-center gap-3">
          <VideoOff aria-hidden="true" className="text-slate-300" />
          <span className="lost-t text-rose-500 font-bold tracking-widest text-lg">NO LIVE STREAM</span>
          <span className="lost-s mono text-slate-300">
            No Detection Engine is streaming {cameraId}
          </span>
        </div>
      </>
    )
  }

  return (
    <>
      {/* hatch อยู่ใต้ภาพเสมอ — ระหว่างเชื่อมต่อ/สตรีมพัง จะเห็นลายนี้แทนกรอบดำ */}
      <div className="hatch" />
      <img
        key={nonce}
        className="feedimg"
        src={src}
        alt={`Live feed — ${cameraId} ${cameraName ?? ''}`.trim()}
        onError={onError}
        onLoad={onLoad}
        draggable={false}
      />
      {!compact && !hideStatus && state !== 'live' && (
        <div className="feedstate" role="status" aria-live="polite">
          {state === 'error' ? (
            <>
              <WifiOff aria-hidden="true" size={14} />
              <span>Stream interrupted — reconnecting…</span>
              <button type="button" className="ackbtn feedretry" onClick={retryNow}>
                <RefreshCw aria-hidden="true" size={12} style={{ marginRight: 5 }} />Retry now
              </button>
            </>
          ) : (
            <>
              <RefreshCw aria-hidden="true" size={14} className="spin" />
              <span>Connecting to {cameraId}…</span>
            </>
          )}
        </div>
      )}
      {/* link lost แต่สตรีมยังมา = ภาพที่เห็นอาจเก่ากว่าความจริง — เตือนไว้ */}
      {!compact && !hideStatus && lost && state === 'live' && (
        <div className="feedstate" role="status">
          <WifiOff aria-hidden="true" size={14} />
          <span>Edge link lost — displayed frames may be stale</span>
        </div>
      )}
    </>
  )
}
