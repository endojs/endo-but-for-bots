//! The `ironhorse` engine seam: the daemon's binding to the Rust engine
//! crates (`ironhorse_vm` + `ironhorse_compile`).
//!
//! Design: `designs/ironhorse-engine.md` § Endor integration
//! (requirement 8). Engine selection is an axis orthogonal to the
//! subcommand: `-e xs` runs the XS engine through `xsnap`, `-e ironhorse`
//! runs the Rust port through this module. Both engines are linked into
//! the one `endor` binary so they coexist through the parity campaign.
//!
//! What is real here, and what is not, stated plainly rather than
//! papered over: `run_script` compiles actual JavaScript with
//! `ironhorse_compile` and executes the resulting bytecode on `ironhorse_vm`
//! over a real `Compartment`, reporting the completion value and the
//! engine's own computron count. Programs that reach an opcode the port
//! has not landed yet halt with `Halt::Unsupported`, which this module
//! surfaces **by name** and with a non-zero exit — Ironhorse declines a
//! program it cannot run rather than returning a wrong answer.
//!
//! The worker envelope protocol (`endor worker -e ironhorse`) is not
//! wired yet: it needs the host-function surface and the SES boot
//! bundle, which are later roadmap stages. That gap is reported as a
//! named gap, not simulated.

#[cfg(feature = "ironhorse-engine")]
pub mod engine {
    use std::path::Path;

    pub use ironhorse_compile::compile_atoms_with;
    pub use ironhorse_vm::Machine as VmMachine;
    pub use ironhorse_vm::{
        Compartment, GcStats, Halt, Heap, Intrinsics, Meter as VMeter, MeterCheck, MeterState,
        ModuleGraph, ModuleSource, RunOutcome, Slot,
    };

    /// Why an evaluation could not be carried out or did not complete.
    #[derive(Debug)]
    pub enum MachineError {
        /// `ironhorse_compile` rejected the source.
        Compile(String),
        /// The program ran but did not complete normally.
        Halt(Halt),
        /// The engine seam is present but the requested surface is not
        /// built yet. Carries the name of the missing surface.
        Unavailable(String),
    }

