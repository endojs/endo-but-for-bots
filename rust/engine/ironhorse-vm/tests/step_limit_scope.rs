//! Wave-6 W6-16: `run_bounded`'s ceiling must not latch onto every
//! later `run` on the same machine.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

#[test]
fn a_bounded_run_does_not_latch_its_ceiling_onto_later_runs() {
    let (b, n) = compile("var i = 0; for (i = 0; i < 500; i++) { i = i; } i");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let bounded = m.run_bounded(&b, 10);
    assert!(
        matches!(bounded.halt, ironhorse_vm::Halt::StepLimit(_)),
        "the bounded run hits its ceiling: {:?}",
        bounded.halt
    );
    let plain = m.run(&b);
    assert!(
        plain.completed,
        "a later PLAIN run must not inherit the bound: {:?}",
        plain.halt
    );
}

fn run_bounded(src: &str, limit: u64) -> ironhorse_vm::RunOutcome {
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    m.run_bounded(&b, limit)
}

/// A built-in's loop dispatches nothing, so the dispatch ceiling alone let a
/// bounded run walk an array-like of length 2^53 - 1 for days, or backtrack
/// a regular expression for exponential time. The work those loops charge
/// at their meter check points now counts against the same ceiling, at what
/// that many dispatches would charge.
#[test]
fn a_bounded_run_bounds_built_in_work() {
    for source in [
        "Array.prototype.includes.call({ length: 2 ** 53 - 1 }, 1)",
        "Array.prototype.join.call({ length: 2 ** 32 - 1 })",
        "new Array(2 ** 32 - 1).join()",
        "/^(a+)+$/.test('a'.repeat(30) + 'b')",
        "/(x+x+)+y/.test('x'.repeat(30))",
        "var a = []; for (var i = 0; i < 60; i++) a = [a, a]; a.flat(Infinity)",
        "var s = 'a'; for (var i = 0; i < 17; i++) s = s + s; void new RegExp(s)",
    ] {
        let out = run_bounded(source, 10_000);
        assert!(
            !out.completed && matches!(out.halt, ironhorse_vm::Halt::StepLimit(_)),
            "{source}: {:?}",
            out.halt
        );
    }
}

/// The built-in work a bounded run may do is what its ceiling's dispatches
/// would charge, so a walk well inside it still completes.
#[test]
fn built_in_work_inside_the_ceiling_completes() {
    for (source, expected) in [
        (
            "Array.prototype.includes.call({ length: 10000 }, 1)",
            "false",
        ),
        (
            "Array.prototype.join.call({ length: 10001 }).length",
            "10000",
        ),
        ("/^(a+)+$/.test('a'.repeat(6) + 'b')", "false"),
    ] {
        let out = run_bounded(source, 10_000);
        assert!(out.completed, "{source}: {:?}", out.halt);
        assert_eq!(out.result, expected, "{source}");
    }
}

/// The built-in work counts afresh for each bounded run and not at all for a
/// plain one: neither latches onto a later run on the same machine.
#[test]
fn bounded_built_in_work_does_not_latch_onto_later_runs() {
    let (walk, n) = compile("Array.prototype.includes.call({ length: 2 ** 53 - 1 }, 1)");
    let (fits, _) = compile("Array.prototype.includes.call({ length: 30000 }, 1)");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let bounded = m.run_bounded(&walk, 10_000);
    assert!(
        matches!(bounded.halt, ironhorse_vm::Halt::StepLimit(_)),
        "{:?}",
        bounded.halt
    );
    let again = m.run_bounded(&fits, 10_000);
    assert!(again.completed, "a fresh bounded run: {:?}", again.halt);
    let plain = m.run(&fits);
    assert!(plain.completed, "a later plain run: {:?}", plain.halt);
}
