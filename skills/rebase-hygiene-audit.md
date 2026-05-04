# PR rebase-hygiene audit

## When to use

When asked "are our open PRs cleanly stacked on master?", a
batch audit per PR with three small `git` calls produces a
maintainer-actionable report.

## Per-PR probes

```sh
git fetch <remote> <base> <head>      # only what's needed

mergebase=$(git merge-base <remote>/<base> <remote>/<head>)
behind=$(git rev-list --count <remote>/<head>..<remote>/<base>)
ahead=$(git rev-list --count <remote>/<base>..<remote>/<head>)
merges=$(git rev-list --count --merges <remote>/<base>..<remote>/<head>)

# Conflict probe (modern git):
if git merge-tree --write-tree <remote>/<base> <remote>/<head> \
     >/dev/null 2>&1; then
  conflicts=clean
else
  conflicts=conflicts
fi
```

Interpret:

- **green** — `behind == 0` and `merges == 0`. Already perfectly
  stacked.
- **needs-rebase** — `behind > 0` and `conflicts == clean`. A
  `git rebase <base>` would land cleanly with no human input.
- **needs-rebase-with-conflicts** — `behind > 0` and `conflicts ==
  conflicts`. The author must resolve.
- **has-merge-commits** — `merges > 0`. The author merged base into
  branch instead of rebasing.
- **base-not-on-remote** — the base branch doesn't exist on the
  audit remote (a stacked-PR scenario whose parent's PR was merged
  or closed).

## Bulk-fetching to limit overhead

60 PRs × 5 fetches each is fine; 60 × `git fetch --all` is not. Get
the list of refs first:

```sh
gh pr list -R <owner>/<repo> --state open --limit 200 \
  --json number,baseRefName,headRefName \
  > /tmp/prs.json
```

Then `git fetch <remote> <ref1> <ref2> ...` in batches of ~50.

## Output

Write a markdown report grouped by category, with a summary table at
the top. End with 2–3 sentences of recommendations: which PRs to
rebase first, whether the merge-commit PRs need author intervention,
whether any stacked-base situations should be cleaned up.

## Pitfalls

- The audit is **read-only**. Do not push or rebase. Recommendations
  go to the maintainer; the author or a follow-up agent applies
  them.
- Long-lived feature branches with intentional merges (e.g., `endor`
  on this project) will look like "has-merge-commits" but should not
  be rebased. Flag them as anomalies.
- Some Dependabot PRs are 700+ commits behind because the bot
  doesn't auto-rebase; for those, recommend "dependabot recreate"
  rather than manual rebase.

## Session example

Audited 60 open PRs on `endojs/endo-but-for-bots` and produced
`process/PR-REBASE-AUDIT.md`. Headline counts: 16 green,
36 needs-rebase (clean), 6 needs-rebase-with-conflicts, 2 has-merge-
commits, 0 base-missing. Top targets to rebase first: 16 `review/*`
PRs all 51 behind `bots/llm` (clean) plus 4 Dependabot PRs 717
behind (clean).
