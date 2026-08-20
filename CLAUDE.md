# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **supporting project** (not an MCP server) that publishes reports and statistics about Apache Maven repository pull requests and branches. The primary purpose is to track the status of open PRs (all authors, not just Dependabot) and stale branches across ~98 Apache Maven repositories.

**Key outputs:**
- A static **single-page dashboard** (`web/`) with two tabs: *Pull requests* (all open PRs, any author, with live build status) and *Branches* (stale-branch detection). Both go through the GitHub GraphQL API and **both require a token**. This replaces the previous Python-generated `dependabot-prs.html`.
- Reports published to GitHub Pages from `main`. Branches and PRs build and test but deploy nowhere: Pages has a single site, and a branch deploy would overwrite it.

Further Python-based reports may live under `scripts/` in the future.

## Commands

### Generate the published site locally

```bash
scripts/generate_report.sh
```
This builds the SPA (`cd web && npm ci && npm run build`) and copies `web/dist/` into `public/dependabot-prs/`. The static `public/index.html` is hand-written and tracked as-is.

### Develop the SPA

```bash
cd web
npm install
npm run dev          # http://localhost:5173/maven-simple-reports/dependabot-prs/
npm run build        # production build into web/dist/
npm run typecheck    # tsc -b --noEmit
npm test             # vitest run — pure logic in src/lib/*.test.ts only
```

See `web/README.adoc` for architecture, rate-limit handling, and roadmap.

### Testing the workflow

The GitHub Actions workflow runs on push, PR, and manual dispatch (Actions → Publish → Run workflow). The previous hourly cron schedule has been removed — the SPA polls itself in the browser.

## Requirements

- **Node.js 22.12+** and npm (for the SPA build)
- **Python 3** and **GitHub CLI (`gh`)** — required by future Python-based report scripts under `scripts/`

## Project Architecture

### Pipeline

1. **`web/`** — Vite + React + TypeScript SPA. Calls `api.github.com/graphql` directly with serial request scheduling and 403/429 backoff. `lib/useSweep.ts` is the shared polling loop driving both tabs; `lib/githubGraphql.ts` is the only API client. Output: `web/dist/`.

   **Both tabs share one `SerialQueue`** (`lib/githubFetch.ts`, exported as `apiQueue`) so they never fire concurrently and a backoff triggered by either pauses both. They also share one 5 000 points/h budget, so that is the correct behaviour rather than a limitation.
2. **`netlify/functions/`** — three TypeScript Netlify Functions (`auth-callback`, `token-exchange`, `token-refresh`) hosting the OAuth Authorization Code + PKCE flow against a registered GitHub App. They never touch dashboard data, only token exchange / refresh, and are deployed independently of this repo's CI.
3. **`scripts/generate_report.sh`** — orchestrator. Builds the SPA and copies it into `public/dependabot-prs/`.
4. **`.github/workflows/publish.yml`** — builds and tests the SPA on every push and PR, and publishes `public/` to GitHub Pages from `main` only.

   The workflow no longer deploys to Netlify. `netlify/functions/` is still the OAuth backend and still deployed by whoever owns the Netlify site; CI just stopped pushing branch previews there.

### Directory layout

- `web/` — SPA source (Vite + React + TS); `web/dist/` is generated
- `netlify/functions/` — OAuth token-exchange Functions (`.mts`, ESM)
- `netlify.toml` — Functions bundler config (no SPA build step here; the workflow runs `generate_report.sh`)
- `scripts/` — Python and shell scripts
- `public/` — published site root; only `index.html` is git-tracked (the rest is generated)
- `.github/workflows/` — CI/CD
- `.agents/skills/` — agent skills, tracked; see below

### Agent skills

Skills live in `.agents/skills/`. Claude Code reads them from `.claude/skills/`,
which holds symlinks into that directory — and both are tracked, so a clone gets
working skills with no setup step.

That is why `.gitignore` uses `.claude/*` with a `!.claude/skills/` exception
rather than a blanket `.claude/`: git cannot re-include a path whose parent
directory is excluded, so the blanket form would make the exception silently do
nothing. Everything else under `.claude/` (worktrees, local settings) stays
ignored.

On Windows, symlinks need `git config core.symlinks true` and developer mode; a
clone without it gets plain files containing a path. Re-create them if that
happens:

```bash
mkdir -p .claude/skills
for s in .agents/skills/*/; do
  ln -sfn "../../$s" ".claude/skills/$(basename "$s")"
done
```

`maven-reports-spa` is the one worth reading before editing anything under
`web/` — it records the traps that have already shipped as bugs here. The rest
came from `vercel-labs/agent-skills`; the Vercel deployment and React Native ones
were deliberately not installed, since this project deploys to GitHub Pages and
Netlify and has no React Native.

### OAuth flow (browser ↔ Netlify Functions ↔ GitHub)

The full setup is documented in `web/README.adoc` (sections _Status_, _UI controls_, _Configuration_). High-level summary:

1. SPA generates PKCE `code_verifier`/`code_challenge` + a CSRF token + a base64-encoded `state = {origin, csrf}`, redirects to `github.com/login/oauth/authorize`.
2. GitHub redirects to the single registered callback URL `https://<netlify-site>/.netlify/functions/auth-callback`. That function decodes `state.origin`, validates it against the allowlist in `netlify/functions/_lib/cors.mts`, and 302s the browser back to the SPA at its own origin with `code` + `state` in the query string.
3. SPA on its origin verifies the CSRF token, POSTs `{code, code_verifier, redirect_uri}` to `/token-exchange`, which calls GitHub with the server-side `client_secret` added and returns the access + refresh tokens.
4. Access tokens (~8 h) are refreshed transparently via `/token-refresh` before each fetch when their remaining lifetime is < 60 s.

