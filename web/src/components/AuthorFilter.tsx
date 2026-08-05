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

import type { AuthorFilter } from '../lib/authors'

interface Props {
  value: AuthorFilter
  onChange: (next: AuthorFilter) => void
  counts: Record<AuthorFilter, number>
}

const OPTIONS: Array<{ key: AuthorFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'dependabot', label: 'Dependabot' },
  { key: 'humans', label: 'People' },
]

export function AuthorFilterControl({ value, onChange, counts }: Props) {
  return (
    <div className="author-filter" role="group" aria-label="Filter pull requests by author">
      {OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`author-filter-btn${value === opt.key ? ' author-filter-btn-active' : ''}`}
          aria-pressed={value === opt.key}
          onClick={() => onChange(opt.key)}
        >
          {opt.label} <span className="muted">({counts[opt.key]})</span>
        </button>
      ))}
    </div>
  )
}
