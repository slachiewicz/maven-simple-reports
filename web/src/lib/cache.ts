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

import type { DraftFilter } from './prFilters'
import type { ReviewFilter } from './reviews'

// Prefixes kept only so migrateLegacyCache can reclaim what earlier versions
// wrote: the ETag cache, the archived-repo flags, and the per-PR build-state
// blob all belonged to the REST pull-request path, which no longer exists.
const LEGACY_ETAG_PREFIX = 'gh-cache:v1:'
const LEGACY_ARCHIVED_PREFIX = 'gh-archived:v1:'
const LEGACY_BUILD_STATE_KEY = 'gh-build:v1'
const DEFAULT_BRANCH_TTL_MS = 7 * 24 * 60 * 60_000
const RESULT_PREFIX = 'gh-result:v2:'
const LEGACY_RESULT_PREFIXES = ['gh-result:v1:']
const FILTER_KEY = 'gh-filter:v1'
const TOKEN_KEY = 'gh-token:v1'
const TOKEN_PERSIST_KEY = 'gh-token-persist:v1'
const HIDE_EMPTY_KEY = 'gh-hide-empty:v1'
const OAUTH_KEY = 'gh-oauth:v1'
const AUTHOR_FILTER_KEY = 'gh-author-filter:v1'
const DRAFT_FILTER_KEY = 'gh-draft-filter:v1'
const ASSIGNEE_FILTER_KEY = 'gh-assignee-filter:v1'
const REVIEW_FILTER_KEY = 'gh-review-filter:v1'
const BRANCH_RESULT_PREFIX = 'gh-branches:v1:'
const DEFAULT_BRANCH_PREFIX = 'gh-default-branch:v1:'
const STALE_THRESHOLD_KEY = 'gh-stale-threshold:v1'
const STALE_ONLY_KEY = 'gh-stale-only:v1'

// Storage writes fail open so the in-memory app keeps working, but a silent
// failure is how the archived-repo cache stops sticking and every cycle starts
// paying double. Say so once per key rather than swallowing it.
const warnedQuotaKeys = new Set<string>()

function reportQuotaFailure(what: string, err: unknown): void {
  if (warnedQuotaKeys.has(what)) return
  warnedQuotaKeys.add(what)
  console.warn(
    `[cache] could not persist ${what} (browser storage full or disabled). ` +
      `The app keeps working but will re-fetch more than necessary. ` +
      `Clearing this site's storage will restore it.`,
    err,
  )
}

// Migration: reclaim localStorage written by versions that no longer match
// this app. That is the ETag cache an early version kept in localStorage
// (where it could exhaust the 5 MB quota and silently break persisted
// results), results left behind by earlier RESULT_PREFIX version bumps, and
// the archived-repo flags and build-state blob the removed REST path wrote.
// Idempotent — safe to run every page load.
export function migrateLegacyCache(): number {
  let removed = 0
  try {
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (
        k &&
        (k.startsWith(LEGACY_ETAG_PREFIX) ||
          k.startsWith(LEGACY_ARCHIVED_PREFIX) ||
          k === LEGACY_BUILD_STATE_KEY ||
          LEGACY_RESULT_PREFIXES.some((p) => k.startsWith(p)))
      ) {
        stale.push(k)
      }
    }
    for (const k of stale) localStorage.removeItem(k)
    removed = stale.length
  } catch {
    // ignore
  }
  return removed
}

export function clearAllCache(): number {
  let removed = 0
  try {
    const lsKeys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (
        k &&
        (k.startsWith(RESULT_PREFIX) ||
          k.startsWith(BRANCH_RESULT_PREFIX) ||
          k.startsWith(DEFAULT_BRANCH_PREFIX) ||
          k.startsWith(LEGACY_ARCHIVED_PREFIX) ||
          k === LEGACY_BUILD_STATE_KEY ||
          LEGACY_RESULT_PREFIXES.some((p) => k.startsWith(p)))
      ) {
        lsKeys.push(k)
      }
    }
    for (const k of lsKeys) {
      localStorage.removeItem(k)
      removed++
    }
  } catch {
    // ignore
  }
  return removed
}

export function readFilter(): string {
  try {
    return localStorage.getItem(FILTER_KEY) ?? ''
  } catch {
    return ''
  }
}

export function writeFilter(pattern: string): void {
  try {
    if (pattern) localStorage.setItem(FILTER_KEY, pattern)
    else localStorage.removeItem(FILTER_KEY)
  } catch {
    // ignore
  }
}

