#!/bin/bash -p
# AEGIS IDEA3 — CTv CLOSED_FAIL successor ATTESTATION. READ-ONLY. NOT AUTHORIZED, NOT WIRED INTO RECOVERY, NOT EXECUTED.
#
# Stage identity: CTv-fail-successor-attestation. It is a distinct stage. It is NOT CTv, NOT CTu and NOT Recovery, it owns no attempt
# marker, writes no file, issues no device command, restarts nothing and consumes nothing. It prints KEY=VALUE facts to stdout only.
#
# What it independently proves, from the current host and the preserved incident files:
#   A. CTv history is immutable and truthful: the consumed-attempt marker, exactly ONE CTv FAIL closeout whose SHA-256 equals the pinned
#      digest and whose sidecar validates, the closeout's strict field schema, and NO other CTv entry (no PASS, no stray file).
#   B. The CURRENT Core unit, effective security settings, drop-ins, runtime, device id, detector state and TrustedClock, by running the
#      reviewed Option B read-only verifier (not by trusting old evidence).
#   C. The preserved PRE / POST / compare evidence still has the digests the closeout recorded, and the historical S10 result is still FAIL.
#   D. Recovery prerequisites that can be read without consuming anything. Each is PASS, BLOCKED or UNKNOWN; none is invented.
#
# What it does NOT do: it does not turn CTv into PASS, does not repair the historical S10 FAIL, does not claim PRE-to-POST preservation
# passed, and does not authorize Recovery (CTV_FAIL_SUCCESSOR_RECOVERY_AUTHORIZED=NO). A later, separately reviewed and authorized stage
# would have to define a third predecessor authority that binds CTV_FAIL_SUCCESSOR_BINDING_SHA256; nothing here changes the existing
# CTu PASS or CTv PASS gates.
#
# usage: ctv-fail-successor-attest.sh --repo R --main SHA40 --canon DIR --work DIR --device ID
#        Test seams (--hermetic ...) are refused unless CTV_OPTION_B_TEST_ONLY=YES and every path is inside a safe CTV_OPTION_B_TEST_ROOT
#        (the shared Option B guard). Production mode accepts no override of any governed path.
set -Eeuo pipefail
umask 077
# Clean start (same contract as the Option B scripts): `bash -p` ignores BASH_ENV/ENV; `bash <file>` with them set is refused; then an
# empty-environment re-exec that keeps only the named test seams.
if [ "${CTV_OPTION_B_CLEAN_START:-}" != YES ]; then
  if [[ $- != *p* ]] && { [ -n "${BASH_ENV+x}" ] || [ -n "${ENV+x}" ]; }; then
    printf 'CTV_FAIL_SUCCESSOR_ATTESTATION=FAIL reason=BASH_ENV_INJECTION_REFUSED\n' >&2; exit 1
  fi
  seams=()
  for v in CTV_OPTION_B_TEST_ONLY CTV_OPTION_B_TEST_ROOT; do [ -z "${!v+x}" ] || seams+=("$v=${!v}"); done
  exec /usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C CTV_OPTION_B_CLEAN_START=YES "${seams[@]}" /bin/bash --noprofile --norc -p "$0" "$@"
fi
PATH=/usr/sbin:/usr/bin:/sbin:/bin
LC_ALL=C
export PATH LC_ALL

STAGE=CTv-fail-successor-attestation
# Pins. The unit and pre-image digests equal the Option B pins; the closeout digest is the owner-supplied value of the recorded Option B
# closeout. The attestation RE-COMPUTES it from the file on the host; the pin is only what the computation is compared with.
PIN_UNIT_SHA256=82446332f6367f16390f432370ec9bcb7f16f78d0bc6badb4f187b7a74c1627c
PIN_PREIMAGE_SHA256=b2425b0bdc4402f09b7ff616afb66b0686f045459d3b7826796e73ad64a59890
PIN_CLOSEOUT_SHA256=86abd122f8f79226672626d5bf34b01bebecdd5fb0e8dcc6bfcf80c02f28aee9
DISPOSITION=OPTION_B_TARGET_UNIT_RETAINED
MARKER_NAME=CTV-GLOBAL-ATTEMPT-CONSUMED
CLOSEOUT_NAME=CTV-GLOBAL-CLOSEOUT-FAIL
P4_REL=IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
INCIDENT_REL=$P4_REL/ctv-incident
R1I_TOOL_REL=$P4_REL/r1i-input-instrumentation/r1i_input_instrumentation.py
R1I_TABLE="inet aegis_idea3_r1i"
# Complete source closure of the reviewed R1B/R1Bv predecessor gate (p4-r1bv-run-lib.sh and everything it sources). A test recomputes it.
R1BV_CLOSURE="p4-r1bv-run-lib.sh p4-f1u-run-lib.sh p4-f1i-run-lib.sh p4-f1r-run-lib.sh p4-f1-run-lib.sh p4-l6b-run-lib.sh p4-l7-run-lib.sh p4-l7u-run-lib.sh p4-l8p-run-lib.sh p4-ntp-reactivation-lib.sh"

