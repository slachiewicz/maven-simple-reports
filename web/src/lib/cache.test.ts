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
import { migrateLegacyCache, readDraftFilter } from './cache'

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

describe('readDraftFilter', () => {
  it('returns "all" when nothing is stored yet', () => {
    expect(readDraftFilter()).toBe('all')
  })

  it('returns "all" for a garbage stored value', () => {
    fakeLocalStorage.setItem('gh-draft-filter:v1', 'bogus')

    expect(readDraftFilter()).toBe('all')
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

  // The REST pull-request path is gone; its two localStorage families must be
  // reclaimed rather than left to occupy the ~5 MB budget forever.
  it('reclaims the archived-repo and build-state keys the REST path wrote', () => {
    fakeLocalStorage.setItem('gh-archived:v1:maven-compiler-plugin', '{}')
    fakeLocalStorage.setItem('gh-build:v1', '{}')
    fakeLocalStorage.setItem('gh-branches:v1:maven-compiler-plugin', '{"kept":true}')

    expect(migrateLegacyCache()).toBe(2)
    expect(fakeLocalStorage.getItem('gh-archived:v1:maven-compiler-plugin')).toBeNull()
    expect(fakeLocalStorage.getItem('gh-build:v1')).toBeNull()
    expect(fakeLocalStorage.getItem('gh-branches:v1:maven-compiler-plugin')).toBe('{"kept":true}')
  })

  it('is idempotent — a second run removes nothing further', () => {
    fakeLocalStorage.setItem('gh-cache:v1:some-key', '{}')

    expect(migrateLegacyCache()).toBe(1)
    expect(migrateLegacyCache()).toBe(0)
  })
})
