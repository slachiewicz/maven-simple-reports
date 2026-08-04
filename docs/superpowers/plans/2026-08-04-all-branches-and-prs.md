# All PRs and All Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show open pull requests from every author (not just Dependabot), and add a second view that finds stale branches across the 98 `apache/maven-*` repositories.

**Architecture:** Two tabs in the existing Vite/React SPA, selected by `?view=prs|branches`. The pull-requests tab keeps using the REST API so it still works without a token, and splits its sweep into an inventory phase and a build-status enrichment phase. The branches tab uses the GraphQL API, which requires a token, and shows a sign-in panel when none is present. The polling loop currently embedded in `App.tsx` is extracted so both tabs share it.

**Tech Stack:** TypeScript 5.6, React 18, Vite 5, Vitest (added by this plan), GitHub REST API v3 and GraphQL API v4.

**Reference spec:** `docs/superpowers/specs/2026-08-04-all-branches-and-prs-design.md`

## Global Constraints

- **Node.js 20+.** Do not use APIs newer than Node 20 / ES2022.
- **No new runtime dependencies.** `web/package.json` `dependencies` stays exactly `react` and `react-dom`. Vitest goes in `devDependencies` only.
- **Every new file** starts with the Apache 2.0 license header block copied verbatim from `web/src/lib/types.ts` lines 1-15. Code blocks in this plan omit it for brevity; add it to every file you create.
- **Owner is `apache`**, from `MAVEN_OWNER` in `web/src/lib/repos.ts:17`. Never hardcode it elsewhere.
- **98 repositories** in `MAVEN_REPOS` (`web/src/lib/repos.ts:19`). Any count in UI text must be derived from `MAVEN_REPOS.length`, never written as a literal.
- **Strict TypeScript.** `noUnusedLocals` and `noUnusedParameters` are on; unused imports break the build.
- **`npm run typecheck` and `npm test` must pass before every commit.** Run both from `web/`.
- **Out of scope — do not implement:** pagination past 100 items per repo, build status for branches, merge-conflict detection, changes to the OAuth flow or `netlify/functions/`.
- **Rate-limit semantics are load-bearing.** `GhRateLimitError` pauses a sweep and re-queues the failed item. Never swallow it.

---

### Task 1: Test infrastructure and build-status characterization tests

Establishes Vitest against the one non-trivial pure function that already exists, so later tasks have somewhere to put tests. `deriveBuildState` is currently untested and Task 4 moves its call sites, so pinning its behaviour first protects that refactor.

**Files:**
- Create: `web/vitest.config.ts`
- Create: `web/src/lib/buildStatus.test.ts`
- Modify: `web/package.json`

**Interfaces:**
- Consumes: `deriveBuildState(checks: CheckRunsResponse, status?: CommitStatusResponse | null): BuildState` from `web/src/lib/buildStatus.ts:42`
- Produces: `npm test` script; test files matched by `src/**/*.test.ts`

- [ ] **Step 1: Install Vitest**

```bash
cd web && npm install --save-dev vitest@^2.1.0
```

- [ ] **Step 2: Add test scripts to `web/package.json`**

In the `"scripts"` block, after `"typecheck"`, add:

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 3: Create `web/vitest.config.ts`**

Environment is `node`, not `jsdom`: this plan tests pure logic only, never components.

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

- [ ] **Step 4: Write the characterization tests**

Create `web/src/lib/buildStatus.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { deriveBuildState, type CheckRunsResponse } from './buildStatus'

function checks(...runs: Array<{ status: string; conclusion: string | null }>): CheckRunsResponse {
  return { total_count: runs.length, check_runs: runs }
}

describe('deriveBuildState', () => {
  it('returns UNKNOWN with no checks and no statuses', () => {
    expect(deriveBuildState(checks(), null)).toBe('UNKNOWN')
  })

  it('returns SUCCESS for a completed successful run', () => {
    expect(deriveBuildState(checks({ status: 'completed', conclusion: 'success' }), null)).toBe(
      'SUCCESS',
    )
  })

  it('treats neutral and skipped as SUCCESS', () => {
    expect(deriveBuildState(checks({ status: 'completed', conclusion: 'neutral' }), null)).toBe(
      'SUCCESS',
    )
    expect(deriveBuildState(checks({ status: 'completed', conclusion: 'skipped' }), null)).toBe(
      'SUCCESS',
    )
  })

  it('returns PENDING for an in-progress run', () => {
    expect(deriveBuildState(checks({ status: 'in_progress', conclusion: null }), null)).toBe(
      'PENDING',
    )
  })

  it('lets FAILURE win over PENDING and SUCCESS', () => {
    const state = deriveBuildState(
      checks(
        { status: 'completed', conclusion: 'success' },
        { status: 'in_progress', conclusion: null },
        { status: 'completed', conclusion: 'failure' },
      ),
      null,
    )
    expect(state).toBe('FAILURE')
  })

  it('treats timed_out, cancelled, action_required and startup_failure as FAILURE', () => {
    for (const conclusion of ['timed_out', 'cancelled', 'action_required', 'startup_failure']) {
      expect(deriveBuildState(checks({ status: 'completed', conclusion }), null)).toBe('FAILURE')
    }
  })

  // Apache Jenkins (ci-maven.apache.org) reports via the legacy combined-status
  // API rather than CheckRuns. Without this source the dashboard misses Jenkins
  // failures entirely — see buildStatus.ts:34-36.
  it('picks up a Jenkins failure that exists only in the legacy status API', () => {
    const state = deriveBuildState(checks({ status: 'completed', conclusion: 'success' }), {
      state: 'failure',
      statuses: [{ state: 'failure', context: 'Jenkins' }],
    })
    expect(state).toBe('FAILURE')
  })

  it('ignores the rolled-up combined state when the statuses array is empty', () => {
    const state = deriveBuildState(checks({ status: 'completed', conclusion: 'success' }), {
      state: 'pending',
      statuses: [],
    })
    expect(state).toBe('SUCCESS')
  })
})
```

- [ ] **Step 5: Run the tests**

Run: `cd web && npm test`
Expected: PASS, 8 tests. If any fail, the assertion is wrong — `deriveBuildState` is existing working code; fix the test, not the source.

- [ ] **Step 6: Typecheck**

Run: `cd web && npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/package-lock.json web/vitest.config.ts web/src/lib/buildStatus.test.ts
git commit -m "Add Vitest and characterization tests for build-state derivation"
```

---

### Task 2: Extract the polling loop into useSweep

`App.tsx:219-339` holds the sweep machinery. The branches view needs the same behaviour, and copying it would duplicate subtle pause/restart logic.

**Move the logic verbatim.** Do not "improve" it while extracting. Its rate-limit pause, restart-token wakeup, and interruptible sleep are load-bearing and hard to re-derive.

**Files:**
- Create: `web/src/lib/useSweep.ts`
- Modify: `web/src/App.tsx` (remove lines 219-339 and the state they own)

**Interfaces:**
- Consumes: `GhRateLimitError`, `clearQueueBackoff` from `web/src/lib/githubFetch.ts`
- Produces:
  - `interface CycleState { startedAt: number | null; completedAt: number | null; inFlight: string | null; nextCycleAt: number | null; pausedUntil: number | null }`
  - `interface SweepOptions<T> { items: readonly string[]; fetchOne: (item: string, token: string | undefined) => Promise<T>; getToken: () => Promise<string | undefined>; intervalMs: number; enabled: boolean; initialResults?: Record<string, T>; onResult?: (item: string, value: T) => void }`
  - `interface SweepResult<T> { results: Record<string, T>; cycle: CycleState; pending: string[]; refreshNow: () => void; wake: () => void }`
  - `useSweep<T>(opts: SweepOptions<T>): SweepResult<T>`

- [ ] **Step 1: Create `web/src/lib/useSweep.ts`**

