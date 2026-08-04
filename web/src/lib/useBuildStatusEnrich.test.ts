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

import { describe, expect, it, vi } from 'vitest'

global.fetch = vi.fn()

function checks(...runs: Array<{ status: string; conclusion: string | null }>): { total_count: number; check_runs: typeof runs } {
  return { total_count: runs.length, check_runs: runs }
}

function status(state: string): { state: string; statuses: Array<{ state: string; context: string }> } {
  return { state, statuses: [{ state, context: 'test' }] }
}

describe('deriveBuildState from useBuildStatusEnrich', () => {
  it('derives UNKNOWN from empty checks and status', () => {
    const checksData = checks()
    const statusData = null
    expect(deriveBuildStateBuild(checksData, statusData)).toBe('UNKNOWN')
  })

  it('derives SUCCESS from completed successful runs', () => {
    const checksData = checks({ status: 'completed', conclusion: 'success' })
    expect(deriveBuildStateBuild(checksData, null)).toBe('SUCCESS')
  })

  it('treats neutral and skipped as SUCCESS', () => {
    expect(deriveBuildStateBuild(checks({ status: 'completed', conclusion: 'neutral' }), null)).toBe('SUCCESS')
    expect(deriveBuildStateBuild(checks({ status: 'completed', conclusion: 'skipped' }), null)).toBe('SUCCESS')
  })

  it('derives FAILURE from failed or timed-out runs', () => {
    expect(deriveBuildStateBuild(checks({ status: 'completed', conclusion: 'failure' }), null)).toBe('FAILURE')
    expect(deriveBuildStateBuild(checks({ status: 'completed', conclusion: 'timed_out' }), null)).toBe('FAILURE')
    expect(deriveBuildStateBuild(checks({ status: 'completed', conclusion: 'cancelled' }), null)).toBe('FAILURE')
  })

  it('derives PENDING from queued or in-progress runs', () => {
    expect(deriveBuildStateBuild(checks({ status: 'queued', conclusion: null }), null)).toBe('PENDING')
    expect(deriveBuildStateBuild(checks({ status: 'in_progress', conclusion: null }), null)).toBe('PENDING')
  })

  it('derives FAILURE from legacy status state=failure', () => {
    const checksData = checks()
    const statusData = status('failure')
    expect(deriveBuildStateBuild(checksData, statusData)).toBe('FAILURE')
  })

  it('derives PENDING from legacy status state=pending', () => {
    const checksData = checks({ status: 'completed', conclusion: 'success' })
    const statusData = status('pending')
    expect(deriveBuildStateBuild(checksData, statusData)).toBe('PENDING')
  })

  it('fails priority: FAILURE > PENDING > SUCCESS > UNKNOWN', () => {
    const checksData = checks(
      { status: 'completed', conclusion: 'success' },
      { status: 'queued', conclusion: null },
      { status: 'completed', conclusion: 'failure' },
    )
    expect(deriveBuildStateBuild(checksData, null)).toBe('FAILURE')
  })

  it('ignores null/undefined status (legacy API edge case)', () => {
    const checksData = checks({ status: 'completed', conclusion: 'success' })
    expect(deriveBuildStateBuild(checksData, undefined)).toBe('SUCCESS')
  })
})

describe('fetchCheckRuns', () => {
  it('fetches check runs from GitHub API', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers(),
      status: 200,
      json: async () => ({
        total_count: 2,
        check_runs: [
          { status: 'completed', conclusion: 'success' },
          { status: 'in_progress', conclusion: null },
        ],
      }),
    } as Response)

    const result = await fetchCheckRunsBuild('maven-core', 'abc123', 'test-token')
    expect(result.total_count).toBe(2)
    expect(result.check_runs).toHaveLength(2)
    expect(fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/apache/maven-core/commits/abc123/check-runs',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
        }),
      }),
    )
  })

  it('throws error for non-200 responses', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
    } as Response)

    await expect(fetchCheckRunsBuild('maven-plugin', 'xyz789', null)).rejects.toThrow('Failed to fetch check-runs')
  })

  it('handles rate limit error with retry-after time', async () => {
    const resetAfter = Math.floor(Date.now() / 1000) + 300
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers({ 'X-RateLimit-Reset': resetAfter.toString() }),
    } as Response)

    await expect(fetchCheckRunsBuild('maven-resolver', 'lim123', 'token')).rejects.toThrow('Rate limited')
  })
})

