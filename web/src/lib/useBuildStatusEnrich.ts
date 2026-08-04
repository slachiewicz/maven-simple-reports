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

import { useCallback, useRef, useState } from 'react'
import type { BuildState } from './types'

export interface BuildStatusEnrichmentItem<T> {
  repo: string
  sha: string
  data: T
}

export interface BuildStatusEnrichmentResult<T> {
  item: BuildStatusEnrichmentItem<T>
  buildState: BuildState
  fetchedAt: number
}

export interface EnrichOptions {
  token?: string | null
  spaceBeforeMs?: number
}

interface EnrichmentState<T> {
  inFlight: Array<{ repo: string; sha: string }>
  results: Record<string, BuildStatusEnrichmentResult<T>>
  inProgressRepo: string | null
  lastError: string | null
}

export function useBuildStatusEnrich<T>() {
  const [state, setState] = useState<EnrichmentState<T>>({
    inFlight: [],
    results: {},
    inProgressRepo: null,
    lastError: null,
  })

  const inFlightRef = useRef<Array<{ repo: string; sha: string }>>([])
  const resultsRef = useRef<Record<string, BuildStatusEnrichmentResult<T>>>({})

  const makeKey = (repo: string, sha: string): string => `${repo}:${sha}`

  const enrich = useCallback(
    async (items: BuildStatusEnrichmentItem<T>[], opts: EnrichOptions = {}): Promise<void> => {
      const tokenRef = useRef(opts.token)
      const spaceBeforeMs = opts.spaceBeforeMs ?? 200

      inFlightRef.current = items.map((i) => ({ repo: i.repo, sha: i.sha }))
      setState((s) => ({
        ...s,
        inFlight: inFlightRef.current,
        inProgressRepo: null,
        lastError: null,
      }))

      for (const item of items) {
        const key = makeKey(item.repo, item.sha)

        setState((s) => ({ ...s, inProgressRepo: item.repo }))

        try {
          if (spaceBeforeMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, spaceBeforeMs))
          }

          const checks = await fetchCheckRuns(item.repo, item.sha, tokenRef.current)
          const status = await fetchCommitStatus(item.repo, item.sha, tokenRef.current)
          const buildState = deriveBuildState(checks, status)

          const result: BuildStatusEnrichmentResult<T> = {
            item,
            buildState,
            fetchedAt: Date.now(),
          }

          resultsRef.current[key] = result
          setState((s) => ({
            ...s,
            results: { ...s.results, [key]: result },
          }))

          inFlightRef.current = inFlightRef.current.filter(
            (i) => !(i.repo === item.repo && i.sha === item.sha),
          )
          setState((s) => ({ ...s, inFlight: inFlightRef.current }))
        } catch (err) {
          setState((s) => ({
            ...s,
            lastError: err instanceof Error ? err.message : String(err),
          }))
          inFlightRef.current = inFlightRef.current.filter(
            (i) => !(i.repo === item.repo && i.sha === item.sha),
          )
          setState((s) => ({ ...s, inFlight: inFlightRef.current }))
        }
      }

      setState((s) => ({ ...s, inProgressRepo: null }))
    },
    [],
  )

  const getItemResult = useCallback((repo: string, sha: string): BuildStatusEnrichmentResult<T> | null => {
    return resultsRef.current[makeKey(repo, sha)] ?? null
  }, [])

  return {
    enrich,
    getItemResult,
    inFlight: state.inFlight,
    results: state.results,
    inProgressRepo: state.inProgressRepo,
    lastError: state.lastError,
  }
}

interface CheckRun {
  status: string
  conclusion: string | null
}

interface CheckRunsResponse {
  total_count: number
  check_runs: CheckRun[]
}

interface CommitStatus {
  state: string
  context: string
}

interface CommitStatusResponse {
  state: string
  statuses: CommitStatus[]
}

async function fetchCheckRuns(
  repo: string,
  sha: string,
  token: string | null | undefined,
): Promise<CheckRunsResponse> {
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

async function fetchCommitStatus(
  repo: string,
  sha: string,
  token: string | null | undefined,
): Promise<CommitStatusResponse | null> {
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

function deriveBuildState(
  checks: CheckRunsResponse,
  status?: CommitStatusResponse | null,
): BuildState {
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