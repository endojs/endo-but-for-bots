//! Oracle-backed coverage for generic `Array.prototype.push` and `pop`.
//! Both methods operate through the object MOP and honor Array descriptor
//! constraints while retaining the packed Array fast path when unobservable.

use ironhorse_262::{dual_run, Agreement};

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
