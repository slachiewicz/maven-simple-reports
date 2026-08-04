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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchRepoPrs } from './lib/pulls'
import { subscribeRateLimit } from './lib/githubFetch'
import {
  migrateLegacyCache,
  readAllResults,
  readFilter,
  readOauth,
  readToken,
  readTokenPersist,
  writeFilter,
  writeOauth,
  writeToken,
  writeTokenPersist,
} from './lib/cache'
import {
  completeOAuthFlow,
  needsRefresh,
  refreshOAuthToken,
  refreshTokenStillValid,
  startOAuthFlow,
  type StoredOauthTokens,
} from './lib/oauth'
import { MAVEN_REPOS } from './lib/repos'
import type { RateLimitInfo as RL, RepoFetchResult } from './lib/types'
import { type CycleState, useSweep } from './lib/useSweep'
import { PrTable } from './components/PrTable'
import { RateLimitInfo } from './components/RateLimitInfo'
import { FilterInput } from './components/FilterInput'
import { TokenInput } from './components/TokenInput'

// 30 min between full cycles when unauthenticated (60/h budget); 5 min when a PAT
// is configured (5 000/h budget). The interval is read at the start of each
// sleep, so toggling the token takes effect on the next cycle.
const CYCLE_INTERVAL_ANON_MS = 30 * 60_000
const CYCLE_INTERVAL_AUTH_MS = 5 * 60_000
const PER_REPO_SPACING_MS = 800

function applyFilter(pattern: string): { repos: string[]; invalid: boolean } {
  const trimmed = pattern.trim()
  if (!trimmed) return { repos: [...MAVEN_REPOS], invalid: false }
  try {
    const re = new RegExp(trimmed)
    return { repos: MAVEN_REPOS.filter((r) => re.test(r)), invalid: false }
  } catch {
    return { repos: [...MAVEN_REPOS], invalid: true }
  }
}

