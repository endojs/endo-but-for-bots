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
//! named gap, not simulated. The worker HEAP-PERSISTENCE lifecycle,
//! by contrast, IS wired: [`engine::HeapStoreOptions`] +
//! [`engine::PersistentMachine`] back a machine's heap with the
//! snapshot store (designs/ironhorse-snapshot-store-seam.md § the
//! supervisor wiring), checkpointing at every completed crank and
//! pairing with [`crate::supervisor::Supervisor::mark_suspended_store`]
//! for suspend/resume bookkeeping.

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
        /// The heap store refused an operation (open, checkpoint,
        /// resume, collect, or close). Store errors are fail-closed by
        /// design; the message carries the store's own taxonomy.
        Store(String),
    }

    impl std::fmt::Display for MachineError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                MachineError::Compile(e) => write!(f, "compile error: {e}"),
                MachineError::Halt(h) => write!(f, "{}", describe_halt(h)),
                MachineError::Unavailable(what) => {
                    write!(f, "not built yet on the Ironhorse engine: {what}")
                }
                MachineError::Store(e) => write!(f, "heap store error: {e}"),
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

    /// Options for a store-backed worker heap: the supervisor-side
    /// opt-in to the snapshot store seam
    /// (`designs/ironhorse-snapshot-store-seam.md` § supervisor
    /// wiring). Absent this option a machine's heap lives and dies
    /// with the process; with it, the heap is a SQLite database the
    /// worker checkpoints at every completed crank, so suspend is
    /// free (the durable state already exists), resume is lazy
    /// (O(working set), not O(heap)), and a crashed crank rewinds to
    /// the last checkpoint instead of persisting partial effects.
    #[derive(Debug, Clone)]
    pub struct HeapStoreOptions {
        /// The heap database path. Created when absent; resumed (with
        /// full succession validation) when present.
        pub path: std::path::PathBuf,
        /// The worker's callback-table signature. The store and the
        /// blob format both gate on it, so a database from a worker
        /// with a different host surface is refused, not adopted.
        pub signature: String,
    }

    /// A machine whose heap is backed by the snapshot store: the
    /// supervisor-facing worker-heap lifecycle. One instance owns one
    /// store session over one database.
    ///
    /// Cadence policy (deliberately minimal, stated rather than
    /// configurable): every COMPLETED crank checkpoints before its
    /// outcome is reported, so the database is always at a crank
    /// boundary; a crank that halts without completing is discarded by
    /// resuming from the last checkpoint (the deterministic
    /// crashed-crank contract — no partial effect ever persists);
    /// [`PersistentMachine::collect`] offers summary-driven partial
    /// collection at any boundary, and the supervisor decides when.
    ///
    /// The SES boot bundle and the worker envelope protocol remain the
    /// named gaps they were; this type is the heap-persistence half the
    /// supervisor owns either way. Cranks after the first must
    /// redeclare their globals in declaration order (program symbol
    /// ids are positional — the store suites' convention).
    pub struct PersistentMachine {
        store: std::rc::Rc<std::cell::RefCell<ironhorse_store_sqlite::SqliteHeapStore>>,
        session: Option<ironhorse_snapshot::machine::StoreSession>,
        signature: ironhorse_snapshot::Signature,
        linked: bool,
        heap_store: std::path::PathBuf,
    }

    fn store_err(e: ironhorse_snapshot::store::StoreError) -> MachineError {
        MachineError::Store(format!("{e:?}"))
    }

    impl PersistentMachine {
        /// Open (creating or resuming) a store-backed machine at
        /// `options.path`. An empty database binds a fresh boot
        /// machine at epoch 1; a populated one is validated against
        /// its sealed root and resumed lazily.
        pub fn open(options: &HeapStoreOptions) -> Result<PersistentMachine, MachineError> {
            use ironhorse_snapshot::machine::{begin_store_session, resume_from_store_lazy};
            use ironhorse_snapshot::store::{HeapStore, StoreError};

            let signature = ironhorse_snapshot::Signature::new(&options.signature);
            let mut store =
                ironhorse_store_sqlite::SqliteHeapStore::open(&options.path).map_err(store_err)?;
            match store.manifest() {
                Err(StoreError::Empty) => {
                    let session =
                        begin_store_session(ironhorse_vm::Interp::new(), &signature, &mut store)
                            .map_err(|(_, e)| store_err(e))?;
                    Ok(PersistentMachine {
                        store: std::rc::Rc::new(std::cell::RefCell::new(store)),
                        session: Some(session),
                        signature,
                        linked: false,
                        heap_store: options.path.clone(),
                    })
                }
                Ok(_) => {
                    let store = std::rc::Rc::new(std::cell::RefCell::new(store));
                    let session =
                        resume_from_store_lazy(store.clone(), &signature).map_err(store_err)?;
                    // A resumed machine carries its program symbol
                    // names in the small state; an empty table means
                    // no crank ever linked (e.g. the first crank
                    // crashed before its checkpoint).
                    let linked = !session.machine().program_symbol_names().is_empty();
                    Ok(PersistentMachine {
                        store,
                        session: Some(session),
                        signature,
                        linked,
                        heap_store: options.path.clone(),
                    })
                }
                Err(e) => Err(store_err(e)),
            }
        }

        /// Compile and run one crank against the persistent heap.
        ///
        /// A completed crank checkpoints before returning its outcome
        /// (the outcome is durable when the caller sees it). A crank
        /// that halts without completing returns its halt AFTER the
        /// machine has been rewound to the last checkpoint — the
        /// partial crank's effects are gone from memory and were never
        /// in the database.
        pub fn eval(&mut self, source: &str) -> Result<EvalOutcome, MachineError> {
            use ironhorse_snapshot::machine::{checkpoint_to_store, resume_from_store_lazy};

            let (bytecode, symbols) = compile_atoms_with(source, false)
                .map_err(|e| MachineError::Compile(e.to_string()))?;
            let session = self.session.as_mut().expect("machine is open");
            if !self.linked {
                let names = ironhorse_vm::parse_symbols(&symbols);
                session.machine_mut().link_intrinsics(&names);
                self.linked = true;
            }
            let outcome = session.machine_mut().run(&bytecode);
            if outcome.completed {
                checkpoint_to_store(session, &self.signature, &mut *self.store.borrow_mut())
                    .map_err(store_err)?;
                Ok(outcome.into())
            } else {
                // Crashed crank: discard the machine, resume from the
                // last checkpoint. The session is replaced before the
                // halt is reported so the machine stays usable.
                let halt = outcome.halt;
                self.session = None;
                let fresh = resume_from_store_lazy(self.store.clone(), &self.signature)
                    .map_err(store_err)?;
                self.linked = !fresh.machine().program_symbol_names().is_empty();
                self.session = Some(fresh);
                Err(MachineError::Halt(halt))
            }
        }

        /// Summary-driven partial collection at the current crank
        /// boundary (the machine is always clean here — `eval` either
        /// checkpointed or rewound). Returns the number of slots
        /// freed. The supervisor owns the cadence: call it as often or
        /// as rarely as policy dictates; the schedule is
        /// replica-visible, like the full collector's.
        pub fn collect(&mut self) -> Result<u32, MachineError> {
            use ironhorse_snapshot::machine::partial_collect;
            let session = self.session.as_mut().expect("machine is open");
            partial_collect(session, &*self.store.borrow()).map_err(store_err)
        }

        /// The store's committed epoch (advances by one per
        /// checkpoint).
        pub fn epoch(&self) -> Result<u64, MachineError> {
            use ironhorse_snapshot::store::HeapStore;
            self.store
                .borrow()
                .manifest()
                .map(|m| m.epoch)
                .map_err(store_err)
        }

        /// The heap database path — the suspend record the supervisor
        /// stores ([`crate::supervisor::Supervisor::mark_suspended_store`]).
        pub fn heap_store_path(&self) -> &std::path::Path {
            &self.heap_store
        }

        /// Release the machine and close the database with the full
        /// last-connection contract: after `Ok`, the file is
        /// self-contained (WAL folded in, sidecars removed) and safe
        /// to copy or hand to another supervisor.
        pub fn close(mut self) -> Result<(), MachineError> {
            drop(self.session.take());
            let store = std::rc::Rc::try_unwrap(self.store)
                .map_err(|_| MachineError::Store("store still shared at close".to_string()))?
                .into_inner();
            store.close().map_err(store_err)
        }
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
