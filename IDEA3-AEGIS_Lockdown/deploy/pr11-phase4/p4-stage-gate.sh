#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — T1 / G-15 fail-closed stage gate (execution
# document §8 K3, §11 S-01/S-02/S-10, §12 fresh authorization). Validates the
# written, same-day authorization record and K3 confirmation for one stage.
# Reads only the two record files; calls no host command and changes nothing.
#
#   bash p4-stage-gate.sh --stage <L0|L1|…|L9> --mode <simulate|live> \
#        --authorization <record> [--k3 <record>]
#
# The gate is necessary, never sufficient. It cannot verify that the stage's
# repository gaps are merged or that the §10 IDEA2 caveat is resolved, so it
# always prints LIVE_STAGE_AUTHORIZED=NO. In live mode a mutating stage also
# fails until a reviewed rollback handler is registered (p4-lib.sh contract);
# T1 registers none.
#
# Record formats (plain ASCII, one key=value per line, no secrets, <= 2048 bytes):
#
#   AEGIS_P4_AUTHORIZATION_V1          AEGIS_P4_K3_CONFIRMATION_V1
#   stage=<stage>                      stage=<stage>
#   date=<YYYY-MM-DD, Asia/Bangkok>    date=<YYYY-MM-DD, Asia/Bangkok>
#   authorizer=music                   confirmed_by=kraveerachat
#   scope=<one line>                   idea1_window_overlap=NONE
#   reference=<link to the written     reference=<link to the written
#              authorization>                     confirmation>
#   + L1/L7: d6_notice=pub, L2: integration_review=kla,
#     L8: recovery_authorization=<link>
#
# Exit 0 = STAGE_GATE=PASS_SIMULATION or PASS_READ_ONLY; 1 = STAGE_GATE=FAIL.
set -uo pipefail
export LC_ALL=C
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=p4-lib.sh
. "$HERE/p4-lib.sh"

STAGE="" MODE="" AUTH="" K3=""
FAILED=0
fail() { FAILED=1; printf 'GATE_FAIL %s\n' "$1"; }
finish() {
  if [ "$FAILED" = 0 ] && ! p4_stage_mutates "$STAGE"; then
    printf 'READ_ONLY_CAPTURE_ALLOWED=YES\n'
    printf 'STAGE_GATE=PASS_READ_ONLY\n'
  elif [ "$FAILED" = 0 ]; then
    printf 'STAGE_GATE=PASS_SIMULATION\n'
  else
    printf 'STAGE_GATE=FAIL\n'
  fi
  printf 'LIVE_STAGE_AUTHORIZED=NO\n'
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
  exit "$FAILED"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --stage) STAGE=${2-} ;;
    --mode) MODE=${2-} ;;
    --authorization) AUTH=${2-} ;;
    --k3) K3=${2-} ;;
    *) fail ARGUMENT_UNKNOWN; finish ;;
  esac
  shift 2 2>/dev/null || shift
done

[ -n "$STAGE" ] || { fail STAGE_MISSING; finish; }
p4_stage_known "$STAGE" || { fail STAGE_UNKNOWN; finish; }
[[ "$MODE" =~ ^(simulate|live)$ ]] || fail MODE_INVALID

TODAY=$(TZ="$P4_WINDOW_TZ" date +%F)
readonly REF_RE='^[A-Za-z0-9][A-Za-z0-9._:/#?=&%+-]{2,199}$'
readonly PLACEHOLDER_RE='(REPLACE|TODO|TBD|CHANGEME|CHANGE-ME|FIXME|XXX)'
readonly DATE_RE='^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
readonly SCOPE_RE='^[\ -~]{1,200}$'
declare -A R

