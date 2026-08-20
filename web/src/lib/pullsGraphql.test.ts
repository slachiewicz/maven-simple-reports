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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRepoPrsGraphql, mapRollupState } from './pullsGraphql'
import { GhRateLimitError, clearQueueBackoff } from './githubFetch'

function mockResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function prNode(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    title: 'Bump foo from 1.0 to 2.0',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-02T00:00:00Z',
    isDraft: false,
    url: 'https://github.com/apache/maven/pull/42',
    baseRefName: 'master',
    headRefOid: 'abc123',
    author: { login: 'dependabot[bot]', __typename: 'Bot' },
    assignees: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...overrides,
  }
}

function repoResponse(nodes: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    data: {
      repository: {
        isArchived: false,
        pullRequests: { totalCount: nodes.length, nodes },
        ...overrides,
      },
      rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-08-04T01:00:00Z' },
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  // apiQueue is a module singleton shared with githubFetch.ts. Tests that
  // trigger a rate-limit response set a real backoff on it; without clearing
  // it here, later tests in this file would block on that backoff and hit
  // the default test timeout.
  clearQueueBackoff()
})

describe('mapRollupState', () => {
  it('maps SUCCESS to SUCCESS', () => {
    expect(mapRollupState('SUCCESS')).toBe('SUCCESS')
  })

  it('maps FAILURE and ERROR to FAILURE', () => {
    expect(mapRollupState('FAILURE')).toBe('FAILURE')
    expect(mapRollupState('ERROR')).toBe('FAILURE')
  })

  it('maps PENDING and EXPECTED to PENDING', () => {
    expect(mapRollupState('PENDING')).toBe('PENDING')
    expect(mapRollupState('EXPECTED')).toBe('PENDING')
  })

  it('maps null, undefined, and an unrecognised value to UNKNOWN', () => {
    expect(mapRollupState(null)).toBe('UNKNOWN')
    expect(mapRollupState(undefined)).toBe('UNKNOWN')
    expect(mapRollupState('SOMETHING_NEW')).toBe('UNKNOWN')
  })
})

describe('fetchRepoPrsGraphql', () => {
  it('returns an error-carrying result and does not call fetch when there is no token', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const result = await fetchRepoPrsGraphql('maven', undefined)
    expect(result.error).toBeTruthy()
    expect(result.prs).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('classifies a null author (deleted account) the same as the REST path: bot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(repoResponse([prNode({ author: null })]))),
    )
    const result = await fetchRepoPrsGraphql('maven', 'tok')
    expect(result.prs[0].author).toBe('unknown')
    expect(result.prs[0].authorClass).toBe('bot')
  })

  it('classifies a Bot author as dependabot when the login matches', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(repoResponse([prNode()]))),
    )
    const result = await fetchRepoPrsGraphql('maven', 'tok')
    expect(result.prs[0].authorClass).toBe('dependabot')
  })

  it('classifies a User author as human', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(
          repoResponse([prNode({ author: { login: 'someone', __typename: 'User' } })]),
        ),
      ),
    )
    const result = await fetchRepoPrsGraphql('maven', 'tok')
    expect(result.prs[0].authorClass).toBe('human')
  })

  it('sets truncated true when totalCount exceeds the returned node count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(repoResponse([prNode()], { pullRequests: { totalCount: 150, nodes: [prNode()] } })),
      ),
    )
    const result = await fetchRepoPrsGraphql('maven', 'tok')
    expect(result.truncated).toBe(true)
  })

  it('sets truncated false when totalCount matches the returned node count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(repoResponse([prNode()]))),
    )
    const result = await fetchRepoPrsGraphql('maven', 'tok')
    expect(result.truncated).toBe(false)
  })

  it('returns an empty archived result without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(repoResponse([], { isArchived: true }))),
    )
    const result = await fetchRepoPrsGraphql('maven-studies', 'tok')
    expect(result.archived).toBe(true)
    expect(result.prs).toEqual([])
  })

  it('maps the status rollup onto buildState and sets buildStateFetchedAt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(
          repoResponse([
            prNode({
              commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
            }),
          ]),
        ),
      ),
    )
    const result = await fetchRepoPrsGraphql('maven', 'tok')
    expect(result.prs[0].buildState).toBe('FAILURE')
    expect(result.prs[0].buildStateFetchedAt).not.toBeNull()
  })

  it('leaves buildState UNKNOWN and buildStateFetchedAt null when no rollup is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(
          repoResponse([prNode({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })]),
        ),
      ),
    )
    const result = await fetchRepoPrsGraphql('maven', 'tok')
    expect(result.prs[0].buildState).toBe('UNKNOWN')
    expect(result.prs[0].buildStateFetchedAt).toBeNull()
  })

  // A RATE_LIMITED entry in the GraphQL errors array must propagate as
  // GhRateLimitError so the sweep pauses instead of the error being swallowed
  // into a per-repo error result, which would just make the sweep hammer again.
  it('propagates a RATE_LIMITED GraphQL error as GhRateLimitError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }),
      ),
    )
    await expect(fetchRepoPrsGraphql('maven', 'tok')).rejects.toBeInstanceOf(GhRateLimitError)
  })

  it('propagates a 403 as GhRateLimitError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('rate limited', { status: 403 })),
    )
    await expect(fetchRepoPrsGraphql('maven', 'tok')).rejects.toBeInstanceOf(GhRateLimitError)
  })
})

describe('fetchRepoPrsGraphql assignees', () => {
  it('maps the assignee nodes onto the PR', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        mockResponse(
          repoResponse([
            prNode({
              assignees: {
                nodes: [
                  {
                    login: 'slachiewicz',
                    avatarUrl: 'https://avatars.githubusercontent.com/u/1',
                    url: 'https://github.com/slachiewicz',
                  },
                ],
              },
            }),
          ]),
        ),
      ),
    )

    const result = await fetchRepoPrsGraphql('maven-compiler-plugin', 'tok')
    expect(result.prs[0].assignees).toEqual([
      {
        login: 'slachiewicz',
        avatarUrl: 'https://avatars.githubusercontent.com/u/1',
        htmlUrl: 'https://github.com/slachiewicz',
      },
    ])
  })

  // Always an array, never undefined: undefined is reserved for cache entries
  // written before the field existed, and conflating the two would make a
  // freshly fetched unassigned PR render as "?".
  it('records an empty array rather than undefined when nobody is assigned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(mockResponse(repoResponse([prNode({ assignees: { nodes: [] } })]))),
    )

    const result = await fetchRepoPrsGraphql('maven-compiler-plugin', 'tok')
    expect(result.prs[0].assignees).toEqual([])
  })
})
