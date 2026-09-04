//! Wave-6 W6-15: a throw during `super(...)` argument evaluation must
//! not leave the pending new-target register poisoned — the register is
//! set BEFORE the arguments evaluate and the unwind never cleared it,
//! so the machine's next `new` construct took the stale target.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
}

#[test]
fn a_throw_in_super_arguments_does_not_poison_a_later_new_target() {
    agrees(
        "var probe = 0; var err = 0; \
         function boom() { throw 1; } \
         class A {} \
         class B extends A { constructor() { super(boom()); } } \
         try { new B(); } catch (e) { err = e; } \
         class K { constructor() { probe = String(new.target === K); } } \
         new K(); \
         probe + ':' + err",
    );
}
