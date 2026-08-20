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

/**
 * GitHub's `PullRequestReviewDecision`, plus `NONE` standing in for the null
 * the API returns when no review has been submitted and none is required.
 */
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | 'NONE'

/**
 * The state of *your* latest review on a PR, from `viewerLatestReview`, with
 * `NONE` for "you have not reviewed it".
 */
export type ViewerReviewState =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'COMMENTED'
  | 'DISMISSED'
  | 'PENDING'
  | 'NONE'

export interface PrAssignee {
  login: string
  avatarUrl: string
  htmlUrl: string
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
  /**
   * Optional on purpose: results persisted by earlier versions predate this
   * field, and we want them to keep working rather than force a `gh-result:`
   * version bump (which would discard every repo's last known state and burn a
   * full refetch cycle against the rate limit).
   *
   * `undefined` therefore means "this cached entry was written before the
   * column existed" — *not* "nobody is assigned". Use `hasAssigneeData()` to
   * tell the two apart and `assigneesOf()` to read the list safely.
   */
  assignees?: PrAssignee[]
  /**
   * Optional for the same reason as `assignees`: entries persisted before the
   * review column existed have no such field, and `undefined` means "unknown",
   * not "nobody has reviewed it". Use `hasReviewData()` to tell them apart.
   */
  reviewDecision?: ReviewDecision
  /** See `reviewDecision` for why this is optional. */
  viewerReviewState?: ViewerReviewState
}

/**
 * True once a PR has been fetched by a version that knows about assignees.
 * Distinguishes a genuinely unassigned PR from a stale cache entry, so the UI
 * never claims "unassigned" about data it simply does not have yet.
 */
export function hasAssigneeData(pr: PullRequestInfo): boolean {
  return pr.assignees !== undefined
}

/** Null-safe accessor tolerating pre-assignee entries from `localStorage`. */
export function assigneesOf(pr: PullRequestInfo): PrAssignee[] {
  return pr.assignees ?? []
}

/**
 * True once a PR has been fetched by a version that knows about reviews, so a
 * stale entry renders "?" instead of being claimed as unreviewed.
 */
export function hasReviewData(pr: PullRequestInfo): boolean {
  return pr.reviewDecision !== undefined
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
