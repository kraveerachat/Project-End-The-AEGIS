# shellcheck shell=bash
# AEGIS IDEA3 PR11 Phase 4 — L3 NetworkManager target-device readiness gate and bound activation. Sourced by
# stages/L3/apply.sh (live path only).
#
# Why this exists: live L3 attempt 3 (2026-09-24, rerun5) failed at `nmcli connection up` with "No suitable device found
# ... (device enp62s0 not available because profile is not compatible with device (mismatching interface name))". The
# NetworkManager journal shows it saw the exact rfkill unblock ("Wi-Fi now enabled by radio killswitch") 37 ms before the
# activation, but wlp0s20f3 never left `unavailable` (no device state change; the earlier rerun3 window shows none in 10 s
# either), and the wired device was only named because no Wi-Fi device was a candidate. Here the target device's own
# NetworkManager state is read (bounded, state-based, no arbitrary sleep) and activation is bound to the approved
# interface with `ifname`, so NetworkManager never chooses a device.
#
# READ-ONLY toward NetworkManager (`device status`, `radio wifi`); the only change is the explicit activation of the
# reviewed profile on the target device. Never changes the global radio, rfkill or regulatory state, never touches any
# other device.
L3_NM_REASON=""
L3_NM_STATE=""

_l3_nm_fail() { L3_NM_REASON=$1; return 1; }

# l3_nm_target_state AP_IF -> L3_NM_STATE (state of exactly that device; empty when NetworkManager does not list it)
l3_nm_target_state() {
  local out
  L3_NM_STATE=""
  out=$(nmcli -t -f DEVICE,STATE device status 2>/dev/null) || { _l3_nm_fail NM_STATE_UNREADABLE; return 1; }
  L3_NM_STATE=$(printf '%s\n' "$out" | awk -F: -v d="$1" '$1 == d { split($2, w, " "); print w[1]; exit }')
}

# l3_nm_wait_ready AP_IF [TRIES] [INTERVAL] — succeeds only when the target device is `disconnected` (available, not
# active). Polls the state at most TRIES times, INTERVAL seconds apart, and logs each observed state change.
l3_nm_wait_ready() { # AP_IF [TRIES=10] [INTERVAL=0.5]
  local ap=$1 tries=${2:-10} interval=${3:-0.5} i last="<none>" radio
  [[ "$ap" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] || { _l3_nm_fail NM_TARGET_INTERFACE_INVALID; return 1; }
  for ((i = 1; i <= tries; i++)); do
    l3_nm_target_state "$ap" || return 1
    if [ "$L3_NM_STATE" != "$last" ]; then
      printf 'L3_NM_TARGET_STATE=%s\n' "${L3_NM_STATE:-absent}"
      last=$L3_NM_STATE
    fi
    [ "$L3_NM_STATE" = disconnected ] && return 0
    [ "$i" -lt "$tries" ] && sleep "$interval"
  done
  if [ -z "$L3_NM_STATE" ]; then _l3_nm_fail NM_TARGET_DEVICE_NOT_FOUND; return 1; fi
  radio=$(nmcli radio wifi 2>/dev/null || true)
  if [ "$radio" = disabled ]; then _l3_nm_fail NM_WIFI_RADIO_DISABLED; return 1; fi
  _l3_nm_fail NM_TARGET_DEVICE_NOT_READY
}

# l3_nm_activate AP_IF CONN_ID — explicit activation on the approved device; never lets NetworkManager pick one
l3_nm_activate() {
  [[ "$1" =~ ^[A-Za-z0-9_.-]{1,15}$ ]] && [[ "$2" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || { _l3_nm_fail NM_ACTIVATION_ARGUMENT_INVALID; return 1; }
  nmcli connection up "$2" ifname "$1" || { _l3_nm_fail NMCLI_UP_FAILED; return 1; }
}
