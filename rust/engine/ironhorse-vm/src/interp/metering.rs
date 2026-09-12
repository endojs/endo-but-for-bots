//! Public aliases for the canonical meter weights and their execution contracts.
#[cfg(doc)]
use super::{Interp, RegExpData};
/// The raw 16.16 cost XS accrues unwinding an **uncaught** throw across
/// the host boundary (`fxJump` longjmps into `fxBeginHost`'s `mxTry`). Two
/// effects combine, both measured against the pin `48ee02d8cfe0`: the
/// escaping `throw`/`rethrow` opcode is **never metered** (the longjmp
/// bypasses its `mxBreak`, where the computed-goto dispatch accrues an
/// opcode's `XS_CODE_METERING`), and the host-boundary teardown accrues a
/// fixed `1<<15` raw. Verified: an uncaught `throw 7` and `1; throw 7`
/// each carry exactly `PROGRAM_ENV_SETUP_METERING + 32768` beyond their
/// pre-throw dispatch metering (raw `443672` and `574744` respectively,
/// = 6 and 8 metered opcodes plus this remainder). Modeled by
/// `crate::meter::Meter::untick_code` on the escaping opcode plus
/// accruing this constant. A *caught* throw needs no adjustment: the
/// `CATCH` resume's `mxBreak` meters the catch target exactly as ironhorse's
/// dispatch does, so caught exceptions are bit-exact without it.
#[doc(hidden)]
pub use ironhorse_meter::THROW_HOST_ESCAPE_METERING;

/// A throw unwinding to a handler that was live ACROSS a suspend (the
/// `try` was entered before a `yield`/`await`, and the run resumed inside
/// it) costs XS one extra bytecode dispatch beyond the ordinary caught
/// throw — the re-establishment the resumed frame's handler needs, which
/// a never-suspended `CATCH` already paid for in its own dispatch.
///
/// The charge follows the computed-goto control flow in the pinned XS source.
/// In `xsRun.c`, a longjmp into an IN-LOOP `CATCH` lands on
/// `mxFirstCode(); mxBreak;` and meters ONCE (the `mxBreak`). A longjmp
/// into a PROLOGUE-RESTORED jump instead `goto`s `XS_CODE_JUMP` and falls
/// into the `for(;;)` dispatch loop, which meters TWICE: once at the loop
/// top and once more in `mxSwitch`, which the computed-goto build
/// `#define`s to `mxBreak`. The difference is exactly one
/// `XS_CODE_METERING`, and it lands per THROW because `fxJump` always
/// longjmps to `the->firstJump`.
///
/// This derivation uses XS's computed-goto build (`__GNUC__ && __OPTIMIZE__`).
/// A plain-switch XS build charges the two paths equally. Ironhorse retains
/// its frozen charge independently of the oracle build; changing it requires
/// a deliberate cost-table revision rather than recalibration to another host.
///
/// The charge applies per throw through a restored handler, not per handler
/// or suspension. With two handlers live across a suspension, one throw adds
/// one dispatch charge and two throws add two; a handler established after
/// resume needs no adjustment.
/// Identical in the generator (`yield`) and async (`await`) resume paths.
#[doc(hidden)]
pub use ironhorse_meter::RESUMED_HANDLER_THROW_METERING;

/// The fixed cost, in computrons, of the top-level program invocation
/// that precedes the captured program bytecode. XS dispatches the
/// program-as-function through its call machinery before the first
/// program opcode; those dispatches are metered but live in the caller
/// frame, not in the bytecode the oracle hands us. It is a constant of
/// the eval harness (identical on both engines), asserted for every
/// corpus entry by the differential harness.
#[doc(hidden)]
pub use ironhorse_meter::PROGRAM_INVOCATION_COMPUTRONS;

/// The raw 16.16-fixed-point aggregate XS accrues building the
/// program's environment instance and frame during program entry
/// (`fxRunEvalEnvironment` and the frame setup: a bundle of `fxNewSlot`
/// allocations for the program environment). Measured against the pin
/// `48ee02d8cfe0`: every top-level program — even `1` — carries exactly
/// this fractional remainder (`meterIndex & 0xFFFF == 17688` on a
/// pure-expression program, verified via the oracle's raw meter). It is
/// under one computron (< 1<<16), so a pure-expression program need not
/// carry from it. Runtime allocation charges accrue on top of the remainder
/// and can produce a carry. Accrued once at the `BEGIN_*` program-frame-entry
/// opcode; `golden_computrons.rs` pins the resulting guest receipts.
#[doc(hidden)]
pub use ironhorse_meter::PROGRAM_ENV_SETUP_METERING;

/// The raw 16.16 cost XS accrues materializing one new own property on
/// an object (`mxBehaviorSetProperty`/`fxRunDefine` creating a property:
/// `fxNewSlot` for the property slot plus the property-table growth and
/// interned-key `fxNewSlot`/`fxNewChunk`). Measured against the pin as
/// 536 = one modeled property-slot allocation
/// ([`crate::meter::SLOT_ALLOCATION_METERING`], 1<<8 = 256) plus this
/// [`PROPERTY_CREATE_REMAINDER`]. Accrued wherever a new own property is
/// created — a hoisted `var` or sloppy global at `EVAL_ENVIRONMENT` /
/// `SET_VARIABLE`, an object-literal member at `NEW_PROPERTY`, or a
/// dynamic assignment at `SET_PROPERTY`. Verified per-site against the
/// oracle's raw meter (a `SET_PROPERTY` that creates costs exactly 536;
/// one that overwrites costs nothing; a `NEW_PROPERTY` costs 536 plus one
/// built-in step for `fxRunDefine`).
#[doc(hidden)]
pub use ironhorse_meter::PROPERTY_CREATE_REMAINDER;

/// The raw 16.16 cost XS accrues in `constructor_function`
/// (`fxNewFunctionInstance` + `fxDefaultFunctionPrototype`): the function
/// instance and its internal CODE/HOME slots, its `length`/`name`
/// properties, and the default `.prototype` object with its `constructor`
/// back-reference — a fixed cluster of `fxNewSlot` allocations plus the
/// built-in steps `fxDefaultFunctionPrototype` runs, independent of the
/// function's body or arity (the body chunk is metered separately at
/// `code`, and the arity-dependent scope slots at the body's
/// `new_local`s). Measured against the pin `48ee02d8cfe0`: a bare
/// `(function(){})()` — whose only unmodeled cost is this cluster plus the
/// 5-byte body chunk — carries exactly [`FUNCTION_DEFINE_METERING`] + 5
/// beyond the program baseline, the per-opcode dispatch metering, and the
/// modeled `new_property`. The nested `(function(){return
/// (function(){return 1})()})()` carries exactly twice this (its raw gap
/// with the constant zeroed was 135670 = 2 × 67835), confirming it as a
/// clean per-definition constant. Verified per-site against the oracle's
/// raw meter. Plain `XS_CODE_FUNCTION` (no default prototype) is a
/// distinct, smaller cluster carried by a later increment. (The
/// body-chunk allocation is *not* part of this constant — it is metered
/// faithfully at `code` via [`crate::meter::Meter::tick_chunk_new`], so a
/// function's arity/body length moves its computrons the way XS's does.)
#[doc(hidden)]
pub use ironhorse_meter::FUNCTION_DEFINE_METERING;

// ---- generator metering (design § generators) ----------------------------
// Generators call `mxMeter` nowhere in `xsGenerator.c`/the `YIELD`/
// `START_GENERATOR` opcode bodies, so — like promises and collections —
// generator metering is entirely allocation-driven: over the identical
// bytecode both engines dispatch (per-opcode `CODE_METERING` matches by
// construction), each constant below is the `fxNewSlot`/`fxNewChunk` cluster
// of one generator operation, calibrated raw-exact against the pin's run-only
// meter (accuracy-over-parity: a deterministic per-release cost, pinned to the
// oracle for *result*-relevant allocation faithfulness).
//
// Calibrated below via the isolated per-operation raw gap; a placeholder `0`
// until the empirical loop sets each. An un-calibrated path must self-name a
// skip rather than complete with a wrong computron.
/// `fxNewGeneratorFunctionInstance`'s extra allocation over a plain
/// `function` define: the `fxNewObjectInstance` `.prototype` object chaining
/// to `%GeneratorPrototype%` plus its `_prototype` property slot. Calibrated
/// raw-exact via the isolated `function* g(){}` gap.
#[doc(hidden)]
pub use ironhorse_meter::GENERATOR_FUNCTION_EXTRA_METERING;

/// `fxNewGeneratorResult`: the `{value, done}` result object a completion
/// (`END`) or an already-completed `.next`/`.return` builds
/// (`fxNewObjectInstance` + two property slots). A *yield*'s result object is
/// built by the body's own `OBJECT`/`NEW_PROPERTY` bytecode (metered by those
/// dispatched opcodes), so it does NOT carry this constant. Calibrated via the
/// second-`next`-on-empty-body gap.
#[doc(hidden)]
pub use ironhorse_meter::GENERATOR_RESULT_METERING;

/// The per-resume residual of `fx_Generator_prototype_aux` + `fxRunID`
/// re-entry over the `RUN` trampoline the interpreter already meters — exactly
/// one dispatch (`1 << 16`) beyond the body opcodes both engines run.
/// Calibrated identical for a suspended-start and a suspended-yield resume.
#[doc(hidden)]
pub use ironhorse_meter::GENERATOR_RESUME_METERING;

/// `START_GENERATOR` → `fxNewGeneratorInstance`: the instance slot plus its
/// two internal property slots (the `XS_STACK_KIND` saved-stack holder and the
/// resume-state integer), plus XS's initial saved-activation `fxNewChunk`.
/// Calibrated via the `g()`-minus-`g` gap.
#[doc(hidden)]
pub use ironhorse_meter::GENERATOR_START_METERING;

/// `YIELD`'s activation save (`fxNewChunk`/`fxRenewChunk` growing the
/// instance's saved-stack chunk to hold the suspended frame). Calibrated on a
/// top-of-body `yield`; XS's chunk scales with the exact suspended activation
/// size, so a `yield` reached with extra live loop/scope temporaries carries a
/// small sub-computron residual over this constant (the `while(true) yield`
/// drift, ~408 raw/resume) — below the computron floor for typical programs, a
/// documented approximation per the accuracy-over-parity doctrine (ironhorse's own
/// deterministic cost, not a back-fit).
#[doc(hidden)]
pub use ironhorse_meter::GENERATOR_YIELD_METERING;

// ---- async-function metering (design § async/await, ASYNC-AWAIT-HANDOFF.md) --
// Like generators, the async opcodes call `mxMeter` nowhere in their bodies, so
// async metering is entirely allocation-driven, calibrated raw-exact against the
// pin. The per-AWAIT suspend runs the *identical* C code as `YIELD` (they share
// the `mxCase`), so it reuses [`GENERATOR_YIELD_METERING`]. The per-resume
// re-entry into a suspended async body (driven by a native reaction, not a `RUN`
// trampoline) mirrors the generator resume residual, [`GENERATOR_RESUME_METERING`].
//
/// The `fxStepAsync` await-branch frame: on a body `await`, XS either takes the
/// native-promise fast path (`mxGetID(_constructor)` + `fxIsSameValue`, then
/// `fxPromiseThen` with a null capability) or the general path
/// (`fxNewPromiseCapability` + `fxPromiseThen` null-capability + `mxRunCount(1)`
/// on the fresh resolve function). This constant is the fast-path frame residual
/// beyond the null-capability [`Interp::promise_then_native`]; the general path
/// adds [`ASYNC_AWAIT_GENERAL_METERING`]. Calibrated against `await nativePromise`.
///
/// Expressed as a **credit** (`untick`): XS's null-capability `fxPromiseThen`
/// registers the reaction on the already-settled awaited promise more leanly
/// than [`Interp::promise_then_native`]'s job-queue accounting (which is shaped
/// for the general `.then`/`Promise.resolve` path). The credit nets the fast
/// path bit-exact. Calibrated against `await Promise.resolve(v)`.
#[doc(hidden)]
pub use ironhorse_meter::ASYNC_AWAIT_FASTPATH_CREDIT;

/// The `fxStepAsync` general await-branch residual over the fast path: the
/// `mxNewPromiseCapability` framing plus the `mxCall`/`mxRunCount(1)` on the
/// capability's resolve function that adopts the awaited value. Calibrated
/// against `await 1` (a primitive await — one microtask turn).
#[doc(hidden)]
pub use ironhorse_meter::ASYNC_AWAIT_GENERAL_METERING;

/// The async-function define delta backed out of [`Interp::new_async_function`]:
/// XS's `XS_CODE_ASYNC_FUNCTION` skips the `fxDefaultFunctionPrototype`
/// `.prototype` allocation that `new_function`'s [`FUNCTION_DEFINE_METERING`]
/// includes (async functions are not constructors). Calibrated against a bare
/// `async function f(){}` define vs a plain function.
#[doc(hidden)]
pub use ironhorse_meter::ASYNC_FUNCTION_DEFINE_DELTA;

