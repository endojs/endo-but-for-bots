//! G3 carry, typed-array family: `ArrayBuffer` backing geometry,
//! TypedArray view state, and DataView state PERSIST across a
//! suspend/resume — retiring the `PendingStateUnsupported("typed
//! arrays")` refusal (wave-6 W6-9). The backing BYTES always traveled
//! (they live in the chunk arena, inside `BLOC`); what was missing was
//! the side-table geometry that makes them readable: without it a
//! resumed `ta[0]` answered `undefined` and `ta.length` answered
//! `undefined` — the silent plain-object degradation the gate refused.
//!
//! Every arm is an uninterrupted-vs-resumed TWIN (the
//! `error_data_carry.rs` discipline): the same cranks run on one
//! continuous machine and across a checkpoint/resume split, and the
//! observations must be equal AND the real answer.

mod common;

use common::TempDir;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    MachineSnapshot,
};
use ironhorse_snapshot::store::{validate_store, HeapStore, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Relink and run one crank, returning `(completed, halt debug, result,
/// computrons)`. The COMPUTRON count is part of the observation: a
/// resumed machine that answers correctly while charging differently
/// has still diverged, and consensus is on the count as much as the
/// value. Every twin below therefore compares metering too.
fn crank(m: &mut Interp, src: &str) -> (bool, String, String, u64) {
    let (b, n) = compile(src);
    let b = m.relink_crank(&b, &n).expect("relink");
    let o = m.run(&b);
    (o.completed, format!("{:?}", o.halt), o.result, o.computrons)
}

/// Run crank 1 and then the observation cranks uninterrupted, and the
/// same cranks across a checkpoint/resume split on `store`; assert the
/// observations agree pairwise and return the continuous ones.
fn twin(crank1: &str, observations: &[&str], store: &mut dyn HeapStore) -> Vec<(bool, String, String, u64)> {
    let (b1, n1) = compile(crank1);

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous: Vec<_> = observations.iter().map(|s| crank(&mut cont, s)).collect();

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (store)");
    let session = begin_store_session(m, &sig(), store)
        .map_err(|(_, e)| e)
        .expect("begin (a live typed array persists now)");
    drop(session);
    let mut session = resume_from_store(store, &sig()).expect("resume");
    let resumed: Vec<_> = observations
        .iter()
        .map(|s| crank(session.machine_mut(), s))
        .collect();
    assert_eq!(continuous, resumed, "resumed observes exactly as uninterrupted");
    // The resumed machine must also checkpoint cleanly — its restored
    // rows re-serialize into the next commit.
    checkpoint_to_store(&mut session, &sig(), store).expect("checkpoint after resume");
    validate_store(store, &sig()).expect("post-crank store validates");
    continuous
}

fn assert_twin(name: &str, crank1: &str, observations: &[&str], expect: &[&str]) {
    let mut mem = MemoryStore::new();
    let seen = twin(crank1, observations, &mut mem);
    for got in &seen {
        assert!(got.0, "observation completes: {:?}", got.1);
    }
    let got: Vec<&str> = seen.iter().map(|(_, _, r, _)| r.as_str()).collect();
    assert_eq!(got, expect, "the continuous observations are the real answers");

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    twin(crank1, observations, &mut file);
}

#[test]
fn resumed_typed_array_reads_like_uninterrupted() {
    // The headline honesty gap: element reads, `length`, and
    // `byteLength` after a resume.
    assert_twin(
        "ih-tarr-twin-u8",
        "var ta = 0; var i = 0; var t = 0; \
         ta = new Uint8Array(8); \
         for (i = 0; i < 8; i = i + 1) { ta[i] = i * 3; } t = 7; t",
        &["var ta; var i; var t; t = ta[0] + ':' + ta[7] + ':' + ta.length + ':' + ta.byteLength; t"],
        &["0:21:8:8"],
    );
}

#[test]
fn resumed_views_share_the_one_restored_buffer() {
    // Two views of different kinds over one buffer, at a byteOffset:
    // a post-resume write through one view reads back through the
    // other — the buffer identity (not just the bytes) round-trips.
    assert_twin(
        "ih-tarr-twin-alias",
        "var buf = 0; var a = 0; var b = 0; var t = 0; \
         buf = new ArrayBuffer(16); \
         a = new Uint32Array(buf); \
         b = new Uint8Array(buf, 4, 4); \
         a[1] = 0x01020304; t = 7; t",
        &[
            "var buf; var a; var b; var t; \
             t = b[0] + ':' + b[3] + ':' + a.length + ':' + b.byteOffset; t",
            "var buf; var a; var b; var t; \
             b[0] = 0xff; t = (a[1] >>> 0) + ':' + buf.byteLength; t",
        ],
        // Little-endian: a[1]=0x01020304 → bytes 04 03 02 01 at offset
        // 4..8; b[0]=4, b[3]=1; then b[0]=0xff → a[1]=0x010203ff.
        &["4:1:4:4", "16909311:16"],
    );
}

#[test]
fn resumed_data_view_reads_and_writes_like_uninterrupted() {
    assert_twin(
        "ih-tarr-twin-dv",
        "var buf = 0; var dv = 0; var t = 0; \
         buf = new ArrayBuffer(12); \
         dv = new DataView(buf, 4, 8); \
         dv.setInt32(0, -7, true); t = 7; t",
        &[
            "var buf; var dv; var t; \
             t = dv.getInt32(0, true) + ':' + dv.byteOffset + ':' + dv.byteLength; t",
            "var buf; var dv; var t; \
             dv.setFloat64(0, 2.5, false); t = dv.getFloat64(0, false); t",
        ],
        &["-7:4:8", "2.5"],
    );
}

#[test]
fn resumed_detached_buffer_stays_detached() {
    // The detached brand (a satellite set) rides the buffer row's
    // flags: a resumed read through a view of a detached buffer throws
    // exactly as the uninterrupted machine's does. The buffer is detached
    // through `ArrayBuffer.prototype.transfer`, the production-reachable
    // detach: the test262 `$262.detachArrayBuffer` host hook is no longer
    // part of a default machine (architecture review F143).
    let crank1 = "var ta = 0; var t = 0; \
         ta = new Uint8Array(4); ta[0] = 9; \
         ta.buffer.transfer(); t = 7; t";
    let obs = "var ta; var t; try { t = ta.subarray(0); t = 'no-throw'; } catch (e) { t = 'threw'; } t";
    assert_twin("ih-tarr-twin-detached", crank1, &[obs], &["threw"]);
}

#[test]
fn resumed_shared_buffer_keeps_its_brand() {
    // The shared brand gates Atomics: a resumed SharedArrayBuffer view
    // still accepts Atomics operations, and the stored value reads
    // back.
    assert_twin(
        "ih-tarr-twin-shared",
        "var sab = 0; var ia = 0; var t = 0; \
         sab = new SharedArrayBuffer(8); \
         ia = new Int32Array(sab); \
         Atomics.store(ia, 0, 41); t = 7; t",
        &["var sab; var ia; var t; t = Atomics.add(ia, 0, 1) + ':' + Atomics.load(ia, 0); t"],
        &["41:42"],
    );
}

#[test]
fn blob_snapshot_carries_the_family_too() {
    let (b1, n1) = compile(
        "var ta = 0; var t = 0; ta = new Int16Array(4); ta[2] = -300; t = 7; t",
    );
    let obs = "var ta; var t; t = ta[2] + ':' + ta.length; t";

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous = crank(&mut cont, obs);
    assert_eq!(continuous.2, "-300:4");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (blob)");
    let bytes = m.write_snapshot(&sig()).expect("suspend with a live typed array");
    let mut r = from_snapshot_bytes(&bytes, &sig()).expect("rebuild");
    let resumed = crank(&mut r, obs);
    assert_eq!(resumed, continuous, "blob twin agrees");
}
