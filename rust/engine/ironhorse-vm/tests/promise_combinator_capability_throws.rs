//! A promise combinator's capability functions may throw while the
//! combinator is settling them, and that throw is a synchronous abrupt
//! completion of the combinator call (ECMA-262 `IfAbruptRejectPromise`
//! is `? Call(capability.[[Reject]], …)`): the caller's `try` catches
//! it. The combinator runs behind the native-try fence, and the fence's
//! outcome used to be returned verbatim rather than re-raised, so the
//! throw skipped every live `catch` between the combinator and the
//! program boundary, and — once the fence started refusing a `Threw`
//! that leaves handlers installed (F170) — a nested combinator tripped
//! that refusal instead. Both shapes are pinned here, oracle-free.

fn run(src: &str) -> String {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    let o = ironhorse_vm::run_program_with_symbols(&b, &s);
    assert!(o.completed, "{:?}", o.halt);
    o.result
}

/// A custom combinator constructor whose capability's `reject` throws.
const THROWING_CAPABILITY: &str = "\
    function C2(exec) { exec(function () {}, function () { throw 'inner-rejthrow'; }); } \
    C2.resolve = function (v) { return v; }; \
    var bad = { }; bad[Symbol.iterator] = function () { throw 'x'; }; ";

#[test]
fn a_throwing_capability_reject_is_caught_by_the_callers_try() {
    let result = run(&format!(
        "{THROWING_CAPABILITY} var r = 0; \
         try {{ Promise.all.call(C2, bad); r = 'ok'; }} catch (e) {{ r = 'caught:' + e; }} r"
    ));
    assert_eq!(result, "caught:inner-rejthrow");
}

#[test]
fn a_throw_inside_a_nested_combinator_is_caught_at_the_nearest_try() {
    let result = run(&format!(
        "{THROWING_CAPABILITY} var r = 0; var inner = 0; \
         function C1(exec) {{ exec(function () {{}}, function () {{ \
             try {{ Promise.all.call(C2, bad); inner = 'ok'; }} \
             catch (e) {{ inner = 'caught:' + e; }} }}); }} \
         C1.resolve = function (v) {{ return v; }}; \
         var bad1 = {{ }}; bad1[Symbol.iterator] = function () {{ throw 'y'; }}; \
         try {{ Promise.all.call(C1, bad1); r = 'ok'; }} catch (e) {{ r = 'caught:' + e; }} \
         r + '/' + inner"
    ));
    assert_eq!(result, "ok/caught:inner-rejthrow");
}

#[test]
fn a_throw_inside_a_fenced_callback_is_caught_by_the_callbacks_own_try() {
    let result = run(&format!(
        "{THROWING_CAPABILITY} var r = 0; var inner = 0; \
         try {{ Array.from([1], function () {{ \
             try {{ Promise.all.call(C2, bad); inner = 'ok'; }} \
             catch (e) {{ inner = 'caught:' + e; }} }}); r = 'ok'; }} \
         catch (e) {{ r = 'caught:' + e; }} \
         r + '/' + inner"
    ));
    assert_eq!(result, "ok/caught:inner-rejthrow");
}

#[test]
fn every_combinator_re_raises_a_throwing_capability() {
    for combinator in ["all", "allSettled", "race", "any"] {
        let result = run(&format!(
            "{THROWING_CAPABILITY} var r = 0; \
             try {{ Promise.{combinator}.call(C2, bad); r = 'ok'; }} catch (e) {{ r = 'caught:' + e; }} r"
        ));
        assert_eq!(result, "caught:inner-rejthrow", "{combinator}");
    }
}
