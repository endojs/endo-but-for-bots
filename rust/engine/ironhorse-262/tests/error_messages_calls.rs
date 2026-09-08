//! XS diagnostics must survive native errors as catchable guest messages.

fn assert_message(source: &str, expected: &str) {
    let run = ironhorse_262::dual_run(source).expect("compile and run both engines");
    assert_eq!(
        run.agreement,
        ironhorse_262::Agreement::BothComplete,
        "{source}: {run:?}"
    );
    assert_eq!(run.oracle_result, expected, "oracle: {source}");
    assert_eq!(run.ironhorse_result, expected, "ironhorse: {source}");
}

#[test]
fn noncallable_and_nonconstructable_callees_preserve_xs_messages() {
    for source in [
        "var f; try { f() } catch(e) { e.message }",
        "try { ({} )() } catch(e) { e.message }",
    ] {
        assert_message(source, "call: not a function");
    }
    for source in [
        "var f; try { new f() } catch(e) { e.message }",
        "try { new Function.prototype.call() } catch(e) { e.message }",
        "try { new Function.prototype.apply() } catch(e) { e.message }",
    ] {
        assert_message(source, "new: not a constructor");
    }
}

#[test]
fn generator_reentry_preserves_xs_message() {
    assert_message(
        "function* f() { try { g.next() } catch(e) { yield e.message } } var g = f(); g.next().value",
        "generator is running",
    );
}

#[test]
fn numeric_coercion_preserves_xs_message() {
    assert_message(
        "try { +Symbol() } catch(e) { e.message }",
        "cannot coerce symbol to number",
    );
    assert_message(
        "try { Math.abs(1n) } catch(e) { e.message }",
        "cannot coerce to number",
    );
}

#[test]
fn primitive_conversion_failures_preserve_hint_and_hook_diagnostics() {
    for (source, expected) in [
        ("try { +{ [Symbol.toPrimitive]: 1 } } catch(e) { e.message }", "call: not a function"),
        ("try { +{ [Symbol.toPrimitive]() { return {} } } } catch(e) { e.message }", "cannot coerce to primitive"),
        ("try { +{ valueOf() { return {} }, toString() { return {} } } } catch(e) { e.message }", "cannot coerce object to number"),
        ("try { String({ valueOf() { return {} }, toString() { return {} } }) } catch(e) { e.message }", "cannot coerce object to string"),
        ("try { +Symbol() } catch(e) { String(e) }", "TypeError: cannot coerce symbol to number"),
    ] {
        assert_message(source, expected);
    }
}

#[test]
fn immutable_binding_diagnostics_keep_the_binding_name() {
    assert_message(
        "(function(){ const x = 1; try { x = 2 } catch(e) { return e.message } })()",
        "set x: const",
    );
    assert_message("(function(){ const x = 1; try { (function() { x = 2 })() } catch(e) { return e.message } })()", "set x: const");
}

#[test]
fn bigint_diagnostics_distinguish_operands_and_width_failures() {
    for (source, expected) in [
        (
            "try { 1n + 1 } catch(e) { e.message }",
            "cannot coerce right operand to bigint",
        ),
        (
            "try { 1 + 1n } catch(e) { e.message }",
            "cannot coerce left operand to bigint",
        ),
        ("try { 1n / 0n } catch(e) { e.message }", "zero divider"),
        ("try { 1n % 0n } catch(e) { e.message }", "zero divider"),
        (
            "try { BigInt.asIntN(-1, 1n) } catch(e) { e.message }",
            "index < 0",
        ),
        (
            "try { BigInt.asIntN(Infinity, 1n) } catch(e) { e.message }",
            "invalid index",
        ),
        (
            "try { BigInt.asIntN(Object(1n), 1n) } catch(e) { e.message }",
            "cannot coerce to number",
        ),
        (
            "try { BigInt.prototype.valueOf.call(1) } catch(e) { e.message }",
            "this: not a bigint",
        ),
        (
            "try { Symbol.prototype.valueOf.call(1) } catch(e) { e.message }",
            "this: not a symbol",
        ),
    ] {
        assert_message(source, expected);
    }
}

#[test]
fn class_and_bigint_operator_errors_are_named() {
    for (source, expected) in [
        (
            "class C {} try { C() } catch(e) { e.message }",
            "call: class",
        ),
        (
            "try { 1n ** -1n } catch(e) { e.message }",
            "negative exponent",
        ),
        (
            "try { 1n >>> 1n } catch(e) { e.message }",
            "no such operation",
        ),
        (
            "try { 1n & 1 } catch(e) { e.message }",
            "cannot coerce right operand to bigint",
        ),
        (
            "try { 1 & 1n } catch(e) { e.message }",
            "cannot coerce left operand to bigint",
        ),
        (
            "try { '' + Symbol() } catch(e) { e.message }",
            "cannot coerce symbol to string",
        ),
    ] {
        assert_message(source, expected);
    }
}