## Fetching pull requests

**A token is mandatory.** Every request goes to GitHub's GraphQL API, which
rejects unauthenticated callers, so `App.tsx` renders `SignInPrompt` in place of
either tab when there are no credentials and the app issues no request at all.
The REST pull-request path that once served anonymous visitors was removed; see
_Why GraphQL only_ in `web/README.adoc` for what it cost and why it went.

### `lib/pullsGraphql.ts`

One query per repo returns the PRs *and* their `statusCheckRollup` together, so
badges arrive with the row rather than a phase later. Measured at **~1-2 points
per repo**, so a 98-repo sweep costs ~100-200 points against the 5 000/h budget
— versus roughly 1 170 REST requests for the same data.

`statusCheckRollup` natively rolls up check-runs *and* legacy commit statuses,
which is what the removed REST path had to reconstruct by hand from two calls.
That is what made it the more reliable of the two for the Apache Jenkins case.

`mapRollupState` maps GitHub's `StatusState`: `SUCCESS` → `SUCCESS`;
`FAILURE`/`ERROR` → `FAILURE`; `PENDING`/`EXPECTED` → `PENDING`; absent or
unrecognised → `UNKNOWN`.

Merge-conflict detection is not consulted. See `web/README.adoc`
_Known limitations_.

## Filtering (client-side, zero requests)

Four controls filtering already-fetched data. The first three are segmented
controls rendered by `components/SegmentedControl.tsx` (`role="radiogroup"`);
the fourth is a dropdown, because its options are discovered at runtime:

- **Author** — All / Dependabot / People (`lib/authors.ts`). Bot-ness comes from
  the API's `type` field, never from pattern-matching the login, so a user called
  `robotics-fan` is not misfiled. "People" excludes *all* bots, so
  `dependabot + people` is usually less than `all`.
- **Draft** — All / Ready / Draft (`lib/prFilters.ts`).
- **Review** — All / Approved / By you / Not approved (`lib/reviews.ts`). "By
  you" is a *subset* of Approved, not a fourth bucket, so the two counts overlap
  by design. Approved and Not approved partition everything known.
- **Assignee** — All / Assigned / Unassigned / one login (`lib/assignees.ts`).
  The login list is collected from whatever the current cycle has fetched, so it
  grows as the sweep progresses.

Each segmented control's counts are computed with the *other* filters already
applied, so a count states what clicking it would actually yield.

`PullRequestInfo.reviewDecision` and `.viewerReviewState` come from
`reviewDecision` and `viewerLatestReview` on the GraphQL `PullRequest` node.
Both are scalar reads — no connection, no page size — so they cost nothing:
measured at cost 2 with and without them on `apache/maven-compiler-plugin`.

`viewerLatestReview` is the viewer's latest review of *any* kind. An approval
followed by a comment-only review reads back as `COMMENTED` while
`reviewDecision` still says `APPROVED`, so the "you" marker drops even though
the approval stands. The alternative needs a `viewer { login }` lookup and a
reviews connection; only `APPROVED` counts as yours, which also makes a
dismissed approval correctly stop counting.

`PullRequestInfo.assignees` is deliberately optional. Entries persisted before
the column existed have no such field, and `undefined` means "unknown", *not*
"unassigned" — `hasAssigneeData()` separates the two so a stale row renders "?"
and is excluded from both Assigned and Unassigned rather than being claimed as
nobody's. Making the field required would have forced a `gh-result:` version
bump, discarding every repo's last known state and burning a full refetch
against the rate limit. `reviewDecision` and `viewerReviewState` follow the
same rule, via `hasReviewData()`: a stale row renders "?" and falls out of
Approved, By you *and* Not approved — claiming a PR is unapproved on the
strength of data never fetched is the same mistake.

> **Trap, shipped and fixed twice.** `PrTable`'s "hide repos without PRs" test and
> its row rendering MUST use the same predicate — `matchesFilters()`. When they
> drifted, repos whose PRs were all filtered out stayed visible as a wall of
> empty "no open PRs" headers while the box was ticked. Any new filter must go
> into `matchesFilters()`, not into the row rendering alone.

## Caching (`lib/cache.ts`)

| Namespace | Storage | Notes |
|---|---|---|
| `gh-result:v2:` | localStorage | Per-repo `PrResult`; v1 entries are reclaimed by `migrateLegacyCache` |
| `gh-branches:v1:` | localStorage | Per-repo branch results |
| `gh-default-branch:v1:` | localStorage | 7-day TTL; avoids a second GraphQL round-trip per repo |

`migrateLegacyCache` reclaims what superseded generations left behind: the
`gh-cache:`, `gh-archived:v1:` and `gh-build:v1` families all belonged to the
removed REST path and are deleted on load rather than left to occupy the budget.

Writers fail open so the app keeps working, but they warn once per key via
`reportQuotaFailure` instead of swallowing the error. That silence mattered
once: when the quota filled, the archived-repo cache stopped sticking and every
cycle paid an extra call per repo — doubling cost invisibly and permanently.

## Integration with Parent Project

Supporting project under the `maven-mcps` umbrella. See `../CLAUDE.md` for overall project structure. Unlike `mail-mcp/`, this is **not** an MCP server.
