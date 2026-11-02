#!/usr/bin/env bash
# Snapshot the DEFENDER side of one red-team scenario, READ-ONLY, into
#   ~/aegis-live-run/evidence/redteam/<scenario>-<UTC-start>/
# and (if given) fold the ATTACKER-side output files you saved by hand into the same folder, so the two sides sit
# together as one incident case study. Writes nothing outside that one new folder. No secrets are read or printed:
# it never opens secrets/, core.env, any *.key/*.pem, or a credential file. Run as the operator directly, or
# through sudo if a step needs it; either way it resolves the OPERATOR's home (never root's -- see WORK below), so
# evidence always lands under the operator's own ~/aegis-live-run/evidence/, not /root/.
#
#   collect-evidence.sh SCENARIO START_UTC END_UTC [ATTACKER_OUTPUT_DIR] [ATTACKER_IP]
#
#   SCENARIO            short slug, e.g. g1-scan, g2a-brute, g2b-flood, g2c-distributed, g3-critical
#   START_UTC, END_UTC  ISO-8601 UTC timestamps you recorded by hand when you ran the scenario, e.g.
#                       2026-10-25T10:00:00Z 2026-10-25T10:00:30Z (these bound every journal/log query below)
#   ATTACKER_OUTPUT_DIR optional: a directory holding the files you saved while running the tool by hand
#                       (nmap -oA output, hydra/hping3 output, your own start/end note) -- copied in as-is
#   ATTACKER_IP         optional: the namespace's source IP (attacker-ns-up.sh prints it); if given, every Core
#                       log line is also grepped for it and put in a filtered sub-file
#
# This script only reads: the Core's own structured event log (logs/aegis-events.jsonl), its plain-text log
# (logs/aegis_soc.log), status.json, graduated-status.json, recovery-status.json, the general system journal
# (for the kernel AEGIS_NEWCONN lines and sshd lines the production detector itself reads), the "aegis-live-detector"
# unit's own journal (its [F1-DETECTOR] decisions), and the lab containment helper's block LIST (a read-only
# request over its socket -- never block/unblock). It never writes to any of those; it only copies lines out.
set -Eeuo pipefail
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $# -ge 3 ]] || die "usage: collect-evidence.sh SCENARIO START_UTC END_UTC [ATTACKER_OUTPUT_DIR] [ATTACKER_IP]"
SCENARIO=$1; START=$2; END=$3; ATTACKER_DIR=${4:-}; ATTACKER_IP=${5:-}
[[ $SCENARIO =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "SCENARIO must be a short lowercase slug (letters, digits, hyphens)"
date -u -d "$START" >/dev/null 2>&1 || die "START_UTC is not a time 'date -u -d' can parse: $START"
date -u -d "$END" >/dev/null 2>&1 || die "END_UTC is not a time 'date -u -d' can parse: $END"
[[ -z $ATTACKER_DIR || -d $ATTACKER_DIR ]] || die "ATTACKER_OUTPUT_DIR does not exist: $ATTACKER_DIR"
if [[ -n $ATTACKER_IP ]]; then
  [[ $ATTACKER_IP =~ ^10\.90\.90\.[0-9]+$ ]] || die "ATTACKER_IP does not look like an attacker-namespace address (expected 10.90.90.x): $ATTACKER_IP"
fi

# Resolve the OPERATOR's home, not root's: under sudo, $HOME is root's unless the invoking user is looked up via
# SUDO_USER. Falls back to $HOME when not run through sudo (SUDO_USER unset).
if [[ -n ${SUDO_USER:-} && $SUDO_USER != root ]]; then
  OPERATOR_HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)" || die "could not resolve the home directory of $SUDO_USER"
  [[ -n $OPERATOR_HOME && -d $OPERATOR_HOME ]] || die "SUDO_USER=$SUDO_USER has no usable home directory"
else
  OPERATOR_HOME="$HOME"
fi
WORK="$OPERATOR_HOME/aegis-live-run"
RUNTIME_DIR="/run/aegis-live"
LOGS_DIR="$WORK/logs"
OUT_ROOT="$WORK/evidence/redteam"
STAMP="$(date -u -d "$START" +%Y%m%dT%H%M%SZ)"
OUT="$OUT_ROOT/${SCENARIO}-${STAMP}"
[[ ! -e $OUT ]] || die "$OUT already exists; pick a different START_UTC or move the old folder aside"
mkdir -p "$OUT"
echo "== writing to $OUT"

{
  echo "scenario: $SCENARIO"
  echo "window (UTC, as given):  $START  to  $END"
  echo "collected (UTC):         $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [[ -n $ATTACKER_IP ]] && echo "attacker source IP:      $ATTACKER_IP"
} > "$OUT/00-window.txt"

echo "== 1/7 Core structured events (logs/aegis-events.jsonl), window only"
if [[ -r $LOGS_DIR/aegis-events.jsonl ]]; then
  python3 - "$LOGS_DIR/aegis-events.jsonl" "$START" "$END" > "$OUT/01-core-events.jsonl" <<'PY'
import json, sys
from datetime import datetime, timezone

path, start_s, end_s = sys.argv[1:4]

def parse(s):
    s = s.replace("Z", "+00:00")
    d = datetime.fromisoformat(s)
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)

