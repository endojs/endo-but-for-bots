# IronHorse: a guest `Compartment`

| | |
|---|---|
| **Created** | 2026-09-18 |
| **Updated** | 2026-09-19 |
| **Author** | kumavis (prompted) |
| **Status** | In Progress (phase 1 landed, less `globalLexicals` and the step-3 template) |
| **Source** | The scope boundary [ironhorse-native-lockdown](ironhorse-native-lockdown.md) drew, and the `Compartment` half of [ironhorse-ses-compartment-equivalence](ironhorse-ses-compartment-equivalence.md) |

## Status

Phase 1 landed, less two pieces named below.

[ironhorse-native-lockdown](ironhorse-native-lockdown.md) landed `fx_lockdown`
steps 1, 2 and 5 and named a guest `Compartment` as explicitly out of scope,
which put steps 3 and 4 out of scope with it.
This is that remainder: bind a guest-callable `Compartment` constructor in
`ironhorse-vm` over the multi-compartment machinery PR #1263 already built, and
fold in the two deferred steps.

**Built.**
`Native::Compartment` is a boot intrinsic with its own
`%Compartment.prototype%` (`interp/native_ids.rs`, `interp/boot.rs`
`create_compartment`), carrying `evaluate`, a `globalThis` getter and a
`Symbol.toStringTag` data property.
Construction (`interp/natives/compartment.rs`) validates `globals`,
`globalLexicals`, `modules` and `name`, copies the endowments' own enumerable
string keys onto a fresh global from `create_environment`, and inherits the
calling environment's source compiler.
`compartment_evaluator` mints `Compartment` beside `eval` and `Function`.
Per-instance state and the environment lease live in the `guest_compartments`
side table, which is also the brand every prototype member checks.
`ironhorse-vm/tests/guest_compartment.rs` is the suite.

`globalLexicals` are bound: `CompartmentEnvironment::global_lexicals` holds one
standalone cell per name, consulted by `dispatch_get_variable` and
`dispatch_set_variable` BETWEEN the frame and the global object, so a lexical
shadows a global, is invisible on `globalThis`, and is `const` when its source
descriptor was not writable.

`Compartment.prototype` is `fx_lockdown` step 2's sixth stand-in
(`locked_down_prototypes`), which is its fifth call in XS.

**Not built, and deliberately so.**

- **The step-3 template and its step-4 attenuation** (§ 4, § 5 below).
  § 4 records the decision — a template, freezing `Object.prototype` as data —
  and why phase 1 did not build it: with no `Math.random` and a `Date.now()`
  that already returns `0.0`, a template would hold exactly what
  `self.intrinsics` holds, so the clause meant to pin it is not yet
  expressible.
- **Module loading**, all of it. Phase 2.
- **Persisting a live compartment** (§ 7). A machine holding one is refused at
  the persist gate by presence.

**Measured.** The hardened262 corpus gate
(`ironhorse-262/tests/native_lockdown_corpora.rs`) moves from
54 passed / 36 known failed / 76 excluded files to
**69 passed / 75 known failed / 7 excluded files and 32 excluded scenarios** —
54 more scenarios judged, 15 more passing.
The blanket `test/Compartment/` + `test/modules/` path exclusion is gone.
Thirteen files now pass in at least one scenario:

| file | scenarios |
|---|---|
| `constructor/globals-types.js` | strict, lockdownStrict |
| `constructor/globals-properties.js` | strict, lockdownStrict |
| `constructor/globalLexicals-types.js` | strict, lockdownStrict |
| `constructor/options-type.js` | strict, lockdownStrict |
| `evaluate.js` | all four |
| `prototype/Symbol.toStringTag.js` | strict, sloppy |
| `prototype/Symbol.toStringTag-lockdown.js` | lockdownStrict |
| `prototype/globalThis/defaults.js` | strict |
| `constructor/globalLexicals-properties.js` | strict, lockdownStrict |
| `prototype/evaluate/environments.js` | strict, lockdownStrict |
| `import-now-hook/module-source-descriptor-sees-globals.js` | all four |
| `import-now-hook/namespace-descriptor.js` | all four |
| `import-now-hook/returns-undefined.js` | all four |

The last three are phase-2 files that pass without module loading, which was
not predicted: each asserts what a compartment does with a descriptor it never
has to resolve.
`ses-xs-parity` reach goes **6/8 to 7/8 covered**, zero divergence — one case,
not the two this note first predicted.
`Symbol.toStringTag.js` moved; `Symbol.toStringTag-lockdown.js` is the
remaining `oracle-shim-unsafe:lockdown` skip, held out for a reason about
`lockdown` rather than about `Compartment`, so the eighth case is not this
work's to take.

## What is the Problem Being Solved?

`Compartment` is a host-side Rust API (`ironhorse-vm/src/compartment.rs`) with
no guest binding.
`typeof Compartment` answers `"undefined"` in every IronHorse realm, and
`new Compartment()` is an ordinary
`ReferenceError: get Compartment: undefined variable`.

**This is conformance coverage, not a product dependency**, and that was
settled after this note's first draft.
Two of the three justifications below are withdrawn: `packages/thixotrope`'s
realm-profile question was answered "keep the SES shim", and the endor daemon's
eventual native profile is deferred outright (endor has no IronHorse worker and
never calls `lockdown`; it runs XS).
The SES shim installs its own `Compartment`, so no embedder in this tree
depends on the native one.
What remains is the corpus, unchanged and still real — plus differential
fidelity against the XS oracle.
Nothing is blocked on this shipping, which is why phase 1 lands cleanly rather
than reaching for phase 2.

**75 of `packages/hardened262`'s 123 test files.**
`rust/engine/ironhorse-262/tests/native_lockdown_corpora.rs:130` excludes
`test/Compartment/` (68 files) and `test/modules/` (7) from the shared-corpus
gate, and asserts each excluded case is already failing in the committed
IronHorse baseline.
The baseline agrees exactly: across all twelve scenario directories under
`packages/hardened262/baseline/ironhorse/`, `test/Compartment/` contributes
**0 passed and 67 failed** — 64 in each strict scenario, 12 in each sloppy
scenario, 66 in each module scenario.
The 68th file, `test/Compartment/legacy-module-method.js`, is `onlySesNode` and
IronHorse never runs it.

**2 of the 8 cases on the `test262:ironhorse` engine lane — not all 8.**
`packages/test262-runner/README.md` records 0/8 covered with 8 named skips.
`Symbol.toStringTag.js` and `Symbol.toStringTag-lockdown.js` skip on
`feature:Compartment`; the other six are `shared-positive-test-failure` and
need `frozenBytes`, `compareBytes`, `concatBytes`, `passStyleOf` and
`environment`, which no engine has natively.

