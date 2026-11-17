//! One process, one persistent Ironhorse heap. No XS or Endor dependency.
#![forbid(unsafe_code)]

use ironhorse_snapshot::{
    machine::{begin_store_session, checkpoint_to_store, resume_from_store, StoreSession},
    store::migrate_store,
    Signature,
};
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, CompiledSource, Interp, SourceCompileError, SourceCompiler};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    rc::Rc,
    time::Instant,
};

struct Compiler;
impl SourceCompiler for Compiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        match ironhorse_compile::compile_atoms_budgeted_firewalled(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        ) {
            Ok(compiled) => Ok(ironhorse_vm::CompiledSource {
                bytecode: compiled.bytecode,
                symbols: compiled.symbols,
                parse_meter_raw: compiled.parse_meter_raw,
                parse_computrons: compiled.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => {
                Err(ironhorse_vm::SourceCompileError::MeterAbort)
            }
            // A caught compiler panic is an engine fault, not a coverage
            // gap (architecture finding F063).
            Err(ironhorse_compile::CompileError::Invariant(detail)) => {
                Err(ironhorse_vm::SourceCompileError::Invariant(detail))
            }
            Err(ironhorse_compile::CompileError::Parse(error)) => match error.kind {
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpHostAllocationFailed,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::HostAllocationFailed),
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::MeterAbort),
                ironhorse_compile::ParseErrorKind::Unsupported => Err(
                    ironhorse_vm::SourceCompileError::Unsupported(error.to_string()),
                ),
                _ => Err(ironhorse_vm::SourceCompileError::Syntax(error.message)),
            },
        }
    }

    fn compile_source_units(
        &self,
        source: &[u16],
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        match ironhorse_compile::compile_atoms_units_budgeted_firewalled(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        ) {
            Ok(compiled) => Ok(ironhorse_vm::CompiledSource {
                bytecode: compiled.bytecode,
                symbols: compiled.symbols,
                parse_meter_raw: compiled.parse_meter_raw,
                parse_computrons: compiled.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => {
                Err(ironhorse_vm::SourceCompileError::MeterAbort)
            }
            // A caught compiler panic is an engine fault, not a coverage
            // gap (architecture finding F063).
            Err(ironhorse_compile::CompileError::Invariant(detail)) => {
                Err(ironhorse_vm::SourceCompileError::Invariant(detail))
            }
            Err(ironhorse_compile::CompileError::Parse(error)) => match error.kind {
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpHostAllocationFailed,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::HostAllocationFailed),
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::MeterAbort),
                ironhorse_compile::ParseErrorKind::Unsupported => Err(
                    ironhorse_vm::SourceCompileError::Unsupported(error.to_string()),
                ),
                _ => Err(ironhorse_vm::SourceCompileError::Syntax(error.message)),
            },
        }
    }
}

/// Compile and execute a source unit, including its promise jobs. The caller
/// chooses the collection boundary; outbound extraction is a trusted read that
/// allocates only unregistered bridge temporaries, reclaimed by a later
/// collection. `spent` receives the wall time of compilation and of the run
/// (dispatch and promise jobs; the engine drains them inside one run), in
/// microseconds, for the timing a request may ask for; nothing reads the
/// clock's value otherwise.
fn run_source(
    session: &mut StoreSession,
    source: &str,
    budget: u64,
    spent: &mut [u64; 2],
) -> Result<String, String> {
    let started = Instant::now();
    let m = session.machine_mut();
    let ceiling = (m.meter_index() >> 16).saturating_add(budget);
    m.rearm_meter(
        budget.clamp(1, 1000),
        Box::new(move |spent| spent <= ceiling),
    );
    let raw_budget = budget
        .saturating_mul(1 << 16)
        .min(u64::MAX - m.meter_index());
    let mut charge = |raw| m.charge_compilation(raw);
    let meter = ironhorse_compile::ParseMeter::with_charge_callback(raw_budget, &mut charge);
    let compiled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        ironhorse_compile::compile_atoms_goal_with_meter(
            source,
            ironhorse_compile::Goal::Script,
            false,
            meter.clone(),
        )
    }));
    // Refusal takes precedence even if a compiler error or unwind follows it.
    if meter.exhausted() {
        return Err("guest crank halted: MeterAbort during compilation".into());
    }
    let (code, symbols) = compiled
        .map_err(|_| "guest crank halted: Panic during compilation".to_string())?
        .map_err(|e| match e.kind {
            ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                ..
            }) => "guest crank halted: HeapExhausted during compilation".to_string(),
            ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                kind: ironhorse_compile::LexErrorKind::RegExpHostAllocationFailed,
                ..
            }) => format!(
                "{} during compilation",
                crank_halted(&ironhorse_vm::Halt::HostAllocationFailed)
            ),
            ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                ..
            })
            | ironhorse_compile::ParseErrorKind::MeterLimit => {
                "guest crank halted: MeterAbort during compilation".to_string()
            }
            _ => e.to_string(),
        })?;
    drop(meter);
    let names = parse_symbols(&symbols);
    m.set_source_compiler(Rc::new(Compiler));
    let code = if m.program_symbol_names().is_empty() {
        m.link_intrinsics(&names);
        code
    } else {
        m.relink_crank(&code, &names)
            .map_err(|e| format!("relink: {e:?}"))?
    };
    let compiled_at = Instant::now();
    spent[0] += micros(compiled_at - started);
    let outcome = m.run(&code);
    spent[1] += micros(compiled_at.elapsed());
    if !outcome.completed {
        return Err(crank_halted(&outcome.halt));
    }
    Ok(outcome.result)
}

fn micros(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_micros()).unwrap_or(u64::MAX)
}

/// Run one crank, then collect if the schedule says so.
fn crank_eval(
    session: &mut StoreSession,
    schedule: &mut GcSchedule,
    source: &str,
    budget: u64,
    stats: &mut CrankStats,
) -> Result<String, String> {
    let mut spent = [0; 2];
    let result = run_source(session, source, budget, &mut spent);
    stats.compile_us += spent[0];
    stats.run_us += spent[1];
    // Never collect after a halt. Recovery replays from the last image.
    let result = result?;
    schedule.after_crank(session.machine_mut(), budget, stats)?;
    Ok(result)
}

/// A crank that always collects, as every crank did before the collection
/// schedule (C-7): the boot sequence, and the tests of that behaviour.
fn eval(session: &mut StoreSession, source: &str, budget: u64) -> Result<String, String> {
    let mut schedule = GcSchedule::new(GcPolicy::EveryCrank, session.machine());
    crank_eval(
        session,
        &mut schedule,
        source,
        budget,
        &mut CrankStats::default(),
    )
}

/// One host request dispatches, drains promise jobs, collects when the
/// schedule says so, and runs every finalizer round of that collection
/// before taking outbound. The trusted bootstrap's outbox holds only
/// JSON-parsed frame data: reading it cannot expose guest getters or
/// register finalizers. Its temporary array/string need no second
/// collection. Keep extraction's budget distinct, as it was in the
/// two-request protocol.
fn crank_deliver(
    session: &mut StoreSession,
    schedule: &mut GcSchedule,
    source: &str,
    budget: u64,
    drain_budget: u64,
    stats: &mut CrankStats,
) -> Result<String, String> {
    crank_eval(session, schedule, source, budget, stats)?;
    let mut spent = [0; 2];
    let started = Instant::now();
    let outbound = run_source(
        session,
        "JSON.stringify(thixotropeTakeOutbound())",
        drain_budget,
        &mut spent,
    );
    stats.extract_us += micros(started.elapsed());
    outbound
}

/// [`crank_deliver`] under the every-crank schedule.
#[cfg(test)]
fn deliver(
    session: &mut StoreSession,
    source: &str,
    budget: u64,
    drain_budget: u64,
) -> Result<String, String> {
    let mut schedule = GcSchedule::new(GcPolicy::EveryCrank, session.machine());
    crank_deliver(
        session,
        &mut schedule,
        source,
        budget,
        drain_budget,
        &mut CrankStats::default(),
    )
}

