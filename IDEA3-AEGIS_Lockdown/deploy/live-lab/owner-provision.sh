#!/usr/bin/env bash
# OPERATOR runs this in a terminal. The RESTORE and CUT secrets are typed by you (hidden input) and never pass through any
# tool, log or chat. Creates secrets/restore.credential and secrets/cut.credential (scrypt hashes, mode 0600).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib-live-lab.sh
. "$HERE/lib-live-lab.sh"

PY="$(ll_python)"
mkdir -p "$LL_SECRETS"; chmod 700 "$LL_SECRETS"
cd "$LL_APP_DIR"
echo "1/2: RESTORE secret (minimum length enforced; remember it)"
"$PY" -m aegis_soc.cli restore-credential --output "$LL_SECRETS/restore.credential"
echo "2/2: CUT secret (must be DIFFERENT from the RESTORE secret)"
LL_CUT_OUT="$LL_SECRETS/cut.credential" "$PY" - <<'PYEOF'
import getpass, os
from aegis_soc import local_cut
first = getpass.getpass("New CUT secret: ")
second = getpass.getpass("Repeat CUT secret: ")
if first != second:
    raise SystemExit("mismatch")
local_cut.write_cut_credential(os.environ["LL_CUT_OUT"], first)
print("CUT credential written")
PYEOF
ls -l "$LL_SECRETS"/*.credential
