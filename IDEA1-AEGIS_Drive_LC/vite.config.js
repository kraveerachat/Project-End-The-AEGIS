import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// base '/drive/' — HUB's NGINX reverse-proxies /drive/* to this app UNCHANGED
// (no path stripping — see HUB-AEGIS_Entry/nginx.conf). Every asset URL and
// apiFetch() call is built from import.meta.env.BASE_URL (src/lib/api.js) so
// the same bundle works standalone at '/' (dev) and mounted at '/drive/' (prod).
//
// dev: vite เสิร์ฟ frontend ที่ :5174/drive/ ส่วน Express API ของ Drive อยู่ที่ :8001
// (mounted ที่ root, ไม่รู้จัก /drive) — proxy จึงต้อง rewrite ตัด /drive ออกก่อนส่งต่อ
// → session cookie (HttpOnly, SameSite=Strict) ไป-กลับได้ตามปกติ same-origin
// (production ไม่ใช้ proxy — Express เสิร์ฟทั้ง dist และ /api จาก origin เดียว
//  ผ่าน nginx ที่ forward /drive/* เข้ามาแบบไม่ตัด prefix)
export default defineConfig({
  base: '/drive/',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/drive/api': {
        target: process.env.AEGIS_DRIVE_API_ORIGIN || 'http://127.0.0.1:8001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/drive/, ''),
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
