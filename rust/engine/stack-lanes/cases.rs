//! The stack-depth case corpus: the inputs of every Phase 0 lane
//! (`STACK-DEPTH-REFACTOR.md` §5).
//!
//! Included by path from the native harness (`ironhorse-vm/tests/stack_height.rs`)
//! and from the probe (`probe/src/main.rs`) so that every lane measures the same
//! programs. It depends on nothing but `std`.
//!
//! The cases are the `native_recursion_budget` scenarios at their halting and
//! accepted sizes (the report's 25 family cases are "the `native_recursion_budget`
//! cases plus their within-budget twins", §1.3), the accepted compiler pins of
//! `ironhorse-compile/tests/recursion_bounds.rs`, and in-place walks as controls.

pub struct Case {
    pub name: &'static str,
    pub source: String,
    /// Run the program after compiling it; compiler pins only compile.
    pub run: bool,
    /// Install the eval bridge.
    pub eval_compiler: bool,
}

/// `layers` proxies wrapped around `{x: 1}`, then `tail`.
fn proxy_chain(layers: usize, tail: &str) -> String {
    format!("var p = {{x: 1}}; for (var i = 0; i < {layers}; i++) p = new Proxy(p, {{}}); {tail}")
}

/// `depth` arrays nested inside `a`, each the sole element of its parent.
fn nested_arrays(depth: usize) -> String {
    format!("var a = []; var r = a; for (var i = 0; i < {depth}; i++) {{ var b = []; r[0] = b; r = b; }} ")
}

/// A reviver that installs a `depth`-deep sibling while the walk is on.
fn reviver(depth: usize) -> String {
    format!(
        "{} JSON.parse('[1,2]', function (k, v) {{ if (k === '0') this[1] = a; return v; }}); 1",
        nested_arrays(depth)
    )
}

fn foreach_nest(levels: usize) -> String {
    format!(
        "function f(n) {{ if (n > 0) [0].forEach(function () {{ f(n - 1); }}); }} f({levels}); 1"
    )
}

fn async_nest(levels: usize) -> String {
    format!("async function f(n) {{ if (n > 0) await f(n - 1); }} f({levels}); 1")
}

fn wrapped(open: &str, core: &str, close: &str, depth: usize) -> String {
    format!("{}{core}{}", open.repeat(depth), close.repeat(depth))
}

const EVAL_DEEP: &str = "var r = []; \
    function tryEval(src) { try { eval(src); r.push('ok'); } catch (e) { r.push(e instanceof SyntaxError ? 'syntax' : 'other'); } } \
    tryEval('('.repeat(5000) + '1' + ')'.repeat(5000)); \
    tryEval('1' + '+1'.repeat(5000)); \
    tryEval('{'.repeat(5000) + '}'.repeat(5000)); \
    tryEval('('.repeat(50) + '1' + ')'.repeat(50)); \
    r.join()";

const REGEXP_DEEP: &str = "var r = []; \
    try { new RegExp('('.repeat(5000) + 'a' + ')'.repeat(5000)); r.push('ok'); } \
    catch (e) { r.push(e instanceof SyntaxError ? 'syntax' : 'other'); } \
    r.push(new RegExp('a|'.repeat(20000) + 'b').test('b')); \
    r.push(new RegExp('a'.repeat(20000)).test('a'.repeat(20000))); \
    r.join()";

