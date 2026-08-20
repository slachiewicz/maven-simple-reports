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
import { fetchRepoPrsGraphql } from '../lib/pullsGraphql'
import {
  migrateLegacyCache,
  readAllResults,
  readAuthorFilter,
  readAssigneeFilter,
  readDraftFilter,
  readReviewFilter,
  writeAuthorFilter,
  writeAssigneeFilter,
  writeDraftFilter,
  writeReviewFilter,
} from '../lib/cache'
import type { AuthorFilter } from '../lib/authors'
import { matchesAuthorFilter } from '../lib/authors'
import { type DraftFilter, matchesDraftFilter } from '../lib/prFilters'
import type { PrResult } from '../lib/types'
import { PrTable } from '../components/PrTable'
import { AuthorFilterControl } from '../components/AuthorFilter'
import { SegmentedControl } from '../components/SegmentedControl'
import {
  ASSIGNEE_ALL,
  ASSIGNEE_ANY,
  ASSIGNEE_NONE,
  collectAssignees,
  matchesAssigneeFilter,
} from '../lib/assignees'
import { type ReviewFilter, isApproved, isApprovedByViewer, matchesReviewFilter } from '../lib/reviews'
import { hasReviewData } from '../lib/types'

// One GraphQL call per repo costs ~1-2 points against the 5 000/h budget, so
// a 5 min cycle over ~98 repos leaves plenty of headroom.
const CYCLE_INTERVAL_MS = 5 * 60_000

const DRAFT_OPTIONS: Array<{ key: DraftFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'ready', label: 'Ready' },
  { key: 'draft', label: 'Draft' },
]

// "By you" is a subset of "Approved", not a fourth disjoint bucket: it answers
// "which of these did I already sign off on" without a second control.
const REVIEW_OPTIONS: Array<{ key: ReviewFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'approved', label: 'Approved' },
  { key: 'mine', label: 'By you' },
  { key: 'unapproved', label: 'Not approved' },
]

interface Props {
  activeRepos: readonly string[]
  getToken: () => Promise<string | undefined>
  tokenEpoch: number
}

