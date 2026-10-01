---
'@endo/inference': major
---

Add `@endo/inference`, the provider-neutral seam for one confined inference
turn over a guest facet, per `designs/endo-claude-inference-backends.md`. It
exports the guarded `InferenceBackend` and `CredentialSource` interfaces and
their request, result, and usage-record shapes; the limit enforcer and the
version-pinned response classifier that a provider plugin calls; and two
enrichers, the prompt-origin gate (refuses any request not labeled
`root-authored` with `needs-containment`) and the usage recorder (one usage
record per turn to the deployment's sink). It depends on no provider package.
