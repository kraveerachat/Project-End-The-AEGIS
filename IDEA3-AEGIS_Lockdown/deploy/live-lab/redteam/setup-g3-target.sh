#!/usr/bin/env bash
# G3 CRITICAL target: a dedicated, deliberately unusable-by-password sshd, for one purpose only -- producing
# ssh_login_after_failures evidence WITHOUT ever brute-forcing or logging into the Core's own real sshd.
# Builds exactly what review/redteam/design-G3-critical.md Option A describes (owner-approved 2026-10-26).
# REVIEW BEFORE RUNNING.
#   sudo ~/aegis-live-run/review/setup-g3-target.sh
# Undo everything: sudo ~/aegis-live-run/review/teardown-g3-target.sh    (idempotent)
#
# Prerequisite: the attacker namespace must already be up (deploy/live-lab/redteam/attacker-ns-up.sh), because this
# script adds its one new address to aegis-att-h, the HOST side of that veth -- never to the AP interface, never
# inside 10.77.30.0/28 or 192.168.1.0/24, never reachable from the Internet or the home LAN. No nftables rule and
# no route is added anywhere: the attacker namespace already holds the kernel's own connected-subnet route for
# 10.90.90.0/29 (see attacker-ns-up.sh), and etc/nftables.conf's one table scopes every drop rule to
# iifname "wlp0s20f3" with a policy-accept fallthrough for every other interface, so traffic on aegis-att-h to a
# new address on the SAME host needs no firewall change (checked by reading that file; this script does not run
# nft at all).
#
# WHAT THIS SCRIPT CREATES (torn down by teardown-g3-target.sh, same mechanism, idempotent):
#   1. one address, 10.90.90.5/29, on aegis-att-h
#   2. one new, dedicated system account ($TARGET_USER): no home, shell /usr/sbin/nologin, LOCKED password
#      (passwd -l -- never merely absent; it can never be password-authenticated, on this sshd or any other,
#      because a locked crypt hash never matches any input)
#   3. one host key, generated fresh into /run/aegis-g3-target/ (never the Core's own host key in /etc/ssh)
#   4. one client keypair, generated into review/redteam/g3-target/ (operator-owned, outside Core secrets and the
#      repo's own secrets/ tree) -- its PUBLIC half becomes this sshd's one authorized key; the PRIVATE half is
#      what the operator uses by hand for the one key-only login this target will ever accept
#   5. one sshd_config, root-owned, under /run/aegis-g3-target/: PasswordAuthentication yes (needed so the locked
#      account still produces ordinary "Failed password" log lines for the brute-force half of the test -- the
#      hash can never match, so no guess can ever succeed; this is what Option A's analysis in the design note
#      relies on), PubkeyAuthentication yes with exactly the one key above, AllowUsers restricted to the one
#      account, listening ONLY on 10.90.90.5:2222 (a non-standard port on an isolated address, so this is never
#      confused with, and never shares a listening socket with, the Core's real sshd on :22)
#   6. one transient systemd unit (User=root -- sshd needs root to bind and to switch to the connecting user on a
#      successful login, exactly like production's real sshd, which is also why the detector trusts _UID=0
#      sshd/sshd-session records at all) running THIS config file and THIS host key only
#
# SANDBOXING (mirrors setup-graduated.sh's containment-helper unit, with two documented, reasoned exceptions):
#   ProtectSystem=strict, ProtectHome=yes, PrivateTmp=yes, NoNewPrivileges=yes, ProtectKernelTunables=yes,
#   ProtectKernelModules=yes, ProtectControlGroups=yes, RestrictNamespaces=yes, LockPersonality=yes, and the SAME
#   InaccessiblePaths= secret-path list setup-graduated.sh uses (kept in sync by hand; see HIDE_COMMON below),
#   checked after the unit starts by reading its own /proc/<pid>/root view, exactly like setup-graduated.sh's
#   sandbox_report.
#   NOT applied, and why: (a) CapabilityBoundingSet is left at its default (full, since User=root already) --
#   sshd's own privilege-separation model re-execs itself and setuid()s to the connecting account's uid as part of
#   a normal accepted session, which needs CAP_SETUID/CAP_SETGID/CAP_SYS_CHROOT; restricting the bounding set the
#   way the (capability-light, non-setuid) containment helper does would risk sshd failing AFTER logging
#   "Accepted" but in a way not exercised here, so it is left alone rather than guessed at;
#   (b) PrivateDevices is not set -- it can hide /dev/ptmx, which an interactive session needs for a pty, and this
#   script has not verified what OpenSSH 10.5p1 does in that case. Neither exception weakens the account's
#   isolation (InaccessiblePaths + ProtectHome + ProtectSystem=strict + a locked, key-only, no-shell account still
#   apply); both are left for your review before this runs.
#
# CONFIRMED LIVE 2026-10-27: a first run of this unit (full CapabilityBoundingSet, no AmbientCapabilities=) failed
# every connection with "setresuid 65534: Operation not permitted [preauth]" in the unit's own journal. Read from
# /proc/<pid>/status on the running (root) daemon itself -- no connection, no fork, no privsep child involved yet --
# CapBnd included CAP_SETUID (bit 7) but CapPrm/CapEff did NOT: of every bit CapBnd held, CAP_SETUID was the ONLY
# one missing from CapPrm/CapEff (CAP_SETGID, CAP_SYS_CHROOT, CAP_CHOWN, CAP_DAC_OVERRIDE, CAP_SETPCAP, CAP_KILL,
# CAP_SYS_RESOURCE, CAP_AUDIT_WRITE -- the rest of the originally-considered list -- were already present in
# CapPrm/CapEff without any extra setting). A capability can be in Bounding without being in Permitted/Effective:
# Bounding is only a ceiling on what a later execve may grant, and apparently this systemd version does not carry
# CAP_SETUID through for a `User=root` unit unless told to. The fix is `AmbientCapabilities=`, not loosening
# NoNewPrivileges: Ambient capabilities are a kernel mechanism (Linux 4.3+) specifically for "this capability
# survives my own process's later privilege drop (setuid/setresuid away from root)" -- precisely sshd's privsep
# case -- and systemd guarantees an Ambient capability lands in Permitted+Effective after exec regardless of
# NoNewPrivileges. NoNewPrivileges=yes is KEPT (not flipped to no): it was never the cause (it blocks gaining new
# privileges via exec of setuid binaries / LSM transitions, not a process's own setresuid using capabilities it
# already holds), and the capability bit-dump above shows no change tied to it. The full originally-considered
# list is still granted as Ambient below, even though only CAP_SETUID was empirically proven missing, so the
# fix is not fragile to a systemd-version difference that drops more than this one bit elsewhere.
#
# Also checked and ruled out: modern OpenSSH (10.5p1, confirmed via `sshd -V`) has no "UsePrivilegeSeparation"
# directive and the installed sshd binary's strings hold no "var/empty" or "privsep" chroot-path reference --
# privilege separation here is the modern seccomp-based preauth sandbox, not the old chroot-into-a-directory
# design, so no extra writable directory or ReadWritePaths= is needed for privsep itself.
#
# WHAT THIS SCRIPT NEVER TOUCHES: /etc/ssh (the Core's real sshd, its config, its host keys), any existing account,
# core.env, any nftables table, any route, the AP interface, the ESP32, or any production aegis-idea3-* unit. It
# refuses to start if the target address, account, port, or state file already exist. Prints no secrets (the
# client private key's PATH is printed; its CONTENTS never are).
set -Eeuo pipefail
trap 'echo "FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR

die() { echo "ERROR: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run with sudo"
CORE_USER="${SUDO_USER:?run through sudo so the operator is known}"
[[ $CORE_USER != root ]] || die "SUDO_USER is root; run as the operator through sudo"
HOME_DIR="$(getent passwd "$CORE_USER" | cut -d: -f6)" || die "could not determine the operator's home directory"
[[ -n $HOME_DIR && -d $HOME_DIR ]] || die "the operator home directory is empty or missing"
WORK="$HOME_DIR/aegis-live-run"
TEARDOWN="$WORK/review/redteam/teardown-g3-target.sh"
KEYDIR="$WORK/review/redteam/g3-target"

VH="aegis-att-h"                      # must already exist: deploy/live-lab/redteam/attacker-ns-up.sh
TARGET_ADDR="10.90.90.5"
PREFIX=29
TARGET_PORT=2222
TARGET_USER="aegis-g3-sshd"
RUNDIR="/run/aegis-g3-target"
HOSTKEY="$RUNDIR/ssh_host_ed25519_key"
AUTHKEYS="$RUNDIR/authorized_keys"
SSHD_CONFIG="$RUNDIR/sshd_config"
UNIT="aegis-g3-target-sshd"
# Granted as Ambient (not just Bounding) so they survive sshd's own privsep setuid/setresuid away from root --
# see the CONFIRMED LIVE 2026-10-27 header note. CapabilityBoundingSet is left at its default (full); this list is
# a strict subset of it, carried into Permitted+Effective across sshd's own credential change, nothing more.
NEEDED_CAPS=(CAP_SETUID CAP_SETGID CAP_SYS_CHROOT CAP_CHOWN CAP_DAC_OVERRIDE CAP_SETPCAP CAP_KILL CAP_SYS_RESOURCE CAP_AUDIT_WRITE)
STATE="/run/aegis-g3-target.state"

as_user() { runuser -u "$CORE_USER" -- "$@"; }
setstate() { echo "$1=1" >> "$STATE"; }

# Same secret-path list setup-graduated.sh hides from its two units (kept in sync by hand; the two scripts are
# independent and neither sources the other). The leading "-" makes systemd ignore a path that does not exist.
HIDE_COMMON="-/run/aegis-live -/run/aegis-idea3-alert -/run/aegis-idea3-containment -/run/credentials -/run/NetworkManager -/opt -/etc/ssh -/etc/ssl/private -/etc/NetworkManager/system-connections -/var/lib/aegis-idea3 -/etc/shadow -/etc/gshadow -$WORK -$KEYDIR"
MUST_BE_HIDDEN=(
  "$WORK" "$WORK/secrets/k_c2d" "$WORK/secrets/k_d2c" "$WORK/secrets/pki/server.key" "$WORK/secrets/pki/ca.key"
  "$WORK/etc/core.env" "$WORK/etc/mosq/passwd" "$WORK/backup" "$KEYDIR"
  /run/aegis-live /run/aegis-live/cut.sock /run/aegis-live/local-restore.sock /run/aegis-live/status.json
  /run/aegis-idea3-alert /run/aegis-idea3-containment /opt/aegis-idea3 /run/credentials
  /etc/ssh/ssh_host_ed25519_key /etc/shadow
)

visible() {
  local p="/proc/$1/root$2"
  if [ -d "$p" ]; then [ -n "$(ls -A -- "$p" 2>/dev/null)" ]
  elif [ -e "$p" ]; then [ -s "$p" ] || [ -S "$p" ]
  else false; fi
}
sandbox_report() {
  local pid=$1 leaked=0 p
  [[ -d /proc/$pid/root/usr ]] || die "cannot inspect /proc/$pid/root; refusing to treat that as 'hidden'"
  echo "   [$UNIT] isolation check (pid $pid, uid $(awk '/^Uid:/ {print $2}' "/proc/$pid/status"))"
  for p in "${MUST_BE_HIDDEN[@]}"; do
    if visible "$pid" "$p"; then echo "      VISIBLE (must be hidden): $p"; leaked=1; fi
  done
  [[ $leaked -eq 0 ]] || return 1
  echo "      all ${#MUST_BE_HIDDEN[@]} secret paths hidden"
}

# cap_check <pid>: every name in NEEDED_CAPS must be set in that process's CapEff (/proc/<pid>/status), by bit
# number -- not just in CapBnd, which only bounds what a later execve may grant (see the CONFIRMED LIVE header
# note: CapBnd having a capability does not mean CapEff/CapPrm does). Fails loudly, names exactly which bit.
cap_check() {
  local pid=$1 effhex
  effhex="$(awk '/^CapEff:/ {print $2}' "/proc/$pid/status")"
  [[ $effhex =~ ^[0-9a-fA-F]+$ ]] || die "could not read CapEff for pid $pid"
  CAP_EFF_PID="$pid" CAP_EFF_HEX="$effhex" CAP_NAMES="${NEEDED_CAPS[*]}" python3 - <<'PY'
import os, sys
bits = {
    "CAP_CHOWN": 0, "CAP_DAC_OVERRIDE": 1, "CAP_DAC_READ_SEARCH": 2, "CAP_FOWNER": 3, "CAP_FSETID": 4,
    "CAP_KILL": 5, "CAP_SETGID": 6, "CAP_SETUID": 7, "CAP_SETPCAP": 8, "CAP_SYS_CHROOT": 18,
    "CAP_SYS_RESOURCE": 24, "CAP_AUDIT_WRITE": 29,
}
eff = int(os.environ["CAP_EFF_HEX"], 16)
missing = [n for n in os.environ["CAP_NAMES"].split() if eff & (1 << bits[n]) == 0]
print(f"   [cap_check] pid={os.environ['CAP_EFF_PID']} CapEff=0x{eff:x}")
if missing:
    print("      MISSING from CapEff: " + " ".join(missing))
    sys.exit(1)
print("      all " + str(len(os.environ["CAP_NAMES"].split())) + " needed capabilities present in CapEff")
PY
}

# ---- rollback on every non-success exit --------------------------------------------------------------------------------
STARTED=0
SUCCESS=0
TD_SHA=""
on_exit() {
  local rc=$?
  trap - EXIT INT TERM HUP ERR
  if [[ $STARTED -eq 1 && $SUCCESS -ne 1 ]]; then
    echo; echo "SETUP DID NOT COMPLETE (exit $rc) -> rolling back with the teardown script" >&2
    if [[ -f $TEARDOWN && ! -L $TEARDOWN && $(sha256sum < "$TEARDOWN" | cut -d' ' -f1) == "$TD_SHA" ]]; then
      "$TEARDOWN" || echo "WARNING: the teardown reported leftovers; run it again by hand" >&2
    else
      echo "ERROR: $TEARDOWN is missing, a symlink, or changed since this run started; NOT executing it. Review it and run it by hand." >&2
    fi
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# ---- preflight (read-only) ----------------------------------------------------------------------------------------------
echo "== preflight (read-only)"
for tool in ip ssh-keygen sshd useradd passwd systemd-run ss; do command -v "$tool" >/dev/null || die "missing tool: $tool"; done
[[ ! -e $STATE && ! -L $STATE ]] || die "$STATE exists: a G3 target may already be up. Run teardown-g3-target.sh first."
[[ -f $TEARDOWN && ! -L $TEARDOWN ]] || die "$TEARDOWN is missing or a symlink"
TD_SHA="$(sha256sum < "$TEARDOWN" | cut -d' ' -f1)" || die "could not hash the teardown script"
ip link show "$VH" >/dev/null 2>&1 || die "$VH does not exist; run attacker-ns-up.sh first"
! ip -4 -o addr show dev "$VH" | awk '{print $4}' | grep -qx "$TARGET_ADDR/$PREFIX" || die "$TARGET_ADDR/$PREFIX is already on $VH; refusing"
! ss -ltn "( sport = :$TARGET_PORT )" 2>/dev/null | grep -q LISTEN || die "something already listens on port $TARGET_PORT; refusing"
! getent passwd "$TARGET_USER" >/dev/null || die "account $TARGET_USER already exists (not ours to touch); refusing"
[[ ! -e $RUNDIR && ! -L $RUNDIR ]] || die "$RUNDIR already exists; refusing"
[[ ! -e $KEYDIR && ! -L $KEYDIR ]] || die "$KEYDIR already exists; refusing (teardown removes it; run that first if this is a leftover)"
systemctl is-active --quiet "$UNIT.service" 2>/dev/null && die "$UNIT.service is already active; refusing"
SSHD_BIN="$(command -v sshd)" || die "sshd not found"
"$SSHD_BIN" -V 2>&1 | grep -q '^OpenSSH' || die "unexpected sshd -V output; refusing to guess its logging behaviour"
echo "   operator=$CORE_USER  veth host side=$VH  target=$TARGET_ADDR:$TARGET_PORT  sshd=$("$SSHD_BIN" -V 2>&1 | head -1)"

( set -C; umask 077; : > "$STATE" ) 2>/dev/null || die "could not create $STATE exclusively"
[[ -f $STATE && ! -L $STATE ]] || die "$STATE is not a regular file"
chown root:root "$STATE"; chmod 600 "$STATE"
STARTED=1

echo "== 1/6 address $TARGET_ADDR/$PREFIX on $VH (no route added: the namespace's existing connected-subnet route already covers it)"
setstate ST_ADDR
ip addr add "$TARGET_ADDR/$PREFIX" dev "$VH"
ip -4 -o addr show dev "$VH" | awk '{print $4}' | grep -qx "$TARGET_ADDR/$PREFIX" || die "address did not take"

echo "== 2/6 account $TARGET_USER: system account, no home, shell /usr/sbin/nologin, LOCKED password"
setstate ST_ACCOUNT
useradd --system --no-create-home --shell /usr/sbin/nologin \
  --comment "AEGIS G3 lab target (ephemeral, torn down by teardown-g3-target.sh)" "$TARGET_USER"
passwd -l "$TARGET_USER" >/dev/null
[[ $(passwd -S "$TARGET_USER" | awk '{print $2}') == L ]] || die "$TARGET_USER is not reported LOCKED after passwd -l; refusing"
echo "   $TARGET_USER created, shell=/usr/sbin/nologin, passwd -S reports LOCKED"

echo "== 3/6 runtime dir $RUNDIR, host key, authorized_keys"
setstate ST_RUNDIR
install -d -o root -g root -m 700 "$RUNDIR"
setstate ST_HOSTKEY
ssh-keygen -q -t ed25519 -N '' -C "aegis-g3-target host key (ephemeral, lab-only)" -f "$HOSTKEY"
chown root:root "$HOSTKEY" "$HOSTKEY.pub"; chmod 600 "$HOSTKEY"; chmod 644 "$HOSTKEY.pub"

echo "   client keypair (operator-held, outside Core secrets/repo): $KEYDIR/id_g3"
setstate ST_CLIENTKEY
as_user install -d -m 700 "$KEYDIR"
as_user ssh-keygen -q -t ed25519 -N '' -C "aegis-g3-target client key (lab-only, operator-held)" -f "$KEYDIR/id_g3"
install -o root -g root -m 600 /dev/null "$AUTHKEYS"
as_user cat "$KEYDIR/id_g3.pub" > "$AUTHKEYS"
chown root:root "$AUTHKEYS"; chmod 600 "$AUTHKEYS"
echo "   PRIVATE key for the manual login step: $KEYDIR/id_g3  (never printed; use it with: ssh -i $KEYDIR/id_g3 ...)"

echo "== 4/6 sshd_config: listen $TARGET_ADDR:$TARGET_PORT only, password+pubkey auth, one allowed user, no shell"
setstate ST_CONFIG
install -o root -g root -m 600 /dev/null "$SSHD_CONFIG"
cat > "$SSHD_CONFIG" <<EOF
# AEGIS G3 lab target sshd_config -- generated by setup-g3-target.sh. Ephemeral; never the Core's real config.
ListenAddress $TARGET_ADDR:$TARGET_PORT
HostKey $HOSTKEY
AuthorizedKeysFile $AUTHKEYS
AllowUsers $TARGET_USER
PermitRootLogin no
PasswordAuthentication yes
PermitEmptyPasswords no
PubkeyAuthentication yes
KbdInteractiveAuthentication no
UsePAM yes
X11Forwarding no
AllowTcpForwarding no
GatewayPorts no
PrintMotd no
LogLevel INFO
PidFile $RUNDIR/sshd.pid
EOF
chmod 600 "$SSHD_CONFIG"
"$SSHD_BIN" -t -f "$SSHD_CONFIG" || die "sshd rejects this config (sshd -t); not starting it"
echo "   sshd -t: config OK"

echo "== 5/6 transient unit $UNIT (root -- sshd needs it; sandboxed, see header comment for the two documented exceptions)"
setstate ST_UNIT
systemd-run --unit="$UNIT" --collect \
  -p User=root -p Group=root -p UMask=0077 \
  -p ProtectHome=yes -p InaccessiblePaths="$HIDE_COMMON" \
  -p NoNewPrivileges=yes -p PrivateTmp=yes \
  -p ProtectSystem=strict -p ProtectKernelTunables=yes -p ProtectKernelModules=yes -p ProtectControlGroups=yes \
  -p RestrictNamespaces=yes -p LockPersonality=yes \
  -p "AmbientCapabilities=${NEEDED_CAPS[*]}" \
  "$SSHD_BIN" -D -e -f "$SSHD_CONFIG" >/dev/null
sleep 1
systemctl is-active --quiet "$UNIT.service" || { journalctl -u "$UNIT.service" -n 20 --no-pager; die "$UNIT.service did not come up"; }
PID="$(systemctl show -p MainPID --value "$UNIT.service")"
[[ $PID =~ ^[0-9]+$ && $PID -gt 0 ]] || die "could not read the unit's main pid"
sandbox_report "$PID" || die "a secret path is visible inside $UNIT; aborting and rolling back"
cap_check "$PID" || die "a capability sshd's privsep needs is missing from CapEff; aborting and rolling back"
ss -ltn "( sport = :$TARGET_PORT )" 2>/dev/null | grep -q "$TARGET_ADDR:$TARGET_PORT" || die "sshd is not listening on $TARGET_ADDR:$TARGET_PORT"
echo "   listening on $TARGET_ADDR:$TARGET_PORT only (checked)"

echo "== 6/6 reachability guard"
ip netns exec aegis-att nc -z -w2 "$TARGET_ADDR" "$TARGET_PORT" 2>/dev/null \
  && echo "   OK: $TARGET_ADDR:$TARGET_PORT is reachable from the attacker namespace" \
  || echo "   NOTE: could not confirm reachability with nc (if nc is missing in the namespace, this is informational only)"

echo
echo "OK. G3 target is up: $TARGET_ADDR:$TARGET_PORT, account=$TARGET_USER (locked password, key-only, no shell)."
echo "Client private key (yours, do not share): $KEYDIR/id_g3"
echo "See review/redteam/README.md for the exact manual commands and timing guidance."
echo "Teardown: sudo $TEARDOWN"
SUCCESS=1
