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

import { ghGraphQL } from './githubGraphql'
import { GhRateLimitError } from './githubFetch'
import { MAVEN_OWNER } from './repos'
import { writeResult } from './cache'
import { classifyAuthor } from './authors'
import type {
  BuildState,
  PullRequestInfo,
  PrResult,
  ReviewDecision,
  ViewerReviewState,
} from './types'

const PR_PAGE_SIZE = 100

const PR_QUERY = `
query($owner:String!, $repo:String!) {
  repository(owner:$owner, name:$repo) {
    isArchived
    pullRequests(states:OPEN, first:${PR_PAGE_SIZE}) {
      totalCount
      nodes {
        number title createdAt updatedAt isDraft url
        baseRefName headRefOid
        author { login __typename }
        reviewDecision
        viewerLatestReview { state }
        assignees(first:10) { nodes { login avatarUrl url } }
        commits(last:1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`

interface PrNode {
  number: number
  title: string
  createdAt: string
  updatedAt: string
  isDraft: boolean
  url: string
  baseRefName: string
  headRefOid: string
  author: { login: string; __typename: string } | null
  reviewDecision?: string | null
  viewerLatestReview?: { state: string } | null
  assignees?: { nodes: Array<{ login: string; avatarUrl: string; url: string }> }
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> }
}

interface PrsResponse {
  repository: {
    isArchived: boolean
    pullRequests: { totalCount: number; nodes: PrNode[] }
  } | null
}

/**
 * Both review fields are scalar reads on the PullRequest node — no connection,
 * no page size — so they add nothing to the query's point cost. Measured
 * against apache/maven-compiler-plugin: cost 2 with them, cost 2 without.
 */
export function mapReviewDecision(decision: string | null | undefined): ReviewDecision {
  switch (decision) {
    case 'APPROVED':
    case 'CHANGES_REQUESTED':
    case 'REVIEW_REQUIRED':
      return decision
    // null is what GitHub returns when nothing has been submitted and the base
    // branch requires no review, which is the common case here.
    default:
      return 'NONE'
  }
}

/**
 * `viewerLatestReview` is the viewer's latest review of *any* kind, so an
 * approval followed by a comment-only review reads back as COMMENTED even
 * though the approval still stands and `reviewDecision` still says APPROVED.
 * The alternative needs a `viewer { login }` lookup and a reviews connection;
 * this stays free, and only APPROVED counts as "approved by you" — which also
 * makes a dismissed approval correctly stop counting.
 */
export function mapViewerReviewState(state: string | null | undefined): ViewerReviewState {
  switch (state) {
    case 'APPROVED':
    case 'CHANGES_REQUESTED':
    case 'COMMENTED':
    case 'DISMISSED':
    case 'PENDING':
      return state
    default:
      return 'NONE'
  }
}

/**
 * Maps GraphQL's StatusState rollup onto BuildState, which is what the badge
 * column renders.
 */
export function mapRollupState(state: string | null | undefined): BuildState {
  switch (state) {
    case 'SUCCESS':
      return 'SUCCESS'
    case 'FAILURE':
    case 'ERROR':
      return 'FAILURE'
    case 'PENDING':
    case 'EXPECTED':
      return 'PENDING'
    default:
      return 'UNKNOWN'
  }
}

/**
 * The pull-request fetch: one GraphQL call per repo returns the open PRs AND
 * their build-status rollup together, at ~1-2 points against the 5 000/h
 * budget. A token is mandatory — GitHub rejects anonymous GraphQL outright,
 * which is why the app renders a sign-in prompt rather than any unauthenticated
 * view.
 */
export async function fetchRepoPrsGraphql(
  repo: string,
  token: string | undefined,
): Promise<PrResult> {
  if (!token) {
    return {
      repo,
      prs: [],
      fetchedAt: Date.now(),
      fromCache: false,
      error: 'A GitHub token is required for the GraphQL pull-requests path',
    }
  }

  try {
    const data = await ghGraphQL<PrsResponse>(PR_QUERY, { owner: MAVEN_OWNER, repo }, token)

    if (!data.repository) {
      return {
        repo,
        prs: [],
        fetchedAt: Date.now(),
        fromCache: false,
        error: 'Repository not found',
      }
    }

    if (data.repository.isArchived) {
      const result: PrResult = {
        repo,
        prs: [],
        fetchedAt: Date.now(),
        fromCache: false,
        archived: true,
      }
      writeResult(repo, result)
      return result
    }

    const baseUrl = `https://github.com/${MAVEN_OWNER}/${repo}`
    const nodes = data.repository.pullRequests.nodes
    const prs: PullRequestInfo[] = nodes.map((n) => {
      const rollup = n.commits.nodes[0]?.commit.statusCheckRollup ?? null
      return {
        repo,
        number: n.number,
        title: n.title,
        author: n.author?.login ?? 'unknown',
        authorClass: classifyAuthor(
          n.author?.login,
          n.author?.__typename === 'Bot' ? 'Bot' : 'User',
        ),
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        isDraft: n.isDraft,
        baseRef: n.baseRefName,
        url: n.url,
        checksUrl: `${baseUrl}/pull/${n.number}/checks`,
        headSha: n.headRefOid,
        buildState: mapRollupState(rollup?.state),
        buildStateFetchedAt: rollup ? Date.now() : null,
        // Always set, never left undefined — see the assignees note below.
        reviewDecision: mapReviewDecision(n.reviewDecision),
        viewerReviewState: mapViewerReviewState(n.viewerLatestReview?.state),
        // Always set, never left undefined: an empty array is "nobody is
        // assigned", while undefined is reserved for cache entries written
        // before this field existed. See hasAssigneeData().
        assignees: (n.assignees?.nodes ?? []).map((a) => ({
          login: a.login,
          avatarUrl: a.avatarUrl,
          htmlUrl: a.url,
        })),
      }
    })

    const result: PrResult = {
      repo,
      prs,
      fetchedAt: Date.now(),
      fromCache: false,
      truncated: data.repository.pullRequests.totalCount > nodes.length,
    }
    writeResult(repo, result)
    return result
  } catch (err) {
    // Rate-limit errors bubble up so the caller can pause the cycle and
    // re-queue this repo; everything else is recorded as a per-repo failure.
    if (err instanceof GhRateLimitError) throw err
    return {
      repo,
      prs: [],
      fetchedAt: Date.now(),
      fromCache: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
