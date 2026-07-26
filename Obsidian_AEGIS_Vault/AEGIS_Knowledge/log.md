---
title: LLM Wiki Audit & Operation Log
tags: [aegis, wiki, log, audit, append-only]
type: wiki-admin
created: 2026-07-20
updated: 2026-07-24
---

# 📜 LLM Wiki Audit & Operation Log

> Append-only chronological log of all ingestion, query synthesis, and lint passes performed by the LLM Agent.

## [2026-07-25] vibe-coding | Full Vault Audit & Synchronization (`/obsidian` Slash Command)
- **Prompt Summary**: Executed explicit `/obsidian` vault audit & sync. Verified and updated all core documentation notes (`00`, `01`, `02`, `03`, `index.md`, `log.md`) in-place to ensure absolute alignment with current source code implementation, including Cross-App Theme Sync (`aegis_theme`), Tailwind CSS v4 `@variant dark` rules, Volumetric Aura Glow, and Framer Motion unfold physics.
- **Modified Source Code Paths**:
  - N/A (Obsidian Knowledge Base Vault Audit)
- **Updated Obsidian Notes**:
  - `00 - 🗺️ AEGIS System Overview.md`
  - `01 - 🚪 HUB-AEGIS Entry.md`
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `index.md`
  - `log.md`
- **Verification**: All 13 notes in `C:\Users\User\AEGIS_System\Obsidian_AEGIS_Vault\AEGIS_Knowledge` audited and confirmed crisp, synchronized, and non-redundant.

## [2026-07-25] vibe-coding | Cross-App Theme Persistence & Synchronization Pass (Hub, Drive & Monitor)
- **Prompt Summary**: Connected and synchronized theme state (Dark / Light mode) across all 3 pages/apps (Welcome -> Hub -> Drive Login & Monitor Login). Configured shared `localStorage` key (`aegis_theme`), synchronized `document.documentElement` `.dark` and `.light` DOM class toggling, and added cross-tab `window.storage` event listeners so theme selection seamlessly persists and transitions across the entire system.
- **Modified Source Code Paths**:
  - `HUB-AEGIS_Entry/src/App.jsx` (Configured `aegis_theme` persistence, DOM class toggling, storage listener)
  - `IDEA1-AEGIS_Drive_LC/src/App.jsx` (Configured `aegis_theme` persistence, DOM class toggling, storage listener)
  - `IDEA2-AEGIS_Monitor/src/App.jsx` (Configured `aegis_theme` persistence, DOM class toggling, storage listener)
- **Updated Obsidian Notes**:
  - `00 - 🗺️ AEGIS System Overview.md`
  - `01 - 🚪 HUB-AEGIS Entry.md`
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `log.md`
- **Verification**: `npm run build` executed with 0 errors across all 3 projects. Rebuilt Docker containers via `docker compose up --build -d` and verified healthy containers (`docker ps`).

## [2026-07-25] vibe-coding | Full Obsidian Knowledge Base In-Place Synchronization
- **Prompt Summary**: Synchronized all technical architectural updates, UI design systems, Volumetric Aura Glow layers, logo enlargement, Framer Motion unfold physics, and Tailwind CSS v4 `@variant dark` rules in-place across the Obsidian Knowledge Base vault per `AGENTS.md`.
- **Modified Source Code Paths**:
  - N/A (Obsidian Knowledge Base Vault Sync)
