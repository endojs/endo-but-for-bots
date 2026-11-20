//! A Proxy keeps the `[[Call]]` it was created with after revocation, a
//! revoked `new.target` makes the prototype fallback throw, and a Proxy
//! program completion stringifies through its target.
//!
//! * ProxyCreate (ECMA-262 10.5.14) gives a proxy `[[Call]]` when its target is
//!   callable, and revocation does not take it away, so `typeof` a revoked
//!   function proxy is still `"function"`, and so is a proxy over one. XS
//!   stamps `XS_CAN_CALL_FLAG` on the proxy instance (`fx_Proxy`,
//!   `fx_Proxy_revocable`) and its `typeof` reads it; ironhorse answered
//!   `"object"` once the target was gone.
//! * GetPrototypeFromConstructor falls back to an intrinsic only after
//!   GetFunctionRealm(newTarget), which throws a TypeError on a revoked proxy.
//!   A `get` trap that revokes its own proxy while `prototype` is read hits
//!   this (XS's `fxGetPrototypeFromConstructor`); ironhorse built the object.
//! * The harness renders a program completion with `String(result)`. A proxy
//!   instance has no prototype of its own, so ironhorse took a trap-less proxy
//!   over `{}` for a null-prototype object and reported a coercion TypeError
//!   where the oracle printed `[object Object]`.
//!
//! Each case fails on unpatched `llm`. Every expected string is the pinned
//! oracle's own result; the dual run asserts the two engines agree.
//! test262: `built-ins/Proxy/create-target-is-revoked-function-proxy.js`,
//! `built-ins/Proxy/revocable/target-is-revoked-function-proxy.js`,
//! `language/expressions/typeof/proxy.js`,
//! `built-ins/Function/internals/Construct/base-ctor-revoked-proxy.js`,
//! `built-ins/Object/seal/seal-proxy.js`.

use ironhorse_262::{dual_run, Agreement};

fn assert_agree(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn revoked_function_proxy_stays_callable() {
    assert_agree(
        "var r = Proxy.revocable(function () {}, {}); r.revoke(); typeof r.proxy",
        "function",
    );
    assert_agree(
        "var r = Proxy.revocable({}, {}); r.revoke(); typeof r.proxy",
        "object",
    );
    assert_agree(
        "var r = Proxy.revocable(function () {}, {}); r.revoke(); \
         typeof new Proxy(r.proxy, {})",
        "function",
    );
    assert_agree(
        "var r = Proxy.revocable(function () {}, {}); r.revoke(); \
         var o = Proxy.revocable(r.proxy, {}); o.revoke(); typeof o.proxy",
        "function",
    );
    // `typeof` reads the creation stamp; a call still refuses the revoked
    // proxy (XS's `fxIsCallable` follows the lost target).
    assert_agree(
        "var r = Proxy.revocable(function () {}, {}); r.revoke(); \
         try { r.proxy(); 'no throw'; } catch (e) { e.constructor.name }",
        "TypeError",
    );
}

#[test]
fn revoked_new_target_throws_at_prototype_fallback() {
    assert_agree(
        "var h = { get: function () { r.revoke(); } }; \
         var r = Proxy.revocable(function () {}, h); \
         try { new r.proxy(); 'no throw'; } catch (e) { e.constructor.name }",
        "TypeError",
    );
    // A live proxy whose `prototype` is not an object still falls back.
    assert_agree(
        "var p = new Proxy(function () {}, { get: function () {} }); \
         Object.getPrototypeOf(new p()) === Object.prototype",
        "true",
    );
}

#[test]
fn proxy_completion_stringifies_through_target() {
    assert_agree("new Proxy({}, {})", "[object Object]");
    assert_agree("Object.seal(new Proxy({}, {}))", "[object Object]");
}
