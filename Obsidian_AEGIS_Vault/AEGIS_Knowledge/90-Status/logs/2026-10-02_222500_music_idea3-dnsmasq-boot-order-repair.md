---
title: Task Receipt — IDEA3 dnsmasq boot-order repair (repository only)
date: 2026-10-02T22:25:00+07:00
owner: music
area: idea3
branch: fix/idea3-dnsmasq-boot-order
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 dnsmasq boot-order repair (repository only)

> [!important] Repository-only. IMPLEMENTED != DEPLOYED. No live host change, no service restart or `reset-failed`, no network or NetworkManager change, no reboot, no Core restart, no L8p, no F1 detector start, no Recovery R1-R8, no ESP32. The Production host still runs the OLD unit and `aegis-idea3-dnsmasq.service` is still `failed (start-limit-hit)` there.

## What happened (evidence, read-only)

- The host was rebooted twice by the operator: `sudo /usr/bin/reboot` on tty3 at 2026-10-02 21:58:50 and again at 22:00:55 +07 (logind: "The system will reboot now!", orderly `systemd-reboot`, clean unmount). No panic, Oops, MCE, thermal, OOM or power-loss entry. The journal does not say why the operator rebooted; no cause beyond the operator action is claimed (`REBOOT_CAUSE = operator-initiated`, reason unknown).
- After the final boot (22:01:22) the Core came up on release `55c7d181…` (`NRestarts=0`) and both the Recovery and alert sockets were recreated. `K12_PERSISTENCE_OBSERVED = YES`, `K12_FORMALLY_PROVEN = NO`, `K12_AUTOMATIC_REBOOT_PERSISTENCE = NOT_PROVEN`. This observation is not a K12 acceptance.
- `aegis-idea3-dnsmasq.service` failed on every observed boot (16:03, 18:56, 21:59 and 22:01) with `dnsmasq: unknown interface wlp0s20f3`, exit status 2, then `start-limit-hit`. In boot 0: the Wi-Fi device was renamed at 22:01:23, dnsmasq burned its five starts between 22:01:24 and 22:01:25 (`Restart=on-failure`, `StartLimitBurst=5` in 10 s, unit ordered only `After=NetworkManager.service`), and NetworkManager auto-activated `aegis-idea3-ap` and assigned `10.77.30.1/28` at 22:01:27. `DNSMASQ_ROOT_CAUSE = PROVEN` (boot-time ordering race; the config is valid, no port conflict).
- In the boot that ran V8 (19:42) dnsmasq was running only because the governed V8 run started it after the AP was active; that start did not survive a reboot.

## What changed

- `deploy/network/aegis-idea3-dnsmasq.service.example` — the canonical unit template gains a first `ExecStartPre`: a read-only bounded gate (`/usr/bin/timeout 30 sh -c 'until ip … | grep -Fq "inet <addr>/<prefix> " && iw dev <if> info | grep -Fq "type AP" && iw … | grep -Fq "channel <ch> "; do sleep 1; done'`) that releases the real dnsmasq only for the exact approved interface, IPv4/prefix, AP mode and channel. Also `TimeoutStartSec=45`, `RestartSec=2`, `StartLimitIntervalSec=300`, `StartLimitBurst=5` (unchanged value). Worst case total wait is five attempts of about 32 s (about 160 s), so the start limit really trips instead of being burned in one second. The existing `--test` pre-check, `ExecStart`, `After/Requires=NetworkManager.service` and `WantedBy` are unchanged. Owner values stay placeholders in the template.
- `deploy/pr11-phase4/p4-ap-network.py` — `render_dnsmasq_service(values)` now substitutes the four placeholders.
- `deploy/pr11-phase4/stages/L4/apply.sh` — the inline `printf` copy of the unit (a second canonical copy that would otherwise have stayed stale) is replaced by rendering the same template with `sed`, then refusing any unresolved `<AEGIS_` placeholder. One source of truth; a test asserts the renderer and L4 emit the identical unit.
- `deploy/pr11-phase4/p4-l34-reactivation-lib.sh` — `l34_dnsmasq_unit_gate` (called by the L34, V5, V6, V7 and V8 apply/verify handlers) kept exact byte identity but its authority is now the canonical template RENDERED with the fixed approved L34 values (new pure `l34_render_dnsmasq_unit`); the raw placeholder template, an old pre-gate unit and any mutation are refused, and an authority with an unresolved placeholder is refused (no pipe, so `pipefail` cannot invert the check). Found by independent review of the first revision of this PR (see below).
- `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-27-idea3-pr11-phase4-l34-post-reboot-reactivation-design.md` — wording updated from "byte-identical to the raw example" to "byte-identical to the canonical template after rendering with the fixed approved L34 values".
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_reactivation.py` — the shared L34 fixture no longer installs `EXAMPLE_UNIT.read_text()`; it installs the canonical rendered unit; plus a raw-template handler refusal test.
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_l34_dnsmasq_unit_authority.py` (new, 24 tests).
- Not changed: `dnsmasq-ap.conf` content, AP address, SSID/channel, DHCP pool, Core-local DNS mapping, `bind-interfaces`, NetworkManager profile semantics, V8 `autoconnect=yes`, broker configuration, forwarding=0, and all Recovery/L7u/L8p/F1 code. No NetworkManager dispatcher was needed. No new installed host artifact (the gate is inline in the unit, so L4 installs no extra file).