export function App() {
  const [filter, setFilter] = useState<string>(() => readFilter())
  const [token, setToken] = useState<string>(() => readToken())
  const [tokenPersist, setTokenPersist] = useState<boolean>(() => readTokenPersist())
  const [oauth, setOauth] = useState<StoredOauthTokens | null>(() =>
    readOauth<StoredOauthTokens>(),
  )
  const [oauthError, setOauthError] = useState<string | null>(null)

  // Hydrate from any prior tab's persisted results so a freshly opened tab
  // shows data instantly (even before its own fetch completes). Also run the
  // one-time migration that evicts the legacy ETag cache from localStorage so
  // persisted results have the full 5 MB budget.
  const hydratedResults = useMemo(() => {
    const removed = migrateLegacyCache()
    const hydrated = readAllResults<PrResult>()
    console.log(
      `[cache] migration removed ${removed} legacy ETag entries from localStorage; hydrated ${Object.keys(hydrated).length} repos from persisted results`,
    )
    return hydrated
  }, [])
  const [rl, setRl] = useState<RL | null>(null)

  const tokenRef = useRef<string>(token)
  const oauthRef = useRef<StoredOauthTokens | null>(oauth)

  useEffect(() => {
    tokenRef.current = token
  }, [token])

  useEffect(() => {
    oauthRef.current = oauth
  }, [oauth])

  const filterResult = useMemo(() => applyFilter(filter), [filter])
  const activeRepos = filterResult.repos
  const filterInvalid = filterResult.invalid

  useEffect(() => subscribeRateLimit(setRl), [])

  const acquireToken = useCallback(async (): Promise<string | undefined> => {
    const current = oauthRef.current
    if (current) {
      if (!refreshTokenStillValid(current)) {
        console.warn('OAuth refresh token expired; falling back to PAT/anonymous')
        updateOauth(null)
      } else if (needsRefresh(current)) {
        try {
          const refreshed = await refreshOAuthToken(current.refresh_token)
          updateOauth(refreshed)
          return refreshed.access_token
        } catch (err) {
          console.error('OAuth token refresh failed; falling back to PAT/anonymous', err)
          setOauthError(err instanceof Error ? err.message : String(err))
          updateOauth(null)
        }
      } else {
        return current.access_token
      }
    }
    return tokenRef.current || undefined
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const authenticated = !!oauth || !!token

  const sweep = useSweep<RepoFetchResult>({
    items: activeRepos,
    fetchOne: (repo, tok) => fetchRepoPrs(repo, { spaceBeforeMs: PER_REPO_SPACING_MS, token: tok }),
    getToken: acquireToken,
    intervalMs: authenticated ? CYCLE_INTERVAL_AUTH_MS : CYCLE_INTERVAL_ANON_MS,
    enabled: true,
    initialResults: hydratedResults,
  })

  const updateToken = (next: string, persist: boolean) => {
    setToken(next)
    setTokenPersist(persist)
    writeToken(next, persist)
    writeTokenPersist(persist)
    tokenRef.current = next
    // Lift any pending anonymous-quota backoff and wake the cycle so the
    // higher (or lower, on clear) limit takes effect immediately.
    sweep.wake()
  }

  const clearTokenAction = () => updateToken('', tokenPersist)

  const updateOauth = (next: StoredOauthTokens | null) => {
    setOauth(next)
    writeOauth(next, tokenPersist)
    oauthRef.current = next
    sweep.wake()
  }

  const connectOauth = () => {
    setOauthError(null)
    startOAuthFlow().catch((err) => {
      setOauthError(err instanceof Error ? err.message : String(err))
    })
  }

  const disconnectOauth = () => updateOauth(null)

  // Detect an OAuth callback in the URL on the very first render (after the
  // redirect from github.com → auth-callback function → back here). The helper
  // also cleans `code`/`state` out of the URL so a refresh doesn't replay.
  useEffect(() => {
    completeOAuthFlow()
      .then((tokens) => {
        if (tokens) updateOauth(tokens)
      })
      .catch((err) => {
        setOauthError(err instanceof Error ? err.message : String(err))
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const updateFilter = (next: string) => {
    setFilter(next)
    writeFilter(next)
  }

  const visibleResults = useMemo(() => {
    const active = new Set(activeRepos)
    return Object.values(sweep.results).filter((r) => active.has(r.repo))
  }, [sweep.results, activeRepos])
  const totalPrs = useMemo(
    () => visibleResults.reduce((n, r) => n + r.prs.length, 0),
    [visibleResults],
  )
  const remaining = sweep.pending.length
  const fetched = Math.max(0, activeRepos.length - remaining)

  return (
    <div className="app">
      <header>
        <h1>Open Maven Dependabot PRs</h1>
        <p className="subtitle">
          Live view across {MAVEN_REPOS.length} <code>apache/maven-*</code> repositories.
        </p>
      </header>

      <TokenInput
        token={token}
        persist={tokenPersist}
        oauth={oauth}
        oauthError={oauthError}
        onSave={updateToken}
        onClear={clearTokenAction}
        onConnectOauth={connectOauth}
        onDisconnectOauth={disconnectOauth}
      />

      <FilterInput
        pattern={filter}
        onChange={updateFilter}
        matchCount={activeRepos.length}
        totalCount={MAVEN_REPOS.length}
        invalid={filterInvalid}
      />

      <section className="meta">
        <RateLimitInfo rl={rl} />
        <span className="meta-sep">·</span>
        <CycleStatus cycle={sweep.cycle} fetched={fetched} total={activeRepos.length} />
        <span className="meta-sep">·</span>
        <span className="muted">
          {totalPrs} open Dependabot PR{totalPrs === 1 ? '' : 's'} across{' '}
          {visibleResults.filter((r) => r.prs.length > 0).length} repos
        </span>
        <span className="meta-sep grow">·</span>
        <button className="restart" type="button" onClick={sweep.refreshNow} title="Re-queue all active repos for a fresh fetch (previous data stays visible until each repo is updated)">
          Refresh now
        </button>
      </section>

      <main>
        <PrTable allRepos={activeRepos} results={sweep.results} inFlight={sweep.cycle.inFlight} />
      </main>

      <footer className="muted">
        <p>
          Static SPA · GitHub REST API · ETag-cached, serial polling. The unauthenticated 60 req/h limit is shared per IP.
        </p>
        <p>
          Contribute on GitHub:{' '}
          <a
            href="https://github.com/aschemaven/maven-simple-reports"
            target="_blank"
            rel="noopener noreferrer"
          >
            aschemaven/maven-simple-reports
          </a>
        </p>
      </footer>
    </div>
  )
}

function CycleStatus({
  cycle,
  fetched,
  total,
}: {
  cycle: import('./lib/useSweep').CycleState
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