# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a **supporting project** (not an MCP server) that publishes reports and statistics about Apache Maven repository pull requests and branches. The primary purpose is to track the status of open PRs (all authors, not just Dependabot) and stale branches across ~98 Apache Maven repositories.

**Key outputs:**
- A static **single-page dashboard** (`web/`) with two tabs: *Pull requests* (all open PRs, any author, with live build status, via the GitHub REST API) and *Branches* (stale-branch detection, via the GitHub GraphQL API, requires a token). This replaces the previous Python-generated `dependabot-prs.html`.
- Reports published to GitHub Pages (main) and Netlify (PRs/branches) on push.

Further Python-based reports may live under `scripts/` in the future.

## Commands

### Generate the published site locally

```bash
scripts/generate_report.sh
```
This builds the SPA (`cd web && npm ci && npm run build`), copies `web/dist/` into `public/dependabot-prs/`, and converts the remaining static AsciiDoc files (e.g. `index.adoc`) to HTML.

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

The GitHub Actions workflow runs on push, PR, and manual dispatch (Actions → Publish Reports → Run workflow). The previous hourly cron schedule has been removed — the SPA polls itself in the browser.

## Requirements

- **Node.js 22+** and npm (for the SPA build)
- **Ruby** and the `asciidoctor` gem (for AsciiDoc → HTML conversion)
  ```bash
  gem install asciidoctor
  ```
- **Python 3** and **GitHub CLI (`gh`)** — required by future Python-based report scripts under `scripts/`

## Project Architecture

### Pipeline

1. **`web/`** — Vite + React + TypeScript SPA. Calls `api.github.com` directly with ETag/`If-None-Match` caching, serial request scheduling, and 403/429 backoff. `lib/useSweep.ts` is the shared polling loop driving both tabs; `lib/githubGraphql.ts` is the GraphQL client. Output: `web/dist/`.

   **Both APIs share one `SerialQueue`** (`lib/githubFetch.ts`, exported as `apiQueue`) so REST and GraphQL never fire concurrently. One consequence: the queue's backoff is global, so a REST 403 also stalls GraphQL even though they draw on separate GitHub budgets.
2. **`netlify/functions/`** — three TypeScript Netlify Functions (`auth-callback`, `token-exchange`, `token-refresh`) hosting the OAuth Authorization Code + PKCE flow against a registered GitHub App. They never touch dashboard data, only token exchange / refresh.
3. **`scripts/generate_report.sh`** — orchestrator. Builds the SPA, copies it into `public/dependabot-prs/`, then runs `asciidoctor` on remaining `.adoc` files.
4. **`.github/workflows/publish-reports.yml`** — runs `generate_report.sh`, publishes `public/` to GitHub Pages (main) or Netlify (PRs/branches), and uploads `netlify/functions/` alongside Netlify deploys.

### Directory layout

- `web/` — SPA source (Vite + React + TS); `web/dist/` is generated
- `netlify/functions/` — OAuth token-exchange Functions (`.mts`, ESM)
- `netlify.toml` — Functions bundler config (no SPA build step here; the workflow runs `generate_report.sh`)
- `scripts/` — Python and shell scripts
- `public/` — published site root; only `index.adoc` is git-tracked (the rest is generated)
- `.github/workflows/` — CI/CD

### OAuth flow (browser ↔ Netlify Functions ↔ GitHub)

The full setup is documented in `web/README.adoc` (sections _Status_, _UI controls_, _Configuration_). High-level summary:

1. SPA generates PKCE `code_verifier`/`code_challenge` + a CSRF token + a base64-encoded `state = {origin, csrf}`, redirects to `github.com/login/oauth/authorize`.
2. GitHub redirects to the single registered callback URL `https://<netlify-site>/.netlify/functions/auth-callback`. That function decodes `state.origin`, validates it against the allowlist in `netlify/functions/_lib/cors.mts`, and 302s the browser back to the SPA at its own origin with `code` + `state` in the query string.
3. SPA on its origin verifies the CSRF token, POSTs `{code, code_verifier, redirect_uri}` to `/token-exchange`, which calls GitHub with the server-side `client_secret` added and returns the access + refresh tokens.
4. Access tokens (~8 h) are refreshed transparently via `/token-refresh` before each fetch when their remaining lifetime is < 60 s.

## Fetching pull requests: two paths

**Which path runs depends solely on whether a token is present.** Both produce the
same `PrResult` shape, so nothing downstream knows or cares which ran. In
`views/PullRequestsView.tsx` all three sweeps are always constructed — React
forbids conditional hooks — and are selected with `enabled`.

