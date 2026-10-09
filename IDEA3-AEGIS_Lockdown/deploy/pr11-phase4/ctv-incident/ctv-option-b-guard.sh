#!/bin/bash -p
# Shared Production guard for the CTv Option B verifier and disposition action. SOURCED only, after the caller has proven this file
# equals the exact-main blob. No side effects at source time. Uses the caller's fail() (which exits).
#
# Production mode (no --hermetic): every governed location is a fixed constant or must be root-trusted.
# Hermetic mode (tests): only with CTV_OPTION_B_TEST_ONLY=YES, only under a safe CTV_OPTION_B_TEST_ROOT, and NEVER against a
# real governance/system path. --hermetic alone is not enough, and cannot be combined with the real canonical directory.

OB_PROD_CANON=/var/lib/aegis-idea3-governance
OB_PROD_UNIT=/etc/systemd/system/aegis-idea3-core.service
OB_PROD_CORE_ENV=/etc/aegis-idea3/core.env
# Roots a test root may not equal, lie under, or (for /) contain.
OB_UNSAFE_ROOTS="/ /etc /var /usr /opt /boot /bin /sbin /lib /lib32 /lib64 /root /srv /proc /sys /dev /run"
# Real governance/system locations no hermetic path may ever name (belt and braces on top of the test-root confinement).
OB_PROTECTED_PATHS="$OB_PROD_CANON /etc/aegis-idea3 /etc/systemd /var/lib/aegis-idea3 /var/lib/aegis-idea3-governance /opt/aegis-idea3"

ob_under() { # PATH ROOT — PATH equals ROOT or lies below it
  [ "$1" = "$2" ] || [[ "$1" == "$2"/* ]]
}
ob_no_gw() { # PATH — not group/world writable
  local m; m=$(stat -c %a -- "$1") || return 1
  [ $(( 8#$m & 8#022 )) -eq 0 ]
}
# ob_chain PATH FLOOR UID — PATH and every ancestor from FLOOR down is a real (non-symlink) object owned by UID, not group/world writable.
ob_chain() {
  local path=$1 floor=$2 uid=$3 cur="" part
  local -a parts
  IFS=/ read -ra parts <<<"${path#/}"
  if [ "$floor" = / ]; then
    [ "$(stat -c %u -- /)" = "$uid" ] && ob_no_gw / || return 1
  fi
  for part in "${parts[@]}"; do
    [ -n "$part" ] || continue
    cur="$cur/$part"
    [ ! -L "$cur" ] && [ -e "$cur" ] || return 1
    if ob_under "$cur" "$floor" || [ "$floor" = / ]; then
      [ "$(stat -c %u -- "$cur")" = "$uid" ] && ob_no_gw "$cur" || return 1
    fi
  done
}

# ob_guard_init — arguments are already parsed into REPO CANON WORK UNIT_DEST CORE_ENV PATH_PREFIX HERMETIC.
ob_guard_init() {
  local p root real bad
  if [ "$HERMETIC" = YES ]; then
    [ "${CTV_OPTION_B_TEST_ONLY:-}" = YES ] || fail HERMETIC_REQUIRES_TEST_ONLY_ENV
    root=${CTV_OPTION_B_TEST_ROOT:-}
    [[ "$root" == /* && "$root" != *..* && "$root" != *//* && "${root%/}" == "$root" ]] || fail TEST_ROOT_INVALID
    [ -d "$root" ] && [ ! -L "$root" ] || fail TEST_ROOT_INVALID
    real=$(realpath -e -- "$root") && [ "$real" = "$root" ] || fail TEST_ROOT_NOT_CANONICAL
    for bad in $OB_UNSAFE_ROOTS; do
      if [ "$bad" = / ]; then [ "$root" != / ] || fail TEST_ROOT_UNSAFE
      else ob_under "$root" "$bad" && fail TEST_ROOT_UNSAFE; fi
    done
    [ "$(stat -c %u -- "$root")" = "$(id -u)" ] && ob_no_gw "$root" || fail TEST_ROOT_UNSAFE
    for p in "$REPO" "$CANON" "$WORK" "$UNIT_DEST" "$CORE_ENV" ${PATH_PREFIX:+"$PATH_PREFIX"}; do
      ob_under "$p" "$root" && [ "$p" != "$root" ] || fail HERMETIC_PATH_OUTSIDE_TEST_ROOT
      for bad in $OB_PROTECTED_PATHS; do ob_under "$p" "$bad" && fail HERMETIC_PATH_IS_PRODUCTION; done
      [ "$(realpath -m -- "$p")" = "$p" ] || fail HERMETIC_PATH_NOT_CANONICAL
    done
    ob_chain "$REPO" "$root" "$(id -u)" || fail REPO_NOT_TRUSTED
    GUARD_UID=$(id -u)
    CTV_SUDO=""
  else
    [ "$CANON" = "$OB_PROD_CANON" ] || fail CANON_NOT_PRODUCTION_PATH
    [ "$UNIT_DEST" = "$OB_PROD_UNIT" ] && [ "$CORE_ENV" = "$OB_PROD_CORE_ENV" ] || fail PRODUCTION_PATH_OVERRIDE_REFUSED
    [ -z "$PATH_PREFIX" ] || fail PRODUCTION_PATH_OVERRIDE_REFUSED
    ob_chain "$REPO" / 0 || fail REPO_NOT_ROOT_TRUSTED
    [ "$(realpath -e -- "$WORK")" = "$WORK" ] && [ ! -L "$WORK" ] && [ "$(stat -c %u -- "$WORK")" = 0 ] && ob_no_gw "$WORK" || fail WORK_NOT_ROOT_TRUSTED
    GUARD_UID=0
    # CTV_SUDO is pinned here, never inherited: root runs directly, anyone else uses the absolute system sudo.
    if [ "$(id -u)" = 0 ]; then CTV_SUDO=""; else CTV_SUDO=/usr/bin/sudo; fi
  fi
  export CTV_SUDO
}

# ob_trusted_file FILE — a regular, non-symlink file owned by the trusted uid and not group/world writable.
ob_trusted_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c %u -- "$1")" = "$GUARD_UID" ] && ob_no_gw "$1"
}
