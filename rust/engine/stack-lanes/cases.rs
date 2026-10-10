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
//! `ironhorse-compile/tests/recursion_bounds.rs` at pin and pin+1, in-place walks
//! as controls, and the lane A inputs of §5: every heavy re-entry family of §2.1
//! and every walker of §2.3 at its ceiling and ceiling+1, the unpinned chain
//! kinds at their ceilings, the mixed value-stack cases of invariant 8, and the
//! U1-U4 compositions. The ceilings are recorded in [`HEAVY`], [`WALKERS`] and
//! [`CHAINS`], and `ceilings.py` re-derives them natively with the probe.

// The harness and the probe each use part of this module.
#![allow(dead_code)]

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

/// RegExp nests at the 512-level limit that compile, through every pass:
/// lookbehind (the backward measure and code walks), modifier groups, a named
/// group around alternations (with the named-capture re-parse) and `v`-mode
/// nested and intersected classes (STACK-DEPTH-REFACTOR.md §4.4 B7).
const REGEXP_NESTS: &str = "var r = []; \
    r.push(new RegExp('(?<='.repeat(512) + 'a' + ')'.repeat(512)).test('a')); \
    r.push(new RegExp('(?i:'.repeat(512) + 'a' + ')'.repeat(512)).test('A')); \
    r.push(new RegExp('(?<n>' + '(?:b|'.repeat(511) + 'a' + ')'.repeat(512) + '\\\\k<n>').test('aa')); \
    r.push(new RegExp('['.repeat(512) + 'a' + ']'.repeat(512), 'v').test('a')); \
    r.push(new RegExp('[\\\\w&&['.repeat(256) + 'a' + ']]'.repeat(256), 'v').test('a')); \
    r.join()";

