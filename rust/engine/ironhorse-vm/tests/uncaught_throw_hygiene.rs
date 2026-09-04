//! The uncaught half of wave-6 W6-15: a throw during `super(...)`
//! argument evaluation that ESCAPES the crank (no handler anywhere)
//! must disarm the pending new-target on its way to the host, exactly
//! as a caught throw does. The direct `XS_CODE_THROW` escape arm
//! returned `Halt::Throw` before `unwind_to_jump` performed its
//! disarm, so the machine's next crank's `new K()` consumed the stale
//! target as its `new.target`.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

fn crank(m: &mut Interp, src: &str) -> (bool, String, String) {
    let (b, n) = compile(src);
    let b = m.relink_crank(&b, &n).expect("relink");
    let o = m.run(&b);
    (o.completed, format!("{:?}", o.halt), o.result)
}

#[test]
fn an_uncaught_super_argument_throw_does_not_poison_the_next_cranks_new_target() {
    let (b, n) = compile(
        "var probe = 0; \
         function boom() { throw 1; } \
         class A {} \
         class B extends A { constructor() { super(boom()); } } \
         new B();",
    );
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(
        !o.completed,
        "crank 1 must escape with the uncaught throw, got {:?}",
        o.halt
    );
    let (completed, halt, result) = crank(
        &mut m,
        "var probe; \
         class K { constructor() { probe = String(new.target === K); } } \
         new K(); probe",
    );
    assert!(completed, "{halt}");
    assert_eq!(
        result, "true",
        "the stale super target leaked into the next crank's new.target"
    );
}
