#!/usr/bin/env bash
# LVR read-only acceptance handler. No apply, rollback, marker or Production write exists.
set -euo pipefail
[ "${AEGIS_LVR_LIVE_AUTHORIZED:-}" = YES ] || { echo 'LVR_VERIFY=FAIL reason=LIVE_AUTHORIZATION_REQUIRED' >&2; exit 1; }
[ -n "${AEGIS_LVR_RUNTIME_VERIFY:-}" ] || { echo 'LVR_VERIFY=FAIL reason=RUNTIME_VERIFIER_REQUIRED' >&2; exit 1; }
EXTRA_ARGS=()
[ -z "${AEGIS_LVR_SYSTEMD_FIXTURE:-}" ] || EXTRA_ARGS+=(--systemd-fixture "$AEGIS_LVR_SYSTEMD_FIXTURE")
[ -z "${AEGIS_LVR_NOW:-}" ] || EXTRA_ARGS+=(--now "$AEGIS_LVR_NOW")
[ -z "${AEGIS_LVR_DEVICE_ID:-}" ] || EXTRA_ARGS+=(--device-id "$AEGIS_LVR_DEVICE_ID")
exec /usr/bin/python3 -I "$AEGIS_LVR_RUNTIME_VERIFY" \
  --status "${AEGIS_LVR_STATUS_PATH:?}" \
  --audit-db "${AEGIS_LVR_AUDIT_DB:?}" \
  --recovery-marker "${AEGIS_LVR_RECOVERY_MARKER:?}" \
  --max-age "${AEGIS_LVR_MAX_AGE_SECONDS:-300}" \
  "${EXTRA_ARGS[@]}"
