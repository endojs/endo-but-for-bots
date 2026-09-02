//! Arrow functions capture `this`, `new.target`, and `super` from their
//! defining function instead of receiving those bindings from the call site.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn arrow_uses_lexical_this() {
    assert_result_agrees(
        "var o = { x: 7, m: function () { var f = () => this.x; return f.call({ x: 9 }); } }; o.m()",
        "7",
    );
}

#[test]
fn arrow_before_super_observes_the_initialized_binding() {
    assert_result_agrees(
        "class C extends Object { constructor() { var f = () => this; super(); return f(); } } new C() instanceof C",
        "true",
    );
    assert_result_agrees(
        "var before=false; class C extends Object { constructor() { var f=()=>this; try { f() } catch (e) { before=e instanceof ReferenceError } super(); this.ok=f()===this; } } var c=new C(); before+':'+c.ok",
        "true:true",
    );
    assert_result_agrees(
        "function side(){return 1} class C extends Object { constructor() { var f=()=>this; super(side()); return f(); } } new C() instanceof C",
        "true",
    );
}

#[test]
fn arrow_uses_lexical_new_target() {
    assert_result_agrees(
        "function F() { this.ok = (() => new.target === F)(); } new F().ok",
        "true",
    );
    assert_result_agrees(
        "function F() { return (() => new.target)(); } F() === undefined",
        "true",
    );
}

#[test]
fn arrow_uses_lexical_super_home_object() {
    assert_result_agrees(
        "var base = { x: 3 }; var object = { m() { return () => super.x; } }; Object.setPrototypeOf(object, base); object.m()()",
        "3",
    );
}