~~**Thixotrope's IronHorse worker migrating off the SES shim.**~~ Withdrawn
2026-09-18: `packages/thixotrope` keeps the shim.
The isolation half works either way —
`native_lockdown.rs::a_host_made_compartment_confines_guest_source_only_with_global_names`
pins it.

## Which `Compartment`: the corpus is XS-shaped

An earlier framing of this work held that the corpus is SES-shaped, that
transliterating `fx_Compartment` therefore could not pass it, and that the
project had to choose between matching SES (passes the corpus, loses the
oracle) and matching XS (keeps the oracle, fails the corpus).
**Measured against the checked-in baselines, that is backwards**, and the
choice it describes does not exist.

Outcomes for the 68 files in `packages/hardened262/test/Compartment/`, from
`packages/hardened262/baseline/<agent>/*/{passed,failed,skipped}.txt`:

| agent | passed | failed | never runs |
|---|---|---|---|
| `xs` (bare XS, no SES) | **51** | 4 | 13 |
| `sesNode` (SES shim on Node) | 11 | 36 | 21 |
| `sesXs` (SES shim on XS) | 6 | 42 | 20 |
| `ironhorse` | 0 | 67 | 1 |

XS passes 51 of the 55 cases it is allowed to run.
The SES shim passes 11 of 47.
The corpus is written against XS, and the four cases XS fails are
`constructor/modules-types.js`, `import-hook/module-source-evaluate.js`,
`import-now-hook/record-and-specifier-descriptor.js` and
`import-now-hook/redirect-record.js`.

The exemplar the earlier framing rested on —
`test/Compartment/constructor/globalLexicals-properties.js`, whose description
reads *"SES dropped support for globalLexicals"* — does not assert that
`globalLexicals` are ignored.
It asserts XS's semantics in detail, and XS passes it:

```js
assert.sameValue(getterCount, 2, 'getterCount');   // one read per compartment
assert.sameValue(neverCount, 0, 'neverCount');     // inherited, non-enumerable
                                                   // and symbol keys untouched
assert.sameValue(c1.evaluate('foo'), 1, 'c1.globalLexicals.foo');
assert.sameValue(c1.globalThis.foo, undefined, 'c1.globalThis.foo');
```

The lexical is honoured inside the compartment, is absent from that
compartment's `globalThis`, is copied per compartment rather than shared, and
is read once per construction from own enumerable string-keyed properties only.
That is `fx_Compartment` (`xsModule.c:3030`), described precisely.
The file's `description` explains why its `noSesXs,noSesNode` flags exclude the
two SES agents; it is not a statement about what the assertions check.
`prototype/globalThis/defaults.js` is blunter still — its description says
*"Passes with XS, but not with XS under Lockdown"*, and its body makes an
allowance for XS 9's per-compartment `ModuleStuff` host object.

**Decision: build XS's `Compartment`.**
It is oracle-adjudicable by `endot-ih`, consistent with how `lockdown()` was
ported, and it is also the thing that passes the corpus.
The divergences that remain are individually small and are enumerated per
phase below, rather than being a project-level fork.

Three files in phase 1 carry `noXs` and so have no oracle at all
(`prototype/Symbol.toStringTag.js`, `prototype/Symbol.toStringTag-lockdown.js`,
`evaluate-transforms.js`); they are adjudicated by the corpus, and each owes a
row in the native-lockdown note's § Oracle divergences.

## What already exists

The host-side machinery is built, and the guest constructor is a binding over
it rather than a new subsystem.

| piece | where | state |
|---|---|---|
| Per-compartment environments | `interp/realm.rs:879` `create_environment` | built; fresh global object, own `global_props`, own module map |
| Fresh `eval`/`Function` per compartment | `interp/realm.rs:109` `compartment_evaluator` | built; re-allocates the evaluator bound to the new `global_env` under `shared_compartments` |
| Global population | `interp/link.rs:240` `install_intrinsic_bindings` | built; walks `self.intrinsics`, honours `global_names`, sets `XS_DONT_ENUM_FLAG` |
| Option bag | `compartment.rs:265` `CompartmentOptions` | built in shape: `name`, `endowments`, `endowments_by_id`, `modules`, `global_names`, and the two hook booleans |
| Environment switching | `interp/realm.rs` `switch_environment` / `activate_environment` | built |
| `lockdown()` steps 1, 2, 5 | `interp/realm.rs` `do_lockdown` | landed |

What does not exist: any `Native` variant for `Compartment`, any entry in
`Native::intrinsics()`, any prototype object, any per-instance brand, the
step-3 template, and the step-4 attenuation.

## The work

### 1. The `Compartment` intrinsic

This is the boot-graph change, and it follows the `Map`/`Date` pattern exactly.

