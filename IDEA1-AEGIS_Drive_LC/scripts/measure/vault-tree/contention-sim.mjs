// scripts/measure/vault-tree/contention-sim.mjs — PR #157 Phase 0 Task 0.1 · two-client CAS contention
//
// ⚠️ DISPOSABLE. Simulates N clients mutating one generation-CAS head with random
//    intents over a shared random tree. Measures the CAS-loss rate and the depth of
//    rebase retries needed per successful commit at several overlap ratios. It
//    informs the `maxRebaseAttempts` and orphan-revision-retention rows of the
//    Limits Register; it is not a protocol implementation.
//
//   node scripts/measure/vault-tree/contention-sim.mjs --clients 2 --ops 2000 --overlap 0.1,0.3,0.6
//
// Model: each client holds a base generation. An "op" targets a node id chosen from
// a hot set (probability = overlap) or from the whole tree. A commit succeeds iff the
// client's base equals the head; otherwise the client refetches (base = head) and
// retries the same intent unless the intent's target node was changed by a commit it
// missed (a "semantic conflict", counted separately and abandoned). Interleaving is
// random per step, which is the worst case for two always-busy devices.
import { seeded } from './bench-core.js'

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const clients = Number(opt('--clients', '2'))
const ops = Number(opt('--ops', '2000'))
const overlaps = String(opt('--overlap', '0.1,0.3,0.6')).split(',').map(Number)
const treeSize = Number(opt('--tree', '5000'))
const hotSize = Number(opt('--hot', '20'))

for (const overlap of overlaps) {
  const rnd = seeded(42)
  let head = 0
  const changedAt = new Map() // nodeIndex → generation of last change
  const state = Array.from({ length: clients }, () => ({ base: 0, pending: null, attempts: 0, done: 0, lost: 0, conflicts: 0, maxAttempts: 0, attemptsHist: new Map() }))
  let total = 0
  while (total < ops) {
    const c = state[Math.floor(rnd() * clients)]
    if (!c.pending) {
      const hot = rnd() < overlap
      const node = hot ? Math.floor(rnd() * hotSize) : hotSize + Math.floor(rnd() * (treeSize - hotSize))
      c.pending = { node, seenGeneration: c.base }
      c.attempts = 0
    }
    c.attempts++
    if (c.base === head) {
      head++
      changedAt.set(c.pending.node, head)
      c.base = head
      c.done++; total++
      c.maxAttempts = Math.max(c.maxAttempts, c.attempts)
      c.attemptsHist.set(c.attempts, (c.attemptsHist.get(c.attempts) ?? 0) + 1)
      c.pending = null
    } else {
      c.lost++
      // refetch head; semantic conflict if our target changed since we last saw it
      const last = changedAt.get(c.pending.node) ?? 0
      if (last > c.pending.seenGeneration) { c.conflicts++; total++; c.pending = null }
      c.base = head
      c.pending && (c.pending.seenGeneration = head)
    }
  }
  const done = state.reduce((a, s) => a + s.done, 0)
  const lost = state.reduce((a, s) => a + s.lost, 0)
  const conflicts = state.reduce((a, s) => a + s.conflicts, 0)
  const hist = new Map()
  for (const s of state) for (const [k, v] of s.attemptsHist) hist.set(k, (hist.get(k) ?? 0) + v)
  const p99 = (() => { let acc = 0; const keys = [...hist.keys()].sort((a, b) => a - b); for (const k of keys) { acc += hist.get(k); if (acc / done >= 0.99) return k } return keys.at(-1) })()
  console.log(JSON.stringify({
    clients, ops, treeSize, hotSize, overlap,
    commits: done, casLosses: lost, casLossRatePerAttempt: +(lost / (done + lost)).toFixed(3),
    semanticConflicts: conflicts, conflictRatePerOp: +(conflicts / ops).toFixed(3),
    maxAttemptsToCommit: Math.max(...state.map((s) => s.maxAttempts)), p99AttemptsToCommit: p99,
    attemptsHistogram: Object.fromEntries([...hist.entries()].sort((a, b) => a[0] - b[0])),
  }))
}
