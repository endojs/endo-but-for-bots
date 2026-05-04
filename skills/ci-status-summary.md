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
- The job logs API is silent during an in-progress run if the
  step's stdout is buffered. Wait for the step to complete before
  reading.
- Some matrices include a `viable-release (X.x, ubuntu-latest)`
  step that runs `lerna prepack`, which is the one most likely to
  surface lerna `ECYCLE` or workspace-cycle bugs. See
  `lerna-ecycle-fix.md`.

## Session example

This sweep ran on every autonomous-loop tick. The pattern caught
PR 70's lingering lint failure (an unnecessary fixture change
triggered `import/no-relative-packages`) and PR 71's lerna ECYCLE.
