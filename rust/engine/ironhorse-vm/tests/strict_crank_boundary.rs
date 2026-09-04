//! Wave-6 W6-6: the program-level `strict` register must not latch
//! across cranks. `BEGIN_STRICT` set it and nothing reset it at crank
//! entry, so after one strict crank every later sloppy crank's TOP
//! LEVEL ran strict: `delete` of a non-configurable property threw
//! where sloppy code silently answers `false` — and, because the
//! register is not serialized, a resumed machine (fresh boot,
//! `strict = false`) DIVERGED from its uninterrupted twin on this
//! completely ordinary two-crank input.

use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

#[test]
fn a_strict_crank_does_not_latch_strictness_onto_later_cranks() {
    let (b1, n1) = compile("'use strict'; var s = 0; s = 1; s");
    let crank2 = "var t = 0; t = delete Object.prototype; t ? 'deleted' : 'kept'";
    let (b2, n2) = compile(crank2);

    // Control: the sloppy crank alone answers 'kept' without throwing.
    let mut control = Interp::new();
    let (bc, nc) = compile(crank2);
    control.link_intrinsics(&nc);
    let c = control.run(&bc);
    assert!(c.completed, "control: {:?}", c.halt);
    assert_eq!(c.result, "kept");

    // Strict crank first, then the same sloppy crank on one machine.
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o1 = m.run(&b1);
    assert!(o1.completed, "strict crank: {:?}", o1.halt);
    let b2r = m.relink_crank(&b2, &n2).expect("relink");
    let o2 = m.run(&b2r);
    assert!(
        o2.completed,
        "the strict register latched across the crank boundary: {:?}",
        o2.halt
    );
    assert_eq!(o2.result, "kept");
}
