# IronHorse architecture reviews

Point-in-time architecture reviews of the IronHorse engine (`rust/engine`).

Each review lives in its own directory named by the date it was published, and
is pinned to the commit it was conducted against.
A review's **analysis is a snapshot**: its findings, line numbers and quotations
describe the commit it was written against and are not rewritten as the engine
moves on.
What a review may gain is a **revision**: a re-verification pass that records,
per finding, whether it is still open at some later commit, without restating
the original analysis.
Both commits are then named, in the table below and in the review's own
metadata, and the review says which findings the revision closed.
Read every citation against the reviewed commit, not against the current tree:

```sh
git show 97d8de25:rust/engine/ironhorse-vm/src/interp.rs | sed -n '10938,10960p'
```

## Reviews

| Published | Reviewed commit | Last revised | Scope | Findings | Review |
|---|---|---|---|---|---|
| 2026-09-06 | [`97d8de25`](https://github.com/endojs/endo-but-for-bots/commit/97d8de25) | 2026-09-06 against [`f109e8f4`](https://github.com/endojs/endo-but-for-bots/commit/f109e8f4): 10 fixed, 11 partially fixed, 170 still open | `rust/engine`, plus `rust/endo/ironhorse-store-sqlite` and `rust/endo/src/ironhorse_engine.rs` | 191 verified: 6 critical, 57 high, 73 medium, 55 low | [2026-09-06](2026-09-06/ARCHITECTURE-REVIEW.md) |

## What a review directory contains

| Path | Contents |
|---|---|
| `<date>/ARCHITECTURE-REVIEW.md` | The review: architecture as built, findings by theme, and a sequenced program of work. Start here. |
| `<date>/README.md` | Index of that review's companion documents, and its method. |
| `<date>/lenses/*.md` | One report per architectural concern, verbatim, with the reviewers' executable probes. |
| `<date>/maps/*.md` | One map per region of the tree, verbatim, each recording what its reader did not read. |

The summary is self-contained.
The lens reports and region maps are kept as evidence: they carry the
mechanism-level detail and the raw candidate findings, including leads that did
not survive verification.

## Adding a review

Create `rust/engine/architecture-review/<YYYY-MM-DD>/` with the layout above,
and add a row to the Reviews table naming the commit reviewed and the finding
counts.
Do not rewrite a previous review's analysis to match a newer engine: supersede
it with a new review, so the record of what was true at each commit stays
intact.

## Revising a review

When the engine has moved but a fresh review is not warranted, revise the
existing one rather than letting it rot: re-verify each finding against the new
commit, and record per finding whether it is fixed, partially fixed or still
open.
Keep the original analysis, claims and line numbers as written; add the new
status alongside them, and note the revision date and base commit in the
review's metadata, in its Revision history, and in the Reviews table above.

Two rules make a revision trustworthy.
Keep the severities the original verification settled on, changing them only
where a finding is fixed: a re-verification pass is one judgement, and silently
re-rating findings against it inflates the review.
Say what the revision did not do, since a revision is not a re-review and finds
nothing new in surfaces added since.
