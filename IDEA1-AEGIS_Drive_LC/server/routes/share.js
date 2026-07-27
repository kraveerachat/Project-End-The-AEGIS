// server/routes/share.js — AEGIS Drive (IDEA1) · เส้นทาง "ไถ่ลิงก์แชร์" (public)
//
// นี่คือเส้นทางเดียวในแอปที่ให้ไฟล์กับคนที่ "ไม่ได้ล็อกอิน" — ผู้รับถือแค่ token ในลิงก์
// จึงต้องมีด่านของตัวเองครบชุด เพราะไม่มี session/CSRF/RBAC มาช่วยเลย:
//
//   1. token ต้องมีจริง (เทียบด้วย sha256 — ตารางเก็บแต่ hash)
//   2. ยังไม่ถูกเพิกถอน และยังไม่หมดอายุ
//   3. IP ต้นทางต้องอยู่ในขอบเขตที่ผู้สร้างกำหนด (ถ้ากำหนดไว้)
//   4. ถ้าลิงก์ตั้งรหัสไว้ ต้องกรอกถูก (bcrypt) + มี rate limit กัน brute-force
//   5. ผ่านหมดแล้วจึง stream ไฟล์ + เพิ่มตัวนับ + เขียน audit
//
// ⚠️ ทุกความล้มเหลวตอบ "หน้าเดียวกัน" (404 หรือ 403 ตามชนิด) — ไม่บอกว่า token ไม่มีจริง
//    หรือมีแต่หมดอายุ/ถูกเพิกถอน ไม่งั้นผู้โจมตีใช้เส้นนี้ยืนยันได้ว่า token ไหนเคยมีอยู่
//    audit ฝั่งเซิร์ฟเวอร์แยกเหตุผลไว้ครบ (สิ่งที่ผู้ดูแลต้องเห็น ≠ สิ่งที่ผู้รับควรรู้)
//
// ⚠️ ไม่มี CSRF token บนเส้นทางนี้ และไม่ต้องมี: ไม่มีเซสชันให้ปลอม และ POST ที่นี่
//    ไม่เปลี่ยนสถานะของ "ผู้ใช้ที่ล็อกอินอยู่" คนไหนเลย ผู้โจมตีที่จะยิงฟอร์มนี้ข้ามต้นทาง
//    ต้องรู้ทั้ง token และรหัสลิงก์อยู่แล้ว — ซึ่งถ้ารู้ ก็เปิดลิงก์เองได้ตรง ๆ
import { Router } from 'express'
import bcrypt from 'bcryptjs'
import express from 'express'
import { randomBytes } from 'node:crypto'
import { recordAudit, sha256Hex } from '../db/connection.js'
import * as store from '../db/store.js'
import { keyExists, openReadStream } from '../storage/fileStore.js'
import { checkLock, recordFailure, recordSuccess } from '../auth/rateLimit.js'

export const shareRouter = Router()

// ฟอร์มรหัสลิงก์ส่งมาเป็น urlencoded — parse เฉพาะ router นี้ ไม่แตะ body parser ของแอป
shareRouter.use(express.urlencoded({ extended: false, limit: '4kb' }))

// ── IP ↔ CIDR ─────────────────────────────────────────────────────────────────
// ⚠️ ขอบเขตของการบังคับนี้ (พูดให้ตรง เพื่อไม่ให้กลายเป็นคำสัญญาเกินจริงอีกครั้ง):
//    นี่คือการเทียบ IP ต้นทางที่ "ชั้นแอปพลิเคชัน" — เป็น defense in depth ที่ทำงานจริง
//    และตรวจสอบได้ แต่ไม่ใช่สิ่งเดียวกับการแยก VLAN ที่ firewall/switch:
//      - req.ip มาจาก X-Forwarded-For (app.set('trust proxy', 1)) ค่านี้เชื่อถือได้
//        "เท่าที่ reverse proxy หน้าบ้านตั้งให้" ถ้าวันหนึ่งมีเส้นทางที่ยิงเข้า Express
//        ตรงโดยไม่ผ่าน nginx ผู้ยิงจะตั้ง header นี้เองได้
//      - การแยกเครือข่ายจริงต้องทำให้ packet ไปไม่ถึงพอร์ตตั้งแต่แรก ไม่ใช่ให้ถึงแล้ว
//        ค่อยปฏิเสธ
//    จอ Shares จึงต้องพูดตรงตามนี้ ไม่ใช่วาดว่า firewall บล็อกให้
const ipv4ToInt = (ip) => {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const v = Number(p)
    if (v > 255) return null
    n = n * 256 + v
  }
  return n
}

