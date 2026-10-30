---
'@endo/daemon': minor
---

New: `SecretImporter.provideBase64(name, description, bytesBase64, { secretId, grantId, operationId })` imports a secret idempotently under caller-chosen identifiers.
Use it instead of `createBase64` when a caller must survive a lost response: a retry with the same identifiers resumes the import, and a retry with a different `grantId` for an existing `secretId` is refused with `IDEMPOTENCY_CONFLICT`.
The `grantId` is redeemable read authority, so choose identifiers that are unguessable or derived from a secret.
A retry without bytes that has nothing to resume returns a `provisioning` summary; treat it as not yet imported.

Migration: `SecretState` gains `'provisioning'` for a record whose bytes are not yet installed.
Consumers that switch exhaustively on `SecretState` must handle it.

Behavior change: the encrypted-file secret backend's `create`, replayed for the same secret ID, now keeps the first-written bytes instead of overwriting them.
