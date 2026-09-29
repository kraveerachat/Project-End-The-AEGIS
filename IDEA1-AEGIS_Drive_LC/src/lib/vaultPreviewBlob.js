// Preserve decrypted bytes exactly when turning a bounded Vault preview into
// an ephemeral object URL. V2 buffered downloads return an array of chunks;
// wrapping that array in another array stringifies the chunks and corrupts the
// media stream.
export function createVaultPreviewBlob(bytes, type = 'application/octet-stream') {
  const parts = Array.isArray(bytes) ? bytes : [bytes]
  return new Blob(parts, { type })
}
