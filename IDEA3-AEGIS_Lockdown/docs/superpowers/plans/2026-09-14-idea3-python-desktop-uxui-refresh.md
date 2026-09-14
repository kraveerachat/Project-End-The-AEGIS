# IDEA3 Python Desktop UX/UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the existing IDEA3 Tkinter desktop as an authenticated, dual-theme, trilingual, nine-surface enterprise SOC console while preserving every control and evidence boundary.

**Architecture:** Add pure auth/session and theme-preference modules, keep `AegisAdminGUI` as the single owner of operational state, and rebuild only Tkinter presentation widgets when authentication, language, or theme changes. Extend the existing presentation/database read layer for the required pages; all privileged actions continue through the unchanged controller and recovery paths.

**Tech Stack:** Python 3.14, Tkinter, SQLite, pytest, Ruff, existing AEGIS controller/MQTT runtime.

**Spec:** `IDEA3-AEGIS_Lockdown/docs/superpowers/specs/2026-09-14-idea3-python-desktop-uxui-refresh-design.md`

## Global Constraints

- Work only on `feat/idea3-python-uxui-refresh` from starting SHA `25e8b60b12e40f086deb99c08b977e4fb36b4959`.
- Preserve the three existing UI commits; do not rewrite working code for preference.
- Do not change protected control modules, MQTT topics/schema, HMAC, nonce/timestamp, ACK, Dead Man, GPIO, CUT, RESTORE, auto-containment, or audit semantics.
- UI login is never CUT/RESTORE authorization.
- Persist only allow-listed non-secret UI preferences.
- Missing evidence is `UNKNOWN`, `NOT CONFIGURED`, or `NO EVIDENCE`; never fabricate health.
- Use only lab + dry-run + auto-contain-off validation; never contact real MQTT or hardware.
- Add one Music-owned final receipt only after final verification.

---

### Task 1: Pure Admin authentication and in-memory session

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/tests/test_desktop_auth.py`
- Create: `IDEA3-AEGIS_Lockdown/aegis_soc/auth.py`

**Interfaces:**
- Produces: `configured_admin_id(env) -> str`
- Produces: `verify_admin_credentials(admin_id, pin, *, env, pin_verifier) -> bool`
- Produces: `DesktopSession.login(admin_id)`, `logout()`, `authenticated`, `admin_id`, `authenticated_at`

- [ ] Write tests proving exact Admin-ID matching, generic rejection, PIN delegation, logout clearing, and absence of any PIN/password field or serialized value.
- [ ] Run `pytest tests/test_desktop_auth.py -q` and observe import failure.
- [ ] Implement only the pure helper and in-memory session.
- [ ] Rerun the focused test and commit the green checkpoint.

### Task 2: Theme preference and theme-aware branding

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/tests/test_theme_state.py`
- Create: `IDEA3-AEGIS_Lockdown/aegis_soc/theme_state.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_branding.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/branding.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/theme.py`

**Interfaces:**
- Produces: `get_theme()`, `set_theme(name)`, `preference_path()`, `available_themes()`
- Changes: `resolve_logo_path(theme=...)` selects the correct official mark.
- Produces: `theme.get_palette(name=None)` and palette-driven widgets.

- [ ] Add tests for dark/light validation, corrupt-file fallback, environment override, exact JSON allowlist, and both logo variants.
- [ ] Run the new tests and observe the expected missing-module/signature failures.
- [ ] Implement atomic best-effort theme persistence containing only `{ "theme": ... }`.
- [ ] Add immutable dark/light palettes and rebuild reusable widgets from the active palette.
- [ ] Rerun theme/branding/presentation tests and commit the green checkpoint.

### Task 3: Login, logout, and presentation-only rebuilds

**Files:**
- Create: `IDEA3-AEGIS_Lockdown/tests/test_login_view.py`
- Create: `IDEA3-AEGIS_Lockdown/aegis_soc/login_view.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/gui.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/i18n.py`

