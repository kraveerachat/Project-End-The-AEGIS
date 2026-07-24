// server/routes/internal.js — AEGIS Monitor (IDEA2)
// ── Internal ingest API สำหรับ Detection Engine (service-to-service) ──────────
// ผู้เขียน detections/alerts/clips คือ Detection Engine (Laptop, VLAN 20) ผ่าน LAN
// endpoint กลุ่มนี้ "เขียนอย่างเดียว" (ingest) — คนละชุดกับ /api/* ที่เว็บแอปใช้อ่าน
//
// ⚠️ ไม่มี CSRF/เซสชันที่นี่โดยเจตนา — Detection Engine ไม่ใช่เบราว์เซอร์ ไม่มี cookie
//    การยืนยันตัวตนใช้ API key (X-Detection-Engine-Key) ผ่าน middleware ที่ mount
//    หน้า router นี้ใน index.js (requireDetectionEngineKey) — ไม่ผูกกับ role ผู้ใช้
//
// ⚠️ ตรรกะ validate + เขียนฐานอยู่ใน store.js (insertDetection/insertClip/insertAlert)
//    ตาม pattern เดียวกับ provisioning — router เป็นแค่ชั้นบาง ๆ ที่ map ผล → HTTP
import { Router } from 'express'
import * as store from '../db/store.js'

export const internalRouter = Router()

// POST /internal/detections — recognition event หนึ่งเฟรม (มีได้หลายคน = tailgating)
internalRouter.post('/detections', async (req, res, next) => {
  try {
    const r = await store.insertDetection(req.body ?? {})
    if (r.error) return res.status(r.status || 400).json({ error: r.error })
    res.status(201).json({ ok: true, frameId: r.frameId, rows: r.rows })
  } catch (err) { next(err) }
})

// POST /internal/clips — clip หนึ่งช่วง; ผู้เรียกคือ nas_sync "หลัง" verify sha256 สำเร็จ
// ⚠️ stored_on_nas เป็น TRUE ได้ก็ต่อเมื่อ verify ผ่านแล้วเท่านั้น (บังคับที่ฝั่ง engine)
internalRouter.post('/clips', async (req, res, next) => {
  try {
    const r = await store.insertClip(req.body ?? {})
    if (r.error) return res.status(r.status || 400).json({ error: r.error })
    res.status(201).json({ ok: true, id: r.id })
  } catch (err) { next(err) }
})

// POST /internal/alerts — alert หนึ่งรายการ; persist เสมอไม่ว่า Telegram จะสำเร็จหรือล่ม
internalRouter.post('/alerts', async (req, res, next) => {
  try {
    const r = await store.insertAlert(req.body ?? {})
    if (r.error) return res.status(r.status || 400).json({ error: r.error })
    res.status(201).json({ ok: true, id: r.id })
  } catch (err) { next(err) }
})

// ทุก path/method อื่นใต้ /internal ที่ไม่แมตช์ → 404 JSON (ไม่ปล่อยตกไป SPA fallback)
internalRouter.use((req, res) => {
  res.status(404).json({ error: 'Not found' })
})
