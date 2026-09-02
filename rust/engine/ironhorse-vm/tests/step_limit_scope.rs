//! Wave-6 W6-16: `run_bounded`'s ceiling must not latch onto every
//! later `run` on the same machine.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
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
