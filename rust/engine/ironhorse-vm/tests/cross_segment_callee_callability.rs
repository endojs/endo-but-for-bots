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
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        match ironhorse_compile::compile_atoms_with(source, strict) {
            Ok((bytecode, symbols)) => Ok(ironhorse_vm::CompiledSource { bytecode, symbols }),
            Err(_) => Err(ironhorse_vm::SourceCompileError::Syntax(String::new())),
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
