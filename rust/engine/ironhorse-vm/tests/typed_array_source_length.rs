//! Review wave 5: `new TA(source)` must bound the SOURCE LENGTH before it
//! materializes anything.
//!
//! The constructor used to collect `0..source.length` into a `Vec<Slot>`
//! and sanity-check the length *afterwards*, which made a declared length
//! an unmetered allocation instruction — 32 bytes of reservation per
//! declared element, charged to nobody. A sparse source is the cheap way
//! to declare one: `new Array(n)` is a single call from guest source, and
//! a snapshot row is another (a sparse array is ordinary JS state, so no
//! decoder can refuse it — see `ironhorse-snapshot`'s
//! `decode_rejects_items_outside_the_declared_length`, which bounds the
//! items and deliberately does not bound the length).
//!
//! What that costs depends on the host, and both outcomes are bad: where
//! the reservation fails, `handle_alloc_error` ABORTS THE PROCESS — not a
//! panic `catch_unwind` can contain; where overcommit lets it succeed, the
//! worker stalls for minutes filling slots the meter never sees. Measured
//! on the mutant below: 132 seconds and 8.6 GB for a two-call program.
//! So the lock is a DEADLINE, which names either outcome as a failure.
//!
//! These run on ironhorse alone (`ironhorse-compile` + the interpreter),
//! so the suite needs no XS oracle; the from-source *result* agreement
//! with XS is gated separately in `ironhorse-262`.

use std::sync::mpsc::{channel, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use ironhorse_vm::{run_program_with_symbols, Halt, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn completes_with(source: &str, expected: &str) {
    let out = run(source);
    assert!(out.completed, "`{source}` must complete (halt: {:?})", out.halt);
    assert_eq!(out.result, expected, "`{source}`");
}

#[test]
fn an_over_long_source_is_refused_before_it_is_materialized() {
    // A Float64 view caps at `0x7FFF_FFFF >> 3` = 268_435_455 elements,
    // so this is one past the cap: the bound refuses and nothing is
    // allocated, in well under a millisecond. Ordered the old way the
    // reservation came first — 268_435_456 * 32 bytes = 8.6 GB — and the
    // program either died there or spent two minutes filling it.
    let (tx, rx) = channel();
    let probe = thread::spawn(move || {
        let out = run("new Float64Array(new Array(268435456))");
        // Render inside the thread; the assertion needs no more than this.
        let _ = tx.send((out.completed, out.halt));
    });
    match rx.recv_timeout(Duration::from_secs(20)) {
        Ok((completed, halt)) => {
            assert!(!completed, "an over-long source must not construct");
            assert_eq!(
                halt,
                Halt::Unsupported("native-call:TypedArray:bad-length"),
                "and must name the length as the reason"
            );
            probe.join().expect("probe thread");
        }
        Err(RecvTimeoutError::Timeout) => panic!(
            "the constructor did not answer within 20s — the length bound is \
             back below the element collect, so a declared length is again an \
             unmetered allocation"
        ),
        Err(RecvTimeoutError::Disconnected) => panic!("probe thread died"),
    }
}

#[test]
fn a_sparse_source_within_bounds_reads_its_holes_as_undefined() {
    // The fix streams elements into the destination instead of collecting
    // them first, so pin the hole semantics it has to preserve: a missing
    // item reads `undefined`, which is 0 in an integer view and NaN in a
    // floating-point one. The declared length — not the item count — is
    // what the destination gets.
    completes_with("var a = new Array(4); a[1] = 5; new Uint8Array(a).length", "4");
    completes_with("var a = new Array(4); a[1] = 5; new Uint8Array(a)[0]", "0");
    completes_with("var a = new Array(4); a[1] = 5; new Uint8Array(a)[1]", "5");
    completes_with("var a = new Array(4); a[1] = 5; new Float64Array(a)[0]", "NaN");
}

#[test]
fn a_dense_array_and_a_source_view_still_copy() {
    // The restructuring rewrote both source arms; keep each one covered
    // here so a regression names itself without the oracle.
    completes_with("new Uint8Array([1, 2, 3])[2]", "3");
    completes_with("var a = new Uint8Array([5, 6, 7]); new Int32Array(a)[1]", "6");
    completes_with("new Uint8Array([]).length", "0");
}
