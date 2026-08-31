// src/lib/vaultPreviewClaim.js — AEGIS Drive (IDEA1) · claim-on-demand (LFT-V2-E3.2)
//
// ⚠️ Why this is a module rather than four lines inside the Service Worker:
//    src/vaultPreviewServiceWorker.js cannot be exercised by node:test, so every
//    line written there is a line with no test. The claim handshake is not
//    decoration — it is the difference between a preview that works and one the
//    user must reload the page to fix — so it lives here, where both sides of
//    the contract are pinned by tests.
//
// ⚠️ What this handshake exists for: a Service Worker registration can be
//    `active` and `activated` while `navigator.serviceWorker.controller` is
//    still null on an already-open page. An uncontrolled page's <video>
//    requests never reach the worker's fetch handler at all, so the virtual
//    preview URL resolves against the real server and 404s. Observed in
//    production after PR #55; a manual reload was the only recovery.
//
// ⚠️ What this must never become: an automatic reload. The same uncontrolled
//    state can reproduce on the next load, so a reload is a reload loop waiting
//    to happen — and every reload destroys the in-memory DEK and the unlocked
//    Vault along with it. One message, one bounded wait, then the truth.

/** The single message the page sends to an active-but-not-controlling worker. */
export const PREVIEW_CLAIM_MESSAGE = 'vault-preview-claim'

export function isPreviewClaimRequest(message) {
  return message?.type === PREVIEW_CLAIM_MESSAGE
}

/**
 * Serve one claim request inside the Service Worker.
 *
 * ⚠️ It never throws. This runs on the message path of a worker that may also
 *    be holding keys for a live preview; an exception escaping here would take
 *    the whole message handler with it.
 *
 * @param {{ clients?: object, reply?: (payload: object) => void,
 *           waitUntil?: (promise: Promise<unknown>) => void }} options
 * @returns {Promise<boolean>} whether this page is now claimed
 */
export async function handlePreviewClaimRequest({ clients, reply = () => {}, waitUntil } = {}) {
  if (typeof clients?.claim !== 'function') {
    reply({ ok: false })
    return false
  }

  let pending
  try {
    pending = clients.claim()
  } catch {
    reply({ ok: false })
    return false
  }
  if (!pending?.then) {
    // A synchronous claim() implementation still counts as claimed.
    reply({ ok: true })
    return true
  }

  // ⚠️ Keep the worker alive across the claim, but never let waitUntil see a
  //    rejection: an unhandled one can terminate the worker mid-preview.
  try { waitUntil?.(pending.then(() => {}, () => {})) } catch { /* not extendable */ }

  try {
    await pending
  } catch {
    reply({ ok: false })
    return false
  }
  reply({ ok: true })
  return true
}