pub fn cases() -> Vec<Case> {
    fn run(name: &'static str, source: String) -> Case {
        Case {
            name,
            source,
            run: true,
            eval_compiler: false,
        }
    }
    fn compile_only(name: &'static str, source: String) -> Case {
        Case {
            name,
            source,
            run: false,
            eval_compiler: false,
        }
    }
    let mut cases = vec![
        // The harness floor: what an empty program costs.
        run("floor", "1".into()),
        // Proxy forwarding, one light frame per trap-absent layer (report §2.2).
        // The 10k cases halt at the budget; 2016 is the largest accepted [[Get]] chain.
        run("proxy-get-10k", proxy_chain(10_000, "p.x")),
        run("proxy-get-2016", proxy_chain(2016, "p.x")),
        run("proxy-get-256", proxy_chain(256, "p.x")),
        run("proxy-get-index-10k", proxy_chain(10_000, "p[0]")),
        run("proxy-set-10k", proxy_chain(10_000, "p.x = 2; 1")),
        run("proxy-has-10k", proxy_chain(10_000, "'x' in p")),
        run("proxy-delete-10k", proxy_chain(10_000, "delete p.x")),
        run("proxy-keys-10k", proxy_chain(10_000, "Object.keys(p).length")),
        run(
            "proxy-getownproperty-10k",
            proxy_chain(10_000, "Object.getOwnPropertyDescriptor(p, 'x').value"),
        ),
        run(
            "proxy-define-10k",
            proxy_chain(10_000, "Object.defineProperty(p, 'y', {value: 1}); 1"),
        ),
        run(
            "proxy-getprototypeof-10k",
            proxy_chain(10_000, "Object.getPrototypeOf(p) === Object.prototype"),
        ),
        run("proxy-setprototypeof-10k", proxy_chain(10_000, "Object.setPrototypeOf(p, null); 1")),
        run("proxy-isextensible-10k", proxy_chain(10_000, "Object.isExtensible(p)")),
        run("proxy-preventextensions-10k", proxy_chain(10_000, "Object.preventExtensions(p); 1")),
        run(
            "proxy-call-10k",
            "var p = function () { return 1; }; for (var i = 0; i < 10000; i++) p = new Proxy(p, {}); p()".into(),
        ),
        run(
            "proxy-construct-10k",
            "var p = function () {}; for (var i = 0; i < 10000; i++) p = new Proxy(p, {}); new p(); 1".into(),
        ),
        run(
            "proxy-proto-cycle",
            "var t = {}; var p = new Proxy(t, {}); Object.setPrototypeOf(t, p); t.zzz".into(),
        ),
        // Native-to-native re-entry (§2.1): join stringifies an element that is the array.
        run("join-self", "var a = []; a[0] = a; a.join()".into()),
        run("string-self", "var a = []; a[0] = a; String(a)".into()),
        // The host renderer of the completion value.
        run("render-nested-256", format!("{} a", nested_arrays(256))),
        run("render-self", "var a = []; a[0] = a; a".into()),
        // Data-structure walkers (§2.3).
        run("json-parse-arr-10k", "JSON.parse('['.repeat(10000) + ']'.repeat(10000)); 1".into()),
        run(
            "json-parse-obj-10k",
            "JSON.parse('{\"a\":'.repeat(10000) + '1' + '}'.repeat(10000)); 1".into(),
        ),
        run("json-parse-arr-256", "JSON.parse('['.repeat(256) + ']'.repeat(256)); 1".into()),
        run("json-reviver-10k", reviver(10_000)),
        run("json-reviver-200", reviver(200)),
        run("json-stringify-10k", format!("{} JSON.stringify(a).length", nested_arrays(10_000))),
        run("json-stringify-256", format!("{} JSON.stringify(a).length", nested_arrays(256))),
        run("flat-self", "var a = []; a[0] = a; a.flat(Infinity)".into()),
        run("flat-256", format!("{} a.flat(Infinity).length", nested_arrays(256))),
        // Heavy re-entry through `dispatch_at` (§2.1).
        run("foreach-63", foreach_nest(63)),
        run("foreach-64", foreach_nest(64)),
        run("foreach-10k", foreach_nest(10_000)),
        run("async-64", async_nest(64)),
        run("async-10k", async_nest(10_000)),
        run(
            "iter-setter",
            "var k='constructor';var d=Object.getOwnPropertyDescriptor(Iterator.prototype,k);var o={};Object.defineProperty(o,k,d);o[k]=1;'done'".into(),
        ),
        run("regexp-deep", REGEXP_DEEP.into()),
        // Walks that stay in place: controls that must stay flat in the chain length.
        run(
            "proto-chain-ordinary-20k",
            "var o = {x: 1}; for (var i = 0; i < 20000; i++) o = Object.create(o); o.x".into(),
        ),
        run(
            "proto-chain-arrays-20k",
            "var o = []; for (var i = 0; i < 20000; i++) { var a = []; Object.setPrototypeOf(a, o); o = a; } o.zzz === undefined".into(),
        ),
        run(
            "bind-call-10k",
            "function f() { return 7; } var c = f; for (var i = 0; i < 10000; i++) c = c.call.bind(c); c()".into(),
        ),
        run(
            "async-gen-drain-40k",
            "async function* ag() {} var g = ag(); for (var i = 0; i < 40000; i++) g.next(); 1".into(),
        ),
        // Runtime compiles through the eval bridge, on top of the VM's depth (§2.4).
        Case { name: "eval-deep", source: EVAL_DEEP.into(), run: true, eval_compiler: true },
    ];
    // Compiler pins at their accepted depth (`recursion_bounds.rs`); compile stage only.
    for (name, source) in [
        ("parse-parens-91", wrapped("(", "1", ")", 91)),
        ("parse-array-91", wrapped("[", "1", "]", 91)),
        (
            "parse-object-90",
            format!("({})", wrapped("{a:", "1", "}", 90)),
        ),
        ("parse-call-args-91", wrapped("f(", "1", ")", 91)),
        ("parse-arrow-91", wrapped("()=>", "1", "", 91)),
        ("parse-template-91", wrapped("`${", "1", "}`", 91)),
        ("parse-blocks-512", wrapped("{", "", "}", 512)),
        (
            "parse-functions-512",
            wrapped("function f(){", "", "}", 512),
        ),
        ("parse-if-505", wrapped("if(1) ", "1", "", 505)),
        ("parse-new-505", wrapped("new ", "f", "", 505)),
        (
            "parse-binding-510",
            format!("var {} = x", wrapped("[", "a", "]", 510)),
        ),
        ("parse-cond-chain-1011", wrapped("a?b:", "1", "", 1011)),
        ("parse-assign-chain-1011", wrapped("a=", "1", "", 1011)),
        ("parse-binary-chain-2045", format!("1{}", "+1".repeat(2045))),
        ("parse-member-chain-2045", format!("a{}", ".b".repeat(2045))),
        ("parse-call-chain-2044", format!("f{}", "()".repeat(2044))),
        (
            "parse-elseif-chain-2044",
            format!("if (a) x; {}else y;", "else if (a) x; ".repeat(2044)),
        ),
        ("parse-tagged-chain-2043", format!("f{}", "``".repeat(2043))),
    ] {
        cases.push(compile_only(name, source));
    }
    cases
}
