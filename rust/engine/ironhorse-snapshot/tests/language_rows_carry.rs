//! The data-only language rows persist (store schema v11): primitive
//! wrapper boxes (`wrapper_data`, `WRAP`), compiled regular
//! expressions (`regexps`, `REGX` — the program recompiles from its
//! persisted source+flags; `lastIndex` travels), the arguments-exotic
//! brand (`ARGB` — the satellite the `Arrays` coverage note called out
//! as not traveling), and the four Temporal record tables (`TMPR`).
//! None depends on the `functions` row: every consuming method is a
//! native on a rooted prototype, so a resumed instance WORKS, not
//! merely renders.
//!
//! Every arm is an uninterrupted-vs-resumed TWIN (the
//! `error_data_carry.rs` discipline): the same cranks run on one
//! continuous machine and across a checkpoint/resume split, and the
//! observations must be equal AND the real answer. Before the carry
//! these rows were silently dropped by resume — the twins diverge, the
//! red this suite was born failing.

#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig, twin};

use common::TempDir;

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_vm::Interp;

fn assert_twin(name: &str, crank1: &str, observations: &[&str], expect: &[&str]) {
    let mut mem = MemoryStore::new();
    let seen = twin(crank1, observations, &mut mem);
    for got in &seen {
        assert!(got.0, "observation completes: {:?}", got.1);
    }
    let got: Vec<&str> = seen.iter().map(|(_, _, r, _)| r.as_str()).collect();
    assert_eq!(
        got, expect,
        "the continuous observations are the real answers"
    );

    let dir = TempDir::new(name);
    let mut file = FileStore::open(dir.join("heap.ihstore")).unwrap();
    twin(crank1, observations, &mut file);
}

#[test]
fn resumed_primitive_wrappers_unbox_like_uninterrupted() {
    assert_twin(
        "ih-lang-twin-wrap",
        "var w = 0; var s = 0; var b = 0; var q = 0; var y = 0; var t = 0; \
         w = new Number(41); s = new String('hi'); b = new Boolean(true); \
         q = Symbol('s'); y = Object(q); t = 7; t",
        &[
            "var w; var s; var b; var q; var y; var t; \
             t = (w + 1) + ':' + w.valueOf(); t",
            "var w; var s; var b; var q; var y; var t; \
             t = s.charAt(1) + ':' + (s + '!'); t",
            "var w; var s; var b; var q; var y; var t; \
             t = b.valueOf() ? 'yes' : 'no'; t",
            "var w; var s; var b; var q; var y; var t; \
             t = (y.valueOf() === q) + ':' + y.toString(); t",
        ],
        &["42:41", "i:hi!", "yes", "true:Symbol(s)"],
    );
}

#[test]
fn resumed_regexp_executes_with_its_last_index() {
    // `exec` on a global regexp advances `lastIndex`; the resumed twin
    // must CONTINUE the scan from the same position, and the compiled
    // program (recompiled from the persisted source+flags) must match
    // identically.
    assert_twin(
        "ih-lang-twin-regexp",
        "var re = 0; var t = 0; \
         re = /a(b+)c/g; re.exec('xabbc abc'); t = 7; t",
        &[
            "var re; var t; t = re.source + ':' + re.flags + ':' + re.lastIndex; t",
            "var re; var t; var m = 0; m = re.exec('xabbc abc'); t = m[1] + ':' + re.lastIndex; t",
            "var re; var t; t = re.test('zzz') + ':' + re.lastIndex; t",
        ],
        &["a(b+)c:g:5", "b:9", "false:0"],
    );
}

#[test]
fn resumed_arguments_object_keeps_its_brand() {
    assert_twin(
        "ih-lang-twin-args",
        "var a = 0; var t = 0; \
         (function () { a = arguments; })(10, 32); t = 7; t",
        &[
            // The brand's consumer is the completion-value render:
            // a branded arguments object renders `[object Arguments]`
            // where a plain array-exotic would render its join
            // (`10,32`) — the exact degradation an unbranded resume
            // produced.
            "var a; var t; a",
            "var a; var t; t = a.length + a[0] + a[1]; t",
        ],
        &["[object Arguments]", "44"],
    );
}

#[test]
fn resumed_temporal_records_answer_like_uninterrupted() {
    assert_twin(
        "ih-lang-twin-temporal",
        "var d = 0; var i = 0; var t = 0; \
         d = Temporal.Duration.from({ hours: 2, minutes: 5 }); \
         i = Temporal.Instant.fromEpochMilliseconds(86400000); t = 7; t",
        &[
            "var d; var i; var t; t = d.total('minutes'); t",
            "var d; var i; var t; t = i.epochMilliseconds + ':' + i.toString(); t",
        ],
        &["125", "86400000:1970-01-02T00:00:00Z"],
    );
}

#[test]
fn blob_snapshot_carries_the_language_rows_too() {
    let (b1, n1) = compile(
        "var w = 0; var q = 0; var y = 0; var t = 0; \
         w = new Number(6); q = Symbol('s'); y = Object(q); t = 7; t",
    );
    let obs = "var w; var q; var y; var t; \
               t = (w * 7) + ':' + (y.valueOf() === q) + ':' + y.toString(); t";

    let mut cont = Interp::new();
    cont.link_intrinsics(&n1);
    assert!(cont.run(&b1).completed, "crank 1 (continuous)");
    let continuous = crank(&mut cont, obs);
    assert_eq!(continuous.2, "42:true:Symbol(s)");

    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    assert!(m.run(&b1).completed, "crank 1 (blob)");
    let bytes = m.write_snapshot(&sig()).expect("suspend");
    let mut r = from_snapshot_bytes(&bytes, &sig()).expect("rebuild");
    let resumed = crank(&mut r, obs);
    assert_eq!(resumed, continuous, "blob twin agrees");
}
