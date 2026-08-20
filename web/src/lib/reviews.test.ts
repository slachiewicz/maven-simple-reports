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
import { matchesReviewFilter } from './reviews'
import type { PullRequestInfo, ReviewDecision, ViewerReviewState } from './types'

function pr(
  reviewDecision: ReviewDecision | undefined,
  viewerReviewState?: ViewerReviewState,
): PullRequestInfo {
  return {
    repo: 'maven-compiler-plugin',
    number: 1,
    title: 'Bump something',
    author: 'alice',
    authorClass: 'human',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    isDraft: false,
    baseRef: 'master',
    url: 'https://github.com/apache/maven-compiler-plugin/pull/1',
    checksUrl: 'https://github.com/apache/maven-compiler-plugin/pull/1/checks',
    headSha: 'deadbeef',
    buildState: 'UNKNOWN',
    buildStateFetchedAt: null,
    assignees: [],
    reviewDecision,
    viewerReviewState,
  }
}

describe('matchesReviewFilter', () => {
  it('keeps everything under "all"', () => {
    expect(matchesReviewFilter(pr('APPROVED'), 'all')).toBe(true)
    expect(matchesReviewFilter(pr('NONE'), 'all')).toBe(true)
    expect(matchesReviewFilter(pr(undefined), 'all')).toBe(true)
  })

  it('keeps only approved PRs under "approved"', () => {
    expect(matchesReviewFilter(pr('APPROVED'), 'approved')).toBe(true)
    expect(matchesReviewFilter(pr('CHANGES_REQUESTED'), 'approved')).toBe(false)
    expect(matchesReviewFilter(pr('REVIEW_REQUIRED'), 'approved')).toBe(false)
    expect(matchesReviewFilter(pr('NONE'), 'approved')).toBe(false)
  })

  it('keeps everything not approved under "unapproved"', () => {
    expect(matchesReviewFilter(pr('CHANGES_REQUESTED'), 'unapproved')).toBe(true)
    expect(matchesReviewFilter(pr('REVIEW_REQUIRED'), 'unapproved')).toBe(true)
    expect(matchesReviewFilter(pr('NONE'), 'unapproved')).toBe(true)
    expect(matchesReviewFilter(pr('APPROVED'), 'unapproved')).toBe(false)
  })

  it('keeps only the viewer\'s own approvals under "mine"', () => {
    expect(matchesReviewFilter(pr('APPROVED', 'APPROVED'), 'mine')).toBe(true)
    expect(matchesReviewFilter(pr('APPROVED', 'NONE'), 'mine')).toBe(false)
  })

  // Only an approval counts as yours: a comment-only review is not a sign-off,
  // and a dismissed one no longer is.
  it('does not count a commented or dismissed review as the viewer\'s approval', () => {
    expect(matchesReviewFilter(pr('APPROVED', 'COMMENTED'), 'mine')).toBe(false)
    expect(matchesReviewFilter(pr('NONE', 'DISMISSED'), 'mine')).toBe(false)
    expect(matchesReviewFilter(pr('CHANGES_REQUESTED', 'CHANGES_REQUESTED'), 'mine')).toBe(false)
  })

  // The cache-compatibility rule: an entry persisted before the column existed
  // is unknown, so it must fall out of every option except "all" — including
  // "unapproved", which would otherwise assert something never fetched.
  it('excludes a pre-review cache entry from every non-"all" option', () => {
    expect(matchesReviewFilter(pr(undefined), 'approved')).toBe(false)
    expect(matchesReviewFilter(pr(undefined), 'mine')).toBe(false)
    expect(matchesReviewFilter(pr(undefined), 'unapproved')).toBe(false)
  })
})
