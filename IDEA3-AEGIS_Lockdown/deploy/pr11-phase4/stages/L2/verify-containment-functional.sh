#!/usr/bin/env bash
# AEGIS IDEA3 PR11 Phase 4 — L2 dynamic IPv4 containment FUNCTIONAL
# verification.
#
# Repository-side and local-only. Proves the behavioral part of the
# host-verification contract in
# "IDEA3 PR11 Post-Containment Reconciliation + Live-Readiness Contract"
# (idea3-status.md), items 7-15 and 17:
#   block / repeated-block idempotency / membership listing / observed
#   traffic denial / unblock / repeated-unblock idempotency / observed
#   traffic restoration / audit evidence / no unrelated table mutated /
#   idempotent table rollback.
#
# It is NOT live-host or Production acceptance (items 1-6, 16, 18 of that
# contract are out of scope here; see FUNCTIONAL_ITEMS_NOT_IN_SCOPE below).
# `verify.sh` in this same directory remains the static/live-host config
# verifier; this script exercises the real `aegis_soc.ip_containment`
# module against a real `nft` binary, inside two disposable, unprivileged
# network namespaces this script creates and destroys. It never touches the
# live host firewall, never requires elevated/root privileges, and never
# mutates Production.
set -uo pipefail

fail() {
  printf 'L2_CONTAINMENT_FUNCTIONAL_VERIFY=FAIL reason=%s\n' "$1" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# stages/L2 -> stages -> pr11-phase4 -> deploy -> IDEA3-AEGIS_Lockdown
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

TEST_TABLE="aegis_idea3"
ATTACKER_ADDR="203.0.113.1"
VICTIM_ADDR="203.0.113.2"
PROTECTED_CIDR="198.51.100.0/29"

# Re-exec inside a fresh, disposable, unprivileged user+network namespace so
# every nft table, veth pair, and namespace this script creates is isolated
# from the real host network stack and requires no elevated/root privileges.
if [ "${AEGIS_L2_FUNCTIONAL_INNER:-0}" != 1 ]; then
  for tool in nft unshare nsenter ip python3; do
    command -v "$tool" >/dev/null 2>&1 || fail "TOOL_MISSING:${tool}"
  done
  unshare -rn true >/dev/null 2>&1 \
    || fail UNPRIVILEGED_NETNS_UNAVAILABLE
  exec env AEGIS_L2_FUNCTIONAL_INNER=1 unshare -rn "$0" "$@"
fi

PID_A=""
PID_V=""

cleanup() {
  local status=$?
  [ -n "$PID_V" ] && kill "$PID_V" >/dev/null 2>&1
  [ -n "$PID_A" ] && kill "$PID_A" >/dev/null 2>&1
  wait "$PID_A" "$PID_V" >/dev/null 2>&1
  return $status
}
trap cleanup EXIT

unshare -n sleep 90 & PID_A=$!
unshare -n sleep 90 & PID_V=$!

for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -e "/proc/$PID_A/ns/net" ] && [ -e "/proc/$PID_V/ns/net" ] && break
  sleep 0.2
done
[ -e "/proc/$PID_A/ns/net" ] && [ -e "/proc/$PID_V/ns/net" ] \
  || fail NAMESPACE_SETUP_FAILED

ip link add veth-l2fv-a type veth peer name veth-l2fv-v \
  || fail VETH_CREATE_FAILED
VETH_ADDED=1

ip link set veth-l2fv-a netns "$PID_A" || fail VETH_MOVE_FAILED
ip link set veth-l2fv-v netns "$PID_V" || fail VETH_MOVE_FAILED

nsenter -t "$PID_A" -n ip addr add "$ATTACKER_ADDR/24" dev veth-l2fv-a || fail ATTACKER_ADDR_FAILED
nsenter -t "$PID_A" -n ip link set veth-l2fv-a up || fail ATTACKER_LINK_UP_FAILED
nsenter -t "$PID_A" -n ip link set lo up || fail ATTACKER_LO_UP_FAILED

nsenter -t "$PID_V" -n ip addr add "$VICTIM_ADDR/24" dev veth-l2fv-v || fail VICTIM_ADDR_FAILED
nsenter -t "$PID_V" -n ip link set veth-l2fv-v up || fail VICTIM_LINK_UP_FAILED
nsenter -t "$PID_V" -n ip link set lo up || fail VICTIM_LO_UP_FAILED

# Pattern-faithful reproduction of deploy/network/aegis-idea3-nftables.conf.example:
# a drop-first blocked_ipv4 rule as the first rule of both input and forward,
# without the AP-interface-specific rules (those are covered by the existing
# static verify.sh / renderer tests, not this functional contract).
nsenter -t "$PID_V" -n nft -f - <<NFTEOF || fail NFT_BASELINE_LOAD_FAILED
table inet $TEST_TABLE {
    set blocked_ipv4 {
        type ipv4_addr
        size 4096
    }

    chain input {
        type filter hook input priority filter; policy accept;
        ip saddr @blocked_ipv4 drop
    }

    chain forward {
        type filter hook forward priority filter; policy accept;
        ip saddr @blocked_ipv4 drop
    }
}
NFTEOF

DRIVER_OUT="$(mktemp)"
nsenter -t "$PID_V" -n python3 - "$REPO_ROOT" "$PID_A" "$ATTACKER_ADDR" "$VICTIM_ADDR" "$PROTECTED_CIDR" \
  > "$DRIVER_OUT" 2>&1 <<'PYEOF'
