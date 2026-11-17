//! Guest code halts the crank, never the process: every guest-reachable
//! native recursion is bounded by the engine's one native-recursion budget
//! ([`NATIVE_DEPTH_LIMIT`]) and degrades to a structured
//! [`Halt::ReentryLimit`] — the abort-to-host XS raises from
//! `fxCheckCStack` — instead of overflowing the host thread's stack, which is
//! a `SIGABRT` no `catch_unwind` can contain.
//!
//! Before the budget, `DISPATCH_REENTRY_LIMIT` bounded exactly one family
//! (bytecode re-entry through `dispatch_at`); at least eight others recursed
//! on the host's terms: a Proxy forwarding an internal method to a Proxy
//! target (or to a Proxy in a prototype chain, which a spec-legal cycle makes
//! infinite), a built-in invoking a built-in (`join` → `toString` → `join`
//! over a self-containing array), `JSON.parse` and `JSON.stringify` over
//! nested data, the host-boundary renderer over a nested or cyclic completion
//! or thrown value, `Array.prototype.flat`, an ordinary prototype chain read
//! or written through the MOP, the async-generator request drain, and the
//! bound-function / `call` / `apply` redispatch chain. Four lines of ordinary
//! JavaScript killed the worker at a depth that depended on the host stack
//! size and the build profile.
//!
//! One test per family. Each runs on a thread of exactly
//! [`NATIVE_STACK_BYTES`], the size the budget is calibrated for per build
//! profile: the family halting cleanly there is the contract; a regression to
//! a native overflow takes the whole test binary down, which is the point.
//! The within-budget twin of each family pins that the ceiling is above what
//! real programs do, so the bound is a bound and not a new refusal. Two
//! families are bounded without a refusal at all — a walk that loops (the
//! redispatch chain, the exotic prototype chains) completes at any length,
//! and the throw-site render, a diagnostic, falls back to a stub rather than
//! halt a crank a native driver may still catch.

use ironhorse_runtime::IronhorseSourceCompiler;
use ironhorse_vm::{Halt, Interp, RunOutcome, NATIVE_DEPTH_LIMIT, NATIVE_STACK_BYTES};

