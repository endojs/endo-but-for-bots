//! XS declaration-instantiation and derived-constructor completion diagnostics.

fn check(body: &str, constructor: &str, message: &str) {
    let source = format!("var result='not caught'; try{{{body}}} catch(e){{result=(e instanceof {constructor})+':'+e.message}} result");
    let run = ironhorse_262::dual_run(&source).expect("XS oracle machine");
    assert_eq!(
        run.agreement,
        ironhorse_262::Agreement::BothComplete,
        "{source}: {run:?}"
    );
    assert_eq!(run.oracle_result, format!("true:{message}"), "{source}");
    assert_eq!(run.ironhorse_result, run.oracle_result, "{source}");
}

#[test]
fn eval_global_declaration_rejections() {
    check(
        "Object.defineProperty(globalThis,'blocked',{value:0}); (0,eval)('function blocked(){}')",
        "TypeError",
        "blocked: global property not configurable and not enumerable or writable",
    );
    for declaration in ["var fresh", "function fresh(){}"] {
        check(
            &format!("Object.preventExtensions(globalThis); (0,eval)({declaration:?})"),
            "TypeError",
            "fresh: global object not extensible",
        );
    }
    check(
        "let duplicate=0; eval('var duplicate')",
        "SyntaxError",
        "duplicate: duplicate variable",
    );
    check(
        "function f(){let duplicate=0; eval('var duplicate')} f()",
        "SyntaxError",
        "duplicate: duplicate variable",
    );
}

#[test]
fn derived_constructor_completion_rejections() {
    for primitive in ["0", "null", "false", "'text'"] {
        check(
            &format!("class D extends Object {{constructor(){{return {primitive}}}}} new D()"),
            "TypeError",
            "result: invalid constructor",
        );
    }
    check(
        "class D extends Object {constructor(){}} new D()",
        "ReferenceError",
        "this: not initialized",
    );
}
