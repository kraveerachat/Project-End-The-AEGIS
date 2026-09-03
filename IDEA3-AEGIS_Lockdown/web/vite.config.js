import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/security/',
  plugins: [react()],
  server: {
    proxy: {
      '/security/api': {
        target: process.env.AEGIS_IDEA3_API_ORIGIN || 'http://127.0.0.1:8003',
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/security/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    restoreMocks: true,
  },
})
