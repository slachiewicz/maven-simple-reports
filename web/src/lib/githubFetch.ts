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

import type { RateLimitInfo } from './types'

interface QueueItem {
  run: () => Promise<void>
}

class SerialQueue {
  private chain: Promise<void> = Promise.resolve()
  private backoffUntil = 0

  setBackoff(untilMs: number): void {
    if (untilMs > this.backoffUntil) this.backoffUntil = untilMs
  }

  clearBackoff(): void {
    this.backoffUntil = 0
  }

  enqueue<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const item: QueueItem = {
        run: async () => {
          // Re-read the deadline on every slice instead of sleeping it out in
          // one go: clearBackoff() (a token was added, "Refresh now" pressed)
          // must take effect immediately. Sleeping the full span would serve
          // out a backoff of up to an hour that the user has already lifted,
          // with nothing on screen explaining the wait.
          for (;;) {
            const wait = this.backoffUntil - Date.now()
            if (wait <= 0) break
            await sleep(Math.min(wait, 500))
          }
          try {
            resolve(await work())
          } catch (err) {
            reject(err)
          }
        },
      }
      this.chain = this.chain.then(item.run, item.run)
    })
  }
}

export const apiQueue = new SerialQueue()

let listeners: Array<(rl: RateLimitInfo | null) => void> = []
let lastRateLimit: RateLimitInfo | null = null

export function subscribeRateLimit(fn: (rl: RateLimitInfo | null) => void): () => void {
  listeners.push(fn)
  fn(lastRateLimit)
  return () => {
    listeners = listeners.filter((l) => l !== fn)
  }
}

export function publishRateLimit(rl: RateLimitInfo | null): void {
  lastRateLimit = rl
  for (const l of listeners) l(rl)
}

/** Force the next request to fire immediately, ignoring any pending backoff. */
export function clearQueueBackoff(): void {
  apiQueue.clearBackoff()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const limit = headers.get('x-ratelimit-limit')
  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  if (limit == null || remaining == null || reset == null) return null
  return {
    limit: Number(limit),
    remaining: Number(remaining),
    resetAt: Number(reset) * 1000,
    resource: 'rest',
  }
}

/**
 * Distinguish a genuine quota/abuse throttle from an authorization 403.
 * 429 is always a throttle; for 403 we trust the rate-limit headers GitHub
 * sets on quota rejections (`x-ratelimit-remaining: 0`, `retry-after` on
 * secondary limits) and fall back to the message body. Anything else — most
 * importantly "Resource not accessible by integration" — is a permission
 * problem the user needs to see, not something to wait out.
 */
export function isRateLimited(res: Response, body: string): boolean {
  if (res.status === 429) return true
  if (res.headers.get('retry-after')) return true
  if (res.headers.get('x-ratelimit-remaining') === '0') return true
  return /rate limit|abuse detection/i.test(body)
}

/** Pull GitHub's `message` field out of an error body, falling back to raw text. */
export function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: string }
    if (parsed.message) return parsed.message
  } catch {
    // not JSON — fall through
  }
  return body.slice(0, 200) || 'no message'
}

export class GhRateLimitError extends Error {
  constructor(message: string, public readonly until: number, public readonly status: number) {
    super(message)
    this.name = 'GhRateLimitError'
  }
}

/**
 * A 403 that is *not* a quota rejection: bad or insufficiently scoped
 * credentials. Deliberately not a GhRateLimitError, so the fetch loop records
 * it as a per-repo error the user can read instead of pausing on it.
 */
export class GhAccessError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
    this.name = 'GhAccessError'
  }
}
