#!/usr/bin/env bash
# IDEA1 D-1 Phase J - LOCAL package verification only.
# Reads Git blob (LF) bytes of the Phase J artifacts at <ref> (default HEAD) and checks:
#   1. authority bindings (exact PR-E SHA, image tag, budget, overlay SHA-256, pending set);
#   2. static overlay contract (S2 WRITE=false + image, S3 WRITE=true + exact budget + NO image);
#   3. `docker compose config` render of a local fixture chain -> Stage 1 -> Stage 2 -> Stage 3
#      using the same extraction expressions as runbook V6 S2.4 / S3.4.
# It never runs `up`, `pull`, `load`, `restart`, or touches any daemon or remote host.
# Usage: bash verify-phase-j-package.sh [git-ref]
set -euo pipefail

REF="${1:-HEAD}"
ROOT=$(git rev-parse --show-toplevel)
D1=IDEA1-AEGIS_Drive_LC/deploy/production/d1
PJ=$D1/phase-j
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

FAILS=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi; }

blob() { git -C "$ROOT" show "$REF:$1"; }

blob "$PJ/phase-j-authority.txt" > "$TMP/authority.txt"
auth() {
  local v
  v=$(grep -E "^$1=" "$TMP/authority.txt" | head -1 | cut -d= -f2-)
  test -n "$v" || { echo "FATAL: authority key $1 missing" >&2; exit 1; }
  printf '%s' "$v"
}

# ---------- 1. authority bindings ----------
PR_E_MERGE_SHA=$(auth PR_E_MERGE_SHA)
S2_SHA=$(auth S2_SHA)
S2_IMAGE=$(auth S2_IMAGE)
S2_OVERLAY=$(auth S2_OVERLAY)
S3_OVERLAY=$(auth S3_OVERLAY)
RT=$(auth RT)
EXPECTED_STAGE1_IMAGE=$(auth EXPECTED_STAGE1_IMAGE)
APPROVED_BUDGET=$(auth APPROVED_BUDGET)

check PR_E_MERGE_SHA "$PR_E_MERGE_SHA" 2cbeb8363acd8ec611eb984e4c4c0c155c2fb24b
check V6_SHA256 "$(auth V6_SHA256)" 7911e780f35ead33ed50a52e3786fb7e2653a69ab75fc462749416a9d059b62e
check S2_SHA_EQ_PR_E "$S2_SHA" "$PR_E_MERGE_SHA"
check IMAGE_REVISION_LABEL "$(auth IMAGE_REVISION_LABEL)" "$S2_SHA"
check S2_IMAGE_TAG "$S2_IMAGE" "aegis-prod-drive:preview-d1-s2-${S2_SHA:0:12}"
check IMAGE_USER "$(auth IMAGE_USER)" node
check IMAGE_ARCHIVE "$(auth IMAGE_ARCHIVE)" "/tmp/aegis-prod-drive-preview-d1-s2-${S2_SHA:0:12}.tar"
check EXPECTED_STAGE1_IMAGE "$EXPECTED_STAGE1_IMAGE" aegis-prod-drive:preview-d1-s1-9f5a01148ce0
check APPROVED_BUDGET "$APPROVED_BUDGET" 8589934592
check WRITER_KINDS "$(auth WRITER_KINDS)" thumb,poster
check RT "$RT" /opt/aegis/runtime/preview-d1
check S2_OVERLAY_PATH "$S2_OVERLAY" "$RT/$(basename "$(auth S2_OVERLAY_REPO)")"
check S3_OVERLAY_PATH "$S3_OVERLAY" "$RT/$(basename "$(auth S3_OVERLAY_REPO)")"
if git -C "$ROOT" cat-file -e "$PR_E_MERGE_SHA^{commit}" 2>/dev/null \
   && git -C "$ROOT" merge-base --is-ancestor "$PR_E_MERGE_SHA" "$REF"; then
  pass PR_E_MERGE_IS_ANCESTOR_OF_REF
else
  fail PR_E_MERGE_IS_ANCESTOR_OF_REF
fi

