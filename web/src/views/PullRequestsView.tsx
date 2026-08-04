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
import {
  migrateLegacyCache,
  readAllResults,
  readAuthorFilter,
  writeAuthorFilter,
} from '../lib/cache'
import type { AuthorFilter } from '../lib/authors'
import type { PrResult } from '../lib/types'
import { PrTable } from '../components/PrTable'
import { AuthorFilterControl } from '../components/AuthorFilter'

// 30 min between full cycles when unauthenticated (60/h budget); 5 min when a PAT
// is configured (5 000/h budget). The interval is read at the start of each
// sleep, so toggling the token takes effect on the next cycle.
const CYCLE_INTERVAL_ANON_MS = 30 * 60_000
const CYCLE_INTERVAL_AUTH_MS = 5 * 60_000
const PER_REPO_SPACING_MS = 800

interface Props {
  activeRepos: readonly string[]
  getToken: () => Promise<string | undefined>
  authenticated: boolean
  tokenEpoch: number
}

export function PullRequestsView({ activeRepos, getToken, authenticated, tokenEpoch }: Props) {
  const [authorFilter, setAuthorFilterState] = useState<AuthorFilter>(() => readAuthorFilter())

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

  const sweep = useSweep<PrResult>({
    items: activeRepos,
    fetchOne: (repo, tok) => fetchRepoPrs(repo, { spaceBeforeMs: PER_REPO_SPACING_MS, token: tok }),
    getToken,
    intervalMs,
    enabled: true,
    initialResults: hydratedResults,
  })

  const activeRepoSet = useMemo(() => new Set(activeRepos), [activeRepos])

  const allPrs = useMemo(
    () =>
      Object.values(sweep.results)
        .filter((r) => activeRepoSet.has(r.repo))
        .flatMap((r) => r.prs),
    [sweep.results, activeRepoSet],
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
    // Enrichment must not compete with the inventory sweep for the shared serial
    // queue: the full PR table has to render first, then badges fill in behind it.
    // This also lets enrichment use the inventory sweep's idle inter-cycle window.
    enabled: sweep.pending.length === 0,
  })

  // A token saved mid-sleep must resume immediately rather than waiting out a
  // rate-limit pause; useSweep only re-reads the token on its next fetch.
  useEffect(() => {
    if (tokenEpoch === 0) return
    sweep.wake()
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

  const visibleResults = useMemo(
    () => Object.values(enrichedResults).filter((r) => activeRepoSet.has(r.repo)),
    [enrichedResults, activeRepoSet],
  )

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
