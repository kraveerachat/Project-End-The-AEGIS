import React from 'react'
import { FlaskConical } from 'lucide-react'
import { makeT } from '../lib/i18n.js'

export function DemoBanner({ mode, language = 'th' }) {
  if (mode !== 'DEMO') return null
  const t = makeT(language)
  return (
    <div className="demo-banner" role="status">
      <FlaskConical size={17} aria-hidden="true" />
      <strong>DEMO</strong>
      <span>{t('demo.message')}</span>
    </div>
  )
}
