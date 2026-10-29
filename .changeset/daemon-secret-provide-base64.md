---
'@endo/daemon': minor
---

`SecretImporter` gains `provideBase64(name, description, bytesBase64, { secretId, grantId, operationId })`, an idempotent import under caller-preallocated identifiers.
Use it instead of `createBase64`, which stays non-idempotent, when a caller must survive a lost response.
A retry must repeat the creating `operationId` and `grantId`; any other pairing with an existing `secretId` is refused with `IDEMPOTENCY_CONFLICT`.
A retry without bytes resumes a completed write, and returns a `provisioning` summary when there is none to resume.

`SecretState` gains `'provisioning'` for a record whose bytes are not yet installed.
Consumers that switch exhaustively on `SecretState` must handle the new state.

The encrypted-file secret backend's `create` now keeps the first-written bytes when replayed for the same secret ID instead of overwriting them, and the backend gains `recover`.
The daemon persistence layer gains `listSecretAuditEventsFor(secretId)`.
