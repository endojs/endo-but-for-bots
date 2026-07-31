---
'@endo/daemon': minor
---

Add the `EndoRegistry` capability, exposed on every host as the required `@registry` special name (mirroring `@node`). `EndoRegistry` brokers npm-style package resolution and tarball fetch against the content-addressed store: `resolve(packageJson, options?)` walks the dependency closure and returns a content-addressed `RegistryResolution`, `fetch(name, version)` checks a package tarball into the store as a `readable-tree`, and `lookup`/`list` inspect the resolved working set. Resolutions distinguish tampered, missing-package, network, and offline failures by error class.

Migration: `@registry` is now required on every host. A daemon whose state was initialized before this release upgrades its persisted host formulas automatically on the next startup; no re-initialization is required.
