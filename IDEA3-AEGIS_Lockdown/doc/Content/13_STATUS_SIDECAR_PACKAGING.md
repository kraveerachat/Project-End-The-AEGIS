# 13 — Status sidecar packaging (STEP 38.6)

Scope: how the status publisher, pusher and observer reach a Production Core host without weakening the governed Core release. Source and offline proof only. Nothing was installed, started or deployed.

## 1. Root cause (verified by executable tests, `tests/test_status_sidecar_release.py`)

| Question | Finding |
|---|---|
| What enters a Core release | Exactly the `aegis_soc` AST closure of four entrypoints (`supervisor`, `recovery_ui`, `production_detector`, `cli`) plus `venv/`, `requirements.txt`, manifest and sums. |
| Why `tools/` is excluded | `verify_release` and the release guard pin `TOP_LEVEL = {venv, aegis_soc, requirements.txt, manifest, sums}`; a `tools/` directory fails with `UNEXPECTED_TOP_LEVEL`. |
| Why `observer.py` / any status module is missing | Nothing in the four entrypoints imports it. Adding the file fails with `PACKAGE_IS_NOT_THE_RUNTIME_CLOSURE`. |
| What else pins the layout | The release guard (`p4-l7-release-guard.py`), the installer helper (re-runs the guard), and the F1u/R1Du/RRu engines (“file set of OLD plus EXACTLY X”). |
| Can the installed release stay unchanged | Yes, if the status components ship separately. |

## 2. Options

| | A. Extend the Core release builder | B. Separate status sidecar package (selected) |
|---|---|---|
| Files | add a fifth entrypoint plus `tools/` handling, or move the tools into `aegis_soc` | six allowlisted files: `aegis_soc/{__init__,dispatch_client,observer,status_projection}.py`, `tools/{status_projection_publisher,status_push_client}.py` |
| Release closure | `runtime` is in the Core closure already, but `tools/` is outside the layout, so the layout and `TOP_LEVEL` change | no closure expansion; explicit allowlist; stdlib only; no Core module |
| Guard compatibility | changes the trusted format: guard, installer helper, L7u and F1u/R1Du/RRu engines and their pinned tests need a coordinated change | none touched; the Core guard refuses a sidecar and the sidecar verifier refuses a Core release (tested) |
| SHA-256 / manifest | reuse the existing | separate `SIDECAR-MANIFEST.json` and `SIDECAR-SHA256SUMS`, strict: exact file set, sorted, no extra, `kind` field |
| Privileges | root-owned `/opt/aegis-idea3/releases/<id>` | same model, new root-owned `/opt/aegis-idea3-status/releases/<id>` (installer not written, owner step) |
| Unit change | none beyond paths | `ExecStart=/usr/bin/python3 -E -s -B -m tools.<module>`, `WorkingDirectory=/opt/aegis-idea3-status/current` |
| Dependencies | would add status code to every Core release | none; host `python3` only, recorded in the manifest |
| Upgrade / rollback | every status fix needs a full governed Core upgrade (which now also carries 13 other changed files incl. local CUT) | independent: new sidecar id, switch `current`, previous release stays; no Core restart |
| Recovery / Core impact | high: touches Recovery release gates | none: Core and Recovery bytes unchanged |

Option A is **not implemented**: it changes the trusted release format and needs owner approval of the guard, installer and upgrade engines. If the owner prefers it, the tested proposal is: add `status_push` as a fifth entrypoint module inside `aegis_soc`, extend `TOP_LEVEL` and the pinned tests, and publish through a new governed upgrade stage.

Rejected shortcut: running from a development checkout in Production (mutable source, no manifest).

## 3. What was built

* `deploy/status-sidecar/build-status-sidecar.py` — `build` and `verify`. Refuses a dirty tree (unless `--allow-dirty`, recorded), symlinks, system staging locations, an existing destination, a missing allowlisted file, any import outside stdlib/allowlist, and `subprocess`, `ctypes`, `pickle`, `marshal`, `importlib`, `pty`, `multiprocessing`, `sqlite3`. The build smoke-imports the package with `python -E -s -B` from its own root and fails if `runtime`, `controller`, `mqtt_client`, `local_restore`, `local_cut`, `cut_client`, `supervisor`, `database` or `paho` is loaded.
* `aegis_soc/status_projection.py` — stdlib-only mirror of `runtime.safe_status_projection`. `runtime.py` is **not changed** (importing the mirror from the Core would have grown the pinned Core closure). `tests/test_status_projection_mirror.py` pins equal output over the full vocabulary product (6240 cases plus timestamps, components, dry_run and non-documents); drift fails the build.
* `tools/status_projection_publisher.py` now imports the mirror instead of `aegis_soc.runtime` (a one-line change; behaviour identical, 46 prior tests unchanged and passing).
* Unit templates now run from the sidecar. Still templates; no `[Install]`.

## 4. Not done / owner gates

1. A root-owned installer for `/opt/aegis-idea3-status` (analogue of `p4-l7-install-release.py`) and a governed stage. Not written: it is a privileged install path and needs owner approval.
2. Python version on the Core host is not verified; the manifest records the builder's version only.
3. Readable-status-file permission, group, HUB/network/mTLS readiness remain as in doc 12.

## 5. Pre-existing finding (not caused by this work)

On `main` (`5a673848`), `tests/test_pr11_phase4_l7_release_builder.py::{test_runtime_closure_is_exact,test_closure_is_computed_from_source_not_hard_coded}` and `tests/test_pr11_phase4_l7u_release_builder_recovery_runtime.py::{test_canonical_verify_passes_and_package_is_exactly_the_entrypoint_closure,test_closure_is_the_union_of_exactly_the_four_governed_entrypoints}` fail: the pinned `CLOSURE` omits `local_cut`, which the current Core source now pulls in. A Core release built from today's `main` therefore ships local CUT code, and the pins are stale. Left untouched (governed pins); owner decision needed before the next Core release.
