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

import type { AuthorClass } from './authors'

export type BuildState =
  | 'SUCCESS'
  | 'FAILURE'
  | 'PENDING'
  | 'CONFLICT'
  | 'UNKNOWN'

export interface RateLimitInfo {
  limit: number
  remaining: number
  resetAt: number // ms epoch
  resource: 'rest' | 'graphql'
}

export interface PullRequestInfo {
  repo: string
  number: number
  title: string
  author: string
  authorClass: AuthorClass
  createdAt: string
  updatedAt: string
  isDraft: boolean
  baseRef: string
  url: string
  checksUrl: string
  headSha: string
  buildState: BuildState
  buildStateFetchedAt: number | null
}

export interface PrResult {
  repo: string
  prs: PullRequestInfo[]
  fetchedAt: number
  fromCache: boolean
  error?: string
  archived?: boolean
  /** True when the repo has more than the 100 open PRs the GraphQL path requested. */
  truncated?: boolean
}

export interface DashboardState {
  repos: Record<string, PrResult>
  rateLimit: RateLimitInfo | null
  lastError: string | null
  cycleStartedAt: number | null
  cycleCompletedAt: number | null
  inFlightRepo: string | null
}

export interface BranchInfo {
  repo: string
  name: string
  /** ISO 8601, or null when the ref target is not a commit. */
  lastCommitDate: string | null
  lastCommitAuthor: string | null
  headSha: string
  isProtected: boolean
  openPrCount: number
  /** Commits this branch has that the default branch lacks. Null if unavailable. */
  aheadBy: number | null
  /** Commits the default branch has that this branch lacks. Null if unavailable. */
  behindBy: number | null
  isDefault: boolean
}

export interface RepoBranchResult {
  repo: string
  branches: BranchInfo[]
  defaultBranch: string
  fetchedAt: number
  totalCount: number
  /** True when the repo has more than the 100 refs we requested. */
  truncated: boolean
  /** True when ahead/behind was dropped after a query timeout. */
  degraded: boolean
  error?: string
  archived?: boolean
}