/// `START_ASYNC` → `fxNewAsyncInstance`'s allocation cluster over and above the
/// promise/resolving-function sub-clusters this metered explicitly via
/// [`Interp::new_promise_instance`] (6 slots) and [`Interp::make_resolving_functions`]
/// (13 slots). The residual covers: the instance slot, the `XS_STACK_KIND`
/// saved-stack holder, the state-integer property, the result-promise property
/// copy, the two resolving-function property copies, the two `fxResolveAwait`/
/// `fxRejectAwait` `fxNewHostFunction`s (5 slots each) and their two property
/// copies, plus the `fxNewAsyncInstance`/`fxRunAsync`/`fxBeginHost` frame residual.
/// Calibrated against the oracle (a `START_ASYNC` with no `await` isolates it).
/// Also carries the once-per-call completion-settle framing (folded here since
/// both fire exactly once per async call).
#[doc(hidden)]
pub use ironhorse_meter::ASYNC_INSTANCE_METERING;

/// The `fxStepAsync` completion-branch frame: on a body `return`, XS pushes the
/// result promise's `resolveFunction`, `mxCall`s it with the completion value
/// (`mxRunCount(1)`), settling the result promise. ironhorse settles the result
/// promise directly ([`Interp::settle_promise`]); this constant carries the
/// native call framing (`mxCall`/`mxRunCount`) that direct settle omits.
/// Calibrated against a bare `async function(){ return v }` (one turn, no await).
/// Folded into [`ASYNC_INSTANCE_METERING`] (both fire once per async call), 0 here.
#[doc(hidden)]
pub use ironhorse_meter::ASYNC_STEP_SETTLE_METERING;

/// The raw 16.16 cost XS accrues in `function_environment`
/// (`fxNewEnvironmentInstance`): the closure environment instance the
/// function captures its defining scope through. Accrued once per
/// `function_environment` opcode, at the definition site. Measured
/// against the pin; verified per-site.
#[doc(hidden)]
pub use ironhorse_meter::FUNCTION_ENVIRONMENT_METERING;

/// Body-scope allocation metering per declared parameter/local inside a
/// function frame. Each declared parameter/local (`new_local`) of a
/// function carries a fixed definition-time allocation cost — a scope-cell
/// `fxNewSlot` (256) plus a small aligned chunk (24 = the `fxNewChunk`
/// header/alignment of a ≤8-byte block), 280 raw total, measured against
/// the pin. It is a **definition-time** cost (present even when the
/// function is never called and constant across calls/recursion depth, so
/// it does not accumulate per invocation), accrued at `code` in proportion
/// to the count of `new_local` opcodes in the function's immediate body.
/// (A residual ≤8 raw per definition from body-chunk alignment on some
/// arities stays below one computron and does not perturb the bit-exact
/// bar.)
#[doc(hidden)]
pub use ironhorse_meter::FUNCTION_LOCAL_METERING;

/// The Function.prototype call/apply trampoline work specific to a callable
/// Proxy receiver. The Proxy's own target/trap-sensitive `[[Call]]` costs are
/// charged centrally by [`Interp::proxy_call`], so direct, bound, and abstract
/// calls all see them and these helpers add only the syntactic trampoline.
#[doc(hidden)]
pub use ironhorse_meter::CALLABLE_PROXY_DOT_TRAMPOLINE_METERING;

/// The fixed cost `fxRunConstructor` accrues over a plain call, beyond the
/// `this`-instance `fxNewSlot`: the `fxBeginHost`/`fxEndHost` host-frame
/// entry/exit around the prototype lookup and `fxNewHostInstance`. Measured
/// against the pin `48ee02d8cfe0` as exactly `2 × XS_CODE_METERING` (131072
/// raw) — the whole-computron gap between `new f()` and `f()` for an empty
/// constructor, independent of body or arity. Accrued once per constructor
/// entry at `begin`, in [`Interp::run_constructor`].
#[doc(hidden)]
pub use ironhorse_meter::CONSTRUCTOR_HOST_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::PROXY_CALL_FORWARD_BOUND_METERING;

#[doc(hidden)]
pub use ironhorse_meter::PROXY_CALL_FORWARD_METHOD_METERING;

#[doc(hidden)]
pub use ironhorse_meter::PROXY_CALL_FORWARD_NATIVE_METERING;

/// Callable Proxy `[[Call]]` residuals, split by the operation that actually
/// runs. A transparent layer forwarding to another Proxy is cheaper than the
/// terminal layer; terminal forwarding differs for user/bound functions,
/// native functions, and native methods. An active `apply` trap has its own
/// path. Calibrated raw-exact against the pinned XS 9.0 oracle.
#[doc(hidden)]
pub use ironhorse_meter::PROXY_CALL_FORWARD_PROXY_METERING;

#[doc(hidden)]
pub use ironhorse_meter::PROXY_CALL_FORWARD_USER_METERING;

#[doc(hidden)]
pub use ironhorse_meter::PROXY_CALL_TRAP_METERING;

/// `Object.defineProperty(o, k, descriptor)` native-body residual for defining
/// a **new** own data property from the canonical four-field data descriptor
/// (`{value, writable, enumerable, configurable}`, no `get`/`set`): the whole
/// `fxDescriptorToSlot` field read (six `mxHasID`/four `mxGetID` over the
/// descriptor's own program-symbol keys, the three `fxToBoolean` coercions)
/// plus `fxOrdinaryDefineOwnProperty` creating the property slot — folded into
/// one measured raw constant, beyond the call-dispatch opcodes the interpreter
/// loop already meters. Calibrated against the pin via the isolated raw-gap. A
/// novel key's intern slot is metered separately by [`Interp::intern_key`].
#[doc(hidden)]
pub use ironhorse_meter::DEFINE_PROPERTY_NEW_RESIDUAL_METERING;

/// `Object.getOwnPropertyDescriptors(o)` native-body base: the result object
/// instance + own-keys walk setup, measured exact against the pin's raw-gap.
#[doc(hidden)]
pub use ironhorse_meter::GOPDS_FRAME_METERING;

/// `Object.getOwnPropertyDescriptors(o)` per-own-key cost: the
/// `fxFromPropertyDescriptor` descriptor-object build plus the key property
/// slot linking it into the result — five explicit descriptor slot charges
/// are deducted from the historical measured residual
/// (cheaper than the standalone `getOwnPropertyDescriptor`'s
/// [`GOPD_PRESENT_RESIDUAL_METERING`] because the plural amortizes the native
/// frame). Calibrated exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::GOPDS_PER_KEY_METERING;

/// `Object.getOwnPropertyDescriptor(o, k)` native-body residual for an absent
/// key: the lookup returns `undefined`, no descriptor is built.
#[doc(hidden)]
pub use ironhorse_meter::GOPD_ABSENT_RESIDUAL_METERING;

/// `Object.getOwnPropertyDescriptor(o, k)` native-body residual for a present
/// ordinary data property: the whole `fxFromPropertyDescriptor` build (the
/// descriptor object instance + its four `value`/`writable`/`enumerable`/
/// `configurable` own data properties), beyond the call-dispatch opcodes the
/// interpreter loop already meters. The descriptor object is built with its
/// five slot charges removed from this measured constant (the
/// isolated `B - A` raw-gap minus the shared call dispatch); a novel key's
/// intern slot is metered separately by [`Interp::intern_key`].
#[doc(hidden)]
pub use ironhorse_meter::GOPD_PRESENT_RESIDUAL_METERING;

/// `Object.seal`/`freeze` keys-walk base: `mxBehaviorPreventExtensions` + the
/// `fxNewInstance` keys holder (one `fxNewSlot`, `1<<8`) over one `CODE` step
/// (`1<<16`) = `65792`, measured against the pin's raw-gap.
#[doc(hidden)]
pub use ironhorse_meter::INTEGRITY_APPLY_KEYS_BASE_METERING;

/// `Object.seal`/`freeze` per-own-key cost: the `mxBehaviorOwnKeys` at-slot
/// (`fxNewSlot`, exactly [`crate::meter::SLOT_ALLOCATION_METERING`] = `1<<8`)
/// per own key. The re-stamp allocates nothing.
#[doc(hidden)]
pub use ironhorse_meter::INTEGRITY_APPLY_PER_KEY_METERING;

/// `Object.isSealed`/`isFrozen` keys-walk base (the `fxNewInstance` keys
/// holder + `mxBehaviorOwnKeys` setup + the undefined property scratch), added
/// when the instance is non-extensible (an extensible instance short-circuits
/// to `false` before the walk). Measured exact against the pin's raw-gap.
#[doc(hidden)]
pub use ironhorse_meter::INTEGRITY_QUERY_KEYS_BASE_METERING;

/// `Object.isSealed`/`isFrozen` per-own-key cost: one `mxBehaviorOwnKeys`
/// at-slot (`fxNewSlot`, `1<<8`) per own key; the `mxBehaviorGetOwnProperty`
/// probe copies flags into the reused scratch, allocating nothing.
#[doc(hidden)]
pub use ironhorse_meter::INTEGRITY_QUERY_PER_KEY_METERING;

/// `Object.isExtensible(o)` / `isSealed` / `isFrozen` native-body base
/// residual: the native frame + `mxBehaviorIsExtensible` read. `isSealed`/
/// `isFrozen` additionally build the `fxNewInstance` keys holder and walk the
/// own keys — the [`INTEGRITY_QUERY_KEYS_BASE_METERING`] +
/// [`INTEGRITY_QUERY_PER_KEY_METERING`] added on top.
#[doc(hidden)]
pub use ironhorse_meter::IS_EXTENSIBLE_RESIDUAL_METERING;

#[doc(hidden)]
pub use ironhorse_meter::METHOD_ERROR_TOSTRING_METERING;

#[doc(hidden)]
pub use ironhorse_meter::METHOD_FUNCTION_TOSTRING_METERING;

#[doc(hidden)]
pub use ironhorse_meter::METHOD_HAS_OWN_PROPERTY_METERING;

/// Per-method raw 16.16 costs for the native prototype methods, measured
/// against the pin `48ee02d8cfe0` via the differential raw-gap. Each is the
/// method's cost beyond its call dispatch; the result-string chunk (for the
/// `toString` family) is metered separately at its `fxNewChunk`.
#[doc(hidden)]
pub use ironhorse_meter::METHOD_OBJECT_TOSTRING_METERING;

#[doc(hidden)]
pub use ironhorse_meter::OBJECT_ENTRIES_FRAME_METERING;

/// `Object.entries(o)` per-own-key native residual beyond the pair array's two
/// element slots and item chunk: the per-element value read plus the
/// `fxNewArray(2)` pair-instance construction, `1<<16`, measured exact.
#[doc(hidden)]
pub use ironhorse_meter::OBJECT_ENTRIES_PER_KEY_METERING;

/// `Object.keys(o)` fixed base: the native-method frame plus the
/// `fxNewArray(0)` result-instance allocation and the `fxOwnKeys` walk setup,
/// for an object with **no** enumerable keys (the empty-result case).
/// Measured against the pin via the isolated raw-gap (`B(0) - A(0)` over a
/// fixed empty object). The per-key cost is added on top: the result array's
/// item chunk grown once to hold all `n` keys ([`Interp::array_chunk_size_metering`])
/// plus one `fxNewSlot` (a string slot for the key name) per key. The key
/// name itself references the interned key string (XS_STRING_X_KIND), so it
/// allocates **no** chunk — `Object.keys` metering is independent of the key
/// name lengths, as the pin confirms.
///
/// This is the native-body residual *beyond* the `.keys` call-dispatch
/// opcodes the interpreter loop already meters (the isolated `B(0) - A(0)`
/// measurement folds in those ~9 dispatch computrons, which are removed
/// here): `655872 - 9<<16 = 66048`.
#[doc(hidden)]
pub use ironhorse_meter::OBJECT_KEYS_FRAME_METERING;

/// `Object.values(o)`/`entries(o)` native-body base (the result `fxNewArray`
/// + own-keys walk setup), mirroring [`OBJECT_KEYS_FRAME_METERING`]. The
/// per-key allocations (the value slot, and for `entries` the pair array) are
/// metered on top.
#[doc(hidden)]
pub use ironhorse_meter::OBJECT_VALUES_FRAME_METERING;

/// `Object.values(o)` per-own-key native residual beyond the result-array's
/// per-slot allocation ([`crate::meter::SLOT_ALLOCATION_METERING`]) and the
/// one-time item chunk: the per-element `mxBehaviorGetProperty` value read
/// (`3<<14`), measured exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::OBJECT_VALUES_PER_KEY_METERING;

/// Credits for the nullish `Object.prototype.valueOf` TypeError path. The
/// shared realm-error builder is slightly more expensive than XS's native
/// `ToObject` failure, and the two source values differ by one aligned-string
/// metering unit in the pin.
#[doc(hidden)]
pub use ironhorse_meter::OBJECT_VALUE_OF_NULL_CREDIT;

/// `Object.prototype.valueOf`'s `ToObject` host residual for a primitive
/// receiver, beyond the two wrapper slots metered by `array_to_object`.
/// Calibrated raw-exact against the pinned XS 9.0 oracle.
#[doc(hidden)]
pub use ironhorse_meter::OBJECT_VALUE_OF_PRIMITIVE_METERING;

#[doc(hidden)]
pub use ironhorse_meter::OBJECT_VALUE_OF_UNDEFINED_CREDIT;

/// `Object.preventExtensions(o)` native-body residual (constant, no per-key
/// work): `mxBehaviorPreventExtensions` sets the instance's
/// `XS_DONT_PATCH_FLAG` and meters nothing beyond the native frame. Calibrated
/// against the pin via the isolated raw-gap.
#[doc(hidden)]
pub use ironhorse_meter::PREVENT_EXTENSIONS_RESIDUAL_METERING;

