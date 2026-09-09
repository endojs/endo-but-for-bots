//! G3 carry, `error_data` row: an Error instance's rendering metadata
//! (`name` + optional `message`) PERSISTS across a suspend/resume, so
//! a resumed machine renders a held error exactly as an uninterrupted
//! one — retiring the `PendingStateUnsupported("error data")` refusal
//! that stood in for the atom (wave-6 W6-9).
//!
//! Every arm is an uninterrupted-vs-resumed TWIN (the
//! `side_table_ledger.rs` discipline): the same cranks run on one
//! continuous machine and across a checkpoint/resume split, and the
//! observations must be equal AND the real answer. The observable that
//! consults the ROW (rather than the slot chain) is the crank ABORT
//! value: `throw e` renders `name` / `name: message` through
//! `error_data` — without the carry a resumed machine would render
//! the degraded `[object Object]`, and with the gate in place it
//! refuses to checkpoint at all (the red this lock was born failing).
//! Own-property reads (`e.message`) additionally pin the slot-chain
//! half of the instance across the same split.
//!
//! Crank discipline: later cranks are RELINKED (`relink_crank`), the
//! managed-lifecycle path, on both twins alike.

#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig, twin};

use common::TempDir;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
use ironhorse_snapshot::store::{validate_store, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_vm::Interp;

/// The full twin over memory and file stores; asserts the last
/// COMPLETING observation also checkpoints cleanly (restored rows
/// re-serialize).
fn assert_twin(name: &str, crank1: &str, observations: &[&str], expect: &[(bool, &str)]) {
    let mut mem = MemoryStore::new();
    let seen = twin(crank1, observations, &mut mem);
    let got: Vec<(bool, &str)> = seen
        .iter()
        .map(|(c, h, r, _)| (*c, if *c { r.as_str() } else { h.as_str() }))
        .collect();
    assert_eq!(
        got, expect,
        "the continuous observations are the real answers"
    );

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    twin(crank1, observations, &mut file);
}

#[test]
fn resumed_error_abort_renders_like_uninterrupted() {
    // The row-consulting observable: `throw e` renders `name: message`
    // through `error_data` in the abort value.
    assert_twin(
        "ih-errd-twin-abort",
        "var e = 0; var t = 0; e = new TypeError('boom'); t = 7; t",
        &["var e; var t; throw e;"],
        &[(false, "Throw(\"TypeError: boom\")")],
    );
}

#[test]
fn resumed_messageless_error_renders_bare_name() {
    // No message argument: the bare name, no colon — the row's message
    // half round-trips as ABSENT, not empty.
    assert_twin(
        "ih-errd-twin-bare",
        "var e = 0; var t = 0; e = new Error(); t = 7; t",
        &["var e; var t; throw e;"],
        &[(false, "Throw(\"Error\")")],
    );
}

#[test]
fn resumed_heap_carries_every_error_row_held() {
    // Multiple rows of different names held at once: each renders
    // under its own owner after the split, and the own `message`
    // property (slot-chain state) agrees with the row.
    assert_twin(
        "ih-errd-twin-multi",
        "var a = 0; var b = 0; var t = 0; \
         a = new RangeError('r'); b = new SyntaxError('s'); t = 7; t",
        &[
            "var a; var b; var t; t = a.message + '|' + b.message; t",
            "var a; var b; var t; throw b;",
            "var a; var b; var t; throw a;",
        ],
        &[
            (true, "r|s"),
            (false, "Throw(\"SyntaxError: s\")"),
            (false, "Throw(\"RangeError: r\")"),
        ],
    );
}

#[test]
fn resumed_machine_checkpoints_its_restored_error_rows() {
    // A resumed machine holding restored rows must checkpoint cleanly
    // — the rows re-serialize into the next commit, and the store
    // still validates.
    let mut store = MemoryStore::new();
    let (b1, n1) = compile("var e = 0; var t = 0; e = new URIError('u'); t = 7; t");
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1");
    let session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    drop(session);
    let mut session = resume_from_store(&store, &sig()).expect("resume");
    let (done, _, result, _) = crank(session.machine_mut(), "var e; var t; t = e.message; t");
    assert!(done, "observation completes");
    assert_eq!(result, "u");
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint after resume");
    validate_store(&store, &sig()).expect("post-crank store validates");
    // And the SECOND resume still renders through the re-serialized row.
    let mut session = resume_from_store(&store, &sig()).expect("second resume");
    let (done, halt, _, _) = crank(session.machine_mut(), "var e; var t; throw e;");
    assert!(!done);
    assert_eq!(halt, "Throw(\"URIError: u\")");
}

#[test]
fn blob_snapshot_carries_error_data_too() {
    // The blob verbs share the carry: suspend to container bytes,
    // rebuild, and the restored machine renders the held error exactly
    // as the continuous one.
    let (b1, n1) = compile("var e = 0; var t = 0; e = new EvalError('ev'); t = 7; t");

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous = crank(&mut cont, "var e; var t; throw e;");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (blob)");
    let bytes = m.write_snapshot(&sig()).expect("suspend with a live error");
    let mut r = from_snapshot_bytes(&bytes, &sig()).expect("rebuild");
    let resumed = crank(&mut r, "var e; var t; throw e;");
    assert_eq!(resumed, continuous, "blob twin agrees");
    assert_eq!(continuous.1, "Throw(\"EvalError: ev\")");
}

/// The `stack` accessor renders the call frames an Error captured at
/// CONSTRUCTION. Those frames cannot be rebuilt — the constructing call
/// stack is long gone by the time a resume happens — so they have to
/// travel, and before the `ESTK` atom they did not:
/// `"Error: boom\n at inner ()\n at ()"` came back as `"Error: boom"`.
/// A silent divergence on an ordinary program, and the reason the row
/// gained its own atom rather than a wider `ERRD` row: an added atom
/// keeps every older container an encoding-identical subset, where a
/// widened row would have made one undecodable.
#[test]
fn a_resumed_error_renders_its_construction_frames() {
    assert_twin(
        "ih-error-frames",
        "var e = 0; var t = 0; e.stack; \
         e = (function inner() { return new Error('boom'); })(); t = 7; t",
        &["var e; var t; e.stack; t = e.stack; t"],
        &[(true, "Error: boom\n at inner ()\n at ()")],
    );
}
