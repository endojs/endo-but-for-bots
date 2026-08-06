#![forbid(unsafe_code)]
//! ironhorse-vm: the safe, index-arena transliteration of the XS
//! interpreter core (design: `designs/ironhorse-engine.md`,
//! § Value and heap model, § Interpreter and dispatch, § Metering).
//!
//! Stage 1 (thin slice) delivers: the `SlotIndex`/`ChunkOffset` arenas
//! and 32-byte slot value model, a `Vec`-backed slot stack, a
//! `match`-dispatch interpreter over the arithmetic / logic / bitwise /
//! comparison / branch / stack opcode subset of the XS `XS_CODE_*` ISA,
//! the 16.16 fixed-point meter incrementing at XS's points with XS's
//! weights, and a primordial `Compartment.evaluate` seam.
//!
//! The whole crate is `#![forbid(unsafe_code)]` (requirement 2): the
//! index-arena design removes the need for raw pointers, so the
//! interpreter and heap are compiler-checked memory safe. Only
//! `xs-oracle` (the dev/CI differential harness) links C.
//!
//! The opcode enum and its size / name tables are generated verbatim
//! from `xsCommon.h` (the enum) and `xsCommon.c` (`gxCodeNames`,
//! `gxCodeSizes`) at the `c/moddable` pin, so opcode byte values,
//! instruction sizes, and mnemonics match the oracle exactly.

pub mod compartment;
pub mod cost;
pub mod default_keys;
pub mod gc;
pub mod interp;
pub mod meter;
pub mod module;
pub mod opcode;
pub mod symbols;
pub mod value;

pub use compartment::{
    Compartment, CompartmentId, CompartmentOptions, CompartmentSkip, Intrinsics, Machine,
};
pub use gc::{GcStats, Heap};
pub use interp::{Halt, Interp, Native, RunOutcome, PROGRAM_INVOCATION_COMPUTRONS};
pub use meter::{Meter, MeterCheck, MeterState, COST_TABLE_VERSION};
pub use module::{
    BodyOp, ExportEntry, ImportEntry, ImportName, ModuleError, ModuleGraph, ModuleId,
    ModuleRecord, ModuleSource, ModuleValue, Namespace,
};
pub use opcode::{instruction_len, Opcode};
pub use symbols::parse_symbols;
pub use value::{
    ChunkArena, ChunkOffset, Kind, Payload, Slot, SlotArena, SlotIndex, CHUNK_EXTENT_BYTES,
    SLOTS_PER_PAGE,
};

/// Run a program bytecode buffer (as emitted by the XS compiler) on
/// a fresh interpreter, returning the completion value and computrons.
pub fn run_program(bytecode: &[u8]) -> RunOutcome {
    Interp::new().run(bytecode)
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
    Interp::new().run_bounded(bytecode, step_limit)
}

/// Run a program bytecode buffer with its XS `symbols` atom, so the
/// program's intrinsic references (`Object`, `Boolean`, the Error
/// constructors, …) relink to ironhorse's intrinsics by name (design §
/// test262 conformance). The symbol atom carries the compiler's
/// program-local id→name table ([`parse_symbols`]); binding is unmetered,
/// matching XS where the global's intrinsics pre-exist the guest run.
pub fn run_program_with_symbols(bytecode: &[u8], symbols: &[u8]) -> RunOutcome {
    let names = parse_symbols(symbols);
    let mut interp = Interp::new();
    interp.link_intrinsics(&names);
    interp.run(bytecode)
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
    fn compartments_share_intrinsics_but_not_globals() {
        let m = Machine::new();
        let mut a = m.new_compartment();
        let b = m.new_compartment();
        a.define_global("x", Slot::integer(1));
        assert!(a.global("x").is_some());
        assert!(b.global("x").is_none(), "globals are per-compartment");
    }
}
