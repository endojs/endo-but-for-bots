//! Oracle-backed coverage for generic `Array.prototype.splice`.

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
fn sparse_inherited_and_array_like_receivers_preserve_holes() {
    for source in [
        "var a=[0,,2,3];var r=a.splice(1,2,'x');r.length+':'+Object.prototype.hasOwnProperty.call(r,0)+':'+r[1]+':'+a.join(',')",
        "var p={1:'inherited'};var o=Object.create(p);o[0]='a';o[2]='c';o.length=3;var r=Array.prototype.splice.call(o,0,2);r.join(':')+':'+o.length+':'+o[0]",
        "var o={0:'a',2:'c',length:3};var r=Array.prototype.splice.call(o,1,1,'x','y');r.length+':'+o.length+':'+o[0]+o[1]+o[2]+o[3]",
        "Array.prototype.splice.call(7,0,0).length",
        "try{Array.prototype.splice.call('abc',1,1);false}catch(e){e instanceof TypeError}",
        "try{Array.prototype.splice.call(null,0,0);false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn coercion_species_and_proxy_operations_follow_spec_order() {
    for source in [
        "var log=[];var n=2;var o={get length(){log.push('length');return n},set length(v){log.push('set-length');n=v},0:'a',1:'b'};var start={valueOf:function(){log.push('start');return 0}};var count={valueOf:function(){log.push('count');return 1}};Array.prototype.splice.call(o,start,count);log.join(',')",
        "var seen;function R(n){seen=n}var a=[1,2,3];a.constructor={};a.constructor[Symbol.species]=R;var r=a.splice(1,1);(r instanceof R)+':'+seen+':'+r[0]+':'+r.length+':'+a.join(',')",
        "var log=[];var p=new Proxy({0:'a',2:'c',length:3},{get:function(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)},has:function(t,k){log.push('has:'+String(k));return Reflect.has(t,k)},set:function(t,k,v,r){log.push('set:'+String(k)+':'+v);return Reflect.set(t,k,v,r)},deleteProperty:function(t,k){log.push('delete:'+String(k));return Reflect.deleteProperty(t,k)}});Array.prototype.splice.call(p,0,1,'x');log.join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn descriptor_failures_and_mapped_arguments_are_observable() {
    for source in [
        "var a=[1,2];Object.defineProperty(a,'0',{writable:false});try{a.splice(0,1,3);false}catch(e){e instanceof TypeError&&a[0]===1}",
        "var a=[1,2];Object.defineProperty(a,'1',{configurable:false});try{a.splice(0,2);false}catch(e){e instanceof TypeError&&a.length===2}",
        "var a=[1];Object.defineProperty(a,'length',{writable:false});try{a.splice(0,0);false}catch(e){e instanceof TypeError}",
        "(function(a,b,c){b='z';var r=Array.prototype.splice.call(arguments,0,2,'x');return r.join(':')+':'+arguments.length+':'+Array.prototype.join.call(arguments,':')+':'+a+':'+b+':'+c})(1,2,3)",
    ] {
        agrees(source);
    }
}
