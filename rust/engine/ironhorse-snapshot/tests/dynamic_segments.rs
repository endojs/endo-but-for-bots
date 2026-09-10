//! Retained code segments (top-level cranks and the `eval` /
//! dynamic-`Function` source bridge) versus heap persistence.
//!
//! Every guest function names an owned segment and the atomic `FUNC`
//! carry serializes those buffers with function, constructor, bound
//! function, and deleted-metadata rows.

#[path = "common/compile.rs"]
mod guest_compile;
use guest_compile::compile;

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

/// The in-test source bridge: the same wiring the conformance harness
/// uses, minimal.
struct TestCompiler;
impl ironhorse_vm::SourceCompiler for TestCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
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
}

/// Without a compiler installed, `eval` halts by name before any
/// segment can exist — the wiring fact that makes the gate
/// unreachable on the daemon path.
#[test]
fn without_a_compiler_eval_halts_before_any_segment_exists() {
    let (b, n) = compile("var t = 0; t = eval('1 + 1'); t");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(!o.completed);
    assert_eq!(
        o.halt,
        ironhorse_vm::Halt::NotImplemented("eval:no-compiler"),
        "the honest no-compiler gap, not a segment"
    );
    assert!(m.live_dynamic_segment_function().is_none());
}

/// A live eval-defined function begins, resumes, and remains callable.
#[test]
fn live_eval_function_persists_from_begin() {
    let (b, n) =
        compile("var f = 0; f = eval('(function (x) { return x * 2; })'); var t = 0; t = f(4); t");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let o = m.run(&b);
    assert!(o.completed, "eval crank: {:?}", o.halt);
    assert_eq!(o.result, "8");
    assert!(
        m.live_dynamic_segment_function().is_some(),
        "the escaped function is the live segment witness"
    );
    let mut store = MemoryStore::new();
    drop(
        begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, error)| error)
            .expect("retained eval function persists"),
    );
    let mut resumed = resume_from_store(&store, &sig()).expect("resume");
    let (b2, n2) = compile("var f; var t; t = f(5); t");
    let b2 = resumed
        .machine_mut()
        .relink_crank(&b2, &n2)
        .expect("relink");
    let out = resumed.machine_mut().run(&b2);
    assert!(out.completed, "resumed eval function: {:?}", out.halt);
    assert_eq!(out.result, "10");
}

/// A crank that creates an eval function under an open session
/// checkpoints it and the next resumed crank can call it.
#[test]
fn eval_crank_checkpoints_its_retained_function() {
    let (_b0, n0) = compile("var f = 0; var t = 0; t = 1; t");
    let mut m = Interp::new();
    m.link_intrinsics(&n0);
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("a compiler alone is not a segment: clean begin");
    let (b1, n1) = compile("var f; var t; f = eval('(function () { return 7; })'); t = f(); t");
    let b1 = session
        .machine_mut()
        .relink_crank(&b1, &n1)
        .expect("relinks");
    let o = session.machine_mut().run(&b1);
    assert!(o.completed, "eval crank: {:?}", o.halt);
    assert_eq!(o.result, "7");
    assert_eq!(
        checkpoint_to_store(&mut session, &sig(), &mut store).unwrap(),
        2
    );
    drop(session);
    let mut resumed = resume_from_store(&store, &sig()).expect("resume");
    let (b2, n2) = compile("var f; var t; t = f(); t");
    let b2 = resumed
        .machine_mut()
        .relink_crank(&b2, &n2)
        .expect("relink");
    let out = resumed.machine_mut().run(&b2);
    assert!(out.completed, "resumed eval function: {:?}", out.halt);
    assert_eq!(out.result, "7");
}

/// The witness asks what the heap HOLDS: once the eval-defined
/// function is unreachable and a collection has run, the machine
/// persists again.
#[test]
fn collected_eval_function_persists_again() {
    let (b, n) = compile("var t = 0; t = (eval('(function (x) { return x + 1; })'))(1); t");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let o = m.run(&b);
    assert!(o.completed, "eval crank: {:?}", o.halt);
    assert_eq!(o.result, "2");
    // The function never escaped to a root; collect it.
    m.collect_garbage().unwrap();
    assert!(
        m.live_dynamic_segment_function().is_none(),
        "the collector pruned the dead eval function's segment entry"
    );
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("a collected eval function is no longer a hazard");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoints");
    drop(session);
    resume_from_store(&store, &sig()).expect("resumes");
}

/// Defining-crank bytecode and function metadata survive both a later
/// live crank and a checkpoint/resume boundary.
#[test]
fn cross_crank_function_reference_works_live_and_resumed() {
    let (b1, n1) = compile("var f = 0; f = function (x) { return x + 1; }; var t = 0; t = f(1); t");
    let (b2, n2) = compile("var f; var t2 = 0; t2 = f(41); t2");

    let mut live = Interp::new();
    live.link_intrinsics(&n1);
    assert!(live.run(&b1).completed);
    let b2l = live.relink_crank(&b2, &n2).expect("relink");
    let l = live.run(&b2l);
    assert!(l.completed, "live cross-crank call: {:?}", l.halt);
    assert_eq!(l.result, "42");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    assert!(session.machine_mut().run(&b1).completed);
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    drop(session);
    let mut resumed = resume_from_store(&store, &sig()).expect("resume");
    let b2r = resumed
        .machine_mut()
        .relink_crank(&b2, &n2)
        .expect("relink");
    let r = resumed.machine_mut().run(&b2r);
    assert!(r.completed, "resumed cross-crank call: {:?}", r.halt);
    assert_eq!(r.result, "42");
}
