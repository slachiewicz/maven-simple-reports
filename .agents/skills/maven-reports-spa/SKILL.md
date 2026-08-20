---
name: maven-reports-spa
description: Conventions and known traps for the maven-simple-reports dashboard SPA in web/ (Vite + React + TypeScript, GitHub GraphQL). Use this whenever touching anything under web/ — components, hooks, lib/, filters, caching, the sweep loop, or the PR fetch path — and also when reviewing changes to it, debugging why the dashboard shows stale or missing data, adding a filter or column, or changing anything about rate limiting, tokens, or polling. Several traps here have already shipped as real bugs; read this before editing rather than after.
---

# maven-simple-reports SPA

A static dashboard over ~157 repositories -- `apache/maven-*` plus the
non-archived `codehaus-plexus` and `mojohaus` ones: one tab of open pull
requests, one tab of stale branches. No server, no backend — the browser talks to
`api.github.com` directly, which is why almost every hard problem here is about
rate limits and caching rather than UI.

Read `CLAUDE.md` at the repo root for the architecture. This file covers what
that document can't: the mistakes that have actually been made in this codebase,
and why the odd-looking code is the way it is.

## Gates

Run all four from `web/`. Tests alone are not sufficient — a merge once produced
a tree where **52/52 tests passed and `tsc` failed**, because the tests didn't
import the broken module.

```bash
npm run typecheck && npm test && npm run build && npm run lint
```

`npm run lint` must report **0 errors**. Three warnings about unused
`eslint-disable` directives are pre-existing and fine.

## Traps

These are ordered by how much damage they've done.

### Hooks after an early return

`BranchesView` returns early when there's no token. A `useMemo` placed after that
return runs only on some renders, so the hook count changes the moment `hasToken`
flips false→true — which is exactly when someone pastes a token — and React
throws.

This shipped. It survived a code review that explicitly checked for conditional
hooks, and survived browser testing, because the page was always loaded with the
token *already* set. ESLint's `rules-of-hooks` found it in seconds.

**Every hook goes above every early return.** If lint complains here, it is right.

### Guards must survive StrictMode

`main.tsx` enables `StrictMode`, which double-invokes effects in dev. A plain
boolean "have I mounted yet" ref survives the synthetic remount, so the second
invocation sails past the guard.

`useSweep` guards with `lastItemsKeyRef` — comparing the last-seen key rather
than a boolean — precisely because the double-invoke carries an identical key and
so exits early. A boolean guard here was written, reviewed, and shipped broken.

This class of bug is nastier than it looks: dev behaviour differs from
production, so **manual testing shows the bug rather than the fix**.

### One predicate, two call sites

`PrTable` filters rows through `matchesFilters()` and *also* uses it to decide
which repos to hide when "hide repos without PRs" is ticked. When those two used
different predicates, every repo whose PRs were all filtered out rendered as an
empty "no open PRs" header while the box was checked.

This shipped **twice** — once for the author filter, again when the draft filter
was added. Both times it passed review, because reviewers only exercised the
default "All" filter, where the buggy and correct predicates agree.

**Any new filter goes into `matchesFilters()`.** Never filter rows in one place
and compute visibility in another.

### Exercise the non-default state

The pattern behind the previous trap generalises: this codebase's filter bugs
have all hidden in the *non-default* option. When adding or reviewing a toggle,
click the states nobody defaults to.

### Tab switches must not unmount a view

`App` keeps both views mounted and hides the inactive one, passing `active` down
so its `useSweep` parks through `enabled`. Conditional rendering looks tidier and
is the obvious "simplification" — it is also the bug: a sweep's queue lives in
its view's state, so unmounting discarded how far the cycle had got and coming
back refetched all 157 repos from the top. That reached a user.

Parking longer than the cycle interval still re-queues everything, on purpose:
the interval sleep expires and the data is due a refresh either way.

The signed-out invariant is unchanged — both views live behind `SignInPrompt`,
so with no credentials neither mounts and no request is issued.

## Rate limits shape everything

