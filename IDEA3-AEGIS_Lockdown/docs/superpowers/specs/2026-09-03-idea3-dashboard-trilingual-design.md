# AEGIS IDEA3 Security Center — Dashboard Trilingual Design Specification

**Date:** 2026-09-03

**Area:** `idea3`

**Owner:** `music`

**Branch:** `feature/aegis-security-ui-redesign`

**Status:** Ready for user review

**Applies to:** Dashboard at `/security/` and `/security/dashboard` only

## 1. Objective

Make the approved Security Center Dashboard easier to scan by translating all
user-facing Dashboard copy into Thai, English, and Simplified Chinese, with Thai
as the default. Reduce repeated explanatory text without removing security
facts or weakening the distinction between requested actions, acknowledgements,
physical evidence, freshness, and source availability.

The language selector follows the existing IDEA1 and IDEA2 visual convention:
a compact segmented control in the top-right utility area beside the theme
control. For this milestone it appears on the Dashboard only. The underlying
language preference is reusable by later page-by-page redesigns.

## 2. Design principles

1. **Translate meaning, not evidence.** Labels and readable states change with
   the selected language; raw API values and source identifiers do not.
2. **Thai-first readability.** A Thai Dashboard must not require English status
   vocabulary to understand system condition or next actions.
3. **One fact, one place.** Repeated descriptions are removed or shortened;
   important evidence remains visible where a decision is made.
4. **Truth before polish.** Translation must never turn missing, stale, or
   unverified evidence into a healthy or completed state.
5. **Dashboard-only rollout.** Shared components may gain backward-compatible
   inputs required by the Dashboard, but no other page copy or layout changes.

## 3. Scope

### In scope

- Language preference values `th`, `en`, and `zh`.
- Thai as the default when no valid saved preference exists.
- A Dashboard-only segmented selector labelled `ไทย`, `EN`, and `中文` in the
  authenticated top bar, immediately beside the theme control.
- Persistent preference using the existing IDEA1/IDEA2-compatible
  `localStorage` key `aegis_lang`.
- Synchronization of `document.documentElement.lang` with the selected language.
- Translation of every user-facing Dashboard heading, label, status, helper
  message, empty/error state, action label, accessible name, and relative-time
  phrase.
- Locale-aware Dashboard date and number formatting.
- A shorter Dashboard information hierarchy with approximately 25–30% less
  secondary copy than the current Dashboard.
- Tests for dictionary parity, language behavior, status wording, persistence,
  and existing Dashboard evidence behavior.
- Desktop and responsive browser validation in all three languages.

### Out of scope

- Translating or redesigning Login, Overview, IDEA1 Security, IDEA2 Detection,
  IDEA3 Lockdown, Alerts, Incidents, Audit, Devices, Recovery, or Settings.
- Displaying the selector on non-Dashboard routes in this milestone.
- Backend, API, RBAC, session, CSRF, evidence-contract, or routing changes.
- Saving language preferences to the server or user account.
- Translating technical identifiers, device names, IP addresses, event IDs,
  source IDs, schema values, or audit evidence.
- Claiming that English or Chinese coverage exists outside the Dashboard.

## 4. Language and terminology policy

### 4.1 Translated content

Translate words whose purpose is to help a person understand or operate the UI:

- page and section titles;
- metric and evidence labels;
- status and freshness labels;
- descriptions, warnings, empty states, and retry messages;
- navigation actions rendered inside the Dashboard;
- relative times and accessible control labels.

### 4.2 Preserved technical content

Keep stable technical evidence unchanged in all languages:

- `IDEA1`, `IDEA2`, `IDEA3`, `AEGIS`;
- `MQTT`, `ACK`, `IP`, `API`, `RBAC`, `ESP32`;
- sanitized source/device identifiers, event IDs, incident IDs, and IP values;
- raw contract values kept in data and logs.

Technical terms may be surrounded by translated explanatory copy. For example,
Thai may show `สถานะ MQTT` and `ได้รับ ACK แล้ว`, while the acronyms remain intact.

### 4.3 Canonical status display

Raw status values remain unchanged in application data. The Dashboard renders
the following localized labels:

| Raw status | ไทย | English | 简体中文 |
|---|---|---|---|
| `HEALTHY` | ปกติ | Healthy | 正常 |
| `DEGRADED` | ทำงานแบบจำกัด | Degraded | 性能受限 |
| `FAILED` | ขัดข้อง | Failed | 故障 |
| `UNKNOWN` | ไม่ทราบสถานะ | Unknown | 未知 |
| `NOT_CONFIGURED` | ยังไม่ได้ตั้งค่า | Not configured | 未配置 |
| `STALE` | ข้อมูลล้าสมัย | Stale | 数据过期 |
| `DISABLED` | ปิดใช้งาน | Disabled | 已禁用 |
| `CONNECTED` | เชื่อมต่อแล้ว | Connected | 已连接 |
| `DISCONNECTED` | ขาดการเชื่อมต่อ | Disconnected | 已断开 |
| `NOT_VERIFIED` | ยังไม่ได้ยืนยัน | Not verified | 未验证 |

Status colors and icons continue to follow evidence semantics and never depend
on translated text.

## 5. Interaction and placement

The selector is a three-option segmented control in the top-right utility group:

```text
Source status · Clock                         ไทย | EN | 中文   Theme   Admin
```

- It is visible only while the Dashboard route is active.
- The current language is selected with a visible shape/background state, not
  color alone.
- It is implemented as a labelled radio group or equivalent accessible control.
- Arrow-key or Tab/Enter interaction follows the chosen native semantics.
- Each option retains the script users recognize; do not replace choices with
  country flags.
- On narrow screens the control remains in the utility area and may wrap as one
  intact unit; individual options must not split across rows.
- Changing language updates the Dashboard immediately without reloading or
  refetching evidence.

## 6. Information-density reduction

The Dashboard keeps its current evidence-led sections and shortens presentation
according to these rules:

- The page introduction becomes one concise purpose line; repeated explanations
  of “Mission Control” are removed.
- Global runtime facts use a label, primary value, and at most one short detail.
- Healthy/normal cards do not repeat what their status badge already says.
- Additional detail appears primarily for abnormal, stale, unavailable, or
  unverified states.
- Each outcome metric receives no more than one short supporting line.
- IDEA summary cards keep source, freshness, safety, and action-boundary facts,
  while removing duplicated prose.
- Attention and recommended-action lists remain bounded and use direct verbs.
- The active-incident section keeps evidence chronology and severity but avoids
  restating the same incident title in multiple nearby elements.

No reduction may remove the distinction between Demo and Live data, API
reachability, requested relay state, ACK evidence, physical relay evidence,
hardware availability, source freshness, or unverified state.

## 7. Technical design

### 7.1 Translation foundation

Add an IDEA3-owned client module at `web/src/lib/i18n.js` containing:

- the allowlisted languages and locale metadata;
- one flat key dictionary per language;
- a small translator function with bounded interpolation;
- Dashboard status-label mappings;
- locale selection for date and number formatting.

All three dictionaries must have identical key sets. Missing-key parity fails
tests. Runtime lookup falls back to Thai only for an invalid language value;
missing valid-language keys remain a development error rather than silently
mixing languages.

### 7.2 Language state

`App.jsx` owns the authenticated UI language state because future page
milestones will reuse it. Initialization validates `aegis_lang`; invalid or
absent values become `th`. A language change:

1. updates React state;
2. writes the allowlisted value to `localStorage`;
3. updates the document `lang` attribute (`th`, `en`, or `zh-CN`);
4. re-renders only presentation copy and formatting.

Evidence state, API requests, authentication, and routes are unaffected.

### 7.3 Dashboard-only shell integration

`AppShell.jsx` receives optional language-control props and renders the selector
only when the current route is Dashboard. Defaults preserve the exact behavior
of every other route. This is the only shared-shell change required by this
milestone.

### 7.4 Dashboard presentation

`DashboardPage.jsx` receives the selected language and translator. Existing
Dashboard selectors in `web/src/lib/dashboard.js` continue to compute raw facts;
translation happens after those facts are derived. No localized string is used
as a branching condition.