/// What one request cost, reported when the request asks for `timing`.
/// Wall times are measurements only: no schedule decision reads them.
#[derive(Default, Debug)]
struct CrankStats {
    compile_us: u64,
    run_us: u64,
    collect_us: u64,
    notify_us: u64,
    extract_us: u64,
    collections: u32,
}

impl CrankStats {
    fn to_json(&self, total_us: u64, schedule: &GcSchedule, m: &Interp) -> Value {
        json!({
            "compileUs": self.compile_us,
            "runUs": self.run_us,
            "collectUs": self.collect_us,
            "notifyUs": self.notify_us,
            "extractUs": self.extract_us,
            "totalUs": total_us,
            "collections": self.collections,
            "policy": schedule.policy.name(),
            "cranksSinceCollection": schedule.cranks_since,
            "liveSlots": m.slots().live_count(),
            "slotCapacity": m.slots().capacity(),
            "chunkBytes": chunk_footprint(m),
        })
    }
}

/// When the worker collects garbage (core candidate C-7).
///
/// Every input to the decision is a deterministic function of the vat's
/// history since its last image: the image's own heap, then the cranks
/// replayed onto it in journal order and their slot and chunk allocation as
/// the engine counts it. No wall time, memory pressure, host state or host
/// setting that may change across a restart (the ceilings may be raised)
/// enters it. A replay from the same image of the same journal therefore
/// collects after the same cranks, runs the same finalizers in the same
/// cranks and emits the same outbound. An image is taken only at `close` (a
/// checkpoint or a sleep), which the host records with its journal cut
/// before it delivers anything more, and recovery never replays across it:
/// the counters restart from the image's heap, as they do for the
/// incarnation that wrote the image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GcPolicy {
    /// Collect after every crank and never at close: the behaviour before
    /// C-7, kept so a regression can be bisected (`gcPolicy` "every-crank").
    EveryCrank,
    /// Collect after a crank that grew the live slots by `slots`, or the
    /// chunk footprint by `chunk_bytes`, since the last collection (or since
    /// the image); and at close when any crank ran since the last
    /// collection, so no image carries the garbage of its cranks. A crank
    /// therefore starts with less than the allowance of uncollected growth:
    /// it fits under a ceiling wherever it would fit under every-crank
    /// collection with the allowance to spare.
    Allocation { slots: u32, chunk_bytes: u64 },
}

impl GcPolicy {
    fn name(&self) -> &'static str {
        match self {
            GcPolicy::EveryCrank => "every-crank",
            GcPolicy::Allocation { .. } => "allocation",
        }
    }
}

/// The chunk bytes the chunk ceiling counts: the arena and the side storage
/// charged against it.
fn chunk_footprint(m: &Interp) -> u64 {
    (m.chunks().byte_size() as u64).saturating_add(m.chunks().side_reserved())
}

/// The schedule's state: the heap's size after the last collection (or at
/// the image) and the cranks run since.
struct GcSchedule {
    policy: GcPolicy,
    live_slots: u32,
    chunk_bytes: u64,
    cranks_since: u32,
}

impl GcSchedule {
    fn new(policy: GcPolicy, m: &Interp) -> Self {
        Self {
            policy,
            live_slots: m.slots().live_count(),
            chunk_bytes: chunk_footprint(m),
            cranks_since: 0,
        }
    }

    fn due(&self, m: &Interp) -> bool {
        match self.policy {
            GcPolicy::EveryCrank => true,
            GcPolicy::Allocation { slots, chunk_bytes } => {
                m.slots().live_count().saturating_sub(self.live_slots) >= slots
                    || chunk_footprint(m).saturating_sub(self.chunk_bytes) >= chunk_bytes
            }
        }
    }

    /// After a completed crank: collect and finalize when due. A cleanup
    /// left pending (by the collection at close, carried in the image) is
    /// notified by the engine at the end of the next crank's drain; one
    /// still pending here is finalized as a due collection's would be.
    fn after_crank(
        &mut self,
        m: &mut Interp,
        budget: u64,
        stats: &mut CrankStats,
    ) -> Result<(), String> {
        self.cranks_since = self.cranks_since.saturating_add(1);
        if self.due(m) || m.finalization_cleanup_pending() {
            sweep_and_notify(m, budget, stats)?;
            self.collected(m);
        }
        Ok(())
    }

    fn collected(&mut self, m: &Interp) {
        self.live_slots = m.slots().live_count();
        self.chunk_bytes = chunk_footprint(m);
        self.cranks_since = 0;
    }

    /// Before the image is written at close. Under the allocation policy
    /// the garbage of the cranks since the last collection is reclaimed, so
    /// the image holds none of it (the guarantee of "collect garbage before
    /// durable crank checkpoints", `7c8eb35860`). Only the sweep runs: the
    /// cleanups it flags are guest code with no delivery to carry their
    /// outbound, so they stay pending in the image and the engine runs
    /// them at the end of the next crank's drain, before that delivery's
    /// outbound is taken. Under every-crank nothing is left to collect.
    fn before_close(&mut self, m: &mut Interp) -> Result<(), String> {
        if matches!(self.policy, GcPolicy::Allocation { .. }) && self.cranks_since > 0 {
            m.collect_garbage()
                .map_err(|e| format!("collection before close: {e}"))?;
            self.collected(m);
        }
        Ok(())
    }
}

/// The fatal message for a crank that did not complete. Every such crank is
/// fatal: the worker reports it and exits before `checkpoint_to_store`, so
/// nothing the crank did is committed. A host failure
/// (`Halt::HostAllocationFailed`) is named apart from the program's own
/// halts because it is not one: the host must not record it as the crank's
/// outcome, but restore the last commit in a fresh worker and re-drive the
/// crank there.
fn crank_halted(halt: &ironhorse_vm::Halt) -> String {
    if halt.is_host_failure() {
        format!("host failure, crank not committed: {halt:?}; restore in a fresh worker")
    } else {
        format!("guest crank halted: {halt:?}")
    }
}

/// Reclaim the completed crank's garbage, run the cleanup callbacks the sweep
/// flagged, and sweep again while their own garbage flags more.
///
/// The sweep nulls dead `WeakRef` targets and flags the registries that held
/// them; the callbacks are guest code, so they run as a crank of their own
/// here, before this delivery's outbound is taken, rather than at the end of
/// the next crank's drain. An OCapN peer's finalizers therefore send their gc
/// frames with the delivery that freed the imports, and no image taken between
/// deliveries carries a pending cleanup. Both steps happen at points a replay
/// reaches identically. The rounds share one crank budget, armed before the
/// first, so a cascade that never ends exhausts it as a crank that never ends
/// would; and since the sweep itself is unmetered, the rounds are counted too,
/// so a cascade of callbacks too cheap to spend the budget cannot buy itself a
/// collection per round for long.
fn sweep_and_notify(m: &mut Interp, budget: u64, stats: &mut CrankStats) -> Result<(), String> {
    let mut armed = false;
    for round in 0.. {
        let started = Instant::now();
        let collected = m.collect_garbage();
        stats.collect_us += micros(started.elapsed());
        stats.collections += 1;
        collected.map_err(|e| format!("guest crank halted: {e}"))?;
        if !m.finalization_cleanup_pending() {
            return Ok(());
        }
        if round == FINALIZATION_ROUNDS {
            return Err(format!(
                "guest crank halted: finalization cascade exceeded {FINALIZATION_ROUNDS} rounds"
            ));
        }
        if !armed {
            let ceiling = (m.meter_index() >> 16).saturating_add(budget);
            m.rearm_meter(
                budget.clamp(1, 1000),
                Box::new(move |spent| spent <= ceiling),
            );
            armed = true;
        }
        let started = Instant::now();
        let outcome = m.notify_finalizations();
        stats.notify_us += micros(started.elapsed());
        if !outcome.completed {
            return Err(crank_halted(&outcome.halt));
        }
    }
    unreachable!("the round counter is unbounded")
}

