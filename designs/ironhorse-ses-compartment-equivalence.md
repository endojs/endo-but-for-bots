# IronHorse: SES `Compartment` and `lockdown` equivalence

| | |
|---|---|
| **Created** | 2026-09-15 |
| **Author** | kumavis (prompted) |
| **Status** | Proposed |
| **Source** | Measured against tree `95e7ee99` while working Phase 4 of [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) |

## Status

Nothing here is implemented.
This is a handoff: what the stage-4 SES gap actually is, measured rather than
assumed, and what a reader who was not present needs in order to size it.

The one thing that did land is the measurement itself —
`rust/engine/ironhorse-262/tests/stage4_ses_boot.rs`, which dual-runs the
daemon's own boot sequence against the XS oracle and pins the gap so it can
neither widen nor close silently.

## What is the Problem Being Solved?

`designs/ironhorse-engine.md:37` records stage 4, Hardened JavaScript, as
"Partial — bar not met", and `:940` states the bar as "the endor daemon boot
bundles … running identically on both engines".
Read literally, that bar is already met and has been for some time.
It is the wrong bar, and reading it literally hides the real gap.

## What the measurement found

`stage4_ses_boot.rs` runs five cranks on one machine through
`dual_run_cranks`: a census, `polyfills.js`, a census, `ses_boot.js` through
`eval_wrapped`'s try/catch shape (`rust/endo/xsnap/src/lib.rs:1078`), a census.
The census brackets are what make the assertions deltas; the earlier reading of
this bar, taken without a pristine crank, misattributed two globals.

**The bundle agrees, and does almost nothing.**
Both engines evaluate `ses_boot.js` to `'ok'`, and on both engines exactly one
census entry moves across it: `HandledPromise`, `undefined` to `function`.

**`ses_boot.js` is not the SES shim.**
It is `@endo/harden`, `@endo/env-options`, `@endo/eventual-send` and the
daemon's own boot file — 70 KB, not the "~1 MB" its ledger row claims
(`rust/engine/CHANGELOG.md:900`).
The tree already says so in three places, most directly
`packages/daemon/src/bus-worker-xs-ses-boot.js:16-38`; this measurement
confirms it rather than discovering it.
Its only `globalThis` write is `HandledPromise`.
`@endo/harden`'s selector *reads* `globalThis.harden` and installs nothing,
because `polyfills.js` got there first.

**The pristine census**, before any source runs:

| | `lockdown` | `harden` | `petrify` | `mutabilities` | `Compartment` |
|---|---|---|---|---|---|
| XS oracle | `function` | `function` | `function` | `function` | `function` |
| IronHorse | `undefined` | `function` | `function` | `undefined` | `undefined` |

The table looks like a four-name gap.
The next section is why it is a one-name gap: four of those five oracle entries
are not what the daemon runs on.

**Two traps for anyone re-measuring.**
`harden` and `petrify` are present on IronHorse *before* `polyfills.js` runs —
they are IronHorse's own bindings from `create_hardened_globals`
(`ironhorse-vm/src/interp/boot.rs:2086`), not the polyfill's deep-freeze and
not the bundle's.
A census taken after `polyfills.js` cannot tell those apart, because
`polyfills.js:158` installs a `harden` of its own when it finds none.
And `Object.isFrozen(Object.prototype)` is `false` on *both* engines
throughout — no lockdown runs anywhere in this sequence, so a bar that probed
it would be asserting the absence of the thing it was meant to check.

## What XS implements

Everything SES-shaped in XS lives in two files.

| | |
|---|---|
| `xs/sources/xsLockdown.c` | `fx_lockdown`, `fx_harden`, `fx_petrify`, `fx_mutabilities` and the `fxVerify*` audit family (974 lines) |
| `xs/sources/xsModule.c:2864` | `fx_Compartment`, plus `get globalThis`, `evaluate`, `import`, `importNow` on its prototype (`:200-205`) |

