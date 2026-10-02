#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — dnsmasq unit boot-order REBOOT VERIFICATION, owner-run wrapper. STRICTLY READ-ONLY; it NEVER reboots anything.
# REPOSITORY TEMPLATE: EXPECTED_MAIN is unpinned, so this file REFUSES TO RUN as committed (same owner freeze workflow as the repair runner).
# Design: docs/superpowers/specs/2026-10-03-idea3-dnsmasq-unit-boot-order-governed-repair-design.md  (section "Separate reboot verification")
#
# This is a SEPARATE activity from the live repair: the repair run claims no reboot persistence. Procedure (the owner performs the reboot, this script does not):
#   1. after a PASSED repair run:  bash verify-dnsmasq-boot-order-after-reboot.sh record <REBOOT_DIR> <REPAIR_EVIDENCE_DIR> <WRITTEN_REBOOT_APPROVAL_REFERENCE>
#   2. the owner performs ONE orderly reboot and, after boot, does NOT touch the AP, NetworkManager or dnsmasq
#   3. bash verify-dnsmasq-boot-order-after-reboot.sh verify <REBOOT_DIR> [--attest-no-manual-intervention]
# Output: REBOOT_VERIFICATION_RESULT=PASS|FAIL, K12_PERSISTENCE_OBSERVED=YES|NO and, separately, K12_FORMALLY_PROVEN=NO (this script can never conclude formal proof;
# the repository holds no canonical K12 acceptance contract — that is an owner/integration decision). K12_AUTOMATIC_REBOOT_PERSISTENCE stays NOT_PROVEN.
set -Eeuo pipefail
umask 077

EXPECTED_MAIN=PIN_MAIN_SHA
case "$EXPECTED_MAIN" in PIN_*) echo "STOP: runner is not pinned (EXPECTED_MAIN). Run the owner freeze workflow first."; exit 2 ;; esac
[[ "$EXPECTED_MAIN" =~ ^[0-9a-f]{40}$ ]] || { echo "STOP: EXPECTED_MAIN is not a 40-hex SHA."; exit 2; }
[ "$(id -u)" != 0 ] || { echo "Run as your normal user, not root."; exit 2; }
MODE=${1:-}; RDIR=${2:-}
case "$MODE" in
  record) REPAIR_EVID=${3:-}; APPROVAL_REF=${4:-}
    [ -n "$RDIR" ] && [ -d "$REPAIR_EVID" ] && [ -n "$APPROVAL_REF" ] || { echo "usage: bash $0 record <REBOOT_DIR (new)> <REPAIR_EVIDENCE_DIR> <WRITTEN_REBOOT_APPROVAL_REFERENCE>"; exit 2; } ;;
  verify) REPAIR_EVID=""; APPROVAL_REF=""
    [ -n "$RDIR" ] && [ -d "$RDIR" ] || { echo "usage: bash $0 verify <REBOOT_DIR> [--attest-no-manual-intervention]"; exit 2; } ;;
  *) echo "usage: bash $0 record|verify ..."; exit 2 ;;
esac
ATTEST=NO; [ "${3:-}" != --attest-no-manual-intervention ] || ATTEST=YES

REPO=/home/kittipat/Workspace/IDEA3-Cyber-Last/worktrees/Project-End-The-AEGIS-DNSMASQREPAIRLIVE   # clean pinned execution worktree at merged main
P4=$REPO/IDEA3-AEGIS_Lockdown/deploy/pr11-phase4
HND=$P4/reactivation/dnsmasq-unit-boot-order-repair
die() { echo "STOP: $*" >&2; exit 1; }
[ -f "$HND/reboot-verify.sh" ] || die "reboot-verify handler missing under $P4 (is $REPO at the pinned main?)"
[ "$(git -C "$REPO" rev-parse HEAD)" = "$EXPECTED_MAIN" ] || die "worktree HEAD is not $EXPECTED_MAIN"
[ -z "$(git -C "$REPO" status --porcelain)" ] || die "worktree is not clean"
git -C "$REPO" fetch -q origin 2>/dev/null && [ "$(git -C "$REPO" rev-parse origin/main)" = "$EXPECTED_MAIN" ] || die "origin/main is not $EXPECTED_MAIN (or fetch failed); not silently re-pinning"
sudo -v || die "sudo authentication failed"
echo "K12_AUTOMATIC_REBOOT_PERSISTENCE=NOT_PROVEN"
exec sudo env AEGIS_DNSREPAIR_REBOOT_MODE="$MODE" AEGIS_DNSREPAIR_REBOOT_DIR="$RDIR" AEGIS_DNSREPAIR_REPAIR_EVIDENCE="$REPAIR_EVID" \
  AEGIS_DNSREPAIR_APPROVAL_REF="$APPROVAL_REF" AEGIS_DNSREPAIR_NO_MANUAL_INTERVENTION="$ATTEST" AEGIS_AP_INTERFACE=wlp0s20f3 bash "$HND/reboot-verify.sh"
