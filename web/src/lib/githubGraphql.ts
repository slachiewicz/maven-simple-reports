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

import {
  GhAccessError,
  GhRateLimitError,
  apiQueue,
  extractMessage,
  isRateLimited,
  parseRateLimit,
  publishRateLimit,
} from './githubFetch'

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
      // Same 403 overload as the REST path: an insufficiently scoped token is
      // a permission problem to surface, not a throttle to wait out.
      const body = await res.text().catch(() => '')
      if (isRateLimited(res, body)) {
        const retryAfter = Number(res.headers.get('retry-after'))
        const until = Number.isFinite(retryAfter) && retryAfter > 0
          ? Date.now() + retryAfter * 1000
          : Date.now() + 60_000
        apiQueue.setBackoff(until)
        throw new GhRateLimitError(`GitHub GraphQL ${res.status}`, until, res.status)
      }
      throw new GhAccessError(`GitHub GraphQL ${res.status}: ${extractMessage(body)}`, res.status)
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