```ts
import { useEffect, useRef, useState } from 'react'
import { GhRateLimitError, clearQueueBackoff } from './githubFetch'

const RATE_LIMIT_PAUSE_BUFFER_MS = 5_000

export interface CycleState {
  startedAt: number | null
  completedAt: number | null
  inFlight: string | null
  nextCycleAt: number | null
  pausedUntil: number | null
}

const initialCycle: CycleState = {
  startedAt: null,
  completedAt: null,
  inFlight: null,
  nextCycleAt: null,
  pausedUntil: null,
}

export interface SweepOptions<T> {
  /** Keys to fetch. Changing this re-queues only keys not already in results. */
  items: readonly string[]
  fetchOne: (item: string, token: string | undefined) => Promise<T>
  getToken: () => Promise<string | undefined>
  intervalMs: number
  /** When false the loop parks without unmounting; flipping to true starts it. */
  enabled: boolean
  initialResults?: Record<string, T>
  onResult?: (item: string, value: T) => void
}

export interface SweepResult<T> {
  results: Record<string, T>
  cycle: CycleState
  pending: string[]
  refreshNow: () => void
  wake: () => void
}

export function useSweep<T>(opts: SweepOptions<T>): SweepResult<T> {
  const [results, setResults] = useState<Record<string, T>>(() => opts.initialResults ?? {})
  const [pending, setPending] = useState<string[]>([...opts.items])
  const [cycle, setCycle] = useState<CycleState>(initialCycle)

  // Seeded with every item, not empty: the old loop always re-verified all repos
  // on load. See the mount guard in the items-changed effect below.
  const pendingRef = useRef<string[]>([...opts.items])
  const didMountRef = useRef(false)
  const itemsRef = useRef<readonly string[]>(opts.items)
  const resultsRef = useRef<Record<string, T>>(results)
  const restartTokenRef = useRef(0)

  // Latest-value refs so the loop below can keep empty deps. The loop must be
  // started exactly once; re-running the effect would abandon an in-flight
  // rate-limit pause.
  const fetchOneRef = useRef(opts.fetchOne)
  const getTokenRef = useRef(opts.getToken)
  const intervalRef = useRef(opts.intervalMs)
  const enabledRef = useRef(opts.enabled)
  const onResultRef = useRef(opts.onResult)

  fetchOneRef.current = opts.fetchOne
  getTokenRef.current = opts.getToken
  intervalRef.current = opts.intervalMs
  onResultRef.current = opts.onResult

  useEffect(() => {
    resultsRef.current = results
  }, [results])

  const syncPending = () => setPending([...pendingRef.current])

  const wake = () => {
    // Callers (updateToken/updateOauth) need the queue's own backoff lifted too,
    // so a token saved during a rate-limit pause takes effect immediately rather
    // than waiting out the anonymous reset.
    clearQueueBackoff()
    restartTokenRef.current += 1
  }

  const refreshNow = () => {
    clearQueueBackoff()
    pendingRef.current = [...itemsRef.current]
    restartTokenRef.current += 1
    syncPending()
    setCycle((c) => ({
      ...c,
      startedAt: Date.now(),
      completedAt: null,
      nextCycleAt: null,
      pausedUntil: null,
    }))
  }

  // Item-set changes queue only what is not already fetched, matching the
  // filter-change behaviour the previous App.tsx had at lines 200-217.
  const itemsKey = opts.items.join('\n')
  useEffect(() => {
    itemsRef.current = opts.items
    // Mount: pendingRef is already seeded with every item, matching the old loop
    // (App.tsx:106,110 seeded from initialActive unconditionally) which always
    // re-verified all repos on load — ETag 304s make that cheap. Filtering here
    // on mount would skip every repo holding a cached result, and persisted
    // results carry no TTL, so a warm cache would fetch nothing at all.
    if (!didMountRef.current) {
      didMountRef.current = true
      return
    }
    const fetched = new Set(Object.keys(resultsRef.current))
    pendingRef.current = opts.items.filter((i) => !fetched.has(i))
    restartTokenRef.current += 1
    syncPending()
    setCycle((c) => ({
      ...c,
      startedAt: c.startedAt ?? Date.now(),
      completedAt: pendingRef.current.length === 0 ? c.completedAt : null,
      nextCycleAt: pendingRef.current.length === 0 ? c.nextCycleAt : null,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on itemsKey
  }, [itemsKey])

  useEffect(() => {
    const wasEnabled = enabledRef.current
    enabledRef.current = opts.enabled
    if (opts.enabled && !wasEnabled) {
      clearQueueBackoff()
      restartTokenRef.current += 1
    }
  }, [opts.enabled])

  useEffect(() => {
    let cancelled = false

    const interruptibleSleep = async (ms: number, token: number): Promise<'done' | 'restart'> => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (cancelled) return 'done'
        if (restartTokenRef.current !== token) return 'restart'
        await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())))
      }
      return 'done'
    }

    const loop = async () => {
      while (!cancelled) {
        if (!enabledRef.current) {
          const tok = restartTokenRef.current
          await interruptibleSleep(500, tok)
          continue
        }

        // Functional update only: this effect has empty deps, so any `cycle`
        // read here would be frozen at first render.
        setCycle((c) => (c.startedAt === null ? { ...c, startedAt: Date.now() } : c))

        while (pendingRef.current.length > 0 && !cancelled && enabledRef.current) {
          const item = pendingRef.current[0]
          setCycle((c) => ({ ...c, inFlight: item }))
          try {
            const value = await fetchOneRef.current(item, await getTokenRef.current())
            if (cancelled) return
            setResults((prev) => ({ ...prev, [item]: value }))
            onResultRef.current?.(item, value)
            pendingRef.current = pendingRef.current.filter((r) => r !== item)
            syncPending()
          } catch (err) {
            if (err instanceof GhRateLimitError) {
              const until = err.until + RATE_LIMIT_PAUSE_BUFFER_MS
              setCycle((c) => ({ ...c, inFlight: null, pausedUntil: until }))
              const tok = restartTokenRef.current
              const wait = until - Date.now()
              if (wait > 0) {
                const outcome = await interruptibleSleep(wait, tok)
                if (outcome === 'restart') {
                  setCycle((c) => ({ ...c, pausedUntil: null }))
                  continue
                }
              }
              if (cancelled) return
              setCycle((c) => ({ ...c, pausedUntil: null }))
              // Sleep expired naturally — retry the same item, still at the head.
              continue
            }
            // Unrecognized error — the caller's fetchOne is responsible for
            // encoding it into T. Reaching here means it threw instead; drop the
            // item so the sweep cannot wedge.
            pendingRef.current = pendingRef.current.filter((r) => r !== item)
            syncPending()
          }
        }
        if (cancelled) return

        const interval = intervalRef.current
        const completed = Date.now()
        setCycle((c) => ({
          ...c,
          completedAt: completed,
          inFlight: null,
          nextCycleAt: completed + interval,
          pausedUntil: null,
        }))
        const tok = restartTokenRef.current
        const outcome = await interruptibleSleep(interval, tok)
        if (cancelled) return
        if (outcome === 'restart') continue
        pendingRef.current = [...itemsRef.current]
        syncPending()
        setCycle((c) => ({ ...c, startedAt: Date.now(), completedAt: null, nextCycleAt: null }))
      }
    }

    void loop()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start once, drive via refs
  }, [])

  return { results, cycle, pending, refreshNow, wake }
}
```

- [ ] **Step 2: Rewire `App.tsx` to use it**

Delete the `useEffect` at `App.tsx:219-339`, the `CycleState` interface and `initialCycle` (lines 55-69), the `cycle`/`pending`/`repos` state, `pendingRef`, `activeReposRef`, `restartTokenRef`, `syncPending`, and the local `refreshNow`. Keep `acquireToken` but hoist it to a `useCallback` in the component body. Import `CycleState` from `./lib/useSweep` instead of declaring it.

Replace with:

```ts
  const acquireToken = useCallback(async (): Promise<string | undefined> => {
    const current = oauthRef.current
    if (current) {
      if (!refreshTokenStillValid(current)) {
        console.warn('OAuth refresh token expired; falling back to PAT/anonymous')
        updateOauth(null)
      } else if (needsRefresh(current)) {
        try {
          const refreshed = await refreshOAuthToken(current.refresh_token)
          updateOauth(refreshed)
          return refreshed.access_token
        } catch (err) {
          console.error('OAuth token refresh failed; falling back to PAT/anonymous', err)
          setOauthError(err instanceof Error ? err.message : String(err))
          updateOauth(null)
        }
      } else {
        return current.access_token
      }
    }
    return tokenRef.current || undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const authenticated = !!oauth || !!token

  const sweep = useSweep<RepoFetchResult>({
    items: activeRepos,
    fetchOne: (repo, tok) => fetchRepoPrs(repo, { spaceBeforeMs: PER_REPO_SPACING_MS, token: tok }),
    getToken: acquireToken,
    intervalMs: authenticated ? CYCLE_INTERVAL_AUTH_MS : CYCLE_INTERVAL_ANON_MS,
    enabled: true,
    initialResults: hydratedResults,
  })
```

Hoist the hydration out of `useState` into a `useMemo` so it can be passed as `initialResults`:

```ts
  const hydratedResults = useMemo(() => {
    const removed = migrateLegacyCache()
    const hydrated = readAllResults<RepoFetchResult>()
    console.log(
      `[cache] migration removed ${removed} legacy ETag entries from localStorage; hydrated ${Object.keys(hydrated).length} repos from persisted results`,
    )
    return hydrated
  }, [])
```

Then replace every remaining reference: `repos` → `sweep.results`, `cycle` → `sweep.cycle`, `pending` → `sweep.pending`, `refreshNow` → `sweep.refreshNow`. In `updateToken` and `updateOauth`, replace `restartTokenRef.current += 1` with `sweep.wake()`. In `updateFilter`, delete the whole re-queue block — `useSweep` now handles it when `activeRepos` changes — keeping only `setFilter`, `writeFilter`, and `writeSearch` behaviour.

- [ ] **Step 3: Typecheck**

Run: `cd web && npm run typecheck`
Expected: no errors. Unused-import errors here mean a leftover import from the deleted loop; remove it.

- [ ] **Step 4: Verify behaviour by hand**

Run: `cd web && npm run dev`, open `http://localhost:5173/maven-simple-reports/dependabot-prs/`.

Check all four, since none is covered by an automated test:
1. Repos populate one at a time and the "Fetching X… (n/98)" counter advances.
2. Changing the repo filter re-queues only unfetched repos and does not clear the table.
3. "Refresh now" re-queues everything with previous data still visible.
4. Saving a token wakes the loop immediately rather than waiting out the interval.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/useSweep.ts web/src/App.tsx
git commit -m "Extract the repo sweep loop into a reusable useSweep hook"
```

---

### Task 3: Author classification and all-author PR fetching

Removes the Dependabot-only filter and makes authorship a display attribute.

**Files:**
- Create: `web/src/lib/authors.ts`
- Create: `web/src/lib/authors.test.ts`
- Modify: `web/src/lib/types.ts`
- Rename + modify: `web/src/lib/dependabot.ts` → `web/src/lib/pulls.ts`
- Modify: `web/src/lib/cache.ts`
- Modify: `web/src/App.tsx` (import path)

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:
  - `type AuthorClass = 'dependabot' | 'bot' | 'human'`
  - `classifyAuthor(login: string | null | undefined, type: string | null | undefined): AuthorClass`
  - `type AuthorFilter = 'dependabot' | 'humans' | 'all'`
  - `matchesAuthorFilter(cls: AuthorClass, filter: AuthorFilter): boolean`
  - `interface PullRequestInfo` (renamed from `DependabotPr`, plus `authorClass: AuthorClass`)
  - `fetchRepoPrs(repo: string, opts: FetchRepoOptions): Promise<RepoFetchResult>`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/authors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classifyAuthor, matchesAuthorFilter } from './authors'

describe('classifyAuthor', () => {
  it('recognises dependabot in its several login forms', () => {
    expect(classifyAuthor('dependabot', 'Bot')).toBe('dependabot')
    expect(classifyAuthor('dependabot[bot]', 'Bot')).toBe('dependabot')
    expect(classifyAuthor('app/dependabot', 'Bot')).toBe('dependabot')
    expect(classifyAuthor('DEPENDABOT[BOT]', 'Bot')).toBe('dependabot')
  })

  it('classifies other bots as bot, not dependabot', () => {
    expect(classifyAuthor('renovate[bot]', 'Bot')).toBe('bot')
    expect(classifyAuthor('github-actions[bot]', 'Bot')).toBe('bot')
  })

  it('classifies real users as human', () => {
    expect(classifyAuthor('slachiewicz', 'User')).toBe('human')
  })

  it('does not treat a user merely named like a bot as a bot', () => {
    expect(classifyAuthor('robotics-fan', 'User')).toBe('human')
  })

  it('falls back to human when the type is missing', () => {
    expect(classifyAuthor('someone', null)).toBe('human')
  })

  it('classifies a missing login as bot rather than inventing a human', () => {
    expect(classifyAuthor(null, null)).toBe('bot')
  })
})

describe('matchesAuthorFilter', () => {
  it('passes everything under all', () => {
    expect(matchesAuthorFilter('dependabot', 'all')).toBe(true)
    expect(matchesAuthorFilter('bot', 'all')).toBe(true)
    expect(matchesAuthorFilter('human', 'all')).toBe(true)
  })

  it('passes only dependabot under dependabot', () => {
    expect(matchesAuthorFilter('dependabot', 'dependabot')).toBe(true)
    expect(matchesAuthorFilter('bot', 'dependabot')).toBe(false)
    expect(matchesAuthorFilter('human', 'dependabot')).toBe(false)
  })

  // Non-dependabot bots are deliberately excluded from "humans": that filter
  // means people, and renovate/github-actions are not people. They remain
  // reachable under "all".
  it('passes only humans under humans, excluding all bots', () => {
    expect(matchesAuthorFilter('human', 'humans')).toBe(true)
    expect(matchesAuthorFilter('bot', 'humans')).toBe(false)
    expect(matchesAuthorFilter('dependabot', 'humans')).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd web && npm test src/lib/authors.test.ts`
