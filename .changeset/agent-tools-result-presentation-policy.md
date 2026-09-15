---
'@endo/agent-tools': minor
---

Add a provider-independent `ToolRecord.resultPolicy` for bounding model-visible
tool results by UTF-8 bytes at adapter boundaries.
The Pi adapter preserves exact raw completions in `details` and marks clipped
model text with an in-band byte-counted truncation marker.
Mount reads no longer expose a separate bounded structured result shape.
