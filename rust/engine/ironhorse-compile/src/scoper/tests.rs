//! Scoper fixture tests — the numbering / scope-shape contract for the
//! coder child. Each asserts the [`ScopeTree::dump`] of a representative
//! program: the scope kinds and nesting, the declare-list order (the
//! coder's slot order via `node->index = coder->scopeLevel++`), the
//! closure / useClosure flags (capture analysis), the per-function
//! `scopeCount` (frame slot count), and the access resolutions. Expected
//! values are derived by reading `c/moddable/xs/sources/xsScope.c` at the
//! oracle pin; they are the explicit, readable contract the job asks for,
//! and a divergence here is a byte-identity failure downstream.

use super::{scope_module, scope_program};
use crate::parser::ParseErrorKind;

fn dump(src: &str) -> String {
    scope_program(src, false).expect("scopes").dump()
}

fn dump_module(src: &str) -> String {
    scope_module(src).expect("module scopes").dump()
}

fn assert_module(src: &str, want: &str) {
    let got = dump_module(src);
    assert_eq!(got, want.trim_start_matches('\n'), "\n--- module ---\n{src}\n--- got ---\n{got}");
}

/// Assert the dump equals `want` (leading newline in `want` trimmed for
/// readable raw-string fixtures).
fn assert_dump(src: &str, want: &str) {
    let got = dump(src);
    assert_eq!(got, want.trim_start_matches('\n'), "\n--- source ---\n{src}\n--- got ---\n{got}");
}

// ---- program-level var / function are global (closure) slots ----

#[test]
fn program_var_and_function_are_global() {
    // Program `var`/function declares survive in the program scope for the
    // coder to create globals, but `declareCount` discounts them (0) and
    // fxScopeBound marks them closure|useClosure; accesses route to the
    // global object, not a frame slot.
    assert_dump(
        "var x = 1; function f() { return x; }",
        "\
s0 PROGRAM scopeCount=0 declareCount=0
  d0 VAR x closure useClosure
  d1 DEFINE f closure useClosure
  define f
  s1 FUNCTION scopeCount=0 declareCount=0
    s2 BLOCK declareCount=0
--- accesses ---
x -> global
f -> global
x -> global
",
    );
}

// ---- lexical nesting: each block reserves a frame level ----

#[test]
fn nested_blocks_bump_scope_count() {
    assert_dump(
        "{ let y = 1; { let z = 2; y; } }",
        "\
s0 PROGRAM scopeCount=2 declareCount=0
  s1 BLOCK declareCount=1
    d0 LET y
    s2 BLOCK declareCount=1
      d0 LET z
--- accesses ---
y -> s1:d0
z -> s2:d0
y -> s1:d0
",
    );
}

// ---- function params + var: the frame slot count ----

#[test]
fn function_params_and_var() {
    // args live in the FUNCTION scope (2 slots), the `var` in the body
    // BLOCK (1 more) → scopeCount=3.
    assert_dump(
        "function g(a, b) { var c; return a + b + c; }",
        "\
s0 PROGRAM scopeCount=0 declareCount=0
  d0 DEFINE g closure useClosure
  define g
  s1 FUNCTION scopeCount=3 declareCount=2
    d0 ARG a
    d1 ARG b
    s2 BLOCK declareCount=1
      d0 VAR c
--- accesses ---
g -> global
a -> s1:d0
b -> s1:d1
c -> s2:d0
a -> s1:d0
b -> s1:d1
c -> s2:d0
",
    );
}

// ---- closure capture: the alias node + closureCount ----

