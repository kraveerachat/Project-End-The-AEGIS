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
- Not changed: `dnsmasq-ap.conf` content, AP address, SSID/channel, DHCP pool, Core-local DNS mapping, `bind-interfaces`, NetworkManager profile semantics, V8 `autoconnect=yes`, broker configuration, forwarding=0, and all Recovery/L7u/L8p/F1 code. No NetworkManager dispatcher was needed. No new installed host artifact (the gate is inline in the unit, so L4 installs no extra file).

## Verification evidence

- RED first (new `tests/test_pr11_phase4_dnsmasq_boot_order.py`, 41 tests), run against the unchanged sources: 26 failed, 3 passed, 12 errors, all for the expected reason `the unit must carry exactly one bounded AP-readiness ExecStartPre`. (An earlier RED draft passed some negative cases for the wrong reason because the harness shims lost `cat`; that harness bug was fixed and RED was re-proven.)
- GREEN after the change: 41 passed. Coverage: A (NetworkManager up but AP interface unaddressed or absent -> no release), B (exact AP appears inside the window -> release; already ready -> immediate), C (never ready -> timeout rc 124, bounded), D (wrong interface, wrong IPv4, address or prefix that merely starts with the approved value, not AP mode, wrong channel -> refused), E (dnsmasq config, DHCP pool, DNS mapping, bind policy and the other unit lines unchanged), F (no nmcli, systemctl, link/addr/route change, rfkill, sysctl, forwarding, nft, Core, broker, Twingate, IDEA2, ESP32, Recovery or kill/reset in the unit), plus renderer == L4 unit identity and the live-value render (`wlp0s20f3`, `10.77.30.1/28`).
- `systemd-analyze verify` on a unit rendered with the live values: clean, nothing installed or started.
- Read-only reality check against the live host's current AP state (only `ip` and `iw` were read): the live-valued gate exits 0 immediately; the same gate with a wrong interface times out with 124.
- Overlapping suites (ap_network, L4 handler, the new boot-order tests, all L34 and V8, L6b handler, L7 and L7u): 2334 passed, 3 skipped, 0 failed (23m27s).
- `bash -n` on L4 apply.sh, `git diff --check`, `node scripts/validate-vault.mjs` (pass, 2 existing canvas warnings), `node scripts/validate-collaboration-policy.mjs` against the PR body (pass), and a diff secret scan (no hits) all pass.

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
- L8p, F1 detector start, Recovery R1-R8, LVR and L8 remain not executed. `K12_FORMALLY_PROVEN = NO`.
