//! Oracle-backed coverage for `ToPropertyKey` at computed property opcodes.
//! Primitive keys other than strings and numbers must use their ordinary
//! string spelling, while Symbols retain their identity.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn primitive_keys_use_their_string_spelling() {
    for source in [
        "var o={[null]:1,[true]:2,[false]:3,[undefined]:4,[12n]:5};[o.null,o.true,o.false,o.undefined,o[12]].join(',')",
        "var o={};o[null]=1;o[true]=2;o[9n]=3;delete o[true];o[null]+':'+String(o[true])+':'+o['9']",
        "var k=function(){};var o={[k()]:7};o[k()]",
    ] {
        agrees(source);
    }
}

#[test]
fn primitive_keys_work_in_class_and_accessor_definitions() {
    for source in [
        "class C{[null](){return 1}static[true](){return 2}}new C().null()+C.true()",
        "var value=0;var o={set[undefined](v){value=v},get[undefined](){return value}};o[void 0]=9;o.undefined",
        "class C{[false]=3;static[12n]=4}new C().false+C['12']",
    ] {
        agrees(source);
    }
}

#[test]
fn primitive_keys_work_in_destructuring() {
    for source in [
        "var {[null]:a,[undefined]:b}={null:1,undefined:2};a+b",
        "var key=false;function f({[key]:v}){return v}f({false:8})",
        "var rest;var {[1n]:x,...rest}={'1':2,true:3};x+rest.true",
    ] {
        agrees(source);
    }
}
