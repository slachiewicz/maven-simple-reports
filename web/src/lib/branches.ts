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

import { MAVEN_OWNER } from './repos'
import type { BranchInfo, RepoBranchResult } from './types'

export interface FetchBranchesOptions {
  token: string
  skipChecks?: boolean
}

interface GraphQLError {
  message: string
  path?: (string | number)[]
}

interface GraphQLResponse<T> {
  data?: T
  errors?: GraphQLError[]
}

interface CommitAuthor {
  user?: { login: string } | null
  name: string
}

interface Commit {
  oid: string
  committedDate: string
  author: CommitAuthor
}

interface AssociatedPullRequests {
  totalCount: number
}

interface RefUpdateRule {
  requiredApprovingReviewCount: number
  allowsForcePushes: boolean
}

interface BranchRef {
  name: string
  target?: Commit | null
  associatedPullRequests?: AssociatedPullRequests
  compare?: { aheadBy: number; behindBy: number } | null
  refUpdateRule?: RefUpdateRule | null
}

interface Refs {
  totalCount: number
  nodes?: BranchRef[]
}

interface DefaultBranchRef {
  name: string | null
}

interface Repository {
  isArchived: boolean | null
  defaultBranchRef?: DefaultBranchRef
  refs?: Refs
}

interface RateLimit {
  cost: number
  remaining: number
  resetAt: string
}

interface QueryResult {
  repository?: Repository | null
  rateLimit: RateLimit
}

const DEFAULT_CACHE_TTL_MS = 7 * 24 * 60 * 60_000
const STORAGE_PREFIX = 'defaultBranch:'

function getStorageKey(repo: string): string {
  return `${STORAGE_PREFIX}${repo}`
}

export function cacheDefaultBranch(repo: string, branchName: string): void {
  try {
    const key = getStorageKey(repo)
    const value = JSON.stringify({
      name: branchName,
      expiresAt: Date.now() + DEFAULT_CACHE_TTL_MS,
    })
    localStorage.setItem(key, value)
  } catch {
    // Ignore localStorage errors
  }
}

export function getCachedDefaultBranch(repo: string): string | null {
  try {
    const key = getStorageKey(repo)
    const raw = localStorage.getItem(key)
    if (!raw) return null

    const cached: { name: string; expiresAt: number } | null = JSON.parse(raw)
    if (!cached || Date.now() > cached.expiresAt) {
      localStorage.removeItem(key)
      return null
    }

    return cached.name
  } catch {
    return null
  }
}

async function fetchGraphQL<T>(query: string, variables: Record<string, string>, token: string): Promise<T> {
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}${text ? ` - ${text}` : ''}`)
  }

  const result = (await response.json()) as GraphQLResponse<T>
  if (result.errors && result.errors.length > 0) {
    throw new Error(`GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`)
  }
  if (!result.data) {
    throw new Error('GraphQL response missing data')
  }

  return result.data
}

const DEFAULT_BRANCH_QUERY = `
  query($owner:String!, $repo:String!) {
    repository(owner:$owner, name:$repo) {
      defaultBranchRef {
        name
      }
    }
  }