**Only `Compartment` is a realm intrinsic.**
`fxBuildModule` builds it into every realm (`xsModule.c:207`), so every XS
machine has it.
The other four are **embedder-installed globals**: `fxCreateMachine` binds none
of them, and each host picks a subset — `xst.c:428-429` installs `harden` and
`lockdown`, `xstFuzz.c:494` installs `lockdown` and `mutabilities`, and our
oracle shim installs all four
(`rust/engine/xs-oracle/csrc/xs_shim.c:373-381`).

This is the finding that resizes the gap.
**The daemon's xsnap installs none of them.**
`rust/endo/xsnap/src/ffi.rs:274-275` declares `fx_harden` and `fx_lockdown` and
calls neither, as `lib.rs:917` already records.
So the daemon's XS realm has `Compartment` and no `lockdown`, no native
`harden`, no `petrify`, no `mutabilities` — the `harden` it runs on is
`polyfills.js`'s deep-freeze, the same one IronHorse's guests would see.

Measured against the daemon's XS rather than against the oracle's shim, the
SES surface IronHorse lacks is **exactly one name: `Compartment`.**
The oracle's other three entries are differential-testing scaffolding.

### `fx_lockdown`, in order

Reading `xsLockdown.c:74-205` as a specification of what a native IronHorse
`lockdown` would have to do:

1. **Idempotence.** `XS_DONT_MARSHALL_FLAG` on `mxProgram`; a second call is a
   `TypeError("lockdown already called")` (`:87-89`).
2. **Remove the evaluators from the shared realm.** `.constructor` on
   `Function.prototype`, `AsyncFunction.prototype`,
   `GeneratorFunction.prototype`, `AsyncGeneratorFunction.prototype` and
   `Compartment.prototype` is replaced with a duplicate of `%ThrowTypeError%`
   carrying `XS_CAN_CONSTRUCT_FLAG` and a `prototype` property (`:91-103`,
   `fx_lockdown_aux` at `:52`).
   After lockdown the only evaluators are the fresh per-compartment ones
   `fx_Compartment` mints.
3. **Snapshot a compartment-global template.** An array of every intrinsic,
   stored as `mxCompartmentGlobal` (`:105-120`), which every later compartment
   is built from.
4. **Tame `Date` and `Math` — into the template only.** `fx_Date_secure`,
   `fx_Date_now_secure`, `fx_Math_random_secure` and `fx_Math_irandom_secure`
   replace the real ones *in the template array* (`:122-139`), so the host
   global keeps its powers and every compartment gets powerless versions.
   This is the one place XS implements ocap attenuation rather than integrity.
5. **Harden.** The guest `harden` is fetched off the global and called over
   every intrinsic, the hidden prototypes (arguments, iterators,
   async-from-sync, host, module, transfer, typed array), the internal helper
   functions and accessors, `Array.prototype[Symbol.unscopables]`, the
   compartment template, `harden` itself and `Function` (`:141-201`).

Against IronHorse's `Interp::new_shared_realm_machine_with_permit`
(`ironhorse-vm/src/interp/realm.rs:108-165`), which links intrinsics,
`do_harden`s every arena instance except the global and the template cache,
then sets `locked_down: true` and `shared_compartments = true`:

| `fx_lockdown` step | IronHorse | Note |
|---|---|---|
| idempotence throw | — | it is a constructor, so the question does not arise |
| evaluators removed from the realm | — | frozen in place and still reachable |
| per-compartment evaluators | partial | `compartment_evaluator` (`realm.rs:72`) re-homes `Eval` and `Function` only, while the `global_env` fixup at `:152-164` covers five natives — `GeneratorFunction`, `AsyncFunction` and `AsyncGeneratorFunction` are re-homed to the *default* global, not the compartment's |
| compartment-global template | — | globals are built per compartment from `global_props` |
| Date/Math taming | — | nothing in `ironhorse-vm` tames either |
| transitive harden | **yes, wider** | XS hardens an enumerated list; IronHorse hardens every instance in the arena |

