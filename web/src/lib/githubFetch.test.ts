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
import { clearQueueBackoff, extractMessage, isRateLimited } from './githubFetch'

function res(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

afterEach(() => {
  vi.unstubAllGlobals()
  // apiQueue is a module singleton; a test that provokes a real backoff would
  // otherwise stall every later test until the deadline passes.
  clearQueueBackoff()
})

describe('isRateLimited', () => {
  it('treats 429 as a throttle whatever the body says', () => {
    expect(isRateLimited(res(429, 'anything'), 'anything')).toBe(true)
  })

  it('treats a retry-after header as a secondary-limit throttle', () => {
    expect(isRateLimited(res(403, '', { 'retry-after': '60' }), '')).toBe(true)
  })

  it('treats an exhausted x-ratelimit-remaining as a throttle', () => {
    expect(isRateLimited(res(403, '', { 'x-ratelimit-remaining': '0' }), '')).toBe(true)
  })

  it('falls back to the message body when no header classifies it', () => {
    expect(isRateLimited(res(403, ''), 'API rate limit exceeded for 1.2.3.4')).toBe(true)
    expect(isRateLimited(res(403, ''), 'You have triggered an abuse detection mechanism')).toBe(true)
  })

  // The whole point of the classification: this must NOT read as a throttle,
  // or a permission problem becomes a silent multi-minute wait.
  it('does not treat a permission 403 as a throttle', () => {
    const body = JSON.stringify({ message: 'Resource not accessible by integration' })
    expect(isRateLimited(res(403, body), body)).toBe(false)
  })

  // Remaining > 0 means quota was left, so the refusal was about access.
  it('does not treat a 403 with quota remaining as a throttle', () => {
    expect(isRateLimited(res(403, '', { 'x-ratelimit-remaining': '4999' }), '')).toBe(false)
  })
})

describe('extractMessage', () => {
  it('pulls the message field out of a GitHub error envelope', () => {
    expect(extractMessage(JSON.stringify({ message: 'Bad credentials' }))).toBe('Bad credentials')
  })

  it('falls back to the raw text when the body is not JSON', () => {
    expect(extractMessage('plain text failure')).toBe('plain text failure')
  })

  it('reports something readable for an empty body', () => {
    expect(extractMessage('')).toBe('no message')
  })
})
