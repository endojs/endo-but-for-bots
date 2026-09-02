//! Generic `Array.prototype.flat` and `flatMap` semantics.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "{source} (halt: {:?}; oracle error: {:?}; ironhorse error: {:?})",
        run.ironhorse_halt,
        run.oracle_error,
        run.ironhorse_error,
    );
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn flat_accepts_sparse_array_like_primitive_and_arguments_receivers() {
    assert_result_agrees(
        "var p={1:[2,,3]}; var o=Object.create(p); o[0]=[0,[1]]; o.length=3; Array.prototype.flat.call(o,2).join(',')",
        "0,1,2,3",
    );
    assert_result_agrees(
        "Array.prototype.flat.call('ab').join(':')+','+Array.prototype.flat.call(true).length",
        "a:b,0",
    );
    assert_result_agrees(
        "(function(a,b){a=[1,,2];b=3;return Array.prototype.flat.call(arguments).join(',')})(0,0)",
        "1,2,3",
    );
}

#[test]
fn flat_observes_depth_length_species_and_proxy_operations() {
    assert_result_agrees("[[1]].flat(undefined)[0]", "1");
    assert_result_agrees(
        "var log=[]; var depth={valueOf:function(){log.push('depth');return 1}}; var a={0:[1],get length(){log.push('length');return 1}}; Array.prototype.flat.call(a,depth); log.join(',')",
        "length,depth",
    );
    assert_result_agrees(
        "var log=[]; var c={}; Object.defineProperty(c,Symbol.species,{get:function(){log.push('species');return function(n){log.push('ctor:'+n);return {}}}}); var a=[7]; a.constructor=c; var r=a.flat(); log.join('|')+','+r[0]+','+('length' in r)",
        "species|ctor:0,7,false",
    );
    assert_result_agrees(
        "var log=[]; var a=[[1]]; var p=new Proxy(a,{has:function(t,k){log.push('h'+k);return k in t},get:function(t,k){log.push('g'+k);return t[k]}}); Array.prototype.flat.call(p).join(',')+':'+log.join('|')",
        "1:glength|gconstructor|h0|g0",
    );
}

#[test]
fn flat_propagates_receiver_depth_proxy_and_target_failures() {
    assert_result_agrees(
        "var a=false,b=false,c=false; try{Array.prototype.flat.call(null)}catch(e){a=e instanceof TypeError} try{[1].flat(1n)}catch(e){b=e instanceof TypeError} var p=Proxy.revocable([],{});p.revoke();try{[p.proxy].flat()}catch(e){c=e instanceof TypeError} ''+a+','+b+','+c",
        "true,true,true",
    );
    assert_result_agrees(
        "var c={}; Object.defineProperty(c,Symbol.species,{value:function(){return Object.preventExtensions({})}}); var a=[1];a.constructor=c;var caught=false;try{a.flat()}catch(e){caught=e instanceof TypeError} caught",
        "true",
    );
    assert_result_agrees(
        "var q=Proxy.revocable([],{});var p=q.proxy;q.revoke();var z=[p].flat(0)[0]===p;var n=[p].flat(-1)[0]===p;var t=false;try{[p].flat(1)}catch(e){t=e instanceof TypeError}''+z+','+n+','+t",
        "true,true,true",
    );
}

#[test]
fn flat_map_observes_callback_receiver_holes_and_mutation() {
    assert_result_agrees(
        "var seen=[]; var ctx={x:4}; var o={0:1,2:3,length:3}; Object.prototype[1]=2; var r=Array.prototype.flatMap.call(o,function(v,k,self){seen.push(this===ctx&&self===o&&k+1===v);if(k===0)delete o[2];return [v,v]},ctx); delete Object.prototype[1]; seen.join(',')+':'+r.join(',')",
        "true,true:1,1,2,2",
    );
    assert_result_agrees(
        "var a=[1,2]; var r=a.flatMap(function(v,k){if(k===0){delete a[1];Object.prototype[1]=7}return [v]});delete Object.prototype[1];r.join(',')",
        "1,7",
    );
}

#[test]
fn flat_map_validates_in_order_and_flattens_only_arrays() {
    assert_result_agrees(
        "var log=[];var o={get length(){log.push('length');return 0}};try{Array.prototype.flatMap.call(o,1)}catch(e){log.push(e instanceof TypeError)}log.join(',')",
        "length,true",
    );
    assert_result_agrees(
        "[1].flatMap(function(){return {0:'x',length:1}})[0].length+','+[1].flatMap(function(){return [[2]]}).join(',')",
        "1,2",
    );
    assert_result_agrees(
        "var calls=0;var c={};Object.defineProperty(c,Symbol.species,{value:function(n){calls++;return {}}});var a=[2];a.constructor=c;var r=a.flatMap(function(v){return [v,v+1]});calls+','+r[0]+','+r[1]+','+('length' in r)",
        "1,2,3,false",
    );
}

#[test]
fn function_metadata_matches_ecmascript() {
    assert_result_agrees(
        "Array.prototype.flat.name+','+Array.prototype.flat.length+','+Array.prototype.flatMap.name+','+Array.prototype.flatMap.length",
        "flat,0,flatMap,1",
    );
}

#[test]
fn flat_map_retains_calibrated_dense_metering() {
    for source in [
        "[5].flatMap(function(x){return [x,x,x]}).length",
        "[1,2,3].flatMap(function(x){return [x,x]}).length",
    ] {
        let run = dual_run(source).expect("pinned XS oracle is available");
        assert_eq!(
            run.ironhorse_meter_raw,
            run.oracle_meter_raw,
            "{source}: oracle={} ({}) ironhorse={} ({})",
            run.oracle_computrons,
            run.oracle_meter_raw,
            run.ironhorse_computrons,
            run.ironhorse_meter_raw,
        );
    }
}
