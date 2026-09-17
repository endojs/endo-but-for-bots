//! Reproducible F063 probes for interactions between coder bookkeeping paths.
//! These are finite Cartesian products, not a proof of totality. Every source
//! is required to compile: Syntax/Unsupported cannot hide an unvisited coder.

use ironhorse_compile::{compile_atoms_goal, Goal};

const MODES: [(Goal, bool); 5] = [
    (Goal::Script, false),
    (Goal::Script, true),
    (Goal::Eval, false),
    (Goal::Eval, true),
    (Goal::Module, true),
];

fn compiled(source: &str, goal: Goal, strict: bool) {
    match std::panic::catch_unwind(|| compile_atoms_goal(source, goal, strict)) {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => panic!("rejected {goal:?}, strict={strict}: {error:?}\n{source}"),
        Err(_) => panic!("panicked {goal:?}, strict={strict}\n{source}"),
    }
}

#[test]
fn generated_finalizer_target_matrix_compiles() {
    let statements = [
        ";",
        "return;",
        "return x?.m?.();",
        "throw 0;",
        "break outer;",
        "continue outer;",
        "function g(){return ()=>x;} g();",
        "{ using resource=null; (()=>resource)(); }",
        "let {a=(()=>x)()}=x; a;",
        "class C { #v=()=>x; method(){return this.#v;} }",
    ];
    let regions = [
        "BODY",
        "try { BODY } finally { x; }",
        "try { BODY } catch(e) { x; }",
        "try { BODY } catch { x; } finally { x; }",
        "try { try { BODY } finally { x; } } finally { x; }",
        "try { x; } finally { BODY }",
        "try { x; } catch({message}) { BODY }",
        "{ using first=null; using second=null; BODY }",
        "{ using first=null; try { BODY } finally { x; } }",
        "try { using first=null; BODY } finally { x; }",
        "switch(x) { case 0: { BODY } default: x; }",
        "for (let value of x) { BODY }",
        "for (let value in x) { BODY }",
        "for (using value of x) { BODY }",
    ];
    let functions = [
        "function f(x) { BODY }",
        "async function f(x) { BODY }",
        "function* f(x) { BODY }",
        "async function* f(x) { BODY }",
        "const f=(x)=>{ BODY };",
        "const f=async(x)=>{ BODY };",
        "class C { method(x) { BODY } }",
    ];
    let loops = [
        "outer: for (let i=0; i<1; i++) { BODY }",
        "outer: while (x) { BODY }",
        "outer: do { BODY } while (x);",
    ];
    let mut count = 0;
    for statement in statements {
        for region in regions {
            let region = region.replace("BODY", statement);
            for loop_ in loops {
                let body = loop_.replace("BODY", &region);
                for function in functions {
                    let source = function.replace("BODY", &body);
                    for (goal, strict) in MODES {
                        compiled(&source, goal, strict);
                        count += 1;
                    }
                }
            }
        }
    }
    assert_eq!(count, 14_700);
}

#[test]
fn generated_suspending_finalizers_compile_in_their_legal_contexts() {
    let mut count = 0;
    for statement in [
        "await x;",
        "for await (const value of x) { if(value) break outer; }",
        "for await (const value of x) { if(value) continue outer; }",
        "await using resource=x; (()=>resource)();",
        "for (await using resource of x) { if(resource) break outer; }",
        "for await (await using resource of x) { if(resource) continue outer; }",
    ] {
        for region in [
            "BODY",
            "try { BODY } finally { await x; }",
            "try { await x; } finally { BODY }",
            "{ await using first=x; BODY }",
        ] {
            let region = region.replace("BODY", statement);
            let body = format!("outer: for (;;) {{ {region} }}");
            for function in ["async function f(x){BODY}", "async function* f(x){BODY}"] {
                let source = function.replace("BODY", &body);
                for (goal, strict) in MODES {
                    compiled(&source, goal, strict);
                    count += 1;
                }
            }
            // Top-level await and await-using are Module-only. A wrapper
            // function must not accidentally hide that separate entry path.
            compiled(&body, Goal::Module, true);
            count += 1;
        }
    }
    for statement in ["yield x;", "yield* x;", "return yield* x;"] {
        for region in [
            "BODY",
            "try { BODY } finally { yield x; }",
            "{ using resource=x; BODY }",
            "try { yield x; } finally { BODY }",
        ] {
            let body = region.replace("BODY", statement);
            for function in ["function* f(x){BODY}", "async function* f(x){BODY}"] {
                let source = function.replace("BODY", &body);
                for (goal, strict) in MODES {
                    compiled(&source, goal, strict);
                    count += 1;
                }
            }
        }
    }
    assert_eq!(count, 384);
}

