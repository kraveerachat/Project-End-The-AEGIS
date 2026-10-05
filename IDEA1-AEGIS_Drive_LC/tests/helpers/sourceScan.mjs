// tests/helpers/sourceScan.mjs — forbidden-primitive scanner for source guards.
//
// Browser storage outlives the Vault lock and the tab, and console output lands in devtools logs and crash
// reports; neither may ever see plaintext names, sizes or key material. Returns the matched snippets.
const FORBIDDEN = [
  /\blocalStorage\b/g,
  /\bsessionStorage\b/g,
  /\bindexedDB\b/g,
  /\bcaches\.open\b/g,
  /\bconsole\.\w+/g,
]

export function scanForbidden(sourceText) {
  const hits = []
  for (const re of FORBIDDEN) {
    for (const m of String(sourceText).matchAll(re)) hits.push(m[0])
  }
  return hits
}
