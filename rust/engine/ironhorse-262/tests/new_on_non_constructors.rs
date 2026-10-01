//! `new` on a function without [[Construct]]: the pinned XS oracle's answer.
//!
//! XS's `RUN` refuses a target frame whose function `mxIsConstructor` rejects
//! with "new: not a constructor", after the arguments have run and before
//! the body is entered. Ironhorse checked [[Construct]] on the paths that
//! name a constructor (`Reflect.construct`, `extends`, bound functions) but
//! not on `new` itself, so `new` on an arrow, a method or an accessor built
//! an object, and `new` on a generator or an async function halted the
//! engine. A Proxy has [[Construct]] only when its target does; `new` on one
//! over a non-constructor ran its `construct` trap where XS throws "new:
//! proxy is not a constructor".

use ironhorse_262::{dual_run, dual_run_async, Agreement};

/// The program completes with the XS oracle's value.
fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert!(
        run.observables_agree(),
        "disagrees: {source}\n  oracle_result={} ironhorse_result={}\n  ironhorse_halt={:?}",
        run.oracle_result,
        run.ironhorse_result,
        run.ironhorse_halt,
    );
}

/// Every kind of function that has [[Call]] but no [[Construct]], as an
/// expression that evaluates to it.
const NON_CONSTRUCTORS: &[&str] = &[
    "() => 1",
    "async () => 1",
    "({ m() {} }).m",
    "({ async m() {} }).m",
    "({ *m() {} }).m",
    "({ async *m() {} }).m",
    "(class { m() {} }).prototype.m",
    "(class { static m() {} }).m",
    "(class { static async m() {} }).m",
    "Object.getOwnPropertyDescriptor({ get x() { return 1; } }, 'x').get",
    "Object.getOwnPropertyDescriptor({ set x(v) {} }, 'x').set",
    "(function* () {})",
    "(async function () {})",
    "(async function* () {})",
];

#[test]
fn new_on_each_non_constructor_throws_a_type_error() {
    for f in NON_CONSTRUCTORS {
        agrees(&format!(
            "var f = {f}; try {{ new f(); 'constructed' }} catch (e) {{ e.constructor.name + ': ' + e.message }}"
        ));
    }
}

#[test]
fn every_new_form_throws_after_its_arguments() {
    // `new f`, a spread, and arguments whose side effects run first, as
    // EvaluateNew evaluates them before IsConstructor.
    for f in NON_CONSTRUCTORS {
        agrees(&format!(
            "var f = {f}; var log = []; \
             try {{ new f; }} catch (e) {{ log.push(e.message); }} \
             try {{ new f(...[log.push('spread')]); }} catch (e) {{ log.push(e.message); }} \
             try {{ new f(log.push('arg'), log.push('arg2')); }} catch (e) {{ log.push(e.message); }} \
             log.join()"
        ));
    }
}

#[test]
fn a_non_constructor_reached_through_a_wrapper_throws_the_same() {
    for f in [
        "() => 1",
        "({ m() {} }).m",
        "(function* () {})",
        "(async function () {})",
    ] {
        agrees(&format!(
            "var f = {f}; var r = []; \
             try {{ new (f.bind(null))(); }} catch (e) {{ r.push(e.message); }} \
             try {{ new (new Proxy(f, {{}}))(); }} catch (e) {{ r.push(e.message); }} \
             try {{ new (new Proxy(f, {{ construct() {{ r.push('trap'); return {{}}; }} }}))(); }} \
             catch (e) {{ r.push(e.message); }} \
             try {{ new (new Proxy(new Proxy(f, {{}}), {{}}))(); }} catch (e) {{ r.push(e.message); }} \
             try {{ new (new Proxy(f.bind(null), {{}}))(); }} catch (e) {{ r.push(e.message); }} \
             try {{ Reflect.construct(f, []); }} catch (e) {{ r.push(e.message); }} \
             try {{ Reflect.construct(function () {{}}, [], f); }} catch (e) {{ r.push(e.message); }} \
             r.join(' | ')"
        ));
    }
}

#[test]
fn new_in_strict_code_and_in_a_nested_frame_throws_the_same() {
    agrees("'use strict'; var f = () => 1; try { new f(); 'constructed' } catch (e) { e.message }");
    agrees(
        "function outer(g) { try { return new g(); } catch (e) { return e.message; } } \
         [outer(() => 1), outer(function* () {}), typeof outer(function () {})].join()",
    );
    agrees(
        "var o = { m() { return new.target; } }; var r = []; \
         try { r.push(typeof new o.m()); } catch (e) { r.push(e.message); } \
         r.push(typeof o.m()); r.join()",
    );
}

#[test]
fn a_revoked_proxy_over_a_constructor_throws_its_revocation() {
    // A revoked Proxy over an arrow is a departure: Ironhorse has dropped the
    // target and throws the revocation error where XS, which keeps the
    // construct capability, says "new: proxy is not a constructor".
    agrees(
        "var r = Proxy.revocable(function () {}, {}); r.revoke(); \
         try { new r.proxy(); 'constructed' } catch (e) { e.message }",
    );
    agrees(
        "var r = Proxy.revocable(function () {}, {}); var p = new Proxy(r.proxy, {}); r.revoke(); \
         try { new p(); 'constructed' } catch (e) { e.message }",
    );
}

#[test]
fn an_async_arrow_in_a_constructor_keeps_its_new_target() {
    // `START_ASYNC` halted on any target frame, which `new` on an async
    // function no longer reaches: the only one left is an async arrow that
    // took its constructor's `new.target`, before and after an `await`.
    for (source, expected) in [
        (
            "var g = ''; class C { constructor() { var f = async () => { \
               g += new.target === C; await 0; g += ',' + (new.target === C); }; f(); } } \
             new C(); undefined",
            "true,true",
        ),
        (
            "var g = ''; function F() { var f = async () => new.target; \
               f().then((t) => { g = String(t === F); }); } new F(); undefined",
            "true",
        ),
    ] {
        let run = dual_run_async(source, "g").expect("the XS oracle machine must start");
        assert_eq!(run.run.agreement, Agreement::BothComplete, "{:?}", run.run);
        assert!(run.run.result_agrees, "{:?}", run.run);
        assert_eq!(run.ironhorse_signal.as_deref(), Some(expected), "{source}");
    }
}

#[test]
fn constructors_still_construct() {
    // The check must leave every constructor kind alone.
    agrees(
        "function F() { this.a = 1; } class C { constructor() { this.b = 2; } } \
         class D extends C {} var B = F.bind(null); \
         [new F().a, new C().b, new D().b, new B().a, new (new Proxy(F, {}))().a, \
          new (new Proxy(C, { construct(t, a) { return { c: 3 }; } }))().c, \
          Reflect.construct(D, []) instanceof D].join()",
    );
}
