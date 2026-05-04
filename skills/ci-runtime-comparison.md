# Compare CI runtime across PRs

## When to use

When a maintainer asks "is the new PR slower than the existing
one?", or when you want to confirm a refactor doesn't regress CI
duration.

## How

Pull the workflow runs for each branch:

```sh
gh api repos/<owner>/<repo>/actions/runs?branch=<branch>&per_page=5 \
  --jq '.workflow_runs[] | {
    head_sha,
    name,
    status,
    conclusion,
    created_at,
    updated_at,
    run_started_at
  }'
```

Total wall-clock for a run = `max(updated_at) − min(run_started_at)`
across the matrix jobs in that run. Per-job durations:

```sh
gh api repos/<owner>/<repo>/actions/runs/<run-id>/jobs \
  --jq '.jobs[] | {
    name,
    started_at,
    completed_at
  }' \
  | python3 -c "
import sys, json
from datetime import datetime
total = 0
for line in sys.stdin:
    j = json.loads(line)
    s = datetime.fromisoformat(j['started_at'].replace('Z','+00:00'))
    e = datetime.fromisoformat(j['completed_at'].replace('Z','+00:00'))
    d = (e-s).total_seconds()
    print(f'{int(d):4d}s  {j[\"name\"]}')
    total += d
print(f'sum: {int(total)}s')"
```

## What to report

Compare:

1. **Wall-clock total** for one run on each branch. This is what a
   reviewer actually waits for, since matrix jobs run in parallel.
2. **Slowest single job** on each branch. This is the bottleneck;
   if both branches have the same slowest job, the new PR doesn't
   regress wall-clock.
3. **Sum of all job durations** if you care about CI compute spend,
   not wall-clock.

Interpret in one paragraph. Acceptable framing: "the rename + refactor
adds N seconds to total compute spend because two more workspace
packages now build chacha12 as a dep, but the slowest single job is
unchanged, so wall-clock per push is unaffected".

## Pitfalls

- A single run includes both required and optional checks; filter
  by `name` if you want apples-to-apples.
- Re-runs of failed jobs inflate `created_at` vs `run_started_at`;
  use the latest re-run's timestamps, not the original.
- Branch comparisons are most stable when both runs were on the
  same runner type; `runs-on:` is in `.github/workflows/*.yml`.

## Session example

Requested as part of the PR 75 review (kriskowal asked the agent to
compare the chacha12 PR's CI runtime to PR 54's `@endo/xorshift`
extraction). The agent didn't post the comparison before its time
budget ran out; pulling the numbers afterwards via this command set
is straightforward.