/// `Object.prototype.propertyIsEnumerable(k)` native-body residual: the
/// `mxBehaviorGetOwnProperty` probe, mirroring `hasOwnProperty`.
#[doc(hidden)]
pub use ironhorse_meter::PROPERTY_IS_ENUMERABLE_METERING;

#[doc(hidden)]
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_FIXED_SUCCESS_METERING;

/// `Proxy.[[GetPrototypeOf]]` residuals split by the operation and validation
/// outcome that actually runs. Transparent Proxy-to-Proxy forwarding recurs;
/// a terminal ordinary target has the smaller forwarding residual.
#[doc(hidden)]
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_FORWARD_PROXY_METERING;

#[doc(hidden)]
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_FORWARD_TARGET_METERING;

#[doc(hidden)]
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_INVARIANT_REJECT_METERING;

/// IronHorse's shared realm-TypeError path is this much heavier than XS when
/// GetMethod finds a present but non-callable `getPrototypeOf` trap.
#[doc(hidden)]
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_NONCALLABLE_CREDIT;

/// Active-trap validation paths: invalid return type; non-extensible target
/// with a mismatching prototype; and non-extensible target with a valid match.
#[doc(hidden)]
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_PRIMITIVE_METERING;

/// The shorter `Proxy.[[GetPrototypeOf]]` frame when the trap throws before
/// its return-value and invariant checks.
#[doc(hidden)]
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_THROW_METERING;

/// Successful active trap on an extensible target.
#[doc(hidden)]
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_TRAP_METERING;

/// `Reflect.*` native-frame **advisory** residual: a modest per-call base for
/// the reflective built-ins (`getPrototypeOf`/`has`/`get`/`set`/… — XS's
/// `mxBehavior*` one-liners). Per the accuracy-over-parity doctrine, the
/// `Reflect` corpus is **result-gated** (the oracle certifies the reflected
/// value; computrons are advisory telemetry), so this is a directional native
/// frame charge — the same `1<<16` scale the other O(1) property-op residuals
/// use ([`PROPERTY_IS_ENUMERABLE_METERING`]) — not an isolated-raw-gap
/// calibration. The descriptor-shaped members (`getOwnPropertyDescriptor`/
/// `defineProperty`) reuse the calibrated `Object.*` residuals above, since
/// their bodies run the identical `fxFromPropertyDescriptor` /
/// `fxOrdinaryDefineOwnProperty` build.
#[doc(hidden)]
pub use ironhorse_meter::REFLECT_FRAME_METERING;

/// The fixed re-dispatch overhead `Function.prototype.call` accrues beyond
/// the visible `.call` opcodes and the callee body (measured as `2<<16`),
/// plus one built-in step ([`CALL_TRAMPOLINE_PER_ARG`]) per forwarded
/// argument (XS copies each). Calibrated against the pin via the raw-gap.
#[doc(hidden)]
pub use ironhorse_meter::CALL_TRAMPOLINE_METERING;

#[doc(hidden)]
pub use ironhorse_meter::CALL_TRAMPOLINE_PER_ARG;

/// `harden`/`petrify` per-hardened-object base: `fx_hardenFreezeAndTraverse`
/// builds the two `fxNewInstance` ownKeys holders (the freeze pass and the
/// traverse pass) over the `mxBehaviorPreventExtensions` frame. Modeled as two
/// `INTEGRITY_APPLY_KEYS_BASE`-shaped holders. `xsLockdown.c` calls no
/// `mxMeter`, so harden's whole cost is these allocation constants; the count
/// is deterministic per release (the bar) — computron parity against the pin is
/// structurally unavailable over a transitive walk into ironhorse's sparse
/// intrinsics, so the corpus is result-gated.
#[doc(hidden)]
pub use ironhorse_meter::HARDEN_OBJECT_BASE_METERING;

/// `harden`/`petrify` per-own-key cost: the two `mxBehaviorOwnKeys` at-slots
/// (`fxNewSlot`, `1<<8` each — freeze pass + traverse pass) plus the
/// `mxBehaviorDefineOwnProperty` re-stamp (no allocation). Petrify's single
/// pass uses [`PETRIFY_PER_KEY_METERING`].
#[doc(hidden)]
pub use ironhorse_meter::HARDEN_PER_KEY_METERING;

/// `harden` per newly-queued instance: the `fx_hardenQueue` worklist
/// `fxNewSlot` (`1<<8`).
#[doc(hidden)]
pub use ironhorse_meter::HARDEN_QUEUE_ITEM_METERING;

/// `petrify` single-object base: one `fxNewInstance` ownKeys holder (petrify
/// walks the keys once, no transitive traverse pass).
#[doc(hidden)]
pub use ironhorse_meter::PETRIFY_OBJECT_BASE_METERING;

/// `petrify` per-own-key cost: one `mxBehaviorOwnKeys` at-slot.
#[doc(hidden)]
pub use ironhorse_meter::PETRIFY_PER_KEY_METERING;

#[doc(hidden)]
pub use ironhorse_meter::APPLY_ARGUMENTS_ARRAYLIKE_CREDIT;

/// `Function.prototype.apply(thisArg, argArray)` with a real (dense) array
/// argument: the extra host cost `fx_Function_prototype_apply` accrues over
/// the no-array subset (whose base folds into [`CALL_TRAMPOLINE_METERING`]).
/// [`APPLY_ARRAY_BASE_METERING`] is the fixed setup the array path adds — the
/// `fxToInstance`/`fxToLength` of the array-like, the `mxGetID(_length)` read
/// (one `mxMeterOne`), and the tail-call re-dispatch cluster — beyond
/// `CALL_TRAMPOLINE_METERING`; [`APPLY_ARRAY_PER_ELEMENT_METERING`] is the
/// per-element cost (the `mxGetIndex(i)` read plus the forwarded-argument copy
/// through the tail-call). Both calibrated against the pin via the raw-gap:
/// with a fixed callee, each element grows the run by exactly `3 << 14` and
/// the array-argument base by a constant `98304` beyond
/// `CALL_TRAMPOLINE_METERING`. That base is `XS_CODE_METERING + 2 *
/// XS_BUILTIN_METERING`. The fixed base is independent of element count and
/// receiver kind; only the per-element term scales with the forwarded array.
#[doc(hidden)]
pub use ironhorse_meter::APPLY_ARRAY_BASE_METERING;

#[doc(hidden)]
pub use ironhorse_meter::APPLY_ARRAY_PER_ELEMENT_METERING;

/// Observable reads on an ordinary array-like already carry part of the
/// dense-array host residual. Arguments objects take the same semantic path
/// but use a smaller resident-storage frame in XS.
///
/// Read `34_240` until an ordinary object's index properties moved into the
/// index store. That is a fixed `-1200` raw per apply-over-ordinary-object,
/// independent of element count, so like the base above it localizes to this
/// constant rather than to a per-element term. It was always this value: a
/// hole-only array-like (`Math.max.apply(null,{length:3})`, which owns no
/// index property and so is untouched by the store) missed the oracle by the
/// same 1200 before the store existed. What hid it for an array-like WITH
/// index properties was the old representation minting a name per index —
/// `intern_key`'s slot + chunk, ~792 each — which happened to cover the gap
/// at the two-element shape pinned here and overshot at three. The store
/// charges XS's real growth instead (`index_prop_set`), so the credit now
/// carries only its own error, and both shapes are exact.
#[doc(hidden)]
pub use ironhorse_meter::APPLY_GENERIC_ARRAYLIKE_CREDIT;

#[doc(hidden)]
pub use ironhorse_meter::BIND_CREATE_ARGS_ARRAY;

/// `Function.prototype.bind` creation (`fx_Function_prototype_bind`): the
/// bound-function instance + its CODE/HOME slots + the `_boundFunction`/
/// `_boundThis`/`_boundArguments` internal properties + the bound `length`
/// and `name` (`"bound "+name`) properties. [`BIND_CREATE_METERING`] is the
/// fixed cluster with **no** bound arguments (`_boundArguments` is `null`).
/// When bound arguments exist, XS builds an Array instead
/// ([`BIND_CREATE_ARGS_ARRAY`] for the `fxNewArrayInstance` + `fxCacheArray`)
/// with [`BIND_CREATE_PER_ARG`] per copied argument. Calibrated against the
/// pin via the raw-gap.
#[doc(hidden)]
pub use ironhorse_meter::BIND_CREATE_METERING;

#[doc(hidden)]
pub use ironhorse_meter::BIND_CREATE_PER_ARG;

/// The bound-function call trampoline (`fx_Function_prototype_bound`): the
/// re-dispatch cost beyond the target's body, plus one built-in step
/// ([`BIND_CALL_PER_ARG`] = `1<<14`) per forwarded argument (bound + call).
/// Calibrated via the raw-gap: with a fixed target, each forwarded argument
/// grows the run by exactly `1<<14` and the base is a constant `180216`.
#[doc(hidden)]
pub use ironhorse_meter::BIND_CALL_METERING;

#[doc(hidden)]
pub use ironhorse_meter::BIND_CALL_PER_ARG;

/// The raw 16.16 cost the `instanceof` operator accrues beyond its own
/// dispatch for the `Symbol.hasInstance` host-frame call itself
/// (`fxRunInstanceOf` → `fxOrdinaryHasInstance`), measured against the pin
/// `48ee02d8cfe0` as `2 × XS_CODE_METERING` — paid for every operand,
/// object or primitive.
#[doc(hidden)]
pub use ironhorse_meter::INSTANCEOF_METERING;

/// The raw 16.16 cost the `in` operator accrues beyond its own dispatch when
/// the property is present: `fxRunIn` wraps `fxHasAt` in a host frame — one
/// code unit plus one built-in step. Measured against the pin `48ee02d8cfe0`
/// as exactly `(1<<16) + (1<<14)` (81920 raw), independent of the object.
#[doc(hidden)]
pub use ironhorse_meter::IN_METERING;

/// The raw 16.16 cost `XS_CODE_EVAL_REFERENCE`/`PROGRAM_REFERENCE` accrues per
/// **object** environment level it tests with `fxIsScopableSlot`: the host-frame
/// `mxHasID` (`fxBeginHost`/`HasProperty`/`fxEndHost`), measured as one
/// `XS_CODE_METERING` beyond the per-prototype-level recursion cost (which the
/// walk adds separately via `tick_code_n`). Calibrated exactly against the
/// pinned XS oracle on the `language/statements/with` slice (a present own hit
/// with no prototype recursion costs exactly this plus one
/// [`WITH_UNSCOPABLES_GET_METERING`]).
#[doc(hidden)]
pub use ironhorse_meter::WITH_SCOPABLE_HAS_METERING;

/// The raw 16.16 cost of the host `mxGetID(@@unscopables)` inside
/// `fxIsScopableSlot`, charged whenever the property is present (XS always reads
/// `obj[@@unscopables]` on a hit). One `XS_CODE_METERING`, calibrated against the
/// pinned XS oracle.
#[doc(hidden)]
pub use ironhorse_meter::WITH_UNSCOPABLES_GET_METERING;

/// The raw 16.16 cost of the *second* host get inside `fxIsScopableSlot` —
/// `obj[@@unscopables][id]` — charged only when `obj[@@unscopables]` is itself an
/// object (a blocklist to consult). Measured as half a `WITH_UNSCOPABLES_GET_METERING`
/// (the first get carries the shared host-frame teardown), calibrated against the
/// pinned XS oracle.
#[doc(hidden)]
pub use ironhorse_meter::WITH_UNSCOPABLES_BLOCKLIST_GET_METERING;

/// The raw 16.16 cost of one `fxOrdinaryHasProperty` frame: the
/// `mxPushUndefined`/`mxPop` pair it runs at every level that does **not** find
/// the property own, before recurring into the prototype.
///
/// Neither the `mxBehavior*` dispatch macros nor anything else in `xsType.c`
/// meters — that file contains no `mxMeterOne` at all. The cost is the stack
/// discipline around the recursion (`xsType.c`):
///
/// ```c
/// if (property) return 1;          /* own hit: no push, no pop */
/// mxPushUndefined();               /* mxOverflow(-1) -> mxMeterOne */
/// if (mxBehaviorGetPrototype(...)) result = mxBehaviorHasProperty(...);
/// else result = 0;
/// mxPop();                         /* mxMeterOne */
/// ```
///
/// `mxPushUndefined()` expands through `mxOverflow(-1)`, which is
/// `(mxMeterOne(), fxOverflow(…))`, and `mxPop()` is `(mxMeterOne(),
/// the->stack++)`. Two `mxMeterOne` steps — half an `XS_CODE_METERING`, not the
/// full unit a *dispatched* opcode pays.
///
/// Count **frames, not prototype hops.** A hit at depth `d` runs `d` frames
/// (the level holding the property returns before its push). A miss off the end
/// of an ordinary chain runs a frame at *every* object including the last,
/// which is one more than the number of hops. A Proxy answering `has` itself
/// contributes no frame, since `fxProxyHasProperty` does not run the pair.
///
/// Shared by `XS_CODE_IN` and the `with` scopable walk, which reach the same
/// recursion — `fxRunIn` calls `fxHasAt` once and does not re-enter per level.
/// Charging a whole `XS_CODE_METERING` per hop (as both sites did) was wrong in
/// both directions: measured against the pinned oracle on constructor chains of
/// verified depth 1..5, `in` ran +0.5 units per level long on a chain, hit and
/// miss alike, and 0.5 short on `'zz' in Object.create(null)`, where there is a
/// frame but no hop. Every `in` test used a shallow receiver, which descends no
/// level, so the two cancelled into invisibility.
#[doc(hidden)]
pub use ironhorse_meter::ORDINARY_HAS_PROPERTY_FRAME_METERING;

