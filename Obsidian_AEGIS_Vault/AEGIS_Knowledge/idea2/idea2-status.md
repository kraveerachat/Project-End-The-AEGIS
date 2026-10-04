---
title: IDEA2 AEGIS Monitor
aliases: ["03 - 📹 IDEA2 AEGIS Monitor"]
tags: [aegis, monitor, cctv, soc, face-recognition, dual-view, mjpeg, heartbeat, telegram, i18n]
type: module-doc
created: 2026-07-20
updated: 2026-10-05
sources: ["[[raw/AEGIS_System_Design_extracted]]", "[[raw/AEGIS_Project_Knowledge_v7]]"]
owner: pub
edit_policy: owner-writable
---

# 📹 IDEA2: AEGIS Monitor (Dual-View SOC & CCTV Operator)

> [!info] Ownership
> Owner: **Pub**. This is the canonical IDEA2 status fragment. Kla reviews only shared integration surfaces; IDEA1/IDEA3 tasks do not write here.

## Current task — Multi-node camera provisioning (2026-10-05)

Branch: feat/idea2-multi-node-camera-provisioning; owner: Pub; starting main: 912b18005bb2fc80bb4e8d1fe8aa88803ac27314.

Current state: IN PROGRESS — REPOSITORY / LOCAL PREPARATION ONLY. Production mutation allowed: NO.

Authority model:
- Machine A: operator + CAM-01 and operator2 + CAM-02 resolve to Physical Camera A.
- Machine B: the same aliases resolve to Physical Camera B.
- Machine C: the same aliases resolve to Physical Camera C.

Each machine requires its own unique Node identity, server-generated physical-camera identity, protected Agent identity, SSH identity, reverse-forward allocation, and local camera-device selection. Logical aliases CAM-01 and CAM-02 are intentionally reusable per Node.

Machine A may prepare repository scripts, templates, preflight checks, runbooks, and acceptance collectors only. Machine B/C private identity, SSH private key, camera device, and protected Agent identity must be generated or discovered on the target machine itself. No Twingate change, PR2 mutation, or Production registration is authorized during preparation.

| ID | Scope | State | Next |
|---|---|---|---|
| MN-P0 | isolated task/worktree + authority model | PASS | checkpoint session note |
| MN-P1 | target-machine read-only preflight | PASS — SOURCE + MACHINE A SMOKE | run unchanged preflight on Machine B/C before any provisioning |
MN-P1 evidence: Windows PowerShell read-only target preflight added with 4/4 static regression tests PASS. Machine A real smoke PASS confirmed Windows/hardware, Python 3.12/3.14 x64, FFmpeg/libx264, camera metadata, OpenSSH, local port ownership, and existing AEGIS runtime ownership. The smoke reported SERVERCONTACT=NO, PRODUCTIONMUTATION=NO, TWINGATEMUTATION=NO, CAMERAOPEN=NO, CONFIGWRITE=NO, and PRIVATEKEYREAD=NO. This does not claim Machine B/C hardware acceptance; the same preflight must still run on each target machine before provisioning.

| MN-P2 | target-machine provisioning runbook | PASS ? SOURCE/RUNBOOK READY | target Machine B/C preflight + local provisioning + separately authorized server registration remain pending |
MN-P2 evidence: Windows multi-node provisioning source package is prepared and statically verified with 6/6 tests PASS. The runbook preserves one unique Node identity, one server-generated physical-camera identity, one target-local Agent identity, one target-local SSH identity, one unique reverse-forward allocation, and reusable per-Node logical aliases `operator -> CAM-01` / `operator2 -> CAM-02`. Templates contain no real private key, Production credential, Machine A identity, or fixed server IP. The Engine override template no longer hardcodes CAM-01/CAM-02 and explicitly records the current limitation that `AEGIS_CAMERA_ID` is one static event-time logical alias per Engine process. Therefore Live account alias authority may be source-ready while detection/clip/alert account-specific attribution still requires explicit review and live acceptance. No Machine B/C provisioning, server registration, Production mutation, or Twingate change is claimed.

| MN-P3 | multi-node live acceptance | PREPARATION PASS ? LIVE PENDING | acceptance collector/verifier/checklist ready; execute on Machine B/C real hardware after provisioning |


MN-P3 evidence: multi-node acceptance preparation is source-complete. A local Windows collector, bundle verifier, and acceptance checklist were added and statically verified with 5/5 tests PASS; the PowerShell collector parses with zero errors and its source contains no sensitive-runtime read markers. The collector is intentionally bounded to local lifecycle metadata and `127.0.0.1:8077/health`; it does not open the camera, read private keys/configuration, contact Production, mutate Twingate, or perform server registration. This preparation does not prove Machine B/C hardware acceptance, account alias routing, cross-node physical-camera isolation, event alias attribution, reboot lifecycle, or Production acceptance. Those claims remain PENDING until target hardware execution.

## Current task — Operator Live navigation persistence and single-camera layout (2026-10-05)

Branch `fix/idea2-operator-live-navigation-persistence` is a source-only PR1.5
follow-up based on main `7dbcae4f0b8fd8aef26e7da52614c9a3fed42880`.
The current Live landing remains unchanged: arriving there after login is an
intentional Live activation. Authentication alone does not create a separate
hidden viewer; an authenticated session on Archive without an activated or
permitted Live view has no stream.

**Operator Live navigation persistence:** after an authorized CCTV-Operator
enters Live, the same mounted Live subtree and same-origin Monitor MJPEG viewer
remain active through internal Archive, Diagnostics, and Settings navigation.
The inactive subtree is hidden, inert, absent from accessibility navigation,
and occupies no layout space. Returning to Live does not reopen the stream.
Logout, session loss, browser close, and normal camera switching retain their
existing teardown; SOC still releases Live viewers when navigating away.
`LiveFeed` image-source cleanup and server-side stream/authorization/producer
authority are unchanged.

**Single-camera Operator Live UI:** a CCTV-Operator with exactly one
server-authorized camera sees the existing hero video without the redundant
lower CameraSelector or reserved gap. The Access control and Event stream
panels remain. Multi-camera Operators and SOC retain the selector and camera
switching. This is role and server-camera-count based, never username based.

Local real-App/generated-frame browser regression went RED on navigation
teardown and the redundant selector, then passed all 30 Playwright tests,
including nine new cases. The neutral Monitor suite passed 184 with zero
failures and 58 conditional skips; Vite production build passed. These are
source/local tests, **not** a Production deployment or Machine A real-camera
acceptance. PR2 Archive/recording and PR3 GPU runtime remain separate.

## Current task — GPU-required inference source policy (2026-10-04)

Branch `feat/idea2-gpu-required-inference` adds an Engine-only, source-tested
accelerator policy. Development defaults remain `AEGIS_GPU_REQUIRED=false` and
`AEGIS_INFERENCE_DEVICE=cpu`; a future Production configuration must explicitly
select `true` and `cuda:0`. Required mode rejects unavailable/invalid CUDA or
a YOLO model that does not report the selected CUDA device before workers and
camera start. Each YOLO prediction receives the selected device; a later YOLO
failure stops the Engine instead of falling back to CPU. YuNet/SFace identity
failures remain fail-secure. Health/metrics distinguish configured device,
reported YOLO device, successful GPU samples and the CPU OpenCV backend.

This policy does **not** add a `capture_on_demand` requirement or change the
existing camera-demand lifecycle. Real CUDA/PyTorch installation, Machine A
hardware GPU proof, Production rollout and Live acceptance are **NOT VERIFIED**
by repository tests. PR2 recording/archive remains separate and unstarted;
no model assets, thresholds, templates, UI, Agent or deployed runtime changed.

## Current task — sustained Live steady-state watchdog follow-up (2026-10-04)

Task: PR1 follow-up for the post-first-byte Live stream timeout. Branch:
`fix/idea2-monitor-steady-idle-watchdog`; owner: Pub; starting main:
`9e5ce3d79e1455ba0707117ad9a5a7ccbbcf889f`. Current state:
PR1 CLOSED / MACHINE A REAL-CAMERA ACCEPTED (operator and operator2).
Production mutation allowed: NO.

Owner-provided Production evidence after PR #328 showed that the first-byte
watchdog no longer fired: demand appeared, the camera connected, and one viewer
remained active, but the Monitor logged two six-second steady-state timeouts
while Operator stayed on Live. The owner then rolled the Monitor image back to
`aegis-prod-monitor:idea2-ba-csp-6ddcf184a5a9`. This is a confirmed mismatch
with the Engine's default 15-second post-first-frame idle allowance, not a
failure of the 50-second cold-start boundary. The earlier PR #328 section below
remains the historical source-checkpoint result, not evidence that sustained
real-camera acceptance had passed at that earlier checkpoint.

The follow-up retains 50 seconds until the first nonempty upstream body data,
then allows a bounded 20-second steady gap (Engine default 15 seconds plus
five seconds for proxy/transport delivery). Headers alone never switch phases.
Authorization before demand/fetch, Browser Association, producer generation,
session/assignment revalidation, browser-close abort and one release per demand
remain on their existing paths. No Engine, Agent, UI, Archive, GPU, database,
HUB or deployed runtime was changed by this repository task.

| Session | Scope | State | Evidence | Remaining |
|---|---|---|---|---|
| S1 | RED→GREEN Monitor timeout reconciliation | PASS | A scaled 70 ms inter-frame gap failed under the old 30 ms-equivalent timer, then survived the new 100 ms-equivalent timer; the later stall still closed. Focused route tests 49 pass / 1 conditional skip; broader focused 70 pass / 1 skip; full Monitor 184 pass / 58 conditional skips; Playwright 21/21; Vite build PASS. | Historical source checkpoint; later Machine A real-camera acceptance is recorded below. |

Owner-provided Machine A real-camera acceptance closed PR1 for both account
aliases: `operator → CAM-01` and `operator2 → CAM-02`. Each independently
passed `PRE_LIVE_IDLE`, `LIVE_ACQUISITION`, `SUSTAINED_LIVE_120S`,
`FINAL_VIEWER_RELEASE`, `POST_LOGOUT_IDLE`, `PHYSICAL_LED_SUSTAIN`, and
`PHYSICAL_LED_RELEASE`. The physical camera LED stayed on through sustained
Live and turned off after final viewer/logout. This is owner-reported hardware
evidence, not a new test performed by this documentation-only PR #338 follow-up.
PR2 recording/archive remains separate and unstarted; PR3 GPU-required
inference is source-only and is not a claim of real GPU or Production acceptance.

## Current task — sustained Live first-byte watchdog (2026-10-04)

Branch `fix/idea2-monitor-first-byte-watchdog` is a repository-only PR1 fix for
the owner-reported Production symptom in which Monitor closed a cold Operator
stream after six seconds without a first frame. The Monitor proxy now gives
the first nonempty upstream body data a 50-second deadline, covering the
Engine's default 45-second cold-first-frame window plus five seconds for the
proxy/transport boundary. After the first data arrives, the existing six-second
steady-state idle watchdog remains in force. The watchdog also bounds a fetch
that never returns stream data. Authorization, physical producer demand,
session/assignment revalidation, browser-close cleanup, and release remain on
their existing paths; Engine, recording, Archive, GPU, UI, and Production
runtime are unchanged.

RED route tests reproduced the premature close before the first byte; GREEN
focused lifecycle tests passed 12/12. The broader focused Monitor set passed
68 with one conditional PostgreSQL skip, the full neutral Monitor suite passed
182 with 58 conditional skips, Playwright passed 21/21, and the Vite build
passed locally. These were source/test results only at that historical
checkpoint. Later owner-provided Machine A real-camera acceptance for both
operator aliases is recorded in the PR1 follow-up section above. PR2
recording/archive remains separate and unstarted; PR3 GPU-required inference
has source work in Draft PR #338 but no real GPU or Production acceptance.

## Current task — Browser Association CSP narrow source fix (2026-10-04)

Branch `fix/idea2-browser-association-csp` is a repository-only fix for the
confirmed Production browser denial of the Operator's local Agent association
request. Monitor's own CSP and the browser-facing HUB `/monitor/` CSP now grant
only `http://127.0.0.1:8078` in `connect-src`. The HUB `/monitor/` location
retains the existing upstream security headers and CSP intersection while
repeating the six HUB headers so nginx location-level `add_header` does not
drop them. No other effective CSP directive is intentionally widened.
HUB root, Drive, IDEA3, and `/monitor/internal/*` are unchanged. Existing
browser-flow tests still prove credentials are omitted, SOC does not associate,
and association does not request a camera stream.

Local evidence: the new/existing focused CSP and association tests passed
24/24; applicable HUB config tests passed 41/41; full neutral Monitor tests
passed 179 with 58 conditional skips and zero failures; HUB and Monitor Vite
builds passed. The broader HUB browser suite was attempted but did not finish
within the bounded local run; it is not claimed green. Production nginx syntax
or browser acceptance has not been tested here. This branch does **not** deploy
the CSP change or prove Machine A live association/camera recovery. Kla must
review the cross-scope HUB policy before any Production rollout.

## Current task — M2-E3 persistent idle pipe accept (2026-10-04)

Branch: `fix/idea2-agent-persistent-idle-pipe-accept`, based on main
`ed351310ed2e0161c2e0fadb68c0f858cdc315bb`. The Agent now keeps its
overlapped `ConnectNamedPipe` pending while idle instead of cancelling and
republishing the first pipe instance at the five-second read timeout. Intentional
shutdown cancels and drains the idle accept, clears the active handle, and
closes it once; Win32 995 is normal only in that idle-shutdown context. Once a
client connects, the existing bounded request read, response write, and
post-response close remain unchanged. Engine local acquisition and Agent
response budgets, ACL/SID authorization, wire protocol, and camera-demand
boundaries are unchanged.

RED reproduced the premature idle close and service-loop republish. GREEN:
native Windows connector reached the original pipe after 12.2 seconds idle;
two requests crossed the former five-second boundary; native idle shutdown
completed; the existing 50/100 no-prepoll stress cases passed. Focused Agent
pipe tests 41/41 and full Engine/Agent tests 273/273 passed locally. Governance
and Vault validation passed; independent review found Critical 0, Important 0.

This is repository source/test evidence only. Installed Machine A heartbeat
recovery has **not** been verified. No Machine A runtime, Identity Agent service,
Production, private key, camera, or tunnel was modified. The earlier PR #318
receipt remains immutable and historical. `M2_E3=NOT_CLOSED_PENDING_POST_MERGE_MACHINE_A_ACCEPTANCE`.

## Current task — M2-E3 final Windows pipe response lifecycle hardening (2026-10-03)

Branch: `fix/idea2-agent-pipe-peer-disconnect-final`; base:
`27ac710f32b8ecbf38a3ee263ca87c8c36d8e9bf`; source checkpoint:
`7f00f78a776c01e47551a7b0cb2398702a1daa5d`, followed by the bounded
pre-write acquisition amendment on the same PR #318 branch.

State: SOURCE FIXED / LOCAL WINDOWS PIPE TESTS VERIFIED / MACHINE A LIVE
RECOVERY NOT VERIFIED. After merged PR #317 and PR #316 were installed on
Machine A, the owner observed seven new Engine `AGENT_UNAVAILABLE` warnings in
40 seconds despite repeated automatic HUB heartbeat HTTP 200 responses and
successful challenge/verify requests. Engine remained idle with camera
connected=false, demanded=false, viewers=0. That is owner-provided live
evidence of the pre-fix problem, not post-fix acceptance.

RED tests exposed Win32 233 on the post-complete-response close path, a
completed Engine response masked by a client `CloseHandle` failure, failed
wait/cancel paths that did not drain pending OVERLAPPED I/O, unsafe publish
diagnostic absence, and a zero-byte close completion during the cancel race.
GREEN now classifies only 109/232/233 as normal peer close after the complete
Agent response write. Connect, request read, and response write still fail on
233; incomplete/invalid write counts, ordinary timeout, and trailing data
remain failures. The Engine retains its separate <=5-second local pipe and
<=30-second Agent response budgets. Close/publish diagnostics record only
phase, exception class, and numeric Win32 code, never payload or exception
message. ACL/SID, DPAPI, signing/session protocol, HTTPS, camera demand, and
service failure backoff were not weakened.

Local Windows verification: focused pipe/client 52/52, explicit Identity
Agent modules 114/114, Windows lifecycle 49/49, full Engine/Agent 261/261,
all five native pywin32 tests executed with zero skips at the original PR
checkpoint. The immutable receipt for that checkpoint records its historical
limitation and remains unchanged.

The later PR #318 amendment closes the local no-instance gap without retrying
an Agent transaction: only Win32 2/231 during `WaitNamedPipe`/`CreateFile`
before handle acquisition may retry within the original at-most-five-second
local deadline. Win32 121 and deadline exhaustion terminate as timeout;
unrelated errors fail immediately. Once a handle is acquired, write/read
failure cannot replay the request. The separately bounded Agent response
wait remains unchanged. RED reproduced early failure on transient missing/busy
instances and a deadline-expired wait that still attempted `CreateFile`.
GREEN: focused pipe/client 60/60 and full Engine/Agent 269/269 on local
Windows; the native 50/100 sequential transactions now call the real Engine
connector back-to-back with no external pipe pre-poll, each reaching the
Agent transport once. Service success has no backoff, injected unrelated
failure retains backoff, and camera-demand side effects remain zero.
Governance 61/61, Vault validation PASS with two pre-existing Canvas warnings,
ten PowerShell parses, diff check, and changed-content secret scan passed.
Independent read-only review: Critical 0, Important 0.

This supersedes the receipt's former unsynchronized-acquisition limitation
as a local source/test fact only. Installed Machine A heartbeat recovery is
still not verified and remains owner-gated after human review/merge. No
Machine A runtime, camera, private key, tunnel, Production, or Production DB
was modified; M2-E3 is not closed.

## Current task — M2-E3 successful Agent pipe-close lifecycle (2026-10-03)

Branch: `fix/idea2-agent-pipe-close-lifecycle`; owner: Pub. Base:
`d5e4072525bc213bba29e6ae491aac8dfc0de009`; source/test checkpoint:
`11cfd3214b6058b5780dbd457a87615c201b5747`.

State: SOURCE FIXED / LOCAL WINDOWS TESTS VERIFIED / MACHINE A HEARTBEAT
RECOVERY NOT VERIFIED. Owner-provided live evidence after the prior response
timeout change showed 22 automatic heartbeat HTTP 200s, successful Agent auth,
and database heartbeat updates, while the Engine still reported
`AGENT_UNAVAILABLE` and heartbeat gaps expanded to about 10–60 seconds. Machine A
was safely rolled back before this repository-only task. These observations
narrowed the suspected fault to the successful Agent response/pipe-close path,
but they do not prove this source fix has recovered the installed runtime.

