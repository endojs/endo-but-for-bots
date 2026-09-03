# Daemon Secret Blob Manager

| | |
|---|---|
| **Created** | 2026-09-03 |
| **Updated** | 2026-09-03 |
| **Status** | Implemented (local backend) |

## Summary

Endo needs a small service for storing, replacing, revoking, and delivering
arbitrary secret bytes.
The service does not understand bearer tokens, signing keys, OAuth sessions,
account identities, origins, models, quotas, or leases.
Those abstractions may be built on top of secret blobs by composing
capabilities.

A singleton `SecretManager` owns the record catalog and audit log.
It exposes management facets through the daemon-provided `@secrets` special
directory.
Individual `SecretBlob` capabilities appear under `secrets`, an ordinary pet
store in the user's normal inventory.

The formula database remains the powerbox capability wallet.
A pet-store entry names an existing `lookup` formula for a `SecretBlob`; it
does not contain the secret bytes.
Messages delegate that formula identifier as a capability attachment without
reading or copying the bytes.

All authorization is capability possession.
This design introduces no access-control list, role lookup, principal check, or
identity-based authorization decision.

## Scope

The manager is responsible for:

- storing an arbitrary bounded `Uint8Array` in an injected backend;
- giving the record a non-secret human-readable purpose;
- minting separately delegable read and administration facets;
- replacing the current bytes without changing existing read capabilities;
- revoking all future reads;
- maintaining a complete audit trail for manager-mediated operations;
- reincarnating durable capabilities after daemon restart; and
- placing new read capabilities in the user's normal inventory.

The manager is not responsible for:

- interpreting the bytes;
- signing, authentication, OAuth refresh, or session management;
- restricting a secret to an origin, protocol, account, model, or quota;
- preventing a holder of `SecretBlob` from reading or copying its bytes;
- automatically migrating secret bytes between daemons;
- choosing an organization's KMS, HSM, backup, or operator procedure; or
- implementing protocol-specific credential or subscription UI.

Higher-level makers can accept a `SecretBlob` and return a narrower service
capability such as an authenticated HTTP client, Git remote, signer, or model
broker.
Those services and their policies are separate designs.

## Namespaces

The host exposes two deliberately different roots:

```text
@secrets/          daemon-provided special directory
  create           host-local SecretImporter facet
  catalog          SecretCatalog facet
  audit            SecretAuditReader facet

secrets/           ordinary user pet-store directory
  github-release   SecretBlob
  staging-api      SecretBlob
```

`@secrets` is special, read-only namespace wiring supplied by the daemon.
It cannot be replaced by writing a normal pet name.
Its facets lead to the singleton manager but expose only the authority needed
by their UI or host consumer.

`secrets` has no special-name status.
It is an ordinary directory backed by an ordinary pet store in the user's
inventory.
The Space creation flow creates it if it is absent and otherwise uses the
existing directory.
Normal pet-store naming, renaming, message attachment, adoption, and retention
rules apply to its entries.

Removing `secrets/github-release` removes one name and retention edge.
It does not revoke copies previously sent to other agents and does not delete
the backend record.
Revocation is an explicit management operation through `@secrets/catalog`.

## Capability Interfaces

The method guards enforce this intentionally small initial vocabulary.

```ts
interface SecretBlob {
  readBase64(): Promise<string>;
  getPurpose(): Promise<string>;
  help(): string;
}

type SecretSummary = {
  purpose: string;
  state: 'active' | 'revoked' | 'unavailable';
  generation: bigint;
  createdAt: string;
  updatedAt: string;
};

interface SecretAdmin {
  getSummary(): Promise<SecretSummary>;
  replaceBase64(bytesBase64: string): Promise<void>;
  setPurpose(purpose: string): Promise<void>;
  revoke(): Promise<void>;
}

interface SecretImporter {
  createBase64(
    name: string,
    purpose: string,
    bytesBase64: string,
  ): Promise<SecretSummary>;
}

interface SecretCatalog {
  list(): Promise<
    Array<{
      secretId: string;
      summary: SecretSummary;
      admin: SecretAdmin;
    }>
  >;
}

interface SecretAuditReader {
  list(limit?: bigint): Promise<SecretAuditEvent[]>;
}
```

