//! Dynamic code segments (the `eval` / dynamic-`Function` source
//! bridge) versus heap persistence.
//!
//! An eval-defined function's bytecode lives in a per-realm SEGMENT
//! buffer (`Interp::code_segments`) that no snapshot carries — the
//! ledger has no segments row yet — so persisting a heap that holds a
//! live such function would resume a callable whose body is gone. On
//! the daemon path this is unreachable today (nothing installs a
//! source compiler, so `eval` halts with `Unsupported("eval:
//! no-compiler")` before any segment exists), but an embedder that
//! wires a compiler AND a store would hit it silently. The store
//! gates refuse it by name instead
//! (`StoreError::DynamicSegmentsUnsupported`), at both
//! `begin_store_session` and `checkpoint_to_store` — the same
//! refuse-before-writing, caller-rewinds contract the old intern gate
//! had — and the witness is what the heap HOLDS (a live
//! `func_segments` entry, pruned by both collectors), not whether an
//! eval ever ran (the wave-5 mint-counter lesson).

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::store::{HeapStore, MemoryStore, StoreError};
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// The in-test source bridge: the same wiring the conformance harness
/// uses, minimal.
struct TestCompiler;
impl ironhorse_vm::SourceCompiler for TestCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        match ironhorse_compile::compile_atoms_with(source, strict) {
            Ok((bytecode, symbols)) => Ok(ironhorse_vm::CompiledSource { bytecode, symbols }),
            Err(_) => Err(ironhorse_vm::SourceCompileError::Syntax(String::new())),
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
        ironhorse_vm::Halt::Unsupported("eval:no-compiler"),
        "the honest no-compiler gap, not a segment"
    );
    assert!(m.live_dynamic_segment_function().is_none());
}

/// A live eval-defined function refuses to BEGIN a store session.
#[test]
fn live_eval_function_refuses_begin() {
    let (b, n) = compile("var f = 0; f = eval('(function (x) { return x * 2; })'); var t = 0; t = f(4); t");
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
    match begin_store_session(m, &sig(), &mut store) {
        Err((_, StoreError::DynamicSegmentsUnsupported)) => {}
        Err((_, e)) => panic!("expected DynamicSegmentsUnsupported, got {e:?}"),
        Ok(_) => panic!("expected a fail-closed refusal, got a session"),
    }
}

/// A crank that runs `eval` under an OPEN session refuses at the
/// checkpoint, before anything is written — the store stands at its
/// prior epoch and the caller can rewind the crank.
#[test]
fn eval_crank_refuses_checkpoint_and_writes_nothing() {
    let (b0, n0) = compile("var f = 0; var t = 0; t = 1; t");
    let mut m = Interp::new();
    m.link_intrinsics(&n0);
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let mut store = MemoryStore::new();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("a compiler alone is not a segment: clean begin");
    let (b1, n1) = compile("var f; var t; f = eval('(function () { return 7; })'); t = f(); t");
    let b1 = session.machine_mut().relink_crank(&b1, &n1).expect("relinks");
    let o = session.machine_mut().run(&b1);
    assert!(o.completed, "eval crank: {:?}", o.halt);
    assert_eq!(o.result, "7");
    assert_eq!(
        checkpoint_to_store(&mut session, &sig(), &mut store),
        Err(StoreError::DynamicSegmentsUnsupported),
        "a live eval-defined function cannot checkpoint"
    );
    assert_eq!(store.manifest().unwrap().epoch, 1, "nothing landed");
}

/// The witness asks what the heap HOLDS: once the eval-defined
/// function is unreachable and a collection has run, the machine
/// persists again.
#[test]
fn collected_eval_function_persists_again() {
    let (b, n) = compile(
        "var t = 0; t = (eval('(function (x) { return x + 1; })'))(1); t",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    let o = m.run(&b);
    assert!(o.completed, "eval crank: {:?}", o.halt);
    assert_eq!(o.result, "2");
    // The function never escaped to a root; collect it.
    m.collect_garbage();
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

/// What cross-crank function references cost today, pinned from both
/// sides. A function defined in crank 1 and stored in a global is NOT
/// callable from crank 2 — on the LIVE machine or the resumed one —
/// because its `FuncInfo.body` is a pc into the DEFINING crank's
/// bytecode buffer, which is the caller's borrow and gone when the
/// next crank runs (and, across a suspend, `FuncInfo` itself is the
/// Pending `functions` ledger row and does not travel). The two sides
/// fail with DIFFERENT visible signatures:
///
/// - live: the call dispatches crank 1's pc into crank 2's buffer and
///   dies on malformed execution (`Unsupported` today — the hazard is
///   that nothing type-checks the pc against the buffer, so this is
///   fail-visible by LUCK of the bytes, not by construction);
/// - resumed: the restored machine has no `FuncInfo` at all, so the
///   call finds a non-callable and throws a catchable TypeError.
///
/// Both directions of the contract ("cranks are self-contained; a
/// function does not outlive its crank") are pinned here so a change
/// on either side is a deliberate flip, not a drift. The fix that
/// makes cross-crank functions REAL is the functions ledger row plus
/// crank-code retention (the segments machinery generalized), and it
/// flips this pin.
#[test]
fn cross_crank_function_reference_fails_visibly_live_and_resumed() {
    let (b1, n1) = compile("var f = 0; f = function (x) { return x + 1; }; var t = 0; t = f(1); t");
    let (b2, n2) = compile("var f; var t2 = 0; t2 = f(41); t2");

    // LIVE machine: the call dies visibly (never a silent wrong answer
    // in this fixture; see the doc comment for why this is luck).
    let mut live = Interp::new();
    live.link_intrinsics(&n1);
    assert!(live.run(&b1).completed);
    let b2l = live.relink_crank(&b2, &n2).expect("relink");
    let l = live.run(&b2l);
    assert!(
        !l.completed,
        "PIN FLIPPED (live): cross-crank calls answer now — crank code \
         retention must have landed; update this pin"
    );

    // RESUMED machine: persists (nothing refuses — the instance slot is
    // ordinary heap), resumes, and the call throws a catchable
    // TypeError (no FuncInfo).
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
    let b2r = resumed.machine_mut().relink_crank(&b2, &n2).expect("relink");
    let r = resumed.machine_mut().run(&b2r);
    assert!(
        !r.completed,
        "PIN FLIPPED (resumed): the functions ledger row must have \
         landed; update this pin and the Pending row"
    );
    assert!(
        matches!(&r.halt, ironhorse_vm::Halt::Throw(msg) if msg.contains("TypeError")),
        "the resumed divergence stays a catchable TypeError: {:?}",
        r.halt
    );
}