Expected: FAIL — cannot resolve `./authors`.

- [ ] **Step 3: Create `web/src/lib/authors.ts`**

```ts
export type AuthorClass = 'dependabot' | 'bot' | 'human'
export type AuthorFilter = 'dependabot' | 'humans' | 'all'

const DEPENDABOT_LOGIN_PATTERNS = [/^dependabot(\[bot\])?$/i, /^app\/dependabot$/i]

export function classifyAuthor(
  login: string | null | undefined,
  type: string | null | undefined,
): AuthorClass {
  if (!login) return 'bot'
  if (DEPENDABOT_LOGIN_PATTERNS.some((re) => re.test(login))) return 'dependabot'
  // Trust the API's own type field rather than pattern-matching the login, so a
  // user called "robotics-fan" is not misfiled as a bot.
  if ((type ?? '').toLowerCase() === 'bot') return 'bot'
  return 'human'
}

export function matchesAuthorFilter(cls: AuthorClass, filter: AuthorFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'dependabot') return cls === 'dependabot'
  return cls === 'human'
}
```

- [ ] **Step 4: Run the tests**

Run: `cd web && npm test src/lib/authors.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Rename the PR types in `web/src/lib/types.ts`**

Rename `DependabotPr` to `PullRequestInfo` and add the author class. Replace lines 30-44 with:

```ts
export interface PullRequestInfo {
  repo: string
  number: number
  title: string
  author: string
  authorClass: AuthorClass
  createdAt: string
  updatedAt: string
  isDraft: boolean
  baseRef: string
  url: string
  checksUrl: string
  headSha: string
  buildState: BuildState
  buildStateFetchedAt: number | null
}
```

Add at the top of the file: `import type { AuthorClass } from './authors'`. Change `RepoFetchResult.prs` to `PullRequestInfo[]`.

- [ ] **Step 6: Rename the module and drop the author filter**

```bash
cd /Users/slachiewicz/oss/maven-simple-reports && git mv web/src/lib/dependabot.ts web/src/lib/pulls.ts
```

In `web/src/lib/pulls.ts`: delete `DEPENDABOT_LOGIN_PATTERNS` and `isDependabotAuthor` (old lines 43-48). Add `user: { login: string; type: string } | null` is already on `RestPullRequest` — keep it. Replace the filter at old line 91:

```ts
    const pulls = list.data
```

Change the loop header from `for (const pr of dependabotPulls)` to `for (const pr of pulls)`, and add the author class to the constructed object:

```ts
        author: pr.user?.login ?? 'unknown',
        authorClass: classifyAuthor(pr.user?.login, pr.user?.type),
```

Update imports: `import { classifyAuthor } from './authors'`, and `import type { PullRequestInfo, RepoFetchResult } from './types'`. Replace the `DependabotPr` type annotations with `PullRequestInfo`.

- [ ] **Step 7: Bump the persisted-result cache key**

In `web/src/lib/cache.ts:18`, change:

```ts
const RESULT_PREFIX = 'gh-result:v2:'
```

A v1 entry has no `authorClass` and would render a blank author column. Bumping the key makes stale entries invisible rather than wrong. Then extend `clearAllCache` to also sweep the old prefix so it does not leak:

```ts
const LEGACY_RESULT_PREFIXES = ['gh-result:v1:']
```

and in the `clearAllCache` key scan, change the condition to:

```ts
      if (
        k &&
        (k.startsWith(RESULT_PREFIX) ||
          k.startsWith(ARCHIVED_PREFIX) ||
          LEGACY_RESULT_PREFIXES.some((p) => k.startsWith(p)))
      ) {
```

- [ ] **Step 8: Fix the import in `App.tsx`**

Change `import { fetchRepoPrs } from './lib/dependabot'` to `from './lib/pulls'`, and `import type { ... RepoFetchResult }` stays as-is.

- [ ] **Step 9: Typecheck and test**

Run: `cd web && npm run typecheck && npm test`
Expected: both clean. `PrTable.tsx` will error on `DependabotPr` — change its import to `PullRequestInfo` from `../lib/types` and update the two annotations (`countBuildStates` parameter, `PrRow` prop).

- [ ] **Step 10: Verify by hand**

Run `npm run dev`. Repos should now show noticeably more PRs than before, including ones authored by people. Build badges still populate.

- [ ] **Step 11: Commit**

```bash
git add web/src/lib/authors.ts web/src/lib/authors.test.ts web/src/lib/pulls.ts web/src/lib/types.ts web/src/lib/cache.ts web/src/App.tsx web/src/components/PrTable.tsx
git commit -m "Show pull requests from all authors, not only Dependabot"
```

---

### Task 4: Two-phase PR fetching

At ~500 open PRs, enrichment is ~1000 calls. An anonymous visitor on 60/h will never finish it. Fetching the inventory first means they still get the complete PR list in about a minute, with badges filling in behind it.

**Files:**
- Modify: `web/src/lib/pulls.ts`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `useSweep` (Task 2), `PullRequestInfo` (Task 3)
- Produces:
  - `fetchRepoPrs(repo, opts)` — inventory only, no longer fetches checks
  - `interface PrBuildResult { state: BuildState; fetchedAt: number }`
  - `fetchPrBuildState(key: string, token: string | undefined): Promise<PrBuildResult>` where `key` is `` `${repo}#${number}#${headSha}` ``
  - `prBuildKey(pr: PullRequestInfo): string`

- [ ] **Step 1: Strip enrichment out of `fetchRepoPrs`**

In `web/src/lib/pulls.ts`, delete the whole `if (!opts.skipChecks) { … }` block (old lines 112-144) and the now-unused `skipChecks` option. The loop body reduces to constructing the `PullRequestInfo` and `prs.push(pull)`. Remove the now-unused imports of `deriveBuildState`, `CheckRunsResponse`, and `CommitStatusResponse`.

- [ ] **Step 2: Add the phase-2 fetcher to `web/src/lib/pulls.ts`**

The key carries the head SHA so a new push produces a new key, which re-enriches naturally; unchanged PRs keep their cached entry and cost nothing.

```ts
export interface PrBuildResult {
  state: BuildState
  fetchedAt: number
}

/** Cache key for a PR's build state. Includes the head SHA so a push invalidates. */
export function prBuildKey(pr: PullRequestInfo): string {
  return `${pr.repo}#${pr.number}#${pr.headSha}`
}

export async function fetchPrBuildState(
  key: string,
  token: string | undefined,
): Promise<PrBuildResult> {
  const [repo, , sha] = key.split('#')
  const checks = await ghFetch<CheckRunsResponse>(
    `/repos/${MAVEN_OWNER}/${repo}/commits/${sha}/check-runs?per_page=100`,
    { token },
  )
  // Legacy combined-status surfaces Apache Jenkins results that never appear as
  // CheckRuns. A failure here must not discard the CheckRun signal we already
  // have — fall back to checks-only. Rate-limit errors still propagate so the
  // sweep pauses.
  let status: CommitStatusResponse | null = null
  try {
    const statusRes = await ghFetch<CommitStatusResponse>(
      `/repos/${MAVEN_OWNER}/${repo}/commits/${sha}/status?per_page=100`,
      { token },
    )
    status = statusRes.data
  } catch (err) {
    if (err instanceof GhRateLimitError) throw err
  }
  return { state: deriveBuildState(checks.data, status), fetchedAt: Date.now() }
}
```

Keep the `deriveBuildState` / `CheckRunsResponse` / `CommitStatusResponse` / `GhRateLimitError` imports — they moved here rather than disappearing.

- [ ] **Step 3: Add the second sweep in `App.tsx`**

After the existing `sweep`, add:

```ts
  const allPrs = useMemo(
    () => Object.values(sweep.results).flatMap((r) => r.prs),
    [sweep.results],
  )

  // Newest first: a reviewer cares about recent PRs, and an anonymous visitor
  // will only get through the first few dozen before the 60/h budget runs out.
  const buildKeys = useMemo(
    () =>
      [...allPrs]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(prBuildKey),
    [allPrs],
  )

  const buildSweep = useSweep<PrBuildResult>({
    items: buildKeys,
    fetchOne: fetchPrBuildState,
    getToken: acquireToken,
    intervalMs: authenticated ? CYCLE_INTERVAL_AUTH_MS : CYCLE_INTERVAL_ANON_MS,
    enabled: true,
  })
```

- [ ] **Step 4: Merge phase-2 state into the rows**

`useSweep` re-queues only keys absent from its results, so already-enriched PRs are skipped on later cycles at no cost.

```ts
  const enrichedResults = useMemo(() => {
    const out: Record<string, RepoFetchResult> = {}
    for (const [repo, result] of Object.entries(sweep.results)) {
      out[repo] = {
        ...result,
        prs: result.prs.map((pr) => {
          const build = buildSweep.results[prBuildKey(pr)]
          return build
            ? { ...pr, buildState: build.state, buildStateFetchedAt: build.fetchedAt }
            : pr
        }),
      }
    }
    return out
  }, [sweep.results, buildSweep.results])