- Add a `Compartment` variant to `Native` (`interp/native_ids.rs:1000`), with
  its `name()` arm returning `"Compartment"` and `arity()` returning 1
  (`fx_Compartment` takes the single options bag; SES's legacy positional form
  is not XS's surface and is not modelled).
- Add `("Compartment", Native::Compartment)` to `Native::intrinsics()`
  (`interp/native_ids.rs:1243`).
  That alone mints the constructor object with `%Function.prototype%` as its
  `[[Prototype]]` and registers it in `self.intrinsics`, which is what makes
  `link_intrinsics` bind the name and `install_intrinsic_bindings` place it on
  every compartment global.
- Add a `Native::Compartment` arm to the prototype match in `create_intrinsics`
  (`interp/boot.rs:308`), allocating `%Compartment.prototype%` as a plain
  instance chaining to `%Object.prototype%`, exactly as `Map` and `Set` do.
  `create_intrinsics` already wires `ctor_prototype`, `prototype` and
  `prototype.constructor` for every entry.
- Add a `create_compartment()` boot function beside `create_date`
  (`interp/boot.rs:2359`) registering the prototype members through
  `alloc_named_method` + `proto_methods`, so `name` and `length` are pinned
  rather than defaulted:

  | member | kind | arity |
  |---|---|---|
  | `evaluate` | method | 1 |
  | `globalThis` | getter | 0 |
  | `import` | method | 1 |
  | `importNow` | method | 1 |
  | `[Symbol.toStringTag]` | value `'Compartment'`, `{writable:false, enumerable:false, configurable:true}` | — |

  `import` and `importNow` are phase 2; phase 1 registers `evaluate`,
  `globalThis` and the tag.
  Use `alloc_named_method`, not `alloc_method` — the latter hard-codes
  `name_chunk = ""` and arity 0, which is the bug
  `create_hardened_globals` (`interp/boot.rs:2144`) had to fix for `harden` and
  `petrify`.
- Add the construct arm in `interp/natives/dispatch.rs`, beside the
  `Native::Map | Native::Set if has_target` arm at `:909`.
  A bare `Compartment(...)` call without `new` is a `TypeError`, on the
  `Native::WeakMap | Native::WeakSet | Native::Map | Native::Set` fallthrough
  pattern at `:961`.

Metering: the Map/Set arm charges its `fxNewSlot`s and its initial chunk
explicitly because the table lives in a side table.
A compartment's cost is dominated by `create_environment` — a global object
plus one property per bound intrinsic name — and the arm must charge that
rather than a constant, or a guest loop over `new Compartment()` buys
unmetered allocation.

### 2. Instance state, and the lifetime question

**This is the one genuinely new design problem, and it should be settled before
any of the above is written.**

A host `Compartment` today is a Rust value (`compartment.rs:394`
`from_options`) holding `lease: Rc<()>`, whose `Weak` is handed to
`create_environment` as `owner` and is what `reap_environments`
(`interp/realm.rs:1017`) consults — an environment whose owner's
`strong_count()` has reached zero is collectable.
Construction does not build the environment; it pushes a `PendingEnvironment`
into `machine.pending`, and the environment is materialized on first use.

A guest-created compartment has no Rust owner.
Its lifetime is the guest object's, which is the arena's, which is the GC's.
Three shapes are available:

1. **Guest instance owns a host `Compartment`.**
   A `compartments: HashMap<SlotIndex, Compartment>` side table beside
   `collections` and `array_buffers`, holding the Rust handle whose `lease`
   keeps the environment alive; the entry is dropped when the instance is
   collected, at which point the lease drops and `reap_environments` may
   reclaim.
   This reuses `new_compartment_with` unchanged and is the smallest change to
   the existing ownership model.
   It requires the GC to drop side-table entries for dead instances, which is
   the same contract `collections` already has.
2. **Guest instance holds the `EnvironmentId` only**, with the lease held by
   the machine for as long as the instance is reachable.
   Avoids storing a Rust handle in the arena's shadow, but needs a second
   liveness rule, and `live_environment_ids` already exists to state it.
3. **A self-lease**: `create_environment` accepts an owner that is the guest
   instance's own reachability.
   Cleanest conceptually and the largest change to `realm.rs`.

Shape 1 is the recommendation.
Whichever is chosen, the brand check for
`Compartment.prototype.evaluate.call(notACompartment)` is presence in that
side table, matching how `CollKind` brands a Map.

### 3. `globalThis` and `evaluate`

`Compartment.prototype.globalThis` is a getter returning the compartment's
global object as an ordinary reference.
`create_environment` returns that `SlotIndex` directly, so the getter is a side
table lookup and a `Payload::Reference`.
`evaluate.js` pins the two properties that matter and both are already true of
`create_environment`'s output: a compartment's `Compartment` is callable
(`new parent.globalThis.Compartment()` constructs), and intrinsics are shared
by identity across compartments (`[] instanceof child.globalThis.Array`).

`Compartment.prototype.evaluate(source)` is `switch_environment` to the
compartment, compile as a Script, run, switch back.
The existing `Compartment::evaluate` host path does this; the guest method is
the same operation without the Rust handle.
Two failure modes need naming rather than inheriting: a compartment with no
`source_compiler` is `Halt::Refused("machine:compiler-policy-owner-dropped")`
today, which is not a guest-facing error, and an evaluation that throws must
propagate as a guest exception in the *calling* compartment with the
environment restored.

`globalLexicals` is a scope between the compartment global and the evaluated
source, per-compartment and per-`evaluate`-call persistent (the corpus reads
`bar` back on a second `evaluate` of the same compartment).
`environments.js` pins that lexicals are invisible on `globalThis` while
`globals` are visible on it.
IronHorse has no such intermediate scope today; this is the largest single
piece of phase 1.

### 4. Step 3 — the compartment-global template

`fx_lockdown` step 3 allocates `fxNewArray(the, _Compartment)`
(`xsLockdown.c:105`), fills it from the intrinsics up to but not including
`_Compartment`, and stores it as `mxCompartmentGlobal` (`:139`).
IronHorse has no template object: `install_intrinsic_bindings`
(`interp/link.rs:240`) reads `self.intrinsics` live, every time.

**Decided: introduce a template**, and D2 says what goes in it — a
boot-allocated object filled at lockdown time, which
`install_intrinsic_bindings` prefers over `self.intrinsics` when `locked_down`
is set, freezing `Object.prototype`'s data properties AS DATA.
Closest to XS, snapshot-visible, and it gives step 4 somewhere to put an
attenuated `Math`.

The alternative — attenuating at environment-creation time, with no template —
is smaller, but every future attenuation becomes a branch in the binding loop
and there is no single object to harden or to hand to `endot-ih` for
comparison.

**Deferred, not abandoned: phase 1 did not build it, because today it would
change nothing.**
The decision above stands and is what a later change should implement; what
does not stand is building it now. Three measurements say so:

- **Step 4 has nothing to put in it.** `Math.random` does not exist and
  `Date.now()` already returns `0.0` (§ 5). A template filled at lockdown
  would hold exactly the entries `self.intrinsics` already holds.
- **Nothing mutates `self.intrinsics` after linking**, so "read the template"
  and "read the live map" cannot diverge. The one runtime insert,
  `install_test262_host`'s `$262`, panics if called after `link_intrinsics` and
  is harness-only.
- **A compartment made before lockdown and one made after already agree**,
  because both hold REFERENCES into the one shared graph rather than copies, so
  freezing that graph reaches both. That is XS's architecture too.

So the acceptance clause this note wrote for it — "a compartment made after
`lockdown()` reads the attenuated template, and one made before does not share
it" — is not merely unmet, it is not yet expressible: with nothing attenuated
there is no observable difference for a test to pin. Building the seam now
would move the boot fingerprint a third time, add an `Interp` field to four
registries, and buy a branch nothing takes.

The seam earns its place when ironhorse grows a real `Math.random` or a real
clock. Recording the shape now is the useful half, and this section is that
record.

Either way, the acceptance property is the same and is pinned as a test rather
than asserted in prose: a compartment created *after* `lockdown()` reads the
attenuated names, and one created *before* does not share them.

### 5. Step 4 — attenuate `Date` and `Math`

Nearly empty as a port, and the gap is the missing template rather than a live
clock.

- `Math.random` does not exist.
  `create_math` (`interp/boot.rs:2512`) registers 34 methods and a set of
  numeric constants, and `random` is not among them; there is nothing to
  attenuate.
- `Date.now()` returns `0.0` unconditionally — the `2 =>` arm at
  `interp/natives/date.rs:50`.
- The shared half of XS's step 4 reduces to `Date.prototype.constructor`,
  which step 2 already covers.

So step 4 is a seam to be built, not behaviour to be ported, and it should be
built only if § 4 chooses the template.
If IronHorse later grows a real `Math.random` or a real clock, the seam is
where they get attenuated; recording that is the point of doing it now.

### 6. `lockdown()` gains a sixth stand-in

`locked_down_prototypes` (`interp/realm.rs:405`) returns five pairs today, and
`create_locked_down_constructors` (`interp/boot.rs:2179`) carries the comment
*"`Compartment.prototype` is absent: ironhorse has no guest `Compartment`,
which is this work's scope boundary."*
`fx_lockdown` step 2 poisons `Compartment.prototype.constructor` as its fifth
call.
Adding the sixth pair is a one-line change once the prototype exists — with the
`SlotIndex::NULL` guard already in place for a partial boot — and the comment
comes out.
`Symbol.toStringTag-lockdown.js` (`onlyLockdown`) is the case that observes it.

### 6b. Does a compartment see `Compartment`, and does an unfrozen machine?

Two different questions; both answered yes.

**Inside a compartment.** Yes, and both references agree: SES's `permits.js`
lists `Compartment` in `universalPropertyNames` ("properties of all global
objects"), and `fx_lockdown` builds `mxCompartmentGlobal` itself
(`xsLockdown.c:139`), so a compartment global carries it by construction.
`compartment_evaluator` mints each compartment its own copy, as XS does.

**On an unfrozen `Machine`.** Yes — and this is where the answer differs from
`lockdown`'s, which is instructive.
`new_shared_realm_machine_configured` deliberately does NOT bind the engine's
`lockdown` when `freeze == false` (`interp/realm.rs:678-704`), on the grounds
that `freeze == false` means the SES shim owns the operation and that until the
shim installs its own, the engine's is *a realm-wide mutation* reachable from
any compartment of a machine that by construction has not locked down yet.

None of that transfers.
Constructing a compartment mutates nothing in the shared graph: it allocates a
global object and fills it with references to intrinsics that are already
reachable.
The pre-freeze window that comment describes — primordials shared and writable,
so two compartments can signal through them — is opened by the machine having
compartments at all, which the host API already allows and which that comment
already makes the caller responsible for.
A guest compartment is no wider a hole than a host one.
And unlike `lockdown`, `Compartment` does not depend on the freeze having
happened to be meaningful.

So `Compartment` is bound on every realm profile, and
`ses_boot_intrinsics.rs` pins all three by identity rather than by `typeof`
(below).

### 6c. Three census sites stop discriminating

`ses_boot_intrinsics.rs` has three census sites, each pinning a different realm
profile, and each read `Compartment=undefined` or `Compartment=function` as a
plain `typeof` term.
Binding a guest `Compartment` makes `function` true on both sides of the shim's
evaluation, so the term stops telling "the engine has one" from "the shim
installed one" — exactly what happened to the `lockdown` term when #1295 bound
that global.

Follow #1295's fix rather than loosening the assertion: stash the engine's
binding (`globalThis.__engineCompartment`) before the shim runs and assert by
IDENTITY afterwards.
The unfrozen-`Interp` and unfrozen-`Machine` sites assert the shim REPLACED it;
the frozen-`Machine` site, where the shim aborts in `repairIntrinsics`, asserts
it did not.

Two probes elsewhere used `Compartment` as their example of an intrinsic the
oracle binds and ironhorse lacks — `xst.rs`'s
`an_unlanded_intrinsic_is_a_named_missing_global_skip` and the raw fixtures in
`expectation_cli.rs` / `expectation_shards.rs`, which relied on it to produce a
real gating failure.
They move to `mutabilities`, the remaining member of the Hardened-JavaScript
global set that XS's shim installs and `create_hardened_globals` declines.

### 7. Snapshot

Two distinct costs.

**The boot fingerprint moves.**
`derive_boot_fingerprint` (`interp/boot.rs:113`) hashes `boot_slot_count`,
every boot slot's `Debug` rendering, the chunk arena, every `functions` entry
including its `Native`/`NativeMethod` variant, and the `intrinsics` map.
A new intrinsic changes all of those, `Signature::check_boot` then refuses
every snapshot written by a prior build, and the golden identity fixtures are
regenerated: the TSV corpora under
`ironhorse-snapshot/tests/fixtures/state_golden*.tsv` for both math providers,
plus the inline digests in
`ironhorse-snapshot/tests/metamorphic_determinism.rs`.
#1295 measured that cost; the precedent for the regeneration commit is
`683380e44`/`47b1c6f2e`.
**It lands twice if phase 1 and phase 2 each add intrinsics**, so phase 2's
`ModuleSource` and `VirtualModuleSource` should be minted in the same boot
change as `Compartment` even if their dispatch arms are stubs that refuse — or
the two phases should be prepared to pay it twice, knowingly.

**A live compartment must round-trip.**
Whatever § 2 chooses, the instance is a guest object with host-side state, and
the persist gate (`stored_unpersistable_row`) classifies such rows.
A compartment is *not* like `$262`: its state is environments the snapshot
already carries (`MachineRestorePolicy::environments`, keyed by
`EnvironmentId`, with `EnvironmentPolicy` carrying `global_names`,
`has_resolve_hook`, `has_import_hook` and `name`).
The work is to re-associate a restored guest instance with its restored
environment, and to state what happens to a compartment whose
`source_compiler` the embedder does not reattach.

## Phasing, against the corpus

The 68 files split on whether the case loads a module, and phase 1 is
independently shippable.
The split is narrower than a directory-level reading suggests: two
`constructor/` cases carry the `module` flag and four more carry `async`, and
all six are module tests.

**Phase 1 — the non-module `Compartment`: 12 files.**

| file | oracle (`xs`) |
|---|---|
| `constructor/globalLexicals-properties.js` | pass |
| `constructor/globalLexicals-types.js` | pass |
| `constructor/globals-properties.js` | pass |
| `constructor/globals-types.js` | pass |
| `constructor/options-type.js` | pass |
| `constructor/modules-types.js` | **fail** — option-shape only, no loading |
| `prototype/evaluate/environments.js` | pass |
| `prototype/globalThis/defaults.js` | pass |
| `evaluate.js` | pass |
| `prototype/Symbol.toStringTag.js` | `noXs` — no oracle |
| `prototype/Symbol.toStringTag-lockdown.js` | `noXs` — no oracle |
| `evaluate-transforms.js` | `noXs` — no oracle; needs SES-only `transforms` |

**Measured after phase 1 landed: eight of the twelve pass**, in at least one
scenario — `globals-types`, `globals-properties`, `globalLexicals-types`,
`options-type`, `evaluate.js`, both `Symbol.toStringTag` cases and
`globalThis/defaults.js`.
The four that do not are `globalLexicals-properties.js` and
`prototype/evaluate/environments.js` (both wait on the lexical scope),
`modules-types.js` (passes the corpus, diverges from the oracle — see
§ Oracle divergences, measured) and `evaluate-transforms.js` (no oracle
side).
Three phase-2 `import-now-hook` files pass as well, which was not predicted.

Nine of the twelve are oracle-adjudicable and XS passes eight of those nine.
`constructor/modules-types.js` is the one phase-1 case where the corpus
outranks the oracle: it is synchronous and checks only the `modules` option's
type discipline under `__options__: true`, and XS fails it.
`evaluate-transforms.js` needs `transforms`, which the equivalence note lists
as shim-only — SES-on-Node passes it, XS does not run it.
Phase 1 delivers the parity corpus's 2 cases (`Symbol.toStringTag{,-lockdown}`)
and needs §§ 1, 2, 3, 4, 5 and 6.

**Phase 2 — modules: 56 files, plus `test/modules/`'s 7.**
`prototype/import` (16), `prototype/importNow` (14), `import-now-hook` (6),
`ModuleSource` (6), `VirtualModuleSource` (4), `import-hook` (2),
`descriptors/` (3, all `async`), `constructor/hooks-types.js` and
`constructor/resolveHook.js` (both `module`-flagged),
`constructor/modules-properties.js` (`async`),
`import-now-optional-resolve-hook.js`, and `legacy-module-method.js`
(`onlySesNode`, which IronHorse never runs).
Gated on both prerequisites below and on turning the two hook booleans into
real callables.

## Prerequisites

**D2 — property-override enablement** (equivalence note § triage).
**Discharged 2026-09-18: defer native enablement.**
The step-3 template freezes `Object.prototype`'s data properties AS DATA,
matching `fx_lockdown`; it does not install SES-style accessors.

The reasoning, since it decides § 4 below.
The override mistake is a `[[Set]]` problem only: class bodies and object
literals define their methods through `[[DefineOwnProperty]]` and never consult
the prototype chain, and `Object.defineProperty` keeps working after lockdown.
Only the ES5 assignment idiom (`Foo.prototype.toString = ...`) is affected.
SES's own `minEnablements` is six properties whose comments name the transpiler
and test libraries they exist for, and no guest-path site in `packages/` or
`rust/endo/xsnap/src/` uses that idiom at all.
Enablement is therefore a compatibility probe to run before migrating an
embedder, not a prerequisite for one.
`native_lockdown.rs::a_native_lockdown_does_not_enable_property_override` already
pins the frozen-data shape.

**Referrer threading through module resolution.**
`ModuleGraph::resolve(&self, specifier: &str)` (`module.rs:283`) takes one
argument; `ImportEntry` carries only `module_request` (`module.rs:106`); all
six resolution sites pass the specifier alone (`:342`, `:358`, `:401`, `:461`,
`:582`, `:656`).
A relative specifier is therefore inexpressible — two modules in one
compartment importing `'./helper.js'` necessarily get the same module — and
`descriptors/source/specifier.js` asserts the referrer directly:

```js
resolveHook(importSpecifier, referrerSpecifier) {
  assert.sameValue(referrerSpecifier, 'BAR');
  ...
}
```

`Realm` (`interp/realm.rs:24`) also holds only `intrinsics` and
`default_global`, with no parent, so XS's inherited-hook walk
(`xsModule.c:2160-2169`) has no counterpart.
This is a prerequisite for phase 2, not part of it.

**The two hook booleans.**
`has_resolve_hook` and `has_import_hook` (`compartment.rs:216-217`) exist so a
constructor-shape probe can observe them; they resolve and import nothing.
Phase 2 replaces them with callables; phase 1 must not pretend otherwise, and
`constructor/hooks-types.js` is `module`-flagged and therefore not in phase 1's
count.

## Design Decisions

1. **Match XS, not SES.**
   Measured: XS passes 51 of the 55 `test/Compartment/` cases it runs; the SES
   shim passes 11 of 47.
   Matching XS keeps `endot-ih` able to adjudicate and passes the corpus.
   Divergences are enumerated per case, not per project.
2. **Honour `globalLexicals`.**
   XS's semantics, and what the corpus asserts.
   Own enumerable string-keyed properties only, read once per construction, per
   compartment, invisible on `globalThis`.
3. **Guest instance owns a host `Compartment` handle in a side table** (§ 2,
   shape 1), so the existing lease-and-reap ownership model is reused rather
   than extended.
4. **Bare `Compartment(...)` is a `TypeError`.**
   Constructor-only, as `Map`/`Set`/`Proxy` already are.
5. **Phase 1 ships without module support**, and its hooks stay booleans.
   A constructor that answers shape questions and fails the first import is
   honest about the same boundary XS is honest about.
6. **Mint phase 2's intrinsics in phase 1's boot change** if both phases are
   committed to, so the fingerprint moves once.
   **Not taken.** Phase 1 minted only `Compartment`.
   With no embedder waiting and phase 2 gated on referrer threading, a
   speculative `ModuleSource` stub would have been a second unfinished surface
   in the boot graph for a saving that is one fixture regeneration.
   The cost is real and is booked: the fingerprint will move again.
7. **The guest instance owns a host-shaped lease in a side table** —
   § 2 shape 1, as recommended.
   `guest_compartments` holds the `Rc<()>` whose `Weak` is
   `create_environment`'s `owner`, and the GC's late map prune drops the row
   with the instance.
8. **`Compartment` is bound on every realm profile**, including an unfrozen
   `Machine` — § 6b says why that differs from `lockdown`.
9. **Property-override enablement is deferred** and the step-3 template freezes
   `Object.prototype`'s data properties as data (D2, discharged; see
   § Prerequisites).
   **Not taken.** Phase 1 minted only `Compartment`. With no embedder waiting
   and phase 2 gated on referrer threading, a speculative `ModuleSource` stub
   would have been a second unfinished surface in the boot graph for a saving
   that is one fixture regeneration.
   The cost is real and is booked: the fingerprint will move again.
7. **The guest instance owns a host-shaped lease in a side table** — § 2 shape
   1, as recommended. `guest_compartments` holds the `Rc<()>` whose `Weak` is
   `create_environment`'s `owner`, and the GC's late map prune drops the row
   with the instance.
8. **`Compartment` is bound on every realm profile**, including an unfrozen
   `Machine` — § 6b, which says why that differs from `lockdown`.
9. **Property-override enablement is deferred** and the step-3 template freezes
   `Object.prototype`'s data properties as data (D2, discharged; see
   § Prerequisites).

