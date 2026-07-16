---
created: 2026-07-16
updated: 2026-07-16
author: gardener
---

# Live eval transcript channel format

The root CHANNEL.json is the machine-readable handshake for this fresh
transcript channel. This branch uses path-layout version 1.

Canonical paths use:

~~~text
<campaign-date>+<campaign-id>+<source-sha-12>/<scenario>/<model-slug>[--attempt-N].md
~~~

There is one campaign folder per serialized campaign run. The campaign date
is UTC, formatted as YYYYMMDDTHHMMSSZ, and is the timestamp of the earliest
run in that campaign. Each campaign folder contains one README.md report and
scenario folders one level below it.

Retries stay in the same campaign and scenario folder with an --attempt-N
suffix. The report Transcript column links every attempt. Each canonical
transcript is one combined Markdown file, not a separate results/full pair.

The publication boundary excludes hidden thinking, credentials, stdout,
stderr, .env content, and host-local paths. Content is bounded and redacted
before publication. Public transcript links are pinned to the commit that
published the artifacts.

This is a fresh v1 tree containing four campaigns. Older publication histories
are preserved in the backup refs orphan/eval-transcripts-backup-20260716 and
orphan/eval-transcripts-v4-backup-20260716. Retention is currently UNPLANNED.
