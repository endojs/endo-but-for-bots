//! Programs that once stopped Ironhorse with a `NotImplemented` halt, each
//! against the pinned XS oracle (V8 agrees on each unless noted).
//!
//! A halt never agrees with an XS answer, so each of these failed before
//! its fix.

use ironhorse_262::dual_run;

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.observables_agree(),
        "observable divergence: {source}\n  oracle={} ironhorse={}\n  ironhorse_halt={:?}",
        run.oracle_result,
        run.ironhorse_result,
        run.ironhorse_halt,
    );
}

#[test]
fn a_symbol_coerced_to_a_string_or_number_throws() {
    for program in [
        "`${Symbol('a')}`",
        "`x${Object(Symbol())}y`",
        "String(Object(Symbol('w')))",
        "var s = Symbol(); s++",
        "var s = Symbol(); s--",
        "var s = Symbol(); ++s",
        "var s = Symbol(); --s",
        "var o = { p: Symbol() }; o.p++",
        "var a = [Symbol()]; a[0]--",
    ] {
        agrees(&format!(
            "try {{ {program}; 'ok' }} catch (e) {{ String(e) }}"
        ));
    }
    agrees("String(Symbol('described'))");
}

#[test]
fn deleting_a_super_reference_throws_after_the_reference_evaluates() {
    for program in [
        "class A { m() { delete super.x; } } new A().m()",
        "class A { m() { return delete super[1 + 1]; } } new A().m()",
        "class A { static m() { delete super.x; } } A.m()",
        "var o = { m() { return delete super.x; } }; Object.setPrototypeOf(o, null); o.m()",
        "var o = { m() { return delete super[0]; } }; Object.setPrototypeOf(o, null); o.m()",
        // The key is evaluated, not converted to a property key.
        "var log = ''; class A { m() { delete super[(log += 'k', { toString() { log += 's'; return 'x'; } })]; } } \
         try { new A().m(); } catch (e) { log += e.constructor.name; } throw log",
        // A derived constructor reads `this` first.
        "class A extends Object { constructor() { delete super.x; super(); } } new A()",
    ] {
        agrees(&format!(
            "try {{ {program}; 'ok' }} catch (e) {{ String(e) }}"
        ));
    }
}

