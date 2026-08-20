// @vitest-environment jsdom
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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { PrTable } from './PrTable'
import type {
  BuildState,
  PrResult,
  PullRequestInfo,
  ReviewDecision,
  ViewerReviewState,
} from '../lib/types'
import type { AuthorClass } from '../lib/authors'
import { writeHideEmpty } from '../lib/cache'

afterEach(() => {
  cleanup()
})

beforeEach(() => {
  localStorage.clear()
})

// Minimal fixture: callers state only what the test cares about, everything
// else (url, checksUrl, headSha, ...) gets an inert default.
interface PrFixture {
  repo: string
  number: number
  title: string
  author: string
  authorClass: AuthorClass
  createdAt: string
  isDraft: boolean
  buildState: BuildState
  reviewDecision?: ReviewDecision
  viewerReviewState?: ViewerReviewState
}

function makePr(fixture: PrFixture): PullRequestInfo {
  return {
    ...fixture,
    updatedAt: fixture.createdAt,
    baseRef: 'main',
    url: `https://github.com/apache/${fixture.repo}/pull/${fixture.number}`,
    checksUrl: `https://github.com/apache/${fixture.repo}/pull/${fixture.number}/checks`,
    headSha: 'deadbeef',
    buildStateFetchedAt: null,
    assignees: [],
    reviewDecision: fixture.reviewDecision ?? 'NONE',
    viewerReviewState: fixture.viewerReviewState ?? 'NONE',
  }
}

// Cell text by column, for assertions that must name one column rather than
// the whole row — "?" and "—" now appear in both Assignee and Review.
const COLUMN = { title: 0, author: 1, assignee: 2, review: 3 } as const

function cellText(column: keyof typeof COLUMN): string[] {
  return [...document.querySelectorAll('tr.pr-row')].map(
    (row) => row.querySelectorAll('td')[COLUMN[column]]?.textContent?.trim() ?? '',
  )
}

function makeResults(entries: Record<string, PullRequestInfo[]>): Record<string, PrResult> {
  const out: Record<string, PrResult> = {}
  for (const [repo, prs] of Object.entries(entries)) {
    out[repo] = { repo, prs, fetchedAt: Date.now(), fromCache: false }
  }
  return out
}

describe('PrTable hide-empty + filter interaction', () => {
  // The shipped bug (twice): "hide repos without PRs" must hide a repo whose
  // PRs are all filtered out, not just repos with zero PRs to begin with.

  it('hides a repo whose only PR is filtered out by the author filter', () => {
    writeHideEmpty(true)
    const results = makeResults({
      'human-only': [
        makePr({
          repo: 'human-only',
          number: 1,
          title: 'Fix typo',
          author: 'alice',
          authorClass: 'human',
          createdAt: '2026-01-01T00:00:00Z',
          isDraft: false,
          buildState: 'SUCCESS',
        }),
      ],
      'has-dependabot': [
        makePr({
          repo: 'has-dependabot',
          number: 2,
          title: 'Bump lodash',
          author: 'dependabot[bot]',
          authorClass: 'dependabot',
          createdAt: '2026-01-01T00:00:00Z',
          isDraft: false,
          buildState: 'SUCCESS',
        }),
      ],
    })

    render(
      <PrTable
        allRepos={['human-only', 'has-dependabot']}
        results={results}
        inFlight={null}
        authorFilter="dependabot"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="all"
      />,
    )

    expect(screen.queryByText('human-only')).toBeNull()
    expect(screen.getByText('has-dependabot')).toBeTruthy()
  })

  it('hides a repo whose only PR is filtered out by the draft filter', () => {
    writeHideEmpty(true)
    const results = makeResults({
      'ready-only': [
        makePr({
          repo: 'ready-only',
          number: 1,
          title: 'Ready PR',
          author: 'alice',
          authorClass: 'human',
          createdAt: '2026-01-01T00:00:00Z',
          isDraft: false,
          buildState: 'SUCCESS',
        }),
      ],
      'has-draft': [
        makePr({
          repo: 'has-draft',
          number: 2,
          title: 'Draft PR',
          author: 'bob',
          authorClass: 'human',
          createdAt: '2026-01-01T00:00:00Z',
          isDraft: true,
          buildState: 'SUCCESS',
        }),
      ],
    })

    render(
      <PrTable
        allRepos={['ready-only', 'has-draft']}
        results={results}
        inFlight={null}
        authorFilter="all"
        draftFilter="draft"
        reviewFilter="all"
        assigneeFilter="all"
      />,
    )

    expect(screen.queryByText('ready-only')).toBeNull()
    expect(screen.getByText('has-draft')).toBeTruthy()
  })

  it('applies both filters together: a draft human PR is hidden under dependabot+draft, shown under humans+draft', () => {
    writeHideEmpty(true)
    const results = makeResults({
      'draft-human': [
        makePr({
          repo: 'draft-human',
          number: 1,
          title: 'WIP feature',
          author: 'carol',
          authorClass: 'human',
          createdAt: '2026-01-01T00:00:00Z',
          isDraft: true,
          buildState: 'SUCCESS',
        }),
      ],
    })

    const { unmount } = render(
      <PrTable
        allRepos={['draft-human']}
        results={results}
        inFlight={null}
        authorFilter="dependabot"
        draftFilter="draft"
        reviewFilter="all"
        assigneeFilter="all"
      />,
    )
    expect(screen.queryByText('draft-human')).toBeNull()
    unmount()

    render(
      <PrTable
        allRepos={['draft-human']}
        results={results}
        inFlight={null}
        authorFilter="humans"
        draftFilter="draft"
        reviewFilter="all"
        assigneeFilter="all"
      />,
    )
    expect(screen.getByText('draft-human')).toBeTruthy()
  })

  it('with both filters "all", shows a repo with PRs and hides a repo with zero PRs', () => {
    writeHideEmpty(true)
    const results = makeResults({
      'has-pr': [
        makePr({
          repo: 'has-pr',
          number: 1,
          title: 'Some change',
          author: 'alice',
          authorClass: 'human',
          createdAt: '2026-01-01T00:00:00Z',
          isDraft: false,
          buildState: 'SUCCESS',
        }),
      ],
      'no-prs': [],
    })

    render(
      <PrTable
        allRepos={['has-pr', 'no-prs']}
        results={results}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="all"
      />,
    )

    expect(screen.getByText('has-pr')).toBeTruthy()
    expect(screen.queryByText('no-prs')).toBeNull()
  })

  it('renders only the rows matching the author filter', () => {
    const results = makeResults({
      mixed: [
        makePr({
          repo: 'mixed',
          number: 1,
          title: 'Bump dependency X',
          author: 'dependabot[bot]',
          authorClass: 'dependabot',
          createdAt: '2026-01-01T00:00:00Z',
          isDraft: false,
          buildState: 'SUCCESS',
        }),
        makePr({
          repo: 'mixed',
          number: 2,
          title: 'Add feature Y',
          author: 'alice',
          authorClass: 'human',
          createdAt: '2026-01-01T00:00:00Z',
          isDraft: false,
          buildState: 'SUCCESS',
        }),
      ],
    })

    render(
      <PrTable
        allRepos={['mixed']}
        results={results}
        inFlight={null}
        authorFilter="dependabot"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="all"
      />,
    )

    expect(screen.getByText('Bump dependency X')).toBeTruthy()
    expect(screen.queryByText('Add feature Y')).toBeNull()
  })

  it('keeps a not-yet-fetched repo and an errored repo visible even with hide-empty on', () => {
    writeHideEmpty(true)
    const results: Record<string, PrResult> = {
      'has-error': {
        repo: 'has-error',
        prs: [],
        fetchedAt: Date.now(),
        fromCache: false,
        error: 'rate limited',
      },
    }

    render(
      <PrTable
        allRepos={['pending-repo', 'has-error']}
        results={results}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="all"
      />,
    )

    expect(screen.getByText('pending-repo')).toBeTruthy()
    expect(screen.getByText('has-error')).toBeTruthy()
  })
})

