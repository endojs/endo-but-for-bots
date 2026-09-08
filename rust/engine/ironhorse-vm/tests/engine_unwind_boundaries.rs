//! Regression cases retained from PR #1039 and its reviews.

use ironhorse_vm::{CompiledSource, Halt, Interp, RunOutcome, SourceCompileError, SourceCompiler};

/// Compile JS `source` to XS-identical bytecode + SYMB atoms and run it,
/// relinking intrinsics from the atoms exactly as the test262 harness does.
fn compile_and_run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    ironhorse_vm::run_program_with_symbols(&bytecode, &symbols)
}

fn compile_and_run_observed(source: &str) -> (Interp, RunOutcome) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    let mut interp = Interp::new();
    interp.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    let out = interp.run(&bytecode);
    (interp, out)
}

fn compile_and_run_with_source_compiler(source: &str) -> RunOutcome {
    struct TestCompiler;
    impl SourceCompiler for TestCompiler {
        fn compile_source(
            &self,
            source: &str,
            strict: bool,
            charge: &mut dyn FnMut(u64) -> bool,
        ) -> Result<CompiledSource, SourceCompileError> {
            match ironhorse_compile::compile_atoms_budgeted(
                source,
                ironhorse_compile::Goal::Eval,
                strict,
                charge,
            ) {
                Ok(compiled) => Ok(ironhorse_vm::CompiledSource {
                    bytecode: compiled.bytecode,
                    symbols: compiled.symbols,
                    parse_meter_raw: compiled.parse_meter_raw,
                    parse_computrons: compiled.parse_computrons,
                }),
                Err(ironhorse_compile::CompileError::MeterAbort) => {
                    Err(ironhorse_vm::SourceCompileError::MeterAbort)
                }
                Err(ironhorse_compile::CompileError::Parse(error)) => match error.kind {
                    ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                        kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                        ..
                    }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
                    ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                        kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                        ..
                    }) => Err(ironhorse_vm::SourceCompileError::MeterAbort),
                    ironhorse_compile::ParseErrorKind::Unsupported => Err(
                        ironhorse_vm::SourceCompileError::Unsupported(error.to_string()),
                    ),
                    _ => Err(ironhorse_vm::SourceCompileError::Syntax(error.message)),
                },
            }
        }
    }

    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    let names = ironhorse_vm::parse_symbols(&symbols);
    let mut interp = Interp::new();
    interp.link_intrinsics(&names);
    interp.set_source_compiler(std::rc::Rc::new(TestCompiler));
    interp.run(&bytecode)
}

#[test]
fn engine_reference_error_captured_tdz_read_is_catchable() {
    let out = compile_and_run(
        "try { function read() { return x; } read(); let x = 2; } catch (e) { 919 }",
    );
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "919");
}

#[test]
fn engine_iterator_result_type_error_is_catchable() {
    let out = compile_and_run(
        "try { var it = {}; it[Symbol.iterator] = function () { return this; }; \
         it.next = function () { return 1; }; for (var x of it) {} } catch (e) { 939 }",
    );
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "939");
}

#[test]
fn engine_raise_crossing_callback_returns_resume_to_outer_dispatch() {
    let out = compile_and_run(
        "function outer() { try { [0].map(() => x); let x = 2; } \
         catch (e) { return 555; } } outer();",
    );
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "555");
}

#[test]
fn engine_raise_crossing_dynamic_function_returns_resume_to_outer_dispatch() {
    let out = compile_and_run_with_source_compiler(
        "var f = Function('function read() { return x; } read(); let x = 2;'); \
         try { f(); } catch (e) { 959 }",
    );
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "959");
}

#[test]
fn engine_raise_preserves_exception_for_async_rejection() {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(
        "var caught = false; var ran = false; \
         async function f() { (() => x)(); let x = 2; } \
         f().catch(e => { ran = true; caught = e instanceof ReferenceError; });",
    )
    .expect("source compiles");
    let mut interp = Interp::new();
    interp.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    let out = interp.run(&bytecode);
    assert_eq!(out.halt, Halt::Return);
    // Script completion precedes the microtask drain; inspect globals after
    // run() to prove both execution of the reaction and its rejection value.
    assert_eq!(interp.global_string("ran").as_deref(), Some("true"));
    assert_eq!(interp.global_string("caught").as_deref(), Some("true"));
}

#[test]
fn engine_raise_and_explicit_throw_respect_native_catch_through_finally() {
    for (body, expected_reason, expected_finalized) in [
        ("throw 1;", "true", "0"),
        ("try { throw 1; } finally { finalized++; }", "true", "1"),
        (
            "try { function read() { return x; } read(); let x = 2; } finally { finalized++; }",
            "ReferenceError",
            "1",
        ),
        (
            "try { try { var g; g(); } finally { finalized++; } } finally { finalized++; }",
            "TypeError",
            "2",
        ),
    ] {
        let source = format!(
            "var rejected = false; var reason; var finalized = 0; var escaped = false; \
             try {{ new Promise(function () {{ {body} }}).catch(e => {{ \
                 rejected = true; reason = e === 1 ? true : e.name; \
             }}); }} catch (e) {{ escaped = true; }}"
        );
        let (interp, out) = compile_and_run_observed(&source);
        assert_eq!(out.halt, Halt::Return, "{source}");
        assert_eq!(
            interp.global_string("escaped").as_deref(),
            Some("false"),
            "{source}"
        );
        assert_eq!(
            interp.global_string("rejected").as_deref(),
            Some("true"),
            "{source}"
        );
        assert_eq!(
            interp.global_string("reason").as_deref(),
            Some(expected_reason),
            "{source}"
        );
        assert_eq!(
            interp.global_string("finalized").as_deref(),
            Some(expected_finalized),
            "{source}"
        );
    }
}

#[test]
fn engine_raise_async_handlers_inside_native_try_still_catch() {
    for call in [
        "async function f() { try { var g; g(); } catch (e) { r = 42; } } f();",
        "async function* f() { try { var g; g(); } catch (e) { r = 42; } } f().next();",
        "Array.fromAsync({ get length() { try { var g; g(); } catch (e) { r = 42; } return 0; } });",
    ] {
        let source = format!(
            "var r = 0; try {{ new Promise(function () {{ {call} }}); }} \
             catch (e) {{ r = 77; }} r;"
        );
        let out = compile_and_run(&source);
        assert_eq!(out.halt, Halt::Return, "{source}");
        assert_eq!(out.result, "42", "{source}");
    }
}

#[test]
fn engine_raise_existing_opcodes_cross_dynamic_segment_boundary() {
    for (body, error_type) in [
        ("missingReviewName", "ReferenceError"),
        ("x; let x = 2;", "ReferenceError"),
        ("var { x } = null;", "TypeError"),
        ("delete null.x;", "TypeError"),
    ] {
        let source = format!(
            "var f = Function('{body}'); var x = 0; try {{ f(); }} \
             catch (e) {{ x = e instanceof {error_type} ? 23 : 24; }} x;"
        );
        let out = compile_and_run_with_source_compiler(&source);
        assert_eq!(out.halt, Halt::Return, "{source}");
        assert_eq!(out.result, "23", "{source}");
    }
}

#[test]
fn engine_raise_transits_finally_only_and_still_escapes() {
    // A `finally` with no `catch` pushes a jump too, so the chain is not
    // empty — the exception transits the finally (running it) and then
    // re-escapes. Proves a finally-only `try` is NOT mistaken for a real
    // catch: the run still aborts with the throw.
    let (interp, out) = compile_and_run_observed(
        "var finalized = false; try { var f; f(); } finally { finalized = true; }",
    );
    assert_eq!(interp.global_string("finalized").as_deref(), Some("true"));
    assert!(
        matches!(out.halt, Halt::Throw { .. }),
        "finally-only still escapes"
    );
    assert!(!out.completed);
}

#[test]
fn engine_raise_transiting_finally_is_caught_by_outer_try() {
    // The exception transits an inner finally-only `try` and is caught by
    // the enclosing `catch` — the finally-transit + outer-catch chain.
    let out = compile_and_run(
        "var finalized = false; try { try { var f; f(); } finally { finalized = true; } } \
         catch (e) { finalized && e instanceof TypeError ? 666 : 667; }",
    );
    assert_eq!(out.halt, Halt::Return);
    assert!(out.completed);
    assert_eq!(out.result, "666");
}
