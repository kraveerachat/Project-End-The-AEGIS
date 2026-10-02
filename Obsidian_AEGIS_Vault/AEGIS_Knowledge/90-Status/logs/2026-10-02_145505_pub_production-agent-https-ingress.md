---
title: Task Receipt — Production Agent HTTPS ingress
date: 2026-10-02T14:55:05+07:00
owner: pub
area: idea2
branch: fix/idea2-production-agent-https-ingress
status: partial
edit_policy: append-by-new-file
---

# Task Receipt — Production Agent HTTPS ingress

## What changed

- Added one case-sensitive, exact-route Machine Identity Agent allowlist at the
  Production HUB while retaining a case-insensitive deny for every other
  `/monitor/internal*` spelling.
- The six approved routes are POST-only, query-free/non-canonical-URI-free,
  limited to 16 KiB, and strip browser Cookie and Authorization before proxying.
  Existing `X-Aegis-*` session/signature proof headers remain Monitor-owned.
- Reconciled the non-secret Production Agent and browser-association audience
  examples to the canonical HTTPS origin `https://aegis.internal`.
- No Production, database, Machine A runtime, identity key, camera, or tunnel
  mutation was performed.

## Source files changed

- `HUB-AEGIS_Entry/nginx.conf` — exact machine ingress, browser-credential stripping, limits, and deny-by-default fallback.
- `HUB-AEGIS_Entry/tests/productionAgentIngress.test.mjs` — static edge/audience security contract.
- `HUB-AEGIS_Entry/tests/nginxRoutingSmoke.mjs` — disposable real-Nginx route, method, header, query, and body-limit coverage.
- `HUB-AEGIS_Entry/tests/driveTransferEdge.test.mjs` — preserve Drive behavior against the updated Monitor deny header.
- `HUB-AEGIS_Entry/tests/idea3RoutingContract.test.mjs` — preserve IDEA3/Drive/Monitor boundaries with the updated deny.
- `IDEA2-AEGIS_Monitor/.env.example` — canonical non-secret Production audiences; strict rollout remains false.
- `IDEA2-AEGIS_Monitor/tests/agentAuth.test.mjs` — missing/mismatched audience fail-closed coverage.
- `IDEA2-AEGIS_CCTV-Operator/detection-engine/tests/test_agent_session.py` — Production URL/audience compatibility and proof that browser Authorization/Cookie are unused.

## Verification evidence

- `node --test tests/productionAgentIngress.test.mjs` — RED: 1 pass, 4 expected failures before implementation; GREEN included below.
- `node --test tests/driveCspParity.test.mjs tests/driveTransferEdge.test.mjs tests/idea3RoutingContract.test.mjs tests/productionAgentIngress.test.mjs` — pass: 36/36.
- `node --test tests/backNavigation.test.mjs` — pass: 11/11.
- `node --test tests/agentAuth.test.mjs tests/detectorCompatibility.test.mjs tests/localNodeSession.test.mjs tests/browserAssociationProof.test.mjs tests/browserAssociationCrossLanguage.test.mjs` — pass: 33/33.
- `python -m unittest tests.test_agent_session` — pass: 11/11.
- `npm test` in `IDEA2-AEGIS_Monitor` — pass: 179, fail: 0, conditional PostgreSQL skips: 58; skipped DB tests are not counted as proof.
- `npm run build` in `HUB-AEGIS_Entry` — pass.
- `npm run build` in `IDEA2-AEGIS_Monitor` — pass.
- `node --test tests/collaborationPolicy.test.mjs` — pass: 33/33.
- `node scripts/validate-vault.mjs` — pass with two pre-existing owner-review canvas warnings.
- `git diff --check` — pass.
- changed-added-content credential pattern scan — pass: 0 findings.
- fresh scoped review — Critical=0, Important=1 fixed in `535634a9`, Minor=1 deferred.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea2/idea2-status.md` — records the bounded ingress contract, local evidence, environment limitations, and remaining rollout gates.

## Shared surfaces touched

- `HUB-AEGIS_Entry/nginx.conf` — Production shared edge route; Kla must review exposure, rollback, and eventual rollout.
- `HUB-AEGIS_Entry/tests/productionAgentIngress.test.mjs` — shared edge security contract.
- `HUB-AEGIS_Entry/tests/nginxRoutingSmoke.mjs` — shared disposable edge runtime verification.
- `HUB-AEGIS_Entry/tests/driveTransferEdge.test.mjs` — shared Drive/Monitor edge preservation assertion.
- `HUB-AEGIS_Entry/tests/idea3RoutingContract.test.mjs` — shared IDEA3/Monitor edge preservation assertion.

## Integration requests

- Kla: review the five exact HUB paths above. Before any Production rollout,
  run the disposable real-Nginx smoke, review the six-route exposure and
  `https://aegis.internal` audience configuration, then use a separately
  approved change window. Rollback is restoration of the prior HUB config and
  prior non-secret Monitor audience configuration; do not alter Agent keys or
  registry authority as part of rollback.

## Known limitations

- `HUB-AEGIS_Entry/tests/nginxRoutingSmoke.mjs` was not executed because the
  local Docker Desktop API was unavailable; no Docker service was started or
  repaired. The script passes Node syntax validation.
- Real-Nginx runtime cases for empty-query, percent-encoded, doubled-slash, and
  dot-segment variants remain deferred; source-level raw-URI contract tests
  cover those spellings pending an available Nginx runtime.
- A full Engine discovery run was environment-limited by missing `requests`,
  OpenCV, and Starlette in the bundled Python. No Engine runtime source changed;
  the directly affected Agent configuration/session suite passes 11/11.
- Production deployment, Production environment reconciliation, live Machine A
  Identity Agent acceptance, and database-backed Monitor gates were not run.
