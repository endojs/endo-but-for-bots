# Runtime Identity for npm Packages: Conditions and Builtins

| | |
|---|---|
| **Created** | 2026-07-28 |
| **Author** | Kris Kowal (prompted) |
| **Status** | Proposed |
| **Source** | Probe findings recorded in the npm-via-CAS press reports of 2026-07-27 and 2026-07-28 |

## What is the problem being solved?

The npm-via-CAS registry proxy
([`endor-npm-registry-proxy.md`](endor-npm-registry-proxy.md))
fetches real npm packages from the registry into the content
address store and executes them in XS with no `node_modules`
tree and no npm CLI. Resolution, linkage, and the CommonJS and
ESM interop gaps are closed or in flight. What remains is a
single question wearing several hats, and it needs a ruling
before any more code lands against it:

**Which environment does the endor archive runtime claim to
be, when an npm package asks?**

A package asks in two ways. It asks *statically*, through the
condition keys in its `exports` map, which decide which build
of itself it hands over. It asks *dynamically*, by importing a
`node:` builtin or reading an ambient global. Today endor
answers the first question with "neither Node nor a browser"
and the second with "nothing is here", and the combination
fails on packages that would otherwise run.

### The precipitating case

`nanoid@5.1.16`, probed against the live registry on
2026-07-27. Its published `exports` are:

```json
{
  ".": {
    "types": "./index.d.ts",
    "browser": "./index.browser.js",
    "default": "./index.js",
    "react-native": "./index.browser.js"
  },
  "./non-secure": { "default": "./non-secure/index.js" },
  "./package.json": "./package.json"
}
```

The two builds have very different needs:

| Build | Needs |
|---|---|
| `./index.js` (the `default`) | `import { webcrypto as crypto } from 'node:crypto'` and the ambient `Buffer` global (`Buffer.allocUnsafe`) |
| `./index.browser.js` (the `browser`) | the ambient `crypto.getRandomValues` and nothing else |

Under the default condition set the resolver hands over
`./index.js`, and the run dies before evaluating anything
with `import webcrypto not found`. The package is pure JavaScript
either way. It needs 32 bytes of randomness. Only the identity
answer stands between it and a working run.

nanoid is not special. The same shape governs every package
that publishes a dual build, which is most of the modern
registry, so the ruling here decides how large a fraction of
npm endor can execute.

## Background: what the runtime does today

- **Condition activation.** `EXPORTS_RESOLVER_JS` in
  `rust/endo/xsnap/src/archive.rs` runs
  `__resolveExports` over `__matchExports` and
  `__resolveExportTarget`. It walks the condition object in
  key order and accepts a key when it is `default` or is in
  the active set. The active set is one module-flavor
  condition per pass: an `import` pass first, then a `require`
  pass, so a dual package's named ESM exports are visible to
  an ESM importer.
- **No environment condition is active.** Neither `node` nor
  `browser` is ever in the set. `default` is the only escape.
- **`node:` specifiers are not special.** There is no builtin
  table, by design of the confined runtime. A bare specifier
  with no link-map entry, no package-name match, and no source
  in its own compartment reaches the end of both load hooks
  and throws `Module not found: <compartment>/<specifier>`.
  The nanoid probe reported the XS binding error
  `import webcrypto not found` instead, so something upstream
  of that throw reports first. Which stage produces which
  message is unpinned, and item 6 below depends on knowing.