#[test]
fn empty_dense_arrays_validate_callbacks_before_returning() {
    for method in [
        "forEach",
        "map",
        "filter",
        "some",
        "every",
        "find",
        "findIndex",
        "findLast",
        "findLastIndex",
        "reduce",
        "reduceRight",
    ] {
        assert_message(
            &format!("try {{ [][{method:?}](null) }} catch(e) {{ e.message }}"),
            "callback: not a function",
        );
    }
    for method in ["reduce", "reduceRight"] {
        assert_message(
            &format!("try {{ [][{method:?}](function() {{}}) }} catch(e) {{ e.message }}"),
            "no initial value",
        );
    }
}

#[test]
fn bitwise_coercion_has_integer_diagnostics() {
    for expression in [
        "~Symbol()",
        "Symbol() | 0",
        "0 & Object(Symbol())",
        "({valueOf() { return Symbol() }}) << 0",
    ] {
        assert_message(
            &format!("try {{ {expression} }} catch(e) {{ e.message }}"),
            "cannot coerce symbol to integer",
        );
    }
    assert_message(
        "try { Symbol() >>> 0 } catch(e) { e.message }",
        "cannot coerce symbol to number",
    );
    assert_message(
        "var count = 0; var v = {valueOf() { count++; return 3 }}; (v | 0) + ':' + count",
        "3:1",
    );
}

#[test]
fn buffer_and_constructor_diagnostics() {
    for name in [
        "ArrayBuffer",
        "SharedArrayBuffer",
        "DataView",
        "Map",
        "Set",
        "WeakMap",
        "WeakSet",
        "Proxy",
        "Promise",
    ] {
        assert_message(
            &format!("try {{ {name}() }} catch(e) {{ e.message }}"),
            &format!("call: {name}"),
        );
    }
    for (expression, expected) in [
        ("Uint8Array()", "call: TypedArray"),
        ("new Uint8Array(-1)", "byteLength < 0"),
        ("new Float64Array(Infinity)", "byteLength too big"),
        (
            "new Int16Array(new ArrayBuffer(4), 1)",
            "invalid byteOffset 1",
        ),
        (
            "new Int16Array(new ArrayBuffer(4), 0, 3)",
            "invalid length 3",
        ),
        ("new Int16Array(new ArrayBuffer(3))", "invalid byteLength 3"),
        (
            "new Int16Array(new ArrayBuffer(4), 6)",
            "invalid byteLength 4294967294",
        ),
        (
            "new (Object.getPrototypeOf(Uint8Array))()",
            "new: TypedArray",
        ),
        ("new Promise()", "no executor"),
        ("new Promise(undefined)", "executor: not a function"),
        ("new ArrayBuffer(-1)", "byteLength < 0"),
        ("new ArrayBuffer(Infinity)", "byteLength too big"),
        ("new SharedArrayBuffer(-1)", "byteLength < 0"),
        ("new ArrayBuffer(Object(1n))", "cannot coerce to number"),
        (
            "new ArrayBuffer(Symbol())",
            "cannot coerce symbol to number",
        ),
        ("new DataView({})", "buffer: not an ArrayBuffer instance"),
        (
            "new DataView(new ArrayBuffer(2), 3)",
            "invalid byteOffset 3",
        ),
        (
            "new DataView(new ArrayBuffer(2), 1, 2)",
            "invalid byteLength 2",
        ),
        ("new DataView(new ArrayBuffer(2), -1)", "byteLength < 0"),
    ] {
        assert_message(
            &format!("try {{ {expression} }} catch(e) {{ e.message }}"),
            expected,
        );
    }
}

#[test]
fn data_view_diagnostics() {
    for (expression, expected) in [
        (
            "DataView.prototype.getInt8.call({})",
            "this: not a DataView instance",
        ),
        (
            "new DataView(new ArrayBuffer(0)).getInt8(0)",
            "invalid byteOffset",
        ),
        (
            "new DataView(new ArrayBuffer(0)).setInt8(0, 1)",
            "invalid byteOffset",
        ),
        (
            "new DataView(new ArrayBuffer(0)).getInt8(-1)",
            "byteLength < 0",
        ),
        (
            "new DataView(new ArrayBuffer(0)).setInt8(0, Symbol())",
            "cannot coerce symbol to integer",
        ),
        (
            "new DataView(new ArrayBuffer(0)).setUint8(0, 1n)",
            "cannot coerce to unsigned",
        ),
        (
            "new DataView(new ArrayBuffer(0)).setFloat64(0, 1n)",
            "cannot coerce to number",
        ),
        (
            "new DataView(new ArrayBuffer(0)).setBigInt64(0, 1)",
            "cannot coerce number to bigint",
        ),
    ] {
        assert_message(
            &format!("try {{ {expression} }} catch(e) {{ e.message }}"),
            expected,
        );
    }
}

