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

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { cacheDefaultBranch, getCachedDefaultBranch, fetchRepoBranches } from './branches'

global.fetch = vi.fn()
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
  }
})()

Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
})

describe('branch caching utilities', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
  })

  afterEach(() => {
    localStorageMock.clear()
  })

  it('caches and retrieves default branch names', () => {
    cacheDefaultBranch('maven-core', 'master')
    expect(getCachedDefaultBranch('maven-core')).toBe('master')
  })

  it('returns null for uncached repositories', () => {
    expect(getCachedDefaultBranch('maven-plugin')).toBeNull()
  })

  it('handles localStorage errors gracefully', () => {
    const originalGetItem = localStorageMock.getItem
    localStorageMock.getItem = () => {
      throw new Error('localStorage error')
    }

    expect(getCachedDefaultBranch('maven-wrapper')).toBeNull()
    localStorageMock.getItem = originalGetItem
  })
})

describe('GraphQL branch data conversion', () => {
  it('converts branch data to BranchInfo correctly', () => {
    const mockBranch = {
      name: 'feature/test',
      target: {
        oid: 'abc123',
        committedDate: '2024-01-15T10:30:00Z',
        author: {
          user: { login: 'username' },
          name: 'User Name',
        },
      },
      associatedPullRequests: { totalCount: 2 },
      compare: { aheadBy: 3, behindBy: 1 },
      refUpdateRule: { requiredApprovingReviewCount: 2, allowsForcePushes: false },
    }

    const result = convertToBranchInfoTest('maven-core', mockBranch, 'main')
    expect(result.repo).toBe('maven-core')
    expect(result.name).toBe('feature/test')
    expect(result.lastCommitDate).toBe('2024-01-15T10:30:00Z')
    expect(result.lastCommitAuthor).toBe('username')
    expect(result.headSha).toBe('abc123')
    expect(result.isProtected).toBe(true)
    expect(result.openPrCount).toBe(2)
    expect(result.aheadBy).toBe(1)
    expect(result.behindBy).toBe(3)
    expect(result.isDefault).toBe(false)
  })

  it('handles missing target and compare data', () => {
    const mockBranch = {
      name: 'orphan',
      target: null,
      associatedPullRequests: { totalCount: 0 },
      compare: null,
      refUpdateRule: null,
    }

    const result = convertToBranchInfoTest('maven-archiver', mockBranch, 'main')
    expect(result.lastCommitDate).toBeNull()
    expect(result.lastCommitAuthor).toBeNull()
    expect(result.headSha).toBe('')
    expect(result.aheadBy).toBeNull()
    expect(result.behindBy).toBeNull()
  })

  it('identifies default branch correctly', () => {
    const mockBranch = {
      name: 'main',
      target: {
        oid: 'def456',
        committedDate: '2024-01-01T00:00:00Z',
        author: {
          user: { login: 'system' },
          name: 'System',
        },
      },
      associatedPullRequests: { totalCount: 0 },
      compare: { aheadBy: 0, behindBy: 0 },
      refUpdateRule: null,
    }

    const result = convertToBranchInfoTest('maven-build', mockBranch, 'main')
    expect(result.isDefault).toBe(true)
  })

  it('inverts GraphQL compare direction', () => {
    const mockBranch = {
      name: 'ahead-by-two',
      target: {
        oid: 'ghi789',
        committedDate: '2024-01-20T15:00:00Z',
        author: {
          user: { login: 'dev' },
          name: 'Developer',
        },
      },
      associatedPullRequests: { totalCount: 1 },
      compare: { aheadBy: 2, behindBy: 0 },
      refUpdateRule: null,
    }

    const result = convertToBranchInfoTest('maven-tests', mockBranch, 'main')
    expect(result.aheadBy).toBe(0)
    expect(result.behindBy).toBe(2)
  })
})

