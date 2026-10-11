---
target: IDEA1 Neo Dashboard static source
total_score: 28
p0_count: 0
p1_count: 0
timestamp: 2026-10-05T22-07-00Z
slug: src-screens-dashboard-jsx
---
Method: dual-agent (A: /root/design_assessment · B: /root/detector_assessment)

# Static Neo Dashboard critique — IDEA1

The source is `src/screens/Dashboard.jsx` with its Neo-only shell and CSS. The two assessments were independent and source-only. The parent separately inspected the authenticated local page in Dark and Light at 320–1920 CSS pixels; the local metadata store was not connected, so populated charts and file lists could not be visually assessed.

## Design Health Score

| # | Nielsen heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of system status | 3 | Independent health probes and unavailable states are visible. |
| 2 | Match system / real world | 3 | Measured storage and telemetry are truthful; tier technology terms still use English. |
| 3 | User control and freedom | 3 | Desktop collapse and mobile drawer Escape/focus return work. |
| 4 | Consistency and standards | 3 | Solid Dark/Light Neo shell is coherent and scoped to Dashboard. |
| 5 | Error prevention | 3 | Missing Dashboard data no longer masquerades as zero or healthy. |
| 6 | Recognition rather than recall | 3 | Labels, active nav, chart legend, and accessible data table help. |
| 7 | Flexibility and efficiency | 2 | Search and quick actions exist; operational tasks still span screens. |
| 8 | Aesthetic and minimalist design | 3 | Storage and activity lead; secondary metrics are quieter. |
| 9 | Error recovery | 3 | Existing retry and independent status remain available. |
| 10 | Help and documentation | 2 | Contextual explanations are limited. |
| **Total** | | **28/40** | **Good; source-only assessment plus separate parent browser QA.** |

## Anti-patterns verdict

The layout is a conventional enterprise dashboard, but the operational hierarchy, supplied Neo atmosphere, solid panels, and restrained active-state spectrum keep it from an indiscriminate neon-card gallery. No fictional metrics, routes, users, or telemetry history were added. Detector B found zero warnings in changed Dashboard/shell JSX. Whole-source warnings were unrelated image-comment/string matches plus the pre-existing Login-only gradient text in `src/index.css:1637`; these are not Dashboard defects. No browser overlay was injected because the available browser evaluation surface is read-only.

## Overall impression

The central gain is honesty: the page says when Metadata is unavailable while showing separately measured Drive, storage, and telemetry states. The main remaining visual cost is the large authoritative background PNG payload.

## What's working

- Storage capacity, storage categories, and seven-day audit activity now occupy the primary Bento hierarchy; telemetry is prominent without invented historical trends.
- Dark and Light use the supplied repository assets, contrasting sidebar, solid surfaces, and restrained interactive lighting.
- Error gating, collapsed-nav labels, mobile focus containment, and screen-reader chart table improve task comprehension and access.

## Priority issues

1. **[P2] Large background transfer.** `public/assets/backgrounds/neo/Neo-Light_BG.png` is 8.8 MB and `Neo-Black_BG.png` is 10.2 MB. First Dashboard load may be slow on constrained networks. Keep the originals as visual authority; evaluate derivative compression only with owner approval. Suggested command: `$impeccable optimize`.
2. **[P2] Mixed-language tier terminology.** `src/screens/Dashboard.jsx:86-89` and existing tier headings in `src/lib/strings.js` use English `APPLICATION/METADATA/STORAGE LAYER`, `Express event loop`, and `Linux FS / HDD` in Thai and Chinese views. First-time readers need domain familiarity. Localize descriptive terms without changing probe semantics. Suggested command: `$impeccable clarify`.
3. **[P2] Populated-state visual proof remains unavailable.** The local in-memory server has no connected Metadata store; the browser can verify truthful unavailable states but not the full real-data chart/row rendering. Repeat browser QA against an approved connected test environment before release. Suggested command: `$impeccable audit`.

## Persona red flags

- **Alex, operations power user:** First viewport exposes current state quickly, but cross-screen investigation still requires navigation; no new shortcut was introduced.
- **Sam, keyboard/screen-reader user:** Drawer focus and chart table are improved; exact real-data chart semantics still require connected-environment validation.
- **Jordan, Thai first-time user:** English tier technology labels may require explanation, although the missing Metadata state is explicit.

## Minor observations

- Parent browser QA found and fixed a 320 px Lake Health row overflow after the independent assessments; a final 320 px DOM check shows no main-content overflow.
- Mobile Dashboard topbar menu, search, and theme targets measure 44 px after the final responsive pass.

## Questions to consider

- Can an approved connected test environment be provided for real-data visual QA before release?
- Are localized layer names desired, or should the English architecture vocabulary remain canonical?
- Is a compressed derivative of each authoritative background acceptable if visual comparison proves no meaningful change?