## Verification evidence

- RED first (new `tests/test_pr11_phase4_dnsmasq_boot_order.py`, 41 tests), run against the unchanged sources: 26 failed, 3 passed, 12 errors, all for the expected reason `the unit must carry exactly one bounded AP-readiness ExecStartPre`. (An earlier RED draft passed some negative cases for the wrong reason because the harness shims lost `cat`; that harness bug was fixed and RED was re-proven.)
- GREEN after the change: 41 passed. Coverage: A (NetworkManager up but AP interface unaddressed or absent -> no release), B (exact AP appears inside the window -> release; already ready -> immediate), C (never ready -> timeout rc 124, bounded), D (wrong interface, wrong IPv4, address or prefix that merely starts with the approved value, not AP mode, wrong channel -> refused), E (dnsmasq config, DHCP pool, DNS mapping, bind policy and the other unit lines unchanged), F (no nmcli, systemctl, link/addr/route change, rfkill, sysctl, forwarding, nft, Core, broker, Twingate, IDEA2, ESP32, Recovery or kill/reset in the unit), plus renderer == L4 unit identity and the live-value render (`wlp0s20f3`, `10.77.30.1/28`).
- `systemd-analyze verify` on a unit rendered with the live values: clean, nothing installed or started.
- Read-only reality check against the live host's current AP state (only `ip` and `iw` were read): the live-valued gate exits 0 immediately; the same gate with a wrong interface times out with 124.
- L34 authority fix, RED first: with the fixture now installing a rendered unit and the gate unchanged, the new authority tests failed (raw template accepted, rendered unit refused, L4-rendered unit refused, template-derived authority) and the existing L34 apply suite failed.
- GREEN: new `test_pr11_phase4_l34_dnsmasq_unit_authority.py` 24 passed (A raw template refused, B canonical rendered accepted, C L4-rendered accepted, D 16 mutations refused, E old pre-gate unit refused, unresolved/missing/symlink authority refused, all 8 gate call sites pinned); explicit fixture proof: CANONICAL_RENDERED_UNIT ACCEPT, RAW_PLACEHOLDER_TEMPLATE REFUSE, OLD_PREFIX_UNIT REFUSE, MUTATED_RENDERED_UNIT REFUSE.
- V6/V7/V8 scope-contract tests after the re-pin: 162 passed (with the authority and boot-order tests).
- Final overlapping suites (ap_network, L4 handler, boot-order, L34 authority, all L34/V4-V8, L6b, L7 and L7u): 2359 passed, 3 skipped, 0 failed in one same-day run (23m45s). An intermediate run crossed midnight and showed 18 L7 runner-flow failures (`authorization-L7.txt date is not today`); that was the date rollover invalidating same-day fixtures, the file passes alone, and the clean re-run above is the recorded result. The earlier 2334-pass figure did not exercise a rendered L34 unit and is superseded.
- `bash -n` on L4 apply.sh, `git diff --check`, `node scripts/validate-vault.mjs` (pass, 2 existing canvas warnings), `node scripts/validate-collaboration-policy.mjs` against the PR body (pass), and a diff secret scan (no hits) all pass.

## Independent review finding (fixed before merge)

