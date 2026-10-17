# 15 — Production activation runbook for the read-only status feature (OWNER-ONLY)

**Nothing in this document was executed.** Every mutating step below is an owner procedure in a written maintenance window; no agent performs it unattended. It activates only the **read-only status feature** (Core → Desktop and Core → Web). It does not enable CUT, RESTORE, MQTT publishing, relay or ESP32 control, and a successful run is **not** hardware acceptance. If anything in section L happens, stop and roll back.

Authoritative companions: doc 11 (transport runbook), 12 (readiness matrix and HUB read-only command package), 13 (packaging), 14 (deployment readiness package).

## Read-only observations at preparation time (2026-10-18, Core host, nonprivileged)

| Item | Observation |
|---|---|
| Core service | `aegis-idea3-core.service` active, `MainPID=939`, `ActiveEnterTimestamp=Fri 2026-10-16 20:07:53 +07` (the preservation baseline) |
| Installed Core release | `/opt/aegis-idea3/current -> …/releases/954ce1c191885e9e90198a6f54a3d990bcf144fc` (8 releases present) |
| Status units / sidecar | none installed; `/opt/aegis-idea3-status` does not exist |
| Clock | `NTPSynchronized=yes` (this host, this instant); HUB clock UNKNOWN |
| DNS | `idea3-core.aegis.internal` → `192.168.10.10` (resolved locally; source of the entry not determined) |
| Route | `192.168.10.10` is reached only via the default gateway `192.168.1.1` on Wi-Fi `wlp0s20f3` (`192.168.1.117/24`); `enp62s0` is DOWN. Reachability of the HUB machine endpoint is **UNVERIFIED and was not probed** (BLOCKED until the owner authorizes a handshake test) |
| AP / broker | `hostapd` inactive, `dnsmasq` inactive, `mosquitto` active; no listener on 8883; **1883 plaintext listening on `0.0.0.0` and `[::]`** |
| Python | `/usr/bin/python3` 3.14.7 (matches the tested minor) |
| Groups | `aegis-idea3`, `-detector`, `-recovery` (operator is a member), `-alert`; **no status group** |
| HUB / Web container | not accessible from here: image identity, nginx machine block, certificates, flag state UNKNOWN |

## A. Preflight and safety gates (all must hold; otherwise stop)

