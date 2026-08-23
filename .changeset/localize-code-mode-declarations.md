---
'@endo/agent-tools': patch
---

Make generated code-mode TypeScript declarations easier for models to read by inlining each global's root object, expanding root-near data and capability types within a bounded prompt-size budget, preserving relevant source documentation, and retaining named anchors for recursive or widely reused shapes.