/// A family that re-enters `dispatch_at` (or a native) once per level: the
/// program at depth `n`, and whether it needs the eval bridge. The ceiling is
/// the largest `n` that completes natively; `n + 1` halts with `ReentryLimit`.
pub fn heavy(family: &str, n: usize) -> Option<(String, bool)> {
    // Every family recurses through `f`, one re-entry per level, and completes
    // with `0` so that a checkable value comes back through every level.
    let level =
        |body: &str| format!("function f(n) {{ if (n > 0) {{ {body} }} return 0; }} f({n})");
    let source = match family {
        "forEach" => level("[0].forEach(function () { f(n - 1); });"),
        "map" => level("[0].map(function () { f(n - 1); });"),
        "reduce" => level("[0].reduce(function (a) { f(n - 1); return a; }, 0);"),
        "reflect-apply" => level("Reflect.apply(f, null, [n - 1]);"),
        "sort-cmp" => level("[1, 2].sort(function () { f(n - 1); return 0; });"),
        "replace-fn" => level("'a'.replace('a', function () { f(n - 1); return ''; });"),
        "array-from" => level("Array.from([0], function () { f(n - 1); });"),
        "join" => format!("{} a.join().length", nested_arrays(n)),
        "toString" => format!("{} String(a).length", nested_arrays(n)),
        "take" => format!(
            "var it = [1, 2, 3].values(); for (var i = 0; i < {n}; i++) it = it.take(5); it.next().value"
        ),
        "iter-map" => format!(
            "var it = [1, 2, 3].values(); for (var i = 0; i < {n}; i++) it = it.map(function (x) {{ return x; }}); it.next().value"
        ),
        "string-x" => level("String({ toString: function () { f(n - 1); return ''; } });"),
        "promise-exec" => level("new Promise(function () { f(n - 1); });"),
        "tagged-then" => level("Promise.resolve({ get then() { f(n - 1); return undefined; } });"),
        "async" => format!("async function f(n) {{ if (n > 0) await f(n - 1); }} f({n}); 1"),
        "gen-next" => format!(
            "function* g(n) {{ if (n > 0) g(n - 1).next(); }} g({n}).next(); 1"
        ),
        "asyncgen" => format!(
            "async function* g(n) {{ if (n > 0) g(n - 1).next(); }} g({n}).next(); 1"
        ),
        "for-of" => format!(
            "function* g(n) {{ if (n > 0) for (var x of g(n - 1)) {{}} }} for (var x of g({n})) {{}} 1"
        ),
        "yield-star" => format!(
            "function* g(n) {{ if (n > 0) yield* g(n - 1); }} g({n}).next(); 1"
        ),
        "getter" => level("var o = { get x() { f(n - 1); return 1; } }; return o.x;"),
        "setter" => level("var o = { set x(v) { f(n - 1); } }; o.x = 1;"),
        "valueOf" => level("var o = { valueOf: function () { f(n - 1); return 1; } }; return +o;"),
        "to-primitive" => level(
            "var o = { [Symbol.toPrimitive]: function () { f(n - 1); return 1; } }; return +o;",
        ),
        "has-instance" => level(
            "var F = { [Symbol.hasInstance]: function () { f(n - 1); return true; } }; return 1 instanceof F ? 0 : 1;",
        ),
        "iterator" => level(
            "for (var x of { [Symbol.iterator]: function () { f(n - 1); return [][Symbol.iterator](); } }) {}",
        ),
        "iterator-spread" => level(
            "[...{ [Symbol.iterator]: function () { f(n - 1); return [][Symbol.iterator](); } }];",
        ),
        "bound" => level("return f.bind(null, n - 1)();"),
        "function-call" => format!(
            "var g = Function('f', 'n', 'return f(n - 1)'); function f(n) {{ if (n > 0) return g(f, n); return 0; }} f({n})"
        ),
        "eval-direct" => level("return eval('f(n - 1)');"),
        "eval-indirect" => format!(
            "var f = function (n) {{ if (n > 0) return (0, eval)('f(' + (n - 1) + ')'); return 0; }}; f({n})"
        ),
        "compartment" => format!(
            "var c = new Compartment(); c.globalThis.f = function (n) {{ return f(n); }}; \
             function f(n) {{ if (n > 0) return c.evaluate('f(' + (n - 1) + ')'); return 0; }} f({n})"
        ),
        "proxy-trap" => level(
            "var p = new Proxy(function () {}, { apply: function () { return f(n - 1); } }); return p();",
        ),
        // Every other Proxy trap, each recursing from the trap. A trap call
        // runs inside the Proxy arm's forwarding walk, so these measure that
        // walk's frame as `proxy-trap` measures the `apply` turn's.
        "proxy-get-trap" => level(
            "var p = new Proxy({}, { get: function () { return f(n - 1); } }); return p.x;",
        ),
        "proxy-set-trap" => level(
            "var p = new Proxy({}, { set: function () { f(n - 1); return true; } }); p.x = 1;",
        ),
        "proxy-has-trap" => level(
            "var p = new Proxy({}, { has: function () { f(n - 1); return true; } }); return 'x' in p ? 0 : 1;",
        ),
        "proxy-delete-trap" => level(
            "var p = new Proxy({}, { deleteProperty: function () { f(n - 1); return true; } }); delete p.x;",
        ),
        "proxy-define-trap" => level(
            "var p = new Proxy({}, { defineProperty: function () { f(n - 1); return true; } }); \
             Object.defineProperty(p, 'x', { value: 1, configurable: true });",
        ),
        "proxy-getownproperty-trap" => level(
            "var p = new Proxy({}, { getOwnPropertyDescriptor: function () { f(n - 1); } }); \
             Object.getOwnPropertyDescriptor(p, 'x');",
        ),
        "proxy-ownkeys-trap" => level(
            "var p = new Proxy({}, { ownKeys: function () { f(n - 1); return []; } }); Object.keys(p);",
        ),
        "proxy-getprototypeof-trap" => level(
            "var p = new Proxy({}, { getPrototypeOf: function () { f(n - 1); return null; } }); \
             Object.getPrototypeOf(p);",
        ),
        "proxy-setprototypeof-trap" => level(
            "var p = new Proxy({}, { setPrototypeOf: function () { f(n - 1); return true; } }); \
             Object.setPrototypeOf(p, null);",
        ),
        "proxy-isextensible-trap" => level(
            "var p = new Proxy({}, { isExtensible: function () { f(n - 1); return true; } }); \
             Object.isExtensible(p);",
        ),
        "proxy-preventextensions-trap" => level(
            "var p = new Proxy({}, { preventExtensions: function () { f(n - 1); return false; } }); \
             Reflect.preventExtensions(p);",
        ),
        "proxy-construct-trap" => level(
            "var p = new Proxy(function () {}, { construct: function () { f(n - 1); return {}; } }); new p();",
        ),
        // The same traps reached through other entry points: an index key, a
        // lookup inherited through the Proxy, `Reflect`, a `with` scope and a
        // for-in walk. Each takes its own path into the Proxy arm.
        "proxy-index-get-trap" => level(
            "var p = new Proxy([], { get: function () { return f(n - 1); } }); return p[0];",
        ),
        "proxy-index-has-trap" => level(
            "var p = new Proxy([], { has: function () { f(n - 1); return true; } }); \
             return 0 in p ? 0 : 1;",
        ),
        "proxy-inherited-get-trap" => level(
            "var p = new Proxy({}, { get: function () { return f(n - 1); } }); \
             return Object.create(p).x;",
        ),
        "proxy-inherited-set-trap" => level(
            "var p = new Proxy({}, { set: function () { f(n - 1); return true; } }); \
             Object.create(p).x = 1;",
        ),
        "proxy-reflect-get-trap" => level(
            "var p = new Proxy({}, { get: function () { return f(n - 1); } }); \
             return Reflect.get(p, 'x');",
        ),
        "proxy-with-has-trap" => level(
            "var p = new Proxy({}, { has: function () { f(n - 1); return false; } }); \
             with (p) { return typeof x; }",
        ),
        "proxy-forin-ownkeys-trap" => level(
            "var p = new Proxy({}, { ownKeys: function () { f(n - 1); return []; } }); \
             for (var k in p) {}",
        ),
        "proxy-forin-getprototypeof-trap" => level(
            "var p = new Proxy({}, { getPrototypeOf: function () { f(n - 1); return null; } }); \
             for (var k in p) {}",
        ),
        "replace-re-fn" => level("'a'.replace(/a/, function () { f(n - 1); return ''; });"),
        "user-exec" => level(
            "var re = /a/; re.exec = function () { f(n - 1); return null; }; 'a'.replace(re, 'b');",
        ),
        "species" => level(
            "class R extends RegExp { static get [Symbol.species]() { f(n - 1); return RegExp; } } 'a'.split(new R('a'));",
        ),
        "lastindex-valueof" => level(
            "var re = /a/g; re.lastIndex = { valueOf: function () { f(n - 1); return 0; } }; re.test('a');",
        ),
        "regexp-test-exec" => level(
            "var re = /a/; re.exec = function () { f(n - 1); return null; }; re.test('a');",
        ),
        _ => return None,
    };
    let eval_compiler = matches!(
        family,
        "function-call" | "eval-direct" | "eval-indirect" | "compartment"
    );
    Some((source, eval_compiler))
}

