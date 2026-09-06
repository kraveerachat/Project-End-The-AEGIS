# IDEA3 Security Center — Overview UI Pass 01 Design

Date: 2026-09-04
Status: Draft for owner review
Area: `idea3`
Owner: `music`
Branch: `feat/idea3-overview-ui-pass-01`
Base dependency: `origin/feature/aegis-security-ui-redesign` at `eaa605d`

## 1. Problem and evidence

The accepted Dashboard answers “what is happening now,” while the existing Overview still reads like a second subsystem summary. Overview needs a separate identity as the architecture and integration-readiness surface: where evidence originates, which boundary it crosses, how it is validated, whether it is fresh, and what remains unproven for production.

The initial workspace copy at `Projects/The_AEGIS/` is not a standalone Git checkout. Its empty `.git` directory causes Git to resolve to an unrelated parent repository. A remote refresh of the canonical AEGIS repository revealed that the Security Center baseline is already committed and merged, and that the accepted Dashboard/trilingual work is preserved on `origin/feature/aegis-security-ui-redesign`. Therefore this task is a focused stacked Overview change, not a whole-tree baseline recovery.

The attached `AEGIS_Overview_UI_Pass_01_Codex_Prompt.md` is treated as product input and acceptance guidance. Repository governance, source code, tests, and current Git history remain the operational source of truth.

## 2. Goals

- Give Overview a clear “system architecture / integration readiness” identity.
- Make the environment and evidence boundary visible before any health interpretation.
- Make the evidence path the visual hero without adding charts or decorative topology.
- Present IDEA1, IDEA2, and IDEA3 as integration contracts rather than Dashboard metrics.
- Keep the integration matrix as the precise comparison layer.
- Derive status conservatively so stale, missing, or incomplete evidence cannot appear healthy.
- Expose provenance and production blockers without adding controls or changing backend contracts.
- Preserve the accepted Dashboard, three-language behavior, APIs, authentication, RBAC, CSRF, and cyber-physical safety boundaries.

## 3. Non-goals

- No redesign of Dashboard or any page other than Overview.
- No Python, MQTT, ESP32, relay, gateway, network, database, or deployment change.
- No new hardware-control action or recovery execution from the browser.
- No API, state model, routing architecture, or authentication contract change.
- No fabricated telemetry, security score, uptime, production percentage, or physical relay proof.
- No repository-wide component refactor or localization expansion.
- No push, merge, or Pull Request in this task session.

## 4. Git and delivery model

The task runs in an isolated worktree on `feat/idea3-overview-ui-pass-01`, stacked directly on `origin/feature/aegis-security-ui-redesign`. This preserves the actual Dashboard dependency and keeps the task diff limited to Overview.

The dependency branch is not merged into current `origin/main`; a future Pull Request, if the owner later requests one, must initially target `feature/aegis-security-ui-redesign` and declare that dependency. This session will create local commits only.

The non-Git workspace copy remains read-only evidence. Generated directories and local artifacts (`node_modules/`, `dist/`, coverage, caches, `.env`, credentials, tokens, and secrets) must never be migrated.

## 5. Information architecture

Overview will use this order:

1. Existing page heading, with an Overview-specific architecture/readiness description.
2. Compact environment and evidence-boundary strip.
3. Evidence and integration flow as the hero section.
4. IDEA1/IDEA2/IDEA3 integration-contract cards.
5. Integration matrix for detailed comparison.
6. Data provenance and production readiness as supporting sections.

The page must not repeat Dashboard’s incident, alert, or mission-control content.

### 5.1 Environment and evidence boundary

The strip exposes only safe metadata already present in the snapshot:

- environment mode;
- evidence-provider alias;
- persistence declaration;
- whether Live merge is allowed.

Missing values fall back to `UNKNOWN` or `NOT_CONFIGURED`. The UI must not invent a provider, persistence mechanism, or isolation claim.

### 5.2 Evidence flow

The flow communicates four stages:

`IDEA1 / IDEA2 / IDEA3 upstream evidence → validate and normalize → store and correlate → Admin surface`