- **Globals are a small endowment set.**
  `ARCHIVE_ENDOWMENTS_JS` in `rust/endo/xsnap/src/lib.rs`
  carries `console`, the host powers, and (in flight, all
  draft) a web-platform `crypto` veneer over the host
  `randomHex256` function
  ([#876](https://github.com/endojs/endo-but-for-bots/pull/876)),
  `TextEncoder` / `TextDecoder` / `atob` / `btoa`
  ([#877](https://github.com/endojs/endo-but-for-bots/pull/877)),
  and a frozen minimal `process`
  ([#859](https://github.com/endojs/endo-but-for-bots/pull/859)).
  There is no `Buffer`, no `URL`, no `crypto.subtle`.
- **One identity decision is already made.** The `process`
  shim's `versions` object deliberately has **no `node` key**,
  so a package's own Node detection takes its non-Node branch.
  The runtime already tells packages it is not Node.
- **`--conditions` is a run-time knob, not a build input.**
  PR #876 threads `endor run --conditions <a,b>` into the
  machine global `__archiveExtraConditions`, which the
  resolver activates in every pass beside that pass's flavor
  condition. Resolution happens inside the archive runtime, so
  the stored compartment map and its CAS hash do **not** vary
  with the condition set. The same map hash can execute two
  different module graphs.

### Prior art inside this repository

`@endo/compartment-mapper` already answers this question for
the JavaScript side of Endo, and answers it three times over:

1. **Its default condition set is `import`, `default`, and
   `endo`** (`packages/compartment-mapper/src/node-modules.js`,
   in `mapNodeModules`). Not `node`. Not `browser`. The `endo`
   condition, per the package README, "only indicates that
   this tool is in use".
2. **`browser` is supported but opt-in**, and activating it
   does more than pick a condition key: `inferExports` also
   draws in the package's top-level `browser` **field**
   through `interpretBrowserField`, a separate file-to-file
   redirection map.
3. **Modules outside the map exit through a hook**
   (`exitModuleImportHookMaker` in `import-hook.js`). Shimming
   a builtin is an established mechanism there, entirely
   separate from condition selection.

endor's resolver diverges from all three: no `endo`, no
`browser` field support, no exit modules.

## The three candidate policies

### A. Activate `browser` by default

Add `browser` to the default condition set, so dual packages
hand over their browser build with no flag.

- **For:** fixes nanoid and most of its class with zero user
  action. Browser builds are usually the *purer* build, since
  they cannot assume builtins. It matches what a bundler
  targeting the web does.
- **Against:** `browser` does not mean "no builtins". It means
  "a DOM is present". A browser build may reach for `window`,
  `document`, `navigator`, `location`, `self`,
  `XMLHttpRequest`, or `addEventListener`, none of which
  endor has and none of which endor should have. So the flag
  can **lose** a working pure-JavaScript `default` build in
  favor of a build that fails deeper in.
- **Against:** our `browser` would be a half-implementation.
  Every other consumer of that condition, including
  `@endo/compartment-mapper`, also honors the top-level
  `browser` field. nanoid itself publishes one
  (`{"./index.js": "./index.browser.js"}`). Defaulting the
  condition without the field redirection means endor's
  `browser` silently differs from everyone else's.

### B. Profess a Node identity: `node` condition plus builtin shims

Add `node` to the default condition set and furnish a table of
`node:` builtin modules.

- **For:** the largest share of published packages are tested
  against their node build. Where a `browser` build does not
  exist, this is the only lever.
- **Against:** it contradicts a decision already made. The
  `process` shim withholds `versions.node` precisely so
  packages take their non-Node branch. Selecting the node
  build while denying Node-ness at runtime gives a package the
  worst of both: it takes the branch that assumes builtins,
  then fails its own feature detection.
- **Against:** the surface is unbounded. nanoid's node build
  needs `node:crypto` **and** the ambient `Buffer` global,
  which is a `Uint8Array` subclass carrying an encoding and
  pooling API that Endo has spent years replacing with
  `Uint8Array` plus text codecs. Every subsequent package
  finds a new hole, and each hole is a new authority question.
- **Against:** it moves failures later and makes them worse.
  Today an unavailable builtin is a clean link-time error
  naming the specifier. A partial `node` identity fails at an
  arbitrary depth inside a package's node path, after side
  effects.

### C. Keep the default set narrow, opt into conditions, endow web standards

The shape PR #876 landed as a draft. The default set stays
flavor plus `default`. `--conditions browser` is available for
the user who knows their package. The gap is filled by
endowing the **web-standard globals** that both browser builds
and modern node builds use: `crypto.getRandomValues`,
`TextEncoder` / `TextDecoder`, `atob` / `btoa`, and later
`URL`.

- **For:** it changes no existing resolution. Every currently
  working package keeps working, pinned by test.
- **For:** web-standard globals are condition-neutral. They
  help the node build and the browser build equally, and none
  of them grant authority the compartment did not already
  hold.
- **Against:** the default experience for a dual package is
  still a failure. A user must know that `--conditions
  browser` exists and that their package publishes that
  condition. This is a poor answer for `endor run entry.js`
  as a first contact with the tool.

## The distinction the three options blur

Options A, B, and C are not three points on one axis. There
are **two independent levers**, and the argument gets clearer
once they are separated:

| Lever | What it decides | Mechanism |
|---|---|---|
| **Condition set** | Which build of a package is selected | `__archiveExtraConditions`, the exports resolver |
| **Module and global provision** | What a selected build can reach | `ARCHIVE_ENDOWMENTS_JS`, and a possible exit-module table |

Shimming `node:crypto` does **not** require activating the
`node` condition. A `node:crypto` exit module would fix
nanoid's *default* build without touching the condition set at
all, because that build imports the specifier directly. The
two levers can be set independently, and the proposal below
does exactly that: it holds the condition set close to Endo's
existing answer and moves the provision lever where the
provision is powerless.

## Proposal

1. **The default condition set becomes flavor plus `endo`
   plus `default`.** Add `endo` to
   `EXPORTS_RESOLVER_JS`'s active set so endor and
   `@endo/compartment-mapper` agree on the identity endor
   professes. The immediate yield is small, since few packages
   publish an `endo` condition today, but the cost is zero and
   it gives a package a way to ship a build for this runtime
   without guessing whether we are a browser.

2. **`node` never enters the condition set.** The runtime is
   not Node, tells packages so through `process.versions`, and
   should not claim otherwise in resolution. This is the one
   item in the proposal that should be settled permanently
   rather than revisited per package.

3. **`browser` stays opt-in for now**, through the `--conditions`
   flag from PR #876. Two things must be true before it could
   become a default: the corpus experiment below has to show
   that browser builds fail less often than default builds,
   and the top-level `browser` field redirection has to land
   alongside it, so endor's `browser` means what every other
   tool's `browser` means. Neither is true today.

4. **Prefer a web-standard global to a builtin shim, always.**
   `crypto.getRandomValues` over `node:crypto`.
   `TextEncoder` over `Buffer`. `URL` over `node:url`. These
   serve both builds, carry no Node identity, and are the
   surfaces Endo is separately hardening
   ([`hardened-text-codecs-shim.md`](hardened-text-codecs-shim.md),
   [`hardened-url-shim.md`](hardened-url-shim.md)).

5. **Add a narrow `node:` exit-module table, powerless
   entries only, with no `node` condition.** A package whose
   only build imports a `node:` specifier has no condition
   escape, so the provision lever is the only one available.
   The table is an allowlist, and the bar for an entry is that
   it is a pure veneer over something the compartment already
   holds:

   | Specifier | Provide | Backed by |
   |---|---|---|
   | `node:crypto` | `webcrypto`, `randomUUID`, `getRandomValues` | the existing `crypto` endowment |
   | `node:util` | `TextEncoder`, `TextDecoder`, `promisify`, `inherits` | the text codecs, plain JavaScript |
   | `node:events` | `EventEmitter` | plain JavaScript |
   | `node:path` | `posix` only: `join`, `resolve`, `dirname`, `basename`, `extname`, `normalize` | plain JavaScript, no filesystem |
   | `node:assert` | `ok`, `equal`, `deepEqual`, `strict` | plain JavaScript |

   Never in the table, in any form: `node:fs`, `node:net`,
   `node:http`, `node:child_process`, `node:worker_threads`,
   `node:os`, `node:vm`, `node:process`. Each is ambient
   authority or an escape from confinement, and an
   unavailable one must stay a clean link-time error.

   `node:buffer` and the ambient `Buffer` are **deliberately
   excluded**, which is why this item does not fix nanoid's
   default build on its own. `Buffer` is the largest single
   surface in the Node standard library that has a
   web-standard replacement, and adopting it would pull the
   ecosystem's encoding conventions into a runtime that has
   chosen `Uint8Array`. A package that needs `Buffer` is
   telling us its node build is not for us.

6. **Improve the diagnostic, whatever the ruling.** First pin
   which stage reports an unfurnishable `node:` import, since
   the observed message is XS's binding error rather than the
   load hooks' `Module not found`. Then, wherever it is
   reported, the error should name the package, the
   specifier, and whether that package publishes a `browser`
   (or other) condition that would avoid it. For nanoid the
   message becomes actionable in one line:
   `nanoid@5.1.16 selected ./index.js, which imports
   node:crypto; this package also publishes a "browser"
   condition, try --conditions browser`. This is independent
   of the policy and worth landing first.

7. **Record the effective condition set with the run.**
   Conditions are a build-time input everywhere else and a
   run-time input here, so today the same CAS map hash can
   execute two different graphs depending on a flag. Either
   fold the condition set into the compartment map (making it
   part of the archive's identity, matching
   `@endo/compartment-mapper`, and preserving the property
   that a hash names exactly one program), or, at minimum,
   emit it in the run's provenance output. The reproducibility
   claim in the registry-proxy design depends on this.

### Where nanoid lands under each option

| Policy | nanoid@5.1.16 result |
|---|---|
| A. `browser` by default | Works, no flag |
| B. `node` plus shims | Needs `node:crypto` **and** a `Buffer` global |
| C. Opt-in only | Works with `--conditions browser`, fails without |
| This proposal | Works with `--conditions browser`, and the failure without it names the flag |

The proposal is deliberately closer to C than to A. The gap it
leaves is the first-contact experience, and item 6 is what
closes that gap without committing to an identity we have not
yet earned evidence for.

## Design decisions

1. **Build selection and module provision are separate
   levers.** Every prior discussion of this question has
   conflated them. Keeping them separate is what lets the
   proposal shim `node:crypto` without professing `node`.

2. **The runtime professes `endo`, not `node`, not
   `browser`.** It is a third environment, and there is
   already a condition name for it that Endo's own tooling
   uses.

3. **Powerlessness, not popularity, is the bar for a builtin
   entry.** A specifier is furnished when it is a veneer over
   an existing endowment. It is refused when it names
   authority, no matter how many packages want it.

4. **A missing capability fails at link time, loudly.** The
   confined runtime's error is a feature. Partial emulation
   that defers the failure into package internals is worse
   than no emulation.

Considered and rejected: retrying resolution under `browser`
after a `node:` link failure. Reason: it makes the selected
module graph depend on how far evaluation got, so the same
archive resolves differently run to run, and a legitimate
error becomes a silent build switch.

Considered and rejected: a `node_compat` profile flag
bundling the `node` condition with a full builtin table.
Reason: it is option B behind a flag, and the surface it
commits to is unbounded. The narrow allowlist in item 5
serves the same packages that can be served at all.

## Dependencies

| Design | Relationship |
|---|---|
| [`endor-npm-registry-proxy.md`](endor-npm-registry-proxy.md) | Parent. This note resolves the condition-set policy its Known gaps list defers. |
| [`hardened-text-codecs-shim.md`](hardened-text-codecs-shim.md) | The vetted form of the `TextEncoder` / `TextDecoder` endowment item 4 prefers. |
| [`hardened-url-shim.md`](hardened-url-shim.md) | Same, for `URL` and `URLSearchParams`. |
| [`endor-run-expanded.md`](endor-run-expanded.md) | Owns the archive and CAS identity that item 7 would extend. |

Open pull requests this note governs: draft
[#876](https://github.com/endojs/endo-but-for-bots/pull/876)
(the `--conditions` flag and the `crypto` endowment), draft
[#877](https://github.com/endojs/endo-but-for-bots/pull/877)
(text codecs), draft
[#859](https://github.com/endojs/endo-but-for-bots/pull/859)
(the `process` shim whose `versions.node` omission item 2
builds on). None of them should be promoted past draft on the
strength of this note alone: the ruling comes first.

## Test plan

The ruling between "browser opt-in" and "browser by default"
should not rest on argument. It is measurable, and the harness
already exists.

1. **Corpus experiment.** Take a fixed list of the most
   depended-upon packages that publish a `browser` condition,
   50 to 100 of them. For each, `endor run` a one-line entry
   module that imports the package and touches its primary
   export, once with the default conditions and once with
   `--conditions browser`. Record which of the four outcomes
   each lands in: both work, only default works, only browser
   works, neither works. "Only default works" is the count
   that decides item 3. A nonzero count means browser builds
   are reaching for a DOM, and `browser` stays opt-in.
2. **Failure classification.** For every failure in either
   column, classify the cause: missing `node:` builtin,
   missing web global, missing DOM global, or engine surface.
   The missing-web-global bucket is the work queue for item 4.
   The DOM bucket is the risk item 3 is guarding against.
3. **Pinned regressions.** A test per policy item: nanoid
   fails without the flag and works with it; the `semver`
   finish-line probe stays green under both; a package
   importing `node:fs` fails with a clean link-time error
   naming the specifier.
4. **Offline replay.** Every corpus case that passes must
   replay byte-identically under `--offline`, so the policy
   does not quietly depend on a network fetch.

## Open questions

1. Should `browser` be in the default condition set? The
   proposal says no until the corpus experiment says
   otherwise. This is the ruling the note exists to request.
2. Is the `endo` condition worth activating by default given
   that almost no published package uses it today? The
   proposal says yes on alignment grounds alone, and the cost
   is one array entry.
3. Is the powerless-veneer bar for the `node:` allowlist the
   right one, and is the proposed table's membership correct?
   `node:path` in particular is pure string manipulation but
   carries a filesystem connotation the runtime has no answer
   for.
4. Should the effective condition set be folded into the
   compartment map (changing the CAS hash) or only reported?
   Folding it in preserves "one hash, one program" but means a
   condition change refetches nothing and reassembles
   everything.
5. Does `Buffer` stay permanently excluded? The proposal
   treats it as a line worth holding, and it is the single
   decision that most limits how much of the registry runs
   unmodified.