/** '::ffff:192.168.1.5' → '192.168.1.5'; ค่าอื่นคืนตามเดิม */
function normalizeIp(ip) {
  const s = String(ip ?? '')
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s)
  return m ? m[1] : s
}

function ipInCidr(ip, cidr) {
  const [net, bitsRaw] = String(cidr).split('/')
  const bits = Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false
  const a = ipv4ToInt(normalizeIp(ip))
  const b = ipv4ToInt(net)
  if (a === null || b === null) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
  return ((a & mask) >>> 0) === ((b & mask) >>> 0)
}

/** ว่าง = ไม่จำกัด; ไม่ว่าง = ต้องเข้าอย่างน้อยหนึ่งช่วง (IPv6 ที่ไม่ใช่ mapped = ไม่ผ่าน) */
export function ipAllowed(ip, cidrs) {
  if (!Array.isArray(cidrs) || cidrs.length === 0) return true
  return cidrs.some((c) => ipInCidr(ip, c))
}

// ── หน้า HTML ขนาดเล็ก ────────────────────────────────────────────────────────
// ⚠️ CSP ของแอปเป็น style-src 'self' (ไม่มี unsafe-inline) — หน้าพวกนี้ไม่ได้อยู่ใน
//    bundle ของ Vite จึงไม่มีไฟล์ CSS ให้อ้าง วิธีที่ถูกต้องคือ nonce ต่อ response
//    ไม่ใช่ผ่อน CSP ของทั้งแอปให้อนุญาต inline style ถาวร
// ⚠️ หน้านี้ไม่มี JavaScript เลยแม้แต่บรรทัดเดียว — ฟอร์ม POST ธรรมดา ทำให้ script-src
//    ไม่ต้องถูกผ่อนตามไปด้วย
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

const STYLE = `
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
         background: #f6f7f9; color: #16181d; padding: 24px; }
  main { width: 100%; max-width: 26rem; background: #fff; border: 1px solid #e4e6ea;
         border-radius: 16px; padding: 28px; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  h1 { margin: 0 0 6px; font-size: 18px; letter-spacing: -0.01em; }
  p { margin: 0 0 18px; color: #5b6472; font-size: 13.5px; }
  .file { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
          background: #f6f7f9; border: 1px solid #e4e6ea; border-radius: 10px;
          padding: 10px 12px; margin-bottom: 18px; overflow-wrap: anywhere; }
  label { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase;
          letter-spacing: .06em; color: #5b6472; margin-bottom: 6px; }
  input { width: 100%; box-sizing: border-box; height: 42px; padding: 0 14px;
          border: 1px solid #d7dae0; border-radius: 999px; font-size: 14px; background: #fff;
          color: inherit; }
  input:focus { outline: none; border-color: #2f6feb; box-shadow: 0 0 0 3px rgba(47,111,235,.18); }
  button { width: 100%; height: 42px; margin-top: 16px; border: 0; border-radius: 999px;
           background: #16181d; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
  .err { color: #c0392b; font-size: 13px; font-weight: 500; margin: 12px 0 0; }
  .muted { font-size: 12px; color: #8b939f; margin: 18px 0 0; }
  @media (prefers-color-scheme: dark) {
    body { background: #0f1115; color: #e8eaee; }
    main { background: #16181d; border-color: #272b33; box-shadow: none; }
    .file { background: #0f1115; border-color: #272b33; }
    input { background: #0f1115; border-color: #333944; }
    button { background: #e8eaee; color: #16181d; }
    p, label { color: #98a1ae; }
  }
`

function page(res, { status, nonce, title, body }) {
  // CSP ต่อ response: อนุญาต <style> ที่มี nonce นี้ก้อนเดียว ที่เหลือปิดหมด
  // (ไม่มี script-src 'self' ด้วยซ้ำ — หน้านี้ไม่โหลด JS อะไรเลย)
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `style-src 'nonce-${nonce}'`,
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join('; '),
  )
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.status(status).send(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex,nofollow">` +
    `<title>${esc(title)}</title><style nonce="${nonce}">${STYLE}</style></head>` +
    `<body><main>${body}</main></body></html>`,
  )
}

