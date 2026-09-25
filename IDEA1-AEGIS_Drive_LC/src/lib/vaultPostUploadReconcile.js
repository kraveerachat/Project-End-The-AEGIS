// One deterministic barrier for the two authoritative facts produced by a TREE upload:
// the encrypted manifest head and the opaque blob inventory. Neither fact is sufficient alone.
export async function reconcileVaultAfterUpload({ reloadHead, reloadInventory, onReconciled = null }) {
  if (typeof reloadHead !== 'function' || typeof reloadInventory !== 'function') {
    throw new TypeError('reconcileVaultAfterUpload requires both reload functions')
  }
  const results = await Promise.all([reloadHead(), reloadInventory()])
  onReconciled?.()
  return results
}
