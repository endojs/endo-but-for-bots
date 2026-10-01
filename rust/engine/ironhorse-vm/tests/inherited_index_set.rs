//! An index write honors an inherited property.
//!
//! OrdinarySet consults the prototype chain for a key the receiver lacks: an
//! inherited setter runs and an inherited non-writable value rejects the write.
//! An Array receiver skipped the walk, a String wrapper's characters were missed
//! on it, and a rejected write in strict code did not throw. A Proxy or
//! TypedArray prototype answers by index, and a locked Array refuses only after
//! the walk.
//!
//! Each case runs on its own machine. Every expectation is the XS oracle's
//! answer, except where a case says the specification (and V8) is followed
//! instead; `ironhorse-262/tests/xs_departures.rs` records those departures.
mod common;
use common::TestCompiler;

use ironhorse_vm::{parse_symbols, Interp};

fn run(source: &str) -> String {
    let source = source.to_string();
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || {
            let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
            let mut machine = Interp::new();
            machine.set_source_compiler(std::rc::Rc::new(TestCompiler));
            machine.link_intrinsics(&parse_symbols(&symbols));
            let outcome = machine.run(&code);
            assert!(outcome.completed, "{:?}\n  {source}", outcome.halt);
            outcome.result
        })
        .unwrap()
        .join()
        .unwrap()
}

fn check(cases: &[(&str, &str, &str)]) {
    for (name, source, expected) in cases {
        assert_eq!(run(source), *expected, "{name}: {source}");
    }
}

#[test]
fn an_inherited_index_decides_an_array_write() {
    check(&[
        (
            "setter_on_array_prototype",
            r#"var log = ''; Object.defineProperty(Array.prototype, 0, {set: function (v) { log += 'set' + v; }, configurable: true}); var a = []; a[0] = 1; var r = log + ':' + a.length + ':' + Object.prototype.hasOwnProperty.call(a, 0); delete Array.prototype[0]; r"#,
            r#"set1:0:false"#,
        ),
        (
            "read_only_on_object_prototype",
            r#"Object.defineProperty(Object.prototype, 2, {value: 'ro', writable: false, configurable: true}); var b = []; b[2] = 'w'; var r = b[2] + ':' + b.length; delete Object.prototype[2]; r"#,
            r#"ro:0"#,
        ),
        (
            "read_only_on_array_prototype",
            r#"Object.defineProperty(Array.prototype, 1, {value: 'ro', writable: false, configurable: true}); var c = [1, 2, 3]; c[1] = 'own'; var d = []; d[1] = 'x'; var r = c[1] + ':' + d[1] + d.length; delete Array.prototype[1]; r"#,
            r#"own:ro0"#,
        ),
        (
            "strict",
            r#"'use strict'; var out = []; function t(n, f) { try { out.push(n + ':' + f()); } catch (e) { out.push(n + '!' + e.constructor.name + ':' + e.message); } } Object.defineProperty(Object.prototype, 3, {value: 'ro', writable: false, configurable: true}); t('ro', function () { var b = []; b[3] = 1; }); t('assign', function () { Object.assign([], {3: 1}); }); delete Object.prototype[3]; Object.defineProperty(Array.prototype, 4, {get: function () { return 1; }, configurable: true}); t('getter_only', function () { var b = []; b[4] = 1; }); delete Array.prototype[4]; out.join()"#,
            r#"ro!TypeError:set ?: not writable,assign!TypeError:C: xsSet ?: not writable,getter_only!TypeError:set ?: no setter"#,
        ),
        (
            "proxy_prototype",
            r#"var log = ''; var p = new Proxy({}, {set: function (t, k, v, r) { log += 'trap' + String(k); return true; }}); var a = []; Object.setPrototypeOf(a, p); a[7] = 1; log + ':' + a.length + ':' + Object.prototype.hasOwnProperty.call(a, 7)"#,
            r#"trap7:0:false"#,
        ),
        (
            "own_holes_and_appends",
            r#"var a = []; for (var i = 0; i < 100; i++) a[i] = i; var b = [1, , 3]; b[1] = 2; [a.length, a[99], b.join()].join()"#,
            r#"100,99,1,2,3"#,
        ),
    ]);
}

