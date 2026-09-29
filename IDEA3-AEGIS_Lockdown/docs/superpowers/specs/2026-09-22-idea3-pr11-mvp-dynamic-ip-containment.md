# IDEA3 PR11 — MVP Dynamic IP Containment (BLOCK_IP / UNBLOCK_IP)

Date: 2026-09-22
Owner: Music (Pub reviewing)
Task: Close the MVP software containment gap recorded by the PR11 MVP scope freeze
Branch: `feat/idea3-mvp-dynamic-ip-containment`
Base: `origin/main` (`70082d317b77a7d52a88997f5111c496263f04e7`)
Status: SOURCE_IMPLEMENTED — MERGED as PR #181 (`21d7b7824e6edf1950a7bd914f5d780366fd13c7`, 2026-09-22); receipt recovered post-merge by PR #182
Production Mutation: NO
Live Firewall Mutation: NO
Live L-Stage Execution: NO

This spec implements the `SOFTWARE_IP_BLOCKING` / `SOFTWARE_IP_UNBLOCK` gap
defined in `2026-09-22-idea3-pr11-mvp-scope-freeze.md`. The scope-freeze
document stays unchanged as the historical binding scope.

## 1. Result

```text
SOFTWARE_IP_BLOCKING            = SOURCE_IMPLEMENTED
SOFTWARE_IP_UNBLOCK             = SOURCE_IMPLEMENTED
PRIVILEGE_BOUNDARY              = IMPLEMENTED (root socket-activated helper)
CORE_DIRECT_CAP_NET_ADMIN       = NO
AUTO_GENERIC_ATTACKER_CUT       = NO
GENERIC_ATTACKER_SOFTWARE_BLOCK = IMPLEMENTED
LOCAL_ADMIN_UNBLOCK             = IMPLEMENTED (aegisctl)
IPV4_MVP                        = YES
IPV6_CONTAINMENT                = FUTURE_WORK (rejected explicitly as IPV6_UNSUPPORTED)
HOST_VERIFIED                   = NO
LIVE_PROVEN                     = NO
PRODUCTION_COMPLETE             = NO
```

## 2. Architecture

```text
Core (aegis-idea3, unprivileged)      aegisctl (root or aegis-idea3 group)
            \                              /
             \  Unix socket, one JSON line /
              v                           v
   /run/aegis-idea3-containment/containment.sock   (root:aegis-idea3 0660)
              |
              v
   aegis-idea3-containment.service  (root, CapabilityBoundingSet=CAP_NET_ADMIN)
              |  exact argv, no shell
              v
   /usr/bin/nft  ->  table inet aegis_idea3  ->  set blocked_ipv4
```

- Code: `aegis_soc/ip_containment.py` (stdlib only). The same module holds the
  helper (`python -m aegis_soc.ip_containment`) and `ContainmentClient`.
- The Core unit `deploy/aegis-idea3-core.service.example` is unchanged:
  `NoNewPrivileges=true`, empty `CapabilityBoundingSet` and
  `AmbientCapabilities`. The Core only needs `AF_UNIX`, which it already has.
- The helper checks `SO_PEERCRED` (root or the `aegis-idea3` account); the
  client checks that the socket's server is root.
- The helper only adds, deletes, and reads elements of `blocked_ipv4`. It
  never flushes, never creates or deletes tables or chains, never touches NAT,
  forwarding, or routes.
- No Web or browser path can reach the helper in this PR.

## 3. Request contract

One newline-terminated JSON object per connection, at most 256 bytes.

| Request | Meaning |
|---|---|
| `{"op":"block","ip":"203.0.113.10"}` | add to `blocked_ipv4` |
| `{"op":"unblock","ip":"203.0.113.10"}` | remove from `blocked_ipv4` |
| `{"op":"contains","ip":"203.0.113.10"}` | read-only membership |
| `{"op":"list"}` | read-only listing |

Every response carries `ok`, `changed`, `operation`, `ip`, `reason_code`.

| Case | ok | changed | reason_code |
|---|---|---|---|
| first block | true | true | `BLOCKED` |
| repeat block | true | false | `ALREADY_BLOCKED` |
| first unblock | true | true | `UNBLOCKED` |
| repeat unblock | true | false | `NOT_BLOCKED` |
| nft failed / not confirmed by re-read | false | false | `NFT_FAILED` |
| protected target | false | false | `PROTECTED_ADDRESS` |
| invalid / IPv6 / unsafe target | false | false | `INVALID_IP`, `IPV6_UNSUPPORTED`, `UNSPECIFIED_ADDRESS`, `LOOPBACK_ADDRESS`, `MULTICAST_ADDRESS`, `LINK_LOCAL_ADDRESS`, `RESERVED_ADDRESS` |
| bad request | false | false | `MALFORMED_REQUEST`, `UNKNOWN_OPERATION`, `REQUEST_TOO_LARGE`, `PEER_NOT_AUTHORIZED` |

Success is reported only after a JSON re-read of the set shows the change.
RFC1918 targets are allowed on purpose, because the authorized attack client
may use private addressing.

## 4. Protected addresses (fail closed)

`/etc/aegis-idea3/containment.env` must set
`AEGIS_CONTAINMENT_PROTECTED_CIDRS` to a comma-separated list of IPv4 CIDRs.
The helper refuses to start when the list is missing, empty, malformed,
non-IPv4, has host bits set, or is `0.0.0.0/0`. The L2 renderer seeds the
private AP subnet so the ESP32 controller link can never be software-blocked.
The owner must append management/operator CIDRs in the render directory before
L2 apply. Unblock ignores protection so a stale block can always be removed.

## 5. nftables contract

`deploy/network/aegis-idea3-nftables.conf.example` now declares
`set blocked_ipv4 { type ipv4_addr; size 4096 }`. The first rule of both the
`input` and `forward` chains is `ip saddr @blocked_ipv4 drop`, so the block
precedes every accept in this table. A drop is final across nftables tables,
so other tables' accepts cannot undo it. Set elements are runtime state: an L2
reload or rollback deletes the table and clears them.

## 6. Core behavior

| Condition | Result |
|---|---|
| generic detector attacker IP, `AEGIS_AUTO_CONTAIN=0` | `detector_alert` only |
| DISARMED | `auto_containment_blocked`, no mutation |
| dry-run | `software_containment_noop` (`DRY_RUN`), no helper call |
| ARMED + `AEGIS_AUTO_CONTAIN=1` | `BLOCK_IP` via helper → `software_containment_success` / `software_containment_noop` / `software_containment_failed` |
| helper unreachable | `software_containment_failed` (`HELPER_UNAVAILABLE`) |

The generic `_on_attacker` callback no longer issues physical `CUT_UPLINK`.
The explicit authenticated CRITICAL/CUT dispatch path and `RESTORE_UPLINK`
behavior are unchanged.

## 7. Local administration

```text
aegisctl block-ip <IPv4>
aegisctl unblock-ip <IPv4>
aegisctl blocked-ips
```

Exit codes: `0` ok, `2` refused by the helper, `1` helper unavailable.
`unblock-ip` is software recovery only. It is not ESP32 `RESTORE_UPLINK`.

## 8. L2 ownership

L2 already owns the `inet aegis_idea3` table lifecycle, so it also owns the
helper units:

- apply installs `aegis-idea3-containment.socket`, `.service`, and
  `/etc/aegis-idea3/containment.env`, validates the set and protection list,
  and (live only) enables the socket. The root helper starts on demand.
- verify compares those three files and (live only) checks the set is loaded
  and the socket is active and enabled.
- rollback stops and disables the socket and service before deleting the
  table, removes only these IDEA3-owned files, and stays idempotent.
- L0 capture records both units; the read-only guard now allows
  `systemctl show` on `.socket` units. L2 `allow-keys.txt` lists the new keys.

The helper runs from `/opt/aegis-idea3/current`, which must be root-owned and
not writable by `aegis-idea3`; this must be confirmed at host verification.

## 9. Verification

Repository and isolated evidence only:

- `tests/test_ip_containment.py`, `tests/test_cli_ip_containment.py`, the
  supervisor cases in `tests/test_runtime.py`, and the L2 containment cases in
  `tests/test_pr11_phase4_l2_handler.py`.
- The rendered ruleset passes `nft -c -f`, and the helper was exercised
  against real `nft` 1.1.7 inside an unprivileged user+network namespace
  (`unshare -rn`). The host firewall was not touched.

## 10. Open

- Host verification on the Arch Linux Core (L2 live) — requires owner authorization.
  See the exact host-verification contract in `idea3-status.md`, "IDEA3 PR11
  Post-Containment Reconciliation + Live-Readiness Contract — 2026-09-23".
- Owner management CIDRs in `containment.env`.
- IPv6 containment — Future Work.
- Persistence of blocks across L2 reload/reboot — not provided (runtime state only).