#[test]
fn function_receivers_are_validated_before_dispatch() {
    for method in ["call", "apply", "bind", "toString"] {
        assert_message(
            &format!("try {{ Function.prototype.{method}.call({{}}) }} catch(e) {{ e.message }}"),
            "this: not a Function instance",
        );
    }
    assert_message(
        "try { Reflect.apply(Function.prototype.call, {}, []) } catch(e) { e.message }",
        "this: not a Function instance",
    );
}

#[test]
fn array_at_observes_index_coercion_mutations() {
    assert_message("var a=[1]; var index={valueOf(){Object.defineProperty(a,'0',{get(){return 9}});return 0}}; a.at(index)", "9");
    assert_message("var a=[1]; var index={valueOf(){delete a[0]; Object.setPrototypeOf(a, {0: 8}); return 0}}; a.at(index)", "8");
}

#[test]
fn promise_capability_diagnostics() {
    for (expression, expected) in [
        ("Promise.prototype.then.call({})", "this: not a Promise instance"),
        ("Promise.resolve.call(function C(){}, 1)", "executor not called"),
        ("Promise.resolve.call(function C(executor){executor()}, 1)", "resolve: not an object"),
        ("Promise.resolve.call(function C(executor){executor({}, function(){})}, 1)", "resolve: not a function"),
        ("Promise.resolve.call(function C(executor){executor(function(){}, 1)}, 1)", "reject: not an object"),
        ("Promise.resolve.call(function C(executor){executor(function(){}, {})}, 1)", "reject: not a function"),
        ("Promise.resolve.call(function C(executor){executor(function(){}, function(){});executor()}, 1)", "executor already called"),
    ] { assert_message(&format!("try {{ {expression} }} catch(e) {{ e.message }}"), expected); }
}

#[test]
fn promise_species_and_receiver_diagnostics() {
    for (body, expected) in [
        ("Promise.prototype.then.call(1)", "this: not an object"),
        ("Promise.prototype.finally.call(1)", "this: not an object"),
        (
            "Promise.prototype.finally.call({then: 1})",
            "call: not a function",
        ),
        ("Promise.resolve.call(1, 1)", "this: not an object"),
        ("Promise.reject.call({}, 1)", "new: not a constructor"),
        (
            "var p = Promise.resolve(); p.constructor = 1; p.then()",
            "no constructor",
        ),
        (
            "var p = Promise.resolve(); p.constructor = {[Symbol.species]: 1}; p.then()",
            "no constructor",
        ),
    ] {
        assert_message(
            &format!("try {{ {body} }} catch(e) {{ e.message }}"),
            expected,
        );
    }
}

#[test]
fn bigint_constructor_and_json_diagnostics() {
    for (body, expected) in [
        ("Number(Symbol())", "cannot coerce symbol to number"),
        ("new BigInt(1)", "new: BigInt"),
        ("BigInt()", "cannot coerce to bigint"),
        ("BigInt(Symbol())", "cannot coerce symbol to bigint"),
        ("BigInt(1.5)", "cannot coerce number to bigint"),
        ("BigInt('x')", "cannot coerce string to bigint"),
        ("BigInt.asIntN(2, 1)", "cannot coerce number to bigint"),
        ("BigInt.asIntN(2, 'x')", "cannot coerce string to bigint"),
        ("JSON.stringify(1n)", "stringify bigint"),
        ("var a=[]; a.push(a); JSON.stringify(a)", "cyclic value"),
        ("var a={}; a.a=a; JSON.stringify(a)", "cyclic value"),
    ] {
        assert_message(
            &format!("try {{ {body} }} catch(e) {{ e.message }}"),
            expected,
        );
    }
}

