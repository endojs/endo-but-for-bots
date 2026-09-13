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
//! has not landed yet halt with `Halt::NotImplemented`, which this module
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
        ModuleGraph, ModuleSource, PanicKind, RunOutcome, Slot,
    };

    /// Why an evaluation could not be carried out or did not complete.
    #[derive(Debug)]
    pub enum MachineError {
        /// `ironhorse_compile` rejected the source.
        Compile {
            message: String,
            /// Raw compilation charges retained even when the attempt fails.
            meter_raw: u64,
        },
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
                MachineError::Compile { message, .. } => write!(f, "compile error: {message}"),
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
            Halt::NotImplemented(op) => {
                format!("unsupported opcode `{op}` (a named, unlanded engine gap)")
            }
            Halt::Refused(label) => {
                format!("execution refused: `{label}` (an engine profile limit)")
            }
            Halt::EngineInvariant(label) => {
                format!("engine invariant violated: `{label}` (an Ironhorse defect, not an unlanded gap)")
            }
            Halt::Decode(e) => format!("bytecode decode error: {e}"),
            Halt::Throw { rendered, .. } => format!("uncaught throw: {rendered}"),
            Halt::StackOverflow(n) => {
                format!("value stack overflow ({n} slots in use)")
            }
            Halt::ReentryLimit { depth, limit } => {
                format!("native recursion limit (attempted weighted depth {depth}; limit {limit})")
            }
            Halt::Panic(PanicKind::EngineFault { message, location }) => match location {
                Some(location) => format!("engine fault at {location}: {message}"),
                None => format!("engine fault: {message}"),
            },
            other => format!("halted: {other:?}"),
        }
    }

    /// How one engine run ended, as the `Machine`/supervisor seam sees it
    /// (design `designs/ironhorse-panic.md` § The Formal `Panic` Category,
    /// item 4). Slot Machine's commit decision reads only this three-way
    /// value: `Quiesced` commits the crank, `Uncaught` and `Panicked` both
    /// discard the embargoed effects, and only `Panicked` additionally
    /// enters the terminate/restore/replay policy.
    ///
    /// **Scope note.** This classifier is landable now, but the
    /// *delivery-path* surfacing — where the supervisor actually acts on a
    /// `Panicked` to discard a crank — rides on the not-yet-complete
    /// `-e ironhorse` engine-selection integration (roadmap stage 8/9) and
    /// is deliberately not wired to a live delivery path here. The type and
    /// its classifier are the landable interpreter-side half; the seam that
    /// consumes them is a deferred follow-on.
    #[derive(Debug, Clone, PartialEq)]
    #[non_exhaustive]
    pub enum ExecutionOutcome {
        /// Execution ran the event loop to quiescence (the job queue
        /// emptied). This does **not** claim Slot Machine has committed
        /// anything, only that the engine run completed normally.
        Quiesced,
        /// A JS-level throw escaped every handler. Catchable in principle
        /// (uncaught by circumstance), so categorically distinct from a
        /// panic; carries the throw's best-effort message.
        Uncaught(String),
        /// The run terminated uncatchably. Carries the underlying [`Halt`]
        /// as its reason for reporting; the supervisor branches on the
        /// arm, never on the reason's variant shape.
        Panicked(Halt),
    }

    impl ExecutionOutcome {
        /// The seam's canonical constructor: classify a top-level [`Halt`]
        /// into the three-way outcome.
        ///
        /// The `Panicked` arm delegates to [`Halt::is_panic`] for every
        /// genuine *panic* variant, never re-listing panic shapes here:
        /// adding a new panic variant updates `is_panic()` alone and this
        /// classifier follows for free (design § The Formal `Panic`
        /// Category, item 4).
        ///
        /// `ExecutionOutcome::Panicked` is deliberately a **strict
        /// superset** of `is_panic()`, not equal to it. Two non-panic halts
        /// also classify as `Panicked` because they likewise must
        /// terminate-without-commit: `Halt::NotImplemented` (a named, unlanded
        /// engine gap) and the fail-closed catch-all for any control-state
        /// or future `#[non_exhaustive]` variant that should never reach
        /// this seam. Those two arms below are the *only* places `Panicked`
        /// is produced without `is_panic()`; every genuine panic still flows
        /// through that single gate, so `is_panic()` stays the one place the
        /// panic set is defined (the superset only adds "did not run to
        /// quiescence" cases that are not themselves panics).
        /// Spelled as an associated function (not a free `classify_halt`)
        /// because it is the sanctioned way to build an `ExecutionOutcome`
        /// from a `Halt`, discoverable at the type it produces.
        pub fn classify(halt: Halt) -> ExecutionOutcome {
            if halt.is_panic() {
                return ExecutionOutcome::Panicked(halt);
            }
            match halt {
                Halt::Throw { rendered, .. } => ExecutionOutcome::Uncaught(rendered),
                Halt::Return => ExecutionOutcome::Quiesced,
                // A known implementation gap or profile refusal did not run
                // the event loop to quiescence. Discard its crank without
                // treating this ordinary host outcome as an impossible state.
                halt @ (Halt::NotImplemented(_) | Halt::Refused(_)) => {
                    ExecutionOutcome::Panicked(halt)
                }
                // A future `#[non_exhaustive]` host outcome must be classified
                // explicitly. Until then, fail closed and discard the crank.
                // Private suspension/control transfers cannot enter this type.
                other => {
                    debug_assert!(
                        false,
                        "unexpected top-level halt at the Machine seam: {other:?}"
                    );
                    ExecutionOutcome::Panicked(other)
                }
            }
        }
    }

    /// The outcome of one evaluation, carrying the engine's own meter
    /// readings rather than a placeholder.
    #[derive(Debug)]
    pub struct EvalOutcome {
        /// The VM's retained first unhandled rejection, without guest coercion.
        /// Coordinates belong to the current interpreter and may move after
        /// a later collection; this is not an independently owned guest value.
        pub unhandled_rejection:
            Option<(ironhorse_vm::value::SlotIndex, ironhorse_vm::value::Slot)>,
        /// Completion value under ECMAScript `String()` semantics, or
        /// the engine's display rendering when `String()` cannot coerce
        /// the value (see `coercion_error`).
        pub result: String,
        /// `true` when the program reached RETURN/END and drained its
        /// jobs: the engine's own verdict, which `is_quiescent()` agrees
        /// with. A Symbol or null-prototype completion reads `true`
        /// here; the oracle harness's `String(result)` failure for it is
        /// reported beside the completion, never as a halt.
        pub completed: bool,
        /// The `TypeError` the oracle harness's post-run `String(result)`
        /// would throw for this completion value as the differential
        /// harness models it (a Symbol, or an object whose prototype is
        /// `null` — a prototype-link test, not a `ToPrimitive`
        /// evaluation; see `RunOutcome::coercion_error`), carried through
        /// from the engine so a host that wants the harness's verdict can
        /// apply it. The managed lifecycle does not: the crank completed.
        pub coercion_error: Option<String>,
        /// Whole computrons for this evaluation, including compilation and linking.
        pub computrons: u64,
        /// Opcodes dispatched by this evaluation.
        pub dispatched: u64,
        /// Raw 16.16 cost for this evaluation, including compilation and linking.
        pub meter_raw: u64,
        /// Machine-lifetime raw meter index at completion.
        pub meter_raw_total: u64,
        /// Why the run stopped.
        pub halt: Halt,
    }

    fn eval_outcome(o: RunOutcome, start_raw: u64) -> EvalOutcome {
        let raw = o.meter_raw.saturating_sub(start_raw);
        EvalOutcome {
            unhandled_rejection: o.unhandled_rejection,
            result: o.result,
            completed: o.completed,
            coercion_error: o.coercion_error,
            computrons: raw >> 16,
            dispatched: o.dispatched_this_run,
            meter_raw: raw,
            meter_raw_total: o.meter_raw,
            halt: o.halt,
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
        /// un-bounded. Clamped into `1..=min(crank_limit, 2^48 - 1)`: a
        /// zero interval would read as "un-armed" to the meter; a
        /// cadence coarser than the limit is never useful; and the meter
        /// scales the interval into 16.16 raw units with saturation, so
        /// an interval of `2^48` computrons or more would be armed but
        /// never consult the host, enforcing nothing while claiming a
        /// bound (adversarial review). The clamp keeps every `PerCrank`
        /// policy enforceable: the host is consulted at least once per
        /// limit's worth of computrons, and the largest cadence is one
        /// the meter can actually reach.
        fn check_interval(&self) -> Option<u64> {
            match self {
                MeterBounds::PerCrank {
                    check_interval,
                    crank_limit,
                } => Some((*check_interval).clamp(1, (*crank_limit).clamp(1, (1 << 48) - 1))),
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

    fn compile_allowance(bounds: &MeterBounds, index: u64) -> u64 {
        bounds
            .crank_limit()
            .map_or(u64::MAX, |limit| limit.saturating_mul(1 << 16))
            .min(u64::MAX - index)
    }

    // The host owns this unwind boundary. Shared progress preserves the bill on
    // parse errors, budget refusal, and coder panics before any bytecode executes.
    fn compile_metered(
        source: &str,
        strict: bool,
        budget: u64,
        charge: impl FnMut(u64) -> bool,
    ) -> Result<(Vec<u8>, Vec<u8>), MachineError> {
        let meter = ironhorse_compile::ParseMeter::with_charge_callback(budget, charge);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ironhorse_compile::compile_atoms_with_meter(source, strict, meter.clone())
        }));
        if meter.exhausted() {
            return Err(MachineError::Halt(Halt::MeterAbort));
        }
        match result {
            Ok(Ok(atoms)) => Ok(atoms),
            Ok(Err(error)) if error.kind == ironhorse_compile::ParseErrorKind::MeterLimit => {
                Err(MachineError::Halt(Halt::MeterAbort))
            }
            Ok(Err(ironhorse_compile::ParseError {
                kind:
                    ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                        kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                        ..
                    }),
                ..
            })) => Err(MachineError::Halt(Halt::HeapExhausted)),
            Ok(Err(ironhorse_compile::ParseError {
                kind:
                    ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                        kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                        ..
                    }),
                ..
            })) => Err(MachineError::Halt(Halt::MeterAbort)),
            Ok(Err(error)) => Err(MachineError::Compile {
                message: error.to_string(),
                meter_raw: meter.raw(),
            }),
            Err(payload) => {
                let message = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
                    .unwrap_or_else(|| "non-string compiler panic".to_string());
                Err(MachineError::Halt(Halt::Panic(PanicKind::EngineFault {
                    message,
                    location: None,
                })))
            }
        }
    }

    fn unrun_outcome(halt: Halt, meter_raw: u64) -> RunOutcome {
        RunOutcome {
            unhandled_rejection: None,
            meter_raw_this_run: 0,
            computrons_this_run: 0,
            dispatched_this_run: 0,
            completed: false,
            result: String::new(),
            coercion_error: None,
            host_render_halt: None,
            computrons: meter_raw >> 16,
            dispatched: 0,
            meter_raw,
            halt,
        }
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
        /// Create a fresh machine, metered under [`MeterBounds::default`].
        ///
        /// Each `evaluate` creates a fresh Realm on the VM machine's shared
        /// heap and frozen primordial graph. Its unreachable guest objects are
        /// collected at the next evaluation or machine drop, keeping raw
        /// diagnostics valid until a later collection. Persistent workers use a
        /// standalone `Interp`; shared-Realm snapshots are not yet supported.
        pub fn new() -> Machine {
            Machine::with_bounds(MeterBounds::default())
        }

        /// Create a fresh machine under an explicit metering policy.
        pub fn with_bounds(bounds: MeterBounds) -> Machine {
            let inner = VmMachine::new();
            inner
                .set_source_compiler(std::rc::Rc::new(ironhorse_runtime::IronhorseSourceCompiler))
                .expect("fresh machine admits its compiler policy");
            Machine { inner, bounds }
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
        /// would not resolve. Each evaluation has a fresh Realm and meter, so
        /// its meter starts at zero and the crank limit is the ceiling
        /// itself. A refused program comes back with `completed: false`
        /// and `halt: Halt::MeterAbort`; [`Machine::eval`] maps that to
        /// [`MachineError::MeterAbort`].
        pub fn evaluate(&self, source: &str, strict: bool) -> Result<EvalOutcome, MachineError> {
            // The prior Realm was dropped on return. Reclaim it before the
            // next compilation, preserving its raw diagnostics until this
            // later VM operation. The last evaluation lives until machine drop.
            // Each ephemeral evaluation is an independent delivery. Explicitly
            // abandon the prior delivery's queued work and acknowledge reports
            // before collecting; live VM compartments never do this implicitly.
            self.inner
                .discard_promise_jobs()
                .map_err(MachineError::Halt)?;
            self.inner
                .discard_unhandled_rejections()
                .map_err(MachineError::Halt)?;
            self.inner.collect().map_err(MachineError::Halt)?;
            let mut meter = VMeter::new();
            let mut host = match (self.bounds.check_interval(), self.bounds.crank_limit()) {
                (Some(interval), Some(limit)) => {
                    meter.begin(interval);
                    Some(meter_host(&std::rc::Rc::new(std::cell::Cell::new(limit))))
                }
                _ => None,
            };
            let budget = compile_allowance(&self.bounds, meter.state().index);
            let compiled = compile_metered(source, strict, budget, |raw| match host.as_mut() {
                Some(host) => meter.charge_compilation(raw, Some(host)),
                None => meter.charge_compilation(raw, None),
            });
            let (bytecode, symbols) = match compiled {
                Ok(atoms) => atoms,
                Err(MachineError::Halt(halt)) => {
                    return Ok(eval_outcome(unrun_outcome(halt, meter.state().index), 0))
                }
                Err(error) => return Err(error),
            };
            let mut comp = self.inner.new_compartment();
            comp.set_source_compiler(std::rc::Rc::new(ironhorse_runtime::IronhorseSourceCompiler));
            let outcome = self
                .inner
                .evaluate_compartment_with_symbols_continuing_meter_shared(
                    &comp,
                    bytecode.into(),
                    &symbols,
                    meter,
                    host,
                );
            Ok(eval_outcome(outcome, 0))
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

        /// This machine's shared frozen primordial graph.
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
        let source = std::fs::read_to_string(path).map_err(|e| MachineError::Compile {
            message: format!("cannot read {}: {e}", path.display()),
            meter_raw: 0,
        })?;
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
        /// Explicit intrinsic-global binding policy for fresh boot, resume,
        /// and rewind. `None` permits all; `Some(vec![])` permits only
        /// `globalThis`. This host policy is not stored: replicas must agree
        /// out of band. It cannot revoke bindings already in the heap or
        /// capabilities reachable through prototypes.
        pub intrinsic_permit: Option<Vec<String>>,
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
        /// Run durable exact collection (including chunks and weak entries) after
        /// every Mth completed crank; `0` (the default) never does —
        /// the supervisor calls [`PersistentMachine::collect`] itself.
        /// Exact collection can make the full heap resident and the following
        /// checkpoint rewrites relocated data; choose cadence for that cost.
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
    /// `collect_every: M` (durable exact collection on a
    /// replica-visible crank schedule); manual
    /// [`PersistentMachine::collect`] remains available either way and
    /// records an additional collection without resetting the crank clock.
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
        session: Option<ironhorse_snapshot::machine::SharedStoreSession>,
        start: Option<Compartment>,
        signature: ironhorse_snapshot::Signature,
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
        intrinsic_permit: Option<Vec<String>>,
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
            use ironhorse_snapshot::machine::begin_shared_store_session;
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
            match store.manifest() {
                Ok(manifest) if manifest.collect_every != options.cadence.collect_every => {
                    return Err(MachineError::Store(
                        "collection cadence mismatch".to_string(),
                    ));
                }
                Ok(manifest) => {
                    // The shared worker cannot adopt the old standalone profile.
                    // Refuse before migration can restamp a heap still owned by an
                    // older worker. This is an explicit profile incompatibility.
                    if manifest.store_schema < 32
                        || ironhorse_snapshot::store::SmallState::decode(
                            &store.read_small_state().map_err(store_err)?,
                        )
                        .map_err(store_err)?
                        .function_state
                        .shared
                        .is_none()
                    {
                        return Err(MachineError::Store(
                            "incompatible standalone heap profile; shared Machine store required"
                                .to_owned(),
                        ));
                    }
                }
                Err(StoreError::Empty) => {}
                Err(error) => return Err(store_err(error)),
            }
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
                    let boot = VmMachine::with_start_permit(options.intrinsic_permit.as_deref());
                    boot.set_source_compiler(std::rc::Rc::new(
                        ironhorse_runtime::IronhorseSourceCompiler,
                    ))
                    .map_err(MachineError::Halt)?;
                    let start = boot.start_compartment();
                    boot.with_persistence(|interp| {
                        if let Some(interval) = options.meter.check_interval() {
                            interp.arm_meter(interval, meter_host(&crank_ceiling));
                        }
                    })
                    .map_err(MachineError::Halt)?;
                    let session = begin_shared_store_session(
                        boot,
                        &signature,
                        &mut store,
                        options.cadence.collect_every,
                    )
                    .map_err(|(_, e)| store_err(e))?;
                    let durable_cranks = session.cranks();
                    Ok(PersistentMachine {
                        store: std::rc::Rc::new(std::cell::RefCell::new(store)),
                        session: Some(session),
                        signature,
                        start: Some(start),
                        heap_store: options.path.clone(),
                        cadence: options.cadence.clone(),
                        pending_cranks: 0,
                        durable_cranks,
                        checkpoint_after_rewind: false,
                        collect_failures: 0,
                        last_collect_error: None,
                        meter: options.meter.clone(),
                        intrinsic_permit: options.intrinsic_permit.clone(),
                        crank_ceiling,
                    })
                }
                Ok(_) => {
                    let store = std::rc::Rc::new(std::cell::RefCell::new(store));
                    let (session, start) = Self::resume_shared(
                        store.clone(),
                        &signature,
                        &options.meter,
                        &options.intrinsic_permit,
                        &crank_ceiling,
                    )?;
                    // The durable crank total the store already carries:
                    // the schedule continues from here, which is what
                    // makes a suspend invisible to it.
                    let durable_cranks = session.cranks();
                    Ok(PersistentMachine {
                        store,
                        session: Some(session),
                        signature,
                        start: Some(start),
                        heap_store: options.path.clone(),
                        cadence: options.cadence.clone(),
                        pending_cranks: 0,
                        durable_cranks,
                        checkpoint_after_rewind: false,
                        collect_failures: 0,
                        last_collect_error: None,
                        meter: options.meter.clone(),
                        intrinsic_permit: options.intrinsic_permit.clone(),
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
        /// the next crank, where no crank runs (a collection there may
        /// checkpoint the resume-time window, which the next crank
        /// start overwrites). Un-bounded policy: a
        /// store that carries an armed meter gets a host that always
        /// continues, so the explicit opt-out means "refuse nothing"
        /// instead of "abort everything"; a never-armed store stays
        /// un-armed.
        fn resume_shared(
            store: std::rc::Rc<std::cell::RefCell<ironhorse_store_sqlite::SqliteHeapStore>>,
            signature: &ironhorse_snapshot::Signature,
            meter: &MeterBounds,
            permit: &Option<Vec<String>>,
            ceiling: &std::rc::Rc<std::cell::Cell<u64>>,
        ) -> Result<(ironhorse_snapshot::machine::SharedStoreSession, Compartment), MachineError>
        {
            let mut start_id = None;
            let session = ironhorse_snapshot::machine::resume_shared_from_store_lazy_with(
                store,
                signature,
                |ids, state| {
                    if ids.len() != 1 {
                        return Err(ironhorse_snapshot::store::StoreError::Snapshot(
                            ironhorse_snapshot::SnapshotError::Corrupt(
                                "persistent worker requires one start compartment",
                            ),
                        ));
                    }
                    start_id = Some(ids[0]);
                    let environments = [(
                        ids[0],
                        ironhorse_vm::EnvironmentPolicy {
                            intrinsic_permit: permit.clone(),
                            source_compiler: Some(std::rc::Rc::new(
                                ironhorse_runtime::IronhorseSourceCompiler,
                            )),
                            name: None,
                            has_resolve_hook: false,
                            has_import_hook: false,
                        },
                    )]
                    .into_iter()
                    .collect();
                    Ok(ironhorse_vm::MachineRestorePolicy {
                        environments,
                        meter_host: (state.interval != 0).then(|| meter_host(ceiling)),
                    })
                },
            )
            .map_err(store_err)?;
            session
                .machine()
                .with_persistence(|interp| match meter.check_interval() {
                    Some(interval) => interp.attach_meter_host(interval, meter_host(ceiling)),
                    None if interp.meter_is_armed() => {
                        interp.reattach_meter_host(Box::new(|_| true));
                    }
                    None => {}
                })
                .map_err(MachineError::Halt)?;
            let start = session
                .machine()
                .claim_compartment(start_id.unwrap())
                .map_err(MachineError::Halt)?;
            session
                .machine()
                .release_unclaimed_roots()
                .map_err(MachineError::Halt)?;
            Ok((session, start))
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
            self.start = None;
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
            let (fresh, start) = Self::resume_shared(
                self.store.clone(),
                &self.signature,
                &self.meter,
                &self.intrinsic_permit,
                &self.crank_ceiling,
            )?;
            self.start = Some(start);
            self.session = Some(fresh);
            Ok(())
        }

        fn rewind_preparation_error(&mut self, error: MachineError) -> MachineError {
            match self.rewind_to_last_checkpoint() {
                Ok(()) => error,
                Err(rewind) => MachineError::Store(format!(
                    "rewind failed after crank preparation ({error}): {rewind}"
                )),
            }
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
        /// Compilation and symbol preparation are part of the crank: their
        /// failures also rewind, including completed but unflushed cranks when
        /// `checkpoint_every > 1`. Compile errors carry their attempted raw
        /// charge even though the persistent meter is restored with the heap.
        pub fn eval(&mut self, source: &str) -> Result<EvalOutcome, MachineError> {
            // Compilation is part of the crank: arm before any source work,
            // retain its live charges, and rewind failures under the same pending
            // checkpoint window as execution failures.
            let mut crank_meter = VMeter::new();
            let state = self
                .session
                .as_ref()
                .ok_or_else(|| {
                    MachineError::Store("machine has no session (a rewind failed)".into())
                })?
                .machine()
                .with_persistence(|i| i.meter_state())
                .map_err(MachineError::Halt)?;
            crank_meter.restore(state);
            let crank_start_raw = state.index;
            if let (Some(interval), Some(limit)) =
                (self.meter.check_interval(), self.meter.crank_limit())
            {
                self.crank_ceiling
                    .set((state.index >> 16).saturating_add(limit));
                crank_meter.rearm(interval);
            }
            let mut host = if crank_meter.is_armed() {
                Some(if self.meter.check_interval().is_some() {
                    meter_host(&self.crank_ceiling)
                } else {
                    Box::new(|_| true) as Box<dyn FnMut(u64) -> bool>
                })
            } else {
                None
            };
            let budget = compile_allowance(&self.meter, state.index);
            let compiled = compile_metered(source, false, budget, |raw| {
                crank_meter.charge_compilation(
                    raw,
                    host.as_mut()
                        .map(|h| h.as_mut() as &mut dyn FnMut(u64) -> bool),
                )
            });
            let compile_spent = crank_meter.state().index.saturating_sub(state.index) >> 16;
            let (bytecode, symbols) = match compiled {
                Ok(atoms) => atoms,
                Err(error) => {
                    let error = match error {
                        MachineError::Halt(halt) => {
                            refuse(halt, compile_spent, self.meter.crank_limit())
                        }
                        other => other,
                    };
                    return Err(self.rewind_preparation_error(error));
                }
            };
            // The cadence decision (deferred item I), taken up front
            // from replica-visible state: counted in completed cranks,
            // so identically configured replicas flush and collect at
            // identical points. `checkpoint_every` is 1-normalized;
            // a due collection forces the flush (the collector needs a
            // checkpoint boundary).
            let pending_after = self.pending_cranks.checked_add(1).ok_or_else(|| {
                MachineError::Store("pending crank counter exhausted".to_string())
            })?;
            // The absolute completed-crank total this crank would reach.
            // Deriving the schedule from a durable ABSOLUTE number is
            // what makes it resume-invariant: two replicas at the same
            // total agree on whether a collection is due, whatever their
            // suspend histories (review wave 5).
            let total_after = self
                .durable_cranks
                .checked_add(pending_after as u64)
                .ok_or_else(|| MachineError::Store("crank counter exhausted".to_string()))?;
            let collect_due = self.cadence.collect_every > 0
                && total_after % self.cadence.collect_every as u64 == 0;
            let checkpoint_due = pending_after >= self.cadence.checkpoint_every.max(1)
                || collect_due
                || self.checkpoint_after_rewind;
            let prepared = (|| -> Result<_, MachineError> {
                let session = self.session.as_mut().ok_or_else(|| {
                    MachineError::Store("machine has no session (a rewind failed)".to_string())
                })?;
                // The store's durable counter is the schedule's input,
                // so it must travel with the commit that makes these
                // cranks durable. The session cannot derive it.
                session.set_cranks(total_after);
                let start = self.start.as_ref().ok_or_else(|| {
                    MachineError::Store("machine has no start compartment".into())
                })?;
                let outcome = session
                    .machine()
                    .evaluate_compartment_with_symbols_continuing_meter_shared(
                        start,
                        bytecode.into(),
                        &symbols,
                        crank_meter,
                        host,
                    );
                Ok(if outcome.completed && checkpoint_due {
                    let r = session.checkpoint(&self.signature, &mut *self.store.borrow_mut());
                    (outcome, Some(r), crank_start_raw)
                } else {
                    (outcome, None, crank_start_raw)
                })
            })();
            let (mut outcome, checkpointed, crank_start_raw) = match prepared {
                Ok(prepared) => prepared,
                Err(error) => return Err(self.rewind_preparation_error(error)),
            };
            if !outcome.completed {
                // Halted: rewind to the LAST CHECKPOINT — under
                // `checkpoint_every > 1` that discards the pending
                // completed cranks too, the documented rewind-window
                // trade the policy opted into.
                //
                // `completed` is the ENGINE's verdict: the crank reached
                // its `END` and drained its jobs, and `is_quiescent()`
                // agrees. A crank whose completion value the oracle
                // harness's `String(result)` cannot coerce (a Symbol, a
                // null-prototype object) completes here with the
                // engine's own rendering; the harness's `TypeError`
                // travels beside it in `coercion_error` and only the
                // differential runners fold it into an abort. So this
                // path rewinds genuine halts only, never a legal program
                // (architecture review F030, closed).
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
                    // Scheduled collection (or its recovery) may relocate reason
                    // chunks after run_shared produced the original outcome.
                    outcome.unhandled_rejection = self.session.as_ref().and_then(|session| {
                        session
                            .machine()
                            .with_persistence(|i| i.unhandled_rejection())
                            .ok()
                            .flatten()
                    });
                    Ok(eval_outcome(outcome, crank_start_raw))
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
                    Ok(eval_outcome(outcome, crank_start_raw))
                }
            }
        }

        /// Exact collection at a quiescent checkpoint boundary, made durable
        /// before returning. Reclaims slots, weak entries, and chunk storage.
        /// The supervisor owns the schedule; replicas requiring identical heaps
        /// must coordinate it. Collection may fault in the full heap and makes
        /// the following checkpoint rewrite relocated records.
        ///
        /// Pending completed cranks are flushed first. A collection or checkpoint
        /// failure rewinds to that durable boundary: delivery remains committed,
        /// while the failed collection event is not counted. Returns slots freed.
        pub fn collect(&mut self) -> Result<u32, MachineError> {
            self.flush_pending()?;
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let session = self.session.as_mut().ok_or_else(|| {
                    MachineError::Store("machine has no session (a rewind failed)".to_string())
                })?;
                let collections = session.collections().checked_add(1).ok_or_else(|| {
                    MachineError::Store("collection counter exhausted".to_string())
                })?;
                let stats = session
                    .full_collect(&*self.store.borrow())
                    .map_err(store_err)?;
                session.set_collections(collections);
                session
                    .checkpoint(&self.signature, &mut *self.store.borrow_mut())
                    .map_err(store_err)?;
                Ok(stats.slots_reclaimed)
            }))
            .unwrap_or_else(|payload| {
                let message = payload
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| payload.downcast_ref::<&str>().map(|s| (*s).to_string()))
                    .unwrap_or_else(|| "non-string collection panic".to_string());
                Err(MachineError::Store(format!("collection failed: {message}")))
            });
            if let Err(error) = &result {
                if let Err(rewind_err) = self.rewind_to_last_checkpoint() {
                    return Err(MachineError::Store(format!(
                        "rewind failed after collection failure ({error:?}): {rewind_err}"
                    )));
                }
            }
            result
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
            if self.pending_cranks == 0 {
                return Ok(());
            }
            let total = self
                .durable_cranks
                .checked_add(self.pending_cranks as u64)
                .ok_or_else(|| MachineError::Store("crank counter exhausted".to_string()))?;
            let r = {
                let session = self.session.as_mut().ok_or_else(|| {
                    MachineError::Store("machine has no session (a rewind failed)".to_string())
                })?;
                session.set_cranks(total);
                session.checkpoint(&self.signature, &mut *self.store.borrow_mut())
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
            drop(self.start.take());
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
        fn standalone_store_profile_refusal_preserves_the_heap() {
            use ironhorse_snapshot::{
                machine::begin_store_session_with_cadence, store::HeapStore, Signature,
            };
            let dir = tempfile::tempdir().unwrap();
            let options = HeapStoreOptions {
                path: dir.path().join("standalone.sqlite"),
                signature: "standalone-profile".into(),
                cadence: CadencePolicy::default(),
                meter: MeterBounds::default(),
                intrinsic_permit: None,
            };
            let mut store = ironhorse_store_sqlite::SqliteHeapStore::open(&options.path).unwrap();
            let vm = ironhorse_vm::Interp::new();
            let session = begin_store_session_with_cadence(
                vm,
                &Signature::new(&options.signature),
                &mut store,
                options.cadence.collect_every,
            )
            .map_err(|(_, e)| e)
            .unwrap();
            let manifest = store.manifest().unwrap();
            let small = store.read_small_state().unwrap();
            drop(session);
            store.close().unwrap();
            assert!(
                matches!(PersistentMachine::open(&options), Err(MachineError::Store(message)) if message.contains("incompatible standalone heap profile"))
            );
            let store = ironhorse_store_sqlite::SqliteHeapStore::open(&options.path).unwrap();
            assert_eq!(store.manifest().unwrap(), manifest);
            assert_eq!(store.read_small_state().unwrap(), small);
            store.close().unwrap();
        }

        #[test]
        fn collector_panic_rewinds_to_the_committed_heap() {
            let dir = tempfile::tempdir().unwrap();
            let options = HeapStoreOptions {
                path: dir.path().join("collector-panic.sqlite"),
                signature: "collector-panic".to_string(),
                cadence: CadencePolicy::default(),
                meter: MeterBounds::default(),
                intrinsic_permit: None,
            };
            let mut machine = PersistentMachine::open(&options).unwrap();
            machine
                .eval("var committed=42; var garbage={}; garbage=null;")
                .unwrap();
            let epoch = machine.epoch().unwrap();
            machine
                .session
                .as_ref()
                .unwrap()
                .machine()
                .with_persistence(|vm| {
                    // Deliberately bypass the host checkpoint path. The collector's
                    // dirty-boundary assertion must be caught and rewind this state.
                    let (code, names) = ironhorse_compile::compile_atoms("committed=99").unwrap();
                    let code = vm
                        .relink_crank(&code, &ironhorse_vm::parse_symbols(&names))
                        .unwrap();
                    assert!(vm.run(&code).completed);
                    assert!(vm.is_quiescent());
                })
                .unwrap();
            assert!(
                matches!(machine.collect(), Err(MachineError::Store(message)) if message.contains("collection failed"))
            );
            assert_eq!(machine.epoch().unwrap(), epoch);
            assert_eq!(machine.session.as_ref().unwrap().collections(), 0);
            assert!(machine
                .session
                .as_ref()
                .unwrap()
                .machine()
                .with_persistence(|vm| vm.is_quiescent())
                .unwrap());
            machine.collect().unwrap();
            assert_eq!(machine.session.as_ref().unwrap().collections(), 1);
            assert_eq!(machine.eval("committed").unwrap().result, "42");
        }

        #[test]
        fn scheduled_collection_refreshes_report_before_delivering_outcome() {
            let dir = tempfile::tempdir().unwrap();
            let options = HeapStoreOptions {
                path: dir.path().join("rejection.sqlite"),
                signature: "rejection-report-test".to_owned(),
                cadence: CadencePolicy {
                    checkpoint_every: 1,
                    collect_every: 1,
                },
                meter: MeterBounds::default(),
                intrinsic_permit: None,
            };
            let mut machine = PersistentMachine::open(&options).unwrap();
            let outcome = machine.eval(
                "var garbage = 'x'.repeat(2000); garbage = null; Promise.reject(String.fromCharCode(55296));"
            ).unwrap();
            let current = machine.session.as_ref().unwrap().machine();
            current
                .with_persistence(|current| {
                    assert_eq!(outcome.unhandled_rejection, current.unhandled_rejection());
                    let (_, reason) = outcome.unhandled_rejection.unwrap();
                    let ironhorse_vm::value::Payload::String(chunk) = reason.value else {
                        panic!("string reason");
                    };
                    assert_eq!(current.chunks().slice(chunk, 2)[..], [0xd8, 0]);
                })
                .unwrap();
            assert_eq!(machine.failed_collections().0, 0);
            machine.close().unwrap();
        }

        #[test]
        fn top_level_compilation_adds_exact_live_charges() {
            let source = "Object.keys({a:1}).length";
            let report = ironhorse_compile::compile_atoms_with_budget(source, false, u64::MAX);
            let raw = report.parse_meter_raw;
            let (code, symbols) = report.result.unwrap();
            let baseline = ironhorse_vm::Machine::new()
                .new_compartment()
                .evaluate_with_symbols(&code, &symbols);
            let machine = Machine::with_bounds(MeterBounds::Unbounded);
            for _ in 0..3 {
                let actual = machine.evaluate(source, false).unwrap();
                assert!(actual.completed);
                assert_eq!(actual.result, baseline.result);
                assert_eq!(actual.meter_raw, baseline.meter_raw + raw);
            }
        }

        #[test]
        fn top_level_admission_refuses_before_execution_and_retains_bill() {
            let machine = Machine::with_bounds(MeterBounds::per_crank(32));
            let source = format!("/*{}*/ 1", "x".repeat(1_000_000));
            let outcome = machine.evaluate(&source, false).unwrap();
            assert!(!outcome.completed);
            assert!(matches!(outcome.halt, Halt::MeterAbort));
            assert_eq!(outcome.meter_raw, 32 << 16);
            assert_eq!(outcome.dispatched, 0);
        }

        #[test]
        fn top_level_parse_error_retains_compile_bill() {
            let source = "var = ;";
            let report = ironhorse_compile::compile_atoms_with_budget(source, false, u64::MAX);
            let machine = Machine::with_bounds(MeterBounds::Unbounded);
            match machine.evaluate(source, false) {
                Err(MachineError::Compile { meter_raw, .. }) => {
                    assert_eq!(meter_raw, report.parse_meter_raw)
                }
                other => panic!("expected charged compile error: {other:?}"),
            }
        }

        #[test]
        fn ephemeral_completion_is_rendered_after_machine_jobs() {
            let machine = Machine::with_bounds(MeterBounds::Unbounded);
            assert_eq!(
                machine
                    .eval("var result = []; Promise.resolve().then(() => result.push(42)); result")
                    .unwrap(),
                "42"
            );
            assert_eq!(
                machine.eval("(()=>{}).constructor('return 42')()").unwrap(),
                "42"
            );
        }

        #[test]
        fn ephemeral_evaluation_reclaims_prior_heap_before_the_next_compilation() {
            let source = "var heap = []; for (var i=0; i<1024; i++) heap.push({i}); heap.length";
            let single = Machine::with_bounds(MeterBounds::Unbounded);
            single.evaluate(source, false).unwrap();
            let single_heap = single.vm_machine().collect().unwrap();
            let machine = Machine::with_bounds(MeterBounds::Unbounded);
            for _ in 0..8 {
                let out = machine.evaluate(source, false).unwrap();
                assert!(out.completed);
                assert_eq!(out.result, "1024");
            }
            let repeated_heap = machine.vm_machine().collect().unwrap();
            assert_eq!(repeated_heap.slots_reclaimed, single_heap.slots_reclaimed);
            assert_eq!(repeated_heap.slots_live, single_heap.slots_live);
            machine.evaluate(source, false).unwrap();
            assert!(machine.evaluate("var = ;", false).is_err());
            assert_eq!(
                machine.vm_machine().collect().unwrap().slots_reclaimed,
                0,
                "prior heap is collected even if next compilation fails"
            );
        }

        #[test]
        fn ephemeral_throw_and_rejection_diagnostics_live_until_later_collection() {
            let machine = Machine::with_bounds(MeterBounds::Unbounded);
            for (source, kind) in [
                (
                    "Promise.reject({diagnostic: 7}); 0",
                    ironhorse_vm::Kind::Reference,
                ),
                (
                    "Promise.reject('retained rejection text'); 0",
                    ironhorse_vm::Kind::String,
                ),
            ] {
                let outcome = machine.evaluate(source, false).unwrap();
                assert!(outcome.completed);
                assert_eq!(outcome.unhandled_rejection.unwrap().1.kind, kind);
                // The returned raw values still belong to an allocated heap;
                // this explicit later collection is what invalidates them.
                assert!(machine.vm_machine().collect().unwrap().slots_reclaimed > 0);
            }
            let outcome = machine.evaluate("throw {diagnostic: 8}", false).unwrap();
            assert!(matches!(
                outcome.halt,
                Halt::Throw {
                    value: Slot {
                        kind: ironhorse_vm::Kind::Reference,
                        ..
                    },
                    ..
                }
            ));
            assert!(machine.vm_machine().collect().unwrap().slots_reclaimed > 0);
            assert_eq!(machine.eval("1").unwrap(), "1");
        }

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
                Err(MachineError::Compile { .. }) => {}
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

        // -- ExecutionOutcome classifier (design § The Formal `Panic`
        //    Category, item 4) ------------------------------------------

        fn engine_fault() -> Halt {
            Halt::Panic(PanicKind::EngineFault {
                message: "arena kind check failed".to_string(),
                location: Some("interp.rs:1:1".to_string()),
            })
        }

        #[test]
        fn quiescence_classifies_as_quiesced() {
            assert_eq!(
                ExecutionOutcome::classify(Halt::Return),
                ExecutionOutcome::Quiesced
            );
        }

        #[test]
        fn throw_classifies_as_uncaught_not_panicked() {
            match ExecutionOutcome::classify(Halt::synthetic_throw("boom".to_string())) {
                ExecutionOutcome::Uncaught(msg) => assert_eq!(msg, "boom"),
                other => panic!("expected Uncaught, got {other:?}"),
            }
        }

        #[test]
        fn unsupported_engine_gap_never_commits() {
            // A named, unlanded engine gap did not run to quiescence, so the
            // classifier must never tell the supervisor to commit its crank.
            // The catch-all's `debug_assert!` compiles out in a release
            // daemon, so `Quiesced` (= commit) would ship silently if this
            // regressed. `Unsupported` reaches this seam routinely, so it
            // has its own arm and must not trip the assert either.
            let outcome = ExecutionOutcome::classify(Halt::NotImplemented("STAGE8_GAP"));
            assert_ne!(
                outcome,
                ExecutionOutcome::Quiesced,
                "an engine gap must never classify as commit-the-crank",
            );
            assert!(
                matches!(outcome, ExecutionOutcome::Panicked(_)),
                "an engine gap must fail closed to Panicked (discard), got {outcome:?}",
            );
        }

        #[test]
        fn every_panic_source_classifies_as_panicked() {
            for halt in [
                Halt::StackOverflow(7),
                Halt::ReentryLimit {
                    depth: 2049,
                    limit: 2048,
                },
                Halt::MeterAbort,
                Halt::EngineInvariant("bitwise:stack-underflow"),
                engine_fault(),
                Halt::Decode(ironhorse_vm::DecodeError::ProgramCounterOutOfBounds {
                    pc: 0,
                    len: 0,
                }),
                Halt::StepLimit(42),
            ] {
                assert!(halt.is_panic(), "{halt:?} should be a panic");
                assert!(
                    matches!(
                        ExecutionOutcome::classify(halt.clone()),
                        ExecutionOutcome::Panicked(_)
                    ),
                    "{halt:?} should classify as Panicked",
                );
            }
        }

        #[test]
        fn stack_diagnostics_distinguish_value_geometry_from_native_depth() {
            assert_eq!(
                describe_halt(&Halt::StackOverflow(4000)),
                "value stack overflow (4000 slots in use)"
            );
            assert_eq!(
                describe_halt(&Halt::ReentryLimit {
                    depth: 2064,
                    limit: 2048
                }),
                "native recursion limit (attempted weighted depth 2064; limit 2048)"
            );
        }

        #[test]
        fn panicked_delegates_to_is_panic_for_every_panic() {
            // For every genuine panic variant the classifier's `Panicked`
            // arm fires *exactly when* `is_panic()` is true — never
            // re-listing panic shapes. `Unsupported` is deliberately
            // excluded here: it is not a panic (see the superset test
            // below), so it would break a strict-agreement claim — the very
            // contradiction the delegation invariant must not hide.
            for halt in [
                Halt::Return,
                Halt::synthetic_throw("x".to_string()),
                Halt::StackOverflow(1),
                Halt::ReentryLimit {
                    depth: 2049,
                    limit: 2048,
                },
                Halt::MeterAbort,
                Halt::EngineInvariant("bitwise:stack-underflow"),
                engine_fault(),
                Halt::Decode(ironhorse_vm::DecodeError::InvalidSymbols),
                Halt::StepLimit(1),
            ] {
                let panicked = matches!(
                    ExecutionOutcome::classify(halt.clone()),
                    ExecutionOutcome::Panicked(_)
                );
                assert_eq!(
                    panicked,
                    halt.is_panic(),
                    "classify/is_panic disagree for {halt:?}",
                );
            }
        }

        #[test]
        fn panicked_is_a_strict_superset_of_is_panic() {
            // `ExecutionOutcome::Panicked` is documented as a strict
            // superset of `is_panic()`: `Halt::NotImplemented` is NOT a panic,
            // yet must classify as `Panicked` (discard the crank, never
            // commit). This pins the deliberate, doc-stated exception to
            // strict delegation so a future reader cannot mistake
            // `is_panic()` for the sole gate on `Panicked`.
            let gap = Halt::NotImplemented("STAGE8_GAP");
            assert!(!gap.is_panic(), "an engine gap is not a panic");
            assert!(
                matches!(
                    ExecutionOutcome::classify(gap),
                    ExecutionOutcome::Panicked(_)
                ),
                "an engine gap must still classify as Panicked (discard)",
            );
        }

        #[test]
        fn escaped_private_transfer_fails_closed_at_the_seam() {
            // Private transfer variants cannot be represented by Halt. The VM
            // reports a transfer escaping its host boundary as an invariant
            // failure, which must discard the crank in every build profile.
            let halt = Halt::EngineInvariant("dispatch:control-transfer-escaped");
            assert!(matches!(
                ExecutionOutcome::classify(halt),
                ExecutionOutcome::Panicked(_)
            ));
        }

        #[test]
        fn engine_fault_without_location_renders_without_a_site() {
            // The `None` location arm of `describe_halt`'s `EngineFault`
            // rendering (a panic hook that could not recover `file:line:col`)
            // is otherwise unexercised — every other fixture carries a
            // `Some(..)` location.
            let halt = Halt::Panic(PanicKind::EngineFault {
                message: "kind check failed".to_string(),
                location: None,
            });
            assert_eq!(describe_halt(&halt), "engine fault: kind check failed");
        }

        #[test]
        fn non_panic_throw_is_not_panic() {
            assert!(!Halt::synthetic_throw("catchable".to_string()).is_panic());
            assert!(!Halt::Return.is_panic());
        }
    }
}

#[cfg(not(feature = "ironhorse-engine"))]
pub mod engine {
    //! Built without the `ironhorse-engine` feature: the seam is absent.
    //! The binary reports `-e ironhorse` as an unknown engine.
}