/// The heavy families and their native ceilings, as `ceilings.py` measures them
/// on this tree. They match report §2.1 and §1.3 except where a template here
/// differs by a level (`toString` wraps `String()` around the join, `bound` and
/// `proxy-trap` recurse from the callee).
pub const HEAVY: &[(&str, usize)] = &[
    ("forEach", 63),
    ("map", 63),
    ("reduce", 63),
    ("reflect-apply", 63),
    ("sort-cmp", 63),
    ("replace-fn", 63),
    ("array-from", 63),
    ("join", 63),
    ("toString", 62),
    ("take", 126),
    ("iter-map", 126),
    ("string-x", 63),
    ("promise-exec", 63),
    ("tagged-then", 61),
    ("async", 126),
    ("gen-next", 62),
    ("asyncgen", 62),
    ("for-of", 62),
    ("yield-star", 62),
    ("getter", 119),
    ("setter", 119),
    ("valueOf", 126),
    ("to-primitive", 126),
    ("has-instance", 126),
    ("iterator", 126),
    ("iterator-spread", 126),
    ("bound", 127),
    ("function-call", 63),
    ("eval-direct", 42),
    ("eval-indirect", 42),
    ("compartment", 42),
    ("proxy-trap", 119),
    ("proxy-get-trap", 126),
    ("proxy-set-trap", 126),
    ("proxy-has-trap", 126),
    ("proxy-delete-trap", 126),
    ("proxy-define-trap", 61),
    ("proxy-getownproperty-trap", 61),
    ("proxy-ownkeys-trap", 61),
    ("proxy-getprototypeof-trap", 61),
    ("proxy-setprototypeof-trap", 61),
    ("proxy-isextensible-trap", 61),
    ("proxy-preventextensions-trap", 61),
    ("proxy-construct-trap", 119),
    ("proxy-index-get-trap", 119),
    ("proxy-index-has-trap", 126),
    ("proxy-inherited-get-trap", 112),
    ("proxy-inherited-set-trap", 112),
    ("proxy-reflect-get-trap", 61),
    ("proxy-with-has-trap", 119),
    ("proxy-forin-ownkeys-trap", 126),
    ("proxy-forin-getprototypeof-trap", 61),
    ("replace-re-fn", 42),
    ("user-exec", 42),
    ("species", 41),
    ("lastindex-valueof", 63),
    ("regexp-test-exec", 63),
];