`

async function fetchDefaultBranch(repo: string, token: string): Promise<string | null> {
  const cached = getCachedDefaultBranch(repo)
  if (cached) return cached

  const variables = { owner: MAVEN_OWNER, repo }
  const data = await fetchGraphQL<{ repository?: { defaultBranchRef?: { name: string | null } } | null }>(
    DEFAULT_BRANCH_QUERY,
    variables,
    token,
  )

  const branchName = data.repository?.defaultBranchRef?.name ?? null
  if (branchName) {
    cacheDefaultBranch(repo, branchName)
  }
  return branchName
}

const BRANCHES_QUERY = `
  query($owner:String!, $repo:String!, $defaultBranch:String!) {
    repository(owner:$owner, name:$repo) {
      isArchived
      defaultBranchRef { name }
      refs(refPrefix:"refs/heads/", first:100) {
        totalCount
        nodes {
          name
          target { ... on Commit { oid committedDate author { user { login } name } } }
          associatedPullRequests(states:OPEN, first:1) { totalCount }
          compare(headRef:$defaultBranch) { aheadBy behindBy }
          refUpdateRule { requiredApprovingReviewCount allowsForcePushes }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`

function convertToBranchInfo(repo: string, branch: BranchRef, defaultBranch: string | null): BranchInfo {
  return {
    repo,
    name: branch.name,
    lastCommitDate: branch.target?.committedDate ?? null,
    lastCommitAuthor: branch.target?.author.user?.login ?? null,
    headSha: branch.target?.oid ?? '',
    isProtected: !!branch.refUpdateRule,
    openPrCount: branch.associatedPullRequests?.totalCount ?? 0,
    aheadBy: branch.compare?.behindBy ?? null,
    behindBy: branch.compare?.aheadBy ?? null,
    isDefault: branch.name === defaultBranch,
  }
}

export async function fetchRepoBranches(repo: string, opts: FetchBranchesOptions): Promise<RepoBranchResult> {
  const startTime = Date.now()

  try {
    const defaultBranch = await fetchDefaultBranch(repo, opts.token)
    if (!defaultBranch) {
      return {
        repo,
        branches: [],
        defaultBranch: 'main',
        fetchedAt: startTime,
        totalCount: 0,
        truncated: false,
        degraded: false,
        error: 'Could not determine default branch',
      }
    }

    const variables = { owner: MAVEN_OWNER, repo, defaultBranch }
    const query = opts.skipChecks
      ? BRANCHES_QUERY.replace(/compare\(headRef:\$\w+\) \{ aheadBy behindBy \}/, '')
      : BRANCHES_QUERY

    const data = await fetchGraphQL<QueryResult>(query, variables, opts.token)
    const repository = data.repository

    if (!repository) {
      return {
        repo,
        branches: [],
        defaultBranch,
        fetchedAt: startTime,
        totalCount: 0,
        truncated: false,
        degraded: false,
        error: 'Repository not found',
      }
    }

    const archived = !!repository.isArchived
    const refs = repository.refs
    const allNodes = refs?.nodes ?? []
    const totalCount = refs?.totalCount ?? 0

    if (archived) {
      return {
        repo,
        branches: [],
        defaultBranch,
        fetchedAt: startTime,
        totalCount,
        truncated: false,
        degraded: false,
        archived: true,
      }
    }

    const branches = allNodes
      .map((branch) => convertToBranchInfo(repo, branch, defaultBranch))
      .sort((a, b) => {
        if (a.lastCommitDate && b.lastCommitDate) {
          return a.lastCommitDate.localeCompare(b.lastCommitDate)
        }
        return b.name.localeCompare(a.name)
      })

    const truncated = totalCount > 100

    return {
      repo,
      branches,
      defaultBranch,
      fetchedAt: startTime,
      totalCount,
      truncated,
      degraded: false,
    }
  } catch (error) {
    if (opts.skipChecks) {
      throw error
    }

    try {
      const variables = { owner: MAVEN_OWNER, repo, defaultBranch: 'main' }
      const data = await fetchGraphQL<QueryResult>(
        BRANCHES_QUERY.replace(/compare\(headRef:\$\w+\) \{ aheadBy behindBy \}/, ''),
        variables,
        opts.token,
      )

      const repository = data.repository
      const refs = repository?.refs
      const allNodes = refs?.nodes ?? []
      const totalCount = refs?.totalCount ?? 0

      const branches = allNodes
        .map((branch) => convertToBranchInfo(repo, branch, repository?.defaultBranchRef?.name ?? null))
        .sort((a, b) => {
          if (a.lastCommitDate && b.lastCommitDate) {
            return a.lastCommitDate.localeCompare(b.lastCommitDate)
          }
          return b.name.localeCompare(a.name)
        })

      return {
        repo,
        branches,
        defaultBranch: repository?.defaultBranchRef?.name ?? 'main',
        fetchedAt: startTime,
        totalCount,
        truncated: totalCount > 100,
        degraded: true,
        error: error instanceof Error ? error.message : String(error),
      }
    } catch {
      return {
        repo,
        branches: [],
        defaultBranch: 'main',
        fetchedAt: startTime,
        totalCount: 0,
        truncated: false,
        degraded: true,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }
}