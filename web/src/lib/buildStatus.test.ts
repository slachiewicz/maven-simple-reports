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

import { describe, expect, it } from 'vitest'
import { deriveBuildState, type CheckRunsResponse } from './buildStatus'

function checks(...runs: Array<{ status: string; conclusion: string | null }>): CheckRunsResponse {
  return { total_count: runs.length, check_runs: runs }
}

describe('deriveBuildState', () => {
  it('returns UNKNOWN with no checks and no statuses', () => {
    expect(deriveBuildState(checks(), null)).toBe('UNKNOWN')
  })

  it('returns SUCCESS for a completed successful run', () => {
    expect(deriveBuildState(checks({ status: 'completed', conclusion: 'success' }), null)).toBe(
      'SUCCESS',
    )
  })

  it('treats neutral and skipped as SUCCESS', () => {
    expect(deriveBuildState(checks({ status: 'completed', conclusion: 'neutral' }), null)).toBe(
      'SUCCESS',
    )
    expect(deriveBuildState(checks({ status: 'completed', conclusion: 'skipped' }), null)).toBe(
      'SUCCESS',
    )
  })

  it('returns PENDING for an in-progress run', () => {
    expect(deriveBuildState(checks({ status: 'in_progress', conclusion: null }), null)).toBe(
      'PENDING',
    )
  })

  it('lets FAILURE win over PENDING and SUCCESS', () => {
    const state = deriveBuildState(
      checks(
        { status: 'completed', conclusion: 'success' },
        { status: 'in_progress', conclusion: null },
        { status: 'completed', conclusion: 'failure' },
      ),
      null,
    )
    expect(state).toBe('FAILURE')
  })

  it('treats timed_out, cancelled, action_required and startup_failure as FAILURE', () => {
    for (const conclusion of ['timed_out', 'cancelled', 'action_required', 'startup_failure']) {
      expect(deriveBuildState(checks({ status: 'completed', conclusion }), null)).toBe('FAILURE')
    }
  })

  // Apache Jenkins (ci-maven.apache.org) reports via the legacy combined-status
  // API rather than CheckRuns. Without this source the dashboard misses Jenkins
  // failures entirely — see buildStatus.ts:34-36.
  it('picks up a Jenkins failure that exists only in the legacy status API', () => {
    const state = deriveBuildState(checks({ status: 'completed', conclusion: 'success' }), {
      state: 'failure',
      statuses: [{ state: 'failure', context: 'Jenkins' }],
    })
    expect(state).toBe('FAILURE')
  })

  it('ignores the rolled-up combined state when the statuses array is empty', () => {
    const state = deriveBuildState(checks({ status: 'completed', conclusion: 'success' }), {
      state: 'pending',
      statuses: [],
    })
    expect(state).toBe('SUCCESS')
  })
})