/// The raw 16.16 environment-setup residual `XS_CODE_WITH` accrues beyond its
/// two `fxNewSlot` allocations and its own dispatch: the host-frame work
/// `fxNewEnvironmentInstance` runs to splice the environment instance into the
/// chain (two `mxMeterOne` steps). Measured as exactly `2 × XS_BUILTIN_METERING`
/// against the pinned XS oracle on the empty-body `with`. Attributed to `WITH`
/// (not the co-emitted `TO_INSTANCE`, whose zero-cost `ToObject` on an object is
/// already calibrated by object destructuring).
#[doc(hidden)]
pub use ironhorse_meter::WITH_ENV_SETUP_METERING;

/// The additional raw 16.16 cost when the left operand is an object:
/// `fxOrdinaryHasInstance` reads the constructor's `.prototype` and walks the
/// chain, whereas a primitive short-circuits to `false` before it. Measured
/// as a further `2 × XS_CODE_METERING`, independent of chain depth or result.
#[doc(hidden)]
pub use ironhorse_meter::INSTANCEOF_OBJECT_METERING;

/// The raw 16.16 cost a primitive-wrapper constructor (`new Boolean`/
/// `new Number`/`new String`) accrues over the native `Object` constructor's
/// empty-object cost: the internal `[[XxxData]]` slot plus the wrap step.
/// Measured against the pin `48ee02d8cfe0` as the raw gap between
/// `new Boolean()` and `new Object()` = `(1<<16) + 256` (65792). Accrued in
/// [`Interp::build_wrapper`].
#[doc(hidden)]
pub use ironhorse_meter::WRAPPER_CONSTRUCT_EXTRA;

/// The raw 16.16 cost of a `Symbol()` call (`fx_Symbol`/`fxNewSymbol`): the
/// symbol slot plus its registration. Measured against the pin `48ee02d8cfe0`
/// as 33792 raw, independent of the description. Accrued per `Symbol()` call.
#[doc(hidden)]
pub use ironhorse_meter::SYMBOL_CREATE_METERING;

#[doc(hidden)]
pub use ironhorse_meter::SYMBOL_FOR_METERING;

#[doc(hidden)]
pub use ironhorse_meter::SYMBOL_KEYFOR_METERING;

/// The raw 16.16 cost of `Symbol.prototype.toString()` (`fx_Symbol_prototype_
/// toString` → `fxCheckSymbol` + `fxSymbolToString`: the host-frame check plus
/// the incremental `fxStringX("Symbol(")`/`fxConcatString`/`fxConcatStringC`
/// build) beyond the method dispatch. Calibrated against the pin via the
/// raw-gap as a constant `33368` (a ≤~24-raw sub-computron chunk-alignment
/// residual as the description length varies stays below one computron). The
/// `String(sym)` coercion path (`Native::String`) folds this into the native
/// call and needs no residual. `Symbol.for`/`keyFor` meter nothing beyond
/// their dispatch and result-chunk allocation (verified bit-exact).
#[doc(hidden)]
pub use ironhorse_meter::SYMBOL_TO_STRING_METERING;

/// The raw 16.16 cost an Error constructor accrues over the native `Object`
/// constructor's empty-object cost: the extra internal slots and steps an
/// error instance carries (`fx_Error`/`fxNewErrorInstance` — the stack-trace
/// capture and internal `[[ErrorData]]`). Measured against the pin
/// `48ee02d8cfe0` as the raw gap between `new Error()` and `new Object()` =
/// 66304 (one built-in step `1<<16` plus 768 for the extra slots). Accrued
/// in [`Interp::build_error`].
#[doc(hidden)]
pub use ironhorse_meter::ERROR_CONSTRUCT_EXTRA;

/// The raw 16.16 cost of an Error's own `message` property when a message
/// argument is supplied (`fx_Error` defining `message`). Measured against the
/// pin as `new Error('x')` minus `new Error()` = 280 raw, independent of the
/// message length (the message string's own chunk is metered at its literal).
#[doc(hidden)]
pub use ironhorse_meter::ERROR_MESSAGE_METERING;

/// `new DisposableStack()` / `new AsyncDisposableStack()` beyond what the
/// arm's own allocation models. Measured against the pinned oracle
/// (2026-08-27, the resource-management dual-run deltas): a bare construct
/// under-metered by exactly two dispatch units, stable across every shape
/// probed, so the gap is charged as a whole-unit constant.
#[doc(hidden)]
pub use ironhorse_meter::DISPOSABLE_STACK_CONSTRUCT_METERING;

/// One record-adding DisposableStack method (`use`/`adopt`/`defer`) or a
/// `move`. Measured (same probe): each added two dispatch units over the
/// modeled cost, additive across combinations (defer×2 + move measured
/// exactly 3× this constant beyond the construct).
#[doc(hidden)]
pub use ironhorse_meter::DISPOSABLE_STACK_ADD_METERING;

/// Disposing a `use` record (the @@dispose method invoked WITH the
/// resource as `this`) costs one dispatch unit more than the modeled
/// callback; `defer`/`adopt` records (undefined `this` / passed resource)
/// measured no residue. Charged per record in the dispose drain.
#[doc(hidden)]
pub use ironhorse_meter::DISPOSE_USE_RECORD_METERING;

/// The `using`/`await using` declaration opcode's bookkeeping beyond the
/// modeled lookups: one dispatch unit always (the null/undefined skip path
/// measured exactly this), plus [`USING_RESOURCE_METERING`] when the
/// resource is real. Measured on the sync form; the async form shares the
/// arm and the charge, pending its own oracle calibration.
#[doc(hidden)]
pub use ironhorse_meter::USING_DECL_METERING;

/// The non-nullish `using` resource's disposer capture beyond the modeled
/// @@dispose lookup — one further dispatch unit (measured: a real-resource
/// `using` totals exactly two units over the modeled cost, the null form
/// one).
#[doc(hidden)]
pub use ironhorse_meter::USING_RESOURCE_METERING;

/// `AggregateError(errors, message)` beyond the base error
/// ([`ERROR_CONSTRUCT_EXTRA`] + the message): the `errors` Array instance
/// (`fxNewArrayInstance` + `fxCacheArray`) plus the `fxGetIterator` +
/// `fxIteratorNext` loop over the iterable, and the `errors` own property.
/// [`AGGREGATE_ERROR_EXTRA`] is the fixed part (array + get-iterator + the
/// final `done` next + the property); [`AGGREGATE_ERROR_PER_ELEMENT`] is the
/// per-element `fxIteratorNext` (the iterator `.next()` call + its result's
/// `value`/`done` reads) plus the `fxNewSlot` copy into the errors array.
/// Calibrated against the pin via the raw-gap (a ≤~24-raw sub-computron
/// item-chunk-alignment residual as the errors length varies stays below one
/// computron).
#[doc(hidden)]
pub use ironhorse_meter::AGGREGATE_ERROR_EXTRA;

#[doc(hidden)]
pub use ironhorse_meter::AGGREGATE_ERROR_PER_ELEMENT;

/// The raw 16.16 cost the `XS_CODE_ARRAY` opcode accrues beyond its own
/// dispatch: `fxNewArray(the, 0)` runs `fxNewArrayInstance`
/// (`fxNewObjectInstance` — one instance `fxNewSlot` — plus one internal
/// `XS_ARRAY_KIND` behavior slot `fxNewSlot`: `2 × XS_SLOT_ALLOCATION_METERING`
/// = 512), plus one built-in step (`XS_BUILTIN_METERING` = 1<<14 = 16384) the
/// array-instance construction runs (`fxNewArrayInstance`/`fxIndexArray`) —
/// 16896 raw total. Isolated against the pin `48ee02d8cfe0` via a *second*
/// `arr.length = N` store (which the fuzz arm generated): the length
/// accessor-setter itself meters **nothing** beyond dispatch when it does not
/// resize the chunk ([`ARRAY_LENGTH_SET_METERING`] = 0), so the fixed
/// per-array constant that made array *literals* bit-exact belongs to the
/// `ARRAY` create, not to the literal's length prelude. Accrued in
/// [`Interp::new_array`].
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_CREATE_METERING;

/// The raw 16.16 cost of an `arr.length = N` store that does **not** resize
/// the item chunk (setting the length of an array with no live item chunk, or
/// to a value the chunk already spans). Measured against the pin
/// `48ee02d8cfe0` — isolated by a *second* `arr.length = N` store the fuzz arm
/// generated — as **zero** beyond the store's own dispatch: the fixed
/// per-array constant that makes literals bit-exact is the `ARRAY` create's
/// build step ([`ARRAY_CREATE_METERING`]), not the length set. (A length
/// store that *shrinks* an array with a live item chunk additionally reallocs
/// the chunk; that chunk metering is a later increment — the covered corpus
/// shrinks only hole/short arrays whose chunk is unaffected.)
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_LENGTH_SET_METERING;

/// The raw 16.16 cost of an `arr.length` read beyond its own dispatch.
/// Measured against the pin `48ee02d8cfe0` as **zero**: the length accessor
/// getter (`fxArrayLengthGetter`) returning the stored length adds no
/// built-in step or allocation over the `GET_PROPERTY` dispatch already
/// metered. Kept as a named constant so a future revision can revise it in
/// one place.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_LENGTH_GET_METERING;

/// The raw 16.16 cost `NEW_PROPERTY_AT` accrues defining a fresh array item
/// beyond its dispatch and the item-chunk growth: one built-in step
/// (`fxRunDefine`'s `mxMeterOne`). Measured against the pin as `1 <<
/// 14` = 16384 (verified: an N-element literal's per-element raw delta is
/// exactly `5 × XS_CODE_METERING + 16384 + item_chunk_bytes`). The chunk
/// growth is metered separately by [`Interp::array_item_grow_metering`].
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITEM_DEFINE_STEP_METERING;

/// `Array.prototype.at` frame cost + the in-range element read (`mxGetAt`).
/// Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_AT_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_AT_READ_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_CONCAT_CHECK_METERING;

/// `Array.prototype.concat` frame cost + the `Symbol.isConcatSpreadable`
/// check per reference operand + the per-spread-element read and per-appended-
/// value residual (beyond the per-element/per-value key slot and `mxMeterSome`,
/// the result chunk, and the closing `mxMeterSome(3)`). Calibrated against the
/// pin by solving the linear system over a spread of operand shapes.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_CONCAT_FRAME_METERING;

/// Extra raw per appended non-array value, over the key slot + `mxMeterSome(4)`.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_CONCAT_PRIM_EXTRA_METERING;

/// Extra raw per spread element (its `mxGetIndex`/`fxHasIndex` read), over the
/// key slot + `mxMeterSome(2)`.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_CONCAT_SPREAD_EXTRA_METERING;

/// `Array.prototype.copyWithin` frame cost, beyond the `mxMeterSome(count*10)`
/// for the copied block. Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_COPYWITHIN_FRAME_METERING;

/// `Array.prototype.fill` frame cost (the full-fill chunk realloc and the
/// per-element `mxMeterSome(5)` are metered separately). Calibrated.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FILL_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FILTER_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FILTER_KEEP_METERING;

/// The fixed backward-scan setup `findLast`/`findLastIndex` accrue over the
/// forward `find`/`findIndex`. Measured against the pin as `6 << 14`.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FINDLAST_EXTRA_METERING;

/// `find`/`findIndex` use `fxFindThisItem` (calls the callback for every index,
/// holes included), a different per-element overhead than `fxCallThisItem`.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FIND_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FIND_PER_ELEM_METERING;

/// The per-source-element callback overhead of `flatMap` (`fxCallThisItem` in
/// `flatAux`'s function branch), beyond the callback body and the result
/// flattening (which reuses the `flat` constants). Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FLATMAP_CALLBACK_METERING;

/// `Array.prototype.flat` frame cost (`fxCreateArraySpecies` + host frame, as
/// slice/splice), plus the per-appended-leaf cost (the visit read + the
/// `mxDefineIndex` step, `9 << 14`; the chunk growth is metered separately) and
/// the per-array-element cost (the visit read + the `.length` read before
/// recursing, `11 << 14`). Calibrated against the pin by solving the linear
/// system (the visit count is `leaves + arrays`, so two constants suffice).
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FLAT_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FLAT_PER_ARRAY_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FLAT_PER_LEAF_METERING;

/// `Array.prototype.forEach` frame cost + the per-element `fxCallThisItem`
/// overhead (`mxGetIndex` + the callback call-frame setup), beyond the
/// callback body's own metering. Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FOREACH_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FOREACH_PER_ELEM_METERING;

/// `Array.prototype.includes` frame + per-element scan step. Calibrated
/// against the pin `48ee02d8cfe0` via the completed-call raw-gap.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_INCLUDES_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_INCLUDES_PER_STEP;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_INDEXOF_PER_STEP;

/// `Array.prototype.join` frame cost (the host frame + `fxGetArrayLimit` + the
/// result setup, beyond the modeled key-list/element-slot/ToString/final-chunk
/// allocations). Calibrated against the pin for the default (",") separator; a
/// non-default *string* separator argument carries a documented −24-raw
/// sub-computron residual (well under a `>> 16` boundary; every corpus/fuzz/
/// test262 check compares computrons and stays exact).
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_JOIN_FRAME_METERING;

