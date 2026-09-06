//! The raw-completion surface (architecture review F030): a completion
//! value the oracle harness's post-run `String(result)` cannot coerce is
//! a COMPLETION on the engine's side, with the harness's `TypeError`
//! beside it in `RunOutcome::coercion_error`; only `host_coerced` folds
//! it into the abort shape the oracle reports. Both uncoercible kinds
//! are locked here, from source, together with the fold — so a fold
//! that handled one kind and not the other, or an engine that stopped
//! recording one kind, fails by name.

use ironhorse_vm::{parse_symbols, Halt, Interp, RunOutcome};

fn run(source: &str) -> (RunOutcome, bool) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    let mut m = Interp::new();
    m.link_intrinsics(&parse_symbols(&symbols));
    let out = m.run(&bytecode);
    (out, m.is_quiescent())
}

#[test]
fn a_symbol_completion_is_a_completion_the_harness_coerces_to_a_typeerror() {
    let (out, quiescent) = run("var s = 0; s = Symbol('k'); s");
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed, "the engine's verdict is a completion");
    assert_eq!(out.result, "Symbol(k)", "the engine's own display rendering");
    assert_eq!(
        out.coercion_error.as_deref(),
        Some("TypeError: cannot coerce symbol to string")
    );
    assert!(quiescent, "and the machine is at a boundary");

    let computrons = out.computrons;
    let coerced = out.host_coerced();
    assert!(!coerced.completed);
    assert_eq!(coerced.result, "");
    assert_eq!(
        coerced.halt.thrown_rendering(),
        Some("TypeError: cannot coerce symbol to string")
    );
    assert_eq!(coerced.coercion_error, None, "folded, not duplicated");
    assert_eq!(coerced.computrons, computrons, "post-run, so unmetered");
}

#[test]
fn a_null_prototype_completion_is_a_completion_the_harness_coerces_to_a_typeerror() {
    let (out, quiescent) = run("var o = 0; o = Object.create(null); o.p = 1; o");
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed, "the engine's verdict is a completion");
    assert_eq!(out.result, "[object Object]", "the generic reference stub");
    assert_eq!(
        out.coercion_error.as_deref(),
        Some("TypeError: cannot convert object to primitive value")
    );
    assert!(quiescent, "and the machine is at a boundary");

    let computrons = out.computrons;
    let coerced = out.host_coerced();
    assert!(!coerced.completed);
    assert_eq!(coerced.result, "");
    assert_eq!(
        coerced.halt.thrown_rendering(),
        Some("TypeError: cannot convert object to primitive value")
    );
    assert_eq!(coerced.coercion_error, None, "folded, not duplicated");
    assert_eq!(coerced.computrons, computrons, "post-run, so unmetered");
}

/// The controls: an ordinary completion carries no coercion error and
/// passes through `host_coerced` untouched, and a genuine halt is a
/// halt on both surfaces.
#[test]
fn ordinary_completions_and_halts_pass_through_the_fold_unchanged() {
    let (out, quiescent) = run("var o = 0; o = { p: 1 }; o");
    assert!(out.completed && quiescent);
    assert_eq!(out.result, "[object Object]");
    assert_eq!(out.coercion_error, None, "a plain object coerces");
    let before = (out.completed, out.result.clone(), out.halt.clone(), out.computrons);
    let after = out.host_coerced();
    assert_eq!(
        before,
        (after.completed, after.result.clone(), after.halt.clone(), after.computrons)
    );

    let (out, quiescent) = run("var x = 0; throw 'boom';");
    assert!(!out.completed && !quiescent);
    assert_eq!(out.coercion_error, None, "a halt has no completion to coerce");
    assert!(matches!(out.halt, Halt::Throw { .. }));
    let before = (out.completed, out.result.clone(), out.halt.clone(), out.computrons);
    let after = out.host_coerced();
    assert_eq!(
        before,
        (after.completed, after.result.clone(), after.halt.clone(), after.computrons),
        "a halt passes through the fold untouched, message included"
    );
}

/// The documented limit of the object arm: it tests the prototype link,
/// not `ToPrimitive`. A null-prototype object carrying its own
/// `toString` is still flagged (the oracle's `String()` would succeed),
/// and the engine's verdict is unaffected either way. Pinned so a change
/// to the predicate is a deliberate edit here, not drift.
#[test]
fn the_object_arm_is_a_prototype_link_test() {
    let (out, _) = run(
        "var o = 0; o = Object.create(null); \
         o.toString = function () { return 'custom'; }; o",
    );
    assert!(out.completed);
    assert_eq!(
        out.coercion_error.as_deref(),
        Some("TypeError: cannot convert object to primitive value"),
        "the harness's approximation flags the prototype link, not the own toString"
    );
}
