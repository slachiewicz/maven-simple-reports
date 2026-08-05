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
import type { BuildState, PullRequestInfo, PrResult } from './types'

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
  commits: { nodes: Array<{ commit: { statusCheckRollup: { state: string } | null } }> }
}

interface PrsResponse {
  repository: {
    isArchived: boolean
    pullRequests: { totalCount: number; nodes: PrNode[] }
  } | null
}

/**
 * Maps GraphQL's StatusState rollup onto the REST-derived BuildState so both
 * fetch paths agree on the same badge for the same commit.
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
 * Authenticated PR fetch: one GraphQL call per repo returns the open PRs AND
 * their build-status rollup together, instead of the REST path's one
 * inventory call plus two enrichment calls per PR. Returns the same PrResult
 * shape as fetchRepoPrs so nothing downstream needs to know which path
 * produced it. Anonymous callers must keep using the REST path — GitHub
 * rejects anonymous GraphQL outright.
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
