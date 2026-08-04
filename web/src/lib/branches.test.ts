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
import { isStaleBranch, mapRefNode } from './branches'
import type { BranchInfo } from './types'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-08-04T00:00:00Z')

function node(overrides: Record<string, unknown> = {}) {
  return {
    name: 'feature/old-thing',
    target: {
      oid: 'abc123',
      committedDate: '2025-01-01T00:00:00Z',
      author: { user: { login: 'someone' }, name: 'Some One' },
    },
    associatedPullRequests: { totalCount: 0 },
    compare: { aheadBy: 40, behindBy: 3 },
    refUpdateRule: null,
    ...overrides,
  }
}

function branch(overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    repo: 'maven-compiler-plugin',
    name: 'feature/old-thing',
    lastCommitDate: new Date(NOW - 200 * DAY).toISOString(),
    lastCommitAuthor: 'someone',
    headSha: 'abc123',
    isProtected: false,
    openPrCount: 0,
    aheadBy: 3,
    behindBy: 40,
    isDefault: false,
    ...overrides,
  }
}

describe('mapRefNode', () => {
  // Ref.compare() treats the ref itself as the BASE and the argument as the
  // HEAD. So compare(headRef: master) returns aheadBy = commits master has that
  // this branch lacks, i.e. how far BEHIND this branch is. The mapping inverts
  // once, here, and nothing downstream re-inverts.
  it('inverts the compare direction so behindBy means behind the default branch', () => {
    const b = mapRefNode('maven-compiler-plugin', 'master', node())
    expect(b.behindBy).toBe(40)
    expect(b.aheadBy).toBe(3)
  })

  it('leaves ahead/behind null when compare is absent', () => {
    const b = mapRefNode('maven-compiler-plugin', 'master', node({ compare: null }))
    expect(b.behindBy).toBeNull()
    expect(b.aheadBy).toBeNull()
  })

  // branchProtectionRule requires repo admin, which we do not have on apache/*;
  // it returns null for every branch. refUpdateRule is the non-admin view.
  it('reads protection from refUpdateRule', () => {
    expect(mapRefNode('r', 'master', node()).isProtected).toBe(false)
    expect(
      mapRefNode('r', 'master', node({ refUpdateRule: { allowsForcePushes: false } })).isProtected,
    ).toBe(true)
  })

  it('marks the default branch', () => {
    expect(mapRefNode('r', 'master', node({ name: 'master' })).isDefault).toBe(true)
    expect(mapRefNode('r', 'master', node({ name: 'other' })).isDefault).toBe(false)
  })

  it('prefers the GitHub login over the raw git author name', () => {
    expect(mapRefNode('r', 'master', node()).lastCommitAuthor).toBe('someone')
  })

  it('falls back to the git author name when there is no linked GitHub user', () => {
    const b = mapRefNode(
      'r',
      'master',
      node({
        target: {
          oid: 'abc',
          committedDate: '2025-01-01T00:00:00Z',
          author: { user: null, name: 'Unlinked Person' },
        },
      }),
    )
    expect(b.lastCommitAuthor).toBe('Unlinked Person')
  })
})

describe('isStaleBranch', () => {
  it('counts a branch older than the threshold as stale', () => {
    expect(isStaleBranch(branch(), 90, NOW)).toBe(true)
  })

  it('does not count a recently committed branch as stale', () => {
    const recent = branch({ lastCommitDate: new Date(NOW - 5 * DAY).toISOString() })
    expect(isStaleBranch(recent, 90, NOW)).toBe(false)
  })

  it('excludes the default branch however old it is', () => {
    expect(isStaleBranch(branch({ isDefault: true }), 90, NOW)).toBe(false)
  })

  it('excludes protected branches', () => {
    expect(isStaleBranch(branch({ isProtected: true }), 90, NOW)).toBe(false)
  })

  it('excludes branches with an open pull request', () => {
    expect(isStaleBranch(branch({ openPrCount: 1 }), 90, NOW)).toBe(false)
  })

  it('excludes branches with no commit date rather than guessing', () => {
    expect(isStaleBranch(branch({ lastCommitDate: null }), 90, NOW)).toBe(false)
  })

  it('treats exactly the threshold age as stale', () => {
    const exactly = branch({ lastCommitDate: new Date(NOW - 90 * DAY).toISOString() })
    expect(isStaleBranch(exactly, 90, NOW)).toBe(true)
  })

  it('honours a changed threshold', () => {
    const b = branch({ lastCommitDate: new Date(NOW - 30 * DAY).toISOString() })
    expect(isStaleBranch(b, 90, NOW)).toBe(false)
    expect(isStaleBranch(b, 14, NOW)).toBe(true)
  })
})
