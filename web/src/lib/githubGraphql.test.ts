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
import { GhGraphQLError, ghGraphQL } from './githubGraphql'
import { GhRateLimitError, clearQueueBackoff } from './githubFetch'

function mockResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  // apiQueue is a module singleton shared with githubFetch.ts. Tests that
  // trigger a rate-limit response set a real backoff on it; without clearing
  // it here, later tests in this file would block on that backoff and hit
  // the default test timeout.
  clearQueueBackoff()
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
