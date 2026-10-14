//! A rejected `await` inside async iteration throws where it happens, as on
//! the pinned XS oracle (V8 agrees).
//!
//! `THROW_STATUS`, which follows every `AWAIT` of a `for await` next and
//! close, a `yield*` and an async generator's `yield` and `return`, was a
//! no-op, so the body resumed with the rejection reason as a value: an async
//! generator's thrown error vanished from `for await` and the loop body ran.
//! And a rejected `yield` operand completed the async generator instead of
//! throwing at the `yield`, where a `try` can catch it.

use ironhorse_262::dual_run;

fn settles_as_xs(body: &str) {
    let source = format!(
        "var out = ['pending']; (async function () {{ {body} }})().then(\
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
fn a_rejection_during_for_await_throws_in_the_loop() {
    for body in [
        "var r = []; async function* g() { yield 1; throw new Error('x'); } for await (var x of g()) r.push(String(x)); return r.join('|')",
        "var r = []; async function* g() { yield 1; throw new Error('x'); } try { for await (var x of g()) r.push(String(x)); } catch (e) { r.push('caught ' + e.message); } return r.join('|')",
        "var r = []; var it = { [Symbol.asyncIterator]() { return { next() { return Promise.reject(new Error('n')); } }; } }; for await (var x of it) r.push(x); return r.join()",
        "var r = []; var it = { [Symbol.asyncIterator]() { var i = 0; return { next() { return { value: 1, done: i++ > 0 }; }, return() { return Promise.reject(new Error('ret')); } }; } }; for await (var x of it) { r.push(x); break; } return r.join()",
        "var r = []; var it = { [Symbol.asyncIterator]() { return { next() { return { get then() { throw new Error('then'); } }; } }; } }; try { for await (var x of it) r.push(x); } catch (e) { r.push(e.message); } return r.join()",
        "var r = []; var it = { [Symbol.asyncIterator]() { var i = 0; return { next() { return { value: 1, done: i++ > 0 }; }, return() { return { get then() { throw new Error('rthen'); } }; } }; } }; try { for await (var x of it) { r.push(x); break; } } catch (e) { r.push(e.message); } return r.join()",
    ] {
        settles_as_xs(body);
    }
}

#[test]
fn a_rejected_yield_operand_throws_at_the_yield() {
    for body in [
        "async function* g() { try { yield Promise.reject(new Error('e')); } catch (e) { return 'caught ' + e.message; } } return JSON.stringify(await g().next())",
        "async function* g() { yield Promise.reject(new Error('e')); yield 2; } var it = g(); var r = []; try { await it.next(); } catch (e) { r.push('rej ' + e.message); } r.push(JSON.stringify(await it.next())); return r.join('|')",
        "async function* g() { try { yield Promise.reject(1); } finally { yield 5; } } var it = g(); var r = []; r.push(JSON.stringify(await it.next())); try { r.push(JSON.stringify(await it.next())); } catch (e) { r.push('rej ' + e); } return r.join('|')",
        "async function* g() { var x = yield Promise.reject(1); return x; } var it = g(); var r = []; try { await it.next(); } catch (e) { r.push('rej ' + e); } return r.join()",
        "async function* inner() { yield Promise.reject(new Error('inner')); } async function* g() { try { yield* inner(); } catch (e) { yield 'caught ' + e.message; } } var r = []; for await (var x of g()) r.push(x); return r.join()",
    ] {
        settles_as_xs(body);
    }
}

/// A `yield*` does not await what it yields: a sync delegate's rejected value
/// rejects the delegation's `next`, not the body at the `yield*`. Resuming the
/// body there sent the reason into the delegate's `throw` through an epilogue
/// whose operand was already popped (`value-stack:underflow`), the test262
/// `yield-promise-reject-next-yield-star-sync-iterator` family.
#[test]
fn a_rejected_value_from_a_sync_yield_star_delegate_rejects_the_request() {
    for body in [
        "async function* g() { yield* [Promise.reject(new Error('e')), 'unreachable']; } var it = g(); var r = []; try { await it.next(); } catch (e) { r.push('rej ' + e.message); } r.push(JSON.stringify(await it.next())); return r.join('|')",
        "var e = new Error('e'); async function* g() { yield* [1, Promise.reject(e)]; } var it = g(); var r = [JSON.stringify(await it.next())]; try { await it.next(); } catch (x) { r.push(x === e); } return r.join('|')",
    ] {
        settles_as_xs(body);
    }
}
