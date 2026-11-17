//! `Await` and an async generator's `return` resolve their operand with
//! `PromiseResolve(%Promise%, value)`, which reads `value.constructor` on a
//! native promise. The await fast path skipped that read, so a promise whose
//! `constructor` getter throws was adopted as though nothing had happened.
//! The pinned XS oracle reads the property and, when the read throws, resumes
//! the waiter with that error. These are the test262
//! `AsyncGeneratorPrototype/return/*-broken-promise*` rows.
//!
//! A RegExp exec result also carries `index`, `input`, `groups` and, under the
//! `d` flag, `indices.groups`, whether or not guest source spells those
//! names. They were created only when the program mentioned the name as an
//! identifier, so a probe by string key (`verifyProperty(indices, 'groups')`)
//! found nothing.

use ironhorse_262::dual_run;

fn settles_as_xs(body: &str) {
    let source = format!(
        "var out = ['pending']; \
         function broken() {{ var b = Promise.resolve(42); \
           Object.defineProperty(b, 'constructor', {{ get: function () {{ throw new Error('broken promise'); }} }}); \
           return b; }} \
         (async function () {{ {body} }})().then(\
         function (v) {{ out[0] = 'fulfilled ' + v; }}, function (e) {{ out[0] = 'rejected ' + e; }}); out"
    );
    let run = dual_run(&source).expect("the XS oracle machine must start");
    assert!(
        run.observables_agree(),
        "{body}\n  oracle={} ironhorse={}",
        run.oracle_result,
        run.ironhorse_result
    );
}

#[test]
fn an_await_reads_the_promise_constructor() {
    for body in [
        "var n = 0; var p = Promise.resolve(7); Object.defineProperty(p, 'constructor', { get: function () { n++; return Promise; } }); var v = await p; return v + ' ' + n;",
        "var p = Promise.resolve(8); p.constructor = function () {}; return await p;",
        "class Sub extends Promise {} return await Sub.resolve(9);",
        "return await Promise.resolve(10);",
    ] {
        settles_as_xs(body);
    }
}

/// A known XS departure: when the `constructor` read throws under a plain
/// async function's `await`, `fxStepAsync` rejects the function's promise
/// from its `mxCatch`, abandoning the body, so a surrounding `try` never sees
/// the error. ECMA-262 `Await` step 2 is `? PromiseResolve(...)`, a throw at
/// the `await` itself, which is what ironhorse does (V8 agrees). Under an
/// async generator, XS resumes the body with the throw, and the two agree.
#[test]
fn an_await_whose_constructor_read_throws_throws_at_the_await() {
    let source = "var out = ['pending']; \
         var b = Promise.resolve(42); \
         Object.defineProperty(b, 'constructor', { get: function () { throw new Error('broken promise'); } }); \
         (async function () { try { await b; return 'no throw'; } catch (e) { return 'caught ' + e.message; } })().then(\
         function (v) { out[0] = 'fulfilled ' + v; }, function (e) { out[0] = 'rejected ' + e; }); out";
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.ironhorse_result.to_string(),
        "fulfilled caught broken promise"
    );
    assert_eq!(
        run.oracle_result.to_string(),
        "rejected Error: broken promise"
    );
}

#[test]
fn an_async_generator_return_reads_the_promise_constructor() {
    for body in [
        "async function* g() { throw new Error('resumed'); } try { await g().return(broken()); return 'no throw'; } catch (e) { return 'caught ' + e.message; }",
        "async function* g() {} var it = g(); await it.next(); try { await it.return(broken()); return 'no throw'; } catch (e) { return 'caught ' + e.message; }",
        "var caught; async function* g() { try { yield; return 'never'; } catch (e) { caught = e; return 1; } } var it = g(); await it.next(); var r = await it.return(broken()); return caught.message + ' ' + r.value + ' ' + r.done;",
        "async function* g() { try { yield 1; } finally { return 2; } } var it = g(); await it.next(); var r = await it.return(broken()); return r.value + ' ' + r.done;",
    ] {
        settles_as_xs(body);
    }
}

#[test]
fn a_regexp_result_has_its_standard_properties_by_string_key() {
    for source in [
        "var r = /./.exec('a'); [Object.prototype.hasOwnProperty.call(r, 'index'), Object.prototype.hasOwnProperty.call(r, 'input'), Object.prototype.hasOwnProperty.call(r, 'groups')].join()",
        "var i = /./d.exec('a')['indic' + 'es']; [Array.isArray(i), Object.prototype.hasOwnProperty.call(i, 'groups'), i['grou' + 'ps']].join()",
        "var d = Object.getOwnPropertyDescriptor(/./d.exec('a')['indic' + 'es'], 'groups'); [d.writable, d.enumerable, d.configurable, d.value].join()",
        "Reflect.ownKeys(/(?<x>.)/d.exec('a')).join()",
    ] {
        let run = dual_run(source).expect("the XS oracle machine must start");
        assert!(
            run.observables_agree(),
            "{source}\n  oracle={} ironhorse={}",
            run.oracle_result,
            run.ironhorse_result
        );
    }
}
