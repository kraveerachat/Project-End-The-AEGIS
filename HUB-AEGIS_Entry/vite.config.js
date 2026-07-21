import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// HUB เป็น routing-only — ไม่มี /api ของตัวเองอีกต่อไป จึงไม่ต้องมี proxy
// (ระบบตัวตนอยู่ใน IDEA1/IDEA2 — แต่ละแอปมี dev proxy ของตัวเอง)
export default defineConfig({
  plugins: [react(), tailwindcss()],
})
