# Hardened `TextEncoder` / `TextDecoder` Vetted Shim

| | |
|---|---|
| **Created** | 2026-05-04 |
| **Updated** | 2026-10-27 |
| **Author** | Kris Kowal (prompted) |
| **Status** | **Implemented** (Phases 1-2) |

## Status

**Implemented (Phases 1-2).** The permits, the global sampling, the
tests, and the changeset merged upstream in
[endojs/endo#3322](https://github.com/endojs/endo/pull/3322) on 2026-07-22
(merge commit `8021d268e7`). They reached `llm`, this repository's
integration branch that carries upstream `endojs/endo` plus fork-only work,
through the regular upstream merges. § Sampling and degradation on hosts
without the codecs describes the sampling.

The change put `TextEncoder` and `TextDecoder` on `universalPropertyNames`
in `packages/ses/src/permits.js` with the prototype permits in the table
below. It added 18 focused tests covering items 1-5 of the § Test plan
below, and a changeset (`.changeset/hardened-text-codecs.md`, released by
[endojs/endo#3302](https://github.com/endojs/endo/pull/3302)).

A follow-up PR, [endojs/endo#3340](https://github.com/endojs/endo/pull/3340)
(merged 2026-08-11 as `dc504ca993`, also on `llm`), explicitly denies
Node's non-standard `Symbol(nodejs.util.inspect.custom)` method on both
prototypes.

Completed follow-up:

- **Phase 3 (downstream audit, optional):** performed on `llm` commit
  `844ce3df7b`; no call site needs migration. § Phase 3 audit result
  below lists the call sites and the loader evidence.

Open items:

- **§ Test plan item 6 (XS smoke test):** open as draft
  [endojs/endo-but-for-bots#1349](https://github.com/endojs/endo-but-for-bots/pull/1349).
  It extends `packages/ses/test/_xs.js`. It also found that the current
  Moddable `xst` *does* define both codecs, so on today's toolchain the XS
  path exercises pass-through-and-harden rather than the missing-codecs
  case this design assumed. § Sampling and degradation and Design
  Decision 3 below note this.
- **Node `TextDecoder` fast-path flags:** hardening a `TextDecoder`
  *instance* on recent Node releases makes the next `decode()` throw.
  Tracked upstream as
  [endojs/endo#2813](https://github.com/endojs/endo/issues/2813), with the
  open fix [endojs/endo#3245](https://github.com/endojs/endo/pull/3245)
  (`@endo/lockdown` accessor patch). This concerns hardened instances, not
  the permitted constructor and prototype this design covers.

## What is the Problem Being Solved?

Endo's hardened-JavaScript model rests on the premise that every
intrinsic shared between fearlessly coöperating compartments is either
a powerless data constructor or has been carefully tamed.
The host's `TextEncoder` and `TextDecoder` constructors are broadly
useful (UTF-8 round-tripping for byte-oriented work, the canonical
portable alternative to Node's `Buffer`) and would be welcome
additions to the permitted intrinsics.

Unlike `URL`, the text codecs have no ambient-authority static
methods and no exposed iterator prototype, so the taming story is
straightforward: list them on `universalPropertyNames`, sample
during the existing intrinsics-collection pass, and harden.

This work targets the same source as the URL shim
([endojs/endo#2635](https://github.com/endojs/endo/issues/2635)) but
is split out as its own design because the implementation has no
overlap with the URL/SharedURL split.

## Design

### Integration: `universalPropertyNames`

`packages/ses/src/permits.js` distinguishes three relevant buckets:

- `universalPropertyNames`: powerless data and constructors that live
  on every global (the start compartment and every compartment
  created after lockdown).
- `initialGlobalPropertyNames`: the powered variants that live only
  on the start compartment (`Date`, `Error`, `RegExp`, `Math`).
- `sharedGlobalPropertyNames`: the tamed, powerless variants of those
  same names, installed on every compartment created after lockdown.

`TextEncoder` and `TextDecoder` are pure transformations between
`string` and `Uint8Array`.
They have no static side channels and no ambient-authority methods.
They belong on `universalPropertyNames`: one identity-equal
constructor across the start compartment and every shared
compartment.

### Permits table

| Constructor | Property | Disposition | Rationale |
|---|---|---|---|
| `TextEncoder` | `prototype` | yes | Required for instances. |
| `TextEncoder` | `prototype.encode`, `encodeInto` | yes | Pure. |
| `TextEncoder` | `prototype.encoding` | yes | Pure (always `'utf-8'`). |
| `TextEncoder` | `prototype[@@toStringTag]` | yes | String data. |
| `TextEncoder` | `prototype[Symbol(nodejs.util.inspect.custom)]` | no | Node-only, non-standard; denied by [endojs/endo#3340](https://github.com/endojs/endo/pull/3340). |
| `TextDecoder` | `prototype` | yes | Required for instances. |
| `TextDecoder` | `prototype.decode` | yes | Pure. |
| `TextDecoder` | `prototype.encoding`, `fatal`, `ignoreBOM` | yes | Pure. |
| `TextDecoder` | `prototype[@@toStringTag]` | yes | String data. |
| `TextDecoder` | `prototype[Symbol(nodejs.util.inspect.custom)]` | no | Node-only, non-standard; denied by [endojs/endo#3340](https://github.com/endojs/endo/pull/3340). |

These constructors return `Uint8Array` (already a permitted
intrinsic) or `string`.
`TextDecoder`'s constructor accepts a label and an options bag; both
are pure inputs.
No iterator prototypes are exposed.

### Sampling and degradation on hosts without the codecs

`packages/ses/src/intrinsics.js`'s `sampleGlobals(globalThis,
universalPropertyNames)` already tolerates missing properties: a
permit whose name is absent on the global is simply skipped.
The shim relies on this behavior.
On a host where `TextEncoder` and `TextDecoder` are not defined
(older XS builds, when this design was written), lockdown proceeds
without them and compartments observe their absence exactly as they
do today.
Current Moddable `xst` defines both codecs, so on today's XS the
permits pass them through and harden them (see § Status).

### Lockdown sequencing

The new permits hook into the existing `intrinsics.js` flow with no
new lockdown phase:

1. `getGlobalIntrinsics` collects `TextEncoder` and `TextDecoder`
   from the host global.
2. The whitelist pass walks the permits graph and prunes any
   non-listed properties.
3. `harden` is applied to the closure of permitted intrinsics.

No code outside `packages/ses/src/` changes.
The shim is fully internal to SES.

### Test plan

Tests live under `packages/ses/test/`.

1. **Presence on universals.**
   In a fresh compartment created post-lockdown,
   `compartment.evaluate('typeof TextEncoder')` returns `'function'`
   when the host provides it, `'undefined'` otherwise.
   Same for `TextDecoder`.

2. **Identity across compartments.**
   The `TextEncoder` from the start compartment and from any
   post-lockdown compartment are the same object
   (`startCompartment.globalThis.TextEncoder ===
   compartment.globalThis.TextEncoder`).

3. **Frozen.**
   `Object.isFrozen(TextEncoder)`,
   `Object.isFrozen(TextEncoder.prototype)`,
   `Object.isFrozen(TextDecoder)`,
   `Object.isFrozen(TextDecoder.prototype)` are all `true`.

4. **Round-trip semantics preserved.**
   `new TextDecoder().decode(new TextEncoder().encode('hello')) ===
   'hello'`.
   This guards against accidental over-pruning.

5. **Host without the codecs.**
   A test that deletes `globalThis.TextEncoder` and
   `globalThis.TextDecoder` before calling `lockdown()` exercises the
   degradation path.
   No throw, and the post-lockdown compartments lack the bindings.

6. **XS smoke test.**
   The existing XS test runner exercises (1) on XS.
   This design assumed XS never provides the codecs, so the XS run
   would also cover (5).
   Current Moddable `xst` defines both codecs
   ([endojs/endo-but-for-bots#1349](https://github.com/endojs/endo-but-for-bots/pull/1349)),
   so on today's toolchain the XS run exercises pass-through-and-harden,
   and (5) is covered only by the deletion test on Node.

### Compatibility considerations

- **Code that monkey-patches the codecs.**
  Any code that today does `TextEncoder.prototype.foo = ...` after
  `@endo/init` will throw, because the permitted intrinsics are
  frozen.
  Such code must perform its mutation before lockdown (the same rule
  that already applies to every other intrinsic).
  Note this in the SES changeset for the release that ships the
  shim.

## Dependencies

| Design | Relationship |
|---|---|
| [hardened-url-shim](hardened-url-shim.md) | Sibling design split from the same source issue.  Both add a vetted host-provided constructor to SES permits.  The two sets of permits are independent and may land in either order. |
| [base64-native-fallthrough](base64-native-fallthrough.md) | Same family of work: tame and dispatch to native intrinsics inside SES rather than re-implementing in JavaScript.  Independent. |

## Phases

### Phase 1: Permits and sampling (S)

- Extend `packages/ses/src/permits.js` with entries for `TextEncoder`
  and `TextDecoder` on `universalPropertyNames`.
- Update the whitelist pass if any new shape is required.

### Phase 2: Tests and changeset (S)

- Add the test cases enumerated in the Test Plan.
- Add a changeset under `.changeset/` describing the newly tamed
  intrinsics and the behavior on hosts without them.

### Phase 3: Downstream audit (S)

Optional cleanup; it does not gate the **Implemented** status.

- Grep the monorepo for `Buffer.from(` and `.toString('utf` in code
  that runs inside a compartment created after lockdown.
  These call sites become candidates for migration to
  `TextEncoder`/`TextDecoder` per the project's
  "prefer Uint8Array + TextEncoder/TextDecoder over Buffer"
  convention.

#### Phase 3 audit result

Audited on `llm` commit `844ce3df7b`.

**Scope.**
The audit covers shipped package code, `packages/*/src`.
It also checks the other non-test package surfaces (`bench/`,
`demo/`, `scripts/`, and Markdown) for code that runs inside a
compartment created after lockdown.
It excludes `packages/*/test/` (83 matches), because tests are not
shipped and run on the Node host.

**Criterion.**
Each match is classified on two separate axes.

- *Execution boundary:* does the code run in the start compartment
  on the Node host, or inside a compartment created after lockdown?
  A module's Node-builtin imports or host-global reads show what
  authority it needs, not where it runs: a loader's policy or
  endowments can grant both to a compartment.
  The audit therefore classifies each site by its loaders, below.
  The start compartment still runs under SES, but `Buffer` is a host
  global there.
- *Conversion:* is the operation a portable UTF-8 conversion, which
  `TextEncoder` and `TextDecoder` can replace, or does it depend on
  `Buffer`-specific behavior?
  `Buffer`-specific behavior includes hex and base64 decoding,
  zero-copy `Buffer` views handed to Node streams, and
  `Buffer#copy` into a frame buffer.

A site is a migration candidate under this phase only if it runs
inside a compartment created after lockdown and performs a portable
UTF-8 conversion.

**Loaders.**
These are the loaders in `packages/*/src` that run code inside a
compartment created after lockdown, and what each supplies:

- The daemon worker (`packages/daemon/src/worker.js`) loads confined
  caplets from a bundle, archive, or tree through `parseArchive`.
  It passes a fixed `globals` record (`assert`, `console`, `E`, `Far`,
  `makeExo`, `M`, `TextEncoder`, `TextDecoder`, `URL`) and no exit
  modules, so a confined caplet gets neither `Buffer` nor any Node
  builtin. Its `evaluate` facet uses the same record plus
  caller-supplied pet-named values.
- `@endo/import-bundle`, the agent-tools code-mode compartment, the
  Fae code tool, the Preact container, the Thixotrope worker, and the
  `exo-npm` snapshot mapper take caller-supplied endowments or pass
  `modules: {}`. No caller in `packages/*/src` endows `Buffer` or
  grants a Node builtin.

The daemon worker loads *unconfined* caplets with a native `import()`,
so they run in the start compartment.
The command-line tools and the daemon's Node powers also load through
Node's own module loader.

**Shipped code.**
`packages/*/src` has 22 `Buffer.from(` and `.toString('utf...')`
call sites in 13 files, not counting comments.
Each site gets its `Buffer` from the host global, from an import of
`node:buffer`, or as a chunk from a `node:net` socket.
No compartment loader above supplies any of these, so in a
compartment created by one of them a site would fail with a
`ReferenceError` or fail to link.
All 22 sites therefore run only under Node's own loader, in the start
compartment.
This holds for the loaders in this repository; a consumer outside it
could build a compartment whose policy grants `Buffer` or
`node:buffer`.
That compartment would also have `TextEncoder` and `TextDecoder`,
because they are universal intrinsics, so the consumer could migrate
at that point.
The per-file notes below record each file's `Buffer` source and its
known loader.

- `packages/9p-server/src/server.js`, 1 site. `Buffer` view for a socket
  write. Host-global `Buffer`. Loaded only by the unconfined `mount-caplet.js` through
  `fs-bridge.js`, which imports `node:net`. The daemon worker loads
  unconfined caplets with a native `import()`.
- `packages/9p-server/src/wire.js`, 3 sites. 2 UTF-8, 1 `Buffer#copy`
  into a frame. Same as `server.js`.
- `packages/claude/src/launch.js`, 2 sites. UTF-8 decode. Host-global
  `Buffer`; spawns a `node:child_process` child.
- `packages/cli/src/commands/log.js`, 1 site. UTF-8 decode. Command-line
  tool; host-global `Buffer`; imports `fs` and `child_process`.
- `packages/daemon/src/manager-node-powers.js`, 1 site. Hex decode of a
  DER prefix. The daemon's Node powers; host-global `Buffer`; imports `node:crypto` and
  `node:fs/promises`.
- `packages/git/src/native-git-backend.js`, 4 sites. UTF-8 encode and
  decode. Imports `node:buffer`, `node:child_process`, and `node:fs`.
- `packages/hosted-agent/src/mcp-socket.js`, 1 site. UTF-8 decode.
  Decodes `Buffer` chunks from a socket it creates with `node:net`.
- `packages/npm-registry-server/src/http.js`, 3 sites. UTF-8 encode and
  decode. Imports `node:http` and `node:buffer`.
- `packages/npm-registry-server/src/registry.js`, 1 site. Base64 decode.
  Imports `Buffer` from `node:buffer`.
- `packages/opencode-sandbox/src/opencode-bridge.mjs`, 1 site. Base64
  encode. Imports `node:buffer`, `node:child_process`, and
  `node:process`.
- `packages/platform/src/http-node/backend.js`, 1 site. `Buffer` view
  for an HTTP write. Host-global `Buffer`; imports `node:http`.
- `packages/sandbox/src/drivers/child-process.js`, 2 sites. UTF-8
  decode. Host-global `Buffer`. Calls `spawn` on a passed-in Node `child_process` module and
  collects its output chunks.
- `packages/sandbox/src/drivers/podman.js`, 1 site. UTF-8 round trip.
  Host-global `Buffer`. Drives `podman` through `child-process.js` and
  reads the `process` host global.

The other matches in `packages/*/src`, in
`packages/pass-style/src/byteArray.js` and
`packages/immutable-arraybuffer/src/lib.js`, are comments.

**Other package surfaces.**
One match runs inside a compartment created after lockdown.
`packages/compartment-mapper/demo/policy/index.mjs` calls `lockdown()`
and then loads `app.js` with `importLocation`.
`packages/compartment-mapper/demo/policy/app.js` calls `Buffer.from`
at line 13, through a `Buffer` subset that the demo's policy endows.
That call decodes a hex string, so it is `Buffer`-specific, and
`TextEncoder` and `TextDecoder` cannot replace it.
The demo also exists to show a policy-attenuated `Buffer` endowment,
so it stays as written.
The remaining matches are host scripts or prose:
`packages/9p-server/bench/bench.js`,
`packages/fae/scripts/debug-llm-logs.js`, and
`packages/fae/scripts/smoke.test.js` run on the Node host, and
`packages/immutable-arraybuffer/README.md` and
`packages/immutable-arraybuffer/designs/immutable-arraybuffer.md` are
Markdown.

**Conclusion.**
No site meets the migration criterion.
The portable UTF-8 sites in the table could still move to
`TextEncoder` and `TextDecoder` as a style cleanup, following the
portability convention, but this design does not require it.

## Design Decisions

1. **Universal, not start-only.**
   `TextEncoder` and `TextDecoder` are powerless.
   They belong on `universalPropertyNames` (one identity-equal
   constructor across all compartments), unlike `URL` which needs an
   `initialGlobalPropertyNames` / `sharedGlobalPropertyNames` split
   to keep `createObjectURL` on the start compartment.

2. **Tame inside SES, not as an external shim.**
   Centralizing the permits avoids duplicating SES's whitelisting
   machinery in a per-package shim.

3. **No polyfill in this design.**
   Hosts that lack `TextEncoder` and `TextDecoder` continue to lack
   them (current Moddable `xst` defines both; see § Status).
   A separate polyfill design can layer cleanly on top when there is
   demand.

## Prompt

```
Split out from designs/hardened-url-shim.md per PR #84 review at
designs/hardened-url-shim.md:420 ("Separating the designs would be
good.").  The TextEncoder/TextDecoder taming has no implementation
overlap with the URL/SharedURL split, so it stands alone.
```
