//! `GET_PROPERTY`'s `DisposableStack.prototype.disposed` arm tests its
//! receiver before the property name. Pin that the arm still answers for a
//! DisposableStack (live and disposed, direct and subclassed) and that a
//! `disposed` read on any other receiver takes the ordinary path.
use crate::{parse_symbols, Interp};

fn run(source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    outcome.result
}

#[test]
fn disposed_reads_answer_for_stacks_and_fall_through_for_other_receivers() {
    assert_eq!(
        run("var s = new DisposableStack(); var a = s.disposed; s.dispose(); [a, s.disposed].join()"),
        "false,true"
    );
    assert_eq!(
        run("class C extends DisposableStack {} var c = new C(); var a = c.disposed; c.dispose(); [a, c.disposed].join()"),
        "false,true"
    );
    assert_eq!(
        run("var o = { disposed: 5, other: 6 }; [o.disposed, o.other, ({}).disposed].join()"),
        "5,6,"
    );
    assert_eq!(
        run("var s = new DisposableStack(); [s.other, typeof s.dispose].join()"),
        ",function"
    );
}
