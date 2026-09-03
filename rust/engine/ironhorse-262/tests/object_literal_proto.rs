//! Object-literal `__proto__:` runtime semantics (`XS_CODE_INSTANTIATE`).

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn written_proto_selects_the_literal_prototype_without_defining_a_property() {
    for source in [
        "var p={x:1};var o={__proto__:p,y:2};o.x+o.y+':'+Object.hasOwn(o,'__proto__')",
        "var o={__proto__:null,x:1};(Object.getPrototypeOf(o)===null)+':'+Object.hasOwn(o,'toString')+':'+typeof o.toString",
        "var o={__proto__:7};Object.getPrototypeOf(o)===Object.prototype",
        "var o={__proto__:undefined};Object.getPrototypeOf(o)===Object.prototype",
    ] {
        agrees(source);
    }
}

#[test]
fn proto_literals_compose_with_methods_accessors_and_ordinary_proto_forms() {
    for source in [
        "var p={x:1};var o={__proto__:p,get y(){return this.x+1},m(){return this.y+1}};o.m()",
        "var __proto__=3;var o={__proto__};Object.hasOwn(o,'__proto__')+':'+o.__proto__",
        "var p={x:1};var o={['__proto__']:p};Object.getPrototypeOf(o)===Object.prototype&&o.__proto__===p",
    ] {
        agrees(source);
    }
}
