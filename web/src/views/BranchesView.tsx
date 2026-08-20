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

import { useEffect, useMemo, useState } from 'react'
import { useSweep } from '../lib/useSweep'
import { fetchRepoBranches } from '../lib/branches'
import {
  readAllBranchResults,
  readStaleOnly,
  readStaleThreshold,
  writeStaleOnly,
  writeStaleThreshold,
} from '../lib/cache'
import type { RepoBranchResult } from '../lib/types'
import { BranchTable } from '../components/BranchTable'

// GraphQL costs ~3-6 points per repo against a 5 000/h budget, so an hourly
// cycle over ~157 repos spends ~470-940 of it. Branches move slower than PRs,
// and this is the more expensive of the two sweeps.
const BRANCH_CYCLE_INTERVAL_MS = 60 * 60_000

interface Props {
  activeRepos: readonly string[]
  getToken: () => Promise<string | undefined>
  /** Defence in depth: App already renders a sign-in prompt instead of this
   * view when there are no credentials. */
  hasToken: boolean
  tokenEpoch: number
  /** False while the pull-requests tab is showing: the view stays mounted,
   * keeping its place in the cycle, but stops spending the shared budget. */
  active: boolean
}

export function BranchesView({ activeRepos, getToken, hasToken, tokenEpoch, active }: Props) {
  const [staleOnly, setStaleOnlyState] = useState<boolean>(() => readStaleOnly())
  const [threshold, setThresholdState] = useState<number>(() => readStaleThreshold())

  const initialResults = useMemo(() => readAllBranchResults<RepoBranchResult>(), [])

  const sweep = useSweep<RepoBranchResult>({
    items: activeRepos,
    fetchOne: (repo, token) => fetchRepoBranches(repo, token),
    getToken,
    intervalMs: BRANCH_CYCLE_INTERVAL_MS,
    enabled: hasToken && active,
    initialResults,
  })

  // A token saved or replaced mid-sleep must resume immediately rather than
  // waiting out the current interval or a rate-limit pause; the enabled
  // false→true transition only covers going from no-token to token.
  useEffect(() => {
    if (tokenEpoch === 0) return
    sweep.wake()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wake on credential change only
  }, [tokenEpoch])

  const setStaleOnly = (v: boolean) => {
    setStaleOnlyState(v)
    writeStaleOnly(v)
  }

  const setThreshold = (days: number) => {
    setThresholdState(days)
    writeStaleThreshold(days)
  }

  const fetchedCount = useMemo(
    () => activeRepos.filter((r) => sweep.results[r] !== undefined).length,
    [activeRepos, sweep.results],
  )

  return (
    <>
      <div className="branch-controls">
        <label>
          <input
            type="checkbox"
            checked={staleOnly}
            onChange={(e) => setStaleOnly(e.target.checked)}
          />{' '}
          Stale only
        </label>
        <label>
          Older than{' '}
          <input
            className="branch-threshold"
            type="number"
            min={1}
            max={3650}
            value={threshold}
            disabled={!staleOnly}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (Number.isFinite(n) && n > 0) setThreshold(n)
            }}
          />{' '}
          days
        </label>
        <span className="muted">
          {fetchedCount}/{activeRepos.length} repos fetched
        </span>
        <button type="button" className="restart" onClick={sweep.refreshNow}>
          Refresh now
        </button>
      </div>
      <p className="muted">
        Excludes the default branch, protected branches, and branches with an open
        pull request.
      </p>
      <BranchTable
        allRepos={activeRepos}
        results={sweep.results}
        inFlight={sweep.cycle.inFlight}
        staleOnly={staleOnly}
        thresholdDays={threshold}
      />
    </>
  )
}
