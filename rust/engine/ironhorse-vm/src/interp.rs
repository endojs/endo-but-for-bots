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

mod admission;
mod apply;
mod code;
mod coerce;
mod dispatch;
mod enumerate;
mod environment;
mod errors;
mod eval;
mod frames;
mod function;
mod invoke;
mod iterable;
mod render;
mod strings;
mod unwind;

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
    /// `Object.fromEntries(iterable)` consumes entry objects through the
    /// iterator protocol. Each entry is read by keys `0` and `1`.
    ObjectFromEntries,
    /// `Object.keys(o)` — the own enumerable string-keyed property names, in
    /// property-creation order, as a fresh `Array` of interned key strings.
    ObjectKeys,
    /// `Object.create(proto[, properties])` for ordinary prototypes and the
    /// same descriptor machinery as `Object.defineProperties`.
    ObjectCreate,
    /// `Object.getOwnPropertyDescriptor(o, k)` returns the own data or accessor
    /// descriptor for `k`, or `undefined` when absent.
    ObjectGetOwnPropertyDescriptor,
    /// `Object.getOwnPropertyNames(o)` — all own string keys, including
    /// non-enumerable Error `message`/`cause` properties.
    ObjectGetOwnPropertyNames,
    /// `Object.defineProperty(o, k, descriptor)` converts the descriptor and
    /// defines the property through the modeled receiver's internal method.
    /// A rejected definition throws; a successful definition returns the object.
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
    /// `Reflect.getPrototypeOf(target)` calls `[[GetPrototypeOf]]` after
    /// requiring an object target.
    ReflectGetPrototypeOf,
    /// `Reflect.setPrototypeOf(target, proto)` calls `[[SetPrototypeOf]]`
    /// after validating the object target and object-or-null prototype.
    /// Returns whether the internal method accepts the change.
    ReflectSetPrototypeOf,
    ReflectIsExtensible,
    ReflectPreventExtensions,
    /// `Reflect.getOwnPropertyDescriptor(target, key)` returns an own data
    /// or accessor descriptor, or `undefined`, through `[[GetOwnProperty]]`.
    /// A non-object target throws TypeError.
    ReflectGetOwnPropertyDescriptor,
    /// `Reflect.defineProperty(target, key, descriptor)` converts the
    /// descriptor and calls `[[DefineOwnProperty]]`, returning its Boolean
    /// acceptance result. Invalid arguments and abrupt completions still throw.
    ReflectDefineProperty,
    /// `Reflect.ownKeys(target)` returns the string and symbol keys produced
    /// by the object target's `[[OwnPropertyKeys]]` internal method.
    ReflectOwnKeys,
    /// `Reflect.has(target, key)` calls `[[HasProperty]]` on the object target
    /// with the converted property key.
    ReflectHas,
    /// `Reflect.get(target, key[, receiver])` calls `[[Get]]` with the
    /// explicit receiver, or the target when it is omitted.
    ReflectGet,
    /// `Reflect.set(target, key, value[, receiver])` calls `[[Set]]` with the
    /// explicit receiver, or the target when omitted, and returns its Boolean
    /// acceptance result.
    ReflectSet,
    /// `Reflect.deleteProperty(target, key)` calls `[[Delete]]` on the
    /// object target and returns its Boolean acceptance result.
    ReflectDeleteProperty,
    /// `Reflect.apply(target, thisArgument, argumentsList)` expands the
    /// array-like arguments list and invokes the callable target through the
    /// shared abstract Call operation.
    ReflectApply,
    /// `Reflect.construct(target, argumentsList[, newTarget])` checks the
    /// constructors, expands the array-like arguments list, and delegates to
    /// the shared construction operation.
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
    /// `Function.prototype.apply` invokes the receiver function with the
    /// given `this` and an array-like arguments list. A null or undefined list
    /// supplies no arguments.
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
    /// `Symbol.prototype.valueOf()` returns the symbol primitive, unwrapping
    /// a Symbol wrapper when necessary.
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
    /// `Array.prototype.push(...items)` appends the arguments and returns
    /// the new length, using the generic property path when required.
    ArrayPush,
    /// `Array.prototype.pop()`
    /// (`fx_Array_prototype_pop`): remove and return the last element (or
    /// `undefined` on an empty array), updating the length.
    ArrayPop,
    /// `Array.prototype.indexOf(value[, from])`
    /// (`fx_Array_prototype_indexOf`): the first index at which `value` is
    /// found by strict equality, or `-1`.
    ArrayIndexOf,
    /// `Array.prototype.join([sep])`
    /// (`fx_Array_prototype_join`): the elements stringified and joined by
    /// `sep` (default `","`), holes/`undefined`/`null` contributing empty.
    ArrayJoin,
    /// `Array.prototype.includes(value[, from])`
    /// (`fx_Array_prototype_includes`): whether `value` is an element (by
    /// SameValueZero), scanning from `from`.
    ArrayIncludes,
    /// `Array.prototype.lastIndexOf(value[, from])`: the last
    /// index at which `value` is found (strict equality) scanning backward, or
    /// `-1`.
    ArrayLastIndexOf,
    /// `Array.prototype.fill(value[, start[, end]])`
    /// (`fx_Array_prototype_fill`): set `[start, end)` to `value`, returning
    /// the array.
    ArrayFill,
    /// `Array.prototype.reverse()`
    /// (`fx_Array_prototype_reverse`): reverse the elements in place, returning
    /// the array.
    ArrayReverse,
    /// `Array.prototype.slice([start[, end]])`
    /// (`fx_Array_prototype_slice`): a new array with the elements of
    /// `[start, end)`.
    ArraySlice,
    /// `Array.prototype.concat(...args)`
    /// (`fx_Array_prototype_concat`): a new array of the receiver's elements
    /// followed by each argument (spreading array arguments).
    ArrayConcat,
    /// `Array.prototype.at(index)` (`fx_Array_prototype_at`):
    /// the element at `index` (negative counts from the end), or `undefined`.
    ArrayAt,
    /// `Array.prototype.shift()` (`fx_Array_prototype_shift`):
    /// remove and return the first element, shifting the rest down.
    ArrayShift,
    /// `Array.prototype.unshift(...items)`
    /// (`fx_Array_prototype_unshift`): prepend the arguments, returning the new
    /// length.
    ArrayUnshift,
    /// `Array.prototype.copyWithin(target[, start[, end]])`
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
    /// `JSON.stringify(value[, replacer[, space]])` serializes through
    /// observable property reads, `toJSON`, replacer callbacks or property
    /// lists, and wrapper unboxing. A remaining BigInt value throws TypeError.
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
    /// An `Atomics.*` operation selected by the payload (see [`AtomicOp`]).
    /// Single-agent read-modify-write operations support integer and BigInt
    /// views using ordinary backing-store byte operations. Wait, notify, and
    /// waitAsync are refused.
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
    /// `Promise.prototype.finally(onFinally)` registers finally handlers,
    /// awaits the callback result through the selected species constructor,
    /// and restores the original settlement unless the callback throws or rejects.
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
    /// `%GeneratorPrototype%.return(v)` resumes with a return completion
    /// through pending finally handlers.
    GeneratorReturn,
    /// `%GeneratorPrototype%.throw(e)` resumes by throwing `e` at the
    /// suspension point.
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
/// (XS's `size >> shift`). Kinds 0 and 1 are BigInt-element views; their
/// element reads and writes use the BigInt conversion paths.
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
/// element (kind 0/1), which uses the dedicated BigInt decoding paths. The
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
