// src/lib/vaultNameSuggestions.js — AEGIS Drive (IDEA1) · PR220-R1 · migration collision suggestions
//
// Editable PROPOSALS for the migration collision step. This is presentation help, not a
// rename: vaultTreeMigration.resolveCollisions still applies only names the Human confirmed
// by pressing Continue, and nothing is written before that. No blob byte is touched.
//
// Collision semantics are exactly TREE's (collisionKey = NFC + case fold), so a suggestion
// can never be "unique" here and colliding on the server/tree.
import { collisionKey } from './vaultTreeManifest.js'

function splitExtension(name) {
  const dot = name.lastIndexOf('.')
  // a leading dot (".env") or a trailing dot is not an extension separator
  if (dot <= 0 || dot === name.length - 1) return [name, '']
  return [name.slice(0, dot), name.slice(dot)]
}

/**
 * For each collision group the first member keeps its name; every later member gets
 * "base (n).ext" with the smallest n ≥ 2 whose collision key is unused by ANY name in the plan
 * (including suggestions already assigned). Deterministic for a given plan order.
 * @param {{ entries: Array<{name:string}>, collisions: Array<{ entries: Array<object> }> }} plan
 * @returns {Map<object, string>} entry → suggested name (only for renamed entries)
 */
export function suggestCollisionNames(plan) {
  const out = new Map()
  const taken = new Set((plan?.entries ?? []).map((e) => collisionKey(e.name)))
  for (const group of plan?.collisions ?? []) {
    for (const entry of group.entries.slice(1)) {
      const [base, ext] = splitExtension(entry.name)
      let n = 2
      let candidate = `${base} (${n})${ext}`
      while (taken.has(collisionKey(candidate))) {
        n += 1
        candidate = `${base} (${n})${ext}`
      }
      taken.add(collisionKey(candidate))
      out.set(entry, candidate)
    }
  }
  return out
}

/**
 * Why the Human's current names cannot be committed yet, or null when they can.
 * Checks the whole plan, because a rename may collide with an item outside its group.
 * @param {Array<{name:string}>} entries plan entries
 * @param {Map<object,string>} decisions entry → name typed/accepted by the Human
 * @param {(name:string)=>string|null} nameProblem TREE name validator
 * @returns {null | { kind: 'invalid'|'collision', name: string, entries: Set<object> }}
 */
export function collisionStepProblem(entries, decisions, nameProblem) {
  const nameOf = (e) => (decisions?.has(e) ? decisions.get(e) : e.name)
  for (const e of entries) {
    if (nameProblem(nameOf(e))) return { kind: 'invalid', name: nameOf(e), entries: new Set([e]) }
  }
  const byKey = new Map()
  for (const e of entries) {
    const k = collisionKey(nameOf(e))
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(e)
  }
  for (const members of byKey.values()) {
    if (members.length > 1) return { kind: 'collision', name: nameOf(members[members.length - 1]), entries: new Set(members) }
  }
  return null
}

/**
 * PR220-R2 B3 — editable proposal for "Recover with a new name". Same TREE semantics
 * (collisionKey = NFC + case fold): the original name when it is free in the destination,
 * otherwise "base (n).ext" with the smallest n ≥ 2 that no sibling uses. Presentation help
 * only — nothing is committed until the Human confirms the (possibly edited) name.
 * @param {string} name decrypted orphan name
 * @param {string[]} siblingNames active names already in the destination folder
 * @returns {string}
 */
export function suggestRecoveryName(name, siblingNames) {
  const taken = new Set((siblingNames ?? []).map((s) => collisionKey(s)))
  if (!taken.has(collisionKey(name))) return name
  const [base, ext] = splitExtension(name)
  let n = 2
  let candidate = `${base} (${n})${ext}`
  while (taken.has(collisionKey(candidate))) {
    n += 1
    candidate = `${base} (${n})${ext}`
  }
  return candidate
}
