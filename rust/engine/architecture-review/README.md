# IronHorse architecture reviews

Point-in-time architecture reviews of the IronHorse engine (`rust/engine`).

Each review lives in its own directory named by the date it was published, and
is pinned to the commit it was conducted against.
A review is a **snapshot, not a living document**: it is not updated as the
engine changes, so its findings and line numbers age.
Read every citation against the commit named in the table below, not against
the current tree:

```sh
git show 97d8de25:rust/engine/ironhorse-vm/src/interp.rs | sed -n '10938,10960p'
```

## Reviews

| Published | Reviewed commit | Scope | Findings | Review |
|---|---|---|---|---|
| 2026-09-06 | [`97d8de25`](https://github.com/endojs/endo-but-for-bots/commit/97d8de25) | `rust/engine`, plus `rust/endo/ironhorse-store-sqlite` and `rust/endo/src/ironhorse_engine.rs` | 191 verified: 6 critical, 57 high, 73 medium, 55 low | [2026-09-06](2026-09-06/ARCHITECTURE-REVIEW.md) |

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
Do not edit a previous review to reflect later changes to the engine; supersede
it with a new one, so the record of what was true at each commit stays intact.
