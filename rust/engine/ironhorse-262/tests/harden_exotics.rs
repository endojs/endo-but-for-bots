//! Oracle-backed `harden`/`petrify` coverage for exotic objects.

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
fn harden_freezes_array_string_and_collection_expandos_transitively() {
    for source in [
        "var child={x:1};var a=[child];var same=harden(a)===a;a[0]=0;child.x=2;same+':'+Object.isFrozen(a)+':'+Object.isFrozen(child)+':'+(a[0]===child)+':'+child.x",
        "var child={x:1};var s=Object('ab');s.child=child;harden(s);s.child=0;child.x=2;Object.isFrozen(s)+':'+Object.isFrozen(child)+':'+(s.child===child)+':'+child.x",
        "var child={x:1};var m=new Map();m.child=child;harden(m);m.child=0;child.x=2;m.set('k',3);Object.isFrozen(m)+':'+Object.isFrozen(child)+':'+(m.child===child)+':'+child.x+':'+m.get('k')",
    ] {
        agrees(source);
    }
}

#[test]
fn harden_skips_typed_array_elements_but_freezes_expandos() {
    agrees(
        "var child={x:1};var a=new Uint8Array([1]);a.child=child;harden(a);a[0]=2;a.child=0;child.x=2;Object.isExtensible(a)+':'+Object.isFrozen(a)+':'+a[0]+':'+(a.child===child)+':'+Object.isFrozen(child)+':'+child.x",
    );
}

#[test]
fn harden_observes_proxy_internal_methods_in_xs_order() {
    agrees(
        "var log=[];var target={child:{}};var p=new Proxy(target,{preventExtensions:function(t){log.push('prevent');return Reflect.preventExtensions(t)},ownKeys:function(t){log.push('keys');return Reflect.ownKeys(t)},getOwnPropertyDescriptor:function(t,k){log.push('get:'+k);return Reflect.getOwnPropertyDescriptor(t,k)},defineProperty:function(t,k,d){log.push('define:'+k);return Reflect.defineProperty(t,k,d)},getPrototypeOf:function(t){log.push('proto');return Reflect.getPrototypeOf(t)}});harden(p);log.join(',')",
    );
}

#[test]
fn failed_harden_clears_the_visited_mark_for_retry() {
    agrees(
        "var fail=true;var target={x:1};var p=new Proxy(target,{preventExtensions:function(t){if(fail)return false;return Reflect.preventExtensions(t)},ownKeys:function(t){return Reflect.ownKeys(t)},getOwnPropertyDescriptor:function(t,k){return Reflect.getOwnPropertyDescriptor(t,k)},defineProperty:function(t,k,d){return Reflect.defineProperty(t,k,d)}});var caught=false;try{harden(p)}catch(e){caught=e instanceof TypeError}fail=false;harden(p);caught+':'+Object.isFrozen(target)",
    );
}

#[test]
fn petrify_handles_array_typed_array_string_and_proxy_surfaces() {
    for source in [
        "var child={};var a=[child];petrify(a);a[0]=0;child.x=1;Object.isFrozen(a)+':'+(a[0]===child)+':'+Object.isFrozen(child)+':'+child.x",
        "var a=new Uint8Array([1]);petrify(a);a[0]=2;Object.isExtensible(a)+':'+Object.isFrozen(a)+':'+a[0]",
        "var s=Object('ab');petrify(s);Object.isFrozen(s)+':'+s[0]+':'+s.length",
        "var log=[];var target={x:1};var p=new Proxy(target,{preventExtensions:function(t){log.push('prevent');return Reflect.preventExtensions(t)},ownKeys:function(t){log.push('keys');return Reflect.ownKeys(t)},getOwnPropertyDescriptor:function(t,k){log.push('get:'+k);return Reflect.getOwnPropertyDescriptor(t,k)},defineProperty:function(t,k,d){log.push('define:'+k);return Reflect.defineProperty(t,k,d)}});petrify(p);Object.isFrozen(target)+':'+log.join(',')",
    ] {
        agrees(source);
    }
}

#[test]
fn petrify_makes_collection_and_date_internal_data_read_only() {
    for source in [
        "var m=new Map([['a',1]]);petrify(m);var ok=false;try{m.set('b',2)}catch(e){ok=e instanceof TypeError}ok+':'+m.size+':'+m.has('b')",
        "var s=new Set([1]);petrify(s);var ok=false;try{s.clear()}catch(e){ok=e instanceof TypeError}ok+':'+s.size",
        "var k={};var m=new WeakMap([[k,1]]);petrify(m);var ok=false;try{m.delete(k)}catch(e){ok=e instanceof TypeError}ok+':'+m.has(k)",
        "var k={};var s=new WeakSet([k]);petrify(s);var ok=false;try{s.add({})}catch(e){ok=e instanceof TypeError}ok+':'+s.has(k)",
        "var d=new Date(0);petrify(d);var ok=false;try{d.setTime(1)}catch(e){ok=e instanceof TypeError}ok+':'+d.getTime()",
    ] {
        agrees(source);
    }
}
