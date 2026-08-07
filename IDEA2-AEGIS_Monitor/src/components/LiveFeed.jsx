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

  // 1. ปล่อยให้ React โหลด Hooks ตามกฎให้เสร็จก่อน
  const [nonce, setNonce] = useState(0)
  const [state, setState] = useState('connecting') // connecting | live | error
  const attempts = useRef(0)
  const timer = useRef(0)
  // ⚠️ live-state feedback: กระพริบกรอบสั้น ๆ "เฉพาะตอนกู้คืนจาก error สำเร็จ"
  // (attempts.current > 0 แปลว่าก่อนหน้านี้หลุดไปแล้วอย่างน้อยหนึ่งรอบ) — ไม่ทำ
  // ตอนเชื่อมต่อสำเร็จครั้งแรกตอนโหลดหน้า เพราะนั่นจะกลายเป็น "page-load
  // choreography" อีกแบบหนึ่ง สัญญาณนี้มีความหมายเฉพาะตอน "กลับมาออนไลน์" จริง ๆ
  const [justRecovered, setJustRecovered] = useState(false)

  const base = import.meta.env.BASE_URL
  const src = `${base}api/cameras/${encodeURIComponent(cameraId)}/stream?t=${nonce}`

  const retryNow = useCallback(() => {
    clearTimeout(timer.current)
    attempts.current = 0
    setState('connecting')
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    clearTimeout(timer.current)
    attempts.current = 0
    setState('connecting')
    setNonce((n) => n + 1)
    return () => clearTimeout(timer.current)
  }, [cameraId])

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
    if (attempts.current > 0) {
      // เพิ่งกู้คืนจาก error จริง ๆ (ไม่ใช่การเชื่อมต่อครั้งแรก) — ให้ feedback สั้น ๆ
      setJustRecovered(true)
      setTimeout(() => setJustRecovered(false), 700)
    }
    attempts.current = 0
    setState('live')
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  if (!hasStream || state === 'nostream') {
    if (compact || hideStatus) return <div className="hatch" />
    return (
      <>
        <div className="hatch" />
        <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 999 }}>
          <div className="hatch" />
        </div>
      </>
    )
  }

  return (
    <>
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
      {justRecovered && <div className="feed-recovered" aria-hidden="true" />}
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
      {!compact && !hideStatus && lost && state === 'live' && (
        <div className="feedstate" role="status">
          <WifiOff aria-hidden="true" size={14} />
          <span>Edge link lost — displayed frames may be stale</span>
        </div>
      )}
    </>
  )
}