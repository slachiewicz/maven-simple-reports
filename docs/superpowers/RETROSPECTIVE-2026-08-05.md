# Retrospective: what I would do differently

Date: 2026-08-05
Scope: the two-tab dashboard (11 planned tasks) plus the GraphQL/budget/filter
follow-up. ~30 commits, 82 tests, roughly a dozen subagents.

The work shipped and works. This records where the *process* leaked, with
evidence, so the next run is cheaper. Ordered by how much each cost.

---

## 1. The plan's code was never compiled

**What happened.** I wrote ~2 466 lines of TypeScript into a markdown plan and
dispatched implementers against it. No compiler ever saw that code. Seven
defects reached implementers as authoritative instructions:

| Defect | Consequence |
|---|---|
| A literal **NUL byte** in a string | `file` classified the plan as binary; the extracted brief was corrupt |
| `pendingRef` seeded empty | Warm-cache reload fetched **nothing** |
| `didMountRef` guard | Defeated by StrictMode's double-invoke — dev testing showed the bug, not the fix |
| `wake()` missing `clearQueueBackoff` | Saving a token during a pause didn't resume |
| Phantom `onRequestSignIn` prop | Implementer had to choose between two contradictory sections |
| "two `colSpan` occurrences" | There was one |
| Shared-singleton test teardown | Every test after the rate-limit case hit a 5 s timeout |

Three of these were real user-visible bugs. All were mine, not the implementers'
— they transcribed faithfully, as instructed.

**Do differently.** Extract every code block from the plan into a scratch file
and run `tsc --noEmit` over it *before* dispatching task 1. Ten minutes would
have caught at least the NUL byte, the phantom prop, and probably the seeding
bug. A plan containing code is a program; treat it like one.

## 2. Per-task review cannot see compositional defects

**What happened.** Eleven tasks each got an independent review; almost all came
back clean. The two most serious bugs in the whole branch were found only by the
final whole-branch review:

- **The repo filter leaked** — filtering to one repo still queued ~740
  enrichment calls for the 97 excluded ones.
- **The two-phase design was never two-phase** — both sweeps ran concurrently on
  one serial queue, so the central rationale of the spec was simply not
  implemented.

Neither is visible from a single task's diff. Each task was individually correct.

**Do differently.** Run a cheap integration review every ~3 tasks, scoped to
"does the assembled thing still do what the spec claims", not to any one diff.
The final review is too late to be the first time anyone looks at the whole.

## 3. I did not check whether anyone else was working on this

**What happened.** A parallel session was implementing the same plan directly on
`main` the entire time. I discovered it at task 8. By then `main` had its own
`branches.ts` (343 lines), `branches.test.ts` (379), `BranchTable.tsx` (359) and
tab navigation. A rebase onto it was obsolete within minutes of finishing,
because `main` gained two more commits during the rebase itself.

**Do differently.** Check `git log origin/<branch>..` and the reflog before
starting a long run, and re-check before any merge or rebase. Cheap, and this
cost an entire duplicate implementation plus a hazardous merge.

## 4. Tests passed while the build was broken

**What happened.** `git rebase -X theirs` produced a tree where `types.ts`
carried one type name and three importers used another. **52/52 tests passed;
`tsc` failed.** The tests didn't import the broken module.

**Do differently.** "Gates" always means typecheck **and** test **and** build.
I had been reporting test counts as though they were sufficient. Also: never
trust `-X ours/theirs` to resolve semantics — it resolves text.

## 5. I ran the app far too late

**What happened.** The first time anything was opened in a browser was after all
11 tasks were complete. Three of the worst bugs lived only there:

- warm-cache reload fetching nothing
- the StrictMode-defeated guard
- the hide-empty filter showing a wall of empty headers

Every agent was headless and correctly refused to claim the manual checks passed
— so the checks simply never happened until the very end.

**Do differently.** Run the app after the first task that produces something
visible, then after each UI task. This is the single highest-value change on this
list: the browser found in minutes what a dozen careful reviews missed.

## 6. Every first measurement of a rate was wrong

**What happened.** Twice I took one reading and nearly reported a false alarm:

| Metric | First reading | True marginal rate |
|---|---|---|
| GraphQL branches | 13 points/repo | **2.7** |
| GraphQL PRs | 16 points/repo | **~1** |

Both were inflated by one-off startup cost. On the second, I had already drafted
"this exceeds the hourly budget" before taking a second sample.

**Do differently.** A rate is a delta between two samples, never total ÷ count.
Never report the first.

## 7. I only ever exercised the default state

**What happened.** The hide-empty bug survived unit tests, a task review, a
whole-branch review by the most capable model, and my own browser pass. All of
them used the default **All** author filter, where the buggy and correct
predicates agree. The user found it in about a minute by clicking *Dependabot*.

**Do differently.** When a feature adds a toggle or filter, exercise the
**non-default** states. The default is the one path least likely to be broken.

## 8. Near-miss: two agents, one file

I very nearly dispatched the GraphQL work while the caching work was still
uncommitted — both rewriting `PullRequestsView.tsx`. I caught it only by checking
`git status` first. **Check for uncommitted work before every dispatch**, not
just at the start of a batch.

---

## What worked, and is worth keeping

- **Adversarial review earns its cost.** Six real defects, three user-visible.
  The reviewers repeatedly caught things I had verified myself and believed fine.
- **Verifying agent claims against git.** Agents reported "done" for work that
  was uncommitted, and reported stale summaries in idle notifications. Every
  claim in this run was checked against `git log`/`git status` before being
  believed, and that caught several discrepancies.
- **Writing the API traps into the plan with their reasoning.** `Ref.compare()`
  reading inverted, `branchProtectionRule` needing admin, `RefOrderField` not
  supporting date sort — all three were stated with *why*, and all three survived
  contact with implementers who would otherwise have "corrected" them from
  memory. Real data later confirmed each.
- **Refusing to claim unrun checks.** Every agent explicitly reported the manual
  browser checks as not performed. That honesty is why the gap was visible enough
  to eventually close.

## The one-line version

Compile the plan, run the app early, measure twice, and click the non-default
button. Most of what went wrong was invisible to tests and visible in a browser
within seconds.
