//! Machine state and execution entry points for the bytecode interpreter.
//!
//! `state` declares each field with its boot, GC, boundary, and persistence
//! policies. `dispatch` owns the opcode loop; `frames`, `invoke`, `apply`,
//! `code`, and `unwind` own call entry, re-entry, buffer identity, and throws.
//! `environment` resolves bindings; `coerce`, `strings`, and `render` separate
//! guest coercion from string storage and host rendering. `admission` controls
//! work and scratch allocation. `property` routes object operations through
//! its keys, descriptors, indexed storage, ordinary, proxy, and integrity modules.
//! Native builtin algorithms live under `natives`; their identities, public
//! meter aliases, snapshot row schemas, and Intl records have separate modules.
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
mod metering;
pub use metering::*;
mod native_ids;
pub use native_ids::{MathId, Native, NativeMethod};
mod snapshot_rows;
pub use snapshot_rows::{
    AccessorRow, ArraySnapshot, AsyncRow, BoundFunctionRow, CollectionSnapshot, CombinatorRow,
    DisposableStackRow, DisposalRecordRow, FunctionRow, FunctionStateSnapshot, GeneratorRow,
    IndexPropsSnapshot, IntlBoundFunctionRow, IteratorRow, PrivateAccessorRow,
    PrivateElementSnapshot, PrivateValueRow, PromiseClusterSnapshot, PromiseFnRow,
    PromiseReactionRow, PromiseRow, ProxyRevokerRow, ProxyRow, ProxyStateSnapshot, SavedFrameRow,
    SavedJumpRow,
};
mod intl_data;
use intl_data::INTL_DATA_VERSION;
pub use intl_data::{
    CollatorData, DateTimeFormatData, IntlTables, ListFormatData, LocaleData, NumberFormatData,
    PluralRulesData, SegmentIteratorData, SegmenterData, SegmentsData,
};

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
use crate::meter::{Meter, MeterCheck};
use crate::opcode::Opcode;
use crate::snapshot_dirty::{SnapshotDirt, SnapshotSection, Tracked};
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

/// Ids retained for the engine's bounded static vocabulary after guest key
/// admission stops. Does not change the positional persisted NAME mapping.
const PROPERTY_KEY_RESERVE: usize = 1024;
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
/// with [`Halt::ReentryLimit`] — distinct from the value-stack abort XS raises from
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
/// This is a deliberate release-versioned engine limit. Changing the budget
/// or frame weights changes execution acceptance and requires a release change;
/// the exact 63/64 callback boundary is pinned by `native_recursion_budget`.
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
use ironhorse_meter::ARRAY_FLATMAP_GENERIC_ELEMENT_OVERLAP;
/// The generic MOP path accounts for a small part of `flatMap`'s calibrated
/// frame and per-element work itself. Remove that overlap when applying the
/// dense-path constants through the generic implementation.
use ironhorse_meter::ARRAY_FLATMAP_GENERIC_FRAME_OVERLAP;
/// XS's `mxTableMinLength`: the initial (and minimum) Map/Set hash-table
/// address-array length. The table grows/shrinks by powers of two around it.
pub const MAP_MIN_TABLE_LENGTH: u32 = 1;

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

/// Construction metadata retained in the existing snapshot format, plus the
/// captured frames used by Error.stack. Live properties determine display text;
/// these original name/message fields are not a second display authority.
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
    Decode(DecodeError),
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
    /// XS's fixed-geometry value-stack abort (`fxOverflow`). Carries the
    /// slots in use before the refused frame installation. Not catchable.
    StackOverflow(usize),
    /// The release's implementation-specific native recursion budget was
    /// exhausted. `depth` is the attempted weighted depth, including the
    /// refused activation; `limit` is the release's maximum weighted depth.
    /// This abort is distinct from the modeled XS value-stack geometry.
    ReentryLimit { depth: usize, limit: usize },
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
    /// The settled core is `StackOverflow | ReentryLimit | MeterAbort | EngineInvariant(_) | Panic(_)`.
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
                | Halt::ReentryLimit { .. }
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