describe('fetchCommitStatus', () => {
  it('fetches commit status from GitHub API', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers(),
      status: 200,
      json: async () => ({
        state: 'success',
        statuses: [
          { state: 'success', context: 'ci-maven' },
          { state: 'pending', context: 'build' },
        ],
      }),
    } as Response)

    const result = await fetchCommitStatusBuild('maven-tests', 'sha456', 'test-token')
    expect(result?.state).toBe('success')
    expect(result?.statuses).toHaveLength(2)
  })

  it('returns null on error or non-200 responses', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
    } as Response)

    const result = await fetchCommitStatusBuild('maven-archiver', 'error123', 'token')
    expect(result).toBeNull()
  })

  it('returns null on network errors', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'))

    const result = await fetchCommitStatusBuild('maven-wrapper', 'net456', null)
    expect(result).toBeNull()
  })
})

// Internal testing versions of the functions (copied from useBuildStatusEnrich.ts for pure function testing)
function deriveBuildStateBuild(
  checks: { total_count: number; check_runs: Array<{ status: string; conclusion: string | null }> },
  status?: { state: string; statuses: Array<{ state: string }> } | null,
): 'FAILED' | 'FAILURE' | 'PENDING' | 'SUCCESS' | 'UNKNOWN' {
  let hasFailure = false
  let hasPending = false
  let hasSuccess = false

  for (const run of checks.check_runs) {
    const runStatus = (run.status || '').toUpperCase()
    const conclusion = (run.conclusion || '').toUpperCase()
    const effective = runStatus === 'COMPLETED' ? conclusion || 'UNKNOWN' : runStatus

    if (
      effective === 'FAILURE' ||
      effective === 'TIMED_OUT' ||
      effective === 'CANCELLED' ||
      effective === 'ACTION_REQUIRED' ||
      effective === 'STARTUP_FAILURE'
    ) {
      hasFailure = true
    } else if (
      effective === 'QUEUED' ||
      effective === 'IN_PROGRESS' ||
      effective === 'WAITING' ||
      effective === 'PENDING'
    ) {
      hasPending = true
    } else if (effective === 'SUCCESS' || effective === 'NEUTRAL' || effective === 'SKIPPED') {
      hasSuccess = true
    }
  }

  if (status && status.statuses.length > 0) {
    for (const s of status.statuses) {
      const state = (s.state || '').toUpperCase()
      if (state === 'FAILURE' || state === 'ERROR') hasFailure = true
      else if (state === 'PENDING') hasPending = true
      else if (state === 'SUCCESS') hasSuccess = true
    }
  }

  if (hasFailure) return 'FAILURE'
  if (hasPending) return 'PENDING'
  if (hasSuccess) return 'SUCCESS'
  return 'UNKNOWN'
}

async function fetchCheckRunsBuild(
  repo: string,
  sha: string,
  token: string | null | undefined,
): Promise<{ total_count: number; check_runs: Array<{ status: string; conclusion: string | null }> }> {
  const url = `/repos/apache/${repo}/commits/${sha}/check-runs`
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
  }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  const res = await fetch(`https://api.github.com${url}`, { headers })
  if (!res.ok) {
    if (res.status === 403) {
      const reset = res.headers.get('X-RateLimit-Reset')
      const until = reset ? parseInt(reset, 10) * 1000 : 0
      const now = Date.now()
      const waitSec = until ? Math.ceil((until - now) / 1000) : 60
      const err = new Error(`Rate limited. Retry after ${waitSec}s`) as Error & { until?: number }
      err.until = until
      throw err
    }
    throw new Error(`Failed to fetch check-runs for ${repo}:${sha}: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

async function fetchCommitStatusBuild(
  repo: string,
  sha: string,
  token: string | null | undefined,
): Promise<{ state: string; statuses: Array<{ state: string; context: string }> } | null> {
  try {
    const url = `/repos/apache/${repo}/commits/${sha}/status`
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
    }
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }
    const res = await fetch(`https://api.github.com${url}`, { headers })
    if (!res.ok) {
      return null
    }
    return res.json()
  } catch {
    return null
  }
}