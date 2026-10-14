//! The worker's crank loop without its host: `rust/thixotrope-ironhorse-worker`'s
//! `Compiler`, `eval` and `crank_halted` copied verbatim from `main.rs` (kept
//! in sync by hand until the core crate of the design's §3 gives both shells
//! one copy), with the session held in a thread-local instead of a process,
//! and the heap behind a [`DoStore`] instead of a file. What `main.rs` does
//! with threads, `flock`, paths and NDJSON is the host shell's business and
//! is absent here.

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_store_session_with_tokens, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    resume_from_store_lazy, StoreSession,
};
use ironhorse_snapshot::store::{
    export_to_container, CommitToken, CommitTokenSource, HeapStore, StoreError,
};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, CompiledSource, Interp, SourceCompileError, SourceCompiler};

use crate::store::DoStore;

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

fn eval(session: &mut StoreSession, source: &str, budget: u64) -> Result<String, String> {
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

/// Commit tokens from the host's randomness: the embedder's
/// `CommitTokenSource`. The engine's default, `RandomTokens`, refuses on
/// `wasm32-unknown-unknown`, where std has no clock and keys its hashers from
/// addresses that repeat from run to run (`ironhorse-snapshot/src/store.rs`);
/// on WASI it works, but a worker's tokens should come from the host's
/// randomness on every target, so every session the spike owns draws from
/// here.
struct HostTokens;

impl CommitTokenSource for HostTokens {
    fn next_token(&mut self) -> Result<CommitToken, StoreError> {
        let mut token = [0u8; 16];
        crate::host::random(&mut token);
        Ok(CommitToken(token))
    }
}

pub struct Session {
    store: Rc<RefCell<DoStore>>,
    session: StoreSession,
    signature: Signature,
}

thread_local! {
    static SESSION: RefCell<Option<Session>> = const { RefCell::new(None) };
}

pub struct Ceilings {
    pub slots: u32,
    pub chunk_bytes: usize,
}

/// Set the host's ceilings; under `consensus` the engine refuses one that some
/// target cannot honor, and the refusal is the embedder's error.
fn apply_ceilings(interp: &mut Interp, ceilings: &Ceilings) -> Result<(), String> {
    if ceilings.slots > 0 {
        interp
            .set_slot_ceiling(ceilings.slots)
            .map_err(|error| format!("slot ceiling: {error:?}"))?;
    }
    if ceilings.chunk_bytes > 0 {
        interp
            .set_chunk_ceiling(ceilings.chunk_bytes)
            .map_err(|error| format!("chunk ceiling: {error:?}"))?;
    }
    Ok(())
}

fn install(mut session: Session) {
    session.session.set_token_source(Box::new(HostTokens));
    SESSION.with(|slot| *slot.borrow_mut() = Some(session));
}

/// A fresh machine bound to an empty store (the worker's first boot).
pub fn begin(store: DoStore, profile: &str, ceilings: &Ceilings) -> Result<(), String> {
    let signature = Signature::new(profile);
    let mut interp = Interp::new();
    apply_ceilings(&mut interp, ceilings)?;
    let store = Rc::new(RefCell::new(store));
    let session = begin_store_session_with_tokens(
        interp,
        &signature,
        &mut *store.borrow_mut(),
        0,
        Box::new(HostTokens),
    )
    .map_err(|(_, error)| format!("begin: {error:?}"))?;
    install(Session {
        store,
        session,
        signature,
    });
    Ok(())
}

/// Wake a stored machine, lazily (rows fault on demand) or eagerly.
pub fn resume(
    store: DoStore,
    lazy: bool,
    profile: &str,
    ceilings: &Ceilings,
) -> Result<(), String> {
    let signature = Signature::new(profile);
    // A ceiling under the heap's committed geometry would halt the next
    // crank's first allocation as the guest's `HeapExhausted`; it is the
    // host's misconfiguration, so it is refused here instead.
    let manifest = store
        .manifest()
        .map_err(|error| format!("resume: manifest: {error:?}"))?;
    if ceilings.slots > 0 && ceilings.slots < manifest.slot_count {
        return Err(format!(
            "resume: a slot ceiling of {} is under the heap's {} slots",
            ceilings.slots, manifest.slot_count
        ));
    }
    if ceilings.chunk_bytes > 0 && (ceilings.chunk_bytes as u64) < manifest.chunk_len {
        return Err(format!(
            "resume: a chunk ceiling of {} bytes is under the heap's {}",
            ceilings.chunk_bytes, manifest.chunk_len
        ));
    }
    let store = Rc::new(RefCell::new(store));
    let mut session = if lazy {
        resume_from_store_lazy(store.clone(), &signature)
    } else {
        resume_from_store(&*store.borrow(), &signature)
    }
    .map_err(|error| format!("resume: {error:?}"))?;
    apply_ceilings(session.machine_mut(), ceilings)?;
    install(Session {
        store,
        session,
        signature,
    });
    Ok(())
}

fn with_session<T>(f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    SESSION.with(|slot| {
        let mut slot = slot.borrow_mut();
        let session = slot.as_mut().ok_or("no session")?;
        f(session)
    })
}

pub fn eval_crank(source: &str, budget: u64) -> Result<String, String> {
    with_session(|s| eval(&mut s.session, source, budget))
}

/// Commit the dirty rows; answers the new epoch.
pub fn checkpoint() -> Result<u64, String> {
    with_session(|s| {
        checkpoint_to_store(&mut s.session, &s.signature, &mut *s.store.borrow_mut())
            .map_err(|error| format!("checkpoint: {error:?}"))
    })
}

/// Residency and progress, as one JSON object.
pub fn stats() -> Result<String, String> {
    with_session(|s| {
        let m = s.session.machine();
        let manifest = s
            .store
            .borrow()
            .manifest()
            .map_err(|error| format!("manifest: {error:?}"))?;
        Ok(format!(
            "{{\"epoch\":{},\"cranks\":{},\"meter\":{},\"resident_pages\":{},\"total_pages\":{},\"fully_resident\":{},\"slot_count\":{},\"chunk_len\":{}}}",
            s.session.epoch(),
            s.session.cranks(),
            m.meter_index(),
            m.slots().resident_page_count(),
            ironhorse_snapshot::store::slot_page_count(manifest.slot_count),
            m.slots().is_fully_resident(),
            manifest.slot_count,
            manifest.chunk_len
        ))
    })
}

pub fn drop_session() -> bool {
    SESSION.with(|slot| slot.borrow_mut().take().is_some())
}

/// Seed a store from canonical container bytes under `profile`: restore the
/// machine from the container, then begin a session over it with the host's
/// token source, which writes the epoch-1 full commit. (`import_from_container`
/// draws its token from `RandomTokens`, which refuses on
/// `wasm32-unknown-unknown`; this is the route its docs name.) The session is
/// dropped: the caller resumes from the seeded store to measure a wake.
pub fn import(store: &mut DoStore, bytes: &[u8], profile: &str) -> Result<(), String> {
    let signature = Signature::new(profile);
    let interp = from_snapshot_bytes(bytes, &signature)
        .map_err(|error| format!("import: restore: {error:?}"))?;
    begin_store_session_with_tokens(interp, &signature, store, 0, Box::new(HostTokens))
        .map_err(|(_, error)| format!("import: begin: {error:?}"))?;
    Ok(())
}

pub fn export(store: &DoStore) -> Result<Vec<u8>, String> {
    export_to_container(store).map_err(|error| format!("export: {error:?}"))
}