/// Nested objects `depth` deep under `o`, each the sole property of its parent.
fn nested_objects(depth: usize) -> String {
    format!("var o = {{}}; var r = o; for (var i = 0; i < {depth}; i++) {{ var b = {{}}; r.a = b; r = b; }} ")
}

/// Nested sparse arrays `depth` deep under `a`: each child sits behind a hole,
/// which keeps `flat` off its compact fast path.
fn nested_sparse_arrays(depth: usize) -> String {
    format!("var a = []; var r = a; for (var i = 0; i < {depth}; i++) {{ var b = []; r[1] = b; r = b; }} ")
}

/// A data-structure walker (report §2.3) at depth `n`. The ceiling is the
/// largest `n` accepted natively.
pub fn walker(name: &str, n: usize) -> Option<String> {
    Some(match name {
        "jparse-arr" => format!("JSON.parse('['.repeat({n}) + ']'.repeat({n})); 1"),
        "jparse-obj" => format!("JSON.parse('{{\"a\":'.repeat({n}) + '1' + '}}'.repeat({n})); 1"),
        "jrevive-arr" => format!(
            "JSON.parse('['.repeat({n}) + ']'.repeat({n}), function (k, v) {{ return v; }}); 1"
        ),
        "jrevive-obj" => format!(
            "JSON.parse('{{\"a\":'.repeat({n}) + '1' + '}}'.repeat({n}), function (k, v) {{ return v; }}); 1"
        ),
        "jstr-arr" => format!("{} JSON.stringify(a).length", nested_arrays(n)),
        "jstr-obj" => format!("{} JSON.stringify(o).length", nested_objects(n)),
        "jstr-replacer" => format!(
            "{} JSON.stringify(a, function (k, v) {{ return v; }}).length",
            nested_arrays(n)
        ),
        "flat-fast" => format!("{} a.flat(Infinity).length", nested_arrays(n)),
        "flat-generic" => format!("{} a.flat(Infinity).length", nested_sparse_arrays(n)),
        "render-arr" => format!("{} a", nested_arrays(n)),
        _ => return None,
    })
}

/// The walkers and their native ceilings as `ceilings.py` measures them. The
/// report's `flat-fast` figure of 1,022 was a probe depth, not a ceiling: the
/// compact path halts at the same 2,015 as the generic one here.
pub const WALKERS: &[(&str, usize)] = &[
    ("jparse-arr", 2016),
    ("jparse-obj", 2015),
    ("jrevive-arr", 2000),
    ("jrevive-obj", 1999),
    ("jstr-arr", 2014),
    ("jstr-obj", 2014),
    ("jstr-replacer", 1999),
    ("flat-fast", 2015),
    ("flat-generic", 2015),
    ("render-arr", 2047),
];