for key in PR_E_MERGE_SHA S2_SHA IMAGE_REVISION_LABEL; do
  [[ "$(auth "$key")" =~ ^[0-9a-f]{40}$ ]] && pass "${key}_FORMAT" || fail "${key}_FORMAT"
done
for key in V6_SHA256 S2_OVERLAY_SHA256 S3_OVERLAY_SHA256; do
  [[ "$(auth "$key")" =~ ^[0-9a-f]{64}$ ]] && pass "${key}_FORMAT" || fail "${key}_FORMAT"
done

# Only the declared live/build facts may stay unresolved.
PENDING=$(grep -E '^[A-Z0-9_]+=<' "$TMP/authority.txt" | cut -d= -f1 | sort | tr '\n' ' ')
check PENDING_SET "$PENDING" "LIVE_CURRENT_IMAGE LIVE_POSTGRES_USER LIVE_STAGE1_CHAIN LIVE_STAGE1_OVERLAY_PATHS LIVE_STAGE1_OVERLAY_SHA256 S2_IMAGE_ARCHIVE_SHA256 S2_IMAGE_ID S2_OCI_REVISION "

# Overlay bytes (Git LF blob) must match the bound SHA-256.
blob "$(auth S2_OVERLAY_REPO)" > "$TMP/s2.yml"
blob "$(auth S3_OVERLAY_REPO)" > "$TMP/s3.yml"
blob "$D1/drive-image-9f5a01148ce0.yml" > "$TMP/s1-image.yml"
blob "$D1/drive-preview-index-stage1-9f5a01148ce0.yml" > "$TMP/s1-flags.yml"
blob "$PJ/fixtures/live-chain-base.fixture.yml" > "$TMP/base.yml"
check S2_OVERLAY_SHA256 "$(sha256sum "$TMP/s2.yml" | awk '{print $1}')" "$(auth S2_OVERLAY_SHA256)"
check S3_OVERLAY_SHA256 "$(sha256sum "$TMP/s3.yml" | awk '{print $1}')" "$(auth S3_OVERLAY_SHA256)"
check S1_IMAGE_OVERLAY_SHA256 "$(sha256sum "$TMP/s1-image.yml" | awk '{print $1}')" 49b0ad5fbe0f49a9cfe168ec28c12aeb3f6fe1ead6dd870105423f4b37b96f78
check S1_FLAGS_OVERLAY_SHA256 "$(sha256sum "$TMP/s1-flags.yml" | awk '{print $1}')" 7c5f0df78c3f5cf46bb2edd83bb8b015ed63d9645ed8de22c69eb1d8d6216a59

# ---------- 2. static overlay contract (YAML keys only; comments stripped) ----------
grep -vE '^[[:space:]]*#' "$TMP/s2.yml" > "$TMP/s2.keys"
grep -vE '^[[:space:]]*#' "$TMP/s3.yml" > "$TMP/s3.keys"
check S2_IMAGE_LINES "$(grep -cE '^[[:space:]]*image:' "$TMP/s2.keys")" 1
check S2_IMAGE_VALUE "$(grep -E '^[[:space:]]*image:' "$TMP/s2.keys" | awk '{print $2}')" "$S2_IMAGE"
check S2_WRITE_FALSE "$(grep -c 'VAULT_PREVIEW_INDEX_WRITE_ENABLED: "false"' "$TMP/s2.keys")" 1
check S2_BUDGET_ABSENT "$(grep -c 'VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER' "$TMP/s2.keys" || true)" 0
check S3_IMAGE_ABSENT "$(grep -cE '^[[:space:]]*(image|build):' "$TMP/s3.keys" || true)" 0
check S3_WRITE_TRUE "$(grep -c 'VAULT_PREVIEW_INDEX_WRITE_ENABLED: "true"' "$TMP/s3.keys")" 1
check S3_BUDGET_EXACT "$(grep -c "VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER: \"$APPROVED_BUDGET\"" "$TMP/s3.keys")" 1
check S3_SERVICES "$(grep -cE '^  [a-z][a-z0-9_-]*:$' "$TMP/s3.keys")" 1