Step 5 is done and then some.
Steps 1–4 are absent, and step 2 is the load-bearing one: without it a
compartment in IronHorse can reach an evaluator bound to the default global.

### `fx_harden` and `fx_petrify`

Both are already transliterated, faithfully.
`Interp::do_harden` (`ironhorse-vm/src/interp/property/integrity.rs:17`) is
`fx_harden` plus `fx_hardenQueue` plus `fx_hardenFreezeAndTraverse`, including
the detail that matters: XS clears the visited bit from every queued instance
when a proxy trap or a property definition throws mid-walk (`xsLockdown.c:385`),
so a later `harden` retries rather than short-circuiting a half-frozen graph.
IronHorse does the same (`integrity.rs:33-42`).
`do_petrify` (`:155`) is `fx_petrify`: a single-object freeze that additionally
marks internal data (ArrayBuffer, Date, Map, Set, WeakMap, WeakSet) and private
fields read-only.

Two XS details worth knowing before extending either: `fx_harden`'s second
argument (`harden(x, "petrify")`) and its "call lockdown before harden" guard
are both present-but-commented-out in `xsLockdown.c` (`:350-360`, `:348`).
XS deliberately does not require lockdown before harden.

### `fx_mutabilities`

The one piece with no IronHorse counterpart at all and no SES counterpart
either.
`fx_mutabilities(x)` (`xsLockdown.c:486`) walks from `x` and returns a sorted
array of every path that is still mutable, via `fxVerifyInstance` /
`fxVerifyProperty` / `fxVerifyCode` — including a **bytecode** scan
(`fxVerifyCode:562`) that finds mutable references reachable from compiled
function bodies, which no JavaScript-level audit can see.
It is XS's answer to "did lockdown actually cover everything", and it is the
reason XS can assert its own hardening rather than assume it.
`create_hardened_globals` names it as a deliberate decline
(`boot.rs:2080-2085`): a program referencing it gets `Halt::NotImplemented`.

### `fx_Compartment`

`fx_Compartment` (`xsModule.c:2864`) allocates a program instance, then a fresh
global object populated by copying intrinsic *references* — from the
`mxCompartmentGlobal` template when lockdown has run, from the live intrinsics
otherwise (`:2901-2919`).
The id enum is the mechanism: `_Infinity`, `_NaN` and `_undefined`
(`xsCommon.h:854-856`) are installed `XS_GET_ONLY` and everything before them
`XS_DONT_ENUM_FLAG`, and the copy loop stops at `_Compartment`, which the enum
follows with `_Function` and `_eval` — the three a compartment gets fresh
rather than copied.
It mints those three bound to the new program (`:2921-2955`, plus
`ModuleStuff` where `mxModuleStuff` is enabled), and after lockdown stamps each
`XS_DONT_PATCH_FLAG` with every own property non-writable and non-deletable
(`fxPrepareCompartmentFunction:2849`).
Finally it builds a `Realm` and adopts the module map's unclaimed modules into
it (`:2985-2998`).

Note what this means for the intrinsic graph: the compartment's globals are
*properties of a fresh global object holding references to the one shared
frozen graph*, not copies.
That is the same architecture PR #1263 gave IronHorse.

## Equivalence: `Compartment`

SES's constructor options (`packages/ses/src/compartment.js:353-366`), XS's
(the keys `fx_Compartment` reads, `xsModule.c:2978-3113`), and IronHorse's
`CompartmentOptions` (`ironhorse-vm/src/compartment.rs:265-288`):