#[test]
fn closure_capture_creates_alias() {
    // `inner` captures `v`; `v` is marked closure in the body block, and
    // `inner`'s scope gains a NoToken closure alias (closureCount=1) that
    // forwards to it — the alias is a real frame slot (scopeCount=1).
    assert_dump(
        "function outer() { var v = 1; function inner() { return v; } return inner; }",
        "\
s0 PROGRAM scopeCount=0 declareCount=0
  d0 DEFINE outer closure useClosure
  define outer
  s1 FUNCTION scopeCount=2 declareCount=0
    s2 BLOCK declareCount=2
      d0 VAR v closure
      d1 DEFINE inner
      define inner
      s3 FUNCTION scopeCount=1 declareCount=1 closureCount=1
        d0 alias v closure useClosure -> s2:d0
        s4 BLOCK declareCount=0
--- accesses ---
outer -> global
v -> s2:d0
inner -> s2:d1
v -> s3:d0
inner -> s2:d1
",
    );
}

// ---- var hoists out of a plain block to the function/program body ----

#[test]
fn var_hoists_out_of_block() {
    assert_dump(
        "{ var w = 1; } w;",
        "\
s0 PROGRAM scopeCount=0 declareCount=0
  d0 VAR w closure useClosure
  s1 BLOCK declareCount=0
--- accesses ---
w -> global
w -> global
",
    );
}

// ---- direct eval poisons the whole scope chain ----

#[test]
fn direct_eval_poisons_scopes() {
    // A direct `eval` poisons the enclosing scopes (`eval` marker) and, like
    // `mxArgumentsFlag`, injects the synthetic `arguments` `Var` into the
    // function scope (`fxFunctionNodeHoist`) — even when the eval is only
    // discovered while hoisting the body. `fxScopeBound` closure-marks every
    // declare of an eval scope.
    assert_dump(
        "function f() { var x; eval('x'); }",
        "\
s0 PROGRAM eval scopeCount=0 declareCount=0
  d0 DEFINE f closure useClosure
  define f
  s1 FUNCTION eval scopeCount=2 declareCount=1
    d0 VAR arguments closure
    s2 BLOCK eval declareCount=1
      d0 VAR x closure
--- accesses ---
f -> global
x -> s2:d0
eval -> global
",
    );
}

// ---- with poisons enclosing scopes; accesses inside route dynamic ----

#[test]
fn with_poisons_and_shadows() {
    assert_dump(
        "function f() { var x; with (obj) { x; } }",
        "\
s0 PROGRAM eval scopeCount=0 declareCount=0
  d0 DEFINE f closure useClosure
  define f
  s1 FUNCTION eval scopeCount=1 declareCount=0
    s2 BLOCK eval declareCount=1
      d0 VAR x closure
      s3 WITH declareCount=0
        s4 BLOCK declareCount=0
--- accesses ---
f -> global
x -> s2:d0
obj -> global
x -> global
",
    );
}

// ---- try / catch: parameter scope, body scope, and the try push ----

#[test]
fn try_catch_with_parameter() {
    assert_dump(
        "try { g(); } catch (e) { e; }",
        "\
s0 PROGRAM scopeCount=4 declareCount=0
  s1 BLOCK declareCount=0
  s2 BLOCK declareCount=1
    d0 LET e
    s3 BLOCK declareCount=0
--- accesses ---
g -> global
e -> s2:d0
e -> s2:d0
",
    );
}

#[test]
fn try_catch_no_parameter() {
    assert_dump(
        "try { g(); } catch { h(); }",
        "\
s0 PROGRAM scopeCount=3 declareCount=0
  s1 BLOCK declareCount=0
  s2 BLOCK declareCount=0
--- accesses ---
g -> global
h -> global
",
    );
}

// ---- arrow using `this` is marked default (needs enclosing this) ----

#[test]
fn arrow_capturing_this_is_default() {
    assert_dump(
        "function f() { return () => this; }",
        "\
s0 PROGRAM scopeCount=0 declareCount=0
  d0 DEFINE f closure useClosure
  define f
  s1 FUNCTION scopeCount=0 declareCount=0
    s2 BLOCK declareCount=0
      s3 FUNCTION scopeCount=0 declareCount=0 arrow-default
        s4 BLOCK declareCount=0
--- accesses ---
f -> global
",
    );
}