"""Functional driver: exercises the REAL aegis_soc.ip_containment module
(ContainmentService, ContainmentServer, ContainmentClient, NftBlockSet)
against the REAL nft binary loaded into this process's network namespace.
Runs already-nsentered into the disposable "victim" namespace; the
"attacker" side is reached only through nsenter(1) for the ping checks.
"""
from __future__ import annotations

import atexit
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading

repo_root, attacker_pid, attacker_addr, victim_addr, protected_cidr = sys.argv[1:6]
sys.path.insert(0, repo_root)

from aegis_soc import ip_containment as ipc  # noqa: E402

results: list[tuple[str, bool]] = []


def item(number: str, ok: bool, detail: str = "") -> None:
    results.append((number, ok))
    print(f"ITEM_{number}={'PASS' if ok else 'FAIL'} {detail}", flush=True)


def ping_from_attacker() -> bool:
    result = subprocess.run(
        ["nsenter", "-t", attacker_pid, "-n", "ping", "-c1", "-W1", victim_addr],
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def ruleset_tables() -> set[str]:
    listing = subprocess.run(
        ["nft", "-j", "list", "ruleset"], capture_output=True, text=True, check=True
    )
    document = json.loads(listing.stdout)
    return {
        entry["table"]["name"]
        for entry in document["nftables"]
        if isinstance(entry, dict) and "table" in entry
    }


def table_exists() -> bool:
    return subprocess.run(
        ["nft", "list", "table", "inet", "aegis_idea3"], capture_output=True
    ).returncode == 0


def rollback_table_once() -> bool:
    if table_exists():
        subprocess.run(["nft", "delete", "table", "inet", "aegis_idea3"], check=True)
    return not table_exists()


protected = ipc.parse_protected_cidrs(protected_cidr)
block_set = ipc.NftBlockSet()
service = ipc.ContainmentService(block_set, protected)

audit_records: list[dict] = []
sock_dir = tempfile.mkdtemp(prefix="aegis-l2-containment-functional-verify-")
atexit.register(shutil.rmtree, sock_dir, ignore_errors=True)
sock_path = os.path.join(sock_dir, "containment.sock")

listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
listener.bind(sock_path)
listener.listen(4)
server = ipc.ContainmentServer(
    listener, service, allowed_uids={os.geteuid()}, audit=audit_records.append
)
server_thread = threading.Thread(target=server.serve_forever, daemon=True)
server_thread.start()

client = ipc.ContainmentClient(sock_path, timeout=3, expected_server_uid=os.geteuid())

response = client.block(attacker_addr)
item(
    "07",
    response["ok"] and response["changed"] and response["reason_code"] == "BLOCKED",
    json.dumps(response),
)

response = client.block(attacker_addr)
item(
    "08",
    response["ok"] and not response["changed"] and response["reason_code"] == "ALREADY_BLOCKED",
    json.dumps(response),
)

response = client.list()
item("10", response["ok"] and attacker_addr in response.get("blocked", []), json.dumps(response))

item("09", not ping_from_attacker(), "observed traffic denial from the blocked address")

response = client.unblock(attacker_addr)
item(
    "11",
    response["ok"] and response["changed"] and response["reason_code"] == "UNBLOCKED",
    json.dumps(response),
)

response = client.unblock(attacker_addr)
item(
    "12",
    response["ok"] and not response["changed"] and response["reason_code"] == "NOT_BLOCKED",
    json.dumps(response),
)

item("13", ping_from_attacker(), "observed traffic restoration after unblock")

block_audits = [record for record in audit_records if record.get("operation") == "block"]
unblock_audits = [record for record in audit_records if record.get("operation") == "unblock"]
item(
    "14",
    len(block_audits) == 2 and len(unblock_audits) == 2,
    f"audit_records={audit_records}",
)

tables = ruleset_tables()
item("15", tables == {"aegis_idea3"}, f"tables={sorted(tables)}")

first_rollback = rollback_table_once()
second_rollback = rollback_table_once()
item("17", first_rollback and second_rollback, f"first={first_rollback} second={second_rollback}")

sys.exit(0 if all(ok for _, ok in results) else 1)
PYEOF
DRIVER_EXIT=$?

cat "$DRIVER_OUT"

if grep -q 'ITEM_[0-9]*=FAIL' "$DRIVER_OUT"; then
  DRIVER_EXIT=1
fi

VERIFIED_ITEMS="07,08,09,10,11,12,13,14,15,17"
NOT_IN_SCOPE_ITEMS="16,18"

rm -f "$DRIVER_OUT"

if [ "$DRIVER_EXIT" -eq 0 ]; then
  printf 'L2_CONTAINMENT_FUNCTIONAL_VERIFY=PASS\n'
  printf 'FUNCTIONAL_ITEMS_VERIFIED=%s\n' "$VERIFIED_ITEMS"
  printf 'FUNCTIONAL_ITEMS_NOT_IN_SCOPE=%s\n' "$NOT_IN_SCOPE_ITEMS"
  printf 'LIVE_HOST_ACCEPTANCE=NO\n'
  printf 'PRODUCTION_MUTATION_PERFORMED=NO\n'
  exit 0
fi

printf 'L2_CONTAINMENT_FUNCTIONAL_VERIFY=FAIL reason=FUNCTIONAL_ITEM_FAILED\n' >&2
printf 'PRODUCTION_MUTATION_PERFORMED=NO\n' >&2
exit 1