export function PullRequestsView({ activeRepos, getToken, tokenEpoch }: Props) {
  const [authorFilter, setAuthorFilterState] = useState<AuthorFilter>(() => readAuthorFilter())
  const [draftFilter, setDraftFilterState] = useState<DraftFilter>(() => readDraftFilter())
  const [assigneeFilter, setAssigneeFilterState] = useState<string>(() => readAssigneeFilter())
  const [reviewFilter, setReviewFilterState] = useState<ReviewFilter>(() => readReviewFilter())

  // Hydrate from any prior tab's persisted results so a freshly opened tab
  // shows data instantly (even before its own fetch completes). Also run the
  // migration that reclaims localStorage from superseded cache generations so
  // persisted results have the full 5 MB budget.
  const hydratedResults = useMemo(() => {
    const removed = migrateLegacyCache()
    const hydrated = readAllResults<PrResult>()
    console.log(
      `[cache] migration reclaimed ${removed} legacy localStorage entries; hydrated ${Object.keys(hydrated).length} repos from persisted results`,
    )
    return hydrated
  }, [])

  // The only fetch path: one GraphQL call per repo returns the PRs and their
  // build-status rollup together. App renders a sign-in prompt instead of this
  // view when there are no credentials, so a token is always available here.
  const sweep = useSweep<PrResult>({
    items: activeRepos,
    fetchOne: (repo, tok) => fetchRepoPrsGraphql(repo, tok),
    getToken,
    intervalMs: CYCLE_INTERVAL_MS,
    enabled: true,
    initialResults: hydratedResults,
  })

  const activeRepoSet = useMemo(() => new Set(activeRepos), [activeRepos])

  // A token saved mid-sleep must resume immediately rather than waiting out a
  // rate-limit pause; useSweep only re-reads the token on its next fetch.
  useEffect(() => {
    if (tokenEpoch === 0) return
    sweep.wake()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wake on credential change only
  }, [tokenEpoch])

  const activeResults = sweep.results

  const allPrs = useMemo(
    () =>
      Object.values(activeResults)
        .filter((r) => activeRepoSet.has(r.repo))
        .flatMap((r) => r.prs),
    [activeResults, activeRepoSet],
  )

  // Each control's counts describe what selecting that option would actually
  // yield, so they're computed with the OTHER filters already applied — author
  // counts over PRs matching the current draft and assignee filters, and so on
  // for each control in turn.
  const authorCounts = useMemo(() => {
    const counts: Record<AuthorFilter, number> = { all: 0, dependabot: 0, humans: 0 }
    for (const pr of allPrs) {
      if (!matchesDraftFilter(pr.isDraft, draftFilter)) continue
      if (!matchesAssigneeFilter(pr, assigneeFilter)) continue
      if (!matchesReviewFilter(pr, reviewFilter)) continue
      counts.all++
      if (pr.authorClass === 'dependabot') counts.dependabot++
      else if (pr.authorClass === 'human') counts.humans++
    }
    return counts
  }, [allPrs, draftFilter, assigneeFilter, reviewFilter])

  const draftCounts = useMemo(() => {
    const counts: Record<DraftFilter, number> = { all: 0, ready: 0, draft: 0 }
    for (const pr of allPrs) {
      if (!matchesAuthorFilter(pr.authorClass, authorFilter)) continue
      if (!matchesAssigneeFilter(pr, assigneeFilter)) continue
      if (!matchesReviewFilter(pr, reviewFilter)) continue
      counts.all++
      if (pr.isDraft) counts.draft++
      else counts.ready++
    }
    return counts
  }, [allPrs, authorFilter, assigneeFilter, reviewFilter])

  const reviewCounts = useMemo(() => {
    const counts: Record<ReviewFilter, number> = { all: 0, approved: 0, mine: 0, unapproved: 0 }
    for (const pr of allPrs) {
      if (!matchesAuthorFilter(pr.authorClass, authorFilter)) continue
      if (!matchesDraftFilter(pr.isDraft, draftFilter)) continue
      if (!matchesAssigneeFilter(pr, assigneeFilter)) continue
      counts.all++
      // A row cached before the column existed is unknown, so it counts under
      // All and nowhere else — the same rule matchesReviewFilter applies.
      if (!hasReviewData(pr)) continue
      if (isApproved(pr)) {
        counts.approved++
        if (isApprovedByViewer(pr)) counts.mine++
      } else {
        counts.unapproved++
      }
    }
    return counts
  }, [allPrs, authorFilter, draftFilter, assigneeFilter])

  // The dropdown lists everyone seen so far, plus the stored value even when
  // the cycle has not yet reached a repo that mentions them — otherwise a
  // persisted login would silently reset to "All" on reload.
  const assigneeLogins = useMemo(() => {
    const logins = collectAssignees(activeResults)
    const isSentinel =
      assigneeFilter === ASSIGNEE_ALL ||
      assigneeFilter === ASSIGNEE_ANY ||
      assigneeFilter === ASSIGNEE_NONE
    if (!isSentinel && !logins.includes(assigneeFilter)) {
      return [assigneeFilter, ...logins].sort((a, b) => a.localeCompare(b))
    }
    return logins
  }, [activeResults, assigneeFilter])

  const setAuthorFilter = (next: AuthorFilter) => {
    setAuthorFilterState(next)
    writeAuthorFilter(next)
  }

  const setDraftFilter = (next: DraftFilter) => {
    setDraftFilterState(next)
    writeDraftFilter(next)
  }

  const setAssigneeFilter = (next: string) => {
    setAssigneeFilterState(next)
    writeAssigneeFilter(next)
  }

  const setReviewFilter = (next: ReviewFilter) => {
    setReviewFilterState(next)
    writeReviewFilter(next)
  }

  const visibleResults = useMemo(
    () => Object.values(activeResults).filter((r) => activeRepoSet.has(r.repo)),
    [activeResults, activeRepoSet],
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
      <SegmentedControl
        value={draftFilter}
        onChange={setDraftFilter}
        ariaLabel="Filter pull requests by draft status"
        options={DRAFT_OPTIONS.map((opt) => ({ ...opt, count: draftCounts[opt.key] }))}
      />
      <SegmentedControl
        value={reviewFilter}
        onChange={setReviewFilter}
        ariaLabel="Filter pull requests by review state"
        options={REVIEW_OPTIONS.map((opt) => ({ ...opt, count: reviewCounts[opt.key] }))}
      />
      <label className="assignee-filter">
        Assignee{' '}
        <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)}>
          <option value={ASSIGNEE_ALL}>All</option>
          <option value={ASSIGNEE_ANY}>Assigned</option>
          <option value={ASSIGNEE_NONE}>Unassigned</option>
          {assigneeLogins.map((login) => (
            <option key={login} value={login}>
              {login}
            </option>
          ))}
        </select>
      </label>

      <section className="meta">
        <CycleStatus cycle={sweep.cycle} fetched={fetched} total={activeRepos.length} />
        <span className="meta-sep">·</span>
        <span className="muted">
          {authorCounts[authorFilter]} open PR{authorCounts[authorFilter] === 1 ? '' : 's'} across{' '}
          {visibleResults.filter((r) => r.prs.length > 0).length} repos
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
        results={activeResults}
        inFlight={sweep.cycle.inFlight}
        authorFilter={authorFilter}
        draftFilter={draftFilter}
        assigneeFilter={assigneeFilter}
        reviewFilter={reviewFilter}
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
