# All PRs and All Branches — Design

Date: 2026-08-04
Status: Approved for planning

## Problem

The dashboard shows only open Dependabot pull requests. Two things are invisible:

1. Pull requests from every other author — committers, outside contributors, bots
   other than Dependabot.
2. Branches themselves. In particular, branches nobody has touched in months and
   that have no pull request attached: candidates for deletion or revival.

`web/src/lib/dependabot.ts` already fetches every open PR per repository and
discards non-Dependabot ones client-side at line 91, so the PR data is being paid
for and thrown away. Branch data is not fetched at all.

## Scope

Two views over the 98 `apache/maven-*` repositories in `web/src/lib/repos.ts`:

- **Pull requests** — every open PR regardless of author. REST. Works without a
  token, as today.
- **Branches** — stale-branch hunting. GraphQL. Requires a token.

Out of scope for this iteration: pagination beyond the first 100 items per
repository, branch build status, merge-conflict detection, and any change to the
OAuth flow or the Netlify Functions.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Meaning of "all branches" | Both: all PRs *and* a branches view | User request |
| Branches view purpose | Spot stale/abandoned branches | User choice |
| Branches API | GraphQL, token-gated | REST needs ~2 extra calls per branch; GraphQL needs one query per repo |
| PR API | REST, unchanged | Preserves anonymous access to the published dashboard |
| PR author default | All authors | User choice |
| Check-run strategy | Two-phase progressive | ~500 PRs × 2 calls would stall the anonymous 60/h budget before the table renders |
| Branches default view | Stale only, oldest first | User choice |

### Why the PR view does not also move to GraphQL

GraphQL would be cheaper and would supply `statusCheckRollup` in one field. It
also requires a token unconditionally — GitHub rejects anonymous GraphQL. The
published GitHub Pages dashboard is currently viewable by anyone, and that
property is worth keeping. Maintaining REST and GraphQL implementations of the
same view is not, so the PR view stays on REST only.

## Architecture

### Component structure

```
App.tsx                     shell: token/OAuth state, repo filter, tab switch
├── views/PullRequestsView   REST sweep, author filter, PR table
└── views/BranchesView       GraphQL sweep, stale filter, branch table
```

Active tab is held in the URL as `?view=prs|branches`, defaulting to `prs`, so a
view is linkable and survives reload. **Only the visible tab sweeps.** Switching
tabs starts that view's sweep and lets the other idle; the two never fetch
concurrently and cannot contend for quota.

### Extracted polling loop

`App.tsx:219-339` currently holds the sweep machinery: pending-queue drain,
`GhRateLimitError` pause with buffer, interruptible sleep, restart-token wakeup
on filter/token change, and cycle-interval scheduling. This moves to
`web/src/lib/useSweep.ts` as:

```ts
useSweep<T>({
  items: readonly string[],
  fetchOne: (item: string, token: string | undefined) => Promise<T>,
  intervalMs: number,
  enabled: boolean,
}): {
  results: Record<string, T>,
  cycle: CycleState,
  refreshNow: () => void,
}
```

The behaviour must be carried across unchanged — it encodes non-obvious handling
of rate-limit pauses and mid-cycle restarts. `enabled: false` (used by the
branches view when no token is present) parks the loop without unmounting it.

Extracting this is load-bearing, not cosmetic: the alternative is duplicating
~120 lines of pause/restart logic into the second view.

### Files

| Path | Change |
|---|---|
| `web/src/App.tsx` | Reduced to shell + tabs |
| `web/src/lib/useSweep.ts` | New — extracted polling loop |
| `web/src/lib/dependabot.ts` | Renamed to `web/src/lib/pulls.ts`; author filter removed; checks split into phase 2 |
| `web/src/lib/githubGraphql.ts` | New — GraphQL POST client sharing the existing `SerialQueue` |
| `web/src/lib/branches.ts` | New — branch query, response mapping, stale predicate |
| `web/src/views/PullRequestsView.tsx` | New |
| `web/src/views/BranchesView.tsx` | New |
| `web/src/components/PrTable.tsx` | Author column, author filter control |
| `web/src/components/BranchTable.tsx` | New |
| `web/src/lib/types.ts` | `DependabotPr` → `PullRequestInfo`; new `BranchInfo`, `RepoBranchResult` |
| `web/src/lib/cache.ts` | Cache key version bump; branch result namespace; new preference keys |

