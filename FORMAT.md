---
created: 2026-07-16
updated: 2026-07-16
author: gardener
---

# Live eval transcript channel format

The root `CHANNEL.json` is the machine-readable handshake for this channel. It
identifies the channel, its branch, and path-layout version `3`.

Transcript paths use:

```text
<source-sha-12>+<campaign-run-id>/<scenario>/<model-slug>.md
```

One campaign folder contains every model/scenario artifact for one serialized
campaign run. Each private model helper keeps its exact run ID for provenance,
while the explicit campaign run ID names the public folder. The exact source
SHA and campaign ID are recorded in every artifact.

Each artifact combines a compact result and metrics header with the bounded,
redacted observable transcript. It may contain captured user and assistant
prose, execute submissions, tool results, errors, and clearly numbered turn
sections.

The publication boundary excludes hidden thinking, credentials, stdout,
stderr, `.env` content, and host-local paths. Content is bounded and redacted before it enters
the channel. Transcript paths are immutable. Repeating identical content is
idempotent, while conflicting content is rejected.

Public links are pinned to the commit SHA that published the artifacts. They
must not depend on a moving branch name.

Retention is currently UNPLANNED. It will be revisited when cardinality grows.
This channel has no cleanup or expiry behavior.
