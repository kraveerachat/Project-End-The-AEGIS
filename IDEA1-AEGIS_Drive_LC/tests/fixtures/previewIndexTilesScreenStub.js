// Screen-only seam: real encrypted reader/crypto is covered by previewIndexTiles.test.js.
// This fixture lets jsdom prove the Vault screen consumes a derivative result before original I/O.
export function createPreviewIndexTiles() {
  const ctl = globalThis.__VAULT_BACKEND__
  return {
    async load() { ctl.indexLoads = (ctl.indexLoads ?? 0) + 1; return { status: 'READY' } },
    async tryTile(node, kind) {
      ctl.indexAttempts = (ctl.indexAttempts ?? 0) + 1
      return ctl.indexTile?.(node, kind) ?? null
    },
    clear() {},
  }
}
