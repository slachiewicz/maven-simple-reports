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

import type { BranchInfo, RepoBranchResult } from '../lib/types'
import { isStaleBranch } from '../lib/branches'
import { MAVEN_OWNER } from '../lib/repos'

interface Props {
  allRepos: readonly string[]
  results: Record<string, RepoBranchResult>
  inFlight: string | null
  staleOnly: boolean
  thresholdDays: number
}

// Absolute commit timestamp in the viewer's locale and zone. GraphQL returns
// committedDate in UTC, so the bare ISO date could be a day out for anyone east
// or west of it. Shown alongside the relative age, which is what you actually
// scan when hunting abandoned branches.
function formatCommitStamp(iso: string | null): string {
  if (!iso) return 'unknown'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return `${d.toLocaleDateString('sv-SE')} ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })}`
}

function formatAge(iso: string | null): string {
  if (!iso) return 'unknown'
  const days = Math.floor((Date.now() - Date.parse(iso)) / (24 * 60 * 60 * 1000))
  if (days < 1) return 'today'
  if (days < 60) return `${days} d`
  const months = Math.floor(days / 30)
  if (months < 24) return `${months} mo`
  return `${Math.floor(days / 365)} y`
}

export function BranchTable({ allRepos, results, inFlight, staleOnly, thresholdDays }: Props) {
  const rows: BranchInfo[] = []
  for (const repo of allRepos) {
    const result = results[repo]
    if (!result) continue
    for (const b of result.branches) {
      if (staleOnly && !isStaleBranch(b, thresholdDays)) continue
      rows.push(b)
    }
  }

  // Oldest first: the point of the view is finding what has been abandoned
  // longest. The GraphQL RefOrderField enum cannot sort branches by commit
  // date, so this must happen client-side.
  rows.sort((a, b) => {
    const at = a.lastCommitDate ? Date.parse(a.lastCommitDate) : Number.MAX_SAFE_INTEGER
    const bt = b.lastCommitDate ? Date.parse(b.lastCommitDate) : Number.MAX_SAFE_INTEGER
    return at - bt
  })

  const truncated = allRepos.filter((r) => results[r]?.truncated)
  const degraded = allRepos.filter((r) => results[r]?.degraded)
  const errored = allRepos.filter((r) => results[r]?.error)

  return (
    <div className="branch-table-wrap">
      {inFlight && <p className="muted">Fetching {inFlight}…</p>}
      {truncated.length > 0 && (
        <p className="muted">
          {truncated.length} {truncated.length === 1 ? 'repo has' : 'repos have'} more than 100
          branches; showing the first 100 of each ({truncated.join(', ')}).
        </p>
      )}
      {degraded.length > 0 && (
        <p className="muted">
          Ahead/behind unavailable for {degraded.join(', ')} — the comparison query timed out.
        </p>
      )}
      {errored.length > 0 && (
        <p className="warn-text">
          Failed: {errored.map((r) => `${r} (${results[r].error})`).join('; ')}
        </p>
      )}
      <table className="pr-table">
        <thead>
          <tr>
            <th>Branch</th>
            <th>Repo</th>
            <th>Last commit</th>
            <th>Last author</th>
            <th>Behind / ahead</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                {Object.keys(results).length === 0
                  ? 'No data yet.'
                  : staleOnly
                    ? `No branches older than ${thresholdDays} days without an open PR.`
                    : 'No branches.'}
              </td>
            </tr>
          ) : (
            rows.map((b) => <BranchRow key={`${b.repo}/${b.name}`} branch={b} />)
          )}
        </tbody>
      </table>
    </div>
  )
}

function BranchRow({ branch }: { branch: BranchInfo }) {
  const branchUrl = `https://github.com/${MAVEN_OWNER}/${branch.repo}/tree/${encodeURIComponent(branch.name)}`
  const repoUrl = `https://github.com/${MAVEN_OWNER}/${branch.repo}`
  return (
    <tr className="pr-row">
      <td>
        <a href={branchUrl} target="_blank" rel="noreferrer">
          {branch.name}
        </a>
        {branch.isProtected && <span className="pr-chip pr-chip-base">protected</span>}
        {branch.openPrCount > 0 && <span className="pr-chip pr-chip-draft">open PR</span>}
      </td>
      <td className="nowrap">
        <a href={repoUrl} target="_blank" rel="noreferrer">
          {branch.repo}
        </a>
      </td>
      <td className="nowrap" title={branch.lastCommitDate ?? undefined}>
        {formatCommitStamp(branch.lastCommitDate)}
        <span className="muted"> · {formatAge(branch.lastCommitDate)}</span>
      </td>
      <td className="nowrap">{branch.lastCommitAuthor ?? '—'}</td>
      <td className="nowrap">
        {branch.behindBy === null && branch.aheadBy === null
          ? '—'
          : `↓${branch.behindBy ?? '?'} / ↑${branch.aheadBy ?? '?'}`}
      </td>
    </tr>
  )
}
