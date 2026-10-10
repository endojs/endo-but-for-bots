//! Proxy diagnostics from xsProxy.c, and descriptor/integrity errors from
//! xsType.c and xsObject.c. Errors must remain catchable realm TypeErrors.
use ironhorse_262::{dual_run, Agreement};

fn check(body: &str, message: &str) {
    let source = format!("var result = 'not caught'; try {{ {body}; }} catch (error) {{ result = (error instanceof TypeError) + ':' + error.message; }} result");
    let run = dual_run(&source).expect("oracle run");
    assert_eq!(run.oracle_result, format!("true:{message}"), "{body}");
    assert_eq!(run.agreement, Agreement::BothComplete, "{body}: {run:?}");
    assert_eq!(run.ironhorse_result, run.oracle_result, "{body}");
}

#[test]
fn proxy_invariants_match_xs() {
    for (body, message) in [
        ("new Proxy(1,{})", "target: not an object"),
        ("new Proxy({},1)", "handler: not an object"),
        ("Object.getPrototypeOf(new Proxy({}, {getPrototypeOf: 1}))", "(proxy).getPrototypeOf: not a function"),
        ("Object.getPrototypeOf(new Proxy({}, {getPrototypeOf(){return 1}}))", "(proxy).getPrototypeOf: neither object nor null"),
        ("Object.getPrototypeOf(new Proxy(Object.preventExtensions({}), {getPrototypeOf(){return null}}))", "(proxy).getPrototypeOf: different prototype for non-extensible object"),
        ("Reflect.setPrototypeOf(new Proxy(Object.preventExtensions({}), {setPrototypeOf(){return true}}), null)", "(proxy).setPrototypeOf: true for non-extensible object with different prototype"),
        ("Object.isExtensible(new Proxy({}, {isExtensible(){return false}}))", "(proxy).isExtensible: false for extensible object"),
        ("Object.isExtensible(new Proxy(Object.preventExtensions({}), {isExtensible(){return true}}))", "(proxy).isExtensible: true for non-extensible object"),
        ("Reflect.preventExtensions(new Proxy({}, {preventExtensions(){return true}}))", "(proxy).preventExtensions: true for extensible object"),
        ("Reflect.has(new Proxy(Object.freeze({x:1}), {has(){return false}}),'x')", "(proxy).has: false for non-configurable property"),
        ("Reflect.has(new Proxy(Object.preventExtensions({x:1}), {has(){return false}}),'x')", "(proxy).has: false for property of not extensible object"),
        ("new Proxy(Object.freeze({x:1}), {get(){return 2}}).x", "(proxy).get: different value for non-configurable, non-writable property"),
        ("new Proxy(Object.defineProperty({},'x',{get:undefined}), {get(){return 2}}).x", "(proxy).get: different getter for non-configurable property"),
        ("Reflect.set(new Proxy(Object.freeze({x:1}), {set(){return true}}),'x',2)", "(proxy).set: true for non-configurable, non-writable property with different value"),
        ("Reflect.set(new Proxy(Object.defineProperty({},'x',{set:undefined}), {set(){return true}}),'x',2)", "(proxy).set: true for non-configurable property with different setter"),
        ("Reflect.deleteProperty(new Proxy(Object.freeze({x:1}), {deleteProperty(){return true}}),'x')", "(proxy).deleteProperty: true for non-configurable property"),
        ("Reflect.deleteProperty(new Proxy(Object.preventExtensions({x:1}), {deleteProperty(){return true}}),'x')", "(proxy).deleteProperty: true for non-extensible object"),
        ("Reflect.ownKeys(new Proxy({}, {ownKeys(){return ['x','x']}}))", "(proxy).ownKeys: duplicate key"),
        ("Reflect.ownKeys(new Proxy({}, {ownKeys(){return [1]}}))", "(proxy).ownKeys: key is neither string nor symbol"),
        ("Reflect.ownKeys(new Proxy(Object.freeze({x:1}), {ownKeys(){return []}}))", "(proxy).ownKeys: no key for non-configurable property"),
        ("Reflect.ownKeys(new Proxy(Object.preventExtensions({x:1}), {ownKeys(){return []}}))", "(proxy).ownKeys: no key for property of non-extensible object"),
        ("Reflect.ownKeys(new Proxy(Object.preventExtensions({}), {ownKeys(){return ['x']}}))", "(proxy).ownKeys: key for non-existent property of non-extensible object"),
        ("new (new Proxy(function(){}, {construct(){return 1}}))()", "(proxy).construct: not an object"),
    ] { check(body, message); }
}

#[test]
fn proxy_descriptor_invariants_match_xs() {
    for (target, descriptor, message) in [
        ("{}", "1", "descriptor: not an object"),
        ("Object.freeze({x:1})", "undefined", "(proxy).getOwnPropertyDescriptor: no descriptor for non-configurable property"),
        ("Object.preventExtensions({x:1})", "undefined", "(proxy).getOwnPropertyDescriptor: no descriptor for existent property of non-extensible object"),
        ("Object.freeze({x:1})", "({value:2})", "(proxy).getOwnPropertyDescriptor: incompatible descriptor for existent property"),
        ("Object.preventExtensions({})", "({configurable:true})", "(proxy).getOwnPropertyDescriptor: descriptor for non-existent property of non-extensible object"),
        ("{}", "({})", "(proxy).getOwnPropertyDescriptor: non-configurable descriptor for non-existent property"),
        ("{x:1}", "({})", "(proxy).getOwnPropertyDescriptor: non-configurable descriptor for configurable property"),
        ("Object.defineProperty({},'x',{value:1,writable:true})", "({value:1,writable:false})", "(proxy).getOwnPropertyDescriptor: true with non-writable descriptor for non-configurable writable property"),
    ] { check(&format!("Object.getOwnPropertyDescriptor(new Proxy({target}, {{getOwnPropertyDescriptor(){{return {descriptor}}}}}), 'x')"), message); }
    for (target, descriptor, message) in [
        ("Object.preventExtensions({})", "{}", "(proxy).defineProperty: true with descriptor for non-existent property of non-extensible object"),
        ("{}", "{configurable:false}", "(proxy).defineProperty: true with non-configurable descriptor for non-existent property"),
        ("Object.freeze({x:1})", "{value:2}", "(proxy).defineProperty: true with incompatible descriptor for existent property"),
        ("{x:1}", "{configurable:false}", "(proxy).defineProperty: true with non-configurable descriptor for configurable property"),
        ("Object.defineProperty({},'x',{value:1,writable:true})", "{writable:false}", "(proxy).defineProperty: true with non-writable descriptor for non-configurable writable property"),
    ] { check(&format!("Reflect.defineProperty(new Proxy({target}, {{defineProperty(){{return true}}}}), 'x', {descriptor})"), message); }
}

#[test]
fn revoked_and_noncallable_proxy_traps_match_xs() {
    for (trap, operation, target) in [
        ("getPrototypeOf", "Reflect.getPrototypeOf(p)", "{}"),
        ("setPrototypeOf", "Reflect.setPrototypeOf(p,null)", "{}"),
        ("isExtensible", "Reflect.isExtensible(p)", "{}"),
        ("preventExtensions", "Reflect.preventExtensions(p)", "{}"),
        (
            "getOwnPropertyDescriptor",
            "Reflect.getOwnPropertyDescriptor(p,'x')",
            "{}",
        ),
        ("defineProperty", "Reflect.defineProperty(p,'x',{})", "{}"),
        ("has", "Reflect.has(p,'x')", "{}"),
        ("get", "Reflect.get(p,'x')", "{}"),
        ("set", "Reflect.set(p,'x',1)", "{}"),
        ("deleteProperty", "Reflect.deleteProperty(p,'x')", "{}"),
        ("ownKeys", "Reflect.ownKeys(p)", "{}"),
        ("apply", "p()", "function(){}"),
        ("construct", "new p()", "function(){}"),
    ] {
        check(
            &format!("var r=Proxy.revocable({target},{{}});var p=r.proxy;r.revoke();{operation}"),
            &format!("(proxy).{trap}: no handler"),
        );
        check(
            &format!("var p=new Proxy({target},{{{trap}:1}});{operation}"),
            &format!("(proxy).{trap}: not a function"),
        );
    }
}

#[test]
fn descriptor_and_integrity_errors_match_xs() {
    for (body, message) in [
        ("Object.freeze(new Proxy({}, {preventExtensions(){return false}}))", "extensible object"),
        ("Object.seal(new Proxy({}, {preventExtensions(){return false}}))", "extensible object"),
        ("Object.freeze(new Proxy({x:1}, {defineProperty(){return false}}))", "cannot configure property"),
        ("Object.seal(new Proxy({x:1}, {defineProperty(){return false}}))", "cannot configure property"),
        ("Object.preventExtensions(new Proxy({}, {preventExtensions(){return false}}))", "extensible object"),
        ("Object.defineProperty(new Proxy({}, {defineProperty(){return false}}),'x',{})", "invalid descriptor"),
        ("Object.defineProperties(new Proxy({},{}))", "invalid properties"),
        ("Object.defineProperties({}, {x:1})", "descriptor: not an object"),
        ("Object.defineProperty({},'x',{get:1})", "descriptor.get: not a function"),
        ("Object.defineProperty({},'x',{set:1})", "descriptor.set: not a function"),
        ("Object.defineProperty({},'x',{get:null})", "cannot coerce null to object"),
        ("Object.defineProperty({},'x',{set:null})", "cannot coerce null to object"),
        ("Object.defineProperty({},'x',{get:1,value:1})", "descriptor: get and value properties"),
        ("Object.defineProperty({},'x',{get:1,writable:true})", "descriptor: get and writable properties"),
        ("Object.defineProperty({},'x',{set:1,value:1})", "descriptor: set and value properties"),
        ("Object.defineProperty({},'x',{set:1,writable:true})", "descriptor: set and writable properties"),
        ("Object.defineProperty({},'x',{get:1,get set(){throw new TypeError('later accessor')}})", "later accessor"),
        ("Object.prototype.hasOwnProperty.call(null,'x')", "cannot coerce null to object"),
        ("Object.prototype.hasOwnProperty.call(undefined,'x')", "cannot coerce undefined to object"),
    ] { check(body,message); }
}

