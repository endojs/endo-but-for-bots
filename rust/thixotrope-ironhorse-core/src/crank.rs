//! One crank: compile and run a source unit under the crank budget, then
//! collect and run the finalizer cascade. Nothing here commits: the caller
//! chooses when to checkpoint.

use ironhorse_snapshot::machine::StoreSession;
use ironhorse_vm::{parse_symbols, Interp};
use std::rc::Rc;

use crate::compiler::Compiler;

/// Compile and execute a source unit, including its promise jobs. The caller
/// chooses the collection boundary; outbound extraction is a trusted read that
/// allocates only unregistered bridge temporaries, reclaimed by the next crank.
pub(crate) fn run_source(
    session: &mut StoreSession,
    source: &str,
    budget: u64,
) -> Result<String, String> {
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
    let outcome = m.run(&code);
    if !outcome.completed {
        return Err(crank_halted(&outcome.halt));
    }
    Ok(outcome.result)
}

/// One crank as a request sees it: compile and run the source with its
/// promise jobs under `budget`, then collect and run the complete finalizer
/// cascade. Before the cascade's first callbacks run, the meter is rearmed
/// with a fresh ceiling of its current index plus `budget`, so the rounds
/// share one budget of their own, not what the source left of `budget`: a
/// crank can spend up to about twice `budget`.
pub fn eval(session: &mut StoreSession, source: &str, budget: u64) -> Result<String, String> {
    let result = run_source(session, source, budget)?;
    // Never collect after a halt. Recovery replays from the last image.
    sweep_and_notify(session.machine_mut(), budget)?;
    Ok(result)
}

/// One host request dispatches, drains promise jobs, collects, and runs every
/// finalizer round before taking outbound. The trusted bootstrap's outbox holds
/// only JSON-parsed frame data: reading it cannot expose guest getters or
/// register finalizers. Its temporary array/string need no second collection.
/// Keep extraction's budget distinct, as it was in the two-request protocol.
pub fn deliver(
    session: &mut StoreSession,
    source: &str,
    budget: u64,
    drain_budget: u64,
) -> Result<String, String> {
    eval(session, source, budget)?;
    run_source(
        session,
        "JSON.stringify(thixotropeTakeOutbound())",
        drain_budget,
    )
}

/// The fatal message for a crank that did not complete. Every such crank is
/// fatal: the worker reports it and exits before `checkpoint_to_store`, so
/// nothing the crank did is committed. A host failure
/// (`Halt::HostAllocationFailed`) is named apart from the program's own
/// halts because it is not one: the host must not record it as the crank's
/// outcome, but restore the last commit in a fresh worker and re-drive the
/// crank there.
pub fn crank_halted(halt: &ironhorse_vm::Halt) -> String {
    if halt.is_host_failure() {
        format!("host failure, crank not committed: {halt:?}; restore in a fresh worker")
    } else {
        format!("guest crank halted: {halt:?}")
    }
}

/// The fatal message for a crank a lazy store's failed row read unwound out
/// of: a host failure like [`crank_halted`]'s, never the program's.
pub(crate) fn store_fault_halted(fault: &ironhorse_snapshot::store::StoreError) -> String {
    format!("host failure, crank not committed: StoreFault({fault:?}); restore in a fresh worker")
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
fn sweep_and_notify(m: &mut Interp, budget: u64) -> Result<(), String> {
    let mut armed = false;
    for round in 0.. {
        m.collect_garbage()
            .map_err(|e| format!("guest crank halted: {e}"))?;
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
        let outcome = m.notify_finalizations();
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
pub const FINALIZATION_ROUNDS: u32 = 64;
