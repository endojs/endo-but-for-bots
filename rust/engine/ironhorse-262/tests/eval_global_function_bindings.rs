//! Oracle-backed regressions for the **global** half of eval declaration
//! instantiation (ECMA-262 EvalDeclarationInstantiation steps 8-10 and
//! `CreateGlobalFunctionBinding`):
//!
//! * every declaration's definability is decided before the first binding is
//!   created, so a declaration the global object refuses (`function NaN(){}`)
//!   leaves none of its siblings behind
//!   (`language/eval-code/indirect/non-definable-function-with-*`);
//! * a function declaration over an existing *configurable* global redefines
//!   it as a writable, enumerable data property, while a non-configurable one
//!   keeps its attributes
//!   (`language/eval-code/{direct,indirect}/var-env-func-init-global-update-*`).
//!
//! Every case is differential: both engines must complete with the same
//! rendered result.

use ironhorse_262::{dual_run, Agreement};

fn assert_oracle_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "agreement for {source}: oracle {:?} ironhorse {:?}",
        run.oracle_error,
        run.ironhorse_error
    );
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
}

#[test]
fn a_refused_function_declaration_creates_no_sibling_binding() {
    for declarations in [
        "function before1() {} function NaN() {} function after1() {}",
        "var before1; function NaN() {} var after1;",
    ] {
        let source = format!(
            "var caught = 'none'; \
             try {{ (0, eval)('{declarations}'); }} catch (e) {{ caught = e.constructor.name; }} \
             [caught, Object.getOwnPropertyDescriptor(globalThis, 'before1'), \
              Object.getOwnPropertyDescriptor(globalThis, 'after1')].join()"
        );
        assert_oracle_result(&source, "TypeError,,");
    }
}

#[test]
fn a_function_declaration_redefines_a_configurable_global() {
    for call in ["(0, eval)", "eval"] {
        let source = format!(
            "Object.defineProperty(globalThis, 'f', \
               {{ value: 1, enumerable: false, writable: false, configurable: true }}); \
             var initial = null; \
             {call}('initial = f; function f() {{ return 345; }}'); \
             var d = Object.getOwnPropertyDescriptor(globalThis, 'f'); \
             [d.writable, d.enumerable, d.configurable, typeof initial, f()].join()"
        );
        assert_oracle_result(&source, "true,true,true,function,345");
    }
}

#[test]
fn a_function_declaration_keeps_a_non_configurable_globals_attributes() {
    let source = "Object.defineProperty(globalThis, 'g', \
           { value: 1, enumerable: true, writable: true, configurable: false }); \
         (0, eval)('function g() { return 4; }'); \
         var d = Object.getOwnPropertyDescriptor(globalThis, 'g'); \
         [d.writable, d.enumerable, d.configurable, g()].join()";
    assert_oracle_result(source, "true,true,false,4");
}
