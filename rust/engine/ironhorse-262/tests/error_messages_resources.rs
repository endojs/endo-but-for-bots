//! Resource protocols preserve XS error classes, messages, and lookup order.
use ironhorse_262::{dual_run, dual_run_cranks, Agreement};

fn result(source: &str, expected: &str) {
    let run = dual_run(source).unwrap();
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert_eq!(run.oracle_result, expected, "oracle: {source}");
    assert_eq!(run.ironhorse_result, expected, "port: {source}");
}

#[test]
fn constructor_and_method_brands_have_native_diagnostics() {
    for brand in ["DisposableStack", "AsyncDisposableStack"] {
        result(
            &format!("try {{ {brand}() }} catch(e) {{ e.name + ':' + e.message }}"),
            &format!("TypeError:call: {brand}"),
        );
        for method in ["use", "adopt", "defer", "move"] {
            result(&format!("try {{ {brand}.prototype.{method}.call({{}}) }} catch(e) {{ e.name + ':' + e.message }}"), &format!("TypeError:this: not a {brand} instance"));
        }
    }
    result("try { DisposableStack.prototype.dispose.call(new AsyncDisposableStack()) } catch(e) { e.message }", "this: not a DisposableStack instance");
}

#[test]
fn disposed_stacks_fail_before_argument_validation_or_property_reads() {
    for brand in ["DisposableStack", "AsyncDisposableStack"] {
        for call in [
            "use(null)",
            "use(undefined)",
            "use(1)",
            "use({get [Symbol.dispose]() { throw 'getter' }})",
            "adopt(1, null)",
            "defer(null)",
            "move()",
        ] {
            result(&format!("var s = new {brand}(); s.move(); try {{ s.{call} }} catch(e) {{ e.name + ':' + e.message }}"), &format!("ReferenceError:this: disposed {brand} instance"));
        }
    }
}

#[test]
fn noncallable_disposers_keep_distinct_sync_and_async_messages() {
    for (brand, message) in [
        ("DisposableStack", "dispose: not a function"),
        ("AsyncDisposableStack", "dispose: no a function"),
    ] {
        for call in [
            "use(1)",
            "use({})",
            "use({[Symbol.dispose]: 1})",
            "adopt(1, null)",
            "defer(null)",
        ] {
            result(
                &format!("try {{ new {brand}().{call} }} catch(e) {{ e.message }}"),
                message,
            );
        }
    }
}

#[test]
fn disposer_getters_are_observed_once_and_propagate_guest_throws() {
    result("var count = 0; var s = new DisposableStack(); try { s.use({get [Symbol.dispose]() { count++; throw 'getter' }}) } catch(e) { count + ':' + e }", "1:getter");
    result("var order = ''; var s = new AsyncDisposableStack(); s.use({get [Symbol.asyncDispose]() { order += 'a'; return 1 }, get [Symbol.dispose]() { order += 's'; return function() {} }}); order", "as");
    result(
        "var s = new DisposableStack(); Number.prototype[Symbol.dispose] = function() {}; s.use(1)",
        "1",
    );
}

#[test]
fn using_errors_are_catchable_and_uncaught_diagnostics_match() {
    for value in ["1", "{}", "{[Symbol.dispose]: 1}"] {
        let source =
            format!("try {{ using x = {value}; }} catch(e) {{ e.name + ':' + e.message }}");
        result(
            &source,
            "TypeError:using: [Symbol.dispose] is not a function",
        );
    }
    let run = dual_run("{ using x = {}; }").unwrap();
    assert_eq!(run.agreement, Agreement::BothAbort, "{run:?}");
    assert!(run.error_agrees, "{run:?}");
}

#[test]
fn async_dispose_brand_failure_rejects_instead_of_throwing() {
    let source = "var g = ''; try { AsyncDisposableStack.prototype.disposeAsync.call({}).then(undefined, function(e) { g = e.name + ':' + e.message }) } catch(e) { g = 'synchronous' }";
    let runs = dual_run_cranks(&[source, "g"]).unwrap();
    for run in &runs {
        assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
    }
    assert_eq!(
        runs[1].oracle_result,
        "TypeError:this: not a AsyncDisposableStack instance"
    );
    assert_eq!(runs[1].ironhorse_result, runs[1].oracle_result);
}

#[test]
fn await_using_reports_async_protocol_and_keeps_fallback_order() {
    let sources = [
        ("var g; async function f() { try { await using x = {}; } catch(e) { g = e.message } } f()", "using: neither [Symbol.asyncDispose] nor [Symbol.dispose] are function"),
        ("var g = ''; async function f() { await using x = {get [Symbol.asyncDispose]() { g += 'a'; return 1 }, get [Symbol.dispose]() { g += 's'; return function() { g += 'd' } }}; } f()", "asd"),
    ];
    for (source, expected) in sources {
        let runs = dual_run_cranks(&[source, "g"]).unwrap();
        for run in &runs {
            assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
        }
        assert_eq!(runs[1].oracle_result, expected);
        assert_eq!(runs[1].ironhorse_result, expected);
    }
}
