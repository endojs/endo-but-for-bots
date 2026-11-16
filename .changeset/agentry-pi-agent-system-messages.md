---
'@endo/agentry': patch
---

`makePiAgent` and `defineAgent` send the system prompt and tool declarations to the provider again. Pi 0.86 moved them into a leading `system` message of the transcript, which the harness's default `convertToLlm` filtered out. The harness now uses pi-agent-core's default filter, and a custom `convertToLlm` must keep `system` messages.
