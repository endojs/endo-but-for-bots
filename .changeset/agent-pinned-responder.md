---
'@endo/hosted-agent': minor
'@endo/lal': minor
'@endo/fae': minor
---

Add a pinned responder for API-key guest agents (`@endo/hosted-agent/agent-responder.js`, with daemon caplets for the responder, its launcher, and its provisioner). It answers an agent's mail one bounded turn at a time through the agent's own inference grant, records one durable effect per message, defers refused messages with backoff or until the budget resets, and marks terminal refusals so the owner can retry or dismiss them. `@endo/lal` and `@endo/fae` each gain an `agent-responder.js` entry point. Inference admission refusals now carry their specific code, such as `agent-rate-limited`, instead of `inference-request-refused`; agent summaries gain the deferred and refused messages; and the agent directory gains `retryMail`.