#[test]
fn ordinary_assign_and_null_ownkeys_errors_match_xs() {
    for (body, message) in [
        (
            "Reflect.ownKeys(new Proxy({}, {ownKeys(){return null}}))",
            "cannot coerce null to object",
        ),
        (
            "Reflect.ownKeys(new Proxy({}, {ownKeys(){return undefined}}))",
            "cannot coerce undefined to object",
        ),
        (
            "Object.assign(Object.freeze({x:1}),{x:2})",
            "C: xsSet x: not writable",
        ),
        (
            "Object.assign(Object.preventExtensions({}),{x:2})",
            "C: xsSet x: not extensible",
        ),
        (
            "Object.assign(Object.defineProperty({},'x',{get(){}}),{x:2})",
            "C: xsSet x: no setter",
        ),
        (
            "Object.assign(Object.create(Object.freeze({x:1})),{x:2})",
            "C: xsSet x: not writable",
        ),
        (
            "Object.assign(Object.freeze({0:1}),{0:2})",
            "C: xsSet ?: not writable",
        ),
        (
            "var k=Symbol('x');var a={};a[k]=1;var b={};b[k]=2;Object.assign(Object.freeze(a),b)",
            "C: xsSet [x]: not writable",
        ),
    ] {
        check(body, message);
    }
}

#[test]
fn generic_array_property_failures_match_xs() {
    for (body, message) in [
        ("Array.prototype.push.call(Object.preventExtensions({length:0}),1)", "C: xsSet ?: not extensible"),
        ("Array.prototype.push.call(Object.freeze({length:0}))", "C: xsSet length: not writable"),
        ("Array.prototype.pop.call(Object.freeze({length:0}))", "C: xsSet length: not writable"),
        ("Array.prototype.pop.call(Object.freeze({0:1,length:1}))", "delete ?: not configurable"),
        ("Array.prototype.shift.call(Object.freeze({0:1,1:2,length:2}))", "C: xsSet ?: not writable"),
        ("Array.prototype.unshift.call(Object.preventExtensions({0:1,length:1}),2)", "C: xsSet ?: not extensible"),
        ("Array.prototype.reverse.call(Object.freeze({0:1,1:2,length:2}))", "C: xsSet ?: not writable"),
        ("Array.prototype.reverse.call(Object.defineProperty({1:2,length:2},'1',{configurable:false}))", "delete ?: not configurable"),
        ("Array.prototype.reverse.call(Object.defineProperty({0:1,length:2},'0',{configurable:false}))", "delete ?: not configurable"),
        ("Array.prototype.splice.call(Object.freeze({0:1,1:2,length:2}),0,1)", "C: xsSet ?: not writable"),
        ("Array.prototype.copyWithin.call(Object.freeze({0:1,1:2,length:2}),0,1)", "C: xsSet ?: not writable"),
        ("Array.prototype.fill.call(Object.freeze({0:1,length:1}),2)", "C: xsSet ?: not writable"),
        ("Array.prototype.sort.call(Object.freeze({0:2,1:1,length:2}))", "C: xsSet ?: not writable"),
        ("Array.prototype.fill.call(Object.defineProperty({length:1},'0',{get(){}}),2)", "C: xsSet ?: no setter"),
    ] { check(body,message); }
}

#[test]
fn array_species_define_failures_match_xs() {
    for method in [
        "map(function(x){return x})",
        "filter(function(){return true})",
        "flat()",
        "flatMap(function(x){return [x]})",
        "concat([])",
        "slice(0)",
        "splice(0,1)",
    ] {
        check(&format!("var a=[1];a.constructor={{[Symbol.species]:function(){{return Object.preventExtensions({{}})}}}};a.{method}"), "define 0: not configurable");
    }
}