// ---- for-let: loop binding scope, postfix bumps the frame ----

#[test]
fn for_let_scope() {
    assert_dump(
        "for (let i = 0; i < 3; i++) { i; }",
        "\
s0 PROGRAM scopeCount=2 declareCount=0
  s1 BLOCK declareCount=1
    d0 LET i
    s2 BLOCK declareCount=0
--- accesses ---
i -> s1:d0
i -> s1:d0
i -> s1:d0
i -> s1:d0
",
    );
}

// ---- named function expression: the CONST self-binding ----

#[test]
fn named_function_expression_self_binding() {
    assert_dump(
        "var g = function rec() { return rec; };",
        "\
s0 PROGRAM scopeCount=0 declareCount=0
  d0 VAR g closure useClosure
  s1 FUNCTION scopeCount=1 declareCount=1
    d0 DEFINE rec
    define rec
    s2 BLOCK declareCount=0
--- accesses ---
g -> global
rec -> s1:d0
",
    );
}

// =============================== early errors ===============================

fn scope_err(src: &str) -> String {
    match scope_program(src, false) {
        Err(e) => {
            assert_eq!(e.kind, ParseErrorKind::Syntax, "expected a scoper SyntaxError for {src}");
            e.message
        }
        Ok(_) => panic!("expected an early error for {src}"),
    }
}

#[test]
fn duplicate_lexical_is_error() {
    assert_eq!(scope_err("let a; let a;"), "duplicate variable");
    assert_eq!(scope_err("let a; var a;"), "duplicate variable");
    assert_eq!(scope_err("const b = 1; let b = 2;"), "duplicate variable");
}

#[test]
fn duplicate_strict_argument_is_error() {
    // Dup params are legal sloppy but an early error once strict. Sloppy,
    // the second `a` reuses the first arg slot (one ARG, both accesses
    // resolve to it); strict, it is a duplicate-argument early error.
    assert_eq!(scope_err("function f(a, a) { 'use strict'; }"), "duplicate argument");
    assert_dump(
        "function f(a, a) { return a; }",
        "\
s0 PROGRAM scopeCount=0 declareCount=0
  d0 DEFINE f closure useClosure
  define f
  s1 FUNCTION scopeCount=1 declareCount=1
    d0 ARG a
    s2 BLOCK declareCount=0
--- accesses ---
f -> global
a -> s1:d0
a -> s1:d0
a -> s1:d0
",
    );
}

// =============================== modules ===============================

#[test]
fn module_imports_are_indirect_bindings() {
    // Each import declares a module-scope `let` that is an immutable
    // indirect binding (closure|useClosure); `b as c` binds the local `c`.
    assert_module(
        "import { a, b as c } from 'm'; a; c;",
        "\
s0 MODULE strict scopeCount=2 declareCount=2
  d0 LET a closure useClosure
  d1 LET c closure useClosure
--- accesses ---
a -> s0:d0
c -> s0:d1
",
    );
}

#[test]
fn module_default_import() {
    assert_module(
        "import d from 'm'; d;",
        "\
s0 MODULE strict scopeCount=1 declareCount=1
  d0 LET d closure useClosure
--- accesses ---
d -> s0:d0
",
    );
}

#[test]
fn module_export_marks_local_closure() {
    // A local `const` that is exported becomes a closure|useClosure module
    // binding; the export resolves it (unknown export → early error).
    assert_module(
        "const x = 1; export { x };",
        "\
s0 MODULE strict scopeCount=1 declareCount=1
  d0 CONST x closure useClosure
--- accesses ---
x -> s0:d0
x -> s0:d0
",
    );
}