/// A compile-only chain at depth `n`: the pins of
/// `ironhorse-compile/tests/recursion_bounds.rs` and the unpinned chain kinds
/// of report §1.3. The ceiling is the largest `n` the compiler accepts.
pub fn chain(name: &str, n: usize) -> Option<String> {
    Some(match name {
        "parens" => wrapped("(", "1", ")", n),
        "array" => wrapped("[", "1", "]", n),
        "object" => format!("({})", wrapped("{a:", "1", "}", n)),
        "call-args" => wrapped("f(", "1", ")", n),
        "arrow" => wrapped("()=>", "1", "", n),
        "template" => wrapped("`${", "1", "}`", n),
        "blocks" => wrapped("{", "", "}", n),
        "functions" => wrapped("function f(){", "", "}", n),
        "if" => wrapped("if(1) ", "1", "", n),
        "new" => wrapped("new ", "f", "", n),
        "binding" => format!("var {} = x", wrapped("[", "a", "]", n)),
        "cond-chain" => wrapped("a?b:", "1", "", n),
        "assign-chain" => wrapped("a=", "1", "", n),
        "binary-chain" => format!("1{}", "+1".repeat(n)),
        "member-chain" => format!("a{}", ".b".repeat(n)),
        "call-chain" => format!("f{}", "()".repeat(n)),
        "elseif-chain" => format!("if (a) x; {}else y;", "else if (a) x; ".repeat(n)),
        "tagged-chain" => format!("f{}", "``".repeat(n)),
        "and" => format!("a{}", " && a".repeat(n)),
        "or" => format!("a{}", " || a".repeat(n)),
        "nullish" => format!("a{}", " ?? a".repeat(n)),
        "optchain" => format!("a{}", "?.b".repeat(n)),
        "computed" => format!("a{}", "[0]".repeat(n)),
        "cmpchain" => format!("a{}", " < a".repeat(n)),
        "typeof" => format!("{}a", "typeof ".repeat(n)),
        "label" => format!(
            "{}1;",
            (0..n).map(|i| format!("l{i}: ")).collect::<String>()
        ),
        "ifelse-block" => format!(
            "if (a) {{ x; }} {}else {{ y; }}",
            "else if (a) { x; } ".repeat(n)
        ),
        _ => return None,
    })
}

/// The chains and their native ceilings as `ceilings.py` measures them: the
/// pins of `recursion_bounds.rs`, then the unpinned kinds of report §1.3 (whose
/// figures there came from shapes with a leading `var a = 1;`, one or two
/// levels lower than these).
pub const CHAINS: &[(&str, usize)] = &[
    ("parens", 91),
    ("array", 91),
    ("object", 90),
    ("call-args", 91),
    ("arrow", 91),
    ("template", 91),
    ("blocks", 512),
    ("functions", 512),
    ("if", 505),
    ("new", 505),
    ("binding", 510),
    ("cond-chain", 1011),
    ("assign-chain", 1011),
    ("binary-chain", 2045),
    ("member-chain", 2045),
    ("call-chain", 2044),
    ("elseif-chain", 2044),
    ("tagged-chain", 2043),
    ("and", 2045),
    ("or", 2045),
    ("nullish", 2045),
    ("optchain", 1022),
    ("computed", 2045),
    ("cmpchain", 2045),
    ("typeof", 1010),
    ("label", 505),
    ("ifelse-block", 2041),
];

