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
import { subscribeRateLimit } from './lib/githubFetch'
import {
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
import { ALL_REPOS } from './lib/repos'
import type { RateLimitInfo as RL } from './lib/types'
import { RateLimitInfo } from './components/RateLimitInfo'
import { FilterInput } from './components/FilterInput'
import { TokenInput } from './components/TokenInput'
import { SignInPrompt } from './components/SignInPrompt'
import { PullRequestsView } from './views/PullRequestsView'
import { BranchesView } from './views/BranchesView'

export type ViewKey = 'prs' | 'branches'

function readViewFromUrl(): ViewKey {
  const raw = new URLSearchParams(window.location.search).get('view')
  return raw === 'branches' ? 'branches' : 'prs'
}

function applyFilter(pattern: string): { repos: string[]; invalid: boolean } {
  const trimmed = pattern.trim()
  if (!trimmed) return { repos: [...ALL_REPOS], invalid: false }
  try {
    const re = new RegExp(trimmed)
    return { repos: ALL_REPOS.filter((r) => re.test(r)), invalid: false }
  } catch {
    return { repos: [...ALL_REPOS], invalid: true }
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
  const [rl, setRl] = useState<RL | null>(null)
  const [view, setViewState] = useState<ViewKey>(() => readViewFromUrl())
  // Bumped whenever the token or OAuth credentials change, so a view whose
  // sweep is mid-sleep (an inter-cycle wait or a rate-limit pause) can wake
  // immediately instead of waiting out the remainder on stale credentials.
  const [tokenEpoch, setTokenEpoch] = useState(0)

  const tokenRef = useRef<string>(token)
  const oauthRef = useRef<StoredOauthTokens | null>(oauth)
  const tokenPersistRef = useRef<boolean>(tokenPersist)

  useEffect(() => {
    tokenRef.current = token
  }, [token])

  useEffect(() => {
    oauthRef.current = oauth
  }, [oauth])

  useEffect(() => {
    tokenPersistRef.current = tokenPersist
  }, [tokenPersist])

  const filterResult = useMemo(() => applyFilter(filter), [filter])
  const activeRepos = filterResult.repos
  const filterInvalid = filterResult.invalid

  useEffect(() => subscribeRateLimit(setRl), [])

  const setView = (next: ViewKey) => {
    setViewState(next)
    const url = new URL(window.location.href)
    if (next === 'prs') url.searchParams.delete('view')
    else url.searchParams.set('view', next)
    window.history.replaceState(null, '', url)
  }

  // Tab switches use replaceState so they do not spam the back stack — the
  // ?view= param exists to make a view linkable. This listener keeps the
  // rendered tab in sync if the URL changes underneath us (e.g. the user
  // navigates back into the app from another page with ?view= set).
  useEffect(() => {
    const onPop = () => setViewState(readViewFromUrl())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

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
          console.error('OAuth token refresh failed; falling back to a PAT if one is set', err)
          setOauthError(err instanceof Error ? err.message : String(err))
          updateOauth(null)
        }
      } else {
        return current.access_token
      }
    }
    return tokenRef.current || undefined
  }, [])

  const authenticated = !!oauth || !!token

  const updateToken = (next: string, persist: boolean) => {
    setToken(next)
    setTokenPersist(persist)
    writeToken(next, persist)
    writeTokenPersist(persist)
    tokenRef.current = next
    tokenPersistRef.current = persist
    setTokenEpoch((n) => n + 1)
  }

  const clearTokenAction = () => updateToken('', tokenPersist)

  const updateOauth = (next: StoredOauthTokens | null) => {
    setOauth(next)
    writeOauth(next, tokenPersistRef.current)
    oauthRef.current = next
    setTokenEpoch((n) => n + 1)
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
  }, [])

  const updateFilter = (next: string) => {
    setFilter(next)
    writeFilter(next)
  }

  return (
    <div className="app">
      <header>
        <h1>Open Maven Pull Requests &amp; Branches</h1>
        <p className="subtitle">
          Live view of pull requests and branches across {ALL_REPOS.length}{' '}
          <code>apache</code>, <code>codehaus-plexus</code> and <code>mojohaus</code>{' '}
          repositories.
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
        totalCount={ALL_REPOS.length}
        invalid={filterInvalid}
      />

      <section className="meta">
        <RateLimitInfo rl={rl} />
      </section>

      <nav className="tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'prs'}
          className={`tab-btn${view === 'prs' ? ' tab-btn-active' : ''}`}
          onClick={() => setView('prs')}
        >
          Pull requests
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'branches'}
          className={`tab-btn${view === 'branches' ? ' tab-btn-active' : ''}`}
          onClick={() => setView('branches')}
        >
          Branches
        </button>
      </nav>

      <main>
        {!authenticated ? (
          <SignInPrompt />
        ) : view === 'prs' ? (
          <PullRequestsView
            activeRepos={activeRepos}
            getToken={acquireToken}
            tokenEpoch={tokenEpoch}
          />
        ) : (
          <BranchesView
            activeRepos={activeRepos}
            getToken={acquireToken}
            hasToken={authenticated}
            tokenEpoch={tokenEpoch}
          />
        )}
      </main>

      <footer className="muted">
        <p>
          Static SPA · GitHub GraphQL API · serial polling against the 5 000 points/h budget of whichever credentials you supply.
        </p>
        <p>
          Contribute on GitHub:{' '}
          <a
            href="https://github.com/slachiewicz/maven-simple-reports"
            target="_blank"
            rel="noopener noreferrer"
          >
            slachiewicz/maven-simple-reports
          </a>
        </p>
      </footer>
    </div>
  )
}
