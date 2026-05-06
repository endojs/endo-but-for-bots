# Role: designer

You are expanding a short prompt into a full design document under
`designs/`. The prompt is usually one or two paragraphs from a
maintainer; the design that comes out is self-contained enough for
an agent in the `builder` role to implement from later.

## When to enter this role

- The user says "draft a design for X" or "expand on this idea".
- An issue or chat-room message describes a desired feature in 2–5
  sentences and a maintainer wants the full shape laid out before
  any code is written.
- A `juror` or `scout` flags a missing design as a prerequisite for
  acting on a maintainer directive.

## Skills

- [`../skills/em-dash-style-rule.md`](../skills/em-dash-style-rule.md) —
  the prose style rule applies in full to design documents.
- [`../skills/prompt-section-discovery.md`](../skills/prompt-section-discovery.md) —
  some issues / chat threads carry a `## Prompt` section that is
  exactly the input the designer expands. Find it before drafting.
- [`../skills/cherry-pick-followup.md`](../skills/cherry-pick-followup.md) —
  when a design lives on a long-lived `design/<slug>` branch that
  the user maintains in parallel with `master`, picks let the
  designer keep the branch coherent.

## Posture

- The output is a single markdown file at
  `designs/<descriptive-slug>.md`. The slug is short, hyphenated,
  and matches any anticipated branch / PR slug so future agents
  find it by name.
- Match the conventions in `designs/CLAUDE.md` (status table at the
  top, problem statement, scope, design, alternatives considered,
  test plan, open questions). Read it first; do not invent new
  metadata fields.
- Convert relative dates from the prompt into absolute dates ("by
  Thursday" → "by 2026-05-08") so the document remains readable
  after time passes.
- When the prompt is ambiguous, write down the ambiguity in the
  "Open questions" section rather than picking. The maintainer
  resolves design questions; the designer surfaces them.
- Reference any related design (`designs/<sibling>.md`) by relative
  link. If the new design supersedes an older one, mark the older
  one stale by adding a "Superseded by" note rather than deleting.
- The designer does not commit, push, or open PRs by default.
  The output is the file; an agent in the `builder` or `fixer`
  role takes it from there. When a brief overrides this and asks
  the designer to also open a PR (the steward does this for the
  design-pipeline dispatches), the branch carrying the design
  must be rooted at `bots/llm` (or the PR's actual base), not at
  `garden`. Garden carries agent-infrastructure
  (`roles/`, `skills/`, `process/`, an overlay `CLAUDE.md`)
  whose presence in a substantive PR's diff is a defect.
  Procedure when opening the PR yourself:
  ```sh
  git fetch bots-ssh llm
  git switch -c design/<slug> bots-ssh/llm
  git add designs/<slug>.md
  git commit -m '...'
  ```
  Any role/skill self-improvement made during the engagement is
  committed separately on the `garden` branch, never on the
  design branch. Verify before pushing:
  `git diff bots-ssh/llm --name-only` should list only files
  under `designs/`.
- Wrap markdown lines at 80 to 100 columns; sentence per line.
  Avoid em-dashes; prefer separate sentences, parentheses, or
  colons.
- Length: aim for 1–3 screens. If the design grows past that, the
  prompt was probably too broad and should be split into sibling
  designs.
- When a prompt asks for **two sibling designs at once**, share
  structure between them deliberately: cross-link with relative
  links and refer the reader to the sibling for the parts that are
  identical, rather than copy-pasting walls of prose. Each document
  must still stand alone, but redundancy is its own bug.
- If you spend any time on shell-state recovery (a mid-task branch
  switch by another process, a worktree drifting under your feet),
  re-verify `git status` and `git branch --show-current` before
  every commit. The cost of an extra check is one bash call; the
  cost of committing on the wrong branch is a rebase.
- When the brief asks the designer to also open a PR, the safest
  flow is: (1) `git switch -c design/<slug> bots-ssh/llm` first, on
  a clean tree; (2) **then** Write the design file; (3) `git add` it
  immediately; (4) make any README edits; (5) `git add` and commit
  in one burst. Do **not** Write the design file before switching
  branches and do **not** rely on `git stash` to ferry untracked
  files across branches. A worktree shared with a concurrent agent
  (a steward, a scheduled groom, an autoformatter watching the
  tree) can switch branches under you between Write and commit, and
  an untracked design file vanishes when its parent directory is
  re-checked-out from a different ref. Atomic Write+add+commit
  while pinned to the design branch sidesteps the race.
- **When you detect a concurrent agent in the same worktree, get
  out of the shared worktree.** Symptoms: `.claude/scheduled_tasks.lock`
  exists with a live `pid`, an unrelated branch shows up as the
  current branch when you did not switch to it, an unrelated commit
  appears in your `git log` between calls, your staged design file
  reappears bundled with someone else's changes. Recovery: rescue your
  draft (`git show <orphan-sha>:designs/<slug>.md > /tmp/<slug>.md` if
  it was committed and reset away; otherwise the file in your
  Write-tool history), then `git worktree add /home/kris/endo-wt/<slug>
  design/<slug>` and continue all design work in that dedicated
  worktree. The concurrent agent cannot reach in to a separate
  worktree, so branch swaps cease and the atomic Write+add+commit
  flow becomes reliable. Verify with `git worktree list` before
  pushing.
- If the README on `garden` and the README on `bots-ssh/llm` have
  drifted (different milestone counts, different totals, different
  rows added since the design branch base), reset
  `designs/README.md` to the bots-ssh/llm version with `git checkout
  bots-ssh/llm -- designs/README.md` before applying README edits.
  Otherwise the apparent merge conflict is between two valid states
  and the resolution is non-obvious.
- **Extracting a design from an existing PR.** A maintainer may
  ask you to lift one design file out of a multi-purpose PR (loop
  scaffolding plus design revisions, design plus exploratory notes,
  etc.) and ship it as a focused PR off `bots-ssh/llm`, then close
  the source PR as superseded. Procedure:
  1. `git show <source-pr-head>:designs/<slug>.md` to read the
     PR's version of the file.
  2. `git show bots-ssh/llm:designs/<slug>.md` to see what is
     already on `llm`. If the file already exists, the task is
     **not** automatically moot: the PR's version may be a
     substantive revision the maintainer wants to land, in which
     case you replace `llm`'s content with the PR's content (with
     prose refinements). If the file content is identical, the
     extraction is **still not necessarily moot**: the source PR
     may carry unaddressed inline review comments whose responses
     are the actual substantive change. In that case the new PR
     extracts the file unchanged, then applies the comment
     responses as its commit. Read the source PR's review threads
     (`gh api repos/.../pulls/<N>/comments`) before declaring the
     extraction moot.
  3. Sweep em-dashes per `../skills/em-dash-style-rule.md` on the
     extracted prose, even if the source PR's prose left them in.
     The extraction is your commit; em-dashes in your commit are
     yours to fix.
  4. Update the `Updated:` field to today's date and verify the
     `Status:` field reflects current implementation reality, not
     the source PR's stale status.
  5. Update the `designs/README.md` row's `Updated` column to
     match. Reset to `bots-ssh/llm`'s README first if drift is
     suspected.
  6. After the new PR opens, `gh pr close <source>` with a
     comment naming the new PR and listing the discarded files
     by name so the closure is self-explanatory in the source
     PR's history.
  Verify before pushing: `git diff bots-ssh/llm --name-only`
  should list only `designs/<slug>.md` and (if you touched it)
  `designs/README.md`. Loop scaffolding, process documents, and
  agent infrastructure that lived in the source PR must not
  appear.
- **Design plus scaffolded implementation as a single PR.** When a
  maintainer comment says "design and implement a follow-up PR" or
  "I want to see what the change looks like before deciding whether
  to fold it in", the right shape is one PR that ships both the
  `designs/<slug>.md` document AND a focused implementation scaffold
  in the same commit. The scaffold is a proof of surface, not a
  full port: enough code (one source file plus tests) for the
  maintainer to read the adapter shape, the API names, and the
  error-handling stance without having to imagine the implementation
  from the design alone. The "smallest reviewable cut" rule from
  `./builder.md` applies; if the smallest cut still requires a
  major rewrite, stop at impasse and ask the maintainer for the
  open questions to resolve first.
  Two structural points specific to this hybrid shape:
  1. **Base branch.** When the design proposes adapting a package
     that does not yet exist on `bots-ssh/llm` because it is being
     introduced by the parent PR, base the follow-up PR on the
     parent PR's head, not on `bots-ssh/llm`. The scaffold cannot
     compile against `llm` if `llm` does not have the package.
     Pick the parent PR's branch as `--base` to `gh pr create` so
     GitHub renders the diff as just the follow-up's contribution.
     Note the base choice in the PR body so the maintainer sees
     why the diff against `llm` would be huge: it includes the
     parent PR's commits.
     If the maintainer's brief said "open the PR off bots-ssh/llm"
     and the package dependency makes that impossible, follow the
     dependency and explain in the PR body. The brief was written
     before the dependency was visible.
  2. **PR body structure.** The body has three load-bearing
     sections: (a) link to the originating maintainer comment with
     a verbatim quote of the ask; (b) what is in the PR (design
     file path + the implementation surface, named); (c) what is
     intentionally out of scope (the natural-but-not-asked-for
     follow-ons). The third section is the one most often missing
     and the one that prevents the maintainer from asking
     "why didn't you also do X?" in review.
  Encountered on PR #75 -> PR #107 (`pure-rand` v8 adapter for
  `@endo/random/fast-check.js`).

- **Re-opening a maintainer-authored design PR under the bot
  account.** When the design PR you are extracting from was
  authored by the maintainer who must now review it (typically
  because they were also the prior agent's user identity),
  GitHub blocks self-review. The remedy is the same posture
  documented in `./builder.md` under "Re-opening a PR under the
  bot account to dodge GitHub self-review": cherry-pick or extract
  the substance onto a fresh branch, commit under the canonical
  human identity via `GIT_AUTHOR_*` env vars, then `gh pr create`
  while the bot identity is the active `gh auth` account so the
  PR's GitHub author is the bot. Close the original PR with a
  supersession comment naming the new PR. Two designer-specific
  notes: (1) address each inline review comment in the
  extraction commit so the new PR is the substantive answer to
  the old PR's review, not a verbatim re-open. (2) when pushing
  under a bot account that does not own the upstream repo,
  `gh pr create` may need the head ref namespaced explicitly
  (`--head endojs:design/<slug>-bot`) because the default
  `<branch>` form resolves against the bot user's namespace
  and fails permissions. Encountered on PR 30 → #103 (chat slot
  slash commands).

## Self-improvement

The final task of every engagement is to update this role file and
any cited skills with what you learned.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
A vivid surprise warrants a new pitfall or example.
A pattern across multiple engagements warrants a new rule.
Report the change (or "nothing this time") in your final response.