#[test]
fn atomics_validate_and_convert_their_arguments() {
    for program in [
        // ValidateIntegerTypedArray.
        "Atomics.add({}, 0, 1)",
        "Atomics.add(1, 0, 1)",
        "Atomics.load(new Float64Array(1), 0)",
        "Atomics.load(new Float32Array(1), 0)",
        "Atomics.store(new Uint8ClampedArray(1), 0, 1)",
        "var t = new Int8Array(4); $262.detachArrayBuffer(t.buffer); Atomics.load(t, 9)",
        // ToIndex, and the range check after it.
        "Atomics.add(new Int32Array(1), '0', 2)",
        "Atomics.load(new Int8Array(1), 'x')",
        "Atomics.load(new Int8Array(1), -0.5)",
        "var t = new Int8Array(4); t[0] = 5; Atomics.load(t, { valueOf() { return 0; } })",
        "Atomics.load(new Int8Array(1), 1)",
        "Atomics.load(new Int8Array(1), -1)",
        "Atomics.load(new Int8Array(1), 2 ** 53)",
        "Atomics.load(new Int8Array(1), Infinity)",
        "Atomics.load(new Int8Array(4), 0n)",
        "Atomics.load(new Int8Array(4), Symbol())",
        "var t = new Int8Array(new ArrayBuffer(8), 2, 3); Atomics.store(t, 3, 7)",
        // The operands, after the index, and the buffer checked again.
        "var t = new Int32Array(1); Atomics.store(t, 0, '7'); t[0]",
        "var t = new Int8Array(4); Atomics.store(t, 0, '-0')",
        "var t = new Int8Array(4); Object.is(Atomics.store(t, 0, -0), 0)",
        "var t = new Int8Array(4); Atomics.store(t, 0)",
        "var t = new Int8Array(4); Atomics.store(t, 0, Infinity) + ',' + t[0]",
        "var t = new Int8Array(4); Atomics.store(t, 0, { valueOf() { $262.detachArrayBuffer(t.buffer); return 1; } })",
        "var t = new Int8Array(4); Atomics.compareExchange(t, 0, { valueOf() { $262.detachArrayBuffer(t.buffer); return 0; } }, 1)",
        "var log = []; var t = new Int8Array(4); try { Atomics.add(t, { valueOf() { log.push('i'); return 9; } }, \
         { valueOf() { log.push('v'); return 1; } }); } catch (e) { log.push(e.constructor.name); } log.join()",
        "var log = []; var t = new Int8Array(4); Atomics.compareExchange(t, { valueOf() { log.push('i'); return 0; } }, \
         { valueOf() { log.push('e'); return 0; } }, { valueOf() { log.push('r'); return 1; } }); log.join() + t[0]",
        "var log = []; try { Atomics.add(new Float64Array(4), { valueOf() { log.push('i'); return 0; } }, 1); } \
         catch (e) { log.push(e.message); } log.join()",
        "var t = new BigInt64Array(4); Atomics.store(t, 0, '12')",
        "var t = new BigInt64Array(4); Atomics.store(t, 0, 1)",
        "var t = new BigInt64Array(4); Atomics.store(t, 0, '1.5')",
        "var t = new BigInt64Array(4); Atomics.store(t, 0, { valueOf() { return 5n; } })",
        "var t = new BigInt64Array(4); Atomics.store(t, 0, 2n ** 70n)",
        // isLockFree converts its size.
        "[Atomics.isLockFree('4'), Atomics.isLockFree(4.5), Atomics.isLockFree({ valueOf() { return 4; } })].join()",
        "[1, 2, 3, 4, 5, 8].map(Atomics.isLockFree).join()",
        "Atomics.isLockFree(Symbol())",
        "Atomics.isLockFree(4n)",
    ] {
        agrees(&format!(
            "try {{ String({program}) }} catch (e) {{ String(e) }}"
        ));
    }
}

#[test]
fn atomics_wrap_operands_to_the_element_width() {
    for program in [
        "var t = new Int32Array(4); t[0] = 1; Atomics.add(t, 0, 2 ** 60); t[0]",
        "var t = new Int32Array(4); Atomics.store(t, 0, 2 ** 53 + 2); t[0]",
        "var t = new Int8Array(4); t[0] = 1; Atomics.compareExchange(t, 0, 257, 9) + ',' + t[0]",
        "var t = new Int8Array(4); Atomics.store(t, 0, 300) + ',' + t[0]",
        "var t = new Uint32Array(4); Atomics.add(t, 0, -1); Atomics.add(t, 0, 0)",
        "var t = new Uint32Array(4); [Atomics.store(t, 0, -1), Atomics.load(t, 0)].join()",
        "var t = new Int16Array(4); [Atomics.add(t, 1, 5), Atomics.sub(t, 1, 7), Atomics.and(t, 1, 0xff), \
         Atomics.or(t, 1, 0x100), Atomics.xor(t, 1, 3), Atomics.exchange(t, 1, -1), Atomics.load(t, 1)].join()",
        "var t = new Uint8Array(4); [Atomics.add(t, 1, 300), Atomics.sub(t, 1, -7), t[1]].join()",
        "var t = new BigUint64Array(4); Atomics.sub(t, 0, 1n); Atomics.load(t, 0)",
        "var t = new BigInt64Array(4); Atomics.sub(t, 0, 1n); Atomics.load(t, 0)",
        "var t = new BigInt64Array(4); Atomics.store(t, 1, true); [Atomics.exchange(t, 1, -5n), t[1]].join()",
        "var t = new BigInt64Array(4); t[0] = 3n; [Atomics.compareExchange(t, 0, 3n, 9n), t[0], \
         Atomics.compareExchange(t, 0, 2n ** 64n + 9n, 1n), t[0]].join()",
        "var t = new Int32Array(new SharedArrayBuffer(8)); Atomics.add(t, 1, 5); Atomics.load(t, 1)",
        "var t = new Int8Array(new ArrayBuffer(8), 2, 3); Atomics.store(t, 2, 7); new Int8Array(t.buffer)[4]",
    ] {
        agrees(program);
    }
}