fail() { printf 'CTV_FAIL_SUCCESSOR_ATTESTATION=FAIL reason=%s\n' "${1:-UNKNOWN}" >&2; exit 1; }
trap 'fail UNEXPECTED_ERROR_LINE_$LINENO' ERR

REPO= MAIN= CANON= WORK= DEVICE= HERMETIC=NO
UNIT_DEST=/etc/systemd/system/aegis-idea3-core.service
CORE_ENV=/etc/aegis-idea3/core.env
CLOCK_FIXTURE= PATH_PREFIX= PREIMAGE_OVERRIDE= CLOSEOUT_OVERRIDE=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO=${2:-}; shift 2 ;; --main) MAIN=${2:-}; shift 2 ;; --canon) CANON=${2:-}; shift 2 ;;
    --work) WORK=${2:-}; shift 2 ;; --device) DEVICE=${2:-}; shift 2 ;;
    --hermetic) HERMETIC=YES; shift ;;
    --unit-dest|--core-env|--clock-fixture|--path-prefix|--preimage-sha256|--closeout-sha256)
      [ "$HERMETIC" = YES ] || fail NON_HERMETIC_OVERRIDE_REFUSED
      case "$1" in
        --unit-dest) UNIT_DEST=${2:-} ;; --core-env) CORE_ENV=${2:-} ;; --clock-fixture) CLOCK_FIXTURE=${2:-} ;;
        --path-prefix) PATH_PREFIX=${2:-} ;; --preimage-sha256) PREIMAGE_OVERRIDE=${2:-} ;; --closeout-sha256) CLOSEOUT_OVERRIDE=${2:-} ;;
      esac
      shift 2 ;;
    *) fail USAGE ;;
  esac
