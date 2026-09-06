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
        /// A later crank's compiled symbol table could not be
        /// RELINKED onto the machine's persisted one (side-table
        /// ledger G2 lifted the old exact-alignment requirement:
        /// differing tables are remapped, extending append-only).
        /// Refusal is now the exception, fail-closed before anything
        /// runs: runtime-interned ids block table extension until the
        /// ledger's KEYS row lands, and malformed bytecode cannot be
        /// walked.
        SymbolMismatch(String),
        /// The crank spent more than its [`MeterBounds`] allow and the
        /// meter halted it (`Halt::MeterAbort`), distinct from every
        /// other halt because it is the one a supervisor budgets for:
        /// the program was refused, not wrong. Carries the computrons
        /// the crank had spent when the host refused (at least the
        /// limit; the check cadence rounds up to the next interval) and
        /// the limit itself. On the persistent path the machine has
        /// already been rewound to its last checkpoint.
        MeterAbort {
            /// Computrons spent by this crank when it was refused.
            computrons: u64,
            /// The per-crank limit in force.
            limit: u64,
        },
    }

    impl std::fmt::Display for MachineError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                MachineError::Compile(e) => write!(f, "compile error: {e}"),
                MachineError::Halt(h) => write!(f, "{}", describe_halt(h)),
                MachineError::MeterAbort { computrons, limit } => write!(
                    f,
                    "metering aborted the crank: {computrons} computrons spent against \
                     a limit of {limit}"
                ),
                MachineError::Unavailable(what) => {
                    write!(f, "not built yet on the Ironhorse engine: {what}")
                }
                MachineError::Store(e) => write!(f, "heap store error: {e}"),
                MachineError::SymbolMismatch(e) => {
                    write!(f, "crank symbol table mismatch: {e}")
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

    /// Computrons between two consultations of the metering host: the
    /// default check cadence, matching the XS embedder's
    /// `DEFAULT_METERING_INTERVAL`. The cadence decides how far past its
    /// limit a crank can run before the refusal lands (at most one
    /// interval), and how often the host callback costs anything; it is
    /// never part of what a crank is charged.
    pub const DEFAULT_METER_CHECK_INTERVAL: u64 = 10_000;

    /// The default per-crank computron limit: `1e8`, the crank metering
    /// limit the SwingSet kernel applies to an XS vat by default. A
    /// crank that spends more is refused with
    /// [`MachineError::MeterAbort`] and, on the persistent path, rewound.
    /// Sized so no realistic crank meets it while a runaway loop or a
    /// catastrophic regexp is cut off within one check interval of it
    /// rather than never. A single built-in still runs to completion
    /// before the refusal lands — check points sit at loop-closing
    /// points and inside regexp matches, not inside `repeat`, `split`,
    /// or the allocators (architecture review F021/F073) — so an
    /// allocation storm shaped as one call is charged, allocated, and
    /// then refused.
    pub const DEFAULT_CRANK_COMPUTRON_LIMIT: u64 = 100_000_000;

    /// How the embedder bounds a crank's computation (architecture
    /// review finding 2, F014/F020: the engine's whole resource-
    /// exhaustion story is delegated to a meter the embedder never
    /// armed).
    ///
    /// The DEFAULT is armed: every crank runs under a finite computron
    /// limit and the host is consulted on a fixed cadence. Running
    /// un-metered is an explicit opt-in ([`MeterBounds::Unbounded`]),
    /// never something a caller gets by forgetting. Both fields are
    /// CONSENSUS-RELEVANT: the check window is re-based at every crank
    /// start, so whether a crank is refused is a pure function of its
    /// own cost and these two numbers, on every replica whatever its
    /// suspend, rewind, or migration history — and therefore two
    /// replicas configured differently fork silently at the first crank
    /// one refuses. Like [`CadencePolicy`], the policy is NOT recorded
    /// in the store (only the armed interval rides the `METR` atom), so
    /// replicas must agree on it out of band, and a change to it belongs
    /// in the same release as any other consensus-relevant
    /// configuration.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum MeterBounds {
        /// Armed. `crank_limit` computrons per crank, checked every
        /// `check_interval` computrons. The limit is enforced against
        /// the machine's absolute meter (which a persistent machine
        /// carries across cranks and suspends), as `crank start +
        /// crank_limit`, so it is exactly a per-crank budget however the
        /// machine's lifetime count reads.
        PerCrank {
            /// Computrons between host consultations (non-zero).
            check_interval: u64,
            /// Computrons a single crank may spend.
            crank_limit: u64,
        },
        /// Explicit opt-out: no limit is enforced. A machine resumed
        /// from a store written under an armed policy still carries the
        /// armed meter state, and the engine fails closed on an armed
        /// meter with no host, so this policy attaches a host that
        /// always continues rather than leaving the machine to abort —
        /// un-bounded means "this embedder refuses nothing", not "this
        /// embedder is misconfigured".
        Unbounded,
    }

    impl Default for MeterBounds {
        fn default() -> MeterBounds {
            MeterBounds::PerCrank {
                check_interval: DEFAULT_METER_CHECK_INTERVAL,
                crank_limit: DEFAULT_CRANK_COMPUTRON_LIMIT,
            }
        }
    }

    impl MeterBounds {
        /// Armed under the default cadence with an explicit limit.
        pub fn per_crank(crank_limit: u64) -> MeterBounds {
            MeterBounds::PerCrank {
                check_interval: DEFAULT_METER_CHECK_INTERVAL,
                crank_limit,
            }
        }

        /// The check cadence the meter is armed with, `None` when
        /// un-bounded. Clamped into `1..=crank_limit`: a zero interval
        /// would read as "un-armed" to the meter, and a cadence coarser
        /// than the limit is never useful — the meter scales the
        /// interval into 16.16 raw units with saturation, so an interval
        /// of `2^48` computrons or more would be armed but never
        /// consult the host, enforcing nothing while claiming a bound
        /// (adversarial review). Clamping to the limit keeps every
        /// `PerCrank` policy enforceable: the host is consulted at least
        /// once per limit's worth of computrons.
        fn check_interval(&self) -> Option<u64> {
            match self {
                MeterBounds::PerCrank {
                    check_interval,
                    crank_limit,
                } => Some((*check_interval).clamp(1, (*crank_limit).max(1))),
                MeterBounds::Unbounded => None,
            }
        }

        /// The per-crank limit, `None` when un-bounded.
        fn crank_limit(&self) -> Option<u64> {
            match self {
                MeterBounds::PerCrank { crank_limit, .. } => Some(*crank_limit),
                MeterBounds::Unbounded => None,
            }
        }
    }

    /// The host callback a [`MeterBounds`] installs: the meter shows it
    /// the machine's absolute computron count; it continues while that
    /// count is within the ceiling the current crank was granted. The
    /// ceiling is shared with the embedder, which re-points it at every
    /// crank start, so one installed callback serves every crank and
    /// every resume. A pure function of meter state and configuration,
    /// so it introduces no nondeterminism.
    fn meter_host(ceiling: &std::rc::Rc<std::cell::Cell<u64>>) -> Box<dyn FnMut(u64) -> bool> {
        let ceiling = ceiling.clone();
        Box::new(move |computrons| computrons <= ceiling.get())
    }

    /// Map a halt to its error, naming a meter refusal under a limit
    /// distinctly ([`MachineError::MeterAbort`]); `spent` is what the
    /// crank had spent when it halted.
    fn refuse(halt: Halt, spent: u64, limit: Option<u64>) -> MachineError {
        match (halt, limit) {
            (Halt::MeterAbort, Some(limit)) => MachineError::MeterAbort {
                computrons: spent,
                limit,
            },
            (halt, _) => MachineError::Halt(halt),
        }
    }

    /// A machine backed by the Rust engine.
    ///
    /// Mirrors the slice of the `xsnap::Machine` surface the daemon's
    /// engine-agnostic callers use, so engine selection stays a seam
    /// rather than a fork of the call sites.
    pub struct Machine {
        inner: VmMachine,
        bounds: MeterBounds,
    }

    impl Default for Machine {
        fn default() -> Self {
            Machine::new()
        }
    }

    impl Machine {
        /// Create a fresh machine over shared intrinsics, metered under
        /// [`MeterBounds::default`].
        pub fn new() -> Machine {
            Machine::with_bounds(MeterBounds::default())
        }

        /// Create a fresh machine under an explicit metering policy.
        pub fn with_bounds(bounds: MeterBounds) -> Machine {
            Machine {
                inner: VmMachine::new(),
                bounds,
            }
        }

        /// The metering policy every evaluation runs under.
        pub fn bounds(&self) -> &MeterBounds {
            &self.bounds
        }

        /// Compile and evaluate `source` in a fresh compartment.
        ///
        /// Compiles to bytecode **and its symbols atom**, then evaluates
        /// through `evaluate_with_symbols` so the intrinsics are linked —
        /// without the symbols atom the program's intrinsic references
        /// would not resolve. Each evaluation is a fresh interpreter, so
        /// its meter starts at zero and the crank limit is the ceiling
        /// itself. A refused program comes back with `completed: false`
        /// and `halt: Halt::MeterAbort`; [`Machine::eval`] maps that to
        /// [`MachineError::MeterAbort`].
        pub fn evaluate(&self, source: &str, strict: bool) -> Result<EvalOutcome, MachineError> {
            let (bytecode, symbols) = compile_atoms_with(source, strict)
                .map_err(|e| MachineError::Compile(e.to_string()))?;
            let comp = self.inner.new_compartment();
            let outcome = match (self.bounds.check_interval(), self.bounds.crank_limit()) {
                (Some(interval), Some(limit)) => {
                    let ceiling = std::rc::Rc::new(std::cell::Cell::new(limit));
                    comp.evaluate_with_symbols_metered(
                        &bytecode,
                        &symbols,
                        interval,
                        meter_host(&ceiling),
                    )
                }
                _ => comp.evaluate_with_symbols(&bytecode, &symbols),
            };
            Ok(outcome.into())
        }

        /// Evaluate and return only the completion value, failing when
        /// the program did not complete.
        pub fn eval(&self, source: &str) -> Result<String, MachineError> {
            let outcome = self.evaluate(source, false)?;
            if outcome.completed {
                Ok(outcome.result)
            } else {
                Err(refuse(
                    outcome.halt,
                    outcome.computrons,
                    self.bounds.crank_limit(),
                ))
            }
        }

        /// Strict-mode counterpart of [`Machine::eval`].
        pub fn eval_strict(&self, source: &str) -> Result<String, MachineError> {
            let outcome = self.evaluate(source, true)?;
            if outcome.completed {
                Ok(outcome.result)
            } else {
                Err(refuse(
                    outcome.halt,
                    outcome.computrons,
                    self.bounds.crank_limit(),
                ))
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
            return Err(refuse(
                outcome.halt,
                outcome.computrons,
                machine.bounds().crank_limit(),
            ));
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
        /// The worker's callback-table signature. The snapshot layer
        /// appends its engine-owned boot-layout generation, and the
        /// store and blob formats gate on the combined signature. A
        /// database from an incompatible host or engine layout is
        /// refused rather than adopted.
        pub signature: String,
        /// Checkpoint/collect scheduling (store seam deferred item I).
        /// The default is the stated per-crank minimum; anything
        /// richer is an explicit supervisor opt-in with its trade
        /// documented on the field.
        pub cadence: CadencePolicy,
        /// The per-crank computation bound (architecture review F014/
        /// F020). Armed by default; [`MeterBounds::Unbounded`] is the
        /// explicit opt-out. Consensus-relevant like `cadence`, and like
        /// `cadence` not recorded in the store: replicas must agree on
        /// it out of band to refuse the same cranks.
        pub meter: MeterBounds,
    }

    /// The checkpoint/collect cadence a [`PersistentMachine`] runs
    /// under — a SUPERVISOR policy, counted in completed cranks so the
    /// schedule is REPLICA-VISIBLE: two replicas configured alike make
    /// identical checkpoint/collect decisions at identical crank
    /// counts over a deterministic execution (crank halts included —
    /// they rewind at the same point everywhere). Host I/O failures
    /// fork epoch history regardless of policy; after such a rewind
    /// the counters restart from the surviving checkpoint.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct CadencePolicy {
        /// Checkpoint after every Nth completed crank. `1` (the
        /// default, and what `0` normalizes to) is today's contract:
        /// every completed crank is durable before its outcome is
        /// reported. N > 1 trades durability for throughput and the
        /// trade is exactly the REWIND WINDOW, rewinding to the last
        /// CHECKPOINT: a crank that HALTS discards up to N-1 completed-
        /// but-unflushed cranks (the halting crank never completed), and
        /// a crank whose FLUSH fails discards up to N completed cranks
        /// (the N-1 previously reported Ok plus this one, its Err). A
        /// suspend (`close`) always flushes pending cranks first, so
        /// the widened window exists only while the machine is live.
        pub checkpoint_every: u32,
        /// Run the durable summary-driven partial collection after
        /// every Mth completed crank; `0` (the default) never does —
        /// the supervisor calls [`PersistentMachine::collect`] itself.
        /// An automatic collection flushes pending cranks first (the
        /// collector requires a checkpoint boundary) and then
        /// checkpoints again for durability, exactly as the manual
        /// call does. Collection rewrites the free list, and free-list
        /// order feeds allocation, so this schedule being
        /// replica-visible is what keeps replicas byte-identical.
        pub collect_every: u32,
    }

    impl Default for CadencePolicy {
        fn default() -> CadencePolicy {
            CadencePolicy {
                checkpoint_every: 1,
                collect_every: 0,
            }
        }
    }

    /// A machine whose heap is backed by the snapshot store: the
    /// supervisor-facing worker-heap lifecycle. One instance owns one
    /// store session over one database.
    ///
    /// Cadence ([`CadencePolicy`], deferred item I): by DEFAULT every
    /// COMPLETED crank checkpoints before its outcome is reported, so
    /// the database is always at a crank boundary; a crank that halts
    /// without completing is discarded by resuming from the last
    /// checkpoint (the deterministic crashed-crank contract — no
    /// partial effect ever persists). A supervisor may opt into
    /// `checkpoint_every: N` (flush every Nth crank; halts and failed
    /// flushes then rewind past up to N-1 completed cranks — the
    /// documented window, closed by `close`'s final flush) and
    /// `collect_every: M` (the durable partial collection on a
    /// replica-visible crank schedule); manual
    /// [`PersistentMachine::collect`] remains available either way and
    /// restarts the collect clock.
    ///
    /// The SES boot bundle and the worker envelope protocol remain the
    /// named gaps they were; this type is the heap-persistence half the
    /// supervisor owns either way. Cranks after the first RELINK
    /// per crank (side-table ledger G2): each crank compiles against
    /// its own symbol table and `Interp::relink_crank` rewrites its
    /// ID operands onto the machine's persisted table, extending it
    /// append-only for new names — the old textual-alignment
    /// contract (same used-name set, same first-appearance order for
    /// hash-bucket-colliding names; the wave-3 sharpening) is lifted.
    /// An aligned crank passes through byte-identical. The remaining
    /// [`MachineError::SymbolMismatch`] refusals are fail-closed
    /// exceptions before anything runs: runtime-interned ids present
    /// (table extension would collide until the ledger's KEYS row
    /// lands), or bytecode the instruction walker cannot decode.
    pub struct PersistentMachine {
        store: std::rc::Rc<std::cell::RefCell<ironhorse_store_sqlite::SqliteHeapStore>>,
        session: Option<ironhorse_snapshot::machine::StoreSession>,
        signature: ironhorse_snapshot::Signature,
        linked: bool,
        heap_store: std::path::PathBuf,
        cadence: CadencePolicy,
        /// Completed cranks not yet checkpointed (the live rewind
        /// window under `checkpoint_every > 1`; always 0 at a
        /// checkpoint boundary).
        pending_cranks: u32,
        /// Total COMPLETED cranks this STORE has absorbed, mirroring
        /// the manifest's durable counter (store schema 8). The collect
        /// schedule is derived from this ABSOLUTE total rather than a
        /// session-local "since the last collection" clock, which is
        /// what makes it survive a suspend: review wave 5 measured two
        /// replicas under an identical policy collecting at different
        /// cranks purely because one of them resumed mid-window, with
        /// identical per-crank results and computrons hiding the fork.
        ///
        /// Absolute also removes the clock entirely, and with it two
        /// defects a clock has: a rewind cannot mis-credit it, and a
        /// failed collection cannot consume credit for work it did not
        /// do — `total % collect_every` answers the same way regardless.
        durable_cranks: u64,
        /// Force the NEXT completed crank to checkpoint, whatever the
        /// cadence says. Set by a rewind.
        ///
        /// Without it, `checkpoint_every: N` STARVES on any workload
        /// that halts more often than every N cranks: the halt rewinds
        /// to the last checkpoint and drops the pending cranks, so the
        /// counter never reaches N, nothing is ever made durable, and
        /// the machine makes no progress at all — not the bounded
        /// rewind window the policy documents, but total loss (review
        /// wave 5). A rewind is evidence the cadence is too loose for
        /// this workload, so the next chance to make progress durable
        /// is taken and the cadence resumes from there. The flag is a
        /// pure function of the crank/halt sequence, so identically
        /// driven replicas still flush at identical points.
        checkpoint_after_rewind: bool,
        /// Scheduled collections that FAILED, and the most recent
        /// failure's text — the programmatic signal a supervisor needs.
        ///
        /// A failed scheduled collection cannot fail the crank (the
        /// crank is already durable, and reporting Err would be
        /// indistinguishable from the checkpoint-failure Err whose
        /// crank was DISCARDED — a supervisor re-delivering would then
        /// double-execute a committed crank, wave-4 P2). But it leaves
        /// this replica's free list and epoch behind a replica whose
        /// collection succeeded, and a log line is not something a
        /// supervisor can act on (review wave 5). Latching: a poll at
        /// any later point still sees it.
        collect_failures: u32,
        last_collect_error: Option<String>,
        /// The metering policy (architecture review F014/F020): a
        /// fresh boot machine is ARMED under it before its first crank,
        /// and every resumed machine — `open` on a populated store, and
        /// every rewind — has its host reattached, because the callback
        /// cannot travel in the snapshot and the engine fails closed on
        /// an armed meter with none. There is no path through this type
        /// that runs a crank without the policy in force.
        meter: MeterBounds,
        /// The absolute computron ceiling the CURRENT crank runs under,
        /// shared with the installed host callback and re-pointed at
        /// every crank start to `meter index at start + crank_limit`.
        /// Absolute because the persistent meter never resets: its
        /// index is the machine-lifetime count the snapshot carries.
        /// (The meter's own overflow guard would restart the index at
        /// zero only once it passed `2^48` computrons in one machine's
        /// lifetime, some `10^14`; a ceiling left stranded above a
        /// restarted index is not a reachable state.)
        crank_ceiling: std::rc::Rc<std::cell::Cell<u64>>,
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
            // Upgrade a decodable older store forward before resuming.
            // Open no longer migrates (review wave 4, F2): the restamp is
            // authorized by the callback-table signature, which lives
            // here, so a daemon pointed at a store it could not resume
            // (incompatible signature) refuses to migrate it rather than
            // one-way restamping it out from under its rightful owner. A
            // fresh or already-current store is a no-op.
            ironhorse_snapshot::store::migrate_store(&mut store, &signature).map_err(store_err)?;
            // No crank has run yet, so the ceiling's initial value is
            // irrelevant; `eval` re-points it before every crank.
            let crank_ceiling = std::rc::Rc::new(std::cell::Cell::new(u64::MAX));
            match store.manifest() {
                Err(StoreError::Empty) => {
                    // A fresh boot machine is armed BEFORE it is bound
                    // to the store, so the very first crank runs
                    // bounded and epoch 1 already carries the armed
                    // meter state.
                    let mut boot = ironhorse_vm::Interp::new();
                    if let Some(interval) = options.meter.check_interval() {
                        boot.arm_meter(interval, meter_host(&crank_ceiling));
                    }
                    let session = begin_store_session(boot, &signature, &mut store)
                        .map_err(|(_, e)| store_err(e))?;
                    let durable_cranks = session.cranks();
                    Ok(PersistentMachine {
                        store: std::rc::Rc::new(std::cell::RefCell::new(store)),
                        session: Some(session),
                        signature,
                        linked: false,
                        heap_store: options.path.clone(),
                        cadence: options.cadence.clone(),
                        pending_cranks: 0,
                        durable_cranks,
                        checkpoint_after_rewind: false,
                        collect_failures: 0,
                        last_collect_error: None,
                        meter: options.meter.clone(),
                        crank_ceiling,
                    })
                }
                Ok(_) => {
                    let store = std::rc::Rc::new(std::cell::RefCell::new(store));
                    let mut session =
                        resume_from_store_lazy(store.clone(), &signature).map_err(store_err)?;
                    Self::attach_meter(&options.meter, &crank_ceiling, session.machine_mut());
                    // A resumed machine carries its program symbol
                    // names in the small state; an empty table means
                    // no crank ever linked (e.g. the first crank
                    // crashed before its checkpoint).
                    let linked = !session.machine().program_symbol_names().is_empty();
                    // The durable crank total the store already carries:
                    // the schedule continues from here, which is what
                    // makes a suspend invisible to it.
                    let durable_cranks = session.cranks();
                    Ok(PersistentMachine {
                        store,
                        session: Some(session),
                        signature,
                        linked,
                        heap_store: options.path.clone(),
                        cadence: options.cadence.clone(),
                        pending_cranks: 0,
                        durable_cranks,
                        checkpoint_after_rewind: false,
                        collect_failures: 0,
                        last_collect_error: None,
                        meter: options.meter.clone(),
                        crank_ceiling,
                    })
                }
                Err(e) => Err(store_err(e)),
            }
        }

        /// Put a RESUMED machine under `meter`. The host callback does
        /// not ride the snapshot, so every resume (open on a populated
        /// store, every rewind) passes through here, and the engine's
        /// fail-closed rule for an armed meter with no host never
        /// fires on a machine this type hands out.
        ///
        /// Armed policy: `attach_meter_host` reattaches when the store
        /// was suspended under this exact interval (the window
        /// continues untouched) and re-arms from the preserved index
        /// otherwise — a store written un-metered, or under an older
        /// cadence, is bounded from its next crank on. Either way
        /// [`Self::eval`] re-bases the window at the crank start, so
        /// the distinction only matters for the gap between resume and
        /// the next crank, where nothing runs. Un-bounded policy: a
        /// store that carries an armed meter gets a host that always
        /// continues, so the explicit opt-out means "refuse nothing"
        /// instead of "abort everything"; a never-armed store stays
        /// un-armed.
        fn attach_meter(
            meter: &MeterBounds,
            crank_ceiling: &std::rc::Rc<std::cell::Cell<u64>>,
            machine: &mut ironhorse_vm::Interp,
        ) {
            match meter.check_interval() {
                Some(interval) => machine.attach_meter_host(interval, meter_host(crank_ceiling)),
                None if machine.meter_is_armed() => {
                    machine.reattach_meter_host(Box::new(|_| true));
                }
                None => {}
            }
        }

        /// The metering policy this machine's cranks run under.
        pub fn meter_bounds(&self) -> &MeterBounds {
            &self.meter
        }

        /// Discard the in-memory machine and resume from the store's
        /// last committed epoch — the crashed-crank/failed-checkpoint
        /// discipline. The store's commit is atomic, so a failed
        /// checkpoint left it at the prior epoch.
        fn rewind_to_last_checkpoint(&mut self) -> Result<(), MachineError> {
            use ironhorse_snapshot::machine::resume_from_store_lazy;
            self.session = None;
            // The cadence just cost this workload every pending crank;
            // make the next completed one durable rather than betting
            // on reaching N before the next halt (review wave 5).
            self.checkpoint_after_rewind = true;
            // A rewind lands on the last CHECKPOINT, discarding only the
            // PENDING (completed-but-unflushed) cranks. Their collect-
            // discarded with them. `durable_cranks` is untouched — it
            // counts what the STORE absorbed, and a rewind returns the
            // machine to exactly that point, so the schedule resumes
            // from the same absolute total a replica that never halted
            // would be at.
            self.pending_cranks = 0;
            let mut fresh = resume_from_store_lazy(self.store.clone(), &self.signature)
                .map_err(store_err)?;
            // The rewound machine is a resume like any other: its host
            // callback must be reattached or its next crank fails
            // closed.
            Self::attach_meter(&self.meter, &self.crank_ceiling, fresh.machine_mut());
            self.linked = !fresh.machine().program_symbol_names().is_empty();
            self.session = Some(fresh);
            Ok(())
        }

        /// Compile and run one crank against the persistent heap.
        ///
        /// A completed crank checkpoints before returning its outcome
        /// (the outcome is durable when the caller sees it). A crank
        /// that halts without completing returns its halt AFTER the
        /// machine has been rewound to the last checkpoint — the
        /// partial crank's effects are gone from memory and were never
        /// in the database. A completed crank whose CHECKPOINT fails
        /// is rewound the same way before the error is reported: a
        /// mutated machine whose outcome was never durably recorded
        /// must not seed a later crank (review finding).
        pub fn eval(&mut self, source: &str) -> Result<EvalOutcome, MachineError> {
            use ironhorse_snapshot::machine::checkpoint_to_store;

            let (bytecode, symbols) = compile_atoms_with(source, false)
                .map_err(|e| MachineError::Compile(e.to_string()))?;
            let names = ironhorse_vm::parse_symbols(&symbols);
            // The cadence decision (deferred item I), taken up front
            // from replica-visible state: counted in completed cranks,
            // so identically configured replicas flush and collect at
            // identical points. `checkpoint_every` is 1-normalized;
            // a due collection forces the flush (the collector needs a
            // checkpoint boundary).
            let pending_after = self.pending_cranks.saturating_add(1);
            // The absolute completed-crank total this crank would reach.
            // Deriving the schedule from a durable ABSOLUTE number is
            // what makes it resume-invariant: two replicas at the same
            // total agree on whether a collection is due, whatever their
            // suspend histories (review wave 5).
            let total_after = self.durable_cranks.saturating_add(pending_after as u64);
            let collect_due = self.cadence.collect_every > 0
                && total_after % self.cadence.collect_every as u64 == 0;
            let checkpoint_due = pending_after >= self.cadence.checkpoint_every.max(1)
                || collect_due
                || self.checkpoint_after_rewind;
            let (outcome, checkpointed, crank_start_raw) = {
                let session = self.session.as_mut().ok_or_else(|| {
                    MachineError::Store("machine has no session (a rewind failed)".to_string())
                })?;
                // The store's durable counter is the schedule's input,
                // so it must travel with the commit that makes these
                // cranks durable. The session cannot derive it.
                session.set_cranks(total_after);
                if !self.linked {
                    // An EMPTY table links nothing and constrains
                    // nothing (there are no ids to misalign), and
                    // `open` derives `linked` from the persisted name
                    // count — so leave the machine unlinked on an
                    // empty first crank, keeping the live machine and
                    // its reopened twin accepting the same next crank
                    // (wave-3 finding: they diverged).
                    if !names.is_empty() {
                        session.machine_mut().link_intrinsics(&names);
                        self.linked = true;
                    }
                }
                // Per-crank RELINKING (side-table ledger G2): a later
                // crank compiles against its OWN symbol table — ids
                // are table positions, so running it raw against a
                // differing persisted table would silently bind the
                // wrong globals (the review finding that used to make
                // this a hard refusal). `relink_crank` rewrites the
                // bytecode's ID operands onto the persisted table
                // (extending it append-only for genuinely new names),
                // so textual alignment is no longer required. Aligned
                // cranks pass through byte-identical. The remaining
                // refusals are fail-closed and name their reason:
                // malformed bytecode cannot be walked, and a table
                // grown to the symbol-key floor cannot extend (the
                // runtime-intern extension refusal retired with the
                // id-space unification — interned names live in the
                // persisted table and symbol keys mint top-down, so
                // extension aliases nothing). Nothing ran on refusal,
                // so no rewind is needed and the epoch stands.
                let bytecode = if self.linked {
                    session
                        .machine_mut()
                        .relink_crank(&bytecode, &names)
                        .map_err(|e| {
                            MachineError::SymbolMismatch(format!(
                                "this crank's compiled table ({} names) could not be \
                                 relinked onto the machine's persisted table ({} names): \
                                 {e:?}",
                                names.len(),
                                session.machine().program_symbol_names().len(),
                            ))
                        })?
                } else {
                    bytecode
                };
                // Grant this crank its budget: the persistent meter is
                // the machine-lifetime count, so the ceiling is absolute
                // — where the meter stands now plus the per-crank limit.
                // Re-pointed every crank, so a crank that was refused
                // does not shrink the next one's budget, and a resume
                // mid-history grants exactly what a never-suspended
                // replica would.
                //
                // The check WINDOW is re-based here too (`rearm_meter`:
                // the next host consultation falls one interval from
                // the crank's start), the way xsnap resets its meter at
                // every crank start. Without it the window's phase is
                // whatever history left it — a store migrated from an
                // un-armed policy, or armed under another cadence, sits
                // on a different phase from a natively armed replica —
                // and a crank spending inside `(limit, limit + interval]`
                // would be refused on one machine and admitted on the
                // other (adversarial review). Re-based per crank, whether
                // a crank is refused is a pure function of its own cost
                // and the configuration, on every replica whatever its
                // suspend, rewind, or migration history.
                let crank_start_raw = session.machine().meter_index();
                if let (Some(interval), Some(limit)) =
                    (self.meter.check_interval(), self.meter.crank_limit())
                {
                    self.crank_ceiling
                        .set((crank_start_raw >> 16).saturating_add(limit));
                    session
                        .machine_mut()
                        .rearm_meter(interval, meter_host(&self.crank_ceiling));
                }
                let outcome = session.machine_mut().run(&bytecode);
                if outcome.completed && checkpoint_due {
                    let r = checkpoint_to_store(
                        session,
                        &self.signature,
                        &mut *self.store.borrow_mut(),
                    );
                    (outcome, Some(r), crank_start_raw)
                } else {
                    (outcome, None, crank_start_raw)
                }
            };
            if !outcome.completed {
                // Halted: rewind to the LAST CHECKPOINT — under
                // `checkpoint_every > 1` that discards the pending
                // completed cranks too, the documented rewind-window
                // trade the policy opted into.
                let halt = outcome.halt;
                if let Err(rewind_err) = self.rewind_to_last_checkpoint() {
                    return Err(MachineError::Store(format!(
                        "rewind failed after a crank halt ({}): {rewind_err}",
                        describe_halt(&halt)
                    )));
                }
                // The meter is the machine-lifetime count; report what
                // THIS crank spent, from the raw index so the fractional
                // computron at the crank boundary is not double-counted.
                let spent = outcome.meter_raw.saturating_sub(crank_start_raw) >> 16;
                return Err(refuse(halt, spent, self.meter.crank_limit()));
            }
            match checkpointed {
                Some(Ok(_epoch)) => {
                    self.pending_cranks = 0;
                    self.durable_cranks = total_after;
                    // Progress is durable again; the cadence resumes.
                    self.checkpoint_after_rewind = false;
                    if collect_due {
                        // The scheduled durable collection is a
                        // memory-management OPTIMIZATION, not part of the
                        // crank's contract: the crank is already flushed
                        // (durable at this epoch). If the collection
                        // fails, `collect()` rewinds to that same epoch —
                        // the crank stands — so this eval must still
                        // report Ok (wave-4 P2: returning Err here was
                        // indistinguishable from the checkpoint-failure
                        // Err whose crank was DISCARDED, so a supervisor
                        // re-delivering would double-execute a committed
                        // crank). A failed scheduled collection is logged
                        // and retried by the next schedule; a real store
                        // fault resurfaces at the next crank's checkpoint.
                        if let Err(e) = self.collect() {
                            // Ok still, for the reason above — but
                            // RECORDED, so a supervisor can see that
                            // this replica's free list and epoch are
                            // behind one whose collection succeeded
                            // instead of only finding it in a log
                            // (review wave 5).
                            self.collect_failures = self.collect_failures.saturating_add(1);
                            self.last_collect_error = Some(e.to_string());
                            eprintln!(
                                "ironhorse: scheduled collection failed after a committed crank \
                                 (the crank stands; collection will retry): {e}"
                            );
                        }
                    }
                    Ok(outcome.into())
                }
                Some(Err(e)) => {
                    // A failed rewind poisons the session (later
                    // calls refuse), but the caller asked what
                    // happened to ITS crank — keep the original
                    // failure visible inside the compound error
                    // instead of swallowing it (wave-3 finding).
                    if let Err(rewind_err) = self.rewind_to_last_checkpoint() {
                        return Err(MachineError::Store(format!(
                            "rewind failed after a failed checkpoint ({e:?}): {rewind_err}"
                        )));
                    }
                    Err(store_err(e))
                }
                None => {
                    // Completed but deferred by the cadence: the crank
                    // is live-only until the next flush point (a later
                    // crank, an automatic or manual collection, or
                    // close's final flush).
                    self.pending_cranks = pending_after;
                    Ok(outcome.into())
                }
            }
        }

        /// Summary-driven partial collection at the current crank
        /// boundary (the machine is always clean here — `eval` either
        /// checkpointed or rewound), made DURABLE before it returns:
        /// collection rewrites the free list, and free-list order
        /// feeds subsequent allocation, so an unrecorded collection
        /// would be silently discarded by `close()` and replayed
        /// differently after reopen (review finding). The checkpoint
        /// advances the epoch; a failed checkpoint rewinds, so the
        /// collection either persists or never happened. Returns the
        /// number of slots freed. The supervisor owns the cadence;
        /// the schedule is replica-visible, like the full collector's.
        pub fn collect(&mut self) -> Result<u32, MachineError> {
            use ironhorse_snapshot::machine::{checkpoint_to_store, partial_collect};
            // The collector requires a checkpoint boundary; under a
            // deferred cadence, flush the pending cranks first.
            self.flush_pending()?;
            let (freed, checkpointed) = {
                let session = self.session.as_mut().ok_or_else(|| {
                    MachineError::Store("machine has no session (a rewind failed)".to_string())
                })?;
                let freed =
                    partial_collect(session, &*self.store.borrow()).map_err(store_err)?;
                let r =
                    checkpoint_to_store(session, &self.signature, &mut *self.store.borrow_mut());
                (freed, r)
            };
            match checkpointed {
                Ok(_epoch) => Ok(freed),
                Err(e) => {
                    if let Err(rewind_err) = self.rewind_to_last_checkpoint() {
                        return Err(MachineError::Store(format!(
                            "rewind failed after a failed collection checkpoint ({e:?}): {rewind_err}"
                        )));
                    }
                    Err(store_err(e))
                }
            }
        }

        /// How many SCHEDULED collections have failed on this machine,
        /// and the most recent failure's text.
        ///
        /// A failed scheduled collection deliberately does not fail its
        /// crank — the crank is already durable, and an Err there would
        /// be indistinguishable from the checkpoint failure whose crank
        /// was DISCARDED, which a re-delivering supervisor would then
        /// double-execute. But it does leave this replica behind one
        /// whose collection succeeded, in both free-list order and
        /// epoch, so the fact is reported here rather than only logged
        /// (review wave 5). Latching, so an occasional poll still sees
        /// it. A manual [`Self::collect`] reports its own failure
        /// directly and is not counted here.
        pub fn failed_collections(&self) -> (u32, Option<&str>) {
            (self.collect_failures, self.last_collect_error.as_deref())
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

        /// Force any completed-but-deferred cranks durable NOW — the
        /// side-effect-free way to close the live rewind window a
        /// `checkpoint_every > 1` cadence opens, without consuming the
        /// machine (`close`) or perturbing the free list (`collect`).
        /// A supervisor calls it before copying `heap_store_path` or
        /// before an external acknowledgement. A no-op at a checkpoint
        /// boundary; on failure the machine rewinds to the last
        /// checkpoint and the error says the pending cranks were never
        /// durable.
        pub fn flush(&mut self) -> Result<(), MachineError> {
            self.flush_pending()
        }

        /// Checkpoint any completed-but-deferred cranks (a no-op at a
        /// checkpoint boundary). On failure the machine rewinds to
        /// the last checkpoint — the pending cranks were never
        /// durable, and the error says so.
        fn flush_pending(&mut self) -> Result<(), MachineError> {
            use ironhorse_snapshot::machine::checkpoint_to_store;
            if self.pending_cranks == 0 {
                return Ok(());
            }
            let total = self
                .durable_cranks
                .saturating_add(self.pending_cranks as u64);
            let r = {
                let session = self.session.as_mut().ok_or_else(|| {
                    MachineError::Store("machine has no session (a rewind failed)".to_string())
                })?;
                session.set_cranks(total);
                checkpoint_to_store(session, &self.signature, &mut *self.store.borrow_mut())
            };
            match r {
                Ok(_epoch) => {
                    self.pending_cranks = 0;
                    self.durable_cranks = total;
                    self.checkpoint_after_rewind = false;
                    Ok(())
                }
                Err(e) => {
                    if let Err(rewind_err) = self.rewind_to_last_checkpoint() {
                        return Err(MachineError::Store(format!(
                            "rewind failed after a failed flush ({e:?}): {rewind_err}"
                        )));
                    }
                    Err(store_err(e))
                }
            }
        }

        /// Release the machine and close the database with the full
        /// last-connection contract: after `Ok`, the file is
        /// self-contained (WAL folded in, sidecars removed) and safe
        /// to copy or hand to another supervisor.
        pub fn close(mut self) -> Result<(), MachineError> {
            // A suspend must not silently drop completed cranks: the
            // final flush closes the live rewind window the cadence
            // opened. Both the flush and the file close can fail; the
            // FLUSH error wins precedence — it reports data loss (the
            // acknowledged-but-unflushed cranks were never durable),
            // which the file-close error would otherwise mask (wave-4
            // P3). The store is closed either way (the machine is being
            // released).
            let flush = self.flush_pending();
            drop(self.session.take());
            let store = match std::rc::Rc::try_unwrap(self.store) {
                Ok(cell) => cell.into_inner(),
                // Same precedence as below, which `?` used to skip:
                // a still-shared store means the file was not closed,
                // but a failed flush means acknowledged cranks were
                // never durable, and that outranks it (review wave 5).
                Err(_) => {
                    return flush.and(Err(MachineError::Store(
                        "store still shared at close".to_string(),
                    )))
                }
            };
            let close = store.close().map_err(store_err);
            flush.and(close)
        }
    }

    /// `endor worker -e ironhorse`: not built yet.
    ///
    /// The worker speaks the CBOR envelope protocol over a transport and
    /// boots `polyfills.js` → `host_aliases.js` → `ses_boot.js`. Those
    /// need the host-function surface and the SES bundle, neither of
    /// which has landed. Reported as a named gap rather than faked.
    pub fn run_worker() -> Result<(), MachineError> {
        Err(MachineError::Unavailable(
            "the worker envelope protocol. The heap-persistence half is \
             fully landed (PersistentMachine: open/resume, per-crank \
             relinking, durable collect, cadence policy, close contract); \
             what remains is exactly the deliver-payload side: the \
             host-function surface (ironhorse-engine.md § Endor \
             integration, the host-powers row — not a numbered stage) \
             and the SES boot bundle (roadmap stage 4, Hardened \
             JavaScript, whose acceptance bar is those bundles running \
             identically on both engines — concretely the side-table \
             ledger's HardenState/Modules/Functions rows). The transport \
             loop itself (init/restore + deliver, as \
             xsnap::run_xs_program speaks it over a worker_io transport) \
             is mechanical once payloads can be interpreted; a private \
             eval-shaped dialect would fake the protocol, so this stays \
             a named gap"
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
