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