describe('assignee filter', () => {
  // Every filter bug in this table has hidden in a non-default option, so the
  // interesting cases are all away from "All".
  function assignedTo(logins: string[]): Partial<PullRequestInfo> {
    return {
      assignees: logins.map((login) => ({
        login,
        avatarUrl: `https://avatars.githubusercontent.com/${login}`,
        htmlUrl: `https://github.com/${login}`,
      })),
    }
  }

  const base = {
    number: 1,
    title: 'Bump something',
    author: 'dependabot[bot]',
    authorClass: 'dependabot' as AuthorClass,
    createdAt: '2026-08-01T10:00:00Z',
    isDraft: false,
    buildState: 'SUCCESS' as BuildState,
  }

  function results(): Record<string, PrResult> {
    return makeResults({
      'assigned-to-slachiewicz': [
        { ...makePr({ ...base, repo: 'assigned-to-slachiewicz' }), ...assignedTo(['slachiewicz']) },
      ],
      'assigned-to-someone-else': [
        { ...makePr({ ...base, repo: 'assigned-to-someone-else' }), ...assignedTo(['ascheman']) },
      ],
      unassigned: [{ ...makePr({ ...base, repo: 'unassigned' }), ...assignedTo([]) }],
    })
  }

  const allRepos = ['assigned-to-slachiewicz', 'assigned-to-someone-else', 'unassigned']

  it('narrows to a single login', () => {
    writeHideEmpty(true)
    render(
      <PrTable
        allRepos={allRepos}
        results={results()}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="slachiewicz"
      />,
    )

    expect(screen.getByText('assigned-to-slachiewicz')).toBeTruthy()
    expect(screen.queryByText('assigned-to-someone-else')).toBeNull()
    expect(screen.queryByText('unassigned')).toBeNull()
  })

  it('keeps only assigned PRs under "Assigned"', () => {
    writeHideEmpty(true)
    render(
      <PrTable
        allRepos={allRepos}
        results={results()}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="__any__"
      />,
    )

    expect(screen.getByText('assigned-to-slachiewicz')).toBeTruthy()
    expect(screen.getByText('assigned-to-someone-else')).toBeTruthy()
    expect(screen.queryByText('unassigned')).toBeNull()
  })

  it('keeps only unassigned PRs under "Unassigned"', () => {
    writeHideEmpty(true)
    render(
      <PrTable
        allRepos={allRepos}
        results={results()}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="__none__"
      />,
    )

    expect(screen.getByText('unassigned')).toBeTruthy()
    expect(screen.queryByText('assigned-to-slachiewicz')).toBeNull()
  })

  // The cache-compatibility case: a PR persisted before the column existed has
  // no assignees field. Claiming it as unassigned would be a lie about data we
  // simply do not have.
  it('excludes a pre-assignee cache entry from both Assigned and Unassigned', () => {
    const stale = makePr({ ...base, repo: 'stale' })
    delete stale.assignees
    const staleResults = makeResults({ stale: [stale] })

    writeHideEmpty(true)
    const { unmount } = render(
      <PrTable
        allRepos={['stale']}
        results={staleResults}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="__none__"
      />,
    )
    expect(screen.queryByText('stale')).toBeNull()
    unmount()

    render(
      <PrTable
        allRepos={['stale']}
        results={staleResults}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="__any__"
      />,
    )
    expect(screen.queryByText('stale')).toBeNull()
  })

  it('renders "?" rather than "—" for a pre-assignee cache entry', () => {
    const stale = makePr({ ...base, repo: 'stale' })
    delete stale.assignees
    render(
      <PrTable
        allRepos={['stale']}
        results={makeResults({ stale: [stale] })}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="all"
      />,
    )

    expect(cellText('assignee')).toEqual(['?'])
  })
})