/** หน้าเดียวสำหรับทุกความล้มเหลวของ "ลิงก์ใช้ไม่ได้" — ไม่แยกว่าเพราะอะไร */
function unavailable(res, nonce) {
  page(res, {
    status: 404, nonce, title: 'Link unavailable',
    body: `<h1>This link is not available</h1>` +
      `<p>It may have expired, been revoked, or never existed. Ask the person who shared it for a new link.</p>`,
  })
}

function outOfScope(res, nonce) {
  page(res, {
    status: 403, nonce, title: 'Link restricted',
    body: `<h1>This link is restricted</h1>` +
      `<p>It can only be opened from an approved network. You are connecting from outside that range.</p>`,
  })
}

function passwordForm(res, { nonce, token, fileName, error }) {
  page(res, {
    status: error ? 401 : 200, nonce, title: 'Password required',
    body: `<h1>Password required</h1>` +
      `<p>This file was shared with a password. Ask the sender if you do not have it.</p>` +
      `<div class="file">${esc(fileName)}</div>` +
      `<form method="post" action="${esc(`s/${token}`)}">` +
      `<label for="pw">Link password</label>` +
      `<input id="pw" name="password" type="password" autocomplete="off" autofocus required>` +
      `<button type="submit">Download</button></form>` +
      (error ? `<p class="err">${esc(error)}</p>` : '') +
      `<p class="muted">Attempts are rate limited and recorded.</p>`,
  })
}

// ── ด่านร่วมของทั้ง GET และ POST ───────────────────────────────────────────────
const auditShare = (req, action, target, result) =>
  recordAudit({
    actorLabel: 'share-link', action, targetHash: target ? sha256Hex(target) : null,
    result, sourceIp: req.ip,
  })

/**
 * @returns {Promise<{ ok: true, share: object } | { ok: false, kind: 'gone'|'scope' }>}
 * ⚠️ audit แยกเหตุผลไว้ครบ (ผู้ดูแลต้องเห็น) แต่ผู้เรียกต้องแปลงเป็นหน้าเดียวกันหมด
 */
async function resolveShare(req, token) {
  const share = await store.findShareByToken(token)
  if (!share) {
    // token ที่ไม่มีจริง — เก็บ hash ของ token ไว้ใน audit เพื่อจับรูปแบบการสุ่มยิง
    await auditShare(req, 'SHARE_REDEEM', `unknown:${sha256Hex(String(token))}`, 'DENIED')
    return { ok: false, kind: 'gone' }
  }
  if (share.revoked) {
    await auditShare(req, 'SHARE_REDEEM_REVOKED', share.fileName, 'BLOCKED')
    return { ok: false, kind: 'gone' }
  }
  if (share.expiresAt <= Date.now()) {
    await auditShare(req, 'SHARE_REDEEM_EXPIRED', share.fileName, 'DENIED')
    return { ok: false, kind: 'gone' }
  }
  // ⚠️ ไฟล์ vault ต้องไถ่ไม่ได้เด็ดขาด แม้จะมีแถวแชร์อยู่ — เซิร์ฟเวอร์ถือแต่ ciphertext
  //    ที่ถอดไม่ได้ การส่งมันออกไปคือส่งขยะให้ผู้รับ และเป็นการรั่ว ciphertext ฟรี ๆ
  if (share.fileVault) {
    await auditShare(req, 'SHARE_REDEEM', share.fileName, 'BLOCKED')
    return { ok: false, kind: 'gone' }
  }
  if (!ipAllowed(req.ip, share.scopeCidrs)) {
    await auditShare(req, 'SHARE_REDEEM_OUT_OF_SCOPE', share.fileName, 'BLOCKED')
    return { ok: false, kind: 'scope' }
  }
  return { ok: true, share }
}

