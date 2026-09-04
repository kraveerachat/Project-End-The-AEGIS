---
title: Task Receipt — IDEA1 Audit Log result filter label
date: 2026-09-04T02:15:00+07:00
owner: kla
area: idea1
branch: fix/idea1-audit-result-filter-label
status: complete
integration-review: no
edit_policy: append-by-new-file
---

# Task Receipt — IDEA1 Audit Log result filter label

`PRODUCTION_CHANGED = NO`. `PRODUCTION_ACCEPTANCE = NOT TESTED`.
`BACKEND_CHANGED = NO`. `FILTER_BEHAVIOUR_CHANGED = NO`.

A UX-copy fix confined to one control on one screen. No route, RBAC, contract,
server file or filtering rule was touched.

## Why

The Audit ledger has four filters in one row. A native `<select>` shows its
selected option, and that text is the only label the control has. Three of the
four named themselves in their resting option — `Date range · All`,
`Actor · All`, `Action · All` — and the result filter did not: it rendered a
bare `All`.

An auditor scanning the row therefore saw three named filters and one unlabelled
one, with no way to tell what it filtered without opening it. Nothing was
broken; the control was simply anonymous.

## What changed

- **`filterResult` added to all three locales** — `Result` / `ผลลัพธ์` /
  `结果`. Its own key rather than reusing `colResult`, for two reasons:
  `filterActor` / `filterAction` / `filterRange` already establish that
  convention for exactly this purpose, and `colResult` is the *table column
  head* — which is additionally declared twice in every locale, so the value it
  actually resolves to (`Result` / `ผล` / `结果`, the later declaration winning)
  is not obvious from the call site. The pre-existing duplication is left
  alone; this change simply does not depend on it.
- **Both options now lead with the filter's name**, so the trigger states the
  filter in either position:
  - `Result · All` / `ผลลัพธ์ · ทั้งหมด` / `结果 · 全部`
  - `Result · Denied only` / `ผลลัพธ์ · เฉพาะถูกปฏิเสธ` / `结果 · 仅被拒绝`
- **The control's accessible name moved from `colResult` to `filterResult`**,
  matching the other three filters and giving Thai screen-reader users
  *ผลลัพธ์* instead of the truncated *ผล*.
- **The box widened from `w-40` to `w-52`** (160px → 208px). This is required,
  not cosmetic: at `w-40` the inner width is 112px, while the English denied
  label measures 128px and the Thai one 142px — both would have been clipped,
  which would have defeated the point of the fix. Measured in the browser at
  the screen's own 13.5px font, all six strings now fit inside the 160px inner
  box; the tightest is Thai `ผลลัพธ์ · เฉพาะถูกปฏิเสธ` at 142px, 18px spare.
  Nothing else about the control changed — same `PillSelect`, same row, same
  spacing, same material.

## What deliberately did **not** change

- The filter still offers exactly two values, `all` and `denied`. The scope was
  **not** extended to separate `OK` / `DENIED` / `BLOCKED`.
- `denied` still means "every result that is not `OK`", which is what keeps a
  `BLOCKED` row visible under that option rather than silently dropping it.
- No server file, route, query, audit contract or RBAC rule was touched.
- The Audit page layout, ledger material, columns, export and empty states are
  untouched.

## Source files changed

- `IDEA1-AEGIS_Drive_LC/src/lib/strings.js` — `filterResult` in `en`, `th`,
  `zh` (+ a comment recording why it is its own key).
- `IDEA1-AEGIS_Drive_LC/src/screens/Audit.jsx` — the result `PillSelect`: both
  option labels, the `aria-label`, and the width.
- `IDEA1-AEGIS_Drive_LC/tests/auditFilterUI.test.js` — new, 5 tests.

## Verification evidence

