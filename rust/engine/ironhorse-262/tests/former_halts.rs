//! Programs that once stopped Ironhorse with a `NotImplemented` halt, each
//! against the pinned XS oracle (V8 agrees on each unless noted).
//!
//! A halt never agrees with an XS answer, so each of these failed before
//! its fix.

use ironhorse_262::{dual_run, run_script_source};

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

/// XS copies a source the species constructor grew past the end of the
/// result; Ironhorse copies only what fits, so the oracle cannot run this.
#[test]
fn concat_copies_only_what_fits_of_a_grown_source() {
    let program = "var a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); var g = new ArrayBuffer(1, { maxByteLength: 8 }); var b = new Uint8Array([9]).buffer; b.constructor = { [Symbol.species]: function (n) { g.resize(8); new Uint8Array(g).set(a); return new ArrayBuffer(n) } }; var r = new Uint8Array(b.concat(g)).join(); if (r !== '9,1') throw new Error(r);";
    let outcome = run_script_source(program).expect("the program compiles");
    assert!(outcome.completed, "{:?}", outcome.halt);
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

/// The generic `map` and `filter` stopped after 2^16 indices of a receiver
/// they probe one by one (a Proxy, a String).
#[test]
fn generic_map_and_filter_walk_past_two_to_the_sixteen() {
    for program in [
        "Array.prototype.filter.call(new Proxy({ length: 70000 }, {}), function () { return true }).length",
        "Array.prototype.map.call(new Proxy({ length: 70000 }, {}), function () { return 1 }).length",
        "Array.prototype.filter.call(new Proxy({ length: 70000, 69999: 'z' }, {}), function () { return true }).join()",
        "Array.prototype.map.call(new Proxy({ length: 70000, 69999: 'z' }, {}), function (v, i) { return v + i })[69999]",
        "Array.prototype.filter.call('x'.repeat(70000) + 'y', function (c) { return c === 'y' }).join()",
    ] {
        agrees(&format!("String({program})"));
    }
}

/// The generic `reduce` and `reduceRight` declined a `length` above
/// 2^32 - 1. XS agrees on these folds, whose elements sit in its resident
/// index storage; `xs_departures.rs` records two it does not.
#[test]
fn generic_reduce_folds_a_length_past_two_to_the_thirty_two() {
    for program in [
        "Array.prototype.reduce.call({ length: 2 ** 32, 0: 'a', 1: 'b' }, function (acc, v, i) { if (i === 1) throw acc + v; return acc + v; }, '')",
        "Array.prototype.reduce.call({ length: 2 ** 53 - 1, 0: 'a', 1: 'b' }, function (acc, v, i) { if (i === 1) throw acc + v; return acc + v; })",
        "Array.prototype.reduceRight.call({ length: 2 ** 32, [2 ** 32 - 2]: 'a' }, function (acc, v, i) { throw v + i }, 0)",
    ] {
        agrees(&format!("try {{ {program} }} catch (e) {{ String(e) }}"));
    }
}

// The read-only generic walks stopped after 2^24 indices of a receiver they
// probe one by one: a Proxy, TypedArray or String wrapper, or for `find*`,
// `includes` and the folds, which probe every index, any array-like. Each
// walk below takes 2^24 + 1 steps: seconds in an optimized build, from half a
// minute to a few minutes in an unoptimized one. Their oracle-free copies in
// `ironhorse-vm/tests/generic_array_walks_run_to_length.rs` run in CI's
// release lane.

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn generic_for_each_walks_past_two_to_the_twenty_four() {
    agrees("var n = 0; Array.prototype.forEach.call(new Proxy({ length: 2 ** 24 + 1, [2 ** 24]: 1 }, {}), function (v, i) { n += v + i }); n");
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn generic_some_and_every_walk_past_two_to_the_twenty_four() {
    agrees(
        "Array.prototype.some.call(new Proxy({ length: 2 ** 24 + 1, [2 ** 24]: 1 }, {}), Boolean)",
    );
    agrees(
        "Array.prototype.every.call(new Proxy({ length: 2 ** 24 + 1, [2 ** 24]: 0 }, {}), Boolean)",
    );
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn generic_find_walks_past_two_to_the_twenty_four() {
    agrees("Array.prototype.find.call({ length: 2 ** 24 + 1, [2 ** 24]: 'x' }, Boolean)");
    agrees("Array.prototype.findIndex.call({ length: 2 ** 24 + 1, [2 ** 24]: 'x' }, Boolean)");
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn generic_find_last_walks_past_two_to_the_twenty_four() {
    agrees("Array.prototype.findLast.call({ length: 2 ** 24 + 1, 0: 'x' }, Boolean)");
    agrees("Array.prototype.findLastIndex.call({ length: 2 ** 24 + 1, 0: 'x' }, Boolean)");
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn generic_reduce_walks_past_two_to_the_twenty_four() {
    agrees("Array.prototype.reduce.call({ length: 2 ** 24 + 1, [2 ** 24]: 'x' }, function (acc, v, i) { return acc + v + i }, '')");
    agrees("Array.prototype.reduceRight.call({ length: 2 ** 24 + 1, 0: 'x' }, function (acc, v, i) { return acc + v + i }, '')");
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn generic_index_of_walks_past_two_to_the_twenty_four() {
    agrees("Array.prototype.indexOf.call(new Proxy({ length: 2 ** 24 + 1, [2 ** 24]: 1 }, {}), 1)");
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn generic_last_index_of_walks_past_two_to_the_twenty_four() {
    agrees("Array.prototype.lastIndexOf.call(new Proxy({ length: 2 ** 24 + 1, 0: 1 }, {}), 1)");
}

#[test]
#[cfg_attr(debug_assertions, ignore = "2^24 + 1 steps: run with --release")]
fn generic_includes_walks_past_two_to_the_twenty_four() {
    agrees("Array.prototype.includes.call({ length: 2 ** 24 + 1, [2 ** 24]: 1 }, 1)");
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

/// `bind` accepts any callable, a Proxy included, and the bound function
/// inherits from the target's [[Prototype]].
#[test]
fn bind_takes_any_callable_and_its_prototype() {
    for program in [
        "Function.prototype.bind.call(new Proxy(function () {}, {}), null).name",
        "(function () { var f = function () {}; Object.setPrototypeOf(f, null); return String(Object.getPrototypeOf(Function.prototype.bind.call(f)) === null) })()",
        "(function () { var A = async function () {}; return Object.getPrototypeOf(A.bind()) === Object.getPrototypeOf(A) })()",
        "(function () { class B {} class C extends B {} return Object.getPrototypeOf(C.bind()) === B })()",
        "(function () { var log = []; var p = new Proxy(function (a, b) { return [this && this.t, a, b].join() }, { getPrototypeOf(t) { log.push('proto'); return Function.prototype }, getOwnPropertyDescriptor(t, k) { log.push('gopd:' + String(k)); return Reflect.getOwnPropertyDescriptor(t, k) }, get(t, k) { log.push('get:' + String(k)); return Reflect.get(t, k) } }); var b = Function.prototype.bind.call(p, { t: 'T' }, 1); return [log.join(), b(2), b.name, b.length].join('|') })()",
        "(function () { var p = new Proxy(function () {}, { get(t, k) { return k === 'name' ? 'pn' : k === 'length' ? 7 : undefined } }); var b = Function.prototype.bind.call(p, null, 1, 2); return [b.name, b.length].join() })()",
        "(function () { var p = new Proxy(function () {}, { getOwnPropertyDescriptor() { return undefined }, get(t, k) { return k === 'length' ? 7 : Reflect.get(t, k) } }); return Function.prototype.bind.call(p).length })()",
        "(function () { var P = new Proxy(function C(x) { this.x = x }, {}); var B = Function.prototype.bind.call(P, null, 5); var o = new B(); return [o.x, o instanceof B, Object.getPrototypeOf(o) === P.prototype].join() })()",
        "(function () { var log = []; var P = new Proxy(function () {}, { construct(t, a, nt) { log.push(a.join() + ':' + (nt === t)); return {} } }); var B = Function.prototype.bind.call(P, null, 1); new B(2); return log.join() })()",
        "(function () { var P = new Proxy(() => 1, {}); var B = Function.prototype.bind.call(P); try { new B() } catch (e) { return String(e) } })()",
        "(function () { var P = new Proxy(function () { return this }, { apply(t, th, a) { return [typeof th, a.length].join() } }); return Function.prototype.bind.call(P, 'x', 1, 2)(3) })()",
        "(function () { var p = Proxy.revocable(function () {}, {}); p.revoke(); try { Function.prototype.bind.call(p.proxy); return 'ok' } catch (e) { return String(e) } })()",
        "(function () { var r = Proxy.revocable(function () {}, {}); var b = Function.prototype.bind.call(r.proxy); r.revoke(); try { b(); return 'ok' } catch (e) { return e.constructor.name } })()",
        "(function () { var p = new Proxy(function () {}, { getPrototypeOf() { throw new EvalError('gp') } }); try { Function.prototype.bind.call(p) } catch (e) { return String(e) } })()",
        "(function () { var p = new Proxy(function () {}, { getPrototypeOf() { return null } }); return String(Object.getPrototypeOf(Function.prototype.bind.call(p))) })()",
        "(function () { var b = Function.prototype.bind.call(Function.prototype.bind.call(new Proxy(function (a, b, c) { return a + b + c }, {}), null, 'a'), null, 'b'); return [b('c'), b.name, b.length].join() })()",
        "(function () { var o = {}; var b = Object.prototype.toString.bind(); return [typeof b, Object.getPrototypeOf(b) === Function.prototype].join() })()",
    ] {
        agrees(&format!("String({program})"));
    }
}

/// `new TA(object)` reads `@@iterator` once: an iterable (an Array whose
/// iteration was replaced included) is collected first, an array-like is read
/// element by element with each conversion in between.
#[test]
fn a_typed_array_takes_an_iterable_or_an_array_like() {
    for program in [
        "(function () { var x = [1, 2]; x[Symbol.iterator] = function* () { yield 7 }; return new Uint8Array(x).join() })()",
        "(function () { var saved = Array.prototype[Symbol.iterator]; Array.prototype[Symbol.iterator] = function* () { yield 9; yield 8 }; try { return new Uint8Array([1, 2, 3]).join() } finally { Array.prototype[Symbol.iterator] = saved } })()",
        "(function () { var AIP = Object.getPrototypeOf([][Symbol.iterator]()); var next = AIP.next; var n = 0; AIP.next = function () { n++; return next.call(this) }; try { return [new Int16Array([5, 6]).join(), n].join('|') } finally { AIP.next = next } })()",
        "(function () { var x = [1, 2, 3]; Object.defineProperty(x, Symbol.iterator, { get() { return function* () { yield 4 } } }); return new Float64Array(x).join() })()",
        "(function () { var x = [1, 2]; x[Symbol.iterator] = function* () { yield { valueOf() { return 3 } }; yield '4' }; return new Int32Array(x).join() })()",
        "(function () { class T extends Uint8Array {} var x = [1]; x[Symbol.iterator] = function* () { yield 2 }; var t = new T(x); return [t instanceof T, t[0]].join() })()",
        "(function () { var x = [1, 2]; x[Symbol.iterator] = function* () { yield 1n }; return new BigInt64Array(x).join() })()",
        "(function () { var x = [1, 2]; x[Symbol.iterator] = function* () { yield 1n }; try { new Uint8Array(x) } catch (e) { return String(e) } })()",
        "(function () { var x = [1, 2]; x[Symbol.iterator] = 5; try { new Uint8Array(x) } catch (e) { return e.constructor.name } })()",
        "new Uint8Array([3, 4, 5]).join()",
        "new Uint8Array(new Set([1, 2, 2, 3])).join()",
        "new Uint8Array({ length: 2, 0: 7, 1: 8 }).join()",
        "(function () { var a = [{ valueOf: function () { a[1] = 99; return 1; } }, 2]; a[Symbol.iterator] = undefined; return new Uint8Array(a)[1] })()",
        "(function () { var a = { length: 2, 0: { valueOf: function () { a[1] = 99; return 1; } }, 1: 2 }; return new Uint8Array(a)[1] })()",
        "(function () { var log = []; var a = { get length() { log.push('len'); return 2 }, get 0() { log.push('g0'); return { valueOf() { log.push('v0'); return 1 } } }, get 1() { log.push('g1'); return 2 } }; new Uint8Array(a); return log.join() })()",
        "(function () { var saved = Array.prototype[Symbol.iterator]; Array.prototype[Symbol.iterator] = undefined; try { var a = [{ valueOf: function () { a[1] = 99; return 1; } }, 2]; return new Uint8Array(a)[1] } finally { Array.prototype[Symbol.iterator] = saved } })()",
        "(function () { var log = []; var o = { length: 1, 0: 5 }; Object.defineProperty(o, Symbol.iterator, { get() { log.push('it'); return undefined } }); new Int8Array(o); return log.join() })()",
        "(function () { var log = []; var o = {}; Object.defineProperty(o, Symbol.iterator, { get() { log.push('it'); return function* () { yield 3 } } }); return [new Int8Array(o).join(), log.join()].join('|') })()",
        "(function () { var o = { length: -5 }; return new Int8Array(o).length })()",
        "(function () { var o = { length: '3', 0: '1', 2: 7 }; return new Int8Array(o).join() })()",
        "(function () { var o = { length: 2 ** 32 }; try { new Int8Array(o) } catch (e) { return String(e) } })()",
        "(function () { var p = new Proxy({ length: 2, 0: 1, 1: 2 }, {}); return new Int8Array(p).join() })()",
        "(function () { var o = { length: 2, 0: 1, get 1() { throw new EvalError('x') } }; try { new Int8Array(o) } catch (e) { return String(e) } })()",
        "(function () { var o = { [Symbol.iterator]: 1 }; try { new Int8Array(o) } catch (e) { return String(e) } })()",
        "(function () { var it = { [Symbol.iterator]() { return { next() { throw new EvalError('n') } } } }; try { new Int8Array(it) } catch (e) { return String(e) } })()",
        "new Uint8Array(new Map([[1, 2]])).join()",
        "(function () { function f() { return new Int16Array(arguments).join() } return f(1, 2, 3) })()",
        "(function () { class T extends Int8Array {} var t = new T({ length: 1, 0: 4 }); return [t instanceof T, t[0]].join() })()",
        "new BigInt64Array({ length: 2, 0: 1n, 1: 2n }).join()",
        "(function () { try { new BigInt64Array({ length: 1, 0: 1 }) } catch (e) { return String(e) } })()",
        "new Float32Array('12').join()",
        "(function () { var o = { length: 3, 0: 1, 1: 2, 2: 3 }; return new Uint8ClampedArray(o).join() })()",
        "new AggregateError({ [Symbol.iterator]: function* () { yield 1; yield 2 } }).errors.length",
        "new Int8Array({ [Symbol.iterator]() { return [7][Symbol.iterator]() } }).join()",
    ] {
        agrees(&format!("String({program})"));
    }
}

/// XS 8.3.1 predates source-phase imports: `import.source` is a SyntaxError.
#[test]
fn import_source_is_a_syntax_error() {
    for program in [
        "try { eval('import.source'); 'parsed' } catch (e) { String(e) }",
        "try { eval('import.source(\"x\")'); 'parsed' } catch (e) { String(e) }",
        "try { new Function('return import.source(\"./x.js\")'); 'parsed' } catch (e) { String(e) }",
    ] {
        agrees(program);
    }
}
