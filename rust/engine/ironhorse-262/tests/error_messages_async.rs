//! Native catches preserve the precise guest error while rejecting promises.
use ironhorse_262::{dual_run, dual_run_cranks, Agreement};

fn caught(expression: &str, expected: &str) {
    let source = format!("try {{ {expression} }} catch(e) {{ e.name + ':' + e.message }}");
    let run = dual_run(&source).unwrap();
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert_eq!(run.oracle_result, expected, "oracle: {source}");
    assert_eq!(run.ironhorse_result, expected, "port: {source}");
}

fn rejected(expression: &str, expected: &str) {
    let source = format!("var g='pending'; try {{ ({expression}).then(function() {{g='fulfilled'}}, function(e) {{g=e.name+':'+e.message}}) }} catch(e) {{g='synchronous:'+e.name+':'+e.message}}");
    let runs = dual_run_cranks(&[&source, "g"]).unwrap();
    for run in &runs {
        assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    }
    assert_eq!(runs[1].oracle_result, expected, "oracle: {source}");
    assert_eq!(runs[1].ironhorse_result, expected, "port: {source}");
}

#[test]
fn array_from_argument_and_iterator_diagnostics() {
    for (expression, expected) in [
        ("Array.from(null)", "TypeError:cannot coerce null to object"),
        (
            "Array.from(undefined)",
            "TypeError:cannot coerce undefined to object",
        ),
        ("Array.from({}, null)", "TypeError:callback: not a function"),
        (
            "Array.from(null, null)",
            "TypeError:callback: not a function",
        ),
        (
            "Array.from({[Symbol.iterator]:1})",
            "TypeError:call: not a function",
        ),
        (
            "Array.from({[Symbol.iterator](){return 1}})",
            "TypeError:iterator: not an object",
        ),
        (
            "Array.from({[Symbol.iterator](){return {next:1}}})",
            "TypeError:call: not a function",
        ),
        (
            "Array.from({[Symbol.iterator](){return {next(){return 1}}}})",
            "TypeError:iterator result: not an object",
        ),
        (
            "Array.from({length:4294967296})",
            "RangeError:invalid length",
        ),
        (
            "Array.from.call(function(){throw 'constructor must not run'}, {length:4294967296})",
            "RangeError:invalid length",
        ),
    ] {
        caught(expression, expected);
    }
}

#[test]
fn array_from_async_rejects_with_native_argument_and_iterator_messages() {
    for (expression, expected) in [
        ("Array.fromAsync()", "TypeError:no items"),
        ("Array.fromAsync(null)", "TypeError:cannot coerce null to object"),
        ("Array.fromAsync(undefined)", "TypeError:cannot coerce undefined to object"),
        ("Array.fromAsync({}, null)", "TypeError:callback: not a function"),
        ("Array.fromAsync(null, null)", "TypeError:callback: not a function"),
        ("Array.fromAsync({[Symbol.asyncIterator]:1})", "TypeError:call: not a function"),
        ("Array.fromAsync({[Symbol.iterator]:1})", "TypeError:call: not a function"),
        ("Array.fromAsync({[Symbol.iterator](){return 1}})", "TypeError:call: not a function"),
        ("Array.fromAsync({[Symbol.iterator](){return {next:1}}})", "TypeError:call: not a function"),
        ("Array.fromAsync({[Symbol.iterator](){return {next(){return 1}}}})", "TypeError:iterator result: not an object"),
        ("Array.fromAsync.call(function(){throw 'constructor must not run'}, {length:2147483648})", "RangeError:array overflow"),
    ] { rejected(expression, expected); }
}

#[test]
fn array_from_target_write_failures_keep_setter_and_definition_reasons() {
    for name in ["from", "fromAsync"] {
        for (tail, expected) in [
            (
                ".call(function(){return Object.preventExtensions({})},[1])",
                "TypeError:define 0: not configurable",
            ),
            (
                ".call(function(){return Object.defineProperty({},'length',{value:0})},[])",
                "TypeError:C: xsSet length: not writable",
            ),
            (
                ".call(function(){return Object.defineProperty({},'length',{get(){return 0}})},[])",
                "TypeError:C: xsSet length: no setter",
            ),
            (
                ".call(function(){return Object.preventExtensions({})},[])",
                "TypeError:C: xsSet length: not extensible",
            ),
        ] {
            let expression = format!("Array.{name}{tail}");
            if name == "from" {
                caught(&expression, expected);
            } else {
                rejected(&expression, expected);
            }
        }
    }
}

#[test]
fn promise_combinators_reject_with_protocol_messages() {
    for name in ["all", "allSettled", "race", "any"] {
        for (input, expected) in [
            ("null", "TypeError:cannot coerce null to object"),
            ("undefined", "TypeError:cannot coerce undefined to object"),
            ("{}", "TypeError:call: not a function"),
            (
                "{[Symbol.iterator](){return 1}}",
                "TypeError:iterator: not an object",
            ),
            (
                "{[Symbol.iterator](){return {next:1}}}",
                "TypeError:call: not a function",
            ),
            (
                "{[Symbol.iterator](){return {next(){return 1}}}}",
                "TypeError:iterator result: not an object",
            ),
        ] {
            rejected(&format!("Promise.{name}({input})"), expected);
        }
        rejected(&format!("Promise.{name}.call(Object.assign(function C(e){{return new Promise(e)}},{{resolve:1}}), [])"), "TypeError:resolve: not a function");
    }
}

#[test]
fn promise_self_resolution_retains_type_and_message() {
    rejected("(function(){var resolve; var promise = new Promise(function(r){resolve=r}); resolve(promise); return promise})()", "TypeError:promise resolves itself");
}

#[test]
fn native_catches_preserve_getter_throw_identity() {
    let source = "var marker = {}; var g = ''; Array.fromAsync({get [Symbol.asyncIterator]() {throw marker}}).then(undefined,function(e){g = e === marker});";
    let runs = dual_run_cranks(&[source, "g"]).unwrap();
    assert_eq!(runs[1].oracle_result, "true");
    assert_eq!(runs[1].ironhorse_result, "true");
}
