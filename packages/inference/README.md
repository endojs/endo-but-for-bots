# @endo/inference

The provider-neutral seam for one confined inference turn over an Endo guest
facet. It names no provider and depends on no provider package; provider
packages (such as `@endo/claude`) ship plugins that satisfy it.

See [`designs/endo-claude-inference-backends.md`](../../designs/endo-claude-inference-backends.md)
§ The Inference Seam for the full contract. This package is phase 1 of that
design.

## Layers

A provider may join at any of these layers.

1. **Interfaces** (`@endo/inference/guards.js`). The guarded
   `InferenceBackendInterface` (`describe()`, and `infer(request)`, which
   never rejects for any outcome of a turn), its request, result, and
   usage-record shapes, and the `CredentialSourceInterface` (`acquire()`
   returns a grant carrying an `environment` and a `release`, or a refusal carrying an
   `AdmissionRefusal`). Every record is closed, so a request cannot carry a
   credential.
2. **Provider plugins.** Not here. A plugin is a maker that returns an
   `InferenceBackend` over exactly one `CredentialSource`.
3. **Mechanism libraries a plugin calls** while it still holds the raw
   provider response or the running process:
   - `@endo/inference/limits.js`: `makeLimitEnforcer` enforces wall clock,
     output bytes, and turn count, and turns cancellation into `cancelled`.
     `makeProcessGroupKiller` is the `terminate` for a plugin that spawns a
     detached child.
   - `@endo/inference/classify.js`: `makeShapeClassifier` maps a raw response
     to a result tag through a table pinned per exact provider version. An
     unknown version or an unrecognized response does not classify, so the
     plugin reports `unavailable`, never a false `needs-auth`. The table may
     not write `ok` or `needs-containment`. `admissionRefusalResult` maps an
     admission refusal to the tag of the same name.
4. **Enrichers** take a backend and return a backend with the same
   interface, acting only on the request and the classified result:
   - `@endo/inference/prompt-origin-gate.js`: `makePromptOriginGate` refuses
     any request whose `promptOrigin` is not `root-authored` with
     `needs-containment`, before the wrapped backend is called. Wrap every
     backend whose turns run without OS containment in it.
   - `@endo/inference/usage-recorder.js`: `makeUsageRecorder` hands one usage
     record per turn to the deployment's usage sink. The deployment passes the
     backend's credential `secretId` at construction; the sink adds the run id
     and cost estimate.

Admission is not an enricher. It belongs to the credential source, which the
plugin calls before it starts any provider process.

## Result tags

| Tag                                                          | Writer                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `ok`                                                         | plugin                                                                     |
| `needs-auth`                                                 | plugin, through a pinned classifier row only                               |
| `usage-exhausted`, `rate-limited`, `budget-exhausted`        | plugin, from an admission refusal or a pinned row; optional `retryAfterMs` |
| `limit-exceeded` (`wall-clock`, `output-bytes`, `max-turns`) | plugin, through the limit enforcer                                         |
| `cancelled`                                                  | plugin, through the limit enforcer                                         |
| `unavailable` (`detail` is display text)                     | plugin                                                                     |
| `needs-containment`                                          | prompt-origin gate only                                                    |

## Not yet here

- A persisted admission ledger. Admission policy is the broker's (or the
  interim slot lease's); this package defines only the `CredentialSource`
  shape.
- Delivery of the projection to an out-of-process provider. The projection
  carries `buildMcpServer`, a remotable function whose closure over one
  resolved facet is the only authority; a CLI backend that needs a spawnable
  stdio server is phase 2's concern.