/// The per-element base cost `Array.prototype.join` accrues for every index
/// (the `mxGetIndex` read + loop overhead), on top of the element's ToString
/// allocation: `1 << 16`. Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_JOIN_PER_ELEMENT_METERING;

/// `Array.prototype.lastIndexOf` frame + per-element (backward) scan step.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_LASTINDEXOF_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_LASTINDEXOF_PER_STEP;

/// Frame/per-element residuals for the other callback-taking methods, beyond
/// the shared per-element `fxCallThisItem` overhead
/// ([`ARRAY_FOREACH_PER_ELEM_METERING`]) and the callback body. Calibrated
/// against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_MAP_FRAME_METERING;

/// The fixed frame cost of `Array.prototype.indexOf` (`2 << 14`) and its
/// per-element scan step (`5 << 14` = 81920, `mxMeterSome(5)` per compared
/// element). Measured against the pin: `gap = 32768 + 81920 × elements_scanned`
/// (scanning stops at the first strict-equal match).
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_METHOD_INDEXOF_FRAME_METERING;

/// The fixed raw 16.16 cost of a dense `Array.prototype.pop` call beyond its
/// modeled `mxMeterSome(2 + 8 + 4)` and the chunk shrink: **zero** (measured
/// bit-exact against the pin with no residual).
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_POP_FRAME_METERING;

/// The `fxToBoolean` of a predicate callback's result (`some`/`every`/`find`/
/// `filter`).
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_PREDICATE_TOBOOL_METERING;

/// The fixed raw 16.16 cost of a dense `Array.prototype.push` call beyond the
/// per-item `mxMeterSome(5)`, the two bracketing `mxMeterSome(2)` steps, and
/// the modeled item-chunk growth: two further built-in steps
/// (`2 << 14` = 32768) the fast path runs unconditionally (host-frame /
/// `fxCheckArray` residual). Measured against the pin `48ee02d8cfe0` as the
/// constant raw-gap across a spread of receiver lengths and argument counts.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_PUSH_FRAME_METERING;

/// `Array.prototype.reduce`/`reduceRight` frame + per-fold-step
/// `fxReduceThisItem` overhead (a 4-arg callback), beyond the callback body.
/// Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_REDUCE_FRAME_METERING;

/// The seed-finding scan `reduce`/`reduceRight` runs when no initial value is
/// given: for a dense array the accumulator seeds from the first (or last)
/// present element in one iteration (`mxGetIndex` read), `6 << 14`.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_REDUCE_INIT_SCAN_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_REDUCE_PER_ELEM_METERING;

/// `Array.prototype.reverse` frame cost + per-swap cost (each swap does
/// `mxHasAt`/`mxGetAt`×2/`mxSetAt`×2 over the generic path). Calibrated
/// against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_REVERSE_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_REVERSE_PER_SWAP_METERING;

/// `Array.prototype.slice` frame cost (the result array's `fxCreateArraySpecies`
/// + host frame + closing `mxMeterSome(3)`); a non-empty slice adds the result
/// chunk and `mxMeterSome(count*10)`. Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_SLICE_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_SOMEEVERY_FRAME_METERING;

/// `Array.prototype.splice` frame cost (`fxCreateArraySpecies` + host frame),
/// beyond the modeled result chunk, tail-shift, per-item, and per-`mxMeterSome`
/// costs. Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_SPLICE_FRAME_METERING;

/// `Array.prototype.toReversed` frame cost (the same copy loop as `with`, one
/// code unit more of setup). Measured against the pin as 131584.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_TOREVERSED_FRAME_METERING;

/// `Array.prototype.toSpliced` frame cost (`fxNewArray` host frame), beyond the
/// modeled result chunk and the per-region `mxMeterSome` copy costs
/// (`start * 10` for the head, `5` per insertion, `rest * 10` for the tail,
/// plus a trailing `4`). Non-mutating: the receiver is untouched. Calibrated
/// against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_TOSPLICED_FRAME_METERING;

/// `Array.prototype.toString` prelude cost beyond the delegated `join` body:
/// the `mxThis`/`mxDub`/`mxGetID(_join)` lookup plus the `mxCall`/`mxRunCount(0)`
/// call-frame setup that invokes `join`. Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_TOSTRING_PRELUDE_METERING;

/// `Array.prototype.unshift` fixed frame cost (`fxCheckArray` host frame),
/// beyond the grow chunk, `mxMeterSome(length*10)`, per-arg `mxMeterSome(4)`,
/// and closing `mxMeterSome(2)`. Measured against the pin as `2 << 14`. (shift
/// needs no such residual — its `mxMeterSome(2+3+3+4)` fully accounts for it.)
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_UNSHIFT_FRAME_METERING;

/// `Array.prototype.with` frame cost + per-element copy over the generic
/// `mxGetAt`/`mxDefineAt` path (plus the result chunk). Calibrated against the
/// pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_WITH_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_WITH_PER_ELEM_METERING;

/// The constant raw 16.16 cost of an `Array(...)` / `new Array(...)` call
/// beyond the element item-chunk allocation: the native host frame,
/// `fxGetPrototypeFromConstructor`, and `fxNewArrayInstance`. Measured
/// against the pin `48ee02d8cfe0` as the constant raw-gap of `Array()` /
/// `Array(n)` / `new Array()` (no chunk), independent of the length; the
/// element forms add exactly one `array_chunk_size_metering(count)` on top.
/// (98816 = six built-in steps + the two `fxNewArrayInstance` slots; the
/// raw-gap the differential harness reports for a completed call, not the
/// larger figure a *halted* ironhorse showed before the call was modeled.)
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_CTOR_BASE_METERING;

/// The raw 16.16 cost of `Array.isArray(v)` beyond its dispatch: **zero**
/// (measured against the pin — the completed-call raw-gap, independent of the
/// argument).
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ISARRAY_METERING;

/// The raw 16.16 cost of the `ArrayBuffer.prototype.byteLength` accessor
/// getter (`fx_ArrayBuffer_prototype_get_byteLength`) beyond the
/// `GET_PROPERTY` dispatch: measured against the pin (the getter reads the
/// stored `bufferInfo.length` and meters nothing itself).
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_BUFFER_BYTE_LENGTH_GET_METERING;

/// The constant raw 16.16 cost of a `new ArrayBuffer(n)` construct beyond
/// the byteLength-dependent backing-store chunk: the native host frame,
/// `fxArgToSafeByteLength`, `fxGetPrototypeFromConstructor`, and
/// `fxNewArrayBufferInstance` (`fxNewObjectInstance` + the two internal
/// `fxNewSlot`s — the `XS_ARRAY_BUFFER_KIND` and `XS_BUFFER_INFO_KIND`
/// slots). Calibrated raw-exact against the pin `48ee02d8cfe0` via the
/// completed-call raw-gap, independent of `n` (the `fxNewChunk(n)` backing
/// store is metered separately by [`crate::meter::Meter::tick_chunk_new`]).
/// 99072 = six built-in steps (`6 << 14`) + three `fxNewSlot`s (`3 << 8` —
/// the object instance plus the two internal slots).
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_BUFFER_CTOR_FRAME_METERING;

/// The raw 16.16 cost of `ArrayBuffer.isView(v)` beyond its dispatch,
/// calibrated raw against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_BUFFER_ISVIEW_METERING;

/// The raw 16.16 cost of a single `Atomics.*` read-modify-write beyond the
/// method dispatch (`xsAtomics.c` element access → `mxMeterOne`). Result-gated
/// on the official slice (the Atomics computron parity is not asserted).
#[doc(hidden)]
pub use ironhorse_meter::ATOMICS_OP_METERING;

/// The constant raw 16.16 cost of a `new DataView(buffer[, offset[, len]])`
/// construct: the native host frame, `fxArgToByteLength`, the bounds checks,
/// `fxGetPrototypeFromConstructor`, and `fxNewDataViewInstance` (the object
/// instance + two internal `fxNewSlot`s — the view slot and the buffer-ref
/// slot). No backing store is allocated (the view shares the argument
/// buffer). Calibrated raw-exact against the pin `48ee02d8cfe0` (99080).
#[doc(hidden)]
pub use ironhorse_meter::DATA_VIEW_CTOR_FRAME_METERING;

/// The raw 16.16 cost of a single `DataView.prototype.get<Type>` beyond the
/// method dispatch: the getter's `mxMeterOne` (one built-in step). Calibrated
/// raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::DATA_VIEW_GET_METERING;

/// The raw 16.16 cost of a single `DataView.prototype.set<Type>` beyond the
/// method dispatch: three built-in steps — the value coercer
/// (`fxToInteger`/`fxToUnsigned`/`fxToNumber`, two steps, constant across the
/// element types) plus the setter's `mxMeterOne`. Calibrated raw-exact
/// against the pin `48ee02d8cfe0`.
#[doc(hidden)]
pub use ironhorse_meter::DATA_VIEW_SET_METERING;

/// The constant raw 16.16 cost of a `new <TypedArray>(buffer[, offset[,
/// length]])` construct over an existing ArrayBuffer: the native host frame
/// and `fxConstructTypedArray` (the instance + three internal slots). No
/// backing store is allocated (the view shares the argument buffer), so
/// this is the whole cost. Calibrated raw-exact against the pin (99336).
#[doc(hidden)]
pub use ironhorse_meter::TYPED_ARRAY_BUFFER_CTOR_FRAME_METERING;

/// The raw 16.16 cost of a single TypedArray element read/write through the
/// exotic index behavior (`fxTypedArrayGetter`/`fxTypedArraySetter` →
/// `mxMeterOne`) beyond the index-property dispatch: one built-in step.
#[doc(hidden)]
pub use ironhorse_meter::TYPED_ARRAY_ELEMENT_METERING;

/// `new <TypedArray>(source)` from a dense Array / source TypedArray
/// (`fx_TypedArray` → `fxConstructTypedArray` → the element copy):
/// per-element **advisory** step over the [`TYPED_ARRAY_LENGTH_CTOR_FRAME_METERING`]
/// frame + `alloc_array_buffer` chunk. XS reaches this either through the
/// iterator protocol (a spread source with `Symbol.iterator`) or the
/// array-like fast path, whose per-element metering differs; per the
/// accuracy-over-parity doctrine the from-source corpus is **result-gated**
/// (the oracle certifies the element bytes; computrons are advisory), so this
/// is the directional per-element setter step (`mxMeterOne` = one builtin
/// step), not an isolated-raw-gap calibration.
#[doc(hidden)]
pub use ironhorse_meter::TYPED_ARRAY_FROM_SOURCE_ELEMENT_METERING;

/// The constant raw 16.16 cost of a `new <TypedArray>(length)` construct
/// beyond the byteLength-dependent backing-store chunk: the native host
/// frame, `fxConstructTypedArray` (`fxGetPrototypeFromConstructor` +
/// `fxNewTypedArrayInstance` — the object instance plus its three internal
/// `fxNewSlot`s: dispatch, view, and buffer-ref), and the inner
/// `new ArrayBuffer(length << shift)` construct's own frame (`mxNew`/
/// `mxRunCount`). The only length-dependent piece is the backing
/// `fxNewChunk(length << shift)`, metered separately. Calibrated raw-exact
/// against the pin `48ee02d8cfe0` (280320 = the TypedArray instance frame +
/// the inner `new ArrayBuffer` construct frame; the length-dependent chunk
/// is metered by `alloc_array_buffer`, independent of this constant).
#[doc(hidden)]
pub use ironhorse_meter::TYPED_ARRAY_LENGTH_CTOR_FRAME_METERING;

/// The raw 16.16 cost of the TypedArray `length`/`byteLength`/`byteOffset`
/// accessor getters (`fx_TypedArray_prototype_*_get`) beyond the
/// `GET_PROPERTY` dispatch: measured against the pin.
#[doc(hidden)]
pub use ironhorse_meter::TYPED_ARRAY_LENGTH_GET_METERING;

/// The extra raw 16.16 cost of a for-in enumerator over an **array** (vs an
/// ordinary object): `mxBehaviorOwnKeys` for an exotic array (`fxArrayOwnKeys`
/// queuing the index keys) does more than `fxOrdinaryOwnKeys`. Measured
/// against the pin as a constant, independent of the element count.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_FOR_IN_EXTRA_METERING;

/// The raw 16.16 cost of `Array.prototype.values()`/`keys()`/`entries()`
/// beyond its dispatch: the native host frame plus `fxNewIteratorInstance`
/// (the iterator instance + the reused `{value, done}` result object + the
/// internal kind/iterable/index slots — a fixed cluster of `fxNewSlot`s).
/// Calibrated against the pin `48ee02d8cfe0` via the completed-call raw-gap
/// (isolated from `next()` by comparing one- vs two-`next()` programs).
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_CREATE_METERING;

/// The extra raw 16.16 cost a `values`/`entries` `next()` accrues reading the
/// array element it yields (`mxGetIndex`), over a `keys` next: `2 << 14`.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_ELEMENT_READ;

/// The additional host step in XS's `fxGetArrayLimit` path for a generic
/// array-like receiver. Arrays and TypedArrays read their resident limits
/// directly; ordinary objects, primitive wrappers, and Proxies perform the
/// observable `length` lookup and carry this one-computron residual.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_GENERIC_RECEIVER_METERING;

