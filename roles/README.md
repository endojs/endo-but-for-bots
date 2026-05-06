# Roles

A "role" is a posture an agent takes for a particular task.
Each file in this directory describes one role, lists the skills
that role draws on, and explains when to enter the role.

A single agent dispatch will usually map to one role; a long-running
maestro will pass through several.

The roles below are not exclusive.
A juror responding to feedback on a panel they themselves ran is
playing both `juror` and `fixer`; consult both.

## Index

- [builder.md](./builder.md) — implement a change from an issue or
  spec and get it through CI.
- [cleaner.md](./cleaner.md) — maximize coverage on a target
  package; write tests for reachable code or delete unreachable
  code.
- [conductor.md](./conductor.md) — drain the steward's merge
  queue one PR at a time: rebase, tidy, validate CI, merge.
- [designer.md](./designer.md) — expand a short prompt into a full
  `designs/*.md` document.
- [juror.md](./juror.md) — conduct a review of someone else's
  PR, alone or as part of a panel.
- [fixer.md](./fixer.md) — address review feedback on an
  open PR.
- [groom.md](./groom.md) — maintain the roadmap in
  `designs/README.md`: recalibrate estimates, re-project
  milestones, refresh the dependency graph.
- [triager.md](./triager.md) — classify or audit a batch of issues
  or PRs, build navigation aids.
- [investigator.md](./investigator.md) — investigate code or repo
  hygiene (TODOs, AST coverage, rebase state) across the tree.
- [liaison.md](./liaison.md) — manage issues on
  endo-but-for-bots: read every contributor comment, reply
  with the action taken, track per-issue posture under
  `process/tracking/<N>.md`.
- [namer.md](./namer.md) — choose a name (function, package,
  flag, branch) against the project's house naming guide.
- [saboteur.md](./saboteur.md) — propose gotcha test cases that
  attack a module's claimed invariants.
- [scout.md](./scout.md) — investigate a performance
  tradeoff with numbers.
- [shepherd.md](./shepherd.md) — keep CI healthy across many
  in-flight PRs.
- [steward.md](./steward.md) — periodically review the bot-PR
  estate and dispatch the right role per PR; tracks state in
  `process/` files across context clears.
- [stratego.md](./stratego.md) — own the upstream-port plan;
  cluster llm-vs-master substance into a linear stack proposal,
  iterate as both branches advance.
- [weaver.md](./weaver.md) — rebase or merge a branch onto a
  fresh base; resolve conflicts by reading both sides.
- [maestro.md](./maestro.md) — dispatch subagents,
  aggregate their work, pace autonomous loops.

The skill files are at [`../skills/`](../skills/).
Each role file references skills by relative path so an agent in the
role can read them inline.

## Self-improvement

Every role's final task is the same: update its own role file and
any cited skills with what was learned during the engagement.
See [`../skills/self-improvement.md`](../skills/self-improvement.md)
for thresholds and discipline.
This is what keeps the role and skill libraries useful instead of
drifting from reality.