## Oracle divergences, measured

Phase 1's, as run by the corpus gate under `SesMode::Lockdown`.
Each is a row the native-lockdown note's § Oracle divergences should carry.

| case | what differs | judgement |
|---|---|---|
| `constructor/modules-types.js` | The gate reports `over-acceptance: ironhorse completed a source the oracle rejected`. Read the direction carefully: the ORACLE fails the case (`Expected a TypeError to be thrown but no exception was thrown`) and ironhorse passes it. `assert_module_map` rejects a `modules` entry that describes no module; `fx_Compartment` accepts one. | Corpus over oracle, by decision. This is the case the equivalence measurement predicted, and the only phase-1 one. Ironhorse is right and XS is wrong; the gate calls it a divergence because the gate's reference is XS. |
| `prototype/Symbol.toStringTag.js` | Both engines fail it under lockdown — `verifyProperty` wants `configurable: true` and step 5 has frozen the property — but the abort renders as `Test262Error: …` on the oracle and `Object: …` on ironhorse. | Agreement on the RESULT, divergence in how a thrown non-`Error` renders its class. Not this work's, though this work is what made it visible: the case could not run before. `Interp::render_uncaught` labels such a value with its `Object.prototype.toString` tag rather than its constructor's `name`, because it is a host boundary that must not run guest code — and for an ordinary guest constructor BOTH hops it would need, `constructor` on the prototype and `name` on the function, are VIRTUAL properties materialized on demand, which a `&self` render cannot do. An attempt to read them as data properties was made and reverted: it needs the render boundary taught to read virtual properties, which is its own change. `packages/hardened262/scripts/agents/ironhorse.js` works around the same gap by rewriting the harness's `Test262Error.prototype.toString`. The file passes in the non-lockdown `strict`/`sloppy` scenarios, where the property is still configurable. |
| construction metering | Allocation-driven (`tick_slot_alloc` per slot allocated) rather than a calibrated frame constant. `ironhorse-meter` has no `fx_Compartment` measurement, and inventing a constant would assert a calibration nobody performed. | Deliberate, and stated at `construct_compartment`. A computron comparison over compartment construction is not meaningful until someone measures XS's. The charge is now measured rather than assumed: see § Adversarial review for the interval where it was a constant. |

