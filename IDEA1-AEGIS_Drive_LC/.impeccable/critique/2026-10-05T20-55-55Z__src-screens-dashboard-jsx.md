---
target: IDEA1 Neo Dashboard source pre-implementation
total_score: 22
p0_count: 0
p1_count: 2
timestamp: 2026-10-05T20-55-55Z
slug: src-screens-dashboard-jsx
---
Method: dual-agent (A: /root/design_assessment · B: /root/detector_assessment)

# Pre-implementation source critique — IDEA1 Neo Dashboard

No authenticated Dashboard screenshot or live runtime was available. Findings describe source and CSS only; visual contrast and interaction remain unverified.

## Design Health Score

| # | Nielsen heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 2 | A failed Dashboard fetch can coexist with apparent OK/all-clear cards. |
| 2 | Match system / real world | 3 | Storage and health concepts are clear; some tier technology copy stays English. |
| 3 | User control and freedom | 3 | Retry, navigation, theme, and collapse exist; desktop collapse is in Sidebar. |
| 4 | Consistency and standards | 2 | Current glass shell conflicts with approved solid-surface Neo direction. |
| 5 | Error prevention | 1 | Missing Dashboard data can be mistaken for zero healthy events. |
| 6 | Recognition rather than recall | 3 | Labeled navigation and chart legend help; collapsed nav leans on title. |
| 7 | Flexibility and efficiency | 2 | Search and quick actions exist; key operational data appears late. |
| 8 | Aesthetic and minimalist design | 2 | Four equal KPI cards and repeated tiles flatten priority. |
| 9 | Error recovery | 3 | Retry exists, but contradictory cards remain visible. |
| 10 | Help and documentation | 1 | Little contextual explanation of tiers/unavailable telemetry on this page. |
| **Total** | | **22/40** | **Source-only baseline; not a visual score.** |

## Anti-patterns verdict

Design review: generic SaaS card stack despite distinctive operational data. Four equal KPI cards, then further card groups and six telemetry tiles; blurred translucent shell does not match the supplied solid-surface direction. Detector: Dashboard.jsx 0 findings. Expanded JSX scan 1 `broken-image` warning at `src/components/ui.jsx:830`, false positive from a JSX comment; actual conditional image has a nonempty source at line 843. No browser overlay was created because this checkout has no dependencies, no local server/backend listener, and protected Dashboard access requires a validated session.

## Overall impression

Truthful measured data is the strength. The main opportunity is to give capacity, current system state, and activity more space while preserving independent health and permission contracts.

## What's working

- Dashboard uses real `/api/dashboard`, `/api/storage`, `/healthz`, and telemetry rather than invented metrics.
- Telemetry distinguishes unavailable, stale, warning, and critical rather than turning missing readings into zero.
- Sidebar navigation is filtered by server-provided permissions; chart has a legend and reduced-motion setting.

## Priority issues

1. **[P1] Contradictory fetch-error state.** `src/screens/Dashboard.jsx:368-415` normalizes missing Dashboard payload to zeros while showing ErrorState; Files/Shares can say OK and security all-clear. Gate dependent claims on successful data; keep independently sourced health visible. Suggested command: `$impeccable harden`.
2. **[P1] Inverted operational hierarchy.** `src/screens/Dashboard.jsx:387-490` starts with four equal KPI cards; seven-day chart is `h-56` after health, history, links, and telemetry. Make storage/current state/chart primary; shrink secondary counts. Suggested command: `$impeccable layout`.
3. **[P2] Neo shell does not use authoritative backgrounds or solid hierarchy.** `src/index.css:1068-1118` uses radial gradient and translucent blur; `src/components/TopBar.jsx:66` hides hamburger on desktop while brand sits in Sidebar. Use supplied assets at repo-relative URLs, separate solid shell/card/inner surfaces, align desktop menu and brand. Suggested command: `$impeccable colorize`.
4. **[P2] Chart values depend on hover.** `src/screens/Dashboard.jsx:342-353` has axes, legend, and tooltip but no evident text/table equivalent. Add accessible seven-day summary or table and enlarge chart area. Suggested command: `$impeccable audit`.
5. **[P2] Localized and collapsed-nav affordances need validation.** Tier labels in `src/screens/Dashboard.jsx:81` include English technology text; collapsed nav in `src/components/Sidebar.jsx:43` relies on `title`. Verify EN/TH/ZH width and keyboard/touch identification. Suggested command: `$impeccable adapt`.

## Persona red flags

- Jordan, first-time Thai user: English tier terms and failed metrics paired with OK can mislead the first decision.
- Alex, operations power user: equal KPI/history sections force scrolling before comparing telemetry and activity.
- Sam, keyboard/screen-reader user: chart exact values lack an evident nonvisual equivalent; collapsed nav has no persistent text.

## Minor observations

- No actual Dashboard visual reference image was attached to this session when this critique ran.
- The detector's sole expanded-scope finding is a comment false positive, not a broken runtime image.

## Questions to consider

- Which operational decision should the first viewport answer?
- Should a failed Dashboard request suppress every dependent healthy claim while `/healthz` remains visible?
- Which seven-day activity values must be readable without hover?