#[test]
fn primitive_prototype_diagnostics() {
    for (body, expected) in [
        ("(1n).toString(1)", "invalid radix"),
        ("(1n).toString(2n)", "cannot coerce to integer"),
        ("(1n).toString(Symbol())", "cannot coerce symbol to integer"),
        ("Symbol.for(Symbol())", "cannot coerce symbol to string"),
        ("Symbol.keyFor(1)", "sym: not a symbol"),
        ("Error.prototype.toString.call(1)", "this: not an object"),
        (
            "function F(){} F.prototype = 1; ({}) instanceof F",
            "this.prototype: not an object",
        ),
        ("Iterator()", "call: Iterator"),
        ("new Iterator()", "new: Iterator"),
    ] {
        assert_message(
            &format!("try {{ {body} }} catch(e) {{ e.message }}"),
            expected,
        );
    }
}

#[test]
fn abstract_call_and_instanceof_diagnostics() {
    for (body, expected) in [
        ("({}) instanceof 1", "call: not a function"),
        ("({}) instanceof null", "cannot coerce null to object"),
        ("({}) instanceof {}", "call: not a function"),
        (
            "({}) instanceof {[Symbol.hasInstance]: 1}",
            "call: not a function",
        ),
        (
            "Promise.prototype.catch.call(null)",
            "cannot coerce null to object",
        ),
        (
            "Promise.prototype.catch.call({then: 1})",
            "call: not a function",
        ),
        ("(function(){}).apply(null, 1)", "argArray: not an object"),
        ("Math.abs.apply(null, 1)", "argArray: not an object"),
        (
            "Reflect.apply(Function.prototype.apply, Math.abs, [null, 1])",
            "argArray: not an object",
        ),
    ] {
        assert_message(
            &format!("try {{ {body} }} catch(e) {{ e.message }}"),
            expected,
        );
    }
}

#[test]
fn error_stack_accessor_diagnostics() {
    for (body, expected) in [
        ("Object.getOwnPropertyDescriptor(Error.prototype,'stack').get.call(1)", "this: not an object"),
        ("Object.getOwnPropertyDescriptor(Error.prototype,'stack').set.call(1)", "this: not an object"),
        ("Object.getOwnPropertyDescriptor(Error.prototype,'stack').set.call({})", "no value"),
        ("Object.getOwnPropertyDescriptor(Error.prototype,'stack').set.call(Object.freeze({}), 1)", "define 413: not configurable"),
    ] { assert_message(&format!("try {{ {body} }} catch(e) {{ e.message }}"), expected); }
}

#[test]
fn host_hook_and_eval_diagnostics() {
    assert_message(
        "try { new eval() } catch(e) { e.message }",
        "new: not a constructor",
    );
    assert_message(
        "try { $262.detachArrayBuffer({}) } catch(e) { e.message }",
        "this is no ArrayBuffer instance",
    );
}

#[test]
fn direct_native_error_values_keep_messages() {
    for (body, expected) in [
        ("1n ** 1", "cannot coerce right operand to bigint"),
        ("1 ** 1n", "cannot coerce left operand to bigint"),
        ("Object.fromEntries(null)", "invalid iterable"),
        ("Object.fromEntries({})", "call: not a function"),
        (
            "Object.fromEntries({[Symbol.iterator]:1})",
            "call: not a function",
        ),
        (
            "Object.fromEntries({[Symbol.iterator](){return 1}})",
            "iterator: not an object",
        ),
        (
            "Object.fromEntries({[Symbol.iterator](){return {next:1}}})",
            "call: not a function",
        ),
        (
            "Object.fromEntries({[Symbol.iterator](){return {next(){return 1}}}})",
            "iterator result: not an object",
        ),
        ("Object.fromEntries([1])", "item: not an object"),
    ] {
        assert_message(
            &format!("try {{ {body} }} catch(e) {{ e.message }}"),
            expected,
        );
    }
    assert_message("var closed=0; try{Object.fromEntries({[Symbol.iterator](){return {next(){return {done:false,value:1}},return(){closed++;return {}}}}})}catch(e){e.message+':'+closed}", "item: not an object:1");
}

#[test]
fn null_prototype_completion_host_coercion_matches_xs() {
    let run = ironhorse_262::dual_run("Object.create(null);").expect("oracle starts");
    assert_eq!(
        run.agreement,
        ironhorse_262::Agreement::BothAbort,
        "{run:?}"
    );
    assert_eq!(
        run.oracle_error,
        "TypeError: cannot coerce object to string"
    );
    assert_eq!(run.ironhorse_error, run.oracle_error);
    assert!(run.error_agrees, "{run:?}");
    // Diagnostic-only correction: preserve the existing run-only budgets.
    // The synthetic post-run throw must not charge guest execution.
    assert_eq!(run.ironhorse_computrons, 14);
    assert_eq!(run.oracle_computrons, 20);
}
