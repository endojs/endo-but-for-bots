#![forbid(unsafe_code)]
// The field inventory expands through one selector step per interpreter field.
#![recursion_limit = "512"]
//! Safe index-arena JavaScript interpreter and runtime.
//!
//! [`Interp`] owns slots, chunks, activation state, built-ins, modules and side tables.
//! Guest strings use UTF-16; symbol-name conversion is shared through `ironhorse-text`.
//! [`SourceCompiler`] supplies dynamic compilation without a production compiler dependency.
//! [`gc::GcHooks`] connects the collector to references held outside the arenas.
//! [`Halt`] includes [`Halt::HeapExhausted`] and [`Halt::Panic`]; resource stops and
//! engine faults are not catchable guest exceptions.
//!
//! [`Compartment`] currently creates independently owned interpreters from pristine
//! boot templates, not shared frozen intrinsics; Realm extraction is planned.
//! `rust/engine/ARCHITECTURE.md` maps the four seams and current acceptance limits.
//! The opcode tables follow the pinned XS ISA; broad runtime support does not imply
//! full test262 or daemon SES acceptance.
//!
//! Execution determinism is scoped per release binary per platform, with matching
//! state, inputs and host policy. The shared meter digest identifies weights, not
//! cross-platform execution semantics. This crate forbids unsafe Rust; that rule
//! does not describe its dependencies or the outer daemon's SQLite/XS integrations.

#[cfg(all(feature = "consensus", feature = "cost-calibration"))]
compile_error!("consensus and cost-calibration are mutually exclusive");

mod math;
pub use math::MATH_PROVIDER;
mod bulk;
mod side_tables;
mod snapshot_dirty;
pub use snapshot_dirty::{SnapshotBaseline, SnapshotDirty, SnapshotSection};
pub mod compartment;
pub mod cost;
pub mod default_keys;
pub mod gc;
pub mod halt_labels;
pub mod interp;
pub mod intl_number;
pub mod meter;
pub use ironhorse_meter as cost_table;
pub mod module;
pub mod opcode;
mod property_index;
pub mod sha256;
#[doc(hidden)]
pub mod source_scan;
pub mod symbols;
pub mod value;

pub use compartment::{
    Compartment, CompartmentId, CompartmentOptions, CompartmentSkip, Intrinsics, Machine,
};
pub use gc::{GcStats, Heap};
pub use interp::DecodeError;
#[doc(hidden)]
pub use interp::SIDE_TABLES;
pub use interp::{
    dtf_component_key_static, error_name_static, AccessorRow, ArraySnapshot, AsyncRow,
    BoundFunctionRow, CollatorData, CollectionSnapshot, CombinatorRow, CompiledSource,
    DateTimeFormatData, DisposableStackRow, DisposalRecordRow, FunctionRow, FunctionStateSnapshot,
    GeneratorRow, Halt, IndexPropsSnapshot, Interp, IntlBoundFunctionRow, IntlTables, IteratorRow,
    ListFormatData, LocaleData, Native, NumberFormatData, PanicKind, PluralRulesData,
    PrivateAccessorRow, PrivateElementSnapshot, PrivateValueRow, PromiseClusterSnapshot,
    PromiseFnRow, PromiseReactionRow, PromiseRow, ProxyRevokerRow, ProxyRow, ProxyStateSnapshot,
    RelinkError, RestoreError, RestoreSession, RunOutcome, SavedFrameRow, SavedJumpRow,
    SegmentIteratorData, SegmenterData, SegmentsData, SourceCompileError, SourceCompiler,
    PROGRAM_INVOCATION_COMPUTRONS, TYPED_ARRAY_TYPES,
};
pub use interp::{HEAVY_FRAME_COST, LIGHT_FRAME_COST, NATIVE_DEPTH_LIMIT};
pub use meter::{Meter, MeterCheck, MeterState, COST_TABLE_VERSION};
pub use module::{
    BodyOp, ExportEntry, ImportEntry, ImportName, ModuleError, ModuleGraph, ModuleId, ModuleRecord,
    ModuleSource, ModuleValue, Namespace,
};
pub use opcode::{instruction_len, Opcode};
#[doc(hidden)]
pub use side_tables::TableDesc;
pub use symbols::{parse_symbols, parse_symbols_checked, SymbolName};
pub use value::{
    BackingCommitAuthority, ChunkArena, ChunkOffset, ChunkSlice, Kind, PageSource, Payload, Slot,
    SlotArena, SlotIndex, CHUNK_EXTENT_BYTES, SLOTS_PER_PAGE,
};