One budget, one fetch path: **5 000 GraphQL points/h** per token, spent by
`lib/pullsGraphql.ts` and `lib/branches.ts`.

**A token is mandatory.** GitHub rejects anonymous GraphQL outright, so
`App.tsx` renders `SignInPrompt` instead of either tab when there are no
credentials. Signed out, the app must issue **zero** requests — that is the
invariant to check in the network panel, not "the PR tab still works". The REST
path that once served anonymous visitors was deliberately removed (see _Why
GraphQL only_ in `web/README.adoc`); do not reintroduce a second fetch path to
restore the published page for signed-out visitors without asking first.

**Everything goes through one `SerialQueue`** (`apiQueue`, exported from
`lib/githubFetch.ts`). Never bypass it with a bare `fetch`. It provides
serialisation and the shared 403/429 backoff — a request that skips it skips
both and will hammer a rate-limited API.

**`GhRateLimitError` must propagate.** Every `catch` in a fetcher rethrows it so
the sweep pauses instead of retrying into a wall. Swallowing it into an error
result is a silent, expensive bug. Grep an existing fetcher before writing a new
one.

### Measuring cost

Cost per repo is a **rate between two samples**, never total ÷ count. Early repos
pay one-off setup, so the first reading is always inflated — this produced two
false alarms (16 points/repo that was really ~1, and 13 that was really ~2.7).
Take a second reading before reporting any number.

## Caching

Persisted state lives in `lib/cache.ts`, all of it in `localStorage` (~5 MB).
Two things to know:

- **Writers fail open but warn once** via `reportQuotaFailure`. The silent version
  was actively harmful: when the quota filled, the archived-repo cache stopped
  sticking and every cycle paid an extra call per repo — doubling cost invisibly
  and permanently.
- **`migrateLegacyCache` reclaims dead generations** on every load, including the
  `gh-cache:`, `gh-archived:v1:` and `gh-build:v1` families the removed REST path
  wrote. Deleting a cache family means adding its key there, not just deleting
  the reader.

When adding a persisted shape, bump its key version (`gh-result:v2:`) so old
entries can't be read as the new shape, and reclaim the old prefix in
`migrateLegacyCache`. A field that is *optional* needs no bump — that is the
whole point of `hasAssigneeData()`, which distinguishes "cached before this
column existed" from "genuinely empty".

## Conventions

- **Runtime dependencies are exactly `react` and `react-dom`.** Everything else
  is a devDependency. A TanStack Query pilot was run and rejected on measurement:
  +12.5 kB gzip and +55 lines with nothing removed, because the hard parts
  (serialisation, shared backoff) aren't what it replaces. Don't re-litigate
  without new evidence.
- **Apache 2.0 header** on every new source file, copied from `lib/types.ts`.
- **`ownerOf(repo)`** from `lib/repos.ts` — never hardcode an owner, and never
  assume `apache`: the sweep spans three organisations. Repo names carry the
  identity (cache keys, result objects) and the owner is looked up, which only
  works while names stay unique across the lists — `repos.test.ts` enforces
  that, and is why neither org's `.github` profile repo is listed. Repo counts
  come from `ALL_REPOS.length`, never a literal.
- **Tests cover pure logic**, in `lib/*.test.ts`, running under `environment:
  'node'` — so there is no `localStorage`; stub it with `vi.stubGlobal`. Note the
  filter bugs above were component logic, so a component test would have earned
  its keep.
- **Dates render in the viewer's locale and zone.** GitHub returns UTC, so a bare
  `iso.slice(0, 10)` is a day out for anyone far enough east or west.

## Run it

Reviews miss what a browser catches in seconds. After any change to fetching,
caching, or filters:

```bash
cd web && npm run dev   # http://localhost:5173/
```

Check specifically:

1. **Reload with a warm cache** — it must refetch. A version that fetched nothing
   on reload shipped, and is invisible on a cold load.
2. **The non-default filter states.**
3. **Without a token** — both tabs must show the sign-in panel, and the network
   panel must stay empty. A leftover sweep shows itself here.