#[test]
fn a_buffer_options_object_without_max_byte_length_is_fixed_length() {
    for program in [
        "new ArrayBuffer(4, {}).resizable",
        "new ArrayBuffer(4, { maxByteLength: undefined }).resizable",
        "new ArrayBuffer(8, { maxByteLength: 4 })",
        "new ArrayBuffer(8, { maxByteLength: -1 })",
        "new ArrayBuffer(8, { get maxByteLength() { throw new SyntaxError('g') } })",
        "new ArrayBuffer({ valueOf() { throw new EvalError('len') } }, { get maxByteLength() { throw new SyntaxError('g') } })",
        "new ArrayBuffer(4, new Proxy({}, { get(t, k) { return String(k) } }))",
        "new ArrayBuffer(4, function () {}).byteLength",
        "new ArrayBuffer(4, 16).byteLength",
        "new ArrayBuffer(4, { maxByteLength: 2 ** 53 })",
        "new SharedArrayBuffer(8, { maxByteLength: 4 })",
        "new SharedArrayBuffer(4, { maxByteLength: undefined }).byteLength",
        "(function () { var log = []; new ArrayBuffer(4, { get maxByteLength() { log.push('m'); } }); return log.join() })()",
        "(function () { var b = new ArrayBuffer(2); b.constructor = { [Symbol.species]: function () { return 1 } }; return b.slice() })()",
    ] {
        agrees(&format!(
            "try {{ String({program}) }} catch (e) {{ 'throw ' + String(e) }}"
        ));
    }
}

#[test]
fn resize_checks_its_receiver_and_length_before_refusing() {
    for program in [
        "ArrayBuffer.prototype.resize.call(1, 0)",
        "ArrayBuffer.prototype.resize.call(new SharedArrayBuffer(1), 0)",
        "new ArrayBuffer(8).resize(4)",
        "new ArrayBuffer(8).resize(-1)",
        "new ArrayBuffer(8).resize()",
        "new ArrayBuffer(8).resize('3')",
        "new ArrayBuffer(8).resize({ valueOf() { throw new EvalError('v') } })",
        "(function () { var b = new ArrayBuffer(8); $262.detachArrayBuffer(b); return b.resize(1); })()",
        "(function () { var b = new ArrayBuffer(8); return b.resize({ valueOf() { $262.detachArrayBuffer(b); return 1 } }); })()",
    ] {
        agrees(&format!(
            "try {{ String({program}) }} catch (e) {{ 'throw ' + String(e) }}"
        ));
    }
}

