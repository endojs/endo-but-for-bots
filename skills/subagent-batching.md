# Subagent batching

## When to use

When the same kind of work needs to be done across N independent
items (PRs to review, files to summarize, issues to triage), split
the items into batches and dispatch one subagent per batch in
parallel.

## How

1. Build batch lists as text files, one path per line:

   ```sh
   ls changes/*.md | sort -t/ -k4 -n > /tmp/all.txt
   total=$(wc -l < /tmp/all.txt)
   batches=12
   per=$(( (total + batches - 1) / batches ))
   for i in $(seq 0 $((batches-1))); do
     sed -n "$((i*per+1)),$(((i+1)*per))p" /tmp/all.txt \
       > /tmp/batch-$((i+1)).txt
   done
   ```

2. Dispatch agents in waves of 3–5 (most harnesses cap concurrency
   below 12). Each agent gets:
   - Its batch list path.
   - The exact transformation contract (one paragraph).
   - Style rules (tag vocabulary, format).
   - Reporting requirements (counts, surprises).

3. Tell each agent to skip files it has already processed (idempotent
   re-entry) so a partial wave can be retried.

4. After all waves finish, validate completeness:

   ```sh
   total=$(ls <out-dir>/*.md | wc -l)
   complete=$(grep -L "^## Summary\\(\r\\)\\?$" <out-dir>/*.md | wc -l)
   ```

   The `\r` alternative catches CRLF false-positives.

## Pitfalls

- Don't dispatch all 12 at once if the harness throttles to 4. The
  later waves' results may take longer to come back than necessary
  because the throttle queue is FIFO and sub-tasks share token
  budgets.
- Each batch's prompt should be **self-contained**. Agents don't
  share a working memory.
- Provide a controlled vocabulary for any tags or labels the agents
  attach, otherwise grep-based queries on the result are noisy.
- Heavy file-write tasks across batches benefit from a small Python
  helper script (regex substitution into JSONL or markdown) to bulk-
  apply changes; agents can write that helper themselves and reuse
  it across files.

## Session example

The 2127-PR change-mirror summarization split the work into 12
batches of ~178 files. Three waves of 4 agents covered the whole
corpus in roughly 70 minutes. Several agents wrote their own
`/tmp/insert-summaries.py` helpers to apply the same regex insertion
across their batch.

The 10-issue parallel implementation pass dispatched 10 agents
simultaneously, each on a worktree off `actual/master`, each
opening one PR.