```

Pass `enrichedResults` to `PrTable` in place of `sweep.results`.

- [ ] **Step 5: Show phase-2 progress**

In the `<section className="meta">` block, after the existing `CycleStatus`, add:

```tsx
        <span className="meta-sep">·</span>
        <span className="muted">
          {buildSweep.pending.length > 0
            ? `build status: ${buildKeys.length - buildSweep.pending.length}/${buildKeys.length}`
            : `build status: ${buildKeys.length} PRs`}
        </span>
```

- [ ] **Step 6: Typecheck and test**

Run: `cd web && npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 7: Verify by hand**

Run `npm run dev` with **no token configured**, to exercise the case this task exists for. Confirm:
1. The full PR inventory appears within roughly a minute, all badges showing "unknown".
2. Badges then fill in from the newest PRs downward.
3. When the 60/h limit is hit, the table stays fully populated and only the build-status counter stalls.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/pulls.ts web/src/App.tsx
git commit -m "Fetch PR inventory and build status in separate phases"
```

---

### Task 5: Author column and filter control

**Files:**
- Create: `web/src/components/AuthorFilter.tsx`
- Modify: `web/src/components/PrTable.tsx`
- Modify: `web/src/lib/cache.ts`
- Modify: `web/src/App.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `AuthorFilter`, `matchesAuthorFilter` (Task 3)
- Produces: `readAuthorFilter(): AuthorFilter`, `writeAuthorFilter(f: AuthorFilter): void`, `<AuthorFilterControl value onChange counts />`

- [ ] **Step 1: Add persistence to `web/src/lib/cache.ts`**

```ts
const AUTHOR_FILTER_KEY = 'gh-author-filter:v1'

export function readAuthorFilter(): 'dependabot' | 'humans' | 'all' {
  try {
    const raw = localStorage.getItem(AUTHOR_FILTER_KEY)
    if (raw === 'dependabot' || raw === 'humans' || raw === 'all') return raw
    return 'all'
  } catch {
    return 'all'
  }
}

export function writeAuthorFilter(filter: 'dependabot' | 'humans' | 'all'): void {
  try {
    localStorage.setItem(AUTHOR_FILTER_KEY, filter)
  } catch {
    // ignore
  }
}
```

Default is `all`, per the spec.

- [ ] **Step 2: Create `web/src/components/AuthorFilter.tsx`**

```tsx
import type { AuthorFilter } from '../lib/authors'

interface Props {
  value: AuthorFilter
  onChange: (next: AuthorFilter) => void
  counts: Record<AuthorFilter, number>
}

const OPTIONS: Array<{ key: AuthorFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'dependabot', label: 'Dependabot' },
  { key: 'humans', label: 'People' },
]

export function AuthorFilterControl({ value, onChange, counts }: Props) {
  return (
    <div className="author-filter" role="group" aria-label="Filter pull requests by author">
      {OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`author-filter-btn${value === opt.key ? ' author-filter-btn-active' : ''}`}
          aria-pressed={value === opt.key}
          onClick={() => onChange(opt.key)}
        >
          {opt.label} <span className="muted">({counts[opt.key]})</span>
        </button>
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Filter and render in `PrTable.tsx`**

Add `authorFilter: AuthorFilter` to `Props`. In `RepoRows`, filter before sorting:

```ts
  const prs = result
    ? result.prs
        .filter((p) => matchesAuthorFilter(p.authorClass, authorFilter))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : []
```

Thread `authorFilter` from `PrTable` into `RepoRows`. Add an Author column header after Title:

```tsx
            <th>Title</th>
            <th>Author</th>
```

and in `PrRow`, after the title cell:

```tsx
      <td className="nowrap">
        <a
          href={`https://github.com/${pr.author}`}
          target="_blank"
          rel="noreferrer"
          className={pr.authorClass === 'human' ? '' : 'author-bot'}
        >
          {pr.author}
        </a>
      </td>
```

Change the two `colSpan={4}` occurrences in the repo-header row to `colSpan={5}`.

Change the empty-state text at old line 231 from `· no Dependabot PRs ·` to:

```tsx
    return <span className="muted"> · no open PRs · {fetched}</span>
```

- [ ] **Step 4: Wire it up in `App.tsx`**

```ts
  const [authorFilter, setAuthorFilterState] = useState<AuthorFilter>(() => readAuthorFilter())

  const setAuthorFilter = (next: AuthorFilter) => {
    setAuthorFilterState(next)
    writeAuthorFilter(next)
  }

  const authorCounts = useMemo(() => {
    const counts: Record<AuthorFilter, number> = { all: 0, dependabot: 0, humans: 0 }
    for (const pr of allPrs) {
      counts.all++
      if (pr.authorClass === 'dependabot') counts.dependabot++
      else if (pr.authorClass === 'human') counts.humans++
    }
    return counts
  }, [allPrs])
```

Render `<AuthorFilterControl value={authorFilter} onChange={setAuthorFilter} counts={authorCounts} />` above `<PrTable>` and pass `authorFilter={authorFilter}` to `PrTable`.

Update the header at `App.tsx:355` to `<h1>Open Maven Pull Requests</h1>`, and the summary at line 386 to:

```tsx
        <span className="muted">
          {authorCounts[authorFilter]} open PR{authorCounts[authorFilter] === 1 ? '' : 's'} across{' '}
          {visibleResults.filter((r) => r.prs.length > 0).length} repos
        </span>
```

- [ ] **Step 5: Add styles to `web/src/styles.css`**

```css
.author-filter {
  display: flex;
  gap: 0.25rem;
  margin: 0.5rem 0;
}

.author-filter-btn {
  cursor: pointer;
  padding: 0.25rem 0.7rem;
}

.author-filter-btn-active {
  font-weight: 600;
  outline: 2px solid currentColor;
}

.author-bot {
  font-style: italic;
}
```

- [ ] **Step 6: Typecheck and test**

Run: `cd web && npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 7: Verify by hand**

Run `npm run dev`. Switching between All / Dependabot / People must be instant with no network activity in the devtools Network tab — it filters already-fetched data. The counts in the buttons must add up: dependabot + people ≤ all, with the difference being non-Dependabot bots.

- [ ] **Step 8: Commit**

```bash
git add web/src/components/AuthorFilter.tsx web/src/components/PrTable.tsx web/src/lib/cache.ts web/src/App.tsx web/src/styles.css
git commit -m "Add author column and author filter to the PR table"
```

---

### Task 6: GraphQL client

GraphQL returns HTTP 200 with an `errors` array, so status-code checks alone would treat failures as success. It shares the REST serial queue so the two APIs cannot fire concurrently.

**Files:**
- Modify: `web/src/lib/githubFetch.ts` (export the queue and rate-limit publisher)
- Create: `web/src/lib/githubGraphql.ts`
- Create: `web/src/lib/githubGraphql.test.ts`
- Modify: `web/src/lib/types.ts`

**Interfaces:**
- Consumes: `GhRateLimitError`, `SerialQueue` instance from `githubFetch.ts`
- Produces:
  - `class GhGraphQLError extends Error { readonly errors: GraphQLError[] }`
  - `interface GraphQLError { type?: string; message: string }`
  - `ghGraphQL<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T>`
  - `RateLimitInfo` gains `resource: 'rest' | 'graphql'`

- [ ] **Step 1: Export the shared queue from `githubFetch.ts`**

Change line 65 and add an export so GraphQL requests serialize with REST ones:

```ts
export const apiQueue = new SerialQueue()
```

Replace the three internal uses of `queue` with `apiQueue`. Also export the publisher:

```ts
export function publishRateLimit(rl: RateLimitInfo | null): void {
```

(change the existing `function publishRateLimit` to be exported), and export the parser:

```ts
export function parseRateLimit(headers: Headers): RateLimitInfo | null {
```

Add `resource` to the parsed value: `return { limit: …, remaining: …, resetAt: …, resource: 'rest' }`.

- [ ] **Step 2: Add `resource` to `RateLimitInfo` in `types.ts`**

```ts
export interface RateLimitInfo {
  limit: number
  remaining: number
  resetAt: number // ms epoch
  resource: 'rest' | 'graphql'
}
```

Then in `web/src/components/RateLimitInfo.tsx`, label the resource so a 5 000-point GraphQL budget is not mistaken for the 60/h REST one. Add `{rl.resource === 'graphql' ? ' (GraphQL)' : ''}` to the rendered text.

- [ ] **Step 3: Write the failing test**

Create `web/src/lib/githubGraphql.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GhGraphQLError, ghGraphQL } from './githubGraphql'
import { GhRateLimitError } from './githubFetch'

function mockResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ghGraphQL', () => {
  it('returns the data payload on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse({ data: { repository: { isArchived: false } } })),
    )
    const data = await ghGraphQL<{ repository: { isArchived: boolean } }>('query{x}', {}, 'tok')
    expect(data.repository.isArchived).toBe(false)
  })

  // GraphQL signals failure with HTTP 200 plus an errors array. Trusting the
  // status code alone would surface `undefined` data as a success.
  it('throws on an errors array despite HTTP 200', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({ errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] }),
      ),
    )
    await expect(ghGraphQL('query{x}', {}, 'tok')).rejects.toBeInstanceOf(GhGraphQLError)
  })

  it('maps a RATE_LIMITED error onto GhRateLimitError so the sweep pauses', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }),
      ),
    )
    await expect(ghGraphQL('query{x}', {}, 'tok')).rejects.toBeInstanceOf(GhRateLimitError)
  })

  it('maps HTTP 401 onto a plain error, not a rate-limit pause', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('Bad credentials', { status: 401 })),
    )
    await expect(ghGraphQL('query{x}', {}, 'tok')).rejects.toThrow(/401/)
  })

  it('maps HTTP 403 onto GhRateLimitError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('rate limited', {
          status: 403,
          headers: { 'retry-after': '1' },
        }),
      ),
    )
    await expect(ghGraphQL('query{x}', {}, 'tok')).rejects.toBeInstanceOf(GhRateLimitError)
  })

  it('sends the token and the query in the request body', async () => {
    const spy = vi.fn().mockResolvedValue(mockResponse({ data: {} }))
    vi.stubGlobal('fetch', spy)
    await ghGraphQL('query($n:String!){x(n:$n)}', { n: 'maven' }, 'secret-token')
    const [url, init] = spy.mock.calls[0]
    expect(url).toBe('https://api.github.com/graphql')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer secret-token')
    expect(JSON.parse(init.body)).toEqual({
      query: 'query($n:String!){x(n:$n)}',
      variables: { n: 'maven' },
    })
  })
})
```

