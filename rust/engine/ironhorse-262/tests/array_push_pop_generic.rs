//! Oracle-backed coverage for generic `Array.prototype.push` and `pop`.
//! Both methods operate through the object MOP and honor Array descriptor
//! constraints while retaining the packed Array fast path when unobservable.

use ironhorse_262::{dual_run, ironhorse_only_run, Agreement};
use ironhorse_vm::Halt;

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (halt: {:?}; oracle error: {:?}; ironhorse error: {:?})",
        run.ironhorse_halt,
        run.oracle_error,
        run.ironhorse_error,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

fn ironhorse_completes(source: &str) {
    assert_eq!(
        ironhorse_only_run(source),
        Halt::Return,
        "IronHorse must complete `{source}`",
    );
}

#[test]
fn push_accepts_generic_sparse_and_primitive_receivers() {
    for source in [
        "var o={length:1,0:'a'}; var n=Array.prototype.push.call(o,'b','c'); n+':'+o.length+':'+o[0]+o[1]+o[2]",
        "var a=new Array(2); a[0]='a'; var n=a.push('c'); n+':'+Object.prototype.hasOwnProperty.call(a,1)+':'+a[2]",
        "Array.prototype.push.call(17,'x','y')",
        "try{Array.prototype.push.call('ab','c');false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn push_observes_inherited_setters_and_proxy_traps() {
    for source in [
        "var seen=''; var p={}; Object.defineProperty(p,'1',{set:function(v){seen=v}}); var a=[0]; Object.setPrototypeOf(a,p); var n=Array.prototype.push.call(a,'x'); n+':'+seen+':'+Object.prototype.hasOwnProperty.call(a,1)+':'+a.length",
        "var p=[]; Object.defineProperty(p,'1',{value:'blocked',writable:false}); var a=[0]; Object.setPrototypeOf(a,p); try{a.push('x');false}catch(e){e instanceof TypeError && !Object.prototype.hasOwnProperty.call(a,1) && a.length===1}",
        "var log=[]; var target={length:1,0:'a'}; var p=new Proxy(target,{get:function(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)},set:function(t,k,v,r){log.push('set:'+String(k)+':'+v);return Reflect.set(t,k,v,r)}}); var n=Array.prototype.push.call(p,'b'); n+'|'+log.join(',')",
        "var typed=new Uint8Array(0); var receiver=Object.create(typed); Object.defineProperty(receiver,'length',{value:0,writable:true,configurable:true}); var n=Array.prototype.push.call(receiver,1); n+':'+receiver.length+':'+Object.prototype.hasOwnProperty.call(receiver,'0')+':'+receiver[0]",
    ] {
        agrees(source);
    }
    // The pinned XS oracle misses this uninterned-key Proxy-prototype trap,
    // while ECMA-262 OrdinarySet requires the parent Proxy's [[Set]]. Keep the
    // spec regression IronHorse-only rather than encoding the oracle bug.
    ironhorse_completes(
        "var log=[]; var prototype=new Proxy({},{set:function(t,k,v,r){log.push(String(k)+':'+v);return true}}); var a=[]; Object.setPrototypeOf(a,prototype); Array.prototype.push.call(a,'x'); if(log.join(',')!=='0:x')throw 'wrong'",
    );
}

#[test]
fn push_and_pop_use_arguments_exotic_length_and_mapping() {
    for source in [
        "(function(a,b){var n=Array.prototype.push.call(arguments,'x');return n+':'+arguments.length+':'+arguments[2]})(1,2)",
        "(function(a,b){var v=Array.prototype.pop.call(arguments);return v+':'+arguments.length+':'+b})(1,2)",
        "(function(a,b){delete arguments[0];b='z';return Array.prototype.pop.call(arguments)+':'+arguments.length})(1,2)",
        "(function(a){var v=Array.prototype.pop.call(arguments);a='z';return v+':'+arguments.length+':'+arguments[0]})(1)",
        "(function(a,a,b){var x=arguments;a='q';b='z';return x[0]+':'+x[1]+':'+x[2]})(1,2,3)",
        "(function(a,b){var x=arguments;return function(){a='q';return x[0]+':'+x[1]}})(1,2)()",
        "(function(a){arguments[0]='x';return a+':'+arguments[0]})(1)",
        "(function(a){delete arguments[0];a='z';return String(arguments[0])+':'+a})(1)",
        "(function(a){Object.defineProperty(arguments,'0',{value:'x',writable:false});a='z';return arguments[0]+':'+a})(1)",
    ] {
        agrees(source);
    }
}

#[test]
fn push_enforces_length_constraints_before_or_after_the_spec_writes() {
    for source in [
        "var a=[]; Object.defineProperty(a,'length',{writable:false}); try{a.push();false}catch(e){e instanceof TypeError}",
        "var o={length:0}; Object.preventExtensions(o); try{Array.prototype.push.call(o,'x');false}catch(e){e instanceof TypeError && o.length===0}",
        "var o={length:9007199254740991}; try{Array.prototype.push.call(o,'x');false}catch(e){e instanceof TypeError && !Object.prototype.hasOwnProperty.call(o,'9007199254740991')}",
        "var a=[]; a.length=4294967295; var type=false; try{a.push('x')}catch(e){type=e instanceof RangeError} type+':'+Object.prototype.hasOwnProperty.call(a,'4294967295')+':'+(a['4294967295']==='x')+':'+a.length",
    ] {
        agrees(source);
    }
}

#[test]
fn pop_accepts_generic_sparse_and_primitive_receivers() {
    for source in [
        "var o={length:2,0:'a',1:'b'}; var v=Array.prototype.pop.call(o); v+':'+o.length+':'+Object.prototype.hasOwnProperty.call(o,1)",
        "var p={1:'inherited'}; var o=Object.create(p); o.length=2; var v=Array.prototype.pop.call(o); v+':'+o.length+':'+p[1]",
        "var a=new Array(3); a[0]='a'; var v=a.pop(); String(v)+':'+a.length+':'+Object.prototype.hasOwnProperty.call(a,2)",
        "String(Array.prototype.pop.call(17))",
        "try{Array.prototype.pop.call(null);false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn pop_observes_proxy_order_and_descriptor_failures() {
    for source in [
        "var log=[]; var target={length:2,1:'b'}; var p=new Proxy(target,{get:function(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)},deleteProperty:function(t,k){log.push('delete:'+String(k));return Reflect.deleteProperty(t,k)},set:function(t,k,v,r){log.push('set:'+String(k)+':'+v);return Reflect.set(t,k,v,r)}}); var v=Array.prototype.pop.call(p); v+'|'+log.join(',')",
        "var o={length:1}; Object.defineProperty(o,'0',{value:'x',configurable:false}); try{Array.prototype.pop.call(o);false}catch(e){e instanceof TypeError && o.length===1}",
        "var a=['x']; Object.defineProperty(a,'0',{configurable:false}); try{a.pop();false}catch(e){e instanceof TypeError && a.length===1 && a[0]==='x'}",
        "var a=[]; Object.defineProperty(a,'length',{writable:false}); try{a.pop();false}catch(e){e instanceof TypeError}",
        "var a=['x']; Object.defineProperty(a,'length',{writable:false}); try{a.pop();false}catch(e){e instanceof TypeError && a.length===1 && a[0]==='x'}",
        "var a=new Uint8Array([7]); Object.defineProperty(a,'length',{value:1,writable:true,configurable:true}); var threw=false; try{Array.prototype.pop.call(a)}catch(e){threw=e instanceof TypeError} threw+':'+a.length+':'+a[0]",
    ] {
        agrees(source);
    }
}

#[test]
fn function_metadata_matches_ecmascript() {
    agrees(
        "Array.prototype.push.name+':'+Array.prototype.push.length+':'+Array.prototype.pop.name+':'+Array.prototype.pop.length",
    );
}
