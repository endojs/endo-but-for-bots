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
    ) -> Result<CompiledSource, SourceCompileError> {
        ironhorse_compile::compile_atoms_with(source, strict)
            .map(|(bytecode, symbols)| CompiledSource { bytecode, symbols })
            .map_err(|e| match e.kind {
                ironhorse_compile::ParseErrorKind::Unsupported => {
                    SourceCompileError::Unsupported(e.to_string())
                }
                _ => SourceCompileError::Syntax(e.message),
            })
    }
}

fn eval(session: &mut StoreSession, source: &str, budget: u64) -> Result<String, String> {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).map_err(|e| e.to_string())?;
    let names = parse_symbols(&symbols);
    let m = session.machine_mut();
    m.set_source_compiler(Rc::new(Compiler));
    let code = if m.program_symbol_names().is_empty() {
        m.link_intrinsics(&names);
        code
    } else {
        m.relink_crank(&code, &names)
            .map_err(|e| format!("relink: {e:?}"))?
    };
    let ceiling = (m.meter_index() >> 16).saturating_add(budget);
    m.rearm_meter(1000, Box::new(move |spent| spent <= ceiling));
    let outcome = m.run(&code);
    if !outcome.completed {
        return Err(format!("guest crank halted: {:?}", outcome.halt));
    }
    Ok(outcome.result)
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .ok_or("usage: thixotrope-ironhorse-worker heap.sqlite [boot.js ...]")?;
    let fresh = !std::path::Path::new(&path).exists();
    let signature = Signature::new("thixotrope-ironhorse-v1");
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
            eprintln!("worker failed: {other:?}");
            std::process::exit(1);
        }
    }
}
