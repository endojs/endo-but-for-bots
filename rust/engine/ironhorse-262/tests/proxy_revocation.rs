//! A revoked Proxy keeps the `[[Call]]` and `[[Construct]]` it was created
//! with (ECMA-262 10.5.14 ProxyCreate steps 6-7; XS's `fx_Proxy` copies
//! `XS_CAN_CALL_FLAG`/`XS_CAN_CONSTRUCT_FLAG` from the target), and
//! GetPrototypeFromConstructor throws for a revoked Proxy `new.target` whose
//! `prototype` read gave a non-object (GetFunctionRealm). Each source runs on
//! Ironhorse and on the pinned XS oracle, and both must give the expected
//! completion. These are the cases behind the test262 rows
//! `built-ins/Proxy/create-target-is-revoked-function-proxy.js`,
//! `built-ins/Proxy/revocable/target-is-revoked-function-proxy.js`,
//! `language/expressions/typeof/proxy.js` and
//! `built-ins/Function/internals/Construct/base-ctor-revoked-proxy.js`.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
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
fn revoked_proxy_keeps_its_call_and_construct() {
    assert_result_agrees(
        "var f = Proxy.revocable(function () {}, {}); f.revoke(); \
         var o = Proxy.revocable({}, {}); o.revoke(); \
         [typeof f.proxy, typeof o.proxy, typeof new Proxy(f.proxy, {}), \
          typeof Proxy.revocable(f.proxy, {}).proxy].join()",
        "function,object,function,function",
    );
}

#[test]
fn new_on_a_revoked_proxy_still_throws_a_type_error() {
    assert_result_agrees(
        "var r = []; \
         var f = Proxy.revocable(function () {}, {}); f.revoke(); \
         try { new f.proxy(); r.push('none'); } catch (e) { r.push(e.constructor.name); } \
         var a = Proxy.revocable(() => {}, {}); a.revoke(); \
         try { new a.proxy(); r.push('none'); } catch (e) { r.push(e.constructor.name + ': ' + e.message); } \
         r.join()",
        "TypeError,TypeError: new: proxy is not a constructor",
    );
}

#[test]
fn construct_through_a_proxy_revoked_by_its_prototype_read_throws() {
    assert_result_agrees(
        "var handle = Proxy.revocable(function () {}, { get: function () { handle.revoke(); } }); \
         var f = handle.proxy; \
         try { new f(); 'none'; } catch (e) { e.constructor.name; }",
        "TypeError",
    );
}