RED: `test_post_response_peer_close_accepts_only_broken_or_closing_pipe`
failed on Win32 232 in initial, pending, and immediate close-wait paths;
`test_successful_close_republishes_same_first_instance_without_service_backoff`
showed the successful HTTP 200 response followed by service backoff instead of
republishing. GREEN: only the post-complete-response close wait now accepts
Win32 109 or 232. Error 233, unrelated errors, response-write failures,
partial writes, ordinary close timeouts, and trailing protocol data remain
failures. Three sequential same-name first-instance round trips pass in both
controlled and native Windows tests; the old handle closes once, no service
backoff follows a successful client close, and camera-demand side effects stay
zero. Engine request/response budgets, client connector, Agent HTTPS,
DACL/SIDs, wire protocol, key/session authority, and retry policy are unchanged.

Local Windows verification: focused pipe/client 43/43, Identity Agent 154/154,
full Detection Engine 252/252, including native pywin32 tests with zero native
skips. Governance 61/61, Vault validation PASS with two existing Canvas
owner-review warnings, Python syntax/import, four relevant PowerShell parses,
diff check, and changed-content secret scan passed. Independent read-only
review found Critical 0 and Important 0; its two optional test-coverage
observations were addressed before the final full-suite run. Installed Machine A,
its Agent service, camera, private key, tunnel, Browser Association, Production,
and PR #293 were not modified. Live Machine A acceptance remains a separate
owner-gated step after review and merge.

## Current task — M2-E3 Engine→Agent response timeout budget (2026-10-03)

Branch: `fix/idea2-engine-agent-response-timeout-budget`; owner: Pub. Source
checkpoint: `c357b7b07556e5e7d539cd3f58d4033dfb14089e` from `origin/main`
`7649d180d01bc92501a7cad792a9f8a610988490`.

State: SOURCE FIXED / LOCAL WINDOWS TESTS VERIFIED / MACHINE A HEARTBEAT
RECOVERY NOT VERIFIED. Owner-provided live evidence after the Engine pywin32
installation showed five of five local Engine→Agent pipe controls succeeded,
while automatic Engine heartbeats still logged `AGENT_UNAVAILABLE`; the
Production HUB access log observed an automatic heartbeat HTTP 200. This is
consistent with the Engine's former single five-second deadline expiring while
the Agent completes allowed HTTPS challenge/verify/heartbeat work, but source
tests alone do not prove that this explains every live heartbeat failure.

The Engine now keeps the existing at-most-five-second local pipe
availability/connect/request-write budget and separately waits at most 30
seconds by default for the Agent response after a completed write.
`AEGIS_IDENTITY_AGENT_RESPONSE_TIMEOUT_S` is bounded to 0.1–30 seconds;
`AEGIS_IDENTITY_AGENT_TIMEOUT_S` remains bounded to 0.1–5 seconds. The Agent
HTTP defaults, protocol, identity authority, heartbeat cadence, camera demand,
and legacy shared-key behavior were not changed. RED proved the old connector
timed out on a response delayed beyond the local window. GREEN: focused
Engine/pipe tests 48/48 and full Engine suite 245/245 on Windows, including
native cancellation. Governance 61/61, Vault validation PASS with two existing
canvas owner-review warnings, PowerShell parser checks, diff check, and
changed-content secret scan passed. Independent review found no Critical or
Important issue; its minor non-default-budget coverage observation was fixed
and rerun. No installed Machine A, Agent service/configuration, private key,
camera, tunnel, Production, Browser Association, or PR #293 state was changed.

The previous Engine pywin32 dependency checkpoint below is historical and its
dependency blocker is closed by owner-provided installation/import evidence;
the separate live response/heartbeat acceptance gate remains open.

## Current task — M2-E3 Engine Windows named-pipe client dependency (2026-10-03)

Branch: `fix/idea2-engine-windows-pipe-client-dependency`; owner: Pub. Source
checkpoint: `6824a41361eae2651bb3bd0b37c682e51ac9c9e8` from `origin/main`
`0ab80a1a7d9ff2b45dbcdfb021aba900841cd128`.

State: SOURCE FIXED / LOCAL WINDOWS DEPENDENCY VERIFIED / MACHINE A HEARTBEAT
ACCEPTANCE PENDING. The Engine requirements now install `pywin32==312` only on
Windows, and the existing Windows installer preflight imports the five named-pipe
client modules (`pywintypes`, `win32con`, `win32event`, `win32file`, `win32pipe`).
Normal repair delegates to that installer; the Engine and Identity Agent remain
separate virtual environments. The Engine receives no Agent private key,
session, or signing authority. Focused adjacent tests pass 113/113; the full
Engine suite passes 239/239. A fresh disposable Windows Engine venv installed
the Engine requirements, imported all five modules at version 312, passed
`pip check`, and passed its 29/29 focused tests. The installed Machine A Engine
venv was not changed or tested by this checkpoint.

Owner-provided post-PR #313 Machine A evidence supersedes the earlier Agent
acceptance-pending statement below: the Agent's named pipe answered 400/400
observations after source refresh, with its protected identity/configuration
preserved and camera idle. The remaining observed physical-heartbeat blocker
was the installed Engine venv missing the five pywin32 modules, producing
`AGENT_UNAVAILABLE`. The local source/dependency fix does not prove that a
reviewed Machine A Engine refresh or live heartbeat acceptance has happened.
Production, Machine A runtime, Agent identity/configuration, and PR #293 were
not modified in this task.

## Concurrent task — M2-E3 Identity Agent idle pipe publication (2026-10-03)

Branch: `fix/idea2-identity-agent-idle-pipe-publish`; owner: Pub. Source
checkpoint: `534db82408df97817496cfb809c7ac96958932aa` on main base
`6227635c4e9efd89563494c180c49e70a38baaa6`.

State: SOURCE FIXED / LOCAL WINDOWS VERIFIED / MACHINE A ACCEPTANCE PENDING.
Owner-provided live M2-E3 evidence showed the installed Agent service running but
the named pipe absent in 200 observations across about 20 seconds; a separate
pywin32 diagnostic pipe worked. Source/tests reproduced the boundary: an idle
`ConnectNamedPipe` timeout previously escaped `serve_once` and triggered the
service host's retry backoff, leaving publication gaps near the Engine's
five-second heartbeat cadence. Only a cancelled, drained idle accept now
returns normally so the next pipe instance can publish without backoff.
Unexpected cancellation-drain errors still propagate; connected read/write
timeouts, SID checks, pipe ACL/first-instance flags, and zero camera-demand
side effects remain covered.

Focused Agent/Windows tests pass 42/42 and full Detection Engine tests pass
237/237 in the local Python 3.12/pywin32 test environment. A native Windows
same-name republish plus authorized one-shot heartbeat test passes and was
repeated three times. Independent scoped review reports Critical=0,
Important=0, Minor=0. These are local source tests, not evidence that the
installed Machine A Agent has been updated or that its live heartbeat has
recovered. Production, Machine A runtime/service/key, camera, tunnel, and
PR #293 were not changed. After owner review/merge, a separately approved
source refresh and bounded Machine A pipe/heartbeat acceptance remain required
before M2-E3 can close or Browser Association begins.

## Current task — Production Agent HTTPS ingress (2026-10-02)

Branch: `fix/idea2-production-agent-https-ingress`; owner: Pub. Source base:
`4a8cc3c95e2f4147fbab9c505079c0377a271d99`.

State: SOURCE IMPLEMENTED / LOCAL STATIC VERIFIED / RUNTIME SMOKE BLOCKED —
repository-only edge and configuration contract work at checkpoints
`9c65a5af` and `535634a9`.
Production currently denies every `/monitor/internal/*` request at the HUB,
while the Machine Identity Agent's canonical Monitor base naturally targets six
registry-backed or signed routes below that prefix. This task is adding a
case-sensitive, exact-route, POST-only, query-free, 16 KiB machine allowlist
ahead of the existing deny-by-default guard. Browser Cookie and Authorization
headers are removed at the edge; Agent proof headers and all Monitor-side
registry, signature, replay, and legacy-auth behavior remain authoritative.

The exact six-route, lowercase, POST-only contract now rejects every raw URI
containing a query delimiter or other non-canonical spelling, enforces 16 KiB,
and removes Cookie and Authorization before proxying. Source inspection and
tests confirm the Agent does not use browser Authorization: challenge/verify
use JSON and signed writes use `X-Aegis-*` proof headers. Production examples
now use `https://aegis.internal` for both Agent and browser-association
audiences without enabling strict local-node rollout by default.

Focused HUB routing passes 36/36, HUB navigation preservation passes 11/11,
focused Monitor identity/authentication passes 33/33, focused Agent
configuration/session passes 11/11, and the neutral Monitor suite passes 179
with 58 explicit conditional PostgreSQL skips. HUB and Monitor Vite builds,
collaboration governance (33/33), Vault validation, diff check, and changed-
content secret scan pass. Fresh scoped review found Critical=0, Important=1
(fixed by `535634a9`), Minor=1 deferred. The disposable real-Nginx smoke was
not executed because the local Docker API was unavailable; its script parses
cleanly and remains an explicit pre-rollout gate. A broader Engine run was also
environment-limited by absent optional Python packages; no Engine source
changed and the affected Agent tests are green.

No Production, database, Machine A runtime, key, camera, or tunnel mutation was
performed. Kla integration review of the shared HUB surface, a reviewed merge,
real-Nginx smoke, and separately authorized Production rollout remain required.

### Session register

| ID | Scope | State | Evidence | Remaining / Next |
|---|---|---|---|---|
| S1 | Exact Production HTTPS machine-ingress contract and canonical audience examples | PARTIAL | RED 1/5 pass and 4/5 expected failures; GREEN focused suites, builds, governance/Vault/diff/secret gates above; real Nginx smoke blocked by unavailable Docker API | Publish Draft PR for Pub/Kla review; run real-Nginx smoke before owner-approved rollout |

## Previous task — SCM-compatible one-shot maintenance (2026-10-02)

Branch: `fix/idea2-identity-agent-scm-oneshot`; owner: Pub. Source base:
`f967ac4c11d0b02dbf4c08c98aac48437ff2efb5`.

State: SOURCE IMPLEMENTED / LOCAL VERIFIED — repository-only hotfix. Machine A
proved that the service-identity maintenance command completed its DPAPI
CurrentUser action, but SCM returned error 1053 because the process exited
before entering `StartServiceCtrlDispatcher`. The corrected temporary commands
retain `--service`; the process enters the dispatcher and defers exactly one of
DPAPI preflight, resumable provisioning, or ACL attestation to `SvcDoRun`.
Maintenance never constructs the normal browser/named-pipe host. Pywin32 alone
owns final service status, and every wrapper requires a stopped service with
zero Win32 and service-specific exit codes before accepting current evidence.

Focused Windows lifecycle/key-store/service verification passes 67/67;
adjacent Agent/Windows verification passes 69 with two native-pywin32
environment skips. The CA-bundle suite remains honestly limited in this local
runtime: 8 tests pass and 3 error because `requests` is absent; CA source was
not changed. Independent scoped review found Critical=0, Important=0, Minor=0.
Machine A has not rerun this corrected source. Production, its database,
installed Machine A runtime, service state, evidence, and private identity
remain unchanged. A reviewed PR/merge and separately authorized runtime refresh
remain required before another live maintenance attempt.

### Session register

| ID | Scope | State | Evidence | Remaining / Next |
|---|---|---|---|---|
| S1 | Reproduce dispatcher bypass; implement and verify bounded service maintenance dispatch | PASS | RED: dispatcher combination rejected, direct maintenance executed, no one-shot service host; GREEN: 67/67 focused plus 69 pass / 2 environment skips adjacent | Open and review a PR, then merge before owner-authorized Machine A runtime refresh and live SCM rerun |

## Identity Agent `sc.exe config` argument hotfix (2026-10-02)

The Machine A DPAPI preflight stopped before key generation when the temporary
service `binPath` configuration returned `sc.exe` exit 1639. On branch
`fix/idea2-identity-agent-sc-config-argv`, a source-only correction passes
`binPath=` and its complete command as separate arguments for DPAPI preflight,
key provisioning, ACL validation, and restoration of the original service
path. Restoration is attempted even if temporary configuration or stopping
fails. The shared helper preserves embedded path quotes for Windows PowerShell
5.1 and rejects the former packed argument shape. Focused Windows/Identity
Agent tests: 60/60 pass; adjacent protocol/autostart tests: 69 pass, 2
environment skips; five relevant PowerShell scripts parse cleanly.

This is **not** Machine A acceptance: the installed service/runtime was not
changed, no key was generated, and the DPAPI preflight was not rerun. The
reviewed fix must reach the intended release through a PR/merge and an
explicitly approved runtime update before a new Machine A preflight attempt.
Production and its database remain unchanged.

## PR #264 repository-integration scope reconciliation (2026-10-02)

PR #264 is now treated as a **repository/source integration closeout**, not as
proof that the H1 live environment or Production rollout has completed.
This supersedes earlier instructions that kept PR #264 Draft solely until
H1 N2-N7 live acceptance finished.

- H1 N0 remains PASS and H1 N1 remains PASS by Human Owner report.
- H1 N2-N7 remain **live/pre-H1 acceptance gates** and are still required
  before N8 may authorize bounded H1 runtime work. Their evidence is not
  backfilled, inferred, or promoted by merging PR #264.
- The dedicated Identity Agent live/service path remains deferred and must not
  be started merely because this repository PR merges.
- The Camera-first Monitor/physical-producer source is repository-integrated
  independently of H1 live acceptance. Production migrations 001-005, explicit
  Node/physical registration, alias policy, Monitor deployment, real browser
  stream acceptance, Telegram acceptance, and later recording/download remain
  separate post-merge owner-gated work.
- Therefore `PR264_REPOSITORY_MERGE_BLOCKED_BY_H1_N2_N7=NO` while
  `H1_N8_AUTHORIZED=NO`, `PRODUCTION_DEPLOYED=NO`, and
  `MACHINE_A_IDENTITY_AGENT_LIVE=DEFERRED`.
- Authoritative main reconciled into the PR branch:
  `812eabeea1450f3e947c9f9d9032351eca26efe0` -> merge commit
  `aa05ebf20749029bb3fd6b23e2d62d3de825e022`; no force push or rebase.


## Concurrent stacked source task — physical producer generation (2026-10-02)

This bounded source task does **not** replace the Machine A Current Task or
H1 facts below, close Task 16, or create that predecessor task's final receipt.

Task: Monitor-side physical producer generation and per-viewer demand lifecycle.
Branch: `fix/idea2-camera-producer-generation`; owner: Pub.
Dependency/base: `feat/idea2-machine-a-no-powershell-runtime` at
`37db029fc641ec9dff687dc6506c88f67a438631`; publish only as a stacked Draft.
PR: Not created at this checkpoint; controller owns publication after review.
Current state: PARTIAL — SOURCE IMPLEMENTED / LOCAL VERIFIED; integration
review and separately authorized Production/external acceptance remain pending.
Implementation/evidence checkpoint: `e5e8f82d9e3ad7b533f7a4d21cace1d91753447d`
(parent `94141e2b63b91d8a7f78c3b53e518f080f7ff8fa`).
Production mutation allowed: NO; Production mutation performed: NO.

### Source contract and scope

- One physical camera/registered Node owns the DB generation; concurrent
  authorized CAM-01/CAM-02 account aliases share it. Identical aliases on
  different physical cameras do not collide. Each viewer owns a separate
  random demand, authenticated user/alias and keyed session-binding hash.
- Strict Operator authorization precedes acquisition and Engine fetch;
  acquire/renew lock and revalidate live authority transactionally. PostgreSQL
  post-lock/write-boundary wall clock controls fixed 30-second leases.
  Serialized 10-second revalidation renews exact authority or aborts.
- Exact positive BIGINT decimal generation is sent only in server-side
  `X-Aegis-Producer-Generation` beside the existing Engine key. No browser
  authority, raw session binding, Engine key or handle is returned/logged.
  Per-viewer release and final epoch retirement cover normal close, errors,
  logout/revocation and connected non-draining backpressure abort.
- Add migration 005; migrations 001–004 retain byte-identical Git blobs
  against the design base. Fresh schema matches post-005 physical ownership.
  Heartbeat remains availability, never registry/producer authority; explicit
  host-side `manage_nodes.py` registration remains unchanged.
- Changed source/tests/package stay within Monitor; exact cross-scope documents
  are `docs/superpowers/plans/2026-10-01-idea2-physical-producer-generation.md`
  and `docs/superpowers/specs/2026-10-01-idea2-physical-producer-generation-design.md`,
  requiring Kla integration review. Engine, UI, deployment files, installed
  Machine A, H1 and original dirty checkout were not changed by this task.

### Source-task Session Register

| ID | Scope | State | Evidence | Checkpoint | Result | Remaining / Next |
|---|---|---|---|---|---|---|
| S1 | Migration 005 and fresh schema | PASS | Static/real-PG parity, upgrade, history, rerun and unsafe-backfill negatives | `3f12522d383e35f8b015bdf6abbabc52fd8cb660` | LOCAL VERIFIED | Owner-gated migration rollout |
| S2 | Physical epoch/demand service | PASS | Real-PG alias/concurrency/revocation/expiry/write-boundary proofs | `7ef474f000206d68b72f08420395489ac6d47fe1` | LOCAL VERIFIED | Runtime rollout/acceptance |
| S3 | Stream integration and abort cleanup | PASS | HTTP header/authorization/revalidation/release and backpressure negatives | `94141e2b63b91d8a7f78c3b53e518f080f7ff8fa` | LOCAL VERIFIED | External Engine provenance |
| S4 | Final source verification and fixture synchronization | PASS | Final neutral matrix, twice-green real-PG gate, build, governance and scoped review | `e5e8f82d9e3ad7b533f7a4d21cace1d91753447d` | SOURCE HANDOFF ONLY | One partial receipt, controller review/publication; no Production acceptance |

### Fresh final evidence and honest failure history

Windows isolated source checkout, Node 24.14.0, PostgreSQL 15.19; commands from
Monitor unless stated. Neutral runs remove both database URL variables and set
`AEGIS_TEST_PYTHON=C:/Program Files/Python312/python.exe` for cross-language proof.

- `node --test tests/producerLifecycle.test.mjs tests/producerLifecyclePostgres.test.mjs tests/physicalCameraStreamRouting.test.mjs tests/machineAAccountSymmetry.test.mjs tests/streamLifecycle.test.mjs tests/nodeRegistry.test.mjs tests/registryMigrations.test.mjs tests/physicalCameraHeartbeat.test.mjs tests/viewerDemandAvailability.test.mjs tests/liveCamera.test.mjs` — 138 total, 81 pass, 0 fail, 57 conditional DB skips.
- Neutral `npm test` — 236 total, 178 pass, 0 fail, 58 conditional DB skips.
- Only disposable `AEGIS_MONITOR_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55448/postgres`, with default `DATABASE_URL` unset: `node --test tests/physicalCameraStreamRouting.test.mjs tests/streamLifecycle.test.mjs tests/machineAAccountSymmetry.test.mjs tests/physicalLinkRoute.test.mjs tests/producerLifecycle.test.mjs tests/producerLifecyclePostgres.test.mjs tests/registryMigrations.test.mjs` — twice 122 pass, 0 fail, 0 skips. Exact test schemas/other clients absent afterward; controller owns cluster shutdown.
- Initial combined PG runs failed at the real HTTP viewer cleanup assertion
  (2 active demands versus 1; complete repeated RED: 121 pass / 1 fail / 0 skip).
  Isolated case passed. Controller-approved test-only synchronization now
  explicitly waits for completed real release (5-second statement-timeout
  bound), preserves every DB lifecycle assertion and closes both viewers
  before schema teardown. Conservative classification: fixture synchronization/
  cleanup defect; prior latency beyond 200 ms was **not measured**. Subsequent
  combined GREEN repeated twice; original failures are retained, not erased.
