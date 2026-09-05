//! Oracle-backed coverage for generic `Array.prototype.fill`.

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
fn sparse_array_like_and_primitive_receivers_are_filled() {
    for source in [
        "var a=new Array(3);a.fill('x',1);a.length+':'+Object.prototype.hasOwnProperty.call(a,0)+':'+a[1]+':'+a[2]",
        "var o={0:'a',length:3};var r=Array.prototype.fill.call(o,7,1,3);(r===o)+':'+o[0]+':'+o[1]+':'+o[2]",
        "var seen='none';Object.defineProperty(Number.prototype,'0',{set:function(v){seen=this.valueOf()+':'+v},configurable:true});Number.prototype.length=1;var r=Array.prototype.fill.call(7,'x');delete Number.prototype[0];delete Number.prototype.length;seen+':'+Object.prototype.toString.call(r)",
        "Object.prototype.toString.call(Array.prototype.fill.call(true,1,0,0))",
        "try{Array.prototype.fill.call('abc','x');false}catch(e){e instanceof TypeError}",
        "try{Array.prototype.fill.call(undefined,1);false}catch(e){e instanceof TypeError}",
    ] {
        agrees(source);
    }
}

#[test]
fn coercion_and_proxy_operations_follow_spec_order() {
    for source in [
        "var log=[];var value={toString:function(){log.push('value');return 'x'}};var o={get length(){log.push('length');return 3}};var start={valueOf:function(){log.push('start');return 1}};var end={valueOf:function(){log.push('end');return 3}};Array.prototype.fill.call(o,value,start,end);log.join(',')+':'+(o[1]===value)+':'+(o[2]===value)",
        "var log=[];var p=new Proxy({length:3},{get:function(t,k,r){log.push('get:'+String(k));return Reflect.get(t,k,r)},set:function(t,k,v,r){log.push('set:'+String(k)+':'+v);return Reflect.set(t,k,v,r)}});Array.prototype.fill.call(p,'x',1);log.join(',')",
        "var n=3;var o={get length(){return n},set length(v){n=v}};var start={valueOf:function(){n=1;return 0}};Array.prototype.fill.call(o,'x',start);n+':'+o[0]+o[1]+o[2]",
    ] {
        agrees(source);
    }
}

#[test]
fn descriptor_failures_and_mapped_arguments_are_observable() {
    for source in [
        "var a=[1,2];Object.defineProperty(a,'1',{writable:false});try{a.fill(9);false}catch(e){e instanceof TypeError&&a[0]===9&&a[1]===2}",
        "var o={length:1};Object.preventExtensions(o);try{Array.prototype.fill.call(o,'x');false}catch(e){e instanceof TypeError&&!Object.prototype.hasOwnProperty.call(o,0)}",
        "var seen='';var p={};Object.defineProperty(p,'0',{set:function(v){seen=v}});var o=Object.create(p);o.length=1;Array.prototype.fill.call(o,'x');seen+':'+Object.prototype.hasOwnProperty.call(o,0)",
        "(function(a,b){b='z';Array.prototype.fill.call(arguments,'x',0,1);return a+':'+b+':'+Array.prototype.join.call(arguments,':')})(1,2)",
    ] {
        agrees(source);
    }
}
