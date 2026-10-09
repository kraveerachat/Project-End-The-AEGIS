// src/lib/vaultPreviewIndexConstants.js — AEGIS Drive (IDEA1) · D-1 separate encrypted preview index · constants
//
// HG-G (2026-10-03, PR #310 reviewed head 89da7f84) approved the named KEEP values below after G.2.
// Other keys remain provisional: six named KEEP_UNMEASURED configuration values retain their current values
// without a measurement claim; padding buckets and backfillConcurrency had no explicit HG-G disposition.
// ⚠️ The markers only ever appear inside encrypted V2 metadata ({ name: '', type: marker }); the server never sees them.
// ⚠️ Pure data — no I/O, no storage, no DOM.

const KiB = 1024
const MiB = 1024 * KiB

export const PREVIEW_INDEX_SCHEMA_VERSION = 1
export const PREVIEW_INDEX_SCHEMA_VERSIONS_READ = Object.freeze([1])

/** encrypted-metadata type of a root catalog object (name is always '') */
export const INDEX_ROOT_MARKER = 'application/vnd.aegis.vault-preview-index-root.v1'
/** encrypted-metadata type of a shard object (name is always '') */
export const INDEX_SHARD_MARKER = 'application/vnd.aegis.vault-preview-index-shard.v1'

/** D-1 writes only these kinds, only with this profile (motion/proxy are later phases) */
export const D1_WRITE_KINDS = Object.freeze(['thumb', 'poster'])
export const D1_WRITE_PROFILE = 'vp1'
/** the only derivative MIME types D-1 ever renders — never HTML, SVG or XML */
export const DERIVATIVE_MIMES = Object.freeze(['image/webp', 'image/jpeg'])

/** preview-index upload family (server route arrives in PR-C behind VAULT_PREVIEW_INDEX_WRITE_ENABLED) */
export const PREVIEW_INDEX_UPLOAD_ROUTE_BASE = '/api/vault/tree/preview-index/uploads'

export const PREVIEW_INDEX_LIMITS = Object.freeze({
  /** 64 routing prefixes at start (design §7 target) */
  initialPrefixBits: 6,
  /** one split level → at most 2^7 = 128 live shards */
  maxPrefixBits: 7,
  maxShards: 128,
  maxShardDecodedBytes: 192 * KiB,
  shardPaddingBuckets: Object.freeze([16 * KiB, 32 * KiB, 64 * KiB, 128 * KiB, 256 * KiB]),
  /** root plaintext + 5-byte padding trailer fits the last root bucket */
  maxRootDecodedBytes: 16 * KiB - 5,
  rootPaddingBuckets: Object.freeze([4 * KiB, 8 * KiB, 16 * KiB]),
  maxEntriesPerCas: 16,
  casMaxAttempts: 5,
  writeQueueMax: 64,
  backfillMaxPerSession: 50,
  backfillConcurrency: 1,
  derivativeLaneConcurrency: 6,
  ciphertextLruBytes: 32 * MiB,
  maxLiveDecodedShards: 16,
  generationBudgetMs: 10_000,
  /** canonical JSON nesting limit for root/shard documents (structural, not a capacity limit) */
  maxJsonDepth: 8,
})

/** Written Human HG-G decision; approval applies only to APPROVED_KEYS. */
export const HG_G_APPROVAL = Object.freeze({
  date: '2026-10-03',
  source: 'HG_G_APPROVED / PR #310 / 89da7f84d7279871f6e10df5df3e6b78594e5ef8',
})
export const APPROVED_KEYS = Object.freeze([
  'initialPrefixBits', 'maxPrefixBits', 'maxShards', 'maxShardDecodedBytes',
  'maxRootDecodedBytes', 'maxEntriesPerCas', 'ciphertextLruBytes',
])
/** Not approved as measured limits; includes Human-accepted unchanged KEEP_UNMEASURED values. */
export const PROVISIONAL_KEYS = Object.freeze(Object.keys(PREVIEW_INDEX_LIMITS)
  .filter((k) => k !== 'maxJsonDepth' && !APPROVED_KEYS.includes(k)))
