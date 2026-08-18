# `@endo/exo-package-manager`

Portable package-manager capabilities for npm, pnpm, and Yarn metadata, safe
dependency hydration, and separately granted project-code execution.

This package holds guarded remotable facets, pure manager selection, fixed argv
translators, snapshot inputs, cancellation scoping, and an injected backend
protocol.
It does not start package managers itself or accept shell command strings.
Package-registry resolution remains a separate `EndoRegistry` capability.

## Capability facets

`makePackageManagerKit(powers)` returns three cumulative facets that share one
backend, policy, mount lineage, and cancellation scope:

- `reader` provides `help`, `detect`, and `scripts` metadata methods.
- `installer` adds `install` and `cancel`.
  `install` hydrates only declared dependencies and always disables lifecycle
  execution; its input has no lifecycle-enable option.
- `executor` adds `run`, the authority to execute a declared package script.
  Future lifecycle, package-binary, build, and test authority belongs at this
  level rather than on `installer`.

Every facet's `readOnly()` returns the same `reader`.
`scope(name)` may select only the same or a lower-authority facet, following the
`reader` / `writer` / `rewriter` attenuation pattern in `@endo/exo-git`.
Unauthorized methods are absent from the facet's guarded interface and from
CapTP method introspection.

`makePackageManager(powers, options)` is the single-facet convenience factory.
It selects `options.facet` (`reader`, `installer`, or `executor`) and defaults to
`executor` for compatibility.

## Installation effects

`install` never adds a package or intentionally edits `package.json`.
The dependency tree (such as `node_modules`) is generated scratch state owned
by the caller's workspace and may be discarded and rehydrated.
Frozen mode is the default and treats the lockfile as caller-owned input.
When host policy grants update mode, a changed lockfile is caller-owned,
committable output; deciding whether to retain or commit it remains with the
caller.
The returned `changed` record reports package-manifest, lockfile, and dependency
tree effects without transferring ownership of those files.

## Portable helpers and backend contract

The sole public code entry point exports the factories, facet interfaces,
manager-marker and frozen-lockfile constants, manager detection helpers,
fixed-argv builders, result guards, and their TypeScript types.

The backend receives mount-relative segments, fixed policy fields, a hardened
inspection snapshot, and an instance-scoped operation identifier.
It must atomically revalidate the snapshot before an install or run side effect
so manager, lockfile, and declared-script authorization cannot go stale.
Concrete execution and revalidation mechanisms remain outside this package.
