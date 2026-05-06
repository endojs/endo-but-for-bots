# Self-improvement at the end of an engagement

## When to use

The final task of every role engagement, before reporting back to
the user.
The discipline turns one-off observations into durable role and
skill content so the next engagement starts from a stronger base.

## What to look for

While the engagement is fresh, scan the run for any of:

1. **A gotcha that surprised you.** A failure mode the existing
   skill or role file did not warn about, or that contradicted
   what it claimed.
2. **A technique you derived from scratch.** A short procedure or
   command sequence you wrote in-line that another role could
   reuse.
3. **A skill the role did not cite that turned out to be useful.**
   Add it to the role's `## Skills` list with a one-line "why".
4. **An outdated or wrong example.** A session example whose
   referenced PR / commit / file no longer matches reality, or
   where the lesson has shifted.
5. **A new role.** If the engagement felt like a posture none of
   the existing roles cover, draft one.
6. **Overlap or contradiction between roles or skills.** Two
   places saying different things about the same operation.

## What to update

- The role file you ran under (`roles/<name>.md`).
- Each cited skill, if it gained a pitfall or example.
- Add a new skill at `skills/<slug>.md` if the technique is
  reusable across roles.
- `roles/README.md` and root `CLAUDE.md` only when a role is
  added, removed, or renamed.

## Threshold for landing a change

- **One vivid observation** is enough to add a pitfall or example.
- **A pattern across ≥3 engagements** is required to add a new
  rule or law that constrains future work.
- **Removing or rewriting** an existing rule needs explicit user
  direction, not just one engagement's evidence.

## How to write the change

- Match the voice of the existing file. Terse, imperative,
  declarative; no em-dashes (per the project rule).
- Preserve audit value: don't delete a session example that's
  still accurate just because there's a fresher one. Add the
  fresher one alongside.
- Keep skill files at 1–2 screens. If a skill is growing past
  two screens, refactor: split into two skills, or move
  reference material into a sibling note.
- Skill content is canonical. Role files cite skills by relative
  path. Don't copy skill prose into a role file; link to it.

## Output

A one-line entry in the engagement's final report:

```
Self-improvement: <changed file 1>, <changed file 2>; <one-line
summary of why>.
```

If nothing was learned, write:

```
Self-improvement: nothing this time.
```

The "nothing this time" line is intentional. It signals that the
role considered self-improvement and decided no change was
warranted, which is meaningfully different from forgetting the step.

## Pitfalls

- **Premature rules.** A new "law" added on one engagement's
  evidence is usually wrong. Wait for the pattern.
- **Skill bloat.** Resist the urge to append every small
  observation. After a long arc, refactor: split overgrown
  skills, prune stale examples, consolidate duplicate rules.
- **Voice drift.** Different agents write differently. Match the
  surrounding text's tone; a role file written terse-imperative
  shouldn't suddenly contain a chatty paragraph.
- **Ghost references.** When you delete a rule or skill, grep for
  references to it in role files and other skills. Stale links
  defeat the indirection.
- **Updating the role you're not in.** If a finding belongs in a
  sibling role's file, write the change as a recommendation in
  the engagement report instead of editing across roles. The next
  engagement under that role can apply it.