/// A structured failure to decode execution input. Hosts can inspect the
/// category and offsets without parsing diagnostic text.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum DecodeError {
    ProgramCounterOutOfBounds {
        pc: usize,
        len: usize,
    },
    InvalidOpcode {
        pc: usize,
        byte: u8,
    },
    UnresolvableInstructionLength {
        pc: usize,
        opcode: u8,
    },
    TruncatedInstruction {
        pc: usize,
        opcode: u8,
        needed: usize,
        remaining: usize,
    },
    InvalidCatchTarget {
        pc: usize,
        target: usize,
        len: usize,
    },
    InvalidSymbols,
    Relink(RelinkError),
    /// Tooling had no bytecode to submit after source compilation failed.
    MissingBytecode,
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ProgramCounterOutOfBounds { pc, len } => write!(f, "pc {pc} past end {len}"),
            Self::InvalidOpcode { pc, byte } => {
                write!(f, "invalid opcode byte {byte:#04x} at {pc}")
            }
            Self::UnresolvableInstructionLength { pc, opcode } => {
                write!(f, "opcode {opcode:#04x} at {pc} has unresolvable length")
            }
            Self::TruncatedInstruction {
                pc,
                opcode,
                needed,
                remaining,
            } => write!(
                f,
                "opcode {opcode:#04x} at {pc} needs {needed} bytes, {remaining} left"
            ),
            Self::InvalidCatchTarget { pc, target, len } => {
                write!(f, "catch target {target} past end {len} at {pc}")
            }
            Self::InvalidSymbols => f.write_str("invalid CESU-8 symbols atom"),
            Self::Relink(error) => write!(f, "relink refused: {error:?}"),
            Self::MissingBytecode => f.write_str("compile produced no bytecode"),
        }
    }
}

impl std::error::Error for DecodeError {}

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

/// A suspended activation: the caller's scope and resume point, saved by
/// `run` and restored by `end` (XS's `mxFrame->value.frame.{code,scope}`
/// plus the environment the frame aliases). The value stack is shared and
/// not saved here; `end` resets it to the frame boundary and pushes the
/// callee's result, matching XS's `mxStack = mxFrameEnd; *mxStack = *slot`.
#[cfg_attr(test, derive(Debug))]
struct CallerState {
    locals: Vec<Slot>,
    // Shared with catch/suspend checkpoints; binding changes copy on write.
    id_map: std::rc::Rc<std::collections::HashMap<u16, usize>>,
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
#[cfg_attr(test, derive(Debug))]
struct CatchJump {
    target_pc: usize,
    segment: Option<usize>,
    stack_len: usize,
    locals_len: usize,
    // Shared with catch/suspend checkpoints; binding changes copy on write.
    id_map: std::rc::Rc<std::collections::HashMap<u16, usize>>,
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
    // Shared with catch/suspend checkpoints; binding changes copy on write.
    id_map: std::rc::Rc<std::collections::HashMap<u16, usize>>,
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
    // Shared with catch/suspend checkpoints; binding changes copy on write.
    id_map: std::rc::Rc<std::collections::HashMap<u16, usize>>,
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
        if self.gc_failed {
            return RunOutcome {
                completed: false,
                result: String::new(),
                coercion_error: None,
                computrons: self.meter.computrons(),
                dispatched: self.n_dispatched,
                meter_raw: self.meter.raw(),
                halt: Halt::EngineInvariant("gc:previous-collection-failed"),
                host_render_halt: None,
            };
        }
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
        std::rc::Rc::make_mut(&mut self.id_map).clear();
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
        let halt = self.finish_step(step);
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
            std::rc::Rc::make_mut(&mut self.id_map).clear();
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
                    host_render_halt = Some(self.finish_step(render_halt));
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
    fn finish_step(&self, step: Step) -> Halt {
        match step {
            Step::Returned => Halt::Return,
            Step::Threw { value, .. } => Halt::Throw {
                value,
                rendered: self.render_uncaught(value),
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
            *field = u32::try_from(interp.temporal_integer(value)?).map_err(|_| {
                interp.catchable_range_error_msg("Temporal: time component out of range".into())
            })?;
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
