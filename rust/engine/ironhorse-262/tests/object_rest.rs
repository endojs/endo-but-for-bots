//! Object-rest destructuring compiles named exclusions through XS_CODE_SYMBOL.
//! These are internal interned string keys, not ECMAScript Symbol primitives.

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
fn named_property_is_excluded_from_object_rest() {
    assert_result_agrees(
        "var a, rest; ({ a: a, ...rest } = { a: 1, b: 2 }); '' + a + ',' + rest.a + ',' + rest.b + ',' + Object.keys(rest).join('|')",
        "1,undefined,2,b",
    );
}

#[test]
fn declaration_and_parameter_rest_preserve_remaining_properties() {
    assert_result_agrees(
        "var { x, ...rest } = { x: 1, y: 2, z: 3 }; '' + x + ',' + rest.y + ',' + rest.z",
        "1,2,3",
    );
    assert_result_agrees(
        "function f({ p, ...rest }) { return '' + p + ',' + rest.q; } f({ p: 4, q: 5 })",
        "4,5",
    );
}

#[test]
fn primitive_string_and_symbol_sources_are_boxed() {
    assert_result_agrees(
        "var { 0: first, ...rest } = 'abc'; '' + first + ',' + rest[0] + ',' + rest[1] + ',' + rest[2] + ',' + Object.keys(rest).join('|')",
        "a,undefined,b,c,1|2",
    );
    assert_result_agrees(
        "var { ...rest } = Symbol('value'); Object.keys(rest).length",
        "0",
    );
}

#[test]
fn spread_and_rest_copy_exotic_sources_observably() {
    assert_result_agrees(
        "var copy={...['a','b']};Object.keys(copy).join('|')+':'+copy[0]+':'+copy[1]",
        "0|1:a:b",
    );
    assert_result_agrees(
        "var a=[];a.length=3;a[2]='c';var copy={...a};Object.keys(copy).join('|')+':'+copy[2]",
        "2:c",
    );
    assert_result_agrees(
        "var copy={...new Uint8Array([4,5])};copy[0]+':'+copy[1]+':'+Object.keys(copy).join('|')",
        "4:5:0|1",
    );
    assert_result_agrees(
        "var log=[];var target={a:1,b:2};var source=new Proxy(target,{ownKeys:function(t){log.push('own');return Reflect.ownKeys(t)},getOwnPropertyDescriptor:function(t,k){log.push('desc:'+String(k));return Reflect.getOwnPropertyDescriptor(t,k)},get:function(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)}});var copy={...source};copy.a+copy.b+':'+log.join(',')",
        "3:own,desc:a,get:a,desc:b,get:b",
    );
    assert_result_agrees(
        "var symbol=Symbol('s');var source={[symbol]:7};var copy={...source};copy[symbol]",
        "7",
    );
    assert_result_agrees(
        "var calls=0;var proto={set x(v){calls++}};var copy={__proto__:proto,...{x:3}};copy.x+':'+calls+':'+copy.hasOwnProperty('x')",
        "3:0:true",
    );
    assert_result_agrees(
        "var copy={...null,...undefined,...'ab',...3};Object.keys(copy).join('|')+':'+copy[0]+copy[1]",
        "0|1:ab",
    );
    assert_result_agrees(
        "var source={get a(){delete this.b;return 1},b:2};var copy={...source};copy.a+':'+copy.hasOwnProperty('b')",
        "1:false",
    );
    assert_result_agrees(
        "var {0:first,...rest}=['a','b'];first+':'+rest[1]+':'+Object.keys(rest).join('|')",
        "a:b:1",
    );
}