/// The native (thread) stack, in bytes, the engine requires for its
/// native-recursion budget to be a bound rather than a hope.
///
/// [`NATIVE_DEPTH_LIMIT`] is a deterministic *counter*; how many bytes of
/// host stack the frames it admits occupy is a property of the build, not of
/// the guest. Measured on the budget's two corners — `HEAVY_FRAME_COST`-class
/// activations nested to the ceiling (`join` re-entering `toString` over a
/// self-containing array: 1.2 MiB with optimizations, close to 13 MiB in an
/// unoptimized build, where the two monolithic dispatch functions keep every
/// match arm's temporaries live at once) and `LIGHT_FRAME_COST`-class levels
/// nested to it (`JSON.stringify` over 2,000 nested arrays: 2.5 MiB and
/// 11 MiB). This constant therefore states the requirement per profile — the
/// 32 MiB the `rust/endo` worker threads and the test262 harness already
/// allocate for debug, and the 8 MiB of a libFuzzer/OS main thread for
/// release — with headroom above the measurement. Run the engine on a thread
/// of at least this size; the recursion-budget tests spawn exactly this size
/// and must never abort.
pub const NATIVE_STACK_BYTES: usize = if cfg!(debug_assertions) {
    32 * 1024 * 1024
} else {
    8 * 1024 * 1024
};

/// Run a program bytecode buffer (as emitted by the XS compiler) on
/// a fresh interpreter, returning the completion value and computrons
/// in the ORACLE HARNESS's shape ([`RunOutcome::host_coerced`]): these
/// three entries exist for the differential harnesses, so a completion
/// value the xsnap shim's post-run `String(result)` cannot coerce is
/// reported as the abort the oracle reports. An embedder that wants the
/// engine's raw completion runs [`Interp::run`] directly.
pub fn run_program(bytecode: &[u8]) -> RunOutcome {
    Interp::new().run(bytecode).host_coerced()
}

/// Run a program bytecode buffer under a **dispatch-count ceiling**, halting
/// with [`Halt::StepLimit`] if the program dispatches `step_limit` opcodes
/// without completing. The un-metered [`run_program`] is not total on
/// arbitrary bytecode — a malformed backward branch that targets itself (or
/// any other non-terminating dispatch cycle) spins forever because no
/// metering host is armed to refuse it. The bytecode-decoder fuzz harness
/// runs every arbitrary/malformed input through this bounded entry so a hang
/// becomes a bounded [`Halt::StepLimit`] in milliseconds instead of wedging
/// the whole test binary.
pub fn run_program_bounded(bytecode: &[u8], step_limit: u64) -> RunOutcome {
    Interp::new()
        .run_bounded(bytecode, step_limit)
        .host_coerced()
}

/// Run a program bytecode buffer with its XS `symbols` atom, so the
/// program's intrinsic references (`Object`, `Boolean`, the Error
/// constructors, …) relink to ironhorse's intrinsics by name (design §
/// test262 conformance). The symbol atom carries the compiler's
/// program-local id→name table ([`parse_symbols`]); binding is unmetered,
/// matching XS where the global's intrinsics pre-exist the guest run.
pub fn run_program_with_symbols(bytecode: &[u8], symbols: &[u8]) -> RunOutcome {
    let names = match parse_symbols_checked(symbols) {
        Ok(names) => names,
        Err(halt) => return symbols::decode_refusal(halt),
    };
    let mut interp = Interp::new();
    interp.link_intrinsics(&names);
    interp.run(bytecode).host_coerced()
}

/// Whether a persisted RegExp `(source, flags)` pair recompiles under this
/// engine build.
///
/// Snapshot validation calls this before admitting an image, so restoration
/// never discovers malformed RegExp state after the trust boundary. The probe
/// checks the compiler grammar and limits without materializing a program.
pub fn regexp_source_compiles(source: &SymbolName, flags: &str) -> bool {
    ironhorse_regexp::validate_units_checked(&source.to_units(), flags, u64::MAX, None)
        .result
        .is_ok()
}

