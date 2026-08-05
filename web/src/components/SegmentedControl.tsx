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

interface Option<T extends string> {
  key: T
  label: string
  count?: number
}

interface Props<T extends string> {
  value: T
  options: ReadonlyArray<Option<T>>
  ariaLabel: string
  onChange: (next: T) => void
}

// A single-select control is semantically a radiogroup, not a set of
// independently toggleable buttons — using role="group" + aria-pressed (the
// pattern this replaced) told assistive tech each button was its own toggle
// rather than one mutually-exclusive choice.
export function SegmentedControl<T extends string>({ value, options, ariaLabel, onChange }: Props<T>) {
  return (
    <div className="author-filter" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          className={`author-filter-btn${value === opt.key ? ' author-filter-btn-active' : ''}`}
          role="radio"
          aria-checked={value === opt.key}
          onClick={() => onChange(opt.key)}
        >
          {opt.label} {opt.count !== undefined && <span className="muted">({opt.count})</span>}
        </button>
      ))}
    </div>
  )
}
