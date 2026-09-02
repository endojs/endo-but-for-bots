//! Oracle-backed integrity-level coverage for exotic objects and proxies.

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
fn arrays_support_prevent_extensions_seal_and_freeze() {
    for source in [
        "var a=[];Object.preventExtensions(a);Object.isExtensible(a)",
        "var a=[1];Object.seal(a);Object.isSealed(a)+':'+Object.getOwnPropertyDescriptor(a,'0').configurable+':'+Object.getOwnPropertyDescriptor(a,'length').configurable",
        "var a=[1];Object.freeze(a);Object.isFrozen(a)+':'+Object.getOwnPropertyDescriptor(a,'0').writable+':'+Object.getOwnPropertyDescriptor(a,'length').writable",
        "'use strict';var a=[1];Object.freeze(a);var element=false,length=false;try{a[0]=2}catch(e){element=e instanceof TypeError}try{a.length=0}catch(e){length=e instanceof TypeError}element+':'+length+':'+a[0]+':'+a.length",
        "'use strict';var a=[1];Object.seal(a);a[0]=2;var removed=false,extended=false;try{delete a[0]}catch(e){removed=e instanceof TypeError}try{a.push(3)}catch(e){extended=e instanceof TypeError}removed+':'+extended+':'+a[0]+':'+a.length",
    ] {
        agrees(source);
    }
}

#[test]
fn string_wrappers_are_already_frozen_at_their_synthetic_keys() {
    for source in [
        "var s=Object('ab');Object.freeze(s);Object.isFrozen(s)+':'+Object.getOwnPropertyDescriptor(s,'0').writable+':'+Object.getOwnPropertyDescriptor(s,'length').configurable",
        "var s=Object('ab');Object.seal(s);Object.isSealed(s)+':'+Object.isFrozen(s)",
    ] {
        agrees(source);
    }
}

#[test]
fn integer_indexed_objects_reject_nonempty_integrity_transitions() {
    for source in [
        "var a=new Uint8Array([1]);var ok=false;try{Object.seal(a)}catch(e){ok=e instanceof TypeError}ok+':'+Object.isExtensible(a)+':'+Object.isSealed(a)",
        "var a=new Uint8Array([1]);var ok=false;try{Object.freeze(a)}catch(e){ok=e instanceof TypeError}ok+':'+Object.isExtensible(a)+':'+Object.isFrozen(a)",
        "var a=new Uint8Array(0);Object.freeze(a);Object.isFrozen(a)",
    ] {
        agrees(source);
    }
}

#[test]
fn proxy_integrity_uses_all_required_internal_methods() {
    for source in [
        "var log=[];var t={x:1};var p=new Proxy(t,{preventExtensions:function(o){log.push('prevent');return Reflect.preventExtensions(o)},ownKeys:function(o){log.push('keys');return Reflect.ownKeys(o)},getOwnPropertyDescriptor:function(o,k){log.push('desc:'+k);return Reflect.getOwnPropertyDescriptor(o,k)},defineProperty:function(o,k,d){log.push('define:'+k);return Reflect.defineProperty(o,k,d)}});Object.freeze(p);Object.isFrozen(p)+':'+log.join(',')",
        "var p=new Proxy({x:1},{preventExtensions:function(){return false}});var ok=false;try{Object.seal(p)}catch(e){ok=e instanceof TypeError}ok",
    ] {
        agrees(source);
    }
}

#[test]
fn primitive_integrity_queries_keep_the_spec_vacuous_results() {
    for source in [
        "Object.preventExtensions(1)===1",
        "Object.freeze(null)===null",
        "Object.seal(undefined)===undefined",
        "Object.isExtensible('x')+':'+Object.isSealed(1)+':'+Object.isFrozen(Symbol('s'))",
    ] {
        agrees(source);
    }
}
