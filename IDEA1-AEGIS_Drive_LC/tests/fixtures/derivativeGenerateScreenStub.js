// Screen-only seam (D-1 PR-D): jsdom has no createImageBitmap/canvas/video decoder, so the Vault screen's
// thumb/poster generation is answered by the test (globalThis.__VAULT_BACKEND__.generate). The real post-upload queue
// and backfill logic still run; the real generators are covered by vaultDerivativeGenerate.test.js.
import * as real from '/src/lib/vaultDerivativeGenerate.js'

const ctl = () => globalThis.__VAULT_BACKEND__
export const generateThumbFromFile = async (file, o) => (ctl()?.generate ? ctl().generate(file, 'thumb', o) : null)
export const generatePosterFromFile = async (file, o) => (ctl()?.generate ? ctl().generate(file, 'poster', o) : null)
export function createUploadDerivativeQueue(o) {
  return real.createUploadDerivativeQueue({ ...o, generateThumb: generateThumbFromFile, generatePoster: generatePosterFromFile })
}