## Adversarial review, and what it found

Five reviewers were run against the landed phase-1 change, each on one failure
class: re-entrancy and slot invalidation, confinement, `globalLexicals` scope
semantics, persistence and GC integration, and the test suite's own honesty.
Every finding below was reproduced against the engine before it was acted on,
and every fix carries a test that fails without it (each was re-checked by
mutating the fix and confirming the test catches it).

Two reviewers converged independently on the first one, which is the one that
mattered.

### Fixed

- **A `globalLexicals` cell could be swept while still bound.** The cell is
  deliberately off the global object's property chain -- that is what keeps the
  name invisible on `globalThis` -- so, alone among environment state, nothing
  reached it through an ordinary arena edge. Its only root was the
  `environments` root walk, which filters on the environment's owner lease, and
  that lease belongs to the `Compartment` INSTANCE. A retained function keeps
  `global_env`, and hence the environment, alive long after its instance is
  swept; two collections later the cell was freed while `global_lexicals` still
  named it, and the next crank's allocations recycled the slot. Reproduced: the
  binding read back as `64`, the churn loop's counter, rather than `42` -- in a
  debug build, with no assertion tripped, because the slot had been reallocated
  and was live again. Silent cross-object data confusion, and a write through
  the same path would have been an arbitrary-slot overwrite. Fixed by visiting
  the cells from `gc_slot_row`'s `environment` arm, which ties their lifetime to
  the compartment's global object rather than to its instance.