It reuses the current panel, badge, icon, border, spacing, and typography language. The flow is explanatory rather than interactive. It adds no chart, animation, fake volume, or decorative network topology.

### 5.3 Integration-contract cards

Each card provides a quick integration summary:

- source/provider alias;
- contract or mode description;
- freshness;
- effective canonical status.

IDEA3 additionally separates runtime mode from physical evidence. `MONITOR ONLY` or `DRY RUN` describes software mode only; physical relay state remains `UNKNOWN` unless the snapshot carries explicit physical evidence.

### 5.4 Integration matrix

The matrix remains the technical detail layer and compares:

- integration name;
- effective overall status;
- freshness;
- validation timestamp;
- contract or runtime mode;
- source type.

Cards provide quick context; the matrix provides precise cross-integration comparison. Missing rows produce an explicit empty state rather than a healthy fallback.

### 5.5 Provenance and readiness

Provenance shows only safe API metadata: provider, environment, persistence, evidence boundary, and Live-merge policy.

Readiness is split into unresolved production gaps and facts confirmed by the current snapshot. It is informational, not actionable. Items that are intentionally unavailable remain `DISABLED`; absence of configuration remains `NOT_CONFIGURED`; absence of evidence remains `UNKNOWN`.

## 6. Status and evidence-honesty rules

Overview uses the existing vocabulary:

`HEALTHY`, `DEGRADED`, `FAILED`, `UNKNOWN`, `NOT_CONFIGURED`, `STALE`, `DISABLED`.

Effective status follows these rules:

1. An integration absent from `snapshot.sources` is `NOT_CONFIGURED`.
2. Explicit `STALE` freshness overrides a source-level `HEALTHY` value.
3. `HEALTHY` requires both `FRESH` and a validation timestamp; otherwise it becomes `UNKNOWN`.
4. An unrecognized status becomes `UNKNOWN`.
5. Contract readiness aggregates only available integration evidence and cannot become healthy when fewer than three expected integrations are present.
6. Demo/Live isolation is healthy only when the provider explicitly declares `liveMerged === false`; `true` is failed and absence is unknown.
7. Admin security is healthy only when both RBAC and CSRF are explicitly `ENFORCED`.
8. Memory-only or missing persistence is not a durable production store.
9. Requested state, ACK state, executed state, and physical evidence remain separate; no ACK or runtime mode proves a relay cut.

These derivations are presentation safeguards over the existing snapshot. They do not change server data or contracts.

## 7. Components and change boundary

Expected implementation paths:

