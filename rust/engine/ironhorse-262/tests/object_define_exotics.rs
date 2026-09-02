//! Oracle-backed Object.defineProperty/defineProperties exotic coverage.

use ironhorse_262::{dual_run, Agreement};
use ironhorse_vm::Halt;

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
fn define_property_uses_array_and_typed_array_internal_methods() {
    for source in [
        "var a=[];Object.defineProperty(a,'2',{value:7,writable:true,enumerable:true,configurable:true});a.length+':'+a[2]",
        "var a=[1,2];Object.defineProperty(a,'length',{value:1});a.length+':'+('1' in a)",
        "var a=new Uint8Array([1]);Object.defineProperty(a,'0',{value:257});a[0]",
        "var a=new Uint8Array([1]);var ok=false;try{Object.defineProperty(a,'0',{writable:false})}catch(e){ok=e instanceof TypeError}ok+':'+a[0]",
    ] {
        agrees(source);
    }
}

#[test]
fn string_wrapper_definitions_preserve_synthetic_properties() {
    for source in [
        "var s=Object('ab');var ok=false;try{Object.defineProperty(s,'0',{value:'z'})}catch(e){ok=e instanceof TypeError}ok+':'+s[0]",
        "var s=Object('ab');Object.defineProperty(s,'x',{value:3,writable:true,configurable:true});s.x",
        "var s=Object('ab');var ok=false;try{Object.defineProperties(s,{0:{value:'z'},x:{value:1}})}catch(e){ok=e instanceof TypeError}ok+':'+s[0]+':'+('x' in s)",
    ] {
        agrees(source);
    }
}

#[test]
fn ordinary_expandos_work_on_other_exotic_instances() {
    for source in [
        "var m=new Map();Object.defineProperty(m,'x',{value:1});Object.getOwnPropertyDescriptor(m,'x').value",
        "var b=new ArrayBuffer(2);Object.defineProperty(b,'x',{value:1,configurable:true});Object.getOwnPropertyDescriptor(b,'x').configurable",
        "var d=new DataView(new ArrayBuffer(2));Object.defineProperty(d,'x',{value:1});Object.getOwnPropertyDescriptor(d,'x').value",
        "Object.getOwnPropertyDescriptor(new Set(),'missing')===undefined",
    ] {
        agrees(source);
    }
}

#[test]
fn define_properties_collects_every_descriptor_before_defining() {
    for source in [
        "var a=[];Object.defineProperties(a,{2:{value:7,writable:true},length:{writable:false}});a.length+':'+a[2]+':'+Object.getOwnPropertyDescriptor(a,'length').writable",
        "var a=new Uint8Array([1,2]);Object.defineProperties(a,{0:{value:257},1:{value:258}});a.join(',')",
        "var o={};Object.defineProperties(o,1);Reflect.ownKeys(o).length",
        "var o={};var ok=false;try{Object.defineProperties(o,'ab')}catch(e){ok=e instanceof TypeError}ok+':'+Reflect.ownKeys(o).length",
    ] {
        agrees(source);
    }
}

#[test]
fn invalid_later_descriptor_keeps_the_target_untouched() {
    // The pinned XS oracle applies `a` eagerly. ECMA-262's
    // ObjectDefineProperties collects every descriptor before defining any.
    let source = "var o={};var ok=false;try{Object.defineProperties(o,{a:{value:1},b:1})}catch(e){ok=e instanceof TypeError}ok+':'+('a' in o)";
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.ironhorse_halt, Halt::Return);
    assert_eq!(run.ironhorse_result, "true:false");
}

#[test]
fn descriptor_maps_and_descriptors_observe_proxy_operations() {
    for source in [
        "var log=[];var map=new Proxy({x:{value:1}},{ownKeys:function(t){log.push('keys');return Reflect.ownKeys(t)},getOwnPropertyDescriptor:function(t,k){log.push('desc:'+k);return Reflect.getOwnPropertyDescriptor(t,k)},get:function(t,k,r){log.push('get:'+k);return Reflect.get(t,k,r)}});var o={};Object.defineProperties(o,map);o.x+':'+log.join(',')",
        "var log=[];var key={toString:function(){log.push('key');return 'x'}};var d={get value(){log.push('value');return 1}};var o={};Object.defineProperty(o,key,d);o.x+':'+log.join(',')",
        "var log=[];var d=new Proxy({value:1},{has:function(t,k){log.push('has:'+k);return Reflect.has(t,k)},get:function(t,k,r){log.push('get:'+k);return Reflect.get(t,k,r)}});var o={};Object.defineProperty(o,'x',d);o.x+':'+log.join(',')",
        "var log=[];var target=[];var p=new Proxy(target,{defineProperty:function(t,k,d){log.push(k);return Reflect.defineProperty(t,k,d)}});Object.defineProperties(p,{0:{value:1,writable:true,enumerable:true,configurable:true}});p.length+':'+p[0]+':'+log.join(',')",
    ] {
        agrees(source);
    }
}