#[test]
fn concat_joins_buffers_through_the_species_constructor() {
    for program in [
        "new ArrayBuffer(2).concat(new ArrayBuffer(3)).byteLength",
        "new Uint8Array(new Uint8Array([1,2]).buffer.concat(new Uint8Array([3]).buffer, new Uint8Array([4,5]).buffer)).join()",
        "new ArrayBuffer(2).concat(new SharedArrayBuffer(3)).byteLength",
        "new Uint8Array(new Uint8Array([9]).buffer.concat(new Uint8Array(new SharedArrayBuffer(2)).fill(7).buffer)).join()",
        "new ArrayBuffer(2).concat({}).byteLength",
        "new ArrayBuffer(2).concat(new ArrayBuffer(1), 5).byteLength",
        "ArrayBuffer.prototype.concat.call(new SharedArrayBuffer(2)).byteLength",
        "ArrayBuffer.prototype.concat.call({})",
        "new ArrayBuffer(2).concat().byteLength",
        "(function () { var b = new ArrayBuffer(4); $262.detachArrayBuffer(b); return b.concat(new ArrayBuffer(2)).byteLength })()",
        "(function () { class B extends ArrayBuffer {} var r = new B(2).concat(new ArrayBuffer(1)); return r instanceof B })()",
        "(function () { var b = new ArrayBuffer(2); b.constructor = { [Symbol.species]: function () { return b } }; return b.concat() })()",
        "(function () { var b = new ArrayBuffer(2); b.constructor = { [Symbol.species]: function () { return 1 } }; return b.concat() })()",
        "(function () { var b = new ArrayBuffer(2); b.constructor = { [Symbol.species]: function () { return 1 } }; return b.slice() })()",
        "(function () { var b = new ArrayBuffer(2); b.constructor = { [Symbol.species]: function () { return new ArrayBuffer(1) } }; return b.concat() })()",
        "(function () { var b = new ArrayBuffer(2); b.constructor = { [Symbol.species]: function () { return new SharedArrayBuffer(4) } }; return b.concat() })()",
        "(function () { var a = new ArrayBuffer(3); var b = new ArrayBuffer(2); b.constructor = { [Symbol.species]: function (n) { $262.detachArrayBuffer(a); return new ArrayBuffer(n) } }; return b.concat(a).byteLength })()",
        "(function () { var a = new Uint8Array([1, 2, 3]).buffer; var b = new Uint8Array([4]).buffer; b.constructor = { [Symbol.species]: function (n) { $262.detachArrayBuffer(a); return new ArrayBuffer(n + 1) } }; return new Uint8Array(b.concat(a, b)).join() })()",
    ] {
        agrees(&format!(
            "try {{ String({program}) }} catch (e) {{ 'throw ' + String(e) }}"
        ));
    }
}

/// A conditional that jumps over more than 32 KiB of bytecode takes the
/// 4-byte `branch_else`/`branch_if` forms.
#[test]
fn a_conditional_can_jump_over_a_long_body() {
    let body = "a = a + 1; ".repeat(2500);
    agrees(&format!(
        "var a = 0; var x = true; if (x) {{ {body} }} else {{ a = -1; }} \
         var b = 0; if (!x) {{ {body} }} else {{ b = 7; }} \
         var c = 0; while (c < 2) {{ c++; {body} }} \
         var d = x && (function () {{ {body} return 3; }})(); \
         var e = !x || (function () {{ {body} return 4; }})(); \
         [a, b, c, d, e].join()"
    ));
}

#[test]
fn a_bigint_loosely_equals_a_string_holding_its_value() {
    for pair in [
        "1n == '1'",
        "'1' == 1n",
        "1n != '1'",
        "0n == '-0'",
        "0n == ''",
        "0n == ' '",
        "1n == ' 1 '",
        "1n == '1n'",
        "1n == '0x1'",
        "1n == '1.0'",
        "-1n == '-1'",
        "-1n == '-0x1'",
        "2n ** 70n == '1180591620717411303424'",
        "2n ** 70n == '1180591620717411303425'",
        "1n == '1e0'",
        "1n == '\\u00a01'",
        "1n === '1'",
        "255n == '0xff'",
        "5n == '0b101'",
        "8n == '0o10'",
        "1n == '+1'",
        "1n == Object('1')",
        "Object(1n) == '1'",
    ] {
        agrees(&format!("String({pair})"));
    }
}

