# GraphQL PR Fetching, Budget Work, and Filters — Design

Date: 2026-08-05
Status: Implemented (`4706300`, `e8db4ff`, `322ca3a`, `d2217d2`, `16c6c87`)

Follows `2026-08-04-all-branches-and-prs-design.md`, which delivered the two-tab
dashboard. That work shipped correct but wasteful: this phase makes it cheap, and
adds the filtering the data volume turned out to demand.

## What prompted it

Running the finished dashboard against the real Apache Maven estate produced
numbers the design phase had only estimated:

| Observation | Measured |
|---|---|
| Open PRs across 98 repos | ~536, of which **532 human, 4 Dependabot** |
| REST cost of one full authenticated cycle | ~98 inventory + ~1 072 enrichment ≈ **1 170 requests** |
| GraphQL cost per repo (branches) | **~2.7 points** |
| GraphQL cost per repo (PRs, incl. rollup) | **~1 point** |
| Anonymous budget | 60 req/h — **cannot complete even one 98-repo sweep** |

Two conclusions. First, the original decision to keep PRs on REST was right for
anonymous visitors and wrong for authenticated ones by a factor of about ten.
Second, at 536 PRs the table is unusable without filters — the 4 Dependabot PRs
that motivated the original dashboard are now lost among 532 human ones.

### A measurement caveat worth recording

Both GraphQL cost figures were **wrong on first reading** — 16 points/repo and
13 points/repo respectively — because early repos pay one-off setup (the
default-branch probe) that inflates the average. The true marginal rate only
appears from the delta between two readings. Any future cost claim here must be
taken as a rate between two samples, never as total ÷ count.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| GraphQL for PRs | Yes, **when a token is present** | ~100 points replaces ~1 170 requests, and badges arrive with the row |
| Keep the REST path | Yes, as the anonymous path | GitHub rejects anonymous GraphQL; the published dashboard must stay viewable |
| Path selection | `enabled` flags on always-constructed sweeps | React forbids conditional hooks |
| Persist build states | One blob, 7-day TTL | Per-PR keys would mean ~536 localStorage entries |
| Enrichment cap | 10 newest **per repo** | A global cap starves later repos entirely |
| Draft filter | Third segmented control | `isDraft` already present; filtering costs nothing |

### Why not move the whole PR tab to GraphQL and drop REST

Considered and rejected: anonymous access is the reason the dashboard is
published at all. The cost is genuinely two implementations of the same view,
accepted deliberately. They are kept honest by both producing the same
`PrResult` shape, so everything downstream — table, counts, filters, cycle
status — consumes one value and cannot tell which path ran.

## Architecture

### Path selection

`views/PullRequestsView.tsx` constructs three sweeps, two dormant at any moment:

| Sweep | `enabled` |
|---|---|
| `graphqlSweep` | `authenticated` |
| `sweep` (REST inventory) | `!authenticated` |
| `buildSweep` (REST enrichment) | `!authenticated && sweep.pending.length === 0` |

`useSweep`'s `enabled: false` parks a loop without unmounting it, which is what
makes this safe: no hook is conditional, and a parked loop resumes within ~500 ms
of being re-enabled.

The second term on `buildSweep` is the two-phase ordering. Without it both REST
sweeps compete for the one serial queue and interleave roughly 1:1, which is how
the original implementation shipped — the design said "inventory first" and the
code did not do it. The gate is one expression and restores the documented
behaviour.

### Build state over GraphQL

`statusCheckRollup` rolls up check-runs *and* legacy commit statuses in one
field. The REST path reconstructs the same thing from two calls specifically
because Apache Jenkins reports via the legacy combined-status API. The GraphQL
path is therefore not merely cheaper but structurally more reliable.

### Filtering

`components/SegmentedControl.tsx` renders both controls as a `role="radiogroup"`
with `role="radio"`/`aria-checked` children — a single-select control modelled
correctly, replacing the earlier `aria-pressed` toggle-button pattern in one
place rather than duplicating it.

Counts are cross-conditioned: author counts respect the active draft filter and
vice versa, so a count always describes what clicking it yields.

**The predicate must be shared.** `PrTable.matchesFilters()` is used by both the
row rendering and the "hide repos without PRs" visibility test. They were
allowed to drift once, and the result was a wall of empty "no open PRs" headers
while the hide box was ticked — the bug survived review and a browser pass
because both only exercised the default "All" filter. Every future filter goes
into `matchesFilters()`.

### Caching and quota

Build states persist as a single `gh-build:v1` blob with a 7-day TTL, pruned on
write because head-SHA-scoped keys are superseded on every push and would
otherwise grow without bound. Hydrating it means a browser restart no longer
re-enriches ~536 PRs.

Every localStorage writer still fails open, but now warns once per key. The
silent mode was actively harmful: a full quota stops `writeArchived` sticking,
so every cycle pays an extra call per repo — a permanent, invisible doubling of
REST cost. `migrateLegacyCache` also now reclaims the superseded `gh-result:v1:`
entries; 25 were found in a real browser profile.

## Known limitations

- **Anonymous mode cannot complete a sweep.** 98 repos need 98 inventory calls
  against a 60/h ceiling. No optimisation fixes this; only a smaller default repo
  set would, which is a product decision.
- **GraphQL responses are not ETag-cached.** POST carries no usable ETag, so
  unlike REST — where 304s are free — every GraphQL sweep pays full price. At
  ~100 points per sweep this is comfortable, but it is why the cadence matters.
- **One shared backoff for two budgets.** REST core and GraphQL are separate
  GitHub quotas gated by a single `apiQueue.backoffUntil`, so exhausting one
  stalls the other. The serial ordering is worth keeping; the backoff should
  become per-resource.
- **`BranchesView` surfaces no rate-limit pause**, unlike `PullRequestsView`'s
  `CycleStatus`. A shared-queue backoff can therefore present as a frozen
  `0/98 repos fetched` with no explanation.
- **`lib/useBuildStatusEnrich.ts` is dead and broken** — it calls `useRef` inside
  an async callback (a Rules-of-Hooks violation that would throw if it ever ran),
  hardcodes `apache` rather than using `MAVEN_OWNER`, and bypasses the queue,
  backoff and ETag cache. Nothing imports it, yet 15 tests exercise it. Inherited
  from a parallel implementation; it should be deleted.