`SecretBlob` is read authority.
There is no claim that a holder may delegate it but cannot invoke it.
Once `readBase64()` resolves, the manager cannot prevent the recipient from copying,
logging, or forwarding the returned bytes.

Base64 is only the passable CapTP wire envelope: mutable `Uint8Array` values are
not passable.
The manager decodes at ingress and the backend stores arbitrary bytes.

`SecretAdmin` is not derivable from `SecretBlob`.
It can replace, update the purpose of, and revoke but cannot read.

`SecretCatalog` enumerates management facets, not read facets.
The Secret Blobs Space uses the catalog to render and manage secrets without
receiving `SecretBlob` presences.

`SecretImporter` is a host-local facade over the singleton manager.
It is also endowed with the authority to formulate a read grant and bind its
identifier under `secrets/<name>` in that host's ordinary inventory.
It returns metadata, not the new read facet.

The `purpose` string is descriptive metadata only.
It is mutable, non-unique, and never interpreted as policy or authority.
It must be short, single-line, and validated, and the UI must state that it is
not secret.

The `help()` text is static and does not interpolate the purpose:

> This capability grants access to secret bytes.
> Prefer proposing a formula that receives it as an endowment.
> Do not call `readBase64()` unless the task specifically requires learning the
> secret value.

This guidance reduces accidental disclosure by an agent but is not a security
boundary.

## Secret Blobs Space UI

The Secret Blobs Space receives catalog summaries, audit events, and
`SecretAdmin` facets.
It never receives a `SecretBlob` or invokes `readBase64()`, so it cannot reveal
an already stored value.

Creation and replacement necessarily accept plaintext from the operator.
Every control that accepts secret bytes must be an `<input type="password">`,
must disable browser autocomplete, autocapitalization, and spellchecking, and
must carry supported third-party password-manager ignore hints.
It must not use a text input or textarea for secret bytes.
The UI keeps these controls in confined, controlled state and clears that state
synchronously on submission, before awaiting the manager operation, so a
submitted value is not left in the live DOM.
Purpose and inventory-name controls remain ordinary text because their values
are explicitly non-secret metadata.

Revocation is placed behind a visibly labeled danger-zone confirmation because
it denies all delegated copies and is not an inventory rename or removal.
Errors shown in the Space are fixed messages and never include caught exception
text, method arguments, or backend responses.

The Space provides a **Clear clipboard** action that asks the browser clipboard
capability to write an empty string.
This is best-effort hygiene after an operator has pasted a secret: success only
means the current clipboard flavor was overwritten.
The UI must not claim to erase operating-system clipboard history, cloud-synced
clipboard history, or copies retained by another application.
The confined view receives only an opaque clear callback and cannot read the
clipboard.

## Backend Interface

The manager receives one or more backend capabilities at bootstrap.
Backend names select among capabilities the manager already holds; they do not
grant authority.

```ts
interface SecretBackend {
  create(operationId: string, bytes: Uint8Array): Promise<StoredSecret>;
}

interface StoredSecret {
  read(): Promise<Uint8Array>;
  replace(operationId: string, bytes: Uint8Array): Promise<void>;
  revoke(operationId: string): Promise<void>;
}
```

`StoredSecret` is a sturdy per-record backend capability.
It never leaves the singleton manager.
The manager wraps it with the externally delegable `SecretBlob` and
`SecretAdmin` facets so every operation passes through manager state and audit.

A conforming backend must document and test:

- how its per-record capabilities survive service and transport restart;
- its maximum value size;
- atomic replacement and fail-closed revocation;
- idempotent mutations under manager-generated operation identifiers;
- encryption in transit;
- risk-appropriate encryption at rest and protection of wrapping keys;
- backup, restore, rollback, deletion, and key-rotation behavior; and
- fixed error results that do not contain secret values or backend response
  bodies.

The core protocol does not mandate a particular encryption algorithm, KMS, or
HSM.
Those are backend and deployment choices that must satisfy the operator's
threat model and service commitments.

The initial Node development backend uses AES-256-GCM, a fresh nonce per
write, the backend record name as associated data, and atomic rename.
Its wrapping key is retained in daemon state, so it protects against accidental
plaintext disclosure and ciphertext mixups, not compromise of the whole state
directory.
Production deployments that need key separation must inject a backend whose
wrapping authority resides in a KMS, HSM, or equivalent isolated service.
The XS manager currently reports this local backend as unavailable until its
supervisor exposes an authenticated-encryption host power.

