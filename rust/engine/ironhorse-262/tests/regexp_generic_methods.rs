//! Generic and observable `RegExp.prototype` method behavior.

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
fn exec_brand_checks_and_coerces_compatible_arguments() {
    for source in [
        "var n=0;try{RegExp.prototype.exec.call(null,{toString:function(){n++;return 'x'}})}catch(e){(e instanceof TypeError)+':'+n}",
        "var n=0;try{RegExp.prototype.exec.call({},{toString:function(){n++;return 'x'}})}catch(e){(e instanceof TypeError)+':'+n}",
        "try{/x/.exec(Symbol())}catch(e){e instanceof TypeError}",
        "var r=/x/;var n=0;r.exec({toString:function(){n++;return 'x'}});n",
    ] {
        agrees(source);
    }
}

#[test]
fn test_uses_the_observable_exec_method() {
    for source in [
        "var seen='';var o={exec:function(s){seen=(this===o)+':'+s;return {}}};RegExp.prototype.test.call(o,{toString:function(){return 'ok'}})+':'+seen",
        "var o={exec:function(){return null}};RegExp.prototype.test.call(o,'x')",
        "var o={exec:function(){return 1}};try{RegExp.prototype.test.call(o,'x')}catch(e){e instanceof TypeError}",
        "var r=/x/;r.exec=function(){return null};r.test('x')",
        "var r=/x/;r.exec=1;r.test('x')",
        "var log='';var o={get exec(){log+='e';return null}};try{RegExp.prototype.test.call(o,{toString:function(){log+='s';return 'x'}})}catch(e){(e instanceof TypeError)+':'+log}",
        "var log='';var p=new Proxy({},{get:function(t,k){log+=k;return k==='exec'?function(){return null}:undefined}});RegExp.prototype.test.call(p,'x')+':'+log",
    ] {
        agrees(source);
    }
}

#[test]
fn to_string_is_generic_and_observable() {
    for source in [
        "RegExp.prototype.toString.call({source:'ab',flags:'gi'})",
        "RegExp.prototype.toString.call({})",
        "var log='';var o={get source(){log+='s';return {toString:function(){log+='S';return 'ab'}}},get flags(){log+='f';return {toString:function(){log+='F';return 'g'}}}};RegExp.prototype.toString.call(o)+':'+log",
        "var r=/x/g;Object.defineProperty(r,'source',{value:'ab'});Object.defineProperty(r,'flags',{value:'i'});r.toString()",
        "var r=/x/g;var p=Object.create(RegExp.prototype);Object.defineProperty(p,'source',{value:'ab'});Object.defineProperty(p,'flags',{value:'i'});Object.setPrototypeOf(r,p);r.toString()",
        "var f=RegExp.prototype.toString;var n=0;var r=/x/g;var p=new Proxy(RegExp.prototype,{get:function(){n++;return n===1?'ab':'i'}});Object.setPrototypeOf(r,p);f.call(r)+':'+n",
        "try{RegExp.prototype.toString.call(null)}catch(e){e instanceof TypeError}",
        "try{RegExp.prototype.toString.call({source:Symbol(),flags:''})}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}
