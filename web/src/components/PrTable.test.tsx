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
import type { BuildState, PrResult, PullRequestInfo } from '../lib/types'
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
  }
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
      />,
    )

    expect(screen.getByText('pending-repo')).toBeTruthy()
    expect(screen.getByText('has-error')).toBeTruthy()
  })
})