- `npm run build` — PASS, 2,077 modules. Root governance/Vault/collaboration
  tests 52/52; Vault validator PASS with two pre-existing owner-data Canvas
  warnings; all 14 changed JS/MJS syntax checks and diff checks PASS.
  Changed-content secret scan PASS; scoped review Critical 0 / Important 0 /
  Minor 0. Publication policy/remote CI and final whole-branch review remain
  controller-owned; local Draft policy fixture passed.

### Evidence boundary, remaining work and handoff

- Engine generation validation/tests: `NOT_PRESENT_IN_THIS_SOURCE_BRANCH`.
  Controlled Monitor upstream tests prove its request contract only. Owner
  live preflight (401 without key; 400 invalid producer generation with key)
  is EXTERNAL evidence; reconcile live Engine source/image/version provenance
  before deployment. No Engine validation was weakened or implemented here.
- The pre-existing DB-enabled WHOLE-suite fixture/pool hang remains unresolved;
  no DB-enabled full-suite green is claimed. Other legacy DB fixture coverage
  is not substituted by the affected lifecycle/migration/HTTP gate.
- Production prerequisites: separately approved migrations 001–005, reviewed
  `SESSION_SECRET` presence/configuration (never its value), explicit Node and
  physical registration, account alias/assignment reconciliation, server-
  approved stream destination, Engine provenance, rollout/rollback decision,
  and real external acceptance. Nothing in Production was inspected/mutated.
- Machine A browser/camera/reboot acceptance, Telegram, recording/download,
  SOC passive/no-wake and fleet/soak acceptance are NOT accepted/implemented
  by this source task. DB outage may defer immediate release until bounded
  lease expiry; indefinitely hung dependency recovery is not proven. Existing
  other fixture SQL-cleanup robustness limitations remain deferred.
- Next: exactly one partial final receipt for this successor source task,
  then controller independent whole-branch review and Draft stacked publication;
  Pub functional review and Kla integration decisions remain required. No push,
  PR creation, merge, rebase, Production action or predecessor closure here.

## Current Task — Engine producer generation reconciliation v2

Task: reconcile the stranded historical Engine generation contract with PR #298 merged current main
Branch: `fix/idea2-engine-producer-generation-reconcile-v2`
Owner: Pub
PR: Draft publication pending; human review and merge only
Current state: SOURCE IMPLEMENTED / LOCAL VERIFIED / REAL MACHINE ACCEPTANCE PENDING
Started: 2026-10-03
Base SHA: `1579712866ef0e83c5b949b0afed7a7969e0f80f`
Implementation checkpoint: `86eec04b3d22c62a97ca07da9783806fe291d11b`
Production mutation allowed: NO

The predecessor reconciliation worktree stopped when `main` advanced. Its
uncommitted receipt and 10-file candidate remain untouched and are historical
context only; this successor was created from main after PR #298 merged.
PR #298 brought canonical SID comparison, staged DataRoot ACL lifecycle, and
expected-current-key-version rotation CAS into main. These Agent/CLI paths are
outside this successor diff.

Historical Engine generation source exists at `f24367bd32ba369be765ce105d981ce3a0f024a7`
and `dceb52f3b5452a11cee3f815af0d52fe74de1bd7`, neither in current main.
The current Monitor already sends server-owned `X-Aegis-Producer-Generation`
with its independent Engine key for strict Operator streams. The Engine now
validates one canonical positive PostgreSQL BIGINT header after key auth and
leases viewers per physical producer generation. Same-generation viewers share
capture; newer generations invalidate old leases and frames; final current
viewer release removes demand. Always-on compatibility may omit the header,
but cannot join an already numbered producer. Stale preflight returns 409;
supersession after response start closes cleanly without stale demand.

### Session Register — Engine generation successor

| ID | Scope | State | Evidence | Checkpoint | Result | Remaining | Next |
|---|---|---|---|---|---|---|---|
| EG-V2-S1 | Current-main Engine generation source, tests, and Monitor fixture | PASS | RED: 11 tests, 15 failures/6 errors on base; GREEN: focused Engine 30/30, full Engine/Agent 232/232; focused Monitor 59 pass/1 conditional PostgreSQL skip; full Monitor 179 pass/58 conditional PostgreSQL skips; Vite build, governance 61/61 and Vault validation PASS | `86eec04b3d22c62a97ca07da9783806fe291d11b` | SOURCE IMPLEMENTED / LOCAL VERIFIED | Draft publication; exact installed Engine artifact and Machine A acceptance unproven; SOC passive-live separate | one new partial receipt, then Draft PR |

Machine A configuration remains a Human-gated deployment requirement:
`AEGIS_MONITOR_INGEST_MODE=identity_agent`,
`AEGIS_CAPTURE_ON_DEMAND=true`, `AEGIS_STREAM_ENABLED=true`, and both
`AEGIS_AGENT_ENGINE_STREAM_URL` and `AEGIS_STREAM_PUBLIC_URL` equal
`http://aegis-stream-host.internal:18077/stream.mjpg`. Repository defaults are
not evidence that those values are installed. No live configuration was read.
The installed Engine source/image SHA is unproven. The strict SOC route still
lacks server-owned generation and a passive no-wake viewer contract; resolve
that in a separate task before capture-on-demand Production rollout.

## Previous Task — Pre-Live Blocker Fix A (PR #298 merged)

Task: IDEA2 pre-live Windows Identity Agent blocker fixes and safe Node key rotation
Branch: `fix/idea2-prelive-windows-agent-blockers`
Owner: Pub
PR: #298 merged into main at `1579712866ef0e83c5b949b0afed7a7969e0f80f`
Current state: SOURCE MERGED — real Windows retest required
Started: 2026-10-02
Starting SHA: `9f5a01148ce016bc0056dbbcc85ac8a3e5fac23f`
Production mutation allowed: NO

### Goal

Repair the confirmed pywin32 312 SID-comparison incompatibility, split the
fresh DataRoot `icacls` owner/grant lifecycle into checked safe operations, and
make public-node key rotation compare-and-swap on an explicit current key
version before the human resumes any live Machine A or Production action.

### Scope and safety

Only Identity Agent ACL source/tests, the Windows installer lifecycle
source/tests, Monitor Node CLI source/tests/documentation, this canonical note,
the task plan, and one final immutable receipt may change. Machine A, the
installed service/runtime, keys, camera, tunnel, Production, Production DB, and
containers remain untouched. Real Windows acceptance remains pending after
human merge.

### Acceptance criteria

The new tests must fail against the starting source and pass after the minimal
fixes. ACL validation remains canonical-SID based and fail-closed; the final
DataRoot owner/DACL remains service/SYSTEM only; rotation requires a positive
expected version and atomically updates exactly one matching row while
preserving the reviewed `active = TRUE` reactivation behavior. Targeted and
broader relevant tests, PowerShell parsing, governance, Vault, diff, secret
scan, source hash, clean Git state, normal push, and one Draft PR are required.

## Session Register — Pre-Live Blocker Fix A

| ID | Scope | State | Evidence | Checkpoint | Result | Remaining | Next |
|---|---|---|---|---|---|---|---|
| PLB-A-S1 | Canonical SID validation, fresh DataRoot ACL ordering, Node key CAS, final source-only verification/publication | SOURCE MERGED | RED reproduced for missing `EqualSid`, combined owner/grant command, and missing CAS. GREEN: ACL 9/9; Windows/Agent lifecycle 91/91; adjacent Agent protocol 53 pass/2 native-pywin32 skips; Node CLI 28/28; Monitor 179 pass/58 conditional PostgreSQL skips; governance/Vault 58/58; Vite build, PowerShell parse, diff, and secret scan pass. | `fb98dfac75846ec8771a88f92ccb61af796e2f0e` | canonical SID equality and exact mask; checked grant→owner→temporary-admin removal; expected-version CAS preserving reviewed reactivation | real Machine A Windows retest; no live key rotation performed | Human-gated runtime recheck |

Authoritative Identity Agent source hash after the fix:
`D1EEAE02CDF7F9E6A58D775F73E238905EE99618D17F28C511D81DAA45278F48`.
The source-only verification does not claim live pywin32 312, `icacls`, service,
DPAPI, key-rotation, camera, tunnel, or Production acceptance. The full Engine
discovery run remains environment-limited by absent optional `requests`,
OpenCV, and Starlette packages; all affected installed-dependency suites listed
above passed.

## Parent Task Context — Machine A No-PowerShell Runtime

Task: IDEA2 Machine A permanent No-PowerShell runtime
Branch: `feat/idea2-machine-a-no-powershell-runtime`
Owner: Pub
PR: Draft publication authorized; keep Draft until remaining H1/Task 16 acceptance and the one final task receipt are complete
Current state: H0_STATE=HUMAN_PROVEN_COMPLETE; H1_N0=PASS; H1_N1=PASS per Human Owner live report; H1_N2_N3=NOT_LIVE_VERIFIED; H1_STATE=BLOCKED_PREREQUISITES. The Human reports healthy isolated N1 PostgreSQL and Monitor, a stable migration rerun, three lab containers, two internal networks, the lab PostgreSQL volume, no Monitor/PostgreSQL host ports, and unchanged Production identity. This repository-only session does not independently retest or mutate that lab. The separate remote source-checkout clean-gate retry returned `REMOTE_WORKTREE_CLEAN=NO` without dirty-path evidence and remains a host-side prerequisite to resolve before new source staging. Historical N0 and earlier source-only N1 evidence are preserved below. N2–N7, live CA/path acceptance, permanent Machine A install/reboot/account acceptance, and final task closeout remain outstanding.
Started: 2026-09-19
Live-accepted source checkpoint: `5f154a25becfd8cf3c84f19a1585c51fbd4d399c`; latest unrelated-main merge: `abd57aa58fc9d52f86e9f700b657fd366f5d8e12` (same pinned H1 inputs)
Production mutation allowed: NO

```text
H1_PERSISTENT_LAB_PROVISIONED=YES_HUMAN_REPORTED_N1
H1_N1_REPOSITORY_ARTIFACT=IMPLEMENTED_SOURCE_ONLY
H1_N1_LIVE_STATE=PASS_HUMAN_REPORTED
H1_N1_DOCKER_HOST_EXECUTION=SOURCE_ONLY_SUDO_NONINTERACTIVE_LOCAL_SOCKET
PRODUCTION_MUTATION=NO
MACHINE_A_RUNTIME_MUTATION=NO
N0_CAPACITY_CRITERION=OWNER_APPROVED_FORMULA_AND_LIMITS
N0_CAPACITY=PASS
N0_STATE=PASS
POSTMERGE_N0=PASS
LIVE_N0_REVALIDATION_REQUIRED=NO
CAPACITY_INPUT_FREEZE_SOURCE_SHA=9e39fe5786a5ac7428d2e5eb47cb2285a63bc606
H1_PROBE_IMPLEMENTATION_SOURCE_SHA=d725365875f54e82f12a592878e382fa2dfa6978
MONITOR_FINAL_SOURCE_SHA=d725365875f54e82f12a592878e382fa2dfa6978
H1_GATEWAY=SOURCE_IMPLEMENTED_AND_DISPOSABLE_PROBE_VERIFIED
CAPACITY_PROBE=LIVE_PASS_AND_CLEANED
CAPACITY_PROBE_DOCKER_EXECUTION=EXPLICIT_DIRECT_OR_SUDO_NONINTERACTIVE
GATEWAY_IMPLEMENTATION_REQUIRED=NO_SOURCE_COMPLETE
N1_STARTED=YES_HUMAN_REPORTED
```

The earlier N0 development checkpoints below retain their original markers as
historical test-contract evidence, not as current gate state:
`N0_CAPACITY_CRITERION=NOT_DEFINED`, `N0_CAPACITY=NOT_PROVEN`,
`N0_STATE=BLOCKED_CAPACITY_CHARACTERIZATION`,
`BOUNDED_ACTIVE_CHARACTERIZATION_REQUIRED=YES`,
`H1_GATEWAY=IMPLEMENTED_SOURCE_ONLY`,
`CAPACITY_PROBE=IMPLEMENTED_SOURCE_ONLY`,
`ACTIVE_CAPACITY_PROBE=ATTEMPT_4_FAILED_CLEANED`,
`ATTEMPT_4_SERVICE_EXIT=GATEWAY_MONITOR_EXIT_1`,
`STARTUP_EXIT_ROOT_CAUSE=NOT_PROVEN`,
`STARTUP_LOG_DIAGNOSTICS=IMPLEMENTED_SOURCE_ONLY`,
`OPTIONAL_HEALTH_DIAGNOSTIC=IMPLEMENTED_SOURCE_ONLY`,
`SERVICE_READINESS_DIAGNOSTICS=IMPLEMENTED_SOURCE_ONLY`, and
`ACTIVE_CAPACITY_PROBE_READY=HUMAN_RERUN_REVIEW_REQUIRED`, plus the earlier
`N1_STARTED=NO` source-only marker. These are historical, not current H1 gates.

### Final reviewed main-equivalence evidence (N0, 2026-09-30)

The first reviewed main merge `8ed07adf1a29a6b76ca5c776031a4fea6e37223e`
had tree `0588a24ee4900b469a0dbf25cccc420c07cb5053`. A second approved
main sync merged `ca8c0133b59695a4b9f0689d7efd61991af8ab32` as
`abd57aa58fc9d52f86e9f700b657fd366f5d8e12`, with tree
`5e93dcab71233c02de62acf2e5f6e5f433a2098a`. The second main advance
changed exactly four IDEA3 paths and no IDEA2 or H1 runtime/build/probe input.
Compared with the live-accepted source
`5f154a25becfd8cf3c84f19a1585c51fbd4d399c`, both main advances are
unrelated IDEA1/IDEA3 source/documentation changes. The latest merged H1 identities are:

| Input | Git object ID |
|---|---|
| IDEA2 Monitor tree | `ff068da99352d7f1ee4b1eea7d79c398e54a7c05` |
| H1 probe tree | `98a1c376dd0fa327ff93c7e5e8017c4056495fa0` |
| H1 gateway tree | `a74c4e70c2ebe67201b0b6ab97d3b67a03a5d11f` |
| H1 probe Compose blob | `2608bc9c14f089cf01261fa906687ab0469fe4f3` |
| root Compose blob | `2115c597d7a94354f90160d22d38e13a711c59d0` |
| root `.env.example` blob | `2a142639348c206158d9ab49399b8d7bc55738b0` |

Monitor Dockerfile, `.dockerignore`, package manifests, `server/`, and `src/`
also matched their live-accepted object IDs. After this merge, the non-live
H1 contracts passed 40/40; physical heartbeat/Agent focus passed 16 with one
conditional PostgreSQL skip; full Monitor passed 142 with three conditional
PostgreSQL skips; Engine/Agent passed 194 tests with two expected Windows-native
skips; Vite built 2,077 modules; static syntax, governance 50/50, Vault,
and diff checks passed. These fresh local checks do not replace the separately
reported human-run live N0 result or prove N1–N7. The raw capacity measurement
artifact remains in the human-run evidence, not this repository; no numerical
capacity value is reconstructed here.

### Goal

Deliver a repository-native Machine A runtime that starts the Detection Engine,
dedicated Identity Agent, and tunnel automatically; keeps the camera closed when
idle; resolves `operator` to CAM-01 and `operator2` to CAM-02; and always routes
both accounts to Machine A's registered physical camera without manual terminal,
heartbeat-loop, or diagnostic-bridge steps.

### Scope

Tasks 1–11 implemented the dedicated Ed25519 Identity Agent architecture,
strict browser association, server-side verified-node session binding,
authenticated physical heartbeat and ingest provenance, account-to-logical-
alias policy, physical routing, and demand lifecycle symmetry. PRE-TASK-12/N12
replaced the rejected diagnostic `:18078` bridge and hard-coded Docker gateway
candidate with a stable deployment-owned, server-controlled Machine A stream
endpoint. Original Task 12 implemented and checkpointed the repository-native
Windows lifecycle without installing or changing the real Machine A runtime.
Original Task 13 exercises the built Monitor, disposable PostgreSQL,
protocol-real Agent proof, physical routing, and Engine demand/release path in
an isolated local harness without the diagnostic bridge or persistent mutation.
Original Task 14 freshly verified that complete candidate, including real
disposable PostgreSQL gates, Windows lifecycle/static contracts, governance,
Vault, dependency, secret, lifecycle, and scoped security review boundaries.

### Out of scope

Final SOC passive/no-wake remediation, Machines B/C rollout, archival footage,
Telegram completion, UI redesign, Production deployment, Production database or
network changes, camera hardware, model weights, training data, and biometric
data are outside this task. The bounded Detector B legacy shared-key path remains
compatible until a separately approved migration.

### Safety boundaries

The dedicated Agent alone owns the DPAPI-protected Ed25519 private key. Browser,
Engine, heartbeat payload, hostname, IP, headers, query parameters, and storage
never establish Node, physical-camera, or alias authority. Machine identity
selects the physical camera; the live authenticated account selects only the
logical alias. Authentication, Agent renewal, heartbeat, and browser association
create no viewer demand. The existing Live workflow creates reference-counted
demand, and final release/logout closes the camera. Production and the installed
Agent/Engine/tunnel/camera runtime remain unchanged; only the separately approved
Python 3.12.10 prerequisite has been installed on Machine A so far.

### Acceptance criteria

Every source behavior is implemented through observed RED-to-GREEN tests. Full
Monitor, Engine, Agent, browser, UI-freeze, build, disposable PostgreSQL,
governance, Vault, secret-scan, and scoped security-review gates must pass. Human
acceptance must then prove reboot/login auto-start, idle camera OFF, Operator on
CAM-01 using physical Camera A, final release OFF, Operator2 on CAM-02 using the
same physical Camera A, final release OFF, and no manual bridge, heartbeat, npm,
Vite, Python helper, or PowerShell workflow. The owner has separately authorized
publication of the verified N0 checkpoint as a **Draft PR** before that final
acceptance. This does not authorize a final receipt, Ready-for-Review status,
merge, Production deployment, or a claim that Task 16 is complete.

## Session Register

