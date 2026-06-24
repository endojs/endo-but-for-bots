// @ts-check

/**
 * Method-guard shape for the EndoRegistry capability.
 *
 * This guard is what crosses the worker boundary, mirroring the
 * `EndoRegistry` interface in the Capability shape section of
 * `designs/registry-capability.md`.
 *
 * The runtime exo (built by `makeNpmReferenceRegistry`) uses
 * `EndoRegistryInterface`; a future Rust-backed wrapper presents the
 * same guard so callers cannot tell which backend resolved a request.
 *
 * The CAS interface guard (`CasInterface`) lives in `@endo/mem-cas`;
 * see that package's `./src/interfaces.js`.
 */

import { M } from '@endo/patterns';

// Shapes shared between guards. The narrow value shapes (resolution
// records, tree refs, etc.) are documented in `types.d.ts`; the
// runtime guards check argument call shapes only.
const NameShape = M.string();
const VersionShape = M.string();

const ResolveOptionsShape = M.splitRecord(
  {},
  {
    offline: M.boolean(),
    // `workspaceRoot` is intentionally permissive: it may be a pet
    // name (string) or an `EndoMount` capability handle. Layer 2's
    // mvs-resolver tightens the shape when it adopts workspace
    // resolution.
    workspaceRoot: M.any(),
  },
);

/**
 * Shape for the `package.json` bytes the resolver consumes.
 *
 * The design's capability shape names `Uint8Array`; in practice an
 * exo's M.interface guard rejects mutable typed arrays at the worker
 * boundary (see the `@endo/daemon` mount-test comment "Cannot pass
 * mutable typed arrays").  Layer 1 accepts the JSON as a string at
 * the boundary; callers that hold the bytes can `new TextDecoder()`
 * once before passing.  A future revision may add a parallel
 * `resolveBlob` taking a readable-blob capability for the binary
 * path; the type-level shape in `types.d.ts` is kept as `Uint8Array`
 * to keep the doc-design alignment.
 */
const PackageJsonShape = M.string();

/**
 * The capability shape that crosses the worker boundary.
 *
 * The interface guard checks the call-site shapes (argument types
 * and arity); the returned-promise payload shapes are documented via
 * the typescript `EndoRegistry` interface in `types.d.ts`. `M.promise()`
 * matches any promise regardless of resolved value, mirroring the
 * shape conventions already in use in `@endo/daemon/src/interfaces.js`.
 *
 * @see designs/registry-capability.md, Capability shape section.
 */
export const EndoRegistryInterface = M.interface('EndoRegistry', {
  resolve: M.call(PackageJsonShape)
    .optional(ResolveOptionsShape)
    .returns(M.promise()),
  fetch: M.call(NameShape, VersionShape).returns(M.promise()),
  lookup: M.call(NameShape, VersionShape).returns(M.promise()),
  list: M.call().optional(NameShape).returns(M.promise()),
  help: M.call().returns(M.string()),
});
