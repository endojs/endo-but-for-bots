//! A non-callable call is a catchable `TypeError` whether or not the
//! machine holds a second code segment (architecture review F024).
//!
//! Once an `eval` or a top-level function has retained a code segment, the
//! `RUN` arm asks `cross_segment_callee` whether the callee's body lives in
//! another buffer. That helper classified ANY `Payload::Reference` as a
//! callee — a plain object, an array, a class instance — and routed it to
//! the cross-segment dispatcher rather than to `enter_call`'s callability
//! check. The `assertThrows(function(){ o(); })` idiom is the most common
//! conformance shape in existence, and `function f(){}` at the top of a
//! test file is enough to put a program on this path.

use ironhorse_vm::{Interp, RunOutcome};

/// The eval bridge needs a compiler wired in (the 262 harness's wiring, in
/// miniature); a bare `run_program` answers `eval:no-compiler`.
struct TestCompiler;
impl ironhorse_vm::SourceCompiler for TestCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        match ironhorse_compile::compile_atoms_budgeted_with_limit(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
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

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    let mut m = Interp::new();
    m.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    m.set_source_compiler(std::rc::Rc::new(TestCompiler));
    m.run(&bytecode)
}

fn assert_true(source: &str) {
    let out = run(source);
    assert!(out.completed, "halt: {:?}\n  {source}", out.halt);
    assert_eq!(out.result, "true", "{source}");
}

#[test]
fn calling_a_plain_object_throws_type_error_inside_a_function_frame() {
    assert_true(
        "function g(){} function f(){ var r=0; var o={}; \
         try { o(); } catch(e){ r = e instanceof TypeError } return r } f()",
    );
    assert_true(
        "function f(){ var r=0; try { ({})(); } catch(e){ r = e instanceof TypeError } \
         return r } f()",
    );
}

#[test]
fn calling_a_non_callable_throws_type_error_when_an_eval_segment_exists() {
    assert_true(
        "eval('function g(){}'); function f(){ var r=0; var o={}; \
         try { o(); } catch(e){ r = e instanceof TypeError } return r } f()",
    );
    assert_true(
        "eval('function g(){}'); var r=0; var a=[]; \
         try { a(); } catch(e){ r = e instanceof TypeError } r",
    );
    assert_true(
        "eval('function g(){}'); function f(){ var r=0; var o={}; \
         try { new o(); } catch(e){ r = e instanceof TypeError } return r } f()",
    );
}

#[test]
fn the_assert_throws_idiom_answers_true() {
    assert_true(
        "function g(){} function assertThrows(fn){ try { fn(); } catch(e) { return true; } \
         return false; } var o = {}; assertThrows(function(){ o(); })",
    );
    assert_true(
        "eval('1'); function assertThrows(fn){ try { fn(); } catch(e) { return true; } \
         return false; } var o = {}; assertThrows(function(){ o(); })",
    );
}

#[test]
fn an_eval_defined_function_is_still_called_across_segments() {
    // The path the helper exists for: a callee whose body lives in the
    // eval's buffer must still be dispatched over that buffer.
    let out = run("eval('function g(x){ return x + 1 }'); function f(){ return g(41) } f()");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "42");
}

#[test]
fn a_handler_established_before_code_promotion_catches_across_eval() {
    // CATCH runs before the function expression's CODE promotes the top-level
    // buffer. The eval throw must cross both nested dispatches to land here.
    let out = run("var trace = ''; try { \
           var f = function () { \
             try { eval(\"throw 'boom'\") } finally { trace += 'inner;'; } \
           }; f(); \
         } catch (e) { trace += 'caught:' + e; } \
         finally { trace += ';outer'; } trace");
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "inner;caught:boom;outer");
}

#[test]
fn nested_eval_callback_unwinds_to_the_handler_in_its_own_buffer() {
    let out = run("var trace = ''; \
         var f = eval(\"(function () { \
           try { [1].map(function () { eval(\\\"throw 'boom'\\\") }); } \
           catch (e) { trace += 'callee:' + e; throw 'again'; } \
           finally { trace += ';callee-finally'; } \
         })\"); \
         try { f(); } catch (e) { trace += ';caller:' + e; } trace");
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "callee:boom;callee-finally;caller:again");
}

#[test]
fn a_suspended_eval_handler_survives_code_segment_compaction() {
    let source = "var phase, iterator, trace; \
        if (!phase) { \
          trace = ''; \
          eval('(function discarded() {})'); \
          iterator = eval(\"(function* () { \
            try { yield 'ready'; [1].map(function () { throw 'boom'; }); } \
            catch (e) { yield 'caught:' + e; } \
            finally { trace += 'finally'; } \
          })()\"); \
          phase = 1; iterator.next().value; \
        } else { \
          var first = iterator.next(); var last = iterator.next(); \
          first.value + '|' + last.done + '|' + trace; \
        }";
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compile");
    let mut collected = Interp::new();
    let mut control = Interp::new();
    for vm in [&mut collected, &mut control] {
        vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
        vm.set_source_compiler(std::rc::Rc::new(TestCompiler));
        let out = vm.run(&code);
        assert!(out.completed, "{:?}", out.halt);
        assert_eq!(out.result, "ready");
        assert!(vm.is_quiescent());
    }
    let before = collected.retained_code_segment_count();
    collected.collect_garbage().unwrap();
    assert!(
        collected.retained_code_segment_count() < before,
        "the dead earlier segment must be removed to exercise remapping"
    );
    collected.collect_garbage().unwrap();
    let expected = control.run(&code);
    let actual = collected.run(&code);
    assert!(expected.completed, "{:?}", expected.halt);
    assert!(actual.completed, "{:?}", actual.halt);
    assert_eq!(expected.result, "caught:boom|true|finally");
    assert_eq!(actual.result, expected.result);
}
