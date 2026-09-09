//! F151: the source compiler's bare diagnostic reaches the guest unchanged.
use ironhorse_vm::{CompiledSource, Interp, SourceCompileError, SourceCompiler};

struct RejectingCompiler;
impl SourceCompiler for RejectingCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        _raw_budget: u64,
        _charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        // This fixture only submits invalid source. Use the real compiler's
        // diagnostic and the production adapter's bare-message translation.
        let error = ironhorse_compile::compile_with(source, strict).unwrap_err();
        Err(SourceCompileError::Syntax(error.message))
    }
}

#[test]
fn eval_lexer_errors_do_not_expose_tooling_line_prefixes() {
    let source = r#"
        var errors = [];
        for (var source of ['0x', '\n0x', '/*', "'a\nb'"]) {
            try { eval(source); } catch (error) { errors.push(String(error)); }
        }
        errors.join('|')
    "#;
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols_checked(&symbols).unwrap());
    vm.set_source_compiler(std::rc::Rc::new(RejectingCompiler));
    let out = vm.run(&code);
    assert!(out.completed, "{:?}", out.halt);
    assert_eq!(out.result, "SyntaxError: invalid number|SyntaxError: invalid number|SyntaxError: end of file in comment|SyntaxError: end of line in string");
}