- An independent review of the first revision (head `cd7d2f67`) found a blocking regression: `l34_dnsmasq_unit_gate` did `cmp -s <installed unit> <raw example>`, and the example had become a placeholder template, so a correctly rendered live unit could never match and every L34/V5/V6/V7/V8 reactivation apply/verify would have refused with `L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY` (read-only proof at review time: the live unit was accepted against the old example and refused against the new one).
- Why it was missed: the shared L34 fixture installed `EXAMPLE_UNIT.read_text()` verbatim, so the earlier 2334-test result did not exercise a real rendered L34 unit. That result is superseded by the run below.
- Fix: exact byte identity is kept; the authority is raw template -> canonical render with `L34_AP_IF`/`L34_AP_ADDR`/`L34_AP_PREFIX`/`L34_CHANNEL` -> byte comparison. All 8 gate call sites (l34 apply/verify, V5 apply, V6 apply, V7 apply/verify, V8 apply/verify; the earlier "nine" figure was a miscount) pass the template path; a test pins that set. No live mutation occurred.

## Intentional re-pin of the shared L34 library (owner-approved)

- The shared gate library `p4-l34-reactivation-lib.sh` is hash-pinned by the V6, V7 and V8 scope-contract tests as a frozen artifact. Its hash changed intentionally AFTER V8, only to fix the dnsmasq rendered-authority regression: the diff against main is exactly `l34_dnsmasq_unit_gate` (reworked) plus the new pure `l34_render_dnsmasq_unit`. The owner approved re-pinning only these three hashes:
  - V6 `LIB_PRE_V6_SHA256` (library prefix before the V6 section): `1adb7a803dc3652070ce7ac88b6f28e5dbd97cf68e825381caacd282dcb8716c` -> `fd31f01ca1f0ba979ef0752ed2c260fa0428080b04a367f99b77a9e27c8fd845`
  - V7 `LIB_PRE_V7_SHA256` (library prefix before the V7 section): `f985a26e506e1694c907821707df301b935eee4782da9cadf12b91839685c035` -> `ee5f992ab4486e1238788de40d0f74faca9e7ebad8d64546f83a1df7c36afdd3`
  - V8 shared-gate pin for `p4-l34-reactivation-lib.sh` (whole file): `b6e1d0d956c08fb87dea4733c569ae718ebf9a0321d4a8084f7c190a80bd3370` -> `08dd7de16cbc57a43b79f35f11e7b1dff011b29dffca5ddeef478f3524621a37`
  The hashes changed because the gate function lives in the early part of the file, so it falls inside both prefixes and the whole-file hash.
- Not re-pinned and unchanged: every L34/V4-V8 handler, runner, allow file, the V1-V6 and V7 pin sets, and all historical receipts. The V6, V7 and V8 live results are preserved as history and are not rewritten; nothing changed on the host.

## Governance truth

- `V8_RUNTIME_RECOVERY = PASS (historical)` is preserved. V8 never claimed K12 reboot persistence, and its own receipt already recorded that dnsmasq may lose its boot race. V8 is not rewritten and its acceptance is not invalidated. The persistent V8 mutation was the AP profile `autoconnect=no -> yes`.
- New finding, stated precisely: the reboot observation identified a separate dnsmasq startup-order gap outside the previously proven V8 runtime acceptance. AP autoconnect succeeds, but dnsmasq can lose the boot-time ordering race and stay `start-limit-hit` until started manually after AP readiness.
- This PR does not deploy the repair. A separately governed, qualified live stage must install the new unit (the live unit is the pre-fix copy), and the reboot behaviour must then be observed before K12 is considered.

## Source files changed

- `IDEA3-AEGIS_Lockdown/deploy/network/aegis-idea3-dnsmasq.service.example`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/p4-ap-network.py`
- `IDEA3-AEGIS_Lockdown/deploy/pr11-phase4/stages/L4/apply.sh`
- `IDEA3-AEGIS_Lockdown/tests/test_pr11_phase4_dnsmasq_boot_order.py` (new)

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new section for this finding and repository fix.

## Shared surfaces touched

- `None` — task stayed inside its selected area

## Integration requests

- None — valid only when no cross-scope/shared path changed

## Known limitations

- Repository only: the live unit is unchanged and dnsmasq is still failed on the host; the device DHCP/DNS path stays unavailable until a separate governed stage deploys and qualifies the repair. L8p provisioning is serial-only and not blocked by dnsmasq, but Recovery R5/R7 need the device network path.
- Deployment ordering: by design the L34 authority now refuses the pre-gate unit that is installed on the host today (read-only check: `L34_DNSMASQ_UNIT_NOT_ACCEPTED_AUTHORITY`). After this merges, any L34/V5-V8 reactivation run is refused until the new rendered unit is installed, so the governed repair stage must install it first.
- L8p, F1 detector start, Recovery R1-R8, LVR and L8 remain not executed. `K12_FORMALLY_PROVEN = NO`.
