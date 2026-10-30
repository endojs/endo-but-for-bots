---
'@endo/daemon': minor
---

`SecretImporter` gains `provideBase64(name, description, bytesBase64, { secretId, grantId, operationId })`, an idempotent import under caller-preallocated identifiers.
Use it instead of `createBase64`, which stays non-idempotent, when a caller must survive a lost response.
The `grantId`, written in the same transaction as the record, identifies the creator: a retry must repeat it, and any other `grantId` with an existing `secretId` is refused with `IDEMPOTENCY_CONFLICT`.
Concurrent stable imports are serialized together, so two cannot bind one name or one `grantId`.
A retry without bytes resumes a completed write, and returns a `provisioning` summary when there is none to resume.
A `provisioning` summary means the bytes are not installed and the name is not bound; treat it as not yet imported.
After the secret is deleted, a retry with bytes creates it afresh under the same identifiers.

`SecretState` gains `'provisioning'` for a record whose bytes are not yet installed.
Consumers that switch exhaustively on `SecretState` must handle the new state.

The encrypted-file secret backend's `create` now keeps the first-written bytes when replayed for the same secret ID instead of overwriting them, and the backend gains `recover`.
The daemon persistence layer gains `writeSecretRecordWithGrant(record, grantId)`, which never repoints an existing grant.
