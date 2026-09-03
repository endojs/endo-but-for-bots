//! Regression gates for native errors, shared coercions, and strict failures.
//!
//! These programs are dual-run against the pinned XS oracle.  They deliberately
//! observe values through ordinary JavaScript rather than inspecting VM side
//! tables, so each test remains load-bearing for the guest-visible semantics.

use ironhorse_262::xst::{run_case, Config, Verdict};
use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        run.ironhorse_halt,
        run.oracle_result,
        run.ironhorse_result,
    );
    assert!(
        run.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn native_errors_have_the_right_realm_surface() {
    for source in [
        "new Error('boom').message",
        "new TypeError('boom').name",
        "new TypeError('boom').constructor === TypeError",
        "new TypeError('boom') instanceof Error",
        "Error.length",
        "AggregateError.length",
        "new Error('boom', { cause: 17 }).cause",
        "var d = Object.getOwnPropertyDescriptor(new Error('boom', { cause: 17 }), 'cause'); d.value === 17 && d.writable && !d.enumerable && d.configurable",
        "new AggregateError([], 'boom', { cause: 23 }).cause",
        "!Object.prototype.hasOwnProperty.call(new Error('boom', Symbol('options')), 'cause')",
        "var log=[];var message={toString:function(){log.push('m');return 'boom'}};var options={get cause(){log.push('c');return 7}};var e=new Error(message,options);e.message+':'+e.cause+':'+log.join('')",
        "new EvalError('x',{__proto__:{cause:11}}).cause",
        "var log=[];var options=new Proxy({cause:13},{has:function(t,k){log.push('h');return Reflect.has(t,k)},get:function(t,k,r){log.push('g');return Reflect.get(t,k,r)}});var e=new TypeError('x',options);e.cause+':'+log.join('')",
        "var caught;try{new RangeError({toString:function(){throw 17}})}catch(e){caught=e}caught",
        "try{new SyntaxError(Symbol('message'));false}catch(e){e instanceof TypeError}",
        "new Error({toString:function(){return '\\ud800'}}).message.charCodeAt(0)",
        "Function.prototype.call.bind(Object.prototype.hasOwnProperty)({ x: 1 }, 'x')",
        "Object.getOwnPropertyNames({ value: 1 })[0]",
        "Object.prototype.toString.call(new TypeError)",
        "Error.prototype.toString.call({ name: 'Custom', message: 12 })",
        "var e = new Error('boom'); e.name = 'Custom'; e.toString() === String(e)",
        "try { Error.prototype.toString.call(null); false } catch (e) { e instanceof TypeError }",
        "try { Error.prototype.toString.call({ name: Symbol() }); false } catch (e) { e instanceof TypeError }",
        "DataView.length",
        "Object.getOwnPropertyDescriptor(Array, 'prototype').writable === false",
        "Object.keys(Object.prototype).length === 0",
        "var e = new Error('boom'); var keys = []; for (var k in e) keys.push(k); keys.length === 0",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn error_to_string_observes_properties_and_preserves_utf16() {
    for source in [
        "var log=[];var value={get name(){log.push('n');return 'Named'},get message(){log.push('m');return 7}};Error.prototype.toString.call(value)+':'+log.join('')",
        "var log=[];var value=new Proxy({name:'N',message:'M'},{get:function(t,k,r){log.push(String(k));return Reflect.get(t,k,r)}});Error.prototype.toString.call(value)+':'+log.join(',')",
        "var log=[];var value={get name(){log.push('n');throw 17},get message(){log.push('m');return 'no'}};var caught;try{Error.prototype.toString.call(value)}catch(e){caught=e}caught+':'+log.join('')",
        "Error.prototype.toString.call({name:undefined,message:'m'})",
        "Error.prototype.toString.call({name:'',message:'m'})",
        "Error.prototype.toString.call({name:'n',message:''})",
        "var text=Error.prototype.toString.call({name:'\\ud800',message:'\\udfff'});text.length+':'+text.charCodeAt(0)+':'+text.charCodeAt(3)",
        "try{Error.prototype.toString.call({name:Symbol('n'),message:'m'});false}catch(e){e instanceof TypeError}",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn aggregate_error_consumes_general_iterables_in_specification_order() {
    for source in [
        "new AggregateError(function*(){yield 1;yield 2}()).errors.join(',')",
        "new AggregateError('ab').errors.join(',')",
        "var a=[];a.length=2;a[1]=3;var e=new AggregateError(a);e.errors.length+':'+String(e.errors[0])+':'+e.errors[1]",
        "(function(a){a=9;return new AggregateError(arguments).errors[0]})(3)",
        "var log=[];var source={n:0,[Symbol.iterator]:function(){log.push('i');return this},next:function(){log.push('n');return this.n++<1?{value:7,done:false}:{done:true}}};var message={toString:function(){log.push('m');return 'boom'}};var e=new AggregateError(source,message);e.message+':'+e.errors[0]+':'+log.join('')",
        "var log=[];var a=[1,2];a[Symbol.iterator]=function(){log.push('i');return [8][Symbol.iterator]()};var e=new AggregateError(a);e.errors.join(',')+':'+log.join('')",
        "var gets=0;var source={ [Symbol.iterator]:function(){var n=0;return {get next(){gets++;return function(){return n++<1?{value:6,done:false}:{done:true}}}}}};new AggregateError(source).errors[0]+':'+gets",
        "var closed=0;var source={ [Symbol.iterator]:function(){return this},next:function(){throw 9},return:function(){closed++;return {done:true}}};var caught;try{new AggregateError(source)}catch(e){caught=e}String(caught)+':'+closed",
        "var log=[];var source={ [Symbol.iterator]:function(){log.push('i');return [1][Symbol.iterator]()}};var message={toString:function(){log.push('m');return 'x'}};var options=new Proxy({cause:2},{has:function(t,k){log.push('h');return Reflect.has(t,k)},get:function(t,k,r){log.push('g');return Reflect.get(t,k,r)}});var e=new AggregateError(source,message,options);e.cause+':'+log.join('')",
        "new AggregateError([], '\\udfff').message.charCodeAt(0)",
        "try{new AggregateError({})}catch(e){e instanceof TypeError}",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn object_to_primitive_drives_string_and_numeric_operations() {
    for source in [
        "var o = { valueOf() { return 4; } }; o + 3",
        "var o = { toString() { return 'key'; } }; ({ key: 9 })[o]",
        "Number({ valueOf() { return '12'; } })",
        "String({ toString() { return 'ok'; } })",
        "var o = { valueOf() { return 1 }, toString() { return 'two' } }; String(o) + (o + 0)",
        "'10' < 9",
        "({ valueOf() { return 5 } }) < 6",
        "'3' & 1",
        "({ valueOf() { return 6 } }) | 1",
        "({ valueOf() { return 7 } }) * 2",
        "({ valueOf() { return 8 } }) - 3",
        "try { ({ valueOf() { throw 7; } }) + 1 } catch (e) { e }",
        "var n = new Number(1); n.valueOf = function () { return 42; }; n + 0",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn strict_assignment_and_delete_throw_catchable_type_errors() {
    for source in [
        "'use strict'; try { Object.freeze({}).x = 1; false } catch (e) { e instanceof TypeError }",
        "'use strict'; var o = {}; Object.defineProperty(o, 'x', { value: 1, writable: true, enumerable: true, configurable: false }); try { delete o.x; false } catch (e) { e instanceof TypeError }",
        "'use strict'; (function () { return this === undefined; })()",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn global_descriptors_are_live_environment_bindings() {
    for source in [
        "Object.defineProperty(this,'x',{configurable:true,value:1});x",
        "var x=1;Object.defineProperty(this,'x',{value:2});x",
        "var hidden=1;Object.defineProperty(this,'x',{configurable:true,get:function(){return hidden},set:function(v){hidden=v}});x=7;x+':'+hidden",
        "var hidden=3;Object.defineProperties(this,{x:{get:function(){return hidden}},y:{value:4}});x+y",
        "var x=1;Object.defineProperty(this,'x',{writable:false});x=2;x",
        "'use strict';var x=1;Object.defineProperty(globalThis,'x',{writable:false});try{x=2;false}catch(e){e instanceof TypeError&&x===1}",
        "var marker={};Object.defineProperty(this,'x',{get:function(){throw marker}});try{x;false}catch(e){e===marker}",
        "Object.defineProperty(this,'x',{configurable:true,value:undefined});delete this.x;typeof x",
    ] {
        assert_result_agrees(source);
    }
}

#[test]
fn only_strict_test262_cases_execute_instead_of_preskipping() {
    let harness = std::env::temp_dir().join(format!(
        "ironhorse-errors-strict-harness-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&harness).expect("create temporary harness");
    std::fs::write(harness.join("sta.js"), "function Test262Error() {}\n").expect("write sta.js");
    std::fs::write(harness.join("assert.js"), "var assert = {};\n").expect("write assert.js");
    let source = r#"/*---
flags: [onlyStrict]
---*/
try { Object.freeze({}).x = 1; false }
catch (e) { e instanceof TypeError }
"#;
    let result = run_case(&Config::default(), &harness, source);
    assert_eq!(result.verdict, Verdict::Covered);
    assert!(!result.strict_skipped);
    std::fs::remove_dir_all(harness).expect("remove temporary harness");
}
