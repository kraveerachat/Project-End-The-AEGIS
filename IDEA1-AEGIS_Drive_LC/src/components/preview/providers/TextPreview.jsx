// src/components/preview/providers/TextPreview.jsx — AEGIS Drive (IDEA1) · Unified Preview P1 · plain/source text (spec §18.2)
//
// ⚠️ Inert by construction: the text is a React child of <pre> (a text node, escaped by React). There is
//    no dangerouslySetInnerHTML, no iframe, no Blob URL with an HTML type — an .html or .svg file shows its
//    source, it never runs. (tests/previewText.test.js asserts no script/svg/iframe/img element exists.)
import { fmtBytes } from '../../../lib/format.js'

/** shared "only the head is shown" notice */
export function TruncatedNotice({ t, maxBytes }) {
  return (
    <p data-preview-truncated="1" role="note" className="text-[12px] text-ink-3 px-4 pt-3">
      {t('previewTextTruncated', { size: fmtBytes(maxBytes) })}
    </p>
  )
}

/**
 * @param {{ t: Function, text: string, truncated?: boolean, maxBytes: number }} props
 */
export function TextPreview({ t, text, truncated = false, maxBytes }) {
  return (
    <div className="w-full self-stretch flex flex-col" data-preview-provider="text-plain">
      {truncated && <TruncatedNotice t={t} maxBytes={maxBytes} />}
      <pre
        tabIndex={0}
        className="m-0 p-4 text-[12.5px] leading-[1.55] text-ink whitespace-pre-wrap break-words overflow-auto text-left"
        style={{ maxHeight: '62vh', fontFamily: 'var(--font-mono, ui-monospace, monospace)', tabSize: 4 }}
      >
        {text}
      </pre>
    </div>
  )
}
