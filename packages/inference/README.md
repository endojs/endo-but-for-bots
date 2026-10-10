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
   returns either a grant, `{ type: 'granted', env, release }`, or a refusal,
   `{ type: 'refused', admission }` whose `admission` is an
   `AdmissionRefusal`). Every record is closed, so a request cannot carry a
   credential.
2. **Provider plugins.** Not here. A plugin is a maker that returns an
   `InferenceBackend` over exactly one `CredentialSource`.
3. **Mechanism libraries a plugin calls** while it still holds the raw
   provider response or the running process:
   - `@endo/inference/limits.js`: `makeLimitEnforcer` enforces wall clock,
     output bytes, and turn count, and turns cancellation into `cancelled`.
     `maxWallClockMs` is at most `MAX_TIMER_DELAY_MS` (`2 ** 31 - 1`,
     exported from `@endo/inference/guards.js`), the
     longest delay a host timer honors. A plugin that spawns a process
     through `@endo/host-spawner` with `killProcessGroup: true` passes
     `terminate: () => proc.kill('SIGKILL')`, so the whole group dies.
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
     `needs-containment`, before the wrapped backend is called. It is a
     tripwire, not an attenuator: `promptOrigin` is a label the caller
     writes. Containment rests on who is given a backend, so a
     guest-influenced path must never hold an uncontained backend; wrap
     every such backend in the gate so that a routing defect surfaces.
   - `@endo/inference/usage-recorder.js`: `makeUsageRecorder` hands one usage
     record per turn to the deployment's usage sink. The deployment passes the
     backend's credential `secretIdentifier` at construction; the sink adds the run id
     and cost estimate.

Both enrichers call the wrapped backend directly, so it must be a local
(near) object, not a remote reference.

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

## Security

`SECURITY.md` is the policy shared by every Endo package for reporting a
vulnerability; CI keeps it identical across packages. The concerns particular
to this package are:

- A `CredentialSource` and the `env` of a grant it returns are secrets. Hold
  them in the deployment, never hand them to a guest or a remote
  holder, and never write the `env` to a log or a usage sink.
- The prompt-origin gate does not make a backend safe to share. It checks a
  label that the caller writes, so the boundary is which holders receive an
  uncontained backend at all.
- The usage recorder copies an `unavailable` result's `detail` into the usage
  record. A plugin must not put credential material or raw provider stderr in
  `detail`.

## Not yet here

- A persisted admission ledger. Admission policy is the broker's (or the
  interim slot lease's); this package defines only the `CredentialSource`
  shape.
- Delivery of the projection to an out-of-process provider. The projection
  carries `buildMcpServer`, a remotable function whose closure over one
  resolved facet is the only authority; a CLI backend that needs a spawnable
  stdio server is phase 2's concern.
