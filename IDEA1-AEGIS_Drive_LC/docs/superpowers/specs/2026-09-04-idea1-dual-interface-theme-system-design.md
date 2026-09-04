# AEGIS Drive_LC — Dual Interface Theme System design

## Goal

Add a server-owned, independent `interfaceStyle` preference to the authenticated IDEA1 application. Existing accounts and invalid legacy data resolve to `classic`; users may select `neo` in Settings and, after an accessible confirmation, save the preference and end the current session. The next successful authentication mounts the selected authenticated shell directly, without a Classic/Neo intermediate frame.

## Scope

The style system covers the authenticated Dashboard, Files, Private Vault, Secure Shares, File History, Storage & Backup, Audit Log, Access Control, and Settings screens.

Login is excluded. Its DOM, styling, theme controls, authentication behavior, and error behavior remain unchanged. No pre-authentication account-specific style hint is stored or rendered.

Audit result-filter semantics, the storage capacity donut, and protected trash remain separate Pull Requests. This branch starts from accepted `origin/main` and does not copy their work.

## Preference contract

The complete appearance preference is:

```js
{
  theme: 'light' | 'dark' | 'system',
  language: 'en' | 'th' | 'zh',
  density: 'comfortable' | 'compact',
  interfaceStyle: 'classic' | 'neo',
}
```

`interfaceStyle` is validated and persisted by the server, defaults to `classic`, and is independent of theme, density, and language. The database migration is additive and idempotent.

## Authentication and shell gate

No style preference is read before authentication. When `/api/me` or Login returns an authenticated user, the application validates the account style, synchronously applies `data-ui-style` to the document root, then exposes the authenticated session to React. This preserves the existing Login bootstrap and prevents the authenticated shell from mounting under the wrong style.

The document root uses:

- `data-ui-style="classic|neo"` only for authenticated rendering;
- `data-theme="light|dark"` for the resolved color scheme;
- `data-density="comfortable|compact"` for spacing.

The authenticated root also carries a stable shell hook so Neo CSS cannot leak into Login.

## Style-switch transaction

1. Selecting the other interface style opens a confirmation modal; it does not alter the active shell.
2. Confirming sends the full validated preference object to `/api/preferences`.
3. If the save fails, the session and active style remain unchanged and an accessible error is shown.
4. If the save succeeds, transient authenticated UI state is cleared, the current server session is ended, and Login is rendered unchanged.
5. On the next successful authentication, the saved style is applied before the authenticated shell mounts.

The modal uses the shared portal, focus targeting, Escape handling, labelled dialog semantics, and keyboard-reachable actions.

## Visual direction

Classic preserves the accepted Precision Ledger appearance.

Neo is a premium enterprise skin informed by the approved references without copying their literal content:

- AEGIS blue `#2563EB` remains the dominant semantic accent.
- Violet and muted pink appear only in active, selected, and focus emphasis.
- Neo Light uses cool-white and light-gray layered surfaces with soft neutral shadows.
- Neo Dark uses stepped graphite/navy surfaces with restrained static lighting.
- Static glass is limited to Sidebar, Topbar, modal surface, and segmented-control housing.
- Data and content cards stay predominantly solid.
- Sidebar navigation uses rounded capsule geometry and a clear selected state.
- Motion uses transform and opacity, avoids animated blur/shadow/layout, and collapses under `prefers-reduced-motion`.

## Token architecture

Neo colors, borders, elevation, radii, and shell effects are semantic CSS custom properties. Components consume the existing semantic surface/ink/accent variables plus shared hooks such as `ui-card`, `ui-segmented`, `ui-modal`, `app-sidebar`, and `app-topbar`. Component-specific hex colors are prohibited.

## Accessibility and performance

- WCAG AA text and control contrast in both Neo schemes.
- Visible keyboard focus rings.
- Segmented controls expose radiogroup/radio semantics.
- Confirmation modal has focus management, a labelled dialog, Escape handling, and safe cancellation.
- Mobile and tablet interactive targets are at least 44px.
- No page-load choreography or perpetual decorative animation.
- Static backdrop filters are limited to shell-level surfaces and disabled where unsupported without losing readability.

## Non-goals and preserved contracts

This work does not change RBAC, authentication UX, file/share authorization, audit semantics, cryptography, storage truth, disk-health truth, backup-agent architecture, route availability, or navigation authorization. The Neo skin must render the same real application state and actions as Classic.