#[test]
fn a_super_member_key_converts_after_the_base_is_found() {
    for program in [
        "class A { m() { return super[{ toString() { return \"toString\" } }] === Object.prototype.toString } } new A().m()",
        "var log = []; var o = { m() { try { super[{ toString() { log.push(\"s\"); return \"x\" } }] = (log.push(\"v\"), 2) } catch (e) { log.push(e.constructor.name) } } }; Object.setPrototypeOf(o, null); o.m(); log.join()",
        "var log = []; var o = { m() { try { return super[{ toString() { log.push(\"s\"); return \"x\" } }] } catch (e) { log.push(e.constructor.name) } } }; Object.setPrototypeOf(o, null); o.m(); log.join()",
        "var log = []; var o = { m() { super[{ toString() { log.push(\"s\"); return \"x\" } }] = (log.push(\"v\"), 2) } }; o.m(); log.join() + o.x",
        "var log = []; var p = { x: 10 }; var o = { __proto__: p, m() { super[{ toString() { log.push(\"s\"); return \"x\" } }] += (log.push(\"v\"), 2); return o.x } }; [o.m(), log.join(), p.x].join()",
        "var log = []; var p = { x: 10 }; var o = { __proto__: p, m() { return super[{ toString() { log.push(\"s\"); return \"x\" } }]++ } }; [o.m(), log.join(), o.x, p.x].join()",
        "var p = { f() { return this === o } }; var o = { __proto__: p, m() { return super[{ [Symbol.toPrimitive]() { return \"f\" } }]() } }; o.m()",
        "var s = Symbol(); var p = { [s]: 3 }; var o = { __proto__: p, m() { return super[Object(s)] } }; o.m()",
        "var p = { 1: \"one\" }; var o = { __proto__: p, m() { return super[{ valueOf() { return 2 }, toString() { return \"1\" } }] } }; o.m()",
        "var o = { m() { return super[{ toString() { throw new EvalError(\"k\") } }] } }; try { o.m() } catch (e) { e.constructor.name }",
        "var o = { m() { return delete super[{ toString() { throw new EvalError(\"k\") } }] } }; try { o.m() } catch (e) { e.constructor.name }",
        "class B { static get x() { return \"bx\" } } class C extends B { static m() { return super[{ toString() { return \"x\" } }] } } C.m()",
    ] {
        agrees(program);
    }
}

#[test]
fn a_direct_eval_call_to_a_shadowed_eval_is_an_ordinary_call() {
    for program in [
        "function f() { var eval = function (x) { return 'shadow ' + x; }; return eval('1'); } f()",
        "function f() { var eval = 1; try { return eval('1'); } catch (e) { return String(e); } } f()",
        "function f() { var eval = function () { return arguments.length; }; return eval(1, 2, 3); } f()",
        "function f(eval) { return eval('x'); } f(function (s) { return s + '!'; })",
        "function g() { var eval = function (x) { return new.target === undefined && x; }; return eval(5); } g()",
        "var eval = function (x) { return 'global ' + x; }; eval('1')",
        "var o = { eval(x) { return [this === o, x].join(); } }; with (o) { eval('2') }",
        // A shadowed eval in tail position.
        "function t(n) { 'use strict'; let eval = function (k) { return k; }; return eval(n); } t(4)",
        "var e = eval; function f() { var eval = e; var x = 'local'; return eval('typeof x'); } f()",
    ] {
        agrees(program);
    }
}