**Interfaces:**
- `LoginView(parent, on_authenticated, on_language, on_theme)` owns form widgets only.
- `AegisAdminGUI` owns one `DesktopSession`, shows Login first, and retains runtime fields across shell rebuilds/logout.

- [ ] Add headless source/pure tests for masked PIN configuration, generic failure, cleared PIN, and shell/session transitions.
- [ ] Observe the failing tests before creating `login_view.py`.
- [ ] Implement localized Canvas circuit treatment, official logo, Admin ID, masked PIN, theme/language controls, and generic failure.
- [ ] Add Logout to the authenticated header and guard monitor refreshes when Login is visible.
- [ ] Prove the session stores no credential input and that login never calls controller methods.
- [ ] Rerun focused auth/login/session/i18n tests and commit the green checkpoint.

### Task 4: Read-only incident and audit projections

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_core.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/database.py`
- Modify: `IDEA3-AEGIS_Lockdown/tests/test_presentation.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/presentation.py`

**Interfaces:**
- Produces: bounded `fetch_incidents()` and `fetch_logs(limit=None)` read helpers.
- Produces: pure page rows and safe diagnostic state mappings.

- [ ] Add failing tests for incident ordering/details, bounded logs, empty results, UNKNOWN device evidence, and configured/not-configured diagnostics.
- [ ] Implement read-only queries and pure mappings without changing writes or schema.
- [ ] Rerun focused database/presentation tests and commit the green checkpoint.

### Task 5: Nine working desktop surfaces

**Files:**
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/gui.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/i18n.py`
- Modify: `IDEA3-AEGIS_Lockdown/aegis_soc/wizard.py`

**Interfaces:**
- Produces page builders for Overview, Incidents, Devices, Lockdown, Recovery, Audit Log, Diagnostics, and Settings; Login remains the unauthenticated surface.

- [ ] Add navigation/page coverage assertions before enabling placeholder routes.
- [ ] Move destructive controls from Overview to the dedicated Lockdown page while reusing the exact callbacks.
- [ ] Build Incidents and Audit from real SQLite rows only.
- [ ] Build Devices and Diagnostics from held evidence/configuration-presence only.
- [ ] Build Recovery around the existing wizard; do not inline or bypass RESTORE authorization.
- [ ] Build Settings with theme, language, branding, and session information only.
- [ ] Ensure every new string key has English/Thai/Chinese entries and rerun i18n coverage.
- [ ] Commit the green multi-page checkpoint.

### Task 6: Responsive polish and safe visual QA

**Files:**
- Modify only the Task 2/3/5 presentation files when an observed defect requires it.

- [ ] Run compile/import smoke without a display.
- [ ] If available, run under Xvfb with lab/dry-run/auto-contain-off and inspect Login plus every page in both themes at 1920x1080 and 1366x768.
- [ ] Verify keyboard reachability, readable contrast, vertical workspace scrolling, and no primary-shell horizontal scrolling.
- [ ] Correct only observed presentation defects, with a regression where practical.

### Task 7: Final verification and task closeout

**Files:**
- Modify: `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`
- Modify: `IDEA3-AEGIS_Lockdown/doc/Content/04_SESSION_HANDOFF.md`
- Create: one `Obsidian_AEGIS_Vault/AEGIS_Knowledge/90-Status/logs/YYYY-MM-DD_HHMMSS_music_idea3-python-desktop-uxui-refresh.md`

- [ ] Run focused auth/session/theme/i18n/branding/presentation tests.
- [ ] Run the full Python suite and, if sandbox loopback remains blocked, rerun the four socket tests with approved test-only permissions.
- [ ] Run Ruff on every touched Python path, compileall with cache under `/tmp`, and `git diff --check`.
- [ ] Run the repository vault/collaboration-policy checks and scan changed paths for secrets/generated artifacts.
- [ ] Update canonical status/handoff with exact evidence and limitations; create exactly one final Music receipt.
- [ ] Stage exact paths, verify the staged diff, create coherent commits, push only this branch, and prepare/update its Pull Request.
- [ ] Stop without merging, deploying, contacting MQTT/hardware, or performing CUT/RESTORE.
