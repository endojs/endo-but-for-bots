# CI status summary across multiple PRs

## When to use

When watching CI on many open PRs at once, `gh pr checks <N> --watch`
blocks one PR at a time and is too slow. Instead, batch a status
sweep that prints one line per PR.

## How

```sh
for n in 63 64 65 66 67 68 69 70 71 72 73 74 75 76; do
  state=$(gh pr checks $n -R endojs/endo-but-for-bots --json state \
    2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
from collections import Counter
c = Counter(x['state'] for x in d)
print(' '.join(f'{k}={v}' for k, v in sorted(c.items())))" 2>/dev/null)
  printf 'PR %s | %s\n' "$n" "$state"
done
```

Output looks like:

```
PR 63 | SUCCESS=26
PR 67 | IN_PROGRESS=7 QUEUED=19
PR 70 | FAILURE=1 SUCCESS=25
```

`SUCCESS=N` where N matches your matrix size means all checks pass.
Anything with `FAILURE=` is an outlier worth investigating.

## Drilling into a failure

```sh
gh pr checks <N> -R <owner>/<repo> --json state,name,link \
  | python3 -c "
import sys, json
for c in json.load(sys.stdin):
    if c['state'] == 'FAILURE':
        print(c['name'], '|', c['link'])"

# For a still-in-progress run, --log-failed returns nothing; use:
gh api repos/<owner>/<repo>/actions/jobs/<job-id>/logs | tail -100
```

## Pitfalls

- `gh pr checks --watch` waits even for queued checks. The
  one-shot summary sweep avoids that and gives a global view.
- **`gh pr checks <N>` text output uses tab/space-separated columns,
  but check names contain spaces** (e.g. `test (18.x, ubuntu-latest)`,
  `viable-release (24.x, ubuntu-latest)`).
  Do not pipe to `awk '{print $2}'` for the state column; the
  parenthetical lands in column 2 for matrixed checks and you get a
  meaningless `(18,` / `(20.x,` summary.
  Use `--json` against `pr view <N> --json statusCheckRollup` and
  jq-extract `.status` / `.conclusion`, e.g.
  ```sh
  gh pr view <N> -R <owner>/<repo> --json statusCheckRollup --jq \
    '[.statusCheckRollup[] | (if .status=="COMPLETED" then .conclusion else .status end)] | group_by(.) | map("\(.[0])=\(length)") | join(" ")'
  ```
  This treats each check name as one logical unit regardless of
  embedded spaces.
- The job logs API is silent during an in-progress run if the
  step's stdout is buffered. Wait for the step to complete before
  reading.
- Some matrices include a `viable-release (X.x, ubuntu-latest)`
  step that runs `lerna prepack`, which is the one most likely to
  surface lerna `ECYCLE` or workspace-cycle bugs. See
  `lerna-ecycle-fix.md`.
- `gh pr checks` rollup can briefly report stale results across
  SHAs right after a force-push: it may show "all SUCCESS" from the
  prior head before the new head's checks register. Cross-check
  with `gh api repos/<owner>/<repo>/actions/runs/<run-id>/jobs` for
  the specific run id when the count looks suspicious (e.g., 26
  SUCCESS within seconds of a push). Don't post a green-CI comment
  off the rollup alone; verify against the run's job list.
- The `/jobs` endpoint can momentarily report all jobs as
  `status=completed` mid-run (likely a re-runner / matrix re-expand
  artifact). When polling for "is the run done?", monitor the
  **run-level** `status=="completed"` instead of summing per-job
  states, e.g.:

  ```sh
  gh api repos/<owner>/<repo>/actions/runs/<id> --jq '.status'
  ```

  Only treat the run as terminal when the run object itself reports
  `completed`; then read `conclusion` for success/failure.
- Run-level `status` lags per-job state by a wide margin: the run sits
  at `queued` while half the matrix is `in_progress`, then flips to
  `in_progress` only near the end. Don't infer "stuck" from a stale
  run-level `queued`; cross-check with the `/jobs` rollup before
  diagnosing.
- The agent shell is zsh, not bash. zsh does **not** word-split
  unquoted parameter expansions by default, so a poll loop like
  `RUNS=$(gh api … --jq '.workflow_runs[].id'); for r in $RUNS; …`
  iterates **once** with `r` set to the entire multi-line string.
  Use a here-string with a `while read` loop instead:

  ```sh
  while IFS= read -r r; do
    [ -z "$r" ] && continue
    ...
  done <<< "$RUNS"
  ```

  Or splat with `=(...)` if you stay in zsh deliberately. The bug is
  invisible until you notice the loop body's `$r` contains newlines.

## Session example

This sweep ran on every autonomous-loop tick. The pattern caught
PR 70's lingering lint failure (an unnecessary fixture change
triggered `import/no-relative-packages`) and PR 71's lerna ECYCLE.
