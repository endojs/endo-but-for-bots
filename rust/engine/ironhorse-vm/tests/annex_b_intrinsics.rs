//! The Annex B members XS ships (ECMA-262 Annex B.2), run inside the
//! Ironhorse guest.
//!
//! Every expectation is the pinned XS oracle's answer, which V8 shares.
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

fn check(cases: &[(&str, &str)]) {
    for (source, expected) in cases {
        assert_eq!(run(source), *expected, "{source}");
    }
}

#[test]
fn object_prototype_proto_accessor() {
    check(&[
        (
            "var o = {}; var r = o.__proto__ === Object.prototype; o.__proto__ = Array.prototype; [r, Object.getPrototypeOf(o) === Array.prototype].join()",
            "true,true",
        ),
        // A computed key reaches the same accessor.
        (
            "var o = {}; var k = '__pro' + 'to__'; [o[k] === Object.prototype, (o[k] = null, Object.getPrototypeOf(o))].join()",
            "true,",
        ),
        (
            "var d = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__'); [typeof d.get, typeof d.set, d.enumerable, d.configurable, d.get.name, d.set.name, d.get.length, d.set.length].join()",
            "function,function,false,true,get __proto__,set __proto__,0,1",
        ),
        (
            "[(5).__proto__ === Number.prototype, 'x'.__proto__ === String.prototype, true.__proto__ === Boolean.prototype, Symbol().__proto__ === Symbol.prototype, (1n).__proto__ === BigInt.prototype].join()",
            "true,true,true,true,true",
        ),
        (
            "var s = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__').set; var r = []; try { s.call(undefined, {}) } catch (e) { r.push(e.name) } r.push(String(s.call(5, {}))); r.push(String(s.call({}, 3))); var o = Object.preventExtensions({}); try { s.call(o, {}) } catch (e) { r.push(e.name) } r.push(String(s.call(o, Object.prototype))); r.join()",
            "TypeError,undefined,undefined,TypeError,undefined",
        ),
        // A defined (not assigned) `__proto__` is an own data property.
        (
            "var o = JSON.parse('{\"__proto__\": 1}'); var c = {['__proto__']: 2}; [o.hasOwnProperty('__proto__'), Object.getPrototypeOf(o) === Object.prototype, o.__proto__, c.__proto__].join()",
            "true,true,1,2",
        ),
        (
            "var o = Object.create(null); [o.__proto__, '__proto__' in o].join()",
            ",false",
        ),
        // The immutable prototype exotic `%Object.prototype%` refuses.
        (
            "try { Object.prototype.__proto__ = {}; 'set' } catch (e) { e.name }",
            "TypeError",
        ),
    ]);
}

#[test]
fn object_prototype_legacy_accessor_helpers() {
    check(&[
        (
            "[Object.prototype.__defineGetter__, Object.prototype.__defineSetter__, Object.prototype.__lookupGetter__, Object.prototype.__lookupSetter__].map(function (f) { return f.name + '/' + f.length; }).join()",
            "__defineGetter__/2,__defineSetter__/2,__lookupGetter__/1,__lookupSetter__/1",
        ),
        (
            "var o = {}; o.__defineGetter__('x', function () { return 7; }); var d = Object.getOwnPropertyDescriptor(o, 'x'); [o.x, d.enumerable, d.configurable, typeof d.set].join()",
            "7,true,true,undefined",
        ),
        (
            "var o = {}; o.__defineSetter__('x', function (v) { this.y = v; }); o.x = 4; var d = Object.getOwnPropertyDescriptor(o, 'x'); [o.y, typeof d.get, o.__lookupSetter__('x') === d.set, String(o.__lookupGetter__('x'))].join()",
            "4,undefined,true,undefined",
        ),
        (
            "var r = []; try { ({}).__defineGetter__('x', 1) } catch (e) { r.push(e.name) } try { Object.prototype.__defineGetter__.call(null, 'x', function () {}) } catch (e) { r.push(e.name) } try { Object.freeze({}).__defineGetter__('x', function () {}) } catch (e) { r.push(e.name) } r.join()",
            "TypeError,TypeError,TypeError",
        ),
        // The callable check precedes `ToPropertyKey`.
        (
            "var log = []; var key = {toString: function () { log.push('key'); return 'k'; }}; try { ({}).__defineGetter__(key, 5) } catch (e) { log.push(e.name) } log.join()",
            "TypeError",
        ),
        (
            "var a = {get q() { return 1; }}; var b = Object.create(a); b.q2 = 1; [b.__lookupGetter__('q') === Object.getOwnPropertyDescriptor(a, 'q').get, String(b.__lookupGetter__('q2')), String(b.__lookupGetter__('zz')), String(b.__lookupSetter__('q'))].join()",
            "true,undefined,undefined,undefined",
        ),
        (
            "var log = []; var p = new Proxy({}, {getOwnPropertyDescriptor: function (t, k) { log.push('gopd:' + String(k)); }, getPrototypeOf: function () { log.push('proto'); return null; }}); [String(p.__lookupGetter__('x')), log.join()].join('|')",
            "undefined|gopd:x,proto",
        ),
        (
            "var s = Symbol('s'); var o = {}; o.__defineGetter__(s, function () { return 3; }); [o[s], o.__lookupGetter__(s)()].join()",
            "3,3",
        ),
        (
            "var a = [1, 2]; a.__defineGetter__('0', function () { return 9; }); var u = new Uint8Array(2), r; try { u.__defineGetter__('0', function () { return 1; }); r = 'defined'; } catch (e) { r = e.name; } [a[0], a.length, r, u[0]].join()",
            "9,2,TypeError,0",
        ),
    ]);
}

#[test]
fn escape_and_unescape() {
    check(&[
        (
            "[escape.name, escape.length, unescape.name, unescape.length, Object.getOwnPropertyDescriptor(globalThis, 'escape').enumerable].join()",
            "escape,1,unescape,1,false",
        ),
        (
            "[escape('a b'), escape('@*_+-./,:;~!'), escape('\\u00e9\\u0100\\uD83D\\uDE00'), escape(), escape('\\uD800')].join('|')",
            "a%20b|@*_+-./%2C%3A%3B%7E%21|%E9%u0100%uD83D%uDE00|undefined|%uD800",
        ),
        // A malformed or truncated escape stays as it is.
        (
            "[unescape('%41%u0042%u00e9%zz%u12%u123g%'), unescape('%%41'), unescape('%u%41'), unescape('%4'), unescape('x%u0041x')].join('|')",
            "AB\u{e9}%zz%u12%u123g%|%A|%uA|%4|xAx",
        ),
        (
            "var u = unescape('%uD83D%uDE00'); [u === '\\uD83D\\uDE00', u.length].join()",
            "true,2",
        ),
        (
            "var s = ''; for (var i = 0; i < 300; i++) s += String.fromCharCode(i); unescape(escape(s)) === s",
            "true",
        ),
        (
            "var r = []; try { escape(Symbol()) } catch (e) { r.push(e.name) } try { new unescape('') } catch (e) { r.push(e.name) } r.join()",
            "TypeError,TypeError",
        ),
    ]);
}
