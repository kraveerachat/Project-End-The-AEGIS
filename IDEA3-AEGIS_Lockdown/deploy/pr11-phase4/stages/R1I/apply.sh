#!/usr/bin/env bash
# First-class Phase-4 R1I handler. The implementation remains in the reviewed
# repository-only package; this adapter is the canonical registered surface.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$HERE/../../r1i-input-instrumentation/apply.sh" "$@"
