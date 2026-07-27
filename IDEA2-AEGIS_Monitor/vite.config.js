import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base '/monitor/' — nginx STRIPS the /monitor prefix before proxying to this app.
// Every asset URL and apiFetch() call is built from import.meta.env.BASE_URL
// (src/lib/api.js) so the same bundle works standalone at '/' (dev) and mounted
// at '/monitor/' (prod) — the prefix lives in the bundle, never in Express.
//
// ⚠️ แก้คอมเมนต์ 2026-07-26: เดิมบรรทัดนี้เขียนว่า nginx forward "UNCHANGED (no path
//    stripping)" — **ข้อความนั้นคือตัวบั๊กเอง** `server/index.js` ใช้
//    `express.static(DIST)` + `app.use('/api', …)` ที่ ROOT ไม่เคย mount ที่ /monitor
//    ดังนั้น "ไม่ตัด prefix" = asset ทุกตัวตกไป SPA fallback ได้ index.html กลับมา
//    เป็น JS module → จอขาว และ POST /monitor/api/login → 404 (วัดจริงแล้วทั้งคู่)
//    ตอนนี้ทั้ง `gateway/nginx.conf` และ `HUB-AEGIS_Entry/nginx.conf` ตัด prefix ด้วย
//    `rewrite ^/monitor/?(.*)$ /$1 break;` แล้วทั้งคู่
//
// dev: vite เสิร์ฟ frontend ที่ :5176/monitor/ ส่วน Express API ของ Monitor อยู่ที่ :8002
// (mounted ที่ root, ไม่รู้จัก /monitor) — proxy จึงต้อง rewrite ตัด /monitor ออกก่อนส่งต่อ
// เหมือนที่ nginx ทำใน production ทุกประการ
// → session cookie (HttpOnly, SameSite=Strict) ไป-กลับได้ตามปกติ same-origin
// เวอร์ชันมาจาก package.json ตัวเดียว — จอ Settings เคย hardcode "v3.0" ไว้ ซึ่ง
// จะเพี้ยนเงียบ ๆ ทุกครั้งที่ bump version
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  base: '/monitor/',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5176,
    proxy: {
      '/monitor/api': {
        target: process.env.AEGIS_MONITOR_API_ORIGIN || 'http://127.0.0.1:8002',
        // ⚠️ ห้ามตั้ง changeOrigin: true — เคยตั้งไว้แล้ว "ล็อกอินใน dev ไม่ผ่าน" (403)
        //    changeOrigin เขียนทับ header Host เป็น host ของ target (127.0.0.1:8002)
        //    ขณะที่เบราว์เซอร์ยังส่ง Origin: http://localhost:5176 มาตามเดิม →
        //    ชั้นที่ 2 ของ CSRF (server/middleware/csrf.js: Origin ต้องตรงกับ Host)
        //    เห็นเป็นคำขอข้ามต้นทางแล้วปฏิเสธด้วย 403 ทั้งที่รหัสผ่านถูกต้อง
        //    ⚠️ /login ไม่ได้รับการยกเว้นจากด่านนี้: PRE_SESSION_PATHS ใน csrf.js
        //    ยกเว้นให้แค่ "ด่าน synchronizer token" ซึ่งอยู่ *หลัง* ด่าน Origin↔Host
        //    → ทุก mutation ใน dev พังหมด ไม่ใช่แค่ login (logout / ack / add-operator
        //    / password reset) และ UI แสดง 403 นี้ว่า "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง"
        //
        //    false = ส่ง Host เดิมของเบราว์เซอร์ต่อไปให้ backend — ซึ่ง "ตรงกับ
        //    production" ด้วย: HUB nginx ใช้ `proxy_set_header Host $http_host`
        //    (ส่งค่า Host ดิบของเบราว์เซอร์ต่อไป **พร้อมพอร์ต**) dev จึงเจอเงื่อนไข
        //    CSRF ชุดเดียวกับของจริง — เหมือน IDEA1-AEGIS_Drive_LC/vite.config.js เป๊ะ
        //    target เป็น Express ธรรมดา ไม่ได้ทำ vhost routing จึงไม่มีอะไรพึ่ง Host
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/monitor/, ''),
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            if (err.code === 'ECONNREFUSED' && res && !res.headersSent) {
              res.writeHead(503, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Backend server not running' }))
            }
          })
        },
      },
    },
  },
})