- **The persist gate keyed on the instance, not on the state.**
  `guest_compartments` empties as soon as the collector prunes the dead
  instance's row, and the gate then had nothing to object to -- while the
  environment, and both pieces of unpersistable state it carries, lived on.
  Reproduced on a plain machine: the checkpoint was ACCEPTED and the resume then
  failed with `Corrupt("restore session did not validate")`. Bytes written that
  no restore can ever accept, with nothing said at write time, which is worse
  than the silent binding loss the review predicted. Two causes, now refused
  separately on the write side: `globalLexicals`, for which `EnvironmentRow` has
  no column and which is not arena-chain-resident either, so nothing could
  rebuild it; and `shared_compartments`, which `construct_compartment` sets and
  which makes `shared_machine_snapshot` emit an image whose empty
  `intrinsic_roots` restore refuses as a "shared primordial profile mismatch".

- **A bare-name `delete` in a compartment reached into the parent realm.**
  `EVAL_REFERENCE` pushes a `Kind::EnvReference` sentinel carrying
  `SlotIndex(0)` to mean "the global object", and `DELETE_PROPERTY` matched on
  the payload without checking the kind -- taking the sentinel for a live
  instance. `SlotIndex(0)` is the default realm's global only because
  `Interp::new` happens to allocate it first. Reproduced: `delete leak`
  evaluated inside a compartment removed the PARENT's `globalThis.leak`. The
  sentinel and the delete path both predate this change and are untouched by it;
  guest compartments are what made the defect reachable, since until now only
  the host could mint a second environment. Fixed by resolving the sentinel
  against the current environment, which also stopped `delete` of a lexical
  answering `true` while the binding survived -- it answers `false` now, because
  a binding in a scope is not a property.