- **Updated Obsidian Notes**:
  - `00 - 🗺️ AEGIS System Overview.md` (Updated Cyber-Physical Precision architecture intro & specs)
  - `02 - 💾 IDEA1 AEGIS Drive LC.md` (Updated Code Status with Dual Theme & Motion Physics details)
  - `03 - 📹 IDEA2 AEGIS Monitor.md` (Updated Implemented Feature #1 with Volumetric Aura & Framer Motion specs)
  - `log.md` (Recorded auto-sync entry)
- **Verification**: All Obsidian notes updated in-place without introducing duplicate files or stale claims.

## [2026-07-25] vibe-coding | Volumetric Aura Glow & Diffused Lighting Overhaul (Drive & Monitor)
- **Prompt Summary**: Implemented high-intensity Volumetric Aura Glow layer (`absolute -inset-2 rounded-[32px] blur-2xl`) directly behind the central Vault Card with pulsing animations (`opacity: [0.6, 0.9, 0.6]`, `scale: [0.99, 1.025, 0.99]`): Electric Cyan & Sky-Blue gradient with cyan spread shadow (`shadow-[0_0_70px_15px_rgba(6,182,212,0.35)]`) in Light Mode, and Neon Purple & Fuchsia Plasma gradient with purple spread shadow (`dark:shadow-[0_0_80px_20px_rgba(168,85,247,0.4)]`) in Dark Mode. Boosted input focus glows (`focus:shadow-[0_0_25px]`).
- **Modified Source Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx` (Added Volumetric Aura Glow element, boosted input focus ring shadows)
  - `IDEA2-AEGIS_Monitor/src/screens/Login.jsx` (Added Volumetric Aura Glow element, boosted input focus ring shadows)
- **Updated Obsidian Notes**:
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `log.md`
- **Verification**: `npm run build` executed with 0 errors in both apps. Rebuilt Docker containers via `docker compose up --build -d` and confirmed all 4 containers healthy (`docker ps`).

## [2026-07-25] vibe-coding | AEGIS Logo Emblem Enlargement Pass (Drive & Monitor)
- **Prompt Summary**: Increased AEGIS Mark logo emblem size from 140px to 180px across both Light and Dark modes to create a more prominent, commanding brand presence on the left Vault Card panel.
- **Modified Source Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx` (Updated `AegisMark` size prop from 140 to 180)
  - `IDEA2-AEGIS_Monitor/src/screens/Login.jsx` (Updated `AegisMark` size prop from 140 to 180)
- **Updated Obsidian Notes**:
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `log.md`
- **Verification**: `npm run build` executed with 0 errors in both apps. Rebuilt Docker containers via `docker compose up --build -d` and confirmed all 4 containers healthy (`docker ps`).

## [2026-07-25] vibe-coding | Illuminated Theme Borders & Dual-Mode Glow Pass (Drive & Monitor)
- **Prompt Summary**: Implemented theme-specific illuminated borders and ambient drop-shadow glowing auras: Electric Cyan (`border-cyan-500/40`, `shadow-[0_10px_35px_-5px_rgba(14,165,233,0.25)]`, cyan focus ring) for Light Mode and Neon Purple (`dark:border-purple-500/40`, `dark:shadow-[0_0_40px_-5px_rgba(168,85,247,0.3)]`, purple focus ring) for Dark Mode.
- **Modified Source Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx` (Updated card, input, and layer row borders)
  - `IDEA2-AEGIS_Monitor/src/screens/Login.jsx` (Updated card, input, and layer row borders)
- **Updated Obsidian Notes**:
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `log.md`
- **Verification**: `npm run build` executed with 0 errors in both apps. Rebuilt Docker containers via `docker compose up --build -d` and confirmed all 4 containers healthy (`docker ps`).

## [2026-07-25] vibe-coding | Framer Motion Unfold Entrance & Tactile Physics Pass (Drive & Monitor)
- **Prompt Summary**: Implemented high-end Framer Motion physics for Login screen: Vault Unfold entrance (`scale: 0.96 -> 1`, spring `stiffness: 260, damping: 20`), staggered Security Layer cascade (`staggerChildren: 0.08s`), logo breathing backlight aura, animated horizontal energy beam translation, hover 3D tilt, and active pressing physics (`active:scale-[0.995]`).
- **Modified Source Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx` (Added Framer Motion card entrance, breathing logo glow, staggered layers)
  - `IDEA2-AEGIS_Monitor/src/screens/Login.jsx` (Added Framer Motion card entrance, breathing logo glow, staggered layers)
  - `IDEA1-AEGIS_Drive_LC/package.json` (Added `framer-motion` dependency)
- **Updated Obsidian Notes**:
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `log.md`
- **Verification**: `npm run build` executed with 0 errors in both apps. Rebuilt Docker containers via `docker compose up --build -d` and confirmed all 4 containers healthy (`docker ps`).

## [2026-07-25] vibe-coding | Tailwind CSS v4 `@variant dark` Configuration & Light Mode Fix (Drive & Monitor)
- **Root Cause & Fix**: Identified why elements remained black in Light Mode: Tailwind CSS v4 requires `@variant dark (&:where(.dark, .dark *));` to bind `dark:` utility classes to the `.dark` DOM class instead of OS `prefers-color-scheme`. Added rule to `index.css` across all projects.
- **Modified Source Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/src/index.css` (Added `@variant dark (&:where(.dark, .dark *));`)
  - `IDEA2-AEGIS_Monitor/src/index.css` (Added `@variant dark (&:where(.dark, .dark *));`)
  - `HUB-AEGIS_Entry/src/index.css` (Added `@variant dark (&:where(.dark, .dark *));`)
  - `IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx` & `IDEA2-AEGIS_Monitor/src/screens/Login.jsx` (Clean dual-theme styling)
- **Updated Obsidian Notes**:
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `log.md`
- **Verification**: `npm run build` executed with 0 errors. Rebuilt Docker containers via `docker compose up --build -d` and confirmed all 4 containers healthy (`docker ps`).

## [2026-07-25] vibe-coding | Complete Light Mode Card & Sub-component Adaptation (Drive & Monitor)
- **Prompt Summary**: Resolved CSS bug where card elements retained dark classes in light mode. Fully updated central vault card (`bg-white/95 border-slate-200/80 shadow-2xl`), left brand panel (`bg-slate-100/80 border-slate-200/80 text-slate-900`), input fields (`bg-slate-50 border-slate-200 text-slate-900 focus:bg-white`), submit button, and security layer rows (`bg-slate-50/80 border-slate-200/80`) to adapt seamlessly when Light Mode is active.
- **Modified Source Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx`
  - `IDEA2-AEGIS_Monitor/src/screens/Login.jsx`
- **Updated Obsidian Notes**:
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `log.md`
- **Verification**: `npm run build` passed cleanly (0 errors) in both apps. Rebuilt Docker containers via `docker compose up --build -d` and confirmed all 4 containers healthy (`docker ps`).

## [2026-07-25] vibe-coding | Dual Theme Dark & Light Mode Overhaul (Drive & Monitor Login)
- **Prompt Summary**: Surgical visual refactoring for both Dark Mode (vibrant ambient energy rays, `bg-slate-950/70` input fields with glowing blue focus rings, high-contrast gradient subtitles) and Light Mode (clean soft cool gray backdrop `bg-slate-100`, crisp white floating vault card `bg-white/95`, slate branding elements, and dual-theme Security Layer rows).
- **Modified Source Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx`
  - `IDEA2-AEGIS_Monitor/src/screens/Login.jsx`
- **Updated Obsidian Notes**:
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `log.md`
- **Verification**: `npm run build` executed with 0 errors in both apps. Rebuilt Docker containers via `docker compose up --build -d` and confirmed all 4 containers healthy (`docker ps`).

## [2026-07-25] vibe-coding | Cyber Background Stack & Clean Security Layers Login Redesign (Drive & Monitor)
- **Prompt Summary**: Implement the exact Cyber-Physical background stack (base `#08080A`, dot-matrix grid pattern, glowing horizontal purple energy line, ambient radial light beam), active input illuminated blue ring focus, and clean transparent Security Layer rows matching Image 2 reference.
- **Modified Source Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx` (Refactored background stack, focus ring glow, and clean transparent Layer 0–3 rows)
  - `IDEA2-AEGIS_Monitor/src/screens/Login.jsx` (Refactored background stack, focus ring glow, and clean transparent Layer 0–3 rows)
  - `IDEA2-AEGIS_Monitor/package.json` & `vite.config.js` & `index.css` (Configured Tailwind CSS v4 support)
- **Updated Obsidian Notes**:
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `log.md`
- **Verification**: `npm run build` passed in both projects with 0 errors. Docker stack rebuilt via `docker compose up --build -d` and verified healthy (`docker ps`).

## [2026-07-25] vibe-coding | Unified Split Vault Card Login Page Redesign (Drive & Monitor)
- **Prompt Summary**: Unify the Login screens for both AEGIS Drive (`http://localhost/drive/`) and AEGIS Monitor (`http://localhost/monitor/`) to match the signature 50/50 Split Vault Card design (Image 1 reference).
- **Modified Source Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/src/screens/Login.jsx` (Redesigned with Split Vault Card, levitating emblem, i18n chrome, and 4-layer security status readout)
  - `IDEA1-AEGIS_Drive_LC/src/components/ui.jsx` (Added `SparkleButton` and `ThemeToggle` exports)
  - `IDEA1-AEGIS_Drive_LC/src/index.css` (Appended `.gate-bg`, `.vault-surface`, `.sparkle-btn`, `.hatch-fine`, and `.shake-x` styles)
  - `IDEA2-AEGIS_Monitor/src/screens/Login.jsx` (Upgraded simple card to identical Split Vault Card layout with TH/EN/ZH i18n & 4-layer readout)
  - `IDEA2-AEGIS_Monitor/src/components/ui.jsx` (Added `SparkleButton`, `ThemeToggle`, `Segmented`, `PillInput`, `Field`, `Toggle`)
  - `IDEA2-AEGIS_Monitor/src/lib/hooks.js` (Added `useReducedMotion` hook)
  - `IDEA2-AEGIS_Monitor/src/index.css` (Appended `.gate-bg`, `.vault-surface`, `.sparkle-btn`, `.hatch-fine`, and `.shake-x` styles)
  - `IDEA2-AEGIS_Monitor/src/App.jsx` (Passed theme/lang state handlers to Login component)
  - `IDEA2-AEGIS_Monitor/public/assets/` (Copied background images `BG_AEGIS01.png`, `BG_AEGIS02.png` and logo assets)
- **Updated Obsidian Notes**:
  - `02 - 💾 IDEA1 AEGIS Drive LC.md`
  - `03 - 📹 IDEA2 AEGIS Monitor.md`
  - `log.md`
- **Verification**: `npm run build` executed successfully with zero errors. Rebuilt and deployed Docker containers using `docker compose up --build -d`. All 4 containers (`aegis_system-postgres-1`, `aegis_system-drive-1`, `aegis_system-monitor-1`, `aegis_system-gateway-1`) are healthy (`docker ps`). Verified end-to-end HTTP 200 responses and login authentication via NGINX gateway at `http://localhost/drive/` and `http://localhost/monitor/`.

---

## [2026-07-20] ingest | AEGIS_Project_Knowledge_v7.md & AEGIS_System_Design.docx
- **Raw Sources**:
  1. `AEGIS_Project_Knowledge.md` (v7 Knowledge Base)
  2. `AEGIS_System_Design.docx` (Official Design Report Document)
- **Actions Taken**:
  - Ingested official report `AEGIS_System_Design.docx` and integrated chapters 1-5 into the LLM Wiki catalog.
  - Added new concept pages: `concepts/ZTNA_Twingate_vs_OpenVPN.md` (Zero Trust Mobile vs Admin OpenVPN) and `concepts/Mnemonic_Recovery_and_Zero_Knowledge.md` (Client-side AES-256 & BIP-39 12-word recovery).
  - Updated hardware entity pages (`MikroTik_hEX_lite`, `TP-Link_TL-SG105E`, `Beelink_Mini_S_NAS`, `ESP32_Relay_Module`).
  - Synthesized team roles, target audience (SMEs/Clinics/PDPA compliance), and OWASP security architecture into Obsidian `[[Wikilinks]]` format.
- **Status**: Completed successfully. 20 interlinked pages active in `AEGIS_Knowledge`.

---

## [2026-07-21] vibe-coding-audit | Codebase Synchronization Verification
- **User Prompt Goal**: Check and verify whether recent code modifications and features in the repository are fully updated inside `Obsidian_AEGIS_Vault\AEGIS_Knowledge`.
- **Modified Code Paths Inspected**:
  - `HUB-AEGIS_Entry/` (`src/App.jsx`, `src/screens/`, `src/components/LuminousModuleCard.jsx`, `server/index.js`, `public/config.json`)
  - `IDEA1-AEGIS_Drive_LC/` (`server/index.js`, `src/lib/vaultCrypto.js`, `src/lib/api.js`, `src/screens/Vault.jsx`, `src/screens/Audit.jsx`)
  - `IDEA2-AEGIS_Monitor/` (`server/index.js`, `src/App.jsx`, `IDEA2-AEGIS_CCTV-Operator/detection-engine/`)
  - `IDEA3-AEGIS_Lockdown/` (`firmware/`, simulation scripts)
- **In-Place Obsidian Updates Performed**:
  - Updated `00 - 🗺️ AEGIS System Overview.md` with current codebase topology and port status.
  - Updated `01 - 🚪 HUB-AEGIS Entry.md` to reflect Routing-Only Entry, `config.json` runtime targets, and `LuminousModuleCard.jsx`.
  - Updated `02 - 💾 IDEA1 AEGIS Drive LC.md` to reflect `vaultCrypto.js` (Client AES-256), `api.js`, and `aegis_drive` Express backend.
  - Updated `03 - 📹 IDEA2 AEGIS Monitor.md` to reflect `aegis_monitor` Express backend, unified dual-view App, and server JOIN on `camera_assignment`.
- **Status**: Verification & in-place update completed. All notes are 100% synchronized with current code.

---

## [2026-07-21] vibe-coding | Revert and Restore Split Vault Login Layout (Picture 2) & Cyber-Physical Blue/Purple Aesthetic
- **User Prompt Goal**: Revert HUB-AEGIS_Entry login screen back to Picture 2 design (split vault card layout with Welcome levitating mark on left, Login form on right, dark theme, and cyber-physical blue/purple gradient accents/glows).
- **Modified Source Code Paths**:
  - `HUB-AEGIS_Entry/src/App.jsx` (restored session state, split vault card morph, dark theme, and demo user hint)
  - `HUB-AEGIS_Entry/src/screens/Login.jsx` (restored Login screen with SparkleButton, Layer 0-3 cascade status, and auth call)
  - `HUB-AEGIS_Entry/src/lib/auth.js` (restored login/authenticate with API + in-memory dev fallback)
  - `HUB-AEGIS_Entry/server/` (restored server routes, session middleware, rate limiter, and DB seed)
- **Obsidian Notes Updated**:
  - `01 - 🚪 HUB-AEGIS Entry.md` updated to reflect the restored split vault card login system and authentication architecture.

---

## [2026-07-21] vibe-coding | Day-0 Bootstrap, Admin Provisioning & Force Password Reset (IDEA1) + SSH-only Operator CLI (IDEA2)
- **User Prompt Goal**: Generate 3 secure backend/database components for AEGIS's closed-registration provisioning model — (1) Day-0 DB seeding for IDEA1's initial Admin via Docker Compose env vars without leaking secrets into git, (2) an IDEA1 Admin API to provision `DataLake-User` accounts with a temp password + Force Password Reset flow, (3) an IDEA2 Python CLI (argparse, SSH-only) to add `CCTV-Operator` accounts and assign cameras — all bcrypt/Argon2-grade, no plaintext passwords anywhere.
- **Modified Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/server/db/schema.sql` (+`must_reset_password` column)
  - `IDEA1-AEGIS_Drive_LC/server/db/connection.js` (+`getUserById`, `createUserWithTempPassword`, `updatePasswordHash`, `generateTempPassword`)
  - `IDEA1-AEGIS_Drive_LC/server/db/bootstrapAdmin.js` (new — Day-0 admin from a pre-computed bcrypt hash env var, refuses to boot on a malformed hash)
  - `IDEA1-AEGIS_Drive_LC/server/auth/login.js`, `server/auth/session.js`, `server/middleware/requireRole.js` (mustResetPassword propagated session→gate; new `RESET_EXEMPT_PATHS`)
  - `IDEA1-AEGIS_Drive_LC/server/routes/api.js` (`POST /api/users` now writes real Postgres accounts; new `POST /api/password/reset`)
  - `IDEA1-AEGIS_Drive_LC/server/index.js` (calls `bootstrapAdminIfNeeded()` before listening; exits on failure)
  - `IDEA1-AEGIS_Drive_LC/src/screens/Access.jsx`, `src/lib/strings.js` (one-time temp-password reveal panel; Admin creation removed from the quick-add UI to match the server's role restriction)
  - `IDEA1-AEGIS_Drive_LC/scripts/hash_password.py`, `scripts/requirements.txt` (new — local bcrypt hash generator, getpass-only)
  - `IDEA1-AEGIS_Drive_LC/.env.example` (new)
  - `IDEA2-AEGIS_Monitor/server/db/schema.sql` (+`must_reset_password` column, mirrors IDEA1)
  - `IDEA2-AEGIS_Monitor/server/db/connection.js`, `server/auth/login.js`, `server/auth/session.js`, `server/middleware/requireRole.js`, `server/routes/api.js` (same force-reset gate + `POST /api/password/reset` as IDEA1)
  - `IDEA2-AEGIS_Monitor/server/cli/manage_users.py`, `server/cli/requirements.txt`, `server/cli/README.md` (new — SSH-only provisioning CLI: `add-operator`, `list-cameras`, `list-operators`)
  - `IDEA2-AEGIS_Monitor/.env.example` (new)
  - `docker-compose.yml` (root — `ADMIN_BOOTSTRAP_USERNAME`/`ADMIN_BOOTSTRAP_PASSWORD_HASH` passthrough for the `drive` service)
  - `.env.example` (root, new)
- **Obsidian Updates**: [[00 - 🗺️ AEGIS System Overview]], [[02 - 💾 IDEA1 AEGIS Drive LC]], [[03 - 📹 IDEA2 AEGIS Monitor]], [[05 - 🛡️ Security Architecture]]
- **Key Changes**:
  - No plaintext password ever crosses a process boundary: Day-0 bootstrap accepts only a pre-computed bcrypt hash (validated by regex before boot); Admin/CLI-issued temp passwords are generated server/CLI-side and returned exactly once.
  - Every server-provisioned account (Day-0 admin, IDEA1 `DataLake-User`, IDEA2 `CCTV-Operator`) is created with `must_reset_password = TRUE`; a new gate in both apps' `requireRole.js` blocks all endpoints except `/me`, `/logout`, `/password/reset` until reset, closing a real gap IDEA2's own code had flagged in a comment (`pgAddOperator` issuing unusable random passwords with no reset path).
  - `POST /api/users` (IDEA1) can only create `DataLake-User`, never `Admin`, to limit blast radius from a hijacked Admin session.
  - IDEA2's CLI is SSH-only by design (no new web-exposed write route); transactional (bad camera id / duplicate username rolls back cleanly); confirms before reassigning a camera already held by another operator.
- **Status**: All modified/new JS files passed `node --check`; both Python scripts passed `py_compile`; IDEA1 frontend build (`vite build`) succeeded with the Access.jsx changes included.

---

## [2026-07-21] vibe-coding | Initialized and Pushed Git Repository to GitHub
- **User Prompt Goal**: Commit and push all project files to GitHub remote (`https://github.com/kraveerachat/Project-End-The-AEGIS.git`).
- **Modified Source Code Paths**:
  - `.gitignore` (updated to exclude `__pycache__/`, `*.pyc`, `.pytest_cache/`)
- **Git Actions**:
  - Added remote `origin`: `https://github.com/kraveerachat/Project-End-The-AEGIS.git`
  - Staged and committed all files to `main` branch.
  - Pushed to `origin/main`.
- **Obsidian Updates**: `log.md` updated.

---

## [2026-07-21] vibe-coding | Deterministic Local Test Fixture Seeding (6-account matrix, IDEA1 + IDEA2)
- **User Prompt Goal**: Seed a local test environment with 6 specific, pre-determined accounts (fixed usernames/passwords, not random temp passwords) to exercise UI and RBAC flows: 1 Admin + 2 DataLake-User on IDEA1, 1 SOC-Responder + 2 CCTV-Operator (with camera assignments) on IDEA2 — hashes only, no plaintext in SQL/app code.
- **Modified/New Code Paths**:
  - `IDEA1-AEGIS_Drive_LC/server/db/seedTestFixtures.js` (new — reads 3 bcrypt hashes from env, upserts fixed test accounts with `must_reset_password = FALSE` so they're immediately usable; refuses to run when `NODE_ENV=production` or without a real `DATABASE_URL`)
  - `IDEA1-AEGIS_Drive_LC/.env.test.example` (new)
  - `.gitignore` (root — added `!.env.test.example` exception; the existing `!.env.example` pattern didn't cover this new filename)
  - `IDEA2-AEGIS_Monitor/server/cli/manage_users.py` — `add-operator` extended with `--role` (CCTV-Operator/SOC-Responder, was hardcoded), `--password-stdin` (scripted password input, no getpass prompt), `--skip-force-reset` (immediately-usable password for test fixtures); all three off/default-safe unless explicitly passed
  - `IDEA2-AEGIS_Monitor/server/cli/README.md` (documents the new flags and the scripted test-fixture usage pattern)
- **Obsidian Updates**: [[02 - 💾 IDEA1 AEGIS Drive LC]], [[03 - 📹 IDEA2 AEGIS Monitor]]
- **Key Changes**:
  - This is a *separate, parallel* path from the production Day-0/force-reset flow built in the previous session — `seedTestFixtures.js` is not called from `index.js` at boot (must be run manually) and explicitly sets `must_reset_password = FALSE`, the opposite default of `bootstrapAdmin.js`/`POST /api/users`, because the stated goal here is immediate login with known credentials, not real provisioning.
  - The one-off Python hash generator for the 6 known test passwords was deliberately written to the session scratchpad, not the repo — hardcoding even test passwords into a tracked file was avoided per the user's own "no plaintext in code" requirement.
  - IDEA2's CLI can now create `SOC-Responder` accounts (previously `add-operator` only supported `CCTV-Operator`), needed for the `soc_admin` fixture.
- **Status**: New/modified files passed `node --check` / `py_compile`; `.gitignore` fix verified with `git check-ignore`.


---

## [2026-07-22] vibe-coding | Ethics (HREC-SUT) forms for IDEA 2 + Syllabus alignment; TASK 3 discrepancy flagged
- **User Prompt Goal**: (1) จัดวัตถุประสงค์/ประโยชน์ของเอกสาร AEGIS ให้ตรง keyword มคอ.3, (2) ร่างเอกสารจริยธรรมการวิจัยในมนุษย์ (PIS + Consent) สำหรับ IDEA 2 (Facial Recognition), (3) แก้ bug 2 จุดในเล่ม (ประโยค Terminal Account ซ้ำท้าย 2.3.4 และถ้อยคำ BOM หัวข้อ 5.6)
- **Modified/New Paths**:
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/ethics/Participant_Information_Sheet_IDEA2.md` (new)
  - `Obsidian_AEGIS_Vault/AEGIS_Knowledge/ethics/Informed_Consent_Form_IDEA2.md` (new)
- **Obsidian Updates**: [[ethics/Participant_Information_Sheet_IDEA2]], [[ethics/Informed_Consent_Form_IDEA2]], `index.md`, `log.md`
- **Key Changes**:
  - ร่างฟอร์ม EC 2 ฉบับตามโครงสร้างมาตรฐาน HREC-SUT เน้น 3 ข้อจำกัดความเป็นส่วนตัว: 100% Local Edge Processing (ไม่ขึ้นคลาวด์), เก็บเฉพาะ Name + RBAC Role (ไม่เก็บเลขบัตร/รหัสพนักงาน), และ Data Retention Policy ตาม PDPA.
  - TASK 1 (วัตถุประสงค์/ประโยชน์) ส่งเป็นข้อความให้ผู้ใช้วางลงเล่มเอง — ยังไม่ได้แก้ลงไฟล์ .docx ต้นฉบับ (แก้ .docx โดยตรงไม่ได้จากเครื่องมือปัจจุบัน).
  - **⚠️ TASK 3 — ตรวจแล้วไม่พบของจริง**: `AEGIS_System_Design.docx` (แก้ 19 ก.ค.) และสำเนา extract ไม่มี Section 5.6 / BOM / คำว่า "วางแผนจะใช้" (หัวข้อ 5 จบที่ 5.5 → 6 → 7) และท้าย Section 2.3.4 ไม่มีประโยค "Terminal Account" ซ้ำ (คำว่า Terminal ปรากฏตามบริบทปกติ). พบ duplicate จริงคนละจุด: หัวเรื่อง "2.1 แผนผังการเชื่อมต่อ (Logical Topology)" ปรากฏซ้ำ 2 ครั้ง. รอผู้ใช้ยืนยัน/ส่งไฟล์ v7 ฉบับที่แก้ล่าสุด.
  - ไม่พบไฟล์ Syllabus (มคอ.3) และ SUT Ethics templates ในเครื่อง — ใช้ keyword ที่ผู้ใช้ระบุ + โครงสร้างมาตรฐานแทน.
- **Status**: ไฟล์ ethics 2 ฉบับสร้างสำเร็จ; TASK 3 blocked รอ input.

---

## [2026-07-22] vibe-coding | Phase 1: Storage Layer ของจริง + operator คนที่สอง + แยก session secret + ล้างค่าจริงออกจาก .env.example
- **User Prompt Goal**: ตามคำสั่ง Phase 1 หลัง Discovery Report — (E) เพิ่มบัญชี CCTV-Operator คนที่สองผูกกับกล้องที่ยังว่าง เพื่อพิสูจน์ per-operator isolation, (F) **สร้าง Storage Layer ของ Data Lake ให้มีอยู่จริง** (งานหลักของเฟสนี้), + งานบังคับอีกสองข้อ: ย้ายค่าจริงออกจาก `.env.example` และแยก `SESSION_SECRET` เป็นคนละดอกต่อแอป — โดย **ห้ามแตะ** ประเด็น A/B (HUB) ที่ผู้ใช้สั่ง HOLD และคง shape ของ `camera_assignment` (C) กับ `cameras.id` แบบ TEXT (D) ไว้เหมือนเดิม
- **Modified/New Paths**:
  - `IDEA1-AEGIS_Drive_LC/server/storage/fileStore.js` (**ใหม่** — Storage Layer)
  - `IDEA1-AEGIS_Drive_LC/server/routes/api.js` (upload เป็น multipart, `GET /api/files/:id/download` ใหม่, DELETE ลบ byte ตามด้วย)
  - `IDEA1-AEGIS_Drive_LC/server/db/store.js` (`recordUpload` รับ `storageKey` แทนการประกอบ path สมมุติ)
  - `IDEA1-AEGIS_Drive_LC/server/index.js` (`initStorage()` ก่อนเปิดพอร์ต)
  - `IDEA1-AEGIS_Drive_LC/Dockerfile` (`mkdir /datalake && chown node:node` ก่อน `USER node`)
  - `IDEA1-AEGIS_Drive_LC/package.json` (+ `multer@^2.0.0`)
  - `IDEA1-AEGIS_Drive_LC/src/lib/api.js` (รองรับ `FormData` + `timeoutMs` + export `apiUrl`)
  - `IDEA1-AEGIS_Drive_LC/src/screens/Uploads.jsx` (ส่งไฟล์จริง ไม่ใช่ metadata), `src/screens/Files.jsx` (ปุ่ม download ต่อสายแล้ว)
  - `IDEA2-AEGIS_Monitor/server/db/seed.sql` (+ `operator2` → CAM-06), `server/db/connection.js` + `server/db/store.js` (dev fallback ให้ตรงกับ seed)
  - `docker-compose.yml` (volume `drive_storage`, `STORAGE_ROOT`, แยก `DRIVE_SESSION_SECRET`/`MONITOR_SESSION_SECRET`)
  - `.env.example` (เหลือแต่ placeholder), `.env` (**ใหม่ — git-ignored**, ค่าจริงย้ายมาที่นี่)
  - `docs/auth-test.md` (**ใหม่** — คำสั่ง curl พิสูจน์ครบ 10 ข้อ)
- **Obsidian Updates**: [[00 - 🗺️ AEGIS System Overview]], [[02 - 💾 IDEA1 AEGIS Drive LC]], [[03 - 📹 IDEA2 AEGIS Monitor]]
- **Key Changes**:
  - **Storage Layer มีอยู่จริงแล้ว**: เดิม `POST /api/files/upload` รับแค่ `{name,size,sha256}` แล้วเขียนแถว `files` ที่ชี้ไป path สมมุติ — ไม่มี byte ไหนลงดิสก์เลย ตอนนี้ multer เขียน stream ลง named volume `drive_storage` (mount `/datalake` ที่คอนเทนเนอร์ drive เท่านั้น) แล้วเซิร์ฟเวอร์อ่านขนาด+sha256 จากไฟล์จริงก่อน INSERT metadata
  - ชื่อไฟล์บนดิสก์เป็น **UUID ทึบ** ไม่มีเศษของชื่อผู้ใช้เลยแม้แต่นามสกุล → ชื่อจากผู้ใช้ไม่มีวันกลายเป็น path = ตัด path traversal ตั้งแต่ต้นทาง (มี `resolveKey()` กันซ้ำอีกชั้น) และชื่อจริงอยู่ Metadata Layer เท่านั้น
  - ลำดับ write เป็น **byte ก่อน metadata ทีหลัง** และถ้า INSERT พังจะลบ byte ทิ้ง — ไม่เหลือทั้ง "แถวที่ชี้ไปไฟล์ที่ไม่มีจริง" และ "ไฟล์กำพร้าที่ไม่มีใครลบได้"
  - `sha256` ที่ client ส่งมาใช้แค่ "เทียบ" ไม่ใช่แหล่งความจริง — ไม่ตรง = `422` ทิ้งทั้ง byte และ metadata
  - **แก้ปัญหาสิทธิ์ volume ตั้งแต่ image**: named volume ที่ mount ใหม่จะเป็นของ `root` ขณะที่คอนเทนเนอร์รันด้วย user `node` — จึง `chown` mountpoint ใน Dockerfile ก่อน `USER node` และให้ `initStorage()` เขียนไฟล์ทดสอบจริงตอนบูตเพื่อให้ปัญหาดังตั้งแต่ start ไม่ใช่ตอนผู้ใช้กดอัปโหลด
  - **operator2 → CAM-06** เพิ่มเข้า seed (ไม่แตะบัญชีเดิมทั้ง 4 ตามคำสั่ง) และ mirror ลง dev fallback ให้ตรงกัน — ยืนยันแล้วว่า operator ↔ operator2 ยิงขอกล้องของกันและกันได้ `403` ทั้งสองทิศทาง
  - **`.env.example` ไม่มีค่าจริงเหลือแล้ว** — ค่าที่ดูเหมือนของจริง (POSTGRES_PASSWORD, SESSION_SECRET, bcrypt hash ของ `veerachat05`) อยู่แค่ใน working copy ที่ยังไม่ถูก commit ตรวจกับ `git log`/`origin/main` แล้ว **ไม่เคยถูก push ขึ้น remote** จึงไม่ต้อง rotate
  - พบและแก้กับดัก: ค่า bcrypt ใน root `.env` ต้องเขียน `$` เป็น `$$` ไม่งั้น docker compose กลืน `$eM2QJbR` เป็นชื่อตัวแปรแล้ว hash พังเงียบ ๆ (ตรวจด้วย `docker compose config`)
- **Status**: ✅ ทดสอบจริงบน stack ที่รันอยู่ — upload→download ไฟล์ binary 3MB ได้ sha256 ตรงกันและ `cmp` byte ต่อ byte ผ่าน; checksum ผิด→422, ไม่มี CSRF→403, ไม่มี session→401, ลบแล้ว byte หายจริง; camera scoping ครบทุกกรณี; drive/monitor healthy ทั้งคู่
- **ค้างไว้ (รอ ruling ของผู้ใช้)**: ประเด็น **A** (HUB `src/lib/auth.js` มี `DEMO_ACCOUNTS` client-side fallback ที่ประกาศ role เองและมีรหัสผ่าน plaintext อยู่ใน bundle ที่ ship จริง) และ **B** (ทั้งสองแอปยังต่อ Postgres ด้วย role `aegis` superuser ตัวเดียว ยังไม่มี `drive_app`/`monitor_app` + GRANT/REVOKE) — **ยังไม่แตะทั้งคู่ตามคำสั่ง HOLD**

---

## [2026-07-22] vibe-coding | Phase 1 follow-up: บังคับ Identity Decoupling ระดับ SQL (drive_app / monitor_app) + ถอน node_modules ออกจาก git
- **User Prompt Goal**: ตรวจให้ชัดว่า drive/monitor แชร์ role ของ Postgres กันจริงไหม ถ้าใช่ให้สร้าง role แยกที่ต่อได้เฉพาะฐานตัวเอง แล้วพิสูจน์ว่าข้ามฐานไม่ได้; และถอน `node_modules` ที่ถูก track ไว้ออกจาก git (ยังห้ามแตะ A/B)
- **Modified/New Paths**:
  - `postgres/init/02-app-roles.sh` (**ใหม่** — สร้าง `drive_app`/`monitor_app` + REVOKE/GRANT)
  - `docker-compose.yml` (mount script ใหม่, env `DRIVE_DB_PASSWORD`/`MONITOR_DB_PASSWORD`, ย้าย `DATABASE_URL` ทั้งสองไปใช้ role แยก)
  - `.env` / `.env.example` (รหัสของ role แยกต่อแอป)
  - `docs/auth-test.md` (ข้อ 11 ใหม่ — แทนที่หมายเหตุเดิมที่บอกว่า "ยังไม่ได้ทำ")
- **Obsidian Updates**: [[00 - 🗺️ AEGIS System Overview]], [[05 - 🛡️ Security Architecture]]
- **Key Changes**:
  - **ยืนยันว่าเป็นปัญหาจริง ไม่ใช่ความเข้าใจผิดของเอกสาร**: `\du` มี role เดียวคือ `aegis` (superuser) และ `DATABASE_URL` ทั้งสองบริการต่อด้วย role นั้น — ทดสอบตรงแล้ว credential ของ IDEA1 `SELECT password_hash` จากตาราง `users` ของ `aegis_monitor` ได้จริงทั้ง 3 แถว
  - แก้แล้ว: `drive_app` → `aegis_drive` เท่านั้น, `monitor_app` → `aegis_monitor` เท่านั้น — **ถูกปฏิเสธที่ชั้น connection** (`FATAL: permission denied for database … User does not have CONNECT privilege`) ไม่ใช่ชั้น query จึงไม่ต้องพึ่ง WHERE clause ที่ไหนเลย
  - **กุญแจสำคัญคือ `REVOKE CONNECT … FROM PUBLIC`**: PostgreSQL แจกสิทธิ์ CONNECT ของทุก database ให้ PUBLIC โดยดีฟอลต์ ถ้า GRANT ให้ role ที่ถูกต้องอย่างเดียวโดยไม่ถอนของ PUBLIC ก่อน การแยกจะไม่เกิดขึ้นเลย
  - role ใหม่ได้แค่ DML + USAGE บน sequence ไม่ได้เป็นเจ้าของตาราง → `DROP TABLE` ได้ `must be owner`, `CREATE TABLE` ได้ `permission denied for schema public` — โปรเซสที่ถูกยึดก็แก้ schema ไม่ได้ migration ยังเป็นงาน superuser ตอน deploy
  - superuser `aegis` เหลือหน้าที่แค่ init/migrate/ตรวจสอบ — ไม่มีบริการไหนที่รันอยู่ต่อด้วย role นี้อีกแล้ว
  - ทดสอบเส้นทาง init บน **volume เปล่าจริง ๆ** ด้วย compose project แยก (`-p aegisfresh`) แล้ว `down -v` ทิ้ง — role/สิทธิ์/seed (รวม `operator2`→CAM-06) ถูกสร้างครบตั้งแต่บูตแรก ข้อมูลของ stack จริงไม่ถูกแตะ
  - เจอผลข้างเคียงตอน recreate: nginx ของ gateway cache IP ของ upstream ไว้ตั้งแต่บูต พอ container ถูกสร้างใหม่แล้วได้ IP ใหม่จะขึ้น 502 ทั้งที่ container สุขภาพดี — แก้ด้วย `docker compose restart gateway` (เป็นข้อจำกัดเดิมของ config ไม่ใช่ของใหม่)
  - `git rm -r --cached IDEA1-AEGIS_Drive_LC/node_modules` ถอดไฟล์ 12,551 ไฟล์ออกจาก index (ไฟล์ยังอยู่บนดิสก์ แอปยังรันได้) — `.gitignore` บรรทัด `node_modules/` ครอบคลุมอยู่แล้ว ยืนยันด้วย `git check-ignore`
- **Status**: ✅ regression ครบหลังย้าย role — login/RBAC, upload→download 2MB byte ตรงกัน, audit เขียนได้, camera scoping (soc=6 กล้อง, operator=CAM-05, operator2=CAM-06, ไขว้กัน=403) ทุกอย่างผ่านบน role ใหม่
- **ค้างไว้ (รอ ruling)**: A (HUB client-side `DEMO_ACCOUNTS`) และ B — **ยังไม่แตะตามคำสั่ง HOLD**

---

## [2026-07-23] vibe-coding | แก้ nginx gateway cache IP ของ backend + เพิ่ม healthcheck ให้ gateway
- **User Prompt Goal**: gateway resolve ชื่อ `drive`/`monitor` ครั้งเดียวตอนบูตแล้ว cache IP ไว้ พอ container ถูกสร้างใหม่ (IP เปลี่ยน) จะขึ้น 502 จนกว่าจะ `docker compose restart gateway` เอง — ให้แก้ด้วย `resolver` + `proxy_pass` ผ่านตัวแปร และเพิ่ม healthcheck ให้ gateway ไปด้วยเพราะกำลังแก้ไฟล์นี้อยู่แล้ว
- **Modified Paths**:
  - `gateway/nginx.conf` (`resolver 127.0.0.11 valid=10s ipv6=off` + `resolver_timeout 5s`; `/drive/` และ `/monitor/` เปลี่ยนไปใช้ `set $..._upstream` แล้ว `proxy_pass http://$var`; `/healthz` เพิ่ม `access_log off`)
  - `docker-compose.yml` (เพิ่ม healthcheck ของ gateway ยิงหา `/healthz` ของตัวเอง)
- **Obsidian Updates**: [[00 - 🗺️ AEGIS System Overview]]
- **Key Changes**:
  - **สาเหตุ**: nginx resolve ชื่อ host ที่เขียนตรง ๆ ใน `proxy_pass` แค่ตอน start แล้วจำ IP ไว้ตลอดอายุโปรเซส การเขียนผ่านตัวแปรทำให้ nginx เลื่อนไป resolve ตอน runtime แทน (ต้องมี `resolver` คู่กันเสมอ ไม่งั้น nginx ไม่รู้จะถาม DNS ตัวไหน)
  - **พิสูจน์แบบ A/B จริง**: บังคับให้ `drive` ได้ IP ใหม่ (หยุด container → ให้ container ชั่วคราวยึด IP เดิม → ยกกลับมาใหม่ได้ `172.18.0.3` → `172.18.0.7`) แล้วยิงผ่าน gateway สองตัวพร้อมกันโดยไม่ restart ตัวไหนเลย — **config เดิม 502 ติดต่อกัน 12 วินาที (และค้างถาวรจนกว่าจะ restart) ส่วน config ใหม่ 200 ทุกครั้งไม่ตกเลยสักครั้ง** ยืนยันซ้ำกับ `monitor` (`172.18.0.2` → `172.18.0.8`) ได้ผลเดียวกัน
  - ยืนยันว่า 502 ของ config เดิมมาจาก DNS ค้างจริง: restart gateway ตัวเก่าแล้วกลับมา 200 ทันทีทั้งที่ backend ไม่ได้แตะเลย
  - **ขอบเขตที่เหลืออยู่ (ไม่ใช่ศูนย์)**: `valid=10s` แปลว่า worst case ยังมีหน้าต่างค้างได้ไม่เกิน ~10 วินาที ถ้า IP เปลี่ยนภายในช่วง TTL — ต่างจากเดิมที่ค้าง "ตลอดไป" ลดค่านี้ได้ถ้าต้องการแต่จะแลกกับ DNS query ถี่ขึ้น
  - healthcheck ของ gateway ยิงหา `/healthz` ของ nginx เอง **ไม่ใช่** `/drive` หรือ `/monitor` โดยเจตนา — gateway เป็น routing-only ถ้าผูก health ไว้กับ backend พอ backend ล่มทีเดียว docker จะรีสตาร์ท router ที่ยังดีอยู่ทิ้งไปด้วย = ขยายวงความเสียหายแทนที่จะจำกัด
  - `HUB-AEGIS_Entry/nginx.conf` (production) **ไม่ต้องแก้** — proxy_pass ไปที่ IP ตรง ๆ (`192.168.10.11:8001` / `192.168.10.12:8002`) ไม่มี DNS เข้ามาเกี่ยวข้องเลย
- **Status**: ✅ `nginx -t` ผ่าน; routing เดิมครบ (`/`, `/drive/`, `/monitor/`, 301 ของ `/drive`→`/drive/`, path ซ้อน, query string); gateway healthy ใน docker; regression ครบหลัง IP เปลี่ยนทั้งสองตัว — login/RBAC, upload→download 1.5MB byte ตรงกัน, camera scoping + 403 ไขว้กัน ผ่านหมด; container ทดสอบถูกลบทิ้งแล้ว
- **ค้างไว้ (รอ ruling)**: A (HUB client-side `DEMO_ACCOUNTS`) และ B — **ยังไม่แตะตามคำสั่ง HOLD**

---

## [2026-07-23] wiki-lint | ตรวจ vault ตามคอนเวนชัน Obsidian + ซ่อมลิงก์เสีย
- **User Prompt Goal**: รัน `/obsidian` — ตรวจ vault ให้ตรงคอนเวนชัน (frontmatter / wikilinks / mermaid / canvas) และซ่อมสิ่งที่ไม่ตรง
- **Modified Paths**: `.schema.md`, `log.md`, `index.md`, `00 - 🗺️ AEGIS System Overview.md`, `02 - 💾 IDEA1 AEGIS Drive LC.md`, `03 - 📹 IDEA2 AEGIS Monitor.md`, `concepts/*.md` (7 ไฟล์), `entities/*.md` (2 ไฟล์)
- **Key Changes**:
  - **ซ่อมลิงก์ที่ตัวเองทำพังในรอบก่อน**: `[[docs/auth-test]]` ใน 4 โน้ต — `docs/auth-test.md` อยู่ **นอก** vault (รากของ repo) Obsidian จึง resolve ไม่ได้ตลอดกาล เปลี่ยนเป็น path ใน inline code แทน และเพิ่มหมายเหตุใน `index.md` ว่าไฟล์นอก vault ต้องอ้างเป็น path ล้วนเสมอ
  - **ซ่อมลิงก์ค้างเก่า 17 จุดใน 11 ไฟล์**: `[[modules/02_IDEA1_AEGIS_Drive_LC]]` และ `[[modules/04_IDEA3_AEGIS_Lockdown]]` ชี้ไปยังโน้ตที่ **ไม่มีอยู่จริง** ส่วน `[[modules/03_IDEA2_AEGIS_Monitor]]` ชี้ไปยังไฟล์ที่มีอยู่แต่ **ว่างเปล่า 0 ไบต์** (แย่กว่าลิงก์เสีย เพราะผู้อ่านกดแล้วเจอหน้าว่างโดยไม่รู้ว่าผิด) — ทั้งหมดถูกชี้กลับไปยังโน้ตหมายเลขที่ใช้งานจริง โดยรักษา label หลัง `|` ไว้ครบ
  - เพิ่ม YAML frontmatter ให้ `log.md` และ `.schema.md` (เดิมไม่มี) — ไฟล์ `raw/` และ `AEGIS_Project_Knowledge.md` **จงใจไม่แตะ** เพราะ `.schema.md` ระบุว่าเป็น Immutable Raw Source
  - ตรวจ mermaid: 13 โน้ตมี fence ครบคู่ทุกไฟล์ (เคยมี fence เกินหนึ่งอันในไฟล์ overview จากรอบก่อน แก้ไปแล้ว)
- **ยังค้าง (ต้องให้ผู้ใช้ตัดสิน ไม่ลบเอง)**:
  - `modules/03_IDEA2_AEGIS_Monitor.md` และ `2026-07-21.md` เป็นไฟล์ว่าง 0 ไบต์ และตอนนี้ไม่มีลิงก์เข้าเลย → โฟลเดอร์ `modules/` ว่างเปล่าโดยพฤตินัยแล้ว ทั้งที่ `.schema.md` ยังประกาศไว้ในโครงสร้าง
  - `.schema.md` ขึ้นต้นด้วยจุด → **Obsidian ไม่ index ไฟล์/โฟลเดอร์ที่ขึ้นต้นด้วย `.`** แปลว่าเอกสารกฎของ vault มองไม่เห็นในแอป และ `[[.schema.md]]` ใน `index.md` กดไม่ได้จริง (เปลี่ยนชื่อเป็น `schema.md` จะแก้ได้ แต่กระทบโครงสร้างที่ประกาศไว้ จึงยังไม่ทำเอง)
- **Status**: ✅ ลิงก์เสียเหลือศูนย์ (ที่เหลือเป็น false positive: ตัวอย่างในเอกสารกฎ และข้อความในเครื่องหมาย backtick ซึ่ง Obsidian ไม่แปลงเป็นลิงก์อยู่แล้ว)

---

## [2026-07-24] vibe-coding | ปิดช่องโหว่ HUB client-side auth + เปลี่ยน HUB เป็น app-picker ล้วน
- **User Prompt Goal**: ปิดช่องโหว่ที่ HUB login fallback ไปตรวจรหัสผ่านฝั่ง client (`DEMO_ACCOUNTS`) เมื่อไม่มี backend ตอบ — เลือกแนวทาง "ลบฟอร์มล็อกอินทิ้ง ให้ HUB เหลือแค่หน้าเลือกแอป" (แทนการสร้าง HUB backend ใหม่) เพื่อปลดล็อกให้เข้าเช็คระบบได้ทันที
- **Root Cause**: `src/lib/auth.js` มี `DEMO_ACCOUNTS` + logic "API offline → authenticate client-side" เงื่อนไข offline เป็นจริงเสมอ เพราะ `docker-compose.yml` ไม่เคยมี service `hub` (gateway เสิร์ฟ HUB เป็น static → `/api/login` ตอบ 405) = แจก session Admin โดยไม่มี server enforcement
- **Modified Code Paths**:
  - **ลบทิ้ง**: `HUB-AEGIS_Entry/server/` (ทั้งโฟลเดอร์), `src/screens/Login.jsx`, `src/lib/auth.js`, `src/lib/modules.js`
  - **แก้**: `src/App.jsx` (state machine เหลือ welcome→hub ตัด screen 'login'/'session' ออก), `src/lib/strings.js` (ลบสตริงหมวด Login + LAYER 0–3 ทั้ง en/th/zh), `Dockerfile` (runtime เป็น nginx เสิร์ฟ static ไม่รัน `node server/index.js` แล้ว), `package.json` (ตัด express + scripts `start`/`server`/`dev:server`), `docker-compose.yml` (port 80/443 + certs volume), `nginx.conf` (comment)
  - **แก้ prose**: `README.md` (ราก), `HUB-AEGIS_Entry/README.md`
  - **หมายเหตุ**: `Hub.jsx` มีโครงเป็น stateless app-picker (window.location.href + config.json) อยู่แล้ว จึงไม่ต้องแก้ตรรกะ — งานหลักคือ "ลบ" ไม่ใช่ "สร้าง"
- **Docs**: `docs/auth-test.md` — เพิ่มหมายเหตุหัวไฟล์ (HUB ไม่มี login) + เพิ่ม **§12** (regression test: bundle ไม่มี credential, `/api/login`→405, หน้า HUB ไม่ยิง auth request, ไม่มี `server/`)
- **Obsidian Updates**: [[01 - 🚪 HUB-AEGIS Entry]] (เขียนใหม่ทั้งโน้ต), [[00 - 🗺️ AEGIS System Overview]] (ลบ HUB_API :3001 จาก mermaid + แก้ตารางสถานะ), [[concepts/Identity_Decoupling]] (เพิ่มเหตุผลว่าทำไม HUB ต้องไม่มี identity), `index.md`
- **Verification (จริง ไม่ใช่ "should work")**:
  - `docker compose build --no-cache && up -d` → 4 container healthy, container postdate source ทุกไฟล์, bundle ที่ deploy = `index-DNSXLW2W.js` ตรงกับ local build
  - Browser (playwright/chrome): หน้า HUB — 0 password input, 0 form, 0 auth request (มีแค่ `GET /` + `/config.json`); กด Drive card → `/drive/` เจอ login จริง; กด Monitor card → `/monitor/` เจอ login จริง
  - Login ผ่านหน้าจอจริง: `admin`/`aegis-drive-admin` → Admin session + เมนู 9 รายการ + `/api/*` ตอบ 200
  - `docs/auth-test.md` §1–12 รันจริงผ่านทั้งหมด (§8 rate limit: attempt 6 → 429 Retry-After 120; §9 roundtrip IDENTICAL + UUID บนดิสก์; §11 cross-DB connect → permission denied)
- **Key Changes**: ปิดช่องโหว่ด้วยการ**ลบพื้นผิวการโจมตี** ไม่ใช่เพิ่ม guard — HUB กลับไปเป็น routing-only ตามสถาปัตยกรรมเดิม Drive/Monitor ไม่ถูกแตะเลย (ยืนยันด้วย §1–11)
- **Constraints ที่รักษาไว้**: ไม่แตะ IDEA2/Add Operator, ไม่แตะ `camera_assignment`/RBAC, ไม่สร้าง HUB DB/backend/session, ดีไซน์เดิมทุกประการ

---

## [2026-07-24] vibe-coding | Verify in-web Add Operator E2E (real Postgres) + document the feature
- **User Prompt Goal**: รันสแตกจริง (ไม่ใช่ dev-fallback), พิสูจน์ `docs/auth-test.md` §13 ด้วย output จริงทุกบรรทัด, เปิดเบราว์เซอร์จริง (Playwright) เพิ่ม operator ผ่านหน้า Nodes & routing แล้วยืนยัน temp-password modal + isolation ของ operator ใหม่ แล้วอัปเดต vault
- **Verification (จริง ไม่ใช่ "should work")**:
  - `docker compose build --no-cache && up -d` → 4 container healthy; monitor ต่อ `aegis_monitor` ผ่าน `monitor_app` (ยืนยันจาก `docker compose config`) = โหมด Postgres จริง ไม่ใช่ in-memory DEV_USERS
  - `docs/auth-test.md` §13 รันจริงผ่านทั้งหมด: §13.1 `201` + temp password 24-char + `grep -c` ใน log = **0**; §13.2 กล้องซ้ำ → `409` + rollback (`x.taken` count = 0); §13.3 operator (ไม่ใช่ SOC) → `403 Forbidden`; §13.4 operator ใหม่ก่อนรีเซ็ต `/cameras` → `403`, หลังรีเซ็ตเห็นแค่ CAM-04; §13.5 สร้างอีกบัญชีผ่าน CLI จริง (Python container บน network เดียวกัน ต่อ `postgres:5432`) แล้วเทียบสองแถวใน DB
  - **Browser (Playwright chromium จริง)**: login `soc` → Nodes & routing → Add operator → dropdown โชว์เฉพาะกล้องว่าง (CAM-03 ตัวเดียว เพราะที่เหลือถูกจับจอง) → submit → `TempPasswordModal` เรนเดอร์ครบ: รหัส 24-char, ปุ่ม Copy (กดแล้วเป็น "Copied" + เขียน clipboard ตรงกับที่โชว์จริง), คำเตือน "won't be shown again" (screenshot เก็บไว้)
  - **Isolation ของ operator ใหม่ (`g.torres.gui` → CAM-03, §5 pattern)**: ก่อนรีเซ็ต `/cameras` → 403; หลังรีเซ็ตเห็นแค่ CAM-03; ขอ CAM-05/CAM-01 ของคนอื่น → 403; `/alerts` (SOC-only) → 403; และไขว้กลับ `operator` (CAM-05) ขอ CAM-03 → 403
  - บัญชีทดสอบทั้ง 4 (`m.reyes.web`, `m.reyes.cli`, `m.reyes.web2`, `g.torres.gui`) ถูกลบทิ้ง คืน DB เป็น seeded baseline (3 บัญชี, CASCADE เก็บ `camera_assignment` ให้)
- **Finding (bcrypt version prefix)**: เส้นทางเว็บ (`bcryptjs`) ออก `$2a$12$` ส่วน CLI (Python `bcrypt`) ออก `$2b$12$` — cost 12 และ 60-char เท่ากัน cross-verify ได้ ต่างแค่ตัวอักษร variant; sample ใน `docs/auth-test.md` §13.5 ที่โชว์ทั้งคู่เป็น `$2b$12$` เป็นค่าที่ idealized (จดไว้ในโน้ต IDEA2 แล้ว)
- **operator2 fixture clarification**: `DEV_USERS` ใน `server/db/connection.js` (รวมแถว `operator2`) ถูก gate ด้วย `DATABASE_URL ? [] : [...]` → เมื่อรันโหมด Postgres อาเรย์นี้ **ว่างเปล่า** ไม่เคย mirror/เขียนลง DB จริง ไม่มี collision กับแถว seed จริงใน `seed.sql` (คนละโหมด, in-memory ล้วน, และ seed ใช้ `ON CONFLICT DO NOTHING`)
- **Modified Code Paths**: ไม่มี (verification-only งานพิสูจน์ + เอกสาร ไม่แตะโค้ดฟีเจอร์)
- **Obsidian Updates**: [[03 - 📹 IDEA2 AEGIS Monitor]] (เพิ่มหัวข้อ In-Web Add Operator + แก้กรอบ CLI จาก "only" + finding bcrypt + code paths), [[00 - 🗺️ AEGIS System Overview]] (หมายเหตุ 2026-07-24)
- **Housekeeping**: commit `README.md` แยกเป็น `docs(readme):` (HUB static-only), และ vault นี้เป็น `docs(vault):` แยกจากโค้ดตามคอนเวนชัน
- **Status**: ✅ Part 1 ผ่านจริงทุกข้อกับ Postgres จริง; DB คืน baseline; ไม่แตะ RBAC/`camera_assignment`/โค้ดฟีเจอร์

---

## [2026-07-25] vibe-coding | ต่อท่อ Detection Engine เข้า aegis_monitor DB จริง (ถอด demo generator)
- **User Prompt Goal**: เชื่อม Detection Engine (Python) กับ Monitor DB จริง — engine ยิงผ่าน internal API (ไม่ถือ DB credential), backend เขียน Postgres, ถอด in-memory demo generator, พิสูจน์ end-to-end จริง
- **Architecture**: Detection Engine → `POST /internal/{detections,clips,alerts}` (service key `X-Detection-Engine-Key`) → backend เขียน DB — trust boundary เดิม: มีแต่ backend ของแอปที่แตะฐานตัวเอง
- **Modified Code Paths**:
  - **Monitor backend**: `server/routes/internal.js` [NEW] (3 endpoints), `server/middleware/requireDetectionEngineKey.js` [NEW] (timing-safe, fail-secure, Thai comments), `server/db/store.js` (ถอด generator + seed arrays ทิ้ง; เพิ่ม `insertDetection/insertClip/insertAlert`; เขียน `listDetections/listAlerts/listClips/ackAlert` ใหม่ให้ query Postgres + แปลงรูปทรงกลับให้ frontend), `server/routes/api.js` (await async reads + ส่ง req.user เข้า ackAlert), `server/index.js` (mount `/internal` แยกจาก `/api` ไม่มี CSRF)
  - **Detection Engine**: `aegis_engine/monitor_client.py` [NEW] (HTTP client fail-soft), wired 3 seams — `engine.py._on_detection`, `nas_sync.py._finish_ok` (หลัง verify เท่านั้น), `alert_manager.py._handle` (persist ไม่ว่า Telegram ผลใด)
  - **Gateway**: `gateway/nginx.conf` — `location /monitor/internal/ { return 404; }` (defense-in-depth)
  - **Frontend**: `src/views/Archive.jsx` — guard `segs ?? []` (option A: ไม่มี segs/live clip)
  - **Config**: `docker-compose.yml` + `.env.example` — `DETECTION_ENGINE_API_KEY` (fail-secure default ว่าง)
  - **Docs**: `docs/auth-test.md` §14 (7 ข้อพิสูจน์)
- **Rulings ที่ทำตาม**: (1) ยึด schema.sql เป๊ะ ไม่มี migration (`at`/`frame_id`, severity amber/red, `file_path`); (2) clips option A (derive kind, ไม่มี segs/live clip); (3) gateway 404; (4) sshd NAS ชั่วคราว + `AEGIS_SEGMENT_SECONDS=20` (test override เท่านั้น, default config.py ยัง 600) แล้วรื้อทิ้งหลังทดสอบ
- **Verification (จริง ไม่ smoke-test)**:
  - API key: no key/wrong key → 401; key ถูก body ผิด → เข้า handler (400); gateway `/monitor/internal/*` → 404 (เว็บ path ปกติ 401 = ถึงแอป)
  - รัน DetectionEngine จริงครบ pipeline (deterministic recognizer inject ตรง AI seam + วิดีโอทดสอบ) ในคอนเทนเนอร์บน network เดียวกับ stack ยิง `monitor:8002`: detections รวม tailgating (2 คน/frame แชร์ frame_id, matched_name NULL เมื่อ Unknown); clips 2 แถว `stored_on_nas=t` + `file_path` ชี้ NAS **หลัง** rsync+sha256 verify จริง (ไบต์ 10MB อยู่บน NAS จริง); alerts `telegram_sent=f` (dry-run) แต่ persist ครบ
  - Browser (Playwright): soc เห็น Detection CAM-01/05/06 (การ์ด tailgating 2/2 + ชื่อ Authorized + Unknown%) + Archive ทุกกล้อง; operator เมนูมีแค่ Live/Archive/Diagnostics/Settings (ไม่มี Detection/Alerts) + Archive เห็นแค่ CAM-05
  - restart monitor แล้ว detections/alerts นิ่ง (68/5 คงที่ 30s) = generator หายจริง
  - รื้อ throwaway NAS+engine (containers+images) ทิ้งแล้ว; main stack healthy; `.env` (key จริง) ยัง gitignored
- **Obsidian Updates**: [[03 - 📹 IDEA2 AEGIS Monitor]] (แก้ mermaid: engine→/internal→backend→DB แทน engine→DB ตรง ๆ; เพิ่มหัวข้อ Phase 3 + code paths), [[00 - 🗺️ AEGIS System Overview]] (หมายเหตุ 2026-07-25)
- **Status**: ✅ ครบทุก Phase; ไม่แตะ IDEA1/HUB/Add-Operator/RBAC/camera_assignment; engine ไม่มี DB credential

---

## [2026-07-25] housekeeping | ลบ vault stub ว่าง 2 ไฟล์ + reconcile .schema.md
- **User Prompt Goal**: ลบไฟล์ 0 ไบต์ที่ยืนยันแล้วว่าว่างเปล่า (`2026-07-21.md`, `modules/03_IDEA2_AEGIS_Monitor.md`) แล้วปรับ `.schema.md` ให้ตรงความจริง
- **Investigation ก่อนลบ**: ทั้งสองไฟล์ born-empty ใน commit `5eea653` (ไม่เคยมีเนื้อหาใน git history), ไม่มี wikilink ชี้เข้าเลย (ที่เจอใน `.obsidian/workspace.json` เป็น UI state ที่ gitignored) — `modules/` มีแค่ไฟล์นี้ไฟล์เดียว ลบแล้วโฟลเดอร์หายทั้งหมด
- **Modified Paths**: ลบ 2 ไฟล์; แก้ `.schema.md` (tree diagram: `modules/` → numbered top-level notes เป็น canonical home + note การเลิกใช้; Ingest workflow ชี้ที่ numbered notes แทน), `index.md` (heading `Core Modules (`modules/`)` → `(numbered top-level notes)`)
- **Commit**: `62f269b` docs(vault): remove empty stub files, reconcile .schema.md (แยกจากงาน Detection Engine)
- **Status**: ✅ ไม่มี stub ว่างเหลือ, ไม่มี reference ชี้ไปโฟลเดอร์ว่าง

---

## [2026-07-25] obsidian-sync | Full-session comprehensive vault audit
- **User Prompt Goal**: ตรวจ vault ทั้งหมดของ session นี้ (ไม่ใช่ incremental) — ยืนยันทุกงานใหญ่ถูกสะท้อนจริง จับ claim ที่ยังเก่า/ผิด
- **ตรวจแล้วถูกต้องอยู่แล้ว (ไม่ต้องแก้)**: HUB fix ([[01 - 🚪 HUB-AEGIS Entry]] + Identity_Decoupling อธิบาย HUB ไม่มี identity, DEMO_ACCOUNTS อยู่ในบริบท "ลบแล้ว/regression" ทั้งหมด); Storage Layer ([[02 - 💾 IDEA1 AEGIS Drive LC]] ระบุ `drive_storage` **IDEA1-only, monitor ไม่ mount** — ไม่มี claim shared storage เก่าค้าง); Add Operator CLI+web ([[03 - 📹 IDEA2 AEGIS Monitor]]); gateway DNS-resolver fix ([[00]] + log 2026-07-23); node_modules untrack (log 2026-07-22); ตาราง 3 apps + per-app DB (drive_app/monitor_app CONNECT-here-only) ใน [[00]] mermaid ถูกต้อง; §14 detection engine ครบใน docs/auth-test.md
- **แก้ที่พบว่าตกหล่น**:
  - [[00 - 🗺️ AEGIS System Overview]] mermaid — เพิ่ม node Detection Engine (VLAN 20, no Postgres credential) → `POST /internal/*` → Monitor API → DB (เดิม diagram ไม่มี engine เลย)
  - [[00 - 🗺️ AEGIS System Overview]] — เพิ่มหัวข้อ **Open / Outstanding** ระบุ 4 งานที่ยัง **ไม่เสร็จ** ชัดเจน (Snapshots & Recovery, Vault persistence, Secure Shares VLAN/UFW enforcement, report↔KB shared-vs-separate storage) กันเข้าใจผิดว่า done
  - [[concepts/Identity_Decoupling]] — เพิ่มชั้นที่ 2 (DB engine: `REVOKE CONNECT … FROM PUBLIC` + drive_app/monitor_app) และชั้นที่ 3 (session secret แยก) เดิมมีแค่ชั้นบัญชี + HUB
  - `log.md` — เติม entry housekeeping (stub removal 62f269b) ที่ยังขาด
- **Commits/push ของ session**: `38cb636` feat(idea2) Detection Engine wiring + `77c33dc` docs(vault) sync (แยกกันตามคอนเวนชัน); push ครบ 14 commits ขึ้น origin แล้ว (`5eea653..77c33dc`, ไม่มีอะไร local-only)
- **Status**: ✅ ทุกงานใหญ่ทั้ง 8 สะท้อนใน vault; open items แยกจาก done ชัดเจน

---

## [2026-07-25] vibe-coding | Drive Login: glow ให้เป็นสีน้ำเงินตระกูลเดียวกันทั้งสองโหมด + ลดความแรงในโหมดมืด
- **User Prompt Goal**: แก้ 2 ปัญหาบนหน้า Login ของ IDEA1 — (1) Dark Mode glow เป็นม่วง/บานเย็น คนละ hue กับ Light Mode ที่เป็นฟ้า/ไซแอน (`#2563EB`), (2) glow ในโหมดมืดใหญ่และแรงเกินไป ขัดหลัก "Precision Light — near-invisible shadows" ให้ลด blur/opacity โดยใช้ Light Mode เป็นตัวอ้างอิงความสุภาพ — **ห้ามแตะ layout, spacing, logic ของ 4-layer readout**
- **Modified Code Paths**:
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\screens\Login.jsx` — volumetric aura, radial beam, เส้นพลังงาน, backlight โลโก้, ขอบ+เงาการ์ด, ขอบ panel ซ้าย, โฟกัสอินพุต 2 ช่อง, ขอบ LayerRow ทั้ง 3 แบบ, tagline gradient
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\index.css` — `body::after` ambient radial (โหมดมืด) จากม่วงเป็นน้ำเงิน
- **Obsidian Updates**: [[02 - 💾 IDEA1 AEGIS Drive LC]] (เพิ่มหัวข้อ Ambient Glow — Single-Hue Policy + ตัวเลข contrast ที่วัดจริง; แก้คำอธิบาย tagline จาก "ฟ้า-ม่วง" เป็น "ฟ้าล้วน")
- **Key Changes**:
  - ทุกค่าม่วง/บานเย็น (`purple-*`, `fuchsia-*`, `rgba(168,85,247,…)`, `rgba(124,58,237,…)`) บนหน้า Login → ตระกูลน้ำเงิน (`blue-*`, `sky-*`, `rgba(37,99,235,…)`, `rgba(59,130,246,…)`)
  - ลดความแรง glow โหมดมืด: gradient ของ aura ใส่ alpha (`/30 /24 /16` จากเดิมทึบเต็มค่า) และเงาจาก `0 0 80px 20px @0.4` → `0 0 34px 2px @0.2`; เงาการ์ด `0 0 40px -5px @0.3` → `0 0 26px -8px @0.28`; เงาโฟกัสอินพุต `0 0 25px @0.5` → `0 0 16px @0.3`
  - **หมายเหตุเชิงเทคนิค**: คลาส `opacity-*` ของ Tailwind บนเลเยอร์เหล่านี้ไม่มีผล เพราะ `framer-motion` เขียน `style.opacity` แบบ inline ทับ — จึงต้องลดความแรงผ่าน alpha ของ color stop และค่า box-shadow เท่านั้น
  - `dark:border-blue-400/70` บนกล่อง `LAYER 1 · APPLICATION` ทำให้ contrast ขอบเทียบพื้นการ์ดขึ้นจาก 2.97:1 เป็น **4.03:1** (ผ่าน WCAG non-text ≥3:1)
  - ไม่แตะ layout/spacing/logic ใด ๆ; `npm run build` ผ่าน
- **Verification**: Playwright screenshot 1440×900 ทั้ง light/dark ก่อน-หลัง + วัด contrast ด้วยการ decode PNG แล้ว sample พิกเซลจริง (ไม่ได้เดาจาก token)
- **Deploy**: `docker compose build drive` → `docker compose up -d drive` (recreated, healthy) — ยืนยันว่า bundle ใน image มี marker ของโค้ดล่าสุดครบ (`dark:border-blue-400/70`, `dark:from-blue-600/30`, `0_0_34px_2px_rgba(37,99,235,0.2)`) และไม่มี class ม่วงเดิม (`fuchsia-500`, `dark:blur-xl`) แล้ว screenshot ซ้ำผ่าน gateway `http://localhost/drive/` ได้ผล contrast เท่ากับ dev server ทุกค่า
- **ข้อสังเกตระหว่าง deploy (ยังไม่แก้)**: `IDEA1-AEGIS_Drive_LC` ไม่มี `.dockerignore` (ทั้ง repo ไม่มีเลยสักแอป) — `COPY . .` จึงลาก `node_modules`/`dist` ของ host เข้า build context; และ image ยังเสิร์ฟ `BG_AEGIS01.png` 3.7 MB + `BG_AEGIS02.png` 4.9 MB ขณะที่ [[01 - 🚪 HUB-AEGIS Entry]] ย้ายไป WebP (171 KB) แล้ว
- **ค้างไว้ (ยังไม่แก้ — อยู่นอกขอบเขต prompt)**: ปุ่ม `.sparkle-btn` ยังเป็น gradient น้ำเงิน→ม่วง (`#2563eb → #7c3aed`) พร้อม `--elev-accent` เงาม่วง ซึ่งเป็น component กลางใช้ทั้งแอป — ตอนปุ่ม enabled จะเป็นสีม่วงจุดเดียวที่เหลือบนหน้า Login; ขอบกล่อง LAYER 1 ในโหมดสว่างวัดได้ 1.57:1 (ต่ำกว่าเกณฑ์ non-text แต่เป็นสภาพเดิมและ prompt ระบุว่าโหมดสว่าง "ถูกต้องแล้ว")

---

## [2026-07-25] vibe-coding | Drive Login: แก้ hint รหัสผ่านผิด + CTA เลิกเป็นม่วง + ขอบ LAYER 1 โหมดสว่างผ่านเกณฑ์
- **User Prompt Goal**: 3 งานบนหน้า Login ของ IDEA1 — (1) footer โชว์รหัสของ HUB ที่ถูกลบไปแล้ว ทำให้คนที่ทำตามล็อกอินไม่ผ่าน, (2) `.sparkle-btn` ยังเป็นน้ำเงิน→ม่วงกลายเป็นของสีม่วงชิ้นเดียวที่เหลือ, (3) ขอบกล่อง `LAYER 1 · APPLICATION` โหมดสว่างวัดได้ 1.57:1 ต่ำกว่าเกณฑ์ non-text 3:1
- **Modified Code Paths**:
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\screens\Login.jsx` — footer hint, ขอบ LAYER 1 โหมดสว่าง, hover shadow ของ CTA (indigo → blue)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\index.css` — `.sparkle-btn` base + hover gradient, `--accent-bloom`, `--elev-accent` (ทั้ง light/dark)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\components\ui.jsx` — Toggle สถานะ ON เลิกใช้ปลายม่วง
- **Obsidian Updates**: [[02 - 💾 IDEA1 AEGIS Drive LC]] (เพิ่มหัวข้อ CTA/Toggle + เหตุผลเชิงเกณฑ์ WCAG + ตัวเลข contrast ใหม่ทั้งสองโหมด + ผลสแกนพิกเซลหาม่วง)
- **Key Changes**:
  - footer: `demo · user / aegis-user · admin / aegis-admin` → `demo · Drive · user / aegis-drive-user · admin / aegis-drive-admin`
  - `.sparkle-btn`: `#2563eb → #7c3aed` เป็น `#1d4ed8 → #075985`; hover `#3b82f6 → #8b5cf6` เป็น `#2563eb → #0369a1`
  - ขอบ LAYER 1 โหมดสว่าง: `border-cyan-500/50` (1.57:1) → `border-blue-600/80` (**3.70:1**) — cyan-500 มีเพดานแค่ 2.45:1 แม้ทึบเต็ม จึงต้องเปลี่ยนสี ไม่ใช่เพิ่ม alpha
- **Verification**:
  - ยิง API จริงผ่าน gateway: `user`/`aegis-drive-user` → **200**, `admin`/`aegis-drive-admin` → **200**, ส่วนคู่เก่า `aegis-user`/`aegis-admin` → **401 Invalid credentials** (ยืนยันว่า hint เดิมพาไปล็อกอินไม่ผ่านจริงตามที่รายงาน)
  - Playwright ทั้งสองโหมด: ขอบ LAYER 1 = 3.70:1 (light) / 4.04:1 (dark), label ปุ่มขาวบน gradient = 6.3:1 / 7.5:1, สแกนพิกเซลหา hue ม่วง 272–335° = 0 px (dark) / 1 px (light, เป็นจุดในภาพพื้นหลัง)
  - build ผ่าน → `docker compose build drive` + `up -d drive` → วัดซ้ำผ่าน `http://localhost/drive/` ได้ตัวเลขตรงกับ dev ทุกค่า
- **พบระหว่างทาง (รายงาน ไม่ได้แก้)**:
  - `IDEA2-AEGIS_Monitor/src/screens/Login.jsx:446` มี hint เดิม `demo · user / aegis-user · admin / aegis-admin` เหมือนกัน และ **ผิดหนักกว่า** เพราะ Monitor ไม่มีบัญชีชื่อ `user`/`admin` เลย ของจริงคือ `soc`/`aegis-soc`, `operator`/`aegis-operator`, `operator2`/`aegis-operator2` (ผู้ใช้สั่งให้รายงานก่อน ห้ามแก้เอง)
  - `docs/auth-test.md:374,386` ใช้ `aegis-user`/`aegis-admin` **โดยเจตนา** — เป็น negative test พิสูจน์ว่ารหัสของ HUB ที่ลบแล้วไม่เหลือใน bundle และใช้ล็อกอินไม่ได้ → ถูกต้องแล้ว ห้ามแก้
  - `src/App.jsx:55-56` ตอนนี้อ่าน theme จาก `localStorage.getItem('aegis_theme')` และ **default เป็น dark** (เดิม `useState('light')`) แต่คอมเมนต์บรรทัด 34 ยังเขียนว่า "ไม่มี localStorage/sessionStorage ที่ไหนเลย" → คอมเมนต์ขัดกับโค้ดแล้ว (ตัว theme ไม่ใช่ token จึงไม่ผิดหลัก OWASP ข้อ 4 แต่คอมเมนต์ควรแก้)
  - ม่วงที่เหลือใน Drive แต่ **ไม่ได้อยู่บนหน้า Login**: `.bg-accent-soft` (sidebar active, ทุกจอ), `.bg-card` เงาม่วงโหมดมืด, `.vault-surface.is-solid` (CSS ตายแล้ว ไม่มี JSX ใช้), ส่วน `--violet` ถูกใช้เป็นสีซีรีส์ `media` ในกราฟ Dashboard/Storage = สีที่มีความหมาย ไม่ควรเปลี่ยนเป็นน้ำเงินเพราะจะชนกับซีรีส์ `docs` ที่ใช้ `--accent`

## [2026-07-26] vibe-coding | /doctor — health-check Claude Code setup, ลด context ที่โหลดทุก session
- **User Prompt Goal**: ตรวจสุขภาพการติดตั้ง Claude Code, หา extension ที่กิน context แต่ไม่ถูกใช้, ตัดเนื้อหา CLAUDE.md ที่ session หาเองได้, ย้าย guidance ที่โหลดตลอดไปเป็น lazy-load, เช็ก hook ช้า, เช็กเวอร์ชัน, ตั้ง auto mode เป็น default
- **Modified Code Paths**:
  - `C:\Users\User\AEGIS_System\CLAUDE.md` (2,747 → 977 chars)
  - `C:\Users\User\AEGIS_System\.claude\skills\vibe_coding_obsidian_sync\SKILL.md` (850 → 2,294 chars)
  - `C:\Users\User\.claude\settings.json` (เพิ่ม `permissions.defaultMode: "auto"`)
- **Obsidian Updates**: `[[log]]` (บันทึกนี้เท่านั้น — เป็นการปรับ tooling ไม่ใช่สถาปัตยกรรม AEGIS จึงไม่แตะ `[[00 - 🗺️ AEGIS System Overview]]`)
- **Key Changes**:
  - ย้าย "AUTOMATIC POST-PROMPT SYNC WORKFLOW" (บรรทัด 8–49, ~1,943 chars) ออกจาก `CLAUDE.md` ไปไว้ใน skill `vibe_coding_obsidian_sync` ที่ครอบคลุมเรื่องเดียวกันอยู่แล้ว → เนื้อหาโหลดเฉพาะตอนเรียกใช้ ไม่ใช่ทุก session
  - คงไว้ใน `CLAUDE.md`: คำสั่ง MANDATORY + vault path (เป็นตัว trigger) และ **CORE AEGIS ARCHITECTURAL PRINCIPLES** ทั้ง 4 ข้อ — safety-critical ห้ามย้ายไป lazy file
  - ตั้ง auto mode เป็น default permission mode ระดับ user (มีผลทุกโปรเจกต์)
- **Findings (ไม่ได้แก้)**:
  - MCP connector `vyra.ai_Edit` (~1,300 est. tokens ทุก session) และ `Google_Drive` — ใช้ 0 ครั้งใน 16 session → ผู้ใช้ต้องปิดเองผ่าน `/mcp` (เป็น claude.ai connector ไม่ใช่ config ในเครื่อง)
  - impeccable PostToolUse hook: median 166 ms / max 255 ms, 56 runs, ไม่มี timeout → ปกติดี
  - Claude Code 2.1.220 = เวอร์ชันล่าสุด, ติดตั้งเดียว ไม่มีของค้าง, settings ทุกไฟล์ parse ผ่าน

## [2026-07-26] vibe-coding | Private Vault (IDEA1) — Zero-Knowledge ของจริง: Argon2id + envelope encryption ต่อท่อครบวงจร
- **User Prompt Goal**: แทนที่ mockup/demo ของ "ห้องนิรภัยส่วนตัว" ที่ `/drive/` ด้วยการเข้ารหัสฝั่ง client จริง — Argon2id → KEK, per-file DEK envelope (AES-256-GCM), setup/unlock/upload/download/lock, idle timeout, audit ที่ไม่แตะเนื้อหา, ไม่มีการกู้ passphrase + เทสต์ครอบคลุม
- **Modified Code Paths**:
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\lib\vaultCrypto.js` (เขียนใหม่ทั้งไฟล์)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\screens\Vault.jsx` (เขียนใหม่ทั้งไฟล์)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\lib\api.js` (+ `apiFetchBytes`)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\lib\strings.js` (+15 คีย์ × 3 ภาษา)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\server\storage\vaultStore.js` **[NEW]**
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\server\app.js` **[NEW]**
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\server\db\migrations\001_vault_envelope.sql` **[NEW]**
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\tests\vaultCrypto.test.js` **[NEW]** · `tests\vaultApi.test.js` **[NEW]**
  - `server\routes\api.js`, `server\db\store.js`, `server\db\schema.sql`, `server\index.js`, `server\middleware\securityHeaders.js`, `package.json`
- **Obsidian Updates**: `[[00 - 🗺️ AEGIS System Overview]]`, `[[02 - 💾 IDEA1 AEGIS Drive LC]]`, `[[concepts/Mnemonic_Recovery_and_Zero_Knowledge]]`, `[[index]]`, `[[log]]`
- **Key Changes**:
  - **สิ่งที่เป็น mock อยู่จริงก่อนหน้านี้** (ไม่ใช่ทั้งจอ — การเข้ารหัสฝั่ง client ทำงานจริงอยู่แล้ว): `vault` เป็น object ในหน่วยความจำใน `store.js` (ตาราง `vault_meta`/`vault_blobs` ถูกประกาศไว้แต่ **ไม่เคยถูกใช้**), vault เดียวใช้ร่วมกันทุกผู้ใช้, salt/verifier เป็นค่า hardcode จาก passphrase เดโม่ (`aegis-vault-demo`) จึงไม่มีทางสร้าง vault ของตัวเองได้, **ไม่มี endpoint ดาวน์โหลดเลย**, ไม่มี idle timeout, ไม่มีเทสต์
  - **Argon2id แทน PBKDF2** (`hash-wasm`, m=64MiB/t=3/p=1) — memory-hard ต้าน GPU cracking; แลกด้วยการต้องเพิ่ม `'wasm-unsafe-eval'` ใน CSP (แคบกว่า `'unsafe-eval'` มาก: อนุญาตแค่คอมไพล์ WASM)
  - **Envelope 2 ชั้น**: DEK 256-bit สุ่มใหม่ทุกไฟล์ → เข้ารหัสเนื้อไฟล์ → ห่อ DEK ด้วย KEK; **ชื่อไฟล์ก็ถูกเข้ารหัสด้วย DEK** เซิร์ฟเวอร์จึงไม่รู้แม้แต่ชื่อ
  - **ciphertext ย้ายจาก TEXT ใน Postgres ไปเป็นไฟล์ `.aegisenc`** บน Storage Layer (`vault/` แยกจาก `uploads/`) — metadata อยู่ใน Postgres ต่อผู้ใช้
  - **บั๊กที่เจอระหว่างเขียนเทสต์แล้วแก้ 2 จุด**:
    1. เดิมเซิร์ฟเวอร์ **clamp พารามิเตอร์ KDF เงียบ ๆ** — แต่ verifier ถูกสร้างฝั่ง client ด้วยค่าเดิม พอเก็บค่าที่ถูกยกขึ้นแทน ผู้ใช้จะ **เปิด vault ตัวเองไม่ได้ตลอดกาลตั้งแต่วินาทีแรก** → เปลี่ยนเป็น **ปฏิเสธ (400)** ไม่แก้ค่าที่กุญแจผูกอยู่ด้วย
    2. passphrase ว่างทำให้ `hash-wasm` โยน `'Password must be specified'` ซึ่ง **แยกแยะได้จาก `'wrong-key'`** = บอกผู้โจมตีว่ายังไม่ถึงขั้นตอนตรวจกุญแจ → บังคับให้ล้มเหลวหน้าตาเดียวกันหมด
  - **เทสต์ 29 เคสผ่านทั้งหมด** (`npm test`, `node:test` ไม่เพิ่ม dependency): รหัสผิดถูกปฏิเสธ · รอบ unlock/lock/unlock · upload→download ได้ไบต์เดิมเป๊ะ (รวมไฟล์ว่าง/ไบนารี/200KB) · GCM จับการแก้ ciphertext ระดับบิต · **สแกนหา plaintext/ชื่อไฟล์/passphrase/กุญแจ ใน DB row + ไฟล์บนดิสก์ + server log (ดัก stdout/stderr ตลอดการรัน) + audit log → ไม่พบ** · Admin ดึง blob ของผู้ใช้อื่นไม่ได้ (404)
  - **ไม่มีการกู้ passphrase** ตามที่สั่ง — UI บังคับติ๊กยอมรับก่อนสร้าง vault และไม่มี endpoint รีเซ็ต
- **⚠️ ต้องทำก่อน deploy ขึ้นของจริง**: DB ที่สร้างไปแล้วต้องรัน `server/db/migrations/001_vault_envelope.sql` ด้วยมือ (schema.sql รันเฉพาะตอน initialize volume เปล่าครั้งแรก) — migration มี guard: ถ้าตารางเดิมมีแถวจะ `RAISE EXCEPTION` ไม่ลบเงียบ ๆ

## [2026-07-26] vibe-coding | Private Vault (IDEA1) — verification pass กับ Postgres จริง (ไม่ใช่ mock)
- **User Prompt Goal**: รันชุดทดสอบ vault กับ Postgres จริงตามระเบียบเดียวกับ verification pass ของ IDEA2 — ยก compose, ทดสอบ schema.sql บน volume เปล่า + migration guard, รัน 29 เทสต์เดิมกับ DB จริง, เพิ่มเทสต์ round-trip + ตรวจแถวจริง, grep หา plaintext ในฐาน/log จริง, รายงาน divergence
- **Modified Code Paths**:
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\server\routes\api.js` (await audit writes ใน vault routes ทั้ง 7 จุด)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\server\db\store.js` (`__resetVaultMemory` → `__resetVaultForTests` รองรับสองโหมด, ใช้ DELETE ไม่ใช่ TRUNCATE)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\tests\vaultApi.test.js` (รองรับ `TEST_DATABASE_URL`)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\tests\vaultPostgres.test.js` **[NEW]** — 9 เคสที่อ่านตารางด้วย SQL ดิบ
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\tests\helpers\seedRealVault.mjs` **[NEW]**
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\package.json` (`--test-concurrency=1`)
  - `c:\Users\User\AEGIS_System\docs\auth-test.md` (หัวข้อ 15 — ขั้นตอนตรวจสอบซ้ำได้)
- **Obsidian Updates**: `[[02 - 💾 IDEA1 AEGIS Drive LC]]`, `[[log]]`
- **Key Changes / ผลการตรวจ**:
  - **38/38 ผ่านกับ Postgres จริง** (29 ผ่าน + skip 9 ในโหมด in-memory) — ฐานทดสอบยกด้วย project name แยก (`-p aegisvaulttest`) ไม่แตะ volume ของ dev
  - **schema.sql บน volume เปล่า**: ได้ตาราง vault โครง envelope ถูกต้อง ไม่มีคอลัมน์ name/mime/key
  - **migration guard ทำงานครบทั้งสามทาง**: มีแถวใน `vault_blobs` → RAISE EXCEPTION + rollback (exit 3, ข้อมูลอยู่ครบ) · มีแถวใน `vault_meta` → RAISE EXCEPTION · ว่างทั้งคู่ → COMMIT และผลลัพธ์ **เท่ากับ schema.sql ทุกคอลัมน์**
  - **grep ของจริง** (ไม่ใช่ assertion): `pg_dump` ทั้งฐาน · ทุกคอลัมน์ข้อความทุกตาราง (112 ค่า) · **Postgres log เปิด `log_statement=all` + `log_parameter_max_length=-1`** · ไฟล์ `.aegisenc` · application log → **0 hit ทุกช่องทาง** พร้อม control check ยืนยันว่า grep ทำงานจริง
  - หลักฐานเด่น: Postgres จด bind parameter ครบทุกตัว แต่ `$7` (ชื่อไฟล์) เป็น ciphertext และ `$2` เป็น UUID ทึบ
- **⚠️ DIVERGENCE ที่เจอ (mock ผ่าน แต่ DB จริงไม่ผ่าน) — บั๊กจริง 1 ข้อ**:
  - **`auditAct()` เป็น fire-and-forget**: โหมด in-memory เขียน `memAudit.unshift()` แบบ synchronous จึงเห็นทันทีเสมอ แต่กับ Postgres เป็น `INSERT` ที่ไม่ถูก `await` → **แข่งกับ HTTP response** ทำให้ 2 เคสของ audit ล้ม (หา `VAULT_UNLOCK` ไม่เจอ / เจอผลของเคสก่อนหน้า)
  - ร้ายแรงเพราะ vault เป็น zero-knowledge — **audit คือ visibility เดียวที่เซิร์ฟเวอร์มี** การตอบ 204 ก่อนแถวลงจริงคือการโกหก client (โดยเฉพาะ `/vault/unlock-attempt` ที่ "มีอยู่เพื่อเขียน audit อย่างเดียว")
  - แก้โดย `await auditAct(...)` ในเส้นทาง vault ทั้ง 7 จุด (`recordAudit` จับ error ของตัวเองอยู่แล้ว จึงไม่เพิ่ม failure path ใหม่)
  - **ยังไม่ได้แก้**: เส้นทางที่ไม่ใช่ vault (FILE_UPLOAD/SHARE_CREATE/USER_CREATE ฯลฯ อีก ~14 จุด) ยังเป็น fire-and-forget เหมือนเดิม — อยู่นอกขอบเขต prompt นี้ แต่มีความเสี่ยงเดียวกัน
- **สิ่งที่เป็น test artifact ไม่ใช่บั๊กโปรดักชัน**:
  - รันไฟล์เทสต์ขนานกัน → ล้ม 6 เคส เพราะสองไฟล์ใช้ฐานเดียวกันและต่างล้างตารางใน `beforeEach` → ตั้ง `--test-concurrency=1`
  - helper เดิมใช้ `TRUNCATE` → `permission denied` เพราะ `drive_app` มีแค่ DML (ตรงตามหัวข้อ 11/14 ของ `auth-test.md`) → เปลี่ยนเป็น `DELETE` ให้เทสต์ทำงานใต้สิทธิ์เท่ากับแอปจริง

## [2026-07-26] vibe-coding | IDEA1 Drive_LC — แก้ dropdown ช่องค้นหาค้างทับทุกจอ + ทำช่องค้นหาให้เป็น "ต่อจอ"
- **User Prompt Goal**: dropdown ผลการค้นหาบนแถบบนเปิดแล้วปิดไม่ลง ค้างทับเนื้อหาทุกจอ — ให้แก้ต้นเหตุทั้งสามข้อ (ไม่มี click-outside / state ไม่ถูกรีเซ็ตตอนเปลี่ยนจอ / stacking), ออกแบบ panel ใหม่, และตัดสินว่าจอไหน "ควร" มีช่องค้นหาระดับระบบจริง ๆ
- **Modified Code Paths**:
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\components\GlobalSearch.jsx` **[NEW]** — `<GlobalSearch />` + `<SearchUnavailable />`
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\App.jsx` (ถอด `searchOpen`/`query`/`searchRef`/⌘K listener/`matches` ออกทั้งหมด, เพิ่มตาราง `SCREEN_SEARCH`, ยิง `/api/users` เฉพาะเมนูที่มี `access`)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\screens\Access.jsx` (ตัวกรองชื่อ/username ของตารางผู้ใช้เอง + แยก empty state สองแบบ)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\lib\strings.js` (คีย์ใหม่ครบ 3 ภาษา: `searchSec*`, `searchNoRecent`, `searchNoResults`, `searchJumpTo`, `searchUnavailable`, `accessFilter*`; เลิกใช้ `searchRecent`)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\index.css` (`@keyframes search-pop` — 120ms ขาเข้าอย่างเดียว)
- **Obsidian Updates**: `[[02 - 💾 IDEA1 AEGIS Drive LC]]` (หัวข้อ 7 ใหม่ใน Implemented Features + Codebase Paths), `[[log]]`
- **Key Changes**:
  - **ต้นเหตุจริงคือความเป็นเจ้าของ state ไม่ใช่ CSS**: `searchOpen` ถูกยกไปไว้ที่ `App.jsx` แต่ไม่มีใครสั่งปิด — ไม่มี click-outside, ไม่มี Escape, ไม่รีเซ็ตตอนเปลี่ยนจอ ย้ายกลับเข้า component แล้วปิดครบสี่ทาง (คลิกนอกกรอบ / Escape / เปลี่ยนจอ / เลือกผลลัพธ์) listener ผูกเฉพาะตอนเปิดและถอดใน cleanup
  - **ข้อ C (stacking) ตรวจแล้วไม่ใช่บั๊ก**: panel เดิมเป็น `absolute` ใน parent ที่ `relative` อยู่แล้วและถูก render จุดเดียว — อาการ "ทับซ้อน" มาจากการที่มันไม่เคยปิดล้วน ๆ ตอนนี้ย้ายมาใช้ `--z-dropdown`/`--elev-2` ให้ตรงระบบแทน `z-50`/`shadow-xl`
  - **ไม่มี exit animation โดยเจตนา** — การ animate ตอนปิดคือที่มาคลาสสิกของ dropdown ค้าง
  - **panel ใหม่**: กลุ่ม `FILES`/`PEOPLE`/`ACTIONS`, empty state แบบกะทัดรัด `RECENT` + `SUGGESTED` (ไม่ใช่ illustrated empty state เต็มหน้าในกล่อง 380px), `↑↓`/`Enter`, ตัวหนาเฉพาะช่วงที่ตรง, `max-height: 60vh`
  - **`SCREEN_SEARCH` = config ต่อจอ**: Dashboard/Files/Uploads ได้ช่องค้นหา · **Vault ได้ช่องเส้นประกดไม่ได้** พร้อมเหตุผล (ciphertext ค้นไม่ได้ — ช่องที่ดูใช้ได้แต่ค้นไม่เจอคือการโกหกผู้ใช้) · Shares/Snapshots/Storage/Audit/Access/Settings ไม่มีเลย เพราะมีตัวกรองของตัวเองที่แม่นกว่า
  - **RBAC ของกลุ่ม PEOPLE ตัดสินจากเมนูที่เซิร์ฟเวอร์ filter มา** (`nav` มี `access` ไหม) ไม่ hardcode ชื่อ role ฝั่ง client — `requireRole(ADMIN)` ที่ endpoint ยังเป็นด่านจริงเหมือนเดิม
  - **ตรวจแล้ว**: `vite build` ผ่าน · `npm test` 29 ผ่าน 0 ล้ม (skip 9 เพราะไม่ได้ตั้ง `TEST_DATABASE_URL`) · rebuild คอนเทนเนอร์ `drive` แล้วยืนยันว่าโค้ดใหม่อยู่ใน bundle ที่เสิร์ฟจริงที่ `http://localhost/drive/`
- **⚠️ ยังค้าง / ไม่ได้ทำในรอบนี้**:
  - **ยังไม่ได้คลิกทดสอบในเบราว์เซอร์จริง** — เครื่องมือขับเบราว์เซอร์ไม่พร้อมใช้ในเซสชันนี้ พฤติกรรมทั้งหมดยืนยันด้วยการอ่านโค้ด + build + test เท่านั้น
  - **ธีมเริ่มต้นเป็น dark** (`App.jsx`: `localStorage.getItem('aegis_theme') || 'dark'`) ขัดกับดีไซน์ซิสเท็ม "Precision Light" ที่ควรเริ่มด้วยพื้นเทาอ่อน/การ์ดขาว — ตั้งใจไม่แก้ในรอบนี้ตามที่ผู้ใช้สั่ง (เป็นงานคนละก้อน)
  - คลิกผลลัพธ์ที่เป็นไฟล์ = กระโดดไปจอ Files แต่**ยังไม่ไฮไลต์/เปิดไฟล์นั้น** เพราะจอ Files ยังไม่มีทางรับ "ไฟล์ที่ถูกเลือกจากภายนอก"

## [2026-07-26] vibe-coding | IDEA1 Drive_LC — ตรวจสอบ wiring ของช่องค้นหาต่อจอด้วยเบราว์เซอร์จริง + เติมตัวกรองที่ยังขาด
- **User Prompt Goal**: ผู้ใช้รายงานว่าช่องค้นหายังโผล่ทุกจอ ขัดกับรายงานรอบก่อน — ให้หาสาเหตุก่อนว่าทำไม config ไม่มีผล แล้วค่อยบังคับใช้กฎ และ**ยืนยันด้วยการเปิดทั้ง 10 จอในเบราว์เซอร์จริง** ไม่ใช่แค่อ่านโค้ด
- **Modified Code Paths**:
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\screens\Shares.jsx` (ตัวกรองตาราง: scope / status / expiry + empty state แยก "ยังไม่มีลิงก์" ออกจาก "ตัวกรองไม่ตรง" + ป้ายนับ `n / total`)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\screens\Audit.jsx` (เพิ่มตัวกรอง **ช่วงเวลา** 24h/7d/30d ให้ครบ date-range + actor + action + result, และข้อความเมื่อไม่มีแถวตรงตัวกรอง)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\lib\strings.js` (คีย์ใหม่ครบ 3 ภาษา: `filterRange`, `filterScope`, `filterStatus`, `filterActive`, `filterExpiresWithin`, `emptyNoAuditFiltered`, `emptyNoSharesFiltered`)
- **Obsidian Updates**: `[[02 - 💾 IDEA1 AEGIS Drive LC]]`, `[[log]]`
- **Key Changes / ผลการตรวจ**:
  - **สาเหตุที่รายงานรอบก่อนกับสิ่งที่ผู้ใช้เห็นไม่ตรงกัน: bundle ค้างในแท็บที่เปิดอยู่ (ข้อ 4) ไม่ใช่ปัญหา wiring** — พิสูจน์ทีละข้อ: (1) `<GlobalSearch />` ถูก render จุดเดียวใน `App.jsx` มีเงื่อนไขจริง ไม่ได้อยู่ใน TopBar (2) `TopBar.jsx` ไม่มี input ค้นหาเลย ทั้งโปรเจกต์มี input ค้นหาระดับระบบตัวเดียว (3) คอนเทนเนอร์ถูก rebuild หลังแก้โค้ดจริง และ**เจอ `uj={dashboard:"global",files:"global",uploads:"global",vault:"blocked"}` พร้อม `uj[p]==="global"&&...` อยู่ใน bundle ที่เสิร์ฟจริง** (4) `index.html` ตอบ `Cache-Control: public, max-age=0` + ETag แต่**แอปเป็น SPA — คลิกเปลี่ยนจอไม่โหลด HTML ใหม่** แท็บที่เปิดค้างไว้ก่อน rebuild จึงรัน bundle เก่าทั้งเซสชัน ต้อง hard-reload
  - ยืนยันว่า `/drive/assets/<bundle เก่า>` และ `/drive/sw.js` ตอบ 556 ไบต์เท่ากับ `index.html` = SPA fallback → **ไม่มี service worker และไม่มี bundle เก่าค้างบนเซิร์ฟเวอร์**
  - **ยืนยันด้วยเบราว์เซอร์จริงแล้ว (playwright-core + chromium, 1440×900, ล็อกอิน `admin` เพื่อให้เห็นครบ 10 จอ)**: **10/10 ผ่าน — มีเพียง 3 จอที่แสดงช่องค้นหา (dashboard/files/uploads)**, Vault ได้ช่องเส้นประข้อความ "ค้นหาไม่ได้ — ห้องนิรภัยส่วนตัวถูกเข้ารหัส", อีก 6 จอไม่มี input ใน header เลย
  - **ทดสอบพฤติกรรม dropdown บนเบราว์เซอร์จริง**: คลิกนอกกรอบ → ปิด · Escape → ปิด · เปลี่ยนจอขณะเปิดอยู่ → ปิด · `↓`+`Enter` → กระโดดจอ ปิด และล้างคำค้น (`query=''`)
  - **ทดสอบกลุ่มผลลัพธ์กับข้อมูลจริง** (อัปโหลดไฟล์เข้า Data Lake จริงผ่าน UI): `RECENT` ขึ้นไฟล์ + ขนาด + เวลา · ค้น `aegis` → กลุ่ม `ไฟล์` · ค้น `admin` → กลุ่ม `ผู้คน` (แสดงเฉพาะ Admin ตาม RBAC)
  - **ช่องว่างที่เจอตอนตรวจตามตาราง §1 และแก้ในรอบนี้**: **Shares ไม่มีตัวกรองตารางเลย** และ **Audit ไม่มีตัวกรองช่วงเวลา** — ทั้งสองจอถูกระบุในบรีฟว่าต้องมีของตัวเองมาแทนช่องค้นหากลาง เติมแล้วทั้งคู่ พิสูจน์การทำงานจริง: สร้างลิงก์แชร์ผ่าน UI → แถบตัวกรองโผล่ (select 3→6) → เลือก status=หมดอายุ → แถว 1→0 ป้ายนับเป็น `0 / 1` และขึ้นข้อความ "ไม่มีลิงก์ที่ตรงกับตัวกรอง"
  - `npm test` 29 ผ่าน / 0 ล้ม (skip 9 เพราะไม่ได้ตั้ง `TEST_DATABASE_URL`) · `docker compose up -d --build` ยกใหม่ทั้ง stack ทุกคอนเทนเนอร์ healthy
- **⚠️ ข้อมูลทดสอบที่ยังค้างอยู่ในสแตก dev**: ไฟล์ `aegis-verify-sample.txt` (1.2 KB) และลิงก์แชร์ 1 รายการที่สร้างระหว่างตรวจสอบ — ลบได้จากจอ Files / Shares ถ้าไม่ต้องการ
- **⚠️ ยังค้างเหมือนเดิม**: ธีมเริ่มต้นยังเป็น dark (`App.jsx`) ขัดกับ "Precision Light" — ตั้งใจไม่แตะตามที่ผู้ใช้สั่ง

## [2026-07-26] vibe-coding | IDEA1 Drive_LC — Global Search: กลับนโยบายเป็น "ทุกจอ" · Vault disabled แบบมีเหตุผล · ยืนยัน 131/131 ด้วยเบราว์เซอร์จริง
- **User Prompt Goal**: แก้ช่องค้นหาใน header ของ IDEA1 ตามลำดับ 4 ข้อ — (1) dropdown ไม่ยอมปิด (2) dropdown ทับปุ่มบนแถบเครื่องมือ (3) ต้อง **disabled เฉพาะจอ Vault** พร้อมทูลทิป และ**พิสูจน์ว่า backend ไม่ยอมเสิร์ฟเนื้อหา vault ผ่านการค้นหา แม้ผู้ใช้จะ bypass `disabled` ด้วย devtools** (4) empty state ให้ตรงแพตเทิร์นจอ Files + keyboard nav — และให้**รายงานว่าตรวจจอไหนจริงบ้าง ไม่ใช่เดาว่าจอที่เหลือได้รับผลตามกันไป**
- **Modified Code Paths**:
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\components\GlobalSearch.jsx` (prop `disabled`, ฉากรับคลิก, geometry ของ panel, `EmptyState`, ลบ `SearchUnavailable`)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\App.jsx` (`SCREEN_SEARCH` → `SEARCH_DISABLED_SCREENS`, render ช่องค้นหาแบบไม่มีเงื่อนไข)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\lib\strings.js` (คีย์ใหม่ครบ 3 ภาษา: `searchUnavailableVault`, `searchNoResultsHint`)
- **Obsidian Updates**: `[[02 - 💾 IDEA1 AEGIS Drive LC]]`, `[[concepts/Mnemonic_Recovery_and_Zero_Knowledge]]`, `[[log]]`
- **Key Changes**:
  - **ข้อ 1 (dropdown ไม่ปิด) ถูกแก้ไปแล้วตั้งแต่รอบก่อน** — click-outside / Escape / effect ผูกกับ `screen` มีครบอยู่แล้วใน `GlobalSearch.jsx` (ไฟล์นี้ยัง **untracked ใน git** = งานที่ยังไม่ commit) **บั๊กที่เหลืออยู่จริงคนละตัว**: `mousedown` ปิด panel ก็จริง แต่**คลิกนั้นทะลุไปสั่งงานปุ่มที่ถูกบังอยู่ข้างล่าง** — คลิกเพื่อปิดตรงปุ่ม "อัปโหลด" แล้วอัปโหลดทำงานจริง แก้ด้วย **ฉากรับคลิกโปร่งใส `fixed inset-0` ที่ `z = --z-dropdown - 1`**
  - **ข้อ 2 (layout)**: ยึดใต้ input เท่านั้น `top-[calc(100%+6px)] right-0 w-full` + `maxHeight: min(60vh, 420px)` + `--z-dropdown`(10) < `--z-modal`(50)
  - **ข้อ 3 (นโยบายต่อจอ) = กลับนโยบายของรอบก่อน**: รอบที่แล้วสรุปว่าช่องค้นหาควรมีแค่ 3 จอ (`SCREEN_SEARCH`) **ผู้ใช้สั่งให้มีทุกจอ** ตอนนี้ `<GlobalSearch />` ถูก render จุดเดียวแบบไม่มีเงื่อนไข และ **Vault ได้ input ตัวเดียวกันที่ `disabled`** (ไม่ใช่ `<div>` ปลอมแบบเดิม) — `SearchUnavailable` ถูกลบทิ้ง · ตัวกรองเฉพาะจอที่เติมไว้รอบก่อน (Shares/Audit/Access) **ยังอยู่ครบ ไม่ได้ถอด**
  - **ข้อ 3 (ความปลอดภัย) — ยืนยันแล้วว่าเป็นการรับประกันเชิงโครงสร้าง ไม่ใช่แค่ attribute**: ทั้งระบบ**ไม่มี endpoint ที่รับคำค้นเลย** (`grep search routes/api.js` = 0) การค้นหาเป็น client-side filter บน `/api/files` + `/api/users` · `listFiles()` = `files.filter(f => !f.vault)` คนละตารางกับ `vault_blobs` · `vault_blobs` **ไม่มีคอลัมน์ `name`/`mime`/`type` ตั้งแต่ schema** · ชื่อไฟล์ที่ถอดรหัสแล้วอยู่ใน state ของ `Vault.jsx` ไม่เคยขึ้นถึง `App.jsx` · เสริมชั้นใน component: `sections` คืน `[]` เมื่อ `disabled` และ panel ผูกกับ `open && !disabled` · **ยิง `?q=` ใส่ทุก endpoint แล้ว: `/api/search` 404 · `/api/files?q=secret` คืนรายการเต็ม 9 แถวเหมือนเดิม (เมิน q) · `/api/vault?q=a` คืนแต่ envelope**
  - **ข้อ 4**: empty state ใช้ `<EmptyState icon={SearchX} …>` **ตัวเดียวกับจอ Files** · keyboard nav (`↑↓`+`Enter`) มีอยู่แล้วและยืนยันว่าทำงานจริง
  - **⌘K ถูกซ่อนและปิดรับคีย์ลัดบนจอ Vault** — ป้ายที่กดแล้วไม่เกิดอะไรคือคำสัญญาที่ผิด
- **✅ วิธีตรวจและผลลัพธ์ (131/131 ผ่าน 0 ล้ม)**:
  - **ขับ Chrome จริงผ่าน CDP โดยไม่ต้องติดตั้ง playwright** — ใช้ `WebSocket` ที่มากับ Node 24 คุยกับ `--remote-debugging-port` โดยตรง (สคริปต์ `cdp.mjs` + `test-search.mjs` ในโฟลเดอร์ scratchpad ของเซสชัน)
  - **ตรวจครบ 10/10 จอทีละจอจริง** (dashboard · files · vault · uploads · shares · snapshots · storage · audit · access · settings) ไม่ได้เดาว่าจอที่เหลือได้ผลตามกัน
  - ต่อจอที่ใช้งานได้ 9 จอ: เปิดเมื่อพิมพ์ · panel อยู่ใต้ input · กว้างไม่เกิน input · `z=10` · **คลิกนอกกรอบปิดโดยไม่สั่งงานปุ่มที่ถูกบัง** · `Escape` ปิด · `↑↓` เลื่อนจริง (`gs-opt-0→gs-opt-1`, 5 ผลลัพธ์) · `Enter` กระโดดไปจอ Files + ปิด + ล้างคำค้น · empty state ไอคอน+หัวข้อ+คำอธิบาย · เปลี่ยนจอขณะเปิดอยู่ → ไม่ค้าง
  - **Vault**: `disabled=true` · `opacity 0.55` · ทูลทิปตรงตัวอักษร · **ถอด `disabled` ใน devtools แล้วพิมพ์ → `panel=false, options=0`**
  - `npm test` 29 ผ่าน / 0 ล้ม (skip 9 เพราะไม่ได้ตั้ง `TEST_DATABASE_URL`) · `vite build` ผ่าน
- **⚠️ บทเรียนเรื่องการตั้งสภาพแวดล้อมทดสอบ (สำคัญสำหรับรอบหน้า)**:
  - **vite dev proxy ล็อกอินไม่ผ่าน** — `changeOrigin: true` เขียนทับ header `Host` เป็น `127.0.0.1:8001` ขณะที่ `Origin` ยังเป็น `localhost:5175` ชน **ชั้นที่ 2 ของ CSRF** (`middleware/csrf.js`: Origin ต้องตรงกับ Host) → `403` แล้ว UI ขึ้นว่า "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" ซึ่งชวนเข้าใจผิด **ต้องทดสอบแบบ single-origin** (ให้ Express เสิร์ฟทั้ง dist และ `/api`)
  - **`base: '/drive/'` กับ `express.static(DIST)` ที่ mount ที่ root ไม่ตรงกัน** — bundle ขอ `/drive/assets/…` แต่ static เสิร์ฟที่ `/assets/…` จึงตกไป SPA fallback ได้ `index.html` กลับมาเป็น JS module → หน้าขาว ตอนทดสอบเลี่ยงด้วยการ build ชั่วคราวด้วย `--base=/` **แล้ว build กลับเป็น `/drive/` เรียบร้อยแล้ว** (ยืนยัน `dist/index.html` ชี้ `/drive/assets` ครบ) ⚠️ **ควรตรวจว่า production ผ่าน nginx ทำงานได้จริงหรือไม่ — comment ใน `vite.config.js` บอกว่า nginx forward `/drive/*` เข้ามา "โดยไม่ตัด prefix" ซึ่งจะชนกับ static ที่ mount ที่ root** (ไม่ได้แตะในรอบนี้ อยู่นอกขอบเขตที่ผู้ใช้สั่ง)
- **⚠️ ยังค้างเหมือนเดิม**: ธีมเริ่มต้นยังเป็น dark (`App.jsx`) ขัดกับ "Precision Light" · คลิกผลลัพธ์ที่เป็นไฟล์ยังกระโดดไปจอ Files เฉย ๆ ไม่ไฮไลต์ไฟล์นั้น

## [2026-07-26] vibe-coding | IDEA1 Drive_LC — แก้ CSRF/proxy ที่แสดงเป็น "รหัสผ่านผิด" + แยกเส้นทาง error ทั้งเชน + ตรวจ nginx จริงทั้งสองชุด
- **User Prompt Goal**: (1) แก้ vite proxy ที่ทำให้ login ใน dev ตอบ 403 ให้ล็อกอินผ่าน proxy ได้จริงแบบที่ผู้ใช้เจอ ไม่ใช่เลี่ยงไป single-origin (2) **แยกเส้นทาง error**: CSRF ต้องมีข้อความของตัวเอง และ**ห้ามถูกแสดงเป็นความล้มเหลวของการยืนยันตัวตนที่ไหนก็ตามในจอ Login** พร้อม**ไล่หาแบบแผนเดียวกันทั้งแอป** เพราะเป็นครั้งที่สองแล้ว (3) **ตรวจว่าปัญหา `base:'/drive/'` vs SPA fallback มีจริงไหมกับ nginx config ที่ใช้ deploy จริง**
- **Modified Code Paths**:
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\vite.config.js` (`changeOrigin: true` → `false`)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\server\middleware\csrf.js` (เพิ่ม `CSRF_ORIGIN_MISMATCH` / `CSRF_TOKEN_INVALID`)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\lib\api.js` (403+`code` ขึ้นต้น `CSRF_` → `errorKind:'csrf'`)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\lib\auth.js` (ส่งต่อ `errorKind` ไม่ทิ้ง)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\screens\Login.jsx` (`error:boolean` → `errorKey` + `loginErrorKey()`)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\screens\Vault.jsx` (แยก `wrong-key` ออกจากความล้มเหลวของ WASM/สภาพแวดล้อม)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\src\lib\strings.js` (คีย์ใหม่ครบ 3 ภาษา: `loginBlockedCsrf`, `loginNetwork`, `loginTimeout`, `loginServerError`, `vaultUnlockUnavailable`)
- **Obsidian Updates**: `[[02 - 💾 IDEA1 AEGIS Drive LC]]`, `[[01 - 🚪 HUB-AEGIS Entry]]`, `[[concepts/OWASP_Security_Defense]]`, `[[log]]`
- **Key Changes**:
  - **ข้อ 1 — แก้แล้ว**: `changeOrigin: false` · เหตุผลที่ค่านี้ "ถูกกว่า" ไม่ใช่แค่ "ทำให้ผ่าน": nginx **ทั้งสองชุด** ใช้ `proxy_set_header Host $host` (คงค่า Host เดิม) ดังนั้น `false` คือค่าที่ทำให้ dev เจอเงื่อนไข CSRF **ชุดเดียวกับ production** ส่วน target เป็น Express ธรรมดาไม่มี vhost routing จึงไม่มีอะไรพึ่ง `changeOrigin`
  - **ข้อ 2 — แก้แล้ว ทั้งเชน**: csrf.js ใส่ `code` (แบบแผนเดียวกับ `PASSWORD_RESET_REQUIRED` ที่มีอยู่แล้ว) → api.js แปลงเป็น `errorKind:'csrf'` → auth.js ส่งต่อ → Login.jsx แม็ปด้วย `loginErrorKey()` · **กฎ: `loginFailed` ใช้ได้เฉพาะ 401 (และ 429)** เท่านั้น
  - **ผล audit หาแบบแผนเดิมทั้งแอป**: 🔴 เจอจริง **1 จุด** = `Vault.jsx tryUnlock()` (Argon2/WASM ล้มเหลว → เคยบอกว่า "กุญแจนี้เปิดห้องนิรภัยนี้ไม่ได้") แก้แล้ว · ✅ `deriveKek()` ที่ normalize passphrase ว่างเป็น `wrong-key` **ถูกต้องแล้ว ไม่แก้** (เหมารวมโดยเจตนาเพื่อความปลอดภัย และเป็นเรื่องของกุญแจจริง) · ✅ `Files.jsx`/`Access.jsx` ใช้ `actionFailed` ที่ไม่ได้อ้างเรื่องสิทธิ์/รหัสผ่าน จึงไม่ติดแบบแผนนี้ · ✅ `useApi()` เป็น GET ล้วน CSRF ไม่แตะ
  - **ข้อ 3 — ผลตรวจ: "ทั้งจริงและไม่จริง" ขึ้นกับว่าใช้ nginx ชุดไหน** (รัน nginx จริงทดสอบทั้งสองชุด)
    - ✅ **`gateway/nginx.conf` (สแตก localhost) = ไม่มีปัญหา** เพราะมี `rewrite ^/drive/?(.*)$ /$1 break;` ตัด prefix: asset ได้ MIME ถูกต้อง (`application/javascript` 922KB) · `POST /drive/api/login` → **200** · `/drive/files`, `/drive/some/deep/route` → `200 text/html` (fallback ถูกต้อง) · CSP มาชั้นเดียว
    - 🔴 **`HUB-AEGIS_Entry/nginx.conf` (production) = พังทั้งแอป** เพราะ **ไม่ตัด prefix** แต่ `server/app.js` mount ทุกอย่างที่ root: asset ทุกตัวตอบ **`200 text/html` 556B** (index.html แทน JS → จอขาว) · **`POST /drive/api/login` → `404`** ล็อกอินไม่ได้เลย · `/drive/healthz` ตอบ HTML แทน JSON
    - 🔴 **เจอเพิ่มระหว่างตรวจ: CSP ซ้อนสอง header** — ของ Express มี `'wasm-unsafe-eval'` แต่ของ HUB nginx (ระดับ server, สืบทอดลง `location /drive`) **ไม่มี** เบราว์เซอร์บังคับใช้ส่วนที่เข้มที่สุดของทั้งคู่ → **Argon2id ของ Private Vault รันไม่ได้ใน production** ซึ่งเป็น trigger ที่ทำให้บั๊กข้อ 2 ใน Vault แสดงผลผิดพอดี (บอกว่า "กุญแจผิด" ทั้งที่กุญแจถูก)
    - **ยังไม่แก้ข้อ 3 โดยเจตนา** — ผู้ใช้สั่งให้ "ตรวจและรายงาน" และการแก้เป็นการตัดสินใจเชิงสถาปัตยกรรม deploy (ตัด prefix ที่ nginx เหมือน gateway **หรือ** ให้ Express mount ใต้ `BASE_PATH`) บันทึกทางเลือกไว้ครบใน `[[01 - 🚪 HUB-AEGIS Entry]]`
- **✅ วิธีตรวจ**: CDP + Chrome จริงผ่าน **vite dev proxy** (ไม่ใช่ single-origin) — 7/7 ผ่าน รวม **regression test ที่ rewrite header `Origin` ผ่าน CDP `Fetch` domain เพื่อจำลองบั๊กเดิมเป๊ะ ๆ**: ใส่รหัส**ที่ถูกต้อง** + Origin ไม่ตรง → UI ขึ้น "คำขอถูกปฏิเสธ — ต้นทางไม่ตรงกัน กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง" (ไม่ใช่ "รหัสผ่านไม่ถูกต้อง") · รหัสผิดจริง → ยังขึ้น "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" เหมือนเดิม · `npm test` 29 ผ่าน 0 ล้ม · `vite build` ผ่าน · `docker compose up -d --build` ทุกคอนเทนเนอร์ healthy
- **⚠️ ยังค้าง**: บั๊ก nginx production ข้างบน (ข้อ 3) · ธีมเริ่มต้นยังเป็น dark ขัดกับ "Precision Light" · จอ Login ยังมี gradient text ที่ผิดหลักดีไซน์ (hook เตือน — ของเดิม ไม่ได้แตะในรอบนี้)

## [2026-07-26] vibe-coding | HUB nginx (production) — แก้ routing /drive + ทำให้ CSP เหลือชั้นเดียว · ยืนยันด้วย config ตัวจริง
- **User Prompt Goal**: แก้ `HUB-AEGIS_Entry/nginx.conf` โดยใช้ `gateway/nginx.conf` เป็นแม่แบบ — (1) เติม rewrite ตัด prefix ที่ `location /drive` **ห้ามเพิ่ม BASE_PATH ใน server/app.js** (2) ให้ nginx เป็นเจ้าของ CSP ของ `/drive` ชั้นเดียวและมี `wasm-unsafe-eval` **ห้ามใส่ให้ location อื่น** (3) **ยืนยันกับ config production ตัวจริง ไม่ใช่การจำลอง** ครบทุกข้อรวมถึงปลดล็อก vault จริง (4) ตรวจ regression ของ IDEA2 (5) **รายงาน header/status ก่อน-หลังของจริง ไม่ใช่แค่ผ่าน/ไม่ผ่าน**
- **Modified Code Paths**:
  - `c:\Users\User\AEGIS_System\HUB-AEGIS_Entry\nginx.conf` (แก้เฉพาะ `location /drive` → `location = /drive` redirect + `location /drive/` พร้อม rewrite, `proxy_hide_header` ×6, `add_header` ×6)
  - **ไม่แตะ** `IDEA1-AEGIS_Drive_LC/server/app.js` (ตามที่สั่ง) และ **ไม่แตะ** `location /monitor` เลย
- **Obsidian Updates**: `[[01 - 🚪 HUB-AEGIS Entry]]`, `[[02 - 💾 IDEA1 AEGIS Drive LC]]`, `[[03 - 📹 IDEA2 AEGIS Monitor]]`, `[[log]]`
- **วิธียืนยัน (ตอบข้อ "ต้องเป็น config จริง ไม่ใช่จำลอง")**: สร้าง docker network `subnet=192.168.10.0/24` แล้วผูก **IP จริง** `192.168.10.11`/`.12` ให้คอนเทนเนอร์ drive/monitor + ออก self-signed cert วางที่ path ที่ config ระบุ → **mount ไฟล์ `nginx.conf` ตัวจริงเข้าคอนเทนเนอร์แบบไม่แก้แม้แต่บรรทัดเดียว** (`md5sum` ในคอนเทนเนอร์ = `Get-FileHash` ของไฟล์ในรีโป ตรงกันทั้งก่อนและหลังแก้) · `nginx -t` ผ่าน
- **Key Changes / ผลวัดก่อน-หลัง**:
  - `/drive/assets/index-*.js`: **`200 text/html` 556B → `200 application/javascript` 922,922B**
  - `/drive/assets/index-*.css`: **`200 text/html` 556B → `200 text/css` 122,417B**
  - `POST /drive/api/login` (รหัสถูก): **`404 text/html` → `200 application/json` 940B**
  - `/drive/healthz`: **`200 text/html` 556B → `200 application/json`** `{"service":"aegis-drive","ok":true,"db":"postgres"}`
  - `/drive/files`, `/drive/some/deep/route`: `200 text/html` 556B **ทั้งก่อนและหลัง** (SPA fallback ถูกต้อง — แต่ก่อนหน้านี้ไร้ความหมายเพราะ asset โหลดไม่ขึ้น)
  - `/drive` (ไม่มี slash): เพิ่ม **`301` → `/drive/`**
  - **CSP: 2 header → 1 header** และมี `'wasm-unsafe-eval'` · security header อื่นจาก **ซ้ำ 2 ชุด → 1 ชุด** ทุกตัว
  - **⚠️ กฎ nginx ที่ต้องรู้**: location ที่มี `add_header` แม้ตัวเดียวจะ **ไม่สืบทอด** `add_header` จาก server block เลย จึงต้องประกาศครบทั้ง 6 ตัวใน `/drive/` (ไม่งั้นจะเหลือแต่ของ Express = หลุดการรับประกันของ nginx) — เลย `proxy_hide_header` ทั้ง 6 ตัวด้วยเพื่อให้เหลือชั้นเดียวจริง ๆ
  - **ปลดล็อก Vault สำเร็จ end-to-end ผ่าน config ตัวจริง** (Chrome จริงผ่าน CDP บน `https://localhost/drive/`): SPA boot ได้ · `WebAssembly.compile()` ผ่าน · สร้าง vault (Argon2id m=64MiB) · ล็อก · **ปลดล็อกสำเร็จ ไม่ขึ้น `vaultUnlockUnavailable` และไม่ขึ้น "กุญแจผิด"** — 7/8 เช็คผ่าน
  - **ข้อ 4 regression**: `diff` response ของ `/monitor/*` และหน้า HUB `/` ก่อน-หลัง → **เหมือนกันทุกไบต์**
- **⚠️ เจอเพิ่มระหว่างตรวจ (ยังไม่แก้ อยู่นอกขอบเขต)**:
  - 🔴 **IDEA2/Monitor พังแบบเดียวกันเป๊ะใน production** — `/monitor/assets/index-*.js` → `200 text/html` 585B (จอขาว) · **ห้ามแก้ด้วยการเติม rewrite เฉย ๆ**: `gateway/nginx.conf` มี `location /monitor/internal/ { return 404; }` แต่ **config ของ HUB ไม่มี** ตอนนี้ `/monitor/internal/ingest` ถูกบังไว้ด้วย "บั๊ก prefix" ไม่ใช่ด้วยนโยบาย → **ต้องพอร์ต 404 guard มาพร้อมกันในคอมมิตเดียว** ไม่งั้นเปิดพื้นผิว ingest ให้ภายนอก (บันทึกไว้ใน `[[03 - 📹 IDEA2 AEGIS Monitor]]` แล้ว)
  - ⚠️ **`proxy_set_header Host $host` ตัดพอร์ตทิ้ง** — ทดสอบบน `:8443` แล้ว login ตอบ `403 CSRF_ORIGIN_MISMATCH` เพราะเบราว์เซอร์ส่ง `Origin: https://localhost:8443` แต่ backend เห็น `Host: localhost` · ย้ายไป `:443` มาตรฐานแล้วหายทันที (ได้ `200`) **บน 443 ไม่มีปัญหา แต่ถ้าจะเสิร์ฟบนพอร์ตอื่นต้องเปลี่ยนเป็น `$http_host`**
  - ⚠️ **ฟอนต์ `data:` ถูก CSP บล็อก** (`font-src 'self'` แต่ bundle ฝังฟอนต์เป็น data: URI) — **ของเดิม ไม่ใช่ผลจากการแก้ครั้งนี้** (`font-src 'self'` เหมือนกันทั้งใน `securityHeaders.js`, CSP ระดับ server ของ HUB และตัวใหม่ของ `/drive/`) ถ้าจะแก้คือเติม `data:` ใน `font-src`
- **⚠️ ข้อมูลทดสอบค้างในสแตก dev**: สร้าง Private Vault ให้บัญชี `admin` (passphrase `aegis-vault-e2e-passphrase-2026`) ในฐาน `aegis_drive` ของ compose ระหว่างทดสอบ — ลบได้จากจอ Vault ถ้าไม่ต้องการ

## [2026-07-26] vibe-coding | HUB nginx (production) — แก้ routing /monitor + พอร์ต ingest guard + `$http_host` ในคอมมิตเดียว
- **User Prompt Goal**: แก้บั๊ก routing production ของ `/monitor` ใน `HUB-AEGIS_Entry/nginx.conf` แบบเดียวกับที่ทำกับ `/drive` — (1) canonical trailing-slash redirect + rewrite (2) **ในคอมมิตเดียวกัน** พอร์ต security guard ของ `/monitor/internal/` จาก `gateway/nginx.conf` โดย **ต้องตรวจ path จริงในไฟล์นั้นก่อน ห้ามเดาว่ามีสตริงเดียว** (3) เปลี่ยน `Host $host` → `$http_host` กัน CSRF origin-mismatch กลับมาถ้าเปลี่ยนพอร์ต deploy (4) ยืนยันด้วย Docker network จริงตาม topology/IP production + config ตัวจริงที่ hash-check + ตาราง before/after + ตรวจ ingest endpoint ทั้งก่อนและหลัง (5) diff response ของ IDEA1/drive ก่อน-หลัง ยืนยัน zero regression
- **Modified Code Paths**:
  - `c:\Users\User\AEGIS_System\HUB-AEGIS_Entry\nginx.conf` (`location = /monitor` redirect + `location /monitor/` พร้อม rewrite + `location ~* ^/monitor/internal(/|$)` 404 guard + `Host`/`X-Forwarded-Host` → `$http_host` ทั้งใน `/drive/` และ `/monitor/`)
  - `c:\Users\User\AEGIS_System\IDEA2-AEGIS_Monitor\vite.config.js` (คอมเมนต์เท่านั้น — เดิมเขียนว่า nginx forward "UNCHANGED (no path stripping)" ซึ่งเป็นตัวบั๊กเอง)
  - `c:\Users\User\AEGIS_System\IDEA1-AEGIS_Drive_LC\vite.config.js` (คอมเมนต์เท่านั้น — แก้ทั้ง "no path stripping" และ "nginx ทั้งสองชุดใช้ `Host $host`" ที่ไม่จริงแล้ว)
  - **ไม่แตะ** `IDEA2/server/index.js`, `gateway/nginx.conf` และ `location /monitor/` ไม่ได้เพิ่ม CSP/`proxy_hide_header` (อยู่นอกขอบเขต — บันทึกไว้เป็นงานค้าง)
- **Obsidian Updates**: `[[01 - 🚪 HUB-AEGIS Entry]]`, `[[03 - 📹 IDEA2 AEGIS Monitor]]`, `[[00 - 🗺️ AEGIS System Overview]]`, `[[log]]`
- **คำตอบข้อ (2) — guard path ที่มีจริงใน `gateway/nginx.conf`**: **มีเพียง 1 บล็อกเดียว** = `location /monitor/internal/ { return 404; }` (บรรทัด 83) · ตรวจครบด้วย `grep -nE "return [0-9]{3}|deny |allow |internal;"` ทั้งไฟล์ → ไม่มี `deny`/`allow`/`internal;` เลย · `location = /monitor { return 301 …}` เป็น routing ไม่ใช่ guard · ฝั่ง Express endpoint จริงคือ `POST /internal/{detections,clips,alerts}` (`server/routes/internal.js` mount ที่ `app.use('/internal', requireDetectionEngineKey, internalRouter)`)
- **🔴 สิ่งที่ค้นพบและเปลี่ยนวิธีแก้ (เหตุผลที่ "ห้ามเดาว่าลอกสตริงเดียวพอ" ถูกต้อง)**: nginx prefix location เป็น **case-sensitive** แต่ **Express match path แบบ case-INSENSITIVE ตามค่าเริ่มต้น** — วัดตรงกับ `monitor:8002`: `POST /Internal/detections` · `/INTERNAL/detections` · `/internal/Detections` → **`201 Created` ทั้งหมด (เขียนลง DB จริง)** ⇒ ถ้าพอร์ต literal `location /monitor/internal/` มาตรง ๆ **จะถูกข้ามได้ด้วย `/monitor/Internal/detections`** จึงใช้ `location ~* ^/monitor/internal(/|$) { return 404; }` แทน (regex ตัวเดียวในไฟล์ จึงไม่มีปัญหาลำดับ precedence) ⚠️ **`gateway/nginx.conf` มีช่องเดียวกันนี้อยู่ — รายงานแล้ว ยังไม่แก้เพราะอยู่นอกขอบเขตคอมมิตนี้**
- **วิธียืนยัน (topology จริง + config ตัวจริง)**: docker network `subnet=192.168.10.0/24 gateway=.1` · `hub=192.168.10.10` (nginx TLS 443 + 80→301, self-signed cert ที่ path ที่ config ระบุ) · `drive=.11:8001` · `monitor=.12:8002` · `postgres=.15` (Metadata Layer จริง ทั้งสองฐาน) · `client=.50` ยิง curl จาก **ในเครือข่าย** ไม่ publish host port เลย · **`nginx.conf` bind-mount read-only ไม่แก้แม้บรรทัดเดียว**: `sha256` ก่อน = `44c09df2…` หลัง = `754b94d9…` **ตรงกันทั้งไฟล์ในรีโป / ในคอนเทนเนอร์ / blob ที่ commit** · `nginx -t` ผ่านทั้งสองรอบ · `DETECTION_ENGINE_API_KEY` **ตั้งค่าจริง** โดยเจตนา (ถ้าไม่ตั้ง `/internal` ตอบ 503 ให้ทุกคน ซึ่งจะทำให้ guard ดู "ได้ผล" ทั้งที่ไม่ได้ผล)
- **ผลวัดก่อน-หลัง (Monitor)**:
  - `/monitor/assets/index-*.js`: **`200 text/html` 587B → `200 application/javascript` 404,831B**
  - `/monitor/assets/index-*.css`: **`200 text/html` 587B → `200 text/css` 101,638B**
  - `POST /monitor/api/login` (รหัสถูก): **`404 text/html` → `200 application/json` 628B** · (รหัสผิด): `404` → **`401 {"error":"Invalid credentials"}`**
  - `/monitor/healthz`: `200 text/html` 587B → **`200 application/json`** `{"service":"aegis-monitor","ok":true,"db":"postgres"}`
  - `/monitor/api/me` (ไม่มีเซสชัน): `200 text/html` 587B → **`401 {"error":"Not authenticated"}`**
  - `/monitor` (ไม่มี slash): จับ prefix ตรง ๆ → **`301` → `/monitor/`** · `/monitor/dashboard`: `200 text/html` 587B ทั้งก่อนและหลัง (SPA fallback ถูกต้อง)
- **ผลวัด ingest guard (ข้อ 4 — ตรวจทั้งก่อนและหลัง ไม่ใช่แค่ว่าจอขาวหาย)**:
  - **ก่อน**: `/monitor/internal/{detections,clips,alerts}` ตอบ `404` **แต่เป็น 404 ของ Express** (`Cannot POST /monitor/internal/detections`) = ถูกบังด้วยบั๊ก ไม่ใช่นโยบาย · `GET /monitor/internal/anything` → **`200` index.html** (พิสูจน์ว่าไม่มีนโยบายอยู่จริง)
  - **หลัง**: ทุกตัวแปร → **`404` ของ nginx เอง** (body มี `nginx/1.31.3`, sha เดียวกันหมด) ครบ: มี/ไม่มี API key · `/monitor/internal/` · `/monitor/internal` (ไม่มี slash) · `/monitor//internal/…` · `/monitor/internal%2F…` · `/monitor/./internal/…` · `/monitor/Internal/…` · `?bypass=1`
  - **control**: payload เดียวกันยิงตรงไป `192.168.10.12:8002/internal/detections` → **`201 Created`** ⇒ endpoint live จริง ตัวที่ปฏิเสธคือ edge
  - **หลักฐานระดับฐานข้อมูล**: `SELECT camera_id, count(*) FROM detections` = `CAM-01:2` (control 2 รอบ) + `CAM-02:4` (เทส case 4 ครั้ง) ⇒ **14 คำขอผ่าน edge เขียน 0 แถว**
  - **ไม่ over-block**: `/monitor/internal-notes`, `/monitor/internals`, `/monitor/internalx/y` → `200` SPA ตามปกติ
  - ℹ️ **IDEA1/Drive ไม่มี mount `/internal` เลย** (`server/app.js` มีแค่ `app.use('/api', …)`) จึงไม่ต้องมี guard ฝั่ง `/drive/`
- **ผลวัด `$http_host` (ข้อ 3)** — ส่ง `Host: aegis-hub:8443` + `Origin: https://aegis-hub:8443` (สิ่งที่เบราว์เซอร์ส่งจริงถ้า deploy บนพอร์ตอื่น): `POST /drive/api/login` **`403 {"code":"CSRF_ORIGIN_MISMATCH"}` → `200`** · `/monitor` `404` → `200` · บน `:443` มาตรฐานเหมือนกันทั้งสองค่า = **ถอนกับดัก ไม่ใช่แก้บั๊กที่เห็นวันนี้**
- **ข้อ 5 — zero regression**: `diff` section `/drive/*` และ HUB (`/`, `/healthz`, `/index.html`, `/config.json`) ก่อน-หลัง (รวม sha256 ของ body) → **เหมือนกันทุกบรรทัด** ยกเว้นบรรทัด `POST /drive/api/login` ที่ hash ต่าง — พิสูจน์แล้วว่าเป็นความไม่แน่นอน "ต่อคำขอ" ไม่ใช่ regression: ยิง 3 ครั้งติดใน config เดียวกันได้ 3 hash ต่างกัน เพราะ body ฝัง `csrfToken` ใหม่ทุกครั้ง (status/content-type/ขนาด 940B เท่ากันหมด)
- **⚠️ ยังค้าง (ไม่ได้แก้ อยู่นอกขอบเขต)**:
  - 🔴 **`gateway/nginx.conf` มีช่อง case-sensitive เดียวกัน** — `/monitor/Internal/detections` ข้าม guard ได้บนสแตก dev (เสนอเปลี่ยนเป็น `~*` แบบเดียวกัน)
  - ⚠️ **`IDEA2/vite.config.js` ตั้ง `changeOrigin: true`** ซึ่ง IDEA1 แก้เป็น `false` ไปแล้วเพราะทำให้ล็อกอินใน dev ตอบ 403 (Host ถูกเขียนทับเป็น `127.0.0.1:8002` แต่ Origin ยังเป็น `localhost:5176` → ชน CSRF ชั้น Origin) — บั๊กตระกูลเดียวกัน ยังไม่แก้ในรอบนี้
  - ⚠️ **`/monitor/*` มี security header ซ้ำ 2 ชุด** (`csp_header_count=2`) — ต่างจาก `/drive` ตรงที่ CSP ของ Express กับ nginx เป็นสตริงเดียวกันเป๊ะ จึงยังไม่ก่อความเสียหายเชิงฟังก์ชัน
  - ⚠️ ฟอนต์ `data:` ถูก CSP บล็อก (ของเดิม) · ธีมเริ่มต้นยังเป็น dark ขัดกับ "Precision Light"
