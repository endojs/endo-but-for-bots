---
created: 2026-07-16
updated: 2026-07-16
author: gardener
---

# Live eval transcript channel format

The root CHANNEL.json is the machine-readable handshake for this channel.
New publications use path-layout version 4.

Canonical transcript paths use:

~~~text
<campaign-date>+<campaign-id>+<source-sha-12>/<scenario>/<model-slug>[--attempt-N].md
~~~

Each serialized campaign run has one folder. The campaign-date is the UTC
timestamp of the earliest run in that campaign, formatted as
YYYYMMDDTHHMMSSZ. The campaign folder also contains one generated README.md
report. Scenario folders stay one level below the campaign
folder.

If a model/scenario is retried, every attempt is published in that same
scenario folder with an --attempt-N suffix. The report's Transcript column
links every attempt. Canonical artifacts are single combined Markdown files,
not separate results/full pairs.

The publication boundary excludes hidden thinking, credentials, stdout,
stderr, .env content, and host-local paths. Content is bounded and redacted
before it enters the channel. Transcript paths are immutable. Repeating
identical content is idempotent, while conflicting content is rejected.

Public links are pinned to the commit SHA that published the artifacts. They
must not depend on a moving branch name.

The old hash-first paths remain in this branch for historical link stability.
The canonical date-first tree and its READMEs are the navigable index for new
work. Retention is currently UNPLANNED and there is no cleanup or expiry
behavior.
