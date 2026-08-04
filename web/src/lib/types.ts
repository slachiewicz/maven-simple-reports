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
  lastCommitDate: string | null
  lastCommitAuthor: string | null
  headSha: string
  isProtected: boolean
  openPrCount: number
  aheadBy: number | null
  behindBy: number | null
  isDefault: boolean
}

export interface RepoBranchResult {
  repo: string
  branches: BranchInfo[]
  defaultBranch: string
  fetchedAt: number
  totalCount: number
  truncated: boolean
  degraded: boolean
  error?: string
  archived?: boolean
}