## Pull requests view

### Fetching

Remove `isDependabotAuthor` filtering (`dependabot.ts:43-48`, applied at line
91). Authorship becomes a display attribute, not a fetch filter.

Split the current inline check-run fetch into two phases, both driven by
`useSweep`:

**Phase 1 — inventory.** One `GET /repos/apache/{repo}/pulls?state=open&per_page=100`
per repository, 98 calls. The archived-repo short-circuit
(`dependabot.ts:59-84`) is preserved unchanged. Every PR renders immediately
with `buildState: 'UNKNOWN'`.

**Phase 2 — enrichment.** Walks the accumulated PRs newest-first by `createdAt`,
issuing the existing check-runs + legacy-status pair per PR and patching
`buildState` in place. A `GhRateLimitError` here pauses only phase 2; the
inventory stays on screen and usable.

This ordering is the point: at ~500 open PRs across all authors, enrichment is
~1000 calls. An anonymous visitor with a 60/h budget will never finish it, but
with phase 1 first they still get the complete PR inventory within about a
minute.

Phase 2 results are cached per head SHA, so unchanged PRs are not re-enriched on
the next cycle.

### Display

New **Author** column. A segmented control filters `Dependabot | Humans | All`,
defaulting to **All**, persisted in `localStorage`. The filter is client-side
over already-fetched data, so switching is instant and costs no quota.

"Humans" means `user.type !== 'Bot'` and the login does not match the existing
`DEPENDABOT_LOGIN_PATTERNS`. "Dependabot" reuses those patterns unchanged.

Header text, the empty-repo message at `PrTable.tsx:231` ("no Dependabot PRs"),
and the summary count at `App.tsx:386` are updated to reflect the active filter
rather than hardcoding "Dependabot".

## Branches view

### Token gate

GitHub's GraphQL API rejects unauthenticated requests. With no PAT and no OAuth
session, the view renders a sign-in panel reusing the existing `TokenInput`
component and issues no request. `useSweep` is held at `enabled: false`. When a
token appears the sweep starts automatically.

### Query

One query per repository:

```graphql
query($owner:String!, $repo:String!, $defaultBranch:String!) {
  repository(owner:$owner, name:$repo) {
    isArchived
    defaultBranchRef { name }
    refs(refPrefix:"refs/heads/", first:100) {
      totalCount
      nodes {
        name
        target { ... on Commit { oid committedDate author { user { login } name } } }
        associatedPullRequests(states:OPEN, first:1) { totalCount }
        compare(headRef:$defaultBranch) { aheadBy behindBy }
        refUpdateRule { requiredApprovingReviewCount allowsForcePushes }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}
```

`$defaultBranch` is not known before the first query for a repository. Resolve it
by running the query in two steps on first contact per repo — a cheap
`defaultBranchRef` lookup, then the full query — and cache the default branch
name in `localStorage` with the same 7-day TTL as the existing archived-repo
cache. Subsequent cycles use the cached value and issue one query.

### Compare direction

`Ref.compare(headRef:)` documents the ref itself as the **base** and the argument
as the **head**. Querying `compare(headRef: defaultBranch)` from a feature branch
therefore returns:

- `aheadBy` = commits the default branch has that the feature branch lacks
  = **how far behind the branch is**
- `behindBy` = commits the feature branch has that the default branch lacks
  = **how far ahead the branch is**

These read inverted from intuition. The mapping is inverted once, in
`branches.ts`, with a comment at the call site, and `BranchInfo` stores the
already-corrected `behindBy`/`aheadBy`. Nothing downstream re-inverts.

### Ordering

`RefOrderField` offers only `ALPHABETICAL` and `TAG_COMMIT_DATE`, and the latter
is specified as meaningful only for `refs/tags/`. Branches therefore cannot be
server-side sorted by commit date. All refs for a repository are fetched and
sorted client-side by `committedDate` ascending.

### Stale filter

Default view hides:

- the default branch,
- branches with `refUpdateRule != null` (protected),
- branches with `associatedPullRequests.totalCount > 0`,
- branches whose `committedDate` is newer than the staleness threshold.

Threshold defaults to **90 days**, is adjustable in the UI, and is persisted. A
"Show all branches" toggle disables all four exclusions. Sort is oldest commit
first in both modes.

Columns: `Branch · Last commit (age) · Last author · Behind/Ahead · PR · Repo`.
Rows group by repository, mirroring `PrTable`'s existing collapsible grouping.

### Protected-branch detection

`branchProtectionRule` is readable only by repository admins, which we are not on
`apache/maven-*`; it would return `null` for every branch and silently defeat the
"hide protected branches" exclusion. `refUpdateRule` exposes the same protection
to non-admins and is the field used. Its presence, not its contents, is the
signal.

### Cost accounting

Every query selects `rateLimit { cost remaining resetAt }`, so spend is measured
rather than estimated. Estimated 3–6 points per repository, giving roughly
300–600 points per 98-repo sweep against a 5 000/h budget. Default cycle interval
is **10 minutes**, leaving headroom; the observed `remaining` value drives the
existing pause logic through the shared `SerialQueue`.

### Failure handling

- **Query timeout.** `compare` is evaluated per ref; 100 refs in one query may
  exceed GitHub's query timeout on large repositories. On timeout, retry that
  repository once without the `compare` selection and render age and PR status
  with ahead/behind blank, marking the row so the degradation is visible.
- **Truncation.** `first: 100` silently truncates. `totalCount` is compared
  against the returned node count; a repository over the limit shows
  "showing 100 of N". No pagination in this iteration.
- **GraphQL error shape.** GraphQL returns HTTP 200 with an `errors` array.
  `githubGraphql.ts` must treat a non-empty `errors` array as a failure rather
  than trusting the status code, and must map `RATE_LIMITED` errors onto the
  existing `GhRateLimitError` so the shared queue backoff applies.

## Caching

REST response caching (`sessionStorage`, ETag) and persisted results
(`localStorage`) keep their current split. Changes:

- `gh-result:v1:` → `gh-result:v2:` — the PR shape changes with the author field
  and the phase-2 split, and a v1 entry must not be read as v2.
- New `gh-branches:v1:` namespace for persisted branch results.
- New `gh-default-branch:v1:` namespace, 7-day TTL.
- New preference keys for author filter, stale threshold, show-all-branches, and
  active tab.

GraphQL responses are not ETag-cached; POST responses do not carry usable ETags.
Branch results persist to `localStorage` so a reopened tab renders instantly
before its own sweep completes, matching current PR behaviour.

## Testing

`web/` has no test setup. Add Vitest and cover the pure logic only, using
recorded fixtures captured from real API responses:

- `deriveBuildState` across check-run and legacy-status combinations, including
  the Apache Jenkins legacy-status case noted at `dependabot.ts:118-120`.
- Author classification: Dependabot patterns, bots, humans.
- The stale-branch predicate against each exclusion (default branch, protected
  via `refUpdateRule`, has open PR) and the threshold boundary.
- The compare-direction inversion — a branch known to be behind must report
  `behindBy`, guarding the one genuinely confusing mapping.
- GraphQL error-array handling, including `RATE_LIMITED` → `GhRateLimitError`.

Not covered: React components, network behaviour, and the sweep loop. The sweep
loop is moved verbatim rather than rewritten, and stays verified by hand.

## Documentation

- `web/README.adoc` — new Branches section, token requirement, revised rate-limit
  and known-limitations text.
- `CLAUDE.md` — the "Build status detection (SPA)" and project-overview sections
  describe the dashboard as Dependabot-only and need revising.

## Risks

| Risk | Mitigation |
|---|---|
| Anonymous PR sweep never finishes phase 2 | Phase 1 renders the full inventory first; badges fill progressively |
| `compare` causes query timeouts | Retry without `compare`, degrade visibly |
| Repos exceed 100 branches or PRs | `totalCount` comparison surfaces truncation |
| `useSweep` extraction changes pause behaviour subtly | Move verbatim; do not refactor while extracting |
| `localStorage` pressure from branch results | v2 key bump plus the existing `clearAllCache` path |
