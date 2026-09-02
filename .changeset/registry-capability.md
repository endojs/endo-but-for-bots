---
'@endo/daemon': minor
---

Add the package registry, exposed on every host as the required `@registry`
special name (mirroring `@node`). `@registry` brokers npm-style package
resolution and tarball fetch against the content-addressed store: it lists and
looks up published packages and checks package tarballs into the store as
integrity-verified `readable-tree`s. Resolutions distinguish tampered,
missing-package, network, and offline failures by error class.

`@registry` is presented as a **directory tree** (`has`/`lookup`/`list`); see
the companion `registry-directory-tree.md` entry for the tree shape and the
eager MVS resolver over it. The earlier `EndoRegistry` method protocol
(`resolve`/`fetch`/`lookup`/`list`) that a draft of this entry described was
never released; it survives only behind the explicit
`makeDeprecatedEndoRegistryAdapter` compatibility surface.

Migration: `@registry` is now required on every host, so a daemon whose state
was initialized before this release cannot incarnate its existing hosts and
must be re-initialized.