1. The single consolidated PR (#444) is merged by a human after independent review; record the merge commit `MAIN_SHA`.
2. Maintenance window written and approved by the owner; a second person can reach the HUB.
3. Capture the baseline and save it (compare in K):
   `readlink /opt/aegis-idea3/current`; `sha256sum /opt/aegis-idea3/releases/954ce1c191885e9e90198a6f54a3d990bcf144fc/RELEASE-SHA256SUMS`; `systemctl show aegis-idea3-core.service -p MainPID -p ActiveEnterTimestamp`; `ss -ltn`; `systemctl list-unit-files 'aegis-idea3*'`; `ls -ld /run/aegis-idea3`.
4. HUB operator has run the read-only package in doc 12 section 3 and the results are acceptable (Web image/revision, nginx machine block, certificate expiry, CRL, clock).
5. The Core-to-HUB route and DNS for the machine endpoint are verified by the owner-authorized probe (a single TLS handshake test is the only network action, run by the owner).
6. The dedicated status group decision is made (D).
7. Port 1883 exposure is acknowledged by the owner (separate infrastructure change; the feature neither needs nor fixes it).

## B. Exact approved identities (fill in; none is invented here)

* Source: `MAIN_SHA` = merge commit of #444; sidecar release id `status-sidecar-<first 12 of MAIN_SHA>`.
* Sidecar payload SHA-256: the six values in doc 14 section 1 must match the built package.
* Web image: `<digest recorded by the HUB operator>`; must contain the status-ingest route from this merge.
* Core release: `954ce1c191885e9e90198a6f54a3d990bcf144fc`, unchanged by this procedure.

## C. Sidecar: build, plan, install, activate (no service is started here)

1. As a normal user, from a **clean checkout of `MAIN_SHA`**: `python3 IDEA3-AEGIS_Lockdown/deploy/status-sidecar/build-status-sidecar.py build --source-root <checkout> --staging-root <user-owned dir> --release-id <id>` then `… verify <dir>/<id>`. A dirty tree is refused.
2. As root (the installer requires root for every live command, including `plan` and `status`): `python3 -I …/install-status-sidecar.py plan --release-id <id> --source <dir>/<id>`; review the output; then `install …`; then `activate --release-id <id>`. `install` never switches `current`; none of these commands touches the Core tree, `/run`, `/etc`, systemd or the network (output shows `SYSTEMD_ACTION=NONE`, `CORE_TOUCHED=NO`).
3. Verify: `status` lists the release as current; the Core baseline in A.3 is unchanged.

## D. Dedicated status group and minimum permissions (owner decision)

* Create a new group for the projection (not `aegis-idea3-recovery`); add only the Desktop operators who need it. Do not change the mode or ownership of `/run/aegis-idea3`.
* The units run as `aegis-idea3`, which already reads the Core status file. The publisher writes only `/run/aegis-idea3-status` (0750, group = the new group, files 0640).

## E. Web status-ingest flag (HUB operator)

Set `AEGIS_IDEA3_STATUS_INGEST_ENABLED=true` and the existing `AEGIS_IDEA3_DISPATCH_{PORT,TRUSTED_PROXY,EXPECTED_SUBJECT}` for the shared machine listener, with **no** `AEGIS_IDEA3_RUNTIME_STATUS_URL`/LAB feed; the nginx machine block must forward `X-Aegis-Client-Verify` and `X-Aegis-Client-DN`. Recreate the Web container from the approved image. Enabling status does not enable dispatch. Rollback: unset the flag and recreate from the previous image.

## F. Core publisher and pusher (owner, written window)

1. Copy the two unit templates, fill the status group placeholder (and, optionally, `IPAddressAllow=<HUB>`), copy the env template to `/etc/aegis-idea3/status-push.env` (paths only; keep `AEGIS_CORE_STATUS_PUSH_ENABLED=0` for now), `systemctl daemon-reload`.
2. Start the publisher only. Confirm the projection file appears with mode 0640 and the Core's own `updated_at`.
3. Only when the HUB, certificates and route are verified (A.4–A.5): set `AEGIS_CORE_STATUS_PUSH_ENABLED=1` and start the pusher. Neither unit has `[Install]`; enabling at boot is a separate later decision.

## G. Desktop read-only status

Start the Desktop with `AEGIS_CORE_STATUS_FILE=/run/aegis-idea3-status/status.projection.json` from an account in the new group. It reads only that file; there is no sudo fallback and no controller or MQTT call.

## H. Web Admin LIVE verification

Log in as Admin and open the Security Center. Expected: runtime evidence LIVE with the Core's `generatedAt` (not the Web's clock) advancing; relay, ACK and heartbeat **UNKNOWN**; a Core that is DEGRADED or UNKNOWN shows exactly that. HEALTHY is acceptable only if the Core itself reports it.

## I. Evidence freshness and fail-closed tests (never restart the Core)

1. Stop the **pusher only** (`systemctl stop aegis-idea3-status-push.service`): within the freshness window the Web evidence becomes UNKNOWN; start it: evidence resumes. The Core status writer is **not** stopped or restarted.
2. Restart the Web container: UNKNOWN until the next push (no persistence).
3. Stop the publisher: the Desktop shows UNKNOWN (runtime directory removed); start it: it recovers.
4. A browser or a client without the machine certificate cannot read or write status (expect refusals).

## J. Independent rollback

* **Web:** unset `AEGIS_IDEA3_STATUS_INGEST_ENABLED`, recreate from the previous image; the machine status route disappears (404).
* **Sidecar units:** stop the pusher, then the publisher; set `AEGIS_CORE_STATUS_PUSH_ENABLED=0`; remove the unit files and `daemon-reload` (owner). The Core is not touched.
* **Sidecar package:** `install-status-sidecar.py rollback` selects the previous verified release (or leave `current` and simply stop the units); no release is deleted; nothing is sent to any device.

## K. Preservation (compare with A.3; every line must be equal)

Core `current` link and release sums; Core `MainPID` and `ActiveEnterTimestamp` (no Core restart); Recovery units/files untouched; `ls -ld /run/aegis-idea3` unchanged; `ss -ltn` listener set unchanged; no unit enabled except by explicit owner decision; unrelated IDEA1/IDEA2 services (same `docker ps`/service state before and after).

## L. Stop immediately and roll back if

The Core `MainPID` or start time changes; any installer command reports a refusal that is not understood; `/run/aegis-idea3` permissions change; the Web shows HEALTHY while the Core is DEGRADED/UNKNOWN or while evidence is stale; evidence timestamps follow the Web clock; a dispatch route answers in status-only mode; any unexpected listener or unit appears; a credential is printed; the HUB operator reports an nginx or certificate anomaly.

## Acceptance wording

Completing this runbook yields **real status synchronization evidence only**. Relay, ACK, heartbeat, ESP32, AP and broker acceptance are separate and unresolved; the cyber-physical system must not be described as accepted.
