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

import { useState, useMemo } from 'react'
import type { BranchInfo, RepoBranchResult } from '../lib/types'
import { MAVEN_OWNER } from '../lib/repos'

const STALE_THRESHOLD_MS = 60 * 60_000

function formatBranchDate(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  const ageMs = Date.now() - d.getTime()
  const days = Math.floor(ageMs / (24 * 60 * 60_000))
  const hours = Math.floor(ageMs / (60 * 60_000))
  const minutes = Math.floor(ageMs / 60_000)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return 'now'
}

function formatFetchedAt(ms: number): string {
  const d = new Date(ms)
  const ageMs = Date.now() - ms
  if (ageMs < STALE_THRESHOLD_MS) {
    return d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    })
  }
  return d.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  })
}

type BranchSort = 'name' | 'age' | 'ahead' | 'behind'

interface Props {
  allRepos: readonly string[]
  results: Record<string, RepoBranchResult>
  inFlight: string | null
}

export function BranchTable({ allRepos, results, inFlight }: Props) {
  const [sort, setSort] = useState<BranchSort>('name')
  const [includeDefault, setIncludeDefault] = useState<boolean>(false)
  const [protectedOnly, setProtectedOnly] = useState<boolean>(false)
  const [search, setSearch] = useState<string>('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const sorted = [...allRepos].sort((a, b) => a.localeCompare(b))

  const isCollapsed = (repo: string): boolean => {
    if (repo in collapsed) return collapsed[repo]
    const result = results[repo]
    return !result || result.branches.length === 0
  }

  const toggle = (repo: string) => {
    setCollapsed((c) => ({ ...c, [repo]: !isCollapsed(repo) }))
  }

  const setAll = (value: boolean) => {
    const next: Record<string, boolean> = {}
    for (const r of sorted) next[r] = value
    setCollapsed(next)
  }

  const toggleSort = (next: BranchSort) => {
    setSort(next)
  }

  const sortedBranches = useMemo(() => {
    return (branches: BranchInfo[]): BranchInfo[] => {
      const filtered = branches.filter(
        (b) =>
          (includeDefault || !b.isDefault) &&
          (!protectedOnly || b.isProtected) &&
          (search.length === 0 || b.name.toLowerCase().includes(search.toLowerCase()))
      )

      switch (sort) {
        case 'name':
          return [...filtered].sort((a, b) => a.name.localeCompare(b.name))
        case 'age':
          return [...filtered].sort((a, b) => {
            if (!a.lastCommitDate) return 1
            if (!b.lastCommitDate) return -1
            return b.lastCommitDate.localeCompare(a.lastCommitDate)
          })
        case 'ahead':
          return [...filtered].sort(
            (a, b) =>
              (b.aheadBy || 0) -
              (a.aheadBy || 0)
          )
        case 'behind':
          return [...filtered].sort(
            (a, b) =>
              (b.behindBy || 0) -
              (a.behindBy || 0)
          )
        default:
          return filtered
      }
    }
  }, [sort, includeDefault, protectedOnly, search])

  return (
    <div className="branch-table-wrap">
      <div className="branch-table-controls">
        <label className="include-default">
          <input
            type="checkbox"
            checked={includeDefault}
            onChange={(e) => setIncludeDefault(e.target.checked)}
          />
          Include default branch
        </label>
        <label className="protected-only">
          <input
            type="checkbox"
            checked={protectedOnly}
            onChange={(e) => setProtectedOnly(e.target.checked)}
          />
          Protected only
        </label>
        <input
          type="search"
          placeholder="Search branches..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="branch-search"
        />
        <span className="branch-table-controls-spacer" />
        <div className="branch-sort-controls">
          <button
            type="button"
            className={sort === 'name' ? 'active' : ''}
            onClick={() => toggleSort('name')}
          >
            Sort by name
          </button>
          <button
            type="button"
            className={sort === 'age' ? 'active' : ''}
            onClick={() => toggleSort('age')}
          >
            Sort by age
          </button>
          <button
            type="button"
            className={sort === 'ahead' ? 'active' : ''}
            onClick={() => toggleSort('ahead')}
          >
            Sort by ahead
          </button>
          <button
            type="button"
            className={sort === 'behind' ? 'active' : ''}
            onClick={() => toggleSort('behind')}
          >
            Sort by behind
          </button>
        </div>
        <span className="branch-table-controls-spacer" />
        <button type="button" onClick={() => setAll(false)}>
          Expand all
        </button>
        <button type="button" onClick={() => setAll(true)}>
          Collapse all
        </button>
      </div>
      <table className="branch-table">
        <thead>
          <tr>
            <th>Branch</th>
            <th>Last commit</th>
            <th>Author</th>
            <th>Ahead/behind</th>
            <th>PRs</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((repo) => (
            <RepoRows
              key={repo}
              repo={repo}
              result={results[repo]}
              isInFlight={inFlight === repo}
              collapsed={isCollapsed(repo)}
              onToggle={() => toggle(repo)}
              sortedBranches={sortedBranches}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface RepoRowsProps {
  repo: string
  result: RepoBranchResult | undefined
  isInFlight: boolean
  collapsed: boolean
  onToggle: () => void
  sortedBranches: (branches: BranchInfo[]) => BranchInfo[]
}

function RepoRows({ repo, result, isInFlight, collapsed, onToggle, sortedBranches }: RepoRowsProps) {
  const repoUrl = `https://github.com/${MAVEN_OWNER}/${repo}/branches`
  const branches = result ? sortedBranches(result.branches) : []
  const totalCount = result?.totalCount ?? 0
  const truncated = result?.truncated ?? false
  const archived = result?.archived ?? false
  const empty = branches.length === 0 && totalCount === 0
  const className = `repo-header${empty ? ' repo-header-empty' : ''}${
    isInFlight ? ' repo-header-active' : ''
  }${archived ? ' repo-header-archived' : ''}`
  const canToggle = !empty

  return (
    <>
      <tr className={className}>
        <td colSpan={5}>
          <button
            type="button"
            className="repo-toggle"
            onClick={onToggle}
            disabled={!canToggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${repo}` : `Collapse ${repo}`}
            title={canToggle ? (collapsed ? 'Expand' : 'Collapse') : 'Nothing to expand'}
          >
            {collapsed ? '▶' : '▼'}
          </button>
          <a href={repoUrl} target="_blank" rel="noreferrer">
            {repo}
          </a>
          <RepoMeta
            result={result}
            isInFlight={isInFlight}
            branchCount={branches.length}
            totalCount={totalCount}
            truncated={truncated}
            archived={archived}
          />
        </td>
      </tr>
      {!collapsed && branches.map((branch) => (
        <BranchRow key={`${repo}-${branch.name}`} repo={repo} branch={branch} />
      ))}
    </>
  )
}

interface RepoMetaProps {
  result: RepoBranchResult | undefined
  isInFlight: boolean
  branchCount: number
  totalCount: number
  truncated: boolean
  archived: boolean
}

function RepoMeta({ result, isInFlight, branchCount, totalCount, truncated, archived }: RepoMetaProps) {
  if (archived) return <span className="muted"> · archived</span>
  if (isInFlight) return <span className="muted"> · fetching…</span>
  if (!result) return <span className="muted"> · pending</span>
  if (result.error) return <span className="muted"> · error: {result.error}</span>

  const fetched = formatFetchedAt(result.fetchedAt)
  if (branchCount === 0 && totalCount === 0) {
    return <span className="muted"> · no branches · {fetched}</span>
  }

  return (
    <>
      <span className="muted">
        {' '}
        · {branchCount} of {totalCount} visible
      </span>
      {truncated && (
        <span className="muted">
          {' '}
          · truncated (GraphQL limit)
        </span>
      )}
      <span className="muted"> · {fetched}</span>
    </>
  )
}

interface BranchRowProps {
  repo: string
  branch: BranchInfo
}

function BranchRow({ repo, branch }: BranchRowProps) {
  const branchUrl = `https://github.com/${MAVEN_OWNER}/${repo}/commits/${branch.name}`
  const aheadClass = branch.aheadBy && branch.aheadBy > 10 ? 'ahead-high' : ''
  const behindClass = branch.behindBy && branch.behindBy > 10 ? 'behind-high' : ''

  return (
    <tr className="branch-row">
      <td className="branch-name">
        <a href={branchUrl} target="_blank" rel="noreferrer">
          <code>{branch.name}</code>
        </a>
        {branch.isProtected && <span className="protected-icon">🔒</span>}
        {branch.isDefault && <span className="default-badge">default</span>}
      </td>
      <td className="branch-commit-date" title={branch.lastCommitDate ?? 'never'}>
        {formatBranchDate(branch.lastCommitDate)}
      </td>
      <td className="branch-author">
        {branch.lastCommitAuthor ?? 'unknown'}
      </td>
      <td className={`branch-diff ${aheadClass} ${behindClass}`}>
        {branch.aheadBy !== null && branch.behindBy !== null ? (
          <>
            <span className="ahead-count">+{branch.aheadBy} ahead</span>
            {' · '}
            <span className="behind-count">-{branch.behindBy} behind</span>
          </>
        ) : (
          <span className="muted">unknown</span>
        )}
      </td>
      <td className="branch-prs">
        {branch.openPrCount > 0 && (
          <span className="pr-count-badge">{branch.openPrCount} PR{branch.openPrCount === 1 ? '' : 's'}</span>
        )}
      </td>
    </tr>
  )
}