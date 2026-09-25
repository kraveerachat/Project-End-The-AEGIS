---
title: Task Receipt — IDEA3 PR11 Phase 4 L4 live acceptance
date: 2026-09-25T11:51:31+07:00
owner: music
area: idea3
branch: docs/idea3-pr11-l4-live-acceptance
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 PR11 Phase 4 L4 live acceptance

> [!important] Two different things are recorded here
> **Live L4 Retry #4 was owner-run and DID mutate Production** (AP address, NetworkManager AP profile, dedicated dnsmasq unit).
> **This closeout task is documentation-only and performed NO Production mutation.** Its spot checks were read-only.

## What changed

- Records L4 live acceptance: `L4_LIVE_ACCEPTANCE = PROVEN` from owner-run Retry #4. L4 is left `APPLIED`; L5 not started.
- Adds this new immutable receipt and a new newest section in `idea3-status.md`. No prior receipt was edited.

### Retry #4 evidence (owner-run)

- `main_sha=47dfe0c4ed299c4453f8aaf63113b3ce03d9ce6a` (PR #210 merged: `fix(idea3-pr11): L4 dnsmasq excludes loopback (except-interface=lo)`)
- `runner_sha256=030edce09d9485874ec661bd2bce9590fa55c4e36a14ac5b7a8a0998e657504d`
- Evidence root: `/home/kittipat/Workspace/idea3-p4-evidence/2026-09-25-l4-20260925-114312` (RUN_ID `l4-20260925-114312`)
- Authorization: https://github.com/kraveerachat/Project-End-The-AEGIS/pull/210#issuecomment-5826873912
- K3 V2: https://github.com/kraveerachat/Project-End-The-AEGIS/pull/210#issuecomment-5826874058
- `L4_RETRY4_EXIT=0`, `JOURNAL_SINCE=2026-09-25 04:43:13 UTC`
- PRE: Engine PID=891 NRestarts=0; Tunnel PID=6321 NRestarts=56; Twingate PID=893; disk=82%; regulatory global=00, phy0=TH
- `CAPTURE_PRE=COMPLETE`, `SHA256=PASS`, `L4_APPLY=PASS`, `AP_INTERFACE=wlp0s20f3`, `AP_ADDRESS=10.77.30.1/28`, `DHCP_STATUS=AP_SCOPED`, `DNS_STATUS=CORE_LOCAL_ONLY`, `FORWARDING_TARGET=DISABLED`, `L4_VERIFY=PASS`, `CAPTURE_POST=COMPLETE`
- New listeners, approved only: `listen.tcp.10.77.30.1:53`, `listen.udp.10.77.30.1:53`, `listen.udp.0.0.0.0%wlp0s20f3:67`; no loopback DNS listener drift.
- Compare: `FINDINGS_NEW_OR_WORSENED_DRIFT=0`, `FINDINGS_BASELINE_UNHEALTHY_BUT_UNCHANGED=0`, `FINDINGS_INCOMPARABLE=0`, `FINDINGS_APPROVED_CHANGE=16`, `FINDINGS_INFO=3`, `DRIFT_RESULT=PASS`, `PRESERVATION_S10=PASS`, `COMPARE_RESULT=PASS`
- Regulatory POST: `phy0=TH global=00`; `GLOBAL_00_EQUALS_TH = NOT_CLAIMED`
- `L4_LIVE_EXECUTED=YES`, `L4_POST_CAPTURE=COMPLETE`, `L4_PRE_POST_COMPARE=PASS`, `L4_S10_PRESERVATION=PASS`, `L4_LIVE_ACCEPTANCE=PROVEN`, L4 left APPLIED
- `ESP32_DHCP_DNS_CLIENT_BEHAVIOUR = NOT_PROVEN` (not part of this run); `L5_STARTED = NO`

### Retry history

- Retry #1: external wired witness wrongly included volatile DHCP valid_lft/preferred_lft. Rollback PASS.
- Retry #2: external witness wrongly treated pre-existing legacy TCP/1883 as new. Rollback PASS.
- Retry #3: real repository gap — dnsmasq implicitly added loopback DNS listeners; canonical compare correctly failed; rollback PASS; PRE->RB compare PASS; S10 PASS.
- PR #210 fixed Retry #3 with `except-interface=lo`, keeping the exact L4 listener allowlist.

## Source files changed

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-25_115131_music_idea3-pr11-l4-live-acceptance.md` — this new receipt
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — new newest L4 live-acceptance section

## Verification evidence

- Read the Retry #4 evidence root (`owner-run.log`, `compare-pre-post.txt`, `authorization-L4.txt`, `k3-L4.txt`, `journal_since.txt`, `run_id.txt`) read-only — pass; values above match. `pre-root`/`post-root`/`l4-work` are root-owned and were not opened.
- Read-only spot checks of the currently APPLIED state at 2026-09-25T11:51:31+07:00 — pass:
  - `iw dev wlp0s20f3 info`: type AP, ssid AEGIS-IDEA3, channel 6
  - `ip -4 addr show dev wlp0s20f3`: 10.77.30.1/28
  - `aegis-idea3-dnsmasq.service`: active/running, enabled, MainPID=495659, NRestarts=0
  - `ss`: tcp+udp 10.77.30.1:53, udp 0.0.0.0%wlp0s20f3:67, tcp 0.0.0.0:1883 and [::]:1883 (pre-existing legacy), :8077 (python pid 891), 127.0.0.1:18002 (ssh pid 6321); no DNS :53 listener on 127.0.0.1 or ::1
  - `sysctl net.ipv4.ip_forward` = 0
  - IDEA2 engine active PID 891 NRestarts=0; tunnel active PID 6321 NRestarts=56; Twingate active PID 893 NRestarts=0 (unchanged from PRE)
  - default route via 192.168.1.1 dev enp62s0; 192.168.10.10 via dev sdwan0
  - `iw reg get`: global 00, phy0 (self-managed) TH
- `nft list ruleset` was NOT inspected live: it needs root and no passwordless sudo is available. Firewall state is covered only by the owner-run compare (no drift).
- `node scripts/validate-vault.mjs`, `git diff --check`, diff secret scan: see PR body for results.
- No application/runtime tests run (documentation-only).

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md` — L4 live acceptance section (`L4_LIVE_ACCEPTANCE = PROVEN`, `NEXT_LIVE_STAGE = L5_AFTER_L4_ACCEPTANCE_MERGE`, `PHASE4_RUNTIME_COMPLETE = NO`, `PR11_COMPLETE = NO`).

## Shared surfaces touched

- None by this task. The owner-run live stage changed only IDEA3 AP/DNS/DHCP surfaces; S10 preservation of IDEA2/Twingate/others PASSED.

## Integration requests

- Human review and merge of the closeout PR; L5 needs its own authorization and K3 after that merge.

## Known limitations

- ESP32 DHCP/DNS client behaviour is NOT proven.
- Live nftables was not re-inspected in this task (no root).
- Global regulatory 00 is not claimed equal to TH.
- Phase 4 runtime and PR11 are not complete.
