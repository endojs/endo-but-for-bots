//! Oracle-backed coverage for generic `Array.prototype.toString`.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines: {run:?}",
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn sparse_arguments_and_primitive_receivers_use_live_join_semantics() {
    for source in [
        "var a=[1,,3];Array.prototype.toString.call(a)",
        "(function(a,b){b='z';return Array.prototype.toString.call(arguments)})(1,2)",
        "var old=Number.prototype.join;Number.prototype.join=function(){return this.valueOf()+1};var r=Array.prototype.toString.call(7);Number.prototype.join=old;r",
        "Array.prototype.toString.call('abc')",
        "try{Array.prototype.toString.call(null);false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn join_lookup_and_call_are_observable() {
    for source in [
        "var marker={};var a=[1,2];a.join=function(){return this===a?marker:null};Array.prototype.toString.call(a)===marker",
        "var log=[];var o={get join(){log.push('get');return function(){log.push(this===o?'call':'wrong');return 'ok'}}};Array.prototype.toString.call(o)+':'+log.join(',')",
        "var log=[];var p=new Proxy({join:function(){log.push('call');return 'ok'}},{get:function(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)}});Array.prototype.toString.call(p)+':'+log.join(',')",
        "var old=Array.prototype.join;Array.prototype.join=function(){return 'patched'};var r=[1,2].toString();Array.prototype.join=old;r",
        "var a=new Uint8Array([1,2]);a.join=function(){return this===a?'typed':'wrong'};Array.prototype.toString.call(a)",
    ] {
        agrees(source);
    }
}

#[test]
fn non_callable_join_falls_back_to_object_to_string() {
    for source in [
        "var a=[];a.join=0;Array.prototype.toString.call(a)",
        "var saved=Array.prototype.join;delete Array.prototype.join;var r=[].toString();Array.prototype.join=saved;r",
        "Reflect.deleteProperty(Array.prototype,'join');[].toString()",
        "Array.prototype.toString.call({join:null})",
        "var o={join:0};o[Symbol.toStringTag]='Tagged';Array.prototype.toString.call(o)",
        "var a=new Uint8Array([1]);a.join=0;Array.prototype.toString.call(a)",
        "Object.prototype.toString.call([])",
    ] {
        agrees(source);
    }
}

#[test]
fn fallback_retains_the_object_intrinsic_and_proxy_array_brand() {
    for source in [
        "var saved=Object.prototype.toString;Object.prototype.toString=function(){return 'patched'};var a=[];a.join=0;var r=Array.prototype.toString.call(a);Object.prototype.toString=saved;r",
        "var saved=Object.prototype.toString;delete Object.prototype.toString;var a=[];a.join=0;var r=Array.prototype.toString.call(a);Object.prototype.toString=saved;r",
        "var a=[];a.join=1;Array.prototype.toString.call(new Proxy(a,{}))",
        "var q=Proxy.revocable([],{});q.revoke();try{Array.prototype.toString.call(q.proxy);false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}
