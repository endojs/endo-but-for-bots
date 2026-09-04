//! Oracle-backed coverage for generic `Array.prototype.shift` and `unshift`.
//! Both methods move properties through the object MOP so holes, prototypes,
//! accessors, Proxies, primitives, and Array descriptor constraints remain
//! observable.

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
fn shift_accepts_generic_sparse_and_primitive_receivers() {
    for source in [
        "var o={0:'a',1:'b',length:2}; var v=Array.prototype.shift.call(o); v+':'+o.length+':'+o[0]+':'+Object.prototype.hasOwnProperty.call(o,1)",
        "var p={1:'inherited'}; var o=Object.create(p); o[0]='first'; o.length=3; var v=Array.prototype.shift.call(o); v+':'+o.length+':'+o[0]+':'+Object.prototype.hasOwnProperty.call(o,0)+':'+Object.prototype.hasOwnProperty.call(o,1)",
        "var a=[,'b']; var v=a.shift(); String(v)+':'+a.length+':'+a[0]+':'+Object.prototype.hasOwnProperty.call(a,0)",
        "String(Array.prototype.shift.call(17))",
        "try{Array.prototype.shift.call('ab');false}catch(e){e instanceof TypeError}",
        "try{Array.prototype.shift.call(null);false}catch(e){e instanceof TypeError}",
        "(function(a,b){var v=Array.prototype.shift.call(arguments);return v+':'+arguments.length+':'+arguments[0]+':'+a+':'+b})(1,2)",
    ] {
        agrees(source);
    }
}

#[test]
fn shift_observes_proxy_order_and_descriptor_failures() {
    for source in [
        "var log=[]; var p=new Proxy({0:'a',2:'c',length:3},{get:function(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)},has:function(t,k){log.push('has:'+String(k));return Reflect.has(t,k)},set:function(t,k,v,r){log.push('set:'+String(k)+':'+v);return Reflect.set(t,k,v,r)},deleteProperty:function(t,k){log.push('delete:'+String(k));return Reflect.deleteProperty(t,k)}}); var v=Array.prototype.shift.call(p); v+'|'+log.join(',')",
        "var a=['a','b']; Object.defineProperty(a,'0',{writable:false}); try{a.shift();false}catch(e){e instanceof TypeError && a.length===2 && a[0]==='a'}",
        "var a=['a']; Object.defineProperty(a,'0',{configurable:false}); try{a.shift();false}catch(e){e instanceof TypeError && a.length===1}",
        "var a=[]; Object.defineProperty(a,'length',{writable:false}); try{a.shift();false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn unshift_accepts_generic_sparse_and_primitive_receivers() {
    for source in [
        "var o={0:'b',2:'d',length:3}; var n=Array.prototype.unshift.call(o,'a'); n+':'+o.length+':'+o[0]+o[1]+':'+Object.prototype.hasOwnProperty.call(o,2)+':'+o[3]",
        "var p={1:'inherited'}; var o=Object.create(p); o[0]='a'; o.length=2; var n=Array.prototype.unshift.call(o,'x'); n+':'+o[0]+o[1]+o[2]",
        "var a=new Array(2); a[1]='b'; var n=a.unshift('a'); n+':'+a.length+':'+a[0]+':'+Object.prototype.hasOwnProperty.call(a,1)+':'+a[2]",
        "Array.prototype.unshift.call(17)",
        "try{Array.prototype.unshift.call('ab','x');false}catch(e){e instanceof TypeError}",
        "(function(a,b){var n=Array.prototype.unshift.call(arguments,'x');return n+':'+arguments.length+':'+arguments[0]+':'+arguments[1]+':'+arguments[2]+':'+a+':'+b})(1,2)",
    ] {
        agrees(source);
    }
}

#[test]
fn unshift_observes_proxy_order_and_constraints() {
    for source in [
        "var log=[]; var p=new Proxy({0:'a',1:'b',length:2},{get:function(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)},has:function(t,k){log.push('has:'+String(k));return Reflect.has(t,k)},set:function(t,k,v,r){log.push('set:'+String(k)+':'+v);return Reflect.set(t,k,v,r)},deleteProperty:function(t,k){log.push('delete:'+String(k));return Reflect.deleteProperty(t,k)}}); var n=Array.prototype.unshift.call(p,'x'); n+'|'+log.join(',')",
        "var o={0:'a',length:1}; Object.preventExtensions(o); try{Array.prototype.unshift.call(o,'x');false}catch(e){e instanceof TypeError && o.length===1}",
        "var a=['a']; Object.defineProperty(a,'0',{writable:false}); try{a.unshift('x');false}catch(e){e instanceof TypeError && a.length===2 && a[1]==='a' && a[0]==='a'}",
        "var o={length:9007199254740991}; try{Array.prototype.unshift.call(o,'x');false}catch(e){e instanceof TypeError && !Object.prototype.hasOwnProperty.call(o,'9007199254740991')}",
        "var a=[]; Object.defineProperty(a,'length',{writable:false}); try{a.unshift();false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn function_metadata_and_wide_zero_argument_length_match() {
    for source in [
        "Array.prototype.shift.name+':'+Array.prototype.shift.length+':'+Array.prototype.unshift.name+':'+Array.prototype.unshift.length",
        "var a=[]; a.length=4294967295; a.unshift()",
    ] {
        agrees(source);
    }
}