| SES option | XS | IronHorse | Assessment |
|---|---|---|---|
| `name` | — | `name: Option<String>` | IronHorse matches SES; XS has no name at all |
| `globals` | `globals` | `endowments`, `endowments_by_id` | all three present; the `_by_id` map is a compiler-era workaround, "until the compiler/symbol table lands" |
| `modules` | `modules` | `modules: ModuleGraph` | present in shape on all three; IronHorse's semantics unverified |
| `resolveHook` | `resolveHook`, callable-checked | `has_resolve_hook: bool` | **shape only** on IronHorse — a boolean, not a callable |
| `importHook` | `importHook`, falling back to `loadHook` | `has_import_hook: bool` | **shape only**, same |
| `importNowHook` | `importNowHook`, falling back to `loadNowHook` | — | absent |
| `moduleMapHook` | read as `undefined` (`:3074`) | — | XS declines it explicitly |
| `importMetaHook` | read as `undefined` (`:3112`) | — | XS declines it explicitly |
| `transforms`, `__shimTransforms__` | — | — | shim-only |
| `__noNamespaceBox__`, `noAggregateLoadErrors` | — | — | shim-only |
| — | `globalLexicals` | — | XS-only; per-name writability from the descriptor (`:3027-3060`) |
| — | — | `intrinsic_permit` | IronHorse-only; see below |

The hooks are the load-bearing row.
`has_resolve_hook` exists so a constructor-shape probe can observe it; it does
not resolve anything.
A guest `Compartment` bound over this would answer `typeof` and
constructor-shape questions and fail the first program that actually imports a
module.
XS is the useful reference here precisely because it is honest about the same
boundary: it callable-checks the hooks it honours and pushes `undefined` for
the two it does not.

`intrinsic_permit` is IronHorse's own, and its doc is explicit that it
"controls bindings, not transitive reachability through endowed objects" —
which is **not** SES's attenuation model, and not XS's either.
Binding a guest `Compartment` over it would present an attenuation story no
layer implements.

## Equivalence: `lockdown`

XS's `fx_lockdown` is not SES's `lockdown()` either, and the difference is
large enough that "match XS" and "run the shim" are genuinely different
projects with different costs.

`packages/ses/src/lockdown.js` calls, in sequence: `tameDomains`,
`tameNaNSideChannel`, `tameLocaleMethods`, `tameFauxDataProperties`,
`removeUnpermittedIntrinsics`, `enablePropertyOverrides`,
`tameRegeneratorRuntime`, and a tamed `harden` (`:345`, `:363`, `:454`, `:456`,
`:469`, `:550`, `:558`, `:583`) — over a permits table (`permits.js`,
`permits-intrinsics.js`, `enablements.js`) and per-intrinsic taming modules for
Date, Math, RegExp, Symbol, Temporal, URL, Error, the function constructors,
`Function.prototype.toString` and module source.
It takes `errorTaming`, `errorTrapping`, `reporting` and
`unhandledRejectionTrapping`; XS takes no options at all.

| | SES shim | XS native | IronHorse |
|---|---|---|---|
| transitive freeze of intrinsics | yes | yes | **yes** |
| evaluators removed from the locked realm | yes | yes | no |
| Date/Math attenuated for compartments | yes | yes | no |
| permits table / unpermitted removal | yes | no | no |
| property-override enablement | yes | no | no |
| locale, NaN side channel, domains, regenerator | yes | no | no |
| error taming and trapping options | yes | no | no |
| mutable-residue audit | no | **yes** (`mutabilities`) | no |

XS's is the smaller, sharper artifact: five steps, no permits table, and an
audit the shim does not have.
If the goal is "the daemon's Ironhorse worker behaves like its XS worker", XS
is the specification, and it is a few hundred lines rather than a package.

## What a next step should establish first

In this order, because each answer changes the next question's cost:

1. **Decide what the daemon actually needs.**
   The measurement above narrows this sharply: the daemon's XS has no
   `lockdown` either, so the IronHorse-versus-daemon gap is `Compartment`
   alone.
   Does the Ironhorse worker path need a guest-visible `Compartment`, or does
   it need the Rust-level compartment API exposed to `rust/endo` and driven
   from there?
   The second is much cheaper and may be sufficient for the worker protocol,
   which is Phase 5's actual consumer.