#[test]
fn an_inherited_string_index_is_read_only() {
    check(&[
        (
            "sloppy",
            r#"var o = Object.create(new String('abc')); o[0] = 'z'; o[0] + ':' + Object.prototype.hasOwnProperty.call(o, 0)"#,
            r#"a:false"#,
        ),
        (
            "own_strict",
            r#"'use strict'; var out = []; function t(n, f) { try { out.push(n + ':' + f()); } catch (e) { out.push(n + '!' + e.constructor.name + ':' + e.message); } } t('own', function () { var s = new String('ab'); s[0] = 'z'; }); t('beyond', function () { var s = new String('ab'); s[5] = 'z'; return s[5]; }); out.join()"#,
            r#"own!TypeError:set ?: not extensible,beyond:z"#,
        ),
        (
            "ordinary_prototype_strict",
            r#"'use strict'; var out = []; function t(n, f) { try { out.push(n + ':' + f()); } catch (e) { out.push(n + '!' + e.constructor.name + ':' + e.message); } } var p = {}; Object.defineProperty(p, 0, {value: 1, writable: false}); var c = Object.create(p); t('proto', function () { c[0] = 2; }); out.join()"#,
            r#"proto!TypeError:set ?: not writable"#,
        ),
        // The specification, as V8; XS answers `wrote b`.
        (
            "string_prototype_strict",
            r#"'use strict'; var o = Object.create(new String('abc')); var r; try { o[1] = 'q'; r = 'wrote ' + o[1]; } catch (e) { r = e.constructor.name; } r"#,
            r#"TypeError"#,
        ),
    ]);
}

/// A non-extensible, frozen or sealed array, or one whose `length` is fixed,
/// meets its own refusal only after the chain: an inherited setter still runs.
#[test]
fn a_locked_array_still_walks_the_chain() {
    check(&[
        (
            "prevent_extensions",
            r#"var log=''; Object.defineProperty(Array.prototype,0,{set:function(v){log+='s'+v},configurable:true}); var a=Object.preventExtensions([]); a[0]=1; delete Array.prototype[0]; log"#,
            r#"s1"#,
        ),
        (
            "frozen",
            r#"var log=''; Object.defineProperty(Array.prototype,0,{set:function(v){log+='s'+v},configurable:true}); var a=Object.freeze([]); a[0]=1; delete Array.prototype[0]; log"#,
            r#"s1"#,
        ),
        (
            "strict",
            r#"'use strict'; var log=''; Object.defineProperty(Array.prototype,0,{set:function(v){log+='s'+v},configurable:true}); var a=Object.preventExtensions([]); var r; try{a[0]=1; r='ok'}catch(e){r=e.name} delete Array.prototype[0]; r+':'+log"#,
            r#"ok:s1"#,
        ),
        (
            "sealed",
            r#"var log=''; Object.defineProperty(Array.prototype,5,{set:function(v){log+='s'+v},configurable:true}); var a=Object.seal([1]); a[5]=1; delete Array.prototype[5]; log+':'+a.length"#,
            r#"s1:1"#,
        ),
        (
            "fixed_length",
            r#"var log=''; Object.defineProperty(Array.prototype,3,{set:function(v){log+='s'+v},configurable:true}); var a=[1]; Object.defineProperty(a,'length',{writable:false}); a[3]=1; delete Array.prototype[3]; log+':'+a.length"#,
            r#"s1:1"#,
        ),
        (
            "strict_own_refusals",
            r#"'use strict'; var a=Object.preventExtensions([1]); var r=[]; try{a[1]=2}catch(e){r.push(e.name)} try{a[0]=5}catch(e){r.push(e.name)} r.push(a.join()); var b=[1]; Object.defineProperty(b,'length',{writable:false}); try{b[1]=1}catch(e){r.push(e.name)} b[0]=3; r.push(b.join()); var c=Object.freeze([1]); try{c[0]=2}catch(e){r.push(e.name)} r.join()"#,
            r#"TypeError,5,TypeError,3,TypeError"#,
        ),
        (
            "sloppy_own_refusals",
            r#"var a=Object.preventExtensions([1]); a[1]=2; a[0]=5; var b=[1]; Object.defineProperty(b,'length',{writable:false}); b[1]=1; b[0]=3; [a.join(),b.join(),b.length].join('|')"#,
            r#"5|3|1"#,
        ),
        (
            "strict_proto_setter",
            r#"'use strict'; var p=Object.create(Array.prototype); Object.defineProperty(p,'0',{set(v){log.push(v)}}); var log=[]; var a=[]; Object.setPrototypeOf(a,p); Object.preventExtensions(a); a[0]=1; log.join()"#,
            r#"1"#,
        ),
        (
            "inherited_read_only",
            r#"var p=[]; Object.defineProperty(p,0,{value:1,writable:false}); var a=[]; Object.setPrototypeOf(a,p); a[0]=2; var r=a.hasOwnProperty(0); try{(function(){'use strict';a[0]=3})()}catch(e){r+=':'+e.name} r"#,
            r#"false:TypeError"#,
        ),
    ]);
}

