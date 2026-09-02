//! Error constructors materialize their own properties UNCONDITIONALLY.
//!
//! XS's key table is machine-global: `fxNewNameC(the, "message")`
//! resolves whether or not the running program ever names the string,
//! so `new TypeError('boom')` ALWAYS sets the own `message` property
//! (likewise AggregateError's `errors` and SuppressedError's
//! `error`/`suppressed`). ironhorse looked the names up in
//! `symbol_ids` and SKIPPED the property when the constructing crank
//! never compiled the name — invisible to the single-crank oracle
//! (reading `.message` in source interns the name as a side effect of
//! compiling), visible the moment a LATER crank reads what an earlier
//! crank constructed. The constructors now intern the key exactly as
//! XS resolves it — unmetered, the boot-key path, so the calibrated
//! construct constants are untouched.

use ironhorse_vm::{parse_symbols, Interp};

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// Run crank 1, then a relinked crank 2, and return crank 2's
/// completion value. Crank 1 deliberately never names the property
/// crank 2 reads.
fn cross_crank(crank1: &str, crank2: &str) -> String {
    let (b1, n1) = compile(crank1);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o1 = m.run(&b1);
    assert!(o1.completed, "crank 1: {:?}", o1.halt);
    let (b2, n2) = compile(crank2);
    let b2 = m.relink_crank(&b2, &n2).expect("relink");
    let o2 = m.run(&b2);
    assert!(o2.completed, "crank 2: {:?}", o2.halt);
    o2.result
}

#[test]
fn error_message_is_own_even_when_the_crank_never_names_it() {
    assert_eq!(
        cross_crank(
            "var e = 0; var t = 0; e = new TypeError('boom'); t = 7; t",
            "var e; var t; t = e.message + ':' + (e.hasOwnProperty('message') ? 'own' : 'inherited'); t",
        ),
        "boom:own"
    );
}

#[test]
fn aggregate_error_errors_and_message_are_own_across_cranks() {
    assert_eq!(
        cross_crank(
            "var a = 0; var t = 0; a = new AggregateError([1, 2], 'agg'); t = 7; t",
            "var a; var t; t = a.errors.length + ':' + a.errors[1] + ':' + a.message; t",
        ),
        "2:2:agg"
    );
}

#[test]
fn suppressed_error_fields_are_own_across_cranks() {
    assert_eq!(
        cross_crank(
            "var s = 0; var t = 0; s = new SuppressedError(1, 2, 'sup'); t = 7; t",
            "var s; var t; t = s.error + ':' + s.suppressed + ':' + s.message; t",
        ),
        "1:2:sup"
    );
}

/// Control: the single-crank shape the oracle already covers keeps
/// working (the name is compiled into the crank, so the old lookup
/// found it too).
#[test]
fn same_crank_message_still_reads() {
    let (b, n) = compile("var e = 0; var t = 0; e = new RangeError('r'); t = e.message; t");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(o.completed, "crank: {:?}", o.halt);
    assert_eq!(o.result, "r");
}
