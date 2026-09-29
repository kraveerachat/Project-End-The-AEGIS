# shellcheck shell=bash
# AEGIS IDEA3 PR11 Phase 4 — shared listener-snapshot helper for L7's apply.sh/verify.sh/rollback.sh.
# Sourced, never executed. Contains no live value, no secret, and mutates nothing.
#
# Live failure B (2026-09-29): the L7 pre->rollback listener compare false-failed on a real host because raw
# `ss -H -ltnu` output includes every UDP socket the kernel autobound to an ephemeral client port (resolvers,
# NTP/mDNS, ...), which rotate continuously and are not services. p4-l0-capture.sh already solves this for the
# T1/G-15 capture/compare harness by excluding UDP local ports that fall inside the kernel's own ephemeral range
# (/proc/sys/net/ipv4/ip_local_port_range); this file gives L7's apply/verify/rollback the exact same semantics
# from one shared implementation, so the three handlers can never drift from each other.
#
# Contract (identical to p4-l0-capture.sh):
#   - TCP is NEVER filtered.
#   - A UDP local port OUTSIDE the kernel's ephemeral range is NEVER filtered.
#   - If the kernel range cannot be read and validated, NOTHING is filtered (fail-safe: possible ephemeral-port
#     churn noise survives, but a real dropped/added listener is never hidden by a guess).
#   - The range is never hard-coded; it is always read fresh from the host (or fixture) at snapshot time.

# l7_listener_snapshot RANGE_PATH -- SS_CMD...
# RANGE_PATH is the (possibly fixture-rooted) path to ip_local_port_range. SS_CMD... is the ss invocation to run
# (each handler's own ss_do wrapper, so fixture-mode ss stubbing is preserved unchanged). Prints "netid:local"
# lines, sorted and de-duplicated, in the exact format the three handlers already compare with cmp/comm.
l7_listener_snapshot() {
  local range_path=$1
  shift
  local eph_lo="" eph_hi=""
  if read -r eph_lo eph_hi < "$range_path" 2>/dev/null \
    && [[ "$eph_lo" =~ ^[0-9]{1,5}$ ]] && [[ "$eph_hi" =~ ^[0-9]{1,5}$ ]] \
    && [ "$eph_lo" -ge 1024 ] && [ "$eph_lo" -le "$eph_hi" ] && [ "$eph_hi" -le 65535 ]; then
    :
  else
    eph_lo="" eph_hi=""
  fi
  "$@" | awk -v lo="$eph_lo" -v hi="$eph_hi" 'NF >= 5 {
      port = $5; sub(/.*:/, "", port)
      if ($1 == "udp" && lo != "" && port ~ /^[0-9]+$/ && port + 0 >= lo + 0 && port + 0 <= hi + 0) next
      print $1 ":" $5 }' | LC_ALL=C sort -u
}