/// Sweep-and-notify rounds a delivery may take before its cascade is halted.
/// An OCapN peer's finalizers free nothing registered, so a real cascade is a
/// round or two; a guest whose callbacks register the next doomed object on
/// every round is spending the host's collector, not its own budget.
const FINALIZATION_ROUNDS: u32 = 64;

// Kernel locks are released on process death. Never unlink the lock files:
// replacing their inodes would let two supervisors each hold a different lock.
fn lock_file(
    path: &std::path::Path,
    operation: rustix::fs::FlockOperation,
) -> Result<std::fs::File, String> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| format!("lock file: {e}"))?;
    rustix::fs::flock(&file, operation).map_err(|e| format!("state directory is busy: {e}"))?;
    Ok(file)
}

fn supervise_lock(state: &str) -> Result<(), String> {
    use rustix::fs::FlockOperation::{NonBlockingLockExclusive, Unlock};
    let root = std::path::Path::new(state);
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    // fd 1 is an inherited duplicate of the supervisor's open lock file.
    // flock belongs to that open-file description: the Node parent retains
    // ownership even if this helper is killed before it can report failure.
    rustix::fs::flock(rustix::stdio::stdout(), NonBlockingLockExclusive)
        .map_err(|e| format!("state directory is busy: {e}"))?;
    let heaps = root.join("heaps");
    std::fs::create_dir_all(&heaps).map_err(|e| e.to_string())?;
    // Old workers retain shared leases until they actually exit. Holding the
    // exclusive lease proves no abandoned incarnation can still be writing.
    let active_path = heaps.join("active.lock");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let active = loop {
        match lock_file(&active_path, NonBlockingLockExclusive) {
            Ok(file) => break file,
            Err(error) if std::time::Instant::now() >= deadline => return Err(error),
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(25)),
        }
    };
    // Cleanup is requested only AFTER the host validates persistent compatibility.
    eprintln!("{{\"op\":\"locked\"}}");
    io::stderr().flush().map_err(|e| e.to_string())?;
    let mut input = io::stdin().lock();
    let mut command = String::new();
    input.read_line(&mut command).map_err(|e| e.to_string())?;
    if command.trim() != "prepare" {
        return Ok(());
    }
    let work = heaps.join("incarnations");
    if work.exists() {
        std::fs::remove_dir_all(&work).map_err(|e| e.to_string())?;
    }
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    rustix::fs::flock(&active, Unlock).map_err(|e| e.to_string())?;
    eprintln!("{{\"op\":\"ready\"}}");
    io::stderr().flush().map_err(|e| e.to_string())?;
    io::copy(&mut input, &mut io::sink()).map_err(|e| e.to_string())?;
    Ok(())
}

/// JSON computron budgets are decimal strings so JS never rounds a u64.
fn positive_integer(value: &Value, name: &str) -> Result<u64, String> {
    let amount = match value {
        Value::String(text) if !text.is_empty() && text.bytes().all(|b| b.is_ascii_digit()) => {
            text.parse::<u64>().ok()
        }
        Value::Number(number) => number.as_u64(),
        _ => None,
    };
    amount
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("{name} must be a positive u64 integer"))
}

/// A request names the source to evaluate and may override the crank budget.
/// A malformed request is the client's mistake, not a VM halt: it is answered
/// with an error reply and the heap session stays open for the next request.
fn parse_request(request: &Value, crank_budget: u64) -> Result<(&str, u64), String> {
    let source = request["source"].as_str().ok_or("source required")?;
    let budget = if request["budget"].is_null() {
        crank_budget
    } else {
        positive_integer(&request["budget"], "budget")?
    };
    Ok((source, budget))
}

fn reply(stdout: &mut impl Write, message: Value) -> Result<(), String> {
    writeln!(stdout, "{message}").map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())
}

struct WorkerLimits {
    crank_budget: u64,
    bootstrap_budget: u64,
    slot_ceiling: u32,
    chunk_ceiling: u32,
    gc: GcPolicy,
}

impl WorkerLimits {
    fn parse(text: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        let slot_ceiling = u32::try_from(positive_integer(&value["slotCeiling"], "slotCeiling")?)
            .map_err(|_| "slotCeiling exceeds the u32 address space")?;
        let chunk_ceiling =
            u32::try_from(positive_integer(&value["chunkCeiling"], "chunkCeiling")?)
                .map_err(|_| "chunkCeiling exceeds the u32 address space")?;
        Ok(Self {
            crank_budget: positive_integer(&value["crankBudget"], "crankBudget")?,
            bootstrap_budget: positive_integer(&value["bootstrapBudget"], "bootstrapBudget")?,
            slot_ceiling,
            chunk_ceiling,
            gc: parse_gc_policy(&value, slot_ceiling, chunk_ceiling)?,
        })
    }

    fn apply(&self, machine: &mut Interp) -> Result<(), String> {
        machine
            .set_slot_ceiling(self.slot_ceiling)
            .map_err(|e| format!("slotCeiling refused: {e:?}"))?;
        machine
            .set_chunk_ceiling(self.chunk_ceiling as usize)
            .map_err(|e| format!("chunkCeiling refused: {e:?}"))?;
        Ok(())
    }
}

/// The collection policy a host names in the worker limits. A host that
/// names none (one older than the policy) gets every-crank, as before. Under
/// "allocation", an allowance not named is [`DEFAULT_GC_SLOT_ALLOWANCE`] or
/// [`DEFAULT_GC_CHUNK_ALLOWANCE`], never derived from a ceiling (a ceiling
/// may be raised across a restart, and the schedule must not move with it);
/// one above half its ceiling is refused.
fn parse_gc_policy(
    value: &Value,
    slot_ceiling: u32,
    chunk_ceiling: u32,
) -> Result<GcPolicy, String> {
    match &value["gcPolicy"] {
        Value::Null => Ok(GcPolicy::EveryCrank),
        Value::String(name) if name == "every-crank" => Ok(GcPolicy::EveryCrank),
        Value::String(name) if name == "allocation" => {
            let allowance = |field: &str, default: u64, ceiling: u64| -> Result<u64, String> {
                let amount = if value[field].is_null() {
                    default
                } else {
                    positive_integer(&value[field], field)?
                };
                if amount > ceiling / 2 {
                    return Err(format!("{field} must be at most half its ceiling"));
                }
                Ok(amount)
            };
            Ok(GcPolicy::Allocation {
                slots: u32::try_from(allowance(
                    "gcSlotAllowance",
                    u64::from(DEFAULT_GC_SLOT_ALLOWANCE),
                    u64::from(slot_ceiling),
                )?)
                .map_err(|_| "gcSlotAllowance exceeds the u32 address space")?,
                chunk_bytes: allowance(
                    "gcChunkAllowance",
                    DEFAULT_GC_CHUNK_ALLOWANCE,
                    u64::from(chunk_ceiling),
                )?,
            })
        }
        _ => Err("gcPolicy must be \"every-crank\" or \"allocation\"".into()),
    }
}

/// Live-slot growth between collections under the allocation policy when
/// the host names none (J-9300..J-9329: a session delivery grows the heap by
/// a few thousand slots, so a collection runs about every few dozen of
/// them).
const DEFAULT_GC_SLOT_ALLOWANCE: u32 = 1 << 17;
/// Chunk-footprint growth between collections, likewise.
const DEFAULT_GC_CHUNK_ALLOWANCE: u64 = 1 << 24;

/// Open the worker's heap. A new heap starts a session on a fresh machine;
/// an existing one is first upgraded in place to the current store schema,
/// as the daemon's opener does, since resume refuses an older schema. The
/// thixotrope host never hands a rebuilt worker an older heap (its runtime
/// profile covers the worker binary's hash, so the signature gate refuses
/// such a heap here as it would at resume); the upgrade serves a worker run
/// directly under an unchanged profile.
fn open_heap(
    path: &str,
    signature: &Signature,
    limits: &WorkerLimits,
) -> Result<(SqliteHeapStore, StoreSession, bool), String> {
    let fresh = !std::path::Path::new(path).exists();
    let mut store = SqliteHeapStore::open(path).map_err(|e| format!("open: {e:?}"))?;
    let mut session = if fresh {
        let mut machine = Interp::new();
        limits.apply(&mut machine)?;
        begin_store_session(machine, signature, &mut store)
            .map_err(|(_, e)| format!("begin: {e:?}"))?
    } else {
        migrate_store(&mut store, signature).map_err(|e| format!("migrate: {e:?}"))?;
        resume_from_store(&store, signature).map_err(|e| format!("restore: {e:?}"))?
    };
    // Arena policy is not snapshot state. Reapply it after every restoration.
    limits.apply(session.machine_mut())?;
    Ok((store, session, fresh))
}