- **A `const` lexical accepted a sloppy store.** The lexical arm gated its
  `XS_DONT_SET_FLAG` check on `self.strict`, modelling the cell as a
  non-writable property. It is a binding: ECMA-262 9.1.1.1.5 forces `S` to true,
  which is why `const c = 1; c = 2` throws in sloppy code, and both of this
  engine's other const paths -- the frame-local one and the `with`-object one --
  already threw unconditionally. `Compartment.prototype.evaluate` is always
  strict, so no test could see it; the compartment's OWN evaluators
  (`globalThis.eval`, `globalThis.Function`) run sloppy source and silently
  discarded the write. That store also skipped the `tick_builtin` both sibling
  arms charge.

- **Construction charged a constant where the cost is guest-controlled.**
  § 1 required charging `create_environment`'s allocations "or a guest loop over
  `new Compartment()` buys unmetered allocation", and the arm charged 2 ticks.
  Measured: a compartment costs 6 slots when the crank's source text interns no
  intrinsic names and 58 when it interns the standard set -- the guest picks,
  via its own source text -- and the charge did not move between those two at
  all. Now charged from the live-count delta, verified exact at 52 x
  `SLOT_ALLOCATION_METERING`. Worth stating precisely: a slot is 1/256 of a
  computron, so this is faithfulness to XS's own accounting and to § 1, not a
  security boundary -- correct metering would not have stopped the arena
  exhaustion the reviewers framed it as enabling.

- **The environment switch leaked on the unwind path.** `define_global_id` and
  `define_global_lexical` reach `heap_exhausted()`, which is a `resume_unwind`
  and not an `Err`, so the restore below `result` was skipped exactly when the
  machine survives the panic. Now `catch_unwind` -> restore -> `resume_unwind`,
  the discipline `create_environment` and `create_host_function` already follow.

- **`shared_compartments` stayed flipped after a failed construction.** The flag
  is machine-wide and irreversible in the forward direction; it is now rolled
  back if `create_environment` fails.

- **The `const` probe pinned nothing.** `constructor/globalLexicals-properties`'s
  twin swallowed its `shared = null` outcome in a bare `catch`, and every other
  term in the expected string read the same whether the store threw or silently
  succeeded. The outcome is now part of the assertion.

### Not a defect

- The `var` hoist's `globalThis` name leak. `c.globalThis.eval('var bar = 5')`
  over a lexical `bar` leaves `bar` on `getOwnPropertyNames(c.globalThis)` with
  the lexical shadowing it -- which is what SES's own `with`-proxy scope does:
  the property comes from the `var` declaration, not from the lexical, and the
  lexical is still not a property of the global. The invariant holds.

### Open, and found but not chased

A compartment's `globalThis` under-reports its standard globals under
REFLECTION, while name resolution inside `evaluate` is unaffected.
Measured on a crank whose source names the intrinsics only as string literals:
`Object.getOwnPropertyNames(c.globalThis)` returned just
`globalThis Compartment Object`, and `c.globalThis['Map']`,
`c.globalThis['Promise']`, `c.globalThis['Reflect']`, `c.globalThis['Function']`
and `c.globalThis['eval']` all read `undefined` — while the SAME computed
access on the outer `globalThis` returned each intrinsic.
Evaluating anything in the compartment that names one repairs it:
after `c.evaluate('typeof Map')`, `c.globalThis['Map']` is a function.

