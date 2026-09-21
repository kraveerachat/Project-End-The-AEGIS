#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L6a rollback handler.
# Defends against PID recycling and reuse via boot_id and /proc/$PID/stat start_time.
set -euo pipefail

fail() {
  printf "L6A_ROLLBACK=FAIL reason=%s\n" "$1" >&2
  exit 1
}

WORK_DIR="${AEGIS_L6A_WORK_DIR:-}"
if [ -z "$WORK_DIR" ] || [ ! -d "$WORK_DIR" ]; then
  # Idempotent return if no work dir
  printf "L6A_ROLLBACK=PASS\n"
  exit 0
fi

PROCESS_FILE="$WORK_DIR/broker-process.json"
if [ -f "$PROCESS_FILE" ]; then
  python3 - <<'EOF' "$PROCESS_FILE"
import json
import os
import signal
import sys
import time
from pathlib import Path

proc_file = Path(sys.argv[1])
try:
    data = json.loads(proc_file.read_text(encoding="utf-8"))
except Exception as exc:
    print(f"Failed to read process metadata: {exc}", file=sys.stderr)
    sys.exit(0)

pid = data.get("pid")
if not pid or not isinstance(pid, int):
    sys.exit(0)

# Check if process is running
try:
    os.kill(pid, 0)
except OSError:
    # Process not running
    sys.exit(0)

# Verify boot_id
recorded_boot_id = data.get("boot_id", "")
boot_id_file = Path("/proc/sys/kernel/random/boot_id")
if boot_id_file.is_file():
    current_boot_id = boot_id_file.read_text(encoding="utf-8").strip()
    if recorded_boot_id and current_boot_id != recorded_boot_id:
        print("WARNING: boot_id mismatch, PID reuse detected; S-11 HOLD", file=sys.stderr)
        sys.exit(1)

# Verify start_time from /proc/$PID/stat
stat_file = Path(f"/proc/{pid}/stat")
if stat_file.is_file():
    try:
        content = stat_file.read_text(encoding="utf-8")
        after_comm = content.split(")")[-1].split()
        current_start_time = after_comm[19]
        recorded_start_time = data.get("start_time", "")
        if recorded_start_time and current_start_time != recorded_start_time:
            print("WARNING: start_time mismatch, PID reuse detected; S-11 HOLD", file=sys.stderr)
            sys.exit(1)
    except Exception as exc:
        print(f"WARNING: stat check failed ({exc}); S-11 HOLD", file=sys.stderr)
        sys.exit(1)
else:
    sys.exit(0)

# Verify executable
exe_path = Path(f"/proc/{pid}/exe")
if exe_path.exists():
    try:
        real_exe = str(exe_path.resolve())
        recorded_exe = data.get("executable", "")
        if recorded_exe and real_exe != recorded_exe and not real_exe.endswith("mosquitto"):
            print("WARNING: exe mismatch; S-11 HOLD", file=sys.stderr)
            sys.exit(1)
    except Exception:
        pass

# Terminate process safely
try:
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
            time.sleep(0.05)
        except OSError:
            break
    else:
        os.kill(pid, signal.SIGKILL)
except OSError:
    pass
EOF
fi

# Clean up ephemeral sensitive/runtime materials in WORK_DIR
rm -f "$WORK_DIR/passwords" "$WORK_DIR/aegis.acl" "$WORK_DIR/mosquitto.conf" "$WORK_DIR/broker-process.json"

# Write rollback evidence
ROLLBACK_TMP="$WORK_DIR/rollback-evidence.tsv.tmp"
ROLLBACK_FINAL="$WORK_DIR/rollback-evidence.tsv"
cat > "$ROLLBACK_TMP" <<EOF
schema	1
stage	L6a
action	ROLLBACK
result	PASS
timestamp	$(date -u +%FT%TZ)
EOF
mv "$ROLLBACK_TMP" "$ROLLBACK_FINAL"
chmod 0600 "$ROLLBACK_FINAL"

printf "L6A_ROLLBACK=PASS\n"
exit 0