done
[[ "$MAIN" =~ ^[0-9a-f]{40}$ && "$DEVICE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || fail ARGUMENT_INVALID
for v in "$REPO" "$CANON" "$WORK" "$UNIT_DEST" "$CORE_ENV"; do [[ "$v" == /* && "$v" != *..* && "$v" != *//* && "${v%/}" == "$v" ]] || fail PATH_INVALID; done

# ── 0. Exact-main authority: every file this stage executes or sources is the blob at MAIN, and is root-trusted.
ob_git() { HOME=/nonexistent GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_NO_REPLACE_OBJECTS=1 /usr/bin/git "$@"; }
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SELF=$HERE/ctv-fail-successor-attest.sh
GUARD=$HERE/ctv-option-b-guard.sh
VERIFIER=$HERE/ctv-option-b-verify.sh
P4DIR=$(cd "$HERE/.." && pwd -P)
[ "$HERE" = "$(cd "$REPO" && pwd -P)/$INCIDENT_REL" ] || fail ATTESTATION_NOT_RUN_FROM_REPO
[ "$(ob_git -C "$REPO" rev-parse HEAD)" = "$MAIN" ] || fail REPO_HEAD_NOT_EXPECTED_MAIN
EXEC_FILES=("$SELF" "$GUARD" "$VERIFIER")
EXEC_RELS=("$INCIDENT_REL/ctv-fail-successor-attest.sh" "$INCIDENT_REL/ctv-option-b-guard.sh" "$INCIDENT_REL/ctv-option-b-verify.sh")
for lib in $R1BV_CLOSURE; do EXEC_FILES+=("$P4DIR/$lib"); EXEC_RELS+=("$P4_REL/$lib"); done
EXEC_FILES+=("$P4DIR/r1i-input-instrumentation/r1i_input_instrumentation.py"); EXEC_RELS+=("$R1I_TOOL_REL")
for i in "${!EXEC_FILES[@]}"; do
  f=${EXEC_FILES[$i]}
  [ -f "$f" ] && [ ! -L "$f" ] || fail AUTHORITY_FILE_MISSING
  [ "$(sha256sum -- "$f" | cut -d' ' -f1)" = "$(ob_git -C "$REPO" show "$MAIN:${EXEC_RELS[$i]}" | sha256sum | cut -d' ' -f1)" ] || fail AUTHORITY_FILE_DIFFERS_FROM_MAIN
done
SELF_SHA=$(sha256sum -- "$SELF" | cut -d' ' -f1)
GUARD_SHA=$(sha256sum -- "$GUARD" | cut -d' ' -f1)
VERIFIER_SHA=$(sha256sum -- "$VERIFIER" | cut -d' ' -f1)

# shellcheck source=/dev/null
. "$GUARD"
ob_guard_init
for f in "${EXEC_FILES[@]}"; do
  ob_trusted_file "$f" || fail EXEC_PATH_NOT_TRUSTED
  if [ "$HERMETIC" = YES ]; then ob_chain "$f" "$CTV_OPTION_B_TEST_ROOT" "$GUARD_UID" || fail EXEC_PATH_CHAIN_NOT_TRUSTED
  else ob_chain "$f" / 0 || fail EXEC_PATH_CHAIN_NOT_TRUSTED; fi
done
# Test seams are honoured only after the guard accepted them.
[ -z "$PREIMAGE_OVERRIDE" ] || PIN_PREIMAGE_SHA256=$PREIMAGE_OVERRIDE
[ -z "$CLOSEOUT_OVERRIDE" ] || PIN_CLOSEOUT_SHA256=$CLOSEOUT_OVERRIDE
[[ "$PIN_PREIMAGE_SHA256" =~ ^[0-9a-f]{64}$ && "$PIN_CLOSEOUT_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail PIN_INVALID
if [ "$HERMETIC" = YES ]; then
  [ -z "$PATH_PREFIX" ] || { PATH="$PATH_PREFIX:$PATH"; export PATH; }
else
  [ "$(id -u)" = 0 ] || fail ROOT_REQUIRED
fi
ro() { if [ -n "$CTV_SUDO" ]; then "$CTV_SUDO" "$@"; else "$@"; fi; }
printf 'CTV_FAIL_SUCCESSOR_STAGE=%s\nCTV_FAIL_SUCCESSOR_AUTHORITY=PASS\nCTV_FAIL_SUCCESSOR_EXPECTED_MAIN=%s\n' "$STAGE" "$MAIN"

# ── A. CTv immutable history -------------------------------------------------------------------------------------------------------
if [ "$HERMETIC" = YES ]; then ob_chain "$CANON" "$CTV_OPTION_B_TEST_ROOT" "$GUARD_UID" || fail CANONICAL_DIR_NOT_TRUSTED
else ob_chain "$CANON" / 0 || fail CANONICAL_DIR_NOT_TRUSTED; fi
marker="$CANON/$MARKER_NAME"; closeout="$CANON/$CLOSEOUT_NAME"; sidecar="$closeout.sha256"
# The CTv namespace holds EXACTLY the attempt marker, one FAIL closeout and its sidecar: no PASS closeout, no sidecar of one, no temp file.
entries=$(ro find "$CANON" -maxdepth 1 -name 'CTV-*' -printf '%f\n' | LC_ALL=C sort)
[ "$entries" = "$(printf '%s\n%s\n%s\n' "$CLOSEOUT_NAME" "$CLOSEOUT_NAME.sha256" "$MARKER_NAME" | LC_ALL=C sort)" ] || fail CTV_NAMESPACE_NOT_EXACT
file_ident() { ro stat -c '%F:%u:%a' -- "$1"; }
[ "$(file_ident "$marker")" = "regular file:$GUARD_UID:600" ] || fail MARKER_UNTRUSTED
[ "$(file_ident "$closeout")" = "regular file:$GUARD_UID:600" ] || fail CLOSEOUT_UNTRUSTED
[ "$(file_ident "$sidecar")" = "regular file:$GUARD_UID:444" ] || fail SIDECAR_UNTRUSTED
closeout_sha=$(ro sha256sum -- "$closeout" | cut -d' ' -f1)
marker_sha=$(ro sha256sum -- "$marker" | cut -d' ' -f1)
[ "$closeout_sha" = "$PIN_CLOSEOUT_SHA256" ] || fail CLOSEOUT_SHA256_NOT_THE_PINNED_RECORD
# read_exact FILE — the file's bytes with exactly ONE trailing newline and no blank line (command substitution alone would hide extra newlines).
read_exact() {
  local raw
  raw=$(ro cat -- "$1"; printf x) || return 1
  raw=${raw%x}
  [[ "$raw" == *$'\n' && "$raw" != *$'\n\n'* && "$raw" != $'\n'* ]] || return 1
  printf '%s' "${raw%$'\n'}"
}
[ "$(read_exact "$sidecar")" = "$closeout_sha  $CLOSEOUT_NAME" ] || fail CLOSEOUT_SIDECAR_INVALID
closeout_text=$(read_exact "$closeout") || fail CLOSEOUT_SCHEMA_NOT_EXACT
marker_text=$(read_exact "$marker") || fail MARKER_SCHEMA_NOT_EXACT

# strict_schema TEXT KEY... — every line is KEY=VALUE with a bounded charset, no duplicate key, and the key set is EXACTLY the given list.
strict_schema() {
  local text=$1; shift
  awk -v want="$*" 'BEGIN { n = split(want, w, " "); for (i = 1; i <= n; i++) allowed[w[i]] = 1 }
    { if ($0 !~ /^[A-Za-z0-9_]+=[A-Za-z0-9._:\/+-]*$/) { bad = 1; next }
      k = substr($0, 1, index($0, "=") - 1)
      if (!(k in allowed) || (k in seen)) { bad = 1; next }
      seen[k] = 1; cnt++ }
    END { if (bad || cnt != n) exit 1 }' <<<"$text"
}
kv() { awk -F= -v k="$2" '$1 == k { n++; v = substr($0, length(k) + 2) } END { if (n != 1) exit 1; print v }' <<<"$1"; }
CLOSEOUT_KEYS="CTV_RESULT CTV_LIVE CTV_LIVE_EXECUTED CTV_ATTEMPT_CONSUMED CTV_RERUN_ALLOWED CTV_IS_CTU_RETRY CTV_FAILURE_REASON CTV_INCIDENT_DISPOSITION CTV_INCIDENT_AUTHORIZATION_ID CTV_ROLLBACK_COMPLETE CTV_TARGET_UNIT_RETAINED CTV_ADDITIONAL_CORE_RESTART CTV_ADDITIONAL_DETECTOR_COMMANDS CTV_S10_HISTORICAL_COMPARE CTV_S10_PROMOTED_TO_PASS CTV_RECOVERY_AUTHORIZED CTV_JOURNAL_PHASE CTV_EXPECTED_MAIN CTV_DISPOSITION_MAIN CTV_UNIT_SHA256 CTV_PREIMAGE_SHA256 CTV_DEVICE_ID CTV_DETECTOR_BASELINE_MODE CTV_TRUSTEDCLOCK_AT_DISPOSITION CTV_CORE_MAINPID_AT_DISPOSITION CTV_FROZEN_RUNNER_SHA256 CTV_EVIDENCE_PRE_SHA256SUMS_SHA256 CTV_EVIDENCE_POST_SHA256SUMS_SHA256 CTV_COMPARE_OUTPUT_SHA256 CTV_VERIFIER_SHA256 CTV_DISPOSITION_ACTION_SHA256 CTV_GUARD_SHA256 CTV_STATE_SHA256 CTV_DISPOSITION_RECORDED_AT_UTC"
MARKER_KEYS="CTV_ATTEMPT_CONSUMED CTV_RERUN_ALLOWED CTV_FROZEN_RUNNER_SHA256 CTV_RUNNER_TEMPLATE_SHA256 CTV_BUNDLE_MANIFEST_SHA256 CTV_CONTROL_MANIFEST_SHA256 work"
# shellcheck disable=SC2086
strict_schema "$closeout_text" $CLOSEOUT_KEYS || fail CLOSEOUT_SCHEMA_NOT_EXACT
# shellcheck disable=SC2086
strict_schema "$marker_text" $MARKER_KEYS || fail MARKER_SCHEMA_NOT_EXACT
for want in CTV_RESULT=FAIL_IMMUTABLE CTV_LIVE=CLOSED_FAIL CTV_LIVE_EXECUTED=YES CTV_ATTEMPT_CONSUMED=YES CTV_RERUN_ALLOWED=NO CTV_IS_CTU_RETRY=NO \
    CTV_FAILURE_REASON=S10_COMPARE_FAIL_ROLLBACK_INCOMPLETE_TARGET_UNIT_RETAINED CTV_INCIDENT_DISPOSITION=$DISPOSITION CTV_ROLLBACK_COMPLETE=NO \
    CTV_TARGET_UNIT_RETAINED=YES CTV_ADDITIONAL_CORE_RESTART=NO CTV_ADDITIONAL_DETECTOR_COMMANDS=0 CTV_S10_HISTORICAL_COMPARE=FAIL \
    CTV_S10_PROMOTED_TO_PASS=NO CTV_RECOVERY_AUTHORIZED=NO CTV_JOURNAL_PHASE=apply-verified CTV_UNIT_SHA256=$PIN_UNIT_SHA256 \
    CTV_PREIMAGE_SHA256=$PIN_PREIMAGE_SHA256 CTV_DEVICE_ID=$DEVICE CTV_DETECTOR_BASELINE_MODE=INACTIVE CTV_TRUSTEDCLOCK_AT_DISPOSITION=SYNCED; do
  [ "$(kv "$closeout_text" "${want%%=*}")" = "${want#*=}" ] || fail "CLOSEOUT_FIELD_INVALID_${want%%=*}"
done
for key in CTV_INCIDENT_AUTHORIZATION_ID; do [[ "$(kv "$closeout_text" $key)" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$ ]] || fail "CLOSEOUT_FIELD_INVALID_$key"; done
for key in CTV_FROZEN_RUNNER_SHA256 CTV_EVIDENCE_PRE_SHA256SUMS_SHA256 CTV_EVIDENCE_POST_SHA256SUMS_SHA256 CTV_COMPARE_OUTPUT_SHA256 CTV_VERIFIER_SHA256 CTV_DISPOSITION_ACTION_SHA256 CTV_GUARD_SHA256 CTV_STATE_SHA256; do
  [[ "$(kv "$closeout_text" $key)" =~ ^[0-9a-f]{64}$ ]] || fail "CLOSEOUT_FIELD_INVALID_$key"
done
[[ "$(kv "$closeout_text" CTV_CORE_MAINPID_AT_DISPOSITION)" =~ ^[1-9][0-9]*$ ]] || fail CLOSEOUT_FIELD_INVALID_CTV_CORE_MAINPID_AT_DISPOSITION
[[ "$(kv "$closeout_text" CTV_DISPOSITION_RECORDED_AT_UTC)" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail CLOSEOUT_FIELD_INVALID_CTV_DISPOSITION_RECORDED_AT_UTC
disp_main=$(kv "$closeout_text" CTV_DISPOSITION_MAIN)
[[ "$disp_main" =~ ^[0-9a-f]{40}$ && "$(kv "$closeout_text" CTV_EXPECTED_MAIN)" = "$disp_main" ]] || fail CLOSEOUT_MAIN_FIELDS_INVALID
# The disposition main must be this main or one of its ancestors: the attestation can only be run by a main that already contains it.
ob_git -C "$REPO" merge-base --is-ancestor "$disp_main" "$MAIN" 2>/dev/null || fail CLOSEOUT_MAIN_NOT_AN_ANCESTOR
# Marker: strict fields, consistent with the closeout.
[ "$(kv "$marker_text" CTV_ATTEMPT_CONSUMED)" = YES ] && [ "$(kv "$marker_text" CTV_RERUN_ALLOWED)" = NO ] || fail MARKER_FIELD_INVALID
[ "$(kv "$marker_text" work)" = "$WORK" ] || fail MARKER_WORK_DIR_MISMATCH
for key in CTV_FROZEN_RUNNER_SHA256 CTV_RUNNER_TEMPLATE_SHA256 CTV_BUNDLE_MANIFEST_SHA256 CTV_CONTROL_MANIFEST_SHA256; do
  [[ "$(kv "$marker_text" $key)" =~ ^[0-9a-f]{64}$ ]] || fail "MARKER_FIELD_INVALID_$key"
done
[ "$(kv "$marker_text" CTV_FROZEN_RUNNER_SHA256)" = "$(kv "$closeout_text" CTV_FROZEN_RUNNER_SHA256)" ] || fail MARKER_CLOSEOUT_RUNNER_MISMATCH
printf 'CTV_FAIL_SUCCESSOR_CTV_HISTORY=IMMUTABLE_FAIL\nCTV_FAIL_SUCCESSOR_CLOSEOUT_SHA256=%s\nCTV_FAIL_SUCCESSOR_CLOSEOUT_SIDECAR=VALID\nCTV_FAIL_SUCCESSOR_MARKER_SHA256=%s\nCTV_FAIL_SUCCESSOR_CTV_NAMESPACE=EXACT\n' "$closeout_sha" "$marker_sha"
printf 'CTV_FAIL_SUCCESSOR_HISTORICAL_RESULT=FAIL_IMMUTABLE\nCTV_FAIL_SUCCESSOR_PROMOTES_CTV_TO_PASS=NO\nCTV_FAIL_SUCCESSOR_ROLLBACK_COMPLETE=NO\n'

# ── B + C. Current runtime and preserved-evidence integrity, from the reviewed Option B read-only verifier ----------------------------
pre_d=$(kv "$closeout_text" CTV_EVIDENCE_PRE_SHA256SUMS_SHA256); post_d=$(kv "$closeout_text" CTV_EVIDENCE_POST_SHA256SUMS_SHA256); cmp_d=$(kv "$closeout_text" CTV_COMPARE_OUTPUT_SHA256)
vargs=(--repo "$REPO" --main "$MAIN" --canon "$CANON" --work "$WORK" --device "$DEVICE" --phase post --bind-evidence --expect-pre-sums "$pre_d" --expect-post-sums "$post_d" --expect-compare "$cmp_d")
if [ "$HERMETIC" = YES ]; then
  vargs+=(--hermetic --unit-dest "$UNIT_DEST" --core-env "$CORE_ENV" --preimage-sha256 "$PIN_PREIMAGE_SHA256")
  [ -z "$CLOCK_FIXTURE" ] || vargs+=(--clock-fixture "$CLOCK_FIXTURE")
  [ -z "$PATH_PREFIX" ] || vargs+=(--path-prefix "$PATH_PREFIX")
fi
vout=$("$VERIFIER" "${vargs[@]}") || fail OPTION_B_VERIFIER_FAILED
[ "$(kv "$vout" CTV_OPTION_B_VERIFY)" = PASS ] || fail OPTION_B_VERIFIER_NOT_PASS
[ "$(kv "$vout" CTV_OPTION_B_GUARD_SHA256)" = "$GUARD_SHA" ] || fail VERIFIER_GUARD_MISMATCH
[ "$(kv "$vout" CTV_OPTION_B_UNIT_SHA256)" = "$(kv "$closeout_text" CTV_UNIT_SHA256)" ] || fail UNIT_NOT_THE_RECORDED_UNIT
[ "$(kv "$vout" CTV_OPTION_B_PREIMAGE_SHA256)" = "$(kv "$closeout_text" CTV_PREIMAGE_SHA256)" ] || fail PREIMAGE_NOT_THE_RECORDED_PREIMAGE
[ "$(kv "$vout" CTV_OPTION_B_DEVICE_ID)" = "$(kv "$closeout_text" CTV_DEVICE_ID)" ] || fail DEVICE_NOT_THE_RECORDED_DEVICE
[ "$(kv "$vout" CTV_OPTION_B_FROZEN_RUNNER_SHA256)" = "$(kv "$closeout_text" CTV_FROZEN_RUNNER_SHA256)" ] || fail RUNNER_NOT_THE_RECORDED_RUNNER
[ "$(kv "$vout" CTV_OPTION_B_PRE_SHA256SUMS_SHA256)" = "$pre_d" ] && [ "$(kv "$vout" CTV_OPTION_B_POST_SHA256SUMS_SHA256)" = "$post_d" ] && [ "$(kv "$vout" CTV_OPTION_B_COMPARE_OUTPUT_SHA256)" = "$cmp_d" ] || fail EVIDENCE_NOT_THE_RECORDED_EVIDENCE
for want in CTV_OPTION_B_DETECTOR_BASELINE_MODE=INACTIVE CTV_OPTION_B_PRE_DETECTOR_BASELINE=INACTIVE CTV_OPTION_B_TRUSTEDCLOCK=SYNCED CTV_OPTION_B_EFFECTIVE_SECURITY=PASS \
    CTV_OPTION_B_DROPINS=EXACT CTV_OPTION_B_RUNTIME=PASS CTV_OPTION_B_UNIT_IDENTITY=PASS CTV_OPTION_B_EVIDENCE_INTEGRITY=PASS CTV_OPTION_B_EVIDENCE_DIGESTS_BOUND=YES \
    CTV_OPTION_B_S10_HISTORICAL_COMPARE=FAIL CTV_OPTION_B_S10_POSITIVELY_EVIDENCED=YES CTV_OPTION_B_S10_PROMOTED_TO_PASS=NO CTV_OPTION_B_READ_ONLY=YES CTV_OPTION_B_ADDITIONAL_RESTART=NO \
    CTV_OPTION_B_RECOVERY_AUTHORITY_UNCHANGED=YES CTV_OPTION_B_ROLLBACK_COMPLETE=NO CTV_OPTION_B_JOURNAL_PHASE=apply-verified; do
  [ "$(kv "$vout" "${want%%=*}")" = "${want#*=}" ] || fail "VERIFIER_FACT_INVALID_${want%%=*}"
done
# Nothing the attestation read may have changed while it ran.
[ "$(ro sha256sum -- "$closeout" | cut -d' ' -f1)" = "$closeout_sha" ] && [ "$(ro sha256sum -- "$marker" | cut -d' ' -f1)" = "$marker_sha" ] || fail HISTORY_CHANGED_DURING_ATTESTATION
[ "$(ro find "$CANON" -maxdepth 1 -name 'CTV-*' -printf '%f\n' | LC_ALL=C sort)" = "$entries" ] || fail HISTORY_CHANGED_DURING_ATTESTATION
printf '%s\n' "$vout" | grep -E '^CTV_OPTION_B_(UNIT_SHA256|CORE_MAINPID|PRE_SHA256SUMS_SHA256|POST_SHA256SUMS_SHA256|COMPARE_OUTPUT_SHA256|STATE_SHA256)=' | sed 's/^CTV_OPTION_B_/CTV_FAIL_SUCCESSOR_CURRENT_/'
cat <<'EOF'
CTV_FAIL_SUCCESSOR_CURRENT_RUNTIME=PASS
CTV_FAIL_SUCCESSOR_CURRENT_STATE_SCOPE=UNIT_SHA256,EFFECTIVE_SECURITY,DROPINS,CORE_ACTIVE,DEVICE_ID,DETECTOR_INACTIVE,TRUSTEDCLOCK_NOW
CTV_FAIL_SUCCESSOR_EVIDENCE_INTEGRITY=PASS
CTV_FAIL_SUCCESSOR_HISTORICAL_S10=FAIL
CTV_FAIL_SUCCESSOR_PRESERVATION_PRE_TO_POST=NOT_PROVEN_HISTORICAL_FAIL
CTV_FAIL_SUCCESSOR_FIXES_HISTORICAL_S10=NO
EOF

# ── D. Recovery prerequisites that can be read without consuming anything (PASS | BLOCKED | UNKNOWN; never invented) ------------------
# D1. The Recovery attempt authority is unconsumed (the verifier already refused any RECOVERY-* entry; restated as a prerequisite).
[ -z "$(ro find "$CANON" -maxdepth 1 -name 'RECOVERY-*' -print -quit)" ] || fail RECOVERY_AUTHORITY_PRESENT
printf 'CTV_FAIL_SUCCESSOR_PREREQ_RECOVERY_ATTEMPT=PASS\n'
prereq_blocked=0
# D2. R1I containment rule still installed in its exact owned shape (read-only nft).
r1i_status=BLOCKED r1i_reason=NFT_UNAVAILABLE
# Production resolves nft under the fixed system PATH; hermetic mode may use ONLY the stub in its own path prefix (never the real host nft).
nft_bin=
if [ "$HERMETIC" = YES ]; then [ -n "$PATH_PREFIX" ] && [ -x "$PATH_PREFIX/nft" ] && nft_bin=$PATH_PREFIX/nft || true
else nft_bin=$(command -v nft || true); fi
if [ -n "$nft_bin" ]; then
  if ro "$nft_bin" list tables 2>/dev/null | grep -qxF "table $R1I_TABLE"; then
    if ro "$nft_bin" --stateless list table $R1I_TABLE 2>/dev/null | /usr/bin/python3 -I -B -X pycache_prefix=/nonexistent-ctv-successor-pycache "${EXEC_FILES[${#EXEC_FILES[@]}-1]}" validate-state /dev/stdin >/dev/null 2>&1; then
      r1i_status=PASS r1i_reason=NONE
    else r1i_reason=R1I_TABLE_NOT_EXACT_OWNED_SHAPE; fi
  else r1i_reason=R1I_TABLE_MISSING; fi
fi
printf 'CTV_FAIL_SUCCESSOR_PREREQ_R1I=%s\nCTV_FAIL_SUCCESSOR_PREREQ_R1I_REASON=%s\n' "$r1i_status" "$r1i_reason"
[ "$r1i_status" = PASS ] || prereq_blocked=1
# D3. R1B incident authority: the reviewed R1B/R1Bv predecessor gate, run unmodified in an empty environment from the exact-main libraries.
r1b_status=BLOCKED r1b_reason=NONE
if r1b_err=$(env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C SUDO= /bin/bash --noprofile --norc -p -c '. "$1" && r1bv_recovery_predecessor_gate "$2" "$3"' _ "$P4DIR/p4-r1bv-run-lib.sh" "$REPO" "$MAIN" 2>&1 >/dev/null); then
  r1b_status=PASS
else
  r1b_reason=$(printf '%s' "${r1b_err%%$'\n'*}" | tr -cd 'A-Za-z0-9_' | cut -c1-96); [ -n "$r1b_reason" ] || r1b_reason=R1B_PREDECESSOR_GATE_FAILED
fi
printf 'CTV_FAIL_SUCCESSOR_PREREQ_R1B_AUTHORITY=%s\nCTV_FAIL_SUCCESSOR_PREREQ_R1B_AUTHORITY_REASON=%s\n' "$r1b_status" "$r1b_reason"
[ "$r1b_status" = PASS ] || prereq_blocked=1
# D4. Pinned release and restore-CLI identity: the trusted pins (release id, CLI digest, release manifest digest) are Recovery
# Authorization inputs that do not exist in the repository, so this stage cannot prove them and must not guess.
printf 'CTV_FAIL_SUCCESSOR_PREREQ_RELEASE_CLI=UNKNOWN\nCTV_FAIL_SUCCESSOR_PREREQ_RELEASE_CLI_REASON=NO_TRUSTED_PIN_INPUT\n'
printf 'CTV_FAIL_SUCCESSOR_RECOVERY_PREREQUISITES=%s\n' "$([ "$prereq_blocked" = 0 ] && echo PARTIAL_RELEASE_CLI_UNKNOWN || echo BLOCKED)"

# ── Binding digest for a future, separately reviewed third predecessor authority; it covers only stable facts. ----------------------
binding=$({
  printf 'stage=%s\nmain=%s\ndevice=%s\n' "$STAGE" "$MAIN" "$DEVICE"
  printf 'closeout=%s\nmarker=%s\nunit=%s\npreimage=%s\n' "$closeout_sha" "$marker_sha" "$PIN_UNIT_SHA256" "$PIN_PREIMAGE_SHA256"
  printf 'pre=%s\npost=%s\ncompare=%s\nattest=%s\nguard=%s\nverifier=%s\n' "$pre_d" "$post_d" "$cmp_d" "$SELF_SHA" "$GUARD_SHA" "$VERIFIER_SHA"
} | sha256sum | cut -d' ' -f1)
cat <<EOF
CTV_FAIL_SUCCESSOR_BINDING_SHA256=$binding
CTV_FAIL_SUCCESSOR_ATTESTATION=PASS
CTV_FAIL_SUCCESSOR_RECOVERY_AUTHORIZED=NO
CTV_FAIL_SUCCESSOR_READ_ONLY=YES
CTV_FAIL_SUCCESSOR_PRODUCTION_MUTATION=NO
CTV_FAIL_SUCCESSOR_ATTEMPT_CONSUMED=NO
CTV_FAIL_SUCCESSOR_CORE_RESTART=NO
CTV_FAIL_SUCCESSOR_DEVICE_COMMANDS=0
CTV_FAIL_SUCCESSOR_WIRED_INTO_RECOVERY=NO
EOF
