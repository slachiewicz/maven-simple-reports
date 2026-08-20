# Draft/Ready filter — report

**Commit:** `16c6c87` — "Add a draft/ready filter to the pull requests tab"
**Branch:** main (working checkout `/Users/slachiewicz/oss/maven-simple-reports`)

## What changed

1. **`web/src/components/SegmentedControl.tsx`** (new) — generic single-select
   control, `role="radiogroup"` + `role="radio"`/`aria-checked` per button
   (replaces the old `role="group"`/`aria-pressed` pattern). Reuses the
   existing `author-filter` / `author-filter-btn` / `author-filter-btn-active`
   CSS classes; count renders in `<span className="muted">` and is omitted
   when `count` is `undefined`.
2. **`web/src/components/AuthorFilter.tsx`** — `AuthorFilterControl` now
   delegates to `SegmentedControl`. Same exported name/props/behaviour, no
   caller changes needed.
3. **`web/src/lib/prFilters.ts`** (new) — `DraftFilter` type + pure
   `matchesDraftFilter(isDraft, filter)`.
4. **`web/src/lib/cache.ts`** — `readDraftFilter`/`writeDraftFilter`, key
   `gh-draft-filter:v1`, validated against the three literals, defaults to
   `'all'` on missing/garbage. Write routes failures through
   `reportQuotaFailure`.
5. **`web/src/views/PullRequestsView.tsx`** — `draftFilter` state hydrated
   from `readDraftFilter()`; second `SegmentedControl` (All/Ready/Draft)
   rendered next to the author control. `authorCounts` now conditions on
   `draftFilter` and `draftCounts` conditions on `authorFilter`, so each
   control's counts reflect what selecting that option would yield. No
   `useSweep` changes — filtering is purely local, zero network cost.
6. **`web/src/components/PrTable.tsx`** — added `draftFilter` prop, threaded
   into `RepoRows`. Extracted a single `matchesFilters(pr, authorFilter,
   draftFilter)` helper combining `matchesAuthorFilter` +
   `matchesDraftFilter`, used identically by the `hideEmpty` visibility test
   and the row-rendering filter, so the two can't drift (this is exactly the
   defect fixed one commit prior — verified not reintroduced).
7. Tests: `web/src/lib/prFilters.test.ts` (6 cases, all 3 filter values ×
   both `isDraft` states) and two new cases in `cache.test.ts`
   (`readDraftFilter` → `'all'` for missing key and for a garbage value).

## Gate results (real output)

- `npm run typecheck` → clean, no errors.
- `npm test` → **8 test files, 82 tests passed** (74 pre-existing + 6 new
  `prFilters.test.ts` + 2 new `cache.test.ts` cases). No existing test
  modified or weakened.
- `npm run build` → succeeded (`tsc -b && vite build`), output:
  `dist/index.html`, `dist/assets/index-*.css` (6.72 kB), `dist/assets/index-*.js`
  (188.66 kB).

`package.json` `dependencies` unchanged (`react`, `react-dom` only). Apache
2.0 header present on both new source files.

## Concerns

None. One pre-existing, unrelated stderr line appears during `npm test`
(a `[cache] could not persist PR results` warning from
`pullsGraphql.test.ts`'s "deleted account" case, expected/asserted-adjacent
behavior in that test, not something this change touched).

Note: the working tree also has untracked root-level `package.json`,
`package-lock.json`, `node_modules/`, and `.superpowers/budget-a-report.md`
left by other concurrent agents sharing this checkout — these were
deliberately left out of this commit as unrelated to the draft-filter task.
