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

use ironhorse_262::{dual_run, dual_run_scripts, Agreement};

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

/// The Script counterpart of the eval redefinition: GlobalDeclarationInstantiation
/// step 16.b calls `CreateGlobalFunctionBinding(fn, fo, false)`, so a top-level
/// function declaration over an existing configurable global redefines it as a
/// writable, enumerable, **non**-configurable data property, while a top-level
/// `var` over the same global leaves its attributes untouched.
///
/// The pinned XS oracle departs from the specification here: it redefines the
/// property but leaves it configurable. Ironhorse follows the specification, so
/// this case pins both results; if a future XS pin starts to agree, the oracle
/// assertion fails and the case can become a plain differential one.
#[test]
fn a_script_function_declaration_redefines_a_configurable_global_as_non_configurable() {
    let setup = "Object.defineProperty(globalThis, 'sf', \
           { value: 1, enumerable: false, writable: false, configurable: true }); \
         Object.defineProperty(globalThis, 'sv', \
           { value: 2, enumerable: false, writable: false, configurable: true }); \
         'setup';";
    let body = "function sf() { return 7; } var sv; \
         var df = Object.getOwnPropertyDescriptor(globalThis, 'sf'); \
         var dv = Object.getOwnPropertyDescriptor(globalThis, 'sv'); \
         [df.writable, df.enumerable, df.configurable, sf(), \
          dv.writable, dv.enumerable, dv.configurable, sv].join()";
    let runs = dual_run_scripts(&[setup, body], None).expect("pinned XS oracle is available");
    let run = &runs.last().expect("the body ran").run;
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "oracle {:?} ironhorse {:?}",
        run.oracle_error,
        run.ironhorse_error
    );
    assert_eq!(
        run.ironhorse_result, "true,true,false,7,false,false,true,2",
        "ironhorse result (per ECMA-262)"
    );
    assert_eq!(
        run.oracle_result, "true,true,true,7,false,false,true,2",
        "oracle result (XS keeps the redefined global configurable)"
    );
}
