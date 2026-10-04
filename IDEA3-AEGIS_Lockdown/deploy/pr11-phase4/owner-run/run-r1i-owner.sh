#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — R1I owner-run template.
# This committed template is intentionally inert. The owner freeze workflow
# must create an external, exact-main-pinned runner with fresh Authorization
# and K3 records before any live use. No repository invocation reaches nft.
set -Eeuo pipefail

EXPECTED_MAIN=PIN_MAIN_SHA
OPERATOR_USER=PIN_OPERATOR_USER
OPERATOR_UID=PIN_OPERATOR_UID
for pin in EXPECTED_MAIN OPERATOR_USER OPERATOR_UID; do
  case "${!pin}" in PIN_*) echo "STOP: runner is not pinned ($pin)." >&2; exit 2 ;; esac
done
echo "R1I owner runner is an inert repository template; freeze outside the repository first." >&2
exit 2