## Durable Representation

There is no `secret-blob` formula type.
The singleton manager is incarnated using an existing daemon service recipe and
exposes a private naming-hub facet.
Each durable read or administration facet uses the existing `lookup` formula.

An inventory read grant is represented as:

```js
{
  type: 'lookup',
  hub: '<formula identifier for the private manager hub>',
  path: ['use', '<random 256-bit grant identifier>'],
}
```

An administration facet may be represented as:

```js
{
  type: 'lookup',
  hub: '<formula identifier for the private manager hub>',
  path: ['admin', '<random 256-bit secret identifier>'],
}
```

The manager hub is the authority amplifier.
The random path component is a Swiss number and grants no authority without the
hub capability retained by the lookup formula.
The general formula inspector already carries capability-wallet authority; the
secret design does not add a new inspection or backup expectation.

The manager lookup always returns an object with the appropriate interface,
including for a revoked record.
Consequently the lookup formula identifier remains stable across replacement,
revocation, daemon restart, and JavaScript object reincarnation.
A revoked `SecretBlob` reincarnates successfully but its `readBase64()` method
rejects with a fixed error.

The formula and pet-store databases never contain secret bytes, ciphertext,
secret hashes, byte lengths, or backend error bodies.
The manager's mutable record store contains only lifecycle metadata and sturdy
backend capability references.

## Creation and Inventory Binding

Creating `secrets/github-release` proceeds as a recoverable operation:

1. The UI resolves `@secrets/create` without resolving the normal
   `secrets` inventory entry.
2. The importer validates the pet name and non-secret purpose.
3. The manager records a pending operation and sends the bytes to its selected
   backend.
4. The backend returns a sturdy `StoredSecret` capability.
5. The manager commits the active record, backend capability reference, first
   generation, and audit event.
6. Under the formula-graph lock, the daemon formulates an existing `lookup`
   recipe for a fresh read grant and binds that identifier as
   `secrets/github-release` in the ordinary pet store.
7. The importer returns only a `SecretSummary` to the UI.

The initial implementation commits the backend value before metadata and
commits metadata before inventory binding.
A crash can therefore leave an unreachable encrypted backend object or an
active unnamed record visible through `@secrets/catalog`; it cannot expose
plaintext or grant unrecorded read authority.
Automatic reconciliation is deferred with the operation journal below.

Creating a new secret never goes through the content-addressed store.
Hash-addressing secret plaintext would reveal equality and create an offline
guessing oracle for low-entropy values.

## Messages and Agent Use

Selecting `secrets/github-release` as a message attachment resolves the pet
name to its lookup formula identifier.
The message records that identifier as its value edge.
It does not call `SecretBlob.readBase64()`.

For a compound passable value, a normal `marshal` formula contains the visible
copy structure and a slot for the existing lookup formula:

```js
{
  type: 'marshal',
  body: '<copy record with credential represented by slot 0>',
  slots: ['<SecretBlob lookup formula identifier>'],
}
```

No secret bytes enter the marshal body.

The receiving agent may adopt the attachment into its own pet store or include
it as an endowment in a proposed formula.
The recommended agent behavior is to propose providing the `SecretBlob`
directly to a server or other formula it creates instead of calling
`readBase64()` in the agent session.
The formula proposal and resulting capability graph remain visible for human
review through the ordinary powerbox workflow.

For a remote recipient, the attachment resolves to a remote presence pointing
back to the originating daemon.
Secret bytes remain in the original backend until the recipient explicitly
calls `readBase64()`.
The originating manager mediates and audits that call.

Forwarding the same inventory capability delegates the same grant.
A later extension may derive a fresh grant for each message to improve audit
correlation or permit per-grant revocation, but the initial design does not
require it.

## Replacement, Revocation, and Collection

Replacement is all-or-nothing from the reader's perspective.
The backend installs the new bytes before the manager advances the current
generation.
Existing `SecretBlob` capabilities read the new generation on their next call.
The initial backend replacement is atomic, but a crash after its rename and
before the metadata commit can leave the recorded generation stale.
The deferred operation journal must reconcile this conservatively before the
catalog claims a new generation.

