#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — Stage L8u rollback handler: there is nothing to roll back. L8u performs no device action and no Core-host change, so rollback performs NONE either: no restart, no flash,
# no reset, no MQTT. A failed L8u is FAIL_IMMUTABLE (attempt consumed, no automatic retry); the evidence is preserved for owner inspection.
set -Eeuo pipefail
printf 'L8U_ROLLBACK=NOT_REQUIRED reason=NO_MUTATION\nESP32_TOUCHED=NO\n'