/// Commit every crank since the heap's last checkpoint and close the file,
/// which leaves it self-contained: the host copies it as the worker's image
/// once `close` has been answered by the process's exit.
fn close_heap(
    mut session: StoreSession,
    schedule: &mut GcSchedule,
    signature: &Signature,
    mut store: SqliteHeapStore,
) -> Result<(), String> {
    schedule.before_close(session.machine_mut())?;
    checkpoint_to_store(&mut session, signature, &mut store)
        .map_err(|e| format!("checkpoint: {e:?}"))?;
    drop(session);
    store.close().map_err(|e| format!("close: {e:?}"))
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let path = args.next().ok_or(
        "usage: thixotrope-ironhorse-worker heap.sqlite profile lease limits-json [boot.js ...]",
    )?;
    if path == "--lock-state" {
        return supervise_lock(&args.next().ok_or("state directory required")?);
    }
    let profile = args.next().ok_or("runtime profile required")?;
    let active_path = args.next().ok_or("worker lease path required")?;
    let limits = WorkerLimits::parse(&args.next().ok_or("worker limits required")?)?;
    let _active = lock_file(
        std::path::Path::new(&active_path),
        rustix::fs::FlockOperation::LockShared,
    )?;
    let signature = Signature::new(&profile);
    let (mut store, mut session, fresh) = open_heap(&path, &signature, &limits)?;
    if fresh {
        for boot in args {
            let source = std::fs::read_to_string(&boot).map_err(|e| e.to_string())?;
            eval(&mut session, &source, limits.bootstrap_budget)
                .map_err(|e| format!("boot {boot}: {e}"))?;
        }
        checkpoint_to_store(&mut session, &signature, &mut store)
            .map_err(|e| format!("boot checkpoint: {e:?}"))?;
    }
    // The schedule starts from the heap as opened (or as booted).
    let mut schedule = GcSchedule::new(limits.gc, session.machine());
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    writeln!(
        stdout,
        "{}",
        json!({"op":"ready", "features":["deliver-v1"]})
    )
    .map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())?;
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        let request: Value = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                reply(
                    &mut stdout,
                    json!({"op":"error", "message":error.to_string()}),
                )?;
                continue;
            }
        };
        if request["op"] == "close" {
            break;
        }
        let (source, budget) = match parse_request(&request, limits.crank_budget) {
            Ok(parsed) => parsed,
            Err(error) => {
                reply(&mut stdout, json!({"op":"error", "message":error}))?;
                continue;
            }
        };
        let delivery = request["op"] == "deliver";
        let extraction_budget = if delivery && !request["drainBudget"].is_null() {
            match positive_integer(&request["drainBudget"], "drainBudget") {
                Ok(budget) => budget,
                Err(error) => {
                    reply(&mut stdout, json!({"op":"error", "message":error}))?;
                    continue;
                }
            }
        } else {
            limits.crank_budget
        };
        let started = Instant::now();
        let mut stats = CrankStats::default();
        let outcome = if delivery {
            crank_deliver(
                &mut session,
                &mut schedule,
                source,
                budget,
                extraction_budget,
                &mut stats,
            )
        } else {
            crank_eval(&mut session, &mut schedule, source, budget, &mut stats)
        };
        let result = match outcome {
            Ok(result) => result,
            Err(error) => {
                reply(&mut stdout, json!({"op":"fatal", "message":error}))?;
                return Err(error);
            }
        };
        // The heap is committed at close, not per crank. The host recovers
        // a worker from its last image plus its journal, never from this
        // file, so a checkpoint here bought no durability and cost a rewrite
        // of every side table a collection marked dirty.
        let mut answer = json!({"op":"result", "result":result});
        if request["timing"] == true {
            answer["timing"] =
                stats.to_json(micros(started.elapsed()), &schedule, session.machine());
        }
        reply(&mut stdout, answer)?;
    }
    close_heap(session, &mut schedule, &signature, store)
}