#[test]
fn module_function_captured_across_import() {
    // Unlike a script, a module top-level function is a lexical binding
    // (it resolves to the declaration, not the global object); an imported
    // name captured by a nested function forms a closure alias.
    assert_module(
        "import { f } from 'm'; function g() { return f; }",
        "\
s0 MODULE strict scopeCount=2 declareCount=2
  d0 LET f closure useClosure
  d1 DEFINE g closure useClosure
  define g
  s1 FUNCTION strict scopeCount=1 declareCount=1 closureCount=1
    d0 alias f closure useClosure -> s0:d0
    s2 BLOCK strict declareCount=0
--- accesses ---
g -> s0:d1
f -> s1:d0
",
    );
}

#[test]
fn module_duplicate_export_is_error() {
    assert_eq!(
        match scope_module("const a = 1; export { a }; export { a };") {
            Err(e) => e.message,
            Ok(_) => panic!("expected duplicate export error"),
        },
        "duplicate export"
    );
}

#[test]
fn module_export_unknown_is_error() {
    assert_eq!(
        match scope_module("export { nope };") {
            Err(e) => e.message,
            Ok(_) => panic!("expected unknown variable error"),
        },
        "unknown variable"
    );
}

#[test]
fn var_redeclaration_is_fine() {
    // Two `var`s of the same name collapse to one slot; a function
    // redeclaration likewise.
    assert_dump(
        "var a; var a; a;",
        "\
s0 PROGRAM scopeCount=0 declareCount=0
  d0 VAR a closure useClosure
--- accesses ---
a -> global
a -> global
a -> global
",
    );
}

// -------- fxParamsBindingNodeBind: getter / setter parameter arity --------

#[test]
fn getter_must_take_no_parameters() {
    // `fxParamsBindingNodeBind`: a getter with any formal parameter is a
    // Syntax Error — for a class accessor and an object-literal accessor
    // alike (the object case flows through `fxObjectNodeBind` copying the
    // getter flag onto the value function).
    for src in [
        "class C { get a(x) {} }",
        "class C { get a(x = 1) {} }",
        "class C { static get a(x) {} }",
        "({ get a(x) {} });",
        "(0, { get a(param = null) {} });",
    ] {
        assert_eq!(scope_err(src), "invalid getter arguments", "src {src}");
    }
    // A zero-parameter getter is legal.
    assert!(scope_program("({ get a() { return 1; } });", false).is_ok());
}

#[test]
fn setter_must_take_exactly_one_nonrest_parameter() {
    // `fxParamsBindingNodeBind`: a setter must take exactly one parameter,
    // and it may not be a rest element.
    for src in [
        "class C { set a() {} }",
        "class C { set a(x, y) {} }",
        "class C { set a(...x) {} }",
        "({ set a() {} });",
        "({ set a(...x) {} });",
    ] {
        assert_eq!(scope_err(src), "invalid setter arguments", "src {src}");
    }
    // Exactly one (possibly defaulted or destructured) parameter is legal.
    assert!(scope_program("({ set a(v) {} });", false).is_ok());
    assert!(scope_program("({ set a(v = 1) {} });", false).is_ok());
    assert!(scope_program("({ set a({x}) {} });", false).is_ok());
}

// -------- fxClassNodeHoist: duplicate PrivateBoundNames --------

#[test]
fn duplicate_private_names_are_error() {
    // PrivateBoundNames of a class body must have no duplicate, unless the
    // name is used once as a getter and once as a setter (same static-ness).
    for src in [
        "class C { #m() {} #m() {} }",
        "class C { get #m() {} #m() {} }",
        "class C { #m() {} get #m() {} }",
        "class C { get #m() {} get #m() {} }",
        "class C { set #m(v) {} set #m(v) {} }",
        "class C { #m; #m; }",
        "class C { #m() {} static #m() {} }", // instance vs static: still a duplicate
    ] {
        assert_eq!(scope_err(src), "duplicate", "src {src}");
    }
    // The single sanctioned exception: one getter and one setter.
    assert!(scope_program("class C { get #m() { return 1; } set #m(v) {} }", false).is_ok());
    assert!(
        scope_program("class C { static get #m() { return 1; } static set #m(v) {} }", false)
            .is_ok()
    );
}
