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
//! or written through the MOP, and the async-generator request drain. Four
//! lines of ordinary JavaScript killed the worker at a depth that depended on
//! the host stack size and the build profile.
//!
//! One test per family. Each runs on a thread of exactly
//! [`NATIVE_STACK_BYTES`], the size the budget is calibrated for per build
//! profile: the family halting cleanly there is the contract; a regression to
//! a native overflow takes the whole test binary down, which is the point.
//! The within-budget twin of each family pins that the ceiling is above what
//! real programs do, so the bound is a bound and not a new refusal.

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
fn a_thrown_self_containing_array_is_refused_at_the_render_boundary() {
    // `render_uncaught` first tries the guest `toString` (bounded as a
    // built-in re-entry) and then the static renderer (bounded by depth).
    assert_stack_overflow(
        &on_contract_stack("var a = []; a[0] = a; throw a".into()),
        "rendering a thrown self-containing array",
    );
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