fn main() {
    let result = std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(run)
        .expect("worker thread")
        .join();
    match result {
        Ok(Ok(())) => {}
        other => {
            if std::env::args().nth(1).as_deref() == Some("--lock-state") {
                eprintln!(
                    "{}",
                    json!({"op": "error", "message": format!("{other:?}")})
                );
            } else {
                eprintln!("worker failed: {other:?}");
            }
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_snapshot::store::MemoryStore;

    fn test_limits() -> WorkerLimits {
        WorkerLimits::parse(r#"{"crankBudget":"100000000","bootstrapBudget":"1000000000","slotCeiling":2000000,"chunkCeiling":536870912}"#).unwrap()
    }

    /// A directory removed when the guard drops.
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_heap_dir(label: &str) -> (std::path::PathBuf, Cleanup) {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "thixotrope-worker-{label}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.clone(), Cleanup(dir))
    }

    #[test]
    fn configured_heap_above_default_survives_restore() {
        let limits = test_limits();
        let signature = Signature::new("configured-heap");
        let mut store = MemoryStore::new();
        let mut machine = Interp::new();
        limits.apply(&mut machine).unwrap();
        let mut session = begin_store_session(machine, &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        assert_eq!(
            eval(
                &mut session,
                "globalThis.kept = null; for (var i = 0; i < 350000; i++) kept = {n:i, next:kept}; kept.n",
                limits.crank_budget
            )
            .unwrap(),
            "349999"
        );
        assert!(
            session.machine_mut().slots().capacity() > ironhorse_vm::value::DEFAULT_SLOT_CEILING
        );
        checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
        drop(session);
        let mut restored = resume_from_store(&store, &signature).unwrap();
        limits.apply(restored.machine_mut()).unwrap();
        assert_eq!(
            restored.machine_mut().slots().ceiling(),
            limits.slot_ceiling
        );
        assert_eq!(
            restored.machine_mut().chunks().ceiling(),
            limits.chunk_ceiling as usize
        );
        assert_eq!(
            eval(&mut restored, "kept.n", limits.crank_budget).unwrap(),
            "349999"
        );
    }

    #[test]
    fn configured_heap_and_meter_failures_remain_distinct() {
        for heap_failure in [false, true] {
            let signature = Signature::new("configured-refusal");
            let mut store = MemoryStore::new();
            let mut session = begin_store_session(Interp::new(), &signature, &mut store)
                .map_err(|(_, error)| error)
                .unwrap();
            // Link builtins before restricting subsequent guest allocation.
            eval(&mut session, "globalThis.kept = []", 1000000).unwrap();
            let budget = if heap_failure {
                let ceiling = session.machine_mut().slots().capacity() + 100;
                session.machine_mut().set_slot_ceiling(ceiling).unwrap();
                10000000
            } else {
                1000
            };
            let error = eval(
                &mut session,
                "for (var i = 0; i < 10000; i++) kept.push({i}); kept.length",
                budget,
            )
            .unwrap_err();
            assert!(
                error.contains(if heap_failure {
                    "HeapExhausted"
                } else {
                    "MeterAbort"
                }),
                "{error}"
            );
        }
    }

    #[test]
    fn worker_limits_preserve_u64_budgets_and_validate_ceilings() {
        let limits = WorkerLimits::parse(r#"{"crankBudget":"9007199254740993","bootstrapBudget":"18446744073709551615","slotCeiling":2000000,"chunkCeiling":536870912}"#).unwrap();
        assert_eq!(limits.crank_budget, 9_007_199_254_740_993);
        assert_eq!(limits.bootstrap_budget, u64::MAX);
        assert!(positive_integer(&json!(0), "budget").is_err());
        assert!(positive_integer(&json!("18446744073709551616"), "budget").is_err());
    }

    #[test]
    fn configured_ceilings_above_consensus_limits_are_refused() {
        let mut limits = test_limits();
        limits.slot_ceiling = ironhorse_vm::CONSENSUS_MAX_SLOT_CEILING + 1;
        assert!(limits
            .apply(&mut Interp::new())
            .unwrap_err()
            .contains("slotCeiling refused"));
        limits.slot_ceiling = test_limits().slot_ceiling;
        limits.chunk_ceiling = (ironhorse_vm::CONSENSUS_MAX_CHUNK_CEILING + 1) as u32;
        assert!(limits
            .apply(&mut Interp::new())
            .unwrap_err()
            .contains("chunkCeiling refused"));
    }

    #[test]
    fn malformed_requests_are_answered_rather_than_fatal() {
        let crank_budget = 42;
        assert_eq!(
            parse_request(&json!({"op":"eval","source":"1"}), crank_budget).unwrap(),
            ("1", crank_budget)
        );
        assert_eq!(
            parse_request(
                &json!({"op":"eval","source":"1","budget":"9007199254740993"}),
                crank_budget
            )
            .unwrap(),
            ("1", 9_007_199_254_740_993)
        );
        assert_eq!(
            parse_request(&json!({"op":"eval"}), crank_budget).unwrap_err(),
            "source required"
        );
        assert_eq!(
            parse_request(&json!({"op":"eval","source":"1","budget":0}), crank_budget).unwrap_err(),
            "budget must be a positive u64 integer"
        );
        let mut out = Vec::new();
        let error = json!({"op":"error", "message":"budget must be a positive u64 integer"});
        reply(&mut out, error.clone()).unwrap();
        let text = String::from_utf8(out).unwrap();
        assert!(text.ends_with('\n') && !text.trim_end().contains('\n'));
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), error);
    }

    #[test]
    fn worker_compilation_is_charged_without_changing_script_semantics() {
        let source = "var n = 7; n";
        let signature = Signature::new("worker-compile-test");
        let mut store = MemoryStore::new();
        let mut session = begin_store_session(Interp::new(), &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        let meter = ironhorse_compile::ParseMeter::with_budget(u64::MAX);
        let (code, symbols) = ironhorse_compile::compile_atoms_goal_with_meter(
            source,
            ironhorse_compile::Goal::Script,
            false,
            meter.clone(),
        )
        .unwrap();
        let mut baseline = Interp::new();
        baseline.link_intrinsics(&parse_symbols(&symbols));
        let expected = baseline.run(&code);
        assert_eq!(
            eval(&mut session, source, 1_000_000).unwrap(),
            expected.result
        );
        assert_eq!(
            session.machine_mut().meter_index(),
            expected.meter_raw + meter.raw()
        );
    }

    /// Every incomplete crank is fatal, so none is committed; a host
    /// allocation failure says so, and is never reported as a guest halt.
    #[test]
    fn a_host_allocation_failure_is_fatal_and_named_as_the_hosts() {
        use ironhorse_vm::Halt;
        let host = crank_halted(&Halt::HostAllocationFailed);
        assert!(
            host.starts_with("host failure, crank not committed"),
            "{host}"
        );
        assert!(!host.contains("guest crank halted"), "{host}");
        assert_eq!(
            crank_halted(&Halt::HeapExhausted),
            "guest crank halted: HeapExhausted"
        );
    }

    #[test]
    fn worker_admission_refuses_before_link_or_dispatch() {
        let signature = Signature::new("worker-compile-test");
        let mut store = MemoryStore::new();
        let mut session = begin_store_session(Interp::new(), &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        let start = session.machine_mut().meter_index();
        let source = format!("/*{}*/ 1", "x".repeat(1_000_000));
        assert_eq!(
            eval(&mut session, &source, 32).unwrap_err(),
            "guest crank halted: MeterAbort during compilation"
        );
        assert_eq!(session.machine_mut().meter_index() - start, 32 << 16);
        assert!(session.machine_mut().program_symbol_names().is_empty());
    }

    /// A heap at an older store schema is upgraded in place before it
    /// resumes. The heap is written by this build and restamped as schema
    /// 35, the last schema before the commit token, whose small state is
    /// laid out as the current one.
    #[test]
    fn an_older_schema_heap_is_migrated_before_it_resumes() {
        use ironhorse_snapshot::store::{HeapStore, StoreManifest, STORE_SCHEMA_VERSION};
        let (dir, _cleanup) = temp_heap_dir("migrate");
        let path = dir.join("heap.sqlite");
        let path = path.to_str().unwrap();
        let signature = Signature::new("worker-migration-test");

        let (mut store, mut session, fresh) = open_heap(path, &signature, &test_limits()).unwrap();
        assert!(fresh);
        assert_eq!(eval(&mut session, "var n = 7; n", 1_000_000).unwrap(), "7");
        checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
        drop(session);
        let current = store.manifest().unwrap();
        let older = StoreManifest {
            store_schema: 35,
            ..current.clone()
        };
        // Schema 35 framed the 32 sections of its day: the restamped state
        // is framed as that schema framed it.
        let small = ironhorse_snapshot::store_sections::small_state_at_schema(
            &store.read_small_state().unwrap(),
            older.store_schema,
        )
        .unwrap();
        store
            .replace_for_migration(&current, &older, &small)
            .unwrap();
        store.close().unwrap();

        let (store, mut session, fresh) = open_heap(path, &signature, &test_limits()).unwrap();
        assert!(!fresh);
        assert_eq!(
            store.manifest().unwrap(),
            StoreManifest {
                store_schema: STORE_SCHEMA_VERSION,
                ..current
            }
        );
        assert_eq!(eval(&mut session, "var n; n + 1", 1_000_000).unwrap(), "8");
    }

    #[test]
    fn cranks_are_committed_at_close_and_not_before() {
        use ironhorse_snapshot::store::HeapStore;
        let (dir, _cleanup) = temp_heap_dir("close");
        let path = dir.join("heap.sqlite");
        let path = path.to_str().unwrap();
        let signature = Signature::new("worker-close-test");
        let limits = test_limits();

        // As `run` does: boot, then the one checkpoint before the serving loop.
        let (mut store, mut session, fresh) = open_heap(path, &signature, &limits).unwrap();
        assert!(fresh);
        assert_eq!(
            eval(&mut session, "var n = 0; n", limits.bootstrap_budget).unwrap(),
            "0"
        );
        checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
        let booted = store.manifest().unwrap().epoch;
        for expected in ["1", "2", "3"] {
            assert_eq!(
                eval(&mut session, "var n; n = n + 1; n", limits.crank_budget).unwrap(),
                expected
            );
        }
        // A crank commits nothing by itself: the file still holds only the boot.
        assert_eq!(store.manifest().unwrap().epoch, booted);
        let mut schedule = GcSchedule::new(GcPolicy::EveryCrank, session.machine());
        close_heap(session, &mut schedule, &signature, store).unwrap();

        let (store, mut session, fresh) = open_heap(path, &signature, &limits).unwrap();
        assert!(!fresh);
        assert!(store.manifest().unwrap().epoch > booted, "close committed");
        assert_eq!(
            eval(&mut session, "var n; n", limits.crank_budget).unwrap(),
            "3"
        );
    }

    #[test]
    fn finalizers_run_within_the_delivery_that_frees_their_targets() {
        let signature = Signature::new("worker-finalization");
        let mut store = MemoryStore::new();
        let mut session = begin_store_session(Interp::new(), &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        let budget = test_limits().crank_budget;
        eval(
            &mut session,
            "globalThis.gone = []; \
             globalThis.registry = new FinalizationRegistry(held => gone.push(held)); \
             globalThis.target = {}; registry.register(target, 'a'); 0",
            budget,
        )
        .unwrap();
        // The target dies in this crank. Its callback has not run when the
        // script reads `gone`, and has run by the time the crank is answered.
        assert_eq!(
            eval(&mut session, "target = null; gone.length", budget).unwrap(),
            "0"
        );
        assert!(!session.machine_mut().finalization_cleanup_pending());
        assert_eq!(
            eval(&mut session, "JSON.stringify(gone)", budget).unwrap(),
            "[\"a\"]"
        );
    }

    #[test]
    fn a_cleanup_cascade_is_followed_to_its_end_and_an_endless_one_is_halted() {
        let signature = Signature::new("worker-finalization-cascade");
        let mut store = MemoryStore::new();
        let mut session = begin_store_session(Interp::new(), &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        let budget = test_limits().crank_budget;
        // Each callback registers one more doomed target, five times over:
        // every round's garbage flags the next, and the rounds end.
        eval(
            &mut session,
            "globalThis.rounds = 0; \
             globalThis.registry = new FinalizationRegistry(() => { \
               rounds += 1; if (rounds < 6) registry.register({}, 0); \
             }); \
             registry.register({}, 0); 0",
            budget,
        )
        .unwrap();
        assert_eq!(eval(&mut session, "rounds", budget).unwrap(), "6");
        // A cascade without an end is halted: by the round count when its
        // callbacks are cheap, by the budget the rounds share when they are
        // not. The cascade begins in the crank that registers it.
        let cheap = eval(
            &mut session,
            "globalThis.endless = new FinalizationRegistry(() => endless.register({}, 0)); \
             endless.register({}, 0); 0",
            budget,
        )
        .unwrap_err();
        assert!(cheap.contains("finalization cascade exceeded"), "{cheap}");
    }

    #[test]
    fn a_costly_cleanup_cascade_spends_the_rounds_shared_budget() {
        let signature = Signature::new("worker-finalization-budget");
        let mut store = MemoryStore::new();
        let mut session = begin_store_session(Interp::new(), &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        // Each round burns well over the small budget's share of 64 rounds,
        // so the meter halts the cascade before the round count does.
        let costly = eval(
            &mut session,
            "globalThis.costly = new FinalizationRegistry(() => { \
               let x = 0; for (let i = 0; i < 100000; i += 1) x += i; \
               costly.register({}, x); \
             }); \
             costly.register({}, 0); 0",
            200_000,
        )
        .unwrap_err();
        assert!(
            costly.contains("guest crank halted") && !costly.contains("cascade exceeded"),
            "{costly}"
        );
    }

    fn delivery_session() -> (StoreSession, MemoryStore) {
        let signature = Signature::new("combined-delivery");
        let mut store = MemoryStore::new();
        let session = begin_store_session(Interp::new(), &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        (session, store)
    }

    const TEST_OUTBOX: &str = "globalThis.frames = []; \
        globalThis.thixotropeTakeOutbound = () => { \
          const result = frames; frames = []; return result; \
        }; 0";

    #[test]
    fn combined_delivery_includes_jobs_and_finalizer_frames_before_extracting() {
        let (mut session, _) = delivery_session();
        let budget = test_limits().crank_budget;
        eval(&mut session, TEST_OUTBOX, budget).unwrap();
        eval(
            &mut session,
            "globalThis.registry = new FinalizationRegistry(held => { \
            frames.push('final:' + held); \
            Promise.resolve().then(() => frames.push('cleanup-job')); \
          }); \
          globalThis.dispatch = () => { \
            frames.push('sync'); \
            Promise.resolve().then(() => { \
              frames.push('job'); registry.register({}, 'gone'); \
            }); \
          }; 0",
            budget,
        )
        .unwrap();
        let frames = deliver(&mut session, "dispatch()", budget, budget).unwrap();
        assert_eq!(frames, r#"["sync","job","final:gone","cleanup-job"]"#);
        assert!(!session.machine_mut().finalization_cleanup_pending());
        assert_eq!(
            eval(&mut session, "JSON.stringify(frames)", budget).unwrap(),
            "[]"
        );
    }

    #[test]
    fn combined_delivery_completes_cleanup_cascades_and_survives_restore() {
        let (mut session, mut store) = delivery_session();
        let budget = test_limits().crank_budget;
        eval(&mut session, TEST_OUTBOX, budget).unwrap();
        eval(
            &mut session,
            "globalThis.rounds = 0; \
            globalThis.registry = new FinalizationRegistry(() => { \
              rounds += 1; frames.push(rounds); \
              if (rounds < 6) registry.register({}, 0); \
            }); 0",
            budget,
        )
        .unwrap();
        assert_eq!(
            deliver(&mut session, "registry.register({}, 0)", budget, budget).unwrap(),
            "[1,2,3,4,5,6]"
        );
        assert!(!session.machine_mut().finalization_cleanup_pending());
        let signature = Signature::new("combined-delivery");
        checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
        let mut restored = resume_from_store(&store, &signature).unwrap();
        assert_eq!(
            deliver(&mut restored, "frames.push(++rounds)", budget, budget).unwrap(),
            "[7]"
        );
    }

    #[test]
    fn combined_delivery_halts_on_an_endless_cleanup_before_extracting() {
        let (mut session, _) = delivery_session();
        let budget = test_limits().crank_budget;
        eval(&mut session, TEST_OUTBOX, budget).unwrap();
        let error = deliver(
            &mut session,
            "globalThis.endless = new FinalizationRegistry(() => endless.register({}, 0)); \
             endless.register({}, 0); 0",
            budget,
            budget,
        )
        .unwrap_err();
        assert!(error.contains("finalization cascade exceeded"), "{error}");
    }

    #[test]
    fn combined_delivery_keeps_extraction_budget_separate() {
        let (mut session, _) = delivery_session();
        let budget = test_limits().crank_budget;
        eval(&mut session, TEST_OUTBOX, budget).unwrap();
        let error = deliver(&mut session, "frames.push('ready')", budget, 1).unwrap_err();
        assert!(error.contains("MeterAbort"), "{error}");
    }

    // ---- the collection schedule (C-7) ----

    use ironhorse_snapshot::{from_snapshot_bytes, MachineSnapshot};

    const GC_SIGNATURE: &str = "worker-gc-schedule";

    /// A vat that allocates garbage, registers one finalizable "import" per
    /// delivery, keeps some of them for a while, and emits a frame per
    /// delivery, per promise job and per finalized import, as an OCapN
    /// peer's `gc-exports` would.
    const GC_WORKLOAD: &str = "globalThis.frames = []; \
        globalThis.thixotropeTakeOutbound = () => { \
          const result = frames; frames = []; return result; \
        }; \
        globalThis.registry = new FinalizationRegistry(held => frames.push('gc:' + held)); \
        globalThis.kept = []; \
        globalThis.dispatch = n => { \
          const garbage = []; \
          for (let i = 0; i < (n * 7919) % 1500; i += 1) garbage.push({ i, s: 'x' + i }); \
          const target = {}; registry.register(target, n); \
          if (n % 5 === 0) kept.push(target); \
          if (n % 7 === 0 && kept.length > 0) kept.shift(); \
          frames.push('d' + n); \
          Promise.resolve().then(() => frames.push('j' + n)); \
        }; 0";

    /// The image a recovery restores: the workload installed and collected.
    fn gc_image() -> Vec<u8> {
        let (mut session, _store) = delivery_session();
        eval(&mut session, GC_WORKLOAD, test_limits().crank_budget).unwrap();
        session
            .machine()
            .write_snapshot(&Signature::new(GC_SIGNATURE))
            .unwrap()
    }

    /// A worker incarnation started from `image`, as `open_heap` starts one.
    fn gc_incarnation(image: &[u8], policy: GcPolicy) -> (StoreSession, GcSchedule) {
        let signature = Signature::new(GC_SIGNATURE);
        let machine = from_snapshot_bytes(image, &signature).unwrap();
        let session = begin_store_session(machine, &signature, &mut MemoryStore::new())
            .map_err(|(_, error)| error)
            .unwrap();
        let schedule = GcSchedule::new(policy, session.machine());
        (session, schedule)
    }

    /// Deliver `dispatch(n)` for each n, returning each delivery's outbound
    /// and how many of them collected.
    fn gc_deliver(
        session: &mut StoreSession,
        schedule: &mut GcSchedule,
        range: std::ops::RangeInclusive<u32>,
    ) -> (Vec<String>, u32) {
        let budget = test_limits().crank_budget;
        let mut collected = 0;
        let outbound = range
            .map(|n| {
                let mut stats = CrankStats::default();
                let out = crank_deliver(
                    session,
                    schedule,
                    &format!("dispatch({n})"),
                    budget,
                    budget,
                    &mut stats,
                )
                .unwrap();
                collected += u32::from(stats.collections > 0);
                out
            })
            .collect();
        (outbound, collected)
    }

    /// The image `close` writes, as bytes: the content the heap digest of
    /// the next checkpoint covers.
    fn gc_close(mut session: StoreSession, schedule: &mut GcSchedule) -> Vec<u8> {
        schedule.before_close(session.machine_mut()).unwrap();
        session
            .machine()
            .write_snapshot(&Signature::new(GC_SIGNATURE))
            .unwrap()
    }

    fn small_allowance() -> GcPolicy {
        GcPolicy::Allocation {
            slots: 20_000,
            chunk_bytes: 1 << 20,
        }
    }

    /// Kill points drawn from a fixed seed, so a failure reproduces.
    fn kill_points(seed: u64, count: usize, last: u32) -> Vec<u32> {
        let mut state = seed;
        (0..count)
            .map(|_| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                1 + ((state >> 33) % u64::from(last - 1)) as u32
            })
            .collect()
    }

    /// Recovery restores the last image and replays the journal: a worker
    /// killed at any point and replayed from the image emits byte-identical
    /// outbound, delivery by delivery, and closes to a byte-identical image.
    #[test]
    fn the_allocation_schedule_replays_byte_identically_after_a_kill() {
        const N: u32 = 120;
        let image = gc_image();
        let (mut session, mut schedule) = gc_incarnation(&image, small_allowance());
        let (reference, collected) = gc_deliver(&mut session, &mut schedule, 1..=N);
        let reference_image = gc_close(session, &mut schedule);
        // The schedule skipped most collections, and some gc frames left late.
        assert!(collected > 2 && collected < N / 2, "{collected} of {N}");
        for kill in kill_points(0x5eed, 6, N) {
            let (mut doomed, mut doomed_schedule) = gc_incarnation(&image, small_allowance());
            let (before_kill, _) = gc_deliver(&mut doomed, &mut doomed_schedule, 1..=kill);
            assert_eq!(
                before_kill[..],
                reference[..kill as usize],
                "kill at {kill}"
            );
            drop(doomed); // SIGKILL: nothing committed
            let (mut replay, mut replay_schedule) = gc_incarnation(&image, small_allowance());
            let (outbound, _) = gc_deliver(&mut replay, &mut replay_schedule, 1..=N);
            assert_eq!(outbound, reference, "replay after a kill at {kill}");
            assert!(
                gc_close(replay, &mut replay_schedule) == reference_image,
                "the image after a kill at {kill}"
            );
        }
    }

    /// A checkpoint is part of the vat's history: the image it writes and
    /// the journal cut are recorded together, and recovery from it replays
    /// the deliveries after it to the same outbound as the incarnation that
    /// continued from it.
    #[test]
    fn a_replay_from_a_checkpoint_matches_the_incarnation_that_continued() {
        const N: u32 = 90;
        let image = gc_image();
        for cut in kill_points(0xc0ffee, 4, N) {
            let (mut first, mut first_schedule) = gc_incarnation(&image, small_allowance());
            gc_deliver(&mut first, &mut first_schedule, 1..=cut);
            let checkpoint = gc_close(first, &mut first_schedule);
            let (mut continued, mut continued_schedule) =
                gc_incarnation(&checkpoint, small_allowance());
            let (after, _) = gc_deliver(&mut continued, &mut continued_schedule, cut + 1..=N);
            let continued_image = gc_close(continued, &mut continued_schedule);
            let kill = cut + (N - cut) / 2;
            let (mut doomed, mut doomed_schedule) = gc_incarnation(&checkpoint, small_allowance());
            gc_deliver(&mut doomed, &mut doomed_schedule, cut + 1..=kill);
            drop(doomed);
            let (mut replay, mut replay_schedule) = gc_incarnation(&checkpoint, small_allowance());
            let (replayed, _) = gc_deliver(&mut replay, &mut replay_schedule, cut + 1..=N);
            assert_eq!(replayed, after, "checkpoint at {cut}");
            assert!(gc_close(replay, &mut replay_schedule) == continued_image);
        }
    }

    /// The gc frames of every finalized import, by delivery.
    fn gc_frames(outbound: &[String]) -> Vec<(usize, u32)> {
        outbound
            .iter()
            .enumerate()
            .flat_map(|(index, frames)| {
                serde_json::from_str::<Vec<Value>>(frames)
                    .unwrap()
                    .into_iter()
                    .filter_map(move |frame| {
                        frame
                            .as_str()
                            .and_then(|f| f.strip_prefix("gc:"))
                            .map(|n| (index, n.parse().unwrap()))
                    })
            })
            .collect()
    }

    /// The frames that are not gc frames, in order.
    fn plain_frames(outbound: &[String]) -> Vec<String> {
        outbound
            .iter()
            .flat_map(|frames| serde_json::from_str::<Vec<Value>>(frames).unwrap())
            .filter_map(|frame| frame.as_str().map(str::to_owned))
            .filter(|frame| !frame.starts_with("gc:"))
            .collect()
    }

    /// Finalizers still run, later than every crank would run them, and
    /// exactly once each, across a checkpoint as well; the vat's other
    /// output and its computron accounting do not change.
    #[test]
    fn finalizers_fire_later_but_exactly_once_and_metering_is_unchanged() {
        const N: u32 = 100;
        let image = gc_image();
        let (mut old, mut old_schedule) = gc_incarnation(&image, GcPolicy::EveryCrank);
        let (old_out, old_collected) = gc_deliver(&mut old, &mut old_schedule, 1..=N);
        assert_eq!(old_collected, N);

        // Allocation policy, with a checkpoint half way: the close sweeps,
        // and the cleanups it flags run in the first delivery after it.
        let (mut new, mut new_schedule) = gc_incarnation(&image, small_allowance());
        let (mut new_out, _) = gc_deliver(&mut new, &mut new_schedule, 1..=N / 2);
        let checkpoint = gc_close(new, &mut new_schedule);
        let (mut resumed, mut resumed_schedule) = gc_incarnation(&checkpoint, small_allowance());
        assert!(resumed.machine().finalization_cleanup_pending());
        let (rest, _) = gc_deliver(&mut resumed, &mut resumed_schedule, N / 2 + 1..=N);
        new_out.extend(rest);
        // Same plain output, in the same order.
        assert_eq!(plain_frames(&new_out), plain_frames(&old_out));
        // Computrons: the deliveries' own work costs the same (see
        // `metering_is_unchanged_when_no_finalizer_runs`). The 100 cleanup
        // callbacks run in other runs (inside a later crank's drain, or in
        // fewer notification runs), and only that run overhead differs:
        // 9,656 raw units here (0.15 computron), measured, not a contract.
        let (old_meter, new_meter) = (
            old.machine_mut().meter_index(),
            resumed.machine_mut().meter_index(),
        );
        assert!(old_meter.abs_diff(new_meter) < 1 << 16);

        // Flush both with one collecting delivery each; then every import
        // that died has been finalized exactly once under both policies.
        let flush = |session: &mut StoreSession| {
            let budget = test_limits().crank_budget;
            deliver(session, "kept = []; 0", budget, budget).unwrap()
        };
        let mut old_all = old_out.clone();
        old_all.push(flush(&mut old));
        let mut new_all = new_out.clone();
        new_all.push(flush(&mut resumed));
        let mut old_gc: Vec<u32> = gc_frames(&old_all).into_iter().map(|(_, n)| n).collect();
        let mut new_gc: Vec<u32> = gc_frames(&new_all).into_iter().map(|(_, n)| n).collect();
        old_gc.sort_unstable();
        new_gc.sort_unstable();
        let mut unique = new_gc.clone();
        unique.dedup();
        assert_eq!(unique, new_gc, "no import is finalized twice");
        assert_eq!(new_gc, old_gc);
        assert_eq!(new_gc, (1..=N).collect::<Vec<_>>());
        // And later: each import's frame leaves no earlier than under the
        // every-crank schedule, and some leave later.
        let when = |frames: Vec<(usize, u32)>| {
            frames
                .into_iter()
                .map(|(index, n)| (n, index))
                .collect::<std::collections::BTreeMap<_, _>>()
        };
        let (old_when, new_when) = (when(gc_frames(&old_all)), when(gc_frames(&new_all)));
        assert!(old_when.iter().all(|(n, index)| new_when[n] >= *index));
        assert!(old_when.iter().any(|(n, index)| new_when[n] > *index));
    }

    /// A crank under the allocation policy starts with less than the
    /// allowance of uncollected growth, so a vat whose cranks each allocate
    /// heavily within the allowance stays under any ceiling that every-crank
    /// collection fits with the allowance to spare: its slot high-water mark
    /// is at most live heap plus allowance plus one crank.
    #[test]
    fn heavy_allocation_within_the_allowance_stays_under_the_ceiling() {
        let budget = test_limits().crank_budget;
        let (mut session, _store) = delivery_session();
        eval(&mut session, TEST_OUTBOX, budget).unwrap();
        eval(
            &mut session,
            "globalThis.kept = []; \
             globalThis.churn = n => { \
               const garbage = []; \
               for (let i = 0; i < n; i += 1) garbage.push({ i }); \
               kept.push({ n }); \
               return kept.length; \
             }; 0",
            budget,
        )
        .unwrap();
        let live = session.machine().slots().live_count();
        let crank = 10_000u32; // slots one churn(2000) allocates, with room
        let allowance = 40_000u32;
        // Every-crank survives at live + one crank; the allocation policy
        // needs the allowance on top.
        let ceiling = live + allowance + crank;
        for policy in [
            GcPolicy::EveryCrank,
            GcPolicy::Allocation {
                slots: allowance,
                chunk_bytes: 1 << 24,
            },
        ] {
            let image = session
                .machine()
                .write_snapshot(&Signature::new(GC_SIGNATURE))
                .unwrap();
            let (mut vat, mut schedule) = gc_incarnation(&image, policy);
            vat.machine_mut().set_slot_ceiling(ceiling).unwrap();
            let mut collections = 0;
            let mut high_water = 0;
            for _ in 0..200 {
                let mut stats = CrankStats::default();
                crank_deliver(
                    &mut vat,
                    &mut schedule,
                    "churn(2000)",
                    budget,
                    budget,
                    &mut stats,
                )
                .unwrap_or_else(|error| panic!("{policy:?}: {error}"));
                collections += u32::from(stats.collections > 0);
                let m = vat.machine();
                high_water = high_water.max(m.slots().capacity());
                // The next crank starts with less than the allowance of
                // uncollected growth.
                assert!(
                    m.slots().live_count() - schedule.live_slots < allowance,
                    "{policy:?}"
                );
            }
            assert!(
                high_water <= ceiling,
                "{policy:?}: {high_water} > {ceiling}"
            );
            if matches!(policy, GcPolicy::Allocation { .. }) {
                assert!(collections < 200 / 2, "{collections} collections");
            }
        }
    }

    /// The cranks' own computrons do not depend on the schedule: the same
    /// deliveries, with no finalizer to run, end at the same meter index
    /// under both policies, with a checkpoint in between or not.
    #[test]
    fn metering_is_unchanged_when_no_finalizer_runs() {
        const N: u32 = 100;
        let (mut session, _store) = delivery_session();
        let budget = test_limits().crank_budget;
        eval(
            &mut session,
            &GC_WORKLOAD.replace("registry.register(target, n);", ""),
            budget,
        )
        .unwrap();
        let image = session
            .machine()
            .write_snapshot(&Signature::new(GC_SIGNATURE))
            .unwrap();
        let (mut old, mut old_schedule) = gc_incarnation(&image, GcPolicy::EveryCrank);
        let (old_out, _) = gc_deliver(&mut old, &mut old_schedule, 1..=N);
        let (mut new, mut new_schedule) = gc_incarnation(&image, small_allowance());
        let (mut new_out, collected) = gc_deliver(&mut new, &mut new_schedule, 1..=N / 2);
        let checkpoint = gc_close(new, &mut new_schedule);
        let (mut resumed, mut resumed_schedule) = gc_incarnation(&checkpoint, small_allowance());
        let (rest, more) = gc_deliver(&mut resumed, &mut resumed_schedule, N / 2 + 1..=N);
        new_out.extend(rest);
        assert!(collected + more < N / 2);
        assert_eq!(new_out, old_out);
        assert_eq!(
            resumed.machine_mut().meter_index(),
            old.machine_mut().meter_index()
        );
    }

    /// Chunk growth counts too: large strings that die in every crank are
    /// collected when they reach the chunk allowance, under a chunk ceiling
    /// of footprint plus three allowances.
    #[test]
    fn chunk_garbage_is_collected_before_the_chunk_ceiling() {
        let budget = test_limits().crank_budget;
        let (mut session, _store) = delivery_session();
        eval(&mut session, TEST_OUTBOX, budget).unwrap();
        eval(
            &mut session,
            "globalThis.big = n => { let s = 'y'; while (s.length < n) s = s + s; return s.length; }; 0",
            budget,
        )
        .unwrap();
        let footprint = chunk_footprint(session.machine());
        let allowance = 8u64 << 20;
        let ceiling = usize::try_from(footprint + 3 * allowance).unwrap();
        let image = session
            .machine()
            .write_snapshot(&Signature::new(GC_SIGNATURE))
            .unwrap();
        let (mut vat, mut schedule) = gc_incarnation(
            &image,
            GcPolicy::Allocation {
                slots: 1 << 20,
                chunk_bytes: allowance,
            },
        );
        vat.machine_mut().set_chunk_ceiling(ceiling).unwrap();
        let mut collections = 0;
        for _ in 0..100 {
            let mut stats = CrankStats::default();
            crank_deliver(
                &mut vat,
                &mut schedule,
                "big(1 << 19)",
                budget,
                budget,
                &mut stats,
            )
            .unwrap();
            collections += u32::from(stats.collections > 0);
        }
        // Each crank leaves about 2 MiB of doubled strings behind.
        assert!(collections > 5 && collections < 100 / 2, "{collections}");
    }

    #[test]
    fn the_gc_policy_is_parsed_and_bounded() {
        let parse = |extra: &str| {
            WorkerLimits::parse(&format!(
                r#"{{"crankBudget":"1","bootstrapBudget":"1","slotCeiling":1600000,"chunkCeiling":1600000{extra}}}"#
            ))
            .map(|limits| limits.gc)
        };
        assert_eq!(parse("").unwrap(), GcPolicy::EveryCrank);
        assert_eq!(
            parse(r#","gcPolicy":"every-crank""#).unwrap(),
            GcPolicy::EveryCrank
        );
        assert_eq!(
            WorkerLimits::parse(r#"{"crankBudget":"1","bootstrapBudget":"1","slotCeiling":1000000,"chunkCeiling":268435456,"gcPolicy":"allocation"}"#)
                .unwrap()
                .gc,
            GcPolicy::Allocation {
                slots: 131_072,
                chunk_bytes: 16_777_216
            }
        );
        assert_eq!(
            parse(r#","gcPolicy":"allocation","gcSlotAllowance":"5","gcChunkAllowance":7"#)
                .unwrap(),
            GcPolicy::Allocation {
                slots: 5,
                chunk_bytes: 7
            }
        );
        assert!(
            parse(r#","gcPolicy":"allocation","gcSlotAllowance":800001"#)
                .unwrap_err()
                .contains("at most half")
        );
        assert!(parse(r#","gcPolicy":"sometimes""#).is_err());
        assert!(parse(r#","gcPolicy":"allocation","gcChunkAllowance":0"#).is_err());
    }
}