| ID | Scope | State | Evidence | Checkpoint | Result | Remaining | Next |
|---|---|---|---|---|---|---|---|
| H1-N2-N3-READINESS | Reconcile trust-only N2 and gateway-start N3; add repository-only validation and lifecycle artifacts | IN PROGRESS — REPOSITORY ONLY | Human reports N1 live PASS; repository source began at `0727b3a22e327e406b4fce2829c46fc4022d3c13`. Focused N2/N3 Python 16 pass/1 Windows symlink-environment skip, H1 61/61, Monitor 142 pass/3 conditional PostgreSQL skips, Windows lifecycle 37/37, full Agent CA 11/11 using existing Python 3.14, and governance 65/65 passed locally. A real Docker Compose render cannot run because the CLI is unavailable; fixture validation is not equivalent. The separate remote source-checkout clean gate remains unresolved after returning `REMOTE_WORKTREE_CLEAN=NO` with no path evidence. No new live action in this session. | — | Repository candidate remains unstaged/uncommitted until missing renderer check and final review are resolved | N2/N3 live DNS, certificates, trust, gateway, and route evidence remain separately authorized | Keep PR #264 Draft; no N1 lab, Machine A, or Production mutation |
| H1-N1-DOCKER-MODE | Align persistent N1 host Docker commands with accepted sudo-noninteractive execution | PASS — SOURCE/LOCAL ONLY | RED showed direct-Docker and unpinned-daemon defects. The validator remains unprivileged for owner-only secret checks; Docker commands pin `unix:///var/run/docker.sock`; rendered values are never printed on failure; cleanup remains print-only. H1 56/56, Monitor 142 pass/0 fail/3 conditional PostgreSQL skips, governance 50/50, Python static/Vault/diff/changed-content secret scan PASS. No live Docker, N1 lab, Machine A, or Production mutation. | `aa222c68b2a62ef02ddc5e1a650c58d4f1d2d52a` | Repository compatibility fix verified locally; N1 live state NOT_STARTED | Human-run non-mutating server Compose render and separate live N1 authorization | Keep PR Draft; do not create the final receipt or start N1 live provision |
| H1-N0-FINAL | Bounded non-Production capacity probe and post-main integration | PASS / CLOSED for N0 only | Attempt 8 blocked at postgres-seed; Attempt 9 PASS at `af42604`; first main merge `5f154a25` included the RED→GREEN physical-heartbeat correction; human-run post-merge N0 at that live SHA exited 0 with postgres-seed, monitor-health, measurements, and cleanup PASS. Fresh Production identity remained `a9793f92…` before/after (7/7/4). Later reviewed main `fdc2dd3d` merged cleanly and produced the exact predicted tree `0588a24e`; all H1 runtime inputs retained their pinned hashes, so no live rerun was required. Post-sync non-live H1 40/40; Monitor 142 pass/3 conditional PostgreSQL skips; Engine 194 tests/2 expected environment skips; Vite 2,077-module build PASS. | live source `5f154a25becfd8cf3c84f19a1585c51fbd4d399c`; final main merge `8ed07adf1a29a6b76ca5c776031a4fea6e37223e` | `POSTMERGE_N0=PASS`; H1 persistent lab, N1–N7, CA/path, and permanent Machine A acceptance still pending | Publish Draft PR for human/integration review; do not merge or start N1 without separate authorization |
| H1-N0-CAPACITY-HISTORICAL-ATTEMPT4 | Earlier exact-candidate disk/RAM/PostgreSQL/rollback capacity gate | BLOCKED_CAPACITY_CHARACTERIZATION at Attempt 4 only; superseded by H1-N0-FINAL | Owner limits, immutable artifacts, sudo-only Docker access, and live preflight were proven. Attempts 1–3 failed closed at the PostgreSQL volume, running-only discovery, and optional-health inspection boundaries. Attempt 4 retained PostgreSQL as running/healthy and gateway/Monitor as exited with code 1, but its log lacked their startup stderr/stdout; no common crash cause was proven then and no `capacity-measurements.json` was produced in that attempt. Exact cleanup removed all probe resources and preserved Production identity. | source checkpoint `3272a90e8e51ffa2d9b8ef322768dcb4fe55780a` | Historical `ACTIVE_CAPACITY_PROBE=ATTEMPT_4_FAILED_CLEANED`; superseded by later PASS | Later Attempt 9 and post-merge N0 closed this boundary | Historical, not the current gate |
| H1-AGENT-CA-BUNDLE | Managed private-CA trust for the dedicated Identity Agent | PASS — SOURCE/LOCAL ONLY | TDD covers public-only PEM validation, exact managed path, empty/unset default trust, reparse/out-of-scope/private-key/malformed/missing rejection, explicit Requests verification across auth and ingest, ambient trust-variable rejection, real disposable TLS chain success, untrusted CA and hostname mismatch denial, and Windows install/status/repair/uninstall ownership. Focused Agent/CA/lifecycle 57/57; full Engine/Agent 194 total / 192 pass / 2 expected native-pywin32 skips; Monitor 140 pass / 0 fail / 3 conditional PostgreSQL skips; H1 contract 6/6; Windows lifecycle 37/37; PowerShell parse 10/10; governance 63/63; Vault PASS with two pre-existing Canvas warnings. No live CA, service, Machine A, lab, or Production state changed. | this local checkpoint | `CA_BUNDLE_IMPLEMENTATION=IMPLEMENTED_SOURCE_ONLY`; H1 remains blocked | N0-N7 and live reviewed H1 CA/path verification | stop before N0, H1, machine mutation, push, or PR |
| H1-NONPROD-ENVIRONMENT-DESIGN | Isolated non-Production H1 architecture and N0-N8 runbook | BLOCKED_PREREQUISITES / DESIGN REVIEWED | Human-approved repository-only design fixes `aegis-h1-lab`, candidate-only HTTPS/stream hostnames, conditional ports, isolated PostgreSQL/Monitor/network/volume/credentials, exact browser/Agent route split, owner-reviewed registry policy, server-authoritative stream destination, and the source/local-verified managed `AEGIS_AGENT_CA_BUNDLE` lifecycle. No live DNS, TLS, database, container, registry, or Machine A resource exists from this checkpoint. | this local checkpoint | DESIGN PASS; CA-BUNDLE SOURCE/LOCAL PASS; LIVE PROVISIONING NOT PERFORMED | Run separately authorized N0-N7 and verify the live reviewed non-Production CA/path | Human reviews this local checkpoint; do not begin N0 or H1 |
| MULTI-MACHINE-PORTABILITY | Pre-H1 portability hardening for Windows Machines A/C and Linux Machine B | PASS — SOURCE/STATIC ONLY | Binding model proven across A/B/C x operator/operator2: A = Windows laptop/built-in camera; B = Linux/local camera discovered at deployment; C = Windows PC/external webcam. RED proved reusable private-network endpoint and reverse-port defaults; GREEN makes the Monitor host, explicit non-loopback server bind, and unique reverse port mandatory deployment inputs. Authorization 17/17; Windows+Linux lifecycle 34/34; full Monitor 140 pass / 0 fail / 3 conditional PostgreSQL skips; full Engine/Agent 179 tests / 177 pass / 0 fail / 2 expected native-Windows skips; UI freeze 5/5; PowerShell parse PASS; Bash parse PASS; Vite build PASS; governance/Vault 50/50 and PASS with two pre-existing Canvas warnings; diff/hardcode/secret/security review PASS. | this local checkpoint | Windows A/C share one configuration-driven lifecycle; Machine C needs no source rewrite. Shared Machine B business logic needs no rewrite, but the repository Linux adapter currently implements only Engine+tunnel systemd lifecycle and source-level camera discovery; Linux dedicated Identity Agent and real Machine B runtime acceptance are NOT_IMPLEMENTED / NOT_VERIFIED. Model semantics unchanged. | Future separately approved Linux identity-agent adapter and real Machine B install/reboot/camera acceptance; H0 is complete and H1 prerequisites remain separate | STOP before H1, any machine mutation, push, or PR |
| ORIGINAL-TASK-15 | Prepare and Stop at the Human Machine A Installation Gate | H0 HUMAN_PROVEN_COMPLETE / H1 BLOCKED_PREREQUISITES | H0 prerequisite remediation and read-only acceptance are human-proven complete. Historical H0-2R defects and corrections remain recorded below. No Agent, Engine, tunnel, camera, Production, Task 16, receipt, push, or PR mutation is claimed. | current branch history through `25dd102ef1f487b04da0d16eb1054e1bbea9a33f`; this design checkpoint follows | H0 PASS; H1 NOT STARTED | Isolated H1 lab, managed CA bundle, and N0-N7 evidence | review design checkpoint; keep H1 blocked |
| ORIGINAL-TASK-14 | Full automated verification and scoped security review | HUMAN-GATE READY | Starting SHA `ee9812d8d5c3992a04118e55149ae843b697fd6d`; focused Monitor lifecycle/security 70/70; focused Windows lifecycle 70/70; full Monitor 140 pass / 0 fail / 3 conditional PostgreSQL skips; all skipped behavior rerun against disposable PostgreSQL 15 with zero skips; full Engine/Agent 176 tests / 174 pass / 0 fail / 2 expected native-pywin32 environment skips; UI freeze 5/5; Vite build PASS; governance 49/49; Vault PASS with two pre-existing Canvas warnings; PR #134 lifecycle 7/7; hash-locked wheels 9/9; PowerShell parser 18/18; scoped review Critical 0 / Important 0 / Minor 0 | source checkpoint `ee9812d8d5c3992a04118e55149ae843b697fd6d`; this status-only evidence checkpoint follows | PASS — source/local candidate; Playwright runner absent and real installed Machine A runtime not exercised | Task 15 human installation-gate preparation; Task 16 acceptance/receipt/PR | stop before Task 15 |
| ORIGINAL-TASK-13 | Production-like disposable integration without diagnostic harness | CLOSED | Starting SHA `d0e9fe59ea5d3daec9b999f2f2c4639f3ceef17f`; `origin/main` `2694808092bd3c28dea14ed4bcd400e6bb0ec5d2` has no overlap with authorized Task 13 paths; Node integration 5/5; Engine contract 2/2; PostgreSQL 15 migrations applied twice; built Monitor shell, Agent proof, account aliases, physical source, demand/release, forged/stale denial, Agent recovery, heartbeat aging, and cleanup all passed | `test(idea2): prove permanent machine a runtime path` (this checkpoint) | PASS — disposable/local integration only; Production and installed Machine A unchanged | Task 14 full automated verification and security review | stop before Task 14 |
| ORIGINAL-TASK-12 | Windows install/status/repair/uninstall/autostart lifecycle | CLOSED | Starting SHA `27d7723f96c4752d32047c5062c55173c3f4c9c2`; focused Windows/Agent 74/74; PowerShell parser 12/12; full Engine/Agent 174 tests / 172 pass / 0 fail / 2 expected native-pywin32 skips across the existing split dependency runtimes; Monitor 143 tests / 140 pass / 0 fail / 3 conditional PostgreSQL skips; UI freeze 5/5; Vite build PASS; hash-locked Windows wheels 9/9; governance 50/50; Vault PASS with two pre-existing canvas warnings; secret scan 21 paths / 0 hits; scoped review Critical 0 / Important 0 / Minor 0 | `d0e9fe59ea5d3daec9b999f2f2c4639f3ceef17f` | PASS at repository source/static/test-double boundary; installed Machine A runtime and privileged Windows lifecycle not executed | Task 13 integration | Task 13 |
| PRE-TASK-12-N12 | Permanent Machine A stream endpoint contract | CLOSED | Task 11 base `cb17caeecbc09b5cab224ae9369e3a29b860cbf8`; stable `aegis-stream-host.internal` application endpoint; server-owned Node/physical mapping; explicit non-loopback IPv4 SSH bind; Monitor 140 passed with 3 conditional PostgreSQL skips; Engine/Agent 139 tests, 0 failures, 2 pywin32 skips; endpoint 18/18; Agent 9/9; Windows 19/19; UI freeze 5/5; governance 50/50; Vite build PASS | `27d7723f96c4752d32047c5062c55173c3f4c9c2` | PASS at source/static/config evidence level; Production and installed Machine A runtime unchanged | original Task 12 |
| MACHINE-A-NO-POWERSHELL-T1-T11 | Agent identity through physical camera demand lifecycle | CLOSED | Tasks 1–11 committed from `cc2ffff` through `cb17caee`; single physical heartbeat supports both account aliases; account switching requires no heartbeat switch; startup/auth/heartbeat create no demand; final demanding release closes the camera | `cb17caeecbc09b5cab224ae9369e3a29b860cbf8` | PASS — source/test checkpoints only; not installed Machine A acceptance | permanent endpoint prerequisite and original Tasks 12–16 | PRE-TASK-12/N12 |
| MACHINE-A-NO-POWERSHELL-S1 | Isolated planning, current-main reconciliation, and Windows capability preflight | CLOSED | task-start `origin/main` `c5468c520f24d29fb37fefcf7c4411b91d4087f4`; PR #134 merged; Windows PowerShell/Python/DPAPI/8078/cryptography preflight accepted; pywin32 isolated-Agent dependency action identified | `cc2ffff` | PASS — planning/preflight; Production unchanged | superseded by implementation sessions above | historical record |
| CP2 cleanup | Dispose isolated PostgreSQL resources and restore local Docker management | CLOSED | Human-run cleanup: exact CP2 container/volume absent, port 55433 released, Docker responsive, Git clean | `9bdcf0647cf5c66cdb303066e6cad15f552ebf25` | PASS | none | CP3-S0 |
| CP3-S0 | Read-only repository and runtime-auth reconnaissance | CLOSED | CP2 registry/key-version/physical-camera foundation exists; runtime still uses shared key/body identity; no Agent auth/session/DPAPI path exists | `9bdcf0647cf5c66cdb303066e6cad15f552ebf25` | PASS | freshness comparison | CP3-S0.5 |
| CP3-S0.5 | Fetch and inspect newer `origin/main` for CP3 overlap | CLOSED | fetched `origin/main` `99a6f916f5b4aa20da2a1c2ee68e75162f7e23b7`; 69 newer commits do not touch IDEA2/CP3 interfaces | `9bdcf0647cf5c66cdb303066e6cad15f552ebf25` | PASS — no reconciliation required | architecture specification | CP3-S1 |
| CP3-S1 | Dedicated Identity Agent and authenticated ingest architecture | CLOSED | 25-section specification; Vault validation PASS with two pre-existing Canvas warnings; governance document tests 63/63; placeholder, secret-material, and Git diff checks PASS; explicit human approval received | `8323eb8432164c4b012b8dfb8bb6cdfb2d5013fa` | PASS — design only | implementation planning | CP3-S2 |
| CP3-S2 | Detailed TDD implementation and human-runtime-gate planning | PASS | 17 reviewable tasks; exact file/interface maps; H1–H10; spec coverage, placeholder, interface, Vault, governance, secret, and Git checks | this documentation checkpoint | PASS — planning only; source not started | human plan review and implementation authorization | stop for human review |
| CF-S1-DESIGN | Camera-First Machine A browser-session association architecture | CLOSED | First broken boundary addressed in design: authenticated session -> verified local Node -> registered physical camera -> existing stream; CP3 preserved/paused; CP5 and final SOC remediation deferred | this documentation checkpoint | PASS — design only; no runtime/test/Production mutation | owner review and shortest TDD implementation plan | stop for human design review |
| CF-S1-PLAN | Bounded TDD implementation plan for Camera-First Slice 1 | CLOSED | Five reviewable tasks with exact file/interface maps, RED/GREEN commands, S1-H1–H5 human gates, protected camera boundaries, and CP3/CP5 exclusions | this documentation checkpoint | PASS — planning only; implementation not started | owner review and authorization for Task 1 RED | stop for human plan review |
| CAM-RUNTIME-UNBLOCKER | Monitor MJPEG idle-watchdog cancellation crash | PASS | RED reproduced the strict unhandled `AbortError`; focused lifecycle 12/12, Monitor 32 pass / 0 fail / 2 conditional PostgreSQL skips, browser 18/18, UI freeze 4/4, Vite build PASS; Engine targeted 18/18; full Engine 74/76 with two unchanged current-main generation failures; human LOCAL Machine A idle/open/sustain/stall/recover/release acceptance PASS | `733fb5d40810f0620082672efc783d5aba8242c2`; runtime evidence `0ca4e655b666bf843c1a9be5773248af59569ea9`; main sync `3be340b0f8acccae8bba0a74e049dbdba0e3dae1` | PASS — source and LOCAL runtime; NOT Production | human code/integration review | keep undeployed; human merge only |

## Machine A No-PowerShell Task Status Dashboard

| Plan boundary | State | Current truth |
|---|---|---|
| Tasks 1–11 | COMPLETE | Agent identity, verified session, physical provenance/routing, one physical heartbeat, and demanding-viewer lifecycle are committed through `cb17caee`. History is preserved. |
| PRE-TASK-12 / N12 | CLOSED | Checkpoint `27d7723f96c4752d32047c5062c55173c3f4c9c2`; stable named/configured endpoint, server-owned source mapping, and explicit SSH-bind contract pass source/static/config gates. Live Machine A acceptance remains later evidence. |
| Original Task 12 | CLOSED | Checkpoint `d0e9fe59ea5d3daec9b999f2f2c4639f3ceef17f`; repository-native Windows install/status/repair/uninstall/autostart lifecycle passes source/static/test-double gates. No permanent Machine A runtime mutation occurred. |
| Original Task 13 | CLOSED | Node integration 5/5 and Engine contract 2/2 passed against the built app, disposable PostgreSQL 15, protocol-real Agent proof transport, and protocol-real Engine stream. Dynamic ports and database schemas were released. Production and installed Machine A remain unchanged. |
| Original Task 14 | HUMAN-GATE READY | Fresh complete source/local verification and scoped security review passed at source checkpoint `ee9812d8`; all Task 14 disposable PostgreSQL and dependency resources were removed. Playwright is honestly `BLOCKED_ENVIRONMENT` because the approved runner is absent. |
| Original Task 15 / H1 N0–N3 | H0 HUMAN_PROVEN_COMPLETE / N0 PASS / N1 PASS HUMAN-REPORTED / N2–N3 LIVE PENDING | Managed Agent CA-bundle source/lifecycle is locally verified. N0 passed with post-main equivalence. Human reports an isolated healthy N1 PostgreSQL/Monitor lab and stable migration rerun; repository-only N2/N3 readiness is in progress. DNS, CA/trust, gateway listener, live browser/Agent validation, and permanent Machine A runtime remain unproven. Production unchanged per owner report. |
| Original Task 16 | NOT STARTED | Permanent Machine A installation, reboot/account/camera acceptance, and the one final task receipt remain pending. Owner-authorized Draft PR publication does not close them. |

### Planned / Completed / Remaining

