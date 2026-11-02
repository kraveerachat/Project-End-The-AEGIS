#!/usr/bin/env bash
# OPERATOR runs this. RESTORE through the Core-local recovery channel; you type the RESTORE secret and the
# confirmation yourself. Usage: owner-restore.sh ["reason, 12-240 characters"]
# The device reports NORMAL only after it has acted on the command; confirm the relay with a meter, not with the ACK.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-live-lab.sh
. "$HERE/lib-live-lab.sh"

mkdir -p "$LL_EVID"
cd "$LL_APP_DIR"
AEGIS_RUNTIME_DIR="$RUNTIME_DIR" "$(ll_python)" -m aegis_soc.cli restore \
  --reason "${1:-IDEA3 live lab restore}" --wait 60 2>&1 | tee -a "$LL_EVID/restore-output.log"