/// A Proxy or TypedArray on the chain answers by index: a write loop mints no
/// name per index, which exhausted the key space and poisoned the machine.
#[test]
fn a_proxy_or_typed_array_prototype_takes_the_index() {
    check(&[
        (
            "proxy_prototype_loop",
            r#"var a=[]; Object.setPrototypeOf(a,new Proxy(Array.prototype,{})); for(var i=0;i<70000;i++)a[i]=i; var b={}; b.fresh=5; a.length+'|'+b.fresh"#,
            r#"70000|5"#,
        ),
        (
            "typed_array_prototype_loop",
            r#"var a=[]; Object.setPrototypeOf(a,new Uint8Array(0)); for(var i=0;i<70000;i++)a[i]=i; var b={}; b.fresh=5; a.length+'|'+b.fresh"#,
            r#"0|5"#,
        ),
        (
            "ordinary_with_proxy_prototype_loop",
            r#"var o={}; Object.setPrototypeOf(o,new Proxy({},{})); for(var i=0;i<70000;i++)o[i]=i; var b={}; b.fresh=5; Object.keys(o).length+'|'+b.fresh"#,
            r#"70000|5"#,
        ),
        (
            "set_trap_sees_the_key",
            r#"var log=[]; var a=[]; Object.setPrototypeOf(a,new Proxy(Array.prototype,{set:function(t,k,v,r){log.push(typeof k+k);return Reflect.set(t,k,v,r)}})); a[3]=1; a[0]=2; log.join()+'|'+a.length+'|'+a[3]"#,
            r#"string3,string0|4|1"#,
        ),
        (
            "set_trap_refuses",
            r#"var a=[]; Object.setPrototypeOf(a,new Proxy(Array.prototype,{set:function(){return false}})); a[0]=1; var r=a.length; try{(function(){'use strict'; a[1]=1})(); r+=':ok'}catch(e){r+=':'+e.name} r"#,
            r#"0:TypeError"#,
        ),
        (
            "typed_array_prototype",
            r#"var a=[]; var t=new Uint8Array(4); Object.setPrototypeOf(a,t); a[1]=7; a[9]=8; [a.length, a.hasOwnProperty(1), a.hasOwnProperty(9), t[1]].join()"#,
            r#"2,true,false,0"#,
        ),
        (
            "ordinary_with_trapping_proxy",
            r#"var log=[];var t={};var p=new Proxy(t,{set:function(t,k,v,r){log.push(k);return Reflect.set(t,k,v,r)}});var o=Object.create(p);o[2]=1;o.x=1;log.join()+'|'+o.hasOwnProperty(2)"#,
            r#"2,x|true"#,
        ),
    ]);
}
