---
title: Task Receipt — IDEA2 Detector B real-machine acceptance
date: 2026-09-06T15:45:16+07:00
owner: pub
area: idea2
branch: codex/idea2-detector-b-runtime
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — IDEA2 Detector B real-machine acceptance

## What changed

- Installed the second physical Detection Engine on an Arch Linux laptop as
  CAM-02 / `edge-node-02`, while preserving CAM-01 on the existing Windows
  laptop and keeping inference off the Beelink.
- Provisioned a distinct Detector B SSH key and reverse endpoint `:18078`, added
  the exact server SSH listen allowance and exact Monitor-container UFW rule,
  then verified the local Monitor forward on `127.0.0.1:18002`.
- Installed the local camera service and tunnel as enabled systemd units. The
  real webcam, heartbeat, Monitor stream, viewer release and repeated reboot
  recovery passed.
- Installed local YOLO, YuNet and SFace assets plus a private enrollment copied
  from Detector A with the user's explicit authorization. Model/enrollment
  compatibility, application Authorized behavior and Unknown detection passed.
- Configured Telegram without printing its token/chat ID. AlertManager reported
  `dry_run=False` after reboot and the user confirmed a real post-reboot alert.
- Deployed two Monitor backend lifecycle corrections required by on-demand
  multi-detector streaming: fresh-heartbeat stream availability and explicit
  upstream MJPEG cancellation on downstream close.
- The final source set was reconciled onto current `origin/main` `73daa3e` in
  local branch `codex/idea2-detector-b-runtime`. No push, Pull Request or merge
  occurred before user review.

## Source files changed

Reconciled IDEA2 source implementation, still local and unpublished:

- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.env.example`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/.gitignore`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/README.md`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/requirements-ai.txt`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/run.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/config.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/engine.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/local_api.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/segment_recorder.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/stream_hub.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/video_catcher.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/yolo_admin_recognizer.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/aegis_engine/yolo_sface_admin_recognizer.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/linux/README.md`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/linux/install_systemd.sh`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/linux/repair_systemd.sh`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/linux/status_systemd.sh`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/linux/uninstall_systemd.sh`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_config.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_entrypoint.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_linux_systemd.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_recognition_safety.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_stream_lifecycle_regression.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_viewer_demand.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_yolo_admin_recognizer.py`
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_yolo_sface_admin_recognizer.py`
- `IDEA2-AEGIS_Monitor/package.json`
- `IDEA2-AEGIS_Monitor/server/db/store.js`
- `IDEA2-AEGIS_Monitor/server/routes/api.js`
- `IDEA2-AEGIS_Monitor/server/streamLifecycle.js`
- `IDEA2-AEGIS_Monitor/tests/streamLifecycle.test.mjs`
- `IDEA2-AEGIS_Monitor/tests/viewerDemandAvailability.test.mjs`

Documentation changed for this acceptance:

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-moc.md`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/2026-09-06_154516_pub_idea2-detector-b-real-machine-acceptance.md`

## Verification evidence

- Command: `python -m unittest discover -s tests -p "test_*.py" -v`; result: PASS (76/76).
- Current-main source reconciliation: `.venv\\Scripts\\python.exe -m unittest discover -s tests -p "test_*.py" -v`
  — PASS 76/76; `npm test` in Monitor — PASS 11/11; `npm run build`
  — PASS, Vite transformed 2,072 modules.
- `bash.exe -n detection-engine/linux/*.sh` — PASS for all four executable
  systemd lifecycle scripts after current-main reconciliation.
- Command: `python -m unittest discover -s tests -p "test_linux_systemd.py" -v`; result: PASS (12/12).
- `node scripts/validate-vault.mjs --vault Obsidian_AEGIS_Vault/AEGIS_Knowledge`
  — PASS with two pre-existing owner-review Canvas warnings.
- Detector B package SHA256 verification, Bash syntax checks and
  `python -m unittest discover -s tests -p "test_linux_systemd.py" -v` — PASS,
  12/12 Linux systemd source tests.
- Dedicated Detector B SSH authentication and `-L 127.0.0.1:18002:172.18.0.2:8002`
  plus `-R 172.18.0.1:18078:127.0.0.1:8077` probe — PASS; probe cleaned up.
- Server `ss -lntp` — PASS: CAM-01 remained on `172.18.0.1:18077` and CAM-02
  listened on `172.18.0.1:18078`.
- Production database heartbeat query — PASS: CAM-02 reported `edge-node-02`,
  fresh heartbeat and the `:18078` stream URL.
- Monitor-container request to Detector B health — initially timed out; after
  the exact UFW bridge rule was added, PASS with HTTP 200. This is the evidence
  for the cross-scope firewall change.
- Model and enrollment SHA256 comparison — PASS without recording biometric
  values. Enrollment contained 133 templates of 128 dimensions and matched the
  provisioned SFace model. Runtime permissions: models `0644`, enrollment
  `0600`.
- AI dependency installation and recognizer constructor — PASS;
  `AI_MODEL_LOAD=PASS`, backend `yolo-sface-admin`.
- Live CAM-02 health — PASS: connected/demanded, one viewer, capture about
  4.9 FPS and detection about 5.0 FPS. Unknown events were logged and the user
  confirmed an Authorized application result for an enrolled person.
- Close-all-viewers check after 20 seconds — PASS: idle, camera disconnected,
  demand false, zero viewers and zero capture/detection FPS. Lifecycle log
  recorded viewer disconnect and `camera released (no authenticated viewers)`.
- Reboot checks — PASS: Engine and tunnel enabled/active; new Engine uptime;
  `yolo-sface-admin`, local Monitor health and `dry_run=False` restored.
- Real post-reboot Unknown-face Telegram notification — PASS by direct user
  confirmation. Secret values were not printed or written to repository files.
- Monitor source tests — PASS: lifecycle/availability suite 11/11 and production
  build completed. These source tests do not replace the real runtime evidence.
- Monitor production activation — PASS: health became healthy, other containers
  and network addresses remained unchanged. A rollback image/release directory
  was retained; rollback was not needed.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — replaces the
  pending Detector B state with scoped real-machine and reboot acceptance.
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-moc.md` — adds the current
  Detector B acceptance pointer.

## Shared surfaces touched

Runtime-only cross-scope infrastructure changes requiring Kla review:

- `/home/pubpup2006p/.ssh/authorized_keys` — added Detector B's constrained
  public key for its dedicated reverse endpoint and Monitor destination.
- `/etc/ssh/sshd_config.d/60-aegis-idea2-camera-tunnel.conf` — added exact
  `PermitListen` allowance for `172.18.0.1:18078` while retaining `:18077`.
- UFW runtime rules — added exact inbound allow from Monitor container
  `172.18.0.2` on the production bridge to `172.18.0.1:18078/tcp`.
- `/opt/aegis/runtime/monitor-viewer-demand-20260905-184223/` — Monitor backend
  availability deployment and rollback artifacts.
- `/opt/aegis/runtime/monitor-stream-cleanup-20260905-194717/` — Monitor stream
  cleanup deployment and rollback artifacts; active image was healthy.

IDEA2 edge runtime changes:

- `/home/kittipat/.local/share/aegis/detection-engine/` — CAM-02 application,
  local `.venv`, models, private enrollment, `.env`, logs and runtime state.
- `/etc/systemd/system/aegis-detection-engine.service` — enabled CAM-02 Engine.
- `/etc/systemd/system/aegis-detection-tunnel.service` — enabled CAM-02 tunnel.

## Integration requests

- Kla: review and reconcile the exact SSH/UFW and Monitor runtime deployment
  changes above into the infrastructure source of truth. Do not copy runtime
  secrets, private keys or biometric assets into infrastructure notes or Git.
- Pub/Kla: the Kla-owned consolidated outstanding note still describes the
  real recognizer and multi-camera deployment as open. Reconcile it through
  owner review using this receipt; this IDEA2 task does not edit Kla's note.
- Before Git publication, split or reconcile the existing mixed dirty worktree
  into a correctly scoped IDEA2 branch, declare every shared surface in the PR,
  run full affected tests/policy checks and obtain integration review. Ask the
  user before commit, push or PR as explicitly required.

## Known limitations

- No biometric accuracy, false-accept/false-reject, fairness, presentation-
  attack or liveness benchmark was performed. `Authorized` is application
  output, not an independent identity or anti-spoof guarantee.
- A long-duration soak and a recorded simultaneous two-physical-camera A/B
  stress matrix were not completed in this acceptance.
- Clip transfer, real NAS offload and Safari MJPEG support remain separate.
- Linux AI dependencies include a large CUDA/PyTorch stack; GPU utilization and
  CPU/GPU performance were not profiled.
- The user's Detector B login credential was entered into conversation text.
  Its value is deliberately omitted here. Rotation was recommended; the user
  chose to retain it at this time, so credential rotation remains an operational
  security follow-up.
- `.codex-tmp/` contains untracked deployment helpers/packages and is not
  currently ignored. It must not be staged or included in a future PR.
- Receipt status is partial only because source reconciliation, full verification,
  integration review and Git publication remain pending. The real CAM-02
  runtime acceptance itself is complete.
