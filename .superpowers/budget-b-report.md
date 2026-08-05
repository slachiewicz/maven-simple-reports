# Budget item 4 report — GraphQL PR tab

Commit: (pending — see below)

## What was added

### `web/src/lib/pullsGraphql.ts` (new)
- `fetchRepoPrsGraphql(repo, token)` — one GraphQL query per repo
  (`isArchived` + `pullRequests(states:OPEN, first:100)` with `commits(last:1)
  { statusCheckRollup }` + `rateLimit`), returning the same `PrResult` shape
  the REST path (`fetchRepoPrs`) produces.
  - No token → returns an error-carrying `PrResult` without calling `fetch`
    (mirrors `fetchRepoBranches`).
  - Archived repo → empty result with `archived: true`, persisted via
    `writeResult` (same as REST).
  - Repository not found (`data.repository` null) → error result, not
    persisted (mirrors `fetchRepoBranches`'s `empty({ error: ... })`).
  - Every `catch` rethrows `GhRateLimitError`; everything else becomes a
    per-repo error result.
  - `truncated` set from `totalCount > nodes.length`.
  - `checksUrl` built identically to the REST path
    (`https://github.com/{owner}/{repo}/pull/{n}/checks`); `url` comes
    straight from the GraphQL node's `url` field.
- `mapRollupState(state)` — pure function mapping GraphQL `StatusState` onto
  the existing `BuildState`: `SUCCESS→SUCCESS`, `FAILURE|ERROR→FAILURE`,
  `PENDING|EXPECTED→PENDING`, anything else (including null/undefined/unknown
  string) → `UNKNOWN`. `buildStateFetchedAt` is set only when a rollup was
  present.
- Author classification calls `classifyAuthor(author?.login, author?.__typename
  === 'Bot' ? 'Bot' : 'User')`, reusing the existing REST logic verbatim. A
  null `author` (deleted account) yields `login=undefined` →
  `classifyAuthor` returns `'bot'`, identical to the REST path's
  `pr.user?.login ?? 'unknown'` / `classifyAuthor(undefined, undefined)`.

### `web/src/lib/types.ts`
- Added `truncated?: boolean` to `PrResult` (optional, so the REST path is
  unaffected).

### `web/src/components/PrTable.tsx`
- Added a truncation notice above the table controls, styled after
  `BranchTable.tsx`'s existing one: "N repo(s) have more than 100 open PRs;
  showing the first 100 of each (…)".

### `web/src/views/PullRequestsView.tsx`
- Added `graphqlSweep` (`enabled: authenticated`), alongside the existing
  `sweep` (now `enabled: !authenticated`) and `buildSweep` (now
  `enabled: !authenticated && sweep.pending.length === 0`). All three
  `useSweep` calls are unconditional (React hook rules), gated only by
  `enabled`.
- `restPrs` (renamed from the old `allPrs`) stays sourced from raw
  `sweep.results` — it feeds *only* `buildKeys` for the REST enrichment
  sweep, which is meaningless once GraphQL already carries build state.
- New `activeSweep` / `activeResults`: `graphqlSweep` when authenticated,
  else the existing REST `enrichedResults` (sweep + buildSweep merge).
  `allPrs`, `authorCounts`, `visibleResults`, `CycleStatus`, the "Refresh
  now" button, and `PrTable`'s `results`/`inFlight` props all now derive from
  this single value — no duplicated downstream logic.
- The "build status: X/Y" meta line is REST-specific (it reports enrichment
  sweep progress); since `buildSweep` never runs when authenticated it would
  otherwise show a permanently stuck "0/N". Wrapped it in `{!authenticated &&
  ...}` rather than leaving a misleading indicator — GraphQL badges arrive
  with the row, so there is no separate phase to report on.
- `tokenEpoch` wake effect now also calls `graphqlSweep.wake()`.
- Both sweeps hydrate from the same `hydratedResults` (`readAllResults`),
  since both paths persist via `writeResult` under the same
  `gh-result:v2:{repo}` key.

## Tests

New `web/src/lib/pullsGraphql.test.ts` (15 tests), `fetch` stubbed via
`vi.stubGlobal` following the `githubGraphql.test.ts` pattern (suite runs
under `environment: 'node'`):
- `mapRollupState`: all 5 enum values + null + undefined + an unrecognised
  string.
- No token → error result, `fetch` never called.
- Null author → `author: 'unknown'`, `authorClass: 'bot'` (matches REST).
- Bot author with dependabot login → `authorClass: 'dependabot'`.
- Plain `User` author → `authorClass: 'human'`.
- `truncated` true when `totalCount` (150) exceeds returned nodes (1);
  false when they match.
- Archived repo → `archived: true`, empty `prs`, no throw.
- Rollup present → `buildState` mapped, `buildStateFetchedAt` non-null.
- Rollup null → `buildState: 'UNKNOWN'`, `buildStateFetchedAt: null`.
- `RATE_LIMITED` GraphQL error → rejects with `GhRateLimitError` (not
  swallowed into an error result).
- HTTP 403 → rejects with `GhRateLimitError`.

No existing test was modified.

## Verification (real output)

- `npm run typecheck` — `tsc -b --noEmit`, no output, exit clean.
- `npm test`:
  ```
  ✓ src/lib/cache.test.ts (7 tests)
  ✓ src/lib/buildStatus.test.ts (8 tests)
  ✓ src/lib/useBuildStatusEnrich.test.ts (15 tests)
  ✓ src/lib/authors.test.ts (9 tests)
  ✓ src/lib/githubGraphql.test.ts (6 tests)
  ✓ src/lib/branches.test.ts (14 tests)
  ✓ src/lib/pullsGraphql.test.ts (15 tests)

  Test Files  7 passed (7)
       Tests  74 passed (74)
  ```
  (59 previous + 15 new = 74.) One expected `console.warn` from `writeResult`
  in the "classifies a null author" test — `localStorage` is unavailable
  under `environment: 'node'`, and `cache.ts` fails open by design (same
  behaviour every other `write*` test exercises); not a test failure.
- `npm run build` — `tsc -b && vite build` succeeds:
  `dist/assets/index-CY8uv9iX.js  187.66 kB │ gzip: 59.96 kB`.

I have no token, so I could not exercise the live GraphQL path against
api.github.com — all verification above is via stubbed `fetch`, as
instructed.

## Concerns

- None blocking. Root of the main checkout still has the stray untracked
  `node_modules/`, `package.json`, `package-lock.json` noted in
  `budget-a-report.md` — unrelated to this work, left untouched.
- The REST `buildKeys`/`buildSweep` machinery is still constructed
  (cheaply) even when authenticated, since all `useSweep` calls must be
  unconditional; it just never fires because `enabled` is false. No
  functional cost, only a tiny amount of otherwise-unused memoization.
