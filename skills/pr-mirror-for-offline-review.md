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

## Sibling shape: working mirrors that iterate

The dispatch shape this skill describes is the **strict review-only
mirror**: panel posts, findings relay upstream, no follow-up commits
on the mirror, mirror closes. A distinct shape exists for the case
where the maintainer wants the mirror to iterate as a real PR
(addressing feedback, shepherding CI, eventually cherry-picking the
fix-commit chain back to upstream): the **working mirror**. The
constraints in this skill's "Constraints" section above ("Do not
modify any commits", "Do not address the panel's feedback") apply
**only** to the review-only mirror. For the working mirror:

- The **base** of the mirror branch still equals the upstream tip
  (so cherry-picks back are trivial). New commits go ON TOP, never
  as a force-push that rewrites the upstream tip's bytes.
- The panel + saboteur findings are addressed via follow-up commits
  on the mirror branch. The maintainer of the upstream PR can then
  pull the mirror's tip back upstream as the PR's new head, or
  cherry-pick individual fix commits.
- The mirror lives until the upstream PR merges or is otherwise
  resolved, then closes with a "superseded by upstream merge" note.

See [`../roles/builder.md`](../roles/builder.md)'s
"Working-mirror dispatch is distinct from the strict review-only
mirror" posture for the full lifecycle and the load-bearing
local-pre-PR-checklist guidance (CI may not auto-fire on a mirror
branch whose head SHA is inherited from upstream, so the local
checklist is the substitute, not just a convenience).

## Session example

PR 76 mirrored `endojs/endo#3053` (gibson042's
`gibson-3046-narrow-rankcover`) for a 12-perspective panel review
under the strict review-only shape. The orchestrator confirmed
`git rev-list --count` was zero in both directions before posting
the panel report.

PR 114 mirrored `endojs/endo#3152` (erights's
`markm-compartment-mapper-errors`) under the working-mirror shape;
the panel report posted with a sibling-fork-misses-peer-fix finding
and the saboteur surfaced two real concerns (Symbol-coercion in
`assertConditions`, redaction-defeat in `assertEmptyObject`); both
sets of findings are intended to be relayed to the upstream PR's
maintainer or addressed via follow-up commits on the mirror tip.