- **Completed:** Original Tasks 1–11, ending at Task 11 SHA `cb17caeecbc09b5cab224ae9369e3a29b860cbf8`.
- **Completed:** PRE-TASK-12/N12 TDD and checkpoint `27d7723f96c4752d32047c5062c55173c3f4c9c2` for a deployment-owned stable hostname, explicit container host mapping, explicit SSH tunnel bind/port, and server-owned Node/physical-camera endpoint authorization.
- **Completed:** Original Task 12 checkpoint `d0e9fe59ea5d3daec9b999f2f2c4639f3ceef17f` for Windows lifecycle tooling and static/test-double verification only; privileged real-Windows installation remains a later human gate.
- **Completed:** Original Task 13 production-like integration: 5/5 Node integration tests and 2/2 Engine runtime-contract tests passed with the built Monitor, disposable PostgreSQL 15, protocol-real Agent proof transport, and Engine demand/release lifecycle. No Vite acceptance, `:18078`, manual heartbeat loop, manual stream proxy, Production URL, or persistent Machine A mutation was used.
- **Completed:** Original Task 14 full automated verification and scoped security/lifecycle review against source checkpoint `ee9812d8d5c3992a04118e55149ae843b697fd6d`; Critical 0 / Important 0 / Minor 0. The absent Playwright runner remains an explicit environment limitation rather than a fabricated pass.
- **Completed:** Original Task 15 prepared and statically validated the Human Owner installation gate. Human H0-1/H0-2R-1 passed. Fresh WinGet diagnostics proved that the first H0-2R-2 command never selected or ran an installer because Windows PowerShell 5.1 split the nested `--override` at `Program Files`. The corrected exact official-installer path was later authorized and exited zero; `C:\Program Files\Python312\python.exe` proves Python 3.12.10 AMD64 and `py.exe -0p` lists it beside the unchanged-location Python 3.14 baseline. H0-2R-3 stopped only because its registration check incorrectly required the Burn bundle GUID in HKLM.
- **Completed:** H0 is human-proven complete. The historical H0-2R failures and their bounded corrections remain below as an audit trail rather than current blockers.
- **Completed:** Repository-only `AEGIS_AGENT_CA_BUNDLE` implementation and local disposable-certificate verification. TLS verification remains mandatory; no live trust material or runtime was provisioned.
- **Completed:** Attempt 9 and the post-merge human-run disposable H1 N0 capacity probe at live source `5f154a25` passed. Reviewed main syncs `fdc2dd3d` and `ca8c0133` changed no pinned IDEA2/H1 runtime input; targeted non-live tests/build passed after each sync. Production identity was unchanged during the live N0 probe.
- **Remaining:** N2–N7, the unresolved remote source-checkout clean gate, reviewed H1 public CA/path acceptance, live gateway and browser/Agent proof, permanent Machine A installation, reboot/operator/operator2 acceptance, and the one final receipt. Draft PR #264 stays Draft; Ready status and merge remain human-gated.

### PRE-TASK-12 verified contract and known limitations

- The rejected `:18078` bridge and hard-coded `172.18.x.x` application destination are absent from the accepted runtime contract. Negative tests reject loopback, runtime IP, port zero, malformed URL, wrong Node, wrong physical camera, and heartbeat override candidates.
- Monitor uses the deployment-owned `aegis-stream-host.internal` name plus an explicit Compose host mapping. Windows tooling requires an explicit non-loopback SSH reverse-listener bind and port. Deployment preflight must still prove those two deployment values identify the same reachable interface.
- No live container-to-host hop was run because Docker CLI/runtime is unavailable in this Codex environment. No real Machine A camera, Production network, Production Compose, SSH tunnel, database, or installed runtime was changed or claimed verified.
- Playwright was not rerun because the existing dependency set does not contain `@playwright/test`; no package/dependency mutation was made to hide that environment limitation. UI freeze 5/5 and Vite production build passed.
- Machine A is the only later runtime-acceptance target. Machines B/C are intentionally deferred; the source is generic by deployment hostname, Node, physical-camera ID, and port, so later provisioning does not require an application rewrite.

### PRE-TASK-12 final verification evidence

- Endpoint/physical routing: `node --test tests/physicalCameraStreamRouting.test.mjs tests/physicalLinkRoute.test.mjs tests/machineAAccountSymmetry.test.mjs` — 18 passed, 0 failed, including a real cross-origin redirect/credential containment test.
- Agent endpoint contract: `python tests/test_agent_session.py -v` — 9 passed, 0 failed.
- Windows deployment contract: `python tests/test_windows_autostart.py -v` — 19 passed, 0 failed; modified PowerShell files parse with 0 errors.
- Full Monitor: `npm test` — 140 passed, 0 failed, 3 conditional PostgreSQL skips.
- Full Engine/Agent: `python -m unittest discover -s tests -p 'test_*.py' -v` — 139 tests, 0 failures, 2 expected pywin32 environment skips.
- UI/build/governance: UI freeze 5/5; Vite production build PASS; Vault/collaboration test matrix 50/50.
- Security/infrastructure: an independent review found and TDD closed redirect credential forwarding, IPv6 bind formatting, trailing-dot parity, and explicit-port-80 parity defects; final re-review is Critical 0 / Important 0 / Minor 0. Strict source rejects redirects and fails closed; no browser/heartbeat destination authority; no embedded secret; root Compose change is a declared shared dev/test infrastructure surface requiring later integration review.

### Original Task 14 verification evidence

- **Starting/source checkpoint:** `ee9812d8d5c3992a04118e55149ae843b697fd6d` on `feat/idea2-machine-a-no-powershell-runtime`; Task 14 changed no production source or tests. Final fetch recorded `origin/main` `5f1c11abf65f5680eef7871646e341a7426f2447`; its three newly observed commits are IDEA3-only and do not overlap Task 14's sole authorized tracked path.
- **Focused candidate gates:** Monitor lifecycle/security 70/70; Windows lifecycle 70/70; Task 13 production-like regression 7/7; PR #134 stream-abort/lifecycle regression 7/7.
- **Full Monitor:** 143 tests, 140 passed, 0 failed, 3 conditional PostgreSQL skips in the environment-neutral run. The PostgreSQL-gated migration/registry/ingest/heartbeat/CLI/integration behavior then ran against disposable PostgreSQL 15 with zero skips: registry migrations 6/6, Node registry 7/7, ingest provenance 3/3, physical heartbeat 4/4, Python CLI/PostgreSQL 33/33, and Task 13 integration 5/5. Schema plus migrations 001–004 also applied successfully twice.
- **Full Engine/Agent:** 176 tests, 174 passed, 0 failed, 2 expected native-pywin32 environment skips. The established Python 3.14 Engine environment ran 167 tests (165 pass, 2 skips); the approved bundled Python 3.12 cryptography runtime ran the remaining Agent key/browser modules 9/9.
- **Windows/dependency gates:** all 18 PowerShell files parsed; 9/9 hash-locked CPython 3.12 Windows wheels resolved with `--require-hashes`; installer/status/repair/uninstall safety and single HKCU Engine startup ownership remained intact.
- **UI/build:** UI-freeze 5/5 and Vite production build PASS (2,076 modules). Playwright is `BLOCKED_ENVIRONMENT`: `package.json` declares the approved runner, but the existing installation has no Playwright executable. Task 14 did not install or mutate dependencies to fabricate a pass.
- **Governance/security:** collaboration/governance 49/49; Vault validation PASS with the two pre-existing owner-data Canvas warnings; changed-file, log-output, private-key/secret, and endpoint-authority scans PASS; `git diff --check` PASS. The fresh scoped review covered proof domains/raw bodies, replay/concurrency, DPAPI/ACL, loopback Origin/CORS/PNA, browser/session binding, live revalidation, physical source/SSRF bounds, demand/release, legacy downgrade, Windows ownership, cleanup, rollback, and Production isolation: Critical 0 / Important 0 / Minor 0.
- **Negative controls preserved:** forged browser Node/physical identity, unknown/disabled Node, stale/invalid association, heartbeat/browser stream override, malformed endpoint, wrong service/key identity, duplicate Engine owner, invalid ACL/key state, and auth/heartbeat/status demand are rejected by deterministic tests.
- **Dependency review limitations:** the current production dependency audit reports three moderate `qs` advisories, but the Monitor source never reads `req.query` or enables URL-encoded body parsing, so the reviewed vulnerable parser path is not reachable. The Engine environment reports an `opencv-python` metadata mismatch while the intentional `opencv-contrib-python` package provides working `cv2`; the complete Engine suite passes. These are deferred dependency hygiene observations, not Task 14 Critical/Important findings.
- **Cleanup:** the exact disposable PostgreSQL cluster/databases, Python dependency directory, wheel-check directory, schemas, and port 55441 were removed/released. No unrelated resource, Production state, or installed Machine A runtime changed.

### Original Task 15 Human Gate preparation

- **Title and plan:** `Prepare and Stop at the Human Machine A Installation Gate`, from `docs/superpowers/plans/2026-09-19-idea2-machine-a-no-powershell-runtime.md`, starting at `48c4f8ff30b83400933b3b55434becd2bf449fab`.
- **Prepared package:** H0 read-only branch/source/Windows/Python/owner/listener/camera/rollback inventory; H1 external non-secret Agent config, hash-bound Agent install, DPAPI preflight, protected key/public export, non-Production registry/alias/auth-mode setup, Engine/tunnel install, and Agent start; H2 immediate status/ACL/key/idle validation; H3 two-reboot operator/operator2 acceptance; H4 bounded repository repair; H5 default identity-preserving rollback and separately labelled destructive identity boundary.
- **Abort conditions:** unexpected Engine owner, unknown Agent, unexpected port owner, wrong managed root/service identity, source/dependency hash failure, DPAPI/key/ACL failure, tunnel or stable endpoint mismatch, camera not idle, unexpected existing Node/runtime, Production database, or any prerequisite failure.
- **Security boundary:** private key remains DPAPI CurrentUser protected under `NT SERVICE\AEGISIdentityAgent`; only its public key/fingerprint may cross to the approved non-Production registry. Browser, heartbeat, username, IP, hostname, headers, storage, and logical alias cannot select the physical camera or upstream destination.
- **Runtime contract:** Engine remains the single HKCU Run owner; Agent is automatic on `127.0.0.1:8078` and creates no demand; server-owned stream target is `aegis-stream-host.internal:18077`; diagnostic `:18078` and hard-coded Docker IPs remain absent.
- **Mutation truth:** `INSTALLED_MACHINE_A_RUNTIME_CHANGED=NO`, `PRIVILEGED_MACHINE_A_COMMAND_EXECUTED=NO`, `PRODUCTION_MUTATION_PERFORMED=NO`, `TASK16_STARTED=NO`.
- **Known limitations:** preparation/static validation does not prove real service installation, service-identity DPAPI behavior, real Node registration, reboot recovery, browser association, physical Camera A, or operator/operator2 demand/release. Those are Task 16 Human Owner evidence.

#### H0-2 prerequisite-remediation discovery

- **Observed Human evidence:** `H0_1=PASS`; `H0_2=BLOCKED_PREREQUISITE`; blocker `CPYTHON_3_12_X64_REQUIRED`. Machine A currently exposes only Python 3.14 x64 at `C:\Users\puppu\AppData\Local\Python\pythoncore-3.14-64\python.exe`.
- **Reviewed package:** WinGet `Python.Python.3.12`, exact version 3.12.10, Python Software Foundation x64 installer `python-3.12.10-amd64.exe`, SHA-256 `67B5635E80EA51072B87941312D00EC8927C4DB9BA18938F7AD2D27B328B95FB`.
- **H0-2R-1 result:** PASS. `py.exe -0p` listed only Python 3.14; the recorded Python 3.14 SHA-256 is `03168C01B7B7491423350E82C26FEE71F35B43694D1319D3C668BDA6903A0C38`; read-only exact WinGet machine/x64 selection found the expected 3.12.10 package, publisher, URL, and installer hash.
- **First H0-2R-2 result:** BLOCKED before installer execution. WinGet 1.29.380 diagnostic activity `{D0444D22-C6E9-4F4A-B6E9-01C3D738BC57}` logged the single intended override as two argv items: `TargetDir=C:\Program` and a second positional `Files\Python312 ...` query. Package matching therefore ended with `0x8A150014`; `C:\Program Files\Python312\python.exe` remained absent and `py.exe -0p` remained 3.14-only.
- **Scope decision:** machine-scope side-by-side install at `C:\Program Files\Python312\python.exe`, because the later Agent virtual environment runs as `NT SERVICE\AEGISIdentityAgent` and must not depend on the interactive user's private AppData tree. Administrator elevation is required. The corrected method uses the exact official PSF URL, mandatory SHA-256 and Authenticode verification, and Python's supported adjacent `unattend.xml` so no nested native quoting is needed. It explicitly disables PATH, shared-launcher, file-association, and shortcut changes; a hash-bound baseline proves Python 3.14, machine/user PATH, launcher, and Python Store-alias entries remain unchanged.
- **Corrected H0-2R-2 result:** installer exit 0. Baseline SHA-256 is `A3BBB9A032378D22EF0F2BDAD1752980985A5FFD77F94ED66CAEAF0476C7D621`; the exact Program Files runtime reports Python 3.12.10 AMD64 and `py.exe -0p` lists Python 3.14 plus the new 3.12 path.
- **Second H0-2R-3 finding:** runtime/path/bitness proof passed, then `PYTHON_312_PRODUCT_REGISTRATION_MISMATCH` exposed a second runbook defect. Read-only registry evidence shows the exact Burn bundle `{b6ce88eb-2ce3-4d91-8efc-425ae1f48caf}` in HKCU and seven exact Python Software Foundation 3.12.10 x64 MSI components in HKLM. CPython's bundle authoring keeps the Burn maintenance entry per-user while `InstallAllUsers=1` selects `ForcePerMachine` component packages. The bundle location is not machine-scope authority.
- **Prepared evidence:** corrected H0-2R-3 requires one exact HKCU bundle entry, the seven exact expected HKLM component registrations across the two machine views, no additional matching registration, exact runtime/version/path/bitness, and the original hash-bound Python 3.14/PATH/launcher/Store-alias baseline. H0-2R-2F now refuses staging cleanup when either bundle or component evidence exists. H0-2R-4 requires the complete corrected model before uninstall and proves the runtime root plus every exact/matching registration absent afterward.
- **Mutation truth:** `PYTHON_312_INSTALLED=YES_NOT_YET_ACCEPTED`; `PYTHON_312_INSTALLER_EXIT=0`; `PYTHON_314_CHANGED=NO_EVIDENCE_OF_CHANGE`; `AGENT_ENGINE_RUNTIME_CHANGED=NO`; `H0_2R_3=BLOCKED_REGISTRATION_MODEL`; `H0_3_STARTED=NO`; `TASK16_STARTED=NO`; `PRODUCTION_MUTATION_PERFORMED=NO`.

#### H0 completion and H1 prerequisite reconciliation

- The Human Owner subsequently accepted the corrected read-only H0 evidence:
  `H0_STATE=HUMAN_PROVEN_COMPLETE`. The earlier blocked lines above remain
  immutable historical sequencing evidence, not the current gate state.
- At this earlier design checkpoint H1 had not started; that statement is
  historical and is superseded by the Human Owner's later N1 PASS report above.
  The approved H1 design is
  `docs/superpowers/specs/2026-09-28-idea2-h1-isolated-nonproduction-environment-design.md`.
  It requires the isolated `aegis-h1-lab` environment, the now source/local-
  verified managed `AEGIS_AGENT_CA_BUNDLE` lifecycle, live reviewed CA/path
  evidence, and N0-N7 PASS before N8 can authorize any bounded H1 action.
- `LIVE_PROVISIONING_PERFORMED=NO`; `PRODUCTION_MUTATION=NO`;
  `MACHINE_A_MUTATION=NO` for this design checkpoint.

### Handoff / Next Action

PR #264 remains Draft. The Human Owner reports N1 PASS; N2–N7, live CA/path
review, and permanent Machine A acceptance remain blocked pending separate
authorizations. The remote source-checkout clean gate must be explained before
new source staging. This repository-only continuation does not repeat N0/N1,
install Agent/Engine, alter tunnel/camera/Production state, mark the PR Ready,
merge, or create the final immutable receipt.

### Original Task 12 verification evidence

- Focused Windows/Identity-Agent bundle: 74 passed, 0 failed.
- PowerShell parser: 12 reviewed lifecycle/status scripts parsed, 0 errors.
- Dependency reproducibility: 9 CPython 3.12 Windows x64 wheels downloaded and
  verified from the committed transitive SHA-256 lock with `--require-hashes`
  and binary-only resolution.
- Full Engine/Agent: 174 tests, 172 passed, 0 failed, 2 expected native-pywin32
  environment skips. The existing Python 3.14 Engine environment ran 165 tests; the bundled
  Python 3.12 cryptography environment ran the remaining 9 tests.
- Full Monitor: 140 passed, 0 failed, 3 conditional PostgreSQL skips.
- UI/build: UI freeze 5/5; Vite production build PASS (2,076 modules).
- Governance/security: collaboration/Vault structure 50/50; Vault validation
  PASS with the two pre-existing owner-data canvas warnings; secret scan 21
  paths / 0 hits; scoped review Critical 0 / Important 0 / Minor 0.
- Browser automation: blocked because `@playwright/test` and its command are
  absent from the existing dependency set; no install was performed to conceal
  that environment limitation.
- Installed Machine A runtime, Production, persistent configuration, camera,
  tunnel, and database were not changed.

## PR #134 Machine A LOCAL runtime acceptance — 2026-09-15

> [!warning] Evidence boundary
> This is **LOCAL diagnostic/runtime acceptance, not Production deployment**.
> The patched PR #134 Monitor worktree used local processes and a disposable
> database. Nothing was deployed to `https://aegis.internal/`, and no
> Production service, database, network, Twingate, Docker runtime, secret, or
> persistent Machine A configuration was modified.

### Local diagnostic topology

| Component | Local endpoint / evidence |
|---|---|
| Monitor backend | `:8002` |
| Vite frontend | `:5176` |
| Detection Engine | `:8077` |
| Temporary diagnostic stream bridge | `:18078` |
| Disposable PostgreSQL | `:55433` |
| Controlled no-frame stall server | `:18079` |

The disposable database mapped `operator` to CAM-01 and `operator2` to CAM-02;
`must_reset_password=false` was changed only for those two disposable LOCAL
accounts. CAM-01 and CAM-02 heartbeat loops later ran simultaneously with
`node_id=pub-laptop-01` and
`stream_url=http://127.0.0.1:18078/stream.mjpg`. One database observation saw
approximately 4-second CAM-01 and 1-second CAM-02 heartbeat ages. This was a
manual diagnostic harness, not permanent node-aware routing, and the deployed
user experience must not require these commands.

### Acceptance matrix

