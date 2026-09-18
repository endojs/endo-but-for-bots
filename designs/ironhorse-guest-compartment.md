# IronHorse: a guest `Compartment`

| | |
|---|---|
| **Created** | 2026-09-18 |
| **Author** | kumavis (prompted) |
| **Status** | Not Started |
| **Source** | The scope boundary [ironhorse-native-lockdown](ironhorse-native-lockdown.md) drew, and the `Compartment` half of [ironhorse-ses-compartment-equivalence](ironhorse-ses-compartment-equivalence.md) |

## Status

Not started.
This note is the implementation specification; no code has been written
against it.

[ironhorse-native-lockdown](ironhorse-native-lockdown.md) landed `fx_lockdown`
steps 1, 2 and 5 and named a guest `Compartment` as explicitly out of scope,
which put steps 3 and 4 out of scope with it.
This is that remainder: bind a guest-callable `Compartment` constructor in
`ironhorse-vm` over the multi-compartment machinery PR #1263 already built, and
fold in the two deferred steps.

## What is the Problem Being Solved?

`Compartment` is a host-side Rust API (`ironhorse-vm/src/compartment.rs`) with
no guest binding.
`typeof Compartment` answers `"undefined"` in every IronHorse realm, and
`new Compartment()` is an ordinary
`ReferenceError: get Compartment: undefined variable`.

Three things are measured as blocked on that one absence.

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

**Thixotrope's IronHorse worker migrating off the SES shim**, together with
property-override enablement (D2 in the equivalence note's triage).
The isolation half already works —
`native_lockdown.rs::a_host_made_compartment_confines_guest_source_only_with_global_names`
pins it — and what is missing is a compartment global to attenuate into.

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

Two options, and the same choice answers step 4:

- **Introduce a template.** A boot-allocated object filled at lockdown time,
  which `install_intrinsic_bindings` prefers over `self.intrinsics` when
  `locked_down` is set.
  Closest to XS, snapshot-visible, and gives step 4 somewhere to put an
  attenuated `Math`.
- **Attenuate at environment-creation time.** No template; the substitutions
  are applied as `install_intrinsic_bindings` walks.
  Smaller, but every future attenuation becomes a branch in the binding loop,
  and there is no single object to harden or to hand to `endot-ih` for
  comparison.

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
Settle before the step-3 design.
A template that freezes `Object.prototype`'s data properties and one that
installs SES-style accessors are different artifacts, and SES's conversion is
only possible while those properties are still configurable — which, after
step 5, they are not.

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

## Done looks like

- `native_lockdown_corpora.rs` drops the `test/Compartment/` arm of its
  exclusion for the phase's files, and they pass against the committed baseline
  in both directions — no case satisfied by a skip or a setup failure, which
  the gate's existing `Outcome::Skip(reason)` discrimination already enforces.
  Note that `constructor/hooks-types.js` and `constructor/resolveHook.js` are
  excluded earlier, at `:110`, on the `module` flag, and dropping the path
  exclusion does not re-enable them.
- `test262:ironhorse` moves from 0/8 to 2/8 covered, and
  `packages/test262-runner/README.md`'s skip inventory is updated to match.
- Snapshot round-trip through eager, lazy and checkpoint resume with a
  compartment live, and the golden identities regenerated under **both** math
  providers.
- A compartment made after `lockdown()` reads the attenuated template, and one
  made before does not share it — pinned as a test.
- `Compartment.prototype` is step 2's sixth stand-in, observed by
  `Symbol.toStringTag-lockdown.js`.
- Oracle divergences from `fx_Compartment` recorded in the native-lockdown
  note's § Oracle divergences, measured, one row each — at minimum
  `constructor/modules-types.js` and the three `noXs` cases.

## Risks

- **`globalLexicals` is a new scope kind**, not a property bag, and it is the
  one phase-1 item with no existing seam in `interp/environment.rs`.
  If phase 1 slips, it slips here.
- **Boot-fingerprint churn is a cross-cutting cost** paid by anyone holding
  snapshots, and it lands twice unless decision 6 is taken.
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

- [ ] Settle D2 (property-override enablement) before the step-3 design.
- [ ] Choose between the template and creation-time attenuation (§ 4).
- [ ] Choose the instance-ownership shape (§ 2).
- [ ] Decide whether phase 2's intrinsics are minted in phase 1's boot change.
- [ ] Size phase 2 once referrer threading is scoped separately.

## Prompt

> Document the work to be done for a native guest `Compartment` in
> `ironhorse-vm` — the implementation details, scoped to this feature — over
> the multi-compartment machinery PR #1263 built, folding in `fx_lockdown`
> steps 3 and 4, with the corpus and baseline numbers measured rather than
> estimated.