describe('review filter', () => {
  // Same rule as every other filter here: the bugs hide in the non-default
  // options, and the hide-empty predicate has to agree with row rendering.
  const base = {
    number: 1,
    title: 'Some change',
    author: 'alice',
    authorClass: 'human' as const,
    createdAt: '2026-08-01T00:00:00Z',
    isDraft: false,
    buildState: 'SUCCESS' as const,
  }

  const allRepos = ['approved-by-you', 'approved-by-someone', 'unreviewed']

  function results() {
    return makeResults({
      'approved-by-you': [
        makePr({
          ...base,
          repo: 'approved-by-you',
          reviewDecision: 'APPROVED',
          viewerReviewState: 'APPROVED',
        }),
      ],
      'approved-by-someone': [
        makePr({ ...base, repo: 'approved-by-someone', reviewDecision: 'APPROVED' }),
      ],
      unreviewed: [makePr({ ...base, repo: 'unreviewed', reviewDecision: 'REVIEW_REQUIRED' })],
    })
  }

  function renderWith(reviewFilter: 'all' | 'approved' | 'mine' | 'unapproved') {
    writeHideEmpty(true)
    render(
      <PrTable
        allRepos={allRepos}
        results={results()}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter={reviewFilter}
        assigneeFilter="all"
      />,
    )
  }

  it('keeps every repo under "All"', () => {
    renderWith('all')

    for (const repo of allRepos) expect(screen.getByText(repo)).toBeTruthy()
  })

  it('hides repos whose PRs are all unapproved under "Approved"', () => {
    renderWith('approved')

    expect(screen.getByText('approved-by-you')).toBeTruthy()
    expect(screen.getByText('approved-by-someone')).toBeTruthy()
    expect(screen.queryByText('unreviewed')).toBeNull()
  })

  it('keeps only the viewer\'s own approvals under "By you"', () => {
    renderWith('mine')

    expect(screen.getByText('approved-by-you')).toBeTruthy()
    expect(screen.queryByText('approved-by-someone')).toBeNull()
    expect(screen.queryByText('unreviewed')).toBeNull()
  })

  it('keeps everything not approved under "Not approved"', () => {
    renderWith('unapproved')

    expect(screen.getByText('unreviewed')).toBeTruthy()
    expect(screen.queryByText('approved-by-you')).toBeNull()
    expect(screen.queryByText('approved-by-someone')).toBeNull()
  })

  it('marks the viewer\'s own approval and leaves other approvals unmarked', () => {
    render(
      <PrTable
        allRepos={allRepos}
        results={results()}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="all"
      />,
    )

    // Rows follow the table's alphabetical repo order: approved-by-someone,
    // approved-by-you, unreviewed.
    expect(cellText('review')).toEqual(['✓ Approved', '✓ Approved you', 'Review required'])
  })

  // The cache-compatibility case, mirroring the assignee column: an entry
  // persisted before this column existed is unknown, and must not be counted
  // as unapproved on the strength of data that was never fetched.
  it('excludes a pre-review cache entry from every option and renders "?"', () => {
    const stale = makePr({ ...base, repo: 'stale' })
    delete stale.reviewDecision
    delete stale.viewerReviewState
    const staleResults = makeResults({ stale: [stale] })

    writeHideEmpty(true)
    for (const filter of ['approved', 'mine', 'unapproved'] as const) {
      const { unmount } = render(
        <PrTable
          allRepos={['stale']}
          results={staleResults}
          inFlight={null}
          authorFilter="all"
          draftFilter="all"
          reviewFilter={filter}
          assigneeFilter="all"
        />,
      )
      expect(screen.queryByText('stale')).toBeNull()
      unmount()
    }

    render(
      <PrTable
        allRepos={['stale']}
        results={staleResults}
        inFlight={null}
        authorFilter="all"
        draftFilter="all"
        reviewFilter="all"
        assigneeFilter="all"
      />,
    )
    expect(cellText('review')).toEqual(['?'])
  })
})