/// The base raw 16.16 cost of `%ArrayIteratorPrototype%.next()` beyond its
/// dispatch: the host frame, `fxCheckIteratorInstance`, and the result-object
/// mutation (the result object is reused, so `next()` allocates nothing for
/// kinds 0/1). A `values`/`entries` next that actually yields an element adds
/// one array-element read ([`ARRAY_ITERATOR_ELEMENT_READ`]). Calibrated
/// against the pin: `keys` next = 32768, `values` next = 65536.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_NEXT_METERING;

/// A transparent target reached by `Reflect.get` inside an active iterator
/// Proxy trap carries the active host frame through to the terminal target.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_ACTIVE_FORWARD_TARGET_METERING;

/// Transition from a transparent outer Proxy to an active inner trap. The
/// value read has an additional half-computron host-frame component.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_FORWARD_ACTIVE_METERING;

/// Per-layer and terminal-target residuals for a transparent Proxy `[[Get]]`
/// forwarding chain in the Array Iterator path.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_FORWARD_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_FORWARD_TARGET_METERING;

/// Raw residual for an observable Proxy `[[Get]]` trap on `length` during a
/// generic Array Iterator step. Charged only when the trap actually exists;
/// transparent and nested forwarding paths recurse without the residual.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_KEYS_METERING;

/// String-wrapper residual when the length read arrives through transparent
/// Proxy forwarding. The Proxy target frame absorbs one half-computron of the
/// direct wrapper path.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_STRING_RECEIVER_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_VALUE_ACTIVE_FORWARD_TARGET_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_VALUE_FORWARD_ACTIVE_METERING;

#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_VALUE_FORWARD_TARGET_METERING;

/// Raw residual for the second observable Proxy `[[Get]]` trap on the indexed
/// value of a values/entries step. The combined direct two-trap residual is
/// 654864 raw units against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_VALUE_METERING;

/// Additional raw residual for the String-exotic generic iterator path. The
/// wrapper exposes synthetic UTF-16 indices and `length`, which XS accounts
/// beyond the ordinary-object `fxGetArrayLimit` step.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_STRING_RECEIVER_METERING;

/// XS keeps arguments in resident indexed storage even though their `length`
/// is an ordinary property. Its wide-length fallback avoids part of the
/// generic property path; credit that raw fractional difference before
/// repeated calls accumulate into whole computrons.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_WIDE_ARGUMENTS_CREDIT;

/// Symbol and BigInt wrappers carry one additional half-computron allocation
/// residual on the pinned generic receiver path.
#[doc(hidden)]
pub use ironhorse_meter::ARRAY_ITERATOR_WIDE_PRIMITIVE_RECEIVER_METERING;

/// The base raw 16.16 cost of a yielding `fx_Enumerator_prototype_next` beyond
/// the yielded key's own string-chunk allocation. Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::ENUMERATOR_NEXT_METERING;

/// The raw 16.16 cost of building a for-in enumerator (`XS_CODE_FOR_IN` →
/// `mxEnumeratorFunction` → `fx_Enumerator`): the enumerator + result objects,
/// the own-keys collection, and the host frame — a fixed cluster independent
/// of the key count (the per-key string allocation is metered in
/// [`ENUMERATOR_NEXT_METERING`] + the key chunk). Calibrated against the pin
/// for an empty ordinary-object enumeration; an array adds
/// [`ARRAY_FOR_IN_EXTRA_METERING`]. Known sub-computron residual: the exact
/// non-empty keys-list handling carries a ±8-raw chunk-alignment gap
/// (analogous to the array-spread residual) that is well under one computron
/// and never crosses a `>> 16` boundary in a bounded program, so the
/// computron-level bar (which every corpus/fuzz/test262 check uses) stays
/// exact; modeling the keys-instance chunk capacity to close it is a later
/// refinement.
#[doc(hidden)]
pub use ironhorse_meter::FOR_IN_ENUMERATOR_METERING;

/// The raw 16.16 cost of `XS_CODE_FOR_OF` (`fxRunForOf` → `fxGetIterator`)
/// beyond the `values()` iterator creation it performs: the `fxGetIterator`
/// host frame, the `arr[Symbol.iterator]` lookup, and the zero-argument call
/// dispatch. Calibrated against the pin `48ee02d8cfe0` via the completed
/// for-of loop raw-gap (the `values()` create cost itself is metered inside
/// [`Interp::make_array_iterator`]) — a constant `2 << 16`, independent of the
/// iterable's length.
#[doc(hidden)]
pub use ironhorse_meter::FOR_OF_GET_ITERATOR_METERING;

/// The raw 16.16 cost of creating a String Iterator (`fx_String_prototype_
/// iterator` → `fxNewIteratorInstance`), analogous to
/// [`ARRAY_ITERATOR_CREATE_METERING`] but chaining to
/// `%StringIteratorPrototype%`. Calibrated against the pin.
#[doc(hidden)]
pub use ironhorse_meter::STRING_ITERATOR_CREATE_METERING;

/// The base raw 16.16 cost of `%StringIteratorPrototype%.next()` that yields a
/// character, beyond the result-string chunk it allocates (`fxNewChunk`, metered
/// separately via [`Interp::meter`] `tick_chunk_new`): the host frame, the
/// `mxStringByteDecode`, and the result-object mutation. Calibrated against the
/// pin.
#[doc(hidden)]
pub use ironhorse_meter::STRING_ITERATOR_NEXT_METERING;

/// The whole raw 16.16 computron cost of a `Math.*` static call, beyond the
/// `RUN` opcode's own dispatch metering. Every `xsMath.c` body carries no
/// `mxMeterSome` and allocates no chunk (the result is a number/integer
/// slot, never heap), so the cost is exactly the native host frame
/// (`fxBeginHost`/`fxEndHost` + the callback dispatch), a single constant
/// shared by every Math function regardless of arity. Calibrated against the
/// pin `48ee02d8cfe0` as **zero**: the `RUN` opcode ironhorse already meters
/// (`1 << 16`) plus the argument-push opcodes fully account for the observed
/// oracle computrons — the C host frame (`fxBeginHost`/`fxEndHost`) adds no
/// metered step of its own for a `Math.*` call (raw_gap measured 0 across
/// `abs`/`max`/`sqrt`/`floor`/… on the pin).
#[doc(hidden)]
pub use ironhorse_meter::MATH_FRAME_METERING;

/// The native-host-frame cost of a `Number` static / numeric global call
/// (`isFinite`/`isInteger`/`isNaN`/`isSafeInteger`/`parseInt`/`parseFloat`/
/// `isNaN`/`isFinite`), beyond the `Number.prototype.toString` result chunk.
/// Like `Math.*`, the `xsNumber.c` bodies carry no `mxMeterSome`, so the frame
/// calibrates against the pin `48ee02d8cfe0` to zero over the `RUN` opcode.
#[doc(hidden)]
pub use ironhorse_meter::NUMBER_FRAME_METERING;

/// The extra residual a `JSON.stringify` of a **produced** top-level primitive
/// accrues over the setup (the `fxStringifyJSONName` + value-append path):
/// a fixed `16384` (`1 << 14`), independent of the primitive's spelling (the
/// result chunk is metered separately). This is also the recursive
/// `fxStringifyJSONProperty` leaf cost — a primitive property/element serializes
/// for exactly one built-in step.
#[doc(hidden)]
pub use ironhorse_meter::JSON_STRINGIFY_SCALAR_METERING;

/// The `JSON.stringify` setup residual: `fxStringifyJSON` mallocs an unmetered
/// 1 KiB working buffer but also allocates a metered holder object
/// (`fxNewObjectInstance` + `fxNextSlotProperty`) and runs the host frame — a
/// fixed `82432` raw 16.16 units, independent of the value, measured against
/// the pin `48ee02d8cfe0` (the `JSON.stringify(undefined)` no-output gap).
#[doc(hidden)]
pub use ironhorse_meter::JSON_STRINGIFY_SETUP_METERING;

// Structured `JSON.stringify` (object/array) per-node metering, decomposed
// against the pin `48ee02d8cfe0` `xsJSON.c` `fxStringifyJSONProperty` and its
// callees, and reconciled bit-exact against the oracle (README § the JSON
// stage). Every value walked recurses through `fxStringifyJSONProperty`; the
// costs below are the run-only 16.16 units that call charges, exclusive of the
// result chunk (which the caller meters once via `new_string_metered`) and of
// the setup holder ([`JSON_STRINGIFY_SETUP_METERING`]). Each constant is a whole
// number of `mxMeterOne` (`1<<14`) steps plus the exact `fxNewSlot`/`fxNewChunk`
// allocations the C path makes, not a fitted total.
//
/// Each array element's per-iteration body (`mxPushReference`, `mxGetIndex`,
/// `mxPushInteger`, the recursive dispatch frame): `5` built-in steps
/// (`81920`), exclusive of the recursive child cost added on top.
#[doc(hidden)]
pub use ironhorse_meter::JSON_STRINGIFY_ARRAY_ELEMENT_METERING;

/// Entering an **array** node (`fxIsArray` true): `fxStringifyJSONChars("[")`,
/// `mxGetID(_length)`, `fxToInteger`, the empty/`]` close — `11` built-in steps
/// (`180224`), value-independent, paid by every array however deep.
#[doc(hidden)]
pub use ironhorse_meter::JSON_STRINGIFY_ARRAY_ENTER_METERING;

/// A **non-empty** array's one-time `level`/indent setup over the enter cost:
/// one built-in step (`16384`).
#[doc(hidden)]
pub use ironhorse_meter::JSON_STRINGIFY_ARRAY_NONEMPTY_METERING;

/// Entering an **object** node: `fxStringifyJSONChars("{")`, `at =
/// fxNewInstance` (one `fxNewSlot`, `+256`), the `mxBehaviorOwnKeys` base walk,
/// the empty/`}` close — `8` built-in steps plus the instance slot
/// (`131072 + 256 = 131328`).
#[doc(hidden)]
pub use ironhorse_meter::JSON_STRINGIFY_OBJECT_ENTER_METERING;

/// Each surviving object key's per-iteration body (`getOwnProperty`, `mxGetAll`,
/// `fxStringifyJSONName`, the recursive dispatch frame): `4` built-in steps
/// (`65536`), exclusive of the key chunk and the recursive child cost.
#[doc(hidden)]
pub use ironhorse_meter::JSON_STRINGIFY_OBJECT_KEY_BODY_METERING;

/// Each own enumerable key contributes one `XS_AT_KIND` slot to the keys list
/// `mxBehaviorOwnKeys` builds (`fxNewSlot`, `+256`), charged per own key whether
/// or not it survives the `getOwnProperty`/`DONT_ENUM` filter.
#[doc(hidden)]
pub use ironhorse_meter::JSON_STRINGIFY_OBJECT_KEY_SLOT_METERING;

/// A **non-empty** object's one-time `level`/indent + `mxPushUndefined`/
/// `mxPushReference` setup over the enter cost — `65528`. (Not a clean step
/// multiple: the `mxBehaviorGetOwnProperty` probe of the reference's first
/// internal slot shaves 8 raw units off the fourth step; measured against the
/// pin.)
#[doc(hidden)]
pub use ironhorse_meter::JSON_STRINGIFY_OBJECT_NONEMPTY_METERING;

/// A top-level reference pays no residual over the recursive child cost beyond
/// the setup: the wrapper's holder fetch and the enter costs fully account for
/// it. Measured against the pin — the enter constants below are anchored at the
/// value the top-level node actually charges, so no top-only term is added.
#[doc(hidden)]
pub use ironhorse_meter::JSON_STRINGIFY_TOP_REFERENCE_METERING;

// `JSON.parse` (`fx_JSON_parse` → `fxParseJSON`/`fxParseJSONValue`/
// `fxParseJSONArray`/`fxParseJSONObject`) metering, decomposed against the pin
// `48ee02d8cfe0` and reconciled bit-exact against the oracle. The parse path
// calls **no** `mxMeter` (like `xsMapSet.c`), so every unit is the native
// frame residual plus the exact `fxNewSlot`/`fxNewChunk` allocations. Each
// constant below reconciles across empty/flat/nested arrays and objects (see
// the README § the JSON stage), not a fitted total.
//
/// Each array element's `fxParseJSONValue` + `fxParseJSONToken` + the appended
/// linked property `fxNewSlot`: a fixed `33024` raw, exclusive of the element's
/// own recursive node cost and of the one-time `fxCacheArray` item chunk.
#[doc(hidden)]
pub use ironhorse_meter::JSON_PARSE_ARRAY_ELEMENT_METERING;

/// Entering an **array** value: `fxNewArrayInstance` (the instance slot + the
/// array's internal length slot) — two `fxNewSlot`s (`512`), before any
/// element or the item cache.
#[doc(hidden)]
pub use ironhorse_meter::JSON_PARSE_ARRAY_INSTANCE_METERING;

/// Entering an **object** value: `fxNewObjectInstance` — one `fxNewSlot`
/// (`256`), before any key.
#[doc(hidden)]
pub use ironhorse_meter::JSON_PARSE_OBJECT_INSTANCE_METERING;

