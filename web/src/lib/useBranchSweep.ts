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

import { useEffect } from 'react'
import { useSweep, type CycleState } from './useSweep'
import { fetchRepoBranches } from './branches'
import type { RepoBranchResult } from './types'

export function useBranchSweep(
  repos: readonly string[],
  getToken: () => Promise<string | undefined>,
  intervalMs: number,
  enabled: boolean
): {
  results: Record<string, RepoBranchResult>
  cycle: CycleState
  pending: string[]
  refreshNow: () => void
  wake: () => void
} {
  const { results, cycle, pending, refreshNow, wake } = useSweep<RepoBranchResult>({
    items: repos,
    fetchOne: async (repo, token) => {
      if (!token) {
        throw new Error('GitHub token required for branch fetching')
      }
      return await fetchRepoBranches(repo, { token })
    },
    getToken,
    intervalMs,
    enabled,
  })

  useEffect(() => {
    if (!enabled) {
      wake()
    }
  }, [enabled, wake])

  return { results, cycle, pending, refreshNow, wake }
}