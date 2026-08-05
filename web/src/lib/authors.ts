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

export type AuthorClass = 'dependabot' | 'bot' | 'human'
export type AuthorFilter = 'dependabot' | 'humans' | 'all'

const DEPENDABOT_LOGIN_PATTERNS = [/^dependabot(\[bot\])?$/i, /^app\/dependabot$/i]

export function classifyAuthor(
  login: string | null | undefined,
  type: string | null | undefined,
): AuthorClass {
  if (!login) return 'bot'
  if (DEPENDABOT_LOGIN_PATTERNS.some((re) => re.test(login))) return 'dependabot'
  // Trust the API's own type field rather than pattern-matching the login, so a
  // user called "robotics-fan" is not misfiled as a bot.
  if ((type ?? '').toLowerCase() === 'bot') return 'bot'
  return 'human'
}

export function matchesAuthorFilter(cls: AuthorClass, filter: AuthorFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'dependabot') return cls === 'dependabot'
  return cls === 'human'
}