- `IDEA3-AEGIS_Lockdown/web/src/pages/OverviewPage.jsx`
- `IDEA3-AEGIS_Lockdown/web/src/components/Panel.jsx`
- `IDEA3-AEGIS_Lockdown/web/src/components/AppShell.jsx`
- `IDEA3-AEGIS_Lockdown/web/src/lib/routes.js`
- `IDEA3-AEGIS_Lockdown/web/src/styles/app.css`
- `IDEA3-AEGIS_Lockdown/web/tests/client/corePages.test.jsx`
- `IDEA3-AEGIS_Lockdown/web/tests/client/shell.test.jsx`
- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea3/idea3-status.md`, only if a durable verified fact changes
- one new `music` task receipt after implementation and verification

Shared component changes must remain backward-compatible:

- `Panel` may accept an optional accessible region label; existing callers remain unchanged.
- `AppShell` may render the existing route description for non-Dashboard headings; it must not alter Dashboard presentation or language scope.
- `routes.js` changes only the Overview description.
- CSS selectors for new hierarchy remain Overview-scoped where practical.

No path outside the IDEA3 owned boundary is expected. If implementation requires a cross-scope path, work stops for owner direction rather than silently expanding scope.

## 8. Accessibility and responsive behavior

- Major Overview sections receive named semantic regions.
- Heading levels preserve a logical page hierarchy.
- Status meaning is expressed with text as well as color.
- Table headers and the existing controlled overflow behavior remain intact.
- Non-interactive cards do not gain button-like hover, cursor, or focus behavior.
- Desktop layouts must remain readable at 1920×1080, 1440×900, and 1366×768 when the available browser can reproduce those sizes.
- Narrow layouts stack the evidence flow and cards in reading order, with no page-level horizontal overflow.
- Light and dark themes must both preserve readable secondary text and status contrast.

If the in-app browser cannot provide an exact requested viewport, the receipt records the actual viewport and limitation rather than claiming exact coverage.

## 9. State coverage

Automated or browser evidence must cover, where the existing fixture/API supports it:

- loading without a premature healthy flash;
- healthy plus fresh evidence;
- degraded and failed evidence;
- unknown and not-configured metadata;
- stale evidence overriding health;
- one or all integrations unavailable;
- API refresh failure while cached evidence remains visible as stale;
- Demo boundary;
- Live boundary with missing adapter fallbacks;
- IDEA3 mode without physical relay proof.

## 10. Verification strategy

Before implementation, confirm the exact source diff against the stacked base and inspect imports/usages for every shared component.

After implementation:

1. Run focused Overview and shell tests.
2. Run Dashboard language/shell regressions because `AppShell` and shared CSS are touched.
3. Run the full web test suite and report every failure honestly, distinguishing pre-existing failures from regressions.
4. Run the production build.
5. Run the repository’s Impeccable detector against exact changed UI paths.
6. Perform browser QA for Demo, Live/missing adapters, stale evidence, light/dark themes, semantic regions, console errors, and responsive overflow.
7. Run `git diff --check`, inspect exact name/status, and scan the candidate diff for secrets and generated artifacts.
8. Run the repository collaboration-policy checks applicable to the final candidate.

The receipt records commands and real results. A focused pass does not make a failed full suite green, and a build does not prove production deployment.

## 11. Documentation and receipt policy

The existing orphan receipt in the non-Git workspace is evidence of the earlier local run, not a commit-ready receipt for this branch. Implementation will create exactly one new immutable receipt in the canonical worktree, recording the recovered Overview outcome, current branch, exact changed paths, new verification results, limitations, and the fact that no PR was created.

The Music-owned `idea3-status.md` may be updated in place only after the recovered implementation is verified. Existing receipts are never edited or duplicated.

The nested `IDEA3-AEGIS_Lockdown/AGENTS.md` references five `doc/Content/*.md` files that are absent from this dependency branch. This is a baseline documentation inconsistency, not permission to synthesize missing operational guidance. The task follows the repository-wide runbook, current source/tests, the IDEA3 canonical notes, and preserves all documented safety boundaries.

## 12. Failure handling and rollback

- The original non-Git workspace remains untouched and available as read-only recovery evidence.
- Any unexpected non-IDEA3 or non-Overview diff stops the migration before commit.
- Any shared-component regression is resolved locally or the shared change is removed.
- If status derivation cannot be supported by current snapshot fields, the UI displays `UNKNOWN`/`NOT_CONFIGURED` rather than changing the API.
- Local commits are reversible and no remote state changes occur in this session.
- Worktree or branch cleanup is not automatic and requires explicit owner direction.

## 13. Acceptance criteria

- Overview is visibly architecture/readiness-focused and distinct from Dashboard.
- The environment/evidence boundary appears before interpreted health.
- Evidence flow is the visual hero and remains readable when stacked.
- Three cards communicate integration contracts without fabricating facts.
- The matrix preserves exact comparison and honest empty/stale states.
- Provenance and production blockers are quickly understandable.
- Demo, Live, runtime mode, and hardware availability remain distinct concepts.
- No stale, absent, or unvalidated evidence appears healthy.
- Dashboard and all other pages retain their accepted behavior and design.
- No backend, MQTT, ESP32, relay, deployment, or shared-area path changes.
- Focused tests and build pass; full-suite and browser results are recorded as observed.
- Exactly one task receipt is added when implementation is complete.
- No push or Pull Request is created.