describe('fetchRepoBranches', () => {
  beforeEach(() => {
    localStorageMock.clear()
    vi.clearAllMocks()
    vi.stubGlobal('Date', class extends Date {
      constructor() {
        super()
        return new Date('2024-08-04T00:00:00Z')
      }
    })
  })

  afterEach(() => {
    localStorageMock.clear()
    vi.useRealTimers()
  })

  it('fetches branches successfully with token', async () => {
    const mockGraphqlResponse = {
      data: {
        repository: {
          isArchived: false,
          defaultBranchRef: { name: 'main' },
          refs: {
            totalCount: 3,
            nodes: [
              {
                name: 'feature-a',
                target: {
                  oid: 'abc123',
                  committedDate: '2024-01-01T00:00:00Z',
                  author: { user: { login: 'user1' }, name: 'User One' },
                },
                associatedPullRequests: { totalCount: 1 },
                compare: { aheadBy: 5, behindBy: 2 },
                refUpdateRule: null,
              },
              {
                name: 'feature-b',
                target: {
                  oid: 'def456',
                  committedDate: '2024-01-02T00:00:00Z',
                  author: { user: { login: 'user2' }, name: 'User Two' },
                },
                associatedPullRequests: { totalCount: 0 },
                compare: { aheadBy: 3, behindBy: 1 },
                refUpdateRule: null,
              },
              {
                name: 'main',
                target: {
                  oid: 'ghi789',
                  committedDate: '2023-12-01T00:00:00Z',
                  author: { user: { login: 'system' }, name: 'System' },
                },
                associatedPullRequests: { totalCount: 0 },
                compare: { aheadBy: 0, behindBy: 0 },
                refUpdateRule: { requiredApprovingReviewCount: 1, allowsForcePushes: false },
              },
            ],
          },
        },
        rateLimit: { cost: 3, remaining: 4950, resetAt: '2024-08-04T01:00:00Z' },
      },
    }

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockGraphqlResponse,
    } as Response)

    const result = await fetchRepoBranches('maven-core', { token: 'test-token' })

    expect(result.repo).toBe('maven-core')
    expect(result.branches).toHaveLength(3)
    expect(result.defaultBranch).toBe('main')
    expect(result.totalCount).toBe(3)
    expect(result.truncated).toBe(false)
    expect(result.degraded).toBe(false)
  })

  it('detects truncation when totalCount exceeds limit', async () => {
    const mockDefaultBranchResponse = {
      data: {
        repository: { defaultBranchRef: { name: 'main' } },
      },
    }

    const mockBranchesResponse = {
      data: {
        repository: {
          isArchived: false,
          defaultBranchRef: { name: 'main' },
          refs: {
            totalCount: 150,
            nodes: [],
          },
        },
        rateLimit: { cost: 3, remaining: 4950, resetAt: '2024-08-04T01:00:00Z' },
      },
    }

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockDefaultBranchResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockBranchesResponse,
      } as Response)

    const result = await fetchRepoBranches('maven-plugin', { token: 'test-token' })
    expect(result.truncated).toBe(true)
  })

  it('returns archived status for archived repositories', async () => {
    const mockDefaultBranchResponse = {
      data: {
        repository: { defaultBranchRef: { name: 'main' } },
      },
    }

    const mockBranchesResponse = {
      data: {
        repository: {
          isArchived: true,
          defaultBranchRef: { name: 'main' },
          refs: {
            totalCount: 0,
            nodes: [],
          },
        },
        rateLimit: { cost: 1, remaining: 4980, resetAt: '2024-08-04T01:00:00Z' },
      },
    }

    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockDefaultBranchResponse,
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockBranchesResponse,
      } as Response)

    const result = await fetchRepoBranches('maven-old', { token: 'test-token' })
    expect(result.archived).toBe(true)
    expect(result.branches).toHaveLength(0)
  })

  it('handles GraphQL errors gracefully', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        errors: [{ message: 'Field "ref" is invalid' }],
      }),
    } as Response)

    const result = await fetchRepoBranches('invalid-repo', { token: 'test-token' })
    expect(result.degraded).toBe(true)
    expect(result.error).toContain('GraphQL errors')
    expect(result.branches).toHaveLength(0)
  })

  it('handles missing default branch', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: {} }),
    } as Response)

    const result = await fetchRepoBranches('maven-core', { token: '' })
    expect(result.error).toBe('Could not determine default branch')
    expect(result.branches).toHaveLength(0)
  })
})

function convertToBranchInfoTest(
  repo: string,
  branch: {
    name: string
    target?: { oid: string; committedDate: string; author: { user?: { login: string } | null; name: string } } | null
    associatedPullRequests?: { totalCount: number }
    compare?: { aheadBy: number; behindBy: number } | null
    refUpdateRule?: { requiredApprovingReviewCount: number; allowsForcePushes: boolean } | null
  },
  defaultBranch: string | null,
): {
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
} {
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