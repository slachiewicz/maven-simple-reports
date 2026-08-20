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

/**
 * Shown in place of either tab when there are no credentials. Both tabs now
 * fetch exclusively through GitHub's GraphQL API, which rejects unauthenticated
 * requests outright, so there is nothing useful to render and — deliberately —
 * no request to issue until the visitor signs in.
 */
export function SignInPrompt() {
  return (
    <div className="signin-prompt">
      <h2>A GitHub token is required</h2>
      <p>
        This dashboard reads GitHub's GraphQL API, which rejects unauthenticated
        requests. Open <strong>Settings</strong> above and either connect with
        GitHub or paste a personal access token — no scopes are needed for
        public repositories.
      </p>
      <p className="muted">
        Nothing is fetched until you do, and the token stays in this browser.
      </p>
    </div>
  )
}
