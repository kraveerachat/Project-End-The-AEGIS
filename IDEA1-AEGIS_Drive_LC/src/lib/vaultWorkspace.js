// Private Vault workspace derivation. Every value passed here already came from
// the decrypted in-memory manifest; this module performs no I/O and persists nothing.

export const VAULT_TYPE_FILTERS = Object.freeze([
  'all', 'images', 'videos', 'documents', 'archives', 'other',
])

export const VAULT_SORT_MODES = Object.freeze([
  'name-asc', 'name-desc', 'uploaded-desc', 'uploaded-asc',
  'modified-desc', 'modified-asc', 'size-desc', 'size-asc',
])

export const DEFAULT_VAULT_SORT = 'modified-desc'

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
const ARCHIVE_EXTS = new Set(['zip', '7z', 'rar', 'tar', 'gz', 'bz2', 'xz'])
const DOCUMENT_EXTS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf'])

const extOf = (node) => {
  const name = String(node?.name ?? '')
  const at = name.lastIndexOf('.')
  return at > -1 ? name.slice(at + 1).toLowerCase() : ''
}

export function vaultFileType(node) {
  if (node?.kind !== 'file') return 'folder'
  const mime = String(node.mediaType ?? '').toLowerCase()
  const ext = extOf(node)
  if (mime.startsWith('image/')) return 'images'
  if (mime.startsWith('video/')) return 'videos'
  if (mime === 'application/pdf' || mime.startsWith('text/') || DOCUMENT_EXTS.has(ext)) return 'documents'
  if (/zip|compressed|archive|tar|gzip|7z|rar/.test(mime) || ARCHIVE_EXTS.has(ext)) return 'archives'
  return 'other'
}

const idOf = (node) => String(node?.nodeId ?? '')
const uploadedOf = (node) => Number(node?.createdAt ?? node?.created ?? node?.modifiedAt ?? node?.modified ?? 0)
const modifiedOf = (node) => Number(node?.modifiedAt ?? node?.modified ?? uploadedOf(node))
const sizeOf = (node) => Number(node?.plainSize ?? node?.size ?? 0)

function sortNodes(nodes, requestedMode) {
  const mode = VAULT_SORT_MODES.includes(requestedMode) ? requestedMode : DEFAULT_VAULT_SORT
  const [field, direction] = mode.split('-')
  const sign = direction === 'asc' ? 1 : -1
  const primary = field === 'name'
    ? (a, b) => collator.compare(String(a.name ?? ''), String(b.name ?? ''))
    : field === 'size'
      ? (a, b) => sizeOf(a) - sizeOf(b)
      : field === 'uploaded'
        ? (a, b) => uploadedOf(a) - uploadedOf(b)
        : (a, b) => modifiedOf(a) - modifiedOf(b)
  return [...nodes].sort((a, b) => (sign * primary(a, b)) || idOf(a).localeCompare(idOf(b)))
}

export function deriveVaultWorkspace(nodes, { query = '', typeFilter = 'all', sort = DEFAULT_VAULT_SORT } = {}) {
  const needle = String(query).trim().toLocaleLowerCase()
  const filter = VAULT_TYPE_FILTERS.includes(typeFilter) ? typeFilter : 'all'
  const folders = []
  const files = []

  for (const node of nodes ?? []) {
    const matchesQuery = needle === '' || String(node?.name ?? '').toLocaleLowerCase().includes(needle)
    if (!matchesQuery) continue
    if (node?.kind === 'folder') {
      folders.push(node)
      continue
    }
    if (filter === 'all' || vaultFileType(node) === filter) files.push(node)
  }

  return { folders: sortNodes(folders, sort), files: sortNodes(files, sort) }
}