- [ ] **Step 4: Run it to confirm it fails**

Run: `cd web && npm test src/lib/githubGraphql.test.ts`
Expected: FAIL — cannot resolve `./githubGraphql`.

- [ ] **Step 5: Create `web/src/lib/githubGraphql.ts`**

```ts
import { GhRateLimitError, apiQueue, parseRateLimit, publishRateLimit } from './githubFetch'

const GRAPHQL_URL = 'https://api.github.com/graphql'

export interface GraphQLError {
  type?: string
  message: string
}

export class GhGraphQLError extends Error {
  constructor(message: string, public readonly errors: GraphQLError[]) {
    super(message)
    this.name = 'GhGraphQLError'
  }
}

interface GraphQLEnvelope<T> {
  data?: T
  errors?: GraphQLError[]
}

export async function ghGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
): Promise<T> {
  return apiQueue.enqueue(async () => {
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    })

    const rl = parseRateLimit(res.headers)
    if (rl) publishRateLimit({ ...rl, resource: 'graphql' })

    if (res.status === 403 || res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'))
      const until = Number.isFinite(retryAfter) && retryAfter > 0
        ? Date.now() + retryAfter * 1000
        : Date.now() + 60_000
      apiQueue.setBackoff(until)
      throw new GhRateLimitError(`GitHub GraphQL ${res.status}`, until, res.status)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`GitHub GraphQL ${res.status} ${res.statusText}: ${text.slice(0, 200)}`)
    }

    const envelope = (await res.json()) as GraphQLEnvelope<T>

    // GraphQL reports failure as HTTP 200 with an errors array. A RATE_LIMITED
    // entry has to become GhRateLimitError so the shared queue backs off and
    // the sweep pauses instead of hammering.
    if (envelope.errors && envelope.errors.length > 0) {
      const limited = envelope.errors.find((e) => e.type === 'RATE_LIMITED')
      if (limited) {
        const until = Date.now() + 60_000
        apiQueue.setBackoff(until)
        throw new GhRateLimitError(limited.message, until, 200)
      }
      throw new GhGraphQLError(
        envelope.errors.map((e) => e.message).join('; '),
        envelope.errors,
      )
    }

    if (!envelope.data) {
      throw new GhGraphQLError('GraphQL response contained no data', [])
    }
    return envelope.data
  })
}
```

- [ ] **Step 6: Run the tests**

Run: `cd web && npm test src/lib/githubGraphql.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `cd web && npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/githubFetch.ts web/src/lib/githubGraphql.ts web/src/lib/githubGraphql.test.ts web/src/lib/types.ts web/src/components/RateLimitInfo.tsx
git commit -m "Add a GraphQL client sharing the REST serial queue"
```

---

### Task 7: Branch fetching, compare inversion, and the stale predicate

The two genuinely error-prone pieces live here: the inverted `compare` direction, and using `refUpdateRule` rather than `branchProtectionRule` for protection. Both are tested.

**Files:**
- Create: `web/src/lib/branches.ts`
- Create: `web/src/lib/branches.test.ts`
- Modify: `web/src/lib/types.ts`
- Modify: `web/src/lib/cache.ts`

**Interfaces:**
- Consumes: `ghGraphQL` (Task 6)
- Produces:
  - `interface BranchInfo { repo, name, lastCommitDate, lastCommitAuthor, headSha, isProtected, openPrCount, aheadBy, behindBy, isDefault }`
  - `interface RepoBranchResult { repo, branches, defaultBranch, fetchedAt, totalCount, truncated, degraded, error?, archived? }`
  - `mapRefNode(repo: string, defaultBranch: string, node: RefNode): BranchInfo`
  - `isStaleBranch(b: BranchInfo, thresholdDays: number, now?: number): boolean`
  - `fetchRepoBranches(repo: string, token: string | undefined): Promise<RepoBranchResult>`

- [ ] **Step 1: Add the types to `web/src/lib/types.ts`**

```ts
export interface BranchInfo {
  repo: string
  name: string
  /** ISO 8601, or null when the ref target is not a commit. */
  lastCommitDate: string | null
  lastCommitAuthor: string | null
  headSha: string
  isProtected: boolean
  openPrCount: number
  /** Commits this branch has that the default branch lacks. Null if unavailable. */
  aheadBy: number | null
  /** Commits the default branch has that this branch lacks. Null if unavailable. */
  behindBy: number | null
  isDefault: boolean
}

export interface RepoBranchResult {
  repo: string
  branches: BranchInfo[]
  defaultBranch: string
  fetchedAt: number
  totalCount: number
  /** True when the repo has more than the 100 refs we requested. */
  truncated: boolean
  /** True when ahead/behind was dropped after a query timeout. */
  degraded: boolean
  error?: string
  archived?: boolean
}
```

- [ ] **Step 2: Write the failing test**

Create `web/src/lib/branches.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isStaleBranch, mapRefNode } from './branches'
import type { BranchInfo } from './types'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-08-04T00:00:00Z')

function node(overrides: Record<string, unknown> = {}) {
  return {
    name: 'feature/old-thing',
    target: {
      oid: 'abc123',
      committedDate: '2025-01-01T00:00:00Z',
      author: { user: { login: 'someone' }, name: 'Some One' },
    },
    associatedPullRequests: { totalCount: 0 },
    compare: { aheadBy: 40, behindBy: 3 },
    refUpdateRule: null,
    ...overrides,
  }
}

function branch(overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    repo: 'maven-compiler-plugin',
    name: 'feature/old-thing',
    lastCommitDate: new Date(NOW - 200 * DAY).toISOString(),
    lastCommitAuthor: 'someone',
    headSha: 'abc123',
    isProtected: false,
    openPrCount: 0,
    aheadBy: 3,
    behindBy: 40,
    isDefault: false,
    ...overrides,
  }
}

describe('mapRefNode', () => {
  // Ref.compare() treats the ref itself as the BASE and the argument as the
  // HEAD. So compare(headRef: master) returns aheadBy = commits master has that
  // this branch lacks, i.e. how far BEHIND this branch is. The mapping inverts
  // once, here, and nothing downstream re-inverts.
  it('inverts the compare direction so behindBy means behind the default branch', () => {
    const b = mapRefNode('maven-compiler-plugin', 'master', node())
    expect(b.behindBy).toBe(40)
    expect(b.aheadBy).toBe(3)
  })

  it('leaves ahead/behind null when compare is absent', () => {
    const b = mapRefNode('maven-compiler-plugin', 'master', node({ compare: null }))
    expect(b.behindBy).toBeNull()
    expect(b.aheadBy).toBeNull()
  })

  // branchProtectionRule requires repo admin, which we do not have on apache/*;
  // it returns null for every branch. refUpdateRule is the non-admin view.
  it('reads protection from refUpdateRule', () => {
    expect(mapRefNode('r', 'master', node()).isProtected).toBe(false)
    expect(
      mapRefNode('r', 'master', node({ refUpdateRule: { allowsForcePushes: false } })).isProtected,
    ).toBe(true)
  })

  it('marks the default branch', () => {
    expect(mapRefNode('r', 'master', node({ name: 'master' })).isDefault).toBe(true)
    expect(mapRefNode('r', 'master', node({ name: 'other' })).isDefault).toBe(false)
  })

  it('prefers the GitHub login over the raw git author name', () => {
    expect(mapRefNode('r', 'master', node()).lastCommitAuthor).toBe('someone')
  })

  it('falls back to the git author name when there is no linked GitHub user', () => {
    const b = mapRefNode(
      'r',
      'master',
      node({
        target: {
          oid: 'abc',
          committedDate: '2025-01-01T00:00:00Z',
          author: { user: null, name: 'Unlinked Person' },
        },
      }),
    )
    expect(b.lastCommitAuthor).toBe('Unlinked Person')
  })
})

describe('isStaleBranch', () => {
  it('counts a branch older than the threshold as stale', () => {
    expect(isStaleBranch(branch(), 90, NOW)).toBe(true)
  })

  it('does not count a recently committed branch as stale', () => {
    const recent = branch({ lastCommitDate: new Date(NOW - 5 * DAY).toISOString() })
    expect(isStaleBranch(recent, 90, NOW)).toBe(false)
  })

  it('excludes the default branch however old it is', () => {
    expect(isStaleBranch(branch({ isDefault: true }), 90, NOW)).toBe(false)
  })

  it('excludes protected branches', () => {
    expect(isStaleBranch(branch({ isProtected: true }), 90, NOW)).toBe(false)
  })

  it('excludes branches with an open pull request', () => {
    expect(isStaleBranch(branch({ openPrCount: 1 }), 90, NOW)).toBe(false)
  })

  it('excludes branches with no commit date rather than guessing', () => {
    expect(isStaleBranch(branch({ lastCommitDate: null }), 90, NOW)).toBe(false)
  })

  it('treats exactly the threshold age as stale', () => {
    const exactly = branch({ lastCommitDate: new Date(NOW - 90 * DAY).toISOString() })
    expect(isStaleBranch(exactly, 90, NOW)).toBe(true)
  })

  it('honours a changed threshold', () => {
    const b = branch({ lastCommitDate: new Date(NOW - 30 * DAY).toISOString() })
    expect(isStaleBranch(b, 90, NOW)).toBe(false)
    expect(isStaleBranch(b, 14, NOW)).toBe(true)
  })
})
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `cd web && npm test src/lib/branches.test.ts`
Expected: FAIL — cannot resolve `./branches`.

- [ ] **Step 4: Create `web/src/lib/branches.ts`**

