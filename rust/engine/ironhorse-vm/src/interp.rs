//! Machine state and execution entry points for the bytecode interpreter.
//!
//! `interp/state.rs` declares each interpreter field together with its boot,
//! GC, boundary and persistence policies. The generated walks share those
//! declarations; their source locks and runtime tests check the resulting
//! coverage. `interp/dispatch.rs` owns the opcode loop and its control-transfer
//! macros. `interp/natives/regexp.rs` owns regexp execution and its string protocols.
//!
//! Semantics follow the XS bytecode instruction set: integer fast paths promote
//! checked overflow to `f64`, arithmetic preserves negative zero, comparisons
//! account for NaN, and scope slots use `mxEnvironment - index` addressing.
//! There is no JIT or execution-count-dependent specialization; opcode dispatch
//! is a Rust `match`.
//!
//! **Frozen Ironhorse metering.** Weights are XS-derived historical estimates.
//! Oracle computrons are advisory; local release golden values are the gate.
//! Charges accrue in raw 16.16 units through the carry into computrons.
//! Dispatch, invocation, allocation and builtin-work charges use the shared
//! meter definitions. `golden_computrons.rs` pins guest execution receipts;
//! snapshot tests check that restoring a machine preserves its meter state.

#[macro_use]
mod state;

mod dispatch;

mod link;
mod native_try;
mod natives;
mod persist;
mod property;
use native_try::CallerHandlers;

mod suspend;
use suspend::Suspension;

mod temporal;
use temporal::{
    balance_zoned_diff, civil_from_days, days_from_civil, duration_from_nanoseconds,
    format_offset_string, format_temporal_duration, format_temporal_instant, format_temporal_plain,
    format_zoned, iso_date, iso_date_add, iso_date_until, iso_datetime_difference,
    iso_duration_span_nanoseconds, iso_total_calendar_units, iso_week_of_year,
    local_datetime_to_epoch, parse_offset_ns, parse_temporal_duration, parse_temporal_instant,
    parse_temporal_plain, parse_temporal_zoned, resolve_time_zone, resolve_zoned_time_zone,
    round_half_expand, round_number_to_increment, round_temporal, temporal_brand,
    temporal_duration_default_largest_rank, temporal_duration_sign_valid, temporal_plain_add,
    temporal_plain_difference, temporal_plain_key, temporal_plain_valid, temporal_unit_name,
    temporal_unit_nanoseconds, temporal_unit_rank, validate_duration_increment,
    zoned_local_datetime, TemporalDurationRecord, TemporalInstantRecord, TemporalPlainRecord,
    TemporalZonedRecord, TEMPORAL_PLAIN_NAMES,
};

mod date;
use date::{
    civil_fields, date_from_components, date_from_components_exact, date_iso_string,
    date_local_string, date_only_string, date_time_string, date_utc_string, parse_date_string,
    time_clip, EN_MONTHS_LONG, EN_MONTHS_NARROW, EN_MONTHS_SHORT, EN_WEEKDAYS_LONG,
    EN_WEEKDAYS_NARROW, EN_WEEKDAYS_SHORT,
};

mod locale;
use locale::{
    canonicalize_locale, collator_compare, currency_digits, format_date_time_parts,
    format_date_time_range_parts, is_well_formed_currency_code, is_well_formed_unit_identifier,
    list_format_parts, locale_base_name, locale_is_supported, locale_to_tag, maximize_locale,
    minimize_locale, plural_categories, plural_select, segment_units, supported_locale,
    titlecase_ascii, valid_language, valid_region, valid_script, valid_unicode_type,
};

mod text;
use text::{
    be16_to_units, cesu8_to_units, is_ecma_whitespace, str_to_be16, trim_ecma_whitespace,
    unicode_case_convert_utf16, unicode_locale_case_convert_utf16, unicode_normalize_utf16,
    units_to_be16, UnicodeNormalizationForm,
};

mod numeric;
pub use numeric::slot_to_ecma_string;
use numeric::{
    apply_arith, canonical_numeric_index_string, element_slot_to_i64, fx_pow, loose_equals,
    math_to_integer, number_to_radix_string, numeric_of, parse_int, strict_equals,
    string_to_array_like_index, string_to_index, string_to_number, to_number, unary_minus, ArithOp,
};

mod bigint;
use bigint::{
    bi_add, bi_add_mag, bi_add_one_in_place, bi_bit_length, bi_cmp, bi_div_rem_mag,
    bi_from_twos_complement, bi_is_zero, bi_mask_width, bi_mul, bi_mul_mag, bi_shl_bits,
    bi_shr_mag, bi_sub_mag, bi_to_decimal, bi_to_twos_complement, bi_trim, bi_usize_up_to,
    number_to_bigint, parse_bigint_string, parse_bigint_string_u64, u64_to_signed_limbs,
};

#[doc(hidden)]
pub use state::SIDE_TABLES;
#[doc(hidden)]
#[macro_use]
pub mod gc_tables;
#[doc(hidden)]
pub mod boundary;
mod gc;
#[doc(hidden)]
pub mod persistence;
#[doc(hidden)]
pub mod roots;

use ironhorse_meter::{
    ARRAY_FIND_VALUE_METERING, ARRAY_ITEM_BYTES, CHUNK_ALIGNMENT, CHUNK_ALLOCATION_METERING,
    CHUNK_HEADER_BYTES, MAP_FIRST_GROW_METERING,
};

use ironhorse_meter::{string_chunk_cost, PROXY_INTERNAL_METHOD_METERING};

use crate::bulk::{ArrayData, CollKey, CollKind, CollectionData, SideRefCounts};
use crate::classification::{ClassIndex, ClassMap, ExoticKind};
use crate::meter::{Meter, MeterCheck};
use crate::opcode::Opcode;
use crate::snapshot_dirty::{SnapshotSection, Tracked};
use crate::symbols::{SymbolIds, SymbolName};
use crate::value::{
    canonicalize_nan, number_to_ecma_string, to_int32, ChunkArena, Kind, Payload, Slot, SlotArena,
};

/// A program compiled from a runtime source string for same-realm
/// execution: the XS-shaped bytecode plus its `symbols` atom (the
/// program-local id→name table [`crate::parse_symbols`] decodes). This is
/// the exact pair [`crate::run_program_with_symbols`] consumes for a
/// top-level program; the [`Interp`] eval bridge relinks its symbol ids
/// into the host realm's symbol table before running it.
pub struct CompiledSource {
    /// Complete front-end raw 16.16 cost, already charged through the callback.
    pub parse_meter_raw: u64,
    /// Whole front-end computrons, for reporting only.
    pub parse_computrons: u64,
    /// The program bytecode, as the XS compiler emits it.
    pub bytecode: Vec<u8>,
    /// The `symbols` atom (`SYMB` payload): the compiler's program-local
    /// id→name table for this unit.
    pub symbols: Vec<u8>,
}

/// Why a [`SourceCompiler`] declined a source string. The bridge maps these
/// to observable outcomes: a [`SourceCompileError::Syntax`] is a realm-local,
/// catchable `SyntaxError` (as the spec's `eval`/`Function` early-error path
/// throws); a [`SourceCompileError::Unsupported`] is an honest Ironhorse
/// compiler-coverage gap (an unported-but-valid construct), surfaced as
/// [`Halt::NotImplemented`] rather than a mis-executed result.
pub enum SourceCompileError {
    /// Host refused compilation work. This stop cannot be caught by guest JS.
    MeterAbort,
    /// A genuine early (parse/early) error: the source is not a valid
    /// Script. The bridge throws a catchable realm `SyntaxError`.
    Syntax(String),
    /// The compiler reached a deferred/unported path (a valid construct it
    /// does not yet compile, or a coder panic). An honest coverage gap.
    Unsupported(String),
    /// Regexp compilation exceeded its storage profile.
    HeapExhausted,
}

/// The compiler seam the runtime source-execution bridge drives (design
/// `designs/ironhorse-engine.md` § roadmap — the compiler/VM boundary).
///
/// `eval` of a string and the `Function` constructor need to turn a source
/// string into bytecode *in the running realm*. Rather than couple
/// [`Interp`] to a concrete front end (which would make the VM depend on
/// `ironhorse-compile` and invert the layering), the host installs a
/// compiler through this trait ([`Interp::set_source_compiler`]). The VM
/// owns linkage, nested invocation, realm identity, metering, and lifetime;
/// the compiler owns only source → bytecode. This is the principled
/// replacement for the former `eval:string-source` source-text boundary.
pub trait SourceCompiler {
    /// Compile `source` as an **Eval** goal for same-realm execution,
    /// returning its bytecode and `symbols` atom. `strict` requests the
    /// strict-mode Script parse (the `Function` constructor and a strict
    /// caller's direct eval); an indirect eval of ordinary source is sloppy.
    /// The source itself may still opt into strict via a `"use strict"`
    /// prologue, which the compiler honors regardless of this hint.
    /// Regexp literals share the same incremental admission callback as all
    /// other compilation phases, including partial work before syntax errors.
    /// A false callback or exhausted budget returns `MeterAbort`; storage
    /// refusal returns `HeapExhausted`. Neither is a syntax error.
    /// Charge work incrementally through `charge`, including work before an
    /// error or unwind. Stop when it returns false, or before exceeding
    /// `raw_budget`. Successful output must report the sum of callback deltas.
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError>;
}

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
/// [`crate::meter::Meter::untick_code`] on the escaping opcode plus
/// accruing this constant. A *caught* throw needs no adjustment: the
/// `CATCH` resume's `mxBreak` meters the catch target exactly as ironhorse's
/// dispatch does, so caught exceptions are bit-exact without it.
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
pub use ironhorse_meter::RESUMED_HANDLER_THROW_METERING;

/// XS's value stack is a fixed array of `stackCount` slots
/// (`xs-oracle/csrc/xs_shim.c` and the endo `DEFAULT_CREATION`:
/// **4096**), holding the value stack, every call frame's
/// result/function/this/frame slots, its arguments, and its scope in one
/// downward-growing region. XS's geometry is **width, not depth**: a
/// program overflows when the *total* concurrent slot count crosses the
/// bottom, so both deep recursion and a single very wide frame exhaust the
/// same fixed budget. Exhaustion aborts with
/// `XS_JAVASCRIPT_STACK_OVERFLOW_EXIT` (`fxOverflow` → `fxAbort`), an
/// abort to the host rather than a catchable `RangeError`. ironhorse models
/// the same fixed geometry so a stack-exhausting program aborts on both
/// engines instead of ironhorse's unbounded `Vec` completing where XS
/// overflows.
pub const STACK_SLOT_COUNT: usize = 4096;

/// Additional live-slot stop for `run_bounded`. An instruction-count bound
/// alone does not bound the heap retained by a loop. Bounded dispatch checks
/// this ceiling before the next instruction and returns `Halt::StepLimit`.
/// Ordinary runs use the arena and allocation-admission limits instead.
const BOUNDED_RUN_SLOT_CEILING: u32 = 1_000_000;
/// XS reserves a fixed band at the top of the stack for the machine roots
/// (`mxGlobal`/`mxException`/`mxProgram`/… — the `*StackIndex` slots in
/// `xsAll.h`) plus the frame scratch `fxOverflow` guards against; the
/// usable value region is below them. Held as a small reserve so ironhorse's
/// overflow point brackets XS's rather than overrunning it.
pub const STACK_SLOT_RESERVED: usize = 32;
/// The per-call fixed frame footprint XS keeps live on the stack for the
/// duration of a call: the `result`/`function`/`this`/`frame` quartet
/// (XS's `mxFrameResult`/`mxFrameFunction`/`mxFrameThis` at fixed offsets
/// around the frame slot). Arguments and scope slots are counted
/// separately.
pub const FRAME_OVERHEAD_SLOTS: usize = 4;

/// The engine's **native-recursion budget**, in light-frame units (see
/// [`LIGHT_FRAME_COST`] / [`HEAVY_FRAME_COST`]).
///
/// An ordinary bytecode CALL loops within a single `dispatch_at` (it rewrites
/// `pc` and pushes a `CallerState`), so deep JS recursion consumes value-stack
/// slots, not native Rust stack, and is bounded by the [`STACK_SLOT_COUNT`]
/// value-stack budget alone. Everything else the engine does on a guest's
/// behalf recurses on the **host thread's native stack**, whose exhaustion is a
/// `SIGABRT` no `catch_unwind` can contain: a callback (`forEach`/`map`/…), an
/// async body (`START_ASYNC`), a generator or async-generator resume, a native
/// built-in invoking another native (`join` → `toString` → `join` over a
/// self-containing array), a Proxy forwarding an internal method to a Proxy
/// target (or to a Proxy in an object's prototype chain), `JSON.parse` /
/// `JSON.stringify` over nested data (and the reviver's walk over what it
/// installs), `Array.prototype.flat`, and the host-boundary renderer over a
/// nested (or cyclic) completion value. Prototype chains through ordinary
/// and exotic objects are walked in place (XS's `fxGetProperty` loop); only
/// a Proxy in the chain forwards, and only that forwarding is a frame.
///
/// One counter, [`Interp::native_depth`], is charged by every one of those
/// re-entry points and checked against this ceiling; past it the engine halts
/// with [`Halt::StackOverflow`] — the abort-to-host XS raises from
/// `fxCheckCStack`, deterministic across hosts because it is a counter rather
/// than a stack-address margin. The *depth* at which it fires is this
/// engine's, sized to its own frames, not XS's: the oracle's C stack admits
/// far deeper nests (thousands of `JSON.parse` levels, a hundred-odd nested
/// `join`s), so the differential harness classifies this halt against an
/// oracle completion as the non-gating `ironhorse-aborted-limit` skip rather
/// than a divergence. A frame is charged by size class rather than by count,
/// so the budget bounds the *stack bytes* a guest can consume regardless of
/// which families it mixes: the worst case is the heavier corner,
/// [`NATIVE_DEPTH_LIMIT`] / [`HEAVY_FRAME_COST`] nested `dispatch_at` or
/// built-in activations (128 frames; a `forEach` nest costs two per level, so
/// 63 nested callbacks beneath the top-level program's own dispatch — the
/// allowance the 64-deep re-entry ceiling of endojs/endo-but-for-bots#1046
/// gave the nested-`START_ASYNC` fuzz trophy `[193, 193, 37, 253, 45, 93]`;
/// a nested `join` costs the same two), or [`NATIVE_DEPTH_LIMIT`] light
/// frames (about 2,000 nested proxies or JSON levels beneath that dispatch).
/// The two corners cost about the same host stack — 13 MiB and 11 MiB
/// unoptimized, 1.2 MiB and 2.5 MiB optimized — which is what the weights are
/// chosen to make true.
///
/// The bound is only a bound relative to a thread stack that can hold the
/// budget: [`crate::NATIVE_STACK_BYTES`] states the size the engine requires,
/// per build profile, and `tests/native_recursion_budget.rs` pins each family
/// at the ceiling on a thread of exactly that size.
pub const NATIVE_DEPTH_LIMIT: usize = 2048;

/// Budget units charged by a **heavy** native frame: a `dispatch_at`
/// re-entry, or a `call_native` / `call_native_method` activation. Both are
/// the monolithic match-dispatch functions of this crate, whose activations
/// measure about 100 KiB unoptimized (a nested `join` level, two of them plus
/// the built-ins between, is 200 KiB; a nested `forEach` level 150 KiB) and
/// about 10 KiB optimized — more than an order of magnitude above any other
/// frame the engine recurses through.
pub const HEAVY_FRAME_COST: usize = 16;

/// Budget units charged by a **light** native frame: a MOP internal method
/// (which forwards once per Proxy layer), a JSON walker level, a `flat`
/// level, a Proxy step of an iterative prototype walk, or a renderer level —
/// 2.5 to 5.5 KiB per level unoptimized (a `JSON.stringify` level is the
/// heaviest), 0.5 to 1.2 KiB optimized.
pub const LIGHT_FRAME_COST: usize = 1;

/// The fixed cost, in computrons, of the top-level program invocation
/// that precedes the captured program bytecode. XS dispatches the
/// program-as-function through its call machinery before the first
/// program opcode; those dispatches are metered but live in the caller
/// frame, not in the bytecode the oracle hands us. It is a constant of
/// the eval harness (identical on both engines), asserted for every
/// corpus entry by the differential harness.
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
pub use ironhorse_meter::GENERATOR_FUNCTION_EXTRA_METERING;
/// `fxNewGeneratorResult`: the `{value, done}` result object a completion
/// (`END`) or an already-completed `.next`/`.return` builds
/// (`fxNewObjectInstance` + two property slots). A *yield*'s result object is
/// built by the body's own `OBJECT`/`NEW_PROPERTY` bytecode (metered by those
/// dispatched opcodes), so it does NOT carry this constant. Calibrated via the
/// second-`next`-on-empty-body gap.
pub use ironhorse_meter::GENERATOR_RESULT_METERING;
/// The per-resume residual of `fx_Generator_prototype_aux` + `fxRunID`
/// re-entry over the `RUN` trampoline the interpreter already meters — exactly
/// one dispatch (`1 << 16`) beyond the body opcodes both engines run.
/// Calibrated identical for a suspended-start and a suspended-yield resume.
pub use ironhorse_meter::GENERATOR_RESUME_METERING;
/// `START_GENERATOR` → `fxNewGeneratorInstance`: the instance slot plus its
/// two internal property slots (the `XS_STACK_KIND` saved-stack holder and the
/// resume-state integer), plus XS's initial saved-activation `fxNewChunk`.
/// Calibrated via the `g()`-minus-`g` gap.
pub use ironhorse_meter::GENERATOR_START_METERING;
/// `YIELD`'s activation save (`fxNewChunk`/`fxRenewChunk` growing the
/// instance's saved-stack chunk to hold the suspended frame). Calibrated on a
/// top-of-body `yield`; XS's chunk scales with the exact suspended activation
/// size, so a `yield` reached with extra live loop/scope temporaries carries a
/// small sub-computron residual over this constant (the `while(true) yield`
/// drift, ~408 raw/resume) — below the computron floor for typical programs, a
/// documented approximation per the accuracy-over-parity doctrine (ironhorse's own
/// deterministic cost, not a back-fit).
pub use ironhorse_meter::GENERATOR_YIELD_METERING;

/// The `mxCall` / `mxRunCount(1)` dispatch XS performs when an async-generator
/// prototype method rejects a bad receiver through its capability's reject
/// function. The settlement helper below models the resolving function body;
/// this is the missing call boundary around it.
use ironhorse_meter::ASYNC_GENERATOR_BRAND_REJECT_CALL_METERING;
/// The extra dispatch XS accrues rejecting an async function whose body
/// throws during the SYNCHRONOUS start (inside the caller's `fxRunID`),
/// beyond what the drain-side reject costs. Measured against the oracle
/// (three shapes: bare start-throw, start-throw under a caller `try`,
/// drain-side throw after an await — the first two run 1<<16 raw hot,
/// the drain shape is exact without it). Charged in `step_async`'s
/// reject arm only when `is_start`.
use ironhorse_meter::ASYNC_START_REJECT_BOUNDARY_METERING;

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
pub use ironhorse_meter::ASYNC_AWAIT_FASTPATH_CREDIT;
/// The `fxStepAsync` general await-branch residual over the fast path: the
/// `mxNewPromiseCapability` framing plus the `mxCall`/`mxRunCount(1)` on the
/// capability's resolve function that adopts the awaited value. Calibrated
/// against `await 1` (a primitive await — one microtask turn).
pub use ironhorse_meter::ASYNC_AWAIT_GENERAL_METERING;
/// The async-function define delta backed out of [`Interp::new_async_function`]:
/// XS's `XS_CODE_ASYNC_FUNCTION` skips the `fxDefaultFunctionPrototype`
/// `.prototype` allocation that `new_function`'s [`FUNCTION_DEFINE_METERING`]
/// includes (async functions are not constructors). Calibrated against a bare
/// `async function f(){}` define vs a plain function.
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
pub use ironhorse_meter::ASYNC_INSTANCE_METERING;
/// The `fxStepAsync` completion-branch frame: on a body `return`, XS pushes the
/// result promise's `resolveFunction`, `mxCall`s it with the completion value
/// (`mxRunCount(1)`), settling the result promise. ironhorse settles the result
/// promise directly ([`Interp::settle_promise`]); this constant carries the
/// native call framing (`mxCall`/`mxRunCount`) that direct settle omits.
/// Calibrated against a bare `async function(){ return v }` (one turn, no await).
/// Folded into [`ASYNC_INSTANCE_METERING`] (both fire once per async call), 0 here.
pub use ironhorse_meter::ASYNC_STEP_SETTLE_METERING;

/// The raw 16.16 cost XS accrues in `function_environment`
/// (`fxNewEnvironmentInstance`): the closure environment instance the
/// function captures its defining scope through. Accrued once per
/// `function_environment` opcode, at the definition site. Measured
/// against the pin; verified per-site.
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
pub use ironhorse_meter::FUNCTION_LOCAL_METERING;

/// The Function.prototype call/apply trampoline work specific to a callable
/// Proxy receiver. The Proxy's own target/trap-sensitive `[[Call]]` costs are
/// charged centrally by [`Interp::proxy_call`], so direct, bound, and abstract
/// calls all see them and these helpers add only the syntactic trampoline.
pub use ironhorse_meter::CALLABLE_PROXY_DOT_TRAMPOLINE_METERING;
/// The fixed cost `fxRunConstructor` accrues over a plain call, beyond the
/// `this`-instance `fxNewSlot`: the `fxBeginHost`/`fxEndHost` host-frame
/// entry/exit around the prototype lookup and `fxNewHostInstance`. Measured
/// against the pin `48ee02d8cfe0` as exactly `2 × XS_CODE_METERING` (131072
/// raw) — the whole-computron gap between `new f()` and `f()` for an empty
/// constructor, independent of body or arity. Accrued once per constructor
/// entry at `begin`, in [`Interp::run_constructor`].
pub use ironhorse_meter::CONSTRUCTOR_HOST_FRAME_METERING;
pub use ironhorse_meter::PROXY_CALL_FORWARD_BOUND_METERING;
pub use ironhorse_meter::PROXY_CALL_FORWARD_METHOD_METERING;
pub use ironhorse_meter::PROXY_CALL_FORWARD_NATIVE_METERING;
/// Callable Proxy `[[Call]]` residuals, split by the operation that actually
/// runs. A transparent layer forwarding to another Proxy is cheaper than the
/// terminal layer; terminal forwarding differs for user/bound functions,
/// native functions, and native methods. An active `apply` trap has its own
/// path. Calibrated raw-exact against the pinned XS 9.0 oracle.
pub use ironhorse_meter::PROXY_CALL_FORWARD_PROXY_METERING;
pub use ironhorse_meter::PROXY_CALL_FORWARD_USER_METERING;
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
pub use ironhorse_meter::DEFINE_PROPERTY_NEW_RESIDUAL_METERING;
/// `Object.getOwnPropertyDescriptors(o)` native-body base: the result object
/// instance + own-keys walk setup, measured exact against the pin's raw-gap.
pub use ironhorse_meter::GOPDS_FRAME_METERING;
/// `Object.getOwnPropertyDescriptors(o)` per-own-key cost: the
/// `fxFromPropertyDescriptor` descriptor-object build plus the key property
/// slot linking it into the result — five explicit descriptor slot charges
/// are deducted from the historical measured residual
/// (cheaper than the standalone `getOwnPropertyDescriptor`'s
/// [`GOPD_PRESENT_RESIDUAL_METERING`] because the plural amortizes the native
/// frame). Calibrated exact against the pin.
pub use ironhorse_meter::GOPDS_PER_KEY_METERING;
/// `Object.getOwnPropertyDescriptor(o, k)` native-body residual for an absent
/// key: the lookup returns `undefined`, no descriptor is built.
pub use ironhorse_meter::GOPD_ABSENT_RESIDUAL_METERING;
/// `Object.getOwnPropertyDescriptor(o, k)` native-body residual for a present
/// ordinary data property: the whole `fxFromPropertyDescriptor` build (the
/// descriptor object instance + its four `value`/`writable`/`enumerable`/
/// `configurable` own data properties), beyond the call-dispatch opcodes the
/// interpreter loop already meters. The descriptor object is built with its
/// five slot charges removed from this measured constant (the
/// isolated `B - A` raw-gap minus the shared call dispatch); a novel key's
/// intern slot is metered separately by [`Interp::intern_key`].
pub use ironhorse_meter::GOPD_PRESENT_RESIDUAL_METERING;
/// `Object.seal`/`freeze` keys-walk base: `mxBehaviorPreventExtensions` + the
/// `fxNewInstance` keys holder (one `fxNewSlot`, `1<<8`) over one `CODE` step
/// (`1<<16`) = `65792`, measured against the pin's raw-gap.
pub use ironhorse_meter::INTEGRITY_APPLY_KEYS_BASE_METERING;
/// `Object.seal`/`freeze` per-own-key cost: the `mxBehaviorOwnKeys` at-slot
/// (`fxNewSlot`, exactly [`crate::meter::SLOT_ALLOCATION_METERING`] = `1<<8`)
/// per own key. The re-stamp allocates nothing.
pub use ironhorse_meter::INTEGRITY_APPLY_PER_KEY_METERING;
/// `Object.isSealed`/`isFrozen` keys-walk base (the `fxNewInstance` keys
/// holder + `mxBehaviorOwnKeys` setup + the undefined property scratch), added
/// when the instance is non-extensible (an extensible instance short-circuits
/// to `false` before the walk). Measured exact against the pin's raw-gap.
pub use ironhorse_meter::INTEGRITY_QUERY_KEYS_BASE_METERING;
/// `Object.isSealed`/`isFrozen` per-own-key cost: one `mxBehaviorOwnKeys`
/// at-slot (`fxNewSlot`, `1<<8`) per own key; the `mxBehaviorGetOwnProperty`
/// probe copies flags into the reused scratch, allocating nothing.
pub use ironhorse_meter::INTEGRITY_QUERY_PER_KEY_METERING;
/// `Object.isExtensible(o)` / `isSealed` / `isFrozen` native-body base
/// residual: the native frame + `mxBehaviorIsExtensible` read. `isSealed`/
/// `isFrozen` additionally build the `fxNewInstance` keys holder and walk the
/// own keys — the [`INTEGRITY_QUERY_KEYS_BASE_METERING`] +
/// [`INTEGRITY_QUERY_PER_KEY_METERING`] added on top.
pub use ironhorse_meter::IS_EXTENSIBLE_RESIDUAL_METERING;
pub use ironhorse_meter::METHOD_ERROR_TOSTRING_METERING;
pub use ironhorse_meter::METHOD_FUNCTION_TOSTRING_METERING;
pub use ironhorse_meter::METHOD_HAS_OWN_PROPERTY_METERING;
/// Per-method raw 16.16 costs for the native prototype methods, measured
/// against the pin `48ee02d8cfe0` via the differential raw-gap. Each is the
/// method's cost beyond its call dispatch; the result-string chunk (for the
/// `toString` family) is metered separately at its `fxNewChunk`.
pub use ironhorse_meter::METHOD_OBJECT_TOSTRING_METERING;
pub use ironhorse_meter::OBJECT_ENTRIES_FRAME_METERING;
/// `Object.entries(o)` per-own-key native residual beyond the pair array's two
/// element slots and item chunk: the per-element value read plus the
/// `fxNewArray(2)` pair-instance construction, `1<<16`, measured exact.
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
pub use ironhorse_meter::OBJECT_KEYS_FRAME_METERING;
/// `Object.values(o)`/`entries(o)` native-body base (the result `fxNewArray`
/// + own-keys walk setup), mirroring [`OBJECT_KEYS_FRAME_METERING`]. The
/// per-key allocations (the value slot, and for `entries` the pair array) are
/// metered on top.
pub use ironhorse_meter::OBJECT_VALUES_FRAME_METERING;
/// `Object.values(o)` per-own-key native residual beyond the result-array's
/// per-slot allocation ([`crate::meter::SLOT_ALLOCATION_METERING`]) and the
/// one-time item chunk: the per-element `mxBehaviorGetProperty` value read
/// (`3<<14`), measured exact against the pin.
pub use ironhorse_meter::OBJECT_VALUES_PER_KEY_METERING;
/// Credits for the nullish `Object.prototype.valueOf` TypeError path. The
/// shared realm-error builder is slightly more expensive than XS's native
/// `ToObject` failure, and the two source values differ by one aligned-string
/// metering unit in the pin.
pub use ironhorse_meter::OBJECT_VALUE_OF_NULL_CREDIT;
/// `Object.prototype.valueOf`'s `ToObject` host residual for a primitive
/// receiver, beyond the two wrapper slots metered by `array_to_object`.
/// Calibrated raw-exact against the pinned XS 9.0 oracle.
pub use ironhorse_meter::OBJECT_VALUE_OF_PRIMITIVE_METERING;
pub use ironhorse_meter::OBJECT_VALUE_OF_UNDEFINED_CREDIT;
/// `Object.preventExtensions(o)` native-body residual (constant, no per-key
/// work): `mxBehaviorPreventExtensions` sets the instance's
/// `XS_DONT_PATCH_FLAG` and meters nothing beyond the native frame. Calibrated
/// against the pin via the isolated raw-gap.
pub use ironhorse_meter::PREVENT_EXTENSIONS_RESIDUAL_METERING;
/// `Object.prototype.propertyIsEnumerable(k)` native-body residual: the
/// `mxBehaviorGetOwnProperty` probe, mirroring `hasOwnProperty`.
pub use ironhorse_meter::PROPERTY_IS_ENUMERABLE_METERING;
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_FIXED_SUCCESS_METERING;
/// `Proxy.[[GetPrototypeOf]]` residuals split by the operation and validation
/// outcome that actually runs. Transparent Proxy-to-Proxy forwarding recurs;
/// a terminal ordinary target has the smaller forwarding residual.
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_FORWARD_PROXY_METERING;
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_FORWARD_TARGET_METERING;
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_INVARIANT_REJECT_METERING;
/// IronHorse's shared realm-TypeError path is this much heavier than XS when
/// GetMethod finds a present but non-callable `getPrototypeOf` trap.
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_NONCALLABLE_CREDIT;
/// Active-trap validation paths: invalid return type; non-extensible target
/// with a mismatching prototype; and non-extensible target with a valid match.
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_PRIMITIVE_METERING;
/// The shorter `Proxy.[[GetPrototypeOf]]` frame when the trap throws before
/// its return-value and invariant checks.
pub use ironhorse_meter::PROXY_GET_PROTOTYPE_THROW_METERING;
/// Successful active trap on an extensible target.
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
pub use ironhorse_meter::REFLECT_FRAME_METERING;
/// XS property flag bits (`xsCommon.h`): a data property's attribute byte.
pub const XS_DONT_DELETE_FLAG: u8 = 2; // configurable: false
pub const XS_DONT_ENUM_FLAG: u8 = 4; // enumerable: false
pub const XS_DONT_SET_FLAG: u8 = 8; // writable: false
pub const XS_METHOD_FLAG: u8 = 16;
pub const XS_GETTER_FLAG: u8 = 32;
pub const XS_SETTER_FLAG: u8 = 64;
/// XS instance-slot flag bit (`xsAll.h`): a non-extensible instance carries
/// `XS_DONT_PATCH_FLAG` on its own `XS_INSTANCE_KIND` slot's `flag` byte
/// (`mxBehaviorPreventExtensions` sets it, `mxBehaviorIsExtensible` reads it).
/// Note the *instance* flag byte reuses bit positions the *property* flag byte
/// spends on `XS_METHOD_FLAG`/`XS_GETTER_FLAG` — the two are never the same
/// slot, so the overlap is harmless. Only the extensibility bit is modeled.
pub const XS_DONT_PATCH_FLAG: u8 = 16;
/// XS instance/internal-slot flag bit (`xsAll.h` `XS_DONT_MODIFY_FLAG = 8`).
/// `petrify` applies the corresponding `XS_DONT_SET_FLAG` to mutable internal
/// data slots (Date, Map/Set/weak collections, and ArrayBuffer). IronHorse's
/// internal data lives in side tables, so the instance head carries this bit
/// as the persisted read-only marker checked by those mutators.
pub const XS_DONT_MODIFY_FLAG: u8 = 8;
/// XS instance-slot flag bit (`xsAll.h` `XS_DONT_MARSHALL_FLAG = 64`): the
/// marker `harden`/`lockdown` stamp on a *hardened* (transitively frozen)
/// instance's own `XS_INSTANCE_KIND` slot. `fx_hardenQueue` skips an instance
/// already carrying it (the visited set), and `fx_harden` short-circuits a
/// re-`harden` of an already-hardened object. It lives on the *instance* flag
/// byte, disjoint from the property flag byte's `XS_SETTER_FLAG` (also `64`) —
/// the two never name the same slot (the instance's head slot is never a
/// property), so the overlap is harmless, exactly as `XS_DONT_PATCH_FLAG`'s is.
pub const XS_DONT_MARSHALL_FLAG: u8 = 64;

/// XS instance-slot flag bit (`xsAll.h` `XS_EXOTIC_FLAG = 1`): an environment
/// instance (and other exotics) carries it on its `XS_INSTANCE_KIND` head slot.
/// `fxNewEnvironmentInstance` stamps it so the instance is never mistaken for an
/// ordinary object; ironhorse's `with`-environment head carries it for fidelity.
pub const XS_EXOTIC_FLAG: u8 = 1;
/// XS property-slot flag bit (`xsAll.h` `XS_INTERNAL_FLAG = 1`): an instance's
/// internal (non-JS-visible) slot. The environment behavior slot carries it.
pub const XS_INTERNAL_FLAG: u8 = 1;
/// The reserved property-key id of an environment instance's behavior slot
/// (XS's `XS_ENVIRONMENT_BEHAVIOR`). It must not collide with any program symbol
/// id (`1..=names.len()`) or runtime-interned key (past `names.len()`); the top
/// of the `u16` space is unreachable by either, and ironhorse never looks the
/// slot up by id (the `with`-walk reads it positionally as `instance.next`), so
/// the value is faithfulness-only.
pub const XS_ENVIRONMENT_BEHAVIOR_ID: u16 = u16::MAX;

/// The callable pair carried by an ordinary accessor property. XS stores the
/// getter and setter in adjacent property slots. Ironhorse keeps the public
/// property slot in the ordinary property chain (so attributes and key order
/// stay centralized there) and keeps the pair in this side table.
#[derive(Clone, Copy, Debug, Default)]
struct AccessorData {
    get: Option<Slot>,
    set: Option<Slot>,
}

/// A property key for a deterministic boot accessor. String keys use the
/// realm's append-only name table; well-known symbols use the descriptor-key
/// table and are installed only during the initial full intrinsic link.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProtoAccessorKey {
    String(&'static str),
    WellKnownSymbol(&'static str),
}

/// Result of writing through XS's exotic closure-environment behavior.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EnvironmentSet {
    Written,
    Uninitialized,
    Const,
    Missing,
}

/// A complete or partial ECMAScript property descriptor. Presence is encoded
/// by `Option`; this is important because an absent field and a present field
/// whose value is `undefined` have different effects during redefinition.
#[derive(Clone, Copy, Debug, Default)]
struct OrdinaryDescriptor {
    value: Option<Slot>,
    writable: Option<bool>,
    get: Option<Slot>,
    set: Option<Slot>,
    enumerable: Option<bool>,
    configurable: Option<bool>,
}

impl OrdinaryDescriptor {
    fn is_accessor(self) -> bool {
        self.get.is_some() || self.set.is_some()
    }

    fn is_data(self) -> bool {
        self.value.is_some() || self.writable.is_some()
    }
}

/// `CompletePropertyDescriptor(Desc)` (ECMA-262 6.2.5.6): fill a partial
/// descriptor (as returned by a proxy trap through `ToPropertyDescriptor`) with
/// the spec defaults, so the target-consistency checks see every field. A
/// generic descriptor completes as a data descriptor.
fn complete_descriptor(mut d: OrdinaryDescriptor) -> OrdinaryDescriptor {
    if !d.is_accessor() {
        if d.value.is_none() {
            d.value = Some(Slot::undefined());
        }
        if d.writable.is_none() {
            d.writable = Some(false);
        }
    } else {
        if d.get.is_none() {
            d.get = Some(Slot::undefined());
        }
        if d.set.is_none() {
            d.set = Some(Slot::undefined());
        }
    }
    if d.enumerable.is_none() {
        d.enumerable = Some(false);
    }
    if d.configurable.is_none() {
        d.configurable = Some(false);
    }
    d
}

/// Whether an `Object.*` static native method takes the object it operates on
/// as its first argument (so a proxy first argument must route through the
/// proxy-aware MOP). `create`/`assign`/`fromEntries` are excluded (their first
/// argument is a prototype / target-plus-sources, handled by their own arms);
/// `getPrototypeOf`/`setPrototypeOf` are excluded because their arms already
/// call the proxy-aware `mop_*` dispatchers directly.
fn is_object_static_on_operand(m: NativeMethod) -> bool {
    matches!(
        m,
        NativeMethod::ObjectKeys
            | NativeMethod::ObjectValues
            | NativeMethod::ObjectEntries
            | NativeMethod::ObjectGetOwnPropertyDescriptor
            | NativeMethod::ObjectGetOwnPropertyDescriptors
            | NativeMethod::ObjectGetOwnPropertyNames
            | NativeMethod::ObjectGetOwnPropertySymbols
            | NativeMethod::ObjectDefineProperty
            | NativeMethod::ObjectDefineProperties
            | NativeMethod::ObjectPreventExtensions
            | NativeMethod::ObjectIsExtensible
            | NativeMethod::ObjectSeal
            | NativeMethod::ObjectFreeze
            | NativeMethod::ObjectIsSealed
            | NativeMethod::ObjectIsFrozen
    )
}

/// `ToLength(n)` (ECMA-262 7.1.20) over an already-`ToNumber`'d value: clamp to
/// the integer range `[0, 2^53 − 1]`.
fn to_length_u64(n: f64) -> u64 {
    if n.is_nan() || n <= 0.0 {
        0
    } else {
        let m = n.floor();
        if m >= 9007199254740991.0 {
            9007199254740991
        } else {
            m as u64
        }
    }
}
/// The fixed re-dispatch overhead `Function.prototype.call` accrues beyond
/// the visible `.call` opcodes and the callee body (measured as `2<<16`),
/// plus one built-in step ([`CALL_TRAMPOLINE_PER_ARG`]) per forwarded
/// argument (XS copies each). Calibrated against the pin via the raw-gap.
pub use ironhorse_meter::CALL_TRAMPOLINE_METERING;
pub use ironhorse_meter::CALL_TRAMPOLINE_PER_ARG;
/// `harden`/`petrify` per-hardened-object base: `fx_hardenFreezeAndTraverse`
/// builds the two `fxNewInstance` ownKeys holders (the freeze pass and the
/// traverse pass) over the `mxBehaviorPreventExtensions` frame. Modeled as two
/// `INTEGRITY_APPLY_KEYS_BASE`-shaped holders. `xsLockdown.c` calls no
/// `mxMeter`, so harden's whole cost is these allocation constants; the count
/// is deterministic per release (the bar) — computron parity against the pin is
/// structurally unavailable over a transitive walk into ironhorse's sparse
/// intrinsics, so the corpus is result-gated.
pub use ironhorse_meter::HARDEN_OBJECT_BASE_METERING;
/// `harden`/`petrify` per-own-key cost: the two `mxBehaviorOwnKeys` at-slots
/// (`fxNewSlot`, `1<<8` each — freeze pass + traverse pass) plus the
/// `mxBehaviorDefineOwnProperty` re-stamp (no allocation). Petrify's single
/// pass uses [`PETRIFY_PER_KEY_METERING`].
pub use ironhorse_meter::HARDEN_PER_KEY_METERING;
/// `harden` per newly-queued instance: the `fx_hardenQueue` worklist
/// `fxNewSlot` (`1<<8`).
pub use ironhorse_meter::HARDEN_QUEUE_ITEM_METERING;
/// `petrify` single-object base: one `fxNewInstance` ownKeys holder (petrify
/// walks the keys once, no transitive traverse pass).
pub use ironhorse_meter::PETRIFY_OBJECT_BASE_METERING;
/// `petrify` per-own-key cost: one `mxBehaviorOwnKeys` at-slot.
pub use ironhorse_meter::PETRIFY_PER_KEY_METERING;

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
pub use ironhorse_meter::APPLY_ARRAY_BASE_METERING;
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
pub use ironhorse_meter::APPLY_GENERIC_ARRAYLIKE_CREDIT;

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
pub use ironhorse_meter::BIND_CREATE_METERING;
pub use ironhorse_meter::BIND_CREATE_PER_ARG;

/// The bound-function call trampoline (`fx_Function_prototype_bound`): the
/// re-dispatch cost beyond the target's body, plus one built-in step
/// ([`BIND_CALL_PER_ARG`] = `1<<14`) per forwarded argument (bound + call).
/// Calibrated via the raw-gap: with a fixed target, each forwarded argument
/// grows the run by exactly `1<<14` and the base is a constant `180216`.
pub use ironhorse_meter::BIND_CALL_METERING;
pub use ironhorse_meter::BIND_CALL_PER_ARG;

/// The raw 16.16 cost the `instanceof` operator accrues beyond its own
/// dispatch for the `Symbol.hasInstance` host-frame call itself
/// (`fxRunInstanceOf` → `fxOrdinaryHasInstance`), measured against the pin
/// `48ee02d8cfe0` as `2 × XS_CODE_METERING` — paid for every operand,
/// object or primitive.
pub use ironhorse_meter::INSTANCEOF_METERING;

/// The raw 16.16 cost the `in` operator accrues beyond its own dispatch when
/// the property is present: `fxRunIn` wraps `fxHasAt` in a host frame — one
/// code unit plus one built-in step. Measured against the pin `48ee02d8cfe0`
/// as exactly `(1<<16) + (1<<14)` (81920 raw), independent of the object.
pub use ironhorse_meter::IN_METERING;

/// The raw 16.16 cost `XS_CODE_EVAL_REFERENCE`/`PROGRAM_REFERENCE` accrues per
/// **object** environment level it tests with `fxIsScopableSlot`: the host-frame
/// `mxHasID` (`fxBeginHost`/`HasProperty`/`fxEndHost`), measured as one
/// `XS_CODE_METERING` beyond the per-prototype-level recursion cost (which the
/// walk adds separately via `tick_code_n`). Calibrated exactly against the
/// pinned XS oracle on the `language/statements/with` slice (a present own hit
/// with no prototype recursion costs exactly this plus one
/// [`WITH_UNSCOPABLES_GET_METERING`]).
pub use ironhorse_meter::WITH_SCOPABLE_HAS_METERING;

/// The raw 16.16 cost of the host `mxGetID(@@unscopables)` inside
/// `fxIsScopableSlot`, charged whenever the property is present (XS always reads
/// `obj[@@unscopables]` on a hit). One `XS_CODE_METERING`, calibrated against the
/// pinned XS oracle.
pub use ironhorse_meter::WITH_UNSCOPABLES_GET_METERING;

/// The raw 16.16 cost of the *second* host get inside `fxIsScopableSlot` —
/// `obj[@@unscopables][id]` — charged only when `obj[@@unscopables]` is itself an
/// object (a blocklist to consult). Measured as half a `WITH_UNSCOPABLES_GET_METERING`
/// (the first get carries the shared host-frame teardown), calibrated against the
/// pinned XS oracle.
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
pub use ironhorse_meter::ORDINARY_HAS_PROPERTY_FRAME_METERING;

/// The own keys of `Array.prototype[@@unscopables]` (ECMA-262 23.1.3.35):
/// every `Array.prototype` method added after ES5, whose name a pre-existing
/// `with (anArray) { … }` body could already have been using as an ordinary
/// variable. Each maps to `true`, so the `with` scopable walk reads through to
/// the enclosing scope instead of resolving the method.
///
/// The order is **XS's**, not the specification's, and own-key order is
/// observable — through `Object.getOwnPropertyNames`, `Object.keys`, `for`-`in`
/// and `JSON.stringify` on the blocklist object. XS builds the list in the
/// order the methods were added to the language rather than alphabetically, so
/// it differs from 23.1.3.35 in two places: `copyWithin` precedes `at`, and
/// `values` precedes `toReversed`/`toSorted`/`toSpliced`. Verified against the
/// pinned oracle key for key, in order.
const ARRAY_UNSCOPABLES: [&str; 16] = [
    "copyWithin",
    "at",
    "entries",
    "fill",
    "find",
    "findIndex",
    "findLast",
    "findLastIndex",
    "flat",
    "flatMap",
    "includes",
    "keys",
    "values",
    "toReversed",
    "toSorted",
    "toSpliced",
];

/// The raw 16.16 environment-setup residual `XS_CODE_WITH` accrues beyond its
/// two `fxNewSlot` allocations and its own dispatch: the host-frame work
/// `fxNewEnvironmentInstance` runs to splice the environment instance into the
/// chain (two `mxMeterOne` steps). Measured as exactly `2 × XS_BUILTIN_METERING`
/// against the pinned XS oracle on the empty-body `with`. Attributed to `WITH`
/// (not the co-emitted `TO_INSTANCE`, whose zero-cost `ToObject` on an object is
/// already calibrated by object destructuring).
pub use ironhorse_meter::WITH_ENV_SETUP_METERING;

/// The additional raw 16.16 cost when the left operand is an object:
/// `fxOrdinaryHasInstance` reads the constructor's `.prototype` and walks the
/// chain, whereas a primitive short-circuits to `false` before it. Measured
/// as a further `2 × XS_CODE_METERING`, independent of chain depth or result.
pub use ironhorse_meter::INSTANCEOF_OBJECT_METERING;

/// The raw 16.16 cost a primitive-wrapper constructor (`new Boolean`/
/// `new Number`/`new String`) accrues over the native `Object` constructor's
/// empty-object cost: the internal `[[XxxData]]` slot plus the wrap step.
/// Measured against the pin `48ee02d8cfe0` as the raw gap between
/// `new Boolean()` and `new Object()` = `(1<<16) + 256` (65792). Accrued in
/// [`Interp::build_wrapper`].
pub use ironhorse_meter::WRAPPER_CONSTRUCT_EXTRA;

/// The raw 16.16 cost of a `Symbol()` call (`fx_Symbol`/`fxNewSymbol`): the
/// symbol slot plus its registration. Measured against the pin `48ee02d8cfe0`
/// as 33792 raw, independent of the description. Accrued per `Symbol()` call.
pub use ironhorse_meter::SYMBOL_CREATE_METERING;

pub use ironhorse_meter::SYMBOL_FOR_METERING;
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
pub use ironhorse_meter::SYMBOL_TO_STRING_METERING;

/// The raw 16.16 cost an Error constructor accrues over the native `Object`
/// constructor's empty-object cost: the extra internal slots and steps an
/// error instance carries (`fx_Error`/`fxNewErrorInstance` — the stack-trace
/// capture and internal `[[ErrorData]]`). Measured against the pin
/// `48ee02d8cfe0` as the raw gap between `new Error()` and `new Object()` =
/// 66304 (one built-in step `1<<16` plus 768 for the extra slots). Accrued
/// in [`Interp::build_error`].
pub use ironhorse_meter::ERROR_CONSTRUCT_EXTRA;

/// The raw 16.16 cost of an Error's own `message` property when a message
/// argument is supplied (`fx_Error` defining `message`). Measured against the
/// pin as `new Error('x')` minus `new Error()` = 280 raw, independent of the
/// message length (the message string's own chunk is metered at its literal).
pub use ironhorse_meter::ERROR_MESSAGE_METERING;

/// `new DisposableStack()` / `new AsyncDisposableStack()` beyond what the
/// arm's own allocation models. Measured against the pinned oracle
/// (2026-08-27, the resource-management dual-run deltas): a bare construct
/// under-metered by exactly two dispatch units, stable across every shape
/// probed, so the gap is charged as a whole-unit constant.
pub use ironhorse_meter::DISPOSABLE_STACK_CONSTRUCT_METERING;

/// One record-adding DisposableStack method (`use`/`adopt`/`defer`) or a
/// `move`. Measured (same probe): each added two dispatch units over the
/// modeled cost, additive across combinations (defer×2 + move measured
/// exactly 3× this constant beyond the construct).
pub use ironhorse_meter::DISPOSABLE_STACK_ADD_METERING;

/// Disposing a `use` record (the @@dispose method invoked WITH the
/// resource as `this`) costs one dispatch unit more than the modeled
/// callback; `defer`/`adopt` records (undefined `this` / passed resource)
/// measured no residue. Charged per record in the dispose drain.
pub use ironhorse_meter::DISPOSE_USE_RECORD_METERING;

/// The `using`/`await using` declaration opcode's bookkeeping beyond the
/// modeled lookups: one dispatch unit always (the null/undefined skip path
/// measured exactly this), plus [`USING_RESOURCE_METERING`] when the
/// resource is real. Measured on the sync form; the async form shares the
/// arm and the charge, pending its own oracle calibration.
pub use ironhorse_meter::USING_DECL_METERING;

/// The non-nullish `using` resource's disposer capture beyond the modeled
/// @@dispose lookup — one further dispatch unit (measured: a real-resource
/// `using` totals exactly two units over the modeled cost, the null form
/// one).
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
pub use ironhorse_meter::AGGREGATE_ERROR_EXTRA;
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
pub use ironhorse_meter::ARRAY_LENGTH_SET_METERING;

/// The raw 16.16 cost of an `arr.length` read beyond its own dispatch.
/// Measured against the pin `48ee02d8cfe0` as **zero**: the length accessor
/// getter (`fxArrayLengthGetter`) returning the stored length adds no
/// built-in step or allocation over the `GET_PROPERTY` dispatch already
/// metered. Kept as a named constant so a future revision can revise it in
/// one place.
pub use ironhorse_meter::ARRAY_LENGTH_GET_METERING;

/// The raw 16.16 cost `NEW_PROPERTY_AT` accrues defining a fresh array item
/// beyond its dispatch and the item-chunk growth: one built-in step
/// (`fxRunDefine`'s `mxMeterOne`). Measured against the pin as `1 <<
/// 14` = 16384 (verified: an N-element literal's per-element raw delta is
/// exactly `5 × XS_CODE_METERING + 16384 + item_chunk_bytes`). The chunk
/// growth is metered separately by [`Interp::array_item_grow_metering`].
pub use ironhorse_meter::ARRAY_ITEM_DEFINE_STEP_METERING;

/// `Array.prototype.at` frame cost + the in-range element read (`mxGetAt`).
/// Calibrated against the pin.
pub use ironhorse_meter::ARRAY_AT_FRAME_METERING;
pub use ironhorse_meter::ARRAY_AT_READ_METERING;
pub use ironhorse_meter::ARRAY_CONCAT_CHECK_METERING;
/// `Array.prototype.concat` frame cost + the `Symbol.isConcatSpreadable`
/// check per reference operand + the per-spread-element read and per-appended-
/// value residual (beyond the per-element/per-value key slot and `mxMeterSome`,
/// the result chunk, and the closing `mxMeterSome(3)`). Calibrated against the
/// pin by solving the linear system over a spread of operand shapes.
pub use ironhorse_meter::ARRAY_CONCAT_FRAME_METERING;
/// Extra raw per appended non-array value, over the key slot + `mxMeterSome(4)`.
pub use ironhorse_meter::ARRAY_CONCAT_PRIM_EXTRA_METERING;
/// Extra raw per spread element (its `mxGetIndex`/`fxHasIndex` read), over the
/// key slot + `mxMeterSome(2)`.
pub use ironhorse_meter::ARRAY_CONCAT_SPREAD_EXTRA_METERING;
/// `Array.prototype.copyWithin` frame cost, beyond the `mxMeterSome(count*10)`
/// for the copied block. Calibrated against the pin.
pub use ironhorse_meter::ARRAY_COPYWITHIN_FRAME_METERING;
/// `Array.prototype.fill` frame cost (the full-fill chunk realloc and the
/// per-element `mxMeterSome(5)` are metered separately). Calibrated.
pub use ironhorse_meter::ARRAY_FILL_FRAME_METERING;
pub use ironhorse_meter::ARRAY_FILTER_FRAME_METERING;
pub use ironhorse_meter::ARRAY_FILTER_KEEP_METERING;
/// The fixed backward-scan setup `findLast`/`findLastIndex` accrue over the
/// forward `find`/`findIndex`. Measured against the pin as `6 << 14`.
pub use ironhorse_meter::ARRAY_FINDLAST_EXTRA_METERING;
/// `find`/`findIndex` use `fxFindThisItem` (calls the callback for every index,
/// holes included), a different per-element overhead than `fxCallThisItem`.
pub use ironhorse_meter::ARRAY_FIND_FRAME_METERING;
pub use ironhorse_meter::ARRAY_FIND_PER_ELEM_METERING;
/// The per-source-element callback overhead of `flatMap` (`fxCallThisItem` in
/// `flatAux`'s function branch), beyond the callback body and the result
/// flattening (which reuses the `flat` constants). Calibrated against the pin.
pub use ironhorse_meter::ARRAY_FLATMAP_CALLBACK_METERING;
use ironhorse_meter::ARRAY_FLATMAP_GENERIC_ELEMENT_OVERLAP;
/// The generic MOP path accounts for a small part of `flatMap`'s calibrated
/// frame and per-element work itself. Remove that overlap when applying the
/// dense-path constants through the generic implementation.
use ironhorse_meter::ARRAY_FLATMAP_GENERIC_FRAME_OVERLAP;
/// `Array.prototype.flat` frame cost (`fxCreateArraySpecies` + host frame, as
/// slice/splice), plus the per-appended-leaf cost (the visit read + the
/// `mxDefineIndex` step, `9 << 14`; the chunk growth is metered separately) and
/// the per-array-element cost (the visit read + the `.length` read before
/// recursing, `11 << 14`). Calibrated against the pin by solving the linear
/// system (the visit count is `leaves + arrays`, so two constants suffice).
pub use ironhorse_meter::ARRAY_FLAT_FRAME_METERING;
pub use ironhorse_meter::ARRAY_FLAT_PER_ARRAY_METERING;
pub use ironhorse_meter::ARRAY_FLAT_PER_LEAF_METERING;
/// `Array.prototype.forEach` frame cost + the per-element `fxCallThisItem`
/// overhead (`mxGetIndex` + the callback call-frame setup), beyond the
/// callback body's own metering. Calibrated against the pin.
pub use ironhorse_meter::ARRAY_FOREACH_FRAME_METERING;
pub use ironhorse_meter::ARRAY_FOREACH_PER_ELEM_METERING;
/// `Array.prototype.includes` frame + per-element scan step. Calibrated
/// against the pin `48ee02d8cfe0` via the completed-call raw-gap.
pub use ironhorse_meter::ARRAY_INCLUDES_FRAME_METERING;
pub use ironhorse_meter::ARRAY_INCLUDES_PER_STEP;
pub use ironhorse_meter::ARRAY_INDEXOF_PER_STEP;
/// `Array.prototype.join` frame cost (the host frame + `fxGetArrayLimit` + the
/// result setup, beyond the modeled key-list/element-slot/ToString/final-chunk
/// allocations). Calibrated against the pin for the default (",") separator; a
/// non-default *string* separator argument carries a documented −24-raw
/// sub-computron residual (well under a `>> 16` boundary; every corpus/fuzz/
/// test262 check compares computrons and stays exact).
pub use ironhorse_meter::ARRAY_JOIN_FRAME_METERING;
/// The per-element base cost `Array.prototype.join` accrues for every index
/// (the `mxGetIndex` read + loop overhead), on top of the element's ToString
/// allocation: `1 << 16`. Calibrated against the pin.
pub use ironhorse_meter::ARRAY_JOIN_PER_ELEMENT_METERING;
/// `Array.prototype.lastIndexOf` frame + per-element (backward) scan step.
pub use ironhorse_meter::ARRAY_LASTINDEXOF_FRAME_METERING;
pub use ironhorse_meter::ARRAY_LASTINDEXOF_PER_STEP;
/// Frame/per-element residuals for the other callback-taking methods, beyond
/// the shared per-element `fxCallThisItem` overhead
/// ([`ARRAY_FOREACH_PER_ELEM_METERING`]) and the callback body. Calibrated
/// against the pin.
pub use ironhorse_meter::ARRAY_MAP_FRAME_METERING;
/// The fixed frame cost of `Array.prototype.indexOf` (`2 << 14`) and its
/// per-element scan step (`5 << 14` = 81920, `mxMeterSome(5)` per compared
/// element). Measured against the pin: `gap = 32768 + 81920 × elements_scanned`
/// (scanning stops at the first strict-equal match).
pub use ironhorse_meter::ARRAY_METHOD_INDEXOF_FRAME_METERING;
/// The fixed raw 16.16 cost of a dense `Array.prototype.pop` call beyond its
/// modeled `mxMeterSome(2 + 8 + 4)` and the chunk shrink: **zero** (measured
/// bit-exact against the pin with no residual).
pub use ironhorse_meter::ARRAY_POP_FRAME_METERING;
/// The `fxToBoolean` of a predicate callback's result (`some`/`every`/`find`/
/// `filter`).
pub use ironhorse_meter::ARRAY_PREDICATE_TOBOOL_METERING;
/// The fixed raw 16.16 cost of a dense `Array.prototype.push` call beyond the
/// per-item `mxMeterSome(5)`, the two bracketing `mxMeterSome(2)` steps, and
/// the modeled item-chunk growth: two further built-in steps
/// (`2 << 14` = 32768) the fast path runs unconditionally (host-frame /
/// `fxCheckArray` residual). Measured against the pin `48ee02d8cfe0` as the
/// constant raw-gap across a spread of receiver lengths and argument counts.
pub use ironhorse_meter::ARRAY_PUSH_FRAME_METERING;
/// `Array.prototype.reduce`/`reduceRight` frame + per-fold-step
/// `fxReduceThisItem` overhead (a 4-arg callback), beyond the callback body.
/// Calibrated against the pin.
pub use ironhorse_meter::ARRAY_REDUCE_FRAME_METERING;
/// The seed-finding scan `reduce`/`reduceRight` runs when no initial value is
/// given: for a dense array the accumulator seeds from the first (or last)
/// present element in one iteration (`mxGetIndex` read), `6 << 14`.
pub use ironhorse_meter::ARRAY_REDUCE_INIT_SCAN_METERING;
pub use ironhorse_meter::ARRAY_REDUCE_PER_ELEM_METERING;
/// `Array.prototype.reverse` frame cost + per-swap cost (each swap does
/// `mxHasAt`/`mxGetAt`×2/`mxSetAt`×2 over the generic path). Calibrated
/// against the pin.
pub use ironhorse_meter::ARRAY_REVERSE_FRAME_METERING;
pub use ironhorse_meter::ARRAY_REVERSE_PER_SWAP_METERING;
/// `Array.prototype.slice` frame cost (the result array's `fxCreateArraySpecies`
/// + host frame + closing `mxMeterSome(3)`); a non-empty slice adds the result
/// chunk and `mxMeterSome(count*10)`. Calibrated against the pin.
pub use ironhorse_meter::ARRAY_SLICE_FRAME_METERING;
pub use ironhorse_meter::ARRAY_SOMEEVERY_FRAME_METERING;
/// `Array.prototype.splice` frame cost (`fxCreateArraySpecies` + host frame),
/// beyond the modeled result chunk, tail-shift, per-item, and per-`mxMeterSome`
/// costs. Calibrated against the pin.
pub use ironhorse_meter::ARRAY_SPLICE_FRAME_METERING;
/// `Array.prototype.toReversed` frame cost (the same copy loop as `with`, one
/// code unit more of setup). Measured against the pin as 131584.
pub use ironhorse_meter::ARRAY_TOREVERSED_FRAME_METERING;
/// `Array.prototype.toSpliced` frame cost (`fxNewArray` host frame), beyond the
/// modeled result chunk and the per-region `mxMeterSome` copy costs
/// (`start * 10` for the head, `5` per insertion, `rest * 10` for the tail,
/// plus a trailing `4`). Non-mutating: the receiver is untouched. Calibrated
/// against the pin.
pub use ironhorse_meter::ARRAY_TOSPLICED_FRAME_METERING;
/// `Array.prototype.toString` prelude cost beyond the delegated `join` body:
/// the `mxThis`/`mxDub`/`mxGetID(_join)` lookup plus the `mxCall`/`mxRunCount(0)`
/// call-frame setup that invokes `join`. Calibrated against the pin.
pub use ironhorse_meter::ARRAY_TOSTRING_PRELUDE_METERING;
/// `Array.prototype.unshift` fixed frame cost (`fxCheckArray` host frame),
/// beyond the grow chunk, `mxMeterSome(length*10)`, per-arg `mxMeterSome(4)`,
/// and closing `mxMeterSome(2)`. Measured against the pin as `2 << 14`. (shift
/// needs no such residual — its `mxMeterSome(2+3+3+4)` fully accounts for it.)
pub use ironhorse_meter::ARRAY_UNSHIFT_FRAME_METERING;
/// `Array.prototype.with` frame cost + per-element copy over the generic
/// `mxGetAt`/`mxDefineAt` path (plus the result chunk). Calibrated against the
/// pin.
pub use ironhorse_meter::ARRAY_WITH_FRAME_METERING;
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
pub use ironhorse_meter::ARRAY_CTOR_BASE_METERING;
/// The raw 16.16 cost of `Array.isArray(v)` beyond its dispatch: **zero**
/// (measured against the pin — the completed-call raw-gap, independent of the
/// argument).
pub use ironhorse_meter::ARRAY_ISARRAY_METERING;

/// The raw 16.16 cost of the `ArrayBuffer.prototype.byteLength` accessor
/// getter (`fx_ArrayBuffer_prototype_get_byteLength`) beyond the
/// `GET_PROPERTY` dispatch: measured against the pin (the getter reads the
/// stored `bufferInfo.length` and meters nothing itself).
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
pub use ironhorse_meter::ARRAY_BUFFER_CTOR_FRAME_METERING;

/// The raw 16.16 cost of `ArrayBuffer.isView(v)` beyond its dispatch,
/// calibrated raw against the pin.
pub use ironhorse_meter::ARRAY_BUFFER_ISVIEW_METERING;
/// The raw 16.16 cost of a single `Atomics.*` read-modify-write beyond the
/// method dispatch (`xsAtomics.c` element access → `mxMeterOne`). Result-gated
/// on the official slice (the Atomics computron parity is not asserted).
pub use ironhorse_meter::ATOMICS_OP_METERING;
/// The constant raw 16.16 cost of a `new DataView(buffer[, offset[, len]])`
/// construct: the native host frame, `fxArgToByteLength`, the bounds checks,
/// `fxGetPrototypeFromConstructor`, and `fxNewDataViewInstance` (the object
/// instance + two internal `fxNewSlot`s — the view slot and the buffer-ref
/// slot). No backing store is allocated (the view shares the argument
/// buffer). Calibrated raw-exact against the pin `48ee02d8cfe0` (99080).
pub use ironhorse_meter::DATA_VIEW_CTOR_FRAME_METERING;
/// The raw 16.16 cost of a single `DataView.prototype.get<Type>` beyond the
/// method dispatch: the getter's `mxMeterOne` (one built-in step). Calibrated
/// raw-exact against the pin.
pub use ironhorse_meter::DATA_VIEW_GET_METERING;
/// The raw 16.16 cost of a single `DataView.prototype.set<Type>` beyond the
/// method dispatch: three built-in steps — the value coercer
/// (`fxToInteger`/`fxToUnsigned`/`fxToNumber`, two steps, constant across the
/// element types) plus the setter's `mxMeterOne`. Calibrated raw-exact
/// against the pin `48ee02d8cfe0`.
pub use ironhorse_meter::DATA_VIEW_SET_METERING;
/// The constant raw 16.16 cost of a `new <TypedArray>(buffer[, offset[,
/// length]])` construct over an existing ArrayBuffer: the native host frame
/// and `fxConstructTypedArray` (the instance + three internal slots). No
/// backing store is allocated (the view shares the argument buffer), so
/// this is the whole cost. Calibrated raw-exact against the pin (99336).
pub use ironhorse_meter::TYPED_ARRAY_BUFFER_CTOR_FRAME_METERING;
/// The raw 16.16 cost of a single TypedArray element read/write through the
/// exotic index behavior (`fxTypedArrayGetter`/`fxTypedArraySetter` →
/// `mxMeterOne`) beyond the index-property dispatch: one built-in step.
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
pub use ironhorse_meter::TYPED_ARRAY_LENGTH_CTOR_FRAME_METERING;
/// The raw 16.16 cost of the TypedArray `length`/`byteLength`/`byteOffset`
/// accessor getters (`fx_TypedArray_prototype_*_get`) beyond the
/// `GET_PROPERTY` dispatch: measured against the pin.
pub use ironhorse_meter::TYPED_ARRAY_LENGTH_GET_METERING;

/// The extra raw 16.16 cost of a for-in enumerator over an **array** (vs an
/// ordinary object): `mxBehaviorOwnKeys` for an exotic array (`fxArrayOwnKeys`
/// queuing the index keys) does more than `fxOrdinaryOwnKeys`. Measured
/// against the pin as a constant, independent of the element count.
pub use ironhorse_meter::ARRAY_FOR_IN_EXTRA_METERING;
/// The raw 16.16 cost of `Array.prototype.values()`/`keys()`/`entries()`
/// beyond its dispatch: the native host frame plus `fxNewIteratorInstance`
/// (the iterator instance + the reused `{value, done}` result object + the
/// internal kind/iterable/index slots — a fixed cluster of `fxNewSlot`s).
/// Calibrated against the pin `48ee02d8cfe0` via the completed-call raw-gap
/// (isolated from `next()` by comparing one- vs two-`next()` programs).
pub use ironhorse_meter::ARRAY_ITERATOR_CREATE_METERING;
/// The extra raw 16.16 cost a `values`/`entries` `next()` accrues reading the
/// array element it yields (`mxGetIndex`), over a `keys` next: `2 << 14`.
pub use ironhorse_meter::ARRAY_ITERATOR_ELEMENT_READ;
/// The additional host step in XS's `fxGetArrayLimit` path for a generic
/// array-like receiver. Arrays and TypedArrays read their resident limits
/// directly; ordinary objects, primitive wrappers, and Proxies perform the
/// observable `length` lookup and carry this one-computron residual.
pub use ironhorse_meter::ARRAY_ITERATOR_GENERIC_RECEIVER_METERING;
/// The base raw 16.16 cost of `%ArrayIteratorPrototype%.next()` beyond its
/// dispatch: the host frame, `fxCheckIteratorInstance`, and the result-object
/// mutation (the result object is reused, so `next()` allocates nothing for
/// kinds 0/1). A `values`/`entries` next that actually yields an element adds
/// one array-element read ([`ARRAY_ITERATOR_ELEMENT_READ`]). Calibrated
/// against the pin: `keys` next = 32768, `values` next = 65536.
pub use ironhorse_meter::ARRAY_ITERATOR_NEXT_METERING;
/// A transparent target reached by `Reflect.get` inside an active iterator
/// Proxy trap carries the active host frame through to the terminal target.
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_ACTIVE_FORWARD_TARGET_METERING;
/// Transition from a transparent outer Proxy to an active inner trap. The
/// value read has an additional half-computron host-frame component.
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_FORWARD_ACTIVE_METERING;
/// Per-layer and terminal-target residuals for a transparent Proxy `[[Get]]`
/// forwarding chain in the Array Iterator path.
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_FORWARD_METERING;
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_FORWARD_TARGET_METERING;
/// Raw residual for an observable Proxy `[[Get]]` trap on `length` during a
/// generic Array Iterator step. Charged only when the trap actually exists;
/// transparent and nested forwarding paths recurse without the residual.
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_KEYS_METERING;
/// String-wrapper residual when the length read arrives through transparent
/// Proxy forwarding. The Proxy target frame absorbs one half-computron of the
/// direct wrapper path.
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_STRING_RECEIVER_METERING;
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_VALUE_ACTIVE_FORWARD_TARGET_METERING;
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_VALUE_FORWARD_ACTIVE_METERING;
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_VALUE_FORWARD_TARGET_METERING;
/// Raw residual for the second observable Proxy `[[Get]]` trap on the indexed
/// value of a values/entries step. The combined direct two-trap residual is
/// 654864 raw units against the pin.
pub use ironhorse_meter::ARRAY_ITERATOR_PROXY_VALUE_METERING;
/// Additional raw residual for the String-exotic generic iterator path. The
/// wrapper exposes synthetic UTF-16 indices and `length`, which XS accounts
/// beyond the ordinary-object `fxGetArrayLimit` step.
pub use ironhorse_meter::ARRAY_ITERATOR_STRING_RECEIVER_METERING;
/// XS keeps arguments in resident indexed storage even though their `length`
/// is an ordinary property. Its wide-length fallback avoids part of the
/// generic property path; credit that raw fractional difference before
/// repeated calls accumulate into whole computrons.
pub use ironhorse_meter::ARRAY_ITERATOR_WIDE_ARGUMENTS_CREDIT;
/// Symbol and BigInt wrappers carry one additional half-computron allocation
/// residual on the pinned generic receiver path.
pub use ironhorse_meter::ARRAY_ITERATOR_WIDE_PRIMITIVE_RECEIVER_METERING;
/// The base raw 16.16 cost of a yielding `fx_Enumerator_prototype_next` beyond
/// the yielded key's own string-chunk allocation. Calibrated against the pin.
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
pub use ironhorse_meter::FOR_IN_ENUMERATOR_METERING;
/// The raw 16.16 cost of `XS_CODE_FOR_OF` (`fxRunForOf` → `fxGetIterator`)
/// beyond the `values()` iterator creation it performs: the `fxGetIterator`
/// host frame, the `arr[Symbol.iterator]` lookup, and the zero-argument call
/// dispatch. Calibrated against the pin `48ee02d8cfe0` via the completed
/// for-of loop raw-gap (the `values()` create cost itself is metered inside
/// [`Interp::make_array_iterator`]) — a constant `2 << 16`, independent of the
/// iterable's length.
pub use ironhorse_meter::FOR_OF_GET_ITERATOR_METERING;
/// The raw 16.16 cost of creating a String Iterator (`fx_String_prototype_
/// iterator` → `fxNewIteratorInstance`), analogous to
/// [`ARRAY_ITERATOR_CREATE_METERING`] but chaining to
/// `%StringIteratorPrototype%`. Calibrated against the pin.
pub use ironhorse_meter::STRING_ITERATOR_CREATE_METERING;
/// The base raw 16.16 cost of `%StringIteratorPrototype%.next()` that yields a
/// character, beyond the result-string chunk it allocates (`fxNewChunk`, metered
/// separately via [`Interp::meter`] `tick_chunk_new`): the host frame, the
/// `mxStringByteDecode`, and the result-object mutation. Calibrated against the
/// pin.
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
pub use ironhorse_meter::MATH_FRAME_METERING;

/// The native-host-frame cost of a `Number` static / numeric global call
/// (`isFinite`/`isInteger`/`isNaN`/`isSafeInteger`/`parseInt`/`parseFloat`/
/// `isNaN`/`isFinite`), beyond the `Number.prototype.toString` result chunk.
/// Like `Math.*`, the `xsNumber.c` bodies carry no `mxMeterSome`, so the frame
/// calibrates against the pin `48ee02d8cfe0` to zero over the `RUN` opcode.
pub use ironhorse_meter::NUMBER_FRAME_METERING;

/// The extra residual a `JSON.stringify` of a **produced** top-level primitive
/// accrues over the setup (the `fxStringifyJSONName` + value-append path):
/// a fixed `16384` (`1 << 14`), independent of the primitive's spelling (the
/// result chunk is metered separately). This is also the recursive
/// `fxStringifyJSONProperty` leaf cost — a primitive property/element serializes
/// for exactly one built-in step.
pub use ironhorse_meter::JSON_STRINGIFY_SCALAR_METERING;
/// The `JSON.stringify` setup residual: `fxStringifyJSON` mallocs an unmetered
/// 1 KiB working buffer but also allocates a metered holder object
/// (`fxNewObjectInstance` + `fxNextSlotProperty`) and runs the host frame — a
/// fixed `82432` raw 16.16 units, independent of the value, measured against
/// the pin `48ee02d8cfe0` (the `JSON.stringify(undefined)` no-output gap).
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
pub use ironhorse_meter::JSON_STRINGIFY_ARRAY_ELEMENT_METERING;
/// Entering an **array** node (`fxIsArray` true): `fxStringifyJSONChars("[")`,
/// `mxGetID(_length)`, `fxToInteger`, the empty/`]` close — `11` built-in steps
/// (`180224`), value-independent, paid by every array however deep.
pub use ironhorse_meter::JSON_STRINGIFY_ARRAY_ENTER_METERING;
/// A **non-empty** array's one-time `level`/indent setup over the enter cost:
/// one built-in step (`16384`).
pub use ironhorse_meter::JSON_STRINGIFY_ARRAY_NONEMPTY_METERING;
/// Entering an **object** node: `fxStringifyJSONChars("{")`, `at =
/// fxNewInstance` (one `fxNewSlot`, `+256`), the `mxBehaviorOwnKeys` base walk,
/// the empty/`}` close — `8` built-in steps plus the instance slot
/// (`131072 + 256 = 131328`).
pub use ironhorse_meter::JSON_STRINGIFY_OBJECT_ENTER_METERING;
/// Each surviving object key's per-iteration body (`getOwnProperty`, `mxGetAll`,
/// `fxStringifyJSONName`, the recursive dispatch frame): `4` built-in steps
/// (`65536`), exclusive of the key chunk and the recursive child cost.
pub use ironhorse_meter::JSON_STRINGIFY_OBJECT_KEY_BODY_METERING;
/// Each own enumerable key contributes one `XS_AT_KIND` slot to the keys list
/// `mxBehaviorOwnKeys` builds (`fxNewSlot`, `+256`), charged per own key whether
/// or not it survives the `getOwnProperty`/`DONT_ENUM` filter.
pub use ironhorse_meter::JSON_STRINGIFY_OBJECT_KEY_SLOT_METERING;
/// A **non-empty** object's one-time `level`/indent + `mxPushUndefined`/
/// `mxPushReference` setup over the enter cost — `65528`. (Not a clean step
/// multiple: the `mxBehaviorGetOwnProperty` probe of the reference's first
/// internal slot shaves 8 raw units off the fourth step; measured against the
/// pin.)
pub use ironhorse_meter::JSON_STRINGIFY_OBJECT_NONEMPTY_METERING;
/// A top-level reference pays no residual over the recursive child cost beyond
/// the setup: the wrapper's holder fetch and the enter costs fully account for
/// it. Measured against the pin — the enter constants below are anchored at the
/// value the top-level node actually charges, so no top-only term is added.
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
pub use ironhorse_meter::JSON_PARSE_ARRAY_ELEMENT_METERING;
/// Entering an **array** value: `fxNewArrayInstance` (the instance slot + the
/// array's internal length slot) — two `fxNewSlot`s (`512`), before any
/// element or the item cache.
pub use ironhorse_meter::JSON_PARSE_ARRAY_INSTANCE_METERING;
/// Entering an **object** value: `fxNewObjectInstance` — one `fxNewSlot`
/// (`256`), before any key.
pub use ironhorse_meter::JSON_PARSE_OBJECT_INSTANCE_METERING;
/// Each object member's fixed body — the value `fxParseJSONValue`/token walk
/// plus the member's property `fxNewSlot` (`65792 = (4<<14) + 256`), exclusive
/// of the key-name interning slot (a novel name adds one `fxNewSlot` via
/// [`Self::intern_key`]), the key-string tokenizer chunk (`rup8(len+1)+16`),
/// and the value's own recursive node cost.
pub use ironhorse_meter::JSON_PARSE_OBJECT_KEY_METERING;
/// The `fx_JSON_parse` native frame residual + tokenizer setup + the primitive
/// `fxParseJSONValue` push, **over** the call trampoline the interpreter already
/// meters on dispatch — a fixed `49152` (`3 << 14`) raw, value-independent,
/// charged once. A produced string additionally allocates its tokenizer chunk
/// (`fxNewChunk(size+1)`), a number/boolean/null nothing.
pub use ironhorse_meter::JSON_PARSE_SETUP_METERING;

/// The raw 16.16 native-host-frame cost of a `String.prototype` method call,
/// beyond the modeled `mxMeterSome` steps and the result chunk. Like the
/// `Math.*` frame it calibrates against the pin `48ee02d8cfe0` to zero over
/// the `RUN` opcode ironhorse already meters — the `xsString.c` bodies charge
/// only their explicit `mxMeterSome` and `fxNewChunk`, which ironhorse models
/// directly.
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
pub use ironhorse_meter::STRING_METERSOME_FRAME_METERING;

/// The fixed residual of `String.prototype.indexOf`/`lastIndexOf` beyond their
/// matching-prefix scan ticks. The pinned XS passes an unparenthesized ternary
/// to `mxMeterSome`; macro expansion and C precedence therefore add one *raw*
/// tick per matching CESU-8 leading byte rather than one built-in unit. The
/// fixed residual itself matches the other `mxMeterSome` string methods.
pub use ironhorse_meter::STRING_INDEX_FRAME_METERING;

/// The native residual of the `Map`/`Set` `size` accessor getter
/// (`fx_Map_prototype_size`) beyond the `GET_PROPERTY` dispatch. Calibrated
/// against the pin.
pub use ironhorse_meter::COLLECTION_SIZE_GET_METERING;
/// The per-linked-slot residual an inserting `fxSetEntry`/`fxSetWeakEntry`
/// charges over each new entry slot BEYOND the first (measured `1 << 15` raw
/// units per slot). A `Map.set`/`WeakMap.set`/`WeakSet.add` new entry (three
/// slots) charges `2×`; a `Set.add` new entry (two slots) charges `1×`. Query
/// methods (`get`/`has`) and an in-place update allocate nothing and carry no
/// residual. Calibrated against the pin `48ee02d8cfe0`.
pub use ironhorse_meter::COLLECTION_SLOT_LINK_METERING;
/// The native residual of `new Map()` / `new Set()` (`fx_Map`/`fx_Set` with no
/// iterable argument) BEYOND the `RUN` dispatch and the explicit
/// allocation ticks the construct path charges (four `fxNewSlot`s — instance,
/// table, list, size — plus the initial `fxNewChunk(mxTableMinLength * 8)`
/// address array). Covers the native host frame and
/// `fxGetPrototypeFromConstructor`. Calibrated raw-exact against the pin
/// `48ee02d8cfe0`.
pub use ironhorse_meter::MAP_CTOR_FRAME_METERING;
/// The native residual of `new WeakMap()` / `new WeakSet()` beyond the two
/// `fxNewSlot`s (`fxNewWeakMapInstance`: instance + weak list; no table, no
/// chunk). Calibrated raw-exact against the pin.
pub use ironhorse_meter::WEAK_CTOR_FRAME_METERING;
/// XS's `mxTableMinLength`: the initial (and minimum) Map/Set hash-table
/// address-array length. The table grows/shrinks by powers of two around it.
pub const MAP_MIN_TABLE_LENGTH: u32 = 1;
/// The native residual of a BigInt **arithmetic** op (`+`/`-`/`*`) beyond the
/// `RUN` dispatch, the `mxBigInt_meter((result_size - 1) * XS_BIGINT_METERING)`
/// digit step, and the result digit-chunk allocation. XS's binary path
/// (`fxToNumericNumberBinary` → `gxTypeBigInt._add/_sub/_mul`) coerces both
/// operands (each already a BigInt in a well-typed program — mixed BigInt/Number
/// arithmetic is a TypeError) through `fxToNumericNumber` and frames the op:
/// measured `1 << 14` raw-exact against the pin `48ee02d8cfe0`.
pub use ironhorse_meter::BIGINT_ARITH_FRAME_METERING;
/// The native residual of a BigInt **literal** (`XS_CODE_BIGINT_1/2` →
/// `fxNewBigInt`) beyond the `RUN` dispatch and the digit-chunk allocation
/// (`fxNewChunk(size * 4)`, charged in [`Interp::make_bigint`]): one builtin
/// step (`fxNewBigInt`'s residual). Calibrated raw-exact against the pin
/// `48ee02d8cfe0`.
pub use ironhorse_meter::BIGINT_LITERAL_METERING;
/// The native residual of a BigInt **unary minus** (`XS_CODE_MINUS` →
/// `fxToNumericNumberUnary` → `gxTypeBigInt._neg`) beyond the `RUN` dispatch and
/// the negated-copy digit chunk (`fxBigInt_neg` → `fxBigInt_alloc`, charged in
/// [`Interp::make_bigint`]). Measured `1 << 14` raw-exact against the pin.
pub use ironhorse_meter::BIGINT_NEG_FRAME_METERING;
/// The native host-frame residual of `Map.prototype.clear` /
/// `Set.prototype.clear` (`fxClearEntries`) BEYOND its dispatch and the
/// `fxResizeEntries` shrink chunk (modeled separately): the frame,
/// `fxCheckMap/SetInstance`, the entry tombstone walk, and `fxPurgeEntries`.
/// Calibrated computron-exact against the pin `48ee02d8cfe0`.
pub use ironhorse_meter::COLLECTION_CLEAR_FRAME_METERING;
/// The per-entry residual `forEach` charges for one live entry BEYOND the
/// callback body the nested dispatch meters: the `mxPushSlot`s, `mxCall`, and
/// `mxRunCount(3)` frame the C loop builds around each call (`2 << 16`).
/// Calibrated raw-exact against the pin (identical for Map and Set).
pub use ironhorse_meter::COLLECTION_FOREACH_PER_ENTRY_METERING;
/// The raw 16.16 cost of building a Map/Set Iterator
/// (`fxNewMapIteratorInstance`/`fxNewSetIteratorInstance` → the shared
/// `fxNewIteratorInstance`): the two host objects (iterator instance + reused
/// `{value, done}` result), the result's `value`/`done` properties, the three
/// internal iterator slots (id/iterable/index), the list slot, and the kind
/// integer slot. Calibrated computron-exact against the pin `48ee02d8cfe0`.
pub use ironhorse_meter::COLLECTION_ITERATOR_CREATE_METERING;
/// The per-yield residual an ENTRIES-kind `%MapIteratorPrototype%.next()` /
/// `%SetIteratorPrototype%.next()` charges to build its `[k, v]` pair
/// (`fxConstructArrayEntry` → `fxNewArrayInstance`) BEYOND the two-element
/// pair chunk (modeled explicitly). A keys/values `next` allocates nothing and
/// carries no residual (its base host-frame cost is folded into the dispatch,
/// measured zero against the pin). Calibrated computron-exact against the pin.
pub use ironhorse_meter::COLLECTION_ITERATOR_ENTRY_METERING;
/// The native host-frame residual of `Map.prototype.forEach`
/// (`fx_Map_prototype_forEach`) BEYOND its dispatch and the per-entry callback
/// machinery: the frame, `fxCheckMapInstance`, `fxArgToCallback`, and the
/// `mxPushList` setup/teardown. Calibrated raw-exact against the pin
/// `48ee02d8cfe0`. The Set form ([`SET_FOREACH_FRAME_METERING`]) is 8 raw
/// units less (Map walks a key→value slot pair per entry; Set a single slot).
pub use ironhorse_meter::MAP_FOREACH_FRAME_METERING;
/// Wrong-brand rejection residuals for the shared Map/Set prototype methods.
/// These paths fail before the successful-method frames below, but XS still
/// charges the declaring builtin's receiver-validation work.
pub use ironhorse_meter::MAP_METHOD_ON_SET_METERING;
/// The native host-frame residual of `Set.prototype.forEach`
/// (`fx_Set_prototype_forEach`). See [`MAP_FOREACH_FRAME_METERING`].
pub use ironhorse_meter::SET_FOREACH_FRAME_METERING;
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
pub use ironhorse_meter::PROMISE_CAPABILITY_METERING;
/// The native residual of `Promise.prototype.catch` (`fx_Promise_prototype_
/// catch`) BEYOND the `then` it delegates to: the frame, `mxGetID(_then)`, and
/// the `mxRunCount(2)` re-dispatch into `then`. Calibrated raw-exact against
/// the pin (`147456` = 2.25 `XS_CODE_METERING`).
pub use ironhorse_meter::PROMISE_CATCH_FRAME_METERING;
/// The native frame residual of a `Promise.all`/`allSettled`/`race`/`any`
/// call BEYOND the derived capability ([`PROMISE_CAPABILITY_METERING`]) and
/// the per-element work: the frame, `fxGetIterator`, and the
/// `remainingElementsCount` cell setup. **Advisory** (see
/// [`PROMISE_FINALLY_FRAME_METERING`]).
pub use ironhorse_meter::PROMISE_COMBINATOR_FRAME_METERING;
/// The per-element native residual of a combinator's iteration step (XS's
/// `C.resolve(element)` species probe + the element-resolve function alloc +
/// the `mxRunCount` `.then` re-dispatch), BEYOND the element promise's own
/// `Promise.resolve`/reaction costs the shared helpers already charge.
/// **Advisory** (see [`PROMISE_FINALLY_FRAME_METERING`]).
pub use ironhorse_meter::PROMISE_COMBINATOR_PER_ELEMENT_METERING;
/// The native residual of `new Promise(executor)` (`fx_Promise`) BEYOND the
/// `RUN` dispatch, the explicit six `fxNewPromiseInstance` `fxNewSlot`s, the
/// [`PROMISE_FUNCTIONS_METERING`] resolving-pair cluster, and the executor
/// body the re-entrant `run_callback` meters. Covers the native host frame,
/// `fxGetPrototypeFromConstructor`, and the `mxRunCount(2)` executor-call
/// framing. Calibrated raw-exact against the pin (`new Promise(function(r){})`
/// = 6 instance slots + 13 resolving-pair slots + this frame + the empty
/// executor body = 32 computrons).
pub use ironhorse_meter::PROMISE_CTOR_FRAME_METERING;
/// The native frame residual of `fx_Promise_prototype_finally` BEYOND the
/// derived capability ([`PROMISE_CAPABILITY_METERING`]) and the native
/// reaction registration ([`Interp::promise_then_native`]): the frame, the
/// `mxGetID(_then)`, and the `thenFinally`/`catchFinally` closure framing XS
/// builds. **Advisory** under the accuracy-over-parity doctrine (ironhorse's own
/// frozen cost table; result agreement is the gate, computrons advisory), set
/// in the `catch`/`then` frame family.
pub use ironhorse_meter::PROMISE_FINALLY_FRAME_METERING;
/// The non-slot residual of `fxPushPromiseFunctions` beyond the 13 explicit
/// `fxNewSlot`s [`Interp::make_resolving_functions`] charges (the two
/// `fxNewHostFunction`s — each instance + CALLBACK + HOME + LENGTH + NAME,
/// the empty name interned so no chunk — plus the shared home object's
/// instance + boolean guard slot + promise-reference slot). Measured zero:
/// the pair allocates no chunk and `xsPromise.c`/`fxNewHostFunction` call no
/// `mxMeter` here. Calibrated raw-exact against the pin.
pub use ironhorse_meter::PROMISE_FUNCTIONS_METERING;
/// The native residual of a reaction handler / thenable `then` that **throws**
/// and is caught by the native `mxTry` (`fxOnResolvedPromise`'s `mxCatch` /
/// `fxOnThenable`'s `fxRejectException`), BEYOND unwinding the speculative
/// host-escape ([`Self::unmeter_host_escape`]) and the reject-fn settle. XS's
/// `mxCatch` moves `mxException` and re-dispatches the reject with the same
/// `mxRunCount(1)` framing the success path uses, so this is near-zero.
/// Calibrated raw-exact against the pin.
pub use ironhorse_meter::PROMISE_HANDLER_THROW_METERING;
/// The native frame residual of running one queued job at the drain
/// (`fxRunPromiseJobs`'s `mxRunCount` + the `fxOnResolvedPromise`/
/// `fxOnRejectedPromise` trampoline) BEYOND the reaction handler body the
/// nested `run_callback` meters, the derived promise's settle
/// ([`PROMISE_RESOLVE_FN_METERING`]), and the 6 queued-job slots. Calibrated
/// raw-exact against the pin.
pub use ironhorse_meter::PROMISE_JOB_FRAME_METERING;
/// The native frame residual of a **pass-through** job — a reaction with no
/// handler for the settled state, which XS's `fxOnResolvedPromise`/
/// `fxOnRejectedPromise` runs with a single `mxRunCount` (the settle only, no
/// handler call). `98304` (1.5 `XS_CODE_METERING`) less than the with-handler
/// frame. Calibrated raw-exact against the pin.
pub use ironhorse_meter::PROMISE_JOB_PASSTHROUGH_FRAME_METERING;
/// The residual of queuing one promise job (`fxQueueJob`): the job instance +
/// the `count + 4` captured argument slots. Charged when a settled promise's
/// reaction is queued (at `.then` on a settled promise, or at settle time for
/// each registered reaction). The 6 `fxQueueJob` slots are charged explicitly
/// in [`Interp::queue_promise_job`]; this is any non-slot residual (measured
/// zero). Calibrated raw-exact against the pin.
pub use ironhorse_meter::PROMISE_QUEUE_JOB_METERING;
/// The non-slot residual of `fxPromiseThen`'s reaction instance beyond the 6
/// reaction `fxNewSlot`s (and, when pending, the THENS-list slot) charged
/// explicitly in [`Interp::promise_then`]. Measured zero. Calibrated against
/// the pin.
pub use ironhorse_meter::PROMISE_REACTION_METERING;
/// The native frame residual of a **reject** function call
/// (`fxRejectPromise`). `fxRejectPromise` is a shorter body than
/// `fxResolvePromise` (no `mxTry`/thenable probe) yet meters a little more of
/// its own frame. Calibrated raw-exact against the pin.
pub use ironhorse_meter::PROMISE_REJECT_FN_METERING;
/// The native residual of `Promise.reject(reason)` (`fx_Promise_reject`).
/// Calibrated raw-exact against the pin.
pub use ironhorse_meter::PROMISE_REJECT_STATIC_METERING;
/// The native frame residual of a **resolve** function call
/// (`fxResolvePromise`) BEYOND the `RUN` dispatch, when it settles a promise
/// with a primitive value and no thenable/reactions (the path allocates
/// nothing). Calibrated raw-exact against the pin.
pub use ironhorse_meter::PROMISE_RESOLVE_FN_METERING;
/// The native residual of `Promise.resolve(v)` when `v` is already a native
/// promise — the identity fast path returns `v` (`fx_Promise_resolve`'s
/// `mxGetID(_constructor)` probe + the `fxIsSameValue(constructor, Promise)`
/// species check that precedes the identity return). Calibrated raw-exact
/// against the pin: `2.5 * XS_CODE_METERING`.
pub use ironhorse_meter::PROMISE_RESOLVE_SAME_METERING;
/// The native residual of `Promise.resolve(v)` (`fx_Promise_resolve` →
/// `fx_Promise_resolveAux`) BEYOND the capability ([`PROMISE_CAPABILITY_
/// METERING`] + its slots) and the `mxRunCount(1)` resolve settle
/// ([`PROMISE_RESOLVE_FN_METERING`]): the two frames plus the folded
/// `fxNewPromiseCapability` framing. Calibrated raw-exact against the pin.
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
pub use ironhorse_meter::PROMISE_RESOLVE_THENABLE_METERING;
/// The native residual of the `mxGetID(_then)` probe a resolve function runs on
/// ANY reference argument (`fxResolvePromise`, `if (mxIsReference(argument))`):
/// one bytecode-dispatch-equivalent (`1 << 16`), the property get for `.then`
/// (a proto-chain walk metered as one dispatch regardless of depth), charged
/// before branching on whether `.then` is callable. Calibrated raw-exact
/// against the pin (a non-thenable-object resolve over-shot the primitive path
/// by exactly this).
pub use ironhorse_meter::PROMISE_RESOLVE_THEN_PROBE_METERING;
/// The native residual of the `[[AlreadyResolved]]`-guarded early return of a
/// resolve/reject function (XS returns right after the boolean check).
/// Measured zero against the pin (a second `resolve`/`reject` adds nothing).
pub use ironhorse_meter::PROMISE_SETTLE_GUARDED_METERING;
/// The native frame residual of running one **thenable job** at the drain
/// (`fxOnThenable`): the `mxRunCount(2)` framing that invokes
/// `then.call(thenable, resolve, reject)` BEYOND the `then` body the nested
/// `run_callback` meters (and the resolve/reject calls that body makes, each
/// metered by [`Interp::call_promise_function`]). Calibrated raw-exact against
/// the pin.
pub use ironhorse_meter::PROMISE_THENABLE_JOB_FRAME_METERING;
/// The native residual of `fx_Promise_prototype_then` BEYOND the capability
/// ([`PROMISE_CAPABILITY_METERING`]) and the reaction registration
/// ([`PROMISE_REACTION_METERING`]): the frame, `mxGetID(_constructor)`, and
/// `fxToSpeciesConstructor`, plus the folded `fxNewPromiseCapability` framing.
/// Calibrated raw-exact against the pin.
pub use ironhorse_meter::PROMISE_THEN_METERING;
/// The native residual of `new RegExp(pattern, flags)` (`fx_RegExp` +
/// `fxInitializeRegExp`) BEYOND the explicit `fxNewRegExpInstance` `fxNewSlot`s
/// and the `fxCompileRegExp` compile meter the [`RegExpData`] program carries.
/// Covers the `fx_RegExp` host frame, `fxGetPrototypeFromConstructor`, and the
/// `mxRunCount(2)` `mxInitializeRegExpFunction` call framing. Calibrated
/// raw-exact against the pin.
pub use ironhorse_meter::REGEXP_CTOR_FRAME_METERING;
/// The native residual of `RegExp.prototype.exec` (`fx_RegExp_prototype_exec`)
/// BEYOND the match meter the matcher carries, the result-array `fxNewSlot`s,
/// and the result-string chunk allocations. Covers the host frame, the
/// `lastIndex` get, and `fxToString(argument)`. Calibrated raw-exact.
pub use ironhorse_meter::REGEXP_EXEC_FRAME_METERING;
/// The on-match residual of `exec` beyond the frame and the explicit
/// per-capture slot/chunk allocations (the `fxCacheUTF8ToUnicodeOffset`
/// remaps + `fxCacheArray`). Calibrated.
pub use ironhorse_meter::REGEXP_EXEC_MATCH_METERING;
/// The per-extra-capture residual of `exec` on a match. Calibrated.
pub use ironhorse_meter::REGEXP_EXEC_PER_CAPTURE;
/// The residual of the composite `flags` getter (`fx_RegExp_prototype_get_
/// flags`), which reads all eight per-flag properties back through
/// `mxGetID` + their accessors and assembles the string. Calibrated raw-exact
/// (constant — the same eight gets regardless of which flags are set).
pub use ironhorse_meter::REGEXP_FLAGS_GETTER_METERING;
/// The residual of a RegExp per-flag / `source` accessor getter beyond the
/// `GET_PROPERTY` dispatch (the getter's `mxMeterOne`, if any). Measured as
/// zero against the pin (each reads `code[0]` / the source key with no
/// built-in step beyond dispatch).
pub use ironhorse_meter::REGEXP_GETTER_METERING;
/// The native residual of `%RegExp.prototype%[@@match]` beyond its observable
/// `flags` getter and the `RegExpExec` cost it drives. Calibrated raw-exact.
pub use ironhorse_meter::REGEXP_MATCH_FRAME_METERING;
/// The base native residual of `%RegExp.prototype%[@@search]` beyond the
/// `RegExpExec` cost it drives: the host frame and `lastIndex`
/// save/reset/restore work. Calibrated raw-exact.
pub use ironhorse_meter::REGEXP_SEARCH_FRAME_METERING;
/// The extra residual of `@@search` on a match: the result's `index` property
/// read, skipped on the `-1` no-match path. Calibrated raw-exact.
pub use ironhorse_meter::REGEXP_SEARCH_INDEX_GET_METERING;
/// XS's `e == p` empty-match advance omits six `mxMeterOne` operations that
/// the ordinary successful-step residual includes. Calibrated raw-exact.
pub use ironhorse_meter::REGEXP_SPLIT_EMPTY_ADVANCE_DISCOUNT;
/// The empty-subject path's single-exec residual, beyond the fixed worker
/// frame. Calibrated raw-exact against the pinned XS profile.
pub use ironhorse_meter::REGEXP_SPLIT_EMPTY_METERING;
/// The fixed native residual of `%RegExp.prototype%[@@split]` beyond the
/// observable `SpeciesConstructor`, `flags`, sticky construction, and result
/// array work performed through the ordinary object MOP below. Calibrated
/// raw-exact against the pinned XS profile.
pub use ironhorse_meter::REGEXP_SPLIT_FRAME_METERING;
/// The extra native residual of a successful split step, including the
/// observable `lastIndex` read and the `e == p` branch. Calibrated raw-exact.
pub use ironhorse_meter::REGEXP_SPLIT_MATCH_STEP_METERING;
/// The native residual for each captured value inserted into a split result,
/// beyond its observable property read and result write. Calibrated raw-exact.
pub use ironhorse_meter::REGEXP_SPLIT_PER_CAPTURE_METERING;
/// The per-position native loop residual of `%RegExp.prototype%[@@split]`,
/// beyond the observable `lastIndex` write and abstract `RegExpExec` call.
/// Calibrated raw-exact against the pinned XS profile.
pub use ironhorse_meter::REGEXP_SPLIT_PER_STEP_METERING;
/// The extra residual of a `g`/`y` (stateful) `exec`/`test`: the
/// `fxCacheUnicodeToUTF8Offset` (read `lastIndex`) + `fxCacheUTF8ToUnicode
/// Offset` (write it back) remap framing. Charged on the advancing path.
pub use ironhorse_meter::REGEXP_STATEFUL_METERING;
/// The native residual of `RegExp.prototype.test` beyond the `exec` cost it
/// drives (the `test` host frame + the `mxGetID(_exec)` + `mxRunCount(1)`
/// re-entrant call framing). Calibrated raw-exact.
pub use ironhorse_meter::REGEXP_TEST_FRAME_METERING;
/// The residual of `RegExp.prototype.toString` (`fx_RegExp_prototype_
/// toString`), which reads `source` + `flags` back through `mxGetID` and their
/// accessors (the `flags` get itself the eight-property cascade) and builds
/// the `/source/flags` string. This is the `toString` host frame only; the
/// `flags`-getter cascade and the three growing concat chunks are charged
/// explicitly. Calibrated raw-exact.
pub use ironhorse_meter::REGEXP_TOSTRING_METERING;
/// The shared native residual of `String.prototype.match` and `.search`
/// around their symbol-protocol calls: the String host frame plus the
/// `withRegexp` lookup/call framing. Calibrated raw-exact against direct
/// custom-protocol calls on the pin.
pub use ironhorse_meter::STRING_REGEXP_PROTOCOL_FRAME_METERING;
/// The native residual of `String.prototype.replace` (`fx_String_prototype_
/// replace` → `fx_RegExp_prototype_replace` via the `Symbol.replace` protocol)
/// BEYOND the `exec` cost, the explicit `flags` cascade, the segment-list
/// `fxNewSlot`s + `split_aux`/substitution chunks, and the final assembly
/// chunk: the String host frame, the `withRegexp` dispatch, and the worker's
/// per-match `index`/`0`/`length` gets. Calibrated raw-exact.
pub use ironhorse_meter::STRING_REPLACE_FRAME_METERING;
/// The extra residual of `replace` on a match: the per-match `mxGetID(_index)`
/// + `mxGetIndex(0)` + `mxGetID(_length)` reads (skipped on the no-match
/// unchanged-string path). Calibrated raw-exact.
pub use ironhorse_meter::STRING_REPLACE_MATCH_METERING;
/// The per-capture-group residual of `replace` on a match: the `for (i=1;
/// i<c; i++)` capture-push loop (`mxGetIndex(i)` + `fxToString`) feeding the
/// substitution, one per capture beyond the whole match. Calibrated raw-exact.
pub use ironhorse_meter::STRING_REPLACE_PER_CAPTURE;
/// The native residual of `String.prototype.split`'s successful `@@split`
/// protocol dispatch, beyond the observable method lookup and invocation.
/// Calibrated raw-exact against the pinned XS profile.
pub use ironhorse_meter::STRING_SPLIT_PROTOCOL_FRAME_METERING;
/// `XS_PARSE_REGEXP_METERING` (`xsCommon.h`, `1 << 10`): the raw-per-byte
/// compile meter. Also the divisor recovering the code-buffer byte size
/// (`parser->size`) from a program's `compile_meter_raw`.
pub use ironhorse_meter::XS_PARSE_REGEXP_METERING;

/// Metadata for a user function instance created by
/// `constructor_function`/`function`: the byte range of its body in the
/// program's code buffer (set by the following `code` opcode) and the
/// closure environment it captured (set by `function_environment`). Kept
/// in a side table keyed by the function's slot index so the function
/// object stays a real arena instance whose own properties (`.prototype`,
/// `.length`, `.name`, and user-defined) are real arena slots the GC
/// traces, while the non-value-slot body/closure metadata rides alongside.
/// A bound function's metadata (`Function.prototype.bind`): the target
/// function instance to invoke, the bound `this`, and the bound leading
/// arguments prepended to each call (XS's `_boundFunction`/`_boundThis`/
/// `_boundArguments` internal slots).
#[derive(Clone, Debug)]
struct BoundData {
    target: crate::value::SlotIndex,
    this_arg: Slot,
    args: Vec<Slot>,
}

/// A `Proxy`'s internal slots (`[[ProxyTarget]]` / `[[ProxyHandler]]`, ECMA-262
/// 10.5), kept in the [`Interp::proxies`] side table keyed by the proxy exotic's
/// arena instance slot — the same allocation-faithful shape as [`BoundData`] and
/// the other exotic tables (`arrays`/`collections`/…). A proxy instance is an
/// ordinary `Kind::Instance` slot with a null prototype (a proxy has no identity
/// prototype of its own); its behavior is entirely the trap dispatch keyed off
/// membership here. Revocation nulls both slots and trips `revoked`, after which
/// every internal-method dispatch throws a realm-local `TypeError`.
#[derive(Clone, Debug)]
struct ProxyData {
    target: crate::value::SlotIndex,
    handler: crate::value::SlotIndex,
    revoked: bool,
}

/// Transient metering context for a recursive `Reflect.get(target, key, …)`
/// issued by an active Proxy trap while an Array Iterator performs its
/// `length` or indexed-value Get. It is installed only when the active trap's
/// target is another Proxy and is restored before the trap call returns.
#[derive(Copy, Clone, Debug)]
struct ArrayIteratorProxyGetContext {
    target: crate::value::SlotIndex,
    /// The property the context is aimed at, by [`ReadKey`] rather than by
    /// interned id: an ordinary object's index property has no name, so an
    /// index-keyed read reaches the same target and must charge the same
    /// residual. Compare through [`Interp::refresh_read_key`], never raw —
    /// the trap is guest code and may have interned the index's name while it
    /// ran, which turns the same property from an `Index` into an `Id`.
    key: ReadKey,
    trap_metering: u64,
    meter_terminal_wrapper: bool,
}

/// A property key for an operation that only READS the property world —
/// `[[Get]]`, `[[HasProperty]]`, `[[GetOwnProperty]]`, `[[Delete]]`.
///
/// An array index arrives without a name (XS's `value.at.id == XS_NO_ID` plus
/// `value.at.index`), and none of these operations creates anything, so an
/// index whose canonical name the key table has never held stays an `Index`
/// rather than minting an `Id`: interning per novel index would burn the `u16`
/// id space that [`Interp::next_symbol_key_id`] shares with symbol keys, and
/// that exhaustion poisons the machine rather than throwing. XS mints nothing
/// on these paths either — `fxAt` takes its index branch, and `fxKeyAt` spells
/// a Proxy trap's key from `value.at.index` without touching the key table.
///
/// The name is materialized in exactly one place: a Proxy trap, which is
/// handed the key as a string ([`Interp::read_key_slot`]) spelled from the
/// index, the way `fxKeyAt` spells one.
///
/// Two `ReadKey`s compare equal iff they name the same property, but only
/// once both have been through [`Interp::refresh_read_key`] — an
/// `Index` whose name has since been interned denotes the same property as
/// the `Id` it refreshes to. Guest code runs between a capture and its use
/// (a Proxy trap can name an index mid-flight), so refresh at the point of
/// comparison, not at the point of capture.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
enum ReadKey {
    Id(u16),
    Index(u32),
}

#[derive(Clone, Debug)]
struct FuncInfo {
    /// Start offset of the function body in the program code buffer (the
    /// byte just past the `code` opcode's operand — where `begin_*` sits).
    ///
    /// `None` for any instance that has **no runnable bytecode body**: a
    /// native/method built-in, and — the trap this `Option` exists to defuse
    /// — a **bound function** (`f.bind(...)`), whose callability is realized
    /// only by the bound trampoline ([`Interp::enter_call_bound`] and the
    /// bound arms of [`Interp::run_callback`]). A plain `usize` here was a
    /// loaded gun: `FuncInfo::default()` gave a bound entry `body_start = 0`,
    /// indistinguishable from "program start", so any dispatch site that
    /// missed the bound gate re-executed the whole program from pc 0 inside
    /// the callee frame (unbounded recursion → process abort, or a silently
    /// divergent completion). Now [`Interp::enter_call`] unwraps this with a
    /// loud `Halt`, so a future missed gate self-names instead of recursing.
    body_start: Option<usize>,
    /// Length of the body chunk (the `code` opcode's operand).
    body_len: usize,
    /// The captured closure environment (a frame-cell owner), or `NULL`
    /// until `function_environment` runs / for a non-capturing function.
    closures: crate::value::SlotIndex,
    /// For an intrinsic (native) function — a `Some` marks this instance a
    /// C-backed built-in (XS's `XS_CALLBACK_KIND`) rather than a bytecode
    /// function: `call`/`run` dispatches to the native handler instead of
    /// entering a bytecode frame, and the completion renders as
    /// `function ["name"] (){[native code]}`. `None` for a user function.
    native: Option<Native>,
    /// For a native **prototype method** (`Object.prototype.toString`,
    /// `Function.prototype.toString`, `Error.prototype.toString`, the wrapper
    /// `valueOf`/`toString`, …): dispatched with the call's receiver as
    /// `this`. `None` for a constructor or a user function.
    method: Option<NativeMethod>,
    /// The function's own name (for `Function.prototype.toString`), an empty
    /// string for an anonymous function.
    name: String,
    /// The function's `.length` — its declared arity. XS sets this from the
    /// second byte of the body chunk (`begin`'s parameter-count operand) in
    /// the `code` opcode (`fxNewFunctionLength(the, variable, *(code+1))`,
    /// `xsRun.c`); an own `length` data property (`XS_DONT_ENUM|XS_DONT_SET`)
    /// created at `fxNewFunctionInstance` and updated there. Filled in at
    /// `code`; `0` until then (a native's arity is set when it is bound).
    arity: u32,
    /// The interned chunk of the function's `.name` string, so a `f.name`
    /// read returns the own `name` property without re-allocating (XS's
    /// `name` chunk is built once at `fxNewFunctionName`, folded into the
    /// definition metering, and read for free thereafter). `NULL` until the
    /// name is interned at definition.
    name_chunk: crate::value::ChunkOffset,
    /// `true` for a generator function (`XS_CODE_GENERATOR_FUNCTION`): its
    /// `.prototype` chains to `%GeneratorPrototype%` and its body leads with
    /// `START_GENERATOR`. Recorded for clarity/diagnostics; the body opcode
    /// drives the actual generator-object creation.
    is_generator: bool,
    /// The class/method home object used by `super` property references.
    /// `NULL` for ordinary functions.
    home: crate::value::SlotIndex,
    /// `Some(false)` for a base-class constructor, `Some(true)` for a derived
    /// constructor, and `None` for an ordinary function.
    class_derived: Option<bool>,
}

/// The `Math` static functions ironhorse models (`xsMath.c`). Each is a
/// property of the `Math` namespace object, dispatched through
/// [`NativeMethod::Math`] ignoring the receiver. The bodies carry **no**
/// `mxMeterSome` (verified against the pin: `grep -c mxMeter xsMath.c` is
/// 0), so a Math call's whole computron cost is the native host frame
/// ([`MATH_FRAME_METERING`]); the result NaN is the canonical `f64::NAN`
/// (`C_NAN`), which the design flags consensus-critical.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum MathId {
    Abs,
    Acos,
    Acosh,
    Asin,
    Asinh,
    Atan,
    Atanh,
    Atan2,
    Cbrt,
    Ceil,
    Clz32,
    Cos,
    Cosh,
    Exp,
    Expm1,
    Floor,
    Fround,
    Hypot,
    Imul,
    Log,
    Log1p,
    Log10,
    Log2,
    Max,
    Min,
    Pow,
    Round,
    Sign,
    Sin,
    Sinh,
    Sqrt,
    Tan,
    Tanh,
    Trunc,
}

/// A native prototype method ironhorse models (dispatched with the receiver as
/// `this`). Some methods invoke guest callbacks or accessors; their bodies
/// use the interpreter's re-entry and exception machinery.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub enum NativeMethod {
    /// `%Function.prototype%` itself is a callable, non-constructable built-in
    /// that accepts any arguments and returns `undefined`.
    FunctionPrototype,
    /// `Date` statics and prototype methods. The compact operation id keeps
    /// the calendar implementation centralized; see `date_method`.
    Date(u8),
    /// A method on one of the ISO Temporal plain families.  The first byte is
    /// the family (date, time, date-time, year-month, month-day, calendar),
    /// and the second is the operation.  Keeping this compact makes the
    /// shared ISO algorithms below genuinely shared instead of six copied
    /// native dispatch tables.
    TemporalPlain(u8, u8),
    /// A `Temporal.ZonedDateTime` static or prototype method.  The byte is the
    /// operation code dispatched in [`Interp::temporal_zoned_method`].
    TemporalZoned(u8),
    /// A `Temporal.Now` namespace function.  The byte selects the hook
    /// (`instant`, `timeZoneId`, `zonedDateTimeISO`, …) in
    /// [`Interp::temporal_now_method`].
    TemporalNow(u8),
    TemporalInstantFrom,
    TemporalInstantFromEpochMilliseconds,
    TemporalInstantFromEpochNanoseconds,
    TemporalInstantCompare,
    TemporalInstantAdd,
    TemporalInstantSubtract,
    TemporalInstantUntil,
    TemporalInstantSince,
    TemporalInstantRound,
    TemporalInstantEquals,
    TemporalInstantToString,
    TemporalInstantToJSON,
    TemporalInstantValueOf,
    TemporalDurationFrom,
    TemporalDurationCompare,
    TemporalDurationWith,
    TemporalDurationNegated,
    TemporalDurationAbs,
    TemporalDurationAdd,
    TemporalDurationSubtract,
    TemporalDurationRound,
    TemporalDurationTotal,
    TemporalDurationToString,
    TemporalDurationToJSON,
    TemporalDurationValueOf,
    IntlGetCanonicalLocales,
    IntlSupportedValuesOf,
    IntlSupportedLocalesOf,
    LocaleToString,
    LocaleMaximize,
    LocaleMinimize,
    CollatorResolvedOptions,
    CollatorCompare,
    ListFormatFormat,
    ListFormatFormatToParts,
    ListFormatResolvedOptions,
    PluralRulesSelect,
    PluralRulesSelectRange,
    PluralRulesResolvedOptions,
    SegmenterSegment,
    SegmenterResolvedOptions,
    SegmentsContaining,
    SegmentsIterator,
    SegmentIteratorNext,
    SegmentIteratorSymbolIterator,
    DateTimeFormatFormat,
    DateTimeFormatFormatToParts,
    DateTimeFormatFormatRange,
    DateTimeFormatFormatRangeToParts,
    DateTimeFormatResolvedOptions,
    NumberFormatFormat,
    /// `get Intl.NumberFormat.prototype.format` — the accessor **getter**
    /// (name `"get format"`, length 0). Returns the receiver's cached
    /// `[[BoundFormat]]` function, creating it on first read.
    NumberFormatFormatGetter,
    /// The cached `[[BoundFormat]]` function (an anonymous, length-1 built-in)
    /// the `format` getter returns: calling `boundFormat(value)` formats
    /// `value` with the NumberFormat the getter was read from.
    NumberFormatBoundFormat,
    NumberFormatFormatToParts,
    NumberFormatFormatRange,
    NumberFormatFormatRangeToParts,
    NumberFormatResolvedOptions,
    /// The internal `%CopyObject%` helper used by object spread and object
    /// rest. It copies the source's own enumerable properties to `this`.
    CopyObject,
    ObjectToString,
    /// `Object.prototype.toLocaleString()` invokes the receiver's live
    /// `toString` method.
    ObjectToLocaleString,
    ObjectHasOwnProperty,
    ObjectValueOf,
    ObjectIsPrototypeOf,
    /// `Object.is(x, y)` — ECMAScript SameValue (NaN equals NaN, signed
    /// zeros differ, and objects compare by identity).
    ObjectIs,
    /// `Object.hasOwn(object, key)` — `HasOwnProperty(? ToObject(object),
    /// ? ToPropertyKey(key))`.
    ObjectHasOwn,
    /// `Object.assign(target, ...sources)` — copy each source's live own
    /// enumerable string and symbol properties through the object MOP.
    ObjectAssign,
    /// `Object.fromEntries(iterable)` for the dense-Array iterable path. Entry
    /// objects are read by keys `0` and `1` (not iterated themselves).
    ObjectFromEntries,
    /// `Object.keys(o)` — the own enumerable string-keyed property names, in
    /// property-creation order, as a fresh `Array` of interned key strings.
    ObjectKeys,
    /// `Object.create(proto[, properties])` for ordinary prototypes and the
    /// same descriptor machinery as `Object.defineProperties`.
    ObjectCreate,
    /// `Object.getOwnPropertyDescriptor(o, k)` — the fully-populated data
    /// descriptor object (`{value, writable, enumerable, configurable}`) for
    /// `o`'s own property `k`, or `undefined` when absent.
    ObjectGetOwnPropertyDescriptor,
    /// `Object.getOwnPropertyNames(o)` — all own string keys, including
    /// non-enumerable Error `message`/`cause` properties.
    ObjectGetOwnPropertyNames,
    /// `Object.defineProperty(o, k, descriptor)` — define a **new** own data
    /// property on an ordinary object from a full four-field data descriptor
    /// (`{value, writable, enumerable, configurable}`), storing the
    /// `writable`/`enumerable`/`configurable` booleans as XS's property flag
    /// byte (`XS_DONT_SET_FLAG`/`XS_DONT_ENUM_FLAG`/`XS_DONT_DELETE_FLAG`) so
    /// the attributes ripple through `Object.keys` (the enumerable filter) and
    /// `getOwnPropertyDescriptor` (the flag → descriptor readback). Returns
    /// the object. The verifyProperty machinery. A partial/accessor
    /// descriptor, a redefine of an existing key, or an exotic receiver
    /// self-names.
    ObjectDefineProperty,
    /// `Object.defineProperties(o, descriptors)`; descriptors are snapshotted
    /// before any definition and then applied through the ordinary MOP seam.
    ObjectDefineProperties,
    /// `Object.getOwnPropertyDescriptors(o)` — a fresh object mapping each own
    /// property key to its descriptor object (the plural of
    /// `getOwnPropertyDescriptor`).
    ObjectGetOwnPropertyDescriptors,
    /// `Object.getOwnPropertySymbols(o)` in symbol creation order.
    ObjectGetOwnPropertySymbols,
    /// `Object.values(o)` — a fresh `Array` of `o`'s own enumerable
    /// string-keyed property values, in creation order.
    ObjectValues,
    /// `Object.entries(o)` — a fresh `Array` of `[key, value]` two-element
    /// arrays for `o`'s own enumerable string-keyed properties, in creation
    /// order.
    ObjectEntries,
    /// `Object.preventExtensions(o)` — mark the instance non-extensible
    /// (`XS_DONT_PATCH_FLAG`), returning it.
    ObjectPreventExtensions,
    /// `Object.seal(o)` — prevent extensions and mark every own property
    /// non-configurable (`XS_DONT_DELETE_FLAG`), returning it.
    ObjectSeal,
    /// `Object.freeze(o)` — prevent extensions and mark every own data
    /// property non-configurable and non-writable
    /// (`XS_DONT_DELETE_FLAG|XS_DONT_SET_FLAG`), returning it.
    ObjectFreeze,
    /// `Object.isExtensible(o)` — whether the instance is still extensible.
    ObjectIsExtensible,
    /// `Object.isSealed(o)` — non-extensible and every own property
    /// non-configurable.
    ObjectIsSealed,
    /// `Object.isFrozen(o)` — non-extensible and every own data property
    /// non-configurable and non-writable.
    ObjectIsFrozen,
    /// `Object.prototype.propertyIsEnumerable(k)` — whether `k` is an own
    /// enumerable property of the receiver.
    ObjectPropertyIsEnumerable,
    /// `Reflect.getPrototypeOf(target)` (`fx_Reflect_getPrototypeOf` →
    /// `mxBehaviorGetPrototype`): the target's `[[Prototype]]` — a reference to
    /// the prototype instance, or `null` for a null-prototype object. A
    /// non-object target self-names (XS throws a TypeError; the covered grammar
    /// never passes a primitive here).
    ReflectGetPrototypeOf,
    /// `Reflect.setPrototypeOf(target, proto)` (`fx_Reflect_setPrototypeOf` →
    /// `mxBehaviorSetPrototype`): install `proto` (an object or `null`) as the
    /// target's `[[Prototype]]`, returning whether it succeeded — `false` only
    /// when the target is non-extensible and `proto` differs from the current
    /// prototype. Ordinary receivers only (an exotic side-table object skips).
    ReflectSetPrototypeOf,
    ReflectIsExtensible,
    ReflectPreventExtensions,
    /// `Reflect.getOwnPropertyDescriptor(target, key)`
    /// (`fx_Reflect_getOwnPropertyDescriptor`): identical result to
    /// `Object.getOwnPropertyDescriptor` (the data-descriptor object or
    /// `undefined`), but a non-object target self-names rather than coercing.
    ReflectGetOwnPropertyDescriptor,
    /// `Reflect.defineProperty(target, key, descriptor)`
    /// (`fx_Reflect_defineProperty` → `mxBehaviorDefineOwnProperty`): the same
    /// new-own-data-property define as `Object.defineProperty`, but returns a
    /// **boolean** (`true` on success) instead of the object and never throws
    /// on rejection. The covered shape is the four-field data descriptor on a
    /// genuinely-new key of an ordinary receiver.
    ReflectDefineProperty,
    /// `Reflect.ownKeys(target)` (`fx_Reflect_ownKeys` → `mxBehaviorOwnKeys`):
    /// a fresh `Array` of **all** own string-keyed property names (enumerable
    /// or not), in creation order. Ordinary receivers with string keys only;
    /// an exotic object or an unclassifiable key self-names.
    ReflectOwnKeys,
    /// `Reflect.has(target, key)` (`fx_Reflect_has` → `mxBehaviorHasProperty`):
    /// the `key in target` chain walk as a boolean. Same soundness gate as the
    /// `in` operator (a boot default-key name the program never referenced
    /// self-names rather than risk a wrong `false`).
    ReflectHas,
    /// `Reflect.get(target, key[, receiver])` (`fx_Reflect_get` →
    /// `mxBehaviorGetProperty`): the own-or-inherited data-property value (the
    /// `receiver` argument is irrelevant to a data property, so it is ignored).
    /// Same default-key soundness gate as `has`.
    ReflectGet,
    /// `Reflect.set(target, key, value[, receiver])` (`fx_Reflect_set` →
    /// `mxBehaviorSetProperty`): an ordinary `[[Set]]` returning whether it was
    /// accepted — `false` when the own data property is non-writable or a new
    /// key lands on a non-extensible receiver, `true` otherwise (creating or
    /// updating the own property).
    ReflectSet,
    /// `Reflect.deleteProperty(target, key)` (`fx_Reflect_deleteProperty` →
    /// `mxBehaviorDeleteProperty`): the ordinary own-property delete as a
    /// boolean (`false` for a non-configurable own property, `true` otherwise
    /// or when absent).
    ReflectDeleteProperty,
    /// `Reflect.apply(target, thisArgument, argumentsList)` — an honest named
    /// skip this child: the argument-list spread re-enters the interpreter
    /// frame machinery (the same re-entrant trampoline as
    /// `Function.prototype.apply` with an actual array), whose metering is a
    /// later increment.
    ReflectApply,
    /// `Reflect.construct(target, argumentsList[, newTarget])` — an honest
    /// named skip this child: re-entrant construction with a spread argument
    /// list, out of the covered trampoline scope.
    ReflectConstruct,
    /// `Proxy.revocable(target, handler)` (`xsProxy.c` `fx_Proxy_revocable`):
    /// returns `{ proxy, revoke }` where `revoke` is a
    /// [`NativeMethod::ProxyRevoke`] function bound (via
    /// [`Interp::proxy_revokers`]) to the freshly-minted proxy.
    ProxyRevocable,
    /// The `revoke` function `Proxy.revocable` returns: trips its proxy's
    /// `[[ProxyTarget]]`/`[[ProxyHandler]]` to null and marks it revoked.
    ProxyRevoke,
    /// `Object.getPrototypeOf(O)` (`fx_Object_getPrototypeOf`): the object's
    /// `[[GetPrototypeOf]]` — routes through the proxy `getPrototypeOf` trap.
    ObjectGetPrototypeOf,
    /// `Object.setPrototypeOf(O, proto)` (`fx_Object_setPrototypeOf`): the
    /// object's `[[SetPrototypeOf]]` — routes through the proxy trap.
    ObjectSetPrototypeOf,
    FunctionToString,
    /// `Function.prototype.call` — a re-entrant trampoline: invoke the
    /// receiver function with the first argument as `this` and the rest as
    /// its arguments. Handled specially in the `run` dispatch (it re-enters
    /// the interpreter frame machinery rather than computing a value).
    FunctionCall,
    /// `Function.prototype.apply` — like `call`, but the arguments come from
    /// an array. ironhorse models the no-array subset (`f.apply(thisArg)` /
    /// `f.apply(thisArg, null|undefined)`), identical to `call` with no
    /// arguments; an actual arguments array self-names (the Array read is
    /// child-3 machinery).
    FunctionApply,
    /// `Function.prototype.bind(thisArg, ...boundArgs)`
    /// (`fx_Function_prototype_bind`): create a **bound function** — a fresh
    /// callable whose `.length` is the target's own `.length` minus the bound
    /// arg count (floored at 0), `.name` is `"bound "` + the target's name,
    /// and which, when called, invokes the target with the bound `this` and
    /// the bound args prepended to the call args (`fx_Function_prototype_
    /// bound`). Handled in `call_native_method` (creation); the bound
    /// function's later invocation is a separate trampoline in the `run`
    /// dispatch.
    FunctionBind,
    /// `Function.prototype[Symbol.hasInstance](value)`: the public
    /// `OrdinaryHasInstance(this, value)` entry point inherited by callable
    /// objects and consulted by the `instanceof` operator.
    FunctionHasInstance,
    ErrorToString,
    DisposableStackUse,
    DisposableStackAdopt,
    DisposableStackDefer,
    DisposableStackMove,
    DisposableStackDispose,
    AsyncDisposableStackUse,
    AsyncDisposableStackAdopt,
    AsyncDisposableStackDefer,
    AsyncDisposableStackMove,
    AsyncDisposableStackDisposeAsync,
    /// A primitive wrapper's `valueOf` (returns the wrapped primitive).
    WrapperValueOf,
    /// A primitive wrapper's `toString` (stringifies the wrapped primitive).
    WrapperToString,
    /// `Symbol.prototype.toString()` (`fx_Symbol_prototype_toString` →
    /// `fxSymbolToString`): the descriptive string `Symbol(<description>)`.
    SymbolToString,
    /// `Symbol.prototype.valueOf()` (`fx_Symbol_prototype_valueOf`): the
    /// symbol primitive itself (unwrapping a Symbol wrapper object, though
    /// ironhorse's covered grammar has only the primitive receiver).
    SymbolValueOf,
    /// `Symbol.prototype[Symbol.toPrimitive](hint)`: the symbol primitive
    /// itself, unwrapping a Symbol wrapper object. The hint is ignored.
    SymbolToPrimitive,
    /// `get Symbol.prototype.description` (`fx_Symbol_prototype_get_
    /// description`): the accessor **getter** (name `"get description"`,
    /// length 0) over the receiver's `[[Description]]` — the description slot
    /// a `Symbol(desc)` call coerced to a String, or `undefined` when the
    /// symbol was created without one. Brand-checked like its `toString`/
    /// `valueOf` siblings, so a non-Symbol receiver is a `TypeError`.
    SymbolDescriptionGetter,
    /// `Date.prototype[Symbol.toPrimitive](hint)`: validate the string hint,
    /// then perform ordinary conversion in string order for `"string"` and
    /// `"default"`, or number order for `"number"`.
    DateToPrimitive,
    /// `BigInt.prototype.toString([radix])`: render the primitive/wrapper
    /// receiver in radix 2 through 36.
    BigIntToString,
    /// `BigInt.prototype.toLocaleString([locales[, options]])`.
    BigIntToLocaleString,
    /// `BigInt.prototype.valueOf()`: unwrap a BigInt wrapper or return a
    /// primitive BigInt receiver unchanged.
    BigIntValueOf,
    /// `BigInt.asIntN(bits, bigint)`: truncate to a signed `bits`-wide value.
    BigIntAsIntN,
    /// `BigInt.asUintN(bits, bigint)`: truncate to an unsigned `bits`-wide
    /// value.
    BigIntAsUintN,
    /// `Symbol.for(key)` (`fx_Symbol_for`): the shared registry symbol for
    /// `key` — the same symbol on repeat calls (registry-interned identity).
    SymbolFor,
    /// `Symbol.keyFor(sym)` (`fx_Symbol_keyFor`): the registry key a
    /// registered symbol was interned under, or `undefined`.
    SymbolKeyFor,
    /// `Array.prototype.push(...items)` — the **dense** fast path
    /// (`fx_Array_prototype_push` with `fxCheckArray` succeeding): append the
    /// arguments and return the new length. A sparse receiver (holes) takes
    /// XS's generic slow path (different metering), so ironhorse self-names it an
    /// honest skip.
    ArrayPush,
    /// `Array.prototype.pop()` — the dense fast path
    /// (`fx_Array_prototype_pop`): remove and return the last element (or
    /// `undefined` on an empty array), shrinking the item chunk.
    ArrayPop,
    /// `Array.prototype.indexOf(value[, from])` — the dense fast path
    /// (`fx_Array_prototype_indexOf`): the first index at which `value` is
    /// found by strict equality, or `-1`.
    ArrayIndexOf,
    /// `Array.prototype.join([sep])` — the dense fast path
    /// (`fx_Array_prototype_join`): the elements stringified and joined by
    /// `sep` (default `","`), holes/`undefined`/`null` contributing empty.
    ArrayJoin,
    /// `Array.prototype.includes(value[, from])` — dense fast path
    /// (`fx_Array_prototype_includes`): whether `value` is an element (by
    /// SameValueZero), scanning from `from`.
    ArrayIncludes,
    /// `Array.prototype.lastIndexOf(value[, from])` — dense fast path: the last
    /// index at which `value` is found (strict equality) scanning backward, or
    /// `-1`.
    ArrayLastIndexOf,
    /// `Array.prototype.fill(value[, start[, end]])` — dense fast path
    /// (`fx_Array_prototype_fill`): set `[start, end)` to `value`, returning
    /// the array.
    ArrayFill,
    /// `Array.prototype.reverse()` — dense fast path
    /// (`fx_Array_prototype_reverse`): reverse the elements in place, returning
    /// the array.
    ArrayReverse,
    /// `Array.prototype.slice([start[, end]])` — dense fast path
    /// (`fx_Array_prototype_slice`): a new array with the elements of
    /// `[start, end)`.
    ArraySlice,
    /// `Array.prototype.concat(...args)` — dense fast path
    /// (`fx_Array_prototype_concat`): a new array of the receiver's elements
    /// followed by each argument (spreading array arguments).
    ArrayConcat,
    /// `Array.prototype.at(index)` — dense fast path (`fx_Array_prototype_at`):
    /// the element at `index` (negative counts from the end), or `undefined`.
    ArrayAt,
    /// `Array.prototype.shift()` — dense fast path (`fx_Array_prototype_shift`):
    /// remove and return the first element, shifting the rest down.
    ArrayShift,
    /// `Array.prototype.unshift(...items)` — dense fast path
    /// (`fx_Array_prototype_unshift`): prepend the arguments, returning the new
    /// length.
    ArrayUnshift,
    /// `Array.prototype.copyWithin(target[, start[, end]])` — dense fast path
    /// (`fx_Array_prototype_copyWithin`): copy the block `[start, end)` to
    /// `target` in place, returning the array.
    ArrayCopyWithin,
    /// `Array.prototype.with(index, value)` (`fx_Array_prototype_with`): a new
    /// array copying the receiver with `index` replaced by `value` (negative
    /// index counts from the end; out-of-range is a RangeError).
    ArrayWith,
    /// `Array.prototype.forEach(callback[, thisArg])`
    /// (`fx_Array_prototype_forEach`): call `callback(item, index, array)` for
    /// each present element; returns `undefined`. The first re-entrant method
    /// (drives a user callback per element via [`Interp::run_callback`]).
    ArrayForEach,
    /// `Array.prototype.map(callback[, thisArg])`: a new array of the callback
    /// results, one per element.
    ArrayMap,
    /// `Array.prototype.some(callback[, thisArg])`: `true` if the callback is
    /// truthy for any element (short-circuits).
    ArraySome,
    /// `Array.prototype.every(callback[, thisArg])`: `true` if the callback is
    /// truthy for every element (short-circuits on the first falsy).
    ArrayEvery,
    /// `Array.prototype.find(callback[, thisArg])`: the first element for which
    /// the callback is truthy, or `undefined`.
    ArrayFind,
    /// `Array.prototype.findIndex(callback[, thisArg])`: the index of the first
    /// element for which the callback is truthy, or `-1`.
    ArrayFindIndex,
    /// `Array.prototype.filter(callback[, thisArg])`: a new array of the
    /// elements for which the callback is truthy.
    ArrayFilter,
    /// `Array.prototype.reduce(callback[, initial])`: fold left with
    /// `callback(acc, item, index, array)`.
    ArrayReduce,
    /// `Array.prototype.reduceRight(callback[, initial])`: fold right.
    ArrayReduceRight,
    /// `Array.prototype.findLast(callback[, thisArg])`: the last element for
    /// which the callback is truthy, or `undefined`.
    ArrayFindLast,
    /// `Array.prototype.findLastIndex(callback[, thisArg])`: the index of the
    /// last element for which the callback is truthy, or `-1`.
    ArrayFindLastIndex,
    /// `Array.prototype.toReversed()` (`fx_Array_prototype_toReversed`): a new
    /// array with the receiver's elements reversed (non-mutating).
    ArrayToReversed,
    /// `Array.prototype.splice(start[, deleteCount, ...items])`
    /// (`fx_Array_prototype_splice`): remove `deleteCount` elements at `start`
    /// and insert `items`, returning a new array of the removed elements.
    ArraySplice,
    /// `Array.prototype.flat([depth])` (`fx_Array_prototype_flat`): a new array
    /// with sub-array elements flattened to `depth` (default 1).
    ArrayFlat,
    /// `Array.prototype.flatMap(callback[, thisArg])`
    /// (`fx_Array_prototype_flatMap`): map then flatten by one level.
    ArrayFlatMap,
    /// `Array.prototype.toSpliced(start, deleteCount, ...items)`
    /// (`fx_Array_prototype_toSpliced`): a non-mutating splice into a new array.
    ArrayToSpliced,
    /// `Array.prototype.toString()` (`fx_Array_prototype_toString`): delegates
    /// to `this.join()` with the default separator (spec 23.1.3.36).
    ArrayToString,
    /// `Array.prototype.sort([comparator])`.
    ArraySort,
    /// `Array.prototype.toSorted([comparator])`.
    ArrayToSorted,
    /// `Array.prototype.toLocaleString()` invokes non-nullish elements'
    /// locale-string methods, with empty fields for holes and nullish values.
    ArrayToLocaleString,
    /// `%TypedArray%.prototype.copyWithin(target, start, end)`.
    TypedArrayCopyWithin,
    /// `%TypedArray%.prototype.fill(value, start, end)`.
    TypedArrayFill,
    /// `%TypedArray%.prototype.set(source, offset)`.
    TypedArraySet,
    /// `%TypedArray%.prototype.reverse()`.
    TypedArrayReverse,
    /// `%TypedArray%.prototype.join(separator)`.
    TypedArrayJoin,
    /// `%TypedArray%.prototype.values()` / `keys()` / `entries()`.
    TypedArrayValues,
    TypedArrayKeys,
    TypedArrayEntries,
    /// `%TypedArray%.prototype.slice(start, end)` / `subarray(begin, end)`.
    TypedArraySlice,
    TypedArraySubarray,
    /// `%TypedArray%.prototype.map(callback, thisArg)` / `filter(...)`.
    TypedArrayMap,
    TypedArrayFilter,
    /// `%TypedArray%.prototype.sort(comparefn)`.
    TypedArraySort,
    /// `%TypedArray%.prototype.toLocaleString([locales[, options]])`.
    TypedArrayToLocaleString,
    /// Non-allocating shared TypedArray methods. Operation ids select
    /// `forEach`, `every`, `some`, `find`, `findIndex`, `includes`, `indexOf`,
    /// `lastIndexOf`, `reduce`, and `reduceRight`, in that order.
    TypedArrayReadonly(u8),
    /// Shared `%TypedArray%.prototype` view accessors.
    TypedArrayLengthGetter,
    TypedArrayByteLengthGetter,
    TypedArrayByteOffsetGetter,
    TypedArrayBufferGetter,
    TypedArrayToStringTagGetter,
    /// `%TypedArray%.from` / `%TypedArray%.of`, inherited by concrete
    /// TypedArray constructors.
    TypedArrayFrom,
    TypedArrayOf,
    /// `Array.from(iterable[, mapFn[, thisArg]])`, including guest iterator,
    /// mapper and constructor calls under a native exception boundary.
    ArrayFrom,
    /// `Array.fromAsync(...)` returns a promise and drives iterator adoption
    /// through the native `FromAsyncData` state machine.
    ArrayFromAsync,
    /// `Array.isArray(v)` — a static on the `Array` constructor: whether `v`
    /// is an array exotic object.
    ArrayIsArray,
    /// `Array.of(...items)` — a static: a new array whose elements are the
    /// arguments (always elements, never a length).
    ArrayOf,
    /// `Array.prototype.values()` / `keys()` / `entries()`
    /// (`fx_Array_prototype_values` &co.): construct an Array Iterator over the
    /// receiver with the given kind (0 values / 1 keys / 2 entries).
    ArrayValues,
    ArrayKeys,
    ArrayEntries,
    /// `%ArrayIteratorPrototype%.next()` (`fx_ArrayIterator_prototype_next`):
    /// yield the next `{value, done}` (mutating and returning the iterator's
    /// reused result object).
    ArrayIteratorNext,
    /// A `Math.*` static (`xsMath.c`), dispatched ignoring the receiver.
    Math(MathId),
    /// `String.prototype.charCodeAt(pos)` (`fx_String_prototype_charCodeAt`):
    /// the UTF-16 code unit at `pos`, or `NaN` when out of range. No
    /// `mxMeterSome`; the result is a number (no chunk).
    StringCharCodeAt,
    /// `String.prototype.codePointAt(pos)` (`fx_String_prototype_codePointAt`):
    /// the code point at `pos`, or `undefined` out of range.
    StringCodePointAt,
    /// `String.prototype.charAt(pos)` (`fx_String_prototype_charAt`): the
    /// one-character string at `pos` (empty string out of range). Allocates
    /// the result chunk.
    StringCharAt,
    /// `String.prototype.at(index)` (`fx_String_prototype_at`): the character
    /// at `index` (negative counts from the end), `undefined` out of range.
    StringAt,
    /// `String.prototype.slice([start[,end]])` (`fx_String_prototype_slice`):
    /// the substring `[start,end)` with negative offsets from the end.
    StringSlice,
    /// `String.prototype.substring([start[,end]])`
    /// (`fx_String_prototype_substring`): the substring between the clamped,
    /// swapped-if-needed offsets.
    StringSubstring,
    /// `String.prototype.indexOf(search[,from])`
    /// (`fx_String_prototype_indexOf`): the first index of `search` at or after
    /// `from`, or `-1`. Meters one `mxMeterSome` per non-continuation scanned
    /// byte.
    StringIndexOf,
    /// `String.prototype.lastIndexOf(search[,from])`
    /// (`fx_String_prototype_lastIndexOf`): the last index of `search`, or `-1`.
    StringLastIndexOf,
    /// `String.prototype.includes(search[,from])`
    /// (`fx_String_prototype_includes`): whether `search` occurs.
    StringIncludes,
    /// `String.prototype.startsWith(search[,from])`
    /// (`fx_String_prototype_startsWith`).
    StringStartsWith,
    /// `String.prototype.endsWith(search[,end])`
    /// (`fx_String_prototype_endsWith`).
    StringEndsWith,
    /// `String.prototype.concat(...args)` (`fx_String_prototype_concat`):
    /// the receiver followed by each stringified argument; `mxMeterSome(argc)`
    /// plus the result chunk.
    StringConcat,
    /// `String.prototype.toLowerCase()` / `toUpperCase()`
    /// (`fx_String_prototype_toCase`): locale-insensitive Unicode case mapping
    /// over scalar runs, preserving unpaired UTF-16 surrogates;
    /// `mxMeterSome(count)` plus the result chunk.
    StringToLowerCase,
    StringToUpperCase,
    /// Locale-aware string casing. The frozen Intl profile uses Unicode
    /// default casing plus Turkish/Azeri dotted-I specialization.
    StringToLocaleLowerCase,
    StringToLocaleUpperCase,
    /// `String.prototype.localeCompare(that[, locales[, options]])`.
    StringLocaleCompare,
    /// `String.prototype.normalize([form])`: Unicode NFC/NFD/NFKC/NFKD
    /// normalization over scalar runs, preserving unpaired UTF-16 surrogates.
    StringNormalize,
    /// `String.prototype.repeat(count)` (`fx_String_prototype_repeat`): the
    /// receiver repeated `count` times; `mxMeterSome(count)` plus the result
    /// chunk. A negative/`Infinity` count is a RangeError.
    StringRepeat,
    /// `String.prototype.trim()`/`trimStart()`/`trimEnd()`
    /// (`fx_String_prototype_trim*`): the receiver with ASCII/Unicode
    /// whitespace stripped. ASCII-whitespace fast path.
    StringTrim,
    StringTrimStart,
    StringTrimEnd,
    /// `String.prototype.padStart` / `padEnd`.
    StringPadStart,
    StringPadEnd,
    /// ES2024 well-formed Unicode string predicates/conversion.
    StringIsWellFormed,
    StringToWellFormed,
    /// `String.fromCharCode` / `String.fromCodePoint` constructor statics.
    StringFromCharCode,
    StringFromCodePoint,
    /// `String.raw(template, ...substitutions)`: concatenate the observable
    /// `template.raw` array-like segments with the corresponding substitutions.
    StringRaw,
    /// `String.prototype[Symbol.iterator]()`.
    StringIterator,
    /// `Number.isFinite`/`isInteger`/`isNaN`/`isSafeInteger` (`xsNumber.c`) —
    /// statics on the `Number` constructor that inspect the argument's slot
    /// **kind** directly (no coercion): an integer is always finite/integer/
    /// safe and never NaN; a number defers to its `fpclassify`.
    NumberIsFinite,
    NumberIsInteger,
    NumberIsNaN,
    NumberIsSafeInteger,
    /// `Number.prototype.toString([radix])` (`fx_Number_prototype_toString`):
    /// radix-10 renders through `fxNumberToString` (the `Number::toString`
    /// spelling); a radix in `[2,36]` runs XS's digit conversion. Allocates
    /// the result chunk.
    NumberToString,
    /// `Number.prototype.toLocaleString([locales[, options]])`.
    NumberToLocaleString,
    /// The global `parseInt(string[,radix])` (`fx_parseInt`): the integer
    /// prefix parse. No `mxMeterSome`, no chunk.
    GlobalParseInt,
    /// The global `parseFloat(string)` (`fx_parseFloat`): the float prefix
    /// parse (`fxStringToNumber` with `whole = 0`). No chunk.
    GlobalParseFloat,
    /// The global `isNaN(x)` / `isFinite(x)` (`fx_isNaN`/`fx_isFinite`):
    /// `fxToNumber` then the `fpclassify` test. No chunk.
    GlobalIsNaN,
    GlobalIsFinite,
    /// The global `harden(x)` (`fx_harden`, `xsLockdown.c`): the transitive
    /// freeze worklist over the slot arena — prevent extensions and stamp
    /// every own data property non-writable/non-configurable (accessors
    /// non-configurable), then queue the prototype and every reference-valued
    /// property, marking each reached instance `XS_DONT_MARSHALL_FLAG`. Returns
    /// `x`. `xsLockdown.c` calls no `mxMeter`, so the cost is allocation-driven
    /// (the worklist `fxNewSlot`s + the two `fxNewInstance` ownKeys holders per
    /// object). Ironhorse's intrinsics are modeled sparsely, so the transitive
    /// object count diverges from the pin — the freeze *result* is faithful,
    /// the computron count over an intrinsic-spilling walk is not (a structural
    /// divergence, the same sparse-intrinsics fact the module/compartment
    /// children record). Result-gated corpus.
    GlobalHarden,
    /// The global `petrify(x)` (`fx_petrify`, `xsLockdown.c`): a *single*-object
    /// freeze (non-transitive) — prevent extensions, stamp every own property
    /// non-writable/non-configurable, and additionally stamp the internal data
    /// slots (ArrayBuffer/Date/Map/Set/WeakMap/WeakSet) `XS_DONT_SET_FLAG`.
    /// Returns `x`. Allocation-driven metering (the one `fxNewInstance` ownKeys
    /// holder + its at-slots).
    GlobalPetrify,
    /// `$262.detachArrayBuffer(buffer)`, the test262 host hook.
    Test262DetachArrayBuffer,
    /// `JSON.stringify(value)` (`fx_JSON_stringify`): serialize `value` over
    /// XS's traversal order. The stringifier's working buffer is C-malloc'd
    /// (unmetered); only the final `fxNewChunk(offset)` meters. The
    /// no-replacer / no-space subset is modeled; a replacer, a space argument,
    /// a `toJSON` method, or a wrapper/BigInt value self-names an honest skip.
    JsonStringify,
    /// `JSON.parse(text)` (`fx_JSON_parse`): parse `text` to a value.
    JsonParse,
    /// `Map.prototype.set(k, v)` / `WeakMap.prototype.set(k, v)`
    /// (`fx_Map_prototype_set` / `fx_WeakMap_prototype_set`): insert or update
    /// the entry, returning the receiver. A new key allocates the entry slots
    /// (`fxSetEntry`/`fxSetWeakEntry`) — the sole metering (xsMapSet.c calls no
    /// `mxMeter`); an existing key updates in place, allocation-free.
    MapSet,
    /// `Map.prototype.get(k)` / `WeakMap.prototype.get(k)`: the value for `k`,
    /// or `undefined`. Allocation-free (`fxGetEntry`/`fxGetWeakEntry`).
    MapGet,
    /// `Map.prototype.has(k)` / `WeakMap.prototype.has(k)`: membership.
    MapHas,
    /// `Map.prototype.delete(k)` / `WeakMap.prototype.delete(k)`: remove and
    /// report whether present. A Map shrink may reallocate the address chunk
    /// (`fxResizeEntries`); a WeakMap unlink is allocation-free.
    MapDelete,
    /// `Map.prototype.getOrInsert(key, value)` (upsert proposal): return the
    /// existing value for `key`, or insert `value` under the canonicalized key
    /// and return it. Requires a real `[[MapData]]` receiver.
    MapGetOrInsert,
    /// `Map.prototype.getOrInsertComputed(key, callbackfn)` (upsert proposal):
    /// return the existing value for `key`; on absence call `callbackfn(key)`
    /// exactly once (the canonicalized key, `this` undefined), then insert its
    /// result under the key (overwriting any entry the callback itself added)
    /// and return it. Re-entrant (drives a user callback).
    MapGetOrInsertComputed,
    /// `Map.groupBy(items, callbackfn)` (array-grouping proposal): a static on
    /// the `Map` constructor. Iterate `items`, call `callbackfn(value, index)`
    /// per element, bucket each value into an Array keyed by the callback result
    /// under SameValueZero (`-0`→`+0`), and return a fresh `Map`. Re-entrant.
    MapGroupBy,
    /// `Object.groupBy(items, callbackfn)` (array-grouping proposal): like
    /// `Map.groupBy` but buckets under `? ToPropertyKey(key)` into a fresh
    /// null-prototype ordinary object whose values are Arrays. Re-entrant.
    ObjectGroupBy,
    WeakMapSet,
    WeakMapGet,
    WeakMapHas,
    WeakMapDelete,
    /// `WeakMap.prototype.getOrInsert(key, value)` (upsert proposal): return the
    /// existing value for `key`, or insert `value` and return it. Requires a
    /// real `[[WeakMapData]]` receiver and a weakly-holdable `key` (a TypeError
    /// otherwise, checked before insertion). No key canonicalization — WeakMap
    /// keys are objects, so SameValue and SameValueZero coincide.
    WeakMapGetOrInsert,
    /// `WeakMap.prototype.getOrInsertComputed(key, callbackfn)` (upsert
    /// proposal): return the existing value for `key`; on absence call
    /// `callbackfn(key)` exactly once (`this` undefined), then insert its result
    /// under the key (overwriting any entry the callback itself added) and
    /// return it. The weak-key check precedes the callable check (spec order).
    /// Re-entrant (drives a user callback).
    WeakMapGetOrInsertComputed,
    /// `Set.prototype.add(v)` / `WeakSet.prototype.add(v)`: insert `v`,
    /// returning the receiver (`fxSetEntry` with no pair → two entry slots;
    /// the weak form allocates three).
    SetAdd,
    /// `Set.prototype.has(v)` / `WeakSet.prototype.has(v)`.
    SetHas,
    /// `Set.prototype.delete(v)` / `WeakSet.prototype.delete(v)`.
    SetDelete,
    /// The seven "new Set methods" (ES2025 set-methods proposal):
    /// `union`/`intersection`/`difference`/`symmetricDifference` return a fresh
    /// Set; `isSubsetOf`/`isSupersetOf`/`isDisjointFrom` return a Boolean. Each
    /// first coerces its argument through `GetSetRecord` (read `size`→ToNumber,
    /// `has`, `keys` — all observably, in that order) and drives the argument's
    /// `keys()` iterator or its `has` callback per the specification.
    SetUnion,
    SetIntersection,
    SetDifference,
    SetSymmetricDifference,
    SetIsSubsetOf,
    SetIsSupersetOf,
    SetIsDisjointFrom,
    WeakSetAdd,
    WeakSetHas,
    WeakSetDelete,
    /// `Map.prototype.forEach(cb[, thisArg])` / `Set.prototype.forEach(...)`
    /// (`fx_Map_prototype_forEach` / `fx_Set_prototype_forEach`): call
    /// `cb(value, key, coll)` for each live entry in insertion order (a Set
    /// passes `value` for both the value AND the key). The second re-entrant
    /// collection method; the handler branches on the receiver's kind. WeakMap/
    /// WeakSet have no `forEach`.
    CollForEach,
    /// `Map.prototype.entries()`/`keys()`/`values()` and
    /// `Set.prototype.entries()`/`values()`/`keys()` (Set's `keys` IS
    /// `values`): construct a Map/Set Iterator over the receiver with the given
    /// iteration kind (0 keys, 1 values, 2 entries). Set's kind-2 entry is
    /// `[value, value]`.
    CollEntries,
    CollKeys,
    CollValues,
    /// `Map.prototype.clear()` / `Set.prototype.clear()`
    /// (`fx_Map_prototype_clear` / the Set form → `fxClearEntries`): drop every
    /// entry and shrink the address table back toward `mxTableMinLength`,
    /// returning `undefined`. WeakMap/WeakSet have no `clear`.
    CollClear,
    /// `ArrayBuffer.prototype.slice(begin, end)`
    /// (`fx_ArrayBuffer_prototype_slice`): a fresh ArrayBuffer holding the
    /// `[begin, end)` byte range (relative-index clamped like
    /// `Array.prototype.slice`), copied out of the receiver's backing store.
    ArrayBufferSlice,
    /// `get ArrayBuffer[Symbol.species]`: the standard accessor returns its
    /// receiver.
    ArrayBufferSpeciesGetter,
    /// The fixed-buffer-compatible `ArrayBuffer.prototype` accessors.
    ArrayBufferDetachedGetter,
    ArrayBufferMaxByteLengthGetter,
    ArrayBufferResizableGetter,
    /// `ArrayBuffer.prototype.resize` is recognized but returns
    /// `Halt::NotImplemented`; only fixed-size buffers are modeled.
    ArrayBufferResize,
    /// `ArrayBuffer.prototype.transfer` / `transferToFixedLength`.
    ArrayBufferTransfer,
    ArrayBufferTransferToFixedLength,
    /// `ArrayBuffer.prototype.concat` (XS extension) —
    /// recognized-but-unimplemented.
    ArrayBufferConcat,
    /// `ArrayBuffer.isView(arg)` (`fx_ArrayBuffer_isView`): `true` iff the
    /// argument is a TypedArray or DataView view, else `false`.
    ArrayBufferIsView,
    /// An `Atomics.*` namespace method (`xsAtomics.c`). The payload selects the
    /// operation (see [`AtomicOp`]). Single-agent: the read-modify-write is a
    /// plain non-atomic sequence over the view's backing store (ironhorse runs
    /// one agent). `wait`/`notify`/`waitAsync` and BigInt-element ops self-name
    /// honest skips.
    Atomic(u8),
    /// `DataView.prototype.get<Type>(byteOffset[, littleEndian])`
    /// (`fx_DataView_prototype_get`): read an element of the type indexed by
    /// the payload (into [`TYPED_ARRAY_TYPES`]) at the byte offset, honoring
    /// the endianness (default big-endian). One `mxMeterOne` per read.
    DataViewGet(u8),
    /// `DataView.prototype.set<Type>(byteOffset, value[, littleEndian])`
    /// (`fx_DataView_prototype_set`): coerce and write an element of the type
    /// indexed by the payload. One `mxMeterOne` per write.
    DataViewSet(u8),
    /// Reflective DataView prototype accessors: buffer, byteLength, byteOffset.
    DataViewAccessor(u8),
    /// `Promise.prototype.then(onFulfilled, onRejected)`
    /// (`fx_Promise_prototype_then`): register the reaction pair on the
    /// receiver promise and return a fresh derived promise the reaction's
    /// outcome settles. Re-entrant when the promise is already settled (it
    /// queues a job, run at the pump-loop drain).
    PromiseThen,
    /// `Promise.prototype.catch(onRejected)` (`fx_Promise_prototype_catch`):
    /// `then(undefined, onRejected)`.
    PromiseCatch,
    /// `Promise.prototype.finally(onFinally)`
    /// (`fx_Promise_prototype_finally`): a `then` whose handlers run
    /// `onFinally` and pass the settlement through — a later increment
    /// (self-names until then).
    PromiseFinally,
    /// The anonymous length-1 `thenFinally` / `catchFinally` closures created
    /// by `Promise.prototype.finally` for an observable custom `then`. Their
    /// hidden home and polarity live in `promise_functions`, alongside the
    /// other runtime-minted, persisted Promise callables.
    PromiseFinallyHandler,
    /// The anonymous length-0 value thunk returned by a callable finally
    /// handler. It restores the original fulfillment value or throws the
    /// original rejection reason after `PromiseResolve(C, onFinally())`.
    PromiseFinallyValue,
    /// `get Promise[@@species]`: the standard accessor returns its receiver.
    PromiseSpeciesGetter,
    /// `%GeneratorPrototype%.next(v)` (`fx_Generator_prototype_next`): resume
    /// the suspended body with `v` as the yield expression's value, running
    /// to the next `yield` or completion; returns `{value, done}`.
    GeneratorNext,
    /// `%GeneratorPrototype%.return(v)` (`fx_Generator_prototype_return`):
    /// force completion with `v` (unwinding any `finally` is a named skip).
    GeneratorReturn,
    /// `%GeneratorPrototype%.throw(e)` (`fx_Generator_prototype_throw`):
    /// resume by throwing `e` at the suspension point (a named skip until the
    /// throw-into-suspended path is modeled).
    GeneratorThrow,
    AsyncGeneratorNext,
    AsyncGeneratorReturn,
    AsyncGeneratorThrow,
    AsyncIteratorIdentity,
    /// `Promise.resolve(value)` (`fx_Promise_resolve`): a promise resolved
    /// with `value` (returned as-is when already a native promise).
    PromiseResolveStatic,
    /// `Promise.reject(reason)` (`fx_Promise_reject`): a promise rejected
    /// with `reason`.
    PromiseRejectStatic,
    /// `Promise.all(iterable)` (`fx_Promise_all`): live iterator consumption
    /// with ordered aggregate fulfillment and abrupt-completion rejection.
    PromiseAll,
    /// `Promise.race(iterable)` (`fx_Promise_race`): live iterator consumption
    /// and first-settlement forwarding.
    PromiseRace,
    /// `Promise.allSettled(iterable)` (`fx_Promise_allSettled`): live iterator
    /// consumption and ordered settlement records.
    PromiseAllSettled,
    /// `Promise.any(iterable)` (`fx_Promise_any`): live iterator consumption,
    /// first fulfillment, or an ordered `AggregateError`.
    PromiseAny,
    /// A promise's resolve/reject function (XS's `fxResolvePromise`/
    /// `fxRejectPromise` host functions handed to the executor). Recognized
    /// in the `RUN` dispatch by a `promise_functions` side-table lookup, not
    /// bound as a prototype method; this variant is the marker the
    /// `alloc_method` name/length machinery uses.
    PromiseResolveFunction,
    PromiseRejectFunction,
    /// The anonymous length-2 closure `NewPromiseCapability` passes to a
    /// constructor. Its hidden home object captures the first resolve/reject
    /// pair supplied by that constructor.
    PromiseCapabilityExecutor,
    /// `RegExp.prototype.exec(string)` (`fx_RegExp_prototype_exec`): compile-
    /// once, drive the matcher from `lastIndex` (for `g`/`y`), and build the
    /// match-result array (`[whole, ...captures]` + `index`/`input`/`groups`),
    /// updating `lastIndex`. Returns `null` on no match.
    RegExpExec,
    /// `RegExp.prototype.test(string)` (`fx_RegExp_prototype_test`): the same
    /// match drive as `exec`, returning a boolean and updating `lastIndex`.
    RegExpTest,
    /// `RegExp.prototype.toString()` (`fx_RegExp_prototype_toString`): the
    /// `/source/flags` literal string, read through the `source`/`flags`
    /// getters.
    RegExpToString,
    /// `RegExp.prototype.compile(...)` (`fx_RegExp_prototype_compile`): XS's
    /// annexB stub is literally `*mxResult = *mxThis` — no instance check, no
    /// recompilation, arguments ignored — so the mirror returns `this` as-is.
    RegExpCompile,
    /// `%RegExp.prototype%[Symbol.replace](string, replaceValue)`: coerce the
    /// subject and drive the shared RegExp replacement worker.
    RegExpReplace,
    /// `%RegExp.prototype%[Symbol.match](string)`: drive abstract `RegExpExec`
    /// once or collect every global match.
    RegExpMatch,
    /// `%RegExp.prototype%[Symbol.matchAll](string)`: clone through the
    /// observable species constructor and return a lazy RegExp String Iterator.
    RegExpMatchAll,
    /// `%RegExp.prototype%[Symbol.search](string)`: execute from zero and
    /// restore the receiver's observable `lastIndex`.
    RegExpSearch,
    /// `%RegExp.prototype%[Symbol.split](string, limit)`: construct the sticky
    /// species matcher and emit intervening substrings and captures.
    RegExpSplit,
    /// `%RegExpStringIteratorPrototype%.next()`: drive `RegExpExec` lazily,
    /// including global zero-length-match advancement.
    RegExpStringIteratorNext,
    /// `get RegExp[Symbol.species]`: the standard accessor returns its receiver.
    RegExpSpeciesGetter,
    /// `get Error.prototype.stack` (`fx_Error_prototype_get_stack`): for an
    /// error instance, `name[: message]` plus one `\n at <fn> ()` line per
    /// construction-time frame; `undefined` for a non-error object; a
    /// TypeError for a non-object `this`.
    ErrorStackGetter,
    /// `set Error.prototype.stack` (`fx_Error_prototype_set_stack`): defines
    /// an own `{value, writable, enumerable, configurable}` `stack` property
    /// on `this` unconditionally (no string check — `mxDefineID`), with a
    /// TypeError for a non-object `this`, a missing argument, or a refused
    /// define (a frozen receiver, a rejecting proxy trap).
    ErrorStackSetter,
    /// `String.prototype.match(regexp)` (`fx_String_prototype_match`): coerce
    /// the receiver to string, the argument to a RegExp, and dispatch to the
    /// matcher — the non-global path returns `exec`'s result; the global path
    /// collects every whole match.
    StringMatch,
    /// `String.prototype.matchAll(regexp)`: validate global RegExps, honor an
    /// observable `@@matchAll`, or create a global RegExp and invoke it.
    StringMatchAll,
    /// `String.prototype.search(regexp)` (`fx_String_prototype_search`): the
    /// index of the first match, or `-1`.
    StringSearch,
    /// `String.prototype.replace(pattern, replacement)`
    /// (`fx_String_prototype_replace`): string-or-RegExp pattern with a
    /// string replacement carrying the `$`-substitution grammar.
    StringReplace,
    /// `String.prototype.replaceAll(pattern, replacement)`: validates that a
    /// RegExp search is global, then replaces every non-overlapping string
    /// occurrence or delegates through `@@replace`.
    StringReplaceAll,
    /// `String.prototype.split(separator[, limit])`
    /// (`fx_String_prototype_split`): split on a string-or-RegExp separator.
    StringSplit,
    /// `%MapIteratorPrototype%.next()` and `%SetIteratorPrototype%.next()`.
    /// Distinct identities enforce the collection-specific internal-slot
    /// brand check even though both advance the shared `IterState` layout.
    MapIteratorNext,
    SetIteratorNext,
    IteratorFrom,
    /// `%WrapForValidIteratorPrototype%.next()`: call the `next` method
    /// captured by `Iterator.from` with the wrapped iterator as receiver.
    IteratorWrapperNext,
    /// `%WrapForValidIteratorPrototype%.return()`: look up and call the
    /// wrapped iterator's live `return` method, or synthesize a completed
    /// iterator result when it has none.
    IteratorWrapperReturn,
    /// `get Iterator.prototype.constructor`: returns the realm's `%Iterator%`
    /// constructor without inspecting the receiver.
    IteratorConstructorGetter,
    /// `set Iterator.prototype.constructor`: the string-keyed instance of
    /// `SetterThatIgnoresPrototypeProperties`.
    IteratorConstructorSetter,
    /// `get Iterator.prototype[Symbol.toStringTag]`: returns `"Iterator"`
    /// without inspecting the receiver.
    IteratorToStringTagGetter,
    /// `set Iterator.prototype[Symbol.toStringTag]`: the symbol-keyed instance
    /// of `SetterThatIgnoresPrototypeProperties`.
    IteratorToStringTagSetter,
    /// One of the Iterator Helper prototype methods, indexed in the order
    /// installed by `create_intrinsics`.
    IteratorHelper(u8),
}

impl Default for FuncInfo {
    fn default() -> Self {
        FuncInfo {
            body_start: None,
            body_len: 0,
            closures: crate::value::SlotIndex::NULL,
            native: None,
            method: None,
            name: String::new(),
            arity: 0,
            name_chunk: crate::value::ChunkOffset::NULL,
            is_generator: false,
            home: crate::value::SlotIndex::NULL,
            class_derived: None,
        }
    }
}

#[derive(Clone, Debug)]
struct DisposalRecord {
    resource: Slot,
    method: Slot,
    pass_resource: bool,
}

#[derive(Clone, Debug, Default)]
struct DisposableStackData {
    disposed: bool,
    asynchronous: bool,
    records: Vec<DisposalRecord>,
}

/// An `ArrayBuffer` instance's internal state (XS's `XS_ARRAY_BUFFER_KIND`
/// + `XS_BUFFER_INFO_KIND` internal slots: the backing-store address and
/// the byte length). Kept in the [`Interp::array_buffers`] side table like
/// [`CollectionData`]; the backing bytes live in the chunk arena at
/// `data`, relocated by the slide-compactor. `length` is the buffer's
/// `byteLength` (`bufferInfo.length`). Resizable buffers are unsupported,
/// so this record has no maximum-length field.
#[derive(Copy, Clone, Debug)]
struct ArrayBufferData {
    /// The chunk-arena offset of the zero-filled backing store. Read by the
    /// view surfaces (TypedArray element access, DataView get/set) and by
    /// `ArrayBuffer.prototype.slice`; the ArrayBuffer surface itself only
    /// exposes `length`.
    data: crate::value::ChunkOffset,
    length: u32,
}

/// One TypedArray element type (XS's `gxTypeDispatches` row): the
/// constructor name, the element byte `size`, and the `shift` (log2 of the
/// size, so `byteLength == length << shift`). The order mirrors
/// `gxTypeDispatches` (with `mxFloat16` off, as the oracle target builds
/// it), so [`Native::TypedArray`]'s index maps 1:1 to the C table.
#[derive(Copy, Clone, Debug)]
pub struct TypedArrayType {
    pub name: &'static str,
    pub size: u8,
    pub shift: u8,
}

/// The concrete TypedArray constructors ironhorse binds, in `gxTypeDispatches`
/// order. `Native::TypedArray(i)` indexes this table.
pub const TYPED_ARRAY_TYPES: &[TypedArrayType] = &[
    TypedArrayType {
        name: "BigInt64Array",
        size: 8,
        shift: 3,
    },
    TypedArrayType {
        name: "BigUint64Array",
        size: 8,
        shift: 3,
    },
    TypedArrayType {
        name: "Float32Array",
        size: 4,
        shift: 2,
    },
    TypedArrayType {
        name: "Float64Array",
        size: 8,
        shift: 3,
    },
    TypedArrayType {
        name: "Int8Array",
        size: 1,
        shift: 0,
    },
    TypedArrayType {
        name: "Int16Array",
        size: 2,
        shift: 1,
    },
    TypedArrayType {
        name: "Int32Array",
        size: 4,
        shift: 2,
    },
    TypedArrayType {
        name: "Uint8Array",
        size: 1,
        shift: 0,
    },
    TypedArrayType {
        name: "Uint16Array",
        size: 2,
        shift: 1,
    },
    TypedArrayType {
        name: "Uint32Array",
        size: 4,
        shift: 2,
    },
    TypedArrayType {
        name: "Uint8ClampedArray",
        size: 1,
        shift: 0,
    },
];

/// A TypedArray instance's internal state (XS's `XS_TYPED_ARRAY_KIND`
/// dispatch slot + `XS_DATA_VIEW_KIND` view slot + buffer reference). Kept
/// in the [`Interp::typed_arrays`] side table. `kind` indexes
/// [`TYPED_ARRAY_TYPES`]; `buffer` names the backing `ArrayBuffer`
/// instance; `offset` is the `byteOffset`; `length` is the element count
/// (XS's `size >> shift`). A BigInt-element view (`kind` 0/1) is bound and
/// constructs, but its element read/write self-names until BigInt coercion
/// lands.
#[derive(Copy, Clone, Debug)]
struct TypedArrayData {
    kind: u8,
    buffer: crate::value::SlotIndex,
    offset: u32,
    length: u32,
}

/// A `DataView` instance's internal state (XS's `XS_DATA_VIEW_KIND` view
/// slot + buffer reference). Kept in the [`Interp::data_views`] side table.
/// `buffer` names the backing `ArrayBuffer`; `offset` is the `byteOffset`;
/// `size` is the view's `byteLength` in bytes.
#[derive(Copy, Clone, Debug)]
struct DataViewData {
    buffer: crate::value::SlotIndex,
    offset: u32,
    size: u32,
}

/// A promise instance's settlement state (XS's `XS_PROMISE_KIND` STATUS
/// slot + RESULT slot + THENS list, `xsPromise.c` `fxNewPromiseInstance`).
/// Kept in the [`Interp::promises`] side table, keyed by the promise
/// instance's slot. `state` is the fulfilled/rejected/pending status;
/// `result` is the fulfillment value or rejection reason once settled;
/// `reactions` are the `.then` reactions registered while still pending
/// (drained into the job queue at settlement). The `[[AlreadyResolved]]`
/// guard is **not** here: it lives per resolving-function *pair* in
/// [`Interp::promise_guards`] (XS's boolean slot in the
/// `fxPushPromiseFunctions` home object), because a promise resolved with a
/// thenable acquires a *second* pair (with its own fresh guard) while the
/// promise itself stays pending — the two-level structure the keystone
/// double-settle calibration turns on. Finalizing the promise state is
/// gated on `state == Pending` instead.
#[derive(Clone, Debug)]
struct PromiseData {
    state: PromiseState,
    result: Slot,
    reactions: Vec<PromiseReaction>,
    /// Whether a reaction (`.then`/`.catch`/`await`) was ever registered on
    /// this promise — ironhorse's coarse mirror of XS's per-rejection "handled"
    /// bookkeeping behind `the->rejection`. Set the first time a reaction is
    /// attached ([`Interp::promise_then_with`]/[`Interp::promise_then_native`]),
    /// so a promise that settles **rejected** with `ever_handled == false` is
    /// the unhandled rejection [`Interp::has_unhandled_rejection`] reports. Pure
    /// post-run bookkeeping — never metered, so it cannot perturb computrons.
    ever_handled: bool,
}

/// Per-instance RegExp state (XS's `XS_REGEXP_KIND` internal slot plus the
/// key slot holding the source string). `program` is the compiled pattern
/// from `ironhorse_regexp`: its `code[0]` is the flags word, `code[1]`
/// the capture count (including the whole match at index 0), and it carries
/// the compile meter. `source` is the pattern source string (the `.source`
/// getter's value, minus the empty-pattern `(?:)` substitution which the
/// getter applies). `flags` is the canonical flag string (`d`-order:
/// `dgimsuvy`) the constructor resolved.
#[derive(Clone, Debug)]
struct RegExpData {
    program: ironhorse_regexp::Program,
    source: String,
    flags: String,
    /// The legacy schema-11 `REGX` value used only when restoring a snapshot
    /// written before `lastIndex` became a real heap property. New machines
    /// carry the complete value and descriptor flags in the instance's
    /// ordinary property slot; this numeric fallback remains on the wire so
    /// existing stores stay readable without a schema migration.
    last_index: f64,
}

/// The program-local symbol ids of the RegExp accessor getters, resolved at
/// [`Interp::link_intrinsics`]. Each is `None` when the program never names
/// that getter.
#[derive(Copy, Clone, Debug, Default)]
struct RegExpGetterIds {
    source: Option<u16>,
    flags: Option<u16>,
    global: Option<u16>,
    ignore_case: Option<u16>,
    multiline: Option<u16>,
    dot_all: Option<u16>,
    sticky: Option<u16>,
    unicode: Option<u16>,
    has_indices: Option<u16>,
    unicode_sets: Option<u16>,
}

/// The program-local symbol ids of the exec-result array's named slots
/// (`index`/`input`/`groups`), resolved at [`Interp::link_intrinsics`].
#[derive(Copy, Clone, Debug, Default)]
struct RegExpResultIds {
    index: Option<u16>,
    input: Option<u16>,
    groups: Option<u16>,
    indices: Option<u16>,
}

/// A promise's settlement status (XS's `mxPendingStatus`/`mxFulfilledStatus`/
/// `mxRejectedStatus`).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum PromiseState {
    Pending,
    Fulfilled,
    Rejected,
}

/// A registered `.then` reaction on a still-pending promise (XS's THENS
/// reaction instance, `fxPromiseThen`): the user handlers (`undefined` when
/// absent) and the derived promise's capability functions the handler's
/// outcome resolves/rejects.
#[derive(Copy, Clone, Debug)]
#[allow(dead_code)] // fields consumed by the `.then`/job-drain increment
struct PromiseReaction {
    on_fulfilled: Slot,
    on_rejected: Slot,
    resolve: Slot,
    reject: Slot,
    /// What kind of reaction this is (XS distinguishes by which native
    /// function pair `fxPromiseThen` registered). A `User` reaction runs its
    /// `on_fulfilled`/`on_rejected` handler and settles the derived promise via
    /// `resolve`/`reject` (the ordinary `.then` path). A **native** reaction
    /// drives dedicated C behavior at the drain; its four slots carry only the
    /// values that behavior needs (and are undefined when it needs none). An
    /// `AsyncAwait(inst)` reaction resumes the suspended async instance via
    /// [`Interp::step_async`]. `fxPromiseThen` allocates only **5** reaction
    /// slots for a native reaction (no derived-promise `__result__` slot),
    /// versus 6 for a user reaction.
    kind: ReactionKind,
}

/// Which native behavior a [`PromiseReaction`] drives at the promise-job drain
/// (XS keys this off the specific native `resolveFunction`/`rejectFunction`
/// pair `fxPromiseThen` was handed). The default `User` is the ordinary `.then`
/// reaction; the native kinds carry no user handler.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum ReactionKind {
    /// An ordinary `.then`/`.catch` reaction: run the user handler, settle the
    /// derived promise.
    User,
    /// The `fxResolveAwait`/`fxRejectAwait` pair `await` registered on the
    /// awaited promise: resume the suspended async instance (the payload) with
    /// the settled value (fulfilled → `NoStatus`, rejected → `Throw`).
    AsyncAwait(crate::value::SlotIndex),
    AsyncGeneratorAwait(crate::value::SlotIndex),
    AsyncGeneratorYield(crate::value::SlotIndex),
    AsyncGeneratorReturn(crate::value::SlotIndex),
    /// A `Promise.prototype.finally` reaction (XS's `then` whose native
    /// handlers run `onFinally` and pass the settlement through). The
    /// reaction's `on_fulfilled` slot carries the `onFinally` function and its
    /// `on_rejected` slot carries the selected species constructor; its
    /// `resolve`/`reject` slots are the result capability, settled with the
    /// ORIGINAL value/reason after `PromiseResolve(C, onFinally())`. Drives
    /// [`Interp::run_finally_reaction`].
    FinallyReturn,
    /// The second half of a callable `Promise.prototype.finally` reaction:
    /// wait for `PromiseResolve(C, onFinally())` and then restore the original
    /// settlement carried in `on_fulfilled`. The boolean records whether that
    /// original settlement was a rejection. A rejection from the awaited
    /// promise overrides the original settlement, as required by `finally`.
    FinallyAwait(bool),
    /// A `Promise.all`/`allSettled`/`race`/`any` element reaction: `(combinator
    /// index into [`Interp::combinators`], element index)`. At the drain each
    /// settled element updates the shared [`CombinatorState`] and, on the
    /// completing element, invokes the combinator's result capability.
    Combine(u32, u32),
    /// The synchronous per-element callback passed to a custom `then` method.
    /// It is represented by a private promise resolving pair so it has the
    /// required anonymous, length-1, non-constructable, one-shot shape, but its
    /// settlement folds into the combinator immediately rather than queuing a
    /// promise reaction job. The reaction carries that pair in `resolve` and
    /// `reject`, allowing snapshot validation to prove this is a real bridge.
    CombineDirect(u32, u32),
    /// An `Array.fromAsync` await point (ECMA-262 sec-array.fromasync), keyed by
    /// the [`FromAsyncData`] index in [`Interp::from_async`]. `fromAsync` is a
    /// native async state machine driven entirely by these native reactions
    /// (no user bytecode frame): each variant resumes the machine at a distinct
    /// `Await` step and either advances the loop or settles the result promise.
    ///
    /// - `FromAsyncNext`: resume after `Await(nextResult)` on an **async**
    ///   iterator's `next()` promise (the `{value, done}` step object).
    /// - `FromAsyncElem`: resume after `Await`ing a per-element value — a
    ///   sync-iterator step's `value` (unwrapped, close-on-rejection) or an
    ///   array-like element `Get`.
    /// - `FromAsyncMap`: resume after `Await(mappedValue)` from `mapfn`.
    /// - `FromAsyncClose`: resume after `Await`ing an async iterator's
    ///   `return()` result during `AsyncIteratorClose`; rejects with the saved
    ///   error regardless of the close outcome.
    FromAsyncNext(u32),
    FromAsyncElem(u32),
    FromAsyncMap(u32),
    FromAsyncClose(u32),
}

/// Bound state for a runtime-minted Promise callable. Ordinary resolve/reject
/// functions use XS's `fxPushPromiseFunctions` home model: `promise` names the
/// promise they settle and `guard` indexes the pair's shared
/// `[[AlreadyResolved]]` flag. Reserved guard tags instead make `promise` the
/// hidden capture home for a capability executor or `finally` closure.
#[derive(Copy, Clone, Debug)]
struct PromiseFnData {
    /// The promise settled by an ordinary resolving function, or the hidden
    /// capture home of another runtime-minted Promise callable.
    promise: crate::value::SlotIndex,
    /// Resolve/reject polarity for a resolving pair, or fulfillment/rejection
    /// pass-through polarity for a `finally` handler/value closure.
    reject: bool,
    /// The high reserved values identify runtime-minted Promise closures;
    /// every lower value is an index into [`Interp::promise_guards`].
    guard: usize,
}

const PROMISE_CAPABILITY_EXECUTOR_GUARD: usize = usize::MAX;
const PROMISE_FINALLY_HANDLER_GUARD: usize = usize::MAX - 1;
const PROMISE_FINALLY_VALUE_GUARD: usize = usize::MAX - 2;

fn is_promise_resolving_guard(guard: usize) -> bool {
    guard < PROMISE_FINALLY_VALUE_GUARD
}

#[derive(Copy, Clone, Debug)]
struct PromiseCapability {
    promise: Slot,
    resolve: Slot,
    reject: Slot,
}

/// A queued microtask (XS's promise job, `fxQueueJob` onto `mxPendingJobs`).
/// A reaction job runs `on_fulfilled`/`on_rejected` against `value` and
/// settles the derived promise via the captured capability, exactly as
/// `fxOnResolvedPromise`/`fxOnRejectedPromise` do. FIFO-ordered in
/// [`Interp::promise_jobs`]; drained by [`Interp::run_promise_jobs`] after
/// the script settles (the pump-loop latch).
#[derive(Copy, Clone, Debug)]
#[allow(dead_code)] // fields consumed by the `.then`/job-drain increment
enum PromiseJob {
    /// A `.then` reaction job (XS's `fxOnResolvedPromise`/`fxOnRejectedPromise`
    /// trampoline): run `on_fulfilled`/`on_rejected` against `value`, settle the
    /// derived promise via the captured capability.
    Reaction {
        reaction: PromiseReaction,
        /// The settled value/reason to feed the reaction.
        value: Slot,
        /// `true` if the source promise rejected (run `on_rejected`).
        rejected: bool,
    },
    /// A resolve-with-thenable job (XS's `PromiseResolveThenableJob` /
    /// `fxOnThenable`): at the drain, call `then.call(thenable, resolve,
    /// reject)` where `resolve`/`reject` are the *second* resolving pair built
    /// for the promise being resolved (with its own fresh guard). The keystone
    /// path.
    Thenable {
        /// The `then` function (a user function) to invoke.
        then: Slot,
        /// The thenable object, passed as `this` to `then`.
        thenable: Slot,
        /// The second resolving pair for the promise (its own guard).
        resolve: Slot,
        reject: Slot,
    },
}

/// Which promise combinator a [`CombinatorState`] drives (XS's distinct
/// `fx_Promise_all`/`allSettled`/`race`/`any` bodies, each with its own
/// element-resolve closure).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
enum CombinatorKind {
    All,
    AllSettled,
    Race,
    Any,
}

/// The shared state one `Promise.all`/`allSettled`/`race`/`any` call threads
/// across its per-element reactions (XS's `remainingElementsCount` cell + the
/// values/errors Array closed over by each element-resolve function). Kept in
/// the [`Interp::combinators`] side table, indexed by the combinator's
/// position; each element reaction ([`ReactionKind::Combine`]) carries that
/// index plus its own element index. `remaining` counts the not-yet-settled
/// elements (`all`/`allSettled` resolve when it reaches 0; `any` rejects when
/// it reaches 0); `results` is the accumulator Array (values for `all`,
/// `{status,value|reason}` records for `allSettled`, errors for `any`; unused
/// for `race`). The result capability's callbacks are retained explicitly:
/// custom constructors may supply arbitrary functions, so repeated element
/// settlements must remain observable instead of being hidden behind a native
/// promise's `[[AlreadyResolved]]` guard.
#[derive(Clone, Debug)]
struct CombinatorState {
    kind: CombinatorKind,
    /// The result capability callbacks. Native resolving functions carry their
    /// own shared one-shot guard; custom callbacks are invoked whenever the
    /// specification calls them.
    resolve: Slot,
    reject: Slot,
    /// Count of elements not yet settled (drives the completion latch).
    remaining: u32,
    /// The accumulator Array instance (values/records/errors; unused for race).
    results: crate::value::SlotIndex,
}

/// The captured closure state of one in-flight `Array.fromAsync` call (its
/// implicit async function's `fromAsyncClosure`, ECMA-262 sec-array.fromasync).
/// `fromAsync` is a **native async state machine**: it never runs guest
/// bytecode of its own, so instead of a suspended frame it keeps this record in
/// the [`Interp::from_async`] side table (indexed by the
/// [`ReactionKind::FromAsyncNext`]/… payload) and steps through it at each
/// promise-job drain. Queued reactions keep the record's reference-bearing
/// slots live. Collection compacts the arena to referenced records and remaps
/// reaction indices; `reaction_arena_pruning.rs` pins reclamation and surviving
/// reactions across that compaction.
#[derive(Clone, Debug)]
struct FromAsyncData {
    /// The result promise's resolve/reject functions (`promiseCapability`).
    resolve: Slot,
    reject: Slot,
    /// The accumulator object `A` (a fresh Array, or `Construct(C[, len])`).
    target: crate::value::SlotIndex,
    /// Fast path: `A` is an intrinsic Array (index/length via the dense store)
    /// rather than an ordinary/proxy object (index via `[[DefineOwnProperty]]`,
    /// length via `[[Set]]`).
    target_is_array: bool,
    /// The current index `k`.
    k: u64,
    /// The map function (`undefined` when `mapping` is false) and its `thisArg`.
    mapfn: Slot,
    mapping: bool,
    this_arg: Slot,
    /// Latched once the result promise is settled — a late reaction is a no-op.
    settled: bool,
    /// The iterator object (`undefined` on the array-like path).
    iterator: Slot,
    /// The iterator's `next` method (iterator path only).
    next_method: Slot,
    /// `true` for a sync iterator (its `next()` returns a plain step and each
    /// value is `Await`ed with close-on-rejection); `false` for a native async
    /// iterator (its `next()` returns a promise that is `Await`ed directly).
    sync_wrapped: bool,
    /// The array-like input object (used for `Get(arrayLike, Pk)`; only read
    /// when `len > 0`, which implies an object).
    array_like: Slot,
    /// The array-like length (`iterator` is `undefined`).
    len: u64,
    /// The pending error an `AsyncIteratorClose` await is unwinding with.
    close_error: Slot,
}

/// An iterator's state. For an **array iterator** (`kind` 0 = values, 1 =
/// keys, 2 = entries) `iterable` is the array and `index` the cursor. For a
/// **for-in enumerator** (`kind` = 3) `enum_keys` is the pre-collected list of
/// enumerable property keys `(id, index)` to yield as strings (an `id ==
/// XS_NO_ID` entry is an array index), and `index` cursors it. `result` is the
/// reused `{value, done}` object `next()` mutates and returns. Kind 9 is a
/// RegExp String Iterator: `iterable` is its matcher, `str_bytes` its input,
/// and the low two `index` bits carry `global`/`fullUnicode`.
#[derive(Clone, Debug)]
struct IterState {
    iterable: crate::value::SlotIndex,
    index: u32,
    kind: u8,
    result: crate::value::SlotIndex,
    done: bool,
    /// For a collection cursor (kinds 5-7): the owning collection's
    /// clear-generation at creation. A `clear()` bumps the collection's
    /// counter and this cursor dead-ends — XS's purge semantics (see
    /// `CollectionData::generation`). Zero for every other kind.
    generation: u32,
    enum_keys: std::rc::Rc<Vec<(u16, u32)>>,
    /// For a string iterator (`kind == 4`) or RegExp String Iterator (`kind ==
    /// 9`): the UTF-16BE input. Kind 4 uses `index` as a byte offset; kind 9's
    /// matcher carries its own observable `lastIndex`, leaving `index` for its
    /// two persisted mode bits.
    str_bytes: std::rc::Rc<Vec<u8>>,
}

/// An Error instance's stringification data (XS's `Error.prototype.toString`
/// inputs): the constructor's `name` and the optional own `message`.
#[derive(Clone, Debug)]
struct ErrorInfo {
    name: &'static str,
    message: Option<String>,
    /// The call-frame names captured at construction (innermost first,
    /// ending with the empty program frame), the way XS records the frame
    /// chain `fx_Error_prototype_get_stack` renders as `\n at <name> ()`
    /// lines in the oracle shim (which compiles from buffers, so frames
    /// carry no file:line ids).
    frames: Vec<String>,
}

/// Resolve a decoded error-constructor name to the engine's static
/// name, or `None` for anything the engine never records — the closed
/// name set `ErrorInfo.name` draws from ([`Interp::restore_error_data`]
/// and the `ERRD` decoder both refuse an unknown name as corrupt: no
/// honest snapshot can carry one).
pub fn error_name_static(name: &str) -> Option<&'static str> {
    const ERROR_NAMES: [&str; 9] = [
        "Error",
        "EvalError",
        "RangeError",
        "ReferenceError",
        "SyntaxError",
        "TypeError",
        "URIError",
        "AggregateError",
        "SuppressedError",
    ];
    ERROR_NAMES.iter().find(|&&n| n == name).copied()
}

/// One intrinsic (native) function ironhorse models. The variant is the
/// identity the `run`/`new` dispatch and the completion renderer key off;
/// [`Native::display_name`] is the name XS's `Function.prototype.toString`
/// prints for it (`function ["Object"] (){[native code]}`).
///
/// Builtin constructors and the Error hierarchy use this closed dispatch set.
/// Unsupported call or construct behavior returns [`Halt::NotImplemented`]
/// with the builtin's name.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Native {
    /// The realm's intrinsic `eval` function. Direct calls are dispatched by
    /// `XS_CODE_EVAL`; ordinary/indirect calls reach [`Interp::call_native`].
    Eval,
    Locale,
    Collator,
    ListFormat,
    PluralRules,
    Segmenter,
    DateTimeFormat,
    NumberFormat,
    TemporalInstant,
    TemporalDuration,
    /// PlainDate, PlainTime, PlainDateTime, PlainYearMonth, PlainMonthDay,
    /// and Calendar respectively.
    TemporalPlain(u8),
    /// The `Temporal.ZonedDateTime` constructor (`new` only; a bare call is a
    /// `TypeError`). Instances are branded by the `temporal_zoneds` side table.
    TemporalZonedDateTime,
    Object,
    Function,
    Boolean,
    Symbol,
    BigInt,
    Number,
    String,
    Date,
    Array,
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
    AggregateError,
    SuppressedError,
    DisposableStack,
    AsyncDisposableStack,
    Map,
    Set,
    WeakMap,
    WeakSet,
    /// The abstract `Iterator` constructor and its helper-method prototype.
    Iterator,
    /// `ArrayBuffer` — the raw byte-buffer constructor (`xsDataView.c`
    /// `fx_ArrayBuffer`). Its per-instance backing store lives in the
    /// [`Interp::array_buffers`] side table.
    ArrayBuffer,
    /// `SharedArrayBuffer` — a shared raw byte-buffer constructor
    /// (`xsAtomics.c` `fx_SharedArrayBuffer`). ironhorse is single-agent, so a
    /// SharedArrayBuffer is a plain byte buffer (its backing store lives in the
    /// same [`Interp::array_buffers`] side table, marked in
    /// [`Interp::shared_buffers`]); the "shared" distinction only gates
    /// `Atomics.wait`/`notify` and `ArrayBuffer.isView`-style brand checks.
    SharedArrayBuffer,
    /// The non-global abstract `%TypedArray%` constructor, reachable as the
    /// `[[Prototype]]` of every concrete TypedArray constructor. Direct call
    /// and direct construction both throw a `TypeError`.
    TypedArrayBase,
    /// A concrete TypedArray constructor (`Uint8Array`/`Int32Array`/… —
    /// `xsDataView.c` `fx_TypedArray`). The payload indexes
    /// [`TYPED_ARRAY_TYPES`] (the element type). Its per-instance view state
    /// lives in the [`Interp::typed_arrays`] side table.
    TypedArray(u8),
    /// `DataView` — the endian-aware buffer view constructor (`xsDataView.c`
    /// `fx_DataView`). Its per-instance view state lives in the
    /// [`Interp::data_views`] side table.
    DataView,
    /// `Promise` — the promise constructor (`xsPromise.c` `fx_Promise`). Its
    /// per-instance settlement state lives in the [`Interp::promises`] side
    /// table; the resolve/reject functions it hands the executor are host
    /// functions recorded in [`Interp::promise_functions`].
    Promise,
    /// `RegExp` — the regular-expression constructor (`xsRegExp.c`
    /// `fx_RegExp`). Its per-instance compiled program + source/flags live in
    /// the [`Interp::regexps`] side table; `lastIndex` is an ordinary own
    /// integer property. The matcher itself is the `ironhorse-regexp` crate.
    RegExp,
    /// `Proxy` — the proxy constructor (`xsProxy.c` `fx_Proxy`). A special
    /// constructor: it has **no** `.prototype` property and its instances have
    /// no identity prototype. Constructing it validates the target/handler are
    /// objects and records a [`ProxyData`] in the [`Interp::proxies`] side
    /// table; the exotic behavior is the trap dispatch keyed off that table.
    Proxy,
    /// `%GeneratorFunction%` — the (non-global) dynamic **generator** function
    /// constructor, reachable as `(function*(){}).constructor`. Call and
    /// construct both run CreateDynamicFunction with the `function*` grammar
    /// through the runtime source bridge ([`Interp::create_dynamic_function`]).
    GeneratorFunction,
    /// `%AsyncFunction%` — the (non-global) dynamic **async** function
    /// constructor, reachable as `(async function(){}).constructor`.
    AsyncFunction,
    /// `%AsyncGeneratorFunction%` — the (non-global) dynamic **async
    /// generator** function constructor, reachable as
    /// `(async function*(){}).constructor`.
    AsyncGeneratorFunction,
}

impl Native {
    /// The name XS prints for this built-in (its `name` property, shown by
    /// `Function.prototype.toString` and by the completion renderer).
    pub fn display_name(self) -> &'static str {
        match self {
            Native::Eval => "eval",
            Native::Locale => "Locale",
            Native::Collator => "Collator",
            Native::ListFormat => "ListFormat",
            Native::PluralRules => "PluralRules",
            Native::Segmenter => "Segmenter",
            Native::DateTimeFormat => "DateTimeFormat",
            Native::NumberFormat => "NumberFormat",
            Native::TemporalInstant => "Instant",
            Native::TemporalDuration => "Duration",
            Native::TemporalPlain(i) => TEMPORAL_PLAIN_NAMES[i as usize],
            Native::TemporalZonedDateTime => "ZonedDateTime",
            Native::Object => "Object",
            Native::Function => "Function",
            Native::Boolean => "Boolean",
            Native::Symbol => "Symbol",
            Native::BigInt => "BigInt",
            Native::Number => "Number",
            Native::String => "String",
            Native::Date => "Date",
            Native::Array => "Array",
            Native::Error => "Error",
            Native::EvalError => "EvalError",
            Native::RangeError => "RangeError",
            Native::ReferenceError => "ReferenceError",
            Native::SyntaxError => "SyntaxError",
            Native::TypeError => "TypeError",
            Native::URIError => "URIError",
            Native::AggregateError => "AggregateError",
            Native::SuppressedError => "SuppressedError",
            Native::DisposableStack => "DisposableStack",
            Native::AsyncDisposableStack => "AsyncDisposableStack",
            Native::Map => "Map",
            Native::Set => "Set",
            Native::WeakMap => "WeakMap",
            Native::WeakSet => "WeakSet",
            Native::Iterator => "Iterator",
            Native::ArrayBuffer => "ArrayBuffer",
            Native::SharedArrayBuffer => "SharedArrayBuffer",
            Native::TypedArrayBase => "TypedArray",
            Native::TypedArray(i) => TYPED_ARRAY_TYPES[i as usize].name,
            Native::DataView => "DataView",
            Native::Promise => "Promise",
            Native::RegExp => "RegExp",
            Native::Proxy => "Proxy",
            Native::GeneratorFunction => "GeneratorFunction",
            Native::AsyncFunction => "AsyncFunction",
            Native::AsyncGeneratorFunction => "AsyncGeneratorFunction",
        }
    }

    /// ECMAScript `length` of the intrinsic constructor.
    fn arity(self) -> u32 {
        match self {
            Native::Eval => 1,
            Native::Locale => 1,
            Native::Collator => 0,
            Native::ListFormat => 0,
            Native::PluralRules => 0,
            Native::Segmenter => 0,
            Native::DateTimeFormat => 0,
            Native::NumberFormat => 0,
            Native::TemporalInstant => 1,
            Native::TemporalDuration => 0,
            Native::TemporalPlain(i) => [3, 0, 3, 2, 2, 1][i as usize],
            Native::TemporalZonedDateTime => 2,
            Native::AggregateError => 2,
            Native::SuppressedError => 3,
            Native::DisposableStack | Native::AsyncDisposableStack => 0,
            Native::RegExp => 2,
            Native::Proxy => 2,
            // `%GeneratorFunction%`/`%AsyncFunction%`/`%AsyncGeneratorFunction%`
            // each have `length` 1 (their sole formal is `...args`).
            Native::GeneratorFunction | Native::AsyncFunction | Native::AsyncGeneratorFunction => 1,
            Native::TypedArray(_) => 3,
            Native::DataView => 1,
            Native::Date => 7,
            Native::Symbol
            | Native::Map
            | Native::Set
            | Native::WeakMap
            | Native::WeakSet
            | Native::Iterator
            | Native::TypedArrayBase => 0,
            Native::Object
            | Native::Function
            | Native::Boolean
            | Native::BigInt
            | Native::Number
            | Native::String
            | Native::Array
            | Native::Error
            | Native::EvalError
            | Native::RangeError
            | Native::ReferenceError
            | Native::SyntaxError
            | Native::TypeError
            | Native::URIError
            | Native::ArrayBuffer
            | Native::SharedArrayBuffer
            | Native::Promise => 1,
        }
    }

    /// The intrinsic global constructors ironhorse binds, in `(name, variant)`
    /// pairs. The name is what the XS compiler records in the symbols
    /// atom; [`Interp::link_intrinsics`] binds each to the program-local id
    /// the compiler assigned it.
    pub fn intrinsics() -> Vec<(&'static str, Native)> {
        let mut v = vec![
            ("Object", Native::Object),
            ("Function", Native::Function),
            ("Boolean", Native::Boolean),
            ("Symbol", Native::Symbol),
            ("BigInt", Native::BigInt),
            ("Number", Native::Number),
            ("String", Native::String),
            ("Date", Native::Date),
            ("Array", Native::Array),
            ("Error", Native::Error),
            ("EvalError", Native::EvalError),
            ("RangeError", Native::RangeError),
            ("ReferenceError", Native::ReferenceError),
            ("SyntaxError", Native::SyntaxError),
            ("TypeError", Native::TypeError),
            ("URIError", Native::URIError),
            ("AggregateError", Native::AggregateError),
            ("SuppressedError", Native::SuppressedError),
            ("DisposableStack", Native::DisposableStack),
            ("AsyncDisposableStack", Native::AsyncDisposableStack),
            ("Map", Native::Map),
            ("Set", Native::Set),
            ("WeakMap", Native::WeakMap),
            ("WeakSet", Native::WeakSet),
            ("Iterator", Native::Iterator),
            ("ArrayBuffer", Native::ArrayBuffer),
            ("SharedArrayBuffer", Native::SharedArrayBuffer),
        ];
        // The concrete TypedArray constructors (`Uint8Array`/…), each a
        // `fx_TypedArray` callback distinguished by its element type index.
        for (i, t) in TYPED_ARRAY_TYPES.iter().enumerate() {
            v.push((t.name, Native::TypedArray(i as u8)));
        }
        v.push(("DataView", Native::DataView));
        v.push(("Promise", Native::Promise));
        v.push(("RegExp", Native::RegExp));
        v
    }
}

/// A host-observable completion or abort. Nested catch and suspension transfers
/// are private interpreter state and cannot be returned in this type.
///
/// Match a **panic** via [`Halt::is_panic`] (or the
/// `ExecutionOutcome` seam in the `endo` crate's `ironhorse_engine`
/// module, which delegates to it), never on a variant shape directly: the
/// "terminate, do not commit" set is defined in exactly one place
/// (`is_panic`), so a commit-path caller that matches `StackOverflow` /
/// `MeterAbort` / `Panic(_)` by hand reproduces that logic and silently
/// drifts when the set changes (design `ironhorse-panic.md`
/// § The Formal `Panic` Category). `#[non_exhaustive]` adds
/// discovery-time friction toward this rule for out-of-crate matches; it
/// is a convention, not a type-level guarantee.
// Thrown values contain floating-point numbers, so only PartialEq is derived.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum Halt {
    /// Reached RETURN/END: the completion value is in `result`.
    Return,
    /// The meter host refused more computation.
    MeterAbort,
    /// The configured slot or chunk heap ceiling was exhausted.
    HeapExhausted,
    /// The interpreter ran past a caller-supplied **step ceiling** without
    /// completing — a bounded-execution guard for callers that install no
    /// metering host (notably the bytecode-decoder fuzz harness, which
    /// [`run_program`] leaves un-metered). A malformed backward branch that
    /// targets itself (e.g. `BRANCH_STATUS_1` with offset `-2` at pc 0) or
    /// any other non-terminating dispatch cycle aborts here in bounded time
    /// instead of hanging. Carries the dispatch count reached at the abort.
    /// Never produced by the default-unbounded [`Interp::run`], so it does
    /// not perturb the oracle-differential paths.
    StepLimit(u64),
    /// An opcode, built-in, or value shape outside the implemented surface.
    /// Skip eligibility requires an explicit NotImplemented label in
    /// [`crate::halt_labels`]; a new or misclassified label is a harness failure.
    NotImplemented(&'static str),
    /// A recognized operation deliberately excluded by the execution profile:
    /// a resource-size ceiling, key-space limit, or host-policy restriction.
    /// Skip eligibility requires an explicit Refused label in
    /// [`crate::halt_labels`]; this is distinct from an implementation gap.
    Refused(&'static str),
    /// The engine's **own state is wrong**: a guard on the interpreter's
    /// invariants fired (value-stack or frame underflow, a suspended
    /// generator or async instance with no saved frame, a resolving
    /// function the promise machinery does not recognize, a dispatch that
    /// reached a method routed elsewhere). On oracle-produced bytecode this
    /// is a defect in the port, never an unported feature; on hostile
    /// bytecode it is the fail-closed refusal the decoder fuzz target pins.
    ///
    /// Never skip-eligible: both differential instruments report it as a
    /// hard failure, which is what separates it from [`Halt::NotImplemented`].
    /// Its label set is pinned alongside the declined set in
    /// `tests/halt_label_registry.rs`.
    EngineInvariant(&'static str),
    /// The bytecode was truncated or an opcode byte was invalid.
    Decode(String),
    /// A JS-level throw that escaped every guest handler and reached the
    /// host boundary. `value` is the original guest value, carried through
    /// nested dispatch and native catches before this outcome is constructed;
    /// `rendered` is its host-boundary `String()` rendering, for
    /// diagnostics and the oracle's thrown-value comparison.
    ///
    /// Constructed at the host boundary after nested dispatch and native
    /// catches have declined the thrown value, or by [`Halt::synthetic_throw`]
    /// for the harness (`tests/throw_construction_sites.rs` locks the set). An
    /// engine error built anywhere else must be a real error object routed
    /// through `raise_js`, so guest `try`/`catch` can observe it.
    Throw { value: Slot, rendered: String },
    /// The value stack was exhausted (XS's `fxOverflow` →
    /// `fxAbort(XS_JAVASCRIPT_STACK_OVERFLOW_EXIT)`): a fixed-geometry
    /// stack overflow — or the native-recursion budget was exhausted
    /// ([`NATIVE_DEPTH_LIMIT`], XS's `fxCheckCStack`). Like XS's, this is an
    /// **abort to the host**, not a catchable `RangeError` — a deterministic,
    /// consensus-relevant limit in the xsnap lineage. Carries the value-stack
    /// slot count in use at the halt for diagnostics (over the limit in the
    /// first case; incidental in the second).
    StackOverflow(usize),
    /// A **net-new panic** with no legacy `Halt` variant (design
    /// `ironhorse-panic.md` § The Formal `Panic` Category, item 3). The
    /// pre-existing panics (`StackOverflow`, `MeterAbort`) keep their flat,
    /// diagnostic-carrying shapes; the sources introduced by the panic
    /// design nest under `Panic(PanicKind)`. Both spellings answer the same
    /// supervisor question — routed through [`Halt::is_panic`], never a
    /// direct variant match.
    Panic(PanicKind),
}

/// The kind of a net-new [`Halt::Panic`], each carrying a diagnostic
/// payload so a frozen-at-fault snapshot is self-describing rather than
/// requiring the cause to be re-derived from the program counter (design
/// `ironhorse-panic.md` § The Formal `Panic` Category, item 3).
///
/// Extensible on purpose: the reference-error source of the design's Coda
/// (`ReferenceError { name, site }`, off by default) is a deferred
/// follow-on and is intentionally absent here; `#[non_exhaustive]` lets it
/// be added later without churning match sites.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum PanicKind {
    /// A caught Rust panic, converted into this value at the thread/FFI
    /// boundary so the supervisor observes a worker-death *value* rather
    /// than a process abort. As informative as `StackOverflow`'s overshoot:
    /// it carries the caught panic's message and, where the panic hook
    /// could recover it, its physical source location.
    ///
    /// Named `EngineFault` (not `Host`) deliberately: this document uses
    /// "host" for the surrounding-runtime call surface, so `Host` would
    /// read as "a host-function call panicked" rather than "the engine hit
    /// an internal logic bug." `EngineFault` names *what happened*.
    EngineFault {
        /// The caught panic's message.
        message: String,
        /// The panic's physical source position (`file:line:col`), when the
        /// panic hook could recover it. Optional because a hook cannot
        /// always reconstruct it.
        location: Option<String>,
    },
}

impl Halt {
    /// True when this halt is a **panic**: an uncatchable abort-to-host
    /// termination whose crank the supervisor must *discard, not commit*
    /// (design `ironhorse-panic.md` § The Formal `Panic` Category, item 2).
    ///
    /// This is the single place the **panic** set is defined. The
    /// `ExecutionOutcome` classifier delegates its `Panicked` arm here for
    /// every genuine panic rather than re-listing panic shapes, so adding a
    /// new panic variant updates this predicate alone. That classifier's
    /// `Panicked` outcome is a strict *superset* of this predicate, though:
    /// it also absorbs `Halt::NotImplemented` and a fail-closed catch-all, which
    /// terminate-without-commit but are **not** panics. Those extra cases
    /// live in `ExecutionOutcome::classify`, never here — so this predicate is
    /// still the sole definition of "is a panic," not of "must discard the
    /// crank" (a strictly larger set).
    ///
    /// The settled core is `StackOverflow | MeterAbort | EngineInvariant(_) | Panic(_)`.
    /// `Decode` and the harness-only `StepLimit` are **provisional**
    /// members: they terminate-without-commit like a panic, but their
    /// provenance is supervisor/harness rather than guest behavior, so
    /// their inclusion is an open question (design § Open Questions).
    /// Because this returns a bare `bool`, a caller written against today's
    /// answer for those two gets **no compiler signal** if the question
    /// later flips it — treat this doc note as that signal.
    ///
    /// A pure function of the `Halt` value: it never consults caller
    /// context. `Decode` arises only on the loader path and `StepLimit`
    /// only on the un-metered fuzz harness, but that is a fact about *where
    /// those variants arise*, not a branch inside this predicate.
    pub fn is_panic(&self) -> bool {
        matches!(
            self,
            Halt::StackOverflow(_)
                | Halt::MeterAbort
                | Halt::HeapExhausted
                | Halt::Panic(_)
                | Halt::EngineInvariant(_)
                // Provisional (Open Question), may change without a
                // type-level signal:
                | Halt::Decode(_)
                | Halt::StepLimit(_)
        )
    }
}

impl Halt {
    /// A host-synthesized uncaught throw with no guest value behind it:
    /// the stand-in for an abort the oracle shim reports OUTSIDE the
    /// machine — a compiler early error the harness models as a thrown
    /// `SyntaxError` before any bytecode ran, or the shim's post-run
    /// `String(result)` failing on a `Symbol` completion. Nothing rejects a
    /// promise with this value (no guest handler or native try is live), so
    /// `value` is `undefined`. Engine code that has a guest to answer must
    /// not use this; it builds a real error object and raises it.
    pub fn synthetic_throw(rendered: impl Into<String>) -> Halt {
        Halt::Throw {
            value: Slot::undefined(),
            rendered: rendered.into(),
        }
    }

    /// The host-boundary rendering of an uncaught throw, if this is one.
    pub fn thrown_rendering(&self) -> Option<&str> {
        match self {
            Halt::Throw { rendered, .. } => Some(rendered),
            _ => None,
        }
    }
}

/// A nested interpreter activation's completion. Only `finish_step` crosses
/// from this private control-flow protocol to the public host outcome.
#[derive(Debug, Clone, PartialEq)]
enum Step {
    /// The activation this dispatcher entered completed normally.
    Returned,
    /// No guest handler caught this value; a native boundary may still catch it.
    Threw {
        value: Slot,
    },
    /// Suspend to the generator, async-function, or async-generator driver.
    Yielded(Slot),
    Awaited(Slot),
    AsyncYielded(Slot),
    /// Resume a handler in the dispatch activation that owns its frame.
    Unwound(ResumeTarget),
    /// A non-JavaScript abort, propagated unchanged through native boundaries.
    Host(Halt),
}

/// A handler cursor and the code buffer it indexes. `None` names the current
/// crank's top-level buffer, including catches established before promotion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ResumeTarget {
    pc: usize,
    segment: Option<usize>,
}

/// XS's `fxToInstance` diagnostic for a member access on a nullish base
/// (`null.f`, `undefined[k]`, `null.f = v`): `TypeError: cannot coerce null
/// to object` / `… undefined to object`. The oracle's `String(e)` verbatim.
fn cannot_coerce_to_object(kind: Kind) -> String {
    let what = if kind == Kind::Null {
        "null"
    } else {
        "undefined"
    };
    format!("cannot coerce {what} to object")
}

/// The result of running one program's bytecode on ironhorse-vm.
#[derive(Debug, Clone)]
pub struct RunOutcome {
    /// `true` if the program completed normally: the dispatch reached
    /// `END` and the job queue drained. This is the ENGINE's verdict,
    /// and it agrees with [`Interp::is_quiescent`] by construction. It
    /// is not the oracle harness's verdict: the harness's post-run
    /// `String(result)` throws for a Symbol or null-prototype
    /// completion, which [`Self::coercion_error`] records and
    /// [`Self::host_coerced`] folds into an abort for a differential
    /// comparison.
    pub completed: bool,
    /// Completion value rendered with ECMAScript `String()` semantics
    /// (valid when `completed`). For a value `String()` cannot coerce
    /// (see [`Self::coercion_error`]) this is the engine's display
    /// rendering instead: a Symbol's descriptive string
    /// (`Symbol(desc)`), the generic `[object Object]` stub for a
    /// null-prototype object. Empty when `host_render_halt` is present.
    pub result: String,
    /// The `TypeError` the oracle shim's post-run `String(result)`
    /// throws for this completion value, as the differential harness
    /// models it: a Symbol (`cannot coerce symbol to string`), or an
    /// ordinary object whose prototype is `null` (`cannot coerce object to
    /// string`, the bare `Object.create(null)` whose
    /// `ToPrimitive` finds neither `toString` nor `valueOf`). `None`
    /// for every other completion and for every halt.
    ///
    /// The object arm is the harness's APPROXIMATION, not a `ToPrimitive`
    /// evaluation: it tests the prototype link of an ordinary object
    /// that is neither an array nor a boot native, so a null-prototype
    /// object carrying its own `toString` is flagged although `String()`
    /// would succeed, while an object whose null-prototype ancestor is
    /// one hop up, or an array re-prototyped to `null`, is not flagged
    /// although `String()` would throw. It has always been this
    /// predicate (it was the halt rewrite before), and
    /// it exists for oracle agreement on the shapes the corpus produces;
    /// an embedder should read it as "the harness would report an abort
    /// here", not as a verdict on the guest value.
    ///
    /// The guest never threw this: it is a HOST coercion the 262 runner
    /// and the fuzz harness emulate through [`Self::host_coerced`], while
    /// an embedder that wants the raw completion reads
    /// `completed`/`result` as they are. Host coercion must not turn a
    /// completed guest crank into a halt that the managed lifecycle rewinds.
    pub coercion_error: Option<String>,
    /// Bounded host rendering failed after a successful dispatch. This never
    /// changes persistence eligibility; only `host_coerced` folds it into the
    /// oracle harness verdict. The rendered `result` is empty in this case.
    pub host_render_halt: Option<Halt>,
    /// Whole computrons under Ironhorse's frozen cost-table release.
    /// Oracle counts are advisory; this includes all costs charged to the meter.
    pub computrons: u64,
    /// Raw dispatched-opcode count, before the invocation baseline
    /// (useful for isolating a metering divergence).
    pub dispatched: u64,
    /// Raw 16.16 fixed-point meter index (`the->meterIndex`), for
    /// diagnosing fractional (allocation/built-in) metering during
    /// calibration.
    pub meter_raw: u64,
    /// Why the run stopped.
    pub halt: Halt,
}

impl RunOutcome {
    /// The outcome as the ORACLE HARNESS reports it: the xsnap shim
    /// coerces the completion value with `String(result)` after the
    /// run, so a completion that coercion cannot render is an abort on
    /// the oracle's side. A [`Self::host_render_halt`] becomes the harness
    /// halt without changing the original machine's lifecycle. Fold
    /// [`Self::coercion_error`] the same way —
    /// `completed` becomes `false`, `result` empties, and `halt` becomes
    /// a [`Halt::Throw`] carrying the `TypeError` — so a differential
    /// comparison sees the shape the oracle produces. The post-run
    /// throw is outside the metered run in the shim, so the computrons
    /// are untouched. Every other outcome passes through unchanged.
    /// This is the differential harness's verb; an embedder that runs
    /// guest programs for their own sake keeps the raw completion.
    pub fn host_coerced(self) -> RunOutcome {
        if let Some(halt) = self.host_render_halt.clone() {
            return RunOutcome {
                completed: false,
                result: String::new(),
                coercion_error: None,
                host_render_halt: None,
                halt,
                ..self
            };
        }
        match self.coercion_error {
            Some(message) => RunOutcome {
                completed: false,
                result: String::new(),
                coercion_error: None,
                // The harness's abort has no guest value behind it: the
                // shim's `String(result)` threw outside the machine, and
                // nothing guest-visible can catch it. That is exactly
                // `synthetic_throw`'s contract, and it keeps this inside
                // the locked set of `Halt::Throw` construction sites.
                halt: Halt::synthetic_throw(message),
                ..self
            },
            None => self,
        }
    }
}

/// Why [`Interp::relink_crank`] refused (side-table ledger G2). Every
/// variant is fail-closed: nothing ran, the machine is unchanged.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum RelinkError {
    /// The crank's bytecode references an id beyond its own compiled
    /// table, or the instruction walker could not decode it.
    MalformedBytecode,
    /// Extending the table would exhaust the 16-bit id space.
    TableFull,
}

/// One serialized `arrays` row as [`Interp::arrays_snapshot`] hands it
/// out: `(owner slot, spec length, items ascending by index)`.
pub type ArraySnapshot = (u32, u32, Vec<(u32, Slot)>);
/// One serialized `index_props` row as [`Interp::index_props_snapshot`] hands
/// it out: `(owner slot, high-water mark, items ascending by index)`.
///
/// The middle field is NOT an array `length` — an ordinary object has none,
/// and nothing bounds the indices. It is the greatest index ever stored plus
/// one, which only rises, so a row may carry a high-water mark with no items
/// left under it: that is the tombstone `resident_indexed_limit` reads to keep
/// the array-iterator cursor domain a since-deleted index opened.
pub type IndexPropsSnapshot = (u32, u32, Vec<(u32, Slot)>);
/// One serialized `collections` row: `(owner slot, kind code,
/// table_length, entries in insertion order)`.
pub type CollectionSnapshot = (u32, u8, u32, Vec<(Slot, Slot)>);

interp_state!(define_interp_state);

/// The interned `typeof`-result strings, held as chunk offsets into the
/// machine chunk heap. Allocated once at [`Interp::new`], before any run,
/// so `typeof` names a preexisting string (XS's `XS_STRING_X_KIND`
/// interned strings) rather than allocating — dispatch-only, as XS.
#[derive(Copy, Clone, Debug)]
struct StaticStrings {
    undefined: crate::value::ChunkOffset,
    object: crate::value::ChunkOffset,
    boolean: crate::value::ChunkOffset,
    number: crate::value::ChunkOffset,
    string: crate::value::ChunkOffset,
    function: crate::value::ChunkOffset,
    symbol: crate::value::ChunkOffset,
    bigint: crate::value::ChunkOffset,
}

// Frozen, in-tree locale-data profile. Intl never consults the host locale,
// libc, environment variables, or a dynamically-updated database.
const INTL_DATA_VERSION: &str = "ironhorse-intl-2026a";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocaleData {
    pub tag: String,
    pub language: String,
    pub script: Option<String>,
    pub region: Option<String>,
    pub variants: Vec<String>,
    pub unicode: std::collections::BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CollatorData {
    pub locale: String,
    pub usage: String,
    pub sensitivity: String,
    pub collation: String,
    pub numeric: bool,
    pub case_first: String,
    pub ignore_punctuation: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListFormatData {
    pub locale: String,
    /// `conjunction` | `disjunction` | `unit`
    pub kind: String,
    /// `long` | `short` | `narrow`
    pub style: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluralRulesData {
    pub locale: String,
    /// `cardinal` | `ordinal`
    pub kind: String,
    /// `standard` | `scientific` | `engineering` | `compact`
    pub notation: String,
    pub minimum_integer_digits: u32,
    pub minimum_fraction_digits: u32,
    pub maximum_fraction_digits: u32,
    pub minimum_significant_digits: Option<u32>,
    pub maximum_significant_digits: Option<u32>,
    /// `fractionDigits` | `significantDigits` | `morePrecision` | `lessPrecision`
    pub rounding_type: String,
    /// `auto` | `morePrecision` | `lessPrecision`
    pub rounding_priority: String,
    pub rounding_mode: String,
    pub rounding_increment: u32,
    /// `auto` | `stripIfInteger`
    pub trailing_zero_display: String,
}

/// The resolved internal slots of an `Intl.NumberFormat`. The digit-option
/// fields mirror `PluralRulesData` (both are populated by
/// `set_number_digit_options`); the remaining fields carry the
/// style/currency/unit/notation/sign/grouping resolution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NumberFormatData {
    pub locale: String,
    pub numbering_system: String,
    /// `decimal` | `percent` | `currency` | `unit`
    pub style: String,
    /// `standard` | `scientific` | `engineering` | `compact`
    pub notation: String,
    /// `short` | `long`
    pub compact_display: String,
    /// `auto` | `always` | `never` | `exceptZero` | `negative`
    pub sign_display: String,
    /// `always` | `auto` | `min2` | `false`
    pub use_grouping: String,
    pub currency: Option<String>,
    /// `symbol` | `narrowSymbol` | `code` | `name`
    pub currency_display: String,
    /// `standard` | `accounting`
    pub currency_sign: String,
    pub unit: Option<String>,
    /// `short` | `narrow` | `long`
    pub unit_display: String,
    pub minimum_integer_digits: u32,
    pub minimum_fraction_digits: u32,
    pub maximum_fraction_digits: u32,
    pub minimum_significant_digits: Option<u32>,
    pub maximum_significant_digits: Option<u32>,
    pub rounding_type: String,
    pub rounding_priority: String,
    pub rounding_mode: String,
    pub rounding_increment: u32,
    pub trailing_zero_display: String,
    /// The lazily-created, cached `[[BoundFormat]]` function (the `format`
    /// getter returns the same function on every read). Reserved for the
    /// accessor-getter follow-up; the current `format` is a plain method.
    #[allow(dead_code)]
    pub bound_format: Option<crate::value::SlotIndex>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmenterData {
    pub locale: String,
    /// `grapheme` | `word` | `sentence`
    pub granularity: String,
}

/// One `%Segments%` object (the result of `segmenter.segment(string)`): the
/// input's UTF-16 code units, the precomputed boundary segments, and the
/// granularity carried for `isWordLike`. Segmentation is deterministic over the
/// pinned `icu_segmenter` Unicode data, so precomputing the whole list at
/// `segment()` time is equivalent to the spec's lazy FindBoundary and lets both
/// iteration and `containing` share one immutable result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentsData {
    pub units: Vec<u16>,
    /// Each `(start, end, is_word_like)` in UTF-16 code-unit offsets.
    pub segments: Vec<(usize, usize, bool)>,
    /// `grapheme` | `word` | `sentence` — only `word` exposes `isWordLike`.
    pub granularity: String,
}

/// One `%SegmentIterator%` — a cursor into a `%Segments%` object's precomputed
/// list (the segment index to yield next).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentIteratorData {
    pub segments_inst: crate::value::SlotIndex,
    pub pos: usize,
}

/// One `Intl.DateTimeFormat` object's resolved options. The frozen profile
/// carries the proleptic Gregorian calendar and a fixed offset time-zone
/// table; formatting is deterministic and host-independent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DateTimeFormatData {
    pub locale: String,
    pub calendar: String,
    pub numbering_system: String,
    /// The resolved IANA time-zone name (canonicalized).
    pub time_zone: String,
    /// Minutes east of UTC for the resolved zone (the frozen table is
    /// fixed-offset: UTC and the `Etc/GMT±N` / numeric-offset zones).
    pub offset_minutes: i32,
    pub hour_cycle: Option<String>,
    /// Each present component's resolved representation, in resolvedOptions
    /// enumeration order. `(key, value)` e.g. `("year","numeric")`.
    pub components: Vec<(&'static str, String)>,
    pub date_style: Option<String>,
    pub time_style: Option<String>,
}

/// The closed set of `Intl.DateTimeFormat` component keys
/// ([`DateTimeFormatData::components`] holds `&'static str` keys from
/// exactly this list). A snapshot decoder maps persisted key strings
/// back onto these statics and refuses anything else — crafted bytes,
/// never engine output.
pub fn dtf_component_key_static(name: &str) -> Option<&'static str> {
    for key in [
        "weekday",
        "era",
        "year",
        "month",
        "day",
        "dayPeriod",
        "hour",
        "minute",
        "second",
        "fractionalSecondDigits",
        "timeZoneName",
    ] {
        if key == name {
            return Some(key);
        }
    }
    None
}

/// The nine Intl DATA record tables of one machine, each ascending by
/// owning slot — the ledger `IntlRecords` row as
/// [`Interp::intl_snapshot`] emits it and [`Interp::restore_intl`]
/// reinstates it. Pure resolved-options data; the bound-function link
/// satellites (`collator_compare_functions`,
/// `number_format_bound_functions`) are deliberately absent — a minted
/// bound function is a `functions` (`FuncInfo`) row, the Pending
/// dependency — and both getters re-mint on a cache miss, so dropping
/// the caches at the boundary is first-access behavior, not loss.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IntlTables {
    pub locales: Vec<(u32, LocaleData)>,
    pub collators: Vec<(u32, CollatorData)>,
    pub list_formats: Vec<(u32, ListFormatData)>,
    pub plural_rules: Vec<(u32, PluralRulesData)>,
    pub number_formats: Vec<(u32, NumberFormatData)>,
    pub segmenters: Vec<(u32, SegmenterData)>,
    pub segments: Vec<(u32, SegmentsData)>,
    pub segment_iterators: Vec<(u32, SegmentIteratorData)>,
    pub date_time_formats: Vec<(u32, DateTimeFormatData)>,
}

impl IntlTables {
    /// Whether every table is empty (the atom is emitted only when not).
    pub fn is_empty(&self) -> bool {
        self.locales.is_empty()
            && self.collators.is_empty()
            && self.list_formats.is_empty()
            && self.plural_rules.is_empty()
            && self.number_formats.is_empty()
            && self.segmenters.is_empty()
            && self.segments.is_empty()
            && self.segment_iterators.is_empty()
            && self.date_time_formats.is_empty()
    }
}

/// One built-in iterator cursor as the snapshot carries it (the ledger
/// `Iterators` row, the `ITER` atom) — [`Interp::iterators_snapshot`]'s
/// emission and [`Interp::restore_iterators`]'s input. Kinds: 0-2 array
/// values/keys/entries, 3 for-in enumerator, 4 string, 5-7 collection
/// keys/values/entries, 8 for an `Iterator.from` generic wrapper, and 9 for a
/// RegExp String Iterator. Two boundary
/// normalizations make the row pure data: a collection cursor's `index` is the
/// LIVE-ENTRY ORDINAL (the
/// `COLL` row compacts tombstones, so the ordinal IS the physical index
/// in the restored dense table), and `clear()`-staleness folds into
/// `done` (the absolute clear-generation counter is unobservable; only
/// "retired" is).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IteratorRow {
    pub owner: u32,
    pub kind: u8,
    /// The iterated slot (weak). `u32::MAX` — [`crate::value::SlotIndex::NULL`]
    /// — for a string iterator, whose text lives in `str_bytes`.
    pub iterable: u32,
    pub index: u32,
    pub done: bool,
    /// The reused `{value, done}` result object's slot. For kind 8, an
    /// internal arena holder containing the cached `next` value.
    pub result: u32,
    /// For-in keys as `(id, index)` pairs (`id == 0` ⇒ an array index).
    pub enum_keys: Vec<(u16, u32)>,
    /// A String or RegExp String Iterator's UTF-16BE input; kind 4 uses `index`
    /// as a byte offset.
    pub str_bytes: Vec<u8>,
}

/// One guest or bound function's serializable metadata.
#[derive(Clone, Debug, PartialEq)]
pub struct FunctionRow {
    pub owner: u32,
    pub segment: Option<u32>,
    pub body_start: Option<u64>,
    pub body_len: u64,
    pub closures: u32,
    pub name: String,
    pub arity: u32,
    pub name_chunk: u32,
    pub is_generator: bool,
    pub home: u32,
    pub class_derived: Option<bool>,
}

/// One `Function.prototype.bind` wrapper's internal slots.
#[derive(Clone, Debug, PartialEq)]
pub struct BoundFunctionRow {
    pub owner: u32,
    pub target: u32,
    pub this_arg: Slot,
    pub args: Vec<Slot>,
}

/// Atomic snapshot unit for guest callability.
///
/// Segment indices in `functions` refer to the compact `segments` vector.
/// Constructor links, bound data, and deleted metadata are bundled because
/// carrying any one without the function rows would restore a partial exotic.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FunctionStateSnapshot {
    /// Boot-native name chunks move during GC even though their code and
    /// identities are rebuilt. None denotes the legacy boot-offset contract.
    /// Some carries the authoritative surviving subset; absent owners may
    /// already have been collected and their slots reused by guest objects.
    pub native_names: Option<Vec<(u32, u32)>>,
    pub segments: Vec<Vec<u8>>,
    pub functions: Vec<FunctionRow>,
    pub bound_functions: Vec<BoundFunctionRow>,
    pub ctor_prototypes: Vec<(u32, u32)>,
    pub deleted_meta: Vec<(u32, u16)>,
}

impl FunctionStateSnapshot {
    pub fn is_empty(&self) -> bool {
        self.native_names.is_none()
            && self.segments.is_empty()
            && self.functions.is_empty()
            && self.bound_functions.is_empty()
            && self.ctor_prototypes.is_empty()
            && self.deleted_meta.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyRow {
    pub owner: u32,
    pub target: u32,
    pub handler: u32,
    pub revoked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyRevokerRow {
    pub owner: u32,
    pub proxy: u32,
    pub name_chunk: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProxyStateSnapshot {
    pub proxies: Vec<ProxyRow>,
    pub revokers: Vec<ProxyRevokerRow>,
}

impl ProxyStateSnapshot {
    pub fn is_empty(&self) -> bool {
        self.proxies.is_empty() && self.revokers.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AccessorRow {
    pub owner: u32,
    pub id: u16,
    pub get: Option<Slot>,
    pub set: Option<Slot>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntlBoundFunctionRow {
    /// 0 = Collator compare, 1 = NumberFormat format.
    pub kind: u8,
    pub function: u32,
    pub owner: u32,
    pub name: String,
    pub name_chunk: u32,
    pub arity: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrivateValueRow {
    pub receiver: u32,
    pub brand: u32,
    pub value: Slot,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrivateAccessorRow {
    pub receiver: u32,
    pub brand: u32,
    pub get: Option<Slot>,
    pub set: Option<Slot>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PrivateElementSnapshot {
    pub values: Vec<PrivateValueRow>,
    pub accessors: Vec<PrivateAccessorRow>,
}

impl PrivateElementSnapshot {
    pub fn is_empty(&self) -> bool {
        self.values.is_empty() && self.accessors.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DisposalRecordRow {
    pub resource: Slot,
    pub method: Slot,
    pub pass_resource: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DisposableStackRow {
    pub owner: u32,
    pub disposed: bool,
    pub asynchronous: bool,
    pub records: Vec<DisposalRecordRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SavedJumpRow {
    pub target_pc: u64,
    /// Canonical code-segment index. Legacy rows without this field resolve
    /// through the enclosing saved frame's current function.
    pub segment: Option<u32>,
    pub stack_offset: u64,
    pub locals_len: u64,
    pub id_map: Vec<(u16, u64)>,
    pub call_depth_offset: u64,
    pub env: Slot,
    pub flag: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SavedFrameRow {
    pub locals: Vec<Slot>,
    pub id_map: Vec<(u16, u64)>,
    pub args: Vec<Slot>,
    pub this_val: Slot,
    pub env: Slot,
    pub cur_func: u32,
    pub cur_target: bool,
    pub target_func: u32,
    pub strict: bool,
    pub result: Slot,
    pub stack_slice: Vec<Slot>,
    pub jumps: Vec<SavedJumpRow>,
    pub resume_pc: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GeneratorRow {
    /// 0 = SuspendedStart, 1 = SuspendedYield, 2 = Completed.
    pub state: u8,
    pub owner: u32,
    pub frame: Option<SavedFrameRow>,
}

/// A suspended async function, carried with its promise cluster. Completed
/// instances have no resumable state and are omitted.
#[derive(Clone, Debug, PartialEq)]
pub struct AsyncRow {
    pub owner: u32,
    pub frame: SavedFrameRow,
    pub result_promise: u32,
    pub resolve: Slot,
    pub reject: Slot,
}

/// One registered reaction of a pending [`PromiseRow`] (the serialized
/// [`PromiseReaction`]). The four handler/capability slots are ordinary
/// value slots; `kind` is the reaction's drain behavior:
///
/// | byte | kind | `a` | `b` |
/// |------|------|-----|-----|
/// | 0 | `User` | — | — |
/// | 1 | `FinallyReturn` | — | — |
/// | 2 | `Combine` | combinator index | element index |
/// | 3–10 | the async-flavored kinds | | |
/// | 11 | `FinallyAwait` | original rejection boolean | — |
/// | 12 | `CombineDirect` | combinator index | element index |
///
/// Byte 3 (`AsyncAwait`) names an activation in `ASYN`. Bytes 4–10
/// (the three `AsyncGenerator*`s and four `FromAsync*`s) name machinery whose rows
/// are still Pending in the snapshot ledger, so the persist gate
/// refuses a machine holding one
/// ([`Interp::stored_unpersistable_row`]) and the decoder refuses the
/// byte. `FinallyAwait` is resumable from the ordinary promise cluster.
/// The encoding is total so every refusal lives at the boundary, not in a
/// lossy encoder.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct PromiseReactionRow {
    pub on_fulfilled: Slot,
    pub on_rejected: Slot,
    pub resolve: Slot,
    pub reject: Slot,
    pub kind: u8,
    pub a: u32,
    pub b: u32,
}

/// One promise instance's settlement state (the serialized
/// [`PromiseData`]): status, result, pending reactions, and the
/// unhandled-rejection latch [`Interp::has_unhandled_rejection`] reads.
#[derive(Clone, Debug, PartialEq)]
pub struct PromiseRow {
    pub owner: u32,
    /// 0 = Pending, 1 = Fulfilled, 2 = Rejected. A settled row carries
    /// no reactions (settlement drains them into the job queue, and the
    /// quiescence gate requires that queue empty).
    pub state: u8,
    pub result: Slot,
    pub ever_handled: bool,
    pub reactions: Vec<PromiseReactionRow>,
}

/// One runtime-minted Promise callable's bound data (the serialized
/// [`PromiseFnData`] plus the `FuncInfo` fields restore rebuilds — mirroring
/// [`IntlBoundFunctionRow`], the other runtime-minted native population that
/// travels outside `FUNC`).
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct PromiseFnRow {
    pub function: u32,
    /// Settled promise for a resolving function; hidden record object for a
    /// capability executor or `finally` closure (reserved high guard tags).
    pub promise: u32,
    /// Resolve/reject polarity for a resolving pair, or original-completion
    /// polarity for a `finally` closure.
    pub reject: bool,
    /// Index into [`PromiseClusterSnapshot::guards`], the pair's shared
    /// `[[AlreadyResolved]]` boolean. `u32::MAX` marks a capability executor;
    /// the next two lower values mark a finally handler and value thunk.
    pub guard: u32,
    /// The callable's interned empty-name chunk. Carried (not re-interned) so
    /// restore mutates no arena.
    pub name_chunk: u32,
}

/// One `Promise.all`/`allSettled`/`race`/`any` shared accumulator (the
/// serialized [`CombinatorState`]).
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct CombinatorRow {
    /// 0 = All, 1 = AllSettled, 2 = Race, 3 = Any.
    pub kind: u8,
    pub resolve: Slot,
    pub reject: Slot,
    pub remaining: u32,
    pub results: u32,
}

/// The atomic promise cluster: the four side tables whose rows
/// cross-reference each other (a reaction indexes `combinators`, a
/// resolving function indexes `guards` and names a `promises` row), so
/// they travel — and are validated — together, exactly as `FUNC`
/// bundles functions with their segments.
///
/// The two index arenas are emitted in COMPACTED form: the snapshot
/// verb applies the same liveness rule as the collector's
/// `compact_reaction_arenas` (a guard is live while a resolving pair
/// names it; a combinator while a pending `Combine` reaction does) and
/// remaps the holders onto the dense arenas. Indices never surface to
/// the guest, so the normalization is invisible — and it makes the
/// encoding canonical: a continued machine and its resumed twin emit
/// byte-identical clusters even before the continued one's next sweep.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PromiseClusterSnapshot {
    pub async_instances: Vec<AsyncRow>,
    pub promises: Vec<PromiseRow>,
    pub functions: Vec<PromiseFnRow>,
    pub guards: Vec<bool>,
    pub combinators: Vec<CombinatorRow>,
}

impl PromiseClusterSnapshot {
    pub fn is_empty(&self) -> bool {
        self.promises.is_empty()
            && self.async_instances.is_empty()
            && self.functions.is_empty()
            && self.guards.is_empty()
            && self.combinators.is_empty()
    }
}

/// A suspended activation: the caller's scope and resume point, saved by
/// `run` and restored by `end` (XS's `mxFrame->value.frame.{code,scope}`
/// plus the environment the frame aliases). The value stack is shared and
/// not saved here; `end` resets it to the frame boundary and pushes the
/// callee's result, matching XS's `mxStack = mxFrameEnd; *mxStack = *slot`.
struct CallerState {
    locals: Vec<Slot>,
    id_map: std::collections::HashMap<u16, usize>,
    result: Slot,
    strict: bool,
    args: Vec<Slot>,
    this_val: Slot,
    this_captures: Vec<crate::value::SlotIndex>,
    /// The caller's `with`/eval environment head (XS's `mxEnvironment`),
    /// saved so a callee starts with an empty environment and the caller's
    /// active `with` is restored on return.
    env: Slot,
    cur_func: crate::value::SlotIndex,
    cur_target: bool,
    target_func: crate::value::SlotIndex,
    /// The caller's code cursor to resume at (just past its `run`).
    ret_pc: usize,
}

/// One entry of the exception jump-buffer chain (XS's `txJump`, pushed by
/// `CATCH`). It records exactly what XS's `c_setjmp` restore restores when
/// a throw longjmps here: where to resume (`segment`/`target_pc`, XS's
/// `jump->code`),
/// the value-stack cut (`stack_len`, XS's `jump->stack`), the scope cut
/// (`locals_len`/`id_map`, XS's `jump->scope`/environment), and the call
/// depth to unwind to (`call_depth`, XS's `jump->frame` — a throw that
/// crosses called functions pops their activations back to the frame that
/// established the catch). `flag` mirrors XS's `jump->flag = 1` (a JS
/// jump); every ironhorse jump is JS, and the host boundary is the empty chain.
#[derive(Clone)]
struct CatchJump {
    target_pc: usize,
    segment: Option<usize>,
    stack_len: usize,
    locals_len: usize,
    id_map: std::collections::HashMap<u16, usize>,
    call_depth: usize,
    /// The `with`/eval environment head active when the catch was
    /// established (XS restores `mxEnvironment` from `jump->scope` on a
    /// longjmp), so a throw out of a `with` body resets the environment for
    /// the surviving catch/finally code in the establishing frame.
    env: Slot,
    flag: u8,
    /// This entry was RE-ESTABLISHED when a suspended run resumed (the
    /// handler was live across a `yield`/`await`), rather than pushed by
    /// a `CATCH` dispatch in the current run. A throw unwinding to such
    /// an entry costs one extra dispatch in XS — see
    /// [`RESUMED_HANDLER_THROW_METERING`].
    rebased: bool,
}

/// The lifecycle state of a generator instance (`xsGenerator.c`'s `state`
/// slot, which holds a resume opcode: `XS_CODE_START_GENERATOR` before the
/// first `next`, `XS_NO_CODE` while executing, `XS_CODE_END` when done).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum GeneratorState {
    /// Created by `START_GENERATOR`, not yet resumed (`.next` runs the body
    /// from the start; the first `.next` argument is discarded per spec).
    SuspendedStart,
    /// Suspended at a `yield`; `.next(v)` resumes with `v` as the yield
    /// expression's value.
    SuspendedYield,
    /// Currently running on a `resume_generator` nested dispatch (a
    /// re-entrant `.next`/`for-of` while executing is a `TypeError` in XS).
    Executing,
    /// Fell off the end or `return`ed; every further `.next` yields
    /// `{value: undefined, done: true}`.
    Completed,
}

/// A suspended activation shared by generators, async functions, and async
/// generators — the ironhorse analog of the
/// slot region XS's `YIELD`/`START_GENERATOR` copy into the instance's
/// `XS_STACK_KIND` chunk. It captures exactly the frame state
/// the resume driver must reinstall to continue the body: the
/// scope (`locals`/`id_map`), the call identity (`args`/`this_val`/
/// `cur_func`/`cur_target`/`strict`/`result`), the generator's own value-stack
/// temporaries (`stack_slice`, the slots above the frame base at the suspend
/// point), its live exception handlers (`jumps`, positions made RELATIVE to
/// the frame base — a suspend inside a `try` snapshots its handlers here and
/// the resume rebases them onto the live chain), and the resume cursor
/// (`resume_pc`).
struct SavedFrame {
    locals: Vec<Slot>,
    id_map: std::collections::HashMap<u16, usize>,
    args: Vec<Slot>,
    this_val: Slot,
    /// The generator's `with`/eval environment head at the suspend point,
    /// reinstalled on resume so a `yield` inside a `with` continues in the
    /// same environment.
    env: Slot,
    cur_func: crate::value::SlotIndex,
    cur_target: bool,
    target_func: crate::value::SlotIndex,
    strict: bool,
    result: Slot,
    stack_slice: Vec<Slot>,
    /// Exception handlers established by this activation. Their stack and
    /// call-depth cuts are stored relative to the activation so a resume can
    /// rebase them above whichever caller is driving the generator.
    jumps: Vec<SavedJump>,
    resume_pc: usize,
}

/// A [`CatchJump`] as saved into a suspended frame: `stack_len` is
/// RELATIVE to the run's frame base (the live chain records absolute
/// positions). Call-depth cuts are likewise offsets from the suspended
/// driver's call-depth base; reinstallation adds the new driver's depth.

#[derive(Clone)]
struct SavedJump {
    target_pc: usize,
    segment: Option<usize>,
    stack_offset: usize,
    locals_len: usize,
    id_map: std::collections::HashMap<u16, usize>,
    call_depth_offset: usize,
    /// The environment head active when this handler was established (see
    /// [`CatchJump::env`]).
    env: Slot,
    flag: u8,
}

/// Which `%GeneratorPrototype%` entry drove a resume (XS's `txFlag status`
/// argument to `fx_Generator_prototype_aux`): `next` (`XS_NO_STATUS`),
/// `return` (`XS_RETURN_STATUS`), or `throw` (`XS_THROW_STATUS`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum GenStatus {
    Next,
    Return,
    Throw,
}

/// Per-instance generator state in the `generators` side table (modeled on
/// `promises`): the lifecycle state and the suspended activation (`None`
/// once completed).
struct GeneratorData {
    state: GeneratorState,
    frame: Option<SavedFrame>,
}

/// The context of a generator currently executing on a nested
/// [`Interp::resume_generator`] dispatch, so the `YIELD` arm knows which
/// instance to snapshot into and where its value-stack region begins.
/// A stack (not a scalar) because a generator body may drive another
/// generator's `.next` before it yields.
struct GenRunFrame {
    gen: crate::value::SlotIndex,
    /// `self.stack.len()` at the moment the generator frame was installed;
    /// `self.stack[stack_base..]` is the generator's own temporaries.
    stack_base: usize,
    /// `self.jumps.len()` at install; handlers above this boundary belong to
    /// the generator activation and are snapshotted on suspension.
    jumps_base: usize,
    /// Call depth of the installed generator frame. Saved handlers rebase
    /// their frame cuts relative to this depth across suspension.
    call_depth_base: usize,
}

/// Per-instance async-function state in the `async_instances` side table
/// (modeled on [`GeneratorData`]): the suspended activation (`None` once the
/// body has run to completion) plus the result promise and its resolve/reject
/// functions (XS's `fxNewAsyncInstance` internal slots `promise`/
/// `resolveFunction`/`rejectFunction`), which [`Interp::step_async`] settles
/// when the body returns or throws.
struct AsyncData {
    frame: Option<SavedFrame>,
    /// The result promise `START_ASYNC` returns to the async call's caller
    /// (XS's `instance->next->next->next`).
    result_promise: crate::value::SlotIndex,
    /// The result promise's resolve function (settles it on body completion).
    resolve_fn: Slot,
    /// The result promise's reject function (settles it on body throw).
    reject_fn: Slot,
    /// Whether the body has finished (returned or threw). Guards against a
    /// double resume (a settled awaited promise firing twice).
    done: bool,
}

/// The context of an async instance currently executing on a nested
/// [`Interp::step_async`] dispatch, so the `AWAIT` arm knows which instance to
/// snapshot into and where its value-stack region begins. The async analog of
/// [`GenRunFrame`].
struct AsyncRunFrame {
    inst: crate::value::SlotIndex,
    stack_base: usize,
    jumps_base: usize,
    /// Call depth of the installed async frame. Saved handlers rebase across
    /// each await just as generator handlers do across yield.
    call_depth_base: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AsyncGeneratorState {
    SuspendedStart,
    SuspendedYield,
    Executing,
    Awaiting,
    Completed,
}

#[derive(Clone, Copy, Debug)]
struct AsyncGeneratorRequest {
    status: GenStatus,
    value: Slot,
    resolve: Slot,
    reject: Slot,
}

struct AsyncGeneratorData {
    state: AsyncGeneratorState,
    frame: Option<SavedFrame>,
    requests: std::collections::VecDeque<AsyncGeneratorRequest>,
    active: Option<AsyncGeneratorRequest>,
}

struct AsyncGenRunFrame {
    gen: crate::value::SlotIndex,
    stack_base: usize,
    jumps_base: usize,
    call_depth_base: usize,
}

/// The resume mode threaded into the `BRANCH_STATUS` epilogue after an `AWAIT`
/// resume (XS's `the->status` bits, restricted to the two an async body can see).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ResumeStatus {
    /// A fulfilled await resume (XS's `XS_NO_STATUS`): `BRANCH_STATUS` branches
    /// by `offset`, leaving the resolved value on the stack as the `await`
    /// expression's result. Also the state outside any resume.
    NoStatus,
    /// A generator `.return(value)` resume. `BRANCH_STATUS` falls through to
    /// the compiler-emitted `set_result`/return-target path, which performs
    /// the same `finally` unwinding as an ordinary `return` statement.
    Return,
    /// A rejected await resume (XS's `XS_THROW_STATUS`): `BRANCH_STATUS` sets
    /// the exception from the top of stack and unwinds to the innermost handler.
    Throw,
}

mod boot;
pub(crate) use boot::BootTemplate;

impl Default for Interp {
    fn default() -> Self {
        Interp::new()
    }
}

impl Interp {
    /// The cost-calibration histogram recorder, present only under the
    /// `cost-calibration` feature. Calibration drivers and histogram tests
    /// read it after a run. Returns a
    /// borrow of the observation-only recorder; there is no `&mut` accessor,
    /// keeping the data flow one-directional (interpreter → recorder).
    #[cfg(feature = "cost-calibration")]
    pub fn cost_recorder(&self) -> &crate::cost::CostRecorder {
        &self.cost
    }

    /// Read the top-level binding named `name`, rendered with ECMAScript
    /// `String()` semantics — the post-run inspection the async test262
    /// harness uses to read the `$DONE` completion sentinel a pure-JS async
    /// prelude records into a global (design § Part 2, the async row). Resolves
    /// through the same read path the interpreter uses (a declared frame local
    /// first, then the global object's property) and the program-local symbol
    /// table [`Self::link_intrinsics`] built, so it must be called after
    /// [`Self::run`], when the top-level frame's scope is restored. Returns
    /// `None` when the program never assigned that name (its slot is absent or
    /// still the hoisted `undefined`): the did-not-run latch — `$DONE`/`print`
    /// was never called — and when the renderer refuses the value (a
    /// self-containing array past the native-recursion budget), which no
    /// harness sentinel is.
    pub fn global_string(&self, name: &str) -> Option<String> {
        let id = *self.symbol_ids.get(name)?;
        let slot = self.resolve_get(id)?;
        if slot.kind == Kind::Undefined {
            return None;
        }
        self.render(&slot).ok()
    }

    /// Whether any promise settled **rejected** with no reaction ever
    /// registered on it — ironhorse's mirror of XS's `the->rejection` unhandled-
    /// rejection latch (design § Part 2, the async row). A `.then`/`.catch`/
    /// `await` on the promise sets `ever_handled`
    /// ([`Self::promise_then_with`]/[`Self::promise_then_native`]), so this is
    /// true only for a rejection nothing ever observed — the shape an async
    /// test that throws without settling `$DONE` leaves behind. Read after
    /// [`Self::run`], once the job drain has settled every promise it can.
    pub fn has_unhandled_rejection(&self) -> bool {
        self.promises
            .values()
            .any(|p| p.state == PromiseState::Rejected && !p.ever_handled)
    }

    /// The raw bytecode-dispatch count (`n_dispatched`), exposed for the C1
    /// histogram-reconciliation check (`opcode_total()` must equal this).
    #[cfg(feature = "cost-calibration")]
    pub fn n_dispatched(&self) -> u64 {
        self.n_dispatched
    }

    /// The native-method identity of a function instance, if it is one.
    #[inline]
    fn method_of(&self, f: crate::value::SlotIndex) -> Option<NativeMethod> {
        self.functions.get(&f).and_then(|fi| fi.method)
    }

    /// The `.prototype` object of a constructor instance, if it is one. A
    /// guest may reassign a plain constructor function's writable own
    /// `prototype` property, so the own slot (when the program names
    /// `prototype` — see [`Self::prototype_key_id`]) outranks the boot-time
    /// [`Self::ctor_prototype`] record; a reassignment to a non-object means
    /// instances chain to `%Object.prototype%` (`fxGetPrototypeFromConstructor`).
    #[inline]
    fn prototype_of(&self, ctor: crate::value::SlotIndex) -> Option<crate::value::SlotIndex> {
        if let Some(pid) = self.prototype_key_id {
            if let Some(p) = self.find_property(ctor, pid) {
                let s = self.slots.get(p);
                if s.kind == Kind::Reference {
                    if let Payload::Reference(r) = s.value {
                        return Some(r);
                    }
                }
                return None;
            }
        }
        self.ctor_prototype.get(&ctor).copied()
    }

    /// `GetPrototypeFromConstructor(constructor, intrinsicDefaultProto)`:
    /// perform the observable ordinary `Get(constructor, "prototype")`, then
    /// use the intrinsic fallback unless that value is an object. This differs
    /// from [`Self::prototype_of`], which is a non-observable cache lookup used
    /// by internal boot plumbing; native construction must run Proxy/accessor
    /// behavior and propagate abrupt completion.
    fn get_prototype_from_constructor(
        &mut self,
        code: &[u8],
        constructor: crate::value::SlotIndex,
        fallback: crate::value::SlotIndex,
    ) -> Result<crate::value::SlotIndex, Step> {
        let id = self.intern_key("prototype");
        let receiver = Slot::of(Kind::Reference, Payload::Reference(constructor));
        let value = self.mop_get(code, constructor, id, receiver)?;
        Ok(match value {
            Slot {
                kind: Kind::Reference,
                value: Payload::Reference(prototype),
                ..
            } => prototype,
            _ => fallback,
        })
    }

    /// ECMAScript `InstanceofOperator(O, C)`. The right operand must be an
    /// object; its `@@hasInstance` method is read through the full MOP and, if
    /// present, called with `C` as `this` and `O` as its sole argument.
    /// Otherwise `C` must be callable and falls through to
    /// [`Self::ordinary_has_instance`].
    fn instanceof_operator(
        &mut self,
        code: &[u8],
        value: Slot,
        constructor: Slot,
    ) -> Result<bool, Step> {
        let ctor = match constructor.value {
            Payload::Reference(ctor) if constructor.kind == Kind::Reference => ctor,
            _ => {
                return Err(self.catchable_type_error_msg(
                    match constructor.kind {
                        Kind::Undefined => "cannot coerce undefined to object",
                        Kind::Null => "cannot coerce null to object",
                        _ => "call: not a function",
                    }
                    .into(),
                ))
            }
        };
        self.meter.tick_raw(INSTANCEOF_METERING);
        let has_instance_id = self
            .well_known_symbol_property_id("hasInstance")
            .expect("well-known hasInstance symbol");
        let method = self.mop_get(code, ctor, has_instance_id, constructor)?;
        if method.kind != Kind::Undefined && method.kind != Kind::Null {
            if !self.is_callable_value(method) {
                return Err(self.catchable_type_error_msg("call: not a function".into()));
            }
            let result = self.invoke_value(code, method, constructor, &[value])?;
            return Ok(self.truthy(&result));
        }
        if !self.is_callable_value(constructor) {
            return Err(self.catchable_type_error_msg("call: not a function".into()));
        }
        self.ordinary_has_instance(code, constructor, value)
    }

    /// ECMAScript `OrdinaryHasInstance(C, O)`, including bound-function
    /// recursion, the primitive-left short circuit, observable `.prototype`
    /// access, and proxy-aware `[[GetPrototypeOf]]` traversal.
    fn ordinary_has_instance(
        &mut self,
        code: &[u8],
        constructor: Slot,
        value: Slot,
    ) -> Result<bool, Step> {
        if !self.is_callable_value(constructor) {
            return Ok(false);
        }
        let ctor = match constructor.value {
            Payload::Reference(ctor) => ctor,
            _ => return Ok(false),
        };
        if let Some(bound) = self.bound_functions.get(&ctor).cloned() {
            let target = Slot::of(Kind::Reference, Payload::Reference(bound.target));
            return self.instanceof_operator(code, value, target);
        }
        let mut object = match value.value {
            Payload::Reference(object) if value.kind == Kind::Reference => object,
            _ => return Ok(false),
        };
        self.meter.tick_raw(INSTANCEOF_OBJECT_METERING);
        let prototype_id = self.intern_key("prototype");
        let prototype = self.mop_get(code, ctor, prototype_id, constructor)?;
        let target = match prototype.value {
            Payload::Reference(target) if prototype.kind == Kind::Reference => target,
            _ => return Err(self.catchable_type_error_msg("this.prototype: not an object".into())),
        };
        let mut proxy_steps = 0;
        loop {
            self.charge_proxy_chain_step(object, &mut proxy_steps)?;
            let parent = self.mop_get_prototype(code, object)?;
            match (parent.kind, parent.value) {
                (Kind::Reference, Payload::Reference(parent)) => {
                    if parent == target {
                        return Ok(true);
                    }
                    object = parent;
                }
                (Kind::Null, _) => return Ok(false),
                _ => return Err(self.catchable_type_error()),
            }
        }
    }

    /// An instance slot's prototype (its payload reference), or `NULL`.
    #[inline]
    fn instance_prototype(&self, inst: crate::value::SlotIndex) -> crate::value::SlotIndex {
        if inst.is_null() || inst.0 >= self.slots.capacity() {
            return crate::value::SlotIndex::NULL;
        }
        match self.slots.get(inst).value {
            Payload::Reference(p) => p,
            _ => crate::value::SlotIndex::NULL,
        }
    }

    /// Run the next top-level program with **eval-program** declaration-
    /// instantiation semantics: `CreateGlobalVarBinding` /
    /// `CreateGlobalFunctionBinding` receive `D = true`, so a top-level
    /// `var`/function declaration becomes a *configurable* global property, as
    /// it does inside `eval`. A top-level Script otherwise gets `D = false`
    /// (non-configurable), which is the default and the correct behavior.
    ///
    /// This exists for **one** caller: the differential harness, which needs to
    /// reproduce the pinned `xs-oracle` shim's framing. That shim compiles and
    /// runs every source with the `eval` builtin's flags, so it answers as an
    /// eval program would; re-running a source this way demonstrates that a
    /// divergence from the oracle is the goal framing rather than a defect (see
    /// `rust/engine/README.md` § "Script goal vs. the oracle's eval framing").
    /// Production embeddings must leave it off.
    ///
    /// It applies to the top-level program only. A nested `eval` unit sets the
    /// same framing for itself and restores the caller's on exit, so this
    /// neither leaks into nor is clobbered by an `eval`.
    pub fn set_eval_program_framing(&mut self, on: bool) {
        self.eval_program_hoist = on;
    }

    /// Install the source compiler the runtime source-execution bridge drives
    /// ([`SourceCompiler`]). Called once by the host after [`Self::new`] /
    /// [`Self::link_intrinsics`]; a string `eval` or the `Function`
    /// constructor is an honest [`Halt::NotImplemented`] until it is armed.
    pub fn set_source_compiler(&mut self, compiler: std::rc::Rc<dyn SourceCompiler>) {
        self.source_compiler = Some(compiler);
    }

    /// The runtime source-execution bridge: compile `source` through the
    /// installed [`SourceCompiler`] and execute the resulting program in
    /// **this** realm, returning its completion value (the spec's eval /
    /// dynamic-function evaluation result).
    ///
    /// This replaces the former `eval:string-source` source-text boundary
    /// with a principled compiler/VM seam:
    /// - **Linkage ownership.** The unit is compiled with its own program-local
    ///   symbol numbering; [`Self::relink_program_symbols`] rewrites its ids
    ///   into the realm's shared symbol table, and
    ///   [`Self::install_intrinsic_bindings`] binds any intrinsic the outer
    ///   program never named — so `Object`, `Math`, … mean the realm's.
    /// - **Realm identity.** It runs on this same [`Interp`]: the same global
    ///   object, intrinsics, heap, and meter. Indirect eval and `Function`
    ///   evaluate in the realm's program (global) scope. A direct eval keeps
    ///   the caller's published environment chain, so parameters and lexical
    ///   cells remain live across the nested dispatch. Sloppy direct-eval
    ///   `var`/function declarations are instantiated in the nearest published
    ///   caller variable environment.
    /// - **Nested invocation / safe recursion.** The unit runs as an isolated
    ///   program activation: the caller's whole frame (scope, `this`, args,
    ///   target, catch-jump chain, call stack, result) is saved and a clean
    ///   one installed, so the nested program cannot corrupt the caller and
    ///   an uncaught throw re-raises into the caller's own `try`/catch.
    /// - **Catchable parse errors.** A [`SourceCompileError::Syntax`] is a
    ///   realm-local, catchable `SyntaxError`; an `Unsupported` construct is
    ///   an honest coverage gap, never a mis-execution.
    /// - **Job/meter behavior.** Execution accrues on the shared meter; the
    ///   eval unit's promise reactions drain with the outer program's job
    ///   pump (not a nested drain), matching a single host crank.
    fn eval_source(&mut self, source: &str, strict: bool) -> Result<Slot, Step> {
        // Whether this is a direct eval (its declaration instantiation observes
        // the caller's lexical environment). Captured before the nested-frame
        // setup clears `eval_direct`.
        let is_direct = self.eval_direct;
        let compiler = match &self.source_compiler {
            Some(compiler) => compiler.clone(),
            None => return Err(Step::Host(Halt::NotImplemented("eval:no-compiler"))),
        };
        self.charge_and_check(0)?;
        let raw_budget = u64::MAX - self.meter_index();
        let mut charged = 0u64;
        let mut refused = false;
        let result = compiler.compile_source(source, strict, raw_budget, &mut |raw| {
            if refused {
                return false;
            }
            let Some(next) = charged.checked_add(raw).filter(|next| *next <= raw_budget) else {
                refused = true;
                return false;
            };
            charged = next;
            refused = !self.charge_compilation(raw);
            !refused
        });
        // Refusal wins even if an embedding compiler mistakenly returns
        // successful output or a syntax error after its callback said stop.
        if refused {
            return Err(Step::Host(Halt::MeterAbort));
        }
        let compiled = match result {
            Err(SourceCompileError::HeapExhausted) => return Err(Step::Host(Halt::HeapExhausted)),
            Ok(compiled) => compiled,
            Err(SourceCompileError::MeterAbort) => return Err(Step::Host(Halt::MeterAbort)),
            Err(SourceCompileError::Syntax(message)) => {
                return Err(self.catchable_syntax_error_with_message(message))
            }
            Err(SourceCompileError::Unsupported(_)) => {
                return Err(Step::Host(Halt::NotImplemented(
                    "eval:compiler-unimplemented",
                )))
            }
        };
        if compiled.parse_meter_raw != charged {
            return Err(Step::Host(Halt::EngineInvariant(
                "eval:compile-charge-receipt",
            )));
        }
        let eval_names =
            crate::symbols::parse_symbols_checked(&compiled.symbols).map_err(Step::Host)?;
        let code = match self.relink_program_symbols(&compiled.bytecode, &eval_names) {
            Some(code) => code,
            None => return Err(Step::Host(Halt::EngineInvariant("eval:relink"))),
        };
        // Bind only the ids appended SINCE THE LAST INSTALL PASS (the
        // installed-names floor — a name interned at
        // runtime has an id no install has seen, so filtering by this
        // unit's own pre-relink length refused it forever); ids at or
        // below the floor keep their existing binding or a guest's
        // deliberate replacement of it, which a re-install would
        // clobber — the same floor scoping `relink_crank` applies.
        let floor = self.installed_names_len;
        // The install floor is in REALM ids, not this eval unit's local
        // symbol numbering. Passing eval_names shrank the floor after a
        // short eval and let the next reflective read resurrect deleted
        // intrinsics (including SES's tamed constructors).
        let realm_names = self.symbol_names[floor..].to_vec();
        self.install_intrinsic_bindings(&realm_names, floor, false, move |id| {
            (id as usize) > floor
        });
        // The unit may reference a well-known property name (`length`, `name`,
        // `then`, a RegExp getter, …) the outer program never used; its id is
        // now in the realm table, so refresh the exotic-property id caches that
        // gate on it, else e.g. `Function('...r', 'return r.length')` would read
        // an absent own `length` instead of the array's exotic length.
        self.refresh_special_ids_from_symbols();

        // Persist this unit's bytecode for the realm's lifetime and run it
        // under its own segment id, so a function it defines that escapes the
        // eval (the completion, a stored global, the `Function` result) still
        // dispatches over the right bytes when called later.
        let segment = self.code_segments.len();
        let buf: std::rc::Rc<[u8]> = code.into();
        self.code_segments.push(buf.clone());

        // Save the caller's activation and install a clean program frame for
        // the nested unit (indirect / top-level-direct eval runs in the realm
        // program scope). `call_stack` and `jumps` are emptied so the unit's
        // `BEGIN` takes the top-level-program branch and an uncaught throw
        // cannot unwind into the caller's catch targets mid-nested-dispatch.
        let saved_locals = std::mem::take(&mut self.locals);
        let saved_id_map = std::mem::take(&mut self.id_map);
        let saved_args = std::mem::take(&mut self.args);
        let saved_call_stack = std::mem::take(&mut self.call_stack);
        let saved_jumps = std::mem::take(&mut self.jumps);
        let saved_env = self.env;
        let saved_result = self.result;
        let saved_strict = self.strict;
        let saved_this = self.this_val;
        let saved_cur_func = self.cur_func;
        let saved_cur_target = self.cur_target;
        let saved_target_func = self.target_func;
        let saved_pending_new_target = self.pending_new_target;
        let saved_frame_slots = self.frame_slots;
        let saved_eval_direct = self.eval_direct;
        let saved_direct_eval_hoist = self.direct_eval_hoist;
        let saved_eval_program_hoist = self.eval_program_hoist;
        let saved_active_segment = self.active_segment;
        let saved_stack_len = self.stack.len();

        self.result = Slot::undefined();
        self.strict = false;
        self.cur_func = crate::value::SlotIndex::NULL;
        self.cur_target = false;
        self.target_func = crate::value::SlotIndex::NULL;
        self.pending_new_target = None;
        self.frame_slots = 0;
        self.eval_direct = false;
        // A direct eval resolves through the caller's compiler-published
        // closure environments. An indirect eval always starts at the realm
        // global and must not inherit an enclosing function's dynamic chain.
        if !is_direct {
            self.env = Slot::undefined();
        }
        // The unit's declaration-instantiation hoist observes the direct/indirect
        // distinction (only a direct eval sees the caller's global lexicals).
        self.direct_eval_hoist = is_direct;
        // EvalDeclarationInstantiation passes `D = true` for a direct *and* an
        // indirect eval, so a global `var` this unit creates is configurable
        // (deletable) — unlike a Script's, which is not.
        self.eval_program_hoist = true;
        self.active_segment = Some(segment);

        let halt = self.dispatch_at(&buf[..], 0, 0);
        let completion = self.result;
        self.active_segment = saved_active_segment;
        self.direct_eval_hoist = saved_direct_eval_hoist;
        self.eval_program_hoist = saved_eval_program_hoist;

        // Restore the caller's activation. Drop any residue the nested unit
        // left on the shared value stack (a well-formed program is balanced;
        // this is the lifetime backstop).
        self.stack.truncate(saved_stack_len);
        self.locals = saved_locals;
        self.id_map = saved_id_map;
        self.args = saved_args;
        self.call_stack = saved_call_stack;
        self.jumps = saved_jumps;
        self.env = saved_env;
        self.result = saved_result;
        self.strict = saved_strict;
        self.this_val = saved_this;
        self.cur_func = saved_cur_func;
        self.cur_target = saved_cur_target;
        self.target_func = saved_target_func;
        self.pending_new_target = saved_pending_new_target;
        self.frame_slots = saved_frame_slots;
        self.eval_direct = saved_eval_direct;

        match halt {
            Step::Returned => Ok(completion),
            // An uncaught throw inside the eval unit: `self.exception` holds
            // the realm error value. Re-raise it into the *caller's* frame so
            // the caller's `try`/catch (its restored jump chain) observes it —
            // exactly as a native helper's `catchable_*` does.
            Step::Threw { value, .. } => Err(self.raise_js(value)),
            // A coverage gap, meter abort, step-limit, or decode fault the
            // nested unit hit: propagate as-is (honest, non-result outcome).
            other => Err(other),
        }
    }

    /// CreateDynamicFunction (ECMA-262 20.2.1.1.1) for the whole
    /// dynamic-function constructor family. `native` selects the
    /// function-head grammar (`function` / `function*` / `async function` /
    /// `async function*`); the trailing argument is the body and the leading
    /// arguments the formal parameter list, each `ToString`-coerced (a
    /// `Symbol` argument throws a realm `TypeError`, any other non-string is
    /// stringified). The assembled
    /// `(<head> anonymous(<params>\n) {\n<body>\n})` source is compiled and run
    /// through the same runtime source bridge as `eval` ([`Self::eval_source`]),
    /// so the returned function persists in its own code segment and stays
    /// callable after this native returns. A parse failure (a bad parameter
    /// list, a `yield`/`await` outside the assembled grammar, a truncated body)
    /// surfaces as a catchable realm `SyntaxError`, exactly as the spec's
    /// early-error path throws. Call and construct are equivalent for the whole
    /// family, so the `new`-ness of the caller is not consulted here.
    fn create_dynamic_function(
        &mut self,
        native: Native,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let mut params: Vec<String> = Vec::new();
        let mut body = String::new();
        for i in 0..argc {
            let slot = self
                .stack
                .get(base + 4 + i)
                .copied()
                .unwrap_or_else(Slot::undefined);
            // ToString each argument (the spec coerces every parameter chunk and
            // the body). A `Symbol` throws a realm `TypeError` from here.
            let piece = self.value_to_string(code, slot)?;
            if i + 1 == argc {
                body = piece;
            } else {
                params.push(piece);
            }
        }
        // The function-head grammar per kind. The trailing `anonymous` is the
        // spec's dynamic-function name; the `.name` the returned function
        // reports comes from compiling this head.
        let head = match native {
            Native::Function => "function anonymous",
            Native::GeneratorFunction => "function* anonymous",
            Native::AsyncFunction => "async function anonymous",
            Native::AsyncGeneratorFunction => "async function* anonymous",
            _ => unreachable!("create_dynamic_function on a non-family native"),
        };
        // The parameters are joined with `,` and the body wrapped in a block;
        // the whole is parenthesized so the Script's completion is the function
        // expression. The `\n` before `)` and after `{` are the spec's exact
        // separators (they defeat a trailing line comment in the parameter list
        // or a `//`-terminated body from swallowing the closing punctuation).
        let source = format!("({}({}\n) {{\n{}\n}})", head, params.join(","), body);
        self.eval_source(&source, false)
    }

    /// The native identity of a function instance, if it is an intrinsic.
    #[inline]
    fn native_of(&self, f: crate::value::SlotIndex) -> Option<Native> {
        self.functions.get(&f).and_then(|fi| fi.native)
    }

    /// The slots the *active* frame holds live: the shared value stack, the
    /// current scope, the current arguments, and the frame quartet. Added
    /// to [`Self::frame_slots`] (the suspended frames) it mirrors XS's
    /// `stackTop - stack` closely enough that the overflow abort brackets
    /// XS's — over-counting slightly (the value stack still carries the
    /// pre-truncation frame region at a call site) rather than under, so
    /// ironhorse never *completes* a program XS overflows on.
    #[inline]
    fn live_stack_slots(&self) -> usize {
        self.stack.len() + self.locals.len() + self.args.len() + FRAME_OVERHEAD_SLOTS
    }

    /// Total concurrent slot usage across the active and suspended frames
    /// (XS's `stackTop - stack`). The stack-overflow guard compares this
    /// against the fixed budget.
    #[inline]
    fn stack_slots_in_use(&self) -> usize {
        self.frame_slots + self.live_stack_slots()
    }

    /// Whether allocating `extra` more slots would exhaust the fixed value
    /// stack (XS's `fxOverflow`: `stack + count < stackBottom`). The usable
    /// budget is [`STACK_SLOT_COUNT`] minus the reserved root band.
    #[inline]
    fn would_overflow(&self, extra: usize) -> bool {
        self.stack_slots_in_use() + extra > STACK_SLOT_COUNT - STACK_SLOT_RESERVED
    }

    /// Seed a global binding by id, so a program that reads an
    /// undeclared name (`EVAL_REFERENCE`/`GET_VARIABLE` falling through
    /// to the global object) observes it. Used by
    /// [`crate::compartment::Compartment::evaluate`] to bind the
    /// compartment's own globals before running.
    pub fn define_global_id(&mut self, id: u16, value: Slot) {
        // Seeding a compartment global happens before the run, so it is
        // not metered (it is not a guest allocation the meter counts).
        self.create_global_property(id, (value.kind, value.value));
    }

    /// Allocate a property slot for global key `id`, link it into the
    /// global object's property list, and record it in [`Self::global_props`].
    /// Does **not** meter — callers add the allocation metering at the
    /// faithful opcode site. Returns the property slot index.
    fn create_global_property(
        &mut self,
        id: u16,
        value: (Kind, Payload),
    ) -> crate::value::SlotIndex {
        let mut prop = Slot::property(id, value.1);
        prop.kind = value.0;
        // Insert at the head of the global object's property list.
        let head = self.slots.get(self.global_obj).next;
        prop.next = head;
        let idx = self.slots.alloc(prop);
        self.slots.get_mut(self.global_obj).next = idx;
        self.global_props.insert(id, idx);
        idx
    }

    /// Materialize a new own global property at run time (a hoisted
    /// `var`, or a sloppy assignment creating a global), metering the
    /// allocation exactly where `fxNewSlot`/`fxNewChunk` run:
    /// [`crate::meter::SLOT_ALLOCATION_METERING`] for the property slot
    /// plus the measured [`PROPERTY_CREATE_REMAINDER`] (the property-table
    /// growth and interned-key allocation not yet modeled as individual
    /// slots) — 536 raw total against the pin. Initialized undefined; a
    /// following `SET_VARIABLE` assigns and meters its own built-in step.
    fn materialize_global_property(&mut self, id: u16) -> crate::value::SlotIndex {
        self.tick_property_create(id);
        self.create_global_property(id, (Kind::Undefined, Payload::None))
    }

    /// Meter one new own-property allocation: the property `fxNewSlot`
    /// ([`crate::meter::SLOT_ALLOCATION_METERING`]) plus the measured
    /// [`PROPERTY_CREATE_REMAINDER`], 536 raw total against the pin.
    ///
    /// The remainder is dominated by the interned-key `fxFindKey` →
    /// `fxNewSlot`/`fxNewChunk` allocation, which XS pays only for an atom
    /// **missing** its boot name table. A key that is one of XS's boot
    /// default keys (`gxIDStrings` — `toString`, `valueOf`, …) is
    /// pre-interned at machine creation, so creating a property under it
    /// costs only the property slot — measured against the pin as exactly
    /// 256 (the `Test262Error.prototype.toString = …` harness store).
    #[inline]
    fn tick_property_create(&mut self, id: u16) {
        self.meter.tick_slot_alloc();
        let name = self.id_name(id);
        if !self.default_keys.contains(name.as_str()) {
            self.meter.tick_raw(PROPERTY_CREATE_REMAINDER);
        }
    }

    /// The pre-discount flat form of [`Self::tick_property_create`], for the
    /// internal materializations (the legacy `caller`/`arguments` own
    /// properties a function define installs through `instance_put`) whose
    /// costs are folded into calibrated cluster constants measured with this
    /// flat charge — discounting them would unbalance those clusters.
    #[inline]
    fn tick_property_create_flat(&mut self) {
        self.meter.tick_slot_alloc();
        self.meter.tick_raw(PROPERTY_CREATE_REMAINDER);
    }

    /// Arm metering (`fxBeginMetering`): install a check `interval` — a
    /// **computron** count, as the xsnap embedder passes — and the `host`
    /// callback the loop-closing check points consult with
    /// `meterIndex >> 16` ("computrons"). Per `fxBeginMetering` this
    /// scales `interval <<16` and resets the index to 0 (finding 2), so
    /// arm before running. The un-metered default is unchanged — a fresh
    /// `Interp` never arms and never checks, so the differential harness
    /// is unaffected. On host refusal, the run halts with
    /// [`Halt::MeterAbort`].
    pub fn arm_meter(&mut self, interval: u64, host: Box<dyn FnMut(u64) -> bool>) {
        self.meter.begin(interval);
        self.meter_host = Some(host);
    }

    /// Re-arm a RESUMED machine's meter without destroying the restored
    /// computron count: the meter's `index` survives; a
    /// fresh check window opens from it. This is the deliberate
    /// interval-CHANGE form — the host chose a new window, so the next
    /// check threshold restarts from the preserved index. A resume that
    /// wants the meter to continue **exactly** as suspended must use
    /// [`Self::reattach_meter_host`] instead: repeated sub-interval
    /// suspend/resume cycles through `rearm_meter` would move the check
    /// deadline forward each time. Snapshot `meter_fail_closed.rs` checks
    /// the rearm and reattach distinction. The host callback
    /// cannot travel in a snapshot, so every resume that wants metering
    /// MUST call one of the three arm forms — a restored machine that
    /// skips them fails closed at the next meter check.
    pub fn rearm_meter(&mut self, interval: u64, host: Box<dyn FnMut(u64) -> bool>) {
        self.meter.rearm(interval);
        self.meter_host = Some(host);
    }

    /// Reattach ONLY the host callback on a resumed machine, leaving
    /// every restored meter counter — `index`, `interval`, and the
    /// next-check threshold `count` — exactly as the snapshot carried
    /// them. Snapshot `meter_fail_closed.rs` checks this pure resume form: a machine
    /// suspended mid-window resumes as if never interrupted, so the
    /// host sees its callback at the original deadline rather than a
    /// freshly opened window. Meaningless on a snapshot whose meter was
    /// never armed (`interval == 0` never checks), exactly as suspended.
    pub fn reattach_meter_host(&mut self, host: Box<dyn FnMut(u64) -> bool>) {
        self.meter_host = Some(host);
    }

    /// The embedder's resume form: make
    /// a restored machine metered under `interval` whatever its snapshot
    /// carried. If the meter was suspended armed under exactly this
    /// `interval`, this is [`Self::reattach_meter_host`] — the window
    /// continues untouched, so a sub-interval suspend/resume cycle never
    /// moves the deadline. Otherwise (the store was written un-armed, or
    /// under a different interval) it is [`Self::rearm_meter`]: a fresh
    /// window opens from the preserved index. Either way the decision is
    /// a pure function of the snapshot and the configuration, so replicas
    /// configured alike consult their hosts at identical points, and no
    /// path yields the fail-closed armed-without-host state.
    pub fn attach_meter_host(&mut self, interval: u64, host: Box<dyn FnMut(u64) -> bool>) {
        if self.meter.interval_raw() == crate::meter::scale_interval(interval) {
            self.reattach_meter_host(host);
        } else {
            self.rearm_meter(interval, host);
        }
    }

    /// The accumulated raw meter index (diagnostic; the same value the
    /// meter state serializes).
    pub fn meter_index(&self) -> u64 {
        self.meter.state().index
    }

    /// Accrue a compiler work delta and consult the live meter host. A compiler
    /// callback must stop at the first false result. This also supports host
    /// compilation before a crank starts; failed admission prevents checkpointing
    /// until the managed lifecycle rewinds or a subsequent crank completes.
    pub fn charge_compilation(&mut self, raw: u64) -> bool {
        let accepted = match self.meter_host.as_mut() {
            Some(host) => self.meter.charge_compilation(raw, Some(host)),
            None => self.meter.charge_compilation(raw, None),
        };
        if !accepted {
            self.last_crank_completed = false;
        }
        accepted
    }

    /// The three reaction-arena lengths `(combinators, from_async,
    /// promise_guards)` — diagnostic for the arena-growth lock
    /// `reaction_arena_pruning.rs`: collection reclaims settled entries
    /// instead of retaining them for the machine's lifetime.
    pub fn reaction_arena_lens(&self) -> (usize, usize, usize) {
        (
            self.combinators.len(),
            self.from_async.len(),
            self.promise_guards.len(),
        )
    }

    /// Number of retained defining-code segments, for the GC compaction lock.
    pub fn retained_code_segment_count(&self) -> usize {
        self.code_segments.len()
    }

    /// A loop-closing metering check (`mxCheckMeter`). Consults the host
    /// when one is installed; a fresh, never-armed machine (the default
    /// the differential harness uses) keeps running. Adds nothing to
    /// `meterIndex`.
    ///
    /// Fail-closed: a meter that is ARMED
    /// (`interval != 0`, which a snapshot carries) but has no host
    /// attached — a restored machine whose embedder skipped every arm
    /// form — aborts at its first check point instead of running
    /// unbounded while reporting itself metered. The host callback
    /// cannot travel in a snapshot, so the only correct resume of an
    /// armed machine reattaches one; anything else is a configuration
    /// error, and the run halts [`Halt::MeterAbort`] rather than
    /// silently disabling the bound the snapshot says is in force. The
    /// rule fires only where checks fire: a crank with no loop-closing
    /// point (straight-line code) still completes on such a machine,
    /// exactly as an armed crank the host never refuses would.
    #[inline]
    fn check_meter(&mut self) -> MeterCheck {
        match self.meter_host.as_mut() {
            Some(host) => self.meter.check(host),
            None if self.meter.is_armed() => MeterCheck::Abort,
            None => MeterCheck::Continue,
        }
    }

    /// Admission inside a built-in, including the restored/armed/no-host
    /// fail-closed case. Call before allocating or doing the charged work.
    fn charge_and_check(&mut self, raw: u64) -> Result<(), Step> {
        let check = match self.meter_host.as_mut() {
            Some(host) => self.meter.charge_and_check(raw, host),
            None if self.meter.is_armed() => MeterCheck::Abort,
            None => self.meter.charge_and_check(raw, &mut |_| true),
        };
        if check == MeterCheck::Abort {
            Err(Step::Host(Halt::MeterAbort))
        } else {
            Ok(())
        }
    }

    fn charge_builtin_work(&mut self, count: u64) -> Result<(), Step> {
        let raw = count
            .checked_mul(crate::meter::BUILTIN_METERING)
            .ok_or(Step::Host(Halt::MeterAbort))?;
        self.charge_and_check(raw)
    }

    fn charge_chunk_work(&mut self, bytes: u64) -> Result<(), Step> {
        let aligned = bytes
            .checked_add(ironhorse_meter::CHUNK_ALIGNMENT - 1)
            .map(|n| n & !(ironhorse_meter::CHUNK_ALIGNMENT - 1))
            .and_then(|n| n.checked_add(ironhorse_meter::CHUNK_HEADER_BYTES))
            .and_then(|n| n.checked_mul(crate::meter::CHUNK_ALLOCATION_METERING))
            .ok_or(Step::Host(Halt::MeterAbort))?;
        self.charge_and_check(aligned)
    }

    /// Bound and prepay a UTF-16 result before its scratch buffer is created.
    /// The format ceiling is independent of the configurable heap policy.
    /// Finish with `new_reserved_string_units`, so the charge is paid once.
    fn reserve_units(&mut self, units: u64) -> Result<usize, Step> {
        self.reserve_units_growth(0, units)
    }

    /// Grow an already prepaid string result, charging only the additional
    /// chunk cost. Every previous unit is still present in the result.
    fn reserve_units_growth(&mut self, previous: u64, units: u64) -> Result<usize, Step> {
        if units > 0x7fff_ffff {
            return Err(self.catchable_range_error_msg("result too large".into()));
        }
        let units = units as usize;
        if !self.chunks.can_allocate(units * 2) {
            return Err(Step::Host(Halt::HeapExhausted));
        }
        let charge = |length: u64| {
            if length == 0 {
                0
            } else {
                string_chunk_cost(length)
            }
        };
        self.charge_and_check(charge(units as u64) - charge(previous))?;
        Ok(units)
    }

    /// Extend a string output only after admitting its complete new size.
    fn extend_reserved_units<T: Copy>(
        &mut self,
        output: &mut Vec<T>,
        addition: &[T],
    ) -> Result<(), Step> {
        let length = output
            .len()
            .checked_add(addition.len())
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        let bytes = length
            .checked_mul(std::mem::size_of::<T>())
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        if !self.chunks.can_allocate(bytes) {
            return Err(Step::Host(Halt::HeapExhausted));
        }
        self.reserve_units_growth(output.len() as u64, length as u64)?;
        output
            .try_reserve(addition.len())
            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
        output.extend_from_slice(addition);
        Ok(())
    }

    /// Admit UTF-8 scratch bytes while pricing the stored UTF-16 code units.
    /// The running unit count avoids rescanning the accumulated result.
    fn extend_reserved_text(
        &mut self,
        output: &mut Vec<u8>,
        addition: &[u8],
        units: &mut u64,
    ) -> Result<(), Step> {
        let added = String::from_utf8_lossy(addition).encode_utf16().count() as u64;
        let next = units
            .checked_add(added)
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        self.reserve_units_growth(*units, next)?;
        self.extend_prepaid_scratch(output, addition)?;
        *units = next;
        Ok(())
    }

    /// Bound an unmetered temporary by the heap profile before reserving it.
    /// Its caller prepays the operation's existing work charge first.
    fn reserve_scratch<T>(&mut self, capacity: usize) -> Result<Vec<T>, Step> {
        self.admit_scratch::<T>(capacity)?;
        Self::reserved_vec(capacity)
    }

    /// Admit new element-wise scratch work, charged once before collecting it.
    /// Unlike `reserve_scratch`, the caller has no existing prepaid loop cost.
    fn reserve_work_scratch<T>(&mut self, capacity: usize) -> Result<Vec<T>, Step> {
        self.admit_scratch::<T>(capacity)?;
        let raw = (capacity as u64)
            .checked_mul(crate::meter::BUILTIN_METERING)
            .ok_or(Step::Host(Halt::MeterAbort))?;
        self.charge_and_check(raw)?;
        Self::reserved_vec(capacity)
    }

    /// Bound each output expansion before copying, including `$` substitutions
    /// whose expansion can be much larger than the replacement template.
    fn extend_work_scratch<T: Copy>(
        &mut self,
        output: &mut Vec<T>,
        addition: &[T],
    ) -> Result<(), Step> {
        let length = output
            .len()
            .checked_add(addition.len())
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        self.admit_scratch::<T>(length)?;
        let charge = (addition.len() as u64)
            .checked_mul(crate::meter::BUILTIN_METERING)
            .ok_or(Step::Host(Halt::MeterAbort))?;
        self.charge_and_check(charge)?;
        output
            .try_reserve(addition.len())
            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
        output.extend_from_slice(addition);
        Ok(())
    }

    fn extend_prepaid_scratch<T: Copy>(
        &mut self,
        output: &mut Vec<T>,
        addition: &[T],
    ) -> Result<(), Step> {
        let length = output
            .len()
            .checked_add(addition.len())
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        self.admit_scratch::<T>(length)?;
        output
            .try_reserve(addition.len())
            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
        output.extend_from_slice(addition);
        Ok(())
    }

    fn push_prepaid_scratch<T>(&mut self, output: &mut Vec<T>, value: T) -> Result<(), Step> {
        let length = output
            .len()
            .checked_add(1)
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        self.admit_scratch::<T>(length)?;
        output
            .try_reserve(1)
            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
        output.push(value);
        Ok(())
    }

    /// Fill an already admitted buffer without permitting a hidden resize.
    fn fill_scratch<T>(mut buffer: Vec<T>, values: impl IntoIterator<Item = T>) -> Vec<T> {
        for value in values {
            if buffer.len() == buffer.capacity() {
                crate::value::heap_exhausted();
            }
            buffer.push(value);
        }
        buffer
    }

    fn admit_scratch<T>(&mut self, capacity: usize) -> Result<(), Step> {
        let bytes = capacity
            .checked_mul(std::mem::size_of::<T>())
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        if !self.chunks.can_allocate(bytes) {
            return Err(Step::Host(Halt::HeapExhausted));
        }
        self.charge_and_check(0)
    }

    /// Reserve a bounded representation copy for immutable host diagnostics.
    /// This helper cannot charge work; guest callers use their normal admission
    /// checkpoints. It is restricted to copies, never guest numeric lengths.
    fn reserve_copy_scratch<T>(&self, capacity: usize) -> Vec<T> {
        let bytes = capacity
            .checked_mul(std::mem::size_of::<T>())
            .unwrap_or_else(|| crate::value::heap_exhausted());
        if !self.chunks.can_allocate(bytes) {
            crate::value::heap_exhausted();
        }
        Self::reserved_vec(capacity).unwrap_or_else(|_| crate::value::heap_exhausted())
    }

    /// Materialize a capacity already admitted by `reserve_units` or a chunk
    /// admission check. Host allocator refusal is also an execution halt.
    fn reserved_vec<T>(capacity: usize) -> Result<Vec<T>, Step> {
        let mut buffer = Vec::new();
        buffer
            .try_reserve_exact(capacity)
            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
        Ok(buffer)
    }

    fn new_reserved_string_units(&mut self, units: &[u16]) -> Slot {
        let off = self.chunks.alloc(&units_to_be16(units));
        Slot::of(Kind::String, Payload::String(off))
    }

    /// Whether the meter is armed (`interval != 0`) — the state a
    /// snapshot carries — independent of whether a host callback is
    /// attached. An embedder resuming a machine consults this to decide
    /// between [`Self::reattach_meter_host`] (the meter was armed when
    /// suspended; continue its window exactly) and
    /// [`Self::rearm_meter`] (it was not; open one now).
    pub fn meter_is_armed(&self) -> bool {
        self.meter.is_armed()
    }

    /// Whether a host callback is attached. `meter_is_armed() &&
    /// !meter_host_attached()` is the fail-closed state every check
    /// point aborts on.
    pub fn meter_host_attached(&self) -> bool {
        self.meter_host.is_some()
    }

    /// Accrue the program-frame + eval-environment setup overhead, once,
    /// at the `BEGIN_*` program-entry opcode: the invocation baseline
    /// ([`PROGRAM_INVOCATION_COMPUTRONS`] dispatches XS meters in the
    /// caller frame before the captured bytecode) plus the measured
    /// environment-setup aggregate ([`PROGRAM_ENV_SETUP_METERING`]). Both
    /// are raw 16.16 units so they compose with the allocation metering
    /// through the carry into computrons. Synthetic bytecode that never
    /// executes a `BEGIN_*` (the meter unit tests) never accrues it.
    #[inline]
    fn tick_program_overhead(&mut self) {
        self.meter
            .tick_raw(PROGRAM_INVOCATION_COMPUTRONS * crate::meter::CODE_METERING);
        self.meter.tick_raw(PROGRAM_ENV_SETUP_METERING);
    }

    /// `fxRunEvalEnvironment`'s global-hoist branch: each declared
    /// top-level `var` (a `NEW_LOCAL` name) becomes an own property of
    /// the global object. Materialize each not-yet-present name's global
    /// property in declaration order, metering the allocation. Idempotent
    /// across a re-declared name (its property is created once).
    fn hoist_vars_to_global(&mut self) -> Result<(), Slot> {
        // Declaration order = the `locals` index the name maps to.
        let mut names: Vec<(usize, u16)> = self.id_map.iter().map(|(&id, &i)| (i, id)).collect();
        names.sort_unstable();
        let direct_variable_env = self.direct_eval_variable_environment();
        for (index, id) in names {
            // GlobalDeclarationInstantiation: a top-level **function**
            // declaration must satisfy `CanDeclareGlobalFunction`, else it is
            // a `TypeError` before any body runs. The compiler hoists a
            // function declaration's local to `null` (its placeholder) and a
            // `var` to `undefined`, so the local's kind here tells the two
            // apart with no source inspection.
            let kind = self.locals.get(index).map(|slot| slot.kind);
            let is_function_declaration = matches!(kind, Some(Kind::Null));
            if let Some(variable_env) = direct_variable_env {
                if self.has_lexical_binding_before(variable_env, id) {
                    return Err(self.internal_error(
                        "SyntaxError",
                        format!("{}: duplicate variable", self.property_debug_name(id)),
                    ));
                }
                if !self.has_function_var_binding(variable_env, id) {
                    self.append_environment_capture(variable_env, id, Slot::undefined());
                }
                continue;
            }
            // A **direct** eval's `var`/function declaration that collides with an
            // enclosing lexical binding — here the realm's global lexical
            // environment, holding the running program's top-level
            // `let`/`const`/`class` — is the direct-eval "duplicate variable"
            // early error, a catchable `SyntaxError` (EvalDeclarationInstantiation
            // step 5.d.ii.2.a.i and the direct-eval scoping). The binding lives on
            // the active declarative environment chain, which a direct eval shares
            // with its caller; an indirect eval runs in a fresh global variable
            // scope that does not see it, so it never raises this — matching XS,
            // which throws only for the direct form.
            if self.direct_eval_hoist && self.has_lexical_env_binding(id) {
                return Err(self.internal_error(
                    "SyntaxError",
                    format!("{}: duplicate variable", self.property_debug_name(id)),
                ));
            }
            if self.global_props.contains_key(&id) {
                if is_function_declaration && !self.can_declare_global_function(id) {
                    return Err(self.internal_error(
                        "TypeError",
                        format!(
                            "{}: global property not configurable and not enumerable or writable",
                            self.property_debug_name(id)
                        ),
                    ));
                }
            } else {
                // The property does not yet exist, so it must be *created* on the
                // global object. Both `CanDeclareGlobalVar` (ECMA-262 9.1.1.4.15)
                // and `CanDeclareGlobalFunction` (9.1.1.4.16) reduce, for an absent
                // name, to `IsExtensible(globalThis)`: a non-extensible global
                // (`Object.preventExtensions(this)`) cannot gain a new binding, so
                // the declaration is a `TypeError` before any body runs. At the
                // top-level program this is unobservable (nothing has run to freeze
                // the global yet); it is reached by an `eval` whose realm already
                // sealed its global. An extensible global (the overwhelming common
                // case) is unaffected, so this never perturbs an existing run.
                if !self.instance_extensible(self.global_obj) {
                    return Err(self.internal_error(
                        "TypeError",
                        format!(
                            "{}: global object not extensible",
                            self.property_debug_name(id)
                        ),
                    ));
                }
                // `CreateGlobalVarBinding` / `CreateGlobalFunctionBinding` take
                // the `D` argument as the new property's **configurable**
                // attribute. GlobalDeclarationInstantiation (a Script) passes
                // `D = false`, so a top-level declaration is non-configurable
                // and `delete globalThis.g` answers `false`;
                // EvalDeclarationInstantiation passes `D = true`, so an eval's
                // global `var` stays deletable. The sloppy implicit global from
                // an unqualified assignment (`x = 1`) is not a declaration at
                // all and is created configurable on the `SET_VARIABLE` path,
                // which does not come through here.
                let property = self.materialize_global_property(id);
                if !self.eval_program_hoist {
                    self.slots.get_mut(property).flag |= XS_DONT_DELETE_FLAG;
                }
            }
        }
        Ok(())
    }

    /// The nearest caller variable environment used by a direct eval inside a
    /// function. The compiler publishes function scopes as declarative
    /// environment instances: a `null` behavior marks the variable environment
    /// and an `undefined` behavior marks lexical/parameter layers. Object
    /// (`with`) environments carry a reference and are skipped.
    fn direct_eval_variable_environment(&self) -> Option<crate::value::SlotIndex> {
        if !self.direct_eval_hoist || self.env.kind != Kind::Reference {
            return None;
        }
        let mut env = match self.env.value {
            Payload::Reference(env) => env,
            _ => return None,
        };
        while !env.is_null() {
            let behavior = self.slots.get(env).next;
            if !behavior.is_null() && self.slots.get(behavior).kind == Kind::Null {
                return Some(env);
            }
            env = self.instance_prototype(env);
        }
        None
    }

    /// Whether a declarative lexical layer between the active environment head
    /// and `variable_env` already binds `id`. EvalDeclarationInstantiation
    /// rejects a `var`/function declaration at that collision, while parameter
    /// and older variable layers below `variable_env` remain valid targets.
    fn has_lexical_binding_before(&self, variable_env: crate::value::SlotIndex, id: u16) -> bool {
        let mut env = match self.env.value {
            Payload::Reference(env) => env,
            _ => return false,
        };
        while !env.is_null() && env != variable_env {
            let behavior = self.slots.get(env).next;
            if !behavior.is_null() {
                let slot = self.slots.get(behavior);
                if slot.kind != Kind::Reference && self.environment_property(env, id).is_some() {
                    return true;
                }
            }
            env = self.instance_prototype(env);
        }
        false
    }

    /// Whether `id` is already published in the current function's variable
    /// environment group. XS's eval-poisoned function layout has the body var
    /// layer first, then parameter bindings, then a second `null` behavior
    /// boundary. Reusing a parameter/body cell is required for `eval('var a =
    /// ...')`; walking beyond the second boundary would incorrectly reuse a
    /// binding captured from an outer function.
    fn has_function_var_binding(&self, variable_env: crate::value::SlotIndex, id: u16) -> bool {
        let mut env = variable_env;
        let mut null_boundaries = 0usize;
        while !env.is_null() {
            let behavior = self.slots.get(env).next;
            if !behavior.is_null() {
                let slot = self.slots.get(behavior);
                if slot.kind != Kind::Reference && self.environment_property(env, id).is_some() {
                    return true;
                }
                if slot.kind == Kind::Null {
                    null_boundaries += 1;
                    if null_boundaries == 2 {
                        return false;
                    }
                }
            }
            env = self.instance_prototype(env);
        }
        false
    }

    /// ECMA-262 § 9.1.1.4.16 `CanDeclareGlobalFunction` over this realm's
    /// global object. A name with no existing own global property can always
    /// be declared (the global object is extensible in this model); an
    /// existing property permits redeclaration as a function only if it is
    /// configurable, or a writable-and-enumerable data property. The frozen
    /// primordial value globals (`NaN`/`Infinity`/`undefined`) are none of
    /// these, so `function NaN(){}` is rejected. Accessor globals are not
    /// modeled, so every existing global here is a data property.
    fn can_declare_global_function(&self, id: u16) -> bool {
        match self.global_props.get(&id) {
            None => true,
            Some(&prop) => {
                let flag = self.slots.get(prop).flag;
                if flag & XS_DONT_DELETE_FLAG == 0 {
                    return true; // configurable
                }
                let writable = flag & XS_DONT_SET_FLAG == 0;
                let enumerable = flag & XS_DONT_ENUM_FLAG == 0;
                writable && enumerable
            }
        }
    }

    #[inline]
    fn push(&mut self, s: Slot) {
        self.stack.push(s);
    }
    #[inline]
    fn pop(&mut self) -> Slot {
        self.stack.pop().unwrap_or_else(Slot::undefined)
    }

    /// The content bytes of a heap string (up to the C NUL terminator, or
    /// the whole payload for an interned string stored without one): XS's
    /// `mxStringLength`/`c_strlen` view of a string value.
    #[inline]
    /// The raw stored payload of a string value: its **UTF-16 big-endian**
    /// code-unit bytes (2 bytes per code unit, revised 2026-07-06 from the
    /// CESU-8 build — design § Value and heap model). There is no NUL
    /// terminator (a UTF-16 code unit U+0000 is `00 00`, so a byte scan
    /// cannot mark the end); the length comes from the chunk header. Big-
    /// endian is chosen so byte-lexicographic order over this slice equals
    /// UTF-16 code-unit order, which is exactly the ECMAScript string
    /// ordering — the relational/equality opcodes therefore compare these
    /// bytes directly with no decode.
    fn str_content(&self, off: crate::value::ChunkOffset) -> crate::value::ChunkSlice<'_> {
        self.chunks.payload(off)
    }

    /// The string value's code units (`str_content` decoded from UTF-16BE).
    fn str_units(&self, off: crate::value::ChunkOffset) -> Vec<u16> {
        string_decode_instrumentation::record();
        be16_to_units(&self.str_content(off))
    }

    /// The single code unit at `index`, read straight out of the stored
    /// UTF-16BE payload.
    ///
    /// O(1), and that is the point: reading one unit through [`Self::str_units`]
    /// decodes and ALLOCATES the whole string first, so walking a String
    /// wrapper's units one at a time was quadratic. At 70,000 units
    /// `harden(new String('x'.repeat(70000)))` spent over 400 seconds for
    /// ~18,000 computrons — work the meter cannot see, which is a denial of
    /// service in a metered engine even though nothing is minted.
    fn str_unit_at(&self, off: crate::value::ChunkOffset, index: u32) -> Option<u16> {
        let at = (index as usize).checked_mul(2)?;
        let bytes = self.chunks.payload_range(off, at..at.checked_add(2)?)?;
        Some(u16::from_be_bytes([bytes[0], bytes[1]]))
    }

    /// The string value's code-unit length (`length`, O(1) — half the stored
    /// byte payload, no decode walk).
    #[inline]
    fn str_len(&self, off: crate::value::ChunkOffset) -> usize {
        self.chunks.len_of(off) / 2
    }

    /// The string value rendered to a Rust `String` (`String::from_utf16_lossy`
    /// over the code units), for the display/debug boundary and text-semantic
    /// built-ins. Lone surrogates render as U+FFFD, matching the oracle shim's
    /// lossy decode at the same boundary.
    fn str_text(&self, off: crate::value::ChunkOffset) -> String {
        String::from_utf16_lossy(&self.str_units(off))
    }

    /// Allocate a String value's chunk from **UTF-8 text** bytes, encoding them
    /// to the stored UTF-16BE form. Unmetered — callers that meter the
    /// allocation do so separately (at code-unit granularity). For text that is
    /// pure ASCII (rendered numbers, names, typeof atoms) the code-unit count
    /// equals the input byte count.
    fn alloc_str_text(&mut self, text: &[u8]) -> crate::value::ChunkOffset {
        let units: Vec<u16> = String::from_utf8_lossy(text).encode_utf16().collect();
        self.chunks.alloc(&units_to_be16(&units))
    }

    /// Allocate and price UTF-8 text using the same UTF-16 length as storage.
    fn alloc_str_text_metered(&mut self, text: &[u8]) -> Result<crate::value::ChunkOffset, Step> {
        let text = String::from_utf8_lossy(text);
        let count = text.encode_utf16().count();
        self.charge_and_check(string_chunk_cost(count as u64))?;
        self.admit_scratch::<u16>(count)?;
        let mut units = Self::reserved_vec(count)?;
        units.extend(text.encode_utf16());
        Ok(self.chunks.alloc(&units_to_be16(&units)))
    }

    /// Render a completion/thrown value the way the oracle shim does:
    /// `fxToString` then a lossy decode of the string's code units
    /// (`String::from_utf16_lossy`), the display/debug boundary the design's
    /// § Value and heap model routes through UTF-16. Non-string kinds defer to
    /// [`slot_to_ecma_string`].
    ///
    /// The array arm recurses over the elements (the `join` XS's `fxToString`
    /// runs), so a self-containing or deeply nested array is bounded by the
    /// native-recursion budget: past [`NATIVE_DEPTH_LIMIT`] the render fails
    /// with [`Halt::StackOverflow`], the abort XS reaches for the same value
    /// through its C stack, rather than overflowing the host's. The budget is
    /// threaded as a parameter because this renderer is `&self`; it starts at
    /// whatever native depth the caller is at, so a diagnostic render from
    /// inside a native shares the one ceiling.
    fn render(&self, s: &Slot) -> Result<String, Step> {
        self.render_at(s, self.native_depth)
    }

    /// The renderer's budget for one more level of element recursion, or the
    /// refusal. Charged only where the renderer actually descends, so a
    /// scalar or an error object renders at any depth — including a
    /// diagnostic render at the very ceiling — and only nesting is refused.
    fn render_descend(&self, depth: usize) -> Result<usize, Step> {
        if depth + LIGHT_FRAME_COST > NATIVE_DEPTH_LIMIT {
            return Err(Step::Host(Halt::StackOverflow(self.stack_slots_in_use())));
        }
        Ok(depth + LIGHT_FRAME_COST)
    }

    fn render_at(&self, s: &Slot, depth: usize) -> Result<String, Step> {
        Ok(match s.value {
            Payload::String(off) => self.str_text(off),
            // A BigInt completion renders as its decimal magnitude (XS's
            // `String(aBigInt)`), no `n` suffix.
            Payload::BigInt(off) => {
                let (neg, mag) = self.read_bigint(off);
                bi_to_decimal(neg, &mag)
            }
            Payload::Reference(r) => {
                // An Error instance stringifies through `Error.prototype.
                // toString`: `name` with an empty/absent message, else
                // `name: message` — the abort/completion value parity the
                // Error hierarchy graduates.
                if self.arguments_objects.contains(&r) {
                    // An `arguments` object's `Object.prototype.toString`
                    // builtinTag is `Arguments` (its prototype is
                    // `Object.prototype`, so `String(arguments)` does NOT run
                    // `Array.prototype.join`). It is stored in the array side
                    // table for its indexed elements, so this arm precedes the
                    // array arm to keep the join from mis-rendering `1,2` where
                    // the oracle reports `[object Arguments]`.
                    "[object Arguments]".to_string()
                } else if let Some(a) = self.arrays.get(&r) {
                    // An array stringifies through `Array.prototype.toString` →
                    // `join(",")`: each index in `[0, length)` rendered, holes
                    // and `undefined`/`null` rendered as the empty string,
                    // joined with commas.
                    let depth = self.render_descend(depth)?;
                    let mut out = String::new();
                    for i in 0..a.length {
                        if i > 0 {
                            out.push(',');
                        }
                        if let Some(item) = a.items().get(&i) {
                            if item.kind != Kind::Undefined && item.kind != Kind::Null {
                                out.push_str(&self.render_at(item, depth)?);
                            }
                        } else if let Some(id) = self.symbol_ids.get(i.to_string()).copied() {
                            // A restrictive `defineProperty` descriptor moves
                            // the index out of the compact item table and into
                            // the ordinary property chain. Completion rendering
                            // is the host's `String(result)`/array join boundary;
                            // include a materialized data index just as the
                            // guest `join` path's MOP read does. (An accessor
                            // would require re-entering guest code after the
                            // run and remains outside this read-only renderer.)
                            if let Some(property) = self.find_property(r, id) {
                                let item = self.slots.get(property);
                                if item.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) == 0
                                    && item.kind != Kind::Undefined
                                    && item.kind != Kind::Null
                                {
                                    out.push_str(&self.render_at(&item, depth)?);
                                }
                            }
                        }
                    }
                    out
                } else if self.typed_arrays.contains_key(&r) {
                    // A TypedArray's `toString` IS `Array.prototype.toString`
                    // (`%TypedArray%.prototype.toString === Array.prototype.
                    // toString`), so `String(new Int8Array(3))` is the `join(",")`
                    // of its elements (`0,0,0`) — NOT the `[object …]` tag its
                    // shared `Symbol.toStringTag` would give through
                    // `Object.prototype.toString`. Render each in-bounds element.
                    let ta = self.typed_arrays[&r];
                    let mut out = String::new();
                    for i in 0..ta.length {
                        if i > 0 {
                            out.push(',');
                        }
                        // A BigInt-element view (kinds 0/1) reads through the
                        // decimal helper; every other kind decodes to a Number.
                        let text = if ta.kind <= 1 {
                            self.typed_array_element_bigint_decimal(ta, i)
                        } else {
                            match self.typed_array_element_get(ta, i) {
                                Some(slot) => self.render_at(&slot, depth)?,
                                None => String::new(),
                            }
                        };
                        out.push_str(&text);
                    }
                    out
                } else if self.array_buffers.contains_key(&r) {
                    // `ArrayBuffer`/`SharedArrayBuffer` inherit
                    // `Object.prototype.toString`; their prototype's
                    // `Symbol.toStringTag` is `ArrayBuffer`/`SharedArrayBuffer`.
                    if self.shared_buffers.contains(&r) {
                        "[object SharedArrayBuffer]".to_string()
                    } else {
                        "[object ArrayBuffer]".to_string()
                    }
                } else if self.data_views.contains_key(&r) {
                    // `DataView` inherits `Object.prototype.toString`; its
                    // prototype's `Symbol.toStringTag` is `DataView`.
                    "[object DataView]".to_string()
                } else if let Some(c) = self.collections.get(&r) {
                    // A Map/Set/WeakMap/WeakSet stringifies through
                    // `Object.prototype.toString` under its `Symbol.toStringTag`
                    // ("Map"/"Set"/…): `[object Map]` &co. — the completion the
                    // oracle reports for a bare collection.
                    match c.kind {
                        CollKind::Map => "[object Map]".to_string(),
                        CollKind::Set => "[object Set]".to_string(),
                        CollKind::WeakMap => "[object WeakMap]".to_string(),
                        CollKind::WeakSet => "[object WeakSet]".to_string(),
                    }
                } else if self.promises.contains_key(&r) {
                    // A promise stringifies through `Object.prototype.toString`
                    // under its `Symbol.toStringTag` ("Promise"): `[object
                    // Promise]` — the completion the oracle reports for a bare
                    // promise.
                    "[object Promise]".to_string()
                } else if let Some(d) = self.regexps.get(&r) {
                    // A RegExp stringifies through `RegExp.prototype.toString`
                    // as the `/source/flags` literal (the empty pattern renders
                    // its `(?:)` source).
                    let (source, _alloc) = self.regexp_source_bytes(r);
                    format!("/{}/{}", String::from_utf8_lossy(&source), d.flags)
                } else if let Some(info) = self.error_data.get(&r) {
                    match &info.message {
                        Some(m) if !m.is_empty() => format!("{}: {}", info.name, m),
                        _ => info.name.to_string(),
                    }
                } else if let Some(prim) = self.wrapper_data.get(&r).copied() {
                    // A primitive wrapper (`new Boolean`/`Number`/`String`)
                    // stringifies as its wrapped primitive value.
                    self.render_at(&prim, self.render_descend(depth)?)?
                } else if let Some(n) = self.native_of(r) {
                    // A native (intrinsic) function stringifies through
                    // `Function.prototype.toString` as a host function
                    // (verified against the pin for a bare `Object`/`Boolean`).
                    format!("function [\"{}\"] (){{[native code]}}", n.display_name())
                } else if let Some(fi) = self
                    .functions
                    .get(&r)
                    .filter(|fi| fi.native.is_none() && fi.method.is_none())
                {
                    // A user (bytecode) function, an arrow, a class constructor,
                    // or a bound function (`f.bind(...)`, whose `name` is already
                    // `"bound "+target`) stringifies through the SAME
                    // `Function.prototype.toString` host-function synthesis the
                    // pinned Moddable emits for every callable:
                    // `function ["<name>"] (){[native code]}`, its own `.name`
                    // interpolated (empty for an anonymous function/arrow). XS's
                    // toString never reproduces the source text, so no
                    // source-span retention is needed; this is a display-only
                    // render (no metering), closing the `non-primitive-
                    // completion` gap for a function-valued completion. A native
                    // *prototype method* (`[].map`, dispatched by `NativeMethod`
                    // so `native_of` is `None`) is excluded here: its `FuncInfo`
                    // carries no `.name`, so it stays the generic reference stub
                    // rather than mis-render as an empty-named host function
                    // (which would turn an honest skip into a divergence).
                    format!("function [\"{}\"] (){{[native code]}}", fi.name)
                } else if let Some(tag) = self.string_tag_of(r) {
                    // An ordinary object carrying a string `Symbol.toStringTag`
                    // on its own/inherited chain stringifies through
                    // `Object.prototype.toString` step 15 as `[object <Tag>]`.
                    // In the pinned oracle profile no *metered* case has such a
                    // tag (only guest-set tags reach here), so this closes the
                    // gap for a `Symbol.toStringTag` completion without
                    // perturbing a covered case (which has no tag and falls
                    // through to the generic reference stub below).
                    format!("[object {}]", tag)
                } else {
                    slot_to_ecma_string(s)
                }
            }
            _ => slot_to_ecma_string(s),
        })
    }

    /// Render an uncaught thrown value the way the oracle shim's host
    /// boundary does (`String(exception)` after `fxRunScript`): a thrown user
    /// object runs its guest `toString` (sta.js's `Test262Error` carries
    /// one), so the abort value matches the oracle's rendering of the same
    /// failure. Native errors also use their observable `name`, `message`,
    /// and coercion hooks: the guest may have changed them since construction.
    /// Any failure inside guest coercion falls back to the static rendering.
    ///
    /// Called from [`Self::run`] only, once the halt has actually reached the
    /// host. An escape out of a nested dispatch is not yet uncaught — a
    /// native `mxTry` (a promise executor, a reaction, a disposer) may still
    /// catch it, and XS's `mxCatch` copies `mxException` without running any
    /// guest code — so the escape sites carry the static render and the
    /// guest `toString` runs here or never. See
    /// `tests/engine_throws_are_catchable.rs` for the once-at-host-boundary lock. The shim's
    /// stringification is post-run, so its metering is discarded too: the
    /// oracle records the run-only count at the throw.
    ///
    /// The text is a diagnostic and never decides the crank's outcome: the
    /// guest coercion running past the native-recursion budget (a thrown
    /// self-containing array's `join`) is discarded like any other failure,
    /// and a value the static renderer refuses for the same reason gets the
    /// reference stub ([`Self::render_or_stub`]). XS's host does abort
    /// rendering such a value; ironhorse reports the throw with the stub
    /// text instead — a divergence confined to the text of a throw nothing
    /// could have caught.
    fn render_uncaught(&mut self, code: &[u8], v: Slot) -> String {
        // Rendering is a host diagnostic boundary, not a second guest throw:
        // if the diagnostic ToPrimitive itself fails, discard that attempt
        // completely so it cannot replace the original value (or leave an
        // extra callback frame behind).
        let saved_exception = self.exception;
        let saved_meter = self.meter.clone();
        let stack_base = self.stack.len();
        let call_depth = self.call_stack.len();
        let jump_depth = self.jumps.len();
        if let Payload::Reference(_) = v.value {
            if v.kind == Kind::Reference {
                match self.to_primitive(code, v, true) {
                    Ok(prim) => {
                        self.exception = saved_exception;
                        self.meter = saved_meter;
                        if prim.kind == Kind::String {
                            if let Payload::String(off) = prim.value {
                                return self.str_text(off);
                            }
                        }
                        if prim.kind != Kind::Reference {
                            return self.render_or_stub(&prim);
                        }
                    }
                    Err(_) => {
                        while self.call_stack.len() > call_depth {
                            let _ = self.leave_call();
                        }
                        self.stack.truncate(stack_base);
                        self.jumps.truncate(jump_depth);
                        self.meter = saved_meter;
                    }
                }
            }
        }
        self.exception = saved_exception;
        self.render_or_stub(&v)
    }

    /// [`Self::render`], or the bounded reference stub when the render
    /// refuses the value (a self-containing or very deep array runs past the
    /// native-recursion budget) — for the throw-site and host-boundary
    /// renders of a thrown value, which must not turn the throw into a halt.
    fn render_or_stub(&self, s: &Slot) -> String {
        self.render(s).unwrap_or_else(|_| slot_to_ecma_string(s))
    }

    /// The string value of an instance's `Symbol.toStringTag` (own or
    /// inherited), for the completion-render boundary — a read-only (`&self`)
    /// analogue of [`Self::string_to_string_tag`] that never interns. Returns
    /// `None` when the well-known `Symbol.toStringTag` was never used as a key
    /// (so no property can carry it), when no chain slot holds it, or when the
    /// held value is not a string (`Object.prototype.toString` ignores a
    /// non-string tag).
    fn string_tag_of(&self, inst: crate::value::SlotIndex) -> Option<String> {
        // The well-known `Symbol.toStringTag`'s descriptor identity, then the
        // interned key id it maps to. Both must already exist: a program that
        // set `[Symbol.toStringTag]` interned the key when it wrote the
        // property, so a missing entry means no such property can exist.
        let descriptor = self
            .well_known_symbols
            .iter()
            .find_map(|(name, value)| (*name == "toStringTag").then_some(value.value))?;
        let descriptor = match descriptor {
            Payload::Reference(d) => d,
            _ => return None,
        };
        let tag_id = *self.symbol_key_ids.get(&descriptor)?;
        let mut cur = inst;
        while !cur.is_null() {
            if let Some(prop) = self.find_property(cur, tag_id) {
                let slot = self.slots.get(prop);
                if slot.kind == Kind::String {
                    if let Payload::String(off) = slot.value {
                        return Some(self.str_text(off));
                    }
                }
                return None;
            }
            cur = self.instance_prototype(cur);
        }
        None
    }

    /// The descriptive string of a symbol value (XS's `fxSymbolToString`):
    /// `Symbol(` + the description (empty when the description is `undefined`)
    /// + `)`. A symbol carries `Payload::Reference(desc)`, the description slot
    /// (a `String` or `undefined`).
    fn symbol_descriptive_bytes(&self, sym: Slot) -> Vec<u8> {
        let mut out = b"Symbol(".to_vec();
        if let Payload::Reference(d) = sym.value {
            if let Payload::String(off) = self.slots.get(d).value {
                out.extend_from_slice(self.str_text(off).as_bytes());
            }
        }
        out.push(b')');
        out
    }

    /// Run a program bytecode buffer to completion.
    /// Run under a dispatch-count ceiling: identical to [`Self::run`] but
    /// halts with [`Halt::StepLimit`] if the program dispatches `step_limit`
    /// opcodes without completing. For un-metered callers (the decoder fuzz
    /// harness) that must stay total on arbitrary/malformed bytecode without
    /// wedging on a non-terminating dispatch cycle.
    pub fn run_bounded(&mut self, code: &[u8], step_limit: u64) -> RunOutcome {
        // Scoped, not latched: the ceiling applies to
        // THIS run; a later plain `run` is unbounded again.
        let prev = self.step_limit;
        self.step_limit = step_limit;
        let out = self.run(code);
        self.step_limit = prev;
        out
    }

    /// Run borrowed bytecode, copying it into an owned buffer so escaping
    /// functions can retain it. Owners that already share their compiled
    /// program should use [`Self::run_shared`] to avoid this conversion.
    pub fn run(&mut self, code: &[u8]) -> RunOutcome {
        self.run_shared(std::rc::Rc::from(code))
    }

    /// Execute caller-owned immutable bytecode without copying its bytes.
    /// Escaping functions retain this same allocation across later cranks.
    pub fn run_shared(&mut self, shared: std::rc::Rc<[u8]>) -> RunOutcome {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.run_inner(shared))) {
            Ok(outcome) => outcome,
            Err(payload) if payload.is::<crate::value::HeapExhausted>() => {
                // All native activations have unwound. The interrupted heap
                // remains non-quiescent and must be rewound by the supervisor.
                self.native_depth = 0;
                self.last_crank_completed = false;
                RunOutcome {
                    completed: false,
                    result: String::new(),
                    coercion_error: None,
                    computrons: self.meter.computrons(),
                    dispatched: self.n_dispatched,
                    meter_raw: self.meter.raw(),
                    halt: Halt::HeapExhausted,
                    host_render_halt: None,
                }
            }
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }

    fn run_inner(&mut self, shared: std::rc::Rc<[u8]>) -> RunOutcome {
        let code: &[u8] = &shared;
        if self.slots.capacity() > self.slots.ceiling()
            || self.chunks.byte_size() > self.chunks.ceiling()
        {
            crate::value::heap_exhausted();
        }
        // A halted crank retains its activation for inspection until the
        // caller explicitly starts another run. Abandon that activation now:
        // otherwise its frames make BEGIN treat this program as a callee,
        // and its operands, handler PCs, or with environment leak into it.
        // Captured locals and environments already live in arena cells and
        // retained function records; dropping these transient roots preserves
        // them. Keep queued jobs, metering, poison latches, and the externally
        // configured eval_program_hoist policy unchanged.
        while !self.call_stack.is_empty() {
            let _ = self.leave_call();
        }
        self.stack.clear();
        self.jumps.clear();
        self.locals.clear();
        self.id_map.clear();
        self.args.clear();
        self.this_captures.clear();
        self.frame_slots = 0;
        self.result = Slot::undefined();
        self.exception = Slot::undefined();
        self.this_val = Slot::undefined();
        self.env = Slot::undefined();
        self.cur_func = crate::value::SlotIndex::NULL;
        self.target_func = crate::value::SlotIndex::NULL;
        self.cur_target = false;
        self.pending_new_target = None;
        self.resume_status = ResumeStatus::NoStatus;
        self.eval_direct = false;
        self.direct_eval_hoist = false;
        // Retain the top-level bytecode so an eval-defined function that calls
        // back into a top-level function can be dispatched over the right
        // buffer from a nested segment. Only the cross-segment call path reads
        // it, and that path is gated on an eval having defined a function.
        self.top_level_code = Some(shared.clone());
        // Top-level functions defined by this crank lazily promote the
        // current buffer into `code_segments` at their first CODE opcode.
        // No-function cranks retain no segment and keep the common path
        // allocation-free when the caller shares the buffer.
        self.active_segment = None;
        // Each crank starts sloppy until its own BEGIN_STRICT. A previous
        // strict crank must not affect later programs or distinguish a live
        // machine from its resumed twin; see `strict_crank_boundary.rs`.
        // Function entry and activation restore set strictness per frame.
        self.strict = false;
        // The lifecycle latch drops at entry: from here until the exit
        // below the machine is mid-crank, and any observer that asks
        // `is_quiescent` (a re-entrant host, a panic-recovery path) is
        // told so. It is re-established from the engine's own halt.
        self.last_crank_completed = false;
        let mut step = self.dispatch(code);
        // Pump-loop latch: after the script settles, drain the promise job
        // queue with metering still accumulating — the host-driven microtask
        // drain the ironhorse embedding performs after a crank (design § promises).
        // This mirrors the oracle shim's post-`fxRunScript` `fxRunPromiseJobs`
        // loop, so the metered computrons include the reactions. The script's
        // completion value (`self.result`) was fixed at `END` and is not
        // changed by the drain (reactions mutate closure state, not the
        // top-level result). A job that reaches an un-modeled path turns the
        // whole run into an honest `Halt::NotImplemented`.
        if step == Step::Returned {
            let script_result = self.result;
            if let Err(h) = self.run_promise_jobs(code) {
                step = h;
            }
            self.result = script_result;
        }
        let halt = self.finish_step(code, step);
        // The ENGINE's verdict on this crank: the dispatch reached `END`
        // and the job queue drained, so the machine stands at a crank
        // boundary. `completed`, the boundary-register clear and the
        // quiescence latch all key on it, whatever the oracle harness
        // makes of the completion value below. A host coercion failure must
        // neither skip the register clear nor change this guest verdict;
        // snapshot `tests/persist_gates.rs` checks the resulting boundary.
        let completed = halt == Halt::Return;
        let completion = self.result;
        // Dispatch owns the lifecycle verdict. Clear activation roots before
        // either host coercion; rendering reads the captured value and cannot
        // execute guest code or collect the heap.
        if completed {
            self.result = Slot::undefined();
            self.exception = Slot::undefined();
            self.locals.clear();
            self.id_map.clear();
            self.args.clear();
            self.this_captures.clear();
            self.this_val = Slot::undefined();
            self.env = Slot::undefined();
            self.cur_func = crate::value::SlotIndex::NULL;
            self.target_func = crate::value::SlotIndex::NULL;
            self.cur_target = false;
            self.frame_slots = 0;
            self.pending_new_target = None;
            self.resume_status = ResumeStatus::NoStatus;
            self.eval_direct = false;
            self.direct_eval_hoist = false;
            self.strict = false;
            self.top_level_code = None;
        }

        // The oracle shim coerces the completion with `String(result)`
        // AFTER the run. Two completion values make that coercion throw:
        // a Symbol (`ToString` of a Symbol is a TypeError), and a bare
        // ordinary object with a null prototype (neither `toString` nor
        // `valueOf`, so `ToPrimitive` fails instead of producing the
        // generic reference stub). Record the harness's `TypeError`
        // here, without rewriting the engine's verdict: the differential
        // harness folds it into an abort through `RunOutcome::host_coerced`
        // and an embedder keeps the completion. The throw is post-run in
        // the shim, so it adds no run computrons (the meter already
        // matches the oracle's run-only count).
        let coercion_error = if !completed {
            None
        } else if completion.kind == Kind::Symbol {
            Some("TypeError: cannot coerce symbol to string".to_string())
        } else if let Payload::Reference(object) = completion.value {
            (completion.kind == Kind::Reference
                && self.instance_prototype(object).is_null()
                && !self.arrays.contains_key(&object)
                && self.native_of(object).is_none())
            .then(|| "TypeError: cannot coerce object to string".to_string())
        } else {
            None
        };
        let mut host_render_halt = None;
        let result = if !completed {
            String::new()
        } else if completion.kind == Kind::Symbol {
            // `String(sym)` throws, so the `render` boundary has no
            // `ToString` to mirror; the engine's own display rendering is
            // the descriptive string `Symbol.prototype.toString` gives.
            String::from_utf8_lossy(&self.symbol_descriptive_bytes(completion)).into_owned()
        } else {
            // Host rendering has its own bounded failure channel. The
            // guest already completed; the harness can fold this afterward.
            match self.render(&completion) {
                Ok(text) => text,
                Err(render_halt) => {
                    host_render_halt = Some(self.finish_step(code, render_halt));
                    String::new()
                }
            }
        };
        self.last_crank_completed = completed;
        // `active_segment` identifies only the buffer of the dispatch in
        // progress. Every surviving function has its own `func_segments`
        // entry, so no segment cursor crosses a crank boundary.
        self.active_segment = None;
        RunOutcome {
            completed,
            result,
            coercion_error,
            host_render_halt,
            // The meter now accrues everything XS's `meterIndex` does:
            // the per-opcode dispatch metering, the program-frame +
            // eval-environment setup overhead (at `BEGIN_*`, folding in
            // the invocation baseline), and the run-time allocation
            // metering (§ Allocation-faithful metering). Computrons are
            // `meterIndex >> 16`, directly comparable with the oracle.
            computrons: self.meter.computrons(),
            dispatched: self.n_dispatched,
            meter_raw: self.meter.raw(),
            halt,
        }
    }

    /// Translate an activation result at the host boundary. Suspension and
    /// catch transfers must have been consumed by their owning activation.
    fn finish_step(&mut self, code: &[u8], step: Step) -> Halt {
        match step {
            Step::Returned => Halt::Return,
            Step::Threw { value, .. } => Halt::Throw {
                value,
                rendered: self.render_uncaught(code, value),
            },
            Step::Host(halt) => halt,
            Step::Yielded(_) | Step::Awaited(_) | Step::AsyncYielded(_) | Step::Unwound(_) => {
                Halt::EngineInvariant("dispatch:control-transfer-escaped")
            }
        }
    }

    /// Charge `cost` budget units for a native activation about to be entered,
    /// or refuse with [`Halt::StackOverflow`] when the charge would exceed
    /// [`NATIVE_DEPTH_LIMIT`]. Pair with [`Self::leave_native_frame`] around the
    /// activation (or use [`Self::with_native_frame`], which cannot forget to).
    #[inline]
    fn enter_native_frame(&mut self, cost: usize) -> Result<(), Step> {
        if self.native_depth + cost > NATIVE_DEPTH_LIMIT {
            return Err(Step::Host(Halt::StackOverflow(self.stack_slots_in_use())));
        }
        self.native_depth += cost;
        Ok(())
    }

    /// Release the budget [`Self::enter_native_frame`] charged.
    #[inline]
    fn leave_native_frame(&mut self, cost: usize) {
        debug_assert!(self.native_depth >= cost, "native-frame budget underflow");
        self.native_depth -= cost;
    }

    /// Run `f` as one guarded native activation of `cost` units: the
    /// budget is charged before `f` runs and released on every return path,
    /// including a `?` propagation inside `f`.
    #[inline]
    fn with_native_frame<T>(
        &mut self,
        cost: usize,
        f: impl FnOnce(&mut Self) -> Result<T, Step>,
    ) -> Result<T, Step> {
        self.enter_native_frame(cost)?;
        let result = f(self);
        self.leave_native_frame(cost);
        result
    }

    /// One step of an iterative prototype-chain walk that may pass through a
    /// Proxy (`OrdinaryHasInstance`, `Object.prototype.isPrototypeOf`). A
    /// Proxy forwards `[[GetPrototypeOf]]` to its target, and a spec-legal
    /// cycle through one (`OrdinarySetPrototypeOf`'s cycle check stops at a
    /// Proxy) makes such a walk infinite — a stuck worker rather than a
    /// crashed one. Count the walk's Proxy steps in `proxy_steps` against the
    /// native-recursion budget, exactly what the recursive shape of the same
    /// walk would have consumed, so the cycle halts with
    /// [`Halt::StackOverflow`] after at most the budget's worth of forwarding.
    /// Ordinary steps are free: an ordinary chain is acyclic by construction.
    fn charge_proxy_chain_step(
        &self,
        object: crate::value::SlotIndex,
        proxy_steps: &mut usize,
    ) -> Result<(), Step> {
        if self.proxies.contains_key(&object) {
            *proxy_steps += LIGHT_FRAME_COST;
            if self.native_depth + *proxy_steps > NATIVE_DEPTH_LIMIT {
                return Err(Step::Host(Halt::StackOverflow(self.stack_slots_in_use())));
            }
        }
        Ok(())
    }

    /// Allocate a fresh user-function instance (`fxNewFunctionInstance` +
    /// `fxDefaultFunctionPrototype`, driven by `constructor_function`).
    /// The instance is a real arena object; its body range and closures are
    /// recorded in [`Self::functions`] by the following `code` /
    /// `function_environment` opcodes. Meters the measured allocation
    /// cluster [`FUNCTION_DEFINE_METERING`].
    fn new_function(&mut self, name: u16) -> crate::value::SlotIndex {
        self.meter.tick_raw(FUNCTION_DEFINE_METERING);
        // `fxNewFunctionInstance` runs `fxRenameFunction`; naming the
        // instance with a real id (an inferred `var f = function(){}` or a
        // `function g(){}` declaration — anything but `XS_NO_ID` = 0)
        // costs two additional built-in steps (`mxMeterOne`) over the
        // anonymous case folded into [`FUNCTION_DEFINE_METERING`]. Measured
        // against the pin as exactly `2 * XS_BUILTIN_METERING` = 32768 raw,
        // independent of the name's length (the name symbol's string chunk
        // is interned at parse time, outside the run-only meter).
        if name != crate::value::XS_NO_ID {
            self.meter.tick_builtin_some(2);
        }
        let f = self.slots.alloc(Slot::instance(self.function_proto));
        // Recover the function's own name (for `Function.prototype.toString`):
        // a real name id indexes the program's symbol names; `XS_NO_ID` is
        // anonymous.
        let fname = if name != crate::value::XS_NO_ID {
            self.symbol_names
                .get(name as usize - 1)
                .cloned()
                .unwrap_or_default()
        } else {
            SymbolName::default()
        };
        // Intern the `.name` chunk once, unmetered: XS builds the function's
        // `name` string chunk at `fxNewFunctionName` (folded into the measured
        // [`FUNCTION_DEFINE_METERING`] cluster), so a later `f.name` read is a
        // free own-property read — ironhorse mirrors that by pre-interning here.
        let name_chunk = self.chunks.alloc(&units_to_be16(&fname.to_units()));
        self.functions.insert(
            f,
            FuncInfo {
                name: fname.to_string(),
                name_chunk,
                ..FuncInfo::default()
            },
        );
        // `fxDefaultFunctionPrototype`: a `constructor_function` gets a default
        // `.prototype` object (chaining to %Object.prototype%) that a later
        // `new f()` uses as the instance prototype and `instanceof` tests
        // against. Its allocation is already folded into the measured
        // [`FUNCTION_DEFINE_METERING`] cluster, so it is created unmetered here.
        let proto = self.slots.alloc(Slot::instance(self.object_proto));
        // `fxDefaultFunctionPrototype` also installs `prototype.constructor`
        // (the spec back-reference, `{writable, enumerable:false,
        // configurable}`). Its slot is folded into the measured
        // [`FUNCTION_DEFINE_METERING`] cluster, so it is written unmetered —
        // and only when the program names `constructor` (otherwise the property
        // is unobservable and non-`constructor` programs stay byte-identical).
        if let Some(cid) = self.constructor_id {
            self.set_own_unmetered_with_flag(
                proto,
                cid,
                Slot::of(Kind::Reference, Payload::Reference(f)),
                XS_DONT_ENUM_FLAG,
            );
        }
        self.ctor_prototype.insert(f, proto);
        f
    }

    /// Install a constructor function's own `prototype` data property
    /// (`fxDefaultFunctionPrototype`'s `{writable, enumerable: false,
    /// configurable: false}` slot) pointing at its [`Self::ctor_prototype`]
    /// object, so `T.prototype` reads, `T.prototype.m = …` augmentation, and
    /// `T.prototype = …` reassignment all resolve the SAME object `new T()`
    /// chains instances to. Gated on the program naming `prototype` (like the
    /// `prototype.constructor` back-reference), unmetered on both sides.
    fn install_own_function_prototype(&mut self, f: crate::value::SlotIndex) {
        if let (Some(pid), Some(&proto)) = (self.prototype_key_id, self.ctor_prototype.get(&f)) {
            self.set_own_unmetered_with_flag(
                f,
                pid,
                Slot::of(Kind::Reference, Payload::Reference(proto)),
                XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG,
            );
        }
    }

    /// Define a generator function (`XS_CODE_GENERATOR_FUNCTION` →
    /// `fxNewGeneratorFunctionInstance`). Like [`Self::new_function`] but the
    /// function's `.prototype` object chains to `%GeneratorPrototype%` (so a
    /// generator instance resolves `next`/`return`/`throw`) rather than to
    /// `%Object.prototype%`. XS builds this prototype as an explicit
    /// `fxNewObjectInstance` + a `_prototype` property slot on top of the base
    /// function instance; that extra allocation cluster over the plain
    /// `function` define is the calibrated [`GENERATOR_FUNCTION_EXTRA_METERING`].
    fn new_generator_function(&mut self, name: u16) -> crate::value::SlotIndex {
        let f = self.new_function(name);
        // Re-chain the function instance's own `[[Prototype]]` to
        // `%GeneratorFunction.prototype%` (XS's `mxGeneratorFunctionPrototype`)
        // rather than `%Function.prototype%`, so `(function*(){}).constructor`
        // resolves `%GeneratorFunction%` (and its `.name` is
        // `"GeneratorFunction"`), matching XS. The intermediate prototype is a
        // single boot object, so this is a slot re-point, not a per-instance
        // allocation — no metering delta.
        self.slots.get_mut(f).value = Payload::Reference(self.generator_function_proto);
        // Re-chain the default `.prototype` object to `%GeneratorPrototype%`
        // and account XS's extra generator-prototype allocation.
        self.meter.tick_raw(GENERATOR_FUNCTION_EXTRA_METERING);
        if let Some(&proto) = self.ctor_prototype.get(&f) {
            if let Payload::Reference(_) | Payload::None = self.slots.get(proto).value {
                let s = self.slots.get_mut(proto);
                s.value = Payload::Reference(self.generator_proto);
            }
        }
        // Mark the function as a generator so a bare call is understood (the
        // body's `START_GENERATOR` is what actually produces the instance).
        self.functions.update(&f, |info| {
            info.is_generator = true;
        });
        f
    }

    /// Allocate a generator instance (`fxNewGeneratorInstance`) chained to
    /// `proto` (the generator function's `.prototype`) and record its
    /// suspended-start activation snapshot in the `generators` side table.
    /// XS allocates the instance slot plus two internal property slots (the
    /// `XS_STACK_KIND` saved-stack holder and the resume-state integer); that
    /// three-`fxNewSlot` cluster is the calibrated
    /// [`GENERATOR_START_METERING`].
    fn new_generator_instance(
        &mut self,
        proto: crate::value::SlotIndex,
        resume_pc: usize,
    ) -> crate::value::SlotIndex {
        self.meter.tick_raw(GENERATOR_START_METERING);
        let inst = self.slots.alloc(Slot::instance(proto));
        // Snapshot the current (freshly-entered) frame. At `START_GENERATOR`
        // the value stack holds nothing above the frame base (`begin` set up
        // `locals`, not temporaries), so `stack_slice` is empty; on the first
        // `.next` the body runs from `resume_pc`.
        let frame = self.fresh_activation(resume_pc);
        self.generators.insert(
            inst,
            GeneratorData {
                state: GeneratorState::SuspendedStart,
                frame: Some(frame),
            },
        );
        inst
    }

    fn new_async_generator_instance(
        &mut self,
        proto: crate::value::SlotIndex,
        resume_pc: usize,
    ) -> crate::value::SlotIndex {
        self.meter.tick_raw(GENERATOR_START_METERING);
        let inst = self.slots.alloc(Slot::instance(proto));
        let frame = self.fresh_activation(resume_pc);
        self.async_generators.insert(
            inst,
            AsyncGeneratorData {
                state: AsyncGeneratorState::SuspendedStart,
                frame: Some(frame),
                requests: std::collections::VecDeque::new(),
                active: None,
            },
        );
        inst
    }

    /// Define an async function (`XS_CODE_ASYNC_FUNCTION` →
    /// `fxNewFunctionInstance`). Like [`Self::new_function`] but the function
    /// instance's own `[[Prototype]]` chains to `%AsyncFunction.prototype%`
    /// (XS's `mxAsyncFunctionPrototype`) rather than `%Function.prototype%`, and
    /// it has **no** own `.prototype`/`constructor` pair (async functions are
    /// not constructors). The body leads with `START_ASYNC`. Metering: XS runs
    /// the *same* `fxNewFunctionInstance` as a plain function and skips
    /// `fxDefaultFunctionPrototype`, so the define cost equals `new_function`'s
    /// (the spurious `ctor_prototype` object ironhorse's `new_function` allocates is
    /// unmetered and dropped here) — the calibrated delta is ~0.
    fn new_async_function(&mut self, name: u16) -> crate::value::SlotIndex {
        let f = self.new_function(name);
        // Re-chain the function instance's `[[Prototype]]` to
        // `%AsyncFunction.prototype%` (XS's `fxNewFunctionInstance` prototype).
        self.slots.get_mut(f).value = Payload::Reference(self.async_function_proto);
        // No own `.prototype`: drop the default-prototype object `new_function`
        // built (unmetered materialization on both sides).
        self.ctor_prototype.remove(&f);
        // An async function is not a constructor, so XS's `XS_CODE_ASYNC_FUNCTION`
        // → `fxNewFunctionInstance` skips the `fxDefaultFunctionPrototype`
        // `.prototype` object `new_function`'s calibrated
        // [`FUNCTION_DEFINE_METERING`] cluster includes. Back that allocation
        // out — the calibrated define delta vs a plain function.
        self.meter.untick_raw(ASYNC_FUNCTION_DEFINE_DELTA);
        f
    }

    fn new_async_generator_function(&mut self, name: u16) -> crate::value::SlotIndex {
        let f = self.new_generator_function(name);
        self.slots.get_mut(f).value = Payload::Reference(self.async_generator_function_proto);
        if let Some(&proto) = self.ctor_prototype.get(&f) {
            self.slots.get_mut(proto).value = Payload::Reference(self.async_generator_proto);
        }
        // Like an async function, an async generator is not constructable.
        self.functions.update(&f, |info| {
            info.is_generator = true;
        });
        f
    }

    /// Allocate an async-function instance (`fxNewAsyncInstance`) for a
    /// `START_ASYNC`: an internal instance holding the suspended activation, the
    /// result promise, and the four resolving/await functions. ironhorse materializes
    /// the result promise + its resolve/reject pair (the sub-clusters this meters
    /// explicitly) and records the `resume_pc`-cursored frame snapshot in the
    /// `async_instances` table, cloning the current (freshly-entered) activation
    /// exactly like [`Self::new_generator_instance`] — a **clone**, not a take,
    /// so the driver frame survives for `START_ASYNC`'s own `leave_call`. The
    /// remaining allocation cluster (instance/stack/state/await-function slots +
    /// frame residual) is the calibrated [`ASYNC_INSTANCE_METERING`].
    fn new_async_instance(&mut self, resume_pc: usize) -> crate::value::SlotIndex {
        self.meter.tick_raw(ASYNC_INSTANCE_METERING);
        // The result promise + its resolve/reject resolving pair (XS's
        // `fxNewPromiseInstance` + `fxPushPromiseFunctions`, metered by the
        // helpers).
        let result_promise = self.new_promise_instance();
        let (resolve_fn, reject_fn) = self.make_resolving_functions(result_promise);
        let inst = self
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));
        // Snapshot the current (freshly-entered) frame. Like `START_GENERATOR`,
        // the value stack holds nothing above the frame base at `START_ASYNC`
        // (`begin` set up `locals`, not temporaries), so `stack_slice` is empty;
        // `step_async` runs the body from `resume_pc`.
        let frame = self.fresh_activation(resume_pc);
        self.async_instances.insert(
            inst,
            AsyncData {
                frame: Some(frame),
                result_promise,
                resolve_fn,
                reject_fn,
                done: false,
            },
        );
        inst
    }

    /// Allocate a closure environment instance (`fxNewEnvironmentInstance`,
    /// driven by `function_environment`). Meters
    /// [`FUNCTION_ENVIRONMENT_METERING`]. The environment is a real arena
    /// instance so its captured cells are GC-traced.
    fn new_environment(&mut self) -> crate::value::SlotIndex {
        self.meter.tick_raw(FUNCTION_ENVIRONMENT_METERING);
        // `fxNewEnvironmentInstance` allocates the instance plus one
        // internal behavior slot (`XS_ENVIRONMENT_BEHAVIOR`); captured
        // closures (`store`) append after it, and `retrieve` reads them at
        // `env.next.next`. The two-slot cost is folded into
        // [`FUNCTION_DEFINE_METERING`] (calibrated on a function whose
        // `function_environment` runs), so it is not metered again here.
        // A function defined while a `with`/eval environment is active
        // captures it (XS's `FUNCTION_ENVIRONMENT` chains the new closure
        // environment's prototype to the current `mxEnvironment`), so the
        // callee's free names resolve through the enclosing `with` when it
        // runs. Outside any `with` the prototype is `NULL`, exactly as before —
        // the closure environment stays a flat declarative frame and this is
        // byte-identical to the pre-`with` engine.
        let proto = if self.env.kind == Kind::Reference {
            match self.env.value {
                Payload::Reference(r) => r,
                _ => crate::value::SlotIndex::NULL,
            }
        } else {
            crate::value::SlotIndex::NULL
        };
        let env = self.slots.alloc(Slot::instance(proto));
        let behavior = self
            .slots
            .alloc(Slot::of(Kind::Uninitialized, Payload::None));
        self.slots.get_mut(env).next = behavior;
        env
    }

    /// `XS_CODE_RUN`'s inline argument count (pushed as an integer just
    /// below the frame). The variadic `run` reads it off the stack.
    fn pop_run_count(&mut self) -> usize {
        match self.pop().value {
            Payload::Integer(i) if i >= 0 => i as usize,
            _ => 0,
        }
    }

    /// Enter a user-function call with `argc` arguments (`XS_CODE_RUN_ALL`).
    /// The value stack below the `argc` args holds the frame geometry
    /// `[THIS, FUNCTION, RESULT, FRAME]`; read the function and `this`,
    /// collect the arguments, unwind those `4 + argc` slots, save the
    /// caller's activation, and install the callee's fresh scope. Returns
    /// the callee body's start pc, or `Halt::Throw` when the callee is not a
    /// known user function (the covered grammar only calls functions it
    /// defined).
    fn enter_call(&mut self, argc: usize, ret_pc: usize, has_target: bool) -> Result<usize, Step> {
        let len = self.stack.len();
        if len < argc + 4 {
            return Err(Step::Host(Halt::EngineInvariant("call:stack-underflow")));
        }
        let base = len - argc - 4; // index of THIS
        let func_slot = self.stack[base + 1];
        // Collect arguments (arg0 is the deepest of the argc; XS's
        // `mxFrameArgv(i) = mxFrame - 1 - i`).
        let args: Vec<Slot> = self.stack[base + 4..base + 4 + argc].to_vec();
        let func = match func_slot.value {
            Payload::Reference(f) if self.functions.contains_key(&f) => f,
            // The callee is not callable (a non-function reference, or a
            // primitive). ECMA-262 `Call` (7.3.14) requires a **catchable**
            // TypeError here, not an uncatchable host abort — a program that
            // wraps the call in `try`/`catch` (or `assert.throws`) must observe
            // a realm-correct `TypeError` object. Raise it through the same
            // jump-buffer chain as the `throw` opcode. A handler in the current
            // frame is a *resume*, not a callee body address: preserve that
            // distinction with `Step::Unwound` so `RUN` does not enter the catch
            // target as though it were a function.
            _ => {
                let message = if has_target {
                    "new: not a constructor"
                } else {
                    "call: not a function"
                };
                return Err(self.catchable_type_error_msg(message.into()));
            }
        };
        // The single choke point every user-function dispatch funnels through.
        // A `None` body means the callee has no runnable bytecode — a bound
        // function (or any bodyless instance) that reached here past a missed
        // gate. Fail loud and self-named rather than dispatch at pc 0 (the
        // whole-program re-execution that aborts / silently diverges); the
        // in-range gates trampoline bound callees before they get here.
        let body_start = match self.functions[&func].body_start {
            Some(bs) => bs,
            None => return Err(Step::Host(Halt::EngineInvariant("bind:bound-callback"))),
        };
        let this_val = self.stack[base];
        // Stack-overflow guard (XS's `fxOverflow` on the callee's frame
        // allocation): entering this call suspends the caller (its frame
        // quartet, args, and scope stay live) and opens a fresh callee
        // frame. If the resulting concurrent slot count would cross the
        // fixed budget, abort to the host exactly as XS does — this is
        // what makes unbounded recursion overflow on ironhorse too, rather than
        // completing where XS aborts.
        let caller_footprint = FRAME_OVERHEAD_SLOTS + self.args.len() + self.locals.len();
        // Opening the callee frame allocates its quartet and argument slots
        // on top of everything currently live (the caller's frame stays
        // suspended on the stack). If that crosses the fixed budget, abort
        // to the host exactly as XS's `fxOverflow`.
        if self.would_overflow(FRAME_OVERHEAD_SLOTS + argc) {
            return Err(Step::Host(Halt::StackOverflow(self.stack_slots_in_use())));
        }
        // Unwind the frame region (THIS..last arg).
        self.stack.truncate(base);
        // The caller's frame is now suspended: account its live slots.
        self.frame_slots += caller_footprint;
        // Save the caller's activation and install the callee's.
        self.call_stack.push(CallerState {
            locals: std::mem::take(&mut self.locals),
            id_map: std::mem::take(&mut self.id_map),
            result: self.result,
            strict: self.strict,
            args: std::mem::take(&mut self.args),
            this_val: self.this_val,
            this_captures: std::mem::take(&mut self.this_captures),
            env: self.env,
            cur_func: self.cur_func,
            cur_target: self.cur_target,
            target_func: self.target_func,
            ret_pc,
        });
        self.result = Slot::undefined();
        self.strict = false;
        self.args = args;
        self.this_val = this_val;
        self.this_captures.clear();
        // Install the callee's captured `with`/eval environment (XS resets
        // `mxEnvironment` at frame setup to the function instance's closure
        // environment). A function defined inside a `with` has a closure
        // environment that chains (non-null prototype) to that `with`, so its
        // free names resolve through it; an ordinary function's closure
        // environment has a null prototype (or none), so the callee begins with
        // an empty environment — byte-identical to the pre-`with` engine. The
        // caller's head is saved above and restored by `leave_call`.
        let closures = self.functions.get(&func).map(|fi| fi.closures);
        self.env = match closures {
            Some(c) if !c.is_null() && !self.instance_prototype(c).is_null() => {
                Slot::of(Kind::Reference, Payload::Reference(c))
            }
            _ => Slot::undefined(),
        };
        self.cur_func = func;
        self.cur_target = has_target;
        self.target_func = if has_target {
            self.pending_new_target.take().unwrap_or(func)
        } else {
            crate::value::SlotIndex::NULL
        };
        Ok(body_start)
    }

    /// Invoke a callback through the shared, complete ECMAScript `Call`
    /// dispatcher. Native algorithms use this name at callback-taking sites;
    /// keeping it as a thin wrapper prevents those sites from growing their
    /// own incompatible callable-shape subsets.
    fn run_callback(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        self.invoke_value(code, func, this, args)
    }

    /// Synchronously invoke a user-function callback `func` with receiver
    /// `this` and `args`, running its body to `END` and returning its
    /// completion value — the re-entrant substrate the callback-taking
    /// `Array.prototype` methods use (XS's `fxRunCount` per element). It sets
    /// up the callee frame on the shared value stack, enters it, and runs a
    /// nested [`Self::dispatch_at`] that stops when the callback's frame
    /// returns to the current call depth; the caller's activation is restored
    /// exactly as an ordinary return does. A non-user-function callback (a
    /// native, or a non-callable) self-names an honest skip. Propagates a
    /// callback throw / meter abort to the caller.
    fn run_user_callback(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        // Resolve the callee. Only a user (bytecode) function is driven here;
        // a native callback or a non-callable is out of the modeled subset.
        let f = match func.value {
            Payload::Reference(f) if self.functions.contains_key(&f) => f,
            _ => {
                return Err(Step::Host(Halt::NotImplemented(
                    "callback:non-user-function",
                )))
            }
        };
        // A bound wrapper has no bytecode body of its own. Route it back
        // through the shared abstract Call operation, which recursively
        // composes all bound argument lists and supports user, native, method,
        // and proxy targets without ever entering that bodyless wrapper.
        if self.bound_functions.contains_key(&f) {
            return self.invoke_value(code, func, this, args);
        }
        let (this_eff, func_eff, args_eff): (Slot, Slot, Vec<Slot>) =
            if let Some(m) = self.method_of(f) {
                // A **native-method** callback (`a.map(nf.format)` — the
                // NumberFormat bound-format function; or any prototype method
                // passed by reference). `run_callback` drives only bytecode
                // bodies, so dispatch the native method through the same seam
                // `invoke_getter` uses: build the [THIS, FUNCTION, RESULT, FRAME]
                // frame + args and call `call_native_method`. A bound native
                // (`nf.format`) recovers its owning instance from its side table,
                // not from `this`, so the callback's `this` is irrelevant. On a
                // throw `call_native_method` returns WITHOUT truncating, so the
                // stack is restored to `base` before propagating.
                let base = self.stack.len();
                self.push(this);
                self.push(func);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                for a in args {
                    self.push(*a);
                }
                return match self.call_native_method(m, base, args.len(), code) {
                    Ok(()) => Ok(self.pop()),
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            } else if let Some(native) = self.functions[&f].native {
                // A native *callable* callback (`[..].map(parseInt)`,
                // `[..].forEach(print)`, `arr.filter(Boolean)`, …). It reaches
                // the `call_native` seam rather than `call_native_method`; drive
                // it through the same in-place frame the native-method branch
                // uses. A native *constructor* invoked as a callback (no `new`,
                // so `has_target = false`) either produces its call-completion
                // or throws a catchable TypeError inside `call_native`, matching
                // the oracle. On a throw `call_native` may return WITHOUT
                // truncating, so restore the stack to `base` before propagating.
                let base = self.stack.len();
                self.push(this);
                self.push(func);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                for a in args {
                    self.push(*a);
                }
                return match self.call_native(native, base, args.len(), false, code) {
                    Ok(()) => Ok(self.pop()),
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            } else {
                (this, func, args.to_vec())
            };
        let argc = args_eff.len();
        // Push the callee frame geometry [THIS, FUNCTION, RESULT, FRAME] + args.
        self.push(this_eff);
        self.push(func_eff);
        self.push(Slot::undefined());
        self.push(Slot::of(Kind::Uninitialized, Payload::None));
        for a in &args_eff {
            self.push(*a);
        }
        let body_start = self.enter_call(argc, 0, false)?;
        // After `enter_call` the callee frame's `CallerState` is on the call
        // stack; run until its `END` pops the stack back to this depth.
        let return_depth = self.call_stack.len();
        // Dispatch over the callee's own buffer when it lives in a different
        // segment than the caller's `code` (an eval-defined function handed to
        // a native driver such as `Array.prototype.map`, or the `Function`
        // result invoked as a callback). Same-segment callbacks keep using the
        // passed `code` with no allocation.
        let callee_seg = match func_eff.value {
            Payload::Reference(f) => self.callee_segment(f),
            _ => None,
        };
        let seg_buf = if callee_seg == self.active_segment {
            None
        } else {
            self.segment_buffer(callee_seg)
        };
        let saved_segment = self.active_segment;
        if seg_buf.is_some() {
            self.active_segment = callee_seg;
        }
        let body_code: &[u8] = match &seg_buf {
            Some(buf) => &buf[..],
            None => code,
        };
        let outcome = self.dispatch_at(body_code, body_start, return_depth);
        self.active_segment = saved_segment;
        match outcome {
            // Only this activation's normal return supplies a callback result.
            // A caller's handler travels outward as Step::Unwound instead.
            Step::Returned => Ok(self.pop()),
            other => Err(other),
        }
    }

    /// The persisted bytecode buffer for `segment` (`None` ⇒ the top-level
    /// program). Returns an owned [`std::rc::Rc`] handle so the caller can
    /// dispatch over it without holding a borrow of `&mut self`.
    fn segment_buffer(&self, segment: Option<usize>) -> Option<std::rc::Rc<[u8]>> {
        match segment {
            Some(seg) => self.code_segments.get(seg).cloned(),
            None => self.top_level_code.clone(),
        }
    }

    /// Ensure the currently executing buffer has an owned segment.
    ///
    /// Eval/dynamic-Function dispatch installs its segment before entering.
    /// A top-level crank stays segment-free until its first function body is
    /// defined, then promotes the `top_level_code` buffer already shared with the
    /// machine. This is the crank-code retention half of cross-crank calls.
    fn ensure_active_code_segment(&mut self, code: &[u8]) -> usize {
        if let Some(segment) = self.active_segment {
            return segment;
        }
        let segment = self.code_segments.len();
        let buffer = self
            .top_level_code
            .clone()
            .unwrap_or_else(|| std::rc::Rc::from(code));
        self.code_segments.push(buffer);
        self.active_segment = Some(segment);
        segment
    }

    /// A dispatch may consume a handler only when it borrows that handler's
    /// buffer. The depth guard alone cannot distinguish nested code buffers.
    fn resume_target_belongs_to(&self, target: ResumeTarget, code: &[u8]) -> bool {
        let buffer = match target.segment {
            Some(segment) => self.code_segments.get(segment),
            None => self.top_level_code.as_ref(),
        };
        buffer.is_some_and(|buffer| std::ptr::eq(buffer.as_ref(), code))
    }

    /// Check the immutable buffer borrowed by the landing dispatch. Native
    /// wrappers can restore `active_segment`, and top-level promotion can turn
    /// an earlier `None` identity into `Some`, without changing that buffer.
    fn assert_resume_target(&self, target: ResumeTarget, code: &[u8]) {
        debug_assert!(
            self.resume_target_belongs_to(target, code),
            "catch target belongs to another dispatch buffer"
        );
        debug_assert!(target.pc < code.len(), "catch target is outside its buffer");
    }

    /// The code segment a callee function's body lives in, and whether it
    /// differs from the segment the current dispatch loop runs over — i.e.
    /// whether entering it needs a cross-segment nested dispatch rather than
    /// an in-loop `enter_call`. Cheap and allocation-free; the whole check is
    /// gated by the caller on [`Self::func_segments`] being non-empty, so a
    /// program that never evals never reaches it.
    #[inline]
    fn callee_segment(&self, f: crate::value::SlotIndex) -> Option<usize> {
        self.func_segments.get(&f).copied()
    }

    /// For the ordinary user-function call arm (`XS_CODE_RUN`): peek the callee
    /// on the value stack and, if its body lives in a different segment than
    /// this loop's buffer, return `Some(callee_segment)` to route it through a
    /// cross-segment dispatch. Returns `None` (stay in-loop) in the common
    /// same-segment case, and immediately when no retained function exists.
    ///
    /// The fast-path guard is `code_segments` empty (no function has retained
    /// a defining buffer):
    /// only then is every callee guaranteed same-segment. Once an eval has
    /// run, the check is needed both ways — the top-level program calling an
    /// eval-defined function, and (while dispatching an eval segment) that
    /// unit calling back into a top-level function.
    #[inline]
    fn cross_segment_callee(&self, argc: usize) -> Option<Option<usize>> {
        if self.code_segments.is_empty() {
            return None;
        }
        let base = self.stack.len().checked_sub(argc + 4)?;
        let f = match self.stack.get(base + 1).map(|slot| slot.value) {
            Some(Payload::Reference(f)) => f,
            _ => return None,
        };
        // Only a user function has a body segment to dispatch over. A
        // non-callable reference (a plain object, an array) is not a
        // cross-segment callee: it stays in-loop, where `enter_call` raises
        // the catchable `TypeError` `Call` requires.
        if !self.functions.contains_key(&f) {
            return None;
        }
        let seg = self.callee_segment(f);
        (seg != self.active_segment).then_some(seg)
    }

    /// Enter a user function whose body lives in a **different** code segment
    /// than the current dispatch loop (an eval-defined function called from
    /// the top-level program or another unit, or a top-level function called
    /// back from an eval). The call args are already on the value stack in
    /// frame geometry; this enters the callee frame, dispatches over the
    /// callee's own buffer until its `END` returns to this depth, and yields
    /// the completion — the same nested-dispatch shape as [`Self::run_callback`],
    /// keeping each dispatch loop over a single buffer. Restores the active
    /// segment afterward.
    fn call_cross_segment(
        &mut self,
        argc: usize,
        has_target: bool,
        callee_segment: Option<usize>,
    ) -> Result<Slot, Step> {
        let body_start = self.enter_call(argc, 0, has_target)?;
        self.dispatch_entered_cross_segment(body_start, callee_segment)
    }

    /// Dispatch a frame that has already been entered over its retained
    /// segment. Shared by ordinary and bound cross-crank calls.
    fn dispatch_entered_cross_segment(
        &mut self,
        body_start: usize,
        callee_segment: Option<usize>,
    ) -> Result<Slot, Step> {
        let buf = match self.segment_buffer(callee_segment) {
            Some(buf) => buf,
            None => {
                return Err(Step::Host(Halt::EngineInvariant(
                    "function:missing-segment",
                )))
            }
        };
        let return_depth = self.call_stack.len();
        let saved_segment = self.active_segment;
        self.active_segment = callee_segment;
        let outcome = self.dispatch_at(&buf[..], body_start, return_depth);
        self.active_segment = saved_segment;
        match outcome {
            // A caller's handler travels outward as Step::Unwound; only
            // this activation's normal return supplies a call result.
            Step::Returned => Ok(self.pop()),
            other => Err(other),
        }
    }

    /// Run a callback behind a native `mxTry` boundary ([`Self::native_try`]).
    /// Promise executors, thenable jobs and disposers catch a guest throw in
    /// native code: the callback activation is abandoned, the thrown value is
    /// returned as `Ok(Err(thrown))`, and the caller rejects with it instead
    /// of the machine halting or a surrounding guest `try` observing it.
    fn run_callback_catching_throw(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        args: &[Slot],
    ) -> Result<Result<Slot, Slot>, Step> {
        self.native_try(|machine| machine.run_callback(code, func, this, args))
    }

    /// Dispatch a plain (non-`new`) call to an intrinsic native function.
    /// The value stack below the `argc` args holds the frame geometry
    /// `[THIS, FUNCTION, RESULT, FRAME]` beginning at `base`; the handler
    /// reads its arguments, collapses the whole `[THIS..argN-1]` region to a
    /// single result slot (XS's `mxStack = mxFrameEnd; *mxStack =
    /// *mxFrameResult`), and meters exactly what the C built-in meters.
    /// A native whose call behavior ironhorse does not yet model returns
    /// [`Halt::NotImplemented`] naming the built-in — an honest skip, never a
    /// mis-executed result.
    fn call_native(
        &mut self,
        native: Native,
        base: usize,
        argc: usize,
        has_target: bool,
        code: &[u8],
    ) -> Result<(), Step> {
        // The native-constructor/function dispatcher is one of the two
        // monolithic activations of this crate (with `call_native_method`):
        // charge the native-recursion budget's heavy class for it, so a
        // built-in that re-enters another built-in or guest code (through
        // `invoke_value`/`construct_value`; a guest callback's own
        // `dispatch_at` beneath it charges itself) is bounded by
        // [`NATIVE_DEPTH_LIMIT`] rather than by the host stack.
        self.with_native_frame(HEAVY_FRAME_COST, |vm| {
            vm.call_native_inner(native, base, argc, has_target, code)
        })
    }

    /// Preserve the integer fast representation without losing negative zero
    /// or a non-integral/non-finite Number.
    fn slot_from_number(value: f64) -> Slot {
        if value == (value as i32) as f64 && !(value == 0.0 && value.is_sign_negative()) {
            Slot::integer(value as i32)
        } else {
            Slot::number(value)
        }
    }

    /// Insert an own data property onto a freshly-built boot instance (the
    /// exec result array's `index`/`input`/`groups`) as a single linked
    /// `fxNewSlot`, without the property-table-growth cost `instance_put`
    /// charges (the slot alloc is metered by the caller, mirroring XS's
    /// `resultItem = resultItem->next = fxNewSlot`).
    fn instance_put_raw(&mut self, inst: crate::value::SlotIndex, id: u16, value: Slot) {
        let head = self.slots.get(inst).next;
        let mut prop = value;
        prop.id = id;
        prop.flag = 0;
        prop.next = head;
        let idx = self.slots.alloc(prop);
        self.slots.get_mut(inst).next = idx;
    }

    /// Whether a slot is a callable value (a reference to a modeled function —
    /// user, native, bound, or promise resolving function). XS's `fxIsCallable`.
    fn is_callable_value(&self, v: Slot) -> bool {
        matches!(v.value, Payload::Reference(r) if v.kind == Kind::Reference && self.slot_is_callable(r))
    }

    /// `IsConstructor(v)` (ECMA-262 7.2.4). A bound/proxy callable follows its
    /// target. Native prototype methods, `eval`, `Symbol`, and `BigInt` have no
    /// `[[Construct]]`. A user function has it only when its constructor opcode
    /// retained a default-prototype link; generator functions use that link for
    /// their generator instances but are themselves non-constructable.
    fn is_constructor_value(&self, v: Slot) -> bool {
        matches!(v.value, Payload::Reference(r) if v.kind == Kind::Reference && self.slot_is_constructor(r))
    }

    fn slot_is_constructor(&self, r: crate::value::SlotIndex) -> bool {
        // Follow proxy and bound-function targets in a loop: both chains are
        // acyclic (each wrapper's target already exists when the wrapper is
        // minted) but a guest can make them a million links long.
        let mut r = r;
        loop {
            if let Some(data) = self.proxies.get(&r) {
                if data.revoked {
                    return false;
                }
                r = data.target;
                continue;
            }
            if let Some(data) = self.bound_functions.get(&r) {
                r = data.target;
                continue;
            }
            break;
        }
        match self.functions.get(&r) {
            Some(fi) if fi.method.is_some() => false,
            Some(fi) if fi.native.is_some() => !matches!(
                fi.native,
                Some(Native::Eval | Native::Symbol | Native::BigInt)
            ),
            Some(fi) => !fi.is_generator && self.ctor_prototype.contains_key(&r),
            None => false,
        }
    }

    /// Whether a heap instance has `[[Call]]`: a function instance, or a live
    /// proxy whose target is (recursively) callable (ECMA-262 10.5.12 gates
    /// `[[Call]]` on the target being callable).
    fn slot_is_callable(&self, r: crate::value::SlotIndex) -> bool {
        // Follow proxy targets in a loop (see `slot_is_constructor`).
        let mut r = r;
        loop {
            if self.functions.contains_key(&r) {
                return true;
            }
            match self.proxies.get(&r) {
                Some(data) if !data.revoked => r = data.target,
                _ => return false,
            }
        }
    }

    /// Normalize one operation executed behind a native try boundary
    /// (Array.from's steps, the resolving function's `Get(resolution,
    /// "then")`). A JS throw becomes its realm value; an implementation halt
    /// remains a halt. This is [`Self::native_try`]: the fence is taken
    /// BEFORE the operation runs, so a caller's live `try` never sees the
    /// throw — classifying afterwards let `Promise.resolve({ get then() {
    /// throw 5 } })` land in the caller's catch where XS rejects the promise.
    fn array_from_try<T>(
        &mut self,
        operation: impl FnOnce(&mut Self) -> Result<T, Step>,
    ) -> Result<Result<T, Slot>, Step> {
        self.native_try(operation)
    }

    /// Compatibility alias for the shared `Call(F, thisArg, args)` dispatcher.
    /// Kept at the iterator/Promise sites so their abstract-operation naming
    /// remains readable; all callable shapes are dispatched by
    /// [`Self::invoke_value`].
    fn call_any(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        self.invoke_value(code, func, this, args)
    }

    /// [`Self::call_any`] under a native `mxTry` ([`Self::native_try`]): a JS
    /// throw is captured as `Ok(Err(thrown))`, a real host halt propagates.
    fn call_any_catching_throw(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        args: &[Slot],
    ) -> Result<Result<Slot, Slot>, Step> {
        self.native_try(|machine| machine.call_any(code, func, this, args))
    }

    /// `GetV(value, key)` followed by the callable check used by the `Invoke`
    /// abstract operation. Primitive receivers read through their realm
    /// wrapper prototype while retaining the primitive as the call receiver.
    fn invoke_value_method(
        &mut self,
        code: &[u8],
        value: Slot,
        name: &str,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        if matches!(value.kind, Kind::Null | Kind::Undefined) {
            return Err(self.catchable_type_error_msg(
                if value.kind == Kind::Undefined {
                    "cannot coerce undefined to object"
                } else {
                    "cannot coerce null to object"
                }
                .into(),
            ));
        }
        let id = self.intern_key(name);
        let method = match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => {
                self.mop_get(code, inst, id, value)?
            }
            _ => {
                let proto = match value.kind {
                    Kind::String => self.string_proto,
                    Kind::Integer | Kind::Number => self.number_proto,
                    Kind::Symbol => self.symbol_proto,
                    Kind::BigInt => self.bigint_proto,
                    Kind::Boolean => self
                        .intrinsics
                        .get("Boolean")
                        .and_then(|&c| self.ctor_prototype.get(&c).copied())
                        .unwrap_or(crate::value::SlotIndex::NULL),
                    _ => crate::value::SlotIndex::NULL,
                };
                if proto.is_null() {
                    return Err(self.catchable_type_error());
                }
                self.mop_get(code, proto, id, value)?
            }
        };
        if !self.is_callable_value(method) {
            return Err(self.catchable_type_error_msg("call: not a function".into()));
        }
        self.call_any(code, method, value, args)
    }

    /// `ToLength(Get(...))` for the array-like `length`, as a `u64` capped at
    /// 2^53 - 1 (the spec integer-index ceiling).
    fn to_length_value(&mut self, code: &[u8], value: Slot) -> Result<u64, Step> {
        let n = self.to_number_f64(code, value)?;
        if n.is_nan() || n <= 0.0 {
            return Ok(0);
        }
        let capped = n.trunc().min(9_007_199_254_740_991.0);
        Ok(capped as u64)
    }

    /// Build a fresh Error instance of type `name` from a native Error
    /// constructor call/construct (`fx_Error`). Meters the construct cost
    /// (the native `Object` object cost plus [`ERROR_CONSTRUCT_EXTRA`]) and,
    /// when a message argument is present, ToString's it into an own
    /// `message` property ([`ERROR_MESSAGE_METERING`]). Records the
    /// `(name, message)` in [`Self::error_data`] so the value stringifies as
    /// `name` / `name: message`, and sets own `name`/`message` properties
    /// (under the program's relinked ids) so guest reads resolve — both
    /// unmetered, mirroring XS where `name` is the inherited prototype value
    /// and the property slot cost is folded into the measured constants.
    /// The frame-name chain an error captures at construction (XS's
    /// `fxCaptureErrorStack` recording): the current activation's function
    /// name, each suspended caller's, then the empty program frame. A
    /// non-function level (the program scope) contributes nothing beyond
    /// the final empty frame.
    fn capture_error_frames(&self) -> Vec<String> {
        let mut frames = Vec::new();
        if let Some(fi) = self.functions.get(&self.cur_func) {
            frames.push(fi.name.clone());
        }
        for state in self.call_stack.iter().rev() {
            if let Some(fi) = self.functions.get(&state.cur_func) {
                frames.push(fi.name.clone());
            }
        }
        frames.push(String::new());
        frames
    }

    fn build_error(&mut self, name: &'static str, base: usize, argc: usize) -> Slot {
        // Base object cost, exactly as the native `Object` constructor
        // (`tick_builtin` + `fxNewObject`), plus the error-instance extra.
        self.meter.tick_builtin();
        let inst = self.new_object();
        self.meter.tick_raw(ERROR_CONSTRUCT_EXTRA);
        // Chain the error instance to its type's `%<Type>.prototype%` (so
        // `err instanceof TypeError` / `instanceof Error` hold) rather than
        // the plain `%Object.prototype%` `new_object` defaulted it to.
        if let Some(proto) = self
            .intrinsics
            .get(name)
            .and_then(|&c| self.prototype_of(c))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }
        // The message argument: absent or `undefined` ⇒ no own message (XS
        // inherits `Error.prototype.message == ""`).
        let message: Option<String> = if argc >= 1 {
            let a = self
                .stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined);
            if a.kind == Kind::Undefined {
                None
            } else {
                let bytes = self.to_string_bytes_metered(a);
                self.meter.tick_raw(ERROR_MESSAGE_METERING);
                Some(String::from_utf8_lossy(&bytes).into_owned())
            }
        } else {
            None
        };
        let frames = self.capture_error_frames();
        self.error_data.insert(
            inst,
            ErrorInfo {
                name,
                message: message.clone(),
                frames,
            },
        );
        // An own `message` property only when a message argument was given
        // (XS): a no-argument error inherits `message == ""` from the
        // prototype. `name` is always inherited from the prototype, never own
        // — so `err.hasOwnProperty('name')` is `false`, matching XS. Both are
        // set unmetered (the own message slot cost is folded into the
        // measured construct constants). The key is INTERNED, not looked up:
        // XS's key table is machine-global ("message" is a boot key), so the
        // own property exists whether or not the constructing crank ever
        // compiled the name — a later crank's `e.message` must resolve
        // (locked by `error_own_properties.rs`).
        if let Some(text) = message {
            let mid = self.intern_key_unmetered("message");
            let off = self.alloc_str_text(text.as_bytes());
            self.set_own_unmetered_with_flag(
                inst,
                mid,
                Slot::of(Kind::String, Payload::String(off)),
                XS_DONT_ENUM_FLAG,
            );
        }
        // `InstallErrorCause`: when the options object has a `cause`
        // property, copy its value to a writable, non-enumerable,
        // configurable own property on the new realm-local Error instance.
        if argc >= 2 {
            let options = self
                .stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined);
            if let (Payload::Reference(options), Some(&cause_id)) =
                (options.value, self.symbol_ids.get("cause"))
            {
                if self.instance_has(options, cause_id).0 {
                    let cause = self.instance_get(options, cause_id);
                    self.set_own_unmetered_with_flag(inst, cause_id, cause, XS_DONT_ENUM_FLAG);
                }
            }
        }
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// Construct an Error-family value from an observable native call.
    /// Unlike the internal-error path above, the public constructors perform
    /// `ToString(message)`, `HasProperty(options, "cause")`, and
    /// `Get(options, "cause")` through the ordinary call/MOP seams so guest
    /// accessors and proxies run in specification order.
    fn build_native_error(
        &mut self,
        code: &[u8],
        name: &'static str,
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        self.meter.tick_builtin();
        let inst = self.new_object();
        self.meter.tick_raw(ERROR_CONSTRUCT_EXTRA);
        if let Some(proto) = self
            .intrinsics
            .get(name)
            .and_then(|&constructor| self.prototype_of(constructor))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }

        let message_units = if argc >= 1 {
            let argument = self
                .stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined);
            if argument.kind == Kind::Undefined {
                None
            } else {
                let units = self.to_string_units(code, argument)?;
                self.meter.tick_raw(ERROR_MESSAGE_METERING);
                Some(units)
            }
        } else {
            None
        };
        let frames = self.capture_error_frames();
        self.error_data.insert(
            inst,
            ErrorInfo {
                name,
                message: message_units
                    .as_ref()
                    .map(|units| String::from_utf16_lossy(units)),
                frames,
            },
        );
        if let Some(units) = message_units {
            let message_id = self.intern_key_unmetered("message");
            let offset = self.chunks.alloc(&units_to_be16(&units));
            self.set_own_unmetered_with_flag(
                inst,
                message_id,
                Slot::of(Kind::String, Payload::String(offset)),
                XS_DONT_ENUM_FLAG,
            );
        }

        if argc >= 2 {
            let options = self
                .stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined);
            self.install_error_cause(code, inst, options)?;
        }
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// `InstallErrorCause(O, options)` for an already-created Error object.
    /// Primitive options are ignored. Object options use the full MOP so an
    /// inherited cause, accessor, or Proxy trap is observable.
    fn install_error_cause(
        &mut self,
        code: &[u8],
        error: crate::value::SlotIndex,
        options: Slot,
    ) -> Result<(), Step> {
        let options_ref = match options.value {
            Payload::Reference(options_ref) if options.kind == Kind::Reference => options_ref,
            _ => return Ok(()),
        };
        let cause_id = self.intern_key_unmetered("cause");
        if self.mop_has(code, options_ref, cause_id)? {
            let cause = self.mop_get(code, options_ref, cause_id, options)?;
            self.set_own_unmetered_with_flag(error, cause_id, cause, XS_DONT_ENUM_FLAG);
        }
        Ok(())
    }

    /// An **engine-internal** error carrying XS's descriptive message text
    /// (the `mxRunDebug`/`mxRunDebugID` diagnostics the pinned oracle emits,
    /// e.g. `"get f: undefined variable"`). Built exactly like
    /// `build_error(name, 0, 0)` — same object geometry, prototype chain, and
    /// meter charge — then augmented with the message on both the render side
    /// (`error_data`, so `String(err)` matches the oracle's `String(exception)`)
    /// and as a real own non-enumerable `message` property (so `err.message`
    /// is observable exactly as XS's thrown error's is). The message is set
    /// **unmetered** — no `ERROR_MESSAGE_METERING` charge — so a program that
    /// throws-and-catches an internal error meters identically to before this
    /// text existed (the oracle's own message construction is likewise off the
    /// metered opcode path, `fxThrowMessage` after `mxSaveState`).
    fn internal_error(&mut self, name: &'static str, message: String) -> Slot {
        let err = self.build_error(name, 0, 0);
        if let Payload::Reference(inst) = err.value {
            if let Some(info) = self.error_data.get_mut(&inst) {
                info.message = Some(message.clone());
            }
            let mid = self.intern_key_unmetered("message");
            let off = self.alloc_str_text(message.as_bytes());
            self.set_own_unmetered_with_flag(
                inst,
                mid,
                Slot::of(Kind::String, Payload::String(off)),
                XS_DONT_ENUM_FLAG,
            );
        }
        err
    }

    /// The source name of a program symbol `id` (XS's `fxIDToString` for the
    /// variable/property diagnostics), `symbol_names[id - 1]`. An id past the
    /// table (never expected for a resolved variable operand) renders empty.
    fn id_name(&self, id: u16) -> String {
        self.symbol_names
            .get((id as usize).saturating_sub(1))
            .map(ToString::to_string)
            .unwrap_or_default()
    }

    /// Construct `SuppressedError(error, suppressed, message)`. Disposal
    /// chaining uses the first two fields directly (and passes no
    /// message); ordinary constructor calls share the same realm
    /// prototype and non-enumerable own fields, and ToString a present,
    /// non-undefined message argument exactly as `build_error` does
    /// (metered — XS's `fx_Error_aux` message path). The field keys are
    /// INTERNED, not looked up: XS's key table is machine-global, so
    /// the own properties exist whether or not the constructing crank
    /// compiled the names (locked by `error_own_properties.rs`).
    fn build_suppressed_error(
        &mut self,
        error: Slot,
        suppressed: Slot,
        message_arg: Option<Slot>,
    ) -> Slot {
        let inst = self.new_object();
        if let Some(proto) = self
            .intrinsics
            .get("SuppressedError")
            .and_then(|&c| self.prototype_of(c))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }
        let message: Option<String> = match message_arg {
            Some(a) if a.kind != Kind::Undefined => {
                let bytes = self.to_string_bytes_metered(a);
                self.meter.tick_raw(ERROR_MESSAGE_METERING);
                Some(String::from_utf8_lossy(&bytes).into_owned())
            }
            _ => None,
        };
        let frames = self.capture_error_frames();
        self.error_data.insert(
            inst,
            ErrorInfo {
                name: "SuppressedError",
                // This branch's fix (the SuppressedError message was
                // dropped) composes with the base's new stack frames:
                // both fields are wanted.
                message: message.clone(),
                frames,
            },
        );
        if let Some(text) = message {
            let mid = self.intern_key_unmetered("message");
            let off = self.alloc_str_text(text.as_bytes());
            self.set_own_unmetered_with_flag(
                inst,
                mid,
                Slot::of(Kind::String, Payload::String(off)),
                XS_DONT_ENUM_FLAG,
            );
        }
        for (name, value) in [("error", error), ("suppressed", suppressed)] {
            let id = self.intern_key_unmetered(name);
            self.set_own_unmetered_with_flag(inst, id, value, XS_DONT_ENUM_FLAG);
        }
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// `new AggregateError(errors, message)` (`fx_AggregateError`): the base
    /// error (name "AggregateError", message from arg **1**), plus an own
    /// `errors` Array built by iterating arg 0. XS builds the base with
    /// `fx_Error_aux(..., 1)`, then a fresh Array instance whose elements are
    /// copied from the `fxGetIterator`/`fxIteratorNext` walk of arg 0. Message
    /// conversion and cause installation precede iterator acquisition.
    fn build_aggregate_error(
        &mut self,
        code: &[u8],
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        let errors_slot = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // The base error (identical to `build_error` but the message is arg 1,
        // XS's `fx_Error_aux(..., 1)`).
        self.meter.tick_builtin();
        let inst = self.new_object();
        self.meter.tick_raw(ERROR_CONSTRUCT_EXTRA);
        if let Some(proto) = self
            .intrinsics
            .get("AggregateError")
            .and_then(|&c| self.prototype_of(c))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }
        let message_units: Option<Vec<u16>> = if argc >= 2 {
            let a = self
                .stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined);
            if a.kind == Kind::Undefined {
                None
            } else {
                let units = self.to_string_units(code, a)?;
                self.meter.tick_raw(ERROR_MESSAGE_METERING);
                Some(units)
            }
        } else {
            None
        };
        let frames = self.capture_error_frames();
        self.error_data.insert(
            inst,
            ErrorInfo {
                name: "AggregateError",
                message: message_units
                    .as_ref()
                    .map(|units| String::from_utf16_lossy(units)),
                frames,
            },
        );
        if let Some(units) = message_units {
            // Interned, not looked up — the machine-global key rule
            // `build_error` documents.
            let mid = self.intern_key_unmetered("message");
            let off = self.chunks.alloc(&units_to_be16(&units));
            self.set_own_unmetered_with_flag(
                inst,
                mid,
                Slot::of(Kind::String, Payload::String(off)),
                XS_DONT_ENUM_FLAG,
            );
        }
        if argc >= 3 {
            let options = self
                .stack
                .get(base + 6)
                .copied()
                .unwrap_or_else(Slot::undefined);
            self.install_error_cause(code, inst, options)?;
        }
        let err_elems = self.aggregate_error_elements(code, errors_slot)?;
        // The `errors` Array (`fxNewArrayInstance` + the copied elements +
        // `fxCacheArray`) plus the `fxGetIterator`/`fxIteratorNext` walk cost.
        let n = err_elems.len() as u64;
        self.charge_and_check(AGGREGATE_ERROR_EXTRA + n * AGGREGATE_ERROR_PER_ELEMENT)?;
        let arr_inst = self.slots.alloc(Slot::instance(self.array_proto));
        let mut arr_data = ArrayData::default();
        for (i, mut v) in err_elems.into_iter().enumerate() {
            v.id = 0;
            v.next = crate::value::SlotIndex::NULL;
            arr_data.insert_item(i as u32, v, &mut self.side_refs);
        }
        arr_data.length = n as u32;
        self.arrays.insert(arr_inst, arr_data);
        let eid = self.intern_key_unmetered("errors");
        self.set_own_unmetered_with_flag(
            inst,
            eid,
            Slot::of(Kind::Reference, Payload::Reference(arr_inst)),
            XS_DONT_ENUM_FLAG,
        );
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// `IterableToList(errors)` for `AggregateError`. Preserve the calibrated
    /// dense-Array path only when the observable iterator operations still
    /// resolve to the intrinsic Array iterator; sparse/custom inputs take the
    /// full protocol path.
    fn aggregate_error_elements(&mut self, code: &[u8], errors: Slot) -> Result<Vec<Slot>, Step> {
        if let Payload::Reference(array) = errors.value {
            if errors.kind == Kind::Reference
                && self.arrays.contains_key(&array)
                && !self.arguments_objects.contains(&array)
            {
                let iterator_id = self
                    .well_known_symbol_property_id("iterator")
                    .expect("well-known iterator symbol");
                let next_id = self.intern_key("next");
                let return_id = self.intern_key("return");
                let intrinsic_protocol = self.chain_resolves_native_data_method(
                    array,
                    iterator_id,
                    NativeMethod::ArrayValues,
                ) && self.chain_resolves_native_data_method(
                    self.array_iterator_proto,
                    next_id,
                    NativeMethod::ArrayIteratorNext,
                ) && !self
                    .chain_has_descriptor(self.array_iterator_proto, return_id);
                let dense = {
                    let data = &self.arrays[&array];
                    data.items().len() == data.length as usize
                };
                if intrinsic_protocol && dense {
                    let length = self.arrays[&array].length;
                    let buffer = self.reserve_work_scratch(length as usize)?;
                    let data = &self.arrays[&array];
                    return Ok(Self::fill_scratch(
                        buffer,
                        (0..length).map(|index| self.array_item_value(array, data.items()[&index])),
                    ));
                }
            }
        }
        self.iterable_to_list(code, errors)
    }

    /// `Function.prototype.bind(thisArg, ...boundArgs)`
    /// (`fx_Function_prototype_bind`): create a bound function. The receiver
    /// (`this`, at `base`) must be a modeled function; `thisArg` is arg 0 and the
    /// bound arguments are args `1..argc`. The bound function's `.length` is
    /// the target's own `.length` minus the bound-arg count (floored at 0),
    /// its `.name` is `"bound "` + the target's name; calling it invokes the
    /// target with the bound `this` + bound args prepended through
    /// [`Self::invoke_value`].
    fn make_bound_function(&mut self, base: usize, argc: usize) -> Result<Slot, Step> {
        let this = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // Any callable may be bound. User functions use the ordinary bound
        // trampoline; the canonical bound `Function.prototype.call` native
        // shape is handled directly by the call opcode. A **native** receiver
        // (native constructor/method) is equally in `functions`, so it binds
        // through the same record — its bound call re-dispatches the native.
        // `Function.prototype.bind` step 2 (ECMA-262 20.2.3.2): if the target
        // is **not callable**, throw a TypeError (catchable). A callable proxy
        // is bindable per spec, but a bound-of-proxy call is not yet modeled,
        // so keep the honest skip rather than throw wrongly.
        let target = match this.value {
            Payload::Reference(r) if self.functions.contains_key(&r) => r,
            Payload::Reference(r) if self.slot_is_callable(r) => {
                return Err(Step::Host(Halt::NotImplemented(
                    "bind:non-user-function-receiver",
                )));
            }
            _ => return Err(self.catchable_type_error_msg("this: not a Function instance".into())),
        };
        let this_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let nbound = argc.saturating_sub(1) as u32;
        // The bound-function creation cluster (instance + CODE/HOME + the three
        // internal property slots + the length/name properties). When there
        // are bound arguments, XS additionally builds an Array for them
        // (`fxNewArrayInstance` + a `fxNewSlot` per arg + `fxCacheArray`);
        // with none, `_boundArguments` is a null property (no array).
        let args_meter = if nbound >= 1 {
            BIND_CREATE_ARGS_ARRAY + nbound as u64 * BIND_CREATE_PER_ARG
        } else {
            0
        };
        self.charge_and_check(BIND_CREATE_METERING + args_meter)?;
        // Bound leading arguments: args 1..argc (arg 0 is `thisArg`).
        let bound_args: Vec<Slot> = if argc >= 2 {
            Self::fill_scratch(
                self.reserve_scratch(argc - 1)?,
                (1..argc).map(|i| {
                    self.stack
                        .get(base + 4 + i)
                        .copied()
                        .unwrap_or_else(Slot::undefined)
                }),
            )
        } else {
            Vec::new()
        };
        // Bound `.length` = max(0, target.length - boundArgs) and bound `.name`
        // = "bound " + target.name (XS reads the target's own `length`/`name`).
        let target_arity = self.functions.get(&target).map(|fi| fi.arity).unwrap_or(0);
        let bound_len = target_arity.saturating_sub(nbound);
        let name_length = self
            .functions
            .get(&target)
            .map(|info| self.str_content(info.name_chunk).len() / 2)
            .unwrap_or(0);
        let mut bound_units = self.reserve_work_scratch(name_length + 6)?;
        bound_units.extend("bound ".encode_utf16());
        if let Some(info) = self.functions.get(&target) {
            bound_units.extend(self.str_units(info.name_chunk));
        }
        let bound_name = SymbolName::from_units(&bound_units).to_string();
        let inst = self.slots.alloc(Slot::instance(self.function_proto));
        let name_chunk = self.chunks.alloc(&units_to_be16(&bound_units));
        // Register in `functions` (native/method None) so `.length`/`.name`
        // read back the bound values through the ordinary GET_PROPERTY arm.
        self.functions.insert(
            inst,
            FuncInfo {
                name: bound_name,
                name_chunk,
                arity: bound_len,
                ..FuncInfo::default()
            },
        );
        self.bound_functions.insert(
            inst,
            BoundData {
                target,
                this_arg,
                args: bound_args,
            },
        );
        Ok(Slot::of(Kind::Reference, Payload::Reference(inst)))
    }

    /// Build a primitive-wrapper object (`new Boolean`/`Number`/`String`)
    /// around the already-computed primitive `prim`. Meters the native
    /// `Object` empty-object cost plus [`WRAPPER_CONSTRUCT_EXTRA`], chains the
    /// wrapper to the constructor's `%X.prototype%` (so it is `instanceof X`),
    /// and records the wrapped primitive so it stringifies as the primitive.
    /// `fxToInstance` boxing of a primitive for the `XS_CODE_TO_INSTANCE`
    /// opcode (`with(primitive)`, object-destructuring of a primitive RHS) —
    /// XS's `fxNewBooleanInstance`/`fxNewNumberInstance` (`xsType.c`
    /// `fxToInstance`). Distinct from [`Self::build_wrapper`], which is the
    /// `new Number()`/`new Boolean()` **constructor** path (a native dispatch
    /// plus the calibrated [`WRAPPER_CONSTRUCT_EXTRA`]): the bare coercion is
    /// two `fxNewSlot` allocations only — `fxNewObjectInstance` (the wrapper
    /// head) and `fxNext<Type>Property` (the internal `[[NumberData]]`/
    /// `[[BooleanData]]` slot) — with no constructor call frame, so it meters
    /// exactly `2 × SLOT_ALLOCATION_METERING` beyond the opcode dispatch. The
    /// wrapped primitive lives in [`Self::wrapper_data`] (where `valueOf`/
    /// `toString`/the bare completion read it); the wrapper carries no own
    /// enumerable property beyond String's derived indexed characters, so a
    /// name resolved against it (the `with` scopable walk) otherwise falls
    /// through to the corresponding intrinsic prototype and then outward,
    /// matching the oracle. In strict code XS stamps the
    /// wrapper `XS_DONT_PATCH_FLAG` (non-extensible); `with` is a strict-mode
    /// SyntaxError so that arm only matters to a strict destructuring temporary,
    /// but it is set faithfully. String's exotic `length` and indexed
    /// characters are derived from this side-table payload by the property and
    /// CopyDataProperties seams. BigInt remains the only primitive without a
    /// modeled realm wrapper.
    /// A ToObject of a primitive performed by the **language** rather than by a
    /// built-in: `XS_CODE_TO_INSTANCE` (a `with` head, an object-destructuring
    /// RHS) and the sloppy-callee `this` bind. Beyond the two allocations
    /// [`Self::box_primitive_wrapper`] meters, XS pays two `mxMeterOne` steps
    /// here — `fxToInstance` dispatching on the primitive's kind and calling
    /// the per-type `fxNew<Type>Instance`.
    ///
    /// Measured as exactly `1<<15` per box, uniform across
    /// Boolean/Number/String/Symbol/BigInt and across both constructs
    /// (`with (0) { … }`, `var {length: n} = 'ab'`, `f.call(1)`), and omitted
    /// entirely before.
    ///
    /// A ToObject performed *inside* a built-in — `CreateArrayIterator`'s
    /// coercion in `Array.prototype.values.call('a')`, `Object(primitive)`,
    /// `Object.getOwnPropertyDescriptor`'s receiver — does **not** pay it and
    /// calls [`Self::box_primitive_wrapper`] directly. Whether XS truly charges
    /// nothing on those paths or ironhorse has an offsetting gap elsewhere in
    /// them is not settled here; they are left exactly as they metered before
    /// this constant existed, so this moves only the two sites it measured.
    fn box_primitive_to_instance(&mut self, native: Native, prim: Slot) -> crate::value::SlotIndex {
        let inst = self.box_primitive_wrapper(native, prim);
        self.meter.tick_builtin_some(2);
        inst
    }

    /// The wrapper allocation alone, with no `fxToInstance` dispatch cost: two
    /// `fxNewSlot`s and the side-table payload. The entry point for a ToObject
    /// performed *inside* a built-in, where XS reaches the wrapper without the
    /// metered dispatch [`Self::box_primitive_to_instance`] models.
    fn box_primitive_wrapper(&mut self, native: Native, prim: Slot) -> crate::value::SlotIndex {
        // fxNewObjectInstance: one fxNewSlot for the wrapper head.
        let proto = self
            .intrinsics
            .get(native.display_name())
            .and_then(|&c| self.prototype_of(c))
            .unwrap_or(self.object_proto);
        let inst = self.slots.alloc(Slot::instance(proto));
        self.meter.tick_slot_alloc();
        // fxNext<Type>Property: one fxNewSlot for the internal [[XxxData]]
        // slot. ironhorse holds the wrapped primitive in the side table, so
        // the slot's cost is metered here explicitly.
        self.meter.tick_slot_alloc();
        self.wrapper_data.insert(inst, prim);
        if self.strict {
            self.slots.get_mut(inst).flag |= XS_DONT_PATCH_FLAG;
        }
        inst
    }

    /// `Object(primitive)` / `new Object(primitive)` creates an ordinary,
    /// extensible wrapper even when the call appears in strict code. The
    /// shared coercion boxer stamps strict temporary wrappers non-extensible
    /// to mirror XS internals, so the explicit constructor path clears only
    /// that internal stamp before exposing the object to guest mutation.
    fn box_object_primitive(&mut self, native: Native, prim: Slot) -> crate::value::SlotIndex {
        let inst = self.box_primitive_wrapper(native, prim);
        self.slots.get_mut(inst).flag &= !XS_DONT_PATCH_FLAG;
        inst
    }

    fn build_wrapper(&mut self, native: Native, prim: Slot) -> Slot {
        self.meter.tick_builtin();
        let inst = self.new_object();
        self.meter.tick_raw(WRAPPER_CONSTRUCT_EXTRA);
        if let Some(proto) = self
            .intrinsics
            .get(native.display_name())
            .and_then(|&c| self.prototype_of(c))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }
        self.wrapper_data.insert(inst, prim);
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// Insert or overwrite an own property `id = value` on `inst` **without**
    /// metering — for intrinsic-supplied properties whose cost is either an
    /// inherited prototype value (unmetered in XS) or already folded into a
    /// measured construct constant.
    fn set_own_unmetered(&mut self, inst: crate::value::SlotIndex, id: u16, value: Slot) {
        if self.installing_intrinsics && self.slots.get(inst).flag & XS_DONT_PATCH_FLAG != 0 {
            return;
        }
        if let Some(p) = self.find_property(inst, id) {
            let s = self.slots.get_mut(p);
            s.kind = value.kind;
            s.value = value.value;
        } else {
            let head = self.slots.get(inst).next;
            let mut prop = value;
            prop.id = id;
            prop.flag = 0;
            prop.next = head;
            let idx = self.slots.alloc(prop);
            self.slots.get_mut(inst).next = idx;
        }
    }

    /// Variant used by built-ins whose spec-created own property has fixed
    /// attributes (Error `message`/`cause`, prototype methods, and the like).
    fn set_own_unmetered_with_flag(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
        flag: u8,
    ) {
        if self.installing_intrinsics && self.slots.get(inst).flag & XS_DONT_PATCH_FLAG != 0 {
            return;
        }
        if let Some(p) = self.find_property(inst, id) {
            let s = self.slots.get_mut(p);
            s.kind = value.kind;
            s.value = value.value;
            s.flag = flag;
        } else {
            let head = self.slots.get(inst).next;
            let mut prop = value;
            prop.id = id;
            prop.flag = flag;
            prop.next = head;
            let idx = self.slots.alloc(prop);
            self.slots.get_mut(inst).next = idx;
        }
    }

    /// Insert an own **accessor** property `id = {get, set}` on `inst` with the
    /// standard built-in accessor attributes `{enumerable: false,
    /// configurable: true}`, without metering — the boot-time analog of
    /// [`Self::set_own_unmetered_with_flag`] for a native getter/setter pair.
    /// The property slot carries `XS_GETTER_FLAG|XS_SETTER_FLAG` (its own value
    /// blanked) and the callables live in the `accessors` side table, exactly
    /// the shape `ordinary_get_own_descriptor`/`ordinary_get` and
    /// `getOwnPropertyDescriptor` already consume.
    fn set_own_accessor_unmetered(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        get: Option<Slot>,
        set: Option<Slot>,
    ) {
        if self.installing_intrinsics && self.slots.get(inst).flag & XS_DONT_PATCH_FLAG != 0 {
            return;
        }
        // `{enumerable: false, configurable: true}`: DONT_ENUM set, DONT_DELETE
        // clear. The getter/setter flags mark the slot an accessor.
        let flag = XS_DONT_ENUM_FLAG | XS_GETTER_FLAG | XS_SETTER_FLAG;
        if let Some(p) = self.find_property(inst, id) {
            let s = self.slots.get_mut(p);
            s.kind = Kind::Undefined;
            s.value = Payload::None;
            s.flag = flag;
        } else {
            let head = self.slots.get(inst).next;
            let mut prop = Slot::undefined();
            prop.id = id;
            prop.flag = flag;
            prop.next = head;
            let idx = self.slots.alloc(prop);
            self.slots.get_mut(inst).next = idx;
        }
        self.accessors.insert((inst, id), AccessorData { get, set });
    }

    /// Must a `.call`/`.apply` receiver take the abstract-Call dispatcher
    /// ([`Self::invoke_value`]) rather than the native-frame fast path? A
    /// promise resolving function, finally thunk, or capability executor
    /// (every function in `promise_functions`) carries a native-method marker
    /// for reflection but its [[Call]] settles a captured promise, and
    /// `Function.prototype.call`/`apply` themselves redispatch their
    /// receiver; `call_native_method` refuses all of them as "never reaches
    /// here", so `Function.prototype.apply.call({}, {}, [])` or
    /// `resolve.call(undefined, 1)` must not be sent there. `invoke_value`
    /// handles exactly these shapes.
    fn needs_abstract_call(
        &self,
        target_ref: crate::value::SlotIndex,
        method: Option<NativeMethod>,
    ) -> bool {
        self.promise_functions.contains_key(&target_ref)
            || matches!(
                method,
                Some(NativeMethod::FunctionCall | NativeMethod::FunctionApply)
            )
    }

    /// Dispatch `native.call(thisArg, ...args)` or a bound receiver without
    /// entering the `.call` bytecode trampoline. Returns `false` for an
    /// ordinary user function, allowing its in-place trampoline to run.
    fn call_dot_call_native(
        &mut self,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<bool, Step> {
        let target = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        if !self.is_callable_value(target) {
            return Err(self.catchable_type_error_msg("this: not a Function instance".into()));
        }
        let target_ref = match target.value {
            Payload::Reference(r) => r,
            _ => return Ok(false),
        };
        let native = self.native_of(target_ref);
        let method = self.method_of(target_ref);
        let is_bound = self.bound_functions.contains_key(&target_ref);
        let is_proxy = self.proxies.contains_key(&target_ref);
        if native.is_none() && method.is_none() && !is_bound && !is_proxy {
            return Ok(false);
        }
        let this_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let forwarded: Vec<Slot> = if argc >= 1 {
            Self::fill_scratch(
                self.reserve_work_scratch(argc - 1)?,
                self.stack[base + 5..base + 4 + argc].iter().copied(),
            )
        } else {
            Vec::new()
        };
        let forwarded_len = forwarded.len();
        self.stack.truncate(base);
        self.charge_and_check(
            CALL_TRAMPOLINE_METERING + forwarded_len as u64 * CALL_TRAMPOLINE_PER_ARG,
        )?;
        if is_proxy {
            self.meter.tick_raw(CALLABLE_PROXY_DOT_TRAMPOLINE_METERING);
        }
        if is_bound || is_proxy || self.needs_abstract_call(target_ref, method) {
            let result = self.invoke_value(code, target, this_arg, &forwarded);
            return match result {
                Ok(value) => {
                    self.push(value);
                    Ok(true)
                }
                Err(halt) => {
                    self.stack.truncate(base);
                    Err(halt)
                }
            };
        }
        self.push(this_arg);
        self.push(target);
        self.push(Slot::undefined());
        self.push(Slot::of(Kind::Uninitialized, Payload::None));
        for arg in forwarded {
            self.push(arg);
        }
        if let Some(native) = native {
            self.call_native(native, base, forwarded_len, false, code)?;
        } else if let Some(method) = method {
            self.call_native_method(method, base, forwarded_len, code)?;
        }
        Ok(true)
    }

    /// Dispatch `native.apply(thisArg, argsArray)` or a bound receiver without
    /// entering a bytecode frame — the `.apply` analog of
    /// [`Self::call_dot_call_native`]. An ordinary user function returns
    /// `Ok(false)` for the in-place trampoline. Every native, native-method,
    /// and bound receiver accepts modeled array-like shapes through
    /// `CreateListFromArrayLike`.
    fn call_dot_apply_native(&mut self, base: usize, code: &[u8]) -> Result<bool, Step> {
        let target = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        if !self.is_callable_value(target) {
            return Err(self.catchable_type_error_msg("this: not a Function instance".into()));
        }
        let target_ref = match target.value {
            Payload::Reference(r) => r,
            _ => return Ok(false),
        };
        let native = self.native_of(target_ref);
        let method = self.method_of(target_ref);
        let is_bound = self.bound_functions.contains_key(&target_ref);
        let is_proxy = self.proxies.contains_key(&target_ref);
        if native.is_none() && method.is_none() && !is_bound && !is_proxy {
            return Ok(false);
        }
        let this_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // Expand the arguments array (arg 1 of `.apply`) into the forwarded
        // slice. A dense intrinsic Array retains the calibrated bulk path;
        // every other object takes observable CreateListFromArrayLike reads.
        let arg_array = self.stack.get(base + 5).copied();
        let (forwarded, array_read_meter) = match arg_array.map(|s| (s.kind, s.value)) {
            None | Some((Kind::Undefined, _)) | Some((Kind::Null, _)) => (Vec::new(), 0),
            Some((Kind::Reference, Payload::Reference(arr)))
                if self.arrays.contains_key(&arr) && !self.arguments_objects.contains(&arr) =>
            {
                let data = &self.arrays[&arr];
                let len = data.length;
                // Reads route through the counted-accessor view (the
                // seam's bulk-table discipline); no counts move.
                if data.items().len() != len as usize {
                    let args = self.arraylike_to_vec(code, arg_array.unwrap())?;
                    let meter = APPLY_ARRAY_BASE_METERING
                        + args.len() as u64 * APPLY_ARRAY_PER_ELEMENT_METERING;
                    (args, meter)
                } else {
                    let buffer = self.reserve_work_scratch(len as usize)?;
                    let data = &self.arrays[&arr];
                    let args = Self::fill_scratch(buffer, (0..len).map(|i| data.items()[&i]));
                    let meter =
                        APPLY_ARRAY_BASE_METERING + len as u64 * APPLY_ARRAY_PER_ELEMENT_METERING;
                    (args, meter)
                }
            }
            Some((Kind::Reference, _)) | Some((Kind::Instance, _)) => {
                let arg_slot = arg_array.unwrap();
                let args = self.arraylike_to_vec(code, arg_slot)?;
                let meter = self.apply_arraylike_metering(arg_slot, args.len());
                (args, meter)
            }
            Some(_) => return Err(self.catchable_type_error_msg("argArray: not an object".into())),
        };
        let forwarded_len = forwarded.len();
        self.stack.truncate(base);
        self.charge_and_check(CALL_TRAMPOLINE_METERING + array_read_meter)?;
        if is_proxy {
            self.meter.tick_raw(CALLABLE_PROXY_DOT_TRAMPOLINE_METERING);
        }
        if is_bound || is_proxy || self.needs_abstract_call(target_ref, method) {
            let result = self.invoke_value(code, target, this_arg, &forwarded);
            return match result {
                Ok(value) => {
                    self.push(value);
                    Ok(true)
                }
                Err(halt) => {
                    self.stack.truncate(base);
                    Err(halt)
                }
            };
        }
        self.push(this_arg);
        self.push(target);
        self.push(Slot::undefined());
        self.push(Slot::of(Kind::Uninitialized, Payload::None));
        for arg in forwarded {
            self.push(arg);
        }
        if let Some(native) = native {
            self.call_native(native, base, forwarded_len, false, code)?;
        } else if let Some(method) = method {
            self.call_native_method(method, base, forwarded_len, code)?;
        }
        Ok(true)
    }

    /// `Function.prototype.call` trampoline: reshape the call frame from
    /// `[f, callMethod, RESULT, FRAME, thisArg, args…]` into a direct call
    /// `[thisArg, f, RESULT, FRAME, args…]` and enter the receiver's body,
    /// so the receiver runs with `thisArg` as `this` and the trailing
    /// arguments, resuming the caller after this `run`. The receiver must be
    /// a user function (a native/method receiver self-names). Meters the fixed
    /// `.call` re-dispatch overhead ([`CALL_TRAMPOLINE_METERING`]) beyond the
    /// visible opcodes and the callee body.
    fn enter_call_dot_call(
        &mut self,
        base: usize,
        argc: usize,
        ret_pc: usize,
    ) -> Result<usize, Step> {
        let f = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let callee = match f.value {
            Payload::Reference(r)
                if self
                    .functions
                    .get(&r)
                    .map_or(false, |fi| fi.native.is_none() && fi.method.is_none()) =>
            {
                r
            }
            _ => {
                return Err(Step::Host(Halt::NotImplemented(
                    "call:non-user-function-receiver",
                )))
            }
        };
        let this_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // A primitive `thisArg` is boxed to its wrapper object in a sloppy
        // callee (XS's `fxToInstance`) but left as-is in a strict callee. The
        // strictness is only known at the callee's `begin`, so the boxing (or
        // pass-through) is deferred there via [`Self::bind_this_sloppy`] /
        // `BEGIN_STRICT`: every primitive family uses its realm wrapper in a
        // sloppy callee, `undefined`/`null` bind to the global, and strict
        // callees retain the original value.
        let real_args: Vec<Slot> = if argc >= 1 {
            Self::fill_scratch(
                self.reserve_work_scratch(argc - 1)?,
                self.stack[base + 5..base + 4 + argc].iter().copied(),
            )
        } else {
            Vec::new()
        };
        let n = real_args.len();
        self.stack.truncate(base);
        self.stack.push(this_arg); // THIS
        self.stack.push(f); // FUNCTION (the receiver)
        self.stack.push(Slot::undefined()); // RESULT
        self.stack
            .push(Slot::of(Kind::Uninitialized, Payload::None)); // FRAME
        for a in real_args {
            self.stack.push(a);
        }
        self.charge_and_check(CALL_TRAMPOLINE_METERING + n as u64 * CALL_TRAMPOLINE_PER_ARG)?;
        let body_start = self.enter_call(n, ret_pc, false)?;
        let callee_segment = self.callee_segment(callee);
        if callee_segment != self.active_segment {
            let result = self.dispatch_entered_cross_segment(body_start, callee_segment)?;
            self.push(result);
            Ok(ret_pc)
        } else {
            Ok(body_start)
        }
    }

    /// `Function.prototype.apply` trampoline for a user-function receiver:
    /// read the nullable array-like argument list, reshape the frame, and enter
    /// the receiver's body with the rebound `this`. A function retained from a
    /// prior crank is synchronously driven over its defining code segment.
    fn enter_call_dot_apply(
        &mut self,
        base: usize,
        // Kept for signature symmetry with `enter_call`: `.apply`'s
        // own arity is immaterial — thisArg/argArray read positionally.
        _argc: usize,
        ret_pc: usize,
        code: &[u8],
    ) -> Result<usize, Step> {
        let f = self
            .stack
            .get(base)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let callee = match f.value {
            Payload::Reference(r)
                if self
                    .functions
                    .get(&r)
                    .map_or(false, |fi| fi.native.is_none() && fi.method.is_none()) =>
            {
                r
            }
            _ => {
                return Err(Step::Host(Halt::NotImplemented(
                    "apply:non-user-function-receiver",
                )))
            }
        };
        let this_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // See `enter_call_dot_call`: sloppy/strict `this` normalization is
        // handled at the callee's `begin` for every primitive family.
        // The arguments array (the second argument). Absent/undefined/null is
        // the no-array subset (zero args). A **dense** Array instance forwards
        // its elements as the call arguments (XS reads `length` then each
        // element). A non-array object (an array-like / `arguments`) or a
        // sparse array uses CreateListFromArrayLike so holes read through the
        // prototype and accessor failures propagate.
        let arg_array = self.stack.get(base + 5).copied();
        let (real_args, array_read_meter) = match arg_array.map(|s| (s.kind, s.value)) {
            None | Some((Kind::Undefined, _)) | Some((Kind::Null, _)) => (Vec::new(), 0),
            Some((Kind::Reference, Payload::Reference(arr)))
                if self.arrays.contains_key(&arr) && !self.arguments_objects.contains(&arr) =>
            {
                let data = &self.arrays[&arr];
                let len = data.length;
                // Dense only: every index in `[0, length)` must be a present
                // compact element. A hole or materialized accessor needs the
                // observable property path.
                if data.items().len() != len as usize {
                    let args = self.arraylike_to_vec(code, arg_array.unwrap())?;
                    let meter = APPLY_ARRAY_BASE_METERING
                        + args.len() as u64 * APPLY_ARRAY_PER_ELEMENT_METERING;
                    (args, meter)
                } else {
                    let buffer = self.reserve_work_scratch(len as usize)?;
                    let data = &self.arrays[&arr];
                    let args = Self::fill_scratch(buffer, (0..len).map(|i| data.items()[&i]));
                    // The array path's fixed setup plus the per-element read +
                    // forwarding (`mxGetID(_length)` + `mxGetIndex(i)` + copy).
                    let meter =
                        APPLY_ARRAY_BASE_METERING + len as u64 * APPLY_ARRAY_PER_ELEMENT_METERING;
                    (args, meter)
                }
            }
            // A non-dense-array **object** argArray (array-like / `arguments` /
            // sparse array): `CreateListFromArrayLike` (ECMA-262 7.3.18) reads
            // `length` (`ToLength`) then each indexed element, with any getter
            // throw propagated. The shared helper below splits the residual
            // from the metering already paid by those property reads.
            Some((Kind::Reference, _)) | Some((Kind::Instance, _)) => {
                let arg_slot = arg_array.unwrap_or_else(Slot::undefined);
                let args = self.arraylike_to_vec(code, arg_slot)?;
                let meter = self.apply_arraylike_metering(arg_slot, args.len());
                (args, meter)
            }
            // A non-object, non-nullish argArray (a Boolean/Number/String/
            // Symbol/BigInt primitive): `CreateListFromArrayLike` step 2
            // (ECMA-262 7.3.18) throws a catchable TypeError.
            Some(_) => return Err(self.catchable_type_error_msg("argArray: not an object".into())),
        };
        let n = real_args.len();
        self.stack.truncate(base);
        self.stack.push(this_arg); // THIS
        self.stack.push(f); // FUNCTION (the receiver)
        self.stack.push(Slot::undefined()); // RESULT
        self.stack
            .push(Slot::of(Kind::Uninitialized, Payload::None)); // FRAME
        for a in real_args {
            self.stack.push(a);
        }
        // The no-array base ([`CALL_TRAMPOLINE_METERING`]) plus the array
        // path's extra (`array_read_meter`); the per-element forwarding is
        // already folded into [`APPLY_ARRAY_PER_ELEMENT_METERING`].
        self.charge_and_check(CALL_TRAMPOLINE_METERING + array_read_meter)?;
        let body_start = self.enter_call(n, ret_pc, false)?;
        let callee_segment = self.callee_segment(callee);
        if callee_segment != self.active_segment {
            let result = self.dispatch_entered_cross_segment(body_start, callee_segment)?;
            self.push(result);
            Ok(ret_pc)
        } else {
            Ok(body_start)
        }
    }

    /// A bound function's **construct** (`new boundF(...)`, ECMA-262 10.4.1.2
    /// `[[Construct]]`): construct the ultimate target with the bound leading
    /// arguments prepended to the call arguments, and the fresh instance's
    /// `new.target` resolved to that ultimate target. The stack at `base` holds
    /// the construct frame `[THIS(uninit), FUNCTION(bound), RESULT, FRAME,
    /// callArgs...]`; reshape it to the target's construct frame and enter.
    ///
    /// The bound chain is walked to its ultimate target, prepending each
    /// level's bound args **inner-first** (`args = innerBound ++ … ++ outerBound
    /// ++ callArgs`, the fold of step 1's `boundArgs ++ argumentsList` down the
    /// chain). For the plain `new` operator the `new.target` supplied to the
    /// outermost bound is the bound itself, and step 5 (`SameValue(F, newTarget)
    /// → target`) applies at every level, so the effective `new.target` is the
    /// ultimate target — its `.prototype` becomes the instance's prototype
    /// (via [`Self::run_constructor`] reading `target_func`). A native or
    /// non-constructor ultimate target is not yet modeled and self-names.
    fn enter_construct_bound(
        &mut self,
        bf: crate::value::SlotIndex,
        base: usize,
        argc: usize,
        ret_pc: usize,
    ) -> Result<usize, Step> {
        let call_args: Vec<Slot> = if argc >= 1 {
            Self::fill_scratch(
                self.reserve_work_scratch(argc)?,
                self.stack[base + 4..base + 4 + argc].iter().copied(),
            )
        } else {
            Vec::new()
        };
        let mut acc = call_args;
        let mut cur = bf;
        let target = loop {
            let data = &self.bound_functions[&cur];
            let t = data.target;
            let length = data
                .args
                .len()
                .checked_add(acc.len())
                .ok_or(Step::Host(Halt::HeapExhausted))?;
            let mut prepended = self.reserve_work_scratch(length)?;
            prepended.extend_from_slice(&self.bound_functions[&cur].args);
            prepended.extend_from_slice(&acc);
            acc = prepended;
            if self.bound_functions.contains_key(&t) {
                cur = t;
                continue;
            }
            match self.functions.get(&t) {
                Some(fi) if fi.native.is_none() && fi.method.is_none() => break t,
                _ => return Err(Step::Host(Halt::NotImplemented("bind:new-bound-target"))),
            }
        };
        let total = acc.len();
        self.stack.truncate(base);
        self.stack.push(Slot::uninitialized()); // THIS (construct placeholder)
        self.stack
            .push(Slot::of(Kind::Reference, Payload::Reference(target))); // FUNCTION
        self.stack.push(Slot::undefined()); // RESULT
        self.stack
            .push(Slot::of(Kind::Uninitialized, Payload::None)); // FRAME
        for a in acc {
            self.stack.push(a);
        }
        // `new.target` resolves to the ultimate target (see the doc comment).
        self.pending_new_target = Some(target);
        self.charge_and_check(BIND_CALL_METERING + total as u64 * BIND_CALL_PER_ARG)?;
        self.enter_call(total, ret_pc, true)
    }

    /// `Error.prototype.toString` over an arbitrary object receiver. The
    /// method reads inherited `name`/`message` properties and applies the
    /// shared string-hint primitive conversion, rather than consulting the
    /// native Error side table (the method is intentionally generic).
    fn error_to_string(&mut self, code: &[u8], this: Slot) -> Result<Vec<u16>, Step> {
        let inst = match this.value {
            Payload::Reference(inst) if this.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("this: not an object".into())),
        };
        let name_id = self.intern_key_unmetered("name");
        let message_id = self.intern_key_unmetered("message");
        let name_value = self.mop_get(code, inst, name_id, this)?;
        let name = if name_value.kind == Kind::Undefined {
            "Error".encode_utf16().collect()
        } else {
            self.to_string_units(code, name_value)?
        };
        let message_value = self.mop_get(code, inst, message_id, this)?;
        let message = if message_value.kind == Kind::Undefined {
            Vec::new()
        } else {
            self.to_string_units(code, message_value)?
        };
        if name.is_empty() {
            Ok(message)
        } else if message.is_empty() {
            Ok(name)
        } else {
            let mut result = self.reserve_scratch(name.len() + message.len() + 2)?;
            result.extend_from_slice(&name);
            result.extend_from_slice(&[':' as u16, ' ' as u16]);
            result.extend_from_slice(&message);
            Ok(result)
        }
    }

    fn value_to_string(&mut self, code: &[u8], value: Slot) -> Result<String, Step> {
        let primitive = if value.kind == Kind::Reference {
            self.to_primitive(code, value, true)?
        } else {
            value
        };
        if primitive.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to string".into()));
        }
        Ok(String::from_utf8_lossy(&self.to_string_bytes_metered(primitive)).into_owned())
    }

    /// Dispatch a native prototype **method** call (`obj.toString()`,
    /// `obj.hasOwnProperty(k)`, `wrapper.valueOf()`, …). The value stack holds
    /// the call frame `[THIS, FUNCTION, RESULT, FRAME]` from `base`; `THIS` is
    /// the receiver. Computes the result from the receiver (no re-entry into
    /// user code), meters the method's steps, collapses the region to the
    /// result, and pushes it. A method whose receiver shape ironhorse cannot model
    /// self-names (an honest skip).
    /// disposeAsync rejects its promise for receiver validation errors;
    /// the remaining resource-management methods throw synchronously.
    fn explicit_resource_error(
        &mut self,
        code: &[u8],
        method: NativeMethod,
        name: &'static str,
        message: String,
    ) -> Result<Slot, Step> {
        let error = self.internal_error(name, message);
        if method == NativeMethod::AsyncDisposableStackDisposeAsync {
            let promise = self.new_promise_instance();
            self.settle_promise(code, promise, error, true)?;
            Ok(Slot::of(Kind::Reference, Payload::Reference(promise)))
        } else {
            Err(self.raise_js(error))
        }
    }

    fn explicit_resource_method(
        &mut self,
        method: NativeMethod,
        this: Slot,
        base: usize,
        _argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let is_async = matches!(
            method,
            NativeMethod::AsyncDisposableStackUse
                | NativeMethod::AsyncDisposableStackAdopt
                | NativeMethod::AsyncDisposableStackDefer
                | NativeMethod::AsyncDisposableStackMove
                | NativeMethod::AsyncDisposableStackDisposeAsync
        );
        let brand = if is_async {
            "AsyncDisposableStack"
        } else {
            "DisposableStack"
        };
        let inst = match (this.kind, this.value) {
            (Kind::Reference, Payload::Reference(inst))
                if self
                    .disposable_stacks
                    .get(&inst)
                    .is_some_and(|data| data.asynchronous == is_async) =>
            {
                inst
            }
            _ => {
                return self.explicit_resource_error(
                    code,
                    method,
                    "TypeError",
                    format!("this: not a {brand} instance"),
                )
            }
        };
        let disposing = matches!(
            method,
            NativeMethod::DisposableStackDispose | NativeMethod::AsyncDisposableStackDisposeAsync
        );
        if !disposing && self.disposable_stacks[&inst].disposed {
            return self.explicit_resource_error(
                code,
                method,
                "ReferenceError",
                format!("this: disposed {brand} instance"),
            );
        }
        let arg = |n: usize| {
            self.stack
                .get(base + 4 + n)
                .copied()
                .unwrap_or_else(Slot::undefined)
        };
        if matches!(
            method,
            NativeMethod::DisposableStackUse | NativeMethod::AsyncDisposableStackUse
        ) {
            let resource = arg(0);
            if matches!(resource.kind, Kind::Null | Kind::Undefined) {
                return Ok(resource);
            }
            let resource_object = self.array_to_object(resource)?;
            let Payload::Reference(resource_inst) = resource_object.value else {
                unreachable!("ToObject result")
            };
            let symbol_name = if is_async { "asyncDispose" } else { "dispose" };
            let mut disposer = match self.well_known_symbol_property_id(symbol_name) {
                Some(id) => self.mop_get(code, resource_inst, id, resource)?,
                None => Slot::undefined(),
            };
            // The pinned XS falls back on every non-callable async method.
            if is_async && !self.is_callable_value(disposer) {
                disposer = match self.well_known_symbol_property_id("dispose") {
                    Some(id) => self.mop_get(code, resource_inst, id, resource)?,
                    None => Slot::undefined(),
                };
            }
            if !self.is_callable_value(disposer) {
                return Err(self.catchable_type_error_msg(
                    if is_async {
                        "dispose: no a function"
                    } else {
                        "dispose: not a function"
                    }
                    .into(),
                ));
            }
            // Measured add-record residue (see the constant).
            self.meter.tick_raw(DISPOSABLE_STACK_ADD_METERING);
            let data = self
                .disposable_stacks
                .get_mut(&inst)
                .expect("brand checked");
            data.records.push(DisposalRecord {
                resource,
                method: disposer,
                pass_resource: false,
            });
            return Ok(resource);
        }
        if matches!(
            method,
            NativeMethod::DisposableStackAdopt | NativeMethod::AsyncDisposableStackAdopt
        ) {
            let resource = arg(0);
            let disposer = arg(1);
            if !self.is_callable_value(disposer) {
                return Err(self.catchable_type_error_msg(
                    if is_async {
                        "dispose: no a function"
                    } else {
                        "dispose: not a function"
                    }
                    .into(),
                ));
            }
            self.meter.tick_raw(DISPOSABLE_STACK_ADD_METERING);
            let data = self
                .disposable_stacks
                .get_mut(&inst)
                .expect("brand checked");
            data.records.push(DisposalRecord {
                resource,
                method: disposer,
                pass_resource: true,
            });
            return Ok(resource);
        }
        if matches!(
            method,
            NativeMethod::DisposableStackDefer | NativeMethod::AsyncDisposableStackDefer
        ) {
            let disposer = arg(0);
            if !self.is_callable_value(disposer) {
                return Err(self.catchable_type_error_msg(
                    if is_async {
                        "dispose: no a function"
                    } else {
                        "dispose: not a function"
                    }
                    .into(),
                ));
            }
            self.meter.tick_raw(DISPOSABLE_STACK_ADD_METERING);
            let data = self
                .disposable_stacks
                .get_mut(&inst)
                .expect("brand checked");
            data.records.push(DisposalRecord {
                resource: Slot::undefined(),
                method: disposer,
                pass_resource: false,
            });
            return Ok(Slot::undefined());
        }
        if matches!(
            method,
            NativeMethod::DisposableStackMove | NativeMethod::AsyncDisposableStackMove
        ) {
            self.meter.tick_raw(DISPOSABLE_STACK_ADD_METERING);
            let data = self
                .disposable_stacks
                .get_mut(&inst)
                .expect("brand checked");
            data.disposed = true;
            let records = std::mem::take(&mut data.records);
            let proto = match self.slots.get(inst).value {
                Payload::Reference(proto) => proto,
                _ => self.object_proto,
            };
            let moved = self.slots.alloc(Slot::instance(proto));
            self.disposable_stacks.insert(
                moved,
                DisposableStackData {
                    disposed: false,
                    asynchronous: is_async,
                    records,
                },
            );
            return Ok(Slot::of(Kind::Reference, Payload::Reference(moved)));
        }

        let data = self
            .disposable_stacks
            .get_mut(&inst)
            .expect("brand checked");
        if data.disposed {
            if is_async {
                let promise = self.new_promise_instance();
                self.settle_promise(code, promise, Slot::undefined(), false)?;
                return Ok(Slot::of(Kind::Reference, Payload::Reference(promise)));
            }
            return Ok(Slot::undefined());
        }
        data.disposed = true;
        let mut records = std::mem::take(&mut data.records);
        let mut pending_error: Option<Slot> = None;
        while let Some(record) = records.pop() {
            let args = if record.pass_resource {
                vec![record.resource]
            } else {
                Vec::new()
            };
            let this_arg = if record.pass_resource {
                Slot::undefined()
            } else {
                record.resource
            };
            // A `use` record (this-bound @@dispose; `defer` records
            // carry an undefined resource, `adopt` passes it as the
            // argument) meters one extra dispatch unit at disposal.
            if !record.pass_resource && record.resource.kind != Kind::Undefined {
                self.meter.tick_raw(DISPOSE_USE_RECORD_METERING);
            }
            if let Err(error) =
                self.run_callback_catching_throw(code, record.method, this_arg, &args)?
            {
                pending_error = Some(match pending_error {
                    Some(suppressed) => self.build_suppressed_error(error, suppressed, None),
                    None => error,
                });
            }
        }
        if is_async {
            let promise = self.new_promise_instance();
            self.settle_promise(
                code,
                promise,
                pending_error.unwrap_or_else(Slot::undefined),
                pending_error.is_some(),
            )?;
            Ok(Slot::of(Kind::Reference, Payload::Reference(promise)))
        } else if let Some(error) = pending_error {
            Err(self.raise_js(error))
        } else {
            Ok(Slot::undefined())
        }
    }

    fn call_native_method(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<(), Step> {
        // The central native-method dispatch is the largest activation in the
        // crate. A method that invokes another native without entering
        // `dispatch_at` — `Array.prototype.join` stringifying an element that
        // is itself an array, `Function.prototype.call` trampolining, an
        // accessor's native setter re-entering itself — nests this frame on
        // the host stack, so it is charged at the heavy class and bounded by
        // [`NATIVE_DEPTH_LIMIT`].
        self.with_native_frame(HEAVY_FRAME_COST, |vm| {
            // These accessors can recursively Set their own copied descriptor.
            // Keep the large dispatch frame out of that forwarding cycle.
            if matches!(
                m,
                NativeMethod::IteratorConstructorSetter | NativeMethod::IteratorToStringTagSetter
            ) {
                vm.cost.on_builtin(m);
                let this = vm.stack.get(base).copied().unwrap_or_else(Slot::undefined);
                let arg0 = vm
                    .stack
                    .get(base + 4)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let result = vm.iterator_prototype_setter(code, m, this, arg0)?;
                vm.stack.truncate(base);
                vm.push(result);
                Ok(())
            } else {
                vm.call_native_method_inner(m, base, argc, code)
            }
        })
    }

    /// Dispatch a `Reflect.*` reflective built-in (`xsProxy.c` `fx_Reflect_*`
    /// → the `mxBehavior*` object-behavior primitives). Every property operation
    /// routes through the complete internal-method MOP, so arrays, String
    /// wrappers, TypedArrays, and proxies retain their exotic semantics. The
    /// result is oracle-certified; the metering is the advisory native-frame
    /// residual (accuracy-over-parity: the `Reflect` corpus is result-gated).
    fn call_reflect(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let _ = argc;
        let arg0 = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let arg1 = self
            .stack
            .get(base + 5)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let arg2 = self
            .stack
            .get(base + 6)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let arg3 = self
            .stack
            .get(base + 7)
            .copied()
            .unwrap_or_else(Slot::undefined);
        match m {
            // `Reflect.getPrototypeOf(target)`: the target's `[[Prototype]]` —
            // a reference to the prototype instance, or `null`. Sound for any
            // object receiver (the prototype is the instance slot's payload).
            NativeMethod::ReflectGetPrototypeOf => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                self.mop_get_prototype(code, inst)
            }
            // `Reflect.setPrototypeOf(target, proto)`: invoke the target's
            // `[[SetPrototypeOf]]` with an object or `null`, returning success.
            NativeMethod::ReflectSetPrototypeOf => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                if !matches!(arg1.kind, Kind::Null | Kind::Reference) {
                    return Err(self.catchable_type_error_msg("invalid prototype".into()));
                }
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                Ok(Slot::boolean(self.mop_set_prototype(code, inst, arg1)?))
            }
            NativeMethod::ReflectIsExtensible => {
                let object = match arg0.value {
                    Payload::Reference(object) if arg0.kind == Kind::Reference => object,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                Ok(Slot::boolean(self.mop_is_extensible(code, object)?))
            }
            NativeMethod::ReflectPreventExtensions => {
                let object = match arg0.value {
                    Payload::Reference(object) if arg0.kind == Kind::Reference => object,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                Ok(Slot::boolean(self.mop_prevent_extensions(code, object)?))
            }
            // `Reflect.getOwnPropertyDescriptor(target, key)`: identical result
            // to `Object.getOwnPropertyDescriptor` — the data-descriptor object
            // or `undefined`. A non-object target self-names (no coercion).
            NativeMethod::ReflectGetOwnPropertyDescriptor => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let key = self.to_read_key(code, arg1)?;
                match self.mop_get_own_property_read(code, inst, key)? {
                    Some(descriptor) => {
                        self.meter.tick_raw(GOPD_PRESENT_RESIDUAL_METERING);
                        Ok(self.descriptor_object(descriptor))
                    }
                    None => {
                        self.meter.tick_raw(GOPD_ABSENT_RESIDUAL_METERING);
                        Ok(Slot::undefined())
                    }
                }
            }
            // `Reflect.defineProperty(target, key, descriptor)`: convert the
            // key before the descriptor, then invoke `[[DefineOwnProperty]]`.
            // Rejection is returned as `false`, not promoted to a throw.
            NativeMethod::ReflectDefineProperty => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let id = self.to_property_id(code, arg1)?;
                let descriptor_object = match arg2.value {
                    Payload::Reference(d) if arg2.kind == Kind::Reference => d,
                    _ => return Err(self.catchable_type_error_msg("invalid descriptor".into())),
                };
                let descriptor = self.descriptor_from_object(code, descriptor_object)?;
                self.meter.tick_raw(DEFINE_PROPERTY_NEW_RESIDUAL_METERING);
                Ok(Slot::boolean(
                    self.mop_define_own_property(code, inst, id, descriptor)?,
                ))
            }
            // `Reflect.ownKeys(target)`: a fresh Array containing the target's
            // complete `[[OwnPropertyKeys]]` result, including exotic indices,
            // non-enumerable strings, symbols, and proxy trap results.
            NativeMethod::ReflectOwnKeys => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let keys = self.mop_own_keys(code, inst)?;
                let n = keys.len() as u32;
                self.meter.tick_raw(OBJECT_KEYS_FRAME_METERING);
                self.charge_and_check(self.array_chunk_size_metering(n))?;
                for _ in 0..n {
                    self.meter.tick_slot_alloc();
                }
                Ok(self.array_from_slots(&keys))
            }
            // `Reflect.has(target, key)`: the `key in target` chain walk as a
            // boolean (same soundness gate as `XS_CODE_IN`).
            NativeMethod::ReflectHas => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let key = self.to_read_key(code, arg1)?;
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                Ok(Slot::boolean(
                    self.mop_has_read_with_recursions(code, inst, key)?.0,
                ))
            }
            // `Reflect.get(target, key[, receiver])`: dispatch the target's
            // full `[[Get]]`, including exotic objects and accessors that use
            // the explicit receiver.
            NativeMethod::ReflectGet => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let key = self.to_read_key(code, arg1)?;
                let receiver = if argc >= 3 { arg2 } else { arg0 };
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                self.mop_get_read(code, inst, key, receiver)
            }
            // `Reflect.set(target, key, value[, receiver])`: the target's
            // complete `[[Set]]`, returning whether it was accepted.
            NativeMethod::ReflectSet => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let id = self.to_property_id(code, arg1)?;
                let receiver = if argc >= 4 { arg3 } else { arg0 };
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                Ok(Slot::boolean(self.mop_set(code, inst, id, arg2, receiver)?))
            }
            // `Reflect.deleteProperty(target, key)`: the target's `[[Delete]]`
            // result (`false` for a non-configurable own property).
            NativeMethod::ReflectDeleteProperty => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let key = self.to_read_key(code, arg1)?;
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                Ok(Slot::boolean(self.mop_delete_read(code, inst, key)?))
            }
            // `Reflect.apply` / `Reflect.construct`: re-entrant (spread argument
            // list into the interpreter frame machinery); an honest named skip
            // this child.
            // `Reflect.apply(target, thisArgument, argumentsList)` (ECMA-262
            // 28.1.1): `Call(target, thisArgument, CreateListFromArrayLike(...))`.
            NativeMethod::ReflectApply => {
                if !self.is_callable_value(arg0) {
                    return Err(self.catchable_type_error_msg("target: not a function".into()));
                }
                if arg2.kind != Kind::Reference {
                    return Err(
                        self.catchable_type_error_msg("argumentsList: not an object".into())
                    );
                }
                let args = self.arraylike_to_vec(code, arg2)?;
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                self.invoke_value(code, arg0, arg1, &args)
            }
            // `Reflect.construct(target, argumentsList[, newTarget])` (ECMA-262
            // 28.1.2): `Construct(target, args, newTarget)`.
            NativeMethod::ReflectConstruct => {
                // ECMA-262 28.1.2: both the target and the (defaulted) newTarget
                // must be **constructors**, not merely callable — a native
                // prototype method (the `format` getter, its bound function)
                // has no `[[Construct]]`, so `Reflect.construct(fn, [], getter)`
                // throws, and the harness `isConstructor(getter)` is `false`.
                if !self.is_constructor_value(arg0) {
                    return Err(self.catchable_type_error_msg("target: not a constructor".into()));
                }
                let new_target = if argc >= 3 { arg2 } else { arg0 };
                if !self.is_constructor_value(new_target) {
                    return Err(
                        self.catchable_type_error_msg("newTarget: not a constructor".into())
                    );
                }
                if arg1.kind != Kind::Reference {
                    return Err(
                        self.catchable_type_error_msg("argumentsList: not an object".into())
                    );
                }
                let args = self.arraylike_to_vec(code, arg1)?;
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                self.construct_value(code, arg0, &args, new_target)
            }
            _ => Err(Step::Host(Halt::EngineInvariant("Reflect:unexpected"))),
        }
    }

    /// `CreateListFromArrayLike(value)` (ECMA-262 7.3.18) with the default
    /// element-type list (any) — read `length`, then each indexed element.
    fn arraylike_to_vec(&mut self, code: &[u8], value: Slot) -> Result<Vec<Slot>, Step> {
        let inst = match value.value {
            Payload::Reference(i) if value.kind == Kind::Reference => i,
            _ => return Err(self.catchable_type_error()),
        };
        let length = self.arraylike_length(code, inst, value)?;
        let len = self.to_length_value(code, length)?;
        let capacity = usize::try_from(len).map_err(|_| Step::Host(Halt::HeapExhausted))?;
        let mut out = self.reserve_work_scratch(capacity)?;
        for i in 0..len {
            out.push(self.arraylike_index(code, inst, i, value)?);
        }
        Ok(out)
    }

    /// Residual for `Function.prototype.apply` after an observable
    /// CreateListFromArrayLike walk. Dense and sparse Arrays use XS's full
    /// array schedule. Ordinary objects and arguments objects have already
    /// paid part of that schedule through their property MOP paths.
    fn apply_arraylike_metering(&self, value: Slot, len: usize) -> u64 {
        let full = APPLY_ARRAY_BASE_METERING + len as u64 * APPLY_ARRAY_PER_ELEMENT_METERING;
        let Payload::Reference(inst) = value.value else {
            return full;
        };
        if self.arguments_objects.contains(&inst) {
            return full.saturating_sub(APPLY_ARGUMENTS_ARRAYLIKE_CREDIT);
        }
        if self.arrays.contains_key(&inst) || self.proxies.contains_key(&inst) {
            return full;
        }
        full.saturating_sub(APPLY_GENERIC_ARRAYLIKE_CREDIT)
    }

    /// `IterableToList(items)` (ECMA-262 7.4.19): acquire the iterator and its
    /// `next` method once, then collect every IteratorStepValue result. An
    /// abrupt iterator step propagates directly; there is no later per-element
    /// operation requiring IteratorClose.
    fn iterable_to_list(&mut self, code: &[u8], items: Slot) -> Result<Vec<Slot>, Step> {
        let outcome = self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            machine.iterable_to_list_inner(code, items)
        });
        match outcome {
            Ok(Ok(values)) => Ok(values),
            Ok(Err(error)) => Err(self.raise_js(error)),
            Err(halt) => Err(halt),
        }
    }

    fn iterable_to_list_inner(
        &mut self,
        code: &[u8],
        items: Slot,
    ) -> Result<Result<Vec<Slot>, Slot>, Step> {
        if matches!(items.kind, Kind::Null | Kind::Undefined) {
            let message = if items.kind == Kind::Null {
                "cannot coerce null to object"
            } else {
                "cannot coerce undefined to object"
            };
            return Ok(Err(self.internal_error("TypeError", message.into())));
        }
        let value_id = self.intern_key("value");
        let done_id = self.intern_key("done");
        self.value_id = Some(value_id);
        self.done_id = Some(done_id);
        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .expect("well-known iterator symbol");
        let iterator_method = match items.value {
            Payload::Reference(object) if items.kind == Kind::Reference => {
                match self.array_from_try(|this| this.mop_get(code, object, iterator_id, items))? {
                    Ok(method) => method,
                    Err(error) => return Ok(Err(error)),
                }
            }
            _ => {
                let proto = match items.kind {
                    Kind::String => self.string_proto,
                    Kind::Integer | Kind::Number => self.number_proto,
                    Kind::Symbol => self.symbol_proto,
                    Kind::BigInt => self.bigint_proto,
                    Kind::Boolean => self
                        .intrinsics
                        .get("Boolean")
                        .and_then(|&constructor| self.ctor_prototype.get(&constructor).copied())
                        .unwrap_or(crate::value::SlotIndex::NULL),
                    _ => crate::value::SlotIndex::NULL,
                };
                if proto.is_null() {
                    Slot::undefined()
                } else {
                    match self
                        .array_from_try(|this| this.mop_get(code, proto, iterator_id, items))?
                    {
                        Ok(method) => method,
                        Err(error) => return Ok(Err(error)),
                    }
                }
            }
        };
        if !self.is_callable_value(iterator_method) {
            return Ok(Err(
                self.internal_error("TypeError", "call: not a function".into())
            ));
        }
        let iterator =
            match self.array_from_try(|this| this.call_any(code, iterator_method, items, &[]))? {
                Ok(iterator) => iterator,
                Err(error) => return Ok(Err(error)),
            };
        let iterator_inst = match iterator.value {
            Payload::Reference(iterator_inst) if iterator.kind == Kind::Reference => iterator_inst,
            _ => {
                return Ok(Err(
                    self.internal_error("TypeError", "iterator: not an object".into())
                ))
            }
        };
        let next_id = self.intern_key("next");
        let next = match self
            .array_from_try(|this| this.mop_get(code, iterator_inst, next_id, iterator))?
        {
            Ok(next) if self.is_callable_value(next) => next,
            Ok(_) => {
                return Ok(Err(
                    self.internal_error("TypeError", "call: not a function".into())
                ))
            }
            Err(error) => return Ok(Err(error)),
        };
        let mut values = Vec::new();
        for _ in 0..1_000_000u64 {
            let step = match self.array_from_try(|this| this.call_any(code, next, iterator, &[]))? {
                Ok(step) => step,
                Err(error) => return Ok(Err(error)),
            };
            let step_inst = match step.value {
                Payload::Reference(step_inst) if step.kind == Kind::Reference => step_inst,
                _ => {
                    return Ok(Err(self.internal_error(
                        "TypeError",
                        "iterator result: not an object".into(),
                    )))
                }
            };
            let done =
                match self.array_from_try(|this| this.mop_get(code, step_inst, done_id, step))? {
                    Ok(done) => done,
                    Err(error) => return Ok(Err(error)),
                };
            if self.truthy(&done) {
                return Ok(Ok(values));
            }
            let value =
                match self.array_from_try(|this| this.mop_get(code, step_inst, value_id, step))? {
                    Ok(value) => value,
                    Err(error) => return Ok(Err(error)),
                };
            self.charge_builtin_work(1)?;
            self.push_prepaid_scratch(&mut values, value)?;
        }
        Err(Step::Host(Halt::StepLimit(self.n_dispatched)))
    }

    /// Dispatch a Map/Set/WeakMap/WeakSet mutator or query method (xsMapSet.c).
    /// The receiver `this` names the collection; argument 0 is the key/value
    /// (`stack[base + 4]`), argument 1 the value for `Map.set`
    /// (`stack[base + 5]`). Metering is purely allocation-driven — xsMapSet.c
    /// calls no `mxMeter` — so a new entry charges its `fxNewSlot`s (and, for a
    /// Map/Set, any `fxResizeEntries` rehash chunk) while a query or an
    /// in-place update is allocation-free; each carries only the calibrated
    /// native-frame residual. Wrong receiver brands and invalid weak keys
    /// produce real catchable TypeErrors with the corresponding XS diagnostic.
    fn collection_brand_error(&mut self, kind: CollKind, readonly: bool) -> Step {
        let name = match kind {
            CollKind::Map => "Map",
            CollKind::Set => "Set",
            CollKind::WeakMap => "WeakMap",
            CollKind::WeakSet => "WeakSet",
        };
        let state = if readonly { "read-only" } else { "not a" };
        self.catchable_type_error_msg(format!("this: {state} {name} instance"))
    }

    fn call_collection(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        let _ = argc;
        let arg0 = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let expected_kind = match m {
            NativeMethod::MapSet
            | NativeMethod::MapGet
            | NativeMethod::MapHas
            | NativeMethod::MapDelete => CollKind::Map,
            NativeMethod::WeakMapSet
            | NativeMethod::WeakMapGet
            | NativeMethod::WeakMapHas
            | NativeMethod::WeakMapDelete => CollKind::WeakMap,
            NativeMethod::SetAdd | NativeMethod::SetHas | NativeMethod::SetDelete => CollKind::Set,
            NativeMethod::WeakSetAdd | NativeMethod::WeakSetHas | NativeMethod::WeakSetDelete => {
                CollKind::WeakSet
            }
            _ => {
                return Err(Step::Host(Halt::EngineInvariant(
                    "collection:unexpected-method",
                )))
            }
        };
        let inst = match self.collection_ref(this) {
            Some(i) => i,
            None => return Err(self.collection_brand_error(expected_kind, false)),
        };
        let kind = self.collections[&inst].kind;
        if kind != expected_kind {
            return Err(self.collection_brand_error(expected_kind, false));
        }
        if matches!(
            m,
            NativeMethod::MapSet
                | NativeMethod::WeakMapSet
                | NativeMethod::SetAdd
                | NativeMethod::WeakSetAdd
                | NativeMethod::MapDelete
                | NativeMethod::WeakMapDelete
                | NativeMethod::SetDelete
                | NativeMethod::WeakSetDelete
        ) && self.slots.get(inst).flag & XS_DONT_MODIFY_FLAG != 0
        {
            return Err(self.collection_brand_error(expected_kind, true));
        }
        let weak = matches!(kind, CollKind::WeakMap | CollKind::WeakSet);
        match m {
            NativeMethod::MapSet | NativeMethod::WeakMapSet => {
                let val = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let key = self.normalize_coll_key(arg0);
                if weak && key.kind != Kind::Reference {
                    return Err(self.catchable_type_error_msg("key: not an object".into()));
                }
                match self.collection_find(inst, &key) {
                    Some(p) => {
                        self.collections.get_mut(&inst).unwrap().set_entry_value(
                            p,
                            val,
                            &mut self.side_refs,
                        );
                    }
                    None => {
                        // `fxSetEntry`/`fxSetWeakEntry` new key: three slots
                        // (Map: key + value + entry; WeakMap: keyEntry +
                        // listEntry + closure).
                        self.charge_new_entry_slots(3);
                        self.collections.get_mut(&inst).unwrap().push_entry(
                            key,
                            val,
                            &mut self.side_refs,
                        );
                        self.collection_table_resize(inst);
                    }
                }
                Ok(this)
            }
            NativeMethod::SetAdd | NativeMethod::WeakSetAdd => {
                let key = self.normalize_coll_key(arg0);
                if weak && key.kind != Kind::Reference {
                    return Err(self.catchable_type_error_msg("value: not an object".into()));
                }
                if self.collection_find(inst, &key).is_none() {
                    // `fxSetEntry` with no pair → two slots (value + entry);
                    // `fxSetWeakEntry` → three (keyEntry + listEntry + closure).
                    let n = if weak { 3 } else { 2 };
                    self.charge_new_entry_slots(n);
                    self.collections.get_mut(&inst).unwrap().push_entry(
                        key,
                        Slot::undefined(),
                        &mut self.side_refs,
                    );
                    self.collection_table_resize(inst);
                }
                Ok(this)
            }
            NativeMethod::MapGet | NativeMethod::WeakMapGet => {
                let key = self.normalize_coll_key(arg0);
                let v = self
                    .collection_find(inst, &key)
                    .map(|p| self.collections[&inst].entries()[p].unwrap().1)
                    .unwrap_or_else(Slot::undefined);
                Ok(v)
            }
            NativeMethod::MapHas | NativeMethod::WeakMapHas => {
                let key = self.normalize_coll_key(arg0);
                Ok(Slot::boolean(self.collection_find(inst, &key).is_some()))
            }
            NativeMethod::SetHas | NativeMethod::WeakSetHas => {
                let key = self.normalize_coll_key(arg0);
                Ok(Slot::boolean(self.collection_find(inst, &key).is_some()))
            }
            NativeMethod::MapDelete
            | NativeMethod::WeakMapDelete
            | NativeMethod::SetDelete
            | NativeMethod::WeakSetDelete => {
                let key = self.normalize_coll_key(arg0);
                match self.collection_find(inst, &key) {
                    Some(p) => {
                        self.collections
                            .get_mut(&inst)
                            .unwrap()
                            .remove_entry(p, &mut self.side_refs);
                        // `fxDeleteEntry` calls `fxResizeEntries` (a Map/Set may
                        // shrink its address chunk; a weak unlink is
                        // allocation-free).
                        self.collection_table_resize(inst);
                        Ok(Slot::boolean(true))
                    }
                    None => Ok(Slot::boolean(false)),
                }
            }
            _ => Err(Step::Host(Halt::EngineInvariant(
                "collection:unexpected-method",
            ))),
        }
    }

    /// Populate a freshly-created collection through the calibrated dense
    /// Array fast path when no observable iterator operation is bypassed.
    /// Every other input routes to [`Self::populate_collection_from_iterable`].
    fn populate_collection_from_dense_array(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        iterable: Slot,
    ) -> Result<(), Step> {
        let array = match iterable.value {
            Payload::Reference(array) if self.arrays.contains_key(&array) => array,
            _ => return self.populate_collection_from_iterable(code, inst, iterable),
        };
        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .expect("well-known iterator symbol");
        let kind = self.collections[&inst].kind;
        let next_id = self.intern_key("next");
        let return_id = self.intern_key("return");
        if !self.chain_resolves_native_data_method(array, iterator_id, NativeMethod::ArrayValues)
            || !self.chain_resolves_native_data_method(
                self.array_iterator_proto,
                next_id,
                NativeMethod::ArrayIteratorNext,
            )
            || self.chain_has_descriptor(self.array_iterator_proto, return_id)
        {
            return self.populate_collection_from_iterable(code, inst, iterable);
        }
        let method_name = if matches!(kind, CollKind::Map | CollKind::WeakMap) {
            "set"
        } else {
            "add"
        };
        let method_id = self.intern_key(method_name);
        let receiver = Slot::of(Kind::Reference, Payload::Reference(inst));
        let expected = match kind {
            CollKind::Map => NativeMethod::MapSet,
            CollKind::Set => NativeMethod::SetAdd,
            CollKind::WeakMap => NativeMethod::WeakMapSet,
            CollKind::WeakSet => NativeMethod::WeakSetAdd,
        };
        let mut adder = self.ordinary_get(code, inst, method_id, receiver)?;
        // Intrinsics are linked sparsely by program atom. The constructor's
        // implicit Get(adder) still sees the boot method when source never
        // spells its name, so recover that already-allocated method identity.
        //
        // The gate is genuine property ABSENCE, not `method_was_linked`: a prior
        // collection constructed in the same program `intern_key`s the adder
        // name (below), so by the second `new Set([...])` the name is in
        // `symbol_ids` yet the `add` property is still unbound on the prototype
        // (binding happens once at link time). Keying recovery on the interned
        // name therefore mis-fired for every collection past the first, throwing
        // a spurious TypeError. Recover when the adder resolved to `undefined`
        // AND no `add`/`set` descriptor exists anywhere on the receiver's chain
        // (a truly unbound intrinsic); a user who cleared `add` to `undefined`
        // leaves a descriptor, so that case still throws per specification.
        if adder.kind == Kind::Undefined && !self.chain_has_descriptor(inst, method_id) {
            if let Some((&function, _)) = self
                .functions
                .iter()
                .find(|(_, info)| info.method == Some(expected))
            {
                adder = Slot::of(Kind::Reference, Payload::Reference(function));
            }
        }
        if !self.is_callable_value(adder) {
            return Err(
                self.catchable_type_error_msg(format!("result.{method_name}: not a function"))
            );
        }
        let intrinsic_adder = match adder.value {
            Payload::Reference(function) => self.method_of(function) == Some(expected),
            _ => false,
        };
        if !intrinsic_adder {
            return self.populate_collection_from_iterable_with_adder(
                code,
                inst,
                iterable,
                Some(adder),
            );
        }
        let (dense, entries_are_dense_pairs) = {
            let data = &self.arrays[&array];
            let dense = data.items().len() == data.length as usize;
            let entries_are_dense_pairs = !matches!(kind, CollKind::Map | CollKind::WeakMap)
                || data.items().values().all(|element| {
                    matches!(element, Slot {
                        kind: Kind::Reference,
                        value: Payload::Reference(entry),
                        ..
                    }
                        if self.arrays.get(&entry).is_some_and(|entry_data| {
                            entry_data.length >= 2
                                && entry_data.items().contains_key(&0)
                                && entry_data.items().contains_key(&1)
                        }))
                });
            (dense, entries_are_dense_pairs)
        };
        if !dense || !entries_are_dense_pairs {
            return self.populate_collection_from_iterable_with_adder(
                code,
                inst,
                iterable,
                Some(adder),
            );
        }
        // Snapshotting is safe only after the observable adder lookup proved
        // that it resolves to the intrinsic. A custom getter or adder can
        // mutate the iterable and must take the live iterator path above.
        let data = &self.arrays[&array];
        let elements: Vec<Slot> = (0..data.length).map(|index| data.items()[&index]).collect();
        for element in elements {
            let (key, value) = if matches!(kind, CollKind::Map | CollKind::WeakMap) {
                let entry = match element.value {
                    Payload::Reference(entry) => entry,
                    _ => unreachable!("dense Map entries were checked before iteration"),
                };
                let entry_data = &self.arrays[&entry];
                (entry_data.items()[&0], entry_data.items()[&1])
            } else {
                (element, Slot::undefined())
            };
            let key = self.normalize_coll_key(key);
            if matches!(kind, CollKind::WeakMap | CollKind::WeakSet) && key.kind != Kind::Reference
            {
                if key.kind == Kind::Symbol {
                    return Err(Step::Host(Halt::Refused(
                        "collection-constructor:weak-symbol-oracle-version",
                    )));
                }
                return Err(self.catchable_type_error_msg(
                    if kind == CollKind::WeakMap {
                        "key: not an object"
                    } else {
                        "value: not an object"
                    }
                    .into(),
                ));
            }
            if let Some(position) = self.collection_find(inst, &key) {
                if matches!(kind, CollKind::Map | CollKind::WeakMap) {
                    self.collections.get_mut(&inst).unwrap().set_entry_value(
                        position,
                        value,
                        &mut self.side_refs,
                    );
                }
            } else {
                let slots = match kind {
                    CollKind::Map | CollKind::WeakMap | CollKind::WeakSet => 3,
                    CollKind::Set => 2,
                };
                self.charge_new_entry_slots(slots);
                self.collections.get_mut(&inst).unwrap().push_entry(
                    key,
                    value,
                    &mut self.side_refs,
                );
                self.collection_table_resize(inst);
            }
        }
        Ok(())
    }

    /// `AddEntriesFromIterable` for Map/WeakMap and the corresponding Set/
    /// WeakSet constructor loop. The adder is read before the iterator method;
    /// iterator advancement failures propagate directly, while every abrupt
    /// completion after a value is yielded closes the iterator.
    fn populate_collection_from_iterable(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        iterable: Slot,
    ) -> Result<(), Step> {
        self.populate_collection_from_iterable_with_adder(code, inst, iterable, None)
    }

    fn populate_collection_from_iterable_with_adder(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        iterable: Slot,
        adder: Option<Slot>,
    ) -> Result<(), Step> {
        let outcome = self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            machine.populate_collection_from_iterable_inner(code, inst, iterable, adder)
        });
        match outcome {
            Ok(Ok(())) => Ok(()),
            Ok(Err(error)) => Err(self.raise_js(error)),
            Err(halt) => Err(halt),
        }
    }

    fn populate_collection_from_iterable_inner(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        iterable: Slot,
        prefetched_adder: Option<Slot>,
    ) -> Result<Result<(), Slot>, Step> {
        let kind = self.collections[&inst].kind;
        let is_map = matches!(kind, CollKind::Map | CollKind::WeakMap);
        let method_name = if is_map { "set" } else { "add" };
        let expected = match kind {
            CollKind::Map => NativeMethod::MapSet,
            CollKind::Set => NativeMethod::SetAdd,
            CollKind::WeakMap => NativeMethod::WeakMapSet,
            CollKind::WeakSet => NativeMethod::WeakSetAdd,
        };
        let method_id = self.intern_key(method_name);
        let receiver = Slot::of(Kind::Reference, Payload::Reference(inst));
        let mut adder = match prefetched_adder {
            Some(adder) => adder,
            None => match self
                .array_from_try(|this| this.ordinary_get(code, inst, method_id, receiver))?
            {
                Ok(adder) => adder,
                Err(error) => return Ok(Err(error)),
            },
        };
        // Sparse intrinsic installation means an implicitly used `add`/`set`
        // can be absent from the prototype until this constructor reaches it.
        // Recover only genuine absence; an explicit guest `undefined` remains
        // observable and fails the callable check.
        if adder.kind == Kind::Undefined && !self.chain_has_descriptor(inst, method_id) {
            if let Some((&function, _)) = self
                .functions
                .iter()
                .find(|(_, info)| info.method == Some(expected))
            {
                adder = Slot::of(Kind::Reference, Payload::Reference(function));
            }
        }
        if !self.is_callable_value(adder) {
            return Ok(Err(self.internal_error(
                "TypeError",
                format!("result.{method_name}: not a function"),
            )));
        }

        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .expect("well-known iterator symbol");
        let iterator_method = match iterable.value {
            Payload::Reference(object) if iterable.kind == Kind::Reference => {
                match self
                    .array_from_try(|this| this.mop_get(code, object, iterator_id, iterable))?
                {
                    Ok(method) => method,
                    Err(error) => return Ok(Err(error)),
                }
            }
            _ => {
                let proto = match iterable.kind {
                    Kind::String => self.string_proto,
                    Kind::Integer | Kind::Number => self.number_proto,
                    Kind::Symbol => self.symbol_proto,
                    Kind::BigInt => self.bigint_proto,
                    Kind::Boolean => self
                        .intrinsics
                        .get("Boolean")
                        .and_then(|&constructor| self.ctor_prototype.get(&constructor).copied())
                        .unwrap_or(crate::value::SlotIndex::NULL),
                    _ => crate::value::SlotIndex::NULL,
                };
                if proto.is_null() {
                    Slot::undefined()
                } else {
                    match self
                        .array_from_try(|this| this.mop_get(code, proto, iterator_id, iterable))?
                    {
                        Ok(method) => method,
                        Err(error) => return Ok(Err(error)),
                    }
                }
            }
        };
        if !self.is_callable_value(iterator_method) {
            return Ok(Err(
                self.internal_error("TypeError", "call: not a function".into())
            ));
        }
        let iterator = match self
            .array_from_try(|this| this.call_any(code, iterator_method, iterable, &[]))?
        {
            Ok(iterator) => iterator,
            Err(error) => return Ok(Err(error)),
        };
        let iterator_inst = match iterator.value {
            Payload::Reference(iterator_inst) if iterator.kind == Kind::Reference => iterator_inst,
            _ => {
                return Ok(Err(
                    self.internal_error("TypeError", "iterator: not an object".into())
                ))
            }
        };
        let next_id = self.intern_key("next");
        let next = match self
            .array_from_try(|this| this.mop_get(code, iterator_inst, next_id, iterator))?
        {
            Ok(next) if self.is_callable_value(next) => next,
            Ok(_) => {
                return Ok(Err(
                    self.internal_error("TypeError", "call: not a function".into())
                ))
            }
            Err(error) => return Ok(Err(error)),
        };
        let done_id = self.intern_key("done");
        let value_id = self.intern_key("value");

        for _ in 0..1_000_000u64 {
            let step = match self.array_from_try(|this| this.call_any(code, next, iterator, &[]))? {
                Ok(step) => step,
                Err(error) => return Ok(Err(error)),
            };
            let step_inst = match step.value {
                Payload::Reference(step_inst) if step.kind == Kind::Reference => step_inst,
                _ => {
                    return Ok(Err(self.internal_error(
                        "TypeError",
                        "iterator result: not an object".into(),
                    )))
                }
            };
            let done =
                match self.array_from_try(|this| this.mop_get(code, step_inst, done_id, step))? {
                    Ok(done) => done,
                    Err(error) => return Ok(Err(error)),
                };
            if self.truthy(&done) {
                return Ok(Ok(()));
            }
            let element =
                match self.array_from_try(|this| this.mop_get(code, step_inst, value_id, step))? {
                    Ok(element) => element,
                    Err(error) => return Ok(Err(error)),
                };
            let args = if is_map {
                let entry = match element.value {
                    Payload::Reference(entry) if element.kind == Kind::Reference => entry,
                    _ => {
                        let error = self.internal_error("TypeError", "item: not an object".into());
                        return Ok(Err(self.array_from_close(code, iterator, error)?));
                    }
                };
                let key_id = self.intern_key("0");
                let key =
                    match self.array_from_try(|this| this.mop_get(code, entry, key_id, element))? {
                        Ok(key) => key,
                        Err(error) => {
                            return Ok(Err(self.array_from_close(code, iterator, error)?));
                        }
                    };
                let value_id = self.intern_key("1");
                let value = match self
                    .array_from_try(|this| this.mop_get(code, entry, value_id, element))?
                {
                    Ok(value) => value,
                    Err(error) => {
                        return Ok(Err(self.array_from_close(code, iterator, error)?));
                    }
                };
                vec![key, value]
            } else {
                vec![element]
            };
            match self.array_from_try(|this| this.call_any(code, adder, receiver, &args))? {
                Ok(_) => {}
                Err(error) => {
                    return Ok(Err(self.array_from_close(code, iterator, error)?));
                }
            }
        }
        Err(Step::Host(Halt::StepLimit(self.n_dispatched)))
    }

    /// Dispatch a `Math.*` static (`xsMath.c`). Reads the positional
    /// arguments off the call frame (`stack[base + 4 + i]`), coerces each to a
    /// number (`fxToNumber`, including observable object-to-primitive
    /// conversion, complete string-number parsing, and catchable Symbol/BigInt
    /// errors), and
    /// meters the single native host frame ([`MATH_FRAME_METERING`]). No
    /// `mxMeterSome` and no chunk — the pin's bodies carry neither. A NaN
    /// result is the canonical `f64::NAN`.
    ///
    /// Provider-sensitive operations currently use platform `f64` math.
    /// Cross-platform bit identity is not established by same-host oracle
    /// agreement: a last-bit difference can affect guest branches and receipts.
    /// `math_determinism.rs` checks known answers and exports platform vectors.
    /// The decision to vendor libm and its required coverage are recorded in
    /// `designs/ironhorse-w6-decisions.md`, section 4.
    fn call_math(
        &mut self,
        id: MathId,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        use MathId::*;
        self.meter.tick_raw(MATH_FRAME_METERING);
        let r = match id {
            Abs => self.math_unary(code, base, argc, f64::abs)?,
            Acos => self.math_unary(code, base, argc, f64::acos)?,
            Acosh => self.math_unary(code, base, argc, f64::acosh)?,
            Asin => self.math_unary(code, base, argc, f64::asin)?,
            Asinh => self.math_unary(code, base, argc, f64::asinh)?,
            Atan => self.math_unary(code, base, argc, f64::atan)?,
            Atanh => self.math_unary(code, base, argc, f64::atanh)?,
            Cbrt => self.math_unary(code, base, argc, f64::cbrt)?,
            Ceil => self.math_unary(code, base, argc, f64::ceil)?,
            Cos => self.math_unary(code, base, argc, f64::cos)?,
            Cosh => self.math_unary(code, base, argc, f64::cosh)?,
            Exp => self.math_unary(code, base, argc, f64::exp)?,
            Expm1 => self.math_unary(code, base, argc, f64::exp_m1)?,
            Floor => self.math_unary(code, base, argc, f64::floor)?,
            Log => self.math_unary(code, base, argc, f64::ln)?,
            Log1p => self.math_unary(code, base, argc, f64::ln_1p)?,
            Log10 => self.math_unary(code, base, argc, f64::log10)?,
            // The pin computes `log2` as `c_log(x) / c_log(2)` only under
            // `mxNoFunctionLength`-style configs it does not enable here; the
            // default build calls `c_log2`, so ironhorse uses `f64::log2`.
            Log2 => self.math_unary(code, base, argc, f64::log2)?,
            Sin => self.math_unary(code, base, argc, f64::sin)?,
            Sinh => self.math_unary(code, base, argc, f64::sinh)?,
            Sqrt => self.math_unary(code, base, argc, f64::sqrt)?,
            Tan => self.math_unary(code, base, argc, f64::tan)?,
            Tanh => self.math_unary(code, base, argc, f64::tanh)?,
            Atan2 => match (self.math_arg(base, argc, 0), self.math_arg(base, argc, 1)) {
                (Some(y), Some(x)) => {
                    let y = self.to_number_f64(code, y)?;
                    let x = self.to_number_f64(code, x)?;
                    Slot::number(y.atan2(x))
                }
                _ => Slot::number(f64::NAN),
            },
            // `fx_Math_pow` → `fx_pow`: `(±1) ** ±Infinity` is NaN (the pin's
            // explicit special-case), otherwise `c_pow`.
            Pow => match (self.math_arg(base, argc, 0), self.math_arg(base, argc, 1)) {
                (Some(x), Some(y)) => {
                    let x = self.to_number_f64(code, x)?;
                    let y = self.to_number_f64(code, y)?;
                    let v = if !y.is_finite() && x.abs() == 1.0 {
                        f64::NAN
                    } else {
                        x.powf(y)
                    };
                    Slot::number(v)
                }
                _ => Slot::number(f64::NAN),
            },
            // `fx_Math_hypot`: no arg → 0; XS special-cases the 2-argument
            // `c_hypot`, else sums the squares and takes the sqrt.
            Hypot => {
                let mut vals = self.reserve_scratch(argc)?;
                for i in 0..argc {
                    let value = self.math_arg(base, argc, i).unwrap();
                    vals.push(self.to_number_f64(code, value)?);
                }
                let v = match vals.len() {
                    0 => 0.0,
                    2 => vals[0].hypot(vals[1]),
                    _ => vals.iter().map(|x| x * x).sum::<f64>().sqrt(),
                };
                Slot::number(v)
            }
            // `fx_Math_sign`: NaN→NaN, <0→-1, >0→1, else the argument (±0),
            // then `fx_Math_toInteger` folds an exact integer to integer kind.
            Sign => match self.math_arg(base, argc, 0) {
                None => Slot::number(f64::NAN),
                Some(s) => {
                    let a = self.to_number_f64(code, s)?;
                    let r = if a.is_nan() {
                        f64::NAN
                    } else if a < 0.0 {
                        -1.0
                    } else if a > 0.0 {
                        1.0
                    } else {
                        a
                    };
                    math_to_integer(r)
                }
            },
            // `fx_Math_round`: an integer argument passes through; otherwise
            // XS rounds half-up (`floor(x + 0.5)`) inside the ±(2^52-1) normal
            // window, with the ±0 corners, then folds to integer kind.
            Round => match self.math_arg(base, argc, 0) {
                None => Slot::number(f64::NAN),
                Some(s) if s.kind == Kind::Integer => s,
                Some(s) => {
                    let mut a = self.to_number_f64(code, s)?;
                    if a.is_normal() && (-4503599627370495.0 < a) && (a < 4503599627370495.0) {
                        if a < -0.5 || 0.5 <= a {
                            a = (a + 0.5).floor();
                        } else if a < 0.0 {
                            a = -0.0;
                        } else if a > 0.0 {
                            a = 0.0;
                        }
                    }
                    math_to_integer(a)
                }
            },
            // `fx_Math_trunc`: `c_trunc`, then fold to integer kind.
            Trunc => match self.math_arg(base, argc, 0) {
                None => Slot::number(f64::NAN),
                Some(s) => math_to_integer(self.to_number_f64(code, s)?.trunc()),
            },
            // `fx_Math_fround`: an integer passes through; otherwise round to
            // the nearest `f32` and widen back.
            Fround => match self.math_arg(base, argc, 0) {
                None => Slot::number(f64::NAN),
                Some(s) if s.kind == Kind::Integer => s,
                Some(s) => Slot::number(self.to_number_f64(code, s)? as f32 as f64),
            },
            // `fx_Math_clz32`: count leading zeros of ToUint32(arg); 32 for 0.
            Clz32 => {
                let x = match self.math_arg(base, argc, 0) {
                    None => 0u32,
                    Some(s) => to_int32(self.to_number_f64(code, s)?) as u32,
                };
                Slot::integer(x.leading_zeros() as i32)
            }
            // `fx_Math_imul`: (ToInt32(a) * ToInt32(b)) as a 32-bit product.
            Imul => {
                let a = match self.math_arg(base, argc, 0) {
                    Some(value) => to_int32(self.to_number_f64(code, value)?),
                    None => 0,
                };
                let b = match self.math_arg(base, argc, 1) {
                    Some(value) => to_int32(self.to_number_f64(code, value)?),
                    None => 0,
                };
                Slot::integer(a.wrapping_mul(b))
            }
            Max => self.math_extremum(code, argc, base, true)?,
            Min => self.math_extremum(code, argc, base, false)?,
        };
        Ok(r)
    }

    /// Copy one positional Math argument out of the native call frame.
    fn math_arg(&self, base: usize, argc: usize, index: usize) -> Option<Slot> {
        (index < argc).then(|| {
            self.stack
                .get(base + 4 + index)
                .copied()
                .unwrap_or_else(Slot::undefined)
        })
    }

    /// A one-argument Math operation, including the no-argument NaN case and
    /// the shared observable ToNumber conversion.
    fn math_unary(
        &mut self,
        code: &[u8],
        base: usize,
        argc: usize,
        operation: fn(f64) -> f64,
    ) -> Result<Slot, Step> {
        match self.math_arg(base, argc, 0) {
            None => Ok(Slot::number(f64::NAN)),
            Some(value) => Ok(Slot::number(operation(self.to_number_f64(code, value)?))),
        }
    }

    /// `fx_Math_max`/`fx_Math_min`: the running extremum over the arguments,
    /// preserving XS's integer-kind fast path (an all-integer argument list
    /// stays integer) and its ±0 tie-break (`max(+0,-0)===+0`,
    /// `min(+0,-0)===-0`), with a NaN argument poisoning the result (after
    /// still coercing the remaining arguments, so a later abrupt completion
    /// takes precedence). `max` seeds `-Infinity`, `min` seeds `+Infinity`.
    fn math_extremum(
        &mut self,
        code: &[u8],
        argc: usize,
        base: usize,
        is_max: bool,
    ) -> Result<Slot, Step> {
        if argc == 0 {
            return Ok(Slot::number(if is_max {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            }));
        }
        // Integer fast path while every argument seen so far is an integer.
        let first = self.math_arg(base, argc, 0).unwrap();
        let mut int_acc: Option<i32> = if first.kind == Kind::Integer {
            match first.value {
                Payload::Integer(v) => Some(v),
                _ => None,
            }
        } else {
            None
        };
        let mut acc: f64 = if is_max {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
        let start = if int_acc.is_some() { 1 } else { 0 };
        let mut saw_nan = false;
        for i in start..argc {
            let s = self.math_arg(base, argc, i).unwrap();
            if let Some(iv) = int_acc {
                if s.kind == Kind::Integer {
                    if let Payload::Integer(v) = s.value {
                        int_acc = Some(if is_max { iv.max(v) } else { iv.min(v) });
                        continue;
                    }
                }
                // Leaving the integer path: seed the float accumulator.
                acc = iv as f64;
                int_acc = None;
            }
            let n = self.to_number_f64(code, s)?;
            if n.is_nan() {
                // Math.max/min still ToNumber-coerce every later argument, so
                // a subsequent abrupt completion must outrank the NaN result.
                saw_nan = true;
                continue;
            }
            if is_max {
                if acc < n {
                    acc = n;
                } else if acc == 0.0 && n == 0.0 && acc.is_sign_negative() && n.is_sign_positive() {
                    acc = 0.0;
                }
            } else if acc > n {
                acc = n;
            } else if acc == 0.0 && n == 0.0 && acc.is_sign_positive() && n.is_sign_negative() {
                acc = -0.0;
            }
        }
        Ok(if saw_nan {
            Slot::number(f64::NAN)
        } else {
            match int_acc {
                Some(v) => Slot::integer(v),
                None => Slot::number(acc),
            }
        })
    }

    /// XS `fxToInteger` uses distinct diagnostics and wraps to signed 32 bits.
    fn number_radix_integer(&mut self, code: &[u8], value: Slot) -> Result<i32, Step> {
        let value = self.to_primitive(code, value, false)?;
        if value.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to integer".into()));
        }
        if value.kind == Kind::BigInt {
            return Err(self.catchable_type_error_msg("cannot coerce to integer".into()));
        }
        Ok(to_int32(self.to_number_f64(code, value)?))
    }

    /// Dispatch a `Number` static / `Number.prototype.toString` / numeric
    /// global (`parseInt`/`parseFloat`/`isNaN`/`isFinite`). The `xsNumber.c`
    /// bodies carry no `mxMeterSome`; `toString` allocates its result chunk,
    /// the rest return a number/boolean (no chunk). A NaN result is the
    /// canonical `f64::NAN`.
    fn call_number(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let arg0 = if argc > 0 {
            Some(
                self.stack
                    .get(base + 4)
                    .copied()
                    .unwrap_or_else(Slot::undefined),
            )
        } else {
            None
        };
        use NativeMethod::*;
        // The kind-inspecting predicates (no coercion).
        let predicate = |s: Option<Slot>, kind: NativeMethod| -> bool {
            let s = match s {
                Some(s) => s,
                None => return false,
            };
            match s.kind {
                Kind::Integer => !matches!(kind, NumberIsNaN),
                Kind::Number => {
                    let n = to_number(&s);
                    match kind {
                        NumberIsNaN => n.is_nan(),
                        NumberIsFinite => n.is_finite(),
                        NumberIsInteger => n.is_finite() && n.trunc() == n,
                        NumberIsSafeInteger => {
                            n.is_finite()
                                && n.trunc() == n
                                && (-9007199254740991.0..=9007199254740991.0).contains(&n)
                        }
                        _ => false,
                    }
                }
                _ => false,
            }
        };
        self.meter.tick_raw(NUMBER_FRAME_METERING);
        let result = match m {
            NumberIsFinite | NumberIsInteger | NumberIsNaN | NumberIsSafeInteger => {
                Slot::boolean(predicate(arg0, m))
            }
            NumberToLocaleString => {
                let prim = match this.value {
                    Payload::Integer(_) | Payload::Number(_) => this,
                    Payload::Reference(r) => match self.wrapper_data.get(&r).copied() {
                        Some(s) if matches!(s.value, Payload::Integer(_) | Payload::Number(_)) => s,
                        _ => return Err(self.catchable_type_error_msg("this: not a number".into())),
                    },
                    _ => return Err(self.catchable_type_error_msg("this: not a number".into())),
                };
                let locale = arg0.unwrap_or_else(Slot::undefined);
                let options = if argc > 1 {
                    self.stack
                        .get(base + 5)
                        .copied()
                        .unwrap_or_else(Slot::undefined)
                } else {
                    Slot::undefined()
                };
                let data = self.build_number_format(code, locale, options)?;
                let resolved = self.nf_resolved(&data);
                let rendered = crate::intl_number::format_to_string(&resolved, to_number(&prim));
                self.intl_string(&rendered)
            }
            // Number.prototype.toString([radix]) — radix 10 renders through the
            // metered `fxNumberToString`; a radix in [2,36] runs the digit
            // conversion. The non-decimal path covers the finite integral
            // domain plus the three non-finite/zero spellings; a fractional
            // finite value keeps an honest named skip until its shortest-round-
            // trip digit generation is modeled.
            NumberToString => {
                let prim = match this.value {
                    Payload::Integer(_) | Payload::Number(_) => this,
                    Payload::Reference(r) => match self.wrapper_data.get(&r).copied() {
                        Some(s) if matches!(s.value, Payload::Integer(_) | Payload::Number(_)) => s,
                        _ => return Err(self.catchable_type_error_msg("this: not a number".into())),
                    },
                    _ => return Err(self.catchable_type_error_msg("this: not a number".into())),
                };
                let radix = match arg0 {
                    Some(s) if s.kind != Kind::Undefined => {
                        let r = self.number_radix_integer(code, s)? as f64;
                        if !(2.0..=36.0).contains(&r) {
                            return Err(self.catchable_range_error_msg("invalid radix".into()));
                        }
                        r as u32
                    }
                    _ => 10,
                };
                if radix == 10 {
                    // `fx_Number_prototype_toString` routes radix-10 through
                    // `fxToString`/`fxNumberToString`, which carries the same
                    // fixed 33280-raw host residual as the `mxMeterSome`-path
                    // built-ins (measured against the pin) beyond the metered
                    // `fxNumberToString` step + result chunk.
                    self.meter.tick_raw(STRING_METERSOME_FRAME_METERING);
                    let bytes = self.to_string_bytes_metered(prim);
                    let off = self.alloc_str_text(&bytes);
                    Slot::of(Kind::String, Payload::String(off))
                } else {
                    let n = to_number(&prim);
                    let bytes = match number_to_radix_string(n, radix) {
                        Some(bytes) => bytes,
                        None => {
                            return Err(Step::Host(Halt::NotImplemented(
                                "Number.toString:fractional-non-decimal-radix",
                            )));
                        }
                    };
                    self.meter.tick_builtin();
                    let off = self.alloc_str_text_metered(&bytes)?;
                    Slot::of(Kind::String, Payload::String(off))
                }
            }
            // parseInt(string[,radix]) — ToString followed by the integer
            // prefix parse.
            GlobalParseInt => {
                let units = self.to_string_units(code, arg0.unwrap_or_else(Slot::undefined))?;
                let bytes = String::from_utf16_lossy(&units).into_bytes();
                let radix_arg = self.stack.get(base + 5).copied();
                let radix = match radix_arg {
                    Some(s) if argc > 1 && s.kind != Kind::Undefined => {
                        let r = self.number_radix_integer(code, s)? as f64;
                        if r != 0.0 && !(2.0..=36.0).contains(&r) {
                            return Ok(Slot::number(f64::NAN));
                        }
                        r as i32
                    }
                    _ => 0,
                };
                parse_int(&bytes, radix)
            }
            // parseFloat(string) — ToString followed by the float prefix parse
            // (`fxStringToNumber`, whole = 0).
            GlobalParseFloat => {
                let units = self.to_string_units(code, arg0.unwrap_or_else(Slot::undefined))?;
                let bytes = String::from_utf16_lossy(&units).into_bytes();
                Slot::number(string_to_number(&bytes, false))
            }
            // isNaN(x)/isFinite(x) — ToNumber then the fpclassify test. A
            // string routes through the whole-string parse; objects use the
            // shared re-entrant ToPrimitive/ToNumber machinery.
            GlobalIsNaN | GlobalIsFinite => {
                let n = match arg0 {
                    None => f64::NAN,
                    Some(s) => self.to_number_f64(code, s)?,
                };
                Slot::boolean(if m == GlobalIsNaN {
                    n.is_nan()
                } else {
                    n.is_finite()
                })
            }
            _ => return Err(Step::Host(Halt::NotImplemented("number:unmodeled"))),
        };
        Ok(result)
    }

    /// The UTF-16 code units of a string receiver, for a primitive string or a
    /// boxed `String` wrapper. Returns `None` for other receivers;
    /// `string_this_units` rejects nullish receivers and performs observable
    /// ToString conversion for the others.
    fn string_receiver_units(&self, this: Slot) -> Option<Vec<u16>> {
        self.string_receiver_offset(this)
            .map(|off| self.str_units(off))
    }

    /// Retain an immutable string's arena address rather than materializing it.
    /// Primitive and boxed-string receivers follow the same branding path as
    /// `string_receiver_units`; other receivers still use its ToString path.
    fn string_receiver_offset(&self, this: Slot) -> Option<crate::value::ChunkOffset> {
        match this.value {
            Payload::String(off) => Some(off),
            Payload::Reference(r) => match self.wrapper_data.get(&r).map(|s| s.value) {
                Some(Payload::String(off)) => Some(off),
                _ => None,
            },
            _ => None,
        }
    }

    /// Allocate a fresh String slot from **UTF-8 text** `bytes`, decoding them
    /// to UTF-16 code units and storing them as UTF-16BE. Metered by code-unit
    /// length (`n_units + 1`, the re-based O(n) string-op weight; for ASCII
    /// text this equals the old CESU-8 `len + 1`, so ASCII results meter
    /// identically). An empty result reuses the interned empty string (no
    /// chunk), exactly as XS returns `mxEmptyString`.
    fn new_string_metered(&mut self, bytes: &[u8]) -> Slot {
        let units: Vec<u16> = String::from_utf8_lossy(bytes).encode_utf16().collect();
        self.new_string_units(&units)
    }

    /// Allocate a fresh String slot from UTF-16 code `units` (the direct
    /// storage form — used where the result is a code-unit slice of an existing
    /// string, so lone surrogates survive without a lossy text round-trip).
    /// Metered by code-unit length (`n_units + 1`); an empty result is the
    /// interned empty string (no metered chunk).
    fn new_string_units(&mut self, units: &[u16]) -> Slot {
        if units.is_empty() {
            // XS's `mxEmptyString` — an interned "", no metered fxNewChunk.
            let off = self.chunks.alloc(&[]);
            return Slot::of(Kind::String, Payload::String(off));
        }
        self.meter.tick_string(units.len() as u64);
        let off = self.chunks.alloc(&units_to_be16(units));
        Slot::of(Kind::String, Payload::String(off))
    }

    /// ECMAScript `ToString`, retaining UTF-16 code units when the primitive
    /// already is a String (so lone surrogates never pass through Rust's
    /// scalar-value `String`). Objects use the shared, re-entrant
    /// `ToPrimitive` machinery; null and undefined are allowed here because
    /// this helper is also used for ordinary arguments.
    fn to_string_units(&mut self, code: &[u8], value: Slot) -> Result<Vec<u16>, Step> {
        let primitive = if value.kind == Kind::Reference {
            self.to_primitive(code, value, true)?
        } else {
            value
        };
        if primitive.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to string".into()));
        }
        if let Payload::String(off) = primitive.value {
            return Ok(self.str_units(off));
        }
        let bytes = self.to_string_bytes_metered(primitive);
        Ok(String::from_utf8_lossy(&bytes).encode_utf16().collect())
    }

    /// ECMAScript `ToString`, retaining the resulting primitive as a String
    /// slot so callers can pass it to user code without a lossy text roundtrip.
    fn to_string_slot(&mut self, code: &[u8], value: Slot) -> Result<Slot, Step> {
        let primitive = if value.kind == Kind::Reference {
            self.to_primitive(code, value, true)?
        } else {
            value
        };
        if primitive.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to string".into()));
        }
        Ok(self.to_string_slot_metered(primitive))
    }

    /// `RequireObjectCoercible(this)` followed by `ToString(this)` for the
    /// generic String prototype algorithms.
    fn string_this_units(&mut self, code: &[u8], this: Slot) -> Result<Vec<u16>, Step> {
        if this.kind == Kind::Undefined {
            return Err(self.catchable_type_error_msg("this: undefined".into()));
        }
        if this.kind == Kind::Null {
            return Err(self.catchable_type_error_msg("this: null".into()));
        }
        if let Some(units) = self.string_receiver_units(this) {
            return Ok(units);
        }
        self.to_string_units(code, this)
    }

    /// Raise an XS RangeError diagnostic through the guest jump chain.
    fn catchable_range_error_msg(&mut self, message: String) -> Step {
        let error = self.internal_error("RangeError", message);
        self.raise_js(error)
    }

    fn catchable_range_error(&mut self) -> Step {
        let error = self.build_error("RangeError", 0, 0);
        self.raise_js(error)
    }

    /// String constructor statics. Both consume numeric arguments through
    /// the shared `ToNumber` path, preserving the observable left-to-right
    /// coercion order.
    fn call_string_static(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        if self
            .stack
            .get(base)
            .is_some_and(|this| this.kind == Kind::Uninitialized)
        {
            return Err(self.catchable_type_error_msg("new: not a constructor".into()));
        }
        let mut out = self.reserve_scratch(argc.saturating_mul(2))?;
        for i in 0..argc {
            let value = self
                .stack
                .get(base + 4 + i)
                .copied()
                .unwrap_or_else(Slot::undefined);
            let n = self.to_number_f64(code, value)?;
            match m {
                NativeMethod::StringFromCharCode => {
                    let integer = if !n.is_finite() || n == 0.0 {
                        0i64
                    } else {
                        n.trunc() as i64
                    };
                    out.push(integer.rem_euclid(0x1_0000) as u16);
                }
                NativeMethod::StringFromCodePoint => {
                    if !n.is_finite() || n.fract() != 0.0 || !(0.0..=0x10_FFFF as f64).contains(&n)
                    {
                        let number = if n.is_nan() {
                            "nan".into()
                        } else {
                            format!("{n:.6}")
                        };
                        // xsAPI.c fxThrowMessage uses a 128-byte C buffer.
                        // This diagnostic is ASCII, so byte truncation is exact.
                        let mut message = format!("invalid code point {number}");
                        message.truncate(127);
                        return Err(self.catchable_range_error_msg(message));
                    }
                    let cp = n as u32;
                    if cp <= 0xFFFF {
                        out.push(cp as u16);
                    } else {
                        let x = cp - 0x10000;
                        out.push(0xD800 + (x >> 10) as u16);
                        out.push(0xDC00 + (x & 0x3FF) as u16);
                    }
                }
                _ => unreachable!(),
            }
        }
        Ok(self.new_string_units(&out))
    }

    /// `String.raw(template, ...substitutions)`: convert `template` and its
    /// live `raw` property to objects, obtain the array-like length through
    /// `ToLength`, then interleave each observable literal segment with the
    /// corresponding substitution. All string conversion remains in UTF-16
    /// units so lone surrogates survive unchanged.
    fn call_string_raw(&mut self, base: usize, argc: usize, code: &[u8]) -> Result<Slot, Step> {
        if self
            .stack
            .get(base)
            .is_some_and(|this| this.kind == Kind::Uninitialized)
        {
            return Err(self.catchable_type_error_msg("new: not a constructor".into()));
        }
        let template = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let cooked = self.array_to_object(template)?;
        let Payload::Reference(cooked_inst) = cooked.value else {
            unreachable!("ToObject returns an object")
        };
        let raw_id = self.intern_key("raw");
        let raw = self.mop_get(code, cooked_inst, raw_id, cooked)?;
        let raw = self.array_to_object(raw)?;
        let Payload::Reference(raw_inst) = raw.value else {
            unreachable!("ToObject returns an object")
        };
        let length = self.arraylike_length(code, raw_inst, raw)?;
        let literal_segments = self.to_length_value(code, length)?;
        if literal_segments == 0 {
            return Ok(self.new_string_units(&[]));
        }
        const STRING_RAW_SEGMENT_CAP: u64 = 1 << 24;
        if literal_segments > STRING_RAW_SEGMENT_CAP {
            return Err(Step::Host(Halt::Refused("String.raw:oversized-template")));
        }

        let substitutions = argc.saturating_sub(1) as u64;
        let mut out = Vec::new();
        for index in 0..literal_segments {
            let id = self.array_generic_index_id(index);
            let segment = self.mop_get(code, raw_inst, id, raw)?;
            let units = self.to_string_units(code, segment)?;
            self.extend_reserved_units(&mut out, &units)?;
            if index + 1 == literal_segments {
                break;
            }
            if index < substitutions {
                let substitution = self
                    .stack
                    .get(base + 5 + index as usize)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                let units = self.to_string_units(code, substitution)?;
                self.extend_reserved_units(&mut out, &units)?;
            }
        }
        Ok(self.new_reserved_string_units(&out))
    }

    /// `ToIntegerOrInfinity` followed by the relative-index adjustment used by
    /// `String.prototype.slice`. `undefined` selects `default`; negative finite
    /// values count from the end, and infinities clamp to the corresponding
    /// boundary.
    fn string_arg_to_index(
        &mut self,
        code: &[u8],
        arg: Option<Slot>,
        default: i64,
        len: i64,
    ) -> Result<i64, Step> {
        let Some(value) = arg.filter(|value| value.kind != Kind::Undefined) else {
            return Ok(default);
        };
        let integer = self.array_to_integer_or_infinity(code, value)?;
        if integer == f64::NEG_INFINITY {
            return Ok(0);
        }
        if integer < 0.0 {
            return Ok((len as f64 + integer).max(0.0) as i64);
        }
        Ok(integer.min(len as f64) as i64)
    }

    /// `ToIntegerOrInfinity` followed by the absolute-position clamp used by
    /// String indexing/search methods and `substring`.
    fn string_arg_to_position(
        &mut self,
        code: &[u8],
        arg: Option<Slot>,
        default: i64,
        len: i64,
    ) -> Result<i64, Step> {
        let Some(value) = arg.filter(|value| value.kind != Kind::Undefined) else {
            return Ok(default);
        };
        let integer = self.array_to_integer_or_infinity(code, value)?;
        Ok(integer.clamp(0.0, len as f64) as i64)
    }

    /// Dispatch a `String.prototype` method (`xsString.c`) over the primitive
    /// receiver's UTF-16 code units (the stored form — indexing is direct, no
    /// boundary walk). Numeric arguments pass through the shared
    /// `ToIntegerOrInfinity` machinery, including observable `ToPrimitive`
    /// calls and catchable BigInt/Symbol errors. Meters exactly the pin's
    /// `mxMeterSome` + `fxNewChunk` (re-based to code-unit length), plus the
    /// (zero) native frame.
    /// Index-addressed String methods never decode the whole primitive/wrapper
    /// receiver. Reacquire the arena slice for each read, so guest coercions may
    /// allocate without a live ChunkSlice borrow across that re-entry.
    fn call_string_indexed(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        if this.kind == Kind::Undefined {
            return Err(self.catchable_type_error_msg("this: undefined".into()));
        }
        if this.kind == Kind::Null {
            return Err(self.catchable_type_error_msg("this: null".into()));
        }
        let branded = self.string_receiver_offset(this);
        let primitive = if branded.is_none() && this.kind == Kind::Reference {
            self.to_primitive(code, this, true)?
        } else {
            this
        };
        let offset = branded.or(match primitive.value {
            Payload::String(off) => Some(off),
            _ => None,
        });
        let fallback = if offset.is_none() {
            // Non-string primitives need formatting; a string returned by a
            // generic receiver's ToPrimitive retains its offset above too.
            self.to_string_units(code, primitive)?
        } else {
            Vec::new()
        };
        let length = offset.map_or(fallback.len(), |off| self.str_len(off));
        let ulen = length as i64;
        let clamp = |unit: i64| -> usize { unit.clamp(0, ulen) as usize };
        let unit_at = |machine: &Self, index: usize| -> u16 {
            match offset {
                Some(off) => machine
                    .str_unit_at(off, index as u32)
                    .expect("in-range string index"),
                None => fallback[index],
            }
        };
        let args: Vec<Slot> = (0..argc)
            .map(|i| {
                self.stack
                    .get(base + 4 + i)
                    .copied()
                    .unwrap_or_else(Slot::undefined)
            })
            .collect();
        let argn = |i: usize| -> Option<Slot> { args.get(i).copied() };
        self.meter.tick_raw(STRING_METHOD_FRAME_METERING);
        use NativeMethod::*;
        let result = match m {
            // charCodeAt(pos): the UTF-16 code unit at `pos`, else NaN. No
            // chunk, no mxMeterSome.
            StringCharCodeAt => {
                let pos = match argn(0) {
                    Some(s) if s.kind != Kind::Undefined => {
                        let n = self.array_to_integer_or_infinity(code, s)?;
                        if n < 0.0 {
                            return Ok(Slot::number(f64::NAN));
                        }
                        n as i64
                    }
                    _ => 0,
                };
                if pos < ulen {
                    Slot::integer(unit_at(self, pos as usize) as i32)
                } else {
                    Slot::number(f64::NAN)
                }
            }
            // codePointAt(pos): the code point at `pos` (combining a surrogate
            // pair into an astral scalar), else undefined.
            StringCodePointAt => {
                let pos = match argn(0) {
                    Some(s) if s.kind != Kind::Undefined => {
                        self.array_to_integer_or_infinity(code, s)? as i64
                    }
                    _ => 0,
                };
                if pos >= 0 && pos < ulen {
                    let hi = unit_at(self, pos as usize) as u32;
                    let cp = if (0xD800..=0xDBFF).contains(&hi) && pos + 1 < ulen {
                        let lo = unit_at(self, (pos + 1) as usize) as u32;
                        if (0xDC00..=0xDFFF).contains(&lo) {
                            0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                        } else {
                            hi
                        }
                    } else {
                        hi
                    };
                    Slot::integer(cp as i32)
                } else {
                    Slot::undefined()
                }
            }
            // charAt(pos): the one-unit string at `pos`, else "". A negative
            // `pos` fails to the empty string (XS's `goto fail`).
            StringCharAt => {
                let pos = match argn(0) {
                    Some(s) if s.kind != Kind::Undefined => {
                        self.array_to_integer_or_infinity(code, s)? as i64
                    }
                    _ => 0,
                };
                if pos < 0 || pos >= ulen {
                    self.new_string_units(&[])
                } else {
                    self.new_string_units(&[unit_at(self, pos as usize)])
                }
            }
            // at(index): the one-unit string at `index` (negative from the
            // end), else undefined.
            StringAt => {
                let idx = match argn(0) {
                    Some(s) => self.array_to_integer_or_infinity(code, s)? as i64,
                    None => 0,
                };
                let idx = if idx < 0 { idx + ulen } else { idx };
                if idx < 0 || idx >= ulen {
                    Slot::undefined()
                } else {
                    self.new_string_units(&[unit_at(self, idx as usize)])
                }
            }
            // startsWith / endsWith: reject `IsRegExp(searchString)`, then
            // `ToString(searchString)`, then mxMeterSome(searchUnitLen) and a
            // byte compare (no per-byte meter).
            StringStartsWith | StringEndsWith => {
                let search = argn(0).unwrap_or_else(Slot::undefined);
                if self.string_is_regexp(code, search)? {
                    return Err(self.catchable_type_error_msg("future editions".into()));
                }
                let sub = self.to_string_units(code, search)?;
                let sub_units = sub.len() as u64;
                let is_start = m == StringStartsWith;
                // The position argument (code unit), clamped to [0, ulen].
                let pos = if is_start {
                    self.string_arg_to_position(code, argn(1), 0, ulen)?
                } else {
                    self.string_arg_to_position(code, argn(1), ulen, ulen)?
                };
                self.charge_and_check(STRING_METERSOME_FRAME_METERING)?;
                self.charge_builtin_work(sub_units)?;
                let at = clamp(pos);
                let matches = if is_start {
                    length >= at + sub.len()
                        && sub
                            .iter()
                            .enumerate()
                            .all(|(i, &unit)| unit_at(self, at + i) == unit)
                } else {
                    at >= sub.len()
                        && sub
                            .iter()
                            .enumerate()
                            .all(|(i, &unit)| unit_at(self, at - sub.len() + i) == unit)
                };
                Slot::boolean(matches)
            }
            // includes(search[,from]): whether `search` occurs. Charges the
            // fixed search-argument residual; its `includes_aux` scan does NOT
            // meter the per-byte compares (measured against the pin — a
            // distinct host-frame shape from `indexOf`), so the search runs
            // unmetered.
            StringIncludes => {
                let search = argn(0).unwrap_or_else(Slot::undefined);
                if self.string_is_regexp(code, search)? {
                    return Err(self.catchable_type_error_msg("future editions".into()));
                }
                let sub = self.to_string_units(code, search)?;
                let from = self.string_arg_to_position(code, argn(1), 0, ulen)?;
                self.meter.tick_raw(STRING_METERSOME_FRAME_METERING);
                let bfrom = clamp(from).min(length);
                let found = sub.is_empty()
                    || (sub.len() <= length - bfrom
                        && (bfrom..=length - sub.len()).any(|at| {
                            sub.iter()
                                .enumerate()
                                .all(|(i, &unit)| unit_at(self, at + i) == unit)
                        }));
                Slot::boolean(found)
            }
            // indexOf / lastIndexOf: search in UTF-16 code units, after the
            // observable ToString(searchString) and ToIntegerOrInfinity(position)
            // coercions. XS's inner UTF-8 scan meters only the matching prefix
            // at each candidate (one raw tick per CESU-8 leading byte because
            // of the pinned macro-precedence quirk), including a full match;
            // `string_search_match_meter` translates that charge to the VM's
            // UTF-16 storage without losing astral/lone-surrogate behavior.
            StringIndexOf | StringLastIndexOf => {
                let search = self.to_string_units(code, argn(0).unwrap_or_else(Slot::undefined))?;
                let last = m == StringLastIndexOf;
                let position =
                    if last && (argc < 2 || argn(1).is_some_and(|v| v.kind == Kind::Undefined)) {
                        f64::INFINITY
                    } else if argc < 2 {
                        0.0
                    } else if last {
                        // `lastIndexOf` maps *any* NaN position to +INFINITY, not
                        // only a missing or `undefined` one, so it cannot share
                        // `ToIntegerOrInfinity`'s NaN-to-zero rule.
                        self.string_last_index_of_position(
                            code,
                            argn(1).unwrap_or_else(Slot::undefined),
                        )?
                    } else {
                        self.array_to_integer_or_infinity(
                            code,
                            argn(1).unwrap_or_else(Slot::undefined),
                        )?
                    };
                let start = if position == f64::INFINITY {
                    length
                } else if position == f64::NEG_INFINITY || position <= 0.0 {
                    0
                } else if position >= length as f64 {
                    length
                } else {
                    position as usize
                };
                self.meter.tick_raw(STRING_INDEX_FRAME_METERING);

                if search.is_empty() {
                    Self::array_index_number(start as u64)
                } else if search.len() > length {
                    Slot::integer(-1)
                } else if last {
                    let mut candidate = start.min(length - search.len());
                    loop {
                        let mut matched = 0usize;
                        while matched < search.len()
                            && unit_at(self, candidate + matched) == search[matched]
                        {
                            self.charge_and_check(1)?;
                            matched += 1;
                        }
                        if matched == search.len() {
                            break Self::array_index_number(candidate as u64);
                        }
                        if candidate == 0 {
                            break Slot::integer(-1);
                        }
                        candidate -= 1;
                    }
                } else if start + search.len() > length {
                    Slot::integer(-1)
                } else {
                    let limit = length - search.len();
                    let mut candidate = start;
                    loop {
                        let mut matched = 0usize;
                        while matched < search.len()
                            && unit_at(self, candidate + matched) == search[matched]
                        {
                            self.charge_and_check(1)?;
                            matched += 1;
                        }
                        if matched == search.len() {
                            break Self::array_index_number(candidate as u64);
                        }
                        if candidate == limit {
                            break Slot::integer(-1);
                        }
                        candidate += 1;
                    }
                }
            }
            _ => unreachable!("only indexed String methods enter this helper"),
        };
        Ok(result)
    }

    fn call_string(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        if matches!(
            m,
            NativeMethod::StringCharCodeAt
                | NativeMethod::StringCodePointAt
                | NativeMethod::StringCharAt
                | NativeMethod::StringAt
                | NativeMethod::StringStartsWith
                | NativeMethod::StringEndsWith
                | NativeMethod::StringIncludes
                | NativeMethod::StringIndexOf
                | NativeMethod::StringLastIndexOf
        ) {
            return self.call_string_indexed(m, this, base, argc, code);
        }
        let content = self.string_this_units(code, this)?;
        let ulen = content.len() as i64; // UTF-16 code-unit length
                                         // Clamp a (possibly negative / out-of-range) code-unit position to a
                                         // valid slice index into `content` (units). Replaces the CESU-8
                                         // byte-offset lookup — with UTF-16 storage the unit index *is* the
                                         // slice index.
        let clamp = |unit: i64| -> usize {
            if unit <= 0 {
                0
            } else if unit >= ulen {
                content.len()
            } else {
                unit as usize
            }
        };
        let args: Vec<Slot> = (0..argc)
            .map(|i| {
                self.stack
                    .get(base + 4 + i)
                    .copied()
                    .unwrap_or_else(Slot::undefined)
            })
            .collect();
        let argn = |i: usize| -> Option<Slot> { args.get(i).copied() };
        self.meter.tick_raw(STRING_METHOD_FRAME_METERING);
        use NativeMethod::*;
        let result = match m {
            // slice([start[,end]]): the substring `[start,end)` with negative
            // offsets counted from the end.
            StringSlice => {
                let start = self.string_arg_to_index(code, argn(0), 0, ulen)?;
                let end = self.string_arg_to_index(code, argn(1), ulen, ulen)?;
                if start < end {
                    self.new_string_units(&content[clamp(start)..clamp(end)])
                } else {
                    self.new_string_units(&[])
                }
            }
            // substring([start[,end]]): clamp both to `[0,len]`, swap if
            // start>end.
            StringSubstring => {
                let mut start = self.string_arg_to_position(code, argn(0), 0, ulen)?;
                let mut stop = self.string_arg_to_position(code, argn(1), ulen, ulen)?;
                if start > stop {
                    std::mem::swap(&mut start, &mut stop);
                }
                if start < stop {
                    self.new_string_units(&content[clamp(start)..clamp(stop)])
                } else {
                    self.new_string_units(&[])
                }
            }
            // concat(...args): the receiver followed by each stringified
            // argument; mxMeterSome(argc) + the result chunk. Argument
            // `ToString` conversions run left-to-right and may re-enter guest
            // code or throw.
            StringConcat => {
                self.charge_and_check(STRING_METERSOME_FRAME_METERING)?;
                self.charge_builtin_work(argc as u64)?;
                let mut out = Vec::new();
                self.extend_reserved_units(&mut out, &content)?;
                for i in 0..argc {
                    let a = argn(i).unwrap();
                    let units = self.to_string_units(code, a)?;
                    self.extend_reserved_units(&mut out, &units)?;
                }
                self.new_reserved_string_units(&out)
            }
            // repeat(count): the receiver repeated `count` times; a negative or
            // over-large count is a RangeError. mxMeterSome(count) + chunk.
            StringRepeat => {
                let count = match argn(0) {
                    Some(s) if s.kind != Kind::Undefined => {
                        let n = self.array_to_integer_or_infinity(code, s)?;
                        if n < 0.0 {
                            return Err(self.catchable_range_error_msg("count < 0".into()));
                        }
                        if n > 0x7FFF_FFFF as f64 {
                            return Err(self.catchable_range_error_msg("count too big".into()));
                        }
                        n as i64
                    }
                    _ => 0,
                };
                self.meter.tick_raw(STRING_METERSOME_FRAME_METERING);
                self.charge_and_check(count as u64 * crate::meter::BUILTIN_METERING)?;
                // XS meters `count` above but guards its copy loop with
                // `if (length)`. Repeating the empty string therefore returns
                // immediately even for the maximum accepted count instead of
                // spending billions of no-op iterations.
                if content.is_empty() {
                    return Ok(self.new_string_units(&[]));
                }
                let size = self.reserve_units(content.len() as u64 * count as u64)?;
                let mut out = Self::reserved_vec(size)?;
                for _ in 0..count {
                    out.extend_from_slice(&content);
                }
                self.new_reserved_string_units(&out)
            }
            // toLowerCase / toUpperCase: Unicode Default Case Conversion over
            // scalar values, preserving lone UTF-16 surrogates unchanged.
            // Rust's whole-string conversion supplies the locale-insensitive
            // SpecialCasing mappings, including contextual final sigma and
            // one-to-many results. Meter against the input code units, then
            // charge the actual result chunk through `new_string_units`.
            StringToLowerCase | StringToUpperCase => {
                let up = m == StringToUpperCase;
                self.charge_and_check(STRING_METERSOME_FRAME_METERING)?;
                self.charge_builtin_work(ulen as u64)?;
                let out = unicode_case_convert_utf16(self, &content, up)?;
                self.new_reserved_string_units(&out)
            }
            StringToLocaleLowerCase | StringToLocaleUpperCase => {
                let locale =
                    self.intl_resolve_locale(code, argn(0).unwrap_or_else(Slot::undefined))?;
                let up = m == StringToLocaleUpperCase;
                self.charge_and_check(STRING_METERSOME_FRAME_METERING)?;
                self.charge_builtin_work(ulen as u64)?;
                let out = unicode_locale_case_convert_utf16(self, &content, up, &locale)?;
                self.new_reserved_string_units(&out)
            }
            StringLocaleCompare => {
                let right = self.to_string_units(code, argn(0).unwrap_or_else(Slot::undefined))?;
                let locale =
                    self.intl_resolve_locale(code, argn(1).unwrap_or_else(Slot::undefined))?;
                let mut data = CollatorData {
                    locale,
                    usage: "sort".to_string(),
                    sensitivity: "variant".to_string(),
                    collation: "default".to_string(),
                    numeric: false,
                    case_first: "false".to_string(),
                    ignore_punctuation: false,
                };
                if let Some(options) =
                    self.intl_get_options_object(argn(2).unwrap_or_else(Slot::undefined))?
                {
                    self.apply_collator_options(code, options, &mut data)?;
                }
                let left = String::from_utf16_lossy(&content);
                let right = String::from_utf16_lossy(&right);
                Slot::integer(collator_compare(&data, &left, &right))
            }
            // normalize: default to NFC, otherwise coerce `form` after the
            // receiver and accept only the four exact normalization names.
            // ICU4X performs the Unicode algorithm over valid scalar runs;
            // the helper retains JavaScript's unpaired UTF-16 surrogates.
            StringNormalize => {
                let form_units = match argn(0) {
                    None
                    | Some(Slot {
                        kind: Kind::Undefined,
                        ..
                    }) => vec![0x4E, 0x46, 0x43],
                    Some(value) => self.to_string_units(code, value)?,
                };
                let form = match form_units.as_slice() {
                    [0x4E, 0x46, 0x43] => UnicodeNormalizationForm::Nfc,
                    [0x4E, 0x46, 0x44] => UnicodeNormalizationForm::Nfd,
                    [0x4E, 0x46, 0x4B, 0x43] => UnicodeNormalizationForm::Nfkc,
                    [0x4E, 0x46, 0x4B, 0x44] => UnicodeNormalizationForm::Nfkd,
                    _ => return Err(self.catchable_range_error_msg("invalid form".into())),
                };
                self.charge_and_check(STRING_METERSOME_FRAME_METERING)?;
                self.charge_builtin_work(ulen as u64)?;
                let out = unicode_normalize_utf16(self, &content, form)?;
                self.new_reserved_string_units(&out)
            }
            // trim / trimStart / trimEnd: strip the ECMAScript WhiteSpace and
            // LineTerminator code points. The pin
            // meters mxMeterSome(leading byte count) and/or mxMeterSome(kept
            // length), then allocates the result chunk.
            StringTrim | StringTrimStart | StringTrimEnd => {
                let trim_start = m != StringTrimEnd;
                let trim_end = m != StringTrimStart;
                self.meter.tick_raw(STRING_METERSOME_FRAME_METERING);
                let mut lo = 0usize;
                if trim_start {
                    while lo < content.len() && is_ecma_whitespace(content[lo] as u32) {
                        self.charge_builtin_work(1)?;
                        lo += 1;
                    }
                }
                let mut hi = content.len();
                if trim_end {
                    while hi > lo && is_ecma_whitespace(content[hi - 1] as u32) {
                        self.charge_builtin_work(1)?;
                        hi -= 1;
                    }
                    self.charge_builtin_work((hi - lo) as u64)?;
                }
                self.new_string_units(&content[lo..hi])
            }
            StringPadStart | StringPadEnd => {
                let target = self.to_length_value(code, argn(0).unwrap_or_else(Slot::undefined))?;
                if target <= content.len() as u64 {
                    self.new_string_units(&content)
                } else {
                    let fill = match argn(1) {
                        None
                        | Some(Slot {
                            kind: Kind::Undefined,
                            ..
                        }) => vec![0x20],
                        Some(v) => self.to_string_units(code, v)?,
                    };
                    if fill.is_empty() {
                        self.new_string_units(&content)
                    } else {
                        // Allocation is an implementation limit, not a guest
                        // RangeError. XS also aborts at its chunk-size limit.
                        // Coerce the filler first: an empty filler needs no
                        // allocation, even when the requested length is huge.
                        const STRING_PAD_UNIT_CAP: u64 = 1 << 24;
                        if target > STRING_PAD_UNIT_CAP {
                            return Err(Step::Host(Halt::Refused(
                                "String.prototype.pad:result-too-large",
                            )));
                        }
                        let target = self.reserve_units(target)?;
                        let needed = target - content.len();
                        let mut out = Self::reserved_vec(target)?;
                        if m == StringPadEnd {
                            out.extend_from_slice(&content);
                        }
                        let mut filled = 0;
                        while filled < needed {
                            let take = (needed - filled).min(fill.len());
                            out.extend_from_slice(&fill[..take]);
                            filled += take;
                        }
                        if m == StringPadStart {
                            out.extend_from_slice(&content);
                        }
                        self.new_reserved_string_units(&out)
                    }
                }
            }
            StringIsWellFormed | StringToWellFormed => {
                let mut well_formed = true;
                let mut out = self.reserve_scratch(content.len())?;
                let mut i = 0usize;
                while i < content.len() {
                    let u = content[i];
                    if (0xD800..=0xDBFF).contains(&u) {
                        if i + 1 < content.len() && (0xDC00..=0xDFFF).contains(&content[i + 1]) {
                            out.push(u);
                            out.push(content[i + 1]);
                            i += 2;
                            continue;
                        }
                        well_formed = false;
                        out.push(0xFFFD);
                    } else if (0xDC00..=0xDFFF).contains(&u) {
                        well_formed = false;
                        out.push(0xFFFD);
                    } else {
                        out.push(u);
                    }
                    i += 1;
                }
                if m == StringIsWellFormed {
                    Slot::boolean(well_formed)
                } else if well_formed {
                    self.new_string_units(&content)
                } else {
                    self.new_string_units(&out)
                }
            }
            StringIterator => self.make_string_iterator(units_to_be16(&content)),
            _ => return Err(Step::Host(Halt::NotImplemented("string-method:unmodeled"))),
        };
        Ok(result)
    }

    /// Build a String Iterator over the UTF-16BE `bytes` (`fx_String_prototype_
    /// iterator` → `fxNewIteratorInstance`): allocate the iterator instance and
    /// its reused `{value, done}` result, recording a kind-4 [`IterState`] whose
    /// `index` is a BYTE offset into `bytes`. Meters the creation cluster
    /// ([`STRING_ITERATOR_CREATE_METERING`]). The iterator chains to
    /// `%Array Iterator.prototype%` in ironhorse's model (its `next` dispatches to
    /// the same [`NativeMethod::ArrayIteratorNext`], which branches on kind).
    fn make_string_iterator(&mut self, bytes: Vec<u8>) -> Slot {
        self.meter.tick_raw(STRING_ITERATOR_CREATE_METERING);
        let result = self.slots.alloc(Slot::instance(self.object_proto));
        if let Some(vid) = self.value_id {
            self.set_own_unmetered(result, vid, Slot::undefined());
        }
        if let Some(did) = self.done_id {
            self.set_own_unmetered(result, did, Slot::boolean(false));
        }
        let iter = self.slots.alloc(Slot::instance(self.array_iterator_proto));
        self.iterators.insert(
            iter,
            IterState {
                iterable: crate::value::SlotIndex::NULL,
                index: 0,
                kind: 4,
                generation: 0,
                result,
                done: false,
                enum_keys: std::rc::Rc::default(),
                str_bytes: std::rc::Rc::new(bytes),
            },
        );
        Slot::of(Kind::Reference, Payload::Reference(iter))
    }

    /// Build a Map/Set Iterator over the collection `inst`
    /// (`fxNewMapIteratorInstance`/`fxNewSetIteratorInstance` → the shared
    /// `fxNewIteratorInstance`): allocate the iterator instance and its reused
    /// `{value, done}` result, recording an [`IterState`] whose `iterable` is
    /// the collection slot and `index` cursors its live entry list. `kind` is
    /// 5 = keys, 6 = values, 7 = entries. The iterator chains to
    /// `%Array Iterator.prototype%` in ironhorse's model (its `next` dispatches to
    /// the same [`NativeMethod::ArrayIteratorNext`], which branches on kind to
    /// [`Self::collection_iterator_next`]). Meters the creation cluster
    /// ([`COLLECTION_ITERATOR_CREATE_METERING`]).
    fn make_collection_iterator(&mut self, inst: crate::value::SlotIndex, kind: u8) -> Slot {
        self.meter.tick_raw(COLLECTION_ITERATOR_CREATE_METERING);
        let coll_generation = self.collections.get(&inst).map_or(0, |c| c.generation());
        let result = self.slots.alloc(Slot::instance(self.object_proto));
        if let Some(vid) = self.value_id {
            self.set_own_unmetered(result, vid, Slot::undefined());
        }
        if let Some(did) = self.done_id {
            self.set_own_unmetered(result, did, Slot::boolean(false));
        }
        let proto = match self.collections.get(&inst).map(|c| c.kind) {
            Some(CollKind::Map) => self.map_iterator_proto,
            Some(CollKind::Set) => self.set_iterator_proto,
            _ => self.array_iterator_proto,
        };
        let iter = self.slots.alloc(Slot::instance(proto));
        self.iterators.insert(
            iter,
            IterState {
                iterable: inst,
                index: 0,
                kind,
                generation: coll_generation,
                result,
                done: false,
                enum_keys: std::rc::Rc::default(),
                str_bytes: std::rc::Rc::default(),
            },
        );
        Slot::of(Kind::Reference, Payload::Reference(iter))
    }

    /// `Iterator.from(value)`: acquire `value`'s iterator record once, return
    /// an existing `%Iterator%` instance unchanged, or wrap a generic direct
    /// iterator in `%WrapForValidIteratorPrototype%`. The wrapper's kind-8
    /// [`IterState`] uses `iterable` for `[[Iterated]]` and `result` for an
    /// arena holder containing the cached (not necessarily callable) `next`
    /// value. Keeping the holder in the arena lets the existing ITER snapshot
    /// row and GC edge machinery carry the otherwise arbitrary [`Slot`].
    fn iterator_from(&mut self, code: &[u8], value: Slot) -> Result<Slot, Step> {
        if value.kind != Kind::String && value.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("iterator: not a string".into()));
        }

        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .expect("well-known iterator symbol");
        let iterator_method = match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => {
                self.mop_get(code, inst, iterator_id, value)?
            }
            Payload::String(_) if value.kind == Kind::String => {
                self.mop_get(code, self.string_proto, iterator_id, value)?
            }
            _ => unreachable!("Iterator.from accepted only objects and strings"),
        };
        let iterator = if matches!(iterator_method.kind, Kind::Undefined | Kind::Null) {
            value
        } else {
            if !self.is_callable_value(iterator_method) {
                return Err(self.catchable_type_error_msg("call: not a function".into()));
            }
            let iterator = self.call_any(code, iterator_method, value, &[])?;
            if iterator.kind != Kind::Reference {
                return Err(self.catchable_type_error_msg("iterator: not an object".into()));
            }
            iterator
        };
        let Payload::Reference(iterator_inst) = iterator.value else {
            return Err(self.catchable_type_error_msg("iterator: not an object".into()));
        };
        let next_id = self.intern_key("next");
        let next_method = self.mop_get(code, iterator_inst, next_id, iterator)?;

        let iterator_ctor =
            self.intrinsics
                .get("Iterator")
                .copied()
                .ok_or(Step::Host(Halt::EngineInvariant(
                    "Iterator:missing-constructor",
                )))?;
        let iterator_ctor = Slot::of(Kind::Reference, Payload::Reference(iterator_ctor));
        if self.ordinary_has_instance(code, iterator_ctor, iterator)? {
            return Ok(iterator);
        }

        self.meter.tick_builtin();
        self.meter.tick_slot_alloc();
        let next_holder = self
            .slots
            .alloc(Slot::of(next_method.kind, next_method.value));
        self.meter.tick_slot_alloc();
        let wrapper = self
            .slots
            .alloc(Slot::instance(self.iterator_wrapper_proto));
        self.iterators.insert(
            wrapper,
            IterState {
                iterable: iterator_inst,
                index: 0,
                kind: 8,
                generation: 0,
                result: next_holder,
                done: false,
                enum_keys: std::rc::Rc::default(),
                str_bytes: std::rc::Rc::default(),
            },
        );
        Ok(Slot::of(Kind::Reference, Payload::Reference(wrapper)))
    }

    /// `%WrapForValidIteratorPrototype%.next()`. The cached method is read
    /// from the wrapper's arena holder and called with the original iterator.
    /// The result is returned unchanged; iterator consumers perform the
    /// protocol's object-result validation when they advance it.
    fn iterator_wrapper_next(&mut self, code: &[u8], this: Slot) -> Result<Slot, Step> {
        let Payload::Reference(wrapper) = this.value else {
            return Err(self.catchable_type_error_msg("this: not an iterator".into()));
        };
        let Some(state) = self
            .iterators
            .get(&wrapper)
            .filter(|state| state.kind == 8)
            .cloned()
        else {
            return Err(self.catchable_type_error_msg("this: not an iterator".into()));
        };
        let next_method = self.slots.get(state.result);
        let iterator = Slot::of(Kind::Reference, Payload::Reference(state.iterable));
        self.call_any(code, next_method, iterator, &[])
    }

    /// `%WrapForValidIteratorPrototype%.return()`. The underlying `return`
    /// method is intentionally fetched on each call; unlike `next`, it is not
    /// part of the captured iterator record. An absent method produces a fresh
    /// ordinary `{ value: undefined, done: true }` result.
    fn iterator_wrapper_return(&mut self, code: &[u8], this: Slot) -> Result<Slot, Step> {
        let Payload::Reference(wrapper) = this.value else {
            return Err(self.catchable_type_error_msg("this: not an iterator".into()));
        };
        let Some(state) = self
            .iterators
            .get(&wrapper)
            .filter(|state| state.kind == 8)
            .cloned()
        else {
            return Err(self.catchable_type_error_msg("this: not an iterator".into()));
        };
        let iterator = Slot::of(Kind::Reference, Payload::Reference(state.iterable));
        let return_id = self.intern_key("return");
        let return_method = self.mop_get(code, state.iterable, return_id, iterator)?;
        if matches!(return_method.kind, Kind::Undefined | Kind::Null) {
            let value_id = self.intern_key("value");
            let done_id = self.intern_key("done");
            let result = self.slots.alloc(Slot::instance(self.object_proto));
            self.set_own_unmetered(result, value_id, Slot::undefined());
            self.set_own_unmetered(result, done_id, Slot::boolean(true));
            return Ok(Slot::of(Kind::Reference, Payload::Reference(result)));
        }
        if !self.is_callable_value(return_method) {
            return Err(self.catchable_type_error_msg("call: not a function".into()));
        }
        self.call_any(code, return_method, iterator, &[])
    }

    /// Invoke one of the eager Iterator helpers (`reduce`, `toArray`,
    /// `forEach`, `some`, `every`, or `find`) behind a native try boundary.
    /// Their shared implementation below drives the public direct-iterator
    /// protocol rather than inspecting ironhorse's iterator side table, so
    /// user iterators, proxies, accessors, and overridden built-in `next`
    /// methods all remain observable.
    fn iterator_terminal_helper(
        &mut self,
        code: &[u8],
        op: u8,
        this: Slot,
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        let outcome = self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            machine.iterator_terminal_helper_inner(code, op, this, base, argc)
        });
        match outcome {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(self.raise_js(error)),
            Err(halt) => Err(halt),
        }
    }

    /// IteratorClose with a normal completion. Unlike the abrupt-close helper
    /// used by `Array.from`, failures from getting/calling `return` replace the
    /// pending value, and a non-object return result is a TypeError.
    fn iterator_close_normal(
        &mut self,
        code: &[u8],
        iterator: Slot,
        completion: Slot,
    ) -> Result<Result<Slot, Slot>, Step> {
        let Payload::Reference(inst) = iterator.value else {
            return Ok(Err(
                self.internal_error("TypeError", "this: not an object".into())
            ));
        };
        let return_id = self.intern_key("return");
        let return_method =
            match self.array_from_try(|this| this.mop_get(code, inst, return_id, iterator))? {
                Ok(method) => method,
                Err(error) => return Ok(Err(error)),
            };
        if matches!(return_method.kind, Kind::Undefined | Kind::Null) {
            return Ok(Ok(completion));
        }
        if !self.is_callable_value(return_method) {
            return Ok(Err(
                self.internal_error("TypeError", "call: not a function".into())
            ));
        }
        let inner =
            match self.array_from_try(|this| this.call_any(code, return_method, iterator, &[]))? {
                Ok(value) => value,
                Err(error) => return Ok(Err(error)),
            };
        if inner.kind != Kind::Reference {
            return Ok(Err(self.internal_error(
                "TypeError",
                "iterator result: not an object".into(),
            )));
        }
        Ok(Ok(completion))
    }

    /// The common direct-iterator loop for the eager Iterator helpers. The
    /// operation ids follow `create_intrinsics`: 5 reduce, 6 toArray, 7
    /// forEach, 8 some, 9 every, 10 find.
    fn iterator_terminal_helper_inner(
        &mut self,
        code: &[u8],
        op: u8,
        iterator: Slot,
        base: usize,
        argc: usize,
    ) -> Result<Result<Slot, Slot>, Step> {
        let inst = match iterator.value {
            Payload::Reference(inst) if iterator.kind == Kind::Reference => inst,
            _ => {
                return Ok(Err(
                    self.internal_error("TypeError", "this: not an object".into())
                ))
            }
        };
        let callback = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        if op != 6 && !self.is_callable_value(callback) {
            // ES2025 creates the incomplete iterator record before validating
            // the callback. IteratorClose therefore observes `return`, but it
            // has not yet read `next`; the original TypeError always wins.
            let error = self.internal_error(
                "TypeError",
                match op {
                    5 => "reducer: not a function",
                    7 => "procedure: not a function",
                    _ => "predicate: not a function",
                }
                .into(),
            );
            return Ok(Err(self.array_from_close(code, iterator, error)?));
        }

        let value_id = self.intern_key("value");
        let done_id = self.intern_key("done");
        self.value_id = Some(value_id);
        self.done_id = Some(done_id);
        let next_id = self.intern_key("next");
        let next_method =
            match self.array_from_try(|this| this.mop_get(code, inst, next_id, iterator))? {
                Ok(method) if self.is_callable_value(method) => method,
                Ok(_) => {
                    return Ok(Err(
                        self.internal_error("TypeError", "call: not a function".into())
                    ))
                }
                Err(error) => return Ok(Err(error)),
            };

        let mut counter = 0u64;
        let mut accumulator = if op == 5 && argc >= 2 {
            self.stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined)
        } else {
            Slot::uninitialized()
        };
        let mut items = Vec::new();

        for _ in 0..1_000_000u64 {
            let step = match self
                .array_from_try(|this| this.call_any(code, next_method, iterator, &[]))?
            {
                Ok(step) => step,
                // IteratorStepValue failures propagate directly and do not
                // invoke `return`.
                Err(error) => return Ok(Err(error)),
            };
            let step_inst = match step.value {
                Payload::Reference(step_inst) if step.kind == Kind::Reference => step_inst,
                _ => {
                    return Ok(Err(self.internal_error(
                        "TypeError",
                        "iterator result: not an object".into(),
                    )))
                }
            };
            let done =
                match self.array_from_try(|this| this.mop_get(code, step_inst, done_id, step))? {
                    Ok(done) => done,
                    Err(error) => return Ok(Err(error)),
                };
            if self.truthy(&done) {
                return Ok(match op {
                    5 if accumulator.kind == Kind::Uninitialized => {
                        Err(self.internal_error("TypeError", "no initial value".into()))
                    }
                    5 => Ok(accumulator),
                    6 => {
                        // CreateArrayFromList at completion. Retain the
                        // existing toArray allocation/meter shape: one real
                        // Array instance followed by its dense item chunk.
                        let array = self.new_array();
                        let length = items.len() as u32;
                        let data = self.arrays.get_mut(&array).unwrap();
                        data.length = length;
                        for (index, value) in items.iter().enumerate() {
                            data.insert_item(index as u32, *value, &mut self.side_refs);
                        }
                        if length != 0 {
                            self.charge_and_check(self.array_chunk_size_metering(length))?;
                        }
                        Ok(Slot::of(Kind::Reference, Payload::Reference(array)))
                    }
                    7 => Ok(Slot::undefined()),
                    8 => Ok(Slot::boolean(false)),
                    9 => Ok(Slot::boolean(true)),
                    10 => Ok(Slot::undefined()),
                    _ => unreachable!("terminal Iterator helper id"),
                });
            }
            let value =
                match self.array_from_try(|this| this.mop_get(code, step_inst, value_id, step))? {
                    Ok(value) => value,
                    Err(error) => return Ok(Err(error)),
                };

            if op == 6 {
                items.push(value);
                counter += 1;
                continue;
            }
            if op == 5 && accumulator.kind == Kind::Uninitialized {
                accumulator = value;
                counter = 1;
                continue;
            }

            let args = if op == 5 {
                vec![accumulator, value, Slot::number(counter as f64)]
            } else {
                vec![value, Slot::number(counter as f64)]
            };
            let result = match self
                .array_from_try(|this| this.call_any(code, callback, Slot::undefined(), &args))?
            {
                Ok(result) => result,
                Err(error) => {
                    return Ok(Err(self.array_from_close(code, iterator, error)?));
                }
            };
            match op {
                5 => accumulator = result,
                7 => {}
                8 if self.truthy(&result) => {
                    return self.iterator_close_normal(code, iterator, Slot::boolean(true));
                }
                9 if !self.truthy(&result) => {
                    return self.iterator_close_normal(code, iterator, Slot::boolean(false));
                }
                10 if self.truthy(&result) => {
                    return self.iterator_close_normal(code, iterator, value);
                }
                8..=10 => {}
                _ => unreachable!("terminal Iterator helper id"),
            }
            counter += 1;
        }
        Err(Step::Host(Halt::StepLimit(self.n_dispatched)))
    }

    /// `fx_MapIterator_prototype_next` / `fx_SetIterator_prototype_next`: yield
    /// the collection's next live entry in insertion order, mutating and
    /// returning the reused result object. `kind` is 5 = keys (the entry key),
    /// 6 = values (the entry value; a Set stores its value as the key half, so
    /// a Set's kind-6 yields the key), 7 = entries (a fresh `[k, v]` pair; a
    /// Set yields `[v, v]`). Meters the per-`next()` base plus, for an entries
    /// yield, the two-element pair array's chunk. Entries are addressed by
    /// index into the live [`CollectionData::entries`] Vec (XS walks the linked
    /// list, skipping deleted `XS_DONT_ENUM` tombstones; the covered grammar
    /// does not mutate mid-iteration).
    fn collection_iterator_next(&mut self, iter: crate::value::SlotIndex) -> Slot {
        let st = self.iterators[&iter].clone();
        let result = st.result;
        // A `clear()` since this cursor was created retires it for good
        // (XS's purge frees the node chain the cursor walked; it never
        // reaches entries added after a clear). Latch done.
        let stale = self
            .collections
            .get(&st.iterable)
            .is_some_and(|c| c.generation() != st.generation);
        if stale {
            if let Some(s) = self.iterators.get_mut(&iter) {
                s.done = true;
            }
        }
        let st = self.iterators[&iter].clone();
        let len = self
            .collections
            .get(&st.iterable)
            .map(|c| c.entries().len() as u32)
            .unwrap_or(0);
        let mut live_index = st.index;
        while live_index < len
            && self.collections[&st.iterable].entries()[live_index as usize].is_none()
        {
            live_index += 1;
        }
        let (new_value, new_done, next_index): (Slot, bool, u32) = if st.done || live_index >= len {
            (Slot::undefined(), true, st.index)
        } else {
            // A keys/values yield carries no residual; an entries yield charges
            // the pair-construction frame ([`COLLECTION_ITERATOR_ENTRY_METERING`])
            // plus the two-element pair chunk (below).
            if st.kind == 7 {
                self.meter.tick_raw(COLLECTION_ITERATOR_ENTRY_METERING);
            }
            let (k, v) = self.collections[&st.iterable].entries()[live_index as usize].unwrap();
            let is_set = matches!(self.collections[&st.iterable].kind, CollKind::Set);
            let value = match st.kind {
                5 => k, // keys
                // values: a Map yields the value half; a Set stores its value
                // in the key half, so it yields the key.
                6 if is_set => k,
                6 => v,
                _ => {
                    // entries: `[key, value]` (a Set yields `[value, value]`).
                    let (a, b) = if is_set { (k, k) } else { (k, v) };
                    let pair = self.new_array();
                    let arr = self.arrays.get_mut(&pair).unwrap();
                    arr.length = 2;
                    arr.insert_item(0, Slot::of(a.kind, a.value), &mut self.side_refs);
                    arr.insert_item(1, Slot::of(b.kind, b.value), &mut self.side_refs);
                    self.meter.tick_raw(self.array_chunk_size_metering(2));
                    Slot::of(Kind::Reference, Payload::Reference(pair))
                }
            };
            (value, false, live_index + 1)
        };
        if let Some(s) = self.iterators.get_mut(&iter) {
            s.index = next_index;
            s.done = new_done;
        }
        if let Some(vid) = self.value_id {
            self.set_own_unmetered(result, vid, Slot::of(new_value.kind, new_value.value));
        }
        if let Some(did) = self.done_id {
            self.set_own_unmetered(result, did, Slot::boolean(new_done));
        }
        Slot::of(Kind::Reference, Payload::Reference(result))
    }

    /// The strong-collection brand declared by the native method function in
    /// the active call frame. Map and Set share several [`NativeMethod`]
    /// variants, but each boot-minted function identity occurs only on its
    /// declaring prototype (apart from Set's intentional keys/values alias).
    fn collection_method_brand(&self, base: usize) -> Option<CollKind> {
        let function = match self.stack.get(base + 1)?.value {
            Payload::Reference(function) => function,
            _ => return None,
        };
        self.proto_methods
            .iter()
            .find_map(|(prototype, _, method)| {
                if *method != function {
                    return None;
                }
                if *prototype == self.map_proto {
                    Some(CollKind::Map)
                } else if *prototype == self.set_proto {
                    Some(CollKind::Set)
                } else {
                    None
                }
            })
    }

    /// `fx_Map_prototype_forEach` / `fx_Set_prototype_forEach`: call the
    /// callback for each live entry in insertion order. Map passes
    /// `(value, key, coll)`; Set passes `(value, value, coll)`. Meters the
    /// native frame ([`COLLECTION_FOREACH_FRAME_METERING`]) plus, per entry,
    /// the call-frame residual ([`COLLECTION_FOREACH_PER_ENTRY_METERING`]) over
    /// the callback body the nested dispatch meters. Receiver and callback
    /// validation also applies to empty collections.
    fn call_collection_foreach(
        &mut self,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let _ = argc;
        let expected =
            self.collection_method_brand(base)
                .ok_or(Step::Host(Halt::EngineInvariant(
                    "collection:missing-method-brand",
                )))?;
        let inst = match self.collection_ref(this) {
            Some(i) => i,
            None => return Err(self.collection_brand_error(expected, false)),
        };
        if self.collections[&inst].kind != expected {
            self.charge_and_check(if expected == CollKind::Map {
                MAP_METHOD_ON_SET_METERING
            } else {
                SET_METHOD_ON_MAP_METERING
            })?;
            return Err(self.collection_brand_error(expected, false));
        }
        let is_set = expected == CollKind::Set;
        let callback = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        if !self.is_callable_value(callback) {
            return Err(self.catchable_type_error_msg("callback: not a function".into()));
        }
        let this_arg = self
            .stack
            .get(base + 4 + 1)
            .copied()
            .unwrap_or_else(Slot::undefined);
        self.charge_and_check(if is_set {
            SET_FOREACH_FRAME_METERING
        } else {
            MAP_FOREACH_FRAME_METERING
        })?;
        // Index into the insertion list. Deletions leave tombstones and
        // additions append, matching XS's live linked-list walk. A
        // `clear()` from inside the callback bumps the collection's
        // generation and ends the walk (XS's purge — the cursor never
        // reaches post-clear appends).
        let start_generation = self.collections.get(&inst).map_or(0, |c| c.generation());
        let mut i = 0u32;
        loop {
            if self
                .collections
                .get(&inst)
                .is_none_or(|c| c.generation() != start_generation)
            {
                break;
            }
            let entry = self
                .collections
                .get(&inst)
                .and_then(|c| c.entries().get(i as usize));
            let (k, v) = match entry {
                Some(Some(kv)) => *kv,
                Some(None) => {
                    i += 1;
                    continue;
                }
                None => break,
            };
            self.meter.tick_raw(COLLECTION_FOREACH_PER_ENTRY_METERING);
            // Map: cb(value, key, coll). Set: cb(value, value, coll) — the
            // value is stored in the key half.
            let cb_val = if is_set { k } else { v };
            let cb_key = k;
            let cb_args = [cb_val, cb_key, this];
            self.run_callback(code, callback, this_arg, &cb_args)?;
            i += 1;
        }
        Ok(Slot::undefined())
    }

    // ------------------------------------------------------------------
    // ES2025 "new Set methods" (set-methods proposal): union, intersection,
    // difference, symmetricDifference, isSubsetOf, isSupersetOf,
    // isDisjointFrom. Each requires the receiver to be a real Set (its
    // [[SetData]] internal slot is read directly, NEVER through overridden
    // methods) and coerces its argument through GetSetRecord — observing
    // `size` (→ ToNumber, NaN throws TypeError, negative throws RangeError),
    // then `has`, then `keys` (both must be callable). union / intersection /
    // difference / symmetricDifference return a fresh %Set.prototype% Set;
    // the three predicates return a Boolean.
    // ------------------------------------------------------------------

    /// The receiver's collection instance if it is a real (non-weak) Set, else
    /// a catchable TypeError (`RequireInternalSlot(O, [[SetData]])`).
    fn require_set_receiver(&mut self, this: Slot) -> Result<crate::value::SlotIndex, Step> {
        match self.collection_ref(this) {
            Some(inst) if self.collections[&inst].kind == CollKind::Set => Ok(inst),
            _ => Err(self.collection_brand_error(CollKind::Set, false)),
        }
    }

    /// The number of live (non-tombstone) entries of a native collection.
    fn collection_live_len(&self, inst: crate::value::SlotIndex) -> usize {
        self.collections
            .get(&inst)
            .map(CollectionData::live_len)
            .unwrap_or(0)
    }

    /// The live key slots of a native collection, in insertion order (for a Set
    /// the key half is the value). A snapshot the algorithms iterate.
    fn collection_live_keys(&self, inst: crate::value::SlotIndex) -> Vec<Slot> {
        self.collections
            .get(&inst)
            .map(|c| {
                c.entries()
                    .iter()
                    .filter_map(|e| e.map(|(k, _)| k))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `Get(obj, id)` walking the ordinary prototype chain, but resolving the
    /// native `Map`/`Set` `size` accessor (which XS/ironhorse handle inline in
    /// GET_PROPERTY rather than as a stored accessor) when the chain carries no
    /// own/inherited `size` property. A user `get size()` override IS a stored
    /// accessor and is found by the chain walk first, so it still wins.
    fn set_record_get_size(
        &mut self,
        code: &[u8],
        obj: crate::value::SlotIndex,
        obj_slot: Slot,
    ) -> Result<Slot, Step> {
        let size_id = self.intern_key("size");
        let mut owner = obj;
        while !owner.is_null() {
            if owner != obj && self.proxies.contains_key(&owner) {
                return self.ordinary_get(code, obj, size_id, obj_slot);
            }
            if self.ordinary_get_own_descriptor(owner, size_id).is_some() {
                return self.ordinary_get(code, obj, size_id, obj_slot);
            }
            owner = self.instance_prototype(owner);
        }
        if let Some(c) = self.collections.get(&obj) {
            if matches!(c.kind, CollKind::Map | CollKind::Set) {
                return Ok(Slot::integer(self.collection_live_len(obj) as i32));
            }
        }
        Ok(Slot::undefined())
    }

    /// `GetSetRecord(obj)` (set-methods proposal): returns `(obj, size, has,
    /// keys)` after the exact observable get order — `size` → ToNumber →
    /// NaN/negative checks, then `has`, then `keys`. `size` is stored as an
    /// `f64` so `+Infinity` is representable.
    fn get_set_record(&mut self, code: &[u8], arg: Slot) -> Result<(Slot, f64, Slot, Slot), Step> {
        let obj = match arg.value {
            Payload::Reference(inst) if arg.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg("other is no object".into())),
        };
        let raw_size = self.set_record_get_size(code, obj, arg)?;
        let num = self.to_number_value(code, raw_size)?;
        let num = to_number(&num);
        if num.is_nan() {
            return Err(self.catchable_type_error_msg("other.size is NaN".into()));
        }
        let int_size = if num.is_infinite() { num } else { num.trunc() };
        if int_size < 0.0 {
            return Err(self.catchable_range_error_msg("other.size < 0".into()));
        }
        let has_id = self.intern_key("has");
        let has = self.ordinary_get(code, obj, has_id, arg)?;
        if !self.value_is_callable(has) {
            return Err(self.catchable_type_error_msg("other.has is no function".into()));
        }
        let keys_id = self.intern_key("keys");
        let keys = self.ordinary_get(code, obj, keys_id, arg)?;
        if !self.value_is_callable(keys) {
            return Err(self.catchable_type_error_msg("other.keys is no function".into()));
        }
        Ok((arg, int_size, has, keys))
    }

    /// Whether a slot value is a callable function value (ordinary, native
    /// method, bound, or a callable proxy) — the value-typed wrapper over
    /// [`Self::slot_is_callable`].
    fn value_is_callable(&self, s: Slot) -> bool {
        match s.value {
            Payload::Reference(f) if s.kind == Kind::Reference => self.slot_is_callable(f),
            _ => false,
        }
    }

    /// `GetKeysIterator(setRecord)`: `keysIter = ? Call(keys, obj)` (must be an
    /// Object) and `nextMethod = ? Get(keysIter, "next")`. Returns
    /// `(keysIter, nextMethod)`.
    fn get_keys_iterator(
        &mut self,
        code: &[u8],
        obj: Slot,
        keys: Slot,
    ) -> Result<(Slot, Slot), Step> {
        let iter = self.call_primitive_method(code, keys, obj, &[])?;
        let iter_inst = match iter.value {
            Payload::Reference(i) if iter.kind == Kind::Reference => i,
            _ if matches!(iter.kind, Kind::Null | Kind::Undefined) => {
                return Err(self.catchable_type_error_msg(cannot_coerce_to_object(iter.kind)))
            }
            // XS reads `next` from boxed primitives and can proceed through
            // their prototypes. Keep the spec-only object guard distinct.
            _ => return Err(self.catchable_type_error()),
        };
        let next_id = self.intern_key("next");
        let next = self.ordinary_get(code, iter_inst, next_id, iter)?;
        Ok((iter, next))
    }

    /// `IteratorStepValue(keysIter, nextMethod)`: one step of the keys
    /// iterator. `Ok(Some(value))` for a produced value, `Ok(None)` when done.
    fn set_keys_iterator_step(
        &mut self,
        code: &[u8],
        iter: Slot,
        next: Slot,
    ) -> Result<Option<Slot>, Step> {
        let result = self.call_primitive_method(code, next, iter, &[])?;
        let result_inst = match result.value {
            Payload::Reference(i) if result.kind == Kind::Reference => i,
            _ => return Err(self.catchable_type_error_msg("iterator result: not an object".into())),
        };
        let done_id = self.intern_key("done");
        let done = self.ordinary_get(code, result_inst, done_id, result)?;
        if self.truthy(&done) {
            return Ok(None);
        }
        let value_id = self.intern_key("value");
        let value = self.ordinary_get(code, result_inst, value_id, result)?;
        Ok(Some(value))
    }

    /// `IteratorClose(keysIter, NormalCompletion)`: call the iterator's
    /// `return` method if present; a thrown completion from `return`
    /// propagates.
    fn set_keys_iterator_close(&mut self, code: &[u8], iter: Slot) -> Result<(), Step> {
        let iter_inst = match iter.value {
            Payload::Reference(i) if iter.kind == Kind::Reference => i,
            _ => return Ok(()),
        };
        let return_id = self.intern_key("return");
        let ret = self.ordinary_get(code, iter_inst, return_id, iter)?;
        if ret.kind == Kind::Undefined || ret.kind == Kind::Null {
            return Ok(());
        }
        if self.value_is_callable(ret) {
            self.call_primitive_method(code, ret, iter, &[])?;
        }
        Ok(())
    }

    /// Canonicalize a set element key (`CanonicalizeKeyedCollectionKey`): only
    /// `-0` normalizes to `+0`, matching [`Self::normalize_coll_key`].
    fn canonicalize_set_key(&self, key: Slot) -> Slot {
        self.normalize_coll_key(key)
    }

    /// Whether `keys` (a working list built by a set method) already contains
    /// `key` by SameValueZero.
    fn key_list_contains(&self, keys: &[Slot], key: &Slot) -> bool {
        keys.iter().any(|k| self.same_value_zero(k, key))
    }

    /// Build a fresh `%Set.prototype%` Set holding exactly `keys` (already
    /// deduped and canonicalized by the caller), charging the same allocation
    /// metering the `new Set` constructor path charges.
    fn new_set_from_keys(&mut self, keys: Vec<Slot>) -> Slot {
        self.meter.tick_raw(MAP_CTOR_FRAME_METERING);
        self.meter.tick_slot_alloc(); // instance
        self.meter.tick_slot_alloc(); // table
        self.meter.tick_slot_alloc(); // list
        self.meter.tick_slot_alloc(); // size
        self.meter.tick_chunk_new(MAP_MIN_TABLE_LENGTH as u64 * 8);
        let inst = self.slots.alloc(Slot::instance(self.set_proto));
        self.collections.insert(
            inst,
            CollectionData::new(CollKind::Set, MAP_MIN_TABLE_LENGTH),
        );
        for key in keys {
            self.charge_new_entry_slots(2);
            self.collections.get_mut(&inst).unwrap().push_entry(
                key,
                Slot::undefined(),
                &mut self.side_refs,
            );
            self.collection_table_resize(inst);
        }
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    fn call_set_method(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let inst = self.require_set_receiver(this)?;
        let arg0 = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let (obj, other_size, has, keys) = self.get_set_record(code, arg0)?;
        match m {
            NativeMethod::SetUnion => {
                let mut result = self.collection_live_keys(inst);
                let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                    let v = self.canonicalize_set_key(v);
                    if !self.key_list_contains(&result, &v) {
                        result.push(v);
                    }
                }
                Ok(self.new_set_from_keys(result))
            }
            NativeMethod::SetIntersection => {
                let mut result: Vec<Slot> = Vec::new();
                let this_len = self.collection_live_len(inst);
                if (this_len as f64) <= other_size {
                    // Walk THIS in order; keep those the other set `has`. `has`
                    // may mutate THIS, so re-check the element is still present.
                    let mut i = 0u32;
                    loop {
                        let entry = self
                            .collections
                            .get(&inst)
                            .and_then(|c| c.entries().get(i as usize));
                        let k = match entry {
                            Some(Some((k, _))) => *k,
                            Some(None) => {
                                i += 1;
                                continue;
                            }
                            None => break,
                        };
                        let in_other = self.call_primitive_method(code, has, obj, &[k])?;
                        if self.truthy(&in_other)
                            && self.collection_find(inst, &k).is_some()
                            && !self.key_list_contains(&result, &k)
                        {
                            result.push(k);
                        }
                        i += 1;
                    }
                } else {
                    // Iterate the OTHER set's keys; keep those THIS contains.
                    let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                    while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                        let v = self.canonicalize_set_key(v);
                        if self.collection_find(inst, &v).is_some()
                            && !self.key_list_contains(&result, &v)
                        {
                            result.push(v);
                        }
                    }
                }
                Ok(self.new_set_from_keys(result))
            }
            NativeMethod::SetDifference => {
                let mut result = self.collection_live_keys(inst);
                let this_len = result.len();
                if (this_len as f64) <= other_size {
                    // For each element of THIS, remove it if the other set has it.
                    let mut i = 0usize;
                    while i < result.len() {
                        let k = result[i];
                        let in_other = self.call_primitive_method(code, has, obj, &[k])?;
                        if self.truthy(&in_other) {
                            result.retain(|e| !self.same_value_zero(e, &k));
                        } else {
                            i += 1;
                        }
                    }
                } else {
                    // Iterate the other set's keys; remove each from the result.
                    let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                    while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                        let v = self.canonicalize_set_key(v);
                        result.retain(|e| !self.same_value_zero(e, &v));
                    }
                }
                Ok(self.new_set_from_keys(result))
            }
            NativeMethod::SetSymmetricDifference => {
                let mut result = self.collection_live_keys(inst);
                let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                    let v = self.canonicalize_set_key(v);
                    let in_this = self.collection_find(inst, &v).is_some();
                    if in_this {
                        result.retain(|e| !self.same_value_zero(e, &v));
                    } else if !self.key_list_contains(&result, &v) {
                        result.push(v);
                    }
                }
                Ok(self.new_set_from_keys(result))
            }
            NativeMethod::SetIsSubsetOf => {
                // this ⊆ other. If |this| > |other|, false. Else every element
                // of THIS must be `has` in the other set.
                let this_keys = self.collection_live_keys(inst);
                if (this_keys.len() as f64) > other_size {
                    return Ok(Slot::boolean(false));
                }
                let mut i = 0u32;
                loop {
                    let entry = self
                        .collections
                        .get(&inst)
                        .and_then(|c| c.entries().get(i as usize));
                    let k = match entry {
                        Some(Some((k, _))) => *k,
                        Some(None) => {
                            i += 1;
                            continue;
                        }
                        None => break,
                    };
                    let in_other = self.call_primitive_method(code, has, obj, &[k])?;
                    if !self.truthy(&in_other) {
                        return Ok(Slot::boolean(false));
                    }
                    i += 1;
                }
                Ok(Slot::boolean(true))
            }
            NativeMethod::SetIsSupersetOf => {
                // this ⊇ other. If |this| < |other|, false. Else every key of
                // OTHER must be contained in THIS.
                let this_len = self.collection_live_len(inst);
                if (this_len as f64) < other_size {
                    return Ok(Slot::boolean(false));
                }
                let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                    if self.collection_find(inst, &v).is_none() {
                        self.set_keys_iterator_close(code, iter)?;
                        return Ok(Slot::boolean(false));
                    }
                }
                Ok(Slot::boolean(true))
            }
            NativeMethod::SetIsDisjointFrom => {
                // No common element. Walk the smaller side.
                let this_len = self.collection_live_len(inst);
                if (this_len as f64) <= other_size {
                    let mut i = 0u32;
                    loop {
                        let entry = self
                            .collections
                            .get(&inst)
                            .and_then(|c| c.entries().get(i as usize));
                        let k = match entry {
                            Some(Some((k, _))) => *k,
                            Some(None) => {
                                i += 1;
                                continue;
                            }
                            None => break,
                        };
                        let in_other = self.call_primitive_method(code, has, obj, &[k])?;
                        if self.truthy(&in_other) {
                            return Ok(Slot::boolean(false));
                        }
                        i += 1;
                    }
                } else {
                    let (iter, next) = self.get_keys_iterator(code, obj, keys)?;
                    while let Some(v) = self.set_keys_iterator_step(code, iter, next)? {
                        if self.collection_find(inst, &v).is_some() {
                            self.set_keys_iterator_close(code, iter)?;
                            return Ok(Slot::boolean(false));
                        }
                    }
                }
                Ok(Slot::boolean(true))
            }
            _ => Err(Step::Host(Halt::EngineInvariant(
                "set-method:unexpected-method",
            ))),
        }
    }

    // ------------------------------------------------------------------
    // Upsert proposal: `{Map,WeakMap}.prototype.getOrInsert` /
    // `getOrInsertComputed`. Shared handler — the proposal covers both Map and
    // WeakMap. It requires a real `[[MapData]]`/`[[WeakMapData]]` receiver of
    // the matching kind, reads its argument against the (canonicalized for Map;
    // pass-through for WeakMap) key, and — on absence — inserts (three entry
    // slots, the same metering `set` charges on either collection).
    // `getOrInsertComputed` calls the callback exactly once on absence with
    // `this` undefined and the key as its sole argument, then overwrites
    // whatever entry the callback itself may have inserted. The WeakMap forms
    // additionally reject a non-weakly-holdable key (a primitive) with a
    // TypeError *before* any callable check or insertion (spec order).
    // ------------------------------------------------------------------
    fn call_map_get_or_insert(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let (expected_kind, weak) = match m {
            NativeMethod::MapGetOrInsert | NativeMethod::MapGetOrInsertComputed => {
                (CollKind::Map, false)
            }
            NativeMethod::WeakMapGetOrInsert | NativeMethod::WeakMapGetOrInsertComputed => {
                (CollKind::WeakMap, true)
            }
            _ => {
                return Err(Step::Host(Halt::EngineInvariant(
                    "map-get-or-insert:unexpected-method",
                )))
            }
        };
        let inst = match self.collection_ref(this) {
            Some(i) if self.collections[&i].kind == expected_kind => i,
            _ => return Err(self.collection_brand_error(expected_kind, false)),
        };
        if self.slots.get(inst).flag & XS_DONT_MODIFY_FLAG != 0 {
            return Err(self.collection_brand_error(expected_kind, true));
        }
        let key_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // `CanBeHeldWeakly(key)` — a WeakMap key must be a reference (XS, like
        // this engine's `WeakMap.prototype.set`, admits objects only). Checked
        // before the callable check and before any lookup/insert.
        let key = self.normalize_coll_key(key_arg);
        if weak && key.kind != Kind::Reference {
            return Err(self.catchable_type_error_msg("key: not an object".into()));
        }
        match m {
            NativeMethod::MapGetOrInsert | NativeMethod::WeakMapGetOrInsert => {
                let value = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                if let Some(p) = self.collection_find(inst, &key) {
                    return Ok(self.collections[&inst].entries()[p].unwrap().1);
                }
                self.charge_new_entry_slots(3);
                self.collections.get_mut(&inst).unwrap().push_entry(
                    key,
                    value,
                    &mut self.side_refs,
                );
                self.collection_table_resize(inst);
                Ok(value)
            }
            NativeMethod::MapGetOrInsertComputed | NativeMethod::WeakMapGetOrInsertComputed => {
                let callbackfn = self
                    .stack
                    .get(base + 5)
                    .copied()
                    .unwrap_or_else(Slot::undefined);
                if !self.value_is_callable(callbackfn) {
                    return Err(self.catchable_type_error_msg("callback: not a function".into()));
                }
                if let Some(p) = self.collection_find(inst, &key) {
                    return Ok(self.collections[&inst].entries()[p].unwrap().1);
                }
                // `Call(callbackfn, undefined, « key »)`. The callback may mutate
                // the map (including inserting `key` itself); the computed value
                // then overwrites that entry.
                let value = self.run_callback(code, callbackfn, Slot::undefined(), &[key])?;
                match self.collection_find(inst, &key) {
                    Some(p) => {
                        self.collections.get_mut(&inst).unwrap().set_entry_value(
                            p,
                            value,
                            &mut self.side_refs,
                        );
                    }
                    None => {
                        self.charge_new_entry_slots(3);
                        self.collections.get_mut(&inst).unwrap().push_entry(
                            key,
                            value,
                            &mut self.side_refs,
                        );
                        self.collection_table_resize(inst);
                    }
                }
                Ok(value)
            }
            _ => Err(Step::Host(Halt::EngineInvariant(
                "map-get-or-insert:unexpected-method",
            ))),
        }
    }

    // ------------------------------------------------------------------
    // Array-grouping proposal: `Map.groupBy` / `Object.groupBy`. Both share the
    // `GroupBy(items, callbackfn, coercion)` skeleton — iterate `items`, call
    // `callbackfn(value, 𝔽(index))` per element, and bucket the values by key.
    // `Map.groupBy` uses `zero` coercion (SameValueZero, `-0`→`+0`) into a fresh
    // `Map` whose values are Arrays; `Object.groupBy` uses `property` coercion
    // (`? ToPropertyKey(key)`) into a fresh null-prototype object.
    // ------------------------------------------------------------------

    /// Read one member of an iterator result object's own `value`/`done`
    /// (through the cached ids the group-by widening force-bound).
    fn iter_result_member(&mut self, code: &[u8], result: Slot, done: bool) -> Result<Slot, Step> {
        let inst = match result.value {
            Payload::Reference(i) if result.kind == Kind::Reference => i,
            _ => return Err(self.catchable_type_error_msg("iterator result: not an object".into())),
        };
        let id = if done {
            match self.done_id {
                Some(v) => v,
                None => self.intern_key("done"),
            }
        } else {
            match self.value_id {
                Some(v) => v,
                None => self.intern_key("value"),
            }
        };
        self.ordinary_get(code, inst, id, result)
    }

    fn call_group_by(&mut self, m: NativeMethod, base: usize, code: &[u8]) -> Result<Slot, Step> {
        let is_map = matches!(m, NativeMethod::MapGroupBy);
        let items = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let callbackfn = self
            .stack
            .get(base + 5)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // fxGroupBy diagnoses the missing items/callback slots before its
        // callback and iterator checks (xsProperty.c).
        if items.kind == Kind::Undefined || callbackfn.kind == Kind::Undefined {
            return Err(self.catchable_type_error_msg("items: not an object".into()));
        }
        if !self.value_is_callable(callbackfn) {
            return Err(self.catchable_type_error_msg("callback: not a function".into()));
        }
        // Buckets in first-insertion order: (canonical key slot, values). For
        // the `property` coercion, `repr` is the SameValue-distinguishing key
        // identity (symbol descriptor vs string text) used to match buckets.
        let mut buckets: Vec<(Slot, Vec<Slot>)> = Vec::new();
        let mut reprs: Vec<(Option<u16>, Vec<u16>)> = Vec::new();
        let mut index: i32 = 0;

        // A closure would need `&mut self`, so record inline. `record` buckets
        // one produced value under the callback's (coerced) result.
        macro_rules! record {
            ($value:expr) => {{
                let value = $value;
                let key = self.run_callback(
                    code,
                    callbackfn,
                    Slot::undefined(),
                    &[value, Slot::integer(index)],
                )?;
                if is_map {
                    let key = self.normalize_coll_key(key);
                    match buckets
                        .iter()
                        .position(|(k, _)| self.same_value_zero(k, &key))
                    {
                        Some(p) => buckets[p].1.push(value),
                        None => buckets.push((key, vec![value])),
                    }
                } else {
                    let key = self.to_property_key_slot(code, key)?;
                    let repr = self.property_key_repr(key);
                    match reprs.iter().position(|r| *r == repr) {
                        Some(p) => buckets[p].1.push(value),
                        None => {
                            reprs.push(repr);
                            buckets.push((key, vec![value]));
                        }
                    }
                }
                index += 1;
            }};
        }

        // GetIterator(items) + the iterate/step loop, with the same intrinsic
        // fast paths `for..of` uses (dense array, string), and the generic
        // `@@iterator` protocol for everything else. Arrays/strings the tests
        // never re-decorate iterate observationally identically to the real
        // iterator; a plain object with a nullish/absent `@@iterator` throws.
        match items.value {
            Payload::Reference(i) if self.arrays.contains_key(&i) => {
                let mut k = 0u32;
                loop {
                    let len = match self.arrays.get(&i) {
                        Some(a) => a.length,
                        None => break,
                    };
                    if k >= len {
                        break;
                    }
                    let value = self
                        .arrays
                        .get(&i)
                        .and_then(|a| a.items().get(&k))
                        .copied()
                        .unwrap_or_else(Slot::undefined);
                    record!(value);
                    k += 1;
                }
            }
            Payload::String(off) if items.kind == Kind::String => {
                let bytes = self.str_content(off).to_vec();
                let it = self.make_string_iterator(bytes);
                let iter_inst = match it.value {
                    Payload::Reference(x) => x,
                    _ => {
                        return Err(Step::Host(Halt::EngineInvariant(
                            "group-by:invalid-string-iterator",
                        )))
                    }
                };
                loop {
                    let result = self.string_iterator_next(iter_inst)?;
                    let done = self.iter_result_member(code, result, true)?;
                    if self.truthy(&done) {
                        break;
                    }
                    let value = self.iter_result_member(code, result, false)?;
                    record!(value);
                }
            }
            Payload::Reference(obj) => {
                // GetIterator(items, sync): `method = ? GetMethod(items,
                // @@iterator)`; a nullish/absent method throws TypeError.
                let iter_id = self
                    .well_known_symbol_property_id("iterator")
                    .unwrap_or(crate::value::XS_NO_ID);
                let method = if iter_id == crate::value::XS_NO_ID {
                    Slot::undefined()
                } else {
                    self.ordinary_get(code, obj, iter_id, items)?
                };
                if method.kind == Kind::Undefined || method.kind == Kind::Null {
                    return Err(self.catchable_type_error_msg("call: not a function".into()));
                }
                let iterator = self.call_primitive_method(code, method, items, &[])?;
                let iter_inst = match iterator.value {
                    Payload::Reference(x) if iterator.kind == Kind::Reference => x,
                    _ => {
                        return Err(self.catchable_type_error_msg("iterator: not an object".into()))
                    }
                };
                let next_id = self.intern_key("next");
                let next = self.ordinary_get(code, iter_inst, next_id, iterator)?;
                // A defensive bound against a pathological non-terminating guest
                // iterator; the tested iterables are short.
                for _ in 0..1_000_000 {
                    let step = self.call_primitive_method(code, next, iterator, &[])?;
                    let done = self.iter_result_member(code, step, true)?;
                    if self.truthy(&done) {
                        break;
                    }
                    let value = self.iter_result_member(code, step, false)?;
                    record!(value);
                }
            }
            _ if items.kind == Kind::Null => {
                return Err(self.catchable_type_error_msg("cannot coerce null to object".into()))
            }
            _ => return Err(self.catchable_type_error_msg("call: not a function".into())),
        }

        if is_map {
            Ok(self.new_map_from_buckets(buckets))
        } else {
            self.new_group_object_from_buckets(code, buckets)
        }
    }

    /// `? ToPropertyKey(key)` reduced to the canonical property-key VALUE (a
    /// Symbol slot, or a String slot) rather than an interned id, so the bucket
    /// preserves the key for a later `CreateDataPropertyOrThrow`.
    fn to_property_key_slot(&mut self, code: &[u8], key: Slot) -> Result<Slot, Step> {
        if key.kind == Kind::Symbol {
            return Ok(key);
        }
        let prim = self.to_primitive(code, key, true)?;
        if prim.kind == Kind::Symbol {
            return Ok(prim);
        }
        Ok(self.to_string_slot_metered(prim))
    }

    /// Disjoint identities for string and symbol property keys.
    fn property_key_repr(&mut self, key: Slot) -> (Option<u16>, Vec<u16>) {
        match key.value {
            Payload::Reference(desc) if key.kind == Kind::Symbol => {
                (Some(self.intern_symbol_key(desc)), Vec::new())
            }
            Payload::String(off) if key.kind == Kind::String => (None, self.str_units(off)),
            _ => unreachable!("ToPropertyKey must produce a string or symbol"),
        }
    }

    /// Build a fresh `%Map.prototype%` Map whose entries are the group-by
    /// buckets (each value an Array of that bucket's elements), charging the
    /// same allocation metering the `new Map` constructor path charges.
    fn new_map_from_buckets(&mut self, buckets: Vec<(Slot, Vec<Slot>)>) -> Slot {
        self.meter.tick_raw(MAP_CTOR_FRAME_METERING);
        self.meter.tick_slot_alloc(); // instance
        self.meter.tick_slot_alloc(); // table
        self.meter.tick_slot_alloc(); // list
        self.meter.tick_slot_alloc(); // size
        self.meter.tick_chunk_new(MAP_MIN_TABLE_LENGTH as u64 * 8);
        let inst = self.slots.alloc(Slot::instance(self.map_proto));
        self.collections.insert(
            inst,
            CollectionData::new(CollKind::Map, MAP_MIN_TABLE_LENGTH),
        );
        for (key, values) in buckets {
            let array = self.group_array_from_values(values);
            self.charge_new_entry_slots(3);
            self.collections
                .get_mut(&inst)
                .unwrap()
                .push_entry(key, array, &mut self.side_refs);
            self.collection_table_resize(inst);
        }
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// Build the null-prototype ordinary object `Object.groupBy` returns: one
    /// own enumerable data property per bucket (key from the coerced property
    /// key, value the bucket's Array). Integer-index keys order ahead of string
    /// keys per the engine's ordinary-object enumeration, matching XS.
    fn new_group_object_from_buckets(
        &mut self,
        code: &[u8],
        buckets: Vec<(Slot, Vec<Slot>)>,
    ) -> Result<Slot, Step> {
        let obj = self.new_object();
        // OrdinaryObjectCreate(null): a null prototype.
        self.slots.get_mut(obj).value = Payload::Reference(crate::value::SlotIndex::NULL);
        let obj_slot = Slot::of(Kind::Reference, Payload::Reference(obj));
        for (key, values) in buckets {
            let array = self.group_array_from_values(values);
            let at = match key.kind {
                Kind::Symbol => {
                    let id = match key.value {
                        Payload::Reference(desc) => self.intern_symbol_key(desc),
                        _ => {
                            return Err(Step::Host(Halt::EngineInvariant(
                                "group-by:invalid-symbol-key",
                            )))
                        }
                    };
                    Slot::of(Kind::At, Payload::At(id, 0))
                }
                Kind::String => {
                    let s = match key.value {
                        Payload::String(off) => SymbolName::from_units(&self.str_units(off)),
                        _ => {
                            return Err(Step::Host(Halt::EngineInvariant(
                                "group-by:invalid-string-key",
                            )))
                        }
                    };
                    if let Some(idx) = s.as_str().and_then(string_to_index) {
                        Slot::of(Kind::At, Payload::At(crate::value::XS_NO_ID, idx))
                    } else {
                        let id = self.intern_key(&s);
                        Slot::of(Kind::At, Payload::At(id, 0))
                    }
                }
                _ => {
                    return Err(Step::Host(Halt::EngineInvariant(
                        "group-by:invalid-key-kind",
                    )))
                }
            };
            // CreateDataPropertyOrThrow (enumerable/writable/configurable own).
            self.property_at_set(code, obj_slot, at, array, true)?;
        }
        Ok(obj_slot)
    }

    /// A fresh dense `%Array.prototype%` Array holding a bucket's values,
    /// charging the array-create metering the `[..]` literal path charges.
    fn group_array_from_values(&mut self, values: Vec<Slot>) -> Slot {
        let inst = self.new_array();
        let n = values.len() as u32;
        for (i, v) in values.into_iter().enumerate() {
            self.meter.tick_raw(ARRAY_ITEM_DEFINE_STEP_METERING);
            let mut v = v;
            v.id = 0;
            v.next = crate::value::SlotIndex::NULL;
            self.arrays
                .get_mut(&inst)
                .unwrap()
                .insert_item(i as u32, v, &mut self.side_refs);
        }
        self.arrays.get_mut(&inst).unwrap().length = n;
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    /// `fx_String_prototype_iterator_next`: decode the next code point at the
    /// byte offset `index`, yield it as a fresh one-character string, and
    /// advance `index` past its bytes. BMP code points only (a single UTF-8
    /// sequence); an astral/surrogate sequence self-names an honest skip (its
    /// yielding astral code points by recombining surrogate pairs). Meters the
    /// per-`next()` base plus the yielded string's chunk allocation.
    fn string_iterator_next(&mut self, iter: crate::value::SlotIndex) -> Result<Slot, Step> {
        let st = self.iterators[&iter].clone();
        let result = st.result;
        let (new_value, new_done, next_index): (Slot, bool, u32) =
            if st.done || (st.index as usize) >= st.str_bytes.len() {
                (Slot::undefined(), true, st.index)
            } else {
                // `index` is a BYTE offset into the UTF-16BE payload; each yielded
                // code point consumes one code unit (2 bytes) or, for a valid
                // surrogate pair, two (4 bytes) — `for...of` iterates by code point.
                let i = st.index as usize;
                if i + 2 > st.str_bytes.len() {
                    return Err(Step::Host(Halt::EngineInvariant(
                        "string-iterator:truncated-sequence",
                    )));
                }
                let hi = u16::from_be_bytes([st.str_bytes[i], st.str_bytes[i + 1]]);
                let consumed = if (0xD800..=0xDBFF).contains(&hi) && i + 4 <= st.str_bytes.len() {
                    let lo = u16::from_be_bytes([st.str_bytes[i + 2], st.str_bytes[i + 3]]);
                    if (0xDC00..=0xDFFF).contains(&lo) {
                        4 // a valid surrogate pair → one astral code point
                    } else {
                        2 // a lone high surrogate → yielded as its own code unit
                    }
                } else {
                    2
                };
                // The yielded string is exactly the consumed BE bytes (already the
                // stored form). Metered by yielded code-unit length (`+1`), the
                // re-based O(n) weight; ASCII yields meter identically to before.
                self.meter.tick_raw(STRING_ITERATOR_NEXT_METERING);
                self.charge_chunk_work((consumed / 2 + 1) as u64)?;
                let off = self.chunks.alloc(&st.str_bytes[i..i + consumed]);
                (
                    Slot::of(Kind::String, Payload::String(off)),
                    false,
                    st.index + consumed as u32,
                )
            };
        if let Some(s) = self.iterators.get_mut(&iter) {
            s.index = next_index;
            s.done = new_done;
        }
        if let Some(vid) = self.value_id {
            self.set_own_unmetered(result, vid, Slot::of(new_value.kind, new_value.value));
        }
        if let Some(did) = self.done_id {
            self.set_own_unmetered(result, did, Slot::boolean(new_done));
        }
        Ok(Slot::of(Kind::Reference, Payload::Reference(result)))
    }

    /// Build a for-in enumerator over `obj` (XS's `fx_Enumerator`): collect the
    /// object's enumerable own-then-inherited string keys in XS enumeration
    /// order (integer indices ascending, then string keys in insertion order,
    /// per prototype level, skipping shadowed keys), and record them as an
    /// enumerator [`IterState`] (kind 3) whose `next()` yields each as a
    /// string. Meters the creation cluster ([`FOR_IN_ENUMERATOR_METERING`]);
    /// each yielded key's string allocation is metered in `next()`.
    fn make_enumerator(&mut self, obj: crate::value::SlotIndex) -> Slot {
        self.meter.tick_raw(FOR_IN_ENUMERATOR_METERING);
        if self.arrays.contains_key(&obj) {
            self.meter.tick_raw(ARRAY_FOR_IN_EXTRA_METERING);
        }
        let keys = self.enumerable_keys(obj);
        let result = self.slots.alloc(Slot::instance(self.object_proto));
        if let Some(vid) = self.value_id {
            self.set_own_unmetered(result, vid, Slot::undefined());
        }
        if let Some(did) = self.done_id {
            self.set_own_unmetered(result, did, Slot::boolean(false));
        }
        let iter = self.slots.alloc(Slot::instance(self.array_iterator_proto));
        self.iterators.insert(
            iter,
            IterState {
                iterable: obj,
                index: 0,
                kind: 3,
                generation: 0,
                result,
                done: false,
                enum_keys: std::rc::Rc::new(keys),
                str_bytes: std::rc::Rc::default(),
            },
        );
        Slot::of(Kind::Reference, Payload::Reference(iter))
    }

    /// The enumerable own-then-inherited string keys of `obj` in XS for-in
    /// order, as `(id, index)` pairs (`id == XS_NO_ID` ⇒ an array index). For
    /// an array: the present item indices ascending. For an ordinary object:
    /// its own string-named properties in insertion order. The prototype chain
    /// is walked (skipping already-seen keys), but the covered grammar's
    /// prototypes (`%Object.prototype%` / `%Array.prototype%`) carry no
    /// enumerable data properties, so only own keys appear.
    fn enumerable_keys(&self, obj: crate::value::SlotIndex) -> Vec<(u16, u32)> {
        let mut out: Vec<(u16, u32)> = Vec::new();
        let mut seen: std::collections::HashSet<(u16, u32)> = std::collections::HashSet::new();
        let mut cur = obj;
        while !cur.is_null() {
            // A String wrapper's units and a TypedArray's elements are
            // enumerable own keys, and XS queues them ahead of the named chain
            // (`fxStringOwnKeys`, `fxTypedArrayOwnKeys`). Neither had an arm
            // here, so `for (k in new String('ab'))` and `for (k in new
            // Uint8Array(2))` yielded nothing at all — while `Object.keys` on
            // the same receiver answered correctly, which is the same one
            // property, two answers split that the index-read work has been
            // closing everywhere else.
            if let Some(Slot {
                kind: Kind::String,
                value: Payload::String(offset),
                ..
            }) = self.wrapper_data.get(&cur).copied()
            {
                for index in 0..self.str_len(offset) as u32 {
                    let k = (crate::value::XS_NO_ID, index);
                    if seen.insert(k) {
                        out.push(k);
                    }
                }
            }
            if let Some(&ta) = self.typed_arrays.get(&cur) {
                let length = if self.detached_buffers.contains(&ta.buffer) {
                    0
                } else {
                    ta.length
                };
                for index in 0..length {
                    let k = (crate::value::XS_NO_ID, index);
                    if seen.insert(k) {
                        out.push(k);
                    }
                }
            }
            // An ordinary object's index properties, ascending, ahead of its
            // named chain — the enumeration order `fxOrdinaryOwnKeys` gives.
            if let Some(props) = self.index_props.get(&cur) {
                for (&index, item) in props.items() {
                    if item.flag & XS_DONT_ENUM_FLAG != 0 {
                        continue;
                    }
                    let k = (crate::value::XS_NO_ID, index);
                    if seen.insert(k) {
                        out.push(k);
                    }
                }
            }
            // Array index keys first (ascending), then string keys.
            if let Some(a) = self.arrays.get(&cur) {
                // A non-enumerable ITEM is skipped, exactly as the
                // non-enumerable named property below is. Items could not
                // carry `XS_DONT_ENUM_FLAG` in practice while
                // `array_define_index` promoted an attributed element out of
                // the map, so the filter was never needed here; now that such
                // an element stays an item, `for-in` over
                // `Object.defineProperty(a, '1', {enumerable: false})` would
                // otherwise yield the key that `Object.keys` correctly omits.
                let mut idxs: Vec<u32> = a
                    .items()
                    .iter()
                    .filter(|(_, item)| item.flag & XS_DONT_ENUM_FLAG == 0)
                    .map(|(index, _)| *index)
                    .collect();
                idxs.sort_unstable();
                for i in idxs {
                    let k = (crate::value::XS_NO_ID, i);
                    if seen.insert(k) {
                        out.push(k);
                    }
                }
            }
            // Own string-named properties, in insertion order. The property
            // list is prepend-ordered (newest first), so collect and reverse.
            let mut names: Vec<(u16, u32)> = Vec::new();
            let mut p = self.slots.get(cur).next;
            while !p.is_null() {
                let s = self.slots.get(p);
                // Symbol-keyed properties are excluded from for-in per
                // EnumerateObjectProperties (and XS agrees); before this
                // filter a symbol-keyed enumerable own property yielded a
                // phantom "" key (the unmapped id rendered empty).
                if s.id != crate::value::XS_NO_ID
                    && s.flag & XS_DONT_ENUM_FLAG == 0
                    && !self.is_symbol_key_id(s.id)
                {
                    names.push((s.id, 0));
                }
                p = s.next;
            }
            names.reverse();
            for k in names {
                if seen.insert(k) {
                    out.push(k);
                }
            }
            cur = self.instance_prototype(cur);
        }
        out
    }

    /// `fx_Enumerator_prototype_next` for a for-in enumerator: yield the next
    /// enumerable key as a string, mutating and returning the reused result
    /// object. Meters the per-`next()` base plus the yielded key's string
    /// allocation.
    fn enumerator_next(&mut self, iter: crate::value::SlotIndex) -> Slot {
        let st = self.iterators[&iter].clone();
        let result = st.result;
        let (new_value, new_done, next_index): (Slot, bool, u32) =
            if st.done || (st.index as usize) >= st.enum_keys.len() {
                (Slot::undefined(), true, st.index)
            } else {
                self.meter.tick_raw(ENUMERATOR_NEXT_METERING);
                let (id, idx) = st.enum_keys[st.index as usize];
                // The key string: an array index renders as a fresh decimal
                // (`fxKeyAt` allocates it, metered per byte + NUL); a named key
                // reuses its interned symbol name (no run-time allocation in
                // XS, so ironhorse allocates the chunk it needs to produce the
                // value but does NOT meter it).
                let bytes: Vec<u8> = if id == crate::value::XS_NO_ID {
                    let b = number_to_ecma_string(idx as f64).into_bytes();
                    self.meter.tick_string(b.len() as u64);
                    b
                } else {
                    self.symbol_names
                        .get(id as usize - 1)
                        .cloned()
                        .unwrap_or_default()
                        .as_bytes()
                        .to_vec()
                };
                let off = self.chunks.alloc(&units_to_be16(&cesu8_to_units(&bytes)));
                (
                    Slot::of(Kind::String, Payload::String(off)),
                    false,
                    st.index + 1,
                )
            };
        if let Some(s) = self.iterators.get_mut(&iter) {
            s.index = next_index;
            s.done = new_done;
        }
        if let Some(vid) = self.value_id {
            self.set_own_unmetered(result, vid, Slot::of(new_value.kind, new_value.value));
        }
        if let Some(did) = self.done_id {
            self.set_own_unmetered(result, did, Slot::boolean(new_done));
        }
        Slot::of(Kind::Reference, Payload::Reference(result))
    }

    /// Whether an ordinary prototype walk reaches exactly the expected native
    /// data method before any Proxy or other property. This is the conservative
    /// gate for fast paths that would otherwise bypass an observable `Get`.
    fn chain_resolves_native_data_method(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
        expected: NativeMethod,
    ) -> bool {
        let mut current = inst;
        while !current.is_null() {
            if self.proxies.contains_key(&current) {
                return false;
            }
            if let Some(property) = self.find_property(current, id) {
                return match self.slots.get(property).value {
                    Payload::Reference(function) => self.method_of(function) == Some(expected),
                    _ => false,
                };
            }
            current = self.instance_prototype(current);
        }
        false
    }

    /// `ToIntegerOrInfinity(? ToNumber(v))` (ECMA-262 7.1.5): `NaN` → 0,
    /// infinities pass through, else truncate toward zero.
    /// `String.prototype.lastIndexOf`'s position coercion (ECMA-262 22.1.3.9
    /// steps 4-6): `ToNumber(position)`, and then **any** NaN becomes
    /// `+INFINITY` -- the whole string is searched -- where
    /// [`Self::array_to_integer_or_infinity`] maps NaN to 0.
    ///
    /// Step 5 only *asserts* that an `undefined` position is NaN; it is not the
    /// sole way to get there. `"abcabc".lastIndexOf("a", NaN)`,
    /// `..., "zzz")` and `..., {})` are all NaN and all answer 3, and sharing
    /// the array rule started them at 0 instead. `indexOf` genuinely wants
    /// NaN to 0, so only this branch is affected.
    ///
    /// The coercion is observable, so this repeats the body rather than
    /// calling `ToNumber` a second time to inspect it.
    fn string_last_index_of_position(&mut self, code: &[u8], v: Slot) -> Result<f64, Step> {
        let n = self.to_number_f64(code, v)?;
        if n.is_nan() {
            Ok(f64::INFINITY)
        } else if n.is_infinite() {
            Ok(n)
        } else {
            Ok(n.trunc())
        }
    }

    /// Strict equality (`===`) with chunk-aware string comparison: two heap
    /// strings are equal iff their UTF-16BE content matches (the free
    /// [`strict_equals`] compares only primitive/reference kinds and treats
    /// two strings as unequal because it cannot see the chunk arena).
    fn strict_equal(&self, a: &Slot, b: &Slot) -> bool {
        match (a.value, b.value) {
            (Payload::String(x), Payload::String(y)) => {
                // Two-chunk read: only through the arena's guarded
                // comparison (lazy-heap borrow discipline).
                self.chunks.compare_payloads(x, y) == std::cmp::Ordering::Equal
            }
            // `bigint === bigint`: equal iff same sign and magnitude. A BigInt
            // is never `===` a non-BigInt (distinct type), which
            // `strict_equals` already gives.
            (Payload::BigInt(x), Payload::BigInt(y)) => {
                let (nx, mx) = self.read_bigint(x);
                let (ny, my) = self.read_bigint(y);
                nx == ny && mx == my
            }
            _ => strict_equals(a, b),
        }
    }

    /// SameValueZero (`includes`): strict equality except `NaN` equals `NaN`
    /// (and `+0`/`-0` are equal, which strict equality already gives).
    fn same_value_zero(&self, a: &Slot, b: &Slot) -> bool {
        if let (Some(x), Some(y)) = (numeric_of(a), numeric_of(b)) {
            if x.is_nan() && y.is_nan() {
                return true;
            }
        }
        self.strict_equal(a, b)
    }

    /// If `this` is a reference to a Map/Set/WeakMap/WeakSet instance, its
    /// slot index; else `None`.
    fn collection_ref(&self, this: Slot) -> Option<crate::value::SlotIndex> {
        match this.value {
            Payload::Reference(r) if self.collections.contains_key(&r) => Some(r),
            _ => None,
        }
    }

    /// ES2025 `SetterThatIgnoresPrototypeProperties`, specialized to the two
    /// accessor properties on `%Iterator.prototype%`. An inherited assignment
    /// creates a normal own data property instead of recursing back into this
    /// setter; an existing own descriptor receives ordinary strict `Set`
    /// semantics. Assignment to the home prototype itself is rejected.
    fn iterator_prototype_setter(
        &mut self,
        code: &[u8],
        method: NativeMethod,
        this: Slot,
        value: Slot,
    ) -> Result<Slot, Step> {
        let name = match method {
            NativeMethod::IteratorConstructorSetter => "constructor",
            NativeMethod::IteratorToStringTagSetter => "Symbol(toStringTag)",
            _ => unreachable!("only Iterator prototype setters dispatch here"),
        };
        let inst = match this.value {
            Payload::Reference(inst) if this.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error_msg(format!("set {name}: not an object"))),
        };
        if inst == self.iterator_proto {
            return Err(self.catchable_type_error_msg(format!("set {name}: not writable")));
        }
        let id = match method {
            NativeMethod::IteratorConstructorSetter => self.intern_key_unmetered("constructor"),
            NativeMethod::IteratorToStringTagSetter => self
                .well_known_symbol_property_id("toStringTag")
                .ok_or(Step::Host(Halt::EngineInvariant(
                    "Iterator.setter:missing-toStringTag",
                )))?,
            _ => unreachable!("only Iterator prototype setters dispatch here"),
        };
        let existing = self.mop_get_own_property(code, inst, id)?.is_some();
        let accepted = if existing {
            // `SetterThatIgnoresPrototypeProperties` step 5 is an ordinary
            // `Set`, so a receiver carrying its own copy of this very accessor
            // re-enters this native unboundedly -- without ever passing through
            // `dispatch_at`. The native-recursion budget bounds it all the same:
            // every level passes through `mop_set` (a light frame) and back into
            // `call_native_method` (a heavy one). The pinned XS does not
            // complete this program either (it aborts at ~8180 computrons); the
            // point is to degrade to a `Halt::StackOverflow` the host can
            // observe rather than overflowing the real thread stack and taking
            // the process down.
            self.mop_set(code, inst, id, value, this)?
        } else {
            self.mop_define_own_property(
                code,
                inst,
                id,
                OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                },
            )?
        };
        if !accepted {
            let reason = if existing {
                "not writable"
            } else {
                "not extensible"
            };
            return Err(self.catchable_type_error_msg(format!("set {name}: {reason}")));
        }
        Ok(Slot::undefined())
    }

    /// `OrdinarySetWithOwnDescriptor` for a **writable data** ownDesc against a
    /// distinct `receiver` (ECMA-262 10.1.9.2 steps 3.a–3.e): the integer-
    /// indexed `[[Set]]`'s valid-index-but-receiver-differs continuation. The
    /// value is stored on the receiver (never on the source view, never
    /// coerced through the source's element type). Both the existing-property
    /// probe and the final definition use the receiver's full internal-method
    /// dispatch, preserving Array, String, TypedArray, and Proxy exotics.
    fn set_data_on_receiver(
        &mut self,
        code: &[u8],
        receiver: Slot,
        key: Slot,
        value: Slot,
    ) -> Result<bool, Step> {
        let robj = match receiver.value {
            Payload::Reference(r) if receiver.kind == Kind::Reference => r,
            _ => return Ok(false),
        };
        let id = self.to_property_id(code, key)?;
        match self.mop_get_own_property(code, robj, id)? {
            Some(existing) => {
                if existing.is_accessor() || existing.writable == Some(false) {
                    return Ok(false);
                }
                let desc = OrdinaryDescriptor {
                    value: Some(value),
                    ..OrdinaryDescriptor::default()
                };
                self.mop_define_own_property(code, robj, id, desc)
            }
            None => {
                let desc = OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                };
                self.mop_define_own_property(code, robj, id, desc)
            }
        }
    }

    /// `ToBigInt(value)` reduced to the low 64 bits a BigInt64/BigUint64 store
    /// keeps (two's complement). Runs `ToPrimitive(number)` on an object first,
    /// then: a BigInt takes its low limbs; a Boolean is `1n`/`0n`; a String
    /// parses as a `StringIntegerLiteral` (a non-integer body throws
    /// `SyntaxError`); a Number/Symbol/`undefined`/`null` throws `TypeError`.
    fn to_bigint_low64(&mut self, code: &[u8], value: Slot) -> Result<u64, Step> {
        let primitive = self.to_primitive(code, value, false)?;
        match primitive.kind {
            Kind::BigInt => Ok(self
                .slot_to_bigint_u64(primitive)
                .expect("a BigInt primitive reduces to its low 64 bits")),
            Kind::Boolean => Ok(matches!(primitive.value, Payload::Boolean(true)) as u64),
            Kind::String => {
                let text = match primitive.value {
                    Payload::String(off) => self.str_text(off),
                    _ => return Err(Step::Host(Halt::EngineInvariant("to-bigint:string"))),
                };
                // `StringToBigInt`: an integer body (decimal or `0x`/`0o`/`0b`,
                // empty ⇒ `0n`) reduced to the low 64 bits; a non-integer body
                // (a fraction, exponent, `n` suffix, or junk) is a SyntaxError.
                match parse_bigint_string_u64(&text) {
                    Some(u) => Ok(u),
                    None => Err(self.catchable_syntax_error_with_message(
                        "cannot coerce string to bigint".into(),
                    )),
                }
            }
            // A Number, a Symbol, undefined, and null are each a TypeError.
            _ => Err(self.catchable_type_error_msg(
                match primitive.kind {
                    Kind::Integer | Kind::Number => "cannot coerce number to bigint",
                    Kind::Symbol => "cannot coerce symbol to bigint",
                    _ => "cannot coerce to bigint",
                }
                .into(),
            )),
        }
    }

    /// `ToBigInt(value)` reduced to its low 64 bits (the value modulo 2^64,
    /// two's complement — what a BigInt64/BigUint64 store keeps). A BigInt
    /// takes its two low limbs (negated for a negative value); a Boolean is
    /// `1n`/`0n`. Returns `None` for a type that needs general coercion (a
    /// Number `TypeError`, a String parse, an object `ToPrimitive`), so the
    /// caller self-names a skip.
    fn slot_to_bigint_u64(&self, value: Slot) -> Option<u64> {
        match value.value {
            Payload::BigInt(off) => {
                let (neg, mag) = self.read_bigint(off);
                let mut u: u64 = 0;
                if let Some(&l0) = mag.first() {
                    u |= l0 as u64;
                }
                if let Some(&l1) = mag.get(1) {
                    u |= (l1 as u64) << 32;
                }
                Some(if neg { u.wrapping_neg() } else { u })
            }
            Payload::Boolean(b) => Some(b as u64),
            _ => None,
        }
    }

    /// XS's `fxArgToByteLength(argi, length)`: coerce call argument `argi`
    /// (at `stack[base + 4 + argi]`) to a non-negative byte length. Returns
    /// `Some(default)` when the argument is absent/`undefined`, `Some(v)` for
    /// a non-negative integer or a truncated in-range number (NaN → 0), and
    /// `None` when the value is negative/oversized (a RangeError in XS) or a
    /// kind needing general ToNumber coercion — an honest skip for the
    /// caller. The `default` is only returned for an absent/undefined arg.
    fn arg_to_byte_length(&self, base: usize, argi: usize, default: u32) -> Option<u32> {
        let a = self
            .stack
            .get(base + 4 + argi)
            .copied()
            .unwrap_or_else(Slot::undefined);
        match a.kind {
            Kind::Undefined => Some(default),
            Kind::Integer => match a.value {
                Payload::Integer(i) if i >= 0 => Some(i as u32),
                _ => None,
            },
            Kind::Number => match a.value {
                Payload::Number(n) => {
                    let t = n.trunc();
                    if t.is_nan() {
                        Some(0)
                    } else if t < 0.0 || t > 0x7FFF_FFFFu32 as f64 {
                        None
                    } else {
                        Some(t as u32)
                    }
                }
                _ => None,
            },
            _ => None,
        }
    }

    /// `ToIndex(value)` (ECMA-262 7.1.22) for a buffer byte length that needs
    /// the **general** coercion path (a boolean / string / object argument,
    /// whose `valueOf`/`toString` must be observed). Distinct from the
    /// integer/number fast paths the constructors keep inline (whose exact
    /// metering the meter-exact corpus pins); this arm is reached only where the
    /// old code self-named an honest `coerce-length` skip. Raises realm-local,
    /// **catchable** errors exactly where XS does: a `Symbol`/`BigInt` argument
    /// throws `TypeError` (its `ToNumber` step), and a negative or
    /// over-`0x7FFFFFFF` result throws `RangeError` (XS's `fxToBigInt`/allocation
    /// ceiling — a byte length above the max chunk size cannot be a backing
    /// store). Returns the clamped `u32`, or a `Halt` (a `Resume` to the catch
    /// target, or an escaping `Throw`) the caller propagates with `?`.
    fn to_index_arg(&mut self, code: &[u8], value: Slot) -> Result<u32, Step> {
        let n = self.to_number_f64(code, value)?;
        let t = if n.is_nan() { 0.0 } else { n.trunc() };
        if t < 0.0 {
            return Err(self.catchable_range_error_msg("byteLength < 0".into()));
        }
        if t > 0x7FFF_FFFFu32 as f64 {
            return Err(self.catchable_range_error_msg("byteLength too big".into()));
        }
        Ok(t as u32)
    }

    /// `fxCheckMapKey`: normalize a collection key so `-0` is stored/compared
    /// as `+0` (every other value is unchanged; SameValueZero already unifies
    /// `NaN`).
    fn normalize_coll_key(&self, key: Slot) -> Slot {
        match key.value {
            Payload::Number(n) if n == 0.0 => Slot::number(0.0),
            _ => key,
        }
    }

    /// Canonicalize exactly the equality relation used by collection keys.
    /// This is host bookkeeping only; it introduces no guest allocations or
    /// metering changes and holds no arena borrow across another chunk read.
    fn coll_index_key(&self, key: &Slot) -> CollKey {
        match key.value {
            Payload::None => CollKey::Empty(key.kind as u8),
            Payload::Boolean(value) => CollKey::Boolean(value),
            Payload::Integer(value) => CollKey::Number((value as f64).to_bits()),
            Payload::Number(value) => CollKey::Number(if value == 0.0 {
                0
            } else {
                crate::value::canonicalize_nan(value).to_bits()
            }),
            Payload::String(off) => CollKey::String(self.chunks.payload(off).to_vec()),
            Payload::BigInt(off) => {
                let (negative, magnitude) = self.read_bigint(off);
                CollKey::BigInt(negative, magnitude)
            }
            Payload::Reference(reference) => CollKey::Reference(reference),
            Payload::At(..) => unreachable!("internal property key in a collection"),
        }
    }

    /// The index of `key` among `inst`'s entries by SameValueZero, or `None`.
    fn collection_find(&self, inst: crate::value::SlotIndex, key: &Slot) -> Option<usize> {
        let data = self.collections.get(&inst)?;
        data.find(&self.coll_index_key(key), |key| self.coll_index_key(key))
    }

    /// Charge the metering of an inserting `fxSetEntry`/`fxSetWeakEntry` new
    /// entry of `n` slots: the `fxNewSlot` base (`XS_SLOT_ALLOCATION_METERING`)
    /// per slot, plus [`COLLECTION_SLOT_LINK_METERING`] for each slot beyond the
    /// first (the measured per-linked-slot residual). The rehash chunk, if any,
    /// is charged separately by [`Self::collection_table_resize`].
    fn charge_new_entry_slots(&mut self, n: u64) {
        for _ in 0..n {
            self.meter.tick_slot_alloc();
        }
        self.meter.tick_raw((n - 1) * COLLECTION_SLOT_LINK_METERING);
    }

    /// `fxResizeEntries` after a Map/Set size change: grow/shrink the
    /// power-of-two address array and, when its length changes, charge the
    /// `fxNewChunk(currentLength * 8)` — the rehash's only allocation. A weak
    /// collection has no table, so this is a no-op for it.
    fn collection_table_resize(&mut self, inst: crate::value::SlotIndex) {
        let (former, size) = {
            let data = &self.collections[&inst];
            if data.kind == CollKind::WeakMap || data.kind == CollKind::WeakSet {
                return;
            }
            (data.table_length, data.live_len() as u32)
        };
        // mxTableThreshold(L) = (L>>1) + (L>>2); high = threshold, low = high>>1.
        let high = (former >> 1) + (former >> 2);
        let low = high >> 1;
        let mut current = former;
        if high < size {
            current = former << 1;
            let max = 1024 * 1024;
            if current > max {
                current = max;
            }
        } else if low >= size {
            current = former >> 1;
            if current < MAP_MIN_TABLE_LENGTH {
                current = MAP_MIN_TABLE_LENGTH;
            }
        }
        if current != former {
            self.meter.tick_chunk_new(current as u64 * 8);
            // The first grow away from the minimum-length (1) address array
            // carries a measured one-time `+8` raw over the plain
            // `fxNewChunk(current * 8)` (the length-1 array the fresh
            // instance's `fxNewChunk(mxTableMinLength * 8)` created is released
            // as the new one is installed). Raw-exact against the pin.
            if former == MAP_MIN_TABLE_LENGTH && current > former {
                self.meter.tick_raw(MAP_FIRST_GROW_METERING);
            }
            self.collections.get_mut(&inst).unwrap().table_length = current;
        }
    }

    /// `fxArgToIndex`: the argument at `base`+`argi` coerced to a relative
    /// index in `[0, length]` (negative counts from the end, clamped). Absent
    /// or `undefined` uses `default`. The covered grammar passes small
    /// non-negative integers.
    fn arg_to_index(&self, base: usize, argi: usize, default: u32, length: u32) -> u32 {
        let a = self.stack.get(base + 4 + argi).copied();
        let n = match a {
            None => return default,
            Some(s) if s.kind == Kind::Undefined => return default,
            Some(s) => match numeric_of(&s) {
                Some(n) => n,
                None => return default,
            },
        };
        if n.is_nan() {
            return 0;
        }
        let t = n.trunc();
        if t < 0.0 {
            let from_end = length as f64 + t;
            if from_end < 0.0 {
                0
            } else {
                from_end as u32
            }
        } else if t > length as f64 {
            length
        } else {
            t as u32
        }
    }

    /// Apply the constructor-specific completion rules associated with the
    /// body's terminating opcode. In particular a derived constructor may
    /// return an object directly, but otherwise must have initialized `this`
    /// with `super()` and may not return a different primitive.
    fn end_completion(&mut self, op: Opcode) -> Result<Slot, Step> {
        // An arrow frame may carry `mxFrameHasTarget` solely so its lexical
        // `new.target` is observable. It is still an ordinary call: XS's
        // `END_ARROW` always returns `mxFrameResult` and never substitutes the
        // captured `this` as a constructor completion.
        if op == Opcode::XS_CODE_END_ARROW {
            return Ok(self.result);
        }
        if !self.cur_target {
            return Ok(self.result);
        }
        match op {
            Opcode::XS_CODE_END_DERIVED => {
                if self.result.kind == Kind::Reference {
                    Ok(self.result)
                } else if self.result.kind == Kind::Undefined {
                    if self.this_val.kind == Kind::Uninitialized {
                        let error =
                            self.internal_error("ReferenceError", "this: not initialized".into());
                        Err(self.raise_js(error))
                    } else {
                        Ok(self.this_val)
                    }
                } else {
                    let error =
                        self.internal_error("TypeError", "result: invalid constructor".into());
                    Err(self.raise_js(error))
                }
            }
            _ if self.result.kind != Kind::Reference => Ok(self.this_val),
            _ => Ok(self.result),
        }
    }

    /// Leave a user-function call (`XS_CODE_END`): restore the caller's
    /// saved activation and return the pc to resume the caller at. The
    /// callee's result has already been captured by the caller of this
    /// method (which pushes it onto the shared value stack, matching XS's
    /// `mxStack = mxFrameEnd; *mxStack = *result`).
    fn leave_call(&mut self) -> usize {
        let caller = self
            .call_stack
            .pop()
            .expect("leave_call with empty call stack");
        // The suspended caller is resumed: release its accounted frame
        // slots (the inverse of the `enter_call` accrual).
        self.frame_slots = self
            .frame_slots
            .saturating_sub(FRAME_OVERHEAD_SLOTS + caller.args.len() + caller.locals.len());
        self.locals = caller.locals;
        self.id_map = caller.id_map;
        self.result = caller.result;
        self.strict = caller.strict;
        self.args = caller.args;
        self.this_val = caller.this_val;
        self.this_captures = caller.this_captures;
        self.env = caller.env;
        self.cur_func = caller.cur_func;
        self.cur_target = caller.cur_target;
        self.target_func = caller.target_func;
        caller.ret_pc
    }

    /// `fxJump`: unwind to the innermost jump-buffer entry (XS's
    /// `the->firstJump`), restoring exactly what the `c_setjmp` restore in
    /// `CATCH` restores — the call frames back to the establishing frame,
    /// then that frame's value-stack and scope cuts — and returning the
    /// code segment and target pc to resume at. Returns `None` when the chain
    /// is empty (the throw escapes every JS handler and reaches the host boundary), so
    /// the caller yields `Halt::Throw`.
    fn unwind_to_jump(&mut self) -> Option<ResumeTarget> {
        // A throw between `XS_CODE_SUPER` (which arms the pending
        // new-target for the construct about to happen) and the
        // construct frame that consumes it abandons that construct.
        // Leaving it armed would give a later constructor the stale target
        // as its `new.target`. Disarm BEFORE the
        // empty-chain return below, so the uncaught direct
        // `THROW`/`RETHROW` (and rejected-await) host escapes are
        // covered exactly like the caught path and `raise_js`.
        self.pending_new_target = None;
        let jump = self.jumps.pop()?;
        // A handler live across a suspend costs XS one extra dispatch to
        // land in (see [`RESUMED_HANDLER_THROW_METERING`]); a handler
        // pushed by a `CATCH` in this run costs nothing beyond the
        // ordinary caught-throw modeling.
        if jump.rebased {
            self.meter.tick_raw(RESUMED_HANDLER_THROW_METERING);
        }
        // Pop any callee activations opened since the catch was
        // established (a throw crossing called functions), restoring the
        // establishing frame's saved activation each time (XS restores
        // `mxFrame`). Discard the callee results — the throw abandons them.
        while self.call_stack.len() > jump.call_depth {
            let _ = self.leave_call();
        }
        // Restore the establishing frame's value-stack and scope cuts
        // (XS's `mxStack = jump->stack; mxScope = jump->scope`) and the
        // exact environment name map at catch time.
        self.stack.truncate(jump.stack_len);
        self.locals.truncate(jump.locals_len);
        self.id_map = jump.id_map;
        // Restore the environment head active at catch establishment (XS's
        // `mxEnvironment` restore from `jump->scope`), so a throw out of a
        // `with` body resets the environment for the surviving catch/finally.
        self.env = jump.env;
        let _ = jump.flag; // every ironhorse jump is a JS jump (flag == 1)
        Some(ResumeTarget {
            pc: jump.target_pc,
            segment: jump.segment,
        })
    }

    /// Raise an engine-created JavaScript value through the same jump-buffer
    /// chain as the `throw` opcode.  Native semantic failures must use this
    /// path so `try`/`catch`/`finally` can observe the realm-correct Error
    /// object instead of seeing an uncatchable host-side `Unsupported` halt.
    ///
    /// The result is always a control transfer for the enclosing dispatch
    /// loop to consume: `Step::Unwound(target)` when a handler caught the
    /// value (the loop that OWNS the handler's frame resumes there, which
    /// `dispatch_halt!`'s depth and buffer tests decide), or `Halt::Throw` when the
    /// chain is empty and the throw escapes to the host. Yielding the caught
    /// case as `Resume` rather than a bare `Ok(target)` is what makes the
    /// depth test unskippable: a raise site cannot assign the target to its
    /// own `pc` without going through the macro.
    fn raise_js(&mut self, value: Slot) -> Step {
        self.exception = value;
        match self.unwind_to_jump() {
            Some(target) => Step::Unwound(target),
            None => {
                // Uncaught: the host-escape leaves the machine
                // post-throw ([`Self::unwind_to_jump`] disarmed the
                // pending new-target for every escape path). The
                // value travels through native catches without rendering;
                // only finish_step renders an uncaught host escape.
                self.meter_host_escape();
                Step::Threw { value }
            }
        }
    }

    /// As [`Self::catchable_type_error`], carrying a diagnostic message so
    /// the thrown `TypeError` renders `TypeError: <message>` — XS's
    /// `mxTypeError("...")` texts (`invalid object`, `invalid descriptor`,
    /// `cannot coerce null to object`, …), which the oracle's
    /// `String(exception)` reports verbatim.
    fn catchable_type_error_msg(&mut self, message: String) -> Step {
        let error = self.internal_error("TypeError", message);
        self.raise_js(error)
    }

    /// Raise a realm-local TypeError from a native helper. The dispatch loop
    /// consumes `Resume` and continues at the catch/finally target; an uncaught
    /// error retains the ordinary host `Throw` result from [`Self::raise_js`].
    fn catchable_type_error(&mut self) -> Step {
        let error = self.build_error("TypeError", 0, 0);
        self.raise_js(error)
    }

    /// Raise a realm-local, catchable `SyntaxError` from a native helper —
    /// the shape `new RegExp(badPattern)` throws (`fxThrowMessage` with
    /// `XS_SYNTAX_ERROR`). Like [`Self::catchable_type_error`], `try`/`catch`
    /// observes a realm-correct `SyntaxError` object (so `instanceof
    /// SyntaxError` and `assert.throws(SyntaxError, …)` hold) rather than an
    /// uncatchable host `Unsupported` halt.
    fn catchable_syntax_error(&mut self) -> Step {
        let error = self.build_error("SyntaxError", 0, 0);
        self.raise_js(error)
    }

    /// As [`Self::catchable_syntax_error`], but carrying XS's parser diagnostic
    /// text so the thrown `SyntaxError` renders `SyntaxError: <message>` — the
    /// pinned oracle's exact `String(exception)` for an early error the source
    /// bridge (eval / dynamic `Function`) rejects. An empty message falls back
    /// to the bare form.
    fn catchable_syntax_error_with_message(&mut self, message: String) -> Step {
        if message.is_empty() {
            return self.catchable_syntax_error();
        }
        let error = self.internal_error("SyntaxError", message);
        self.raise_js(error)
    }

    /// Adjust the meter for an uncaught throw escaping to the host: the
    /// escaping opcode's dispatch metering (added at the top of the loop)
    /// is removed — XS never meters it, its `mxBreak` bypassed by the
    /// longjmp — and the fixed host-boundary constant
    /// [`THROW_HOST_ESCAPE_METERING`] is accrued instead.
    #[inline]
    fn meter_host_escape(&mut self) {
        self.meter.untick_code();
        self.meter.tick_raw(THROW_HOST_ESCAPE_METERING);
    }

    /// Reverse [`Self::meter_host_escape`]: a throw that reached the host
    /// boundary of a re-entrant [`Self::run_callback`] was actually caught by a
    /// native `mxTry` (a promise reaction handler or a thenable `then`), so XS
    /// never left the machine — restore the escaping opcode's dispatch tick and
    /// remove the speculative host-boundary residual, leaving just the plain
    /// `throw` opcode metering XS's `fxJump`-to-`mxCatch` path incurs.
    #[inline]
    fn unmeter_host_escape(&mut self) {
        self.meter.tick_code();
        self.meter.untick_raw(THROW_HOST_ESCAPE_METERING);
    }

    /// Read a `*_CLOSURE_*`/`retrieve`/`store` opcode's 1-based scope index
    /// operand (`mxEnvironment - index`): a `u8` for the `_1` variant, a
    /// little-endian `u16` for `_2`.
    fn closure_index(&self, op: Opcode, code: &[u8], pc: usize) -> usize {
        if op.size() == 2 {
            code[pc + 1] as usize
        } else {
            u16::from_le_bytes([code[pc + 1], code[pc + 2]]) as usize
        }
    }

    /// The shared heap cell a closure scope slot `k` (1-based) indirects
    /// to, or `None` if the slot is out of range or not a closure.
    fn closure_cell(&self, k: usize) -> Option<crate::value::SlotIndex> {
        let i = self.local_index(k)?;
        let s = self.locals[i];
        match (s.kind, s.value) {
            (Kind::Closure, Payload::Reference(cell)) => Some(cell),
            _ => None,
        }
    }

    /// Recover the closure-cell mapping encoded by the compiler immediately
    /// after `arguments_sloppy`. Each formal initialization is emitted as
    /// `argument i; var_closure k`; duplicate names reuse `k`, and only their
    /// last occurrence remains mapped by the arguments exotic object.
    fn sloppy_argument_cells(
        &self,
        code: &[u8],
        mut pc: usize,
        formal_count: usize,
    ) -> Vec<Option<crate::value::SlotIndex>> {
        // The formal count is decoded from the BEGIN bytecode's u8 operand,
        // so this metadata has at most 255 entries, independent of argc.
        let mut cells = self.reserve_copy_scratch(formal_count);
        cells.resize(formal_count, None);
        let mut pending_argument = None;
        let mut initialized = 0usize;
        while pc < code.len() && initialized < formal_count {
            let Some(op) = Opcode::from_u8(code[pc]) else {
                break;
            };
            let Some(size) = crate::opcode::instruction_len(code, pc) else {
                break;
            };
            match op {
                Opcode::XS_CODE_ARGUMENT => {
                    pending_argument = code.get(pc + 1).copied().map(usize::from);
                }
                Opcode::XS_CODE_VAR_CLOSURE_1 | Opcode::XS_CODE_VAR_CLOSURE_2 => {
                    if let Some(argument) = pending_argument.take() {
                        let k = self.closure_index(op, code, pc);
                        if let Some(cell) = self.closure_cell(k) {
                            for former in &mut cells {
                                if *former == Some(cell) {
                                    *former = None;
                                }
                            }
                            if let Some(mapped) = cells.get_mut(argument) {
                                *mapped = Some(cell);
                            }
                        }
                        initialized += 1;
                    }
                }
                _ => {}
            }
            pc += size;
        }
        cells
    }

    /// Point closure scope slot `k` at a different heap cell (XS's
    /// `slot->value.closure = variable`), preserving the slot's `Closure`
    /// kind and binding id. Used by `reset_closure`/`refresh_closure` to
    /// give a per-iteration `let` binding a fresh cell.
    fn repoint_closure(&mut self, k: usize, cell: crate::value::SlotIndex) {
        if let Some(i) = self.local_index(k) {
            self.locals[i].kind = Kind::Closure;
            self.locals[i].value = Payload::Reference(cell);
        }
    }

    /// Write value `v` through closure scope slot `k` into its shared cell
    /// (all closures capturing the binding observe the mutation).
    fn write_closure_cell(&mut self, k: usize, v: Slot) {
        if let Some(cell) = self.closure_cell(k) {
            let c = self.slots.get_mut(cell);
            c.kind = v.kind;
            c.value = v.value;
        }
    }

    /// `XS_CODE_RETRIEVE`: import the running function's `k` captured
    /// closures from its closure environment (`functions[cur_func].closures`,
    /// whose stored closures live at `env.next.next` onward) into the frame
    /// scope, copying the closure-kind slots so they point at the same
    /// shared cells. No allocation (the cells already exist).
    fn retrieve_closures(&mut self, k: usize) {
        let env = self
            .functions
            .get(&self.cur_func)
            .map(|f| f.closures)
            .unwrap_or(crate::value::SlotIndex::NULL);
        if env.is_null() {
            return;
        }
        // env.next = behavior slot; behavior.next = first stored closure.
        let behavior = self.slots.get(env).next;
        let mut cur = if behavior.is_null() {
            crate::value::SlotIndex::NULL
        } else {
            self.slots.get(behavior).next
        };
        for _ in 0..k {
            if cur.is_null() {
                break;
            }
            let s = self.slots.get(cur);
            let mut copy = Slot::of(s.kind, s.value);
            copy.id = s.id;
            copy.flag = s.flag;
            self.locals.push(copy);
            if s.id != 0 {
                self.id_map.insert(s.id, self.locals.len() - 1);
            }
            cur = s.next;
        }
    }

    /// `XS_CODE_STORE`: capture scope closure `k` into the top-of-stack
    /// closure environment, appending a shared-cell reference to the
    /// environment's property list (`fxNewSlot`, metered). The stored slot
    /// keeps the same cell reference, so the captured closure and the
    /// defining frame share one cell.
    fn store_closure(&mut self, k: usize) {
        let env = match self.stack.last() {
            Some(&Slot {
                value: Payload::Reference(e),
                ..
            }) => e,
            _ => return,
        };
        let i = match self.local_index(k) {
            Some(i) => i,
            None => return,
        };
        let src = self.locals[i];
        // fxNewSlot for the appended closure slot.
        self.meter.tick_slot_alloc();
        let mut stored = Slot::of(src.kind, src.value);
        stored.id = src.id;
        stored.flag = src.flag;
        let idx = self.slots.alloc(stored);
        // Append to the end of the environment's property chain.
        let mut tail = env;
        loop {
            let next = self.slots.get(tail).next;
            if next.is_null() {
                break;
            }
            tail = next;
        }
        self.slots.get_mut(tail).next = idx;
    }

    /// Append a lexical arrow capture to a function closure environment.
    ///
    /// Arrow captures use the same arena-backed property chain as ordinary
    /// closures, which keeps them visible to the existing snapshot and GC
    /// traversal without adding a parallel side table.
    fn append_environment_capture(
        &mut self,
        env: crate::value::SlotIndex,
        id: u16,
        value: Slot,
    ) -> crate::value::SlotIndex {
        self.meter.tick_slot_alloc();
        let mut stored = Slot::of(value.kind, value.value);
        stored.id = id;
        let index = self.slots.alloc(stored);

        let mut tail = env;
        loop {
            let next = self.slots.get(tail).next;
            if next.is_null() {
                break;
            }
            tail = next;
        }
        self.slots.get_mut(tail).next = index;
        index
    }

    /// Attach a module binding's shared heap cell to an initializer or
    /// evaluator closure environment. Module initializer/evaluator functions
    /// are compiled independently, but their `retrieve` opcodes must resolve
    /// the same lexical cell for each transfer record.
    fn append_module_closure(
        &mut self,
        env: crate::value::SlotIndex,
        id: u16,
        cell: crate::value::SlotIndex,
    ) {
        self.append_environment_capture(env, id, Slot::of(Kind::Closure, Payload::Reference(cell)));
    }

    /// `XS_CODE_BEGIN_SLOPPY`'s `this` binding: an `undefined`/`null` `this`
    /// in a sloppy function frame binds to the realm global. Recorded for
    /// the `this`/method semantics that observe it; the covered call
    /// grammar (plain calls) passes `undefined`.
    /// A top-level script program's `this` binding: the realm global
    /// object (`fxRunProgram` binds the program frame's `this` to the
    /// realm global for a script; only an ES module binds `undefined`, and
    /// modules are structurally skipped). Set once at program entry so a
    /// top-level `this` opcode observes the global rather than the default
    /// `undefined`.
    fn bind_program_this(&mut self) {
        self.this_val = Slot::of(Kind::Reference, Payload::Reference(self.global_obj));
    }

    /// `fxRunConstructor` (driven by `begin` in a construct frame): allocate
    /// the fresh `this` instance the constructor populates, and bind the
    /// frame's `this` to it. XS reads the prototype from the constructor's
    /// `.prototype` (defaulting to `%Object.prototype%`); the covered grammar
    /// reads only own properties of `this`, so ironhorse allocates the instance
    /// with a null prototype and leaves the intrinsic-prototype wiring to the
    /// object-model stage. Meters the single instance `fxNewSlot`
    /// ([`crate::meter::SLOT_ALLOCATION_METERING`], 256 raw) exactly where
    /// `fxNewHostInstance` allocates it — measured against the pin as the
    /// whole construct overhead over a plain call.
    fn run_constructor(&mut self) {
        // `fxRunConstructor` runs `fxBeginHost`/`fxEndHost` around
        // `fxGetPrototypeFromConstructor` and then `fxNewHostInstance`. Beyond
        // the instance `fxNewSlot` ([`crate::meter::SLOT_ALLOCATION_METERING`],
        // 256 raw), the host-frame entry/exit accrues a fixed two code units
        // ([`CONSTRUCTOR_HOST_FRAME_METERING`]) — measured against the pin as
        // exactly the gap between `new f()` and a plain `f()` (131072 raw =
        // 2 × `XS_CODE_METERING`), independent of the constructor's body.
        self.meter.tick_slot_alloc();
        self.meter.tick_raw(CONSTRUCTOR_HOST_FRAME_METERING);
        // The new `this` chains to the constructor's `.prototype`
        // (fxGetPrototypeFromConstructor), defaulting to %Object.prototype% —
        // so `(new F()) instanceof F` holds. Reading the prototype is a
        // property get (unmetered), already folded into the measured cost.
        let proto = self
            .prototype_of(self.target_func)
            .unwrap_or(self.object_proto);
        let inst = self.slots.alloc(Slot::instance(proto));
        self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
    }

    fn bind_this_sloppy(&mut self) {
        match self.this_val.kind {
            // `undefined`/`null` bind to the realm global (the sloppy default).
            Kind::Undefined | Kind::Null => {
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(self.global_obj));
            }
            // A primitive `this` in a sloppy callee is ToObject-boxed to its
            // wrapper object (XS's `fxToInstance`; ECMA-262 OrdinaryCallBindThis
            // step 5 for non-strict code). The wrapped primitive lives in the
            // wrapper side table, while String's exotic indices and length are
            // projected by the ordinary property MOP.
            Kind::Boolean => {
                let inst = self.box_primitive_to_instance(Native::Boolean, self.this_val);
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
            }
            Kind::Integer | Kind::Number => {
                let inst = self.box_primitive_to_instance(Native::Number, self.this_val);
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
            }
            Kind::String => {
                let inst = self.box_primitive_to_instance(Native::String, self.this_val);
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
            }
            Kind::Symbol => {
                let inst = self.box_primitive_to_instance(Native::Symbol, self.this_val);
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
            }
            Kind::BigInt => {
                let inst = self.box_primitive_to_instance(Native::BigInt, self.this_val);
                self.this_val = Slot::of(Kind::Reference, Payload::Reference(inst));
            }
            _ => {}
        }
    }

    /// The single complete `Call(F, thisArg, args)` dispatcher. Promise
    /// resolving functions, bound chains, native functions/methods, bytecode
    /// functions, and callable proxies all route through this operation so
    /// abstract `Call` sites cannot recognize incompatible callable subsets.
    fn invoke_value(
        &mut self,
        code: &[u8],
        func: Slot,
        this: Slot,
        initial_args: &[Slot],
    ) -> Result<Slot, Step> {
        // The bound-function fold and the `Function.prototype.call`/`apply`
        // trampolines below each redispatch to another callable. They loop
        // here rather than recurse: neither enters a charged frame, so a chain
        // `c = c.call.bind(c)` (bound wrapper → `call` → bound wrapper …) of
        // 10,000 links overflowed the host stack while the pinned XS completes
        // it. `owned_args` is the argument list the last step rebuilt; until a
        // step rebuilds one, `initial_args` serves.
        let mut func = func;
        let mut this = this;
        let mut owned_args: Option<Vec<Slot>> = None;
        loop {
            let args: &[Slot] = owned_args.as_deref().unwrap_or(initial_args);
            let f = match func.value {
                Payload::Reference(f) if func.kind == Kind::Reference => f,
                _ => return Err(self.catchable_type_error_msg("call: not a function".into())),
            };
            if self.proxies.contains_key(&f) {
                return self.proxy_call(code, f, this, args);
            }
            // Promise resolve/reject functions carry a native-method marker for
            // reflection, but their [[Call]] settles the captured promise.
            if self.promise_functions.contains_key(&f) {
                let base = self.stack.len();
                self.push(this);
                self.push(func);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                for a in args {
                    self.push(*a);
                }
                return match self.call_promise_function(code, f, base, args.len()) {
                    Ok(()) => Ok(self.pop()),
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            }
            // BoundFunctionExoticObject.[[Call]] prepends this level's
            // arguments, substitutes its bound this, and redispatches the
            // target.
            if self.bound_functions.contains_key(&f) {
                // Fold the whole chain iteratively rather than recursing once
                // per wrapper: a 20,000-link chain overflowed the real thread
                // stack and aborted the host, while the pinned XS completes the
                // same program. `enter_construct_bound` already folds the
                // construct side this way. Each level prepends its own bound
                // arguments and replaces the receiver, and is charged exactly
                // as the recursive form charged it, so the meter is unchanged.
                // `bind` always allocates a fresh exotic whose target already
                // exists, so the chain is acyclic and this terminates.
                let mut current = f;
                let mut this_arg = this;
                let mut combined: Vec<Slot> = match owned_args.take() {
                    Some(rebuilt) => rebuilt,
                    None => Self::fill_scratch(
                        self.reserve_work_scratch(initial_args.len())?,
                        initial_args.iter().copied(),
                    ),
                };
                while let Some(data) = self.bound_functions.get(&current) {
                    let target = data.target;
                    let receiver = data.this_arg;
                    let length = data
                        .args
                        .len()
                        .checked_add(combined.len())
                        .ok_or(Step::Host(Halt::HeapExhausted))?;
                    self.charge_and_check(BIND_CALL_METERING + length as u64 * BIND_CALL_PER_ARG)?;
                    let mut next = self.reserve_scratch(length)?;
                    next.extend_from_slice(&self.bound_functions[&current].args);
                    next.extend_from_slice(&combined);
                    combined = next;
                    this_arg = receiver;
                    current = target;
                }
                func = Slot::of(Kind::Reference, Payload::Reference(current));
                this = this_arg;
                owned_args = Some(combined);
                continue;
            }
            let fi = match self.functions.get(&f) {
                Some(fi) => fi,
                None => return Err(self.catchable_type_error_msg("call: not a function".into())),
            };
            let native = fi.native;
            let method = fi.method;
            // Function.prototype.call/apply are themselves ordinary callable
            // built-ins whose receiver is the function to redispatch. The
            // opcode RUN path has an in-place trampoline for them, but abstract
            // Call sites arrive here without that opcode context. Handle the
            // same semantics at the shared dispatcher so a bound call/apply
            // function, a Proxy trap, or another native algorithm can invoke
            // them too.
            if method == Some(NativeMethod::FunctionCall) {
                if !self.is_callable_value(this) {
                    return Err(
                        self.catchable_type_error_msg("this: not a Function instance".into())
                    );
                }
                let this_arg = args.first().copied().unwrap_or_else(Slot::undefined);
                let tail = args.get(1..).unwrap_or_default();
                let forwarded = Self::fill_scratch(
                    self.reserve_work_scratch(tail.len())?,
                    tail.iter().copied(),
                );
                self.charge_and_check(
                    CALL_TRAMPOLINE_METERING + forwarded.len() as u64 * CALL_TRAMPOLINE_PER_ARG,
                )?;
                func = this;
                this = this_arg;
                owned_args = Some(forwarded);
                continue;
            }
            if method == Some(NativeMethod::FunctionApply) {
                if !self.is_callable_value(this) {
                    return Err(
                        self.catchable_type_error_msg("this: not a Function instance".into())
                    );
                }
                let this_arg = args.first().copied().unwrap_or_else(Slot::undefined);
                let arg_array = args.get(1).copied().unwrap_or_else(Slot::undefined);
                let (forwarded, array_read_meter) = if arg_array.kind == Kind::Undefined
                    || arg_array.kind == Kind::Null
                {
                    (Vec::new(), 0)
                } else {
                    if arg_array.kind != Kind::Reference {
                        return Err(self.catchable_type_error_msg("argArray: not an object".into()));
                    }
                    let forwarded = self.arraylike_to_vec(code, arg_array)?;
                    let meter = self.apply_arraylike_metering(arg_array, forwarded.len());
                    (forwarded, meter)
                };
                self.charge_and_check(CALL_TRAMPOLINE_METERING + array_read_meter)?;
                func = this;
                this = this_arg;
                owned_args = Some(forwarded);
                continue;
            }
            if native.is_some() || method.is_some() {
                // Native / native-method: build the [THIS, FUNCTION, RESULT,
                // FRAME] frame + args, dispatch, and take the pushed result.
                let base = self.stack.len();
                self.push(this);
                self.push(func);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                for a in args {
                    self.push(*a);
                }
                let result = if let Some(n) = native {
                    self.call_native(n, base, args.len(), false, code)
                } else {
                    self.call_native_method(method.unwrap(), base, args.len(), code)
                };
                return match result {
                    Ok(()) => Ok(self.pop()),
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            }
            return self.run_user_callback(code, func, this, args);
        }
    }

    /// Construct any constructor value with an explicit argument list — the
    /// substrate `Reflect.construct` and a proxy's default `[[Construct]]` need.
    /// A native constructor dispatches with the construct flag; a callable proxy
    /// routes to its `construct` trap; a user constructor re-enters through the
    /// construct-capable callback path.
    fn construct_value(
        &mut self,
        code: &[u8],
        func: Slot,
        args: &[Slot],
        new_target: Slot,
    ) -> Result<Slot, Step> {
        let f = match func.value {
            Payload::Reference(f) if func.kind == Kind::Reference => f,
            _ => return Err(self.catchable_type_error_msg("new: not a constructor".into())),
        };
        if !self.is_constructor_value(func) {
            return Err(self.catchable_type_error_msg("new: not a constructor".into()));
        }
        if self.proxies.contains_key(&f) {
            return self.proxy_construct(code, f, args, new_target);
        }
        if let Some(n) = self.native_of(f) {
            let target = match new_target.value {
                Payload::Reference(target) if new_target.kind == Kind::Reference => target,
                _ => return Err(self.catchable_type_error_msg("new: not a constructor".into())),
            };
            let base = self.stack.len();
            self.push(Slot::of(Kind::Uninitialized, Payload::None)); // THIS = construct flag
            self.push(func);
            self.push(Slot::undefined());
            self.push(Slot::of(Kind::Uninitialized, Payload::None));
            for a in args {
                self.push(*a);
            }
            // Plain `new Native` derives NewTarget from the function slot.
            // Reflect.construct can supply a distinct constructor; hand that
            // one-shot identity to native dispatch so it can select the
            // requested prototype without leaking into a later construction.
            let saved_pending_new_target = self.pending_new_target;
            self.pending_new_target = (target != f).then_some(target);
            let result = self.call_native(n, base, args.len(), true, code);
            self.pending_new_target = saved_pending_new_target;
            result?;
            return Ok(self.pop());
        }
        // A user-defined constructor: re-enter with the construct geometry.
        self.run_callback_construct(code, func, args, new_target)
    }

    /// Run a user (bytecode) constructor to completion with an explicit
    /// argument list, returning the constructed object (ECMA-262 Ordinary
    /// [[Construct]] shape, modeled on [`Self::run_callback`] but with the
    /// construct flag set so the callee body's `this` is a fresh instance).
    /// A constructor retained from an earlier crank executes against its own
    /// persisted code segment, just like an ordinary cross-crank callback.
    fn run_callback_construct(
        &mut self,
        code: &[u8],
        func: Slot,
        args: &[Slot],
        new_target: Slot,
    ) -> Result<Slot, Step> {
        let f = match func.value {
            Payload::Reference(f) if self.functions.contains_key(&f) => f,
            _ => return Err(self.catchable_type_error()),
        };
        if self.functions[&f].native.is_some()
            || self.functions[&f].method.is_some()
            || self.bound_functions.contains_key(&f)
        {
            // Only a plain user constructor is driven here.
            return Err(Step::Host(Halt::NotImplemented(
                "proxy:construct-nonuser-target",
            )));
        }
        let _ = new_target;
        let argc = args.len();
        self.push(Slot::of(Kind::Uninitialized, Payload::None)); // THIS (construct)
        self.push(func);
        self.push(Slot::undefined());
        self.push(Slot::of(Kind::Uninitialized, Payload::None));
        for a in args {
            self.push(*a);
        }
        let body_start = self.enter_call(argc, 0, true)?;
        let return_depth = self.call_stack.len();
        let callee_seg = self.callee_segment(f);
        let seg_buf = if callee_seg == self.active_segment {
            None
        } else {
            self.segment_buffer(callee_seg)
        };
        let saved_segment = self.active_segment;
        if seg_buf.is_some() {
            self.active_segment = callee_seg;
        }
        let body_code: &[u8] = match &seg_buf {
            Some(buf) => &buf[..],
            None => code,
        };
        let outcome = self.dispatch_at(body_code, body_start, return_depth);
        self.active_segment = saved_segment;
        match outcome {
            Step::Returned => Ok(self.pop()),
            other => Err(other),
        }
    }

    /// Allocate a `with`/eval environment instance (XS's
    /// `fxNewEnvironmentInstance`, `xsType.c`). Two slots: an
    /// `XS_INSTANCE_KIND` head carrying `XS_EXOTIC_FLAG`, whose payload
    /// prototype is the prior environment head (`self.env` when it is a
    /// reference, else `NULL`), and a behavior slot (`instance.next`) keyed
    /// [`XS_ENVIRONMENT_BEHAVIOR_ID`] whose kind/value are copied from the
    /// `with` value on top of the stack (a `Reference` for `with(obj)`;
    /// `NULL`/`undefined` for the eval prelude). Meters exactly two
    /// `fxNewSlot` allocations (`2 × SLOT_ALLOCATION_METERING`) — no built-in
    /// step, no prototype-link to `%Object.prototype%` (an environment is not
    /// an ordinary object). Returns the head instance index.
    fn new_environment_instance(&mut self, with_value: Slot) -> crate::value::SlotIndex {
        let proto = if self.env.kind == Kind::Reference {
            match self.env.value {
                Payload::Reference(r) => r,
                _ => crate::value::SlotIndex::NULL,
            }
        } else {
            crate::value::SlotIndex::NULL
        };
        // fxNewSlot #1: the instance head.
        let mut head = Slot::instance(proto);
        head.flag = XS_EXOTIC_FLAG;
        let inst = self.slots.alloc(head);
        self.meter.tick_slot_alloc();
        // fxNewSlot #2: the behavior slot, carrying the `with` value.
        let mut behavior = Slot::of(with_value.kind, with_value.value);
        behavior.id = XS_ENVIRONMENT_BEHAVIOR_ID;
        behavior.flag = XS_INTERNAL_FLAG;
        let behavior_idx = self.slots.alloc(behavior);
        self.meter.tick_slot_alloc();
        self.slots.get_mut(inst).next = behavior_idx;
        inst
    }

    /// `fxIsScopableSlot` (`xsRun.c`): is `id` resolvable as a scopable
    /// binding of the `with` object `obj`? True when `obj` **has** the
    /// property (own or inherited) AND it is not blocked by the object's
    /// `@@unscopables` list — `obj[@@unscopables]` being an object whose `id`
    /// property is truthy hides the binding (ECMA-262 9.1.1.2.1). Meters the
    /// host-frame `mxHasID` walk exactly (the calibrated
    /// [`WITH_SCOPABLE_BASE_METERING`] host teardown plus one
    /// `XS_CODE_METERING` per prototype level the `HasProperty` recursion
    /// descends); the `@@unscopables` consultation is charged only on a hit
    /// via [`WITH_UNSCOPABLES_GET_METERING`], matching the extra host `mxGetID`
    /// XS runs only when the property is present.
    ///
    /// Both lookups route through the complete internal-method seam
    /// (`mop_has`/`mop_get`), never the slot-chain-only `instance_*`
    /// helpers: an object environment over a Proxy must observe its `has`
    /// and `get` traps (ECMA-262 `HasBinding` on an Object Environment
    /// Record is `HasProperty` then `Get` of `@@unscopables`), and a
    /// `with` over a membrane is exactly where a chain-only walk would see
    /// through to the target. A trap may throw, so the check is fallible.
    fn is_scopable_slot(
        &mut self,
        code: &[u8],
        obj: crate::value::SlotIndex,
        id: u16,
    ) -> Result<bool, Step> {
        let (present, frames) = self.mop_has_with_recursions(code, obj, id)?;
        self.meter.tick_raw(WITH_SCOPABLE_HAS_METERING);
        self.charge_and_check(frames * ORDINARY_HAS_PROPERTY_FRAME_METERING)?;
        if !present {
            return Ok(false);
        }
        // Consult `obj[@@unscopables]` only when the property is present, as
        // XS does. The well-known symbol's key id is minted on first use; a
        // program that never names `Symbol.unscopables` has no object keyed by
        // it, so `unscopables` is `undefined` and never blocks.
        self.meter.tick_raw(WITH_UNSCOPABLES_GET_METERING);
        if let Some(unscopables_id) = self.well_known_symbol_property_id("unscopables") {
            let receiver = Slot::of(Kind::Reference, Payload::Reference(obj));
            let blocklist = self.mop_get(code, obj, unscopables_id, receiver)?;
            if let Payload::Reference(list) = blocklist.value {
                if blocklist.kind == Kind::Reference {
                    // A further host `mxGetID(id)` on the blocklist object.
                    self.meter.tick_raw(WITH_UNSCOPABLES_BLOCKLIST_GET_METERING);
                    let flag = self.mop_get(code, list, id, blocklist)?;
                    if self.truthy(&flag) {
                        return Ok(false);
                    }
                }
            }
        }
        Ok(true)
    }

    /// Whether `inst` is one of the exotic environment instances allocated by
    /// [`Self::new_environment_instance`]. The reserved behavior slot is the
    /// discriminator, matching XS's `XS_ENVIRONMENT_BEHAVIOR` test.
    fn is_environment_instance(&self, inst: crate::value::SlotIndex) -> bool {
        if inst.is_null() {
            return false;
        }
        let behavior = self.slots.get(inst).next;
        !behavior.is_null() && self.slots.get(behavior).id == XS_ENVIRONMENT_BEHAVIOR_ID
    }

    /// Find an id-keyed property published on a closure environment. The
    /// behavior slot itself is internal; published closure cells begin at its
    /// `next`, exactly as `fxEnvironmentHasProperty`/`GetProperty` walk them.
    fn environment_property(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<crate::value::SlotIndex> {
        if id == 0 || !self.is_environment_instance(inst) {
            return None;
        }
        let behavior = self.slots.get(inst).next;
        let mut property = self.slots.get(behavior).next;
        while !property.is_null() {
            let slot = self.slots.get(property);
            if slot.id == id {
                return Some(property);
            }
            property = slot.next;
        }
        None
    }

    /// `fxEnvironmentGetProperty`: return the published value, dereferencing a
    /// closure-kind property through its shared heap cell. `None` denotes an
    /// uninitialized cell (TDZ) or a missing property; resolution guarantees
    /// the latter cannot normally reach this point.
    fn environment_get(&self, inst: crate::value::SlotIndex, id: u16) -> Option<Slot> {
        let property = self.environment_property(inst, id)?;
        let slot = self.slots.get(property);
        let value = if slot.kind == Kind::Closure {
            match slot.value {
                Payload::Reference(cell) => self.slots.get(cell),
                _ => return None,
            }
        } else {
            slot
        };
        (value.kind != Kind::Uninitialized).then(|| Slot::of(value.kind, value.value))
    }

    /// `fxEnvironmentSetProperty`: write through a published closure cell so
    /// every capturer observes the assignment, retaining TDZ and const guards.
    fn environment_set(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
    ) -> EnvironmentSet {
        let Some(property) = self.environment_property(inst, id) else {
            return EnvironmentSet::Missing;
        };
        let property_slot = self.slots.get(property);
        let target = if property_slot.kind == Kind::Closure {
            match property_slot.value {
                Payload::Reference(cell) => cell,
                _ => return EnvironmentSet::Missing,
            }
        } else {
            property
        };
        let slot = self.slots.get_mut(target);
        if slot.kind == Kind::Uninitialized {
            return EnvironmentSet::Uninitialized;
        }
        if slot.flag & XS_DONT_SET_FLAG != 0 {
            return EnvironmentSet::Const;
        }
        slot.kind = value.kind;
        slot.value = value.value;
        EnvironmentSet::Written
    }

    /// Walk the active `with`/eval environment chain (XS's
    /// `XS_CODE_EVAL_REFERENCE`/`PROGRAM_REFERENCE` `mxEnvironment` walk),
    /// returning the object a variable read/write of `name` should resolve
    /// against, or `None` when no active environment binds it (the caller then
    /// falls through to the frame scope / global object, byte-identically to
    /// the pre-`with` engine). Only **object** environments (a `with(obj)`
    /// behavior slot holding a `Reference`) are consulted with
    /// [`Self::is_scopable_slot`]. A declarative/closure environment (a
    /// null/undefined behavior slot) uses its exotic id-keyed HasProperty walk
    /// and resolves to the environment instance itself. Returns `None`
    /// immediately — and meters
    /// nothing — when no environment is active, preserving the empty-chain
    /// dispatch cost exactly. Fallible because a `with` object's `has` or
    /// `@@unscopables` lookup may run a Proxy trap or accessor that throws.
    fn resolve_env_reference(
        &mut self,
        code: &[u8],
        name: u16,
    ) -> Result<Option<crate::value::SlotIndex>, Step> {
        if self.env.kind != Kind::Reference {
            return Ok(None);
        }
        let mut env = match self.env.value {
            Payload::Reference(r) => r,
            _ => return Ok(None),
        };
        while !env.is_null() {
            let behavior = self.slots.get(env).next;
            if !behavior.is_null() {
                let beh = self.slots.get(behavior);
                if beh.kind == Kind::Reference {
                    if let Payload::Reference(obj) = beh.value {
                        if self.is_scopable_slot(code, obj, name)? {
                            return Ok(Some(obj));
                        }
                    }
                } else if self.environment_property(env, name).is_some() {
                    // `mxBehaviorHasProperty` on an environment instance is a
                    // direct id walk with no allocation or metering.
                    return Ok(Some(env));
                }
            }
            env = self.instance_prototype(env);
        }
        Ok(None)
    }

    /// Whether `name` is bound by a **declarative/closure** environment on the
    /// active chain — a lexical (`let`/`const`/`class`) binding, as opposed to a
    /// `with(obj)` object environment (whose behavior slot holds a `Reference`)
    /// or the frame scope / global object. Used by declaration instantiation to
    /// detect a direct eval's `var`/function colliding with an enclosing lexical
    /// binding (the direct-eval "duplicate variable" `SyntaxError`). Read-only
    /// and unmetered: a pure id walk over the same chain
    /// [`Self::resolve_env_reference`] consults, restricted to its
    /// declarative-environment arm.
    fn has_lexical_env_binding(&self, name: u16) -> bool {
        if self.env.kind != Kind::Reference {
            return false;
        }
        let mut env = match self.env.value {
            Payload::Reference(r) => r,
            _ => return false,
        };
        while !env.is_null() {
            let behavior = self.slots.get(env).next;
            if !behavior.is_null() {
                let beh = self.slots.get(behavior);
                // A `with(obj)` environment carries the object in its behavior
                // slot as a `Reference`; only a declarative/closure environment
                // (a null/undefined behavior) publishes lexical closure cells.
                if beh.kind != Kind::Reference && self.environment_property(env, name).is_some() {
                    return true;
                }
            }
            env = self.instance_prototype(env);
        }
        false
    }

    /// Read a `*_LOCAL_*` opcode's 1-based scope-index operand: a `u8` for
    /// the `_1` variant (`size == 2`), a little-endian `u16` for `_2`
    /// (`size == 3`) — the wide-index form the compiler emits once a frame
    /// declares more than 255 scope slots (XS's `mxRunU1`/`mxRunU2`).
    #[inline]
    fn local_operand(&self, op: Opcode, code: &[u8], pc: usize) -> usize {
        if op.size() == 3 {
            u16::from_le_bytes([code[pc + 1], code[pc + 2]]) as usize
        } else {
            code[pc + 1] as usize
        }
    }

    /// Address a 1-based scope index `k` (XS's `mxEnvironment - index`).
    #[inline]
    fn local_index(&self, k: usize) -> Option<usize> {
        if k == 0 || k > self.locals.len() {
            None
        } else {
            Some(k - 1)
        }
    }

    /// Read scope slot `k`; `None` if it is still uninitialized (a TDZ
    /// read) or the index is out of range.
    fn get_local(&self, k: usize) -> Option<Slot> {
        let i = self.local_index(k)?;
        let s = self.locals[i];
        if s.kind == Kind::Uninitialized {
            None
        } else {
            Some(s)
        }
    }

    /// Write scope slot `k` from a value (kind + payload), mirroring
    /// XS's `variable->kind = ...; variable->value = ...`.
    fn set_local(&mut self, k: usize, v: Slot) {
        if let Some(i) = self.local_index(k) {
            self.locals[i].kind = v.kind;
            self.locals[i].value = v.value;
        }
    }

    /// Resolve a name for reading: a frame local when declared (unless
    /// uninitialized), else the global object's property.
    fn resolve_get(&self, name: u16) -> Option<Slot> {
        if let Some(&i) = self.id_map.get(&name) {
            let s = self.locals[i];
            // A closure-captured local holds a `Kind::Closure` cell indirection
            // (`store`/`retrieve`), not the value inline. Reached by name only
            // through the `with`/eval reference path (a plain access uses
            // `GET_CLOSURE` by index); dereference the shared cell so the read
            // yields the value, not the cell — TDZ if the cell is uninitialized.
            if s.kind == Kind::Closure {
                if let Payload::Reference(cell) = s.value {
                    let c = self.slots.get(cell);
                    return if c.kind == Kind::Uninitialized {
                        None
                    } else {
                        Some(Slot::of(c.kind, c.value))
                    };
                }
            }
            if s.kind == Kind::Uninitialized {
                None
            } else {
                Some(s)
            }
        } else if let Some(&idx) = self.global_props.get(&name) {
            let p = self.slots.get(idx);
            Some(Slot::of(p.kind, p.value))
        } else {
            None
        }
    }

    /// Resolve a **declared frame local** for writing. A name that is not a
    /// frame local is not this function's business: `SET_VARIABLE` handles the
    /// global arm itself, through the global object's full `[[Set]]`, so that
    /// an accessor or a non-writable descriptor installed reflectively stays
    /// binding-correct. A direct global-slot write here would bypass those
    /// descriptor checks. The caller selects this path only for names in
    /// `id_map`; all other writes must retain the global object's semantics.
    ///
    /// Returns `false` when the binding is an initialized `const` and the write
    /// must raise a TypeError instead. `CONST_LOCAL`/`CONST_CLOSURE` stamp
    /// `XS_DONT_SET_FLAG` on the local slot and on the shared closure cell, and
    /// `SET_LOCAL`/`PULL_LOCAL`/`SET_CLOSURE`/`PULL_CLOSURE` all consult it; a
    /// by-name write reaching here through `with`/eval has to observe the same
    /// guard, or `with ({}) { c = 2 }` silently rewrites a `const`.
    #[must_use]
    fn resolve_set(&mut self, name: u16, value: Slot) -> bool {
        if let Some(&i) = self.id_map.get(&name) {
            // A closure-captured local writes through its shared `Kind::Closure`
            // cell (so the mutation is visible to every capturer), mirroring
            // `resolve_get`'s dereference. Reached by name only through the
            // `with`/eval path; a plain write uses `SET_CLOSURE` by index.
            if self.locals[i].kind == Kind::Closure {
                if let Payload::Reference(cell) = self.locals[i].value {
                    if self.slots.get(cell).flag & XS_DONT_SET_FLAG != 0 {
                        return false;
                    }
                    let c = self.slots.get_mut(cell);
                    c.kind = value.kind;
                    c.value = value.value;
                    return true;
                }
            }
            if self.locals[i].flag & XS_DONT_SET_FLAG != 0 {
                return false;
            }
            self.locals[i].kind = value.kind;
            self.locals[i].value = value.value;
        }
        true
    }

    /// ToBoolean with chunk access: a heap string is truthy iff its
    /// content is non-empty (XS's `mxStringLength != 0`); every other kind
    /// defers to the pure [`to_boolean`]. The empty-string case is why this
    /// must route through the machine — a bare `to_boolean` cannot see the
    /// chunk and would call `""` truthy.
    #[inline]
    fn truthy(&self, s: &Slot) -> bool {
        match s.value {
            Payload::String(off) => !self.str_content(off).is_empty(),
            // ToBoolean(bigint): `0n` is falsy, every other BigInt truthy.
            Payload::BigInt(off) => {
                let (_, mag) = self.read_bigint(off);
                !bi_is_zero(&mag)
            }
            _ => to_boolean(s),
        }
    }

    // Binary numeric arithmetic, ported from the xsRun.c integer fast
    // paths with checked-overflow promotion to f64. A string operand needs
    // `ToNumber(string)` (string→number parsing), outside the covered
    // primitive subset, so it returns `Err` and the caller self-names
    // unsupported rather than producing a spurious `NaN`. (A reference
    // operand ToPrimitives to `NaN` for a plain object, which matches XS,
    // so it is left on the numeric path.)
    fn binary_arith(&mut self, code: &[u8], op: ArithOp) -> Result<(), Step> {
        let n = self.stack.len();
        if n < 2 {
            return Err(Step::Host(Halt::EngineInvariant(
                "arithmetic:stack-underflow",
            )));
        }
        let a_value = self.stack[n - 2];
        let b_value = self.stack[n - 1];
        let a = self.to_number_value(code, a_value)?;
        let b = self.to_number_value(code, b_value)?;
        self.stack.truncate(n - 2);
        // ToNumeric has completed left-to-right above. Arithmetic with one
        // BigInt and one Number is a catchable TypeError; two BigInts stay in
        // the arbitrary-precision domain for every binary arithmetic op.
        if a.kind == Kind::BigInt || b.kind == Kind::BigInt {
            match self.try_bigint_binop(op, a, b)? {
                Some(r) => {
                    self.push(r);
                    return Ok(());
                }
                None => {}
            }
            return Err(Step::Host(Halt::EngineInvariant(
                "bigint:missing-binary-result",
            )));
        }
        self.push(apply_arith(op, &a, &b));
        Ok(())
    }

    fn binary_bit(&mut self, code: &[u8], op: BitOp) -> Result<(), Step> {
        let n = self.stack.len();
        if n < 2 {
            return Err(Step::Host(Halt::EngineInvariant("bitwise:stack-underflow")));
        }
        let a_value = self.stack[n - 2];
        let b_value = self.stack[n - 1];
        let (a, b) = if op == BitOp::Shr {
            (
                self.to_number_value(code, a_value)?,
                self.to_number_value(code, b_value)?,
            )
        } else {
            (
                self.to_numeric_integer_value(code, a_value)?,
                self.to_numeric_integer_value(code, b_value)?,
            )
        };
        self.stack.truncate(n - 2);
        if a.kind == Kind::BigInt || b.kind == Kind::BigInt {
            let (Payload::BigInt(a_off), Payload::BigInt(b_off)) = (a.value, b.value) else {
                return Err(self.catchable_type_error_msg(if a.kind == Kind::BigInt {
                    "cannot coerce right operand to bigint".into()
                } else {
                    "cannot coerce left operand to bigint".into()
                }));
            };
            if op == BitOp::Shr {
                // BigInt has no unsigned-right-shift operation. Both operands
                // have nevertheless completed ToNumeric before this TypeError.
                return Err(self.catchable_type_error_msg("no such operation".into()));
            }
            let result = match op {
                BitOp::And | BitOp::Or | BitOp::Xor => self.bigint_bitwise(op, a_off, b_off),
                BitOp::Shl | BitOp::Sar => self.bigint_shift(op, a_off, b_off)?,
                BitOp::Shr => unreachable!(),
            };
            self.push(result);
            return Ok(());
        }
        let ai = to_int32(to_number(&a));
        let bi = to_int32(to_number(&b));
        let r = match op {
            BitOp::And => ai & bi,
            BitOp::Or => ai | bi,
            BitOp::Xor => ai ^ bi,
            BitOp::Shl => ((ai as u32) << (bi & 0x1f)) as i32,
            BitOp::Sar => ai >> (bi & 0x1f),
            BitOp::Shr => ((ai as u32) >> (bi & 0x1f)) as i32,
        };
        // Unsigned shift can exceed i32 range; XS keeps it a number
        // when the high bit is set.
        if let BitOp::Shr = op {
            let u = (ai as u32) >> (bi & 0x1f);
            if u > i32::MAX as u32 {
                self.push(Slot::number(u as f64));
                return Ok(());
            }
        }
        self.push(Slot::integer(r));
        Ok(())
    }

    /// Relational comparison (`<`/`<=`/`>`/`>=`). Two strings compare
    /// lexicographically by UTF-16BE byte (== code-unit order, XS's
    /// `c_strcmp`, and the ECMAScript abstract relational comparison on
    /// strings); two numerics compare as `f64` with NaN → false. A mixed
    /// string/numeric pair needs `ToNumber(string)` (or `ToPrimitive` of a
    /// reference), outside the covered subset, so it returns `Err` and the
    /// caller self-names unsupported.
    fn relational(&mut self, code: &[u8], op: RelOp) -> Result<(), Step> {
        let n = self.stack.len();
        if n < 2 {
            return Err(Step::Host(Halt::EngineInvariant(
                "comparison:stack-underflow",
            )));
        }
        let a_value = self.stack[n - 2];
        let b_value = self.stack[n - 1];
        let a = self.to_primitive(code, a_value, false)?;
        let b = self.to_primitive(code, b_value, false)?;
        self.stack.truncate(n - 2);
        if a.kind == Kind::String && b.kind == Kind::String {
            if let (Payload::String(x), Payload::String(y)) = (a.value, b.value) {
                let r = {
                    // Two-chunk read: only through the arena's guarded
                    // comparison (lazy-heap borrow discipline).
                    let ord = self.chunks.compare_payloads(x, y);
                    match op {
                        RelOp::Less => ord.is_lt(),
                        RelOp::LessEqual => ord.is_le(),
                        RelOp::More => ord.is_gt(),
                        RelOp::MoreEqual => ord.is_ge(),
                    }
                };
                self.push(Slot::boolean(r));
                return Ok(());
            }
        }
        // A mixed string/numeric comparison converts both operands to numbers
        // after the primitive step below.
        // BigInt relational (`<`/`<=`/`>`/`>=`). String operands use
        // StringToBigInt (an invalid integer string makes the comparison
        // undefined/false); other primitives use ToNumeric and compare the
        // exact mathematical values. In particular, never round the BigInt to
        // f64 at this boundary: values around 2**53 depend on the Number's
        // fractional/integer position relative to the exact BigInt.
        if a.kind == Kind::BigInt || b.kind == Kind::BigInt {
            let ordering = match (a.value, b.value) {
                (Payload::BigInt(x), Payload::BigInt(y)) => {
                    let (nx, mx) = self.read_bigint(x);
                    let (ny, my) = self.read_bigint(y);
                    Some(bi_cmp(nx, &mx, ny, &my))
                }
                (Payload::BigInt(x), Payload::String(y)) => {
                    let text = self.str_text(y);
                    parse_bigint_string(&text).map(|(ny, my)| {
                        let (nx, mx) = self.read_bigint(x);
                        bi_cmp(nx, &mx, ny, &my)
                    })
                }
                (Payload::String(x), Payload::BigInt(y)) => {
                    let text = self.str_text(x);
                    parse_bigint_string(&text).map(|(nx, mx)| {
                        let (ny, my) = self.read_bigint(y);
                        bi_cmp(nx, &mx, ny, &my)
                    })
                }
                (Payload::BigInt(x), _) => {
                    let number = self.to_number_value(code, b)?;
                    if number.kind == Kind::BigInt {
                        unreachable!("the both-BigInt case was handled above");
                    }
                    self.compare_bigint_number(x, to_number(&number))
                }
                (_, Payload::BigInt(y)) => {
                    let number = self.to_number_value(code, a)?;
                    if number.kind == Kind::BigInt {
                        unreachable!("the both-BigInt case was handled above");
                    }
                    self.compare_bigint_number(y, to_number(&number))
                        .map(std::cmp::Ordering::reverse)
                }
                _ => unreachable!("a BigInt kind carries a BigInt payload"),
            };
            use std::cmp::Ordering;
            let r = ordering.is_some_and(|ord| match op {
                RelOp::Less => ord == Ordering::Less,
                RelOp::LessEqual => ord != Ordering::Greater,
                RelOp::More => ord == Ordering::Greater,
                RelOp::MoreEqual => ord != Ordering::Less,
            });
            self.push(Slot::boolean(r));
            return Ok(());
        }
        let x = to_number(&self.to_number_value(code, a)?);
        let y = to_number(&self.to_number_value(code, b)?);
        let r = if x.is_nan() || y.is_nan() {
            false
        } else {
            match op {
                RelOp::Less => x < y,
                RelOp::LessEqual => x <= y,
                RelOp::More => x > y,
                RelOp::MoreEqual => x >= y,
            }
        };
        self.push(Slot::boolean(r));
        Ok(())
    }

    /// Equality (`===`/`!==`/`==`/`!=`). String↔string compares content
    /// bytes; string↔{null,undefined,symbol} is unequal on both operators;
    /// loose string↔{number,boolean} applies `ToNumber` after any object
    /// operand has already gone through `ToPrimitive`. Non-string kinds keep
    /// the existing primitive/reference-identity comparison.
    fn equality(&mut self, code: &[u8], strict: bool, negate: bool) -> Result<(), Step> {
        let mut b = self.pop();
        let mut a = self.pop();
        // Abstract Equality Comparison converts an object operand to a
        // primitive when the other operand is primitive. This is the ordinary
        // wrapper path (`Object(1) == 1`, `new Boolean(true) == true`) as well
        // as user objects with conversion methods. Two references still compare
        // by identity and strict equality never coerces either side.
        // `IsLooselyEqual` only converts an object operand when the other side
        // is a String, Number, BigInt or Symbol (steps 10-11). An Object
        // compared against `null`/`undefined` falls through to step 12 and is
        // `false` with no conversion at all, so running `ToPrimitive` there
        // would let the guest observe a `valueOf`/`toString`/`@@toPrimitive`
        // call the language guarantees does not happen -- and would propagate
        // an abrupt completion from a throwing one.
        let coercible = |other: &Slot| !matches!(other.kind, Kind::Null | Kind::Undefined);
        if !strict {
            if a.kind == Kind::Reference && b.kind != Kind::Reference && coercible(&b) {
                a = self.to_primitive_default(code, a)?;
            }
            if b.kind == Kind::Reference && a.kind != Kind::Reference && coercible(&a) {
                b = self.to_primitive_default(code, b)?;
            }
        }
        let eq = match (a.kind, b.kind) {
            (Kind::String, Kind::String) => match (a.value, b.value) {
                (Payload::String(x), Payload::String(y)) => {
                    // Two-chunk read: only through the arena's guarded
                    // comparison (lazy-heap borrow discipline).
                    self.chunks.compare_payloads(x, y) == std::cmp::Ordering::Equal
                }
                _ => false,
            },
            // A string is never `==`/`===` to null/undefined.
            (Kind::String, Kind::Null)
            | (Kind::String, Kind::Undefined)
            | (Kind::Null, Kind::String)
            | (Kind::Undefined, Kind::String) => false,
            (Kind::String, Kind::Integer | Kind::Number | Kind::Boolean) => {
                if strict {
                    false
                } else {
                    let x = match a.value {
                        Payload::String(off) => {
                            string_to_number(self.str_text(off).as_bytes(), true)
                        }
                        _ => f64::NAN,
                    };
                    let y = to_number(&b);
                    !x.is_nan() && !y.is_nan() && x == y
                }
            }
            (Kind::Integer | Kind::Number | Kind::Boolean, Kind::String) => {
                if strict {
                    false
                } else {
                    let x = to_number(&a);
                    let y = match b.value {
                        Payload::String(off) => {
                            string_to_number(self.str_text(off).as_bytes(), true)
                        }
                        _ => f64::NAN,
                    };
                    !x.is_nan() && !y.is_nan() && x == y
                }
            }
            (Kind::String, Kind::Symbol) | (Kind::Symbol, Kind::String) => false,
            (Kind::String, _) | (_, Kind::String) => {
                if strict {
                    false // `===` across types is false without coercion
                } else {
                    return Err(Step::Host(Halt::NotImplemented("equal"))); // `==` needs ToNumber(string)
                }
            }
            // BigInt `===`/`==`. Both BigInt: compare sign+magnitude
            // (`fxBigIntCompare` → `fxBigInt_comp`). The compare itself neither
            // allocates nor meters a digit step, so beyond the opcode dispatch
            // it carries no residual (measured raw-exact against the pin).
            (Kind::BigInt, Kind::BigInt) => self.strict_equal(&a, &b),
            // BigInt mixed with a Number/Integer. `===` across types is always
            // false with no residual (XS's strict path falls to `offset = 0`).
            // Loose `==` coerces the number to a BigInt (`fxNumberToBigInt`,
            // its digit chunk metered faithfully) and compares mathematical
            // values — a non-integral or non-finite Number is never equal.
            (Kind::BigInt, Kind::Integer) | (Kind::BigInt, Kind::Number) => {
                if strict {
                    false
                } else {
                    self.bigint_num_loose_eq(a, b)
                }
            }
            (Kind::Integer, Kind::BigInt) | (Kind::Number, Kind::BigInt) => {
                if strict {
                    false
                } else {
                    self.bigint_num_loose_eq(b, a)
                }
            }
            // BigInt is never `==`/`===` null/undefined.
            (Kind::BigInt, Kind::Null)
            | (Kind::Null, Kind::BigInt)
            | (Kind::BigInt, Kind::Undefined)
            | (Kind::Undefined, Kind::BigInt) => false,
            // Boolean first converts to Number, then takes the modeled
            // BigInt↔Number mathematical comparison. A Symbol is simply
            // incomparable. Reference operands have already gone through
            // ToPrimitive above.
            (Kind::BigInt, Kind::Boolean) => {
                if strict {
                    false
                } else {
                    let n = Slot::integer(if matches!(b.value, Payload::Boolean(true)) {
                        1
                    } else {
                        0
                    });
                    self.bigint_num_loose_eq(a, n)
                }
            }
            (Kind::Boolean, Kind::BigInt) => {
                if strict {
                    false
                } else {
                    let n = Slot::integer(if matches!(a.value, Payload::Boolean(true)) {
                        1
                    } else {
                        0
                    });
                    self.bigint_num_loose_eq(b, n)
                }
            }
            (Kind::BigInt, Kind::Symbol) | (Kind::Symbol, Kind::BigInt) => false,
            // BigInt↔String still needs arbitrary-precision StringToBigInt and
            // its allocation metering. Keep that boundary named rather than
            // round through an imprecise Number.
            (Kind::BigInt, _) | (_, Kind::BigInt) => {
                if strict {
                    false
                } else {
                    return Err(Step::Host(Halt::NotImplemented("equal")));
                }
            }
            _ => {
                if strict {
                    strict_equals(&a, &b)
                } else {
                    loose_equals(&a, &b)
                }
            }
        };
        self.push(Slot::boolean(eq ^ negate));
        Ok(())
    }

    /// Invoke one of the callable methods selected by `ToPrimitive` through
    /// the shared `Call` dispatcher.
    fn call_primitive_method(
        &mut self,
        code: &[u8],
        method: Slot,
        receiver: Slot,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        if !self.is_callable_value(method) {
            // GetMethod/Call requires a callable conversion hook. A present
            // non-callable `@@toPrimitive`, `valueOf`, or `toString` throws a
            // realm-local TypeError that surrounding JS can catch.
            return Err(self.catchable_type_error_msg("call: not a function".into()));
        }
        self.invoke_value(code, method, receiver, args)
    }

    /// ECMAScript `ToPrimitive`, including `@@toPrimitive` and the ordinary
    /// `valueOf`/`toString` fallback order.  The hint is `true` for string and
    /// `false` for number; default-hint callers use
    /// [`Self::to_primitive_default`].
    fn to_primitive(&mut self, code: &[u8], value: Slot, string_hint: bool) -> Result<Slot, Step> {
        let hint = if string_hint {
            PrimitiveHint::String
        } else {
            PrimitiveHint::Number
        };
        self.to_primitive_with_hint(code, value, hint)
    }

    /// `ToPrimitive(value)` with the ECMAScript default hint. Date objects use
    /// the string fallback order; ordinary objects use the number order, and a
    /// guest `@@toPrimitive` observes the literal `"default"` hint.
    fn to_primitive_default(&mut self, code: &[u8], value: Slot) -> Result<Slot, Step> {
        self.to_primitive_with_hint(code, value, PrimitiveHint::Default)
    }

    fn to_primitive_with_hint(
        &mut self,
        code: &[u8],
        value: Slot,
        hint: PrimitiveHint,
    ) -> Result<Slot, Step> {
        let inst = match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => inst,
            _ => return Ok(value),
        };
        let string_hint = hint == PrimitiveHint::String
            || (hint == PrimitiveHint::Default && self.dates.contains_key(&inst));

        if let Some((_, symbol)) = self
            .well_known_symbols
            .iter()
            .find(|(name, _)| *name == "toPrimitive")
            .copied()
        {
            if let Payload::Reference(desc) = symbol.value {
                let id = self.intern_symbol_key(desc);
                // GetMethod begins with the object's full [[Get]], including
                // accessor invocation and proxy traps. A raw slot lookup would
                // return an accessor's placeholder value and lose an abrupt
                // completion from its getter.
                let exotic = self.mop_get(code, inst, id, value)?;
                // GetMethod: a `null` `@@toPrimitive` is absent exactly like an
                // `undefined` one and falls through to OrdinaryToPrimitive;
                // only a present non-nullish non-callable is the TypeError
                // (`fxToPrimitive` tests both `mxIsUndefined` and `mxIsNull`).
                if !matches!(exotic.kind, Kind::Undefined | Kind::Null) {
                    let hint = match hint {
                        PrimitiveHint::Default => b"default".as_slice(),
                        PrimitiveHint::Number => b"number".as_slice(),
                        PrimitiveHint::String => b"string".as_slice(),
                    };
                    let off = self.alloc_str_text(hint);
                    let result = self.call_primitive_method(
                        code,
                        exotic,
                        value,
                        &[Slot::of(Kind::String, Payload::String(off))],
                    )?;
                    if result.kind != Kind::Reference {
                        return Ok(result);
                    }
                    return Err(self.catchable_type_error_msg("cannot coerce to primitive".into()));
                }
            }
        }

        self.ordinary_to_primitive(code, value, string_hint)
    }

    /// OrdinaryToPrimitive over an object after the caller has selected the
    /// preferred method order. This deliberately does not consult
    /// `@@toPrimitive`; it is the shared fallback for `ToPrimitive` and the
    /// intrinsic Date exotic-to-primitive method itself.
    fn ordinary_to_primitive(
        &mut self,
        code: &[u8],
        value: Slot,
        string_hint: bool,
    ) -> Result<Slot, Step> {
        let inst = match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error()),
        };
        let names = if string_hint {
            ["toString", "valueOf"]
        } else {
            ["valueOf", "toString"]
        };
        for name in names {
            let Some(&id) = self.symbol_ids.get(name) else {
                if !string_hint && name == "valueOf" {
                    if let Some(primitive) = self.wrapper_data.get(&inst).copied() {
                        return Ok(primitive);
                    }
                }
                continue;
            };
            let method = self.mop_get(code, inst, id, value)?;
            if method.kind == Kind::Undefined {
                if !string_hint && name == "valueOf" {
                    if let Some(primitive) = self.wrapper_data.get(&inst).copied() {
                        return Ok(primitive);
                    }
                }
                continue;
            }
            // OrdinaryToPrimitive calls only callable `valueOf`/`toString`
            // properties; a present non-callable property is skipped. This
            // differs from the `@@toPrimitive` GetMethod above, where a
            // present non-callable value is itself a TypeError.
            if !self.is_callable_value(method) {
                continue;
            }
            let result = self.call_primitive_method(code, method, value, &[])?;
            if result.kind != Kind::Reference {
                return Ok(result);
            }
        }
        Err(self.catchable_type_error_msg(if string_hint {
            "cannot coerce object to string".into()
        } else {
            "cannot coerce object to number".into()
        }))
    }

    /// `ToNumeric` after `ToPrimitive`, retaining XS's integer fast kind where
    /// possible, preserving BigInt, parsing a string as one complete
    /// ECMAScript number, and raising the required catchable TypeError for a
    /// Symbol. Callers whose abstract operation is specifically `ToNumber`
    /// reject the preserved BigInt at their boundary.
    fn to_number_value(&mut self, code: &[u8], value: Slot) -> Result<Slot, Step> {
        let primitive = self.to_primitive(code, value, false)?;
        match primitive.kind {
            Kind::Integer | Kind::Number => Ok(primitive),
            Kind::String => match primitive.value {
                Payload::String(off) => Ok(math_to_integer(string_to_number(
                    self.str_text(off).as_bytes(),
                    true,
                ))),
                _ => unreachable!(),
            },
            Kind::Boolean | Kind::Null | Kind::Undefined => Ok(Slot::number(to_number(&primitive))),
            Kind::BigInt => Ok(primitive),
            Kind::Symbol => {
                Err(self.catchable_type_error_msg("cannot coerce symbol to number".into()))
            }
            _ => Err(Step::Host(Halt::EngineInvariant(
                "to_numeric:non-value-kind",
            ))),
        }
    }

    /// XS bitwise coercion uses ToInteger diagnostics while preserving BigInt.
    fn to_numeric_integer_value(&mut self, code: &[u8], value: Slot) -> Result<Slot, Step> {
        let primitive = self.to_primitive(code, value, false)?;
        if primitive.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to integer".into()));
        }
        self.to_number_value(code, primitive)
    }

    /// ECMAScript `ToNumber`: run the shared observable primitive conversion,
    /// then reject the BigInt value that `ToNumeric` deliberately preserves.
    fn to_number_f64(&mut self, code: &[u8], value: Slot) -> Result<f64, Step> {
        let number = self.to_number_value(code, value)?;
        if number.kind == Kind::BigInt {
            return Err(self.catchable_type_error_msg("cannot coerce to number".into()));
        }
        Ok(to_number(&number))
    }

    /// `XS_CODE_ADD` with the string/reference cases (xsRun.c's
    /// `XS_CODE_ADD_GENERAL`): a reference operand needs `ToPrimitive`
    /// (unsupported); a string operand means concatenation
    /// ([`Self::concat_add`]); otherwise the numeric fast path
    /// ([`Self::binary_arith`]).
    fn op_add(&mut self, code: &[u8]) -> Result<(), Step> {
        let n = self.stack.len();
        if n < 2 {
            return Err(Step::Host(Halt::EngineInvariant("add:stack-underflow")));
        }
        let a = self.to_primitive_default(code, self.stack[n - 2])?;
        let b = self.to_primitive_default(code, self.stack[n - 1])?;
        // After ToPrimitive, either String selects concatenation and ToString
        // accepts a BigInt. Otherwise two BigInts add, while a BigInt mixed
        // with a Number throws the catchable TypeError from ToNumeric.
        if a.kind == Kind::String || b.kind == Kind::String {
            if a.kind == Kind::Symbol || b.kind == Kind::Symbol {
                return Err(self.catchable_type_error_msg("cannot coerce symbol to string".into()));
            }
            self.stack.truncate(n - 2);
            self.concat_add(a, b);
            return Ok(());
        }
        if a.kind == Kind::BigInt || b.kind == Kind::BigInt {
            if let Some(r) = self.try_bigint_binop(ArithOp::Add, a, b)? {
                self.stack.truncate(n - 2);
                self.push(r);
                return Ok(());
            }
            return Err(Step::Host(Halt::EngineInvariant(
                "bigint:missing-binary-result",
            )));
        }
        self.stack.truncate(n - 2);
        self.push(a);
        self.push(b);
        self.binary_arith(code, ArithOp::Add)
    }

    /// String `+`: `ToString` both operands and concatenate, metering
    /// exactly at XS's sites — a `ToString` of a number allocates its
    /// rendered chunk (`tick_chunk_new(len+1)`; `ToString` of a
    /// string/boolean/null/undefined is an interned or identity no-op with
    /// no allocation), and `fxConcatString` allocates the joined chunk
    /// `fxNewChunk(aSize + bSize + 1)`. The result is a new heap String.
    fn concat_add(&mut self, a: Slot, b: Slot) {
        let ua = self.to_string_units_metered(a);
        let ub = self.to_string_units_metered(b);
        // fxConcatString: one fxNewChunk over the joined code units. Metered by
        // total code-unit length (`+1`, the re-based O(n) string weight; for
        // ASCII operands this equals the old CESU-8 `aSize + bSize + 1`).
        self.meter.tick_string((ua.len() + ub.len()) as u64);
        let mut joined = Vec::with_capacity(ua.len() + ub.len());
        joined.extend_from_slice(&ua);
        joined.extend_from_slice(&ub);
        let off = self.chunks.alloc(&units_to_be16(&joined));
        self.push(Slot::of(Kind::String, Payload::String(off)));
    }

    /// `ToString` of a primitive to its content bytes (no NUL), metering
    /// the allocation XS's `fxToString` performs: a number renders to a
    /// fresh chunk (`fxNumberToString` → `tick_chunk_new(len+1)`); a string
    /// is identity and a boolean/null/undefined is an interned string, both
    /// allocation-free.
    /// Coerce a value to a **String slot** (`fxToString`), metering exactly
    /// the allocation `fxToString` performs. A string is identity (no chunk);
    /// a number/bigint renders into a fresh chunk; a boolean/null/undefined is
    /// an interned string. Used where the coerced string itself is retained
    /// (e.g. `exec`'s `input`, which XS aliases to the argument string rather
    /// than copying).
    fn to_string_slot_metered(&mut self, s: Slot) -> Slot {
        if s.kind == Kind::String {
            return s;
        }
        let units = self.to_string_units_metered(s);
        // `to_string_units_metered` already charged the render chunk; store the
        // slot without double-charging (a number's chunk was metered; the
        // boolean/null/undefined interned strings carry no chunk).
        let off = self.chunks.alloc(&units_to_be16(&units));
        Slot::of(Kind::String, Payload::String(off))
    }

    /// `ToString` of a value to its UTF-16 code units, metering the render
    /// allocation exactly where `to_string_bytes_metered` does. A string
    /// returns its stored units verbatim (exact — lone surrogates survive); a
    /// non-string renders to text (ASCII-shaped) and encodes to units. Used
    /// where the coerced string is retained/joined at storage fidelity
    /// (`concat`, `to_string_slot_metered`).
    fn to_string_units_metered(&mut self, s: Slot) -> Vec<u16> {
        if s.kind == Kind::String {
            if let Payload::String(off) = s.value {
                return self.str_units(off);
            }
        }
        let bytes = self.to_string_bytes_metered(s);
        String::from_utf8_lossy(&bytes).encode_utf16().collect()
    }

    fn to_string_bytes_metered(&mut self, s: Slot) -> Vec<u8> {
        match s.value {
            Payload::String(off) => self.str_text(off).into_bytes(),
            Payload::Integer(i) => {
                let r = i.to_string().into_bytes();
                // `fxToString`/`fxNumberToString` on a number renders into a
                // fresh chunk (`tick_chunk_new(len+1)`) and meters one
                // built-in step (`mxMeterOne`) for the conversion — measured
                // against the pin as exactly `XS_BUILTIN_METERING` over the
                // allocation.
                self.meter.tick_builtin();
                self.meter.tick_string(r.len() as u64);
                r
            }
            Payload::Number(n) => {
                let r = number_to_ecma_string(n).into_bytes();
                self.meter.tick_builtin();
                self.meter.tick_string(r.len() as u64);
                r
            }
            Payload::Boolean(bv) => {
                if bv {
                    b"true".to_vec()
                } else {
                    b"false".to_vec()
                }
            }
            Payload::None => match s.kind {
                Kind::Null => b"null".to_vec(),
                _ => b"undefined".to_vec(),
            },
            Payload::Reference(_) => Vec::new(), // unreachable: op_add rejects references
            Payload::At(..) => Vec::new(),       // unreachable: not a primitive value
            // `String(aBigInt)` — the decimal magnitude with a leading `-`.
            // `fxBigIntToString` renders into a fresh chunk; metered as a
            // number's ToString is (one built-in step + the result chunk).
            Payload::BigInt(off) => {
                let (neg, mag) = self.read_bigint(off);
                let r = bi_to_decimal(neg, &mag).into_bytes();
                self.meter.tick_builtin();
                self.meter.tick_string(r.len() as u64);
                r
            }
        }
    }

    /// Read a BigInt chunk into `(negative, little-endian u32 limbs)`.
    fn read_bigint(&self, off: crate::value::ChunkOffset) -> (bool, Vec<u32>) {
        let bytes = self.chunks.payload(off);
        let neg = bytes.first().copied().unwrap_or(0) == 1;
        let mut mag = Vec::with_capacity(bytes.len() / 4);
        let mut i = 1;
        while i + 4 <= bytes.len() {
            mag.push(u32::from_le_bytes([
                bytes[i],
                bytes[i + 1],
                bytes[i + 2],
                bytes[i + 3],
            ]));
            i += 4;
        }
        if mag.is_empty() {
            mag.push(0);
        }
        (neg, bi_trim(mag))
    }

    /// Convert a BigInt magnitude to the nearest IEEE-754 binary64 value,
    /// using round-to-nearest, ties-to-even. Reading only the leading 53 bits
    /// and the discarded round/sticky bits avoids an intermediate `f64`
    /// accumulation (and therefore avoids double rounding for wide values).
    fn bigint_to_f64(&self, off: crate::value::ChunkOffset) -> f64 {
        let (negative, magnitude) = self.read_bigint(off);
        if bi_is_zero(&magnitude) {
            return 0.0;
        }

        let top = *magnitude.last().expect("a BigInt has at least one limb");
        let bit_length = (magnitude.len() - 1) * 32 + (32 - top.leading_zeros() as usize);
        let mut exponent = bit_length - 1;
        let discarded = bit_length.saturating_sub(53);

        let bit = |position: usize| -> bool {
            magnitude
                .get(position / 32)
                .is_some_and(|limb| limb & (1u32 << (position % 32)) != 0)
        };
        let mut significand = 0u64;
        for position in (discarded..bit_length).rev() {
            significand = (significand << 1) | u64::from(bit(position));
        }
        if bit_length < 53 {
            significand <<= 53 - bit_length;
        }

        if discarded > 0 {
            let round = bit(discarded - 1);
            let sticky = (0..discarded - 1).any(bit);
            if round && (sticky || significand & 1 != 0) {
                significand += 1;
                if significand == 1u64 << 53 {
                    significand >>= 1;
                    exponent += 1;
                }
            }
        }

        if exponent > 1023 {
            return if negative {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            };
        }
        let sign = u64::from(negative) << 63;
        let biased = (exponent as u64 + 1023) << 52;
        let fraction = significand - (1u64 << 52);
        f64::from_bits(sign | biased | fraction)
    }

    /// The BigInt primitive carried by a primitive or boxed receiver.
    fn bigint_this_value(&mut self, this: Slot) -> Result<Slot, Step> {
        if this.kind == Kind::BigInt {
            return Ok(this);
        }
        match this.value {
            Payload::Reference(owner) => self
                .wrapper_data
                .get(&owner)
                .copied()
                .filter(|value| value.kind == Kind::BigInt)
                .ok_or_else(|| self.catchable_type_error_msg("this: not a bigint".into())),
            _ => Err(self.catchable_type_error_msg("this: not a bigint".into())),
        }
    }

    /// The Symbol primitive carried by a primitive or boxed receiver.
    fn symbol_this_value(&mut self, this: Slot) -> Result<Slot, Step> {
        if this.kind == Kind::Symbol {
            return Ok(this);
        }
        match this.value {
            Payload::Reference(owner) => self
                .wrapper_data
                .get(&owner)
                .copied()
                .filter(|value| value.kind == Kind::Symbol)
                .ok_or_else(|| self.catchable_type_error_msg("this: not a symbol".into())),
            _ => Err(self.catchable_type_error_msg("this: not a symbol".into())),
        }
    }

    /// `ToIndex(bits)` for `BigInt.asIntN` / `BigInt.asUintN`.
    fn to_bigint_width(&mut self, code: &[u8], value: Slot) -> Result<u64, Step> {
        let n = self.to_number_f64(code, value)?;
        let integer = if n.is_nan() { 0.0 } else { n.trunc() };
        if integer < 0.0 {
            return Err(self.catchable_range_error_msg("index < 0".into()));
        }
        if !integer.is_finite() || integer > 9_007_199_254_740_991.0 {
            return Err(self.catchable_range_error_msg("invalid index".into()));
        }
        Ok(integer as u64)
    }

    /// The general `ToBigInt` operation used by the width-limiting statics.
    /// Unlike the public `BigInt()` constructor, this rejects Number values.
    fn to_bigint_value(&mut self, code: &[u8], value: Slot) -> Result<Slot, Step> {
        let primitive = self.to_primitive(code, value, false)?;
        match primitive.kind {
            Kind::BigInt => Ok(primitive),
            Kind::Boolean => Ok(self.make_bigint(
                false,
                vec![u32::from(matches!(primitive.value, Payload::Boolean(true)))],
            )),
            Kind::String => {
                let text = match primitive.value {
                    Payload::String(off) => self.str_text(off),
                    _ => return Err(self.catchable_syntax_error()),
                };
                let (negative, magnitude) = parse_bigint_string(&text).ok_or_else(|| {
                    self.catchable_syntax_error_with_message(
                        "cannot coerce string to bigint".into(),
                    )
                })?;
                Ok(self.make_bigint(negative, magnitude))
            }
            _ => Err(self.catchable_type_error_msg(
                match primitive.kind {
                    Kind::Integer | Kind::Number => "cannot coerce number to bigint",
                    Kind::Symbol => "cannot coerce symbol to bigint",
                    _ => "cannot coerce to bigint",
                }
                .into(),
            )),
        }
    }

    /// Reduce `value` modulo `2**bits`, interpreting the retained high bit as
    /// a sign bit for `asIntN`. Widths that would require an adversarially
    /// large positive result are named unsupported; widths wider than an
    /// already-representable value return that value without allocation.
    fn bigint_as_n(&mut self, value: Slot, bits: u64, signed: bool) -> Result<Slot, Step> {
        const MAX_BIGINT_WIDTH_BITS: u64 = 64 * 1024;

        let Payload::BigInt(off) = value.value else {
            return Err(self.catchable_type_error());
        };
        let (negative, magnitude) = self.read_bigint(off);
        if bits == 0 || bi_is_zero(&magnitude) {
            return Ok(self.make_bigint(false, vec![0]));
        }
        let top = *magnitude
            .last()
            .expect("a non-zero BigInt has a leading limb");
        let magnitude_bits =
            (magnitude.len() as u64 - 1) * 32 + u64::from(32 - top.leading_zeros());

        if !negative && ((!signed && magnitude_bits <= bits) || (signed && magnitude_bits < bits)) {
            return Ok(value);
        }
        if negative && signed {
            let minimum_at_width = magnitude_bits == bits
                && magnitude
                    .iter()
                    .take(magnitude.len() - 1)
                    .all(|&limb| limb == 0)
                && top.is_power_of_two();
            if magnitude_bits < bits || minimum_at_width {
                return Ok(value);
            }
        }
        if bits > MAX_BIGINT_WIDTH_BITS {
            return Err(Step::Host(Halt::Refused("BigInt.asN:result-too-large")));
        }

        let limb_count = bits.div_ceil(32) as usize;
        let mut unsigned = vec![0u32; limb_count];
        let copied = limb_count.min(magnitude.len());
        unsigned[..copied].copy_from_slice(&magnitude[..copied]);
        if negative {
            for limb in &mut unsigned {
                *limb = !*limb;
            }
            bi_add_one_in_place(&mut unsigned);
        }
        bi_mask_width(&mut unsigned, bits);

        if signed {
            let sign_index = (bits - 1) as usize;
            let sign_set = unsigned[sign_index / 32] & (1u32 << (sign_index % 32)) != 0;
            if sign_set {
                for limb in &mut unsigned {
                    *limb = !*limb;
                }
                bi_add_one_in_place(&mut unsigned);
                bi_mask_width(&mut unsigned, bits);
                return Ok(self.make_bigint(true, unsigned));
            }
        }
        Ok(self.make_bigint(false, unsigned))
    }

    /// BigInt exponentiation (`base ** exponent`) using exponentiation by
    /// squaring. Negative exponents are a RangeError. The constant-result
    /// bases `0`, `1`, and `-1` accept arbitrarily wide positive exponents;
    /// other bases are bounded by projected result bits so adversarial source
    /// cannot turn one opcode into an unbounded host allocation.
    fn bigint_pow(&mut self, base: Slot, exponent: Slot) -> Result<Slot, Step> {
        // `bi_mul_mag` is the straightforward quadratic limb multiply. Keep
        // the largest admitted result small enough that one guest opcode
        // cannot monopolize the host before the next meter check.
        const MAX_BIGINT_POW_BITS: usize = 64 * 1024;

        let (Payload::BigInt(base_off), Payload::BigInt(exponent_off)) =
            (base.value, exponent.value)
        else {
            return Err(self.catchable_type_error_msg(if base.kind == Kind::BigInt {
                "cannot coerce right operand to bigint".into()
            } else {
                "cannot coerce left operand to bigint".into()
            }));
        };
        let (base_negative, base_magnitude) = self.read_bigint(base_off);
        let (exponent_negative, exponent_magnitude) = self.read_bigint(exponent_off);
        if exponent_negative {
            return Err(self.catchable_range_error_msg("negative exponent".into()));
        }
        if bi_is_zero(&exponent_magnitude) {
            return Ok(self.make_bigint(false, vec![1]));
        }
        if bi_is_zero(&base_magnitude) {
            return Ok(self.make_bigint(false, vec![0]));
        }
        if base_magnitude == [1] {
            let odd = exponent_magnitude[0] & 1 != 0;
            return Ok(self.make_bigint(base_negative && odd, vec![1]));
        }

        let exponent = if exponent_magnitude.len() == 1 {
            exponent_magnitude[0]
        } else {
            return Err(Step::Host(Halt::Refused("exponentiation:result-too-large")));
        };
        let top = *base_magnitude
            .last()
            .expect("a non-zero BigInt has a leading limb");
        let base_bits = (base_magnitude.len() - 1) * 32 + (32 - top.leading_zeros() as usize);
        let projected_bits = base_bits
            .checked_mul(exponent as usize)
            .ok_or(Step::Host(Halt::Refused("exponentiation:result-too-large")))?;
        if projected_bits > MAX_BIGINT_POW_BITS {
            return Err(Step::Host(Halt::Refused("exponentiation:result-too-large")));
        }

        let mut power = base_magnitude;
        let mut result = vec![1u32];
        let mut remaining = exponent;
        while remaining != 0 {
            if remaining & 1 != 0 {
                result = bi_mul_mag(&result, &power);
            }
            remaining >>= 1;
            if remaining != 0 {
                power = bi_mul_mag(&power, &power);
            }
        }
        let negative = base_negative && exponent & 1 != 0;
        // The allocation meter is charged at the retained result size. Exact
        // XS repeated-squaring work metering remains advisory in dual-run
        // coverage; the semantic result and allocation bound are enforced.
        Ok(self.make_bigint(negative, result))
    }

    /// Build a BigInt value from `(negative, limbs)`, allocating the digit
    /// chunk `[sign: u8][LE u32 limbs]` (trimmed; a `-0` normalizes to `+0`)
    /// and charging the allocation at the value's own size
    /// (`fxNewChunk(size * 4)`). Used where XS allocates exactly `bigint.size`
    /// limbs — a literal (`fxNewBigInt`) and a negation (`fxBigInt_neg` →
    /// `fxBigInt_alloc(a->size)`). An arithmetic result instead allocates its
    /// (pre-trim) working size and meters the chunk itself
    /// ([`Self::store_bigint`]).
    fn make_bigint(&mut self, neg: bool, mag: Vec<u32>) -> Slot {
        let mag = bi_trim(mag);
        self.meter.tick_chunk_new((mag.len() * 4) as u64);
        self.store_bigint(neg, mag)
    }

    /// Build a BigInt value without metering the chunk allocation (the caller
    /// meters it — at XS's allocation size, which for an arithmetic result is
    /// the pre-trim working size rather than the trimmed `bigint.size`).
    fn store_bigint(&mut self, neg: bool, mag: Vec<u32>) -> Slot {
        let mag = bi_trim(mag);
        let neg = if bi_is_zero(&mag) { false } else { neg };
        let mut bytes = Vec::with_capacity(1 + mag.len() * 4);
        bytes.push(neg as u8);
        for limb in &mag {
            bytes.extend_from_slice(&limb.to_le_bytes());
        }
        let off = self.chunks.alloc(&bytes);
        Slot::of(Kind::BigInt, Payload::BigInt(off))
    }

    /// Loose `==`/`!=` between a BigInt (`big`) and a Number/Integer (`num`),
    /// XS's `fxBigIntCompare` number path: a finite Number is coerced to a
    /// BigInt (`fxNumberToBigInt`, its `fxNewChunk(size*4)` the only metered
    /// residual) then compared by mathematical value, so a non-integral Number
    /// is never equal; a non-finite Number (`NaN`/`±Infinity`) is never equal
    /// and allocates no chunk. Returns the equality boolean.
    fn bigint_num_loose_eq(&mut self, big: Slot, num: Slot) -> bool {
        let n = match num.value {
            Payload::Integer(v) => v as f64,
            Payload::Number(v) => v,
            _ => return false,
        };
        if !n.is_finite() {
            return false;
        }
        let (nneg, nmag) = number_to_bigint(n);
        // fxNumberToBigInt allocates `size` limbs regardless of the fraction.
        self.meter.tick_chunk_new((nmag.len() * 4) as u64);
        if n.trunc() != n {
            return false; // a fractional Number is never == a BigInt
        }
        let off = match big.value {
            Payload::BigInt(o) => o,
            _ => return false,
        };
        let (bneg, bmag) = self.read_bigint(off);
        bneg == nneg && bmag == nmag
    }

    /// BigInt `+`/`-`/`*` (`fxBigInt_add`/`_sub`/`_mul`). Meters, in XS's order:
    /// the result digit chunk at XS's **allocation** size (`fxBigInt_alloc`,
    /// pre-trim) — a magnitude add allocates `max(a,b)+1` limbs, a magnitude
    /// subtract `max(a,b)`, a multiply `a.size+b.size`; then the digit step
    /// `mxBigInt_meter(result_size)` = `(result_size - 1) * XS_BIGINT_METERING`
    /// over the trimmed result size (XS trims `rr->size` in `uadd`/`usub`/
    /// `umul`); then the calibrated frame residual. Division and remainder use
    /// limb long division, truncate the quotient toward zero, and give the
    /// remainder the dividend's sign. Their retained-result allocation is
    /// metered here; exact XS long-division work calibration remains advisory.
    fn bigint_arith(
        &mut self,
        op: ArithOp,
        a_off: crate::value::ChunkOffset,
        b_off: crate::value::ChunkOffset,
    ) -> Result<Slot, Step> {
        let (na, ma) = self.read_bigint(a_off);
        let (nb, mb) = self.read_bigint(b_off);
        let (neg, mag) = match op {
            ArithOp::Add => bi_add(na, &ma, nb, &mb),
            ArithOp::Sub => bi_add(na, &ma, !nb, &mb),
            ArithOp::Mul => bi_mul(na, &ma, nb, &mb),
            ArithOp::Div | ArithOp::Mod => {
                if bi_is_zero(&mb) {
                    return Err(self.catchable_range_error_msg("zero divider".into()));
                }
                let (quotient, remainder) = bi_div_rem_mag(&ma, &mb);
                if op == ArithOp::Div {
                    (na != nb && !bi_is_zero(&quotient), quotient)
                } else {
                    (na && !bi_is_zero(&remainder), remainder)
                }
            }
        };
        // XS's per-op allocation size (`fxBigInt_alloc` limb count), which is
        // what `fxNewChunk` meters — distinct from the trimmed `bigint.size`.
        let max = ma.len().max(mb.len()) as u64;
        let alloc_limbs = match op {
            // `a + b`: magnitudes add when the signs agree (`uadd`, max+1), else
            // subtract (`usub`, max). `a - b`: the reverse.
            ArithOp::Add => {
                if na == nb {
                    max + 1
                } else {
                    max
                }
            }
            ArithOp::Sub => {
                if na != nb {
                    max + 1
                } else {
                    max
                }
            }
            ArithOp::Mul => (ma.len() + mb.len()) as u64,
            ArithOp::Div | ArithOp::Mod => mag.len() as u64,
        };
        self.meter.tick_chunk_new(alloc_limbs * 4);
        let size = mag.len() as u64; // trimmed to XS's post-op `rr->size`
        self.meter
            .tick_raw((size - 1) * crate::meter::BIGINT_METERING);
        self.meter.tick_raw(BIGINT_ARITH_FRAME_METERING);
        Ok(self.store_bigint(neg, mag))
    }

    /// BigInt `++`/`--` (`fxBigInt_inc`/`fxBigInt_dec`), which delegate to
    /// addition/subtraction with XS's static `gxBigIntOne`. The constant does
    /// not allocate; only the arithmetic result and digit work are charged.
    fn bigint_update(&mut self, value: crate::value::ChunkOffset, increment: bool) -> Slot {
        let (negative, magnitude) = self.read_bigint(value);
        let one = [1u32];
        let (result_negative, result_magnitude) = if increment {
            bi_add(negative, &magnitude, false, &one)
        } else {
            bi_add(negative, &magnitude, true, &one)
        };
        let max = magnitude.len().max(one.len()) as u64;
        let allocation_limbs = if increment {
            if negative {
                max
            } else {
                max + 1
            }
        } else if negative {
            max + 1
        } else {
            max
        };
        self.meter.tick_chunk_new(allocation_limbs * 4);
        self.meter
            .tick_raw((result_magnitude.len() as u64 - 1) * crate::meter::BIGINT_METERING);
        self.meter.tick_raw(BIGINT_ARITH_FRAME_METERING);
        self.store_bigint(result_negative, result_magnitude)
    }

    /// If `a`/`b` involve a BigInt, dispatch the op: both BigInt → BigInt
    /// arithmetic; a BigInt mixed with any non-BigInt → catchable TypeError.
    /// Returns `Ok(None)` when neither is a BigInt.
    fn try_bigint_binop(&mut self, op: ArithOp, a: Slot, b: Slot) -> Result<Option<Slot>, Step> {
        if a.kind != Kind::BigInt && b.kind != Kind::BigInt {
            return Ok(None);
        }
        match (a.value, b.value) {
            (Payload::BigInt(x), Payload::BigInt(y)) => Ok(Some(self.bigint_arith(op, x, y)?)),
            _ => Err(self.catchable_type_error_msg(if a.kind == Kind::BigInt {
                "cannot coerce right operand to bigint".into()
            } else {
                "cannot coerce left operand to bigint".into()
            })),
        }
    }

    /// Compare an exact BigInt with an IEEE-754 Number without converting the
    /// BigInt to f64. `None` represents the abstract relational comparison's
    /// undefined result for NaN.
    fn compare_bigint_number(
        &self,
        bigint: crate::value::ChunkOffset,
        number: f64,
    ) -> Option<std::cmp::Ordering> {
        use std::cmp::Ordering;
        if number.is_nan() {
            return None;
        }
        if number == f64::INFINITY {
            return Some(Ordering::Less);
        }
        if number == f64::NEG_INFINITY {
            return Some(Ordering::Greater);
        }

        let (bigint_negative, bigint_magnitude) = self.read_bigint(bigint);
        let truncated = number.trunc();
        let (number_negative, number_magnitude) = number_to_bigint(truncated);
        let ordering = bi_cmp(
            bigint_negative,
            &bigint_magnitude,
            number_negative,
            &number_magnitude,
        );
        if ordering != Ordering::Equal || number == truncated {
            return Some(ordering);
        }
        // The BigInt equals trunc(number). A positive fractional Number lies
        // just above it; a negative fractional Number lies just below it.
        Some(if number.is_sign_positive() {
            Ordering::Less
        } else {
            Ordering::Greater
        })
    }

    /// BigInt `&`/`|`/`^` over the spec's infinite two's-complement values.
    /// One extra high limb preserves sign extension while the operation runs;
    /// the result is converted back to canonical sign+magnitude form.
    fn bigint_bitwise(
        &mut self,
        op: BitOp,
        a: crate::value::ChunkOffset,
        b: crate::value::ChunkOffset,
    ) -> Slot {
        let (a_negative, a_magnitude) = self.read_bigint(a);
        let (b_negative, b_magnitude) = self.read_bigint(b);
        let width = a_magnitude.len().max(b_magnitude.len()) + 1;
        let a_twos = bi_to_twos_complement(a_negative, &a_magnitude, width);
        let b_twos = bi_to_twos_complement(b_negative, &b_magnitude, width);
        let result = a_twos
            .into_iter()
            .zip(b_twos)
            .map(|(a_limb, b_limb)| match op {
                BitOp::And => a_limb & b_limb,
                BitOp::Or => a_limb | b_limb,
                BitOp::Xor => a_limb ^ b_limb,
                _ => unreachable!("only the three logical BigInt ops call this helper"),
            })
            .collect();
        let (negative, magnitude) = bi_from_twos_complement(result);
        self.make_bigint(negative, magnitude)
    }

    /// BigInt signed shifts. A negative BigInt count reverses direction. Right
    /// shift is arithmetic (floor division by a power of two); a shift beyond
    /// the value's bit length therefore saturates to `0n` or `-1n`. Left shifts
    /// are bounded to keep one guest opcode from forcing an unbounded host
    /// allocation.
    fn bigint_shift(
        &mut self,
        op: BitOp,
        value: crate::value::ChunkOffset,
        count: crate::value::ChunkOffset,
    ) -> Result<Slot, Step> {
        const MAX_BIGINT_SHIFT_RESULT_BITS: usize = 64 * 1024;

        let (negative, magnitude) = self.read_bigint(value);
        let (count_negative, count_magnitude) = self.read_bigint(count);
        if bi_is_zero(&magnitude) {
            return Ok(self.make_bigint(false, vec![0]));
        }
        let shifts_left = (op == BitOp::Shl) != count_negative;
        let value_bits = bi_bit_length(&magnitude);
        if shifts_left {
            let max_shift = MAX_BIGINT_SHIFT_RESULT_BITS.saturating_sub(value_bits);
            let shift = bi_usize_up_to(&count_magnitude, max_shift)
                .ok_or(Step::Host(Halt::Refused("bigint-shift:result-too-large")))?;
            return Ok(self.make_bigint(negative, bi_shl_bits(&magnitude, shift)));
        }

        let Some(shift) = bi_usize_up_to(&count_magnitude, value_bits) else {
            return Ok(if negative {
                self.make_bigint(true, vec![1])
            } else {
                self.make_bigint(false, vec![0])
            });
        };
        let (mut shifted, discarded) = bi_shr_mag(&magnitude, shift);
        if negative && discarded {
            shifted = bi_add_mag(&shifted, &[1]);
        }
        Ok(self.make_bigint(negative, shifted))
    }

    /// BigInt bitwise complement: `~x === -x - 1n`, expressed directly over
    /// sign+magnitude limbs to avoid constructing an intermediate BigInt.
    fn bigint_bit_not(&mut self, value: crate::value::ChunkOffset) -> Slot {
        let (negative, magnitude) = self.read_bigint(value);
        if negative {
            self.make_bigint(false, bi_sub_mag(&magnitude, &[1]))
        } else {
            self.make_bigint(true, bi_add_mag(&magnitude, &[1]))
        }
    }
}

/// The primitive value globals XS's realm exposes by name (non-writable,
/// non-configurable): a reference reads the value with no allocation, so
/// binding them is metering-neutral. Returns the slot value for a known
/// name, else `None` (leaving the name to resolve as an ordinary global).
fn value_global(name: &str) -> Option<Slot> {
    match name {
        "undefined" => Some(Slot::undefined()),
        "NaN" => Some(Slot::number(f64::NAN)),
        "Infinity" => Some(Slot::number(f64::INFINITY)),
        _ => None,
    }
}

/// Decode a numeric element of type `kind` (an index into
/// [`TYPED_ARRAY_TYPES`]) from its little-endian bytes `b` (length == the
/// element size) to a number/integer completion. `None` for a BigInt
/// element (kind 0/1), whose BigInt decode is a later increment. The
/// `Uint32` result is an integer completion when it fits int32, else a
/// number (XS's `fxUint32Getter`).
fn decode_element_le(kind: u8, b: &[u8]) -> Option<Slot> {
    Some(match kind {
        0 | 1 => return None,
        // Float32
        2 => Slot::number(f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64),
        // Float64
        3 => Slot::number(f64::from_le_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ])),
        // Int8
        4 => Slot::integer(b[0] as i8 as i32),
        // Int16
        5 => Slot::integer(i16::from_le_bytes([b[0], b[1]]) as i32),
        // Int32
        6 => Slot::integer(i32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        // Uint8 / Uint8Clamped
        7 | 10 => Slot::integer(b[0] as i32),
        // Uint16
        8 => Slot::integer(u16::from_le_bytes([b[0], b[1]]) as i32),
        // Uint32
        9 => {
            let u = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            if u <= 0x7FFF_FFFF {
                Slot::integer(u as i32)
            } else {
                Slot::number(u as f64)
            }
        }
        _ => return None,
    })
}

/// Encode the number `n` as a numeric element of type `kind` to
/// little-endian bytes, applying the per-type coercion the XS setter does
/// (ToInteger truncation + width wrap for the int/uint types, ToNumber +
/// clamp/round for `Uint8ClampedArray`, IEEE for the floats). `None` for a
/// BigInt element (kind 0/1).
fn encode_element_le(kind: u8, n: f64) -> Option<Vec<u8>> {
    // `ToInt8`/`ToUint8`/`ToInt16`/… : `NaN` and `±∞` map to `+0`; a finite
    // value truncates toward zero (`ToIntegerOrInfinity`) then reduces modulo
    // `2^bits` (two's-complement wrap). A Rust `f64 as iN` cast SATURATES
    // (`Infinity as i64` → `i64::MAX`), which is NOT the spec's modular
    // reduction — hence the explicit `rem_euclid`.
    let to_wrapped = |x: f64, bits: u32| -> u64 {
        if !x.is_finite() {
            return 0;
        }
        let m = 2f64.powi(bits as i32);
        // `rem_euclid` lands in `[0, 2^bits)`; the caller's `as uN` truncation
        // then keeps the low `bits`, so `-255 mod 256 == 1`, `2^53 mod 256 == 0`.
        x.trunc().rem_euclid(m) as u64
    };
    Some(match kind {
        0 | 1 => return None,
        // Float32
        2 => {
            let value = if n.is_nan() {
                f32::from_bits(0x7fc0_0000)
            } else {
                n as f32
            };
            value.to_le_bytes().to_vec()
        }
        // Float64
        3 => canonicalize_nan(n).to_le_bytes().to_vec(),
        // Int8 / Uint8
        4 | 7 => vec![to_wrapped(n, 8) as u8],
        // Int16 / Uint16
        5 | 8 => (to_wrapped(n, 16) as u16).to_le_bytes().to_vec(),
        // Int32 / Uint32
        6 | 9 => (to_wrapped(n, 32) as u32).to_le_bytes().to_vec(),
        // Uint8Clamped (ToNumber, clamp to [0,255], round half-to-even).
        10 => {
            let v = if n.is_nan() || n <= 0.0 {
                0.0
            } else if n >= 255.0 {
                255.0
            } else {
                round_half_even(n)
            };
            vec![v as u8]
        }
        _ => return None,
    })
}

/// Round to the nearest integer, ties to even (C's `c_nearbyint` under the
/// default rounding mode) — the `Uint8ClampedArray` setter's rounding.
fn round_half_even(x: f64) -> f64 {
    let r = x.round(); // ties away from zero
    if (x - x.trunc()).abs() == 0.5 {
        // A halfway value: pick the even neighbor.
        let lower = x.floor();
        if (lower as i64) % 2 == 0 {
            lower
        } else {
            x.ceil()
        }
    } else {
        r
    }
}

fn temporal_set_time_args(
    interp: &mut Interp,
    record: &mut TemporalPlainRecord,
    args: &[Slot],
    start: usize,
) -> Result<(), Step> {
    let mut out = [0u32; 6];
    for (n, field) in out.iter_mut().enumerate() {
        let value = args.get(start + n).copied().unwrap_or_else(Slot::undefined);
        if value.kind != Kind::Undefined {
            *field = u32::try_from(interp.temporal_integer(value)?)
                .map_err(|_| interp.catchable_range_error())?;
        }
    }
    [
        record.hour,
        record.minute,
        record.second,
        record.millisecond,
        record.microsecond,
        record.nanosecond,
    ] = out;
    Ok(())
}

// Proleptic-Gregorian civil date conversion (Howard Hinnant's algorithms),
// expressed entirely in integers so every supported Instant stays nanosecond exact.

// -----------------------------------------------------------------------------
// Temporal.ZonedDateTime / Temporal.Now support (fixed-offset time-zone model).
// -----------------------------------------------------------------------------

/// A `&'static str` naming an unmodeled native **call** for
/// [`Halt::NotImplemented`], so the differential runner records the skip
/// attributed to the specific built-in (never a silent mis-execution).
fn native_unsupported_name(native: Native) -> &'static str {
    match native {
        Native::Eval => "native-call:eval",
        Native::Locale => "native-call:Locale",
        Native::Collator => "native-call:Collator",
        Native::ListFormat => "native-call:ListFormat",
        Native::PluralRules => "native-call:PluralRules",
        Native::Segmenter => "native-call:Segmenter",
        Native::DateTimeFormat => "native-call:DateTimeFormat",
        Native::NumberFormat => "native-call:NumberFormat",
        Native::TemporalInstant => "native-call:Temporal.Instant",
        Native::TemporalDuration => "native-call:Temporal.Duration",
        Native::TemporalPlain(i) => match i {
            0 => "native-call:Temporal.PlainDate",
            1 => "native-call:Temporal.PlainTime",
            2 => "native-call:Temporal.PlainDateTime",
            3 => "native-call:Temporal.PlainYearMonth",
            4 => "native-call:Temporal.PlainMonthDay",
            _ => "native-call:Temporal.Calendar",
        },
        Native::TemporalZonedDateTime => "native-call:Temporal.ZonedDateTime",
        Native::Object => "native-call:Object",
        Native::Function => "native-call:Function",
        Native::Boolean => "native-call:Boolean",
        Native::Symbol => "native-call:Symbol",
        Native::BigInt => "native-call:BigInt",
        Native::Number => "native-call:Number",
        Native::String => "native-call:String",
        Native::Date => "native-call:Date",
        Native::Array => "native-call:Array",
        Native::Error => "native-call:Error",
        Native::EvalError => "native-call:EvalError",
        Native::RangeError => "native-call:RangeError",
        Native::ReferenceError => "native-call:ReferenceError",
        Native::SyntaxError => "native-call:SyntaxError",
        Native::TypeError => "native-call:TypeError",
        Native::URIError => "native-call:URIError",
        Native::AggregateError => "native-call:AggregateError",
        Native::SuppressedError => "native-call:SuppressedError",
        Native::DisposableStack => "native-call:DisposableStack",
        Native::AsyncDisposableStack => "native-call:AsyncDisposableStack",
        Native::Map => "native-call:Map",
        Native::Set => "native-call:Set",
        Native::WeakMap => "native-call:WeakMap",
        Native::WeakSet => "native-call:WeakSet",
        Native::Iterator => "native-call:Iterator",
        Native::ArrayBuffer => "native-call:ArrayBuffer",
        Native::SharedArrayBuffer => "native-call:SharedArrayBuffer",
        Native::TypedArrayBase => "native-call:TypedArray",
        Native::TypedArray(_) => "native-call:TypedArray",
        Native::DataView => "native-call:DataView",
        Native::Promise => "native-call:Promise",
        Native::RegExp => "native-call:RegExp",
        Native::Proxy => "native-call:Proxy",
        Native::GeneratorFunction => "native-call:GeneratorFunction",
        Native::AsyncFunction => "native-call:AsyncFunction",
        Native::AsyncGeneratorFunction => "native-call:AsyncGeneratorFunction",
    }
}

/// Map a property id to the `XS_REGEXP_*` bit its boolean per-flag getter
/// reads (`fx_RegExp_prototype_get_{global,ignoreCase,…}`), or `None` when
/// the id is not one of the per-flag getters.
fn regexp_flag_bit_for(g: RegExpGetterIds, id: u16) -> Option<u32> {
    use ironhorse_regexp::{
        XS_REGEXP_D, XS_REGEXP_G, XS_REGEXP_I, XS_REGEXP_M, XS_REGEXP_S, XS_REGEXP_U, XS_REGEXP_V,
        XS_REGEXP_Y,
    };
    let some = Some(id);
    if some == g.global {
        Some(XS_REGEXP_G)
    } else if some == g.ignore_case {
        Some(XS_REGEXP_I)
    } else if some == g.multiline {
        Some(XS_REGEXP_M)
    } else if some == g.dot_all {
        Some(XS_REGEXP_S)
    } else if some == g.sticky {
        Some(XS_REGEXP_Y)
    } else if some == g.unicode {
        Some(XS_REGEXP_U)
    } else if some == g.has_indices {
        Some(XS_REGEXP_D)
    } else if some == g.unicode_sets {
        Some(XS_REGEXP_V)
    } else {
        None
    }
}

#[derive(Copy, Clone, Eq, PartialEq)]
enum BitOp {
    And,
    Or,
    Xor,
    Shl,
    Sar,
    Shr,
}
#[derive(Copy, Clone)]
enum RelOp {
    Less,
    LessEqual,
    More,
    MoreEqual,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PrimitiveHint {
    Default,
    Number,
    String,
}

/// Count the `new_local` opcodes in a function body `[start, start+len)`,
/// skipping any nested function bodies (a nested `code M` embeds M bytes
/// that belong to the inner function, whose own `code` opcode counts
/// them). Mirrors the dispatch loop's instruction-advance quirks: an
/// `id`-operand opcode is `1 + ID_SIZE`, `new_property`/`new_property_at`
/// carry a 2-byte inline flag operand (5 bytes total), and `code_*`
/// advances past both its length operand and the embedded body. Used to
/// meter the per-declared-local definition cost ([`FUNCTION_LOCAL_METERING`])
/// at `code` time.
fn count_new_locals(code: &[u8], start: usize, len: usize) -> usize {
    let end = (start + len).min(code.len());
    let mut pc = start;
    let mut n = 0usize;
    while pc < end {
        let op = match Opcode::from_u8(code[pc]) {
            Some(o) => o,
            None => break,
        };
        if op == Opcode::XS_CODE_NEW_LOCAL {
            n += 1;
        }
        let step = match op {
            // Nested function body: skip the length operand and the M
            // embedded body bytes (they are the inner function's locals).
            Opcode::XS_CODE_CODE_1 => 2 + *code.get(pc + 1).unwrap_or(&0) as usize,
            Opcode::XS_CODE_CODE_2 => {
                3 + u16::from_le_bytes([
                    *code.get(pc + 1).unwrap_or(&0),
                    *code.get(pc + 2).unwrap_or(&0),
                ]) as usize
            }
            Opcode::XS_CODE_CODE_4 => {
                5 + u32::from_le_bytes([
                    *code.get(pc + 1).unwrap_or(&0),
                    *code.get(pc + 2).unwrap_or(&0),
                    *code.get(pc + 3).unwrap_or(&0),
                    *code.get(pc + 4).unwrap_or(&0),
                ]) as usize
            }
            // The 2-byte inline flag operand `new_property`/`new_property_at`
            // carry past their id (the dispatch loop advances 5, not the
            // `instruction_len` id-opcode 3). The AT form has NO id
            // operand: a 1-byte opcode whose 2-byte INTEGER_1 flag is a
            // separate instruction the loop below sizes itself. Counting it
            // twice would desynchronize the scan.
            Opcode::XS_CODE_NEW_PROPERTY => 5,
            Opcode::XS_CODE_NEW_PROPERTY_AT => 1,
            Opcode::XS_CODE_NEW_PRIVATE_1 => 4,
            Opcode::XS_CODE_NEW_PRIVATE_2 => 5,
            _ => crate::opcode::instruction_len(code, pc).unwrap_or(1),
        };
        if step == 0 {
            break;
        }
        pc += step;
    }
    n
}

#[inline]
fn branch_target(pc: usize, size: i8, offset: i32) -> usize {
    // pc + INDEX(size) + OFFSET, in XS's signed arithmetic.
    (pc as isize + size as isize + offset as isize) as usize
}

// ToBoolean (ECMAScript 7.1.2) for values not requiring chunk inspection.
fn to_boolean(s: &Slot) -> bool {
    match s.value {
        Payload::None => false, // undefined and null are both falsy
        Payload::Boolean(b) => b,
        Payload::Integer(i) => i != 0,
        Payload::Number(n) => !(n == 0.0 || n.is_nan()),
        Payload::String(_) => true, // Interp::truthy handles string contents first
        Payload::Reference(_) => true,
        Payload::At(..) => true, // a transient key is never ToBoolean'd
        // A BigInt's zero-ness needs the digit chunk; [`Interp::truthy`]
        // handles a BigInt operand before delegating here, so this arm is
        // reached only defensively.
        Payload::BigInt(_) => true,
    }
}

// The child carries its test-only cfg for both rustc and the source locks.
mod tests;

/// Render a sign/magnitude BigInt in radix 2 through 36.
fn bi_to_radix(
    vm: &mut Interp,
    negative: bool,
    magnitude: &[u32],
    radix: u32,
) -> Result<String, Step> {
    debug_assert!((2..=36).contains(&radix));
    if bi_is_zero(magnitude) {
        return Ok("0".into());
    }
    let mut limbs = Interp::fill_scratch(
        vm.reserve_work_scratch(magnitude.len())?,
        magnitude.iter().copied(),
    );
    let capacity = magnitude
        .len()
        .checked_mul(32)
        .and_then(|n| n.checked_add(1))
        .ok_or(Step::Host(Halt::HeapExhausted))?;
    let mut digits = vm.reserve_scratch::<u8>(capacity)?;
    while !bi_is_zero(&limbs) {
        vm.charge_builtin_work(limbs.len() as u64)?;
        let mut remainder = 0u64;
        for limb in limbs.iter_mut().rev() {
            let value = (remainder << 32) | *limb as u64;
            *limb = (value / radix as u64) as u32;
            remainder = value % radix as u64;
        }
        limbs = bi_trim(limbs);
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[remainder as usize]);
    }
    if negative {
        digits.push(b'-');
    }
    digits.reverse();
    Ok(String::from_utf8(digits).expect("ASCII radix digits"))
}

#[cfg(test)]
mod meter_consistency {
    include!("meter_consistency.rs");
}

#[cfg(test)]
mod string_decode_instrumentation {
    std::thread_local! {
        pub(super) static STRING_UNITS_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }
    pub(super) fn record() {
        STRING_UNITS_CALLS.with(|count| count.set(count.get() + 1));
    }
}

#[cfg(not(test))]
mod string_decode_instrumentation {
    #[inline(always)]
    pub(super) fn record() {}
}

mod reused_boot_native_tests;
