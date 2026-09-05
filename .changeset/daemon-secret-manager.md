---
'@endo/daemon': minor
'@endo/chat': minor
---

Add a durable secret-blob capability: a host can hold bytes that no agent
session enumerates or reads back through ordinary inventory, and can endow a
formula with a read capability by reference instead of by value.

`@endo/daemon` gives every host a `@secrets` special name resolving to three
management facets reached by lookup — `@secrets/create`
(`SecretImporter.createBase64(name, description, bytesBase64)`),
`@secrets/catalog` (`SecretCatalog.list()`, returning a `SecretAdmin` per entry
for `replaceBase64` / `setDescription` / `revoke` / `delete`), and
`@secrets/audit` (`SecretAuditReader.list(limit?)`). `@secrets/use/<grantId>`
resolves the read capability itself: a `SecretBlob` with `getDescription()` and
`readBase64()`. `createBase64` binds each grant under the ordinary `secrets`
pet directory, so a secret is passed on by reference and its bytes never appear
in `list()`. Every operation writes an audit event (`create`, `release`,
`replace`, `set-description`, `revoke`, `delete`, each recorded `attempted` /
`succeeded` / `failed`), and a revoked secret keeps its record and audit trail
while refusing reads.

Administration facets are vended only by `SecretCatalog.list()`; there is no
`@secrets/admin/<secretId>` path, because a secret identifier is published on
the catalog, importer, and audit surfaces. Audit events deliberately carry no
grant identifier, which would be redeemable read authority. A release that
overlaps an uncommitted replacement fails closed rather than returning bytes
the recorded generation does not describe.

The store is single-principal: records, grants, and audit events carry no
owning-host column, so any holder of a `@secrets` root administers every secret
in the daemon. See `designs/daemon-secret-manager.md` for why per-principal
partitioning is deferred.

New exports from `@endo/daemon/src/interfaces.js`: `SecretBlobInterface`,
`SecretAdminInterface`, `SecretImporterInterface`, `SecretCatalogInterface`,
`SecretAuditReaderInterface`, and `SecretManagerDirectoryInterface`. New types
exported from the package root: `SecretAdmin`, `SecretAuditEvent`,
`SecretAuditReader`, `SecretBlob`, `SecretCatalog`, `SecretCatalogEntry`,
`SecretImporter`, `SecretManagerDirectory`, `SecretRecord`, `SecretState`, and
`SecretSummary`.

`CryptoPowers` gains required `sealSecret` and `openSecret` (AES-256-GCM with
the record identifier as associated data), and `DaemonicPersistencePowers`
gains a required `provideSecretStoreKey` alongside the secret record, grant,
and audit accessors. Supervisors implementing those power types must supply
them. The Node supervisor seals blobs on disk and derives the store key from
daemon state; the XS supervisor refuses `sealSecret` and `openSecret`, so a bus
daemon still bundles for XS but cannot hold secrets there.

Existing daemon state needs no migration: `@secrets` resolves to the host's own
identifier rather than a new formula, so hosts formulated before this release
incarnate unchanged, and the new tables are created on open.

`@endo/chat` adds a Secrets space for creating, describing, replacing,
revoking, and deleting secrets and for reading the audit log. The space renders
metadata only; it never requests or displays a stored value.
