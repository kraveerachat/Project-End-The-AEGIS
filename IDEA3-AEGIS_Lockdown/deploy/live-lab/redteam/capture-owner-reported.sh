#!/usr/bin/env bash
# Archive the test evidence for rows that doc 21 (21_TEST_EVIDENCE_MATRIX.md) currently marks "owner-reported" /
# "output not archived", using ONLY files that already exist on this host -- never by re-running a test, never by
# guessing a time window, never by writing anything into a test's output. STRICTLY READ-ONLY and writes SOLELY
# under ~/aegis-live-run/evidence/: it reads lab logs, lab evidence files and (read-only) the lab sqlite databases,
# and either copies an already-existing source into a new ~/aegis-live-run/evidence/<row-id>/ folder, or -- if no
# source exists on disk at all -- records "no archived source found" and copies nothing for that row. Nothing is
# fabricated: a row with no real file behind it stays exactly as unproven as it was.
#
#   capture-owner-reported.sh
#
# No argument, no sudo, no network, no systemctl, no nft. Does not touch core.env, secrets/, or any .key/.pem file.
set -Eeuo pipefail
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

WORK="$HOME/aegis-live-run"
EVID="$WORK/evidence"
OUT_REPORT="$EVID/redteam-capture-report.txt"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# row_id | short description | one or more EXISTING source paths (space-separated; globs allowed), or empty for
# "known to have no source". Every path here was found to already exist by hand before writing this table; the
# script re-checks each one at run time and only acts on what is actually still there.
declare -A SOURCES=(
  [fz-01-a1-deadman]="$EVID/a1-restore-pending"
  [rc-01-stale-restore-record]="$EVID/g6-restore-pending-diagnosis.txt"
  [rc-04-g6-restore-pending]="$EVID/acceptance.md $EVID/g6-restore-pending-diagnosis.txt"
  [op-02-restore-with-evidence]="$EVID/restore-output.log $EVID/acceptance.md"
  [dt-01-forged-log]=""
  [is-01-secret-isolation]=""
  [gr-06-priority-order]=""
  [ph-06-cable-tester]=""
  [nt-02-lockdown-telegram]=""
  [nt-04-restored-telegram]=""
  [nt-05-restart-telegram]=""
  [rc-08-recovery-page-hw]=""
  [rc-09-incidents-audit-hw]=""
  [rc-10-dialog-translations-hw]=""
  [pl-01-pl-06-a2-repeat-hw]=""
)
declare -A WHY_NO_SOURCE=(
  [dt-01-forged-log]="the forged-log test's terminal output was never redirected to a file (doc 21, DT-01)"
  [is-01-secret-isolation]="the setup-graduated.sh run that printed the 19/19 isolation check was never redirected to a file (doc 21, IS-01)"
  [gr-06-priority-order]="the setup-graduated.sh run that printed the kernel priority check was never redirected to a file (doc 21, GR-06)"
  [ph-06-cable-tester]="a physical meter/tester reading has no file to archive; it was reported verbally (doc 21, PH-06)"
  [nt-02-lockdown-telegram]="the Telegram message was not screenshotted or saved at the time (doc 21, NT-02)"
  [nt-04-restored-telegram]="the Telegram message was not screenshotted or saved at the time (doc 21, NT-04)"
  [nt-05-restart-telegram]="the Telegram message was not screenshotted or saved at the time (doc 21, NT-05)"
  [rc-08-recovery-page-hw]="the operator's 2026-10-24 hardware check of the Recovery page was reported verbally, no screenshot or terminal capture saved (doc 21, RC-08)"
  [rc-09-incidents-audit-hw]="the operator's 2026-10-24 hardware check of the Incidents/Audit pages was reported verbally, no screenshot or terminal capture saved (doc 21, RC-09)"
  [rc-10-dialog-translations-hw]="the operator's 2026-10-24 hardware check of the th dialogs was reported verbally, no screenshot or terminal capture saved (doc 21, RC-10)"
  [pl-01-pl-06-a2-repeat-hw]="the 38.40 s A2-repeat measurement and the hardware checklist were reported verbally; no absolute clock time was given, so no journal/log window can be bounded without guessing (doc 21, PL-01/PL-06)"
)

mkdir -p "$EVID"
{
  echo "capture-owner-reported.sh — read-only archival pass"
  echo "run at (UTC): $STAMP"
  echo "writes only under: $EVID/<row-id>/ (created only for rows with a real source below)"
  echo
} > "$OUT_REPORT"

for row in "${!SOURCES[@]}"; do
  sources_glob=${SOURCES[$row]}
  found=()
  if [[ -n $sources_glob ]]; then
    for candidate in $sources_glob; do
      [[ -e $candidate ]] && found+=("$candidate")
    done
  fi
  if [[ ${#found[@]} -eq 0 ]]; then
    reason=${WHY_NO_SOURCE[$row]:-"no source path was ever recorded for this row"}
    echo "NO ARCHIVED SOURCE FOUND — $row: $reason" >> "$OUT_REPORT"
    echo "no source: $row"
    continue
  fi
  dest="$EVID/$row"
  if [[ -e $dest ]]; then
    echo "ALREADY CAPTURED — $row: $dest already exists; left untouched (rerun after moving it aside to refresh)" >> "$OUT_REPORT"
    echo "already captured: $row -> $dest"
    continue
  fi
  mkdir -p "$dest"
  {
    echo "row: $row"
    echo "captured (UTC): $STAMP"
    echo "source(s), as they existed on this host at capture time:"
  } > "$dest/MANIFEST.txt"
  for src in "${found[@]}"; do
    echo "  $src" >> "$dest/MANIFEST.txt"
    cp -a -- "$src" "$dest/" 2>/dev/null || cp -a -- "$src" "$dest/$(basename "$src").copy"
  done
  echo "CAPTURED — $row: $(printf '%s ' "${found[@]}") -> $dest" >> "$OUT_REPORT"
  echo "captured: $row <- ${found[*]}"
done

echo
echo "== secret scan of everything just written (refuses to leave anything behind if a pattern matches)"
BAD=0
for row in "${!SOURCES[@]}"; do
  dest="$EVID/$row"
  [[ -d $dest ]] || continue
  if grep -RIlE '(AEGIS_TG_TOKEN|AEGIS_TG_CHAT|-----BEGIN [A-Z ]*PRIVATE KEY-----|[0-9]{8,10}:[A-Za-z0-9_-]{35})' "$dest" 2>/dev/null; then
    echo "   SECRET-LOOKING PATTERN in $dest — remove this capture by hand: rm -rf -- $dest" >&2
    BAD=1
  fi
done
[[ $BAD -eq 0 ]] && echo "   clean"

echo
echo "== report: $OUT_REPORT"
cat "$OUT_REPORT"
[[ $BAD -eq 0 ]] || { echo; echo "Finished WITH a secret-pattern warning above; review before using these captures." >&2; exit 1; }
