---
'@endo/inference': minor
---

Introduce `@endo/inference`, the provider-neutral interface for running one confined inference turn on behalf of an Endo guest.
Provider plugins implement the guarded `InferenceBackend` and `CredentialSource` interfaces, imported with their request, result, and usage-record shapes from `@endo/inference/guards.js`, and the matching types from `@endo/inference/types.js`.
A plugin bounds a turn's wall-clock time, output bytes, and turn count with `makeLimitEnforcer` from `@endo/inference/limits.js`, and maps a provider's raw responses onto the shared result shapes with `makeShapeClassifier` from `@endo/inference/classify.js`.
A deployment wraps a backend with `makePromptOriginGate`, which refuses any request not labeled `root-authored` with `needs-containment`, and with `makeUsageRecorder`, which writes one usage record per turn to the deployment's sink.
The package depends on no provider package.
