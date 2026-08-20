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

import { hasReviewData } from './types'
import type { PullRequestInfo } from './types'

/**
 * `mine` is "approved by you", not "reviewed by you" — a comment-only review
 * is not an approval, and neither is one GitHub has dismissed.
 */
export type ReviewFilter = 'all' | 'approved' | 'mine' | 'unapproved'

export function isApproved(pr: PullRequestInfo): boolean {
  return pr.reviewDecision === 'APPROVED'
}

export function isApprovedByViewer(pr: PullRequestInfo): boolean {
  return pr.viewerReviewState === 'APPROVED'
}

export function matchesReviewFilter(pr: PullRequestInfo, filter: ReviewFilter): boolean {
  if (filter === 'all') return true
  // An entry cached before the column existed is *unknown*. It must fall out of
  // every non-"all" option, including "Not approved" — claiming a PR has no
  // approval on the strength of data we never fetched is the same mistake the
  // assignee column had to avoid.
  if (!hasReviewData(pr)) return false
  if (filter === 'approved') return isApproved(pr)
  if (filter === 'mine') return isApprovedByViewer(pr)
  return !isApproved(pr)
}