# ---------- 3. fixture render with docker compose config (no daemon, no mutation) ----------
if ! env -u DOCKER_HOST docker compose version >/dev/null 2>&1; then
  echo 'COMPOSE_RENDER=SKIPPED (docker compose unavailable)'
else
  : > "$TMP/fixture.env"
  C=(env -u DOCKER_HOST -u CONTAINER_HOST docker compose --project-directory "$TMP" --env-file "$TMP/fixture.env" --project-name aegis-phase-j-fixture)
  S1_CHAIN=(-f "$TMP/base.yml" -f "$TMP/s1-image.yml" -f "$TMP/s1-flags.yml")
  render_images() { "${C[@]}" "$@" config --images | grep -E 'drive|aegis-prod-drive'; }
  v6_write() { echo "$1" | grep "VAULT_PREVIEW_INDEX_WRITE_ENABLED" | awk '{print $2}' | tr -d '"'; }
  v6_budget() { echo "$1" | grep "VAULT_PREVIEW_INDEX_MAX_RETAINED_BYTES_PER_OWNER" | tr -dc '0-9' || true; }

  check S1_RENDER_IMAGE "$(render_images "${S1_CHAIN[@]}")" "$EXPECTED_STAGE1_IMAGE"

  S2_IMAGES=$(render_images "${S1_CHAIN[@]}" -f "$TMP/s2.yml")
  check S2_RENDER_IMAGE_COUNT "$(echo "$S2_IMAGES" | wc -l | tr -d ' ')" 1
  check S2_RENDER_IMAGE "$S2_IMAGES" "$S2_IMAGE"
  S2_CONFIG=$("${C[@]}" "${S1_CHAIN[@]}" -f "$TMP/s2.yml" config)
  check S2_RENDER_WRITE "$(v6_write "$S2_CONFIG")" false
  check S2_RENDER_BUDGET_ABSENT "$(v6_budget "$S2_CONFIG")" ""

  S3_IMAGES=$(render_images "${S1_CHAIN[@]}" -f "$TMP/s2.yml" -f "$TMP/s3.yml")
  check S3_RENDER_IMAGE_COUNT "$(echo "$S3_IMAGES" | wc -l | tr -d ' ')" 1
  check SAME_IMAGE_S2_S3 "$S3_IMAGES" "$S2_IMAGES"
  check S3_ALL_IMAGES_EQ_S2 \
    "$("${C[@]}" "${S1_CHAIN[@]}" -f "$TMP/s2.yml" -f "$TMP/s3.yml" config --images | sort | tr '\n' ' ')" \
    "$("${C[@]}" "${S1_CHAIN[@]}" -f "$TMP/s2.yml" config --images | sort | tr '\n' ' ')"
  S3_CONFIG=$("${C[@]}" "${S1_CHAIN[@]}" -f "$TMP/s2.yml" -f "$TMP/s3.yml" config)
  check S3_RENDER_WRITE "$(v6_write "$S3_CONFIG")" true
  check S3_RENDER_BUDGET "$(v6_budget "$S3_CONFIG")" "$APPROVED_BUDGET"

  # Non-drive services must render identically across Stage 1 -> 2 -> 3.
  nondrive() { "${C[@]}" "$@" config --format json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);delete j.services.drive;console.log(JSON.stringify(j.services))})'; }
  ND1=$(nondrive "${S1_CHAIN[@]}")
  check NON_DRIVE_S2_UNCHANGED "$(nondrive "${S1_CHAIN[@]}" -f "$TMP/s2.yml")" "$ND1"
  check NON_DRIVE_S3_UNCHANGED "$(nondrive "${S1_CHAIN[@]}" -f "$TMP/s2.yml" -f "$TMP/s3.yml")" "$ND1"
  echo 'COMPOSE_RENDER=DONE'
fi

if [ "$FAILS" -eq 0 ]; then
  echo "PHASE_J_PACKAGE_VERIFY=PASS ref=$(git -C "$ROOT" rev-parse "$REF")"
else
  echo "PHASE_J_PACKAGE_VERIFY=FAIL ($FAILS)" >&2
  exit 1
fi