| Gate | Result | Measured evidence |
|---|---|---|
| Idle / no demand | PASS | Engine `status=idle`, camera disconnected/not demanded, all viewer counts 0, capture 0.0 FPS; heartbeat alone did not hold the camera open |
| Operator / CAM-01 real Machine A stream | PASS | camera connected/demanded, stream/demanding viewers 1/1, passive 0; initial capture/detect approximately 30.0/1.2 FPS |
| CAM-01 sustained live (~60 seconds) | PASS | same demanded state; approximately 29.9 capture FPS and 1.2 detect FPS; Monitor remained alive |
| Operator logout/release | PASS | Engine returned idle with demand/viewers 0 and capture 0.0 FPS; human confirmed the physical camera LED OFF |
| Controlled >6-second no-data watchdog | PASS | CAM-01 temporarily used `http://127.0.0.1:18079/stream.mjpg`; repeated `no data for 6000ms — closing` messages proved the watchdog path executed |
| Monitor survives same PID | PASS | Monitor remained listening on `:8002` with PID `36192`; frontend remained on `:5176` with PID `40040` |
| Fatal abort recurrence | NOT OBSERVED | no `AbortError`, `triggerUncaughtException`, or Monitor process exit during the controlled stall |
| Post-stall recovery | PASS | CAM-01 restored to `:18078`; Engine returned idle, then real Machine A video reopened at approximately 30.2/1.1 capture/detect FPS; Monitor remained PID `36192`; logout returned demand to 0 |
| Simultaneous CAM-01 + CAM-02 heartbeat harness | PASS | both logical heartbeat rows were fresh simultaneously and pointed to the same local Machine A diagnostic bridge; no manual identity swap was required |
| Operator2 / CAM-02 Machine A path | PASS | camera connected/demanded with stream/demanding viewers 1/1 and passive 0; human reported physical camera ON; logout returned Engine telemetry to idle/demand 0 and Monitor remained PID `36192` |
| Final Operator symmetry/release | PASS | live state approximately 30.1 capture FPS; final logout returned idle/demand/viewers 0; human explicitly confirmed the physical Machine A camera LED OFF |
| Production deployment | NOT RUN | outside PR #134 approval |
| SOC passive/no-wake | NOT RUN | separate follow-up task |
| Telegram delivery | NOT RUN | separate follow-up task |
| Machine B / C acceptance | NOT RUN | separate follow-up task |

### Remaining boundaries

- The local PowerShell heartbeat loops, temporary `:18078` bridge, `:18079`
  stall server, and disposable PostgreSQL were diagnostic tools only.
- Permanent heartbeat/service startup, automatic Machine A/B/C association,
  permanent dual-account routing, temporary-bridge removal, and CP3 Identity
  Agent completion are not proven by this PR.
- The owner clarified that Operator-session camera activation is acceptable for
  the desired Machine A experience. Reconcile the exact login-versus-Live
  demand trigger in its owning architecture task; PR #134 changes only abort
  containment.
- The task's existing receipt predates this human runtime evidence and remains
  byte-for-byte unchanged. The human owner accepted it as a historical
  pre-runtime record; the later mutable status and verified runtime checkpoint
  supersede its historically stale runtime-pending limitation. This is an
  approved reconciliation of premature sequencing, not a claim that the
  original ordering was perfect, and no second receipt is created.

### Immutable receipt governance reconciliation — 2026-09-15

The immutable receipt did not falsely claim Production deployment or Machine A
runtime acceptance. It truthfully recorded the earlier partial checkpoint, but
its runtime-pending limitation became historically stale after the human Machine
A LOCAL acceptance recorded by commit
`0ca4e655b666bf843c1a9be5773248af59569ea9`. The human owner approved preserving
the receipt as historical evidence while the mutable canonical status and later
verified runtime checkpoint supersede that stale limitation. The receipt is not
rewritten, deleted, or replaced, and no second receipt is created.

```text
RECEIPT_GOVERNANCE_RECONCILIATION=
HUMAN_OWNER_ACCEPTED_EXISTING_RECEIPT_AS_HISTORICAL_PRE_RUNTIME_RECORD;
LATER_MUTABLE_STATUS_AND_VERIFIED_RUNTIME_CHECKPOINT_SUPERSEDE_STALE_LIMITATION;
RECEIPT_NOT_REWRITTEN;
SECOND_RECEIPT_NOT_CREATED

SOURCE_IMPLEMENTED=YES
TESTED=YES
LOCALLY_VERIFIED=YES
RUNTIME_VERIFIED_LOCAL_MACHINE_A=YES
PRODUCTION_DEPLOYED=NO
EXTERNALLY_ACCEPTED_PRODUCTION=NO
```

## Detector B real-machine acceptance (2026-09-06)

CAM-02 is now running on a second physical laptop using Arch Linux and
`edge-node-02`. Detection and inference remain on that edge laptop; the Beelink
continues to run Monitor, proxy, PostgreSQL, HUB and Drive only.

| Gate | Result | Evidence boundary |
|---|---|---|
| INSTALL_MACHINE_B | PASS | Runtime installed under the operator account with boot-enabled systemd units |
| ENGINE_8077_B | PASS | Local health restored after reboot with `yolo-sface-admin` selected |
| TUNNEL_B | PASS | Dedicated SSH key; local Monitor forward `:18002`; unique server reverse endpoint `:18078` |
| HEARTBEAT_B / LIVE_CAMERA_B | PASS | CAM-02 heartbeat and real video reached Monitor |
| DETECTION_B | PASS | Real capture/inference ran at approximately 5 FPS; Unknown and user-confirmed Authorized application results observed |
| TELEGRAM_B | PASS | AlertManager restored with `dry_run=False`; user confirmed a real post-reboot alert |
| VIEWER_RELEASE_B | PASS | Closing all viewers returned zero viewers/demand/FPS and released the webcam |
| REBOOT_B | PASS | Engine, tunnel, AI backend, Monitor forward and alert configuration recovered automatically |

Local ports `:8077` and `:18002` are reusable because Detector A and B are
different hosts. Their server reverse endpoints are unique: CAM-01 uses
`:18077`; CAM-02 uses `:18078`. Models and biometric enrollment remain local
runtime assets and are not tracked in Git. This acceptance proves application
behavior, not biometric accuracy, fairness, anti-spoofing or liveness.

Source reconciliation includes the Linux systemd installer/operator scripts,
explicit YOLO + YuNet/SFace backend, viewer-demand lifecycle and the Monitor
availability/upstream-cleanup corrections required by the two-detector path.
Infrastructure runtime changes on the Beelink remain subject to Kla review.

Detailed evidence and limitations:
[[90-Status/logs/2026-09-06_154516_pub_idea2-detector-b-real-machine-acceptance]].

### 🧪 Local run check (2026-08-06)

For a quick UI check, run `npm run dev:server` and `npm run dev` in separate terminals from `IDEA2-AEGIS_Monitor`; the UI is at `http://localhost:5176/monitor/` and the API at `http://localhost:8002`. For the full localhost integration stack, start Docker Desktop, ensure the repository-root `.env` exists, then run `docker compose up -d --build` from the repository root and open `http://localhost/` (or `http://localhost/monitor/`). The canonical detection engine remains directly runnable with `python run.py` after its own environment and dependencies are configured, and root Compose now builds that same runtime from `IDEA2-AEGIS_CCTV-Operator/detection-engine/`.

> **Codebase Status**: Monitor UI/API and the modular Python Detection Engine
> are implemented. The optional YOLO + YuNet/SFace path, viewer-demand capture,
> Linux systemd deployment and CAM-02 alert delivery passed scoped real-machine
> acceptance. Repository models/enrollment remain intentionally absent;
> production NAS and fleet-scale soak are still open.
> **Primary Source Files**: `IDEA2-AEGIS_Monitor/server/`, `IDEA2-AEGIS_Monitor/src/`, `IDEA2-AEGIS_CCTV-Operator/detection-engine/`

> **Folder boundary clarification (2026-07-28).** `IDEA2-AEGIS_Monitor/` is the single authenticated Monitor application: login, Monitor identity store, server-resolved `SOC-Responder` / `CCTV-Operator` menus, scoped views, API, and `camera_assignment` enforcement all live here. The old `IDEA2-AEGIS_CCTV-Operator/` folder is only partially deprecated: its former `web-app/` UI is merged and is no longer present, but `detection-engine/` remains the Laptop-side sensor layer that captures camera frames, writes telemetry to Monitor, and must not be deleted unless that edge pipeline is migrated first. Do not delete the entire old folder.

> **Evidence boundary.** The repository default remains identity-free and
> fail-safe. Real identity recognition requires explicit local YOLO, YuNet,
> SFace and enrollment assets. That configured path passed application-level
> checks on two edge laptops, but no independent accuracy, fairness, liveness or
> anti-spoof benchmark is claimed. Production NAS remains separate work.

---

## 📽️ Verified Architecture

```mermaid
flowchart TD
    subgraph EdgeEngine ["Detection Engine — Laptop, VLAN 20 (headless, no UI)"]
        CamFeed["📷 Camera source<br/>webcam index OR rtsp:// URL"] --> Catcher["VideoCatcher<br/>(only thread touching the device)"]
        Catcher -->|record sink| Rec["SegmentRecorder<br/>~10-min .mp4 files"]
        Catcher -->|detect sink, latest-only| Det["FaceDetectorProcessor<br/>default Unknown OR explicit YOLO + SFace"]
        Det -->|matched frame + result| Hub["StreamHub<br/>annotate once, share JPEG to N viewers"]
        Rec --> NASW["NASSyncWorker<br/>scp/rsync + sha256 verify"]
        NASW --> NAS[("Local NAS<br/>raw video bytes")]
        Det --> HB["HeartbeatWorker<br/>every 5s"]
    end

    subgraph BackendServer ["AEGIS Monitor Server :8002"]
        Internal["/internal/* ingest<br/>X-Detection-Engine-Key · no DB creds on engine"]
        Proxy["/api/cameras/:id/stream<br/>requireAuth → canSeeCamera → proxy"]
        CameraResolver["Camera Access Control<br/>server-side JOIN camera_assignment"]
    end

    subgraph ClientViews ["Unified React App :5176"]
        SOCView["🛡️ SOC-Responder<br/>live · archive · detection · alerts · nodes · operators"]
        OpView["🎥 CCTV-Operator<br/>live · archive · diagnostics (assigned cameras only)"]
    end

    Det -->|"POST /internal/detections"| Internal
    NASW -->|"POST /internal/clips (only after verify)"| Internal
    HB -->|"POST /internal/heartbeat<br/>metrics + stream_url"| Internal
    Internal --> MonitorDB[("aegis_monitor<br/>users · cameras · camera_assignment<br/>detections · alerts · clips · camera_heartbeat")]
    MonitorDB <--> BackendServer
    Hub -->|"GET /stream.mjpg (API key)"| Proxy
    Proxy -->|"multipart/x-mixed-replace → &lt;img&gt;"| ClientViews
    BackendServer --> CameraResolver
    CameraResolver -->|scoped payload| OpView
    BackendServer --> SOCView

    classDef socStyle fill:#0f172a,stroke:#38bdf8,stroke-width:2px,color:#fff;
    classDef opStyle fill:#0f172a,stroke:#4ade80,stroke-width:2px,color:#fff;
    classDef warnStyle fill:#1c1917,stroke:#f59e0b,stroke-width:2px,color:#fff;
    class SOCView socStyle;
    class OpView opStyle;
    class Det warnStyle;
```

---

## 🎥 Detection Engine (Laptop, VLAN 20)

**Where it lives**: `IDEA2-AEGIS_CCTV-Operator/detection-engine/`. The parent folder is marked deprecated but explicitly carves this out: *"`detection-engine/` is NOT deprecated — it remains the Laptop-side sensor layer."* Root Compose selects this modular runtime while preserving the `aegis-camera` service name for compatibility; an edge laptop can still start it directly with `python run.py`.

### Canonical modular runtime reconciliation (2026-08-29)

- Root Compose builds the modular engine rather than the legacy `AEGIS_Camera` scanner. It preserves the current shared IDEA1 proxy/network topology and exposes the local development API only on `127.0.0.1:8005`.
- NAS is disabled by default. Disabled or failed transfers retain local recordings, do not create a successful clip record, and do not claim that local volumes are production NAS.
- Startup and shutdown use a cooperative lifecycle. A component startup failure rolls back components that already started.
- The engine talks to Monitor through its authenticated HTTP API and does not receive a PostgreSQL credential. Secret values are redacted from startup logs.
- Recognition remains intentionally fail-unknown: the repository does not contain a real identity model and does not convert generic object detections into authorization.
- This reconciliation is source-level integration from current `main`; real camera, production NAS, Telegram delivery, and production deployment evidence are still required before those outcomes can be claimed.

### Windows Detection Laptop portable auto-start (2026-08-29)

The portable Windows source now follows the architecture previously observed
on the operator's working Detection Laptop:

```text
Windows boot -> SYSTEM tunnel task -> reconnect wrapper -> SSH :18002/:18077
User login   -> HKCU Run -> Engine supervisor -> Detection Engine :8077/webcam
```

`detection-engine/windows/` contains an installer plus status, repair,
non-destructive uninstall, Engine-supervisor, and strict two-way SSH tunnel
scripts. Installation copies durable source to a configurable Local AppData
runtime, creates a runtime-local `.venv`, requires a machine-specific `.env`,
a unique per-laptop SSH key and a fingerprint-verified `known_hosts`, and keeps
all of those machine artifacts outside Git. The Engine starts in the logged-in
user session for webcam access; the tunnel starts as SYSTEM and reconnects
after SSH exits.

Real-machine evidence superseded the earlier key contract: Windows OpenSSH
rejected the service key when its final ACL included both SYSTEM and
`BUILTIN\Administrators`, then accepted the same authorized key after it was
hardened to owner SYSTEM, inheritance disabled, and one explicit SYSTEM
FullControl rule. The source installer and repair flow therefore delegate key
copy/migration, exact SYSTEM-only hardening, and a strict SSH local-forward plus
Monitor-health probe to a short-lived SYSTEM task. The persistent tunnel task
cannot be registered until that probe passes, and the helper task is cleaned up
on success or failure. Status reports the exact key ACL, SYSTEM/AtStartup task
contract, supervisors, ports, health, and OpenSSH permission/public-key failure
flags without printing secret material.

This SYSTEM-only lifecycle is source-level remediation. Automated tests and
PowerShell parsing verify the contract, but the revised installer has not been
run on the Detection Laptop. Elevated installation, Windows reboot recovery,
`:8077`, `:18002`, Monitor `/healthz`, and authorized real-camera Live Canvas
acceptance remain explicitly not verified for this revision.

**Camera source is config, not code.** `AEGIS_CAMERA_SOURCE` is passed straight to `cv2.VideoCapture`: an integer string opens a local device, anything else is treated as a URL. Moving to a real IP camera is a `.env` edit:

```bash
AEGIS_CAMERA_SOURCE=rtsp://user:pass@192.168.10.40:554/Streaming/Channels/101
```

**[NEW 2026-07-28] Local Camera-Device Picker.** The engine now provides `setup_camera.py`, an interactive CLI for probing and selecting local video capture devices (acting like a "microphone-picker" UX).
- **Probes**: Uses `cv2.VideoCapture` and OS-level APIs (like DirectShow via `pygrabber` on Windows) to verify which indices actually deliver frames.
- **Auto-Configures**: Interactively saves the chosen source and friendly name (`AEGIS_CAMERA_DEVICE_NAME`) directly into the local `.env`.
- **Heartbeat Integration**: The `cameraDeviceName` is now included in the heartbeat payload sent to the Monitor backend.

Verified by swapping a running engine between a webcam (index `1`) and a file path with **zero code changes**. There is no ONVIF discovery — the URL is supplied manually or selected via `setup_camera.py`.

> ⚠️ **The recognition model does not exist yet.** `face_detector.py` ships `PlaceholderRecognizer`, which uses an OpenCV Haar cascade to find face *boxes only* and labels **every** face `Unknown` with a confidence derived from box area (its own docstring calls this "NOT a real score"). Consequences that matter when reading any screen:
> * `detections.result` is **always** `'Unknown'`; `matched_name` is **always** `NULL`.
> * A row reading "Authorized — <name>" cannot be produced by the engine as shipped.
> * Model weights (`.pt`/`.h5`) are git-ignored and absent.
>
> The injection seam is clean and documented (`FaceRecognizer` Protocol) and was **deliberately left untouched** during both build-out phases — a real model is to be supplied separately.

**One camera per process.** `config.py` carries a single `camera_id`; six seeded cameras means six configured instances. There is no supervisor or orchestration for this yet.

---

## 💓 Heartbeat & Real Edge-Link State (2026-07-27)

Before this, `/api/link` was **two integers in memory plus a demo toggle** — it returned `online` forever, including when no engine had ever existed. Every screen showing link state was reporting a constant.

**Docker database initialisation.** A fresh `docker compose down -v` followed by `docker compose up -d --build` loads Monitor's own `server/db/schema.sql` and `seed.sql` into `aegis_monitor` before the scoped `monitor_app` role is granted DML-only access. The application role must not bootstrap DDL at runtime: its lack of `CREATE` privilege on `public` is intentional.

**[NEW 2026-07-28] UI Camera Loading State.** `src/views/Live.jsx` now checks for `cameras === null` (in-flight `/api/cameras` request) and renders a smooth loading state (`Connecting to AEGIS Monitor feed server...`) instead of prematurely flashing the empty camera error state ("No cameras available to this account").

### Strict request-state rendering (2026-07-28)

Data-driven Monitor views use `src/lib/viewState.js` as one strict state machine: `LOADING`, `ERROR`, `SUCCESS_EMPTY`, or `SUCCESS_DATA`. The error branch returns only its retry/error container, so stale cards, mock-looking skeleton markup, charts, and page widgets cannot render beneath it. A successful zero-result response retains the existing page layout and presents its ordinary empty/zero state instead of an outage. This covers Alerts, Detection stream, Archival footage, Nodes, and Operators. `npm test` runs the regression test that proves an error always wins over any residual data payload.

For the HTTP-only localhost compose stack, `ENFORCE_PASSWORD_RESET=false` lets seeded demo accounts reach the zero-data UI immediately. The server defaults to enforcing the reset gate when this variable is absent, so production retains its fail-closed password-reset policy.

### Unified dual-theme Monitor shell (2026-07-28)

All authenticated Monitor views now share one cyber-physical visual system in `src/index.css`; this was a presentation-only refactor and did not add any mock rows, invented telemetry, or replacement pages. The shell is aligned to IDEA1's hierarchy with a near-black `#07080B` canvas, a restrained 24px cyber grid, bounded blue/violet workspace ambience, and elevated dark glass panels. The brand lockup now lives in the left/start zone of the global topbar, while the sidebar is reserved for navigation and footer context; the main workspace is no longer wrapped in one heavy outer glass card. The topbar uses Drive's `h-16 px-6` rhythm, compact status capsules, stacked tactical clock, utility dividers, and a ringed profile badge. The same status semantics remain everywhere: emerald for real online state, cyan for metadata, and rose for unreachable state. `App.jsx` owns the root `dark` / `light` class, so the Settings theme control updates the whole Monitor app rather than only the current card.