# parse_record FILE MAGIC ALLOWED REQUIRED: strict key=value parse into R.
parse_record() {
  local file=$1 magic=$2 allowed=" $3 " required=$4 line key value first=1
  R=()
  [ -f "$file" ] && [ -r "$file" ] || return 1
  [ "$(wc -c < "$file")" -le 2048 ] || return 1
  # Printable ASCII and newlines only: no CR, tab, escape, or non-ASCII byte.
  [ "$(LC_ALL=C tr -d '\n -~' < "$file" | wc -c)" = 0 ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$first" = 1 ]; then
      [ "$line" = "$magic" ] || return 1
      first=0
      continue
    fi
    [[ "$line" =~ ^([a-z0-9_]+)=(.+)$ ]] || return 1
    key=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
    [[ "$allowed" == *" $key "* ]] || return 1
    [ -z "${R[$key]+set}" ] || return 1
    R[$key]=$value
  done < "$file"
  [ "$first" = 0 ] || return 1
  for key in $required; do [ -n "${R[$key]+set}" ] || return 1; done
  return 0
}

# ── authorization record (S-02) ──────────────────────────────────────────────
AUTH_OK=0
EXTRA=$(p4_stage_auth_extra "$STAGE")
if [ -z "$AUTH" ]; then
  fail AUTHORIZATION_MISSING
elif ! parse_record "$AUTH" AEGIS_P4_AUTHORIZATION_V1 \
  "stage date authorizer scope reference d6_notice integration_review recovery_authorization" \
  "stage date authorizer scope reference $EXTRA"; then
  fail AUTHORIZATION_MALFORMED
elif ! [[ "${R[date]}" =~ $DATE_RE ]] || [ "${R[authorizer]}" != music ] \
  || ! [[ "${R[scope]}" =~ $SCOPE_RE ]] \
  || ! [[ "${R[reference]}" =~ $REF_RE ]] || [[ "${R[reference]^^}" =~ $PLACEHOLDER_RE ]] \
  || { [ -n "${R[d6_notice]+set}" ] && [ "${R[d6_notice]}" != pub ]; } \
  || { [ -n "${R[integration_review]+set}" ] && [ "${R[integration_review]}" != kla ]; } \
  || { [ -n "${R[recovery_authorization]+set}" ] && ! [[ "${R[recovery_authorization]}" =~ $REF_RE ]]; }; then
  fail AUTHORIZATION_MALFORMED
elif [ "${R[stage]}" != "$STAGE" ]; then
  fail AUTHORIZATION_STAGE_MISMATCH
elif [ "${R[date]}" != "$TODAY" ]; then
  fail AUTHORIZATION_STALE
else
  AUTH_OK=1
fi

# ── K3 confirmation (S-01), every Production mutation stage ──────────────────
K3_STATE=NOT_REQUIRED
if p4_stage_mutates "$STAGE"; then
  K3_STATE=INVALID
  if [ -z "$K3" ]; then
    fail K3_MISSING
  elif ! parse_record "$K3" AEGIS_P4_K3_CONFIRMATION_V1 \
    "stage date confirmed_by idea1_window_overlap reference" \
    "stage date confirmed_by idea1_window_overlap reference"; then
    fail K3_MALFORMED
  elif ! [[ "${R[date]}" =~ $DATE_RE ]] || [ "${R[confirmed_by]}" != kraveerachat ] \
    || ! [[ "${R[reference]}" =~ $REF_RE ]] || [[ "${R[reference]^^}" =~ $PLACEHOLDER_RE ]]; then
    fail K3_MALFORMED
  elif [ "${R[stage]}" != "$STAGE" ]; then
    fail K3_STAGE_MISMATCH
  elif [ "${R[date]}" != "$TODAY" ]; then
    fail K3_STALE
  elif [ "${R[idea1_window_overlap]}" != NONE ]; then
    fail K3_OVERLAP_NOT_NONE
  else
    K3_STATE=VALID
  fi
fi

printf 'STAGE=%s\n' "$STAGE"
printf 'MODE=%s\n' "${MODE:-<missing>}"
printf 'WINDOW_DATE=%s (%s)\n' "$TODAY" "$P4_WINDOW_TZ"
if p4_stage_mutates "$STAGE"; then printf 'STAGE_MUTATES_PRODUCTION=YES\n'; else printf 'STAGE_MUTATES_PRODUCTION=NO\n'; fi
if [ "$AUTH_OK" = 1 ]; then printf 'AUTHORIZATION_RECORD=VALID\n'; else printf 'AUTHORIZATION_RECORD=INVALID\n'; fi
printf 'K3_CONFIRMATION=%s\n' "$K3_STATE"
printf 'REQUIRED_REPOSITORY_GAPS=%s\n' "$(p4_stage_gaps "$STAGE")"
printf 'REPOSITORY_GAP_MERGE_STATE=NOT_VERIFIED_BY_GATE\n'
printf 'S10_IDEA2_CAVEAT=OPEN\n'
if p4_stage_mutates "$STAGE"; then
  handler=$(p4_stage_handler_status "$STAGE")
  printf 'ROLLBACK_HANDLER=%s\n' "$handler"
  [ "$MODE" = live ] && [ "$handler" != REGISTERED ] && fail ROLLBACK_HANDLER_NOT_REGISTERED
else
  printf 'ROLLBACK_HANDLER=NOT_APPLICABLE\n'
fi
finish
