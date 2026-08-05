/*
 * Copyright 2026 The Apache Software Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useEffect, useMemo, useState } from 'react'
import { type CycleState, useSweep } from '../lib/useSweep'
import { fetchPrBuildState, fetchRepoPrs, prBuildKey, type PrBuildResult } from '../lib/pulls'
import { fetchRepoPrsGraphql } from '../lib/pullsGraphql'
import {
  migrateLegacyCache,
  readAllResults,
  readAuthorFilter,
  readBuildStates,
  readDraftFilter,
  writeAuthorFilter,
  writeBuildStates,
  writeDraftFilter,
} from '../lib/cache'
import type { AuthorFilter } from '../lib/authors'
import { matchesAuthorFilter } from '../lib/authors'
import { type DraftFilter, matchesDraftFilter } from '../lib/prFilters'
import type { PrResult, PullRequestInfo } from '../lib/types'
import { PrTable } from '../components/PrTable'
import { AuthorFilterControl } from '../components/AuthorFilter'
import { SegmentedControl } from '../components/SegmentedControl'

// 30 min between full cycles when unauthenticated (60/h budget); 5 min when a PAT
// is configured (5 000/h budget). The interval is read at the start of each
// sleep, so toggling the token takes effect on the next cycle.
const CYCLE_INTERVAL_ANON_MS = 30 * 60_000
const CYCLE_INTERVAL_AUTH_MS = 5 * 60_000
const PER_REPO_SPACING_MS = 800

// Build status for every open PR costs ~2 REST calls each; at ~536 PRs that
// dominates the budget. The newest few per repo are what anyone actually looks
// at, and older PRs still render (with an unknown badge) at no request cost.
const MAX_ENRICHED_PRS_PER_REPO = 10

const DRAFT_OPTIONS: Array<{ key: DraftFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'ready', label: 'Ready' },
  { key: 'draft', label: 'Draft' },
]

interface Props {
  activeRepos: readonly string[]
  getToken: () => Promise<string | undefined>
  authenticated: boolean
  tokenEpoch: number
}

export function PullRequestsView({ activeRepos, getToken, authenticated, tokenEpoch }: Props) {
  const [authorFilter, setAuthorFilterState] = useState<AuthorFilter>(() => readAuthorFilter())
  const [draftFilter, setDraftFilterState] = useState<DraftFilter>(() => readDraftFilter())

  // Hydrate from any prior tab's persisted results so a freshly opened tab
  // shows data instantly (even before its own fetch completes). Also run the
  // one-time migration that evicts the legacy ETag cache from localStorage so
  // persisted results have the full 5 MB budget.
  const hydratedResults = useMemo(() => {
    const removed = migrateLegacyCache()
    const hydrated = readAllResults<PrResult>()
    console.log(
      `[cache] migration removed ${removed} legacy ETag entries from localStorage; hydrated ${Object.keys(hydrated).length} repos from persisted results`,
    )
    return hydrated
  }, [])

  const intervalMs = authenticated ? CYCLE_INTERVAL_AUTH_MS : CYCLE_INTERVAL_ANON_MS

  // REST path: inventory sweep + separate build-status enrichment sweep. Only
  // runs when unauthenticated — GitHub rejects anonymous GraphQL outright, so
  // this path must keep working with no token.
  const sweep = useSweep<PrResult>({
    items: activeRepos,
    fetchOne: (repo, tok) => fetchRepoPrs(repo, { spaceBeforeMs: PER_REPO_SPACING_MS, token: tok }),
    getToken,
    intervalMs,
    enabled: !authenticated,
    initialResults: hydratedResults,
  })

  // GraphQL path: one call per repo returns PRs and their build-status rollup
  // together, so badges arrive with the row instead of a separate phase.
  // Requires a token, so it only runs when authenticated. Both paths persist
  // via writeResult under the same key, so hydratedResults seeds either one.
  const graphqlSweep = useSweep<PrResult>({
    items: activeRepos,
    fetchOne: (repo, tok) => fetchRepoPrsGraphql(repo, tok),
    getToken,
    intervalMs,
    enabled: authenticated,
    initialResults: hydratedResults,
  })

  const activeRepoSet = useMemo(() => new Set(activeRepos), [activeRepos])

  // Raw REST inventory only, independent of which path is active — feeds
  // solely the REST build-status enrichment sweep below. The GraphQL path
  // never needs this: its PRs already carry buildState from the rollup.
  const restPrs = useMemo(
    () =>
      Object.values(sweep.results)
        .filter((r) => activeRepoSet.has(r.repo))
        .flatMap((r) => r.prs),
    [sweep.results, activeRepoSet],
  )

  // Cap enrichment to the newest few PRs per repo rather than a flat global
  // cap, so every repo gets some badges instead of later repos being starved
  // entirely. Preserve the global newest-first order afterwards: a reviewer
  // cares about recent PRs, and an anonymous visitor only gets through the
  // first few dozen before the 60/h budget runs out.
  const buildKeys = useMemo(() => {
    const byRepo = new Map<string, PullRequestInfo[]>()
    for (const pr of restPrs) {
      const group = byRepo.get(pr.repo)
      if (group) group.push(pr)
      else byRepo.set(pr.repo, [pr])
    }
    const capped: PullRequestInfo[] = []
    for (const group of byRepo.values()) {
      group.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      capped.push(...group.slice(0, MAX_ENRICHED_PRS_PER_REPO))
    }
    capped.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return capped.map(prBuildKey)
  }, [restPrs])

  // Hydrate once from the persisted blob so a freshly opened tab shows build
  // badges instantly instead of re-fetching ~536 enrichment results from
  // scratch. Keys are head-SHA scoped (prBuildKey), so a hydrated entry is
  // only ever reused for the exact commit it was fetched against.
  const hydratedBuildStates = useMemo(() => readBuildStates<PrBuildResult>(), [])

  const buildSweep = useSweep<PrBuildResult>({
    items: buildKeys,
    fetchOne: fetchPrBuildState,
    getToken,
    intervalMs,
    // Enrichment must not compete with the inventory sweep for the shared serial
    // queue: the full PR table has to render first, then badges fill in behind it.
    // This also lets enrichment use the inventory sweep's idle inter-cycle window.
    // Never runs when authenticated — the GraphQL path already has build state.
    enabled: !authenticated && sweep.pending.length === 0,
    initialResults: hydratedBuildStates,
  })

  // Persist on result-set change rather than per-result (onResult), which would
  // serialise the whole blob hundreds of times per cycle. useSweep already
  // skips items already present in results, so hydrated entries cost zero
  // requests — that's the entire point of persisting them.
  useEffect(() => {
    if (Object.keys(buildSweep.results).length === 0) return
    writeBuildStates(buildSweep.results)
  }, [buildSweep.results])

  // A token saved mid-sleep must resume immediately rather than waiting out a
  // rate-limit pause; useSweep only re-reads the token on its next fetch.
  useEffect(() => {
    if (tokenEpoch === 0) return
    sweep.wake()
    graphqlSweep.wake()
    buildSweep.wake()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wake on credential change only
  }, [tokenEpoch])

  const enrichedResults = useMemo(() => {
    const out: Record<string, PrResult> = {}
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

  // Single source of truth for everything rendered below, regardless of which
  // fetch path produced it: the GraphQL sweep's results already carry build
  // state, the REST sweep's are merged with the separate enrichment sweep above.
  const activeSweep = authenticated ? graphqlSweep : sweep
  const activeResults = authenticated ? graphqlSweep.results : enrichedResults

  const allPrs = useMemo(
    () =>
      Object.values(activeResults)
        .filter((r) => activeRepoSet.has(r.repo))
        .flatMap((r) => r.prs),
    [activeResults, activeRepoSet],
  )

  // Each control's counts describe what selecting that option would actually
  // yield, so they're computed with the OTHER filter already applied — author
  // counts over PRs matching the current draftFilter, and vice versa.
  const authorCounts = useMemo(() => {
    const counts: Record<AuthorFilter, number> = { all: 0, dependabot: 0, humans: 0 }
    for (const pr of allPrs) {
      if (!matchesDraftFilter(pr.isDraft, draftFilter)) continue
      counts.all++
      if (pr.authorClass === 'dependabot') counts.dependabot++
      else if (pr.authorClass === 'human') counts.humans++
    }
    return counts
  }, [allPrs, draftFilter])

  const draftCounts = useMemo(() => {
    const counts: Record<DraftFilter, number> = { all: 0, ready: 0, draft: 0 }
    for (const pr of allPrs) {
      if (!matchesAuthorFilter(pr.authorClass, authorFilter)) continue
      counts.all++
      if (pr.isDraft) counts.draft++
      else counts.ready++
    }
    return counts
  }, [allPrs, authorFilter])

  const setAuthorFilter = (next: AuthorFilter) => {
    setAuthorFilterState(next)
    writeAuthorFilter(next)
  }

  const setDraftFilter = (next: DraftFilter) => {
    setDraftFilterState(next)
    writeDraftFilter(next)
  }

  const visibleResults = useMemo(
    () => Object.values(activeResults).filter((r) => activeRepoSet.has(r.repo)),
    [activeResults, activeRepoSet],
  )

  const remaining = activeSweep.pending.length
  const fetched = Math.max(0, activeRepos.length - remaining)

  return (
    <>
      <AuthorFilterControl
        value={authorFilter}
        onChange={setAuthorFilter}
        counts={authorCounts}
      />
      <SegmentedControl
        value={draftFilter}
        onChange={setDraftFilter}
        ariaLabel="Filter pull requests by draft status"
        options={DRAFT_OPTIONS.map((opt) => ({ ...opt, count: draftCounts[opt.key] }))}
      />

      <section className="meta">
        <CycleStatus cycle={activeSweep.cycle} fetched={fetched} total={activeRepos.length} />
        <span className="meta-sep">·</span>
        <span className="muted">
          {authorCounts[authorFilter]} open PR{authorCounts[authorFilter] === 1 ? '' : 's'} across{' '}
          {visibleResults.filter((r) => r.prs.length > 0).length} repos
        </span>
        {!authenticated && (
          <>
            <span className="meta-sep">·</span>
            <span className="muted">
              {buildSweep.pending.length > 0
                ? `build status: ${buildKeys.length - buildSweep.pending.length}/${buildKeys.length}`
                : `build status: ${buildKeys.length} PRs`}
            </span>
          </>
        )}
        <span className="meta-sep grow">·</span>
        <button
          className="restart"
          type="button"
          onClick={activeSweep.refreshNow}
          title="Re-queue all active repos for a fresh fetch (previous data stays visible until each repo is updated)"
        >
          Refresh now
        </button>
      </section>

      <PrTable
        allRepos={activeRepos}
        results={activeResults}
        inFlight={activeSweep.cycle.inFlight}
        authorFilter={authorFilter}
        draftFilter={draftFilter}
      />
    </>
  )
}

function CycleStatus({
  cycle,
  fetched,
  total,
}: {
  cycle: CycleState
  fetched: number
  total: number
}) {
  if (cycle.pausedUntil) {
    return (
      <span className="cycle warn">
        Paused (rate-limited) · resumes at {formatTime(cycle.pausedUntil)} ({formatRelative(cycle.pausedUntil)})
      </span>
    )
  }
  if (cycle.inFlight) {
    return (
      <span className="cycle">
        Fetching {cycle.inFlight}… ({fetched}/{total})
      </span>
    )
  }
  if (cycle.nextCycleAt) {
    return (
      <span className="cycle">
        Updated at {formatTime(cycle.completedAt ?? Date.now())} · next refresh at {formatTime(cycle.nextCycleAt)}
      </span>
    )
  }
  if (cycle.startedAt) {
    return (
      <span className="cycle">
        Loading… ({fetched}/{total})
      </span>
    )
  }
  return <span className="cycle muted">Idle</span>
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

function formatRelative(targetMs: number): string {
  const diffMs = targetMs - Date.now()
  if (diffMs <= 0) return 'now'
  const mins = Math.ceil(diffMs / 60_000)
  if (mins < 60) return `in ${mins} min`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins ? `in ${hours} h ${remMins} min` : `in ${hours} h`
}