#[test]
fn json_parse_keeps_a_lone_surrogate() {
    for program in [
        "JSON.parse(String.fromCharCode(34, 0xd800, 34)).length",
        "JSON.parse(String.fromCharCode(34, 0xd800, 34)).charCodeAt(0)",
        "JSON.parse(\"[\\\"a\" + String.fromCharCode(0xdc00) + \"b\\\", 1]\")[0].length",
        "JSON.parse(\"[\\\"a\" + String.fromCharCode(0xdc00) + \"b\\\", 1]\")[0].charCodeAt(1)",
        "(function () { try { JSON.parse(String.fromCharCode(0xd800)) } catch (e) { return e.constructor.name } })()",
        "(function () { try { JSON.parse(\"[1, \" + String.fromCharCode(0xdfff) + \"]\") } catch (e) { return e.constructor.name } })()",
        "(function () { var s; JSON.parse(String.fromCharCode(34, 0xd800, 34), function (k, v, c) { s = c && c.source; return v }); return [s.length, s.charCodeAt(1)].join() })()",
        "(function () { var s; JSON.parse(String.fromCharCode(34, 0xe9, 0xd83d, 0xde00, 34), function (k, v, c) { s = c && c.source; return v }); return [s.length, s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)].join() })()",
        "JSON.parse(String.fromCharCode(34, 0xd800, 0xdc00, 34)).length",
        "JSON.parse(String.fromCharCode(34, 0xdbff, 0xd800, 34)).length",
        "JSON.parse(String.fromCharCode(34, 0xdc00, 0xd800, 0xdc00, 0xd800, 34)).split(\"\").map(function (c) { return c.charCodeAt(0) }).join()",
        "Object.keys(JSON.parse(\"{\\\"\" + String.fromCharCode(0xd834) + \"\\\": 1}\"))[0].charCodeAt(0)",
        "JSON.parse(\"{\\\"\" + String.fromCharCode(0xd834) + \"\\\": \" + \"\\\"\" + String.fromCharCode(0xdd1e) + \"x\\\"}\")[String.fromCharCode(0xd834)].length",
        "JSON.parse(String.fromCharCode(34, 0xe9, 0x20ac, 0xd83d, 0xde00, 34)).length",
        "JSON.stringify(JSON.parse(String.fromCharCode(34, 0xd800, 34)))",
        "JSON.parse(\"\\\"\\\\ud800\\\"\").length",
    ] {
        agrees(&format!("String({program})"));
    }
}

#[test]
fn generic_array_methods_box_a_primitive_receiver() {
    for program in [
        "Array.prototype.indexOf.call(\"abc\", \"b\")",
        "Array.prototype.lastIndexOf.call(\"abcb\", \"b\")",
        "Array.prototype.includes.call(\"abc\", \"c\")",
        "Array.prototype.at.call(\"abc\", -1)",
        "Array.prototype.map.call(\"abc\", function (c) { return c + c }).join()",
        "Array.prototype.filter.call(\"abcd\", function (c, i) { return i % 2 }).join()",
        "Array.prototype.forEach.call(\"ab\", function (c, i, o) { globalThis.r = (globalThis.r || \"\") + c + i + typeof o }); r",
        "Array.prototype.some.call(\"abc\", function (c) { return c === \"b\" })",
        "Array.prototype.every.call(true, function () { return false })",
        "Array.prototype.find.call(\"abc\", function (c) { return c > \"a\" })",
        "Array.prototype.findIndex.call(\"abc\", function (c) { return c > \"a\" })",
        "Array.prototype.findLast.call(\"abc\", function (c) { return c > \"a\" })",
        "Array.prototype.findLastIndex.call(\"abc\", function (c) { return c > \"z\" })",
        "Array.prototype.reduce.call(\"abc\", function (a, c) { return a + c.toUpperCase() })",
        "Array.prototype.reduceRight.call(\"abc\", function (a, c) { return a + c }, \"\")",
        "Array.prototype.map.call(5, function () { return 1 }).length",
        "Array.prototype.filter.call(Symbol(), function () { return 1 }).length",
        "(function () { Number.prototype.length = 2; Number.prototype[0] = \"x\"; Number.prototype[1] = \"y\"; var r = Array.prototype.map.call(5, function (v, i, o) { return v + i + typeof o }).join(); delete Number.prototype.length; delete Number.prototype[0]; delete Number.prototype[1]; return r })()",
        "(function () { \"use strict\"; var t; Array.prototype.forEach.call(\"a\", function () { t = typeof this }, 1); return t })()",
        "(function () { try { Array.prototype.map.call(\"abc\", 1) } catch (e) { return String(e) } })()",
        "(function () { try { Array.prototype.indexOf.call(null, 1) } catch (e) { return String(e) } })()",
        "Array.prototype.indexOf.call(10n, 1)",
    ] {
        agrees(&format!("String({program})"));
    }
}

