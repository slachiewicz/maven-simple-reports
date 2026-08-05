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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateLegacyCache, readBuildStates, writeBuildStates } from './cache'

// The suite runs under environment: 'node' (see vitest.config.ts), so there is
// no localStorage global. Provide a minimal in-memory stub sufficient for the
// key/getItem/setItem/removeItem/length surface this module actually uses.
class FakeStorage {
  private store = new Map<string, string>()

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }

  get length(): number {
    return this.store.size
  }
}

let fakeLocalStorage: FakeStorage

beforeEach(() => {
  fakeLocalStorage = new FakeStorage()
  vi.stubGlobal('localStorage', fakeLocalStorage)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const DAY_MS = 24 * 60 * 60_000

describe('readBuildStates', () => {
  it('keeps entries within the 7-day TTL and drops older ones', () => {
    const now = Date.now()
    fakeLocalStorage.setItem(
      'gh-build:v1',
      JSON.stringify({
        fresh: { state: 'SUCCESS', fetchedAt: now - 1 * DAY_MS },
        stale: { state: 'FAILURE', fetchedAt: now - 8 * DAY_MS },
      }),
    )

    const result = readBuildStates<{ state: string; fetchedAt: number }>()

    expect(Object.keys(result)).toEqual(['fresh'])
    expect(result.fresh.state).toBe('SUCCESS')
  })

  it('returns {} on malformed JSON rather than throwing', () => {
    fakeLocalStorage.setItem('gh-build:v1', '{not valid json')

    expect(() => readBuildStates()).not.toThrow()
    expect(readBuildStates()).toEqual({})
  })

  it('returns {} when nothing is stored yet', () => {
    expect(readBuildStates()).toEqual({})
  })
})

describe('writeBuildStates', () => {
  it('prunes stale entries so the blob cannot grow without bound', () => {
    const now = Date.now()
    writeBuildStates({
      fresh: { state: 'SUCCESS', fetchedAt: now },
      stale: { state: 'FAILURE', fetchedAt: now - 8 * DAY_MS },
    })

    const raw = fakeLocalStorage.getItem('gh-build:v1')
    expect(raw).not.toBeNull()
    const stored = JSON.parse(raw!) as Record<string, unknown>
    expect(Object.keys(stored)).toEqual(['fresh'])
  })

  it('round-trips through readBuildStates', () => {
    const now = Date.now()
    writeBuildStates({ 'repo#1#sha': { state: 'PENDING', fetchedAt: now } })

    expect(readBuildStates()).toEqual({ 'repo#1#sha': { state: 'PENDING', fetchedAt: now } })
  })
})

describe('migrateLegacyCache', () => {
  it('removes both gh-cache: and gh-result:v1: keys and leaves gh-result:v2: untouched', () => {
    fakeLocalStorage.setItem('gh-cache:v1:some-key', '{}')
    fakeLocalStorage.setItem('gh-result:v1:some-repo', '{}')
    fakeLocalStorage.setItem('gh-result:v2:some-repo', '{"kept":true}')

    const removed = migrateLegacyCache()

    expect(removed).toBe(2)
    expect(fakeLocalStorage.getItem('gh-cache:v1:some-key')).toBeNull()
    expect(fakeLocalStorage.getItem('gh-result:v1:some-repo')).toBeNull()
    expect(fakeLocalStorage.getItem('gh-result:v2:some-repo')).toBe('{"kept":true}')
  })

  it('is idempotent — a second run removes nothing further', () => {
    fakeLocalStorage.setItem('gh-cache:v1:some-key', '{}')

    expect(migrateLegacyCache()).toBe(1)
    expect(migrateLegacyCache()).toBe(0)
  })
})
