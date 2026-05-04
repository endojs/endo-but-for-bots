# TODO comment link classification

## When to use

When auditing a codebase for TODO hygiene, you want to distinguish
TODOs that cite an issue (linked) from TODOs that are dangling
(unlinked) so the unlinked ones can be filed for tracking.

## What counts as linked

A TODO is **linked** if any of the following appears in the same
comment line or any contiguous comment line within the surrounding
block:

- `#NNNN` — bare GitHub issue/PR reference (one or more digits).
- `endojs/endo#NNNN` or `Agoric/agoric-sdk#NNNN` — qualified
  cross-repo reference.
- A full URL: `https://github.com/<owner>/<repo>/issues/<NNNN>`,
  `/pull/<NNNN>`, or `/discussions/<NNNN>`.
- A bug-tracker link with an issue id: `https://bugs.chromium.org/`,
  `https://issues.chromium.org/issues/`, `tc39/proposal-*#NNNN`.

A TODO is **ambiguous** if it cites a doc or external note rather
than a tracker (e.g., "see notes.md", "per the SDK design doc").
Worth a separate bucket so the maintainer can decide whether to
promote them to issues.

Match labels case-insensitively but only `TODO`, `FIXME`, `XXX`.
Skip `NOTE`, `HACK`, `OPTIMIZE` — they're informational, not
debt markers.

## Resolving the surrounding block

A "block" is the contiguous run of comment lines (`//` in JS/TS,
indented `*` inside JSDoc, `<!-- -->` in markdown) that contains the
TODO line. The link may be on the next line, not the same line.

```sh
grep -rEn --include='*.js' --include='*.ts' --include='*.md' \
  --include='*.cjs' --include='*.mjs' \
  -B 0 -A 3 \
  "\\b(TODO|FIXME|XXX)\\b" packages/ \
  > /tmp/todo-raw.txt
```

Then process programmatically: bucket each match into linked /
unlinked / ambiguous using regex, aggregate by package.

## Reclassification gotcha

`@ts-expect-error XXX <reason>` and friends are typing-debt
markers, not real TODOs. They show up in TODO grep results because
of the `XXX` substring. In a hygiene audit, **report them
separately** rather than counting them against the unlinked rate.
The session's audit found 38 such markers out of 324 unlinked
matches; reclassifying them lifts the linked rate from 10.7% to
about 14%.

## Session example

The `actual/master` audit produced
`process/UNLINKED-TODOS.md`: 365 blocks, 39 linked, 324
unlinked, 2 ambiguous. Top packages by unlinked count: `@endo/ses`
(60), `@endo/pass-style` (40), `@endo/patterns` (38), `@endo/daemon`
(34), `@endo/marshal` (34). The recommended follow-up is per-file
umbrella issues for the 32 files with three or more unlinked TODOs,
plus a CI rule that any new TODO must cite an issue.