#[test]
fn generated_assignment_target_matrix_compiles() {
    let mut count = 0;
    for target in ["x", "x.p", "x[key]", "this.#value", "super.p", "super[key]"] {
        for operator in [
            "=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=",
            "&&=", "||=", "??=",
        ] {
            for use_ in ["EXPR;", "return EXPR;", "for(;x;EXPR){}"] {
                let expression = format!("{target} {operator} (()=>x)()");
                let body = use_.replace("EXPR", &expression);
                let source =
                    format!("class C extends Base {{ #value; method(x,key) {{ {body} }} }}");
                for (goal, strict) in MODES {
                    compiled(&source, goal, strict);
                    count += 1;
                }
            }
        }
    }
    assert_eq!(count, 1_440);
}

#[test]
fn generated_array_binding_finalizers_compile() {
    // ArrayBinding has its own iterator-close/alias/finalize path. In
    // particular, a hoisted module function's parameter binding runs before
    // either that function or its enclosing module installs a return target.
    let patterns = [
        "[]",
        "[a]",
        "[,a,...rest]",
        "[...rest]",
        "[[a]=[],{b}={},...rest]",
        "[a=(()=>{try{try{return x;}finally{x;}}finally{x;}})()]",
    ];
    let positions = [
        "let PATTERN=x;",
        "function f(PATTERN=x){return ()=>x;}",
        "const f=(PATTERN=x)=>x;",
        "try{throw x;}catch(PATTERN){x;}",
        "outer: for(const PATTERN of x){try{continue outer;}finally{x;}}",
        "let a,b,rest; (PATTERN=x);",
        "function f(){try{let PATTERN=x;return x;}finally{x;}}",
        "function* f(){let PATTERN=x;try{yield x;}finally{return x;}}",
    ];
    let mut count = 0;
    for pattern in patterns {
        for position in positions {
            let source = position.replace("PATTERN", pattern);
            for (goal, strict) in MODES {
                compiled(&source, goal, strict);
                count += 1;
            }
        }
    }
    assert_eq!(count, 240);
}

#[test]
fn generated_declaration_and_expression_matrix_compiles() {
    let expressions = [
        "x",
        "(()=>x)",
        "(function named(a=()=>named){return a;})",
        "(class Named { #value=()=>x; get(){return this.#value;} })",
        "x?.m?.(x?.n)",
        "(x??(()=>x))",
        "((x)=>x)(x)",
        "({[x]:()=>x, get p(){return x;}, ...x})",
        "([...x,()=>x])",
        "`a${(()=>x)()}`",
        "eval('x')",
    ];
    let positions = [
        "const result=EXPR;",
        "function f(a=EXPR){return a;}",
        "const f=({a=EXPR}={})=>a;",
        "class C extends (EXPR) {}",
        "class C { [EXPR]=()=>x; static [EXPR]=()=>x; }",
        "class C { field=EXPR; static field=EXPR; }",
        "class C { #field=EXPR; static #s=EXPR; }",
        "({[EXPR]: EXPR});",
        "let target; ({[EXPR]:target=EXPR}=x);",
        "try{}catch({[EXPR]:target=EXPR}){target;}",
        "function f(){return EXPR;}",
        "function f(){using resource=EXPR; return ()=>resource;}",
        "class C extends Base { constructor(a=EXPR){super();} }",
        "for (let i=EXPR; EXPR; i=EXPR) { (()=>i)(); }",
    ];
    let mut count = 0;
    for expression in expressions {
        for position in positions {
            let source = position.replace("EXPR", expression);
            for (goal, strict) in MODES {
                compiled(&source, goal, strict);
                count += 1;
            }
        }
    }
    assert_eq!(count, 770);
}
