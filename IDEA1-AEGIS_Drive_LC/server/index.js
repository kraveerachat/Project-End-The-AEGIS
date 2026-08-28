// server/index.js — AEGIS Drive (IDEA1) · Application Layer ของ Edge Data Lake
// เสิร์ฟ API + ไฟล์ build จาก origin เดียวกัน → session cookie (HttpOnly) ทำงานโดยไม่ต้องเปิด CORS
//
// ⚠️ Identity Decoupling: ระบบตัวตนของ Drive อยู่ "ในแอปนี้" ทั้งหมด
//    - ไม่มี SSO, ไม่เชื่อ cookie จาก HUB หรือแอปอื่นใด
//    - HUB เป็นแค่ทางผ่าน (traffic router) — ไม่มีสิทธิ์ออกเซสชันแทนใคร
//    - IDEA2 (AEGIS Monitor) มีตาราง users + ฐานข้อมูลของตัวเองแยกต่างหาก
//
// การประกอบ app อยู่ใน app.js (ชุดทดสอบ import ตัวเดียวกันไปใช้) — ไฟล์นี้ทำหน้าที่
// bootstrap + เปิดพอร์ตเท่านั้น
import { createApp } from './app.js'
import { usingPostgres } from './db/connection.js'
import { bootstrapAdminIfNeeded } from './db/bootstrapAdmin.js'
import { initStorage, STORAGE_ROOT } from './storage/fileStore.js'
import { initUploadStaging } from './storage/uploadStaging.js'
import { cleanupAbandonedUploads, scheduleUploadCleanup } from './storage/uploadCleanup.js'
import { initVaultStorage } from './storage/vaultStore.js'
import { initAvatarStorage } from './storage/avatarStore.js'

const PORT = process.env.PORT || 8001 // ตรงกับผังบริการ: AEGIS Drive = พอร์ตภายใน 8001

const app = createApp()

// Day-0 bootstrap ก่อนเปิดพอร์ตรับ request — ถ้า ADMIN_BOOTSTRAP_* ตั้งค่าผิดรูปแบบ
// (เช่นใส่รหัสดิบแทน bcrypt hash) ต้อง crash ตั้งแต่ตรงนี้ ไม่ใช่เงียบแล้วรันต่อแบบไม่ปลอดภัย
//
// Storage Layer ต้องพร้อม "ก่อน" เปิดพอร์ตเช่นกัน — volume ที่ mount มาแล้วเขียนไม่ได้
// (เจ้าของเป็น root ขณะที่เรารันด้วย user 'node') ต้องดังตั้งแต่บูต ไม่ใช่ปล่อยให้ผู้ใช้
// อัปโหลดแล้วเจอ 500 ตอน runtime โดยไม่มีใครรู้ว่า Data Lake ไม่มีชั้นเก็บไฟล์อยู่จริง
// vault/ ถูกเตรียมแยกจาก uploads/ — ถ้าเขียนไม่ได้ ผู้ใช้จะอัปโหลดเข้า vault ไม่ได้เลย
// avatars/ ก็เช่นกัน — แยกโฟลเดอร์เพราะเป็นที่เดียวที่ไบต์ของผู้ใช้ถูกส่งกลับให้
// เบราว์เซอร์ render เอง (ไม่ใช่ attachment) ดูกฎของมันใน storage/avatarStore.js
// .staging/uploads/ ต้องพร้อมก่อนเปิดพอร์ตเช่นกัน — ถ้าเขียนไม่ได้ การอัปโหลดไฟล์ใหญ่
// (เส้นทาง V2 แบบ chunk) จะล้มตอน runtime แทนที่จะดังตั้งแต่บูต
Promise.all([
  bootstrapAdminIfNeeded(), initStorage(), initUploadStaging(), initVaultStorage(), initAvatarStorage(),
])
  .then(() => {
    // เก็บกวาดรอบแรกตอนบูต แล้วจึงตั้งรอบประจำ — session ที่ค้างจากการรันครั้งก่อนต้อง
    // ถูกเก็บกวาดโดยไม่ต้องรอครบหนึ่งชั่วโมง (ล้มเหลวไม่กันการเปิดพอร์ต: มันคือการเก็บ
    // กวาดพื้นที่ ไม่ใช่ด่านความปลอดภัย และ scheduleUploadCleanup จะลองใหม่เอง)
    cleanupAbandonedUploads()
      .then(({ expired, orphans }) => {
        if (expired || orphans) {
          console.log(`[aegis-drive] upload cleanup removed ${expired} expired session(s), ${orphans} orphan(s)`)
        }
      })
      .catch((err) => console.error('[aegis-drive] initial upload cleanup failed:', err.message))
    scheduleUploadCleanup()

    app.listen(PORT, () => {
      const mode = usingPostgres ? 'PostgreSQL' : 'in-memory dev fallback'
      console.log(`[aegis-drive] server on :${PORT} (auth store: ${mode})`)
      console.log(`[aegis-drive] storage layer ready at ${STORAGE_ROOT}`)
    })
  })
  .catch((err) => {
    console.error('[aegis-drive] startup failed (admin bootstrap or storage layer) — refusing to start:', err.message)
    process.exit(1)
  })
