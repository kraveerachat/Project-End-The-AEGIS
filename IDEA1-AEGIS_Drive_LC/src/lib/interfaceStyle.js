const INTERFACE_STYLES = new Set(['classic', 'neo'])

export function normalizeInterfaceStyle(value) {
  return INTERFACE_STYLES.has(value) ? value : 'classic'
}

export function applyAuthenticatedInterfaceStyle(value, targetDocument = globalThis.document) {
  const style = normalizeInterfaceStyle(value)
  if (targetDocument?.documentElement) {
    targetDocument.documentElement.dataset.uiStyle = style
  }
  return style
}

export function clearAuthenticatedInterfaceStyle(targetDocument = globalThis.document) {
  if (targetDocument?.documentElement) {
    delete targetDocument.documentElement.dataset.uiStyle
  }
}
