# Recalibrate velocity from observed history

## When to use

When refreshing the size and time estimates in `designs/README.md`,
or whenever a roadmap has drifted from reality and needs to be
recomputed from actuals.

## Inputs

- The set of designs marked `**Complete**` or `Implemented` in the
  README summary table.
- Each completed design's metadata block (`Created` / `Updated`).
- `git log --since=<earliest-created> --until=<now>` on the relevant
  branch (`actual/llm`, `actual/master`, or whichever line the work
  shipped on).
- The PR mirror at `changes/<N>.md` for cross-referencing the merged
  PRs that completed each design.

## Procedure

1. **Identify the observation window.** Pick the earliest `Created`
   date among the completed designs in scope and `today` as the
   ends.
2. **Count active work days.** `git log --since=… --until=… --format=%aI`
   piped through `awk '{print substr($1,1,10)}' | sort -u | wc -l`
   gives unique calendar dates with commits. That's the active-day
   denominator.
3. **For each completed design, compute LOC and elapsed days:**
   - LOC: `git log <range> -- packages/... | git diff --shortstat`
     summed across the design's files. For mixed-PR designs, use the
     merged PRs from `changes/` and sum their `+/-` totals.
   - Days: `Updated − Created` is the easy upper bound; if the
     design landed in fewer commits than that suggests, use the
     count of distinct commit dates touching the design's files
     instead.
4. **Bin the actuals into a small table** matching the README's
   "Completed reference points" section: feature, LOC, days,
   LOC/day. Do not invent new size buckets; use the existing
   S/M/L/XL classification.
5. **Compute median LOC/day per bucket.** Median, not mean: a
   single big day skews the mean. Five reference points per bucket
   is enough; if you have fewer than three, mark the bucket
   "preliminary" and don't update it yet.
6. **Compare to the previous calibration line in the README.** If
   velocity has moved by more than ±20%, update the size buckets'
   "Duration (1 dev)" column. Otherwise leave the buckets alone and
   only refresh the reference-point table.

## Output

A diff to `designs/README.md` § "Size and Time Estimates" that:

- Replaces the "Recalibrated on YYYY-MM-DD using observed velocity
  from N active work days (… – …) by one full-time developer."
  preamble with current numbers.
- Refreshes the "Completed reference points" table with the new
  actuals.
- Updates the "Key observations" bullets if a category's median has
  moved enough to warrant a re-characterization (e.g., what used to
  be ~500 LOC/day for cross-cutting daemon features is now ~700).
- Updates the "Recalibrated size categories" table only if the
  per-bucket medians moved meaningfully.
- Updates the "Progress as of YYYY-MM-DD:" footer at the bottom of
  § "Strategic Early Items".

## Pitfalls

- Don't include vendored sources, generated files, or yarn.lock in
  the LOC count. They are not the developer's work.
- Beware re-implemented designs (e.g., the Go → Rust pivot of
  `daemon-engo-supervisor`); count only the version that shipped.
- "Active work days" is calendar days *with commits*, not man-days.
  Multi-developer days still count as one active day.
- A design that was completed by merging an existing PR that already
  had several months of work in it should be excluded from velocity
  measurements. The completion date is artificial.

## Matching designs to PRs

The PR catalog has at least three patterns; check all of them when
binding a design to its merged PRs:

1. **Branch slug.** `design/<slug>`, `feat/<slug>`, `fix/<slug>` are
   the common shapes. The slug usually matches the design filename
   (without `.md`), but not always (e.g., `design/daemon-rename-to-manager`
   matches `daemon-rename-to-manager.md`; `feat/chat-rename-clear`
   matches `chat-rename-dismiss-to-clear.md`).
2. **Body `Refs:` line.** Implementation PRs typically open with
   `Refs designs/<slug>.md` or `Refs: #N`. The latter resolves to a
   prior design-only PR you then trace back to the design file.
3. **Re-opened-under-bot pattern.** PRs whose body starts with
   "Forwarded from #N under the bot per the re-open-under-bot
   pattern" point at an *original* PR (closed-unmerged) whose
   metadata holds the true creation date and slug. For elapsed-time
   purposes, use the original's creation date, not the bot
   re-opening's.

If a design ships in multiple PRs (a stack split, a design-only PR
followed by an impl PR, or an impl PR plus follow-up fix PRs), fold
them into one design's velocity by summing their elapsed times *and*
recording the union of PR numbers. Don't double-count overlap; use
`max(merged_at) − min(created_at)` of the set as a wall-clock proxy
when the PRs ran in parallel.

## Distinguish effort from queue time

Time-to-merge measures two very different things depending on the PR:

- **Implementation PRs (real code):** time-to-merge approximates
  effort, modulo CI flakes and review back-and-forth.
- **Design-only PRs (one or two `.md` files):** time-to-merge measures
  CI plus reviewer latency, not design effort.
  Don't pool design-only and impl PRs in the same ratio; report them
  separately.

When the in-flight queue is deep, *minimum elapsed since branch
creation* across open PRs gives a lower bound on completion time
that often dwarfs the per-PR effort estimate.
If the median open-PR-age is materially larger than any reasonable
per-design effort estimate, the binding constraint on the milestone
is review bandwidth, not author throughput.
Surface this as a separate "review queue carry" addition to the
milestone totals rather than folding it into per-design estimates.

## Reporting per-size ratios

Aggregate the actual / estimate ratio per size bucket (S, M, L, XL)
and report each separately.
A single overall median collapses bucket-specific signal: in practice
S-sized work tends to undershoot estimates while L and XL tend to
overshoot, and the recalibration multiplier should differ accordingly.
With a small N per bucket, prefer the median over the mean; report N
alongside each bucket's number so readers can see which buckets are
provisional.
