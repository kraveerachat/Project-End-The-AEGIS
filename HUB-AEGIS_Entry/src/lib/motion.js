// One motion vocabulary for the pre-auth vault (DESIGN.md · Motion).
// SPRING drives every layout move of the expanding card — weighted,
// barely-there overshoot, so the vault feels physical, not springy.
// EASE is the house curve (--ease) for plain fades and exits.
export const EASE = [0.32, 0.72, 0, 1]
export const SPRING = { type: 'spring', bounce: 0.15, duration: 0.6 }