The likely mechanism is that `materialize_runtime_global` populates
`self.environment` — whichever environment is ACTIVE when a name is first
needed — so a name that becomes a global after the compartment was built lands
in the default realm rather than in the compartment, while
`install_intrinsic_bindings` gave the compartment only what was installed at
`create_environment` time.
Two things are NOT established: whether the host `Compartment` API shares this
(it runs the same `create_environment`, so it probably does, which would make
this pre-existing rather than this work's), and whether XS behaves the same.
It was found while strengthening
`a_compartment_global_shares_every_name_but_its_own_evaluators`, which had been
passing partly because of it — the evaluator terms compared `undefined` against
a real function and read as "per-compartment" — and is recorded here rather
than fixed because the fix depends on which of the two engines is right.

### Open, and deliberately not guessed at

- A function declaration in the compartment's own sloppy evaluators is routed
  to the lexical cell instead of to the global binding it declares.
  `hoist_vars_to_global` and `can_declare_global_function` do not consult
  `global_lexicals`, so `c.globalThis.eval('function bar(){}')` over a lexical
  `bar` materializes a global property that the declaration's initializing store
  never reaches. Before the const fix it vanished silently; it now throws
  `TypeError: set bar: const`, which is the right posture for a known gap but
  not correct semantics. The repair is to distinguish a declaration-instantiation
  store from an ordinary assignment, which is a compiler/dispatch change that
  wants the shadowing semantics settled first -- and phase 1's documented
  surface is `evaluate`, which is strict and where declarations become frame
  locals that shadow correctly. Recorded rather than guessed at.

## Done looks like

- `native_lockdown_corpora.rs` drops the `test/Compartment/` arm of its
  exclusion for the phase's files, and they pass against the committed baseline
  in both directions — no case satisfied by a skip or a setup failure, which
  the gate's existing `Outcome::Skip(reason)` discrimination already enforces.
  Note that `constructor/hooks-types.js` and `constructor/resolveHook.js` are
  excluded earlier, at `:110`, on the `module` flag, and dropping the path
  exclusion does not re-enable them.
  **Done**, with two narrow exclusions in place of the prefix: a named
  missing-global skip (phase 2's 32 `ModuleSource` cases) and
  `evaluate-transforms.js`, which needs SES's shim-only `transforms` and so has
  no oracle side at all.
  The `module`-flagged pair is still excluded at `:110`, as predicted.
- `ses-xs-parity` reach moves.
  **Two measurements, and they moved differently.**
  The Rust-side `ses_xs_parity_suite_has_zero_divergence` ratchet goes
  **6/8 to 7/8** covered with zero divergence; the eighth is the
  `oracle-shim-unsafe:lockdown` skip and is not this work's.
  The `packages/test262-runner` lane — the one that reads 0/8 — goes
  **0/8 covered with 8 named skips to 0/8 covered with 7 skips and 1
  failure**: `Compartment` left `DEFAULT_ENDOR_SKIP_FEATURES`, so both cases
  that declare it now RUN, and **neither became covered**, because that lane
  runs `-l` and `lockdown()` has frozen `Compartment.prototype` before the case
  asks whether it is configurable, so both fail on both engines. One of the two
  fails identically and is an honest shared skip; the other diverges only in
  how the thrown `Test262Error` renders (§ Oracle divergences, measured).
  So this note's "0/8 to 2/8" prediction was wrong twice over, and the lane's
  README now carries the measurement instead.
- Snapshot round-trip through eager, lazy and checkpoint resume with a
  compartment live, and the golden identities regenerated under **both** math
  providers.
  **Half done.** The goldens are regenerated under both providers (the TSV
  corpora plus nine inline digests, exactly as costed), and the
  per-compartment `Compartment` copy round-trips as an `EvaluatorRow`.
  A machine holding a LIVE guest compartment is refused at the persist gate by
  presence, so the round-trip clause is not met and cannot be until § 7's
  two-column table exists.
- A compartment made after `lockdown()` reads the attenuated template, and one
  made before does not share it — pinned as a test.
  **Withdrawn, not merely unmet.** § 4 says why: with nothing attenuated there
  is no observable difference to pin, and a test asserting one would be
  asserting an implementation detail.
  What is pinned today is weaker and true: a compartment made after
  `lockdown()` reaches the same frozen graph (`native_lockdown.rs`).
- `Compartment.prototype` is step 2's sixth stand-in.
  **Done**, and pinned directly rather than through
  `Symbol.toStringTag-lockdown.js`, which passes for an unrelated reason (step
  5's general freeze walk).
  `lockdown_poisons_the_compartment_constructor` asserts the rewire, the
  stand-in's anonymity and `length` 1, the `secure mode` refusal on
  construction, and that the global constructor still works.
- Oracle divergences from `fx_Compartment` recorded, measured, one row each.
  **Done**, in § Oracle divergences, measured above, and copied into the
  native-lockdown note's own section as its rows 7-9.
  Three rows, not the four this note guessed: two of the three `noXs` cases
  need no row (`Symbol.toStringTag-lockdown.js` simply passes, and
  `evaluate-transforms.js` is excluded because XS does not implement
  `transforms` at all).

## Risks

- **`globalLexicals` is a new scope kind**, not a property bag, and it is the
  one phase-1 item with no existing seam in `interp/environment.rs`.
  It is where phase 1 did slip: the option is validated and read, and then
  dropped.
- **Boot-fingerprint churn is a cross-cutting cost** paid by anyone holding
  snapshots, and decision 6 was NOT taken, so it lands twice.
  Phase 1 has paid it once: the TSV corpora under both math providers plus nine
  inline digests in `metamorphic_determinism.rs`, exactly as costed.
- **Phase 2 is 56 of the 68 files and carries both prerequisites.**
  Sizing phase 1 and calling it "the Compartment" would under-report by roughly
  4x.
- **Three phase-1 cases have no oracle.**
  `noXs` means `endot-ih` cannot adjudicate them and the corpus is the only
  judge; each needs a divergence-ledger row rather than a silent pass.

## Dependencies

| Design | Relationship |
|---|---|
| [ironhorse-native-lockdown](ironhorse-native-lockdown.md) | Prerequisite, landed. This note completes its steps 3 and 4 and adds step 2's sixth stand-in. |
| [ironhorse-ses-compartment-equivalence](ironhorse-ses-compartment-equivalence.md) | Source. § Equivalence: `Compartment` and § Module resolution are the measurement this specifies against; its D2 triage item is a prerequisite. |
| [ironhorse-daemon-acceptance-sequencing](ironhorse-daemon-acceptance-sequencing.md) | Consumer. The daemon's realm-profile choice depends on a compartment global existing to attenuate. |
| [ironhorse-engine](ironhorse-engine.md) | Parent. Roadmap stage 4. |

## Known Gaps and TODOs

- [x] Settle D2 (property-override enablement). Discharged: defer enablement;
      the template freezes data properties.
- [x] Choose between the template and creation-time attenuation (§ 4).
      Template.
- [x] Choose the instance-ownership shape (§ 2). Side table holding the lease.
- [x] Decide whether phase 2's intrinsics are minted in phase 1's boot change.
      They are not; the fingerprint will move again.
- [x] Bind `globalLexicals`. Done: `CompartmentEnvironment::global_lexicals`,
      consulted between the frame and the global object. Both corpus files pass.
- [x] Wire `Compartment.prototype` as step 2's sixth stand-in. Done.
- [ ] Build the step-3 template and its step-4 attenuation seam — when there
      is something to put in it (a real `Math.random` or a real clock). § 4
      carries the decision and the reason phase 1 did not.
- [ ] Persist a live guest compartment (§ 7), lifting the persist-gate
      refusal.
- [x] Copy § Oracle divergences, measured into the native-lockdown note. Done:
      rows 7-9 of its own § Oracle divergences, measured.
- [x] Update `packages/test262-runner/README.md`'s skip inventory. Done, and
      it needed more than a skip line: `Compartment` left
      `DEFAULT_ENDOR_SKIP_FEATURES`, both cases now run, and neither became
      covered.
- [ ] Teach `Interp::render_uncaught` to label a thrown non-`Error` with its
      constructor's `name`. Both hops are virtual properties, so it needs a
      read-only path to those, not just another data-property walk. Would turn
      the lane's one failure into an honest shared skip and let
      `packages/hardened262/scripts/agents/ironhorse.js` drop its
      `Test262Error.prototype.toString` rewrite.
- [ ] Measure the corpus under `-c`/`-lc`. `new Compartment()` exists now, so
      `SesMode::unimplemented_skip` no longer folds those modes for want of a
      constructor — it folds them for want of a measurement.
- [ ] Re-verify `ironhorse-262/tests/stage4_ses_boot.rs`. Its census bar is
      rewritten to REQUIRE `Compartment=function`, as its previous revision
      asked whoever landed a guest `Compartment` to do, but the bar skips
      without `rust/endo/xsnap/src/ses_boot.js`, which this environment could
      not generate — so that edit is unexecuted.
- [ ] Teach `hoist_vars_to_global` / `can_declare_global_function` about
      `global_lexicals`, so a function declaration in the compartment's own
      sloppy evaluators initializes the global binding it declares instead of
      being routed to the lexical cell. See § Adversarial review, "Open".
- [ ] Settle whether a compartment's `globalThis` should carry the standard
      globals under reflection, not only under name resolution. See
      § Adversarial review, "found but not chased": establish first whether the
      host `Compartment` API shares the behaviour and what XS answers.
- [ ] Size phase 2 once referrer threading is scoped separately.

## Prompt

> Document the work to be done for a native guest `Compartment` in
> `ironhorse-vm` — the implementation details, scoped to this feature — over
> the multi-compartment machinery PR #1263 built, folding in `fx_lockdown`
> steps 3 and 4, with the corpus and baseline numbers measured rather than
> estimated.
