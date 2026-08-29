//! Multi-crank oracle locks (the wave-6 pattern-2 antidote): the same
//! crank SEQUENCE runs on one live XS machine and one relinking
//! ironhorse machine, compared per crank — results AND computrons.
//! The single-crank oracle structurally cannot see cross-crank
//! semantics; its live specimen was an error constructor's own
//! `message` property, silently skipped when the CONSTRUCTING crank
//! never compiled the name and only observable from a LATER crank.
//! That exact shape is the first lock here.
//!
//! Scope: the self-contained-crank contract — cross-crank DATA and
//! state reads, never calls of a prior crank's functions (ironhorse's
//! crank bytecode belongs to the caller; XS retains it, so such a
//! fixture diverges by design and is out of scope).

use ironhorse_262::{dual_run_cranks, Agreement};

/// Every crank completes on both engines, agrees on the result, and
/// agrees on the per-crank computron count.
fn agrees(cranks: &[&str]) {
    let runs = dual_run_cranks(cranks).expect("the XS oracle machine must start");
    assert_eq!(runs.len(), cranks.len(), "every crank ran");
    for (i, run) in runs.iter().enumerate() {
        assert_eq!(
            run.agreement,
            Agreement::BothComplete,
            "crank {i}: {run:?}"
        );
        assert!(run.is_bit_exact(), "crank {i}: {run:?}");
    }
}

#[test]
fn state_persists_across_cranks_exactly() {
    agrees(&["var x = 5; x", "x = x + 1; x", "x + 10"]);
}

#[test]
fn error_metadata_reads_across_cranks() {
    // The live specimen: crank 1 never names `message`, crank 2 reads
    // it. XS's machine-global key table always materialized the own
    // property; ironhorse skipped it until the wave-6 backlog fix
    // (`error_own_properties.rs` holds the vm-level lock; this is the
    // oracle-differential twin that the single-crank mode could not
    // express).
    agrees(&[
        "var e = 0; e = new TypeError('boom'); 0",
        "e.message + ':' + e.name",
        "e.hasOwnProperty('message') + ':' + e.hasOwnProperty('name')",
    ]);
}

#[test]
fn collections_and_arrays_read_back_across_cranks() {
    agrees(&[
        "var m = new Map(); var arr = [1, 2, 3]; var s = new Set(); \
         m.set('k', 41); s.add('x'); 0",
        "m.get('k') + arr.length + (s.has('x') ? 1 : 0) - 3",
        "arr[0] + arr[2]",
    ]);
}

#[test]
fn symbol_registry_identity_holds_across_cranks() {
    agrees(&[
        "var s1 = Symbol.for('shared'); 0",
        "var s2 = Symbol.for('shared'); s1 === s2 ? 'same' : 'different'",
    ]);
}

#[test]
fn typed_array_state_reads_back_across_cranks() {
    agrees(&[
        "var ta = new Uint8Array(4); ta[0] = 7; ta[3] = 9; 0",
        "ta[0] + ta[3] + ta.length + ta.byteLength",
    ]);
}

#[test]
fn an_aborting_crank_compares_and_stops() {
    let runs = dual_run_cranks(&[
        "var e = 0; e = new RangeError('later'); 0",
        "throw e;",
        "'never runs'",
    ])
    .expect("oracle starts");
    // The run stops AT the aborting crank: two comparisons, not three.
    assert_eq!(runs.len(), 2, "{runs:?}");
    assert_eq!(runs[0].agreement, Agreement::BothComplete);
    assert!(runs[0].is_bit_exact(), "{:?}", runs[0]);
    // Both engines abort crank 2 with the SAME rendered error (the
    // error_data render crossing the crank boundary) and the same
    // run-only computron count at the throw.
    assert_eq!(runs[1].agreement, Agreement::BothAbort, "{:?}", runs[1]);
    assert!(runs[1].error_agrees, "{:?}", runs[1]);
    assert!(runs[1].is_bit_exact(), "{:?}", runs[1]);
    assert_eq!(runs[1].oracle_error, "RangeError: later");
}