/// Each object member's fixed body — the value `fxParseJSONValue`/token walk
/// plus the member's property `fxNewSlot` (`65792 = (4<<14) + 256`), exclusive
/// of the key-name interning slot (a novel name adds one `fxNewSlot` via
/// [`Interp::intern_key`]), the key-string tokenizer chunk (`rup8(len+1)+16`),
/// and the value's own recursive node cost.
#[doc(hidden)]
pub use ironhorse_meter::JSON_PARSE_OBJECT_KEY_METERING;

/// The `fx_JSON_parse` native frame residual + tokenizer setup + the primitive
/// `fxParseJSONValue` push, **over** the call trampoline the interpreter already
/// meters on dispatch — a fixed `49152` (`3 << 14`) raw, value-independent,
/// charged once. A produced string additionally allocates its tokenizer chunk
/// (`fxNewChunk(size+1)`), a number/boolean/null nothing.
#[doc(hidden)]
pub use ironhorse_meter::JSON_PARSE_SETUP_METERING;

/// The raw 16.16 native-host-frame cost of a `String.prototype` method call,
/// beyond the modeled `mxMeterSome` steps and the result chunk. Like the
/// `Math.*` frame it calibrates against the pin `48ee02d8cfe0` to zero over
/// the `RUN` opcode ironhorse already meters — the `xsString.c` bodies charge
/// only their explicit `mxMeterSome` and `fxNewChunk`, which ironhorse models
/// directly.
#[doc(hidden)]
pub use ironhorse_meter::STRING_METHOD_FRAME_METERING;

/// The measured native residual carried by every `String.prototype` method
/// whose body calls `mxMeterSome` (`startsWith`/`endsWith`/`includes`/`concat`/
/// `toLowerCase`/`toUpperCase`/`repeat`/`trim`/`trimStart`/`trimEnd`): a fixed
/// `33280` raw 16.16 units (`2 << 14` + `2 << 8`) beyond the explicit
/// `mxMeterSome` steps and the result chunk, independent of the string
/// lengths. The chunk-only / number-returning methods that call **no**
/// `mxMeterSome` (`slice`/`substring`/`charAt`/`at`/`charCodeAt`/`codePointAt`/
/// `str[i]`) carry **zero** residual. Calibrated against the pin
/// `48ee02d8cfe0` (raw-exact, so the `>> 16` computron count never drifts by a
/// sub-computron rounding).
#[doc(hidden)]
pub use ironhorse_meter::STRING_METERSOME_FRAME_METERING;

/// The fixed residual of `String.prototype.indexOf`/`lastIndexOf` beyond their
/// matching-prefix scan ticks. The pinned XS passes an unparenthesized ternary
/// to `mxMeterSome`; macro expansion and C precedence therefore add one *raw*
/// tick per matching CESU-8 leading byte rather than one built-in unit. The
/// fixed residual itself matches the other `mxMeterSome` string methods.
#[doc(hidden)]
pub use ironhorse_meter::STRING_INDEX_FRAME_METERING;

/// The native residual of the `Map`/`Set` `size` accessor getter
/// (`fx_Map_prototype_size`) beyond the `GET_PROPERTY` dispatch. Calibrated
/// against the pin.
#[doc(hidden)]
pub use ironhorse_meter::COLLECTION_SIZE_GET_METERING;

/// The per-linked-slot residual an inserting `fxSetEntry`/`fxSetWeakEntry`
/// charges over each new entry slot BEYOND the first (measured `1 << 15` raw
/// units per slot). A `Map.set`/`WeakMap.set`/`WeakSet.add` new entry (three
/// slots) charges `2×`; a `Set.add` new entry (two slots) charges `1×`. Query
/// methods (`get`/`has`) and an in-place update allocate nothing and carry no
/// residual. Calibrated against the pin `48ee02d8cfe0`.
#[doc(hidden)]
pub use ironhorse_meter::COLLECTION_SLOT_LINK_METERING;

/// The native residual of `new Map()` / `new Set()` (`fx_Map`/`fx_Set` with no
/// iterable argument) BEYOND the `RUN` dispatch and the explicit
/// allocation ticks the construct path charges (four `fxNewSlot`s — instance,
/// table, list, size — plus the initial `fxNewChunk(mxTableMinLength * 8)`
/// address array). Covers the native host frame and
/// `fxGetPrototypeFromConstructor`. Calibrated raw-exact against the pin
/// `48ee02d8cfe0`.
#[doc(hidden)]
pub use ironhorse_meter::MAP_CTOR_FRAME_METERING;

/// The native residual of `new WeakMap()` / `new WeakSet()` beyond the two
/// `fxNewSlot`s (`fxNewWeakMapInstance`: instance + weak list; no table, no
/// chunk). Calibrated raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::WEAK_CTOR_FRAME_METERING;

/// The native residual of a BigInt **arithmetic** op (`+`/`-`/`*`) beyond the
/// `RUN` dispatch, the `mxBigInt_meter((result_size - 1) * XS_BIGINT_METERING)`
/// digit step, and the result digit-chunk allocation. XS's binary path
/// (`fxToNumericNumberBinary` → `gxTypeBigInt._add/_sub/_mul`) coerces both
/// operands (each already a BigInt in a well-typed program — mixed BigInt/Number
/// arithmetic is a TypeError) through `fxToNumericNumber` and frames the op:
/// measured `1 << 14` raw-exact against the pin `48ee02d8cfe0`.
#[doc(hidden)]
pub use ironhorse_meter::BIGINT_ARITH_FRAME_METERING;

/// The native residual of a BigInt **literal** (`XS_CODE_BIGINT_1/2` →
/// `fxNewBigInt`) beyond the `RUN` dispatch and the digit-chunk allocation
/// (`fxNewChunk(size * 4)`, charged in [`Interp::make_bigint`]): one builtin
/// step (`fxNewBigInt`'s residual). Calibrated raw-exact against the pin
/// `48ee02d8cfe0`.
#[doc(hidden)]
pub use ironhorse_meter::BIGINT_LITERAL_METERING;

/// The native residual of a BigInt **unary minus** (`XS_CODE_MINUS` →
/// `fxToNumericNumberUnary` → `gxTypeBigInt._neg`) beyond the `RUN` dispatch and
/// the negated-copy digit chunk (`fxBigInt_neg` → `fxBigInt_alloc`, charged in
/// [`Interp::make_bigint`]). Measured `1 << 14` raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::BIGINT_NEG_FRAME_METERING;

/// The native host-frame residual of `Map.prototype.clear` /
/// `Set.prototype.clear` (`fxClearEntries`) BEYOND its dispatch and the
/// `fxResizeEntries` shrink chunk (modeled separately): the frame,
/// `fxCheckMap/SetInstance`, the entry tombstone walk, and `fxPurgeEntries`.
/// Calibrated computron-exact against the pin `48ee02d8cfe0`.
#[doc(hidden)]
pub use ironhorse_meter::COLLECTION_CLEAR_FRAME_METERING;

/// The per-entry residual `forEach` charges for one live entry BEYOND the
/// callback body the nested dispatch meters: the `mxPushSlot`s, `mxCall`, and
/// `mxRunCount(3)` frame the C loop builds around each call (`2 << 16`).
/// Calibrated raw-exact against the pin (identical for Map and Set).
#[doc(hidden)]
pub use ironhorse_meter::COLLECTION_FOREACH_PER_ENTRY_METERING;

/// The raw 16.16 cost of building a Map/Set Iterator
/// (`fxNewMapIteratorInstance`/`fxNewSetIteratorInstance` → the shared
/// `fxNewIteratorInstance`): the two host objects (iterator instance + reused
/// `{value, done}` result), the result's `value`/`done` properties, the three
/// internal iterator slots (id/iterable/index), the list slot, and the kind
/// integer slot. Calibrated computron-exact against the pin `48ee02d8cfe0`.
#[doc(hidden)]
pub use ironhorse_meter::COLLECTION_ITERATOR_CREATE_METERING;

/// The per-yield residual an ENTRIES-kind `%MapIteratorPrototype%.next()` /
/// `%SetIteratorPrototype%.next()` charges to build its `[k, v]` pair
/// (`fxConstructArrayEntry` → `fxNewArrayInstance`) BEYOND the two-element
/// pair chunk (modeled explicitly). A keys/values `next` allocates nothing and
/// carries no residual (its base host-frame cost is folded into the dispatch,
/// measured zero against the pin). Calibrated computron-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::COLLECTION_ITERATOR_ENTRY_METERING;

/// The native host-frame residual of `Map.prototype.forEach`
/// (`fx_Map_prototype_forEach`) BEYOND its dispatch and the per-entry callback
/// machinery: the frame, `fxCheckMapInstance`, `fxArgToCallback`, and the
/// `mxPushList` setup/teardown. Calibrated raw-exact against the pin
/// `48ee02d8cfe0`. The Set form ([`SET_FOREACH_FRAME_METERING`]) is 8 raw
/// units less (Map walks a key→value slot pair per entry; Set a single slot).
#[doc(hidden)]
pub use ironhorse_meter::MAP_FOREACH_FRAME_METERING;

/// Wrong-brand rejection residuals for the shared Map/Set prototype methods.
/// These paths fail before the successful-method frames below, but XS still
/// charges the declaring builtin's receiver-validation work.
#[doc(hidden)]
pub use ironhorse_meter::MAP_METHOD_ON_SET_METERING;

/// The native host-frame residual of `Set.prototype.forEach`
/// (`fx_Set_prototype_forEach`). See [`MAP_FOREACH_FRAME_METERING`].
#[doc(hidden)]
pub use ironhorse_meter::SET_FOREACH_FRAME_METERING;

#[doc(hidden)]
pub use ironhorse_meter::SET_METHOD_ON_MAP_METERING;

// ---- Promise metering (xsPromise.c; the pump-loop latch) -------------
//
// xsPromise.c calls `mxMeter` exactly once in the whole file (the
// unhandled-rejection list walk), so — like xsMapSet.c and the JSON parse
// path — promise metering is almost entirely allocation-driven: the
// `fxNewSlot`/`fxNewInstance`/`fxNewChunk`/`fxNewHostFunction` clusters plus
// the native host frames of each entry point, over the `RUN` dispatch the
// interpreter already meters and the re-entrant reaction/executor bodies the
// nested dispatch meters. Each constant below is the native residual of one
// entry point BEYOND the explicit allocation ticks its handler charges,
// calibrated raw-exact against the pin `48ee02d8cfe0`.

/// The native residual of `fxNewPromiseCapability` BEYOND the derived promise
/// instance + resolving pair (charged by [`Interp::new_promise_instance`] /
/// [`Interp::make_resolving_functions`]): the capability-callback
/// `fxNewHostFunction` (5 slots), the callback body's home object
/// (`fxNewInstance` + 2 slots), the folded `fx_Promise` frame
/// ([`PROMISE_CTOR_FRAME_METERING`]), and the `mxNew`/`mxRunCount(1)`
/// executor framing. Calibrated raw-exact against the pin. Set to the folded
/// `fx_Promise` construct frame ([`PROMISE_CTOR_FRAME_METERING`]); the
/// `fxNewPromiseCapability` `mxNew`/`mxRunCount(1)` framing folds into each
/// caller's own frame constant (every capability caller invokes it the same
/// way).
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_CAPABILITY_METERING;

/// The native residual of `Promise.prototype.catch` (`fx_Promise_prototype_
/// catch`) BEYOND the `then` it delegates to: the frame, `mxGetID(_then)`, and
/// the `mxRunCount(2)` re-dispatch into `then`. Calibrated raw-exact against
/// the pin (`147456` = 2.25 `XS_CODE_METERING`).
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_CATCH_FRAME_METERING;

/// The native frame residual of a `Promise.all`/`allSettled`/`race`/`any`
/// call BEYOND the derived capability ([`PROMISE_CAPABILITY_METERING`]) and
/// the per-element work: the frame, `fxGetIterator`, and the
/// `remainingElementsCount` cell setup. **Advisory** (see
/// [`PROMISE_FINALLY_FRAME_METERING`]).
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_COMBINATOR_FRAME_METERING;

/// The per-element native residual of a combinator's iteration step (XS's
/// `C.resolve(element)` species probe + the element-resolve function alloc +
/// the `mxRunCount` `.then` re-dispatch), BEYOND the element promise's own
/// `Promise.resolve`/reaction costs the shared helpers already charge.
/// **Advisory** (see [`PROMISE_FINALLY_FRAME_METERING`]).
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_COMBINATOR_PER_ELEMENT_METERING;

/// The native residual of `new Promise(executor)` (`fx_Promise`) BEYOND the
/// `RUN` dispatch, the explicit six `fxNewPromiseInstance` `fxNewSlot`s, the
/// [`PROMISE_FUNCTIONS_METERING`] resolving-pair cluster, and the executor
/// body the re-entrant `run_callback` meters. Covers the native host frame,
/// `fxGetPrototypeFromConstructor`, and the `mxRunCount(2)` executor-call
/// framing. Calibrated raw-exact against the pin (`new Promise(function(r){})`
/// = 6 instance slots + 13 resolving-pair slots + this frame + the empty
/// executor body = 32 computrons).
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_CTOR_FRAME_METERING;

/// The native frame residual of `fx_Promise_prototype_finally` BEYOND the
/// derived capability ([`PROMISE_CAPABILITY_METERING`]) and the native
/// reaction registration ([`Interp::promise_then_native`]): the frame, the
/// `mxGetID(_then)`, and the `thenFinally`/`catchFinally` closure framing XS
/// builds. **Advisory** under the accuracy-over-parity doctrine (ironhorse's own
/// frozen cost table; result agreement is the gate, computrons advisory), set
/// in the `catch`/`then` frame family.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_FINALLY_FRAME_METERING;