/// Disassemble a bytecode buffer to `(offset, mnemonic)` pairs, walking
/// instruction lengths with [`opcode::instruction_len`] so ID-operand
/// and length-prefixed variable opcodes (functions, strings, embedded
/// code blocks) advance correctly rather than stopping disassembly.
/// A truncated or invalid instruction ends the walk.
pub fn disassemble(bytecode: &[u8]) -> Vec<(usize, &'static str)> {
    let mut out = Vec::new();
    let mut pc = 0usize;
    while pc < bytecode.len() {
        match Opcode::from_u8(bytecode[pc]) {
            Some(op) => {
                out.push((pc, op.name()));
                match opcode::instruction_len(bytecode, pc) {
                    Some(len) if len > 0 => pc += len,
                    _ => break,
                }
            }
            None => break,
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opcode_table_is_dense_and_roundtrips() {
        for b in 0..opcode::XS_CODE_COUNT {
            let op = Opcode::from_u8(b as u8).expect("dense");
            assert_eq!(op as usize, b, "discriminant must equal byte value");
        }
    }

    #[test]
    fn nested_start_async_degrades_to_stack_overflow() {
        // Regression for the `bytecode_decoder` fuzz stack overflow
        // (endojs/endo-but-for-bots#1046, ASan crash-9088911a…): the six-byte
        // input `[193, 193, 37, 253, 45, 93]` (`0xc1 0xc1 …`, START_ASYNC
        // leading an async body that itself leads with START_ASYNC) drove
        // `dispatch_at → step_async → dispatch_at …` recursion that the
        // dispatch-count step limit does not bound, blowing the native stack.
        // The native re-entry depth is now capped by the native-recursion
        // budget ([`NATIVE_DEPTH_LIMIT`]), so an arbitrary corrupt snapshot
        // degrades to `Halt::ReentryLimit` instead of aborting the process.
        //
        // Run on the stack the budget is calibrated for
        // ([`NATIVE_STACK_BYTES`]): the default Rust *test* harness gives
        // worker threads only 2 MiB, and the `dispatch_at` activation is tens
        // of KiB (debug), so the bounded recursion this fix permits would
        // overflow that artificially small ceiling; pinning the stack keeps the
        // regression faithful and deterministic rather than hostage to the
        // harness default.
        let handle = std::thread::Builder::new()
            .stack_size(NATIVE_STACK_BYTES)
            .spawn(|| {
                let crash = [193u8, 193, 37, 253, 45, 93];
                run_program_bounded(&crash, 2_000_000).halt
            })
            .expect("spawn regression thread");
        let halt = handle.join().expect("regression thread must not overflow");
        assert!(
            matches!(halt, Halt::ReentryLimit { .. }),
            "nested START_ASYNC must bound to ReentryLimit, got {halt:?}"
        );
    }

    #[test]
    fn known_opcode_bytes_match_xs() {
        // Spot-check against the bytes the oracle emitted.
        assert_eq!(Opcode::XS_CODE_ADD as u8, 0x01);
        assert_eq!(Opcode::XS_CODE_INTEGER_1 as u8, 0x72);
        assert_eq!(Opcode::XS_CODE_MULTIPLY as u8, 0x82);
        assert_eq!(Opcode::XS_CODE_SUBTRACT as u8, 0xcf);
        assert_eq!(Opcode::XS_CODE_BEGIN_SLOPPY as u8, 0x0b);
        assert_eq!(Opcode::XS_CODE_SET_RESULT as u8, 0xbb);
        assert_eq!(Opcode::XS_CODE_RETURN as u8, 0xa9);
    }

    #[test]
    fn to_int32_matches_ecma() {
        assert_eq!(value::to_int32(4294967296.0), 0);
        assert_eq!(value::to_int32(-1.0), -1);
        assert_eq!(value::to_int32(2147483648.0), i32::MIN);
        assert_eq!(value::to_int32(f64::NAN), 0);
    }

    #[test]
    fn number_strings_match_js() {
        assert_eq!(value::number_to_ecma_string(-0.0), "0");
        assert_eq!(value::number_to_ecma_string(4.0), "4");
        assert_eq!(value::number_to_ecma_string(f64::NAN), "NaN");
        assert_eq!(value::number_to_ecma_string(f64::INFINITY), "Infinity");
    }

    #[test]
    fn compartments_do_not_share_globals() {
        // Intrinsic *sharing* is not delivered by this surface (each
        // evaluation builds a fresh `Interp`; see `compartment`'s module
        // documentation), so this pins only the half that is true.
        let m = Machine::new();
        let mut a = m.new_compartment();
        let b = m.new_compartment();
        a.define_global("x", Slot::integer(1));
        assert!(a.global("x").is_some());
        assert!(b.global("x").is_none(), "globals are per-compartment");
    }

    #[test]
    fn is_panic_names_the_terminate_do_not_commit_set() {
        // The single source of truth for the panic set (design
        // `ironhorse-panic.md` § The Formal `Panic` Category, item 2).
        // Settled core:
        assert!(Halt::StackOverflow(3).is_panic());
        assert!(Halt::MeterAbort.is_panic());
        assert!(Halt::EngineInvariant("bitwise:stack-underflow").is_panic());
        assert!(Halt::Panic(PanicKind::EngineFault {
            message: "arena kind check".to_string(),
            location: None,
        })
        .is_panic());
        // Provisional members (Open Question), included for the commit
        // decision:
        assert!(
            Halt::Decode(crate::DecodeError::ProgramCounterOutOfBounds { pc: 0, len: 0 })
                .is_panic()
        );
        assert!(Halt::StepLimit(9).is_panic());
        // Not panics: an ordinary (uncaught) throw and normal completion.
        assert!(!Halt::synthetic_throw("catchable".to_string()).is_panic());
        assert!(!Halt::Return.is_panic());
    }
}
