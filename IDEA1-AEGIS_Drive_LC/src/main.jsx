import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { ErrorBoundary } from './components/ErrorBoundary.jsx'

// ErrorBoundary ครอบทั้งแอป — ตาข่ายสุดท้ายกันจอขาวระหว่างเดโม่บนฮาร์ดแวร์จริง
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
