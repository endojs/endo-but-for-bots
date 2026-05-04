# Mirror an upstream PR for offline review

## When to use

When you want to conduct an extensive review of a PR on a repository
where you'd rather not post a noisy stream of comments — e.g., a
twelve-perspective panel review of an upstream PR. Mirror the PR's
branch to a controlled "bots" repository and review there.

## How

Assume the upstream PR is `endojs/endo#NNNN` on branch
`<upstream-branch>`, and a mirror repo is `endojs/endo-but-for-bots`
configured as the `bots` remote.

```sh
git fetch actual <upstream-branch>
git worktree add <path> actual/<upstream-branch>
cd <path>
git switch -c <upstream-branch>-mirror   # avoid local cache collisions

git push bots HEAD:<upstream-branch>     # push to bots, same name

gh pr create -R endojs/endo-but-for-bots \
  --base master --head <upstream-branch> \
  --title "<original title> [mirror of endojs/endo#NNNN]" \
  --body "..."
```

The PR body should:

1. Open with "Mirror of upstream PR `endojs/endo#NNNN` by @<author>
   for in-organization offline review."
2. Reproduce the upstream PR's description.
3. End with "Reviewers: relay any actionable findings to the
   upstream PR. This mirror is review-only and will not be merged."

## Constraints

- Do not modify any commits on the mirror branch. The mirror tip
  must equal the upstream PR's tip exactly. Verify with:
  ```sh
  git rev-list --count actual/<branch>..bots/<branch>   # both 0
  git rev-list --count bots/<branch>..actual/<branch>
  ```
- Do not address the panel's feedback on the mirror PR. That's the
  upstream author's call.
- See `ssh-fallback-workflow-scope.md` if the push fails because the
  branch's older base touches `.github/workflows/*.yml`.

## Session example

PR 76 mirrored `endojs/endo#3053` (gibson042's
`gibson-3046-narrow-rankcover`) for a 12-perspective panel review.
The orchestrator confirmed `git rev-list --count` was zero in both
directions before posting the panel report.
