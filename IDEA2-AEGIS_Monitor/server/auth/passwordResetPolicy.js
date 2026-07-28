/** Production stays fail-closed; only the localhost compose stack opts out. */
export function isPasswordResetEnforced(value = process.env.ENFORCE_PASSWORD_RESET) {
  return value !== 'false'
}
