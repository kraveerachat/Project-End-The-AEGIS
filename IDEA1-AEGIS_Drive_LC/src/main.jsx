import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './neoDarkApp.css'
import './neoDashboard.css'
import './neoOverlays.css'
import './neoSelect.css'
import './neoNavigation.css'
import './neoLight.css'
// Classic = Glossy Enamel (PR #388). It supersedes PR #359's Classic Precision layer,
// so classicPrecision.css is no longer imported; every rule is [data-ui-style="classic"].
import './theme-classic.css'
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
