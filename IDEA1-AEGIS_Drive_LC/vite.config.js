import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const driveBackendProxy = () => ({
  target: process.env.AEGIS_DRIVE_API_ORIGIN || 'http://127.0.0.1:8001',
  changeOrigin: false,
  rewrite: (path) => path.replace(/^\/drive/, ''),
  configure: (proxy) => {
    proxy.on('error', (err, _req, res) => {
      if (err.code === 'ECONNREFUSED' && res && !res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Backend server not running' }))
      }
    })
  },
})

// base '/drive/' — nginx STRIPS the /drive prefix before proxying to this app.
// Every asset URL and apiFetch() call is built from import.meta.env.BASE_URL
// (src/lib/api.js) so the same bundle works standalone at '/' (dev) and mounted
// at '/drive/' (prod) — the prefix lives in the bundle, never in Express.
//
// ⚠️ แก้คอมเมนต์ 2026-07-26: เดิมบรรทัดนี้เขียนว่า nginx forward "UNCHANGED (no path
//    stripping)" ซึ่ง **ไม่จริงแล้ว และตอนที่เขียนก็เป็นสาเหตุของบั๊กจอขาว** — ทั้ง
//    `gateway/nginx.conf` และ `HUB-AEGIS_Entry/nginx.conf` ตัด prefix ด้วย
//    `rewrite ^/drive/?(.*)$ /$1 break;` แล้วทั้งคู่ (Express mount ทุกอย่างที่ root)
//
// dev: vite เสิร์ฟ frontend ที่ :5174/drive/ ส่วน Express API ของ Drive อยู่ที่ :8001
// (mounted ที่ root, ไม่รู้จัก /drive) — proxy จึงต้อง rewrite ตัด /drive ออกก่อนส่งต่อ
// เหมือนที่ nginx ทำใน production ทุกประการ
// → session cookie (HttpOnly, SameSite=Strict) ไป-กลับได้ตามปกติ same-origin
// ── Service Worker ของ preview วิดีโอ V2 (LFT-V2-E3) ────────────────────────
// ⚠️ ต้องเป็น entry แยกที่มี **ชื่อไฟล์คงที่ ไม่มี hash** และวางที่ราก dist/ เพราะสองข้อ:
//    1. ขอบเขต (scope) ของ Service Worker คือไดเรกทอรีของสคริปต์มันเอง ไฟล์ที่อยู่ใน
//       dist/assets/ จะได้ scope '/drive/assets/' ซึ่งดักคำขอของ '/drive/…' ไม่ได้เลย
//    2. การลงทะเบียนต้องอ้างถึง URL เดิมทุกครั้ง ชื่อที่มี hash จะเปลี่ยนทุก build แล้ว
//       เบราว์เซอร์จะเห็นเป็น worker คนละตัวและทิ้งตัวเก่าค้างไว้
// ⚠️ มันถูก build เป็น ES module (ลงทะเบียนด้วย { type: 'module' }) จึง import โมดูล
//    เดียวกับที่แอปและชุดทดสอบใช้ได้ — กติกาการถอดรหัสจึงมีสำเนาเดียวในโครงการนี้
const previewWorkerEntry = fileURLToPath(new URL('./src/vaultPreviewServiceWorker.js', import.meta.url))

export default defineConfig({
  base: '/drive/',
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        // ⚠️ คีย์ต้องเป็น 'index' เพื่อให้ชื่อไฟล์ของ entry หลักยังเป็น assets/index-[hash].js
        //    เหมือนเดิม การเปลี่ยนคีย์เปลี่ยนชื่อไฟล์ผลลัพธ์ไปด้วยโดยไม่มีเหตุผล
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        'vault-preview-sw': previewWorkerEntry,
      },
      output: {
        entryFileNames: (chunk) =>
          (chunk.name === 'vault-preview-sw' ? 'vault-preview-sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
  server: {
    proxy: {
      '/drive/api': {
        // ⚠️ ห้ามตั้ง changeOrigin: true — เคยตั้งไว้แล้ว "ล็อกอินใน dev ไม่ผ่าน" (403)
        //    changeOrigin เขียนทับ header Host เป็น host ของ target (127.0.0.1:8001)
        //    ขณะที่เบราว์เซอร์ยังส่ง Origin: http://localhost:5174 มาตามเดิม →
        //    ชั้นที่ 2 ของ CSRF (server/middleware/csrf.js: Origin ต้องตรงกับ Host)
        //    เห็นเป็นคำขอข้ามต้นทางแล้วปฏิเสธด้วย 403 ทั้งที่รหัสผ่านถูกต้อง
        //    (แย่กว่านั้นคือ UI เคยแสดง 403 นี้ว่า "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง")
        //
        //    false = ส่ง Host เดิมของเบราว์เซอร์ต่อไปให้ backend — ซึ่ง "ตรงกับ
        //    production" ด้วย: HUB nginx ใช้ `proxy_set_header Host $http_host`
        //    (ส่งค่า Host ดิบของเบราว์เซอร์ต่อไป **พร้อมพอร์ต** — เดิมเป็น `$host` ซึ่ง
        //    ตัดพอร์ตทิ้งและทำให้ล็อกอินพังทันทีถ้า deploy บนพอร์ตอื่นที่ไม่ใช่ :443)
        //    dev จึงเจอเงื่อนไข CSRF ชุดเดียวกับของจริง
        //    target เป็น Express ธรรมดา ไม่ได้ทำ vhost routing จึงไม่มีอะไรพึ่ง Host
        ...driveBackendProxy(),
      },
      // TopBar และ Dashboard ใช้ health เพื่อแยก "ยังไม่เชื่อมต่อ" ออกจาก API พังจริง
      // จึงต้องผ่าน proxy เดียวกับ /api ใน dev ด้วย ไม่เช่นนั้นจะแสดง offline ปลอม
      '/drive/healthz': driveBackendProxy(),
    },
  },
})