    impl std::fmt::Display for MachineError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                MachineError::Compile(e) => write!(f, "compile error: {e}"),
                MachineError::Halt(h) => write!(f, "{}", describe_halt(h)),
                MachineError::Unavailable(what) => {
                    write!(f, "not built yet on the Ironhorse engine: {what}")
                }
            }
        }
    }

    impl std::error::Error for MachineError {}

    /// Render a halt the way the port's ledger names it, so an
    /// unsupported opcode reads as the exact thing to implement next.
    pub fn describe_halt(halt: &Halt) -> String {
        match halt {
            Halt::Return => "completed".to_string(),
            Halt::MeterAbort => "metering aborted the run".to_string(),
            Halt::StepLimit(n) => format!("step ceiling reached after {n} dispatches"),
            Halt::Unsupported(op) => {
                format!("unsupported opcode `{op}` (a named, unlanded engine gap)")
            }
            Halt::Decode(e) => format!("bytecode decode error: {e}"),
            Halt::Throw(e) => format!("uncaught throw: {e}"),
            Halt::StackOverflow(n) => format!("stack overflow ({n} slots over the limit)"),
            other => format!("halted: {other:?}"),
        }
    }

    /// The outcome of one evaluation, carrying the engine's own meter
    /// readings rather than a placeholder.
    #[derive(Debug)]
    pub struct EvalOutcome {
        /// Completion value under ECMAScript `String()` semantics.
        pub result: String,
        /// `true` when the program reached RETURN/END.
        pub completed: bool,
        /// Computrons, the meter's release-versioned count.
        pub computrons: u64,
        /// Dispatched opcodes before the invocation baseline.
        pub dispatched: u64,
        /// Raw 16.16 fixed-point meter index.
        pub meter_raw: u64,
        /// Why the run stopped.
        pub halt: Halt,
    }

    impl From<RunOutcome> for EvalOutcome {
        fn from(o: RunOutcome) -> Self {
            EvalOutcome {
                result: o.result,
                completed: o.completed,
                computrons: o.computrons,
                dispatched: o.dispatched,
                meter_raw: o.meter_raw,
                halt: o.halt,
            }
        }
    }

    /// A machine backed by the Rust engine.
    ///
    /// Mirrors the slice of the `xsnap::Machine` surface the daemon's
    /// engine-agnostic callers use, so engine selection stays a seam
    /// rather than a fork of the call sites.
    pub struct Machine {
        inner: VmMachine,
    }

    impl Default for Machine {
        fn default() -> Self {
            Machine::new()
        }
    }

    impl Machine {
        /// Create a fresh machine over shared intrinsics.
        pub fn new() -> Machine {
            Machine {
                inner: VmMachine::new(),
            }
        }

        /// Compile and evaluate `source` in a fresh compartment.
        ///
        /// Compiles to bytecode **and its symbols atom**, then evaluates
        /// through `evaluate_with_symbols` so the intrinsics are linked —
        /// without the symbols atom the program's intrinsic references
        /// would not resolve.
        pub fn evaluate(&self, source: &str, strict: bool) -> Result<EvalOutcome, MachineError> {
            let (bytecode, symbols) = compile_atoms_with(source, strict)
                .map_err(|e| MachineError::Compile(e.to_string()))?;
            let comp = self.inner.new_compartment();
            Ok(comp.evaluate_with_symbols(&bytecode, &symbols).into())
        }

        /// Evaluate and return only the completion value, failing when
        /// the program did not complete.
        pub fn eval(&self, source: &str) -> Result<String, MachineError> {
            let outcome = self.evaluate(source, false)?;
            if outcome.completed {
                Ok(outcome.result)
            } else {
                Err(MachineError::Halt(outcome.halt))
            }
        }

        /// Strict-mode counterpart of [`Machine::eval`].
        pub fn eval_strict(&self, source: &str) -> Result<String, MachineError> {
            let outcome = self.evaluate(source, true)?;
            if outcome.completed {
                Ok(outcome.result)
            } else {
                Err(MachineError::Halt(outcome.halt))
            }
        }

        /// Shared intrinsics for this machine.
        pub fn intrinsics(&self) -> &Intrinsics {
            self.inner.intrinsics().as_ref()
        }

        /// The underlying VM machine, for callers that need the full
        /// engine surface.
        pub fn vm_machine(&self) -> &VmMachine {
            &self.inner
        }
    }

    /// `endor run -e ironhorse <script.js>`: run a JavaScript file on the
    /// Rust engine.
    ///
    /// This is the daemon binary's real consumption of the engine
    /// crates. It prints the completion value on stdout and the meter
    /// reading on stderr, and fails loudly — naming the gap — when the
    /// program reaches a surface the port has not landed.
    pub fn run_script(path: &Path) -> Result<(), MachineError> {
        let source = std::fs::read_to_string(path)
            .map_err(|e| MachineError::Compile(format!("cannot read {}: {e}", path.display())))?;
        eprintln!("endor[run -e ironhorse]: {}", path.display());
        let machine = Machine::new();
        let outcome = machine.evaluate(&source, false)?;
        eprintln!(
            "endor[run -e ironhorse]: {} computrons ({} dispatched, meter_raw {})",
            outcome.computrons, outcome.dispatched, outcome.meter_raw
        );
        if !outcome.completed {
            return Err(MachineError::Halt(outcome.halt));
        }
        println!("{}", outcome.result);
        Ok(())
    }

    /// `endor worker -e ironhorse`: not built yet.
    ///
    /// The worker speaks the CBOR envelope protocol over a transport and
    /// boots `polyfills.js` → `host_aliases.js` → `ses_boot.js`. Those
    /// need the host-function surface and the SES bundle, which are
    /// later roadmap stages. Reported as a named gap rather than faked.
    pub fn run_worker() -> Result<(), MachineError> {
        Err(MachineError::Unavailable(
            "the worker envelope protocol (needs the host-function surface \
             and the SES boot bundle; see designs/ironhorse-engine.md \
             roadmap stages 4 and 7)"
                .to_string(),
        ))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn machine_creates() {
            let _ = Machine::new();
        }

        #[test]
        fn evaluates_arithmetic_through_the_real_engine() {
            let m = Machine::new();
            let outcome = m.evaluate("1 + 2", false).expect("compiles");
            assert!(outcome.completed, "halt: {:?}", outcome.halt);
            assert_eq!(outcome.result, "3");
            // The meter is real: a program that dispatched opcodes cannot
            // report zero computrons.
            assert!(outcome.computrons > 0);
        }

        #[test]
        fn reports_meter_movement_between_programs() {
            let m = Machine::new();
            let small = m.evaluate("1 + 1", false).expect("compiles");
            let bigger = m
                .evaluate(
                    "var x = 0; for (var i = 0; i < 20; i++) { x += i; } x",
                    false,
                )
                .expect("compiles");
            assert!(small.completed && bigger.completed);
            assert_eq!(bigger.result, "190");
            assert!(
                bigger.computrons > small.computrons,
                "the loop must cost more than the constant fold: {} vs {}",
                bigger.computrons,
                small.computrons,
            );
        }

        #[test]
        fn compile_errors_surface_as_compile_errors() {
            let m = Machine::new();
            match m.evaluate("var = ;", false) {
                Err(MachineError::Compile(_)) => {}
                other => panic!("expected a compile error, got {other:?}"),
            }
        }

        #[test]
        fn worker_gap_is_named_not_simulated() {
            match run_worker() {
                Err(MachineError::Unavailable(what)) => {
                    assert!(what.contains("worker envelope protocol"));
                }
                other => panic!("expected a named gap, got {other:?}"),
            }
        }
    }
}

#[cfg(not(feature = "ironhorse-engine"))]
pub mod engine {
    //! Built without the `ironhorse-engine` feature: the seam is absent.
    //! The binary reports `-e ironhorse` as an unknown engine.
}
