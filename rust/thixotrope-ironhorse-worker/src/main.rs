//! One process, one persistent Ironhorse heap. No XS or Endor dependency.
#![forbid(unsafe_code)]

use ironhorse_snapshot::{
    machine::{begin_store_session, checkpoint_to_store, resume_from_store, StoreSession},
    Signature,
};
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, CompiledSource, Interp, SourceCompileError, SourceCompiler};
use serde_json::{json, Value};
use std::{
    io::{self, BufRead, Write},
    rc::Rc,
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
        match ironhorse_compile::compile_atoms_budgeted_with_limit(
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
            Err(ironhorse_compile::CompileError::Parse(error)) => match error.kind {
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
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
        match ironhorse_compile::compile_atoms_units_budgeted_with_limit(
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
            Err(ironhorse_compile::CompileError::Parse(error)) => match error.kind {
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
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
        return Err(format!("guest crank halted: {:?}", outcome.halt));
    }
    // Reclaim completed-crank garbage before persisting the next heap image.
    // Collection is deterministic and runs only after a successful crank;
    // an exhausted or otherwise halted crank must remain a fatal failure.
    m.collect_garbage();
    Ok(outcome.result)
}

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

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .ok_or("usage: thixotrope-ironhorse-worker heap.sqlite [boot.js ...]")?;
    if path == "--lock-state" {
        return supervise_lock(&args.next().ok_or("state directory required")?);
    }
    let profile = args.next().ok_or("runtime profile required")?;
    let active_path = args.next().ok_or("worker lease path required")?;
    let _active = lock_file(
        std::path::Path::new(&active_path),
        rustix::fs::FlockOperation::LockShared,
    )?;
    let fresh = !std::path::Path::new(&path).exists();
    let signature = Signature::new(&profile);
    let mut store = SqliteHeapStore::open(&path).map_err(|e| format!("open: {e:?}"))?;
    let mut session = if fresh {
        begin_store_session(Interp::new(), &signature, &mut store)
            .map_err(|(_, e)| format!("begin: {e:?}"))?
    } else {
        resume_from_store(&store, &signature).map_err(|e| format!("restore: {e:?}"))?
    };
    if fresh {
        for boot in args {
            let source = std::fs::read_to_string(&boot).map_err(|e| e.to_string())?;
            eval(&mut session, &source, 1_000_000_000).map_err(|e| format!("boot {boot}: {e}"))?;
        }
        checkpoint_to_store(&mut session, &signature, &mut store)
            .map_err(|e| format!("boot checkpoint: {e:?}"))?;
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{}", json!({"op":"ready"})).map_err(|e| e.to_string())?;
    stdout.flush().map_err(|e| e.to_string())?;
    for line in stdin.lock().lines() {
        let request: Value =
            serde_json::from_str(&line.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        if request["op"] == "close" {
            break;
        }
        let source = request["source"].as_str().ok_or("source required")?;
        let result = match eval(
            &mut session,
            source,
            request["budget"].as_u64().unwrap_or(10_000_000),
        ) {
            Ok(result) => result,
            Err(error) => {
                writeln!(stdout, "{}", json!({"op":"fatal", "message":error}))
                    .map_err(|e| e.to_string())?;
                stdout.flush().map_err(|e| e.to_string())?;
                return Err(error);
            }
        };
        // No result or outbound frame escapes a crank that failed to commit.
        checkpoint_to_store(&mut session, &signature, &mut store)
            .map_err(|e| format!("checkpoint: {e:?}"))?;
        writeln!(stdout, "{}", json!({"op":"result", "result":result}))
            .map_err(|e| e.to_string())?;
        stdout.flush().map_err(|e| e.to_string())?;
    }
    drop(session);
    store.close().map_err(|e| format!("close: {e:?}"))?;
    Ok(())
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
}