2. **If guest-visible SES is required, decide shim versus native.**
   Native means implementing `fx_lockdown`'s five steps and `fx_Compartment`,
   inheriting XS's divergences from the shim — and that is what the daemon
   would get from an XS worker today, so it is the parity-preserving choice.
   The shim means implementing what `packages/ses` needs, which is a larger and
   better-specified surface.
   One blocker either way: `polyfills.js` installs
   `Object[Symbol.for('harden')]` non-configurable
   (`designs/worker-rust-xs.md:513-519`), which the shim's own selector notes
   "will prevent any HardenedJS's lockdown from succeeding" — so bundling the
   real shim needs `polyfills.js` changed first.
   And lockdown replaces `globalThis`, dropping the `host<Name>` aliases both
   bootstraps resolve through (`:520-527`).
3. **Do not treat `CompartmentOptions` as SES-compatible** without walking the
   table above.
   Two of its hook fields are booleans.
4. **Fix step 2 of the lockdown table regardless.**
   `compartment_evaluator` re-homing only `Eval` and `Function` while the
   `global_env` fixup covers five natives is a hole in the existing realm
   sharing, independent of whether any of this is exposed to guests.
5. **The ledger row now names the right thing; keep it that way.**
   `boot:ses-lockdown-bundle` (`rust/engine/CHANGELOG.md:900`) and the comment
   it came from described `ses_boot.js` as a ~1 MB rollup artifact carrying
   SES `lockdown()` whose bundling was out of the engine workspace's scope.
   Four things wrong, all corrected in the change that added this document:
   it is 70 KB, the bundler is `@endo/compartment-mapper`'s `makeBundle`, it
   carries no `lockdown`, and `yarn bundle:xs` now runs in the oracle lane.
   The guest-`lockdown` gap the row was named for is tracked by
   `ses-mode:lockdown-unimplemented` and `compartment:intrinsic-surface`, and
   those are the rows a next step should be reading.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) | Phase 4 is where this gap sits; that document carries the measurement and points here for the equivalence detail. |
| [ironhorse-engine](ironhorse-engine.md) | Owns stage 4 (`:37`) and its acceptance wording (`:940`). Its `:201` note that XS implements SES natively is true of the implementation and misleading about the bindings — see § What XS implements. |
| [worker-rust-xs](worker-rust-xs.md) | § Known Gaps (`:501-531`) already carries the three-part dependency between `polyfills.js`, the `host<Name>` aliases and any real lockdown. |
| [ironhorse-w6-decisions](ironhorse-w6-decisions.md) | §1 is the Realm decision whose extraction (PR #1263) built the compartment machinery this document inventories. |

## Known Gaps and TODOs

- [ ] Answer question 1 above — daemon need — before anything else.
      It is the only question whose answer can make the rest unnecessary.
- [ ] Verify `ModuleGraph` against SES and XS module-map semantics.
      This document checked the option's presence, not its behaviour.
- [ ] Establish whether `intrinsic_permit` can be made to mean SES attenuation
      or should be renamed so it stops looking like it already does.
- [ ] `stage4_ses_boot.rs` runs in `test-ironhorse-oracle`, which triggers on
      `rust/engine/**` only.
      A change to `packages/daemon/src/bus-worker-xs-ses-boot.js` alone will
      not re-run the bar; `build-xsnap` covers the daemon side.
- [ ] The bar does not run `bootstrap_ses`'s closing `run_promise_jobs()`, so
      it cannot see a divergence in how the two engines settle what
      `@endo/eventual-send`'s shim leaves pending.

## Prompt

> record or frame the follow up SES / Compartment / lockdown equivalence in a
> work document as a handoff
>
> you can look at what XS implements for reference into what we're trying to
> provide with SES natively with IronHorse

Written after a session that measured the stage-4 bar rather than reasoning
about it, prompted by the observation — correct — that "we have support for
multiple Compartments in a Realm in IronHorse, it must just not be exposed to
the environment".
