# shellcheck shell=bash
# AEGIS IDEA3 PR11 Phase 2 — portable helpers with no Production constants.
# Sourced, never executed: by p2-lib.sh (server scripts) and directly by the
# Core scripts. Both helpers fail closed. Regression tests:
# IDEA3-AEGIS_Lockdown/tests/test_pr11_phase2_harness.py

# p2_http_status: read `wget -S` (BusyBox) output on stdin and print the status
# code of the last HTTP/x.y status line.
#
# BusyBox prints the response headers indented ("  HTTP/1.1 403 Forbidden") and,
# for a non-2xx response, an extra "wget: server returned error: HTTP/1.1 403
# Forbidden" line. The code is always the token that follows HTTP/x.y, never a
# fixed whitespace field. Without a parsable status it prints 000 and returns 1,
# so no expected 200/403/404 can ever be matched by accident.
p2_http_status() {
  local code
  code=$(grep -oE '(^|[[:space:]])HTTP/[0-9](\.[0-9])? [1-5][0-9]{2}([[:space:]]|$)' |
    tail -n 1 | grep -oE ' [1-5][0-9]{2}' | tr -d ' ')
  if [[ "$code" =~ ^[1-5][0-9]{2}$ ]]; then
    printf '%s\n' "$code"
  else
    printf '000\n'
    return 1
  fi
}

# p2_host_identity: print the static host name without the optional `hostname`
# executable (absent on the real Arch Core). It prefers `hostnamectl --static`,
# then the first non-comment line of /etc/hostname. It prints nothing and returns
# 1 when neither yields a plain host name, so an exact comparison with
# CORE_DECLARED can never pass on an unknown host.
# AEGIS_P2_HOSTNAME_FILE is a TEST-ONLY override for /etc/hostname.
p2_host_identity() {
  local name=""
  if command -v hostnamectl >/dev/null 2>&1; then
    name=$(hostnamectl --static 2>/dev/null) || name=""
  fi
  if [ -z "$name" ] && [ -r "${AEGIS_P2_HOSTNAME_FILE:-/etc/hostname}" ]; then
    name=$(grep -vE '^[[:space:]]*(#|$)' "${AEGIS_P2_HOSTNAME_FILE:-/etc/hostname}" | head -n 1 | tr -d '[:space:]')
  fi
  if [[ "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]{0,252})$ ]]; then
    printf '%s\n' "$name"
  else
    return 1
  fi
}