- `cd IDEA1-AEGIS_Drive_LC && node --test tests/auditFilterUI.test.js` — pass:
  5 / 5. AUDIT-FILTER-1 and -2 fail against the pre-change markup (the resting
  option was a bare `All`), so they are real regression guards:
  - **1** — in every locale, both options lead with the filter's own name, the
    values are still exactly `all` + `denied`, and the resting option is never
    a bare "All".
  - **2** — all four filters in the row rest on `<name> · All`, i.e. one
    convention rather than three-plus-one.
  - **3** — every locale defines `filterResult`, and TH/ZH are real
    translations rather than the English fallback.
  - **4** — behaviour is unchanged: `denied` keeps `DENIED` **and** `BLOCKED`
    and drops `OK`; the default shows all three, and the screen's own counter
    reports `3 / 3`.
  - **5** — the label is read through `t('filterResult')`; no locale string is
    hardcoded in `Audit.jsx`.
- `cd IDEA1-AEGIS_Drive_LC && npm test` — pass: 835 tests / 768 pass / **0
  fail** / 67 PostgreSQL-gated skips (no `TEST_DATABASE_URL`), the 5 new tests
  included.
- `node --test tests/auditFilterUI.test.js tests/auditViewer.test.js
  tests/i18nCopyAudit.test.js tests/allScreensEmptyState.test.js` — pass:
  30 / 30. This is the group most exposed to a copy change: the existing
  locale-parity audit and the audit viewer's own tests both stay green.
- `cd IDEA1-AEGIS_Drive_LC && npm run build` — pass (built in 4.50 s); `dist/`
  restored with `git checkout` and **not** included in the branch.
- **Layout unchanged:** at 1024px the filter row wraps to two lines both with
  the old `w-40` and the new `w-52` — measured by swapping the class back in
  the live DOM and re-measuring. The extra width does not move the wrap point.
- **Browser, real app** (dev server, in-memory store, Admin session, 1440×900):
  the Audit filter row reads `Date range · All` · **`Result · All`** ·
  `Actor · All` · `Action · All` in English, and
  `ช่วงเวลา · ทั้งหมด` · **`ผลลัพธ์ · ทั้งหมด`** · `ผู้กระทำ · ทั้งหมด` ·
  `การกระทำ · ทั้งหมด` in Thai.
- **Keyboard:** the control is focusable and tabbable; changing it by keyboard
  moves the trigger to `Result · Denied only` and sets the value to `denied`.
  Its accessible name reads `Result` / `ผลลัพธ์`.
- **Fit:** all six locale strings measured against the rendered inner width —
  all fit, tightest 142/160px.
- Not run: any production host; PostgreSQL-gated tests (no `TEST_DATABASE_URL`).
  Live ledger rows could not be shown in the browser because the in-memory dev
  store is not a wired platform, so the screen correctly renders its
  "not connected" state — the row-level filtering is covered by AUDIT-FILTER-4,
  which renders the real component with fixture events.

## Canonical notes updated

- `Obsidian_AEGIS_Vault/AEGIS_Knowledge/idea1/idea1-status.md` — one paragraph
  recording the audit filter labelling convention.

## Shared surfaces touched

None. All changed paths are inside `IDEA1-AEGIS_Drive_LC/`. IDEA2 and IDEA3
were not touched.

## Integration requests

- **Kla (owner review, IDEA1):** no integration review required — no contract,
  route, RBAC rule or backend behaviour changed, and the filter's value domain
  is unchanged.

## Known limitations

- `colResult` remains declared twice in each locale in `strings.js`
  (`RESULT`/`Result`, `ผลลัพธ์`/`ผล`, `结果`/`结果`), so the later declaration
  silently wins. This change removes the audit filter's dependence on it but
  does not clean it up; that is a separate, wider edit to shared copy.
- The three specific-value filters (actor, action) still show raw values
  without a prefix once a specific value is chosen — unchanged, and correct:
  the prefix exists to name the filter when it is resting on "All".
- Verified in the embedded preview browser only; no cross-browser check.