/** ส่งไฟล์จริงให้ผู้รับ + นับ hit + audit — เรียกได้เฉพาะเมื่อผ่านด่านทั้งหมดแล้ว */
async function deliver(req, res, share, nonce) {
  if (!share.filePath || !(await keyExists(share.filePath))) {
    // แถว metadata มีแต่ไบต์ไม่มี — ไม่ปลอมไฟล์เปล่าคืน
    await auditShare(req, 'SHARE_REDEEM', share.fileName, 'DENIED')
    return unavailable(res, nonce)
  }
  const stream = openReadStream(share.filePath)
  if (!stream) {
    await auditShare(req, 'SHARE_REDEEM', share.fileName, 'DENIED')
    return unavailable(res, nonce)
  }

  // นับ "การไถ่สำเร็จ" ก่อนเริ่ม stream — ถ้าท่อขาดกลางทางก็ยังถือว่าไฟล์ถูกปล่อยออกไปแล้ว
  await store.countShareHit(share.id)
  await auditShare(req, 'SHARE_REDEEM', share.fileName, 'OK')

  // octet-stream + attachment เสมอ เหมือน /api/files/:id/download — ห้ามให้เบราว์เซอร์
  // render ไฟล์ที่ผู้ใช้อัปโหลด (HTML/SVG ที่ถูก render ใน origin นี้ = XSS)
  res.setHeader('Content-Type', 'application/octet-stream')
  res.setHeader('Content-Length', String(share.fileSize))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(share.fileName)}`)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

// ── GET /s/:token ─────────────────────────────────────────────────────────────
shareRouter.get('/s/:token', async (req, res, next) => {
  const nonce = randomBytes(16).toString('base64')
  try {
    const result = await resolveShare(req, req.params.token)
    if (!result.ok) return result.kind === 'scope' ? outOfScope(res, nonce) : unavailable(res, nonce)

    const { share } = result
    if (share.authType === 'password') {
      // ยังไม่ยืนยันรหัส — แสดงฟอร์ม (ยังไม่นับ hit: การเห็นฟอร์มไม่ใช่การเข้าถึงไฟล์)
      return passwordForm(res, { nonce, token: req.params.token, fileName: share.fileName })
    }
    return deliver(req, res, share, nonce)
  } catch (err) {
    next(err)
  }
})

// ── POST /s/:token — ส่งรหัสลิงก์ ──────────────────────────────────────────────
shareRouter.post('/s/:token', async (req, res, next) => {
  const nonce = randomBytes(16).toString('base64')
  try {
    // ⚠️ rate limit ก่อนแตะ DB — ใช้กลไกเดียวกับหน้า login (5 ครั้ง แล้ว exponential
    //    backoff) โดยใช้ hash ของ token เป็น "แกนบัญชี" ถ้าไม่มีด่านนี้ ลิงก์ที่ตั้งรหัส
    //    สั้น ๆ จะถูกไล่เดารหัสได้ไม่จำกัดครั้งจากเครื่องเดียว โดยที่เจ้าของไฟล์ไม่รู้เลย
    const rateKey = `share:${sha256Hex(String(req.params.token))}`
    const lock = checkLock(req, rateKey, 'share')
    if (lock.locked) {
      res.set('Retry-After', String(Math.ceil(lock.retryAfterMs / 1000)))
      await auditShare(req, 'SHARE_REDEEM_LOCKOUT', rateKey, 'BLOCKED')
      return page(res, {
        status: 429, nonce, title: 'Too many attempts',
        body: '<h1>Too many attempts</h1><p>Wait a few minutes before trying this link again.</p>',
      })
    }

    const result = await resolveShare(req, req.params.token)
    if (!result.ok) return result.kind === 'scope' ? outOfScope(res, nonce) : unavailable(res, nonce)
    const { share } = result

    // ลิงก์ที่ไม่ได้ตั้งรหัสก็ให้ผ่านทาง POST ได้ (ไม่มีอะไรต้องตรวจ) — แต่ปกติจะมาทาง GET
    if (share.authType !== 'password') return deliver(req, res, share, nonce)

    const submitted = String(req.body?.password ?? '')
    const ok = share.passwordHash ? await bcrypt.compare(submitted, share.passwordHash) : false
    if (!ok) {
      recordFailure(req, rateKey, 'share')
      await auditShare(req, 'SHARE_REDEEM', share.fileName, 'DENIED')
      return passwordForm(res, {
        nonce, token: req.params.token, fileName: share.fileName,
        error: 'That password is not correct.',
      })
    }

    recordSuccess(req, rateKey, 'share')
    return deliver(req, res, share, nonce)
  } catch (err) {
    next(err)
  }
})
