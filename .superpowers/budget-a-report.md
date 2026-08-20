# Budget items 1-3 report

Commit: `e8db4ff` — "Persist build states, cap enrichment, and reclaim cache"

## Item 1 — Persist build states across sessions
- Added `readBuildStates`/`writeBuildStates` to `web/src/lib/cache.ts`, storing all
  build results as one JSON blob under `gh-build:v1` with a 7-day TTL, pruned on
  write.
- `PullRequestsView.tsx` now hydrates `buildSweep`'s `initialResults` via
  `useMemo(() => readBuildStates<PrBuildResult>(), [])` and persists via a
  `useEffect` keyed on `buildSweep.results` (not `onResult`, to avoid serialising
  the whole blob ~536 times per cycle). `useSweep` already skips items present in
  `results`, so hydrated entries cost zero requests on the next tab open.

## Item 2 — Cap enrichment per repo
- Replaced the flat newest-first `buildKeys` derivation with a per-repo cap:
  group `allPrs` by repo, sort each group by `createdAt` descending, take the
  first `MAX_ENRICHED_PRS_PER_REPO` (10), flatten, then sort the result
  newest-first globally before mapping to `prBuildKey`.

## Item 3 — Reclaim cache / stop hiding quota failures
- `migrateLegacyCache` now also removes every key matching
  `LEGACY_RESULT_PREFIXES` (`gh-result:v1:`), not just `gh-cache:`, and counts
  them in its return value.
- Added `reportQuotaFailure` (warns once per key via `console.warn`) and wired it
  into the catch blocks of `writeCache`, `writeArchived`, `writeResult`,
  `writeBranchResult`, `writeDefaultBranch`, and the new `writeBuildStates`. All
  writers still fail open.
- Also added `gh-build:v1` to `clearAllCache`'s cleanup set for consistency
  (not explicitly requested, but keeps the "clearing this site's storage"
  quota-warning message honest).

## Tests
Added `web/src/lib/cache.test.ts` (7 new tests) using a `FakeStorage` class
stubbed via `vi.stubGlobal('localStorage', ...)` in `beforeEach`/restored in
`afterEach` (suite runs under `environment: 'node'`, no real localStorage).
Covers: TTL drop/keep in `readBuildStates`, malformed-JSON → `{}`, empty-store →
`{}`, pruning in `writeBuildStates`, round-trip, and `migrateLegacyCache`
removing both legacy prefixes while leaving `gh-result:v2:` untouched
(plus idempotency). No existing test was modified.

## Verification (real output)
- `npm run typecheck` — passes, no errors.
- `npm test` — **59 passed (59)**, 6 test files (52 previous + 7 new in
  `cache.test.ts`).
- `npm run build` — succeeds; `tsc -b && vite build` produces
  `dist/assets/index-*.js` (185.24 kB / gzip 59.43 kB).

## Concerns
- None blocking. `clearAllCache` isn't called from any UI yet (pre-existing —
  it was already unused before this change), so the quota-warning message's
  "clearing this site's storage will restore it" still requires a manual
  DevTools clear until a UI control exists.
- Root of the main checkout has stray untracked `node_modules/`,
  `package.json`, `package-lock.json` (a minimal `{ "dependencies": { "jsdom":
  "^30.0.1" } }`) unrelated to this work — left untouched, not staged/committed.