/// The non-slot residual of `fxPushPromiseFunctions` beyond the 13 explicit
/// `fxNewSlot`s [`Interp::make_resolving_functions`] charges (the two
/// `fxNewHostFunction`s — each instance + CALLBACK + HOME + LENGTH + NAME,
/// the empty name interned so no chunk — plus the shared home object's
/// instance + boolean guard slot + promise-reference slot). Measured zero:
/// the pair allocates no chunk and `xsPromise.c`/`fxNewHostFunction` call no
/// `mxMeter` here. Calibrated raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_FUNCTIONS_METERING;

// `PROMISE_HANDLER_THROW_METERING` (the near-zero native residual of a
// throwing promise reaction handler) is not re-exported here: it is a
// documented `ironhorse_meter` constant, reachable as
// `ironhorse_vm::cost_table::PROMISE_HANDLER_THROW_METERING`.

/// The native frame residual of running one queued job at the drain
/// (`fxRunPromiseJobs`'s `mxRunCount` + the `fxOnResolvedPromise`/
/// `fxOnRejectedPromise` trampoline) BEYOND the reaction handler body the
/// nested `run_callback` meters, the derived promise's settle
/// ([`PROMISE_RESOLVE_FN_METERING`]), and the 6 queued-job slots. Calibrated
/// raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_JOB_FRAME_METERING;

/// The native frame residual of a **pass-through** job — a reaction with no
/// handler for the settled state, which XS's `fxOnResolvedPromise`/
/// `fxOnRejectedPromise` runs with a single `mxRunCount` (the settle only, no
/// handler call). `98304` (1.5 `XS_CODE_METERING`) less than the with-handler
/// frame. Calibrated raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_JOB_PASSTHROUGH_FRAME_METERING;

/// The residual of queuing one promise job (`fxQueueJob`): the job instance +
/// the `count + 4` captured argument slots. Charged when a settled promise's
/// reaction is queued (at `.then` on a settled promise, or at settle time for
/// each registered reaction). The 6 `fxQueueJob` slots are charged explicitly
/// in [`Interp::queue_promise_job`]; this is any non-slot residual (measured
/// zero). Calibrated raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_QUEUE_JOB_METERING;

/// The non-slot residual of `fxPromiseThen`'s reaction instance beyond the 6
/// reaction `fxNewSlot`s (and, when pending, the THENS-list slot) charged
/// explicitly in [`Interp::promise_then`]. Measured zero. Calibrated against
/// the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_REACTION_METERING;

/// The native frame residual of a **reject** function call
/// (`fxRejectPromise`). `fxRejectPromise` is a shorter body than
/// `fxResolvePromise` (no `mxTry`/thenable probe) yet meters a little more of
/// its own frame. Calibrated raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_REJECT_FN_METERING;

/// The native residual of `Promise.reject(reason)` (`fx_Promise_reject`).
/// Calibrated raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_REJECT_STATIC_METERING;

/// The native frame residual of a **resolve** function call
/// (`fxResolvePromise`) BEYOND the `RUN` dispatch, when it settles a promise
/// with a primitive value and no thenable/reactions (the path allocates
/// nothing). Calibrated raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_RESOLVE_FN_METERING;

/// The native residual of `Promise.resolve(v)` when `v` is already a native
/// promise — the identity fast path returns `v` (`fx_Promise_resolve`'s
/// `mxGetID(_constructor)` probe + the `fxIsSameValue(constructor, Promise)`
/// species check that precedes the identity return). Calibrated raw-exact
/// against the pin: `2.5 * XS_CODE_METERING`.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_RESOLVE_SAME_METERING;

/// The native residual of `Promise.resolve(v)` (`fx_Promise_resolve` →
/// `fx_Promise_resolveAux`) BEYOND the capability ([`PROMISE_CAPABILITY_
/// METERING`] + its slots) and the `mxRunCount(1)` resolve settle
/// ([`PROMISE_RESOLVE_FN_METERING`]): the two frames plus the folded
/// `fxNewPromiseCapability` framing. Calibrated raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_RESOLVE_STATIC_METERING;

/// The native residual of a **resolve** function call (`fxResolvePromise`) that
/// takes the **thenable-adoption** branch — the argument is a reference with a
/// callable `.then`, so instead of finalizing the promise XS queues a
/// `PromiseResolveThenableJob`. Charged BEYOND the [`PROMISE_RESOLVE_FN_METERING`]
/// base frame, the second resolving pair's 13 `fxNewSlot`s
/// ([`Interp::make_resolving_functions`]), and the count-3 job's slots
/// ([`Interp::queue_promise_job_n`]): the `mxGetID(_then)` probe, the
/// `fxIsCallable` check, and the `mxCall`/`fxQueueJob(3)` framing. Calibrated
/// raw-exact against the pin (over the [`PROMISE_RESOLVE_THEN_PROBE_METERING`]
/// probe common to every reference resolve).
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_RESOLVE_THENABLE_METERING;

/// The native residual of the `mxGetID(_then)` probe a resolve function runs on
/// ANY reference argument (`fxResolvePromise`, `if (mxIsReference(argument))`):
/// one bytecode-dispatch-equivalent (`1 << 16`), the property get for `.then`
/// (a proto-chain walk metered as one dispatch regardless of depth), charged
/// before branching on whether `.then` is callable. Calibrated raw-exact
/// against the pin (a non-thenable-object resolve over-shot the primitive path
/// by exactly this).
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_RESOLVE_THEN_PROBE_METERING;

/// The native residual of the `[[AlreadyResolved]]`-guarded early return of a
/// resolve/reject function (XS returns right after the boolean check).
/// Measured zero against the pin (a second `resolve`/`reject` adds nothing).
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_SETTLE_GUARDED_METERING;

/// The native frame residual of running one **thenable job** at the drain
/// (`fxOnThenable`): the `mxRunCount(2)` framing that invokes
/// `then.call(thenable, resolve, reject)` BEYOND the `then` body the nested
/// `run_callback` meters (and the resolve/reject calls that body makes, each
/// metered by [`Interp::call_promise_function`]). Calibrated raw-exact against
/// the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_THENABLE_JOB_FRAME_METERING;

/// The native residual of `fx_Promise_prototype_then` BEYOND the capability
/// ([`PROMISE_CAPABILITY_METERING`]) and the reaction registration
/// ([`PROMISE_REACTION_METERING`]): the frame, `mxGetID(_constructor)`, and
/// `fxToSpeciesConstructor`, plus the folded `fxNewPromiseCapability` framing.
/// Calibrated raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::PROMISE_THEN_METERING;

/// The native residual of `new RegExp(pattern, flags)` (`fx_RegExp` +
/// `fxInitializeRegExp`) BEYOND the explicit `fxNewRegExpInstance` `fxNewSlot`s
/// and the `fxCompileRegExp` compile meter the [`RegExpData`] program carries.
/// Covers the `fx_RegExp` host frame, `fxGetPrototypeFromConstructor`, and the
/// `mxRunCount(2)` `mxInitializeRegExpFunction` call framing. Calibrated
/// raw-exact against the pin.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_CTOR_FRAME_METERING;

/// The native residual of `RegExp.prototype.exec` (`fx_RegExp_prototype_exec`)
/// BEYOND the match meter the matcher carries, the result-array `fxNewSlot`s,
/// and the result-string chunk allocations. Covers the host frame, the
/// `lastIndex` get, and `fxToString(argument)`. Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_EXEC_FRAME_METERING;

/// The on-match residual of `exec` beyond the frame and the explicit
/// per-capture slot/chunk allocations (the `fxCacheUTF8ToUnicodeOffset`
/// remaps + `fxCacheArray`). Calibrated.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_EXEC_MATCH_METERING;

/// The per-extra-capture residual of `exec` on a match. Calibrated.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_EXEC_PER_CAPTURE;

/// The residual of the composite `flags` getter (`fx_RegExp_prototype_get_
/// flags`), which reads all eight per-flag properties back through
/// `mxGetID` + their accessors and assembles the string. Calibrated raw-exact
/// (constant — the same eight gets regardless of which flags are set).
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_FLAGS_GETTER_METERING;

/// The residual of a RegExp per-flag / `source` accessor getter beyond the
/// `GET_PROPERTY` dispatch (the getter's `mxMeterOne`, if any). Measured as
/// zero against the pin (each reads `code[0]` / the source key with no
/// built-in step beyond dispatch).
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_GETTER_METERING;

/// The native residual of `%RegExp.prototype%[@@match]` beyond its observable
/// `flags` getter and the `RegExpExec` cost it drives. Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_MATCH_FRAME_METERING;

/// The base native residual of `%RegExp.prototype%[@@search]` beyond the
/// `RegExpExec` cost it drives: the host frame and `lastIndex`
/// save/reset/restore work. Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_SEARCH_FRAME_METERING;

/// The extra residual of `@@search` on a match: the result's `index` property
/// read, skipped on the `-1` no-match path. Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_SEARCH_INDEX_GET_METERING;

/// XS's `e == p` empty-match advance omits six `mxMeterOne` operations that
/// the ordinary successful-step residual includes. Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_SPLIT_EMPTY_ADVANCE_DISCOUNT;

/// The empty-subject path's single-exec residual, beyond the fixed worker
/// frame. Calibrated raw-exact against the pinned XS profile.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_SPLIT_EMPTY_METERING;

/// The fixed native residual of `%RegExp.prototype%[@@split]` beyond the
/// observable `SpeciesConstructor`, `flags`, sticky construction, and result
/// array work performed through the ordinary object MOP below. Calibrated
/// raw-exact against the pinned XS profile.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_SPLIT_FRAME_METERING;

/// The extra native residual of a successful split step, including the
/// observable `lastIndex` read and the `e == p` branch. Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_SPLIT_MATCH_STEP_METERING;

/// The native residual for each captured value inserted into a split result,
/// beyond its observable property read and result write. Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_SPLIT_PER_CAPTURE_METERING;

/// The per-position native loop residual of `%RegExp.prototype%[@@split]`,
/// beyond the observable `lastIndex` write and abstract `RegExpExec` call.
/// Calibrated raw-exact against the pinned XS profile.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_SPLIT_PER_STEP_METERING;

/// The extra residual of a `g`/`y` (stateful) `exec`/`test`: the
/// `fxCacheUnicodeToUTF8Offset` (read `lastIndex`) + `fxCacheUTF8ToUnicode
/// Offset` (write it back) remap framing. Charged on the advancing path.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_STATEFUL_METERING;

/// The native residual of `RegExp.prototype.test` beyond the `exec` cost it
/// drives (the `test` host frame + the `mxGetID(_exec)` + `mxRunCount(1)`
/// re-entrant call framing). Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_TEST_FRAME_METERING;

/// The residual of `RegExp.prototype.toString` (`fx_RegExp_prototype_
/// toString`), which reads `source` + `flags` back through `mxGetID` and their
/// accessors (the `flags` get itself the eight-property cascade) and builds
/// the `/source/flags` string. This is the `toString` host frame only; the
/// `flags`-getter cascade and the three growing concat chunks are charged
/// explicitly. Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::REGEXP_TOSTRING_METERING;

/// The shared native residual of `String.prototype.match` and `.search`
/// around their symbol-protocol calls: the String host frame plus the
/// `withRegexp` lookup/call framing. Calibrated raw-exact against direct
/// custom-protocol calls on the pin.
#[doc(hidden)]
pub use ironhorse_meter::STRING_REGEXP_PROTOCOL_FRAME_METERING;

/// The native residual of `String.prototype.replace` (`fx_String_prototype_
/// replace` → `fx_RegExp_prototype_replace` via the `Symbol.replace` protocol)
/// BEYOND the `exec` cost, the explicit `flags` cascade, the segment-list
/// `fxNewSlot`s + `split_aux`/substitution chunks, and the final assembly
/// chunk: the String host frame, the `withRegexp` dispatch, and the worker's
/// per-match `index`/`0`/`length` gets. Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::STRING_REPLACE_FRAME_METERING;

/// The extra residual of `replace` on a match: the per-match `mxGetID(_index)`
/// + `mxGetIndex(0)` + `mxGetID(_length)` reads (skipped on the no-match
/// unchanged-string path). Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::STRING_REPLACE_MATCH_METERING;

/// The per-capture-group residual of `replace` on a match: the `for (i=1;
/// i<c; i++)` capture-push loop (`mxGetIndex(i)` + `fxToString`) feeding the
/// substitution, one per capture beyond the whole match. Calibrated raw-exact.
#[doc(hidden)]
pub use ironhorse_meter::STRING_REPLACE_PER_CAPTURE;

/// The native residual of `String.prototype.split`'s successful `@@split`
/// protocol dispatch, beyond the observable method lookup and invocation.
/// Calibrated raw-exact against the pinned XS profile.
#[doc(hidden)]
pub use ironhorse_meter::STRING_SPLIT_PROTOCOL_FRAME_METERING;

/// `XS_PARSE_REGEXP_METERING` (`xsCommon.h`, `1 << 10`): the raw-per-byte
/// compile meter. Also the divisor recovering the code-buffer byte size
/// (`parser->size`) from a program's `compile_meter_raw`.
#[doc(hidden)]
pub use ironhorse_meter::XS_PARSE_REGEXP_METERING;
