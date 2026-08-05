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
import { readDefaultBranch, writeDefaultBranch, writeBranchResult } from './cache'
import type { BranchInfo, RepoBranchResult } from './types'

const REF_PAGE_SIZE = 100

export interface RefNode {
  name: string
  target: {
    oid: string
    committedDate: string
    author: { user: { login: string } | null; name: string | null } | null
  } | null
  associatedPullRequests: { totalCount: number }
  compare: { aheadBy: number; behindBy: number } | null
  refUpdateRule: unknown | null
}

const DEFAULT_BRANCH_QUERY = `
query($owner:String!, $repo:String!) {
  repository(owner:$owner, name:$repo) {
    isArchived
    defaultBranchRef { name }
  }
}`

function branchesQuery(withCompare: boolean): string {
  return `
query($owner:String!, $repo:String!, $defaultBranch:String!) {
  repository(owner:$owner, name:$repo) {
    isArchived
    refs(refPrefix:"refs/heads/", first:${REF_PAGE_SIZE}) {
      totalCount
      nodes {
        name
        target { ... on Commit { oid committedDate author { user { login } name } } }
        associatedPullRequests(states:OPEN, first:1) { totalCount }
        ${withCompare ? 'compare(headRef:$defaultBranch) { aheadBy behindBy }' : ''}
        refUpdateRule { allowsForcePushes }
      }
    }
  }
  rateLimit { cost remaining resetAt }
}`
}

/**
 * Ref.compare() treats THIS ref as the base and the argument as the head, so
 * compare(headRef: <default>) returns:
 *   aheadBy  = commits the default branch has that this branch lacks -> BEHIND
 *   behindBy = commits this branch has that the default branch lacks -> AHEAD
 * The names read inverted. Invert exactly once, here.
 */
export function mapRefNode(repo: string, defaultBranch: string, node: RefNode): BranchInfo {
  return {
    repo,
    name: node.name,
    lastCommitDate: node.target?.committedDate ?? null,
    lastCommitAuthor: node.target?.author?.user?.login ?? node.target?.author?.name ?? null,
    headSha: node.target?.oid ?? '',
    // branchProtectionRule needs repo admin and would be null for everything on
    // apache/*; refUpdateRule is the non-admin-visible equivalent.
    isProtected: node.refUpdateRule != null,
    openPrCount: node.associatedPullRequests.totalCount,
    aheadBy: node.compare ? node.compare.behindBy : null,
    behindBy: node.compare ? node.compare.aheadBy : null,
    isDefault: node.name === defaultBranch,
  }
}

export function isStaleBranch(b: BranchInfo, thresholdDays: number, now = Date.now()): boolean {
  if (b.isDefault) return false
  if (b.isProtected) return false
  if (b.openPrCount > 0) return false
  if (!b.lastCommitDate) return false
  const age = now - Date.parse(b.lastCommitDate)
  return age >= thresholdDays * 24 * 60 * 60 * 1000
}

interface BranchesResponse {
  repository: {
    isArchived: boolean
    refs: { totalCount: number; nodes: RefNode[] }
  } | null
}

interface DefaultBranchResponse {
  repository: { isArchived: boolean; defaultBranchRef: { name: string } | null } | null
}

export async function fetchRepoBranches(
  repo: string,
  token: string | undefined,
): Promise<RepoBranchResult> {
  const empty = (extra: Partial<RepoBranchResult>): RepoBranchResult => ({
    repo,
    branches: [],
    defaultBranch: '',
    fetchedAt: Date.now(),
    totalCount: 0,
    truncated: false,
    degraded: false,
    ...extra,
  })

  if (!token) return empty({ error: 'A GitHub token is required for the branches view' })

  try {
    // The default branch name is a query variable, so it must be resolved
    // first. Cached for 7 days, making this a one-off per repo.
    let defaultBranch = readDefaultBranch(repo)
    if (!defaultBranch) {
      const meta = await ghGraphQL<DefaultBranchResponse>(
        DEFAULT_BRANCH_QUERY,
        { owner: MAVEN_OWNER, repo },
        token,
      )
      if (!meta.repository) return empty({ error: 'Repository not found' })
      if (meta.repository.isArchived) {
        const result = empty({ archived: true })
        writeBranchResult(repo, result)
        return result
      }
      defaultBranch = meta.repository.defaultBranchRef?.name ?? 'master'
      writeDefaultBranch(repo, defaultBranch)
    }

    let degraded = false
    let data: BranchesResponse
    try {
      data = await ghGraphQL<BranchesResponse>(
        branchesQuery(true),
        { owner: MAVEN_OWNER, repo, defaultBranch },
        token,
      )
    } catch (err) {
      if (err instanceof GhRateLimitError) throw err
      // compare() is evaluated per ref and can push a 100-ref query past
      // GitHub's timeout. Retry without it and show age plus PR status only.
      degraded = true
      data = await ghGraphQL<BranchesResponse>(
        branchesQuery(false),
        { owner: MAVEN_OWNER, repo, defaultBranch },
        token,
      )
    }

    if (!data.repository) return empty({ defaultBranch, error: 'Repository not found' })
    if (data.repository.isArchived) {
      const result = empty({ defaultBranch, archived: true })
      writeBranchResult(repo, result)
      return result
    }

    const nodes = data.repository.refs.nodes
    const result: RepoBranchResult = {
      repo,
      branches: nodes.map((n) => mapRefNode(repo, defaultBranch, n)),
      defaultBranch,
      fetchedAt: Date.now(),
      totalCount: data.repository.refs.totalCount,
      truncated: data.repository.refs.totalCount > nodes.length,
      degraded,
    }
    writeBranchResult(repo, result)
    return result
  } catch (err) {
    if (err instanceof GhRateLimitError) throw err
    return empty({ error: err instanceof Error ? err.message : String(err) })
  }
}