/// The stack-lane corpus (`stack-lanes/cases.rs`): the heavy re-entry
/// families at their measured ceilings, shared with the probe every lane runs.
#[path = "../../stack-lanes/cases.rs"]
mod cases;

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("fixture compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// Run `source` as one crank on a fresh machine, on a thread of the
/// documented stack size. A native overflow aborts the process here; a
/// panic fails the join.
fn on_contract_stack(source: String) -> RunOutcome {
    std::thread::Builder::new()
        .stack_size(NATIVE_STACK_BYTES)
        .spawn(move || {
            let (bytecode, names) = compile(&source);
            let mut machine = Interp::new();
            machine.link_intrinsics(&names);
            machine.run(&bytecode)
        })
        .expect("spawn the contract-stack thread")
        .join()
        .expect("the engine must halt, never panic or abort")
}

/// As [`on_contract_stack`], also reading the top-level binding `global`
/// after the run — the observation a promise reaction records.
fn on_contract_stack_with_global(
    source: String,
    global: &'static str,
) -> (RunOutcome, Option<String>) {
    std::thread::Builder::new()
        .stack_size(NATIVE_STACK_BYTES)
        .spawn(move || {
            let (bytecode, names) = compile(&source);
            let mut machine = Interp::new();
            machine.link_intrinsics(&names);
            let out = machine.run(&bytecode);
            let observed = machine.global_string(global);
            (out, observed)
        })
        .expect("spawn the contract-stack thread")
        .join()
        .expect("the engine must halt, never panic or abort")
}

fn assert_stack_overflow(out: &RunOutcome, what: &str) {
    assert!(
        matches!(out.halt, Halt::ReentryLimit { depth, limit } if depth > limit && limit == NATIVE_DEPTH_LIMIT),
        "{what} must halt with ReentryLimit at the native-recursion budget; halt: {:?}",
        out.halt
    );
    assert!(!out.completed, "{what} must not complete");
}

fn assert_completes(out: &RunOutcome, want: &str, what: &str) {
    assert!(
        out.completed,
        "{what} must complete within the budget; halt: {:?}",
        out.halt
    );
    assert_eq!(out.result, want, "{what}: completion value");
}

/// `layers` proxies wrapped around `{x: 1}`, then `tail`.
fn proxy_chain(layers: usize, tail: &str) -> String {
    format!("var p = {{x: 1}}; for (var i = 0; i < {layers}; i++) p = new Proxy(p, {{}}); {tail}")
}

/// `depth` arrays nested inside `a`, each the sole element of its parent.
fn nested_arrays(depth: usize) -> String {
    format!("var a = []; var r = a; for (var i = 0; i < {depth}; i++) {{ var b = []; r[0] = b; r = b; }} ")
}

#[test]
fn a_proxy_prototype_cycle_halts_instead_of_overflowing_the_host_stack() {
    // The review's reproducer: a Proxy in an ordinary object's prototype chain
    // whose target is that very object. `OrdinarySetPrototypeOf`'s cycle check
    // stops at a Proxy (spec-legal), so `[[Get]]` forwards forever. V8 and JSC
    // produce a RangeError; XS aborts on its C stack; ironhorse aborted the
    // process.
    let out = on_contract_stack(
        "var t = {}; var p = new Proxy(t, {}); Object.setPrototypeOf(t, p); t.zzz".into(),
    );
    assert_stack_overflow(&out, "a proxy prototype cycle");
}

#[test]
fn a_proxy_prototype_cycle_bounds_the_iterative_chain_walks() {
    // `instanceof` and `isPrototypeOf` step through `[[GetPrototypeOf]]` in
    // a loop rather than recursing, so the cycle used to spin forever — a
    // stuck worker rather than a crashed one. Each Proxy step now counts
    // against the same budget the recursive shape would have consumed.
    let cycle = "var t = {}; var p = new Proxy(t, {}); Object.setPrototypeOf(t, p); ";
    for tail in ["t instanceof Object", "Object.prototype.isPrototypeOf(t)"] {
        assert_stack_overflow(
            &on_contract_stack(format!("{cycle}{tail}")),
            &format!("a proxy prototype cycle under {tail}"),
        );
    }
    // A finite Proxy chain in the prototype walk still answers.
    assert_completes(
        &on_contract_stack(
            "function F() {} var o = new F(); var p = o; \
             for (var i = 0; i < 64; i++) p = new Proxy(p, {}); \
             [p instanceof F, F.prototype.isPrototypeOf(p)].join()"
                .into(),
        ),
        "true,true",
        "a 64-layer proxy chain under instanceof and isPrototypeOf",
    );
}

#[test]
fn exotic_prototype_chains_are_walked_in_place() {
    // Arrays, functions, wrappers and TypedArrays as prototypes carry an
    // exotic own surface, which `[[Get]]` consults per level in place rather
    // than by recursing into the parent's `mop_get` — `class extends` chains
    // are function-prototype chains, so a static lookup walks one.
    let chains = [
        (
            "arrays",
            "var o = []; for (var i = 0; i < 20000; i++) { var a = []; Object.setPrototypeOf(a, o); o = a; } ",
        ),
        (
            "functions",
            "var o = function () {}; for (var i = 0; i < 20000; i++) { var f = function () {}; Object.setPrototypeOf(f, o); o = f; } ",
        ),
        (
            "Number wrappers",
            "var o = new Number(1); for (var i = 0; i < 20000; i++) { var w = new Number(2); Object.setPrototypeOf(w, o); o = w; } ",
        ),
        (
            "String wrappers",
            "var o = new String('ab'); for (var i = 0; i < 20000; i++) { var w = new String('cd'); Object.setPrototypeOf(w, o); o = w; } ",
        ),
        (
            "TypedArrays",
            "var o = new Int8Array(1); for (var i = 0; i < 20000; i++) { var w = new Int8Array(1); Object.setPrototypeOf(w, o); o = w; } ",
        ),
    ];
    for (name, chain) in chains {
        assert_completes(
            &on_contract_stack(format!("{chain} o.zzz === undefined")),
            "true",
            &format!("a 20,000-deep chain of {name}: a missing property"),
        );
        assert_completes(
            &on_contract_stack(format!("{chain} o.zzz = 1; o.zzz")),
            "1",
            &format!("a 20,000-deep chain of {name}: a missing property set"),
        );
    }
    // The exotic own surface is still honored at every level.
    assert_completes(
        &on_contract_stack(
            "var o = function named() {}; \
             for (var i = 0; i < 2000; i++) { var f = function () {}; Object.setPrototypeOf(f, o); o = f; } \
             var s = new String('xy'); for (var i = 0; i < 2000; i++) { var w = {}; Object.setPrototypeOf(w, s); s = w; } \
             var t = new Int8Array([7]); for (var i = 0; i < 2000; i++) { var u = {}; Object.setPrototypeOf(u, t); t = u; } \
             [o.name, s[1], s.length, t[0]].join()"
                .into(),
        ),
        "f,y,2,7",
        "exotic own properties through long chains",
    );
}

#[test]
fn a_deep_proxy_forwarding_chain_halts_and_a_shallow_one_completes() {
    assert_stack_overflow(
        &on_contract_stack(proxy_chain(10_000, "p.x")),
        "a 10,000-layer proxy [[Get]] chain",
    );
    assert_completes(
        &on_contract_stack(proxy_chain(256, "p.x")),
        "1",
        "a 256-layer proxy [[Get]] chain",
    );
}

/// The same forwarding families reached by an INDEX key.
///
/// An index whose canonical name the key table has never held takes a
/// separate path through the MOP (it must, or reading it would mint a
/// property id per novel index and exhaust the shared `u16` key space). That
/// path forwards down a proxy chain exactly like the named one, so it has to
/// be charged to the same budget — `[[Get]]` and `[[GetOwnProperty]]` were
/// not, and ran past the ceiling their named spellings stopped at, which on a
/// contract-sized stack is the `SIGABRT` this whole file exists to prevent.
#[test]
fn every_forwarded_proxy_internal_method_is_bounded_for_an_index_key() {
    let tails = [
        ("[[Get]]", "p[0]"),
        ("[[HasProperty]]", "0 in p"),
        ("[[Delete]]", "delete p[0]"),
        (
            "[[GetOwnProperty]]",
            "Object.getOwnPropertyDescriptor(p, 0)",
        ),
        ("[[Get]] via Reflect", "Reflect.get(p, 0)"),
        ("[[HasProperty]] via Reflect", "Reflect.has(p, 0)"),
        ("[[Delete]] via Reflect", "Reflect.deleteProperty(p, 0)"),
        (
            "[[GetOwnProperty]] via Reflect",
            "Reflect.getOwnPropertyDescriptor(p, 0)",
        ),
    ];
    for (name, tail) in tails {
        assert_stack_overflow(
            &on_contract_stack(proxy_chain(10_000, tail)),
            &format!("a 10,000-layer proxy {name} index chain"),
        );
    }
    // The within-budget twin: the ceiling is above what real programs do.
    for (_, tail) in tails {
        let out = on_contract_stack(proxy_chain(256, tail));
        assert!(
            out.completed,
            "a 256-layer proxy index chain must complete within the budget; halt: {:?}",
            out.halt
        );
    }
}

#[test]
fn every_forwarded_proxy_internal_method_is_bounded() {
    // Each of the thirteen internal methods forwards to the target when its
    // trap is absent, one native frame per layer.
    let tails = [
        ("[[Set]]", "p.x = 2; 1"),
        ("[[HasProperty]]", "'x' in p"),
        ("[[Delete]]", "delete p.x"),
        ("[[OwnPropertyKeys]]", "Object.keys(p).length"),
        (
            "[[GetOwnProperty]]",
            "Object.getOwnPropertyDescriptor(p, 'x').value",
        ),
        (
            "[[DefineOwnProperty]]",
            "Object.defineProperty(p, 'y', {value: 1}); 1",
        ),
        (
            "[[GetPrototypeOf]]",
            "Object.getPrototypeOf(p) === Object.prototype",
        ),
        ("[[SetPrototypeOf]]", "Object.setPrototypeOf(p, null); 1"),
        ("[[IsExtensible]]", "Object.isExtensible(p)"),
        ("[[PreventExtensions]]", "Object.preventExtensions(p); 1"),
    ];
    for (name, tail) in tails {
        assert_stack_overflow(
            &on_contract_stack(proxy_chain(10_000, tail)),
            &format!("a 10,000-layer proxy {name} chain"),
        );
    }
    assert_stack_overflow(
        &on_contract_stack(
            "var p = function () { return 1; }; for (var i = 0; i < 10000; i++) p = new Proxy(p, {}); p()"
                .into(),
        ),
        "a 10,000-layer proxy [[Call]] chain",
    );
    assert_stack_overflow(
        &on_contract_stack(
            "var p = function () {}; for (var i = 0; i < 10000; i++) p = new Proxy(p, {}); new p(); 1"
                .into(),
        ),
        "a 10,000-layer proxy [[Construct]] chain",
    );
}

#[test]
fn a_built_in_re_entering_a_built_in_is_bounded() {
    // `join` stringifies each element; an element that is the array itself
    // runs `Array.prototype.toString`, which is `join` again — native to
    // native, never through `dispatch_at`, so the old re-entry counter never
    // saw it.
    assert_stack_overflow(
        &on_contract_stack("var a = []; a[0] = a; a.join()".into()),
        "join over a self-containing array",
    );
    assert_stack_overflow(
        &on_contract_stack("var a = []; a[0] = a; String(a)".into()),
        "String() of a self-containing array",
    );
}

#[test]
fn a_self_containing_completion_value_is_refused_at_the_render_boundary() {
    // The host boundary's `String(result)` runs after the crank has halted, so
    // no meter and no step limit applied: three lines killed the daemon on its
    // only result path.
    assert_stack_overflow(
        &on_contract_stack("var a = []; a[0] = a; a".into()).host_coerced(),
        "rendering a self-containing completion value",
    );
    // The mutual-cycle form.
    assert_stack_overflow(
        &on_contract_stack("var a = []; var b = [a]; a[0] = b; a".into()).host_coerced(),
        "rendering a mutually cyclic completion value",
    );
}

#[test]
fn a_thrown_value_the_renderer_refuses_is_reported_with_the_stub_text() {
    // The host diagnostic bounds structural recursion. A self-containing
    // array falls back to the reference stub without executing guest code or
    // replacing the original throw. Native drivers still catch the raw value.
    let out = on_contract_stack("var a = []; a[0] = a; throw a".into());
    assert!(
        matches!(&out.halt, Halt::Throw { rendered, .. } if rendered == "[object Object]"),
        "a thrown self-containing array is an ordinary throw with the stub text; halt: {:?}",
        out.halt
    );
    assert!(!out.completed, "an uncaught throw never completes");
    // The same refusal one guest frame higher, inside the thrown value's own
    // `toString`, is the same ordinary throw.
    let out = on_contract_stack(
        "var a = []; a[0] = a; throw { toString: function() { return a.join(); } }".into(),
    );
    assert!(
        matches!(&out.halt, Halt::Throw { rendered, .. } if rendered == "[object Object]"),
        "a thrown object whose toString runs past the budget; halt: {:?}",
        out.halt
    );
    // Driver-caught: an async body's throw becomes its promise's rejection,
    // which the guest handles.
    let (out, observed) = on_contract_stack_with_global(
        "var a = []; a[0] = a; var out = 'pending'; \
         async function f() { throw a; } \
         f().catch(function(e) { out = e === a ? 'caught' : 'other'; }); 1"
            .into(),
        "out",
    );
    assert_completes(
        &out,
        "1",
        "an async function throwing a self-containing array",
    );
    assert_eq!(
        observed.as_deref(),
        Some("caught"),
        "the rejection reason is the value"
    );
    // A promise reaction's throw becomes the derived promise's rejection.
    let (out, observed) = on_contract_stack_with_global(
        "var a = []; a[0] = a; var out = 'pending'; \
         Promise.resolve(1).then(function() { throw a; }) \
             .catch(function(e) { out = e === a ? 'caught' : 'other'; }); 1"
            .into(),
        "out",
    );
    assert_completes(&out, "1", "a reaction throwing a self-containing array");
    assert_eq!(
        observed.as_deref(),
        Some("caught"),
        "the rejection reason is the value"
    );
    // A callback's throw unwinds to the guest handler in the outer frame
    // before it escapes anything, so nothing is rendered at all.
    let out = on_contract_stack(
        "var a = []; a[0] = a; var r = 'no'; \
         try { [1].forEach(function() { throw a; }); } \
         catch (e) { r = e === a ? 'caught' : 'other'; } r"
            .into(),
    );
    assert_completes(
        &out,
        "caught",
        "a callback throwing a self-containing array",
    );
}

#[test]
fn bound_call_and_apply_trampolines_are_folded_in_place() {
    // `c = c.call.bind(c)` alternates a bound wrapper (folded to its target,
    // `Function.prototype.call`, with the previous link as receiver) and the
    // `call` trampoline (redispatching that receiver): two redispatches per
    // link that enter no charged frame, so `invoke_value` loops rather than
    // recurses. 10,000 links overflowed a 32 MiB thread; XS completes them.
    let out = on_contract_stack(
        "function f() { return 7; } var c = f; \
         for (var i = 0; i < 10000; i++) c = c.call.bind(c); c()"
            .into(),
    );
    assert_completes(&out, "7", "a 10,000-link call.bind chain");
    let out = on_contract_stack(
        "function f() { return 8; } var c = f; \
         for (var i = 0; i < 10000; i++) c = c.apply.bind(c); c()"
            .into(),
    );
    assert_completes(&out, "8", "a 10,000-link apply.bind chain");
}

#[test]
fn a_nested_completion_value_renders_within_the_budget() {
    let out = on_contract_stack(format!("{} a", nested_arrays(256)));
    assert_completes(&out, "", "rendering 256 nested arrays");
}

#[test]
fn json_parse_nesting_is_bounded() {
    assert_stack_overflow(
        &on_contract_stack("JSON.parse('['.repeat(10000) + ']'.repeat(10000)); 1".into()),
        "JSON.parse of 10,000 nested arrays",
    );
    assert_stack_overflow(
        &on_contract_stack(
            "JSON.parse('{\"a\":'.repeat(10000) + '1' + '}'.repeat(10000)); 1".into(),
        ),
        "JSON.parse of 10,000 nested objects",
    );
    assert_completes(
        &on_contract_stack("JSON.parse('['.repeat(256) + ']'.repeat(256)); 1".into()),
        "1",
        "JSON.parse of 256 nested arrays",
    );
}

#[test]
fn a_json_reviver_that_deepens_its_holder_is_bounded() {
    // `InternalizeJSONProperty` reads each property at visit time, so a
    // reviver called for one element can install an arbitrarily deep value
    // as the next one and the walk recurses into it; that walk is one light
    // frame per level of the same budget (it used to carry a private cap).
    let deepen = |depth: usize| {
        format!(
            "{} JSON.parse('[1,2]', function (k, v) {{ if (k === '0') this[1] = a; return v; }}); 1",
            nested_arrays(depth)
        )
    };
    assert_stack_overflow(
        &on_contract_stack(deepen(10_000)),
        "a reviver installing a 10,000-deep sibling",
    );
    assert_completes(
        &on_contract_stack(deepen(200)),
        "1",
        "a reviver installing a 200-deep sibling",
    );
}

#[test]
fn json_stringify_nesting_is_bounded() {
    assert_stack_overflow(
        &on_contract_stack(format!(
            "{} JSON.stringify(a).length",
            nested_arrays(10_000)
        )),
        "JSON.stringify of 10,000 nested arrays",
    );
    assert_completes(
        &on_contract_stack(format!("{} JSON.stringify(a).length", nested_arrays(256))),
        "514",
        "JSON.stringify of 256 nested arrays",
    );
}

#[test]
fn flat_over_a_self_containing_array_is_bounded() {
    // Formerly a private cap answering `Halt::NotImplemented("flat:recursion-depth")`;
    // now the one budget, answering the abort XS reaches on its C stack.
    assert_stack_overflow(
        &on_contract_stack("var a = []; a[0] = a; a.flat(Infinity)".into()),
        "flat(Infinity) over a self-containing array",
    );
    assert_completes(
        &on_contract_stack(format!("{} a.flat(Infinity).length", nested_arrays(256))),
        "0",
        "flat(Infinity) over 256 nested arrays",
    );
}

#[test]
fn nested_callbacks_halt_past_the_budget_and_complete_within_it() {
    // The family the old `DISPATCH_REENTRY_LIMIT` covered, at the same
    // allowance: each `forEach` level is a `call_native_method` activation
    // plus a `dispatch_at` re-entry, two heavy frames, on top of the
    // top-level program's own dispatch.
    let nest = |levels: usize| {
        format!(
            "function f(n) {{ if (n > 0) [0].forEach(function () {{ f(n - 1); }}); }} f({levels}); 1"
        )
    };
    assert_completes(
        &on_contract_stack(nest(63)),
        "1",
        "63 nested forEach callbacks",
    );
    assert_stack_overflow(&on_contract_stack(nest(64)), "64 nested forEach callbacks");
    assert_stack_overflow(
        &on_contract_stack(nest(10_000)),
        "10,000 nested forEach callbacks",
    );
}

#[test]
fn nested_synchronous_async_calls_are_bounded() {
    // Each async call runs its body synchronously to the first `await` in a
    // nested `dispatch_at` (XS's `fxRunID` re-entry), one heavy frame per
    // level.
    let nest = |levels: usize| {
        format!("async function f(n) {{ if (n > 0) await f(n - 1); }} f({levels}); 1")
    };
    assert_completes(
        &on_contract_stack(nest(64)),
        "1",
        "64 nested synchronous async calls",
    );
    assert_stack_overflow(
        &on_contract_stack(nest(10_000)),
        "10,000 nested synchronous async calls",
    );
}

#[test]
fn a_queued_async_generator_drain_is_iterative() {
    // `kick` ↔ `finish` used to recurse once per queued request on a finished
    // generator; 40,000 `next()` calls aborted the process.
    let out = on_contract_stack(
        "async function* ag() {} var g = ag(); for (var i = 0; i < 40000; i++) g.next(); 1".into(),
    );
    assert_completes(&out, "1", "draining 40,000 queued async-generator requests");
}

#[test]
fn an_ordinary_prototype_chain_is_walked_in_place() {
    // `OrdinaryGet`/`OrdinarySet` delegate a miss to the parent's full
    // internal method; for a plain parent that is the same algorithm, so the
    // walk continues in place (XS's `fxGetProperty` loop) instead of nesting
    // one native frame per prototype level.
    let chain = "var o = {x: 1}; for (var i = 0; i < 20000; i++) o = Object.create(o); ";
    for (tail, want) in [
        ("o.x", "1"),
        ("Reflect.get(o, 'x')", "1"),
        ("o.y = 2; o.y", "2"),
        ("Reflect.set(o, 'y', 2); o.y", "2"),
        ("'x' in o", "true"),
    ] {
        assert_completes(
            &on_contract_stack(format!("{chain}{tail}")),
            want,
            &format!("a 20,000-deep ordinary prototype chain: {tail}"),
        );
    }
}

#[test]
fn an_alternating_ordinary_and_proxy_chain_is_walked_in_one_loop() {
    // An id-keyed `[[Get]]` or `[[Set]]` that crosses from an ordinary object
    // to a Proxy prototype and on to the Proxy's ordinary target takes the
    // crossings after its first in one loop (STACK-DEPTH-REFACTOR.md B9),
    // charging the unit the parent's or the target's guarded entry charged:
    // two per pair, so the budget refuses at the depth the recursion did. The recursion needed
    // about a kilobyte of host stack per pair natively, more than this
    // thread's stack at these depths; the loop needs none per pair.
    let alt = "function alt(o, n) { for (var i = 0; i < n; i++) o = i % 2 ? Object.create(o) : new Proxy(o, {}); return o; } ";
    let on_small_stack = |source: String| {
        std::thread::Builder::new()
            .stack_size(NATIVE_STACK_BYTES / 16)
            .spawn(move || {
                let (bytecode, names) = compile(&source);
                let mut machine = Interp::new();
                machine.link_intrinsics(&names);
                machine.run(&bytecode)
            })
            .expect("spawn the small-stack thread")
            .join()
            .expect("the engine must halt, never panic or abort")
    };
    for (n, tail, want) in [
        (2031, "p.x", Some("1")),
        (2032, "p.x", None),
        (2015, "Reflect.get(p, 'x')", Some("1")),
        (2016, "Reflect.get(p, 'x')", None),
        (2030, "p.y = 2; p.y", Some("2")),
        (2031, "p.y = 2", None),
    ] {
        let out = on_small_stack(format!("{alt}var p = alt({{x: 1}}, {n}); {tail}"));
        let what = format!("an alternating chain of {n}: {tail}");
        match want {
            Some(want) => assert_completes(&out, want, &what),
            None => assert_stack_overflow(&out, &what),
        }
    }
}

/// [`on_contract_stack`] with the production eval bridge installed, so the
/// compiler-side budgets are observed through the guest-visible surface.
fn on_contract_stack_with_compiler(source: String) -> RunOutcome {
    std::thread::Builder::new()
        .stack_size(NATIVE_STACK_BYTES)
        .spawn(move || {
            let (bytecode, names) = compile(&source);
            let mut machine = Interp::new();
            machine.link_intrinsics(&names);
            machine.set_source_compiler(std::rc::Rc::new(IronhorseSourceCompiler));
            machine.run(&bytecode)
        })
        .expect("spawn the contract-stack thread")
        .join()
        .expect("the engine must halt, never panic or abort")
}

#[test]
fn source_past_the_compiler_budget_is_a_catchable_syntax_error_through_eval() {
    // The compile front end had no guard at all (the review's F017): ~8 KB
    // of nested parentheses aborted the process at a depth that depended on
    // the build profile. Now `eval` throws the `SyntaxError` the spec's
    // early-error path throws, catchable by the guest.
    let out = on_contract_stack_with_compiler(
        "var r = []; \
         function tryEval(src) { try { eval(src); r.push('ok'); } catch (e) { r.push(e instanceof SyntaxError ? 'syntax' : 'other'); } } \
         tryEval('('.repeat(5000) + '1' + ')'.repeat(5000)); \
         tryEval('1' + '+1'.repeat(5000)); \
         tryEval('{'.repeat(5000) + '}'.repeat(5000)); \
         tryEval('('.repeat(50) + '1' + ')'.repeat(50)); \
         r.join()"
            .into(),
    );
    assert_completes(
        &out,
        "syntax,syntax,syntax,ok",
        "eval of over-deep and acceptable sources",
    );
}

#[test]
fn a_regexp_past_the_nesting_limit_is_a_catchable_syntax_error_and_length_is_free() {
    let out = on_contract_stack(
        "var r = []; \
         try { new RegExp('('.repeat(5000) + 'a' + ')'.repeat(5000)); r.push('ok'); } \
         catch (e) { r.push(e instanceof SyntaxError ? 'syntax' : 'other'); } \
         r.push(new RegExp('a|'.repeat(20000) + 'b').test('b')); \
         r.push(new RegExp('a'.repeat(20000)).test('a'.repeat(20000))); \
         r.join()"
            .into(),
    );
    assert_completes(
        &out,
        "syntax,true,true",
        "RegExp nesting refusal and long flat patterns",
    );
}

#[test]
fn the_budget_is_released_when_a_deep_native_returns_or_unwinds() {
    // A deep `JSON.parse` that completes, then one that throws a catchable
    // SyntaxError from its innermost level (unwinding through every guarded
    // frame), then a proxy chain that needs most of the budget: the chain
    // completes only if both earlier descents gave their units back.
    let chain_layers = NATIVE_DEPTH_LIMIT - 32;
    let out = on_contract_stack(format!(
        "JSON.parse('['.repeat(400) + ']'.repeat(400)); \
         var caught = false; \
         try {{ JSON.parse('['.repeat(400) + 'x'); }} catch (e) {{ caught = e instanceof SyntaxError; }} \
         var p = {{x: 1}}; for (var i = 0; i < {chain_layers}; i++) p = new Proxy(p, {{}}); \
         caught && p.x === 1"
    ));
    assert_completes(
        &out,
        "true",
        "the budget after a deep return and a deep unwind",
    );
}

#[test]
fn regexp_compilation_refusal_bypasses_guest_catch_in_constructor_and_eval() {
    for source in [
        r"try { new RegExp('[\\u{0}-\\u{10ffff}]', 'iu'); } catch (_) { 'caught'; }",
        r"try { eval('/[\\u{0}-\\u{10ffff}]/iu'); } catch (_) { 'caught'; }",
    ] {
        let (bytecode, names) = compile(source);
        let mut machine = Interp::new();
        machine.link_intrinsics(&names);
        machine.set_source_compiler(std::rc::Rc::new(IronhorseSourceCompiler));
        machine.arm_meter(1, Box::new(|computrons| computrons < 10_000));
        let out = machine.run(&bytecode);
        assert!(
            matches!(out.halt, Halt::MeterAbort),
            "{source}: {:?}",
            out.halt
        );
        assert!(!machine.is_quiescent());
    }
}

#[test]
fn copied_iterator_setters_fit_the_contract_stack() {
    for key in ["'constructor'", "Symbol.toStringTag"] {
        assert_stack_overflow(&on_contract_stack(format!(
            "var k={key};var d=Object.getOwnPropertyDescriptor(Iterator.prototype,k);var o={{}};Object.defineProperty(o,k,d);o[k]=1;'done'"
        )), "copied Iterator setter recursion");
    }
}

// STACK-DEPTH-REFACTOR.md §5, Phase 0, "Native tests": the §3 compositions
// (U1 bound `instanceof`, U2 the fast-path `flat`, U3 the RegExp compiler, U4
// the runtime-compile seam) and the ceilings the report measured but did not
// test.

#[test]
fn instanceof_through_bound_functions_is_charged_only_through_has_instance() {
    // U1. `InstanceofOperator` on a bound function with no `@@hasInstance` in
    // its chain unwraps the bound target with no native frame charged, so the
    // walk is unbounded by the budget: 2,000 here, 5,000 in §3, as deep as
    // the heap admits. B2 made the walk a loop, so it no longer grows the
    // host stack either, which the stack-height ratchet
    // (`benches/stack_height.py`) pins; charging it instead would halt chains
    // that complete today, a versioned release (§6). A chain over an ordinary
    // function
    // inherits the intrinsic `@@hasInstance`, one charged native activation
    // per layer, and halts at 126.
    let uncharged = |layers: usize| {
        format!(
            "function F() {{}} Object.setPrototypeOf(F, null); var b = F; \
             for (var i = 0; i < {layers}; i++) {{ b = Function.prototype.bind.call(b, null); Object.setPrototypeOf(b, null); }} \
             new F() instanceof b"
        )
    };
    let charged = |layers: usize| {
        format!(
            "function F() {{}} var b = F; for (var i = 0; i < {layers}; i++) b = b.bind(null); \
             new F() instanceof b"
        )
    };
    assert_completes(
        &on_contract_stack(uncharged(2000)),
        "true",
        "instanceof through 2,000 null-prototype bound functions",
    );
    assert_completes(
        &on_contract_stack(charged(125)),
        "true",
        "instanceof through 125 bound functions with the intrinsic @@hasInstance",
    );
    assert_stack_overflow(
        &on_contract_stack(charged(126)),
        "instanceof through 126 bound functions with the intrinsic @@hasInstance",
    );
}

#[test]
fn a_fast_path_flat_and_a_regexp_compile_fit_under_the_deepest_admitted_stacks() {
    // U2 and U3 at the bottom of the deepest stack the budget admits above
    // them, and one layer more halts. U2 is the compact fast-path `flat`
    // over a 1,022-deep nest (its own recursion uncharged, §3), one charged
    // native activation: 16 units. U3 is a 512-group RegExp (the pattern
    // nesting limit; its compile uncharged, §3) reached through the
    // constructor and the `source` getter: 17 units. So the flat sits one
    // layer deeper than the RegExp under each stack: a `JSON.stringify` nest
    // of 1,983 / 1,982 arrays (1 unit per level), 2,000 / 1,999 forwarding
    // Proxies under a getter (1 unit per layer), and 63 / 62 nested
    // `forEach` callbacks (32 units per level).
    let flat = "a.flat(Infinity).length";
    let regexp = "new RegExp('('.repeat(512) + 'a' + ')'.repeat(512)).source.length";
    let under_json = |levels: usize, body: &str| {
        format!(
            "{} var o = {{ toJSON: function () {{ return {body}; }} }}; \
             var r = o; for (var i = 0; i < {levels}; i++) {{ r = [r]; }} JSON.stringify(r).length",
            nested_arrays(1022)
        )
    };
    let under_proxies = |layers: usize, body: &str| {
        format!(
            "{} var t = {{ get x() {{ return {body}; }} }}; var p = t; \
             for (var i = 0; i < {layers}; i++) p = new Proxy(p, {{}}); p.x",
            nested_arrays(1022)
        )
    };
    let under_for_each = |levels: usize, body: &str| {
        format!(
            "{} function f(n) {{ if (n > 0) {{ var r; [0].forEach(function () {{ r = f(n - 1); }}); return r; }} \
             return {body}; }} f({levels})",
            nested_arrays(1022)
        )
    };
    for (what, body, json, proxies, for_each, results) in [
        (
            "the fast-path flat",
            flat,
            1983,
            2000,
            63,
            ["3967", "0", "0"],
        ),
        (
            "the 512-group RegExp",
            regexp,
            1982,
            1999,
            62,
            ["3968", "1025", "1025"],
        ),
    ] {
        assert_completes(
            &on_contract_stack(under_json(json, body)),
            results[0],
            &format!("{what} under a {json}-deep JSON nest"),
        );
        assert_stack_overflow(
            &on_contract_stack(under_json(json + 1, body)),
            &format!("{what} under a {}-deep JSON nest", json + 1),
        );
        assert_completes(
            &on_contract_stack(under_proxies(proxies, body)),
            results[1],
            &format!("{what} under {proxies} Proxies"),
        );
        assert_stack_overflow(
            &on_contract_stack(under_proxies(proxies + 1, body)),
            &format!("{what} under {} Proxies", proxies + 1),
        );
        assert_completes(
            &on_contract_stack(under_for_each(for_each, body)),
            results[2],
            &format!("{what} under {for_each} forEach levels"),
        );
        assert_stack_overflow(
            &on_contract_stack(under_for_each(for_each + 1, body)),
            &format!("{what} under {} forEach levels", for_each + 1),
        );
    }
}

#[test]
fn an_eval_nest_compiling_a_tagged_chain_fits_under_a_for_each_nest() {
    // U4, the runtime-compile seam, under a re-entry stack: nested `eval`s
    // (48 units each), the innermost compiling a function whose body is a
    // 2,038-template tagged chain (the deepest the parser admits inside that
    // function wrapper), at the bottom of 20 nested `forEach` callbacks
    // (32 units each). 28 evals fit; 29 sum to the whole budget and the light
    // frame at the bottom takes them to 2,049, the halt.
    let source = |evals: usize| {
        format!(
            "function g(n) {{ if (n > 0) return eval('g(n - 1)'); \
               return eval('(function () {{ return f' + '``'.repeat(2038) + '; }})'); }} \
             function f(n) {{ if (n > 0) {{ var r; [0].forEach(function () {{ r = f(n - 1); }}); return r; }} \
               return typeof g({evals}); }} f(20)"
        )
    };
    assert_completes(
        &on_contract_stack_with_compiler(source(28)),
        "function",
        "28 evals under 20 forEach levels",
    );
    assert_stack_overflow(
        &on_contract_stack_with_compiler(source(29)),
        "29 evals under 20 forEach levels",
    );
}

#[test]
fn the_regexp_protocol_iterator_helper_and_thenable_ceilings_are_exact() {
    // The ceilings the report measured (§2.1) but did not test: each family
    // returns at its ceiling and halts one level past it, on the corpus
    // template every lane runs.
    for (family, ceiling) in [
        ("replace-re-fn", 42),
        ("user-exec", 42),
        ("species", 41),
        ("lastindex-valueof", 63),
        ("regexp-test-exec", 63),
        ("take", 126),
        ("iter-map", 126),
        ("tagged-then", 61),
    ] {
        let recorded = cases::HEAVY
            .iter()
            .find(|(name, _)| *name == family)
            .map(|(_, n)| *n);
        assert_eq!(
            recorded,
            Some(ceiling),
            "{family}: the corpus records this ceiling"
        );
        let source = |n: usize| {
            let (source, needs_compiler) = cases::heavy(family, n).expect("a corpus family");
            assert!(!needs_compiler, "{family} runs without the source compiler");
            source
        };
        let at = on_contract_stack(source(ceiling));
        assert!(
            at.completed,
            "{family} at its ceiling of {ceiling} must return; halt: {:?}",
            at.halt
        );
        assert_stack_overflow(
            &on_contract_stack(source(ceiling + 1)),
            &format!("{family} one past its ceiling"),
        );
    }
}
