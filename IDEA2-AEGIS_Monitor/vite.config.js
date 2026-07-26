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
export default defineConfig({
  base: '/monitor/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5176,
    proxy: {
      '/monitor/api': {
        target: process.env.AEGIS_MONITOR_API_ORIGIN || 'http://127.0.0.1:8002',
        changeOrigin: true,
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
