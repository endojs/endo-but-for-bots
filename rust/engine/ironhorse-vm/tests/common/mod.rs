//! The one `SourceCompiler` the integration tests share.
//!
//! `tests/common/mod.rs` is Cargo's shared-helper location: it is not built as
//! its own test binary, only pulled in by the files that declare `mod common;`.
//!
//! This mapping used to be copy-pasted per test file -- thirteen verbatim
//! copies in this directory when it was last counted -- so every change to the
//! `CompileError` -> `SourceCompileError` arms (the `RegExpResourceLimit` and
//! `RegExpBudgetExceeded` ones, say) had to be repeated N times or silently
//! diverge. New test files should use this rather than paste a fourteenth.

pub struct TestCompiler;
impl ironhorse_vm::SourceCompiler for TestCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        // FIREWALLED. A compiler panic arrives as
        // `CompileError::Invariant` and is passed through as an engine
        // fault, not folded into `Unsupported` — which is what every
        // hand-written catcher did, and how an invariant violation came to
        // read as an unported construct (architecture finding F063).
        match ironhorse_compile::compile_atoms_budgeted_firewalled(
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
            Err(ironhorse_compile::CompileError::Invariant(detail)) => {
                Err(ironhorse_vm::SourceCompileError::Invariant(detail))
            }
        }
    }
}
