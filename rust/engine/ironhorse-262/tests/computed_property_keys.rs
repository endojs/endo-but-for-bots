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
fn computed_names_lazily_install_intrinsics_without_resurrecting_edits() {
    for source in [
        "typeof globalThis['Pro' + 'mise']",
        "var k='hasOwn'+'Property';var f={}[k];f.call({x:1},'x')",
        "var p=Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));var k='con'+'structor';p[k].name",
        "var k='con'+'structor';var o={};o[k]=7;o[k]",
        "var k='to'+'String';delete Object.prototype[k];typeof ({})[k]",
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

#[test]
fn in_coerces_its_left_operand_to_a_property_key() {
    for source in [
        "var o={null:1,true:2,undefined:3,'12':4};[null in o,true in o,undefined in o,12n in o].join(',')",
        "[undefined in {},null in {},true in {},1n in {}].join(',')",
        "var k={[Symbol.toPrimitive](hint){return hint}};var o={string:1};k in o",
        "var seen;var p=new Proxy({}, {has(t,k){seen=typeof k+':'+String(k);return true}});var k={toString(){return '7'}};(k in p)+':'+seen",
        "var a=[];a[2]=1;[2 in a,1 in a,'length' in a].join(',')",
        "'prototype' in (()=>{})",
        "var a=new Uint8Array([1]);[0 in a,1n in a,null in a,'-0' in a].join(',')",
        "var k={[Symbol.toPrimitive](){throw 42}};try{k in {}}catch(e){e}",
        "var hit=false;var k={[Symbol.toPrimitive](){hit=true;return 'x'}};try{k in null}catch(e){};hit",
    ] {
        agrees(source);
    }
}
