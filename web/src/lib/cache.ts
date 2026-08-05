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

const PREFIX = 'gh-cache:v1:'
const RESULT_PREFIX = 'gh-result:v2:'
const LEGACY_RESULT_PREFIXES = ['gh-result:v1:']
const ARCHIVED_PREFIX = 'gh-archived:v1:'
const FILTER_KEY = 'gh-filter:v1'
const TOKEN_KEY = 'gh-token:v1'
const TOKEN_PERSIST_KEY = 'gh-token-persist:v1'
const HIDE_EMPTY_KEY = 'gh-hide-empty:v1'
const OAUTH_KEY = 'gh-oauth:v1'
const AUTHOR_FILTER_KEY = 'gh-author-filter:v1'
const DRAFT_FILTER_KEY = 'gh-draft-filter:v1'
const BRANCH_RESULT_PREFIX = 'gh-branches:v1:'
const DEFAULT_BRANCH_PREFIX = 'gh-default-branch:v1:'
const STALE_THRESHOLD_KEY = 'gh-stale-threshold:v1'
const STALE_ONLY_KEY = 'gh-stale-only:v1'
const BUILD_STATE_KEY = 'gh-build:v1'

const ARCHIVED_TTL_MS = 7 * 24 * 60 * 60_000
const BUILD_STATE_TTL_MS = 7 * 24 * 60 * 60_000

interface ArchivedEntry {
  archived: boolean
  checkedAt: number
}

interface StoredBuildState {
  state: string
  fetchedAt: number
}

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

interface Entry<T> {
  etag: string | null
  body: T
  fetchedAt: number
}

// ETag-cached response bodies can be large (full check-runs responses etc.).
// Keep them in sessionStorage so they don't compete with persisted results
// for the ~5 MB localStorage budget. The cache survives reloads of the same
// tab; on tab close it's lost, but the next session simply fetches fresh
// bodies (no ETag → full response, then re-populate the session cache).
export function readCache<T>(key: string): Entry<T> | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key)
    if (!raw) return null
    return JSON.parse(raw) as Entry<T>
  } catch {
    return null
  }
}

export function writeCache<T>(key: string, entry: Entry<T>): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(entry))
  } catch (err) {
    reportQuotaFailure('ETag cache', err)
  }
}

export function deleteCache(key: string): void {
  try {
    sessionStorage.removeItem(PREFIX + key)
  } catch {
    // ignore
  }
}

// Migration: earlier versions stored the ETag cache in localStorage, which
// could exhaust the 5 MB quota and silently break persisted results. Drop
// any leftover gh-cache entries, plus results left behind by earlier
// RESULT_PREFIX version bumps (LEGACY_RESULT_PREFIXES), from localStorage so
// the budget is reclaimed. Idempotent — safe to run every page load.
export function migrateLegacyCache(): number {
  let removed = 0
  try {
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k && (k.startsWith(PREFIX) || LEGACY_RESULT_PREFIXES.some((p) => k.startsWith(p)))) {
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
          k.startsWith(ARCHIVED_PREFIX) ||
          k.startsWith(BRANCH_RESULT_PREFIX) ||
          k.startsWith(DEFAULT_BRANCH_PREFIX) ||
          k === BUILD_STATE_KEY ||
          LEGACY_RESULT_PREFIXES.some((p) => k.startsWith(p)))
      ) {
        lsKeys.push(k)
      }
    }
    for (const k of lsKeys) {
      localStorage.removeItem(k)
      removed++
    }
    const ssKeys: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(PREFIX)) ssKeys.push(k)
    }
    for (const k of ssKeys) {
      sessionStorage.removeItem(k)
      removed++
    }
  } catch {
    // ignore
  }
  return removed
}

export function readArchived(repo: string): ArchivedEntry | null {
  try {
    const raw = localStorage.getItem(ARCHIVED_PREFIX + repo)
    if (!raw) return null
    const entry = JSON.parse(raw) as ArchivedEntry
    if (Date.now() - entry.checkedAt > ARCHIVED_TTL_MS) return null
    return entry
  } catch {
    return null
  }
}

export function writeArchived(repo: string, archived: boolean): void {
  try {
    const entry: ArchivedEntry = { archived, checkedAt: Date.now() }
    localStorage.setItem(ARCHIVED_PREFIX + repo, JSON.stringify(entry))
  } catch (err) {
    reportQuotaFailure('archived-repo status', err)
  }
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

// The default branch name rarely changes, so cache it for the same 7-day TTL
// used for archived-repo status rather than re-querying it on every fetch.
export function readDefaultBranch(repo: string): string | null {
  try {
    const raw = localStorage.getItem(DEFAULT_BRANCH_PREFIX + repo)
    if (!raw) return null
    const entry = JSON.parse(raw) as DefaultBranchEntry
    if (Date.now() - entry.checkedAt > ARCHIVED_TTL_MS) return null
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

// Build results are keyed by repo#number#headSha (see prBuildKey in pulls.ts),
// so a stored entry is only ever valid for the commit it was fetched against —
// a new push naturally produces a new key and the old one just ages out via
// the TTL. Stored as one JSON blob rather than one localStorage key per PR:
// at ~536 open PRs, per-PR keys would be slow to enumerate and wasteful.
export function readBuildStates<T>(): Record<string, T> {
  try {
    const raw = localStorage.getItem(BUILD_STATE_KEY)
    if (!raw) return {}
    const all = JSON.parse(raw) as Record<string, StoredBuildState>
    const cutoff = Date.now() - BUILD_STATE_TTL_MS
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(all)) {
      if (v && typeof v.fetchedAt === 'number' && v.fetchedAt >= cutoff) {
        out[k] = v as unknown as T
      }
    }
    return out
  } catch {
    return {}
  }
}

export function writeBuildStates<T extends { fetchedAt: number }>(
  states: Record<string, T>,
): void {
  try {
    // Prune on write: keys are head-SHA scoped, so superseded entries would
    // otherwise accumulate forever as PRs get new pushes.
    const cutoff = Date.now() - BUILD_STATE_TTL_MS
    const kept: Record<string, T> = {}
    for (const [k, v] of Object.entries(states)) {
      if (v.fetchedAt >= cutoff) kept[k] = v
    }
    localStorage.setItem(BUILD_STATE_KEY, JSON.stringify(kept))
  } catch (err) {
    reportQuotaFailure('build states', err)
  }
}
