// The code-mode contract for the daemon's mount capability, named for the
// `workspace` global it is printed under.
//
// This is a re-export, not a copy: the prompt extractor follows it into
// `@endo/daemon`'s own published type source, flattens the interface
// inheritance and overloads it finds there, and inlines the types it reaches
// across `@endo/*` packages. TypeScript checks the re-export, so the daemon
// contract cannot be renamed or removed without failing here first.

export type DaemonMount = import('@endo/daemon').EndoMount;
