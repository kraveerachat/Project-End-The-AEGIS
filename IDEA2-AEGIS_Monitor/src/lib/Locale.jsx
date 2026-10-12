import { createContext, useContext, useMemo } from 'react'
import { normalizeLanguage, translate } from './i18n.js'

const Locale = createContext({ lang: 'en', t: (message, params) => translate('en', message, params) })
export function LocaleProvider({ lang, children }) {
  const value = useMemo(() => {
    const normalized = normalizeLanguage(lang)
    return { lang: normalized, t: (message, params) => translate(normalized, message, params) }
  }, [lang])
  // No locale-dependent key: language changes must never remount media/session.
  return <Locale.Provider value={value}>{children}</Locale.Provider>
}
export const useLocale = () => useContext(Locale)
