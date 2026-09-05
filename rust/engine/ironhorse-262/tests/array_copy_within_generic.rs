//! Oracle-backed coverage for generic `Array.prototype.copyWithin`.

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
fn sparse_inherited_and_array_like_receivers_copy_or_delete() {
    for source in [
        "var a=[1,,3];a.copyWithin(0,1,3);Object.prototype.hasOwnProperty.call(a,0)+':'+a[1]+':'+a[2]",
        "var p={1:'p'};var o=Object.create(p);o[0]='a';o[2]='c';o.length=3;Array.prototype.copyWithin.call(o,0,1,3);o[0]+':'+o[1]+':'+o[2]",
        "var o={0:'a',2:'c',length:3};var r=Array.prototype.copyWithin.call(o,1,0,2);(r===o)+':'+o[0]+':'+o[1]+':'+Object.prototype.hasOwnProperty.call(o,2)",
        "Object.prototype.toString.call(Array.prototype.copyWithin.call(7,0,0))",
        "try{Array.prototype.copyWithin.call('abc',0,1);false}catch(e){e instanceof TypeError}",
        "try{Array.prototype.copyWithin.call(null,0,0);false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn coercion_and_proxy_operations_follow_spec_order() {
    for source in [
        "var log=[];var o={get length(){log.push('length');return 3},0:'a',1:'b',2:'c'};var target={valueOf:function(){log.push('target');return 1}};var start={valueOf:function(){log.push('start');return 0}};var end={valueOf:function(){log.push('end');return 2}};Array.prototype.copyWithin.call(o,target,start,end);log.join(',')+':'+o[0]+o[1]+o[2]",
        "var log=[];var p=new Proxy({0:'a',2:'c',length:3},{get:function(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)},has:function(t,k){log.push('has:'+String(k));return Reflect.has(t,k)},set:function(t,k,v,r){log.push('set:'+String(k)+':'+v);return Reflect.set(t,k,v,r)},deleteProperty:function(t,k){log.push('delete:'+String(k));return Reflect.deleteProperty(t,k)}});Array.prototype.copyWithin.call(p,1,0,2);log.join(',')",
        "var log=[];var p=new Proxy({0:'a',1:'b',2:'c',length:3},{get:function(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)},has:function(t,k){log.push('has:'+String(k));return Reflect.has(t,k)},set:function(t,k,v,r){log.push('set:'+String(k)+':'+v);return Reflect.set(t,k,v,r)}});Array.prototype.copyWithin.call(p,1,0,2);log.join(',')+':'+p[0]+p[1]+p[2]",
    ] {
        agrees(source);
    }
}

#[test]
fn descriptor_failures_and_mapped_arguments_are_observable() {
    for source in [
        "var a=[1,2];Object.defineProperty(a,'1',{writable:false});try{a.copyWithin(1,0,1);false}catch(e){e instanceof TypeError&&a[1]===2}",
        "var a=[,2];Object.defineProperty(a,'1',{configurable:false});try{a.copyWithin(1,0,1);false}catch(e){e instanceof TypeError&&a[1]===2}",
        "var o={0:'a',1:'b',length:2};Object.preventExtensions(o);delete o[1];try{Array.prototype.copyWithin.call(o,1,0,1);false}catch(e){e instanceof TypeError&&!Object.prototype.hasOwnProperty.call(o,1)}",
        "(function(a,b,c){b='z';Array.prototype.copyWithin.call(arguments,0,1,3);return a+':'+b+':'+c+':'+Array.prototype.join.call(arguments,':')})(1,2,3)",
        "(function(a,b){delete arguments[0];Array.prototype.copyWithin.call(arguments,1,0,1);return Object.prototype.hasOwnProperty.call(arguments,1)+':'+b})(1,2)",
    ] {
        agrees(source);
    }
}