start, end = parse(start_s), parse(end_s)
with open(path, encoding="utf-8") as handle:
    for line in handle:
        line = line.strip()
        if not line:
            continue
        try:
            doc = json.loads(line)
            at = parse(doc["timestamp"])
        except (ValueError, KeyError):
            continue
        if start <= at <= end:
            print(json.dumps(doc, ensure_ascii=False, sort_keys=True))
PY
  echo "   $(wc -l < "$OUT/01-core-events.jsonl") line(s) in the window"
else
  echo "NOT_AVAILABLE — $LOGS_DIR/aegis-events.jsonl is not readable" > "$OUT/01-core-events.jsonl"
  echo "   not readable: $LOGS_DIR/aegis-events.jsonl"
fi

echo "== 2/7 Core plain-text log (logs/aegis_soc.log), window only, grep by timestamp prefix"
if [[ -r $LOGS_DIR/aegis_soc.log ]]; then
  START_LOCAL="$(date -d "$START" '+%Y-%m-%d %H:%M')"
  END_LOCAL="$(date -d "$END" '+%Y-%m-%d %H:%M')"
  awk -v a="$START_LOCAL" -v b="$END_LOCAL" '{line=substr($0,1,16); if (line >= a && line <= b) print}' \
    "$LOGS_DIR/aegis_soc.log" > "$OUT/02-core-log.txt" || true
  echo "   $(wc -l < "$OUT/02-core-log.txt") line(s) in the window (local time $START_LOCAL to $END_LOCAL)"
else
  echo "NOT_AVAILABLE — $LOGS_DIR/aegis_soc.log is not readable" > "$OUT/02-core-log.txt"
fi

echo "== 3/7 system journal: kernel AEGIS_NEWCONN lines and sshd lines the detector itself reads"
journalctl --utc --since "$START" --until "$END" -o short-iso -g 'AEGIS_NEWCONN' --no-pager \
  > "$OUT/03-journal-newconn.txt" 2>&1 || echo "NOT_AVAILABLE — journalctl query failed" > "$OUT/03-journal-newconn.txt"
journalctl --utc --since "$START" --until "$END" -o short-iso _COMM=sshd --no-pager \
  > "$OUT/04-journal-sshd.txt" 2>&1 || echo "NOT_AVAILABLE — journalctl query failed" > "$OUT/04-journal-sshd.txt"
echo "   AEGIS_NEWCONN: $(wc -l < "$OUT/03-journal-newconn.txt") line(s);  sshd: $(wc -l < "$OUT/04-journal-sshd.txt") line(s)"

echo "== 4/7 aegis-live-detector unit's own decisions ([F1-DETECTOR] lines), if the unit ran"
journalctl --utc --since "$START" --until "$END" -u aegis-live-detector -o cat --no-pager \
  > "$OUT/05-detector-unit.txt" 2>&1 || echo "NOT_AVAILABLE — unit not found or journalctl query failed" > "$OUT/05-detector-unit.txt"
echo "   $(wc -l < "$OUT/05-detector-unit.txt") line(s)"

echo "== 5/7 current Core projections (status.json, graduated-status.json, recovery-status.json) — a snapshot now, not of the window"
for f in status.json graduated-status.json recovery-status.json; do
  if [[ -r $RUNTIME_DIR/$f ]]; then
    python3 -c "import json,sys; json.dump(json.load(open(sys.argv[1])), sys.stdout, indent=2, sort_keys=True)" "$RUNTIME_DIR/$f" \
      > "$OUT/06-${f%.json}.json" 2>/dev/null || cp "$RUNTIME_DIR/$f" "$OUT/06-${f%.json}.json"
  else
    echo "NOT_AVAILABLE — $RUNTIME_DIR/$f is not readable" > "$OUT/06-${f%.json}.json"
  fi
done
echo "   copied what was readable of: status.json, graduated-status.json, recovery-status.json"

