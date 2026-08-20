# IDEA1 UI foundation revision design

## Scope

This task is the first independently reviewable slice of the supplied IDEA1 revision prompt. It covers the authenticated application shell and the user-preference contract because those changes affect every screen and can be verified without inventing telemetry or changing file-storage architecture.

Included requirements: G-B, G-C, G-E, G-F, D-6, design-system documentation, reusable extraction, onboarding/empty-state review, accessibility hardening, and route-level bundle optimization.

G-A is analyzed but not changed in this task. Both NGINX configurations already forward `X-Real-IP` and `X-Forwarded-For`, while Express currently trusts one proxy hop. Replacing that with one exact NGINX container IP needs a stable production IP/configuration contract that the repository does not currently define; changing it unilaterally would cross the attachment's architecture-conflict gate.

Trash/recovery, quota, system-health collection, file/share/access-control expansion, and production deployment remain separate subprojects because each changes its own storage, data-retention, privilege, or rollout contract.

## Product behavior

- Light is the default appearance for anonymous and newly created accounts.
- Authenticated theme, language, and density are loaded from the server-owned user record. No browser storage is used.
- Appearance changes are persisted through an authenticated endpoint bound to `req.user.id`. Invalid values are rejected; the client never supplies a target user or role.
- The profile menu contains Profile, Settings, and Sign out. Profile and Settings open the appropriate Settings tab.
- The inactive notification bell is removed until a real event source exists.
- Global search keeps its cross-application behavior but states the current scope with page-specific placeholder copy.
- Dashboard quick actions provide direct routes to Upload, Secure Shares, and Private Vault using existing authorized navigation only.
- Screen modules load on demand behind the existing content-shaped skeleton fallback. Login and the reset gate stay eager.
- Decorative gradient text is replaced by solid semantic ink. Avatar fallback remains request-efficient without rendering a broken image.

## Design system and extraction

Write an IDEA1-local `DESIGN.md` from the actual CSS tokens and reusable components. Add an IDEA1-local `.impeccable/design.json` sidecar. Extraction is limited to repeated preference validation/normalization and shell navigation helpers; no generic component abstraction is introduced without three real uses.

## Accessibility and resilience

- All new menu entries are real buttons with visible focus, text labels, and 44px-capable touch targets.
- Preference saves expose busy/error state without discarding the user's current selection.
- Reduced-motion behavior continues to use the existing global rule.
- Lazy route failures are caught by the existing error boundary; loading never presents a blank screen.
- Thai remains the default language, with English and Chinese retained because the current translation catalog contains complete key sets.

## Verification

- Node tests prove default, persistence, validation, current-user binding, role-filtered navigation, and shell source behavior.
- `npm test` must pass in memory mode; PostgreSQL-only tests remain explicitly skipped unless an isolated test DB is provided.
- `npm run build` must pass and produce route chunks smaller than the previous single 969.77 kB entry bundle.
- Impeccable detector, static audit, and source review are rerun after changes.