Revocation first marks the manager record revoked and commits that state.
All subsequent reads then fail closed even if the backend is unavailable.
Backend revocation follows as a retryable cleanup operation.

Removing or garbage-collecting a lookup formula is not revocation and never
implicitly deletes backend material.
The catalog retains the management record until an explicit retention or purge
operation is designed and invoked.

Revocation cannot retract bytes already returned by `readBase64()` or undo an
upstream action already performed with them.

## Audit

The singleton manager is the mandatory mediation point because no backend
record capability leaves it.
It records create, read, replace, purpose change, and revoke operations.

```ts
type SecretAuditEvent = {
  eventId: string;
  secretId: string;
  operation: 'create' | 'release' | 'replace' | 'set-purpose' | 'revoke';
  outcome: 'attempted' | 'succeeded' | 'failed';
  generation: bigint;
  occurredAt: string;
  operationId: string;
  grantId?: string;
  invocationId?: string;
  parentInvocationId?: string;
  workerFormulaId?: string;
  connectionId?: string;
  reasonCode?: string;
  previousEventHash?: string;
};
```

Audit events exclude secret bytes, ciphertext, hashes, lengths, purpose text,
backend locators, arbitrary reason text, and exception messages.
Application logs contain only an audit event identifier and fixed diagnostic
codes.

For `readBase64()`, the manager durably records an attempt before reading the
backend and durably records release before resolving with bytes.
A crash may conservatively record release even if the response did not reach
the caller.
The event therefore means that the manager released the value, not that a
specific human or process received it.

The manager must not receive the Endo root merely to enrich audit records.
A later daemon integration may endow it with a narrow, observational
`AuditContext` that reports invocation, worker, connection, turn, and causal
parent identifiers.
These fields are evidence and correlation data only and never authorization
inputs.

An object cannot reliably identify its current holder after delegation or
aliasing.
Audit claims must describe the nearest observed grant and transport boundary,
not invent an authenticated caller identity.

## Leak-Prevention Invariants

The security boundary is enforced by the following invariants, not by a custom
formula type:

1. Formula construction never accepts secret bytes.
2. Backend record capabilities never leave the manager.
3. The Space management UI never receives a `SecretBlob` presence merely to
   render, replace, revoke, or attach an inventory item.
4. Message attachment passes a formula identifier without resolving or reading
   the secret.
5. No general logger receives method arguments, results, backend bodies, or
   purpose strings from secret operations.
6. Fixed errors contain no secret-dependent text.
7. Tests scan formula storage, SQLite, logs, traces, errors, and message records
   for canary secret values.
8. Revocation is checked immediately before every backend read.

JavaScript cannot guarantee timely zeroization of every engine copy of a
`Uint8Array`.
Implementations minimize copies and discard references promptly, but the trust
boundary necessarily includes any process to which plaintext is delivered.

## Implementation

### Implemented

- guarded read, administration, import, catalog, audit, and directory facets;
- durable SQLite metadata, grants, and audit events;
- the encrypted local development backend;
- `@secrets` management routing and ordinary `secrets/<name>` lookup formulas;
- restart, message delegation, replacement, revocation-race, and canary tests;
  and
- a Secret Blobs Space that creates, enumerates, replaces, updates purposes,
  revokes,
  and audits without receiving a read facet.

### Deferred hardening

- a durable operation journal and reconciliation for crashes between a backend
  mutation and its metadata commit;
- an XS authenticated-encryption host power;
- a production KMS/HSM backend; and
- explicit audit retention, export, and purge policy.

## Open Questions

1. Should the initial production backend be a local envelope-encrypted store or
   only an adapter to an external secret service?
2. What maximum secret size should the first protocol guarantee?
3. Should every message derive a fresh grant, or should messages initially
   forward the inventory grant exactly as ordinary capability delegation?
4. Which stable daemon invocation fields can a narrow `AuditContext` expose
   without turning debugging internals into a security contract?
5. What retention and explicit purge policy should follow revocation?

## References

- [Exploratory secret-management pull request](https://github.com/endojs/endo-but-for-bots/pull/994)
- [Secret storage issue 22](https://git.goooooo.ooo/floot/endo/issues/22)
- [Secret storage issue 26](https://git.goooooo.ooo/floot/endo/issues/26)
- [AICPA Trust Services Criteria resource](https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022)