export function readHideEmpty(): boolean {
  try {
    return localStorage.getItem(HIDE_EMPTY_KEY) === '1'
  } catch {
    return false
  }
}

export function writeHideEmpty(hide: boolean): void {
  try {
    if (hide) localStorage.setItem(HIDE_EMPTY_KEY, '1')
    else localStorage.removeItem(HIDE_EMPTY_KEY)
  } catch {
    // ignore
  }
}

/**
 * Read the saved PAT. Prefers localStorage (persisted across browser sessions)
 * over sessionStorage (tab-scoped). Returns '' if neither has one.
 */
export function readToken(): string {
  try {
    const persisted = localStorage.getItem(TOKEN_KEY)
    if (persisted) return persisted
    return sessionStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Read the "remember this device" preference. Defaults to false so a first-time
 * user has to actively opt in to persistent storage; the safer choice for the
 * default. If no preference is saved but a token already exists in localStorage
 * (e.g. left over from a previous session), keep the checkbox consistent with
 * where the token actually lives.
 */
export function readTokenPersist(): boolean {
  try {
    const raw = localStorage.getItem(TOKEN_PERSIST_KEY)
    if (raw !== null) return raw === '1'
    return localStorage.getItem(TOKEN_KEY) !== null
  } catch {
    return false
  }
}

/**
 * Save the PAT to the chosen storage and clear the other so we never have two
 * copies in flight. Empty token clears both storages.
 */
export function writeToken(token: string, persist: boolean): void {
  try {
    if (!token) {
      localStorage.removeItem(TOKEN_KEY)
      sessionStorage.removeItem(TOKEN_KEY)
      return
    }
    if (persist) {
      localStorage.setItem(TOKEN_KEY, token)
      sessionStorage.removeItem(TOKEN_KEY)
    } else {
      sessionStorage.setItem(TOKEN_KEY, token)
      localStorage.removeItem(TOKEN_KEY)
    }
  } catch {
    // ignore
  }
}

export function writeTokenPersist(persist: boolean): void {
  try {
    localStorage.setItem(TOKEN_PERSIST_KEY, persist ? '1' : '0')
  } catch {
    // ignore
  }
}

/**
 * Read the OAuth tokens (access + refresh + expirations). The persist flag
 * picks between localStorage (set) and sessionStorage (clear), same as the
 * PAT. We prefer localStorage if both happen to have a copy.
 */
export function readOauth<T>(): T | null {
  try {
    const persisted = localStorage.getItem(OAUTH_KEY)
    if (persisted) return JSON.parse(persisted) as T
    const session = sessionStorage.getItem(OAUTH_KEY)
    if (session) return JSON.parse(session) as T
    return null
  } catch {
    return null
  }
}

export function writeOauth<T>(tokens: T | null, persist: boolean): void {
  try {
    if (!tokens) {
      localStorage.removeItem(OAUTH_KEY)
      sessionStorage.removeItem(OAUTH_KEY)
      return
    }
    const value = JSON.stringify(tokens)
    if (persist) {
      localStorage.setItem(OAUTH_KEY, value)
      sessionStorage.removeItem(OAUTH_KEY)
    } else {
      sessionStorage.setItem(OAUTH_KEY, value)
      localStorage.removeItem(OAUTH_KEY)
    }
  } catch {
    // ignore
  }
}

export function writeResult<T>(repo: string, value: T): void {
  try {
    localStorage.setItem(RESULT_PREFIX + repo, JSON.stringify(value))
  } catch (err) {
    reportQuotaFailure('PR results', err)
  }
}

export function readAuthorFilter(): 'dependabot' | 'humans' | 'all' {
  try {
    const raw = localStorage.getItem(AUTHOR_FILTER_KEY)
    if (raw === 'dependabot' || raw === 'humans' || raw === 'all') return raw
    return 'all'
  } catch {
    return 'all'
  }
}

export function writeAuthorFilter(filter: 'dependabot' | 'humans' | 'all'): void {
  try {
    localStorage.setItem(AUTHOR_FILTER_KEY, filter)
  } catch {
    // ignore
  }
}

export function readDraftFilter(): DraftFilter {
  try {
    const raw = localStorage.getItem(DRAFT_FILTER_KEY)
    if (raw === 'all' || raw === 'ready' || raw === 'draft') return raw
    return 'all'
  } catch {
    return 'all'
  }
}

export function writeDraftFilter(filter: DraftFilter): void {
  try {
    localStorage.setItem(DRAFT_FILTER_KEY, filter)
  } catch (err) {
    reportQuotaFailure('draft filter', err)
  }
}

/**
 * Unlike the author and draft filters, any string is legal here: the value is
 * either one of the sentinels or a GitHub login, and the set of logins isn't
 * known until repos have been fetched. A login that no longer appears simply
 * matches nothing, which the dropdown shows as the stored-but-absent option.
 */
export function readAssigneeFilter(): string {
  try {
    return localStorage.getItem(ASSIGNEE_FILTER_KEY) || 'all'
  } catch {
    return 'all'
  }
}

export function writeAssigneeFilter(filter: string): void {
  try {
    localStorage.setItem(ASSIGNEE_FILTER_KEY, filter)
  } catch (err) {
    reportQuotaFailure('assignee filter', err)
  }
}

const REVIEW_FILTERS: ReviewFilter[] = ['all', 'approved', 'mine', 'unapproved']

export function readReviewFilter(): ReviewFilter {
  try {
    const raw = localStorage.getItem(REVIEW_FILTER_KEY)
    return REVIEW_FILTERS.find((f) => f === raw) ?? 'all'
  } catch {
    return 'all'
  }
}

export function writeReviewFilter(filter: ReviewFilter): void {
  try {
    localStorage.setItem(REVIEW_FILTER_KEY, filter)
  } catch (err) {
    reportQuotaFailure('review filter', err)
  }
}

export function readAllResults<T>(): Record<string, T> {
  const out: Record<string, T> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(RESULT_PREFIX)) continue
      const raw = localStorage.getItem(k)
      if (!raw) continue
      try {
        out[k.slice(RESULT_PREFIX.length)] = JSON.parse(raw) as T
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    // ignore
  }
  return out
}

interface DefaultBranchEntry {
  name: string
  checkedAt: number
}

// The default branch name rarely changes, so cache it for a week rather than
// re-querying it on every fetch.
export function readDefaultBranch(repo: string): string | null {
  try {
    const raw = localStorage.getItem(DEFAULT_BRANCH_PREFIX + repo)
    if (!raw) return null
    const entry = JSON.parse(raw) as DefaultBranchEntry
    if (Date.now() - entry.checkedAt > DEFAULT_BRANCH_TTL_MS) return null
    return entry.name
  } catch {
    return null
  }
}

export function writeDefaultBranch(repo: string, name: string): void {
  try {
    const entry: DefaultBranchEntry = { name, checkedAt: Date.now() }
    localStorage.setItem(DEFAULT_BRANCH_PREFIX + repo, JSON.stringify(entry))
  } catch (err) {
    reportQuotaFailure('default branch name', err)
  }
}

export function writeBranchResult<T>(repo: string, value: T): void {
  try {
    localStorage.setItem(BRANCH_RESULT_PREFIX + repo, JSON.stringify(value))
  } catch (err) {
    reportQuotaFailure('branch results', err)
  }
}

export function readAllBranchResults<T>(): Record<string, T> {
  const out: Record<string, T> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(BRANCH_RESULT_PREFIX)) continue
      const raw = localStorage.getItem(k)
      if (!raw) continue
      try {
        out[k.slice(BRANCH_RESULT_PREFIX.length)] = JSON.parse(raw) as T
      } catch {
        // skip malformed entries
      }
    }
  } catch {
    // ignore
  }
  return out
}

export function readStaleThreshold(): number {
  try {
    const raw = Number(localStorage.getItem(STALE_THRESHOLD_KEY))
    if (Number.isFinite(raw) && raw > 0) return raw
    return 90
  } catch {
    return 90
  }
}

export function writeStaleThreshold(days: number): void {
  try {
    localStorage.setItem(STALE_THRESHOLD_KEY, String(days))
  } catch {
    // ignore
  }
}

export function readStaleOnly(): boolean {
  try {
    // Default true — the view exists to surface stale branches.
    return localStorage.getItem(STALE_ONLY_KEY) !== '0'
  } catch {
    return true
  }
}

export function writeStaleOnly(value: boolean): void {
  try {
    localStorage.setItem(STALE_ONLY_KEY, value ? '1' : '0')
  } catch {
    // ignore
  }
}
