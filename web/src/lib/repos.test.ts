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

import {
  ALL_REPOS,
  MAVEN_OWNER,
  MAVEN_REPOS,
  MOJOHAUS_OWNER,
  MOJOHAUS_REPOS,
  PLEXUS_OWNER,
  PLEXUS_REPOS,
  ownerOf,
} from './repos'

describe('repository lists', () => {
  // Repo names are the cache key and the result identity, so a name shared by
  // two organisations would make one shadow the other. Both orgs ship a
  // `.github` profile repo; that is why neither is listed.
  it('has no name shared between organisations', () => {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const [owner, repos] of [
      [MAVEN_OWNER, MAVEN_REPOS],
      [PLEXUS_OWNER, PLEXUS_REPOS],
      [MOJOHAUS_OWNER, MOJOHAUS_REPOS],
    ] as const) {
      for (const repo of repos) {
        const previous = seen.get(repo)
        if (previous) duplicates.push(`${repo}: ${previous} and ${owner}`)
        else seen.set(repo, owner)
      }
    }
    expect(duplicates).toEqual([])
  })

  it('covers every list in ALL_REPOS', () => {
    expect(ALL_REPOS.length).toBe(MAVEN_REPOS.length + PLEXUS_REPOS.length + MOJOHAUS_REPOS.length)
    expect(new Set(ALL_REPOS).size).toBe(ALL_REPOS.length)
  })
})

describe('ownerOf', () => {
  it('resolves each list to its organisation', () => {
    expect(ownerOf('maven-compiler-plugin')).toBe('apache')
    expect(ownerOf('plexus-utils')).toBe('codehaus-plexus')
    expect(ownerOf('versions')).toBe('mojohaus')
  })

  it('falls back to apache for an unknown repository', () => {
    expect(ownerOf('not-a-listed-repo')).toBe(MAVEN_OWNER)
  })
})
