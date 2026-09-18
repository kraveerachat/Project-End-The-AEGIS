# IDEA3 PR11 Phase 4 T6 — Local Trusted NTP Design

Date: 2026-09-18
Owner: Music
Task: T6 / G-05
Branch: `feat/idea3-pr11-phase4-t6-local-ntp`
Status: OWNER APPROVED DESIGN — repository implementation not started

## 1. Authority and decision

This design closes the repository contract for G-05 only.
It does not execute live stage L5.

OD-06 is decided by the owner:

- Core-local NTP server implementation: `chrony`.
- Trusted upstream: supplied by the owner at render/live time.
- The actual Production upstream value is not committed to Git.
- The Core must continue deriving trusted time from a trusted upstream.

## 2. Repository architecture

```text
owner-supplied trusted upstream
            |
            v
        p4-ntp.py
       render/validate
            |
            v
 rendered chrony configuration
            |
            | future L5 only
            v
       Core chronyd
            |
            v
 AP-address-only UDP/123 service
            |
            v
       ESP32/AP clients
```

The repository tool renders and validates material only. It never installs,
starts, stops, enables, disables, reloads, or reconfigures a live service.

## 3. Inputs

`p4-ntp.py render` requires:

- `--ap-address`: exact IPv4 address owned by the Core AP.
- `--ap-subnet`: exact IPv4 AP subnet containing the AP address.
- `--trusted-upstream`: owner-supplied trusted NTP upstream for this render.
- `--output-dir`: absent or empty repository-safe output directory.

The renderer chooses no Production address, subnet, hostname, public pool,
or upstream by itself.

## 4. Rendered artifacts

The deterministic render produces:

- `aegis-idea3-chrony.conf`
- `aegis-idea3-t6-contract.txt`

The chrony configuration must contain the owner-supplied upstream plus exact
AP-only bind and allow values.

Conceptual template:

```text
server <AEGIS_TRUSTED_NTP_UPSTREAM> iburst
bindaddress <AEGIS_AP_ADDRESS>
allow <AEGIS_AP_SUBNET>
```

The template contains placeholders only. Rendered output contains no unresolved
placeholder.

## 5. Fail-closed validation

Rendering or validation fails if any of the following is present:

- missing or malformed AP address;
- missing or malformed AP subnet;
- AP address outside the AP subnet;
- missing or malformed trusted upstream;
- newline or configuration injection in the upstream input;
- wildcard serving such as `0.0.0.0` or `::`;
- `allow all` or a client network other than the supplied AP subnet;
- unresolved angle-bracket placeholders;
- unsafe chrony `local` / local-stratum behavior;
- additional serving bind addresses;
- non-empty output directory overwrite.

The implementation must not add NAT, forwarding, DNS, DHCP, NetworkManager,
or nftables behavior. T5 already owns those contracts.

## 6. TrustedClock continuity

The existing TrustedClock safety contract is authoritative and is not weakened:

- successful synchronized state: `SYNCED`;
- maximum accepted kernel maxerror: `1,000,000 us`;
- bounded holdover: `300 seconds`;
- `HOLDOVER` is a temporary safety state, not the final L5 success state;
- final L5 success requires the Core to return to `SYNCED`.

No T6 source change may loosen `MAX_ERROR_US`, `HOLDOVER_SEC`, `TIME_ERROR`,
`STA_UNSYNC`, the time floor, or the trusted-state semantics.

## 7. Future L5 handoff contract

T6 records the handoff requirements but does not implement an executable live
stage handler.

Required future sequence:

1. Confirm L5 preconditions: G-05 merged, OD-06 decided, L4 PASS, fresh K3.
2. Prove the Core is `SYNCED` before the handoff.
3. Validate rendered chrony material before changing service ownership.
4. Transfer upstream time ownership from systemd-timesyncd to chronyd.
5. Re-check kernel synchronization immediately during the bounded handoff.
6. Require chronyd to synchronize to the owner-supplied trusted upstream.
7. Require final TrustedClock state `SYNCED` with maxerror within the existing bound.
8. Verify NTP serves the AP address only.
9. Verify an AP-side query succeeds and a non-AP query is not served.
10. Run the Phase 4 preservation checks.

Exact live `systemctl` ordering is intentionally not encoded by this repository
task; it is reviewed at the authorized L5 execution window.

## 8. Rollback contract

If synchronization is lost, the bound is exceeded, serving escapes the AP,
or any L5 preservation gate fails:

- stop the L5 transition;
- remove chronyd ownership of time serving;
- restore systemd-timesyncd to its L0 state;
- prove the Core is synchronized again;
- require final TrustedClock state `SYNCED` before considering rollback complete.

No fallback to a fabricated local trusted clock is allowed.

## 9. Repository evidence versus live evidence

T6 repository acceptance may prove:

- deterministic rendering;
- fail-closed input/config validation;
- exact AP-only chrony contract;
- trusted-upstream requirement;
- handoff and rollback requirements;
- TrustedClock threshold parity;
- preservation of the existing T5 UDP/123 firewall contract.

T6 repository acceptance does not prove:

- chrony installed on the Core;
- chronyd running;
- timesyncd-to-chronyd handoff executed;
- live upstream reachability;
- real AP-side NTP response;
- real non-AP denial;
- L5 PASS;
- Phase 4 runtime completion.

## 10. Security and mutation boundary

The repository implementation must contain no live package/service/network
mutation path. In particular it must not perform `pacman -S chrony`,
`timedatectl set-ntp false`, live `systemctl` changes, live `chronyd` launch,
route/address changes, nftables mutation, AP activation, or ESP32 mutation.

Production mutation remains NO.