/// Invariant 8 (report §4.1): a plain-call recursion that runs to the value
/// stack's `StackOverflow` below `k` levels of the forEach family.
fn mixed_value_stack(k: usize) -> String {
    format!(
        "function deep() {{ return deep(); }} \
         function f(n) {{ if (n > 0) [0].forEach(function () {{ f(n - 1); }}); else deep(); }} \
         try {{ f({k}); }} catch (e) {{ String(e); }} 1"
    )
}

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
        run("regexp-nests-512", REGEXP_NESTS.into()),
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
    // Heavy re-entry families at their ceiling and one past it (§2.1).
    for (family, ceiling) in HEAVY {
        for n in [*ceiling, ceiling + 1] {
            let (source, eval_compiler) = heavy(family, n).expect("known family");
            cases.push(Case {
                name: leak(format!("{family}-{n}")),
                source,
                run: true,
                eval_compiler,
            });
        }
    }
    // Walkers at their ceiling and one past it (§2.3).
    for (name, ceiling) in WALKERS {
        for n in [*ceiling, ceiling + 1] {
            cases.push(run(
                leak(format!("{name}-{n}")),
                walker(name, n).expect("known walker"),
            ));
        }
    }
    // Chains at their ceiling (accepted) and one past it (refused); compile stage only.
    for (name, ceiling) in CHAINS {
        for n in [*ceiling, ceiling + 1] {
            cases.push(compile_only(
                leak(format!("parse-{name}-{n}")),
                chain(name, n).expect("known chain"),
            ));
        }
    }
    // Invariant 8: value-stack overflow under 0, 30 and 60 heavy levels.
    for k in [0, 30, 60] {
        cases.push(run(
            leak(format!("mixed-value-stack-{k}")),
            mixed_value_stack(k),
        ));
    }
    // U1-U4 compositions (§3, §5), accepted natively; U2-U4 are expected
    // traps on wasm, and U1 was until B2. U1 is `instanceof` through 2,000
    // bound functions with no
    // `@@hasInstance` in the chain (null prototypes), the walk §3 found
    // uncharged: each bound target is unwrapped with no native frame
    // charged, so it completes at any depth the heap admits. It trapped on
    // the Worker-sized wasm stacks of lane B until B2 made the walk a loop.
    // A chain over an ordinary function is charged instead, one intrinsic
    // `@@hasInstance` call per layer, and halts at 126
    // (`native_recursion_budget.rs`).
    cases.push(run(
        "u1-uncharged-bound-instanceof-2000",
        "function F() {} Object.setPrototypeOf(F, null); var b = F; \
         for (var i = 0; i < 2000; i++) { b = Function.prototype.bind.call(b, null); Object.setPrototypeOf(b, null); } \
         new F() instanceof b".into(),
    ));
    cases.push(run(
        "u2-tojson-flat-1022",
        format!(
            "{} var deep = a; var o = {{ toJSON: function () {{ return deep.flat(Infinity).length; }} }}; \
             var r = o; for (var i = 0; i < 1982; i++) {{ r = [r]; }} JSON.stringify(r).length",
            nested_arrays(1022)
        ),
    ));
    cases.push(run(
        "u2-tojson-regexp-512",
        "var o = { toJSON: function () { return new RegExp('('.repeat(512) + 'a' + ')'.repeat(512)).source.length; } }; \
         var r = o; for (var i = 0; i < 1982; i++) { r = [r]; } JSON.stringify(r).length"
            .into(),
    ));
    cases.push(Case {
        name: "u3-eval-nest-tagged-2038",
        source: "function f(n) { if (n > 0) return eval('f(n - 1)'); return eval('(function () { return f' + '``'.repeat(2038) + '; })'); } typeof f(41)".into(),
        run: true,
        eval_compiler: true,
    });
    cases.push(Case {
        name: "u3-eval-nest-callchain-2044",
        source: "function f(n) { if (n > 0) return eval('f(n - 1)'); try { return eval('(function () { return g' + '()'.repeat(2044) + '; })'); } catch (e) { return e; } } typeof f(41)".into(),
        run: true,
        eval_compiler: true,
    });
    cases.push(Case {
        name: "u4-function-callchain-in-tojson-1900",
        source: "var o = { toJSON: function () { return typeof Function('return g' + '()'.repeat(2039)); } }; \
                 var r = o; for (var i = 0; i < 1900; i++) { r = [r]; } JSON.stringify(r).length".into(),
        run: true,
        eval_compiler: true,
    });
    // The 25th family case: the RegExp matcher's backtracking, in its own shard.
    cases.push(run(
        "regexp-backtrack",
        "/^(a+)+$/.test('a'.repeat(22) + 'b')".into(),
    ));
    cases
}

/// Case names are `&'static str`; generated ones are leaked once per process.
fn leak(name: String) -> &'static str {
    Box::leak(name.into_boxed_str())
}
