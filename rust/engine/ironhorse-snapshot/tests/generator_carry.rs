//! Synchronous generator activations persist (`GENR`, schema 21 /
//! format 10): a suspended generator's saved frame — locals, arguments,
//! the value-stack slice, live handlers, and the resume pc — travels,
//! so a resumed `it.next()` CONTINUES the walk exactly where the
//! uninterrupted machine's would. The WIP commit that landed the
//! wiring named its own gap ("tests and golden pins still
//! outstanding"); the pins landed next, and these are the tests: every
//! arm is an uninterrupted-vs-resumed TWIN in the carry-suite
//! discipline (`functions_carry.rs`, `iterator_carry.rs`), and the
//! crafted rows exercise the decode gates from the refusing side.

mod common;

use common::TempDir;

use ironhorse_snapshot::image::{read_machine, write_machine};
use ironhorse_snapshot::machine::{
    begin_store_session, from_snapshot_bytes, resume_from_store, resume_from_store_lazy,
    MachineSnapshot,
};
use ironhorse_snapshot::store::{HeapStore, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::{Signature, SnapshotError};
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

fn crank(machine: &mut Interp, source: &str) -> (bool, String, String) {
    let (bytecode, names) = compile(source);
    let bytecode = machine.relink_crank(&bytecode, &names).expect("relink");
    let outcome = machine.run(&bytecode);
    (outcome.completed, format!("{:?}", outcome.halt), outcome.result)
}

fn twin(
    first: &str,
    observations: &[&str],
    store: &mut dyn HeapStore,
) -> Vec<(bool, String, String)> {
    let (bytecode, names) = compile(first);

    let mut continuous = Interp::new();
    continuous.link_intrinsics(&names);
    assert!(continuous.run(&bytecode).completed);
    let expected: Vec<_> = observations
        .iter()
        .map(|source| crank(&mut continuous, source))
        .collect();

    let mut suspended = Interp::new();
    suspended.link_intrinsics(&names);
    assert!(suspended.run(&bytecode).completed);
    drop(
        begin_store_session(suspended, &sig(), store)
            .map_err(|(_, error)| error)
            .expect("a suspended generator is carried state now, not a refusal"),
    );
    let mut resumed = resume_from_store(store, &sig()).expect("resume");
    let actual: Vec<_> = observations
        .iter()
        .map(|source| crank(resumed.machine_mut(), source))
        .collect();
    assert_eq!(actual, expected, "resumed generator walks exactly as uninterrupted");
    expected
}

fn assert_memory_and_file(name: &str, first: &str, observations: &[&str], expected: &[&str]) {
    let mut memory = MemoryStore::new();
    let seen = twin(first, observations, &mut memory);
    for got in &seen {
        assert!(got.0, "observation completes: {:?}", got.1);
    }
    assert_eq!(
        seen.iter().map(|(_, _, value)| value.as_str()).collect::<Vec<_>>(),
        expected,
        "the continuous observations are the real answers"
    );

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    twin(first, observations, &mut file);
}

/// The core continuation: a generator advanced mid-walk before the
/// checkpoint yields its NEXT value after resume, then completes,
/// then stays done.
#[test]
fn mid_walk_generator_continues_after_resume() {
    assert_memory_and_file(
        "ih-genr-mid-walk",
        "var it = 0; var t = 0; \
         function* g() { yield 10; yield 20; return 30; } \
         it = g(); t = it.next().value; t",
        &[
            "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t",
            "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t",
            "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t",
        ],
        &["20:false", "30:true", "undefined:true"],
    );
}

/// Locals and sent values compose across the boundary: the saved
/// frame's accumulator continues from its pre-checkpoint value, and
/// `next(v)` feeds the suspended `yield` expression after resume.
#[test]
fn generator_locals_and_sent_values_survive_resume() {
    assert_memory_and_file(
        "ih-genr-locals",
        "var it = 0; var t = 0; \
         function* g() { var acc = 0; while (true) { acc = acc + (yield acc); } } \
         it = g(); it.next(); it.next(5); t = 7; t",
        &[
            "var it; var t; t = it.next(7).value; t",
            "var it; var t; t = it.next(30).value; t",
        ],
        &["12", "42"],
    );
}

/// A generator created but never started (SuspendedStart, whose frame
/// still travels) runs its body from the top after resume.
#[test]
fn unstarted_generator_starts_after_resume() {
    assert_memory_and_file(
        "ih-genr-unstarted",
        "var it = 0; var t = 0; \
         function* g() { yield 41; } \
         it = g(); t = 7; t",
        &["var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t"],
        &["41:false"],
    );
}

/// A completed generator resumes still done — the frameless Completed
/// row round-trips.
#[test]
fn completed_generator_stays_done_after_resume() {
    assert_memory_and_file(
        "ih-genr-completed",
        "var it = 0; var t = 0; \
         function* g() { return 1; } \
         it = g(); it.next(); t = 7; t",
        &["var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t"],
        &["undefined:true"],
    );
}

/// The saved frame's live handlers travel: `it.return()` on the
/// resumed generator still runs the `finally` block armed before the
/// checkpoint.
#[test]
fn generator_return_runs_a_pre_checkpoint_finally_after_resume() {
    assert_memory_and_file(
        "ih-genr-finally",
        "var it = 0; var cleaned = 0; var t = 0; \
         function* g() { try { yield 1; yield 2; } finally { cleaned = 'ran'; } } \
         it = g(); it.next(); t = 7; t",
        &[
            "var it; var cleaned; var t; var r = 0; \
             r = it.return(9); t = r.value + ':' + r.done + ':' + cleaned; t",
        ],
        &["9:true:ran"],
    );
}

/// Two live generators over the SAME body keep independent saved
/// frames across the boundary.
#[test]
fn sibling_generators_keep_independent_frames() {
    assert_memory_and_file(
        "ih-genr-siblings",
        "var a = 0; var b = 0; var t = 0; \
         function* g(start) { var n = start; while (true) { n = n + (yield n); } } \
         a = g(100); b = g(200); a.next(); b.next(); a.next(1); t = 7; t",
        &[
            "var a; var b; var t; t = a.next(1).value + ':' + b.next(5).value; t",
        ],
        &["102:205"],
    );
}

/// The blob path carries the same rows.
#[test]
fn blob_resume_continues_a_generator() {
    let (bytecode, names) = compile(
        "var it = 0; var t = 0; \
         function* g() { yield 1; yield 2; } \
         it = g(); t = it.next().value; t",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut resumed = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    assert_eq!(
        crank(&mut resumed, "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t").2,
        "2:false"
    );
}

/// The lazy path restores the rows eagerly with the rest of the small
/// state; the continuation works before any page beyond the working
/// set faults.
#[test]
fn lazy_resume_continues_a_generator() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let (bytecode, names) = compile(
        "var it = 0; var t = 0; \
         function* g() { yield 5; yield 6; } \
         it = g(); t = it.next().value; t",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(machine, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut resumed = resume_from_store_lazy(store, &sig()).expect("lazy resume");
    assert_eq!(
        crank(
            resumed.machine_mut(),
            "var it; var t; var r = 0; r = it.next(); t = r.value + ':' + r.done; t"
        )
        .2,
        "6:false"
    );
}

/// The decode gates, from the refusing side: an Executing state byte,
/// a Completed row that still carries a frame, and a duplicated owner
/// can only be crafted — each is refused by name.
#[test]
fn malformed_generator_rows_are_refused() {
    let (bytecode, names) = compile(
        "var it = 0; var t = 0; \
         function* g() { yield 1; } \
         it = g(); t = it.next().value; t",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let image = read_machine(&bytes, &sig()).expect("read GENR");
    assert_eq!(image.generators.len(), 1, "the fixture persisted its generator row");

    let expect = |crafted: &ironhorse_snapshot::image::MachineImage, want: &'static str| {
        match from_snapshot_bytes(&write_machine(crafted), &sig()) {
            Err(SnapshotError::Corrupt(msg)) if msg == want => {}
            Err(other) => panic!("refused, but not by the named gate ({want}): {other:?}"),
            Ok(_) => panic!("crafted generator rows must not restore ({want})"),
        }
    };

    let mut executing = image.clone();
    executing.generators[0].state = 3;
    expect(&executing, "generators: invalid state");

    let mut disagreeing = image.clone();
    disagreeing.generators[0].state = 2; // Completed, but the frame stays
    expect(&disagreeing, "generators: state and frame disagree");

    let mut duplicated = image.clone();
    duplicated.generators.push(duplicated.generators[0].clone());
    expect(&duplicated, "generators: owners not strictly ascending");

    // And the honest row still restores.
    assert!(from_snapshot_bytes(&write_machine(&image), &sig()).is_ok());
}

/// The resume cursor and every saved-handler target must name an
/// INSTRUCTION START inside the owning function's own body -- not
/// merely an offset inside the code segment. A segment holds every
/// function a crank compiled, so a segment-wide bound accepts the
/// segment end, an operand byte, and a perfectly valid instruction
/// belonging to a DIFFERENT function. Each would enter dispatch at a
/// pc the generator never suspended at.
#[test]
fn generator_pcs_outside_the_owning_body_are_refused() {
    let (bytecode, names) = compile(
        "var it = 0; var t = 0; \
         function* g() { var a = 11; yield a; yield a + 1; } \
         function* h() { var b = 22; yield b; yield b + 1; } \
         it = g(); t = it.next().value; t",
    );
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let image = read_machine(&bytes, &sig()).expect("read GENR");
    assert_eq!(image.generators.len(), 1);

    let frame = image.generators[0].frame.as_ref().expect("suspended frame");
    let owner = frame.cur_func;
    let functions = &image.function_state.functions;
    let mine = functions
        .iter()
        .find(|f| f.owner == owner)
        .expect("the frame's function has a row");
    let segment = mine.segment.expect("a guest body owns a segment");
    let code = &image.function_state.segments[segment as usize];
    let body_start = mine.body_start.expect("a guest body starts somewhere");
    let body_end = body_start + mine.body_len;

    // The instruction starts of the owning body, derived exactly as
    // the gate must derive them.
    let mut starts = Vec::new();
    let mut pc = body_start as usize;
    while pc < body_end as usize {
        starts.push(pc as u64);
        pc += ironhorse_vm::instruction_len(code, pc).expect("honest body sizes");
    }
    assert!(starts.len() > 2, "the fixture body has several instructions");

    // A sibling body in the SAME segment, and one of its starts that
    // is not also a start of ours.
    let sibling = functions
        .iter()
        .find(|f| f.owner != owner && f.segment == Some(segment))
        .expect("the fixture compiled two generator bodies into one segment");
    let sibling_start = sibling.body_start.expect("sibling body starts somewhere");
    assert!(
        !starts.contains(&sibling_start),
        "the sibling body begins outside ours"
    );

    // An operand byte: the second byte of a multi-byte instruction.
    let operand = starts
        .iter()
        .find(|&&s| ironhorse_vm::instruction_len(code, s as usize).unwrap() > 1)
        .map(|&s| s + 1)
        .expect("the body has a multi-byte instruction");
    assert!(!starts.contains(&operand), "an operand byte is not a start");

    let expect = |crafted: &ironhorse_snapshot::image::MachineImage, want: &'static str| {
        match from_snapshot_bytes(&write_machine(crafted), &sig()) {
            Err(SnapshotError::Corrupt(msg)) if msg == want => {}
            Err(other) => panic!("refused, but not by the named gate ({want}): {other:?}"),
            Ok(_) => panic!("a crafted generator pc must not restore ({want})"),
        }
    };
    const CURSOR: &str = "generator frame: invalid resume cursor or scope map";
    const HANDLER: &str = "generator frame: invalid saved handler";

    for (name, pc) in [
        ("segment end", code.len() as u64),
        ("body end", body_end),
        ("operand byte", operand),
        ("a sibling body's instruction", sibling_start),
    ] {
        let mut crafted = image.clone();
        crafted.generators[0].frame.as_mut().unwrap().resume_pc = pc;
        assert!(
            matches!(
                from_snapshot_bytes(&write_machine(&crafted), &sig()),
                Err(SnapshotError::Corrupt(CURSOR))
            ),
            "resume_pc at {name} must be refused"
        );
    }

    // The saved-handler target takes the same bound. Give the frame a
    // handler whose every other field is honest.
    let mut with_handler = image.clone();
    with_handler.generators[0]
        .frame
        .as_mut()
        .unwrap()
        .jumps
        .push(ironhorse_vm::SavedJumpRow {
            target_pc: starts[1],
            stack_offset: 0,
            locals_len: frame.locals.len() as u64,
            id_map: Vec::new(),
            call_depth_offset: 0,
            env: ironhorse_vm::Slot::undefined(),
            flag: 1,
        });
    assert!(
        from_snapshot_bytes(&write_machine(&with_handler), &sig()).is_ok(),
        "the honest handler still restores"
    );
    for pc in [code.len() as u64, body_end, operand, sibling_start] {
        let mut crafted = with_handler.clone();
        crafted.generators[0].frame.as_mut().unwrap().jumps[0].target_pc = pc;
        expect(&crafted, HANDLER);
    }

    // And a handler's `id_map` is bounded by the handler's OWN
    // `locals_len` -- the length its resumed `catch` resolves against
    // -- not by the frame's current locals. A shorter `locals_len`
    // with an index in between misresolves a name on the way out.
    let mut short = with_handler.clone();
    {
        let jump = &mut short.generators[0].frame.as_mut().unwrap().jumps[0];
        jump.locals_len = 0;
        jump.id_map = vec![(1, 0)];
    }
    expect(&short, HANDLER);

    // The honest image is untouched by all of it.
    assert!(from_snapshot_bytes(&write_machine(&image), &sig()).is_ok());
}
