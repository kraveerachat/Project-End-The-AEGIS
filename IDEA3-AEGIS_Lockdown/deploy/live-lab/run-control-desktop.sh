#!/usr/bin/env bash
# Operator control Desktop for the live lab: CUT and RESTORE buttons plus the (read-only) severity panel.
# Run it in your own graphical session. You type the CUT / RESTORE secrets in the window; they are verified by the Core
# and never stored. Needs the Core running (aegis-live-up.sh) and the credentials from owner-provision.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-live-lab.sh
. "$HERE/lib-live-lab.sh"

cd "$LL_APP_DIR"
AEGIS_DESKTOP_CUT_ENABLED=YES \
AEGIS_LOCAL_CUT_SOCKET="$RUNTIME_DIR/cut.sock" \
AEGIS_DESKTOP_RESTORE_ENABLED=YES \
AEGIS_LOCAL_RESTORE_SOCKET="$RUNTIME_DIR/local-restore.sock" \
AEGIS_DESKTOP_STATUS_PATH="$RUNTIME_DIR/status.json" \
AEGIS_RECOVERY_CORE_USER="$CORE_USER" \
exec "$(ll_python)" -m tools.live_purple_control_desktop
