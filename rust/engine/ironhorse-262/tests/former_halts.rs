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

/// XS copies a source the species constructor grew past the end of the
/// result; Ironhorse copies only what fits, so the oracle cannot run this.
#[test]
fn concat_copies_only_what_fits_of_a_grown_source() {
    let program = "var a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]); var g = new ArrayBuffer(1, { maxByteLength: 8 }); var b = new Uint8Array([9]).buffer; b.constructor = { [Symbol.species]: function (n) { g.resize(8); new Uint8Array(g).set(a); return new ArrayBuffer(n) } }; var r = new Uint8Array(b.concat(g)).join(); if (r !== '9,1') throw new Error(r);";
    let outcome = run_script_source(program).expect("the program compiles");
    assert!(outcome.completed, "{:?}", outcome.halt);
}
