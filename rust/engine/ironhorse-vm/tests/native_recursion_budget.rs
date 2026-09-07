//! Guest code halts the crank, never the process: every guest-reachable
//! native recursion is bounded by the engine's one native-recursion budget
//! ([`NATIVE_DEPTH_LIMIT`]) and degrades to a structured
//! [`Halt::StackOverflow`] — the abort-to-host XS raises from
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

use ironhorse_vm::{Halt, Interp, RunOutcome, NATIVE_DEPTH_LIMIT, NATIVE_STACK_BYTES};

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
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
        matches!(out.halt, Halt::StackOverflow(_)),
        "{what} must halt with StackOverflow at the native-recursion budget; halt: {:?}",
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
        &on_contract_stack("var a = []; a[0] = a; a".into()),
        "rendering a self-containing completion value",
    );
    // The mutual-cycle form.
    assert_stack_overflow(
        &on_contract_stack("var a = []; var b = [a]; a[0] = b; a".into()),
        "rendering a mutually cyclic completion value",
    );
}

#[test]
fn a_thrown_value_the_renderer_refuses_is_reported_with_the_stub_text() {
    // The throw-site render is a diagnostic. `render_uncaught` tries the
    // guest `toString` (bounded as a built-in re-entry), then the static
    // renderer (bounded by depth), and when both refuse a self-containing
    // array it reports the throw with the reference stub. It must never halt
    // the crank: the same render runs before a native driver catches the
    // `Halt::Throw`, as the driver-caught forms below pin.
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
    // Formerly a private cap answering `Halt::Unsupported("flat:recursion-depth")`;
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

/// The crate's own source compiler installed as the eval bridge, so the
/// compiler-side budgets are observed through the guest-visible surface.
struct IronhorseCompiler;
impl ironhorse_vm::SourceCompiler for IronhorseCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        match ironhorse_compile::compile_atoms_with(source, strict) {
            Ok((bytecode, symbols)) => Ok(ironhorse_vm::CompiledSource { bytecode, symbols }),
            Err(e) => Err(ironhorse_vm::SourceCompileError::Syntax(e.to_string())),
        }
    }
}

fn on_contract_stack_with_compiler(source: String) -> RunOutcome {
    std::thread::Builder::new()
        .stack_size(NATIVE_STACK_BYTES)
        .spawn(move || {
            let (bytecode, names) = compile(&source);
            let mut machine = Interp::new();
            machine.link_intrinsics(&names);
            machine.set_source_compiler(std::rc::Rc::new(IronhorseCompiler));
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