The Drive dashboard was used as the approved visual north star for density and hierarchy: a compact status topbar, grouped sidebar navigation, violet-blue active route, and crisp panel borders. Monitor retains its own authenticated menus and real backend payloads. Empty and error branches now consume the shared `EmptyState` HUD card with an accessible status role and reduced-motion fallback. Feed cards, node cards, operator rows, filters, role badges, and Settings segmented rails consume the same tokens in both themes.

**Settings layout refinement (2026-07-28).** `src/index.css` now gives Settings a 12-column bento layout rather than four equal cards: Display spans 5 columns, Notifications 7, Account 7, and System Status 5. Related controls stay grouped, short information cards gain usable height, and the grid collapses to two columns and then one column at mobile breakpoints. This addresses the prior large unused lower canvas while preserving the existing settings state and server-derived account/status data.

### Monitor shell layout and contrast correction (2026-07-28)

`TopBar.jsx` owns the complete `AEGIS Monitor` / `AI CCTV · NEXT-GEN HUD` lockup in the navbar start zone. `AegisLockup` uses intrinsic-width, non-truncating text so the subtitle remains visible. The desktop sidebar is 280px wide; section headings and menu labels use no-wrap alignment so `INFRASTRUCTURE & CONFIG` stays on one line. The final Monitor CSS contract also assigns explicit readable colors to page subtitles, sidebar footer copy, and Live event-stream timestamps, camera ids, and messages in both dark and light themes. No application logic or telemetry flow changed.
### Media-surface overlay correction (2026-07-28)

Live canvas overlays are now treated as media-surface UI rather than theme-inherited page text. The hero top-left label group is separated from the right utility controls and uses explicit white/rose-on-black contrast; the lost-state center uses a flex column with a gap and bright subtitles. Small-camera labels use explicit light and dark surface colors. Nodes & routing camera cards do not render the unnecessary absolute `LIVE CAM-XX` status overlay; its stale CSS rule was removed. No data, RBAC, or telemetry logic changed.
### Repository-wide tactical surface pass (2026-07-28)

The comprehensive Impeccable `craft`, `delight`, `layout`, and `animate` directive was applied to the three production frontend stylesheets: HUB, Drive, and Monitor. Monitor's existing real telemetry, request-state classifier, RBAC, routes, and state machines were left untouched. The Monitor CSS adds the same restrained interaction contract as its siblings—theme-aware focus rings, active press feedback, paint containment for high-frequency panels, and reduced-motion fallbacks—while retaining the approved dark cyber grid, glass panels, and honest unavailable/error states.

### Dark/Light palette and alignment correction (2026-07-28)

The final Monitor CSS contract now explicitly enforces `#07080B` dark canvas, `rgba(12, 13, 18, .90)` dark panels, white/Slate-300/400/500 text roles, rose glass status capsules, and blue-to-purple active navigation. Light mode now uses Slate-100 with a 16px Slate dot grid, white elevated panels, dark Slate headings/labels/values, and cyan-to-blue active states. TopBar status, clock, dividers, and profile now share a three-column baseline grid; Nodes and Settings use consistent 20px card padding and readable key/value alignment. This was a CSS-only correction in `src/index.css`; no new motion was introduced.

### Docker deployment verification (2026-07-28)

The latest Monitor CSS build was deployed through the root `docker compose up -d --build` workflow. `monitor`, `gateway`, `drive`, and `postgres` all report `healthy`, and the gateway route `http://localhost/monitor/` returned HTTP 200. This is a local HTTP test stack; production deployment remains the separate HUB production compose/nginx configuration.

### Live Canvas assigned-camera selector — source verification (2026-09-03)

`src/views/Live.jsx` retains the existing `heroCam` state, now defaulting to the
first camera in the server response rather than a hardcoded ID. After explicit
user approval, `CameraSelector` cards show live previews in pages of up to three
authorized cameras from `GET /api/cameras`, including offline/selected cameras.
Previous/Next exposes the rest of the list and selects the new page's first
camera. Unselected cards use the existing authorized stream proxy; the selected
thumbnail paints the main player's decoded pixels in memory at up to 10 fps,
without another stream request. Changing page/unmounting removes image sources,
listeners and retry timers, and clears/stops the selected thumbnail canvas.
All streamable cameras in the current page now demand capture, not just the
main camera; no off-page camera is started. This replaces the earlier
metadata-only design. Full-resolution thumbnail streams add real network,
capture/inference and potentially recording load; real-device measurement is
still required.

The main label, overlay, latest-detection Access Control result and Event Stream
share the same selected-camera context. A newer unknown result cannot inherit
an older authorization; missing detections show an explicit empty state.
Responsive cards use the existing dark/light tokens, with three columns below
the main feed and two/one columns when the container is narrower. They remain
selectable at 360/768/1024/1440/1920px. Two server cameras produce two choices,
not a fabricated third camera. The earlier three-tile hardcoded priority/swap-order behavior is
superseded, not retained as a second selection architecture.
At 901-1240px the right panels move below the feed/selector instead of being
squeezed into the inherited narrow two-panel rail.

Verification after reconciliation with current main: Monitor unit tests **14/14**, isolated Chromium browser tests
**18/18**, repository tests **56/56**, and production build pass. These are
source/UI/HTTP-fixture results, **not real-machine acceptance**. Receipt:
[[90-Status/logs/2026-09-03_142344_pub_idea2-live-camera-selector]].
No Engine, installer, tunnel, key ACL, production database or deployment changed.

Current `main` includes the merged cold-start availability and
viewer-demand/upstream-cleanup corrections from PR #89. The selector branch was
reconciled with that source while preserving both unit-test suites. Final rollout
should still repeat assigned-camera switching, idle cold start and viewer-demand
release acceptance against the exact merged revision.

### Presentation-only CCTV redesign (2026-07-28)

The Live canvas and authenticated Monitor shell use the confirmed IDEA1 visual language as a presentation skin over the existing real product: near-black canvas, quiet 24px grid, IDEA1-style compact topbar and sidebar, blue/violet active navigation, teal live state, restrained panels, and a balanced two-column Live workspace. The primary feed remains the visual anchor. The old thumbnail row is superseded by the bounded live-preview camera selector described above.

This change is intentionally presentation-only. `IDEA2-AEGIS_Monitor/src/index.css` owns the redesign, `tests/designContract.test.mjs` protects the layout and reduced-motion contract, and `package.json` includes that test in `npm test`. A pre-existing malformed JSX newline/tag mismatch in `src/views/Live.jsx` was corrected only so the unchanged Live behavior can compile; no API, RBAC, camera assignment, MJPEG lifecycle, state machine, or event handling was changed. `npm test` passes 6/6 and `npm run build` succeeds.

### Nodes & routing information hierarchy and Docker cache behavior (2026-07-28)

`src/views/Nodes.jsx` now presents Nodes & routing as an information-only routing workspace: camera feed thumbnails, hatch placeholders, and redundant absolute `LIVE CAM-XX` overlays were removed from the routing cards. The cards retain the real camera identity, zone, resolution, assignment, link status, and operator data, with a restrained loading skeleton while the real request is in flight. This is a presentation-only change; the camera list, assignment scope, RBAC, and status payload are unchanged. `server/index.js` also marks the HTML shell as `no-store, no-cache, must-revalidate` while keeping fingerprinted assets immutable, preventing a Docker deployment from serving the previous Monitor bundle after rebuild.

* `HeartbeatWorker` POSTs a `MetricsRegistry` snapshot to `/internal/heartbeat` every 5s.
* Monitor UPSERTs one row per camera into **`camera_heartbeat`** (real columns: `camera_connected`, `capture_fps`, `detect_fps`, `latency_ms`, `latency_ms_avg`, `uptime_s`, `frames_captured`, `segments_written`, `nas_last_status`, `nas_pending`, `node_id`, `stream_url`).
* `store.linkStatus(visibleIds)` derives status **purely from row age**: `≤15s → online`, `≤45s → degraded`, older or absent → `lost`.
* Scoped like every other data endpoint — an operator sees health for their own cameras only.

**Silence is the signal.** The engine never posts "I am down". If the process dies or the network drops, rows simply stop arriving and Monitor ages the status itself. A live process cannot fake health, and a dead one cannot hide. Measured:

| condition | result |
| :--- | :--- |
| engine alive | `status=online`, `age=2314ms`, `captureFps=346`, `latencyAvg=13.7ms` |
| engine killed | `status=lost`, `simulated=false`, `age=55979ms` |
| `operator2` (CAM-06, no engine) | `cameras=[]`, `status=lost` — honest, not fabricated |

**`POST /api/link/outage`** is a deliberate drill control, restricted to **SOC-Responder** (`requireRole(ROLES.SOC)`). It no longer fabricates state silently: the payload carries `simulated: true` alongside `realStatus`, so a drill is distinguishable from a real outage. An operator with a valid, non-gated session gets `403 Forbidden`.

---

## 📺 Live Video — Proxied MJPEG (Phase B, 2026-07-27)

Previously there was **no video display at all**: the "feed" surfaces were a CSS diagonal hatch (`repeating-linear-gradient`), with zero `<video>` elements and no stream endpoint anywhere.

```mermaid
sequenceDiagram
    participant B as Browser &lt;img&gt;
    participant M as Monitor :8002
    participant DB as aegis_monitor
    participant E as Engine :8077

    B->>M: GET /api/cameras/CAM-05/stream (session cookie)
    M->>M: requireAuth
    M->>M: canSeeCamera — same logic as /api/cameras
    Note over M: 403 here if not assigned — before any socket opens
    M->>DB: SELECT stream_url FROM camera_heartbeat
    Note over M: 503 if absent or heartbeat older than 45s
    M->>E: GET /stream.mjpg (X-Detection-Engine-Key)
    E-->>M: multipart/x-mixed-replace
    M-->>B: piped through, same origin
    loop every 10s while open
        M->>M: reload session + re-check camera_assignment
    end
```

**Why proxy instead of browser → engine directly**: the engine sits on VLAN 20 and holds the service key. A direct connection would require exposing the engine to browsers and shipping the key to the client. The proxy keeps the browser on Monitor's own origin and `stream_url` server-side only — verified absent from every client payload (the client sees a `hasStream` boolean).

**Frames come from a third sink on the existing capture fan-out**, not a second `cv2.VideoCapture` and *not* the detector's queue — items on that queue are consumed once, so sharing it would steal frames from inference. `StreamHub` encodes each frame once and shares the bytes with all viewers, encodes nothing when nobody is watching, and drops stale frames rather than queueing them.

**Rendering**: a plain `<img src="/monitor/api/cameras/:id/stream">`. `multipart/x-mixed-replace` is the browser's native path — no player library, no decoding JS.

### Verified live, not merely connected

10 consecutive frames pulled through the proxy as the `operator` session: **10/10 distinct SHA-256 hashes**, all valid 1280×720 JPEGs at ~10.4 fps, with the burned-in timestamp region changing on every transition and a `mean|Δ| = 3.947` spike when a second subject entered frame.

### CSP — no change was required

`img-src 'self' data:` is already present, and CSP governs `<img>` fetches through **`img-src`**, not `media-src` (which covers `<audio>`/`<video>`/`<track>`). The stream is same-origin with the page, so it matches `'self'`. **No `media-src` amendment and no relaxation of any kind was needed.** Verified by inspecting the CSP served on both the page and the stream response (one header; the doubling issue is confined to the production HUB config).

---

## 🔐 Server-Side Privilege Control

1. **Single app, server-resolved dual views** — the backend issues the menu; a view the role lacks is never in the payload, so it cannot appear in the DOM.
2. **Server-side camera JOIN** — `camera_assignment` lives in `aegis_monitor`. `CCTV-Operator` requests JOIN through it server-side; an unassigned camera id yields `403`. `soc` has no rows and sees everything.
   * Demo scope: `operator` → CAM-05, `operator2` → CAM-06.
   * This now covers **live video too**: `operator2` requesting CAM-05's stream gets `403` before any socket to the engine is opened.
3. **Streams re-check authorisation while open** — checking only at open would let a logged-out operator keep receiving live video until they closed the tab. The session is re-read from the store every 10s and `camera_assignment` re-checked on the same tick.
4. **Force-reset gate** — seeded demo accounts carry `must_reset_password = TRUE`; everything except `/me`, `/logout`, `/password/reset` answers `403 PASSWORD_RESET_REQUIRED` until changed.

---

## 🖥️ Screens

| # | View | Roles | Status |
| :-- | :--- | :--- | :--- |
| 1 | Live canvas | SOC + Operator | ✅ Real MJPEG video + overlays from real detections; CAM-02 hardcoded `host.docker.internal` removed, now proxied like every other camera (2026-08-01). CCTV Operator motion/hierarchy pass (2026-08-01, follow-up): real camera-swap fade transition, page-load choreography removed, brief live-state recovery flash, `prefers-reduced-motion` now respected by Framer Motion via `MotionConfig`, not just raw CSS. |
| 2 | Archival footage | SOC + Operator | ✅ Real clip metadata + **real playback** — `GET /api/clips/:id/video` + `<video>` element (2026-08-01, closes the prior open item). Independently re-verified live in the 2026-08-01 follow-up session (see below) after a regression briefly broke it. |
| 3 | Detection stream | SOC | ✅ Real rows; multi-person frames reveal tailgating |
| 4 | Alerts | SOC | ✅ Real rows; Acknowledge is the console's only write; Telegram delivery now routes per-camera via `camera_assignment` instead of one hardcoded chat id (2026-08-01), independently verified live in the follow-up session |
| 5 | Nodes & routing | SOC | ✅ Real fleet + assignment + link state, now derived from `camera_heartbeat` rows instead of a static column (2026-08-01); live preview frame added to node cards |
| 6 | **Operators** | SOC | ✅ **Built 2026-07-27** — table + assignment editor |
| 7 | Camera diagnostics | Operator | ✅ Rebuilt on real heartbeat data |
| 8 | Settings | SOC + Operator | 🟡 Display/theme real; notification prefs are UI-only; language selector now persists to `localStorage` and syncs cross-tab like theme (2026-08-01 follow-up), but only `Settings.jsx` itself reads translated strings so far |

### Operators view (View #6) — the dead menu entry, resolved

`permissions.js` had always issued `operators` in the SOC menu, but `nav.js` had no `DISPLAY` entry, so `buildSections` dropped it silently and no component existed. Three layers were already finished — the README specified it, `index.css` carried a purpose-built `/* operators */` block (`.tablewrap`, `.dt`, `.opav`, `.opassign`, `.edrow`, `.camopts`) with zero consumers, and `PUT /api/assignments` existed **uncalled**. Building it was chosen over deleting, and it is now the first and only caller of that endpoint. Reassignment takes effect on the operator's scope immediately (verified: adding CAM-01 changed their visible set within one request).

### Camera diagnostics — rebuilt, with honest gaps

Previously fabricated end to end: `LAT_SERIES` was three hard-coded 12-point arrays feeding the "last 12 samples" sparkline, heartbeat was always `'2s ago'`, uptime always `'99.2%'`, stream always `'24fps'`, and all five checks derived from one (also fake) flag. Now every field comes from `camera_heartbeat`. Where a metric genuinely cannot be computed it says **`unavailable`** and why:

* **Uptime % and disconnects (24h)** → unavailable: the table UPSERTs one row per camera and keeps no history.
* **Latency sparkline** → removed outright for the same reason.
* **A camera with no heartbeat** → renders "No engine" with every field unavailable, never a healthy-looking card.

See [[concepts/Honest_Telemetry_and_Unavailable_States]].

---

## 🧹 Fabricated Content Removed (2026-07-27)

| Removed | Was |
| :--- | :--- |
| `HERO_SCENES` / `TILE_BOXES` (`data.js`) | Bounding boxes hard-keyed to camera ids with **invented people and match scores** — `AUTH // J. SMITH // 98%`, `SOMCHAI T. // 98%`, `A. OKAFOR // 95%`, `UNKNOWN PERSON // 82%`. Drawn whether or not the system had ever seen anyone. On a security console this is fabricated evidence, not a placeholder. |
| `FACE_RECOGNITION V1.3` | A model name for a model that does not exist. |
| `REC • 1080p • 24fps` | Hard-coded. Resolution now from the `cameras` table, fps from the heartbeat, omitted when unmeasured. |
| `AI auto-elevated CAM-02 on unknown detection` | Driven by a static flag; no auto-elevate mechanism exists. |
| `LAN · 4 ms` / `LAN · 210 ms` (TopBar) | Latency never measured anywhere. Now real mean inference latency, or `Inference · unavailable`. |
| `AI engine: running` | Pinned green regardless. Now derived from how many engines are actually reporting. |
| `Running v1.3` / `AEGIS Monitor v3.0` (Settings) | Version strings typed into the screen. Version now from `package.json` via a vite `define`. |
| `demo · user / aegis-user · admin / aegis-admin` (login page) | Credentials printed to every unauthenticated visitor — **and they were IDEA1's, not Monitor's**, so the hint also misdirected. |
| `192.168.1.42 · LAN` / `v3.0-spatial` (`Footer.jsx`, found + fixed 2026-08-01 follow-up) | A fixed IP with nothing measured behind it (identical regardless of which node was actually reporting, or whether any node was reporting at all), and a version string that disagreed with the one `Settings.jsx` already read from `__APP_VERSION__`. Footer now shows the real `node_id` from the freshest `camera_heartbeat` row (or "No edge node reporting") and the same `__APP_VERSION__` as Settings. |

Overlays are now derived from the newest real detection for that camera and render **nothing** when there is none. With the placeholder recogniser in play every box reads `UNKNOWN`, which is the truth.

---

## 🐛 Bugs Found & Fixed Along The Way

* **Dev login was entirely broken** — `vite.config.js` had `changeOrigin: true`, which rewrites `Host` to the proxy target while the browser still sends its own `Origin`. The CSRF Origin↔Host check (`csrf.js:23`) then rejected **every** mutation with `403`, including login (`PRE_SESSION_PATHS` exempts only the *token* check, which runs after). Measured `403` before, `200` after. Same fix and reasoning as IDEA1's `vite.config.js`.
* **Seeded credentials were live forever** — the three demo accounts landed with `must_reset_password = FALSE`, so bcrypt hashes committed to a public repo were working credentials on every deployment. Now `TRUE`, plus an idempotent `UPDATE` (matched on the git-known hashes) to close databases initialised earlier. Plaintext passwords removed from the seed file's own header comment — a comment recording real credentials is itself the leak.
* **Any operator could black out every console** — `POST /api/link/outage` was `requireAuth` only, but the state it flips is process-wide. One request (or pressing `L`) put every connected console into LINK LOST for 60s.
* **A dying stream could hang forever** — found during Phase B testing of my own implementation: when the upstream socket went quiet without FIN/RST, the client hung >30s with no bytes and no error, freezing the last frame with nobody told. Fixed with a 6s idle watchdog on the proxy.
* **Streams outlived their session** — authorisation was checked only at open, so a logged-out user kept receiving video. Fixed with 10s revalidation.
* **[2026-08-01 follow-up] `GET /api/clips/:id/video` silently disappeared for one deploy cycle** — an earlier same-day edit pass re-copied the pristine uploaded `api.js` as a base for the `/api/nodes` heartbeat-status fix instead of continuing from the version that already had the clip-video route, dropping the route entirely while the `/nodes` fix rode along on top of the reset file. Not caught by any test or lint; only surfaced as a plain 404 in the browser against a clip independently confirmed present on disk (`sha256sum` matching the `nas_sync` log line) and readable by the `node` user (`fs.existsSync` from inside the container). Re-added, and `Cache-Control: no-store` — previously only set on the success path — was moved to the top of the handler so it now covers every response branch (403/404/409/503), closing a related caching footgun the route had already been bitten by once before.

