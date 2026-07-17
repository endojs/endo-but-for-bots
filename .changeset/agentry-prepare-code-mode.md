---
'@endo/agentry': major
'@endo/agent-tools': minor
'@endo/daemon': minor
'@endo/platform': minor
---

Add `prepareCodeMode` as the host-independent repository setup API, with
`inspect`, `edit`, and `rewriteHistory` access presets for in-process and daemon
evaluation.

Keep `makeCodeModeAgent` as the generic maker and remove the public
Git-eval-specific constructor.
Add accurate read-only Filesystem declarations, trusted local posture tracking,
and daemon-side repository provisioning and attenuation.