### Authenticated → GraphQL (`lib/pullsGraphql.ts`)

One query per repo returns the PRs *and* their `statusCheckRollup` together, so
badges arrive with the row rather than a phase later. Measured at **~1 point per
repo**, so a 98-repo sweep costs ~100 points against the 5 000/h budget — versus
roughly 1 170 REST requests for the same data.

`statusCheckRollup` natively rolls up check-runs *and* legacy commit statuses,
which is what the REST path has to reconstruct by hand from two calls. It is
therefore the more reliable of the two for the Apache Jenkins case.

`mapRollupState` maps GitHub's `StatusState`: `SUCCESS` → `SUCCESS`;
`FAILURE`/`ERROR` → `FAILURE`; `PENDING`/`EXPECTED` → `PENDING`; absent or
unrecognised → `UNKNOWN`.

### Anonymous → REST, two-phase (`lib/pulls.ts`)

GitHub rejects anonymous GraphQL outright, so the REST path exists to keep the
published dashboard viewable without a token on the 60 req/h budget. It is
deliberately two-phase:

1. **Inventory** — one `/pulls` call per repo, so the full table paints quickly
   with `BuildState: 'UNKNOWN'`.
2. **Enrichment** — a separate sweep resolving build state per PR, gated on
   `sweep.pending.length === 0` so it never competes with inventory for the
   shared queue. Keyed by head SHA (`repo#number#sha`), so an unmoved PR is
   skipped on later cycles.

The ordering is the point: enrichment is the dominant cost, and an anonymous
visitor must get a usable table before their budget runs out. Enrichment is
capped to `MAX_ENRICHED_PRS_PER_REPO` (10) newest PRs per repo — per repo rather
than globally, so every repo shows some badges instead of later repos starving.

`deriveBuildState` (REST path only) combines `/commits/{sha}/check-runs` with the
legacy `/commits/{sha}/status`:

- Any failed/timed-out/cancelled run or failed/error status → `FAILURE`
- Otherwise any queued/in-progress run or pending status → `PENDING`
- Otherwise any successful/neutral/skipped run or successful status → `SUCCESS`
- Empty or all-other → `UNKNOWN`

Merge-conflict detection (`/pulls/{n}.mergeable`) is not consulted. See
`web/README.adoc` _Known limitations_.

## Filtering (client-side, zero requests)

Two segmented controls, both rendered by `components/SegmentedControl.tsx`
(`role="radiogroup"`), filtering already-fetched data:

- **Author** — All / Dependabot / People (`lib/authors.ts`). Bot-ness comes from
  the API's `type` field, never from pattern-matching the login, so a user called
  `robotics-fan` is not misfiled. "People" excludes *all* bots, so
  `dependabot + people` is usually less than `all`.
- **Draft** — All / Ready / Draft (`lib/prFilters.ts`).

Each control's counts are computed with the *other* filter already applied, so a
count states what clicking it would actually yield.

> **Trap, shipped and fixed twice.** `PrTable`'s "hide repos without PRs" test and
> its row rendering MUST use the same predicate — `matchesFilters()`. When they
> drifted, repos whose PRs were all filtered out stayed visible as a wall of
> empty "no open PRs" headers while the box was ticked. Any new filter must go
> into `matchesFilters()`, not into the row rendering alone.

## Caching (`lib/cache.ts`)

| Namespace | Storage | Notes |
|---|---|---|
| `gh-cache:` | sessionStorage | ETag bodies; kept out of localStorage so they don't eat the ~5 MB budget |
| `gh-result:v2:` | localStorage | Per-repo `PrResult`; v1 entries are reclaimed by `migrateLegacyCache` |
| `gh-build:v1` | localStorage | **One blob**, not a key per PR; 7-day TTL, pruned on write since head-SHA keys accumulate |
| `gh-branches:v1:` | localStorage | Per-repo branch results |
| `gh-default-branch:v1:` | localStorage | 7-day TTL; avoids a second GraphQL round-trip per repo |

Writers fail open so the app keeps working, but they now warn once per key via
`reportQuotaFailure` instead of swallowing the error. That silence mattered: when
the quota fills, `writeArchived` stops sticking and every cycle pays an extra
call per repo — doubling REST cost invisibly and permanently.

## Integration with Parent Project

Supporting project under the `maven-mcps` umbrella. See `../CLAUDE.md` for overall project structure. Unlike `mail-mcp/`, this is **not** an MCP server.