echo "== 6/7 containment block list (read-only 'list' request; never block/unblock)"
LAB_SOCK="/run/aegis-live-containment/containment.sock"   # the LAB socket only; the production one is never touched
if [[ -S $LAB_SOCK ]]; then
  AEGIS_CONTAINMENT_SOCKET="$LAB_SOCK" PYTHONDONTWRITEBYTECODE=1 "$WORK/venv/bin/python" -c "
import json, sys
sys.path.insert(0, '$WORK/repo/IDEA3-AEGIS_Lockdown')
from aegis_soc.ip_containment import ContainmentClient, ContainmentUnavailable
try:
    r = ContainmentClient().list()
except ContainmentUnavailable as error:
    print(json.dumps({'ok': False, 'reason_code': 'UNAVAILABLE', 'detail': type(error).__name__}))
    sys.exit(0)
print(json.dumps(r, sort_keys=True))
" > "$OUT/07-containment-list.json" 2>&1 || echo '{"ok": false, "reason_code": "SCRIPT_FAILED"}' > "$OUT/07-containment-list.json"
else
  echo '{"ok": false, "reason_code": "NOT_AVAILABLE", "detail": "lab containment socket not present"}' > "$OUT/07-containment-list.json"
fi
cat "$OUT/07-containment-list.json"

echo "== 7/7 decision timeline (detector-seen -> score -> level -> action -> outcome) built from 01/03/04/05 above"
python3 - "$OUT" > "$OUT/08-timeline.txt" <<'PY'
import glob, json, re, sys
from datetime import datetime

out = sys.argv[1]
rows = []

# Core's own structured decisions (graduated_decision, graduated_cut_issued/refused, production_alert).
try:
    with open(f"{out}/01-core-events.jsonl", encoding="utf-8") as handle:
        for line in handle:
            try:
                doc = json.loads(line)
            except ValueError:
                continue
            event = doc.get("event")
            if event in ("production_alert", "graduated_decision", "graduated_cut_issued", "graduated_cut_refused",
                        "graduated_cut_recommended", "graduated_cut_noop", "graduated_cut_blocked",
                        "graduated_evidence_refused", "graduated_episode_reset"):
                rows.append((doc.get("timestamp", ""), "core", event, doc.get("detail", {})))
except OSError:
    pass

# The detector's own [F1-DETECTOR] lines (its own timestamp is journalctl's, prefixed by -o short-iso elsewhere;
# here we only have -o cat, so these sort after the Core rows with no timestamp of their own -- see the note below).
try:
    with open(f"{out}/05-detector-unit.txt", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line.startswith("[F1-DETECTOR]"):
                rows.append(("", "detector", "f1_detector", line[len("[F1-DETECTOR] "):]))
except OSError:
    pass


def sort_key(row):
    stamp = row[0]
    try:
        return datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min


rows.sort(key=sort_key)
if not rows:
    print("No detector-seen or decision events found in the window. Check that the window covers when the scenario ran,")
    print("and that AEGIS_GRADUATED_RESPONSE=YES was set (setup-graduated.sh) when it ran.")
for stamp, source, event, detail in rows:
    print(f"{stamp or '(no Core timestamp)':25s} {source:9s} {event:28s} {detail}")
PY
echo "   $(grep -c . "$OUT/08-timeline.txt" 2>/dev/null || echo 0) line(s)"

if [[ -n $ATTACKER_IP ]]; then
  echo "== extra: lines mentioning the attacker IP ($ATTACKER_IP), across every file above"
  grep -h -- "$ATTACKER_IP" "$OUT"/0[1-5]*.txt "$OUT"/01-core-events.jsonl 2>/dev/null > "$OUT/09-filtered-by-ip.txt" || true
  echo "   $(wc -l < "$OUT/09-filtered-by-ip.txt") matching line(s)"
fi

if [[ -n $ATTACKER_DIR ]]; then
  echo "== attacker-side files from $ATTACKER_DIR"
  mkdir -p "$OUT/attacker-side"
  cp -a -- "$ATTACKER_DIR"/. "$OUT/attacker-side/"
  find "$OUT/attacker-side" -maxdepth 1 -type f -printf '   copied: %f\n'
fi

echo "== secret scan of what was just written (refuses to leave the folder if anything matches)"
if grep -RIlE '(AEGIS_TG_TOKEN|AEGIS_TG_CHAT|-----BEGIN [A-Z ]*PRIVATE KEY-----|[0-9]{8,10}:[A-Za-z0-9_-]{35})' "$OUT" 2>/dev/null; then
  die "a secret-looking pattern was found in the evidence just written; inspect and remove it by hand, then rerun"
fi
echo "   clean"

echo
echo "OK. Evidence folder: $OUT"