### Measured failure behaviour (live video)

| scenario | result |
| :--- | :--- |
| engine dies mid-stream | EOF at **t=5.23s** → `<img>` fires `error` → backoff retry (2s…30s) |
| camera never started | **503** — client never dials, shows `NO LIVE STREAM` |
| session ends mid-stream | cut at **t=10.06s**, log `session ended — closing` |
| access revoked mid-stream | cut at **t=10.03s**, log `access revoked — closing` |

---

## ✅ End-to-End Verification (2026-07-27)

Run against the live compose stack with a real camera and a synthetic feed:

* **Pipeline**: real 1280×720 capture → 20s segments (603 frames, 1.2 MB) → `scp` + **sha256 verify** → delete-after-verify → `clips` row. At peak, **187 clip rows ↔ 187 real files on the NAS (3.0 GB)**, every sampled path present.
* **Detections**: 375 rows across 232 frames — **all `Unknown`, zero `Authorized`** (correct for the placeholder), with 2-person frames proving the shared-`frame_id` tailgating path.
* **Regression**: **27/27**, covering every operator-denial case, both stream-denial cases, engine key enforcement, the gateway still 404-ing `/monitor/internal/`, and CSRF.

> ⚠️ **Note on the NAS used for testing**: a disposable Alpine + sshd container standing in for the Synology. The transfer, the sha256 verification and the delete-after-verify were all the real code path — only the host differed. It was torn down afterwards, so those 187 rows were removed.

---

## 🔧 2026-08-01 Pass — CAM-02 fix, clip playback, Telegram routing, heartbeat nodes, Operators rebuild, i18n kickoff

> ⚠️ **User-reported at the time this was first logged, not independently re-verified in that session.** A follow-up same-day session (below) did have live source-code access and a running stack, and independently re-confirmed several of these claims against real terminal output — see the section directly below for exactly which ones.

* **CAM-02 live stream fixed.** `LiveFeed.jsx` had a hardcoded `host.docker.internal` URL that bypassed the documented `/api/cameras/:id/stream` proxy architecture (see [Live Video — Proxied MJPEG](#-live-video--proxied-mjpeg-phase-b-2026-07-27) above). Removed; CAM-02 now goes through the proxy like every other camera.
* **Docker/CSP/OpenCV/codec cluster fixed.** `docker-compose.yml` port mapping, volume mounts, and env vars corrected; CSP header fixed; a conflicting `opencv-python` version resolved; `aegis_scanner.py` gained an ffmpeg transcode step (mp4v → H.264) so recorded segments are broadly playable.
* **Clip playback closed** — see the Screens table and Open Items table above.
* **Alerts now route by camera, not a single hardcoded chat.** `telegram_chat_id` added to the schema; `telegramRouteFor()` + `GET /internal/route/:cameraId` resolve the right Telegram destination per camera; `aegis_scanner.py` routes through `camera_assignment` instead of one fixed chat id; a `set-telegram` CLI command was added for provisioning.
* **Nodes & routing online/offline now sourced from `camera_heartbeat`** rather than a static column, plus a live stream preview frame added to node cards. Note this is described as a fix to a *different* signal than the `linkStatus()` row-age logic documented under [Heartbeat & Real Edge-Link State](#-heartbeat--real-edge-link-state-2026-07-27) — worth reconciling in a future audit pass to confirm there was only ever one source of truth for online/offline.
* **`Operators.jsx` (View #6) rebuilt** — the file was missing from the working tree despite the backend (`PUT /api/assignments`, etc., documented above) already being wired up.
* **Central i18n started, not finished.** New `src/lib/i18n.js`; `Settings.jsx` now imports from it. `App.jsx` and the remaining views still need to accept a `lang` prop and use translated strings — tracked as a new open item below.

---

## 🔧 2026-08-01 Follow-up — video-route regression, Live canvas motion pass, Footer honesty fix, live-verified Telegram routing

This is a same-day continuation of the pass immediately above, this time run with live source-code access and a real running dev stack, so the claims here are backed by terminal output rather than a developer's own summary.

**The video-route regression** is documented in [Bugs Found & Fixed Along The Way](#-bugs-found--fixed-along-the-way) above (`GET /api/clips/:id/video` disappearing during the `/nodes` edit, then re-added with `Cache-Control: no-store` moved to cover every response branch).

**Live canvas motion/hierarchy pass**, per an explicit CCTV-Operator-focused design brief (feed → switcher → access/event rail hierarchy; a real camera-swap transition; live-state feedback; no page-load choreography; full `prefers-reduced-motion` support):

* `App.jsx` — wrapped the whole app in `<MotionConfig reducedMotion="user">`. The existing `@media (prefers-reduced-motion: reduce)` CSS rules only ever covered raw CSS `animation`/`transition` properties; every Framer Motion `whileHover`/`whileTap`/`animate` interaction across the entire app was previously **not** honoring the OS-level reduced-motion setting at all. One wrapper fixes it site-wide. `lang` also now persists to `localStorage` and syncs cross-tab, matching how `theme` already worked (`aegis_theme`) — closing a small gap where language reset to Thai on every reload.
* `Live.jsx` — removed staggered entrance animation from `.pagehead` and `.canvasR` (the `.canvasR` panel was fading/sliding in **150ms after** the left column on every page visit — literal page-load choreography). Fixed the hero's camera-swap transition, previously `initial={{opacity:1}} animate={{opacity:1}}` (a no-op — both values identical, nothing ever animated despite the code appearing to intend a swap effect), to a real 200ms fade tied to the `key={cam.id}` remount. Replaced `motion.button` wrappers on the three secondary-camera tiles with plain `<button>` elements — those wrappers also had matching `initial`/`animate` values and no `whileHover`/`whileTap` props, so they did nothing that the existing `.sfeed--clickable:hover`/`:active` CSS wasn't already doing.
* `LiveFeed.jsx` — added a `justRecovered` state that briefly flashes a teal inset ring (`.feed-recovered`, 700ms CSS keyframe) specifically when a stream **recovers from a prior error** (`attempts.current > 0` at the moment `onLoad` fires), not on first connect — this was a deliberate design choice to avoid reintroducing page-load choreography under a different name; a flash on every fresh page load would be exactly that.
* `src/index.css` — new rules appended at the very end of the file (`.feed-recovered` keyframe, `.hero`/`.secondrow`/`.sfeed` weighting tweaks, `.sfeed--clickable:focus-visible`). **Not** consolidated with the file's existing ~5 stacked "redesign pass" blocks (several of which redeclare `:root`/`.hero`/`.topbar`/`.panel`/`.side` with different values, where only the last-in-file declaration is ever live) — that cleanup was explicitly proposed to the user and explicitly deferred by their own choice, so this pass deliberately followed the file's existing "append last, let it win the cascade" convention rather than touching anything upstream.

**`Footer.jsx` honesty fix** — see the new row in [Fabricated Content Removed](#-fabricated-content-removed-2026-07-27) above. `link` replaces the narrower `linkStatus` prop so the component can read `camera_heartbeat.node_id` from the freshest row.

**Independently verified live in this session** (terminal output, not self-reported):

* `docker compose exec monitor grep -c "clips/:id/video" server/routes/api.js` → `2`; `grep -c "getClipById" server/db/store.js` → `1` — confirms the regression fix actually deployed.
* A camera was relabeled from `CAM-02` to `CAM-05` purely via the engine's `AEGIS_CAMERA_ID` env var (no code change), to exercise the Telegram-routing logic against a camera that already had a real `camera_assignment` row (`operator` / M. Reyes). `GET /internal/route/CAM-05` → `{"chatId":"8686991056","routeLabel":"M. Reyes"}`; the running engine's own log then showed `OK: Telegram alert sent -> M. Reyes` repeatedly, confirming `telegramRouteFor()` resolves through `camera_assignment` correctly once an operator has both a camera and a `telegram_chat_id`, rather than always falling back to SOC-Team.
* `ffprobe` on the newly recorded CAM-05 clip: `Video: h264 (High) ... encoder: Lavc62.28.102 libx264` — confirms the ffmpeg mp4v→H.264 transcode step from the earlier same-day pass is still working correctly after the camera relabel.

**Operational issues found and resolved during this verification (not code changes, recorded for anyone else hitting the same thing)**:

* The project's root `.env` did not exist — only `.env.example` did. `DETECTION_ENGINE_API_KEY` was silently empty inside the `monitor` container the entire time, so `requireDetectionEngineKey.js`'s fail-secure design correctly returned `503` on `/internal/route/:cameraId` (this is the fail-secure behavior working as designed — the bug was the missing `.env`, not the 503). Recreating `.env` from `.env.example` then surfaced a second, unrelated issue: the freshly-copied `.env`'s DB password placeholders didn't match what Postgres had actually been initialized with on first boot (`password authentication failed for user "monitor_app"`, `500`) until corrected to match the `docker-compose.yml` defaults.
* `telegram_chat_id` for `operator` (M. Reyes) was set via a direct `UPDATE users ... WHERE username = 'operator'` SQL statement, not a code change, to complete the routing verification above (reusing the same chat id already set for `soc`, since both route to the same tester's own Telegram in this dev environment).

---

## 📂 Codebase File Paths

**Monitor (Beelink, `:8002`)**
* `server/index.js` — Express API server
* `server/routes/api.js` — user-facing API incl. **`GET /api/cameras/:id/stream`** (scoped MJPEG proxy), **[NEW 2026-08-01]** `GET /api/clips/:id/video` (briefly regressed and re-fixed same-day — see Bugs Found)
* `server/routes/internal.js` — engine ingest incl. **`POST /internal/heartbeat`**, **[NEW 2026-08-01]** `telegramRouteFor()` + `GET /internal/route/:cameraId`
* `server/db/schema.sql` — incl. **`camera_heartbeat`**, **[NEW 2026-08-01]** `telegram_chat_id`
* `server/db/store.js` — `linkStatus()`, `recordHeartbeat()`, `streamSourceFor()`, `provisionOperator()`, **[NEW 2026-08-01]** `getClipById()`
* `server/rbac/permissions.js` — view registry (source of truth for menus)
* `src/App.jsx` — **[UPDATED 2026-08-01 follow-up]** `<MotionConfig reducedMotion="user">` wraps the app; `lang` persists to `localStorage` and syncs cross-tab
* `src/components/LiveFeed.jsx` — MJPEG `<img>` + reconnect/failure states; **[FIXED 2026-08-01]** removed hardcoded `host.docker.internal` for CAM-02; **[UPDATED 2026-08-01 follow-up]** brief `.feed-recovered` flash on error recovery
* `src/components/Footer.jsx` — **[FIXED 2026-08-01 follow-up]** `link` prop replaces `linkStatus`; real `node_id` + `__APP_VERSION__` replace a hardcoded IP and a mismatched version string
* `src/components/ui.jsx` · `src/index.css` — shared dual-theme HUD state, controls, panels and motion rules for all Monitor views; **[UPDATED 2026-08-01 follow-up]** additive block appended at file end for the Live canvas motion pass
* `src/views/Operators.jsx` — View #6; **[REBUILT 2026-08-01]** — was missing from the working tree
* `src/components/AddOperator.jsx` — shared provisioning modals (lifted out of `Nodes.jsx`)
* `src/views/Diagnostics.jsx` — rebuilt on real heartbeat data
* `src/views/Archive.jsx` — **[NEW 2026-08-01]** real `<video>` playback via `GET /api/clips/:id/video`
* `src/views/Nodes.jsx` — **[UPDATED 2026-08-01]** online/offline sourced from `camera_heartbeat`; live preview frame on node cards
* `src/views/Live.jsx` — **[UPDATED 2026-08-01 follow-up]** removed page-load choreography from `.pagehead`/`.canvasR`; real camera-swap fade transition; simplified no-op `motion.button` wrappers to plain buttons on secondary tiles
* `src/lib/api.js` — **[UPDATED 2026-08-01]** `GET /api/clips/:id/video`
* `src/lib/store.js` — **[UPDATED 2026-08-01]** `getClipById()`
* `src/lib/i18n.js` — **[NEW 2026-08-01]** central i18n module; only `Settings.jsx` consumes it so far
* `src/data.js` — display helpers only; `bboxesFor()` replaced the fabricated scene tables
* `aegis_scanner.py` — **[UPDATED 2026-08-01]** ffmpeg transcode (mp4v → H.264); Telegram routing via `camera_assignment` — independently re-confirmed working in the 2026-08-01 follow-up session (`ffprobe` on a CAM-05 clip, live Telegram delivery log)

**Detection Engine (Laptop, VLAN 20)**
* `aegis_engine/video_catcher.py` — the only thread touching the device
* `aegis_engine/face_detector.py` — model injection seam; identity-free default or explicit hybrid recognizer selected by `run.py`
* `aegis_engine/segment_recorder.py` · `nas_sync.py` — recording and verified off-load
* `aegis_engine/heartbeat_worker.py` — **[NEW]** liveness publisher
* `aegis_engine/stream_hub.py` — **[NEW]** JPEG encode-once, share-to-N
* `aegis_engine/local_api.py` — FastAPI; incl. **`GET /stream.mjpg`** (API-key gated)

---

## 🚧 Open Items (IDEA2)

| Item | Status | Notes |
| :--- | :--- | :--- |
| **Real face-recognition model** | ✅ Accepted on two real edge runtimes; source review pending | Optional YOLO + YuNet/SFace uses private local assets on CAM-01 Windows and CAM-02 Arch Linux. CAM-02 model load, real inference, user-observed Authorized behavior, Unknown alerting, Telegram delivery, viewer release and reboot persistence passed. Accuracy/fairness/liveness benchmarking is not claimed. |
| ~~**Clip playback**~~ | ✅ Resolved (2026-08-01) | `GET /api/clips/:id/video` + `getClipById()` in `store.js` + a real `<video>` element in `Archive.jsx` replaced the text-panel-only play button; a URL bug that dropped the `/monitor/` prefix was fixed in the same pass. **Independently re-verified live in the 2026-08-01 follow-up session** after briefly regressing to a 404 (see Bugs Found) — `grep` confirms the route is deployed and a real CAM-05 clip was confirmed playable end to end. |
| **`gateway/nginx.conf` case-sensitivity gap** | 🔴 Open | `location /monitor/internal/` is a case-sensitive literal, but Express matches paths case-insensitively — `/monitor/Internal/...` bypasses the edge guard. The production HUB config already uses `location ~* ^/monitor/internal(/\|$)` and its comment records that the gateway has the same hole. Still guarded by the API key; the *edge* layer is what is bypassable. |
| **Heartbeat history / uptime %** | 🔴 Open | `camera_heartbeat` keeps only the latest row per camera. Uptime %, 24h disconnects and a real latency sparkline all need a time-series table. Currently shown as `unavailable`. |
| **Multi-camera engine deployment** | 🟠 Two-node path accepted; fleet automation open | CAM-01 Windows and CAM-02 Arch Linux run one configured process per physical edge host with unique camera/node identity, SSH key and server reverse endpoint. Same-host multi-instance supervision, bulk provisioning and fleet-scale soak remain open. |
| **Real bbox geometry** | 🟠 Design constraint | `detections` has no bbox column, so overlay boxes are evenly-spaced slots. `.feedimg` uses `object-fit: cover`, which crops within the box — **when real bbox telemetry arrives this must become `contain` or letterbox-aware**, or normalised coordinates will be wrong by the cropped margin. |
| **Safari live video** | 🟠 Known limitation | `multipart/x-mixed-replace` in `<img>` works in Chrome/Edge/Firefox; **Safari does not support it** and will sit in the reconnect state. |
| **Notification preferences (Settings)** | 🔴 Open | Sound / desktop push / snooze are `useState` only — never persisted — yet each toggle fires a "saved successfully" toast. |
| **No audit log** | 🔴 Open | IDEA2 has **no `audit_log` table at all** (unlike IDEA1). Operator creation, camera reassignment, alert acknowledgement, password resets and every login leave no record. If built, use awaited writes from the start rather than repeating IDEA1's fire-and-forget bug. |
| **Zero automated tests** | 🔴 Open | No test script, no test dependency, no `tests/` directory (IDEA1 has 11 suites). The RBAC/scoping boundary — the project's headline security claim — has no automated proof. |
| **Real NAS integration** | 🔴 Open | `nas_sync_clip()` still only verifies sha256 against a file on the **same disk** as the engine (Phase 1 simulation, documented in-code) rather than actually transferring bytes to a separate NAS host. Swapping the `docker-compose.yml` bind-mount source and adding a real rsync/scp step was design-confirmed with the user 2026-08-01 but not yet implemented. |
| **i18n rollout incomplete** | 🟡 In progress (2026-08-01, still incomplete as of the same-day follow-up) | `src/lib/i18n.js` exists and `Settings.jsx` consumes it. The 2026-08-01 follow-up pass added `lang` persistence (`localStorage` + cross-tab sync) to `App.jsx`, but **no additional view or shell component was wired to read translated strings** — `Live.jsx`, `TopBar.jsx`, `Sidebar.jsx`, `Footer.jsx`, `Detection.jsx`, `Diagnostics.jsx`, and `Login.jsx` still render hardcoded English/Thai strings. |
| **`src/index.css` has ~5 stacked redesign-pass blocks with duplicate declarations** | 🟡 Flagged, deferred by user choice (2026-08-01) | Several blocks redeclare the same `:root`/`.hero`/`.topbar`/`.panel`/`.side` selectors with different values; only the last one in the file is ever live, so the earlier ones are dead code that makes the file harder to reason about. Flagged to the user before the 2026-08-01 follow-up motion pass; the user explicitly chose to defer the cleanup rather than have it done as part of that pass. |

---

## 🔗 Related Notes
* [[core/system-overview]]
* [[core/hub-aegis-entry]]
* [[idea3/idea3-status]]
* [[core/security-architecture]]
* [[concepts/Identity_Decoupling]]
* [[concepts/Honest_Telemetry_and_Unavailable_States]]
* [[concepts/OWASP_Security_Defense]]
