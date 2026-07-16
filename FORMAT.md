---
created: 2026-07-16
updated: 2026-07-16
author: gardener
---

# Live eval transcript channel format

The root `CHANNEL.json` is the machine-readable handshake for this channel. It
identifies the channel, its branch, and the path-layout version.

Transcript paths use:

```text
<source-sha-12>+<run-id>/<scenario>/<model-slug>-results.md
<source-sha-12>+<run-id>/<scenario>/<model-slug>-full.md
```

The exact source SHA remains authoritative in artifact metadata and links. The
results file is a compact, redacted summary that links to the full observable
transcript with a relative link. The full file contains captured user and
assistant prose, execute submissions, tool results, errors, and clearly
numbered turn sections.

The publication boundary excludes hidden thinking, credentials, stdout,
stderr, and host-local paths. Content is bounded and redacted before it enters
the channel. Transcript paths are immutable. Repeating identical content is
idempotent, while conflicting content is rejected.

Public links are pinned to the commit SHA that published the artifacts. They
must not depend on a moving branch name.

Retention is currently UNPLANNED. It will be revisited when cardinality grows.
This channel has no cleanup or expiry behavior.