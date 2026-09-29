---
title: Task Receipt — IDEA3 Web production image assets packaging
date: 2026-09-28T05:41:17+07:00
owner: music
area: idea3
branch: fix/idea3-web-production-image-assets
status: complete
edit_policy: append-by-new-file
---

# Task Receipt — IDEA3 Web production image assets packaging

## What changed

- The IDEA3 Security Center Docker build now copies Vite `public/` assets into the build stage before `npm run build`, so the already-merged AEGIS login background artwork is packaged into the production bundle.
- A regression contract test now fails if the production image build omits `public/`.

## Source files changed

- `IDEA3-AEGIS_Lockdown/web/Dockerfile` — add `COPY public ./public` before the Vite production build.
- `IDEA3-AEGIS_Lockdown/web/tests/server/dockerContainerContract.test.js` — require the production build stage to include `public ./public`.

## Verification evidence

- `npm test -- tests/server/dockerContainerContract.test.js` — pass: 10 tests passed after the fix; the new test was RED before the Dockerfile change.
- `npm test` — pass: 566 tests passed across 31 test files.
- `npm run build` — pass: Vite production build completed and emitted `dist/assets/BG_AEGIS01.png` and `dist/assets/BG_AEGIS02.png`.
- `grep -RhoE 'url\([^)]*BG_AEGIS0[12]\.png[^)]*\)' dist | sort -u` — pass: both references resolve under `/security/assets/`.
- `git diff --check` — pass.

## Canonical notes updated

- None — this is a repository packaging fix only; Production deployment has not yet been performed.

## Shared surfaces touched

- None — the task stayed inside IDEA3-owned paths plus this IDEA3 task receipt.

## Integration requests

- None — no cross-scope/shared path changed.

## Known limitations

- The Arch workstation has no usable local Docker/Podman engine, so image-level runtime inspection was not completed locally.
- Production deployment is not part of this receipt and remains a separate, explicitly bounded server mutation.
