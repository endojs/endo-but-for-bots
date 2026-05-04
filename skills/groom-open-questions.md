# Leave open questions for the user

## When to use

When the `groom` (or any other role) encounters a roadmap question
the role cannot resolve unilaterally — re-prioritization,
unclear status, contradicting design metadata, or a missing
estimate.

The goal: leave a structured note the user can answer at their
next interactive turn without re-deriving the context.

## Where the note lives

`process/GROOM-OPEN-QUESTIONS.md` at the triage root.
One file, appended to over time.
The most recent grooming pass is at the top; older passes follow.
Ship updates in process commits per
[`process-documents.md`](./process-documents.md).

## Format

```markdown
# Open questions for the user

Latest grooming pass: <UTC timestamp>.

## <YYYY-MM-DD> grooming pass

<one-paragraph context: what triggered this pass, how many
designs were reviewed, what changed in the README>

### Re-prioritization candidates

- **<design-slug>** — <why it is a candidate, e.g. its prerequisite
  shipped two weeks early; the user's recent commits suggest interest
  shifted; M3 has bandwidth>.
  Recommended action: <move to M2 / hold in M3 / drop entirely>.
  Awaiting decision.

### Status drift

- **<design-slug>** — README says `<status>`, design file says
  `<other-status>`, last commit touching the package was on
  `<date>`. Which is correct?

### Missing or stale estimates

- **<design-slug>** — no estimate in § Per-Design Estimates.
  Suggested: `<size>` (`<duration>`) based on similarity to
  `<reference design>`.  Awaiting confirmation.

### Roadmap shape

- <free-form: should M5 be split? Should we collapse M3 and M4
  given recent re-ordering? Should EndoClaw items move earlier?>
```

## Procedure

1. Open `process/GROOM-OPEN-QUESTIONS.md` (create if missing).
2. Insert a new dated section at the top.
3. For each unresolved question, write one bullet that names the
   design (or the cross-cutting concern), states what the
   ambiguity is, and includes a recommended action so the user
   can sign off in one word ("yes" / "no" / "pick A").
4. If the same question appears in a later pass, **don't
   duplicate it**. Update the existing entry's date in place and
   append a "still pending as of <date>" note.

## Pitfalls

- Don't ask the user to verify something the role could verify
  itself. The note is for genuinely human decisions
  (prioritization, vision), not for "I was too lazy to grep".
- Keep each question to under 80 words. The user reads this
  inline; long entries get skipped.
- Resolve old entries when the user answers them. Move the
  resolved bullet into a "Resolved" subsection at the bottom of
  the dated section, prefixed with the date and the user's
  answer in one sentence. Don't delete; the audit trail is
  useful when the same question recurs.
- If an answer requires a decision the user has already made
  elsewhere (chat, an issue, a previous grooming pass), cite it
  rather than re-asking.
