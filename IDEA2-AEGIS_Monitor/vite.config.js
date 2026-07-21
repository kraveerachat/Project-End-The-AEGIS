import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base '/monitor/' — HUB's NGINX reverse-proxies /monitor/* to this app UNCHANGED
// (no path stripping — see HUB-AEGIS_Entry/nginx.conf). Every asset URL and
// apiFetch() call is built from import.meta.env.BASE_URL (src/lib/api.js) so
// the same bundle works standalone at '/' (dev) and mounted at '/monitor/' (prod).
//
// dev: vite เสิร์ฟ frontend ที่ :5176/monitor/ ส่วน Express API ของ Monitor อยู่ที่ :8002
// (mounted ที่ root, ไม่รู้จัก /monitor) — proxy จึงต้อง rewrite ตัด /monitor ออกก่อนส่งต่อ
// → session cookie (HttpOnly, SameSite=Strict) ไป-กลับได้ตามปกติ same-origin
// (production ไม่ใช้ proxy — Express เสิร์ฟทั้ง dist และ /api จาก origin เดียว
//  ผ่าน nginx ที่ forward /monitor/* เข้ามาแบบไม่ตัด prefix)
export default defineConfig({
  base: '/monitor/',
  plugins: [react()],
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
