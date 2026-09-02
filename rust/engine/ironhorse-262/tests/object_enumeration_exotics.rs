//! Oracle-backed coverage for Object enumeration across exotic receivers.

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
fn keys_values_and_entries_accept_primitive_and_exotic_receivers() {
    for source in [
        "Object.keys([,'x']).join(',')",
        "Object.values('ab').join(',')",
        "JSON.stringify(Object.entries(new Uint8Array([4,5])))",
        "Object.keys(1).length+':'+Object.values(true).length+':'+Object.entries(Symbol('s')).length",
        "var a=[1];a.x=2;Object.entries(a).map(function(p){return p.join('=')}).join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn enumerable_own_properties_use_proxy_traps_and_live_descriptors() {
    for source in [
        "var log=[];var p=new Proxy({a:1,b:2},{ownKeys:function(t){log.push('keys');return ['b','a']},getOwnPropertyDescriptor:function(t,k){log.push('desc:'+k);return Object.getOwnPropertyDescriptor(t,k)},get:function(t,k,r){log.push('get:'+k);return Reflect.get(t,k,r)}});Object.entries(p).map(function(x){return x.join('=')}).join('|')+':'+log.join(',')",
        "var o={get a(){delete this.b;return 1},b:2};Object.values(o).join(',')+':'+Object.hasOwn(o,'b')",
        "var p=new Proxy({a:1},{getOwnPropertyDescriptor:function(t,k){return {value:1,writable:true,enumerable:false,configurable:true}}});Object.keys(p).length",
    ] {
        agrees(source);
    }
}

#[test]
fn own_name_and_symbol_queries_cover_exotic_shapes() {
    for source in [
        "Object.getOwnPropertyNames([1,,3]).join(',')",
        "Object.getOwnPropertyNames(String.fromCodePoint(0x1F600)).join(',')",
        "Object.getOwnPropertyNames(new Uint8Array([4,5])).join(',')",
        "var s=Symbol('s'),a=[];a[s]=1;Object.getOwnPropertySymbols(a)[0]===s",
        "var s=Symbol('s'),p=new Proxy({},{ownKeys:function(){return [s,'x']},getOwnPropertyDescriptor:function(t,k){return {value:1,writable:true,enumerable:true,configurable:true}}});Object.getOwnPropertyNames(p).join(',')+':'+(Object.getOwnPropertySymbols(p)[0]===s)",
        "Object.getOwnPropertyNames('ab').join(',')+':'+Object.getOwnPropertySymbols(1).length",
    ] {
        agrees(source);
    }
}

#[test]
fn descriptor_collection_covers_indices_symbols_and_proxy_descriptors() {
    for source in [
        "var d=Object.getOwnPropertyDescriptors([7]);d[0].value+':'+d[0].enumerable+':'+d.length.value+':'+d.length.enumerable",
        "var d=Object.getOwnPropertyDescriptors('ab');d[0].value+d[1].value+':'+d.length.value+':'+d.length.writable",
        "var d=Object.getOwnPropertyDescriptors(new Uint8Array([4]));d[0].value+':'+d[0].configurable",
        "var s=Symbol('s'),o={};o[s]=9;Object.getOwnPropertyDescriptors(o)[s].value",
        "var log=[];var p=new Proxy({x:1},{ownKeys:function(t){log.push('keys');return ['x']},getOwnPropertyDescriptor:function(t,k){log.push('desc');return Object.getOwnPropertyDescriptor(t,k)}});Object.getOwnPropertyDescriptors(p).x.value+':'+log.join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn reflect_own_keys_uses_the_same_complete_mop() {
    for source in [
        "Reflect.ownKeys([1,,3]).join(',')",
        "Reflect.ownKeys(Object('ab')).join(',')",
        "Reflect.ownKeys(new Uint8Array([4,5])).join(',')",
        "var s=Symbol('s'),a=[];a[s]=1;var k=Reflect.ownKeys(a);k.length+':'+k[0]+':'+(k[1]===s)",
        "var log=[];var p=new Proxy({a:1},{ownKeys:function(){log.push('keys');return ['a']}});Reflect.ownKeys(p).join(',')+':'+log.join(',')",
    ] {
        agrees(source);
    }
}