`StatusBadge.jsx` gains an optional display label while continuing to receive
the raw status for semantic class and icon selection. Existing callers that do
not pass a label retain their current output. `format.js` gains optional locale
parameters whose defaults preserve all non-Dashboard pages.

## 8. Data flow

```text
Dashboard language selector
        ↓
App language state ──→ localStorage: aegis_lang
        ├────────────→ document <html lang>
        └────────────→ AppShell + DashboardPage
                              ↓
               translated copy/status/formatting

Snapshot/API evidence ──→ existing raw selectors ──→ unchanged facts
```

Language selection never changes, filters, or fabricates evidence.

## 9. Accessibility and responsive behavior

- The language control has a translated group label and an explicit selected
  state exposed to assistive technology.
- Focus indication meets the existing high-contrast focus treatment.
- Status meaning remains available through icon and text, not color alone.
- Thai uses the existing Thai-capable font stack and generous line height.
- Chinese copy must not be letter-spaced like uppercase English telemetry.
- At 1366×768, 1440×900, and 1920×1080 the Dashboard must have no document-level
  horizontal overflow.
- At mobile widths the selector and metric values remain readable without
  clipping; evidence tables may retain their existing bounded internal scroll.

## 10. Error and fallback behavior

- Invalid persisted language: discard it and render Thai.
- Unavailable `localStorage`: keep the in-memory Thai default and do not block
  Dashboard rendering.
- Missing translation key: fail automated parity tests; development rendering
  exposes the missing key instead of inventing or silently mixing copy.
- API refresh failure: retain the existing cached-evidence and stale-warning
  behavior, translated into the selected language.
- Unknown future raw status: keep the existing safe unknown styling and render
  the localized “Unknown” label.

## 11. Verification and acceptance criteria

### Automated verification

- Dictionary parity: Thai, English, and Chinese contain exactly the same keys.
- Language initialization: absent/invalid preference resolves to Thai.
- Persistence: selecting each language saves the allowlisted value and updates
  the document language.
- Scope: the selector renders on Dashboard and not on other routes.
- Status matrix: every supported raw status renders the correct label in all
  three languages while retaining its semantic class/icon.
- Thai Dashboard contains no raw English user-facing status labels; approved
  technical identifiers are allowed.
- Dashboard evidence tests continue to cover populated, empty, disconnected,
  incident, navigation, bounded attention, stale, and unverified states.
- Existing non-Dashboard client tests pass without requiring translation props.
- Production build passes.

### Browser verification

- Switch among `ไทย`, `EN`, and `中文` without reload and confirm immediate full
  Dashboard translation.
- Reload after each selection and confirm persistence.
- Inspect normal, stale/disconnected, empty, Demo, and populated Dashboard states.
- Verify light/dark themes and widths 1366×768, 1440×900, and 1920×1080, plus a
  narrow mobile width.
- Confirm no new console warning/error and no document-level horizontal overflow.

## 12. Expected implementation paths

- `IDEA3-AEGIS_Lockdown/web/src/App.jsx`
- `IDEA3-AEGIS_Lockdown/web/src/components/AppShell.jsx`
- `IDEA3-AEGIS_Lockdown/web/src/components/StatusBadge.jsx`
- `IDEA3-AEGIS_Lockdown/web/src/lib/i18n.js` (new)
- `IDEA3-AEGIS_Lockdown/web/src/lib/format.js`
- `IDEA3-AEGIS_Lockdown/web/src/pages/DashboardPage.jsx`
- `IDEA3-AEGIS_Lockdown/web/src/styles/app.css`
- Dashboard/i18n-focused client tests under `IDEA3-AEGIS_Lockdown/web/tests/client/`
- One new IDEA3 task receipt after implementation and validation

No backend, API, deployment, database, gateway, IDEA1, or IDEA2 path is expected
to change.

## 13. Git and delivery boundary

Implementation remains on `feature/aegis-security-ui-redesign`. After the
Dashboard language pass is validated, stage only intentional Dashboard paths and
the new immutable receipt, create one Dashboard-specific implementation commit,
push the branch, and stop. Do not create a Pull Request and do not merge into
`main`; later UI pages will continue on the same branch after separate review.