```ts
import { ghGraphQL } from './githubGraphql'
import { GhRateLimitError } from './githubFetch'
import { MAVEN_OWNER } from './repos'
import { readDefaultBranch, writeDefaultBranch, writeBranchResult } from './cache'
import type { BranchInfo, RepoBranchResult } from './types'

const REF_PAGE_SIZE = 100

export interface RefNode {
  name: string
  target: {
    oid: string
    committedDate: string
    author: { user: { login: string } | null; name: string | null } | null
  } | null
  associatedPullRequests: { totalCount: number }
  compare: { aheadBy: number; behindBy: number } | null
  refUpdateRule: unknown | null
}

const DEFAULT_BRANCH_QUERY = `
query($owner:String!, $repo:String!) {
  repository(owner:$owner, name:$repo) {
    isArchived
    defaultBranchRef { name }
  }
}`

function branchesQuery(withCompare: boolean): string {
  return `
query($owner:String!, $repo:String!, $defaultBranch:String!) {
  repository(owner:$owner, name:$repo) {
    isArchived
    refs(refPrefix:"refs/heads/", first:${REF_PAGE_SIZE}) {
      totalCount
      nodes {
        name
        target { ... on Commit { oid committedDate author { user { login } name } } }
        associatedPullRequests(states:OPEN, first:1) { totalCount }
        ${withCompare ? 'compare(headRef:$defaultBranch) { aheadBy behindBy }' : ''}
        refUpdateRule { allowsForcePushes }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`
}

/**
 * Ref.compare() treats THIS ref as the base and the argument as the head, so
 * compare(headRef: <default>) returns:
 *   aheadBy  = commits the default branch has that this branch lacks -> BEHIND
 *   behindBy = commits this branch has that the default branch lacks -> AHEAD
 * The names read inverted. Invert exactly once, here.
 */
export function mapRefNode(repo: string, defaultBranch: string, node: RefNode): BranchInfo {
  return {
    repo,
    name: node.name,
    lastCommitDate: node.target?.committedDate ?? null,
    lastCommitAuthor: node.target?.author?.user?.login ?? node.target?.author?.name ?? null,
    headSha: node.target?.oid ?? '',
    // branchProtectionRule needs repo admin and would be null for everything on
    // apache/*; refUpdateRule is the non-admin-visible equivalent.
    isProtected: node.refUpdateRule != null,
    openPrCount: node.associatedPullRequests.totalCount,
    aheadBy: node.compare ? node.compare.behindBy : null,
    behindBy: node.compare ? node.compare.aheadBy : null,
    isDefault: node.name === defaultBranch,
  }
}

export function isStaleBranch(b: BranchInfo, thresholdDays: number, now = Date.now()): boolean {
  if (b.isDefault) return false
  if (b.isProtected) return false
  if (b.openPrCount > 0) return false
  if (!b.lastCommitDate) return false
  const age = now - Date.parse(b.lastCommitDate)
  return age >= thresholdDays * 24 * 60 * 60 * 1000
}

interface BranchesResponse {
  repository: {
    isArchived: boolean
    refs: { totalCount: number; nodes: RefNode[] }
  } | null
}

interface DefaultBranchResponse {
  repository: { isArchived: boolean; defaultBranchRef: { name: string } | null } | null
}

export async function fetchRepoBranches(
  repo: string,
  token: string | undefined,
): Promise<RepoBranchResult> {
  const empty = (extra: Partial<RepoBranchResult>): RepoBranchResult => ({
    repo,
    branches: [],
    defaultBranch: '',
    fetchedAt: Date.now(),
    totalCount: 0,
    truncated: false,
    degraded: false,
    ...extra,
  })

  if (!token) return empty({ error: 'A GitHub token is required for the branches view' })

  try {
    // The default branch name is a query variable, so it must be resolved
    // first. Cached for 7 days, making this a one-off per repo.
    let defaultBranch = readDefaultBranch(repo)
    if (!defaultBranch) {
      const meta = await ghGraphQL<DefaultBranchResponse>(
        DEFAULT_BRANCH_QUERY,
        { owner: MAVEN_OWNER, repo },
        token,
      )
      if (!meta.repository) return empty({ error: 'Repository not found' })
      if (meta.repository.isArchived) {
        const result = empty({ archived: true })
        writeBranchResult(repo, result)
        return result
      }
      defaultBranch = meta.repository.defaultBranchRef?.name ?? 'master'
      writeDefaultBranch(repo, defaultBranch)
    }

    let degraded = false
    let data: BranchesResponse
    try {
      data = await ghGraphQL<BranchesResponse>(
        branchesQuery(true),
        { owner: MAVEN_OWNER, repo, defaultBranch },
        token,
      )
    } catch (err) {
      if (err instanceof GhRateLimitError) throw err
      // compare() is evaluated per ref and can push a 100-ref query past
      // GitHub's timeout. Retry without it and show age plus PR status only.
      degraded = true
      data = await ghGraphQL<BranchesResponse>(
        branchesQuery(false),
        { owner: MAVEN_OWNER, repo, defaultBranch },
        token,
      )
    }

    if (!data.repository) return empty({ defaultBranch, error: 'Repository not found' })
    if (data.repository.isArchived) {
      const result = empty({ defaultBranch, archived: true })
      writeBranchResult(repo, result)
      return result
    }

    const nodes = data.repository.refs.nodes
    const result: RepoBranchResult = {
      repo,
      branches: nodes.map((n) => mapRefNode(repo, defaultBranch, n)),
      defaultBranch,
      fetchedAt: Date.now(),
      totalCount: data.repository.refs.totalCount,
      truncated: data.repository.refs.totalCount > nodes.length,
      degraded,
    }
    writeBranchResult(repo, result)
    return result
  } catch (err) {
    if (err instanceof GhRateLimitError) throw err
    return empty({ error: err instanceof Error ? err.message : String(err) })
  }
}
```

- [ ] **Step 5: Add the cache helpers to `web/src/lib/cache.ts`**

```ts
const BRANCH_RESULT_PREFIX = 'gh-branches:v1:'
const DEFAULT_BRANCH_PREFIX = 'gh-default-branch:v1:'

interface DefaultBranchEntry {
  name: string
  checkedAt: number
}

export function readDefaultBranch(repo: string): string | null {
  try {
    const raw = localStorage.getItem(DEFAULT_BRANCH_PREFIX + repo)
    if (!raw) return null
    const entry = JSON.parse(raw) as DefaultBranchEntry
    if (Date.now() - entry.checkedAt > ARCHIVED_TTL_MS) return null
    return entry.name
  } catch {
    return null
  }
}

export function writeDefaultBranch(repo: string, name: string): void {
  try {
    const entry: DefaultBranchEntry = { name, checkedAt: Date.now() }
    localStorage.setItem(DEFAULT_BRANCH_PREFIX + repo, JSON.stringify(entry))
  } catch {
    // ignore
  }
}

export function writeBranchResult<T>(repo: string, value: T): void {
  try {
    localStorage.setItem(BRANCH_RESULT_PREFIX + repo, JSON.stringify(value))
  } catch {
    // ignore
  }
}

export function readAllBranchResults<T>(): Record<string, T> {
  const out: Record<string, T> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(BRANCH_RESULT_PREFIX)) continue
      const raw = localStorage.getItem(k)
      if (!raw) continue
      try {
        out[k.slice(BRANCH_RESULT_PREFIX.length)] = JSON.parse(raw) as T
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    // ignore
  }
  return out
}
```

Reuse the existing `ARCHIVED_TTL_MS` (7 days) at `cache.ts:26`. Add both new prefixes to the `clearAllCache` localStorage scan condition.

- [ ] **Step 6: Run the tests**

Run: `cd web && npm test src/lib/branches.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 7: Typecheck and run the full suite**

Run: `cd web && npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/branches.ts web/src/lib/branches.test.ts web/src/lib/types.ts web/src/lib/cache.ts
git commit -m "Add branch fetching with stale detection over the GraphQL API"
```

---

### Task 8: Branch table component

**Resolving a contradiction in the spec.** The spec's Branches section asks for
both "rows group by repository, mirroring `PrTable`'s collapsible grouping" and
"sort is oldest commit first in both modes". Those are mutually exclusive —
grouping by repo forces the sort to restart within each group, so the single
oldest branch across the estate is no longer at the top. The stated purpose of
the view is finding the longest-abandoned branches, so this task implements a
**flat list globally sorted oldest-first with a Repo column**, and drops the
grouping. Likewise the spec's "PR" column becomes an "open PR" chip on the
branch name: under the default stale-only filter every such branch is excluded,
so a dedicated column would be empty in the common case.

**Files:**
- Create: `web/src/components/BranchTable.tsx`
- Modify: `web/src/styles.css`

**Interfaces:**
- Consumes: `BranchInfo`, `RepoBranchResult` (Task 7), `isStaleBranch` (Task 7)
- Produces: `<BranchTable allRepos results inFlight staleOnly thresholdDays />`

- [ ] **Step 1: Create `web/src/components/BranchTable.tsx`**

```tsx
import type { BranchInfo, RepoBranchResult } from '../lib/types'
import { isStaleBranch } from '../lib/branches'
import { MAVEN_OWNER } from '../lib/repos'

interface Props {
  allRepos: readonly string[]
  results: Record<string, RepoBranchResult>
  inFlight: string | null
  staleOnly: boolean
  thresholdDays: number
}

function formatAge(iso: string | null): string {
  if (!iso) return 'unknown'
  const days = Math.floor((Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000))
  if (days < 1) return 'today'
  if (days < 60) return `${days} d`
  const months = Math.floor(days / 30)
  if (months < 24) return `${months} mo`
  return `${Math.floor(days / 365)} y`
}

export function BranchTable({ allRepos, results, inFlight, staleOnly, thresholdDays }: Props) {
  const rows: BranchInfo[] = []
  for (const repo of allRepos) {
    const result = results[repo]
    if (!result) continue
    for (const b of result.branches) {
      if (staleOnly && !isStaleBranch(b, thresholdDays)) continue
      rows.push(b)
    }
  }

  // Oldest first: the point of the view is finding what has been abandoned
  // longest. The GraphQL RefOrderField enum cannot sort branches by commit
  // date, so this must happen client-side.
  rows.sort((a, b) => {
    const at = a.lastCommitDate ? Date.parse(a.lastCommitDate) : Number.MAX_SAFE_INTEGER
    const bt = b.lastCommitDate ? Date.parse(b.lastCommitDate) : Number.MAX_SAFE_INTEGER
    return at - bt
  })

  const truncated = allRepos.filter((r) => results[r]?.truncated)
  const degraded = allRepos.filter((r) => results[r]?.degraded)
  const errored = allRepos.filter((r) => results[r]?.error)

  return (
    <div className="branch-table-wrap">
      {inFlight && <p className="muted">Fetching {inFlight}…</p>}
      {truncated.length > 0 && (
        <p className="muted">
          {truncated.length} repo{truncated.length === 1 ? '' : 's'} have more than 100 branches;
          showing the first 100 of each ({truncated.join(', ')}).
        </p>
      )}
      {degraded.length > 0 && (
        <p className="muted">
          Ahead/behind unavailable for {degraded.join(', ')} — the comparison query timed out.
        </p>
      )}
      {errored.length > 0 && (
        <p className="warn-text">
          Failed: {errored.map((r) => `${r} (${results[r].error})`).join('; ')}
        </p>
      )}
      <table className="pr-table">
        <thead>
          <tr>
            <th>Branch</th>
            <th>Repo</th>
            <th>Last commit</th>
            <th>Last author</th>
            <th>Behind / ahead</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                {Object.keys(results).length === 0
                  ? 'No data yet.'
                  : staleOnly
                    ? `No branches older than ${thresholdDays} days without an open PR.`
                    : 'No branches.'}
              </td>
            </tr>
          ) : (
            rows.map((b) => <BranchRow key={`${b.repo}/${b.name}`} branch={b} />)
          )}
        </tbody>
      </table>
    </div>
  )
}

function BranchRow({ branch }: { branch: BranchInfo }) {
  const branchUrl = `https://github.com/${MAVEN_OWNER}/${branch.repo}/tree/${encodeURIComponent(branch.name)}`
  const repoUrl = `https://github.com/${MAVEN_OWNER}/${branch.repo}`
  return (
    <tr className="pr-row">
      <td>
        <a href={branchUrl} target="_blank" rel="noreferrer">
          {branch.name}
        </a>
        {branch.isProtected && <span className="pr-chip pr-chip-base">protected</span>}
        {branch.openPrCount > 0 && <span className="pr-chip pr-chip-draft">open PR</span>}
      </td>
      <td className="nowrap">
        <a href={repoUrl} target="_blank" rel="noreferrer">
          {branch.repo}
        </a>
      </td>
      <td className="nowrap" title={branch.lastCommitDate ?? undefined}>
        {formatAge(branch.lastCommitDate)}
      </td>
      <td className="nowrap">{branch.lastCommitAuthor ?? '—'}</td>
      <td className="nowrap">
        {branch.behindBy === null && branch.aheadBy === null
          ? '—'
          : `↓${branch.behindBy ?? '?'} / ↑${branch.aheadBy ?? '?'}`}
      </td>
    </tr>
  )
}
```

- [ ] **Step 2: Add styles to `web/src/styles.css`**

```css
.branch-table-wrap {
  margin-top: 0.5rem;
}

.branch-controls {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin: 0.5rem 0;
  flex-wrap: wrap;
}

.branch-threshold {
  width: 5rem;
}

.tabs {
  display: flex;
  gap: 0.25rem;
  margin: 0.75rem 0 0.25rem;
  border-bottom: 1px solid currentColor;
}

.tab-btn {
  cursor: pointer;
  padding: 0.4rem 1rem;
  background: none;
  border: none;
  border-bottom: 3px solid transparent;
}

.tab-btn-active {
  font-weight: 600;
  border-bottom-color: currentColor;
}

.signin-prompt {
  padding: 1rem;
  margin: 1rem 0;
  border: 1px solid currentColor;
  border-radius: 4px;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/BranchTable.tsx web/src/styles.css
git commit -m "Add the branch table component"
```

---

### Task 9: Branches view with token gate

**Files:**
- Create: `web/src/views/BranchesView.tsx`
- Modify: `web/src/lib/cache.ts`

**Interfaces:**
- Consumes: `useSweep` (Task 2), `fetchRepoBranches` (Task 7), `BranchTable` (Task 8)
- Produces: `<BranchesView activeRepos getToken hasToken onRequestSignIn />`, `readStaleThreshold()`, `writeStaleThreshold(days)`, `readStaleOnly()`, `writeStaleOnly(v)`

- [ ] **Step 1: Add preference persistence to `web/src/lib/cache.ts`**

```ts
const STALE_THRESHOLD_KEY = 'gh-stale-threshold:v1'
const STALE_ONLY_KEY = 'gh-stale-only:v1'

export function readStaleThreshold(): number {
  try {
    const raw = Number(localStorage.getItem(STALE_THRESHOLD_KEY))
    if (Number.isFinite(raw) && raw > 0) return raw
    return 90
  } catch {
    return 90
  }
}

export function writeStaleThreshold(days: number): void {
  try {
    localStorage.setItem(STALE_THRESHOLD_KEY, String(days))
  } catch {
    // ignore
  }
}

export function readStaleOnly(): boolean {
  try {
    // Default true — the view exists to surface stale branches.
    return localStorage.getItem(STALE_ONLY_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeStaleOnly(value: boolean): void {
  try {
    localStorage.setItem(STALE_ONLY_KEY, value ? '1' : '0')
  } catch {
    // ignore
  }
}
```

- [ ] **Step 2: Create `web/src/views/BranchesView.tsx`**

```tsx
import { useMemo, useState } from 'react'
import { useSweep } from '../lib/useSweep'
import { fetchRepoBranches } from '../lib/branches'
import {
  readAllBranchResults,
  readStaleOnly,
  readStaleThreshold,
  writeStaleOnly,
  writeStaleThreshold,
} from '../lib/cache'
import type { RepoBranchResult } from '../lib/types'
import { BranchTable } from '../components/BranchTable'

// GraphQL costs ~3-6 points per repo against a 5 000/h budget, so a 10 min
// cadence leaves comfortable headroom for ~98 repos.
const BRANCH_CYCLE_INTERVAL_MS = 10 * 60_000

interface Props {
  activeRepos: readonly string[]
  getToken: () => Promise<string | undefined>
  hasToken: boolean
}

export function BranchesView({ activeRepos, getToken, hasToken }: Props) {
  const [staleOnly, setStaleOnlyState] = useState<boolean>(() => readStaleOnly())
  const [threshold, setThresholdState] = useState<number>(() => readStaleThreshold())

  const initialResults = useMemo(() => readAllBranchResults<RepoBranchResult>(), [])

  const sweep = useSweep<RepoBranchResult>({
    items: activeRepos,
    fetchOne: (repo, token) => fetchRepoBranches(repo, token),
    getToken,
    intervalMs: BRANCH_CYCLE_INTERVAL_MS,
    enabled: hasToken,
    initialResults,
  })

  const setStaleOnly = (v: boolean) => {
    setStaleOnlyState(v)
    writeStaleOnly(v)
  }

  const setThreshold = (days: number) => {
    setThresholdState(days)
    writeStaleThreshold(days)
  }

  if (!hasToken) {
    return (
      <div className="signin-prompt">
        <h2>A GitHub token is required</h2>
        <p>
          The branches view uses GitHub's GraphQL API, which rejects
          unauthenticated requests. Open <strong>Settings</strong> above and
          either connect with GitHub or paste a personal access token — no scopes
          are needed for public repositories.
        </p>
        <p className="muted">
          The pull requests tab keeps working without a token.
        </p>
      </div>
    )
  }

  const fetchedCount = Object.keys(sweep.results).length

  return (
    <>
      <div className="branch-controls">
        <label>
          <input
            type="checkbox"
            checked={staleOnly}
            onChange={(e) => setStaleOnly(e.target.checked)}
          />{' '}
          Stale only
        </label>
        <label>
          Older than{' '}
          <input
            className="branch-threshold"
            type="number"
            min={1}
            max={3650}
            value={threshold}
            disabled={!staleOnly}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n > 0) setThreshold(n)
            }}
          />{' '}
          days
        </label>
        <span className="muted">
          {fetchedCount}/{activeRepos.length} repos fetched
        </span>
        <button type="button" className="restart" onClick={sweep.refreshNow}>
          Refresh now
        </button>
      </div>
      <p className="muted">
        Excludes the default branch, protected branches, and branches with an open
        pull request.
      </p>
      <BranchTable
        allRepos={activeRepos}
        results={sweep.results}
        inFlight={sweep.cycle.inFlight}
        staleOnly={staleOnly}
        thresholdDays={threshold}
      />
    </>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/views/BranchesView.tsx web/src/lib/cache.ts
git commit -m "Add the branches view with a token gate"
```

---

### Task 10: Tabs and view routing

Splits `App.tsx` into a shell plus two views and adds `?view=` routing. This is the task that makes the branches view reachable.

**Files:**
- Create: `web/src/views/PullRequestsView.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: everything from Tasks 2-9
- Produces: `type ViewKey = 'prs' | 'branches'`; `<PullRequestsView activeRepos getToken authenticated />`

- [ ] **Step 1: Create `web/src/views/PullRequestsView.tsx`**

Move the PR-specific logic out of `App.tsx`: both sweeps (`sweep`, `buildSweep`), `allPrs`, `buildKeys`, `enrichedResults`, `authorFilter` state, `authorCounts`, the `CycleStatus` component and its `formatTime` / `formatRelative` helpers, the `meta` section, and the `PrTable` render.

```tsx
import { useMemo, useState } from 'react'
import { useSweep } from '../lib/useSweep'
import { fetchPrBuildState, fetchRepoPrs, prBuildKey, type PrBuildResult } from '../lib/pulls'
import {
  migrateLegacyCache,
  readAllResults,
  readAuthorFilter,
  writeAuthorFilter,
} from '../lib/cache'
import type { AuthorFilter } from '../lib/authors'
import type { RepoFetchResult } from '../lib/types'
import { PrTable } from '../components/PrTable'
import { AuthorFilterControl } from '../components/AuthorFilter'

const CYCLE_INTERVAL_ANON_MS = 30 * 60_000
const CYCLE_INTERVAL_AUTH_MS = 5 * 60_000
const PER_REPO_SPACING_MS = 800

interface Props {
  activeRepos: readonly string[]
  getToken: () => Promise<string | undefined>
  authenticated: boolean
}

export function PullRequestsView({ activeRepos, getToken, authenticated }: Props) {
  const [authorFilter, setAuthorFilterState] = useState<AuthorFilter>(() => readAuthorFilter())

  const hydratedResults = useMemo(() => {
    const removed = migrateLegacyCache()
    const hydrated = readAllResults<RepoFetchResult>()
    console.log(
      `[cache] migration removed ${removed} legacy ETag entries from localStorage; hydrated ${Object.keys(hydrated).length} repos from persisted results`,
    )
    return hydrated
  }, [])

  const intervalMs = authenticated ? CYCLE_INTERVAL_AUTH_MS : CYCLE_INTERVAL_ANON_MS

  const sweep = useSweep<RepoFetchResult>({
    items: activeRepos,
    fetchOne: (repo, tok) => fetchRepoPrs(repo, { spaceBeforeMs: PER_REPO_SPACING_MS, token: tok }),
    getToken,
    intervalMs,
    enabled: true,
    initialResults: hydratedResults,
  })

  const allPrs = useMemo(
    () => Object.values(sweep.results).flatMap((r) => r.prs),
    [sweep.results],
  )

  // Newest first: a reviewer cares about recent PRs, and an anonymous visitor
  // only gets through the first few dozen before the 60/h budget runs out.
  const buildKeys = useMemo(
    () => [...allPrs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(prBuildKey),
    [allPrs],
  )

  const buildSweep = useSweep<PrBuildResult>({
    items: buildKeys,
    fetchOne: fetchPrBuildState,
    getToken,
    intervalMs,
    enabled: true,
  })

  const enrichedResults = useMemo(() => {
    const out: Record<string, RepoFetchResult> = {}
    for (const [repo, result] of Object.entries(sweep.results)) {
      out[repo] = {
        ...result,
        prs: result.prs.map((pr) => {
          const build = buildSweep.results[prBuildKey(pr)]
          return build
            ? { ...pr, buildState: build.state, buildStateFetchedAt: build.fetchedAt }
            : pr
        }),
      }
    }
    return out
  }, [sweep.results, buildSweep.results])

  const authorCounts = useMemo(() => {
    const counts: Record<AuthorFilter, number> = { all: 0, dependabot: 0, humans: 0 }
    for (const pr of allPrs) {
      counts.all++
      if (pr.authorClass === 'dependabot') counts.dependabot++
      else if (pr.authorClass === 'human') counts.humans++
    }
    return counts
  }, [allPrs])

  const setAuthorFilter = (next: AuthorFilter) => {
    setAuthorFilterState(next)
    writeAuthorFilter(next)
  }

  const visibleResults = useMemo(() => {
    const active = new Set(activeRepos)
    return Object.values(enrichedResults).filter((r) => active.has(r.repo))
  }, [enrichedResults, activeRepos])

  const remaining = sweep.pending.length
  const fetched = Math.max(0, activeRepos.length - remaining)

  return (
    <>
      <AuthorFilterControl
        value={authorFilter}
        onChange={setAuthorFilter}
        counts={authorCounts}
      />

      <section className="meta">
        <CycleStatus cycle={sweep.cycle} fetched={fetched} total={activeRepos.length} />
        <span className="meta-sep">·</span>
        <span className="muted">
          {authorCounts[authorFilter]} open PR{authorCounts[authorFilter] === 1 ? '' : 's'} across{' '}
          {visibleResults.filter((r) => r.prs.length > 0).length} repos
        </span>
        <span className="meta-sep">·</span>
        <span className="muted">
          {buildSweep.pending.length > 0
            ? `build status: ${buildKeys.length - buildSweep.pending.length}/${buildKeys.length}`
            : `build status: ${buildKeys.length} PRs`}
        </span>
        <span className="meta-sep grow">·</span>
        <button
          className="restart"
          type="button"
          onClick={sweep.refreshNow}
          title="Re-queue all active repos for a fresh fetch (previous data stays visible until each repo is updated)"
        >
          Refresh now
        </button>
      </section>

      <PrTable
        allRepos={activeRepos}
        results={enrichedResults}
        inFlight={sweep.cycle.inFlight}
        authorFilter={authorFilter}
      />
    </>
  )
}
```

Then move `CycleStatus`, `formatTime`, and `formatRelative` from `App.tsx:418-474` into the bottom of this file unchanged, and add `import type { CycleState } from '../lib/useSweep'` for `CycleStatus`'s prop type.

Note that `RateLimitInfo` moves to `App.tsx` (the shell) rather than here, since the rate-limit display is shared by both tabs.

- [ ] **Step 2: Reduce `App.tsx` to a shell with tabs**

`App.tsx` keeps: `filter`, `token`, `tokenPersist`, `oauth`, `oauthError`, the
`rl` rate-limit state and its `subscribeRateLimit` effect, `applyFilter`,
`acquireToken`, `updateToken`, `updateOauth`, `connectOauth`,
`disconnectOauth`, the OAuth-callback effect, and `updateFilter`. It also keeps
rendering `<TokenInput>`, `<FilterInput>`, `<RateLimitInfo rl={rl} />`, and the
footer — all shared by both tabs. It gains:

```tsx
export type ViewKey = 'prs' | 'branches'

function readViewFromUrl(): ViewKey {
  const raw = new URLSearchParams(window.location.search).get('view')
  return raw === 'branches' ? 'branches' : 'prs'
}
```

and in the component:

```tsx
  const [view, setViewState] = useState<ViewKey>(() => readViewFromUrl())

  const setView = (next: ViewKey) => {
    setViewState(next)
    const url = new URL(window.location.href)
    if (next === 'prs') url.searchParams.delete('view')
    else url.searchParams.set('view', next)
    window.history.replaceState(null, '', url)
  }

  // Back/forward must move between tabs, not silently leave the URL and the
  // rendered view disagreeing.
  useEffect(() => {
    const onPop = () => setViewState(readViewFromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
```

Render:

```tsx
      <nav className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'prs'}
          className={`tab-btn${view === 'prs' ? ' tab-btn-active' : ''}`}
          onClick={() => setView('prs')}
        >
          Pull requests
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'branches'}
          className={`tab-btn${view === 'branches' ? ' tab-btn-active' : ''}`}
          onClick={() => setView('branches')}
        >
          Branches
        </button>
      </nav>

      <main>
        {view === 'prs' ? (
          <PullRequestsView
            activeRepos={activeRepos}
            getToken={acquireToken}
            authenticated={authenticated}
          />
        ) : (
          <BranchesView
            activeRepos={activeRepos}
            getToken={acquireToken}
            hasToken={authenticated}
          />
        )}
      </main>
```

Because only the mounted view's `useSweep` runs, the inactive tab stops sweeping automatically — no extra gating needed. Update the `<h1>` to `Open Maven Pull Requests & Branches` and the subtitle to mention both.

- [ ] **Step 3: Typecheck and run the full suite**

Run: `cd web && npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 4: Verify by hand**

Run `npm run dev` and check:
1. Default load shows the pull requests tab; the URL has no `view` param.
2. Clicking Branches with **no token** shows the sign-in prompt and issues zero network requests (check the Network tab).
3. Adding a token in Settings makes the branches sweep start without a reload.
4. The URL becomes `?view=branches`; reloading lands on the branches tab.
5. Browser Back returns to the pull requests tab.
6. Switching back to Pull requests does not re-fetch everything from scratch — previously fetched repos stay rendered.

- [ ] **Step 5: Build to confirm the production bundle is clean**

Run: `cd web && npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/views/PullRequestsView.tsx web/src/App.tsx
git commit -m "Split the SPA into pull-request and branch tabs"
```

---

### Task 11: Documentation

**Files:**
- Modify: `web/README.adoc`
- Modify: `CLAUDE.md`
- Modify: `web/package.json` (name field)

**Interfaces:**
- Consumes: the finished feature
- Produces: no code

- [ ] **Step 1: Rename the package**

`web/package.json` `"name"` is `maven-dependabot-dashboard`, which is now wrong. Change to `maven-pr-dashboard`. Run `npm install` afterwards so `package-lock.json` picks up the new name.

- [ ] **Step 2: Update `web/README.adoc`**

Revise these sections:
- **Overview** — two views, not one. The dashboard covers all open PRs and stale branches.
- **Status / UI controls** — document the tab bar and `?view=` parameter, the author filter (All / Dependabot / People, defaulting to All), and the branches controls (stale-only toggle, day threshold defaulting to 90).
- **New section "Branches"** — GraphQL, token required and why (GitHub rejects anonymous GraphQL), one query per repo, ~3-6 points each, 10 min cadence, and the three exclusions (default branch, protected via `refUpdateRule`, has an open PR).
- **Known limitations** — add: first 100 branches and 100 PRs per repo only, with a visible "showing 100 of N" marker; no build status for branches; ahead/behind may be missing when the compare query times out.
- **New section "Tests"** — `npm test` runs Vitest over pure logic in `src/lib/*.test.ts`. Components, network behaviour, and the sweep loop are not covered.

- [ ] **Step 3: Update `CLAUDE.md`**

- **Project Overview** — the SPA shows all open PRs and a stale-branches view, not just Dependabot PRs.
- **Build status detection (SPA)** — note that build state is derived in a second enrichment phase keyed by head SHA, and that both check-runs and the legacy combined-status API are consulted (the file already documents the derivation rules; they are unchanged).
- **Project Architecture / Pipeline** — mention `lib/useSweep.ts` as the shared polling loop and `lib/githubGraphql.ts` as the GraphQL client.
- **Commands** — add `npm test` under "Develop the SPA".

- [ ] **Step 4: Verify the docs match reality**

Re-read both files against the code. Every filename, default value, and interval mentioned must match what was actually built. The most likely mismatches: the branch cycle interval (10 min), the stale threshold default (90 days), and the author-filter default (All).

- [ ] **Step 5: Commit**

```bash
git add web/README.adoc CLAUDE.md web/package.json web/package-lock.json
git commit -m "Document the all-author PR view and the branches view"
```

---

## Verification checklist

After Task 11, confirm end to end:

- [ ] `cd web && npm run typecheck` — clean
- [ ] `cd web && npm test` — all tests pass
- [ ] `cd web && npm run build` — succeeds
- [ ] `scripts/generate_report.sh` — still produces `public/dependabot-prs/`
- [ ] Anonymous: PR inventory completes; badges fill progressively; branches tab prompts for sign-in
- [ ] With a token: both tabs populate; branches tab shows stale branches oldest-first
- [ ] `?view=branches` reloads onto the branches tab