/// A callback can delete an element of the dense array it walks (exposing
/// an inherited one), turn one into an accessor, or shorten the array; the
/// walk still visits what HasProperty and Get answer.
#[test]
fn a_dense_array_walk_follows_its_callback_mutations() {
    for program in [
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.forEach(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.forEach(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.forEach(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.forEach(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.map(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.map(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.map(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.map(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.filter(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.filter(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.filter(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.filter(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.some(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.some(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.some(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.some(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.every(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.every(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.every(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.every(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.find(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.find(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.find(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.find(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.findIndex(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.findIndex(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.findIndex(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.findIndex(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.findLast(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.findLast(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.findLast(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.findLast(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.findLastIndex(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.findLastIndex(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.findLastIndex(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.findLastIndex(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.reduce(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.reduce(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.reduce(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.reduce(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3]; Array.prototype[1] = 'p'; var r = []; try { a.reduceRight(function (x, y, z) { if (r.length === 0) delete a[1]; r.push(String(x) + '/' + String(y)); return false; }) } finally { delete Array.prototype[1]; } return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.reduceRight(function (x, y, z) { if (r.length === 0) { Object.defineProperty(a, 2, { get: function () { return 'g'; }, configurable: true }); Object.defineProperty(a, 3, { value: 'v', writable: false }); } r.push([x, y].map(String).join('/')); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.reduceRight(function (x, y) { if (r.length === 0) a.length = 1; r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "(function () { var a = [1, 2, 3, 4]; var r = []; a.reduceRight(function (x, y) { if (r.length === 0) a.push(9); r.push(String(x) + '/' + String(y)); return false; }); return r.join() })()",
        "[1, 2, 3].reduce(function (acc, x, i, a) { if (i === 1) delete a[2]; return acc + x; })",
        "[1, 2, 3].reduceRight(function (acc, x, i, a) { if (i === 1) delete a[0]; return acc + x; })",
        "(function () { try { [].reduce(function () {}) } catch (e) { return String(e) } })()",
        "[5].reduce(function () { return 1 })",
        "[].reduce(function () { return 1 }, 7)",
        "[1, 2, 3].map(function (x, i, a) { if (i === 0) a.length = 2; return x * 2 }).join()",
    ] {
        agrees(&format!("String({program})"));
    }
}

#[test]
fn number_to_string_renders_any_value_in_any_radix() {
    for program in [
        "(1.5).toString(2)",
        "(1e21).toString(36)",
        "(2 ** 53 + 2).toString(2).length",
        "(-0.25).toString(2)",
        "(0.1).toString(3)",
        "(1 / 3).toString(3)",
        "(255.5).toString(16)",
        "(Number.MAX_VALUE).toString(36)",
        "(Number.MIN_VALUE).toString(2).length",
        "(1 - 2 ** -53).toString(2)",
        "(-987654.321).toString(7)",
        "(2 ** 100 + 3).toString(5)",
    ] {
        agrees(program);
    }
    // Every radix over a spread of magnitudes, folded into one hash so a
    // single differing digit fails the comparison.
    agrees(
        "var seed = 12345; function rnd() { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; } \
         var vals = [0.5, -0.25, 1.5, 0.1, 1 / 3, 2 / 3, 1e21, 1e-7, 123.456, 2 ** 53 + 2, 2 ** 60, 5e-324, 1e-300, 4.35, -0]; \
         for (var i = 0; i < 100; i++) { var e = Math.floor(rnd() * 80) - 40; vals.push((rnd() - 0.5) * Math.pow(10, e)); vals.push(Math.floor(rnd() * 1e6) / 1024); } \
         var out = []; for (var r = 2; r <= 36; r++) { for (var j = 0; j < vals.length; j++) out.push(vals[j].toString(r)); } \
         var h = 0; var s = out.join(','); for (var k = 0; k < s.length; k++) h = (h * 31 + s.charCodeAt(k)) % 1000000007; \
         [out.length, s.length, h].join(' ')",
    );
}
