// src/components/preview/providers/TextFamilyPreview.jsx — AEGIS Drive (IDEA1) · Unified Preview P1
//
// Text-family body for the shared preview shell. `TextBody` picks the renderer from the provider id;
// `TextFamilyPreview` additionally loads the bounded head (Files: one Range request to /preview).
// ⚠️ Every renderer produces React text nodes / elements only — never HTML strings.
import { useEffect, useState } from 'react'
import { TextPreview } from './TextPreview.jsx'

/**
 * @param {{ t: Function, provider: string|null, text: string, truncated: boolean, maxBytes: number }} props
 */
export function TextBody({ t, text, truncated, maxBytes }) {
  return <TextPreview t={t} text={text} truncated={truncated} maxBytes={maxBytes} />
}

/**
 * @param {{ t: Function, provider: string|null, load: (signal: AbortSignal) => Promise<{ text: string, truncated: boolean }>,
 *   maxBytes: number, onPhase?: (phase: 'ready'|'failed') => void }} props
 */
export function TextFamilyPreview({ t, provider, load, maxBytes, onPhase }) {
  const [state, setState] = useState(null)
  useEffect(() => {
    const ctrl = new AbortController()
    let live = true
    setState(null)
    load(ctrl.signal).then(
      (r) => { if (live) { setState(r); onPhase?.('ready') } },
      () => { if (live) onPhase?.('failed') },
    )
    return () => { live = false; ctrl.abort() }
    // `load` identity changes with the file; onPhase is a stable setter in every caller
  }, [load])
  if (!state) return null
  return <TextBody t={t} provider={provider} text={state.text} truncated={state.truncated} maxBytes={maxBytes} />
}
