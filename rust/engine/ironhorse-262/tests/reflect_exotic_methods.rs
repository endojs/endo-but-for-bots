//! Oracle-backed coverage for Reflect operations on exotic objects.

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
fn array_internal_methods_drive_reflect_operations() {
    for source in [
        "var a=[];Reflect.defineProperty(a,'2',{value:7,writable:true,enumerable:true,configurable:true})+':'+a.length+':'+a[2]",
        "var a=[1,2];Reflect.defineProperty(a,'length',{value:1})+':'+a.length+':'+('1' in a)",
        "var a=[1];Reflect.deleteProperty(a,'length')+':'+Reflect.deleteProperty(a,'0')+':'+a.length+':'+('0' in a)",
        "var a=[1];Reflect.preventExtensions(a)+':'+Reflect.isExtensible(a)+':'+Reflect.defineProperty(a,'1',{value:2})",
    ] {
        agrees(source);
    }
}

#[test]
fn string_exotic_properties_cannot_be_shadowed_or_deleted() {
    for source in [
        "var s=Object('ab');var d=Reflect.getOwnPropertyDescriptor(s,'0');d.value+':'+d.writable+':'+d.enumerable+':'+d.configurable",
        "var s=Object('ab');Reflect.defineProperty(s,'0',{value:'z'})+':'+Reflect.set(s,'0','z')+':'+Reflect.deleteProperty(s,'0')+':'+s[0]",
        "var s=Object('ab');Reflect.defineProperty(s,'x',{value:3,writable:true,configurable:true})+':'+Reflect.set(s,'x',4)+':'+Reflect.deleteProperty(s,'x')+':'+('x' in s)",
    ] {
        agrees(source);
    }
}

#[test]
fn typed_array_internal_methods_drive_reflect_operations() {
    for source in [
        "var a=new Uint8Array([1]);Reflect.defineProperty(a,'0',{value:257})+':'+a[0]+':'+Reflect.defineProperty(a,'0',{writable:false})+':'+Reflect.deleteProperty(a,'0')",
        "var a=new Uint8Array([1]);Reflect.set(a,'0',258)+':'+a[0]+':'+Reflect.set(a,'-0',9)+':'+a[0]",
        "var a=new Uint8Array([1]);Reflect.preventExtensions(a)+':'+Reflect.isExtensible(a)+':'+Reflect.defineProperty(a,'x',{value:1})",
    ] {
        agrees(source);
    }
}

#[test]
fn prototypes_are_reflective_for_exotic_objects() {
    for source in [
        "var a=[];var p={};Reflect.setPrototypeOf(a,p)+':'+(Reflect.getPrototypeOf(a)===p)",
        "var s=Object('x');var p={};Reflect.setPrototypeOf(s,p)+':'+(Reflect.getPrototypeOf(s)===p)",
        "var a=new Uint8Array(0);var p={};Reflect.setPrototypeOf(a,p)+':'+(Reflect.getPrototypeOf(a)===p)",
        "var a=[];Reflect.preventExtensions(a);Reflect.setPrototypeOf(a,{})+':'+Reflect.setPrototypeOf(a,Reflect.getPrototypeOf(a))",
    ] {
        agrees(source);
    }
}

#[test]
fn reflect_define_property_observes_specification_order_and_descriptor_proxies() {
    for source in [
        "var log=[];var key={toString:function(){log.push('key');return 'x'}};var desc={get value(){log.push('value');return 1}};Reflect.defineProperty({},key,desc);log.join(',')",
        "var log=[];var target={value:1};var desc=new Proxy(target,{has:function(t,k){log.push('has:'+k);return Reflect.has(t,k)},get:function(t,k,r){log.push('get:'+k);return Reflect.get(t,k,r)}});var o={};Reflect.defineProperty(o,'x',desc);o.x+':'+log.join(',')",
        "var log=[];var p=new Proxy({},{defineProperty:function(t,k,d){log.push(k+':'+d.value);return Reflect.defineProperty(t,k,d)}});Reflect.defineProperty(p,'x',{value:4})+':'+p.x+':'+log.join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn callable_proxy_is_accepted_as_an_accessor() {
    // The pinned XS oracle rejects this valid callable Proxy, so pin the
    // IronHorse result directly instead of encoding that oracle limitation.
    let source = "var g=new Proxy(function(){return 3},{});var o={};Reflect.defineProperty(o,'x',{get:g})+':'+o.x";
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.ironhorse_halt, Halt::Return);
    assert_eq!(run.ironhorse_result, "true:3");
}

#[test]
fn non_object_targets_raise_catchable_type_errors() {
    for source in [
        "var ok=false;try{Reflect.getPrototypeOf(1)}catch(e){ok=e instanceof TypeError}ok",
        "var ok=false;try{Reflect.setPrototypeOf('x',null)}catch(e){ok=e instanceof TypeError}ok",
        "var ok=false;try{Reflect.getOwnPropertyDescriptor(null,'x')}catch(e){ok=e instanceof TypeError}ok",
        "var ok=false;try{Reflect.defineProperty(undefined,'x',{})}catch(e){ok=e instanceof TypeError}ok",
        "var ok=false;try{Reflect.ownKeys(Symbol('x'))}catch(e){ok=e instanceof TypeError}ok",
        "var ok=false;try{Reflect.has(1,'x')}catch(e){ok=e instanceof TypeError}ok",
        "var ok=false;try{Reflect.get(1,'x')}catch(e){ok=e instanceof TypeError}ok",
        "var ok=false;try{Reflect.set(1,'x',2)}catch(e){ok=e instanceof TypeError}ok",
        "var ok=false;try{Reflect.deleteProperty(1,'x')}catch(e){ok=e instanceof TypeError}ok",
    ] {
        agrees(source);
    }
}
