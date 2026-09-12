#![forbid(unsafe_code)]
//! Production compiler adapter for the VM’s runtime source-execution seam.
//! Neither the compiler nor the VM depends on this assembly crate.

/// The [`ironhorse_vm::SourceCompiler`] the VM's runtime source-execution
/// bridge (a string `eval`, the `Function` constructor) drives to compile a
/// source string to bytecode in the running realm. It is ironhorse's own
/// front end ([`ironhorse_compile`]) — the same compiler the top-level
/// program rides — so an eval'd source is held to the identical pipeline.
///
/// Total over the coder's panics (`catch_unwind`): a deferred coder path
/// becomes an honest [`ironhorse_vm::SourceCompileError::Unsupported`]
/// (a coverage gap the VM surfaces as `Halt::NotImplemented`), never a harness
/// crash. A structured parse reject splits on its kind by its kind: an `Unsupported` parse (an unported-but-valid
/// construct) is a coverage gap. Meter refusal becomes an uncatchable
/// `MeterAbort`; other rejects become realm-local, catchable `SyntaxError`s.
/// Charges reach the live VM before each work step, and a shared receipt
/// survives this compiler's unwind boundary.
pub struct IronhorseSourceCompiler;

impl ironhorse_vm::SourceCompiler for IronhorseSourceCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        let meter = ironhorse_compile::ParseMeter::with_charge_callback(raw_budget, charge);
        let compiled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ironhorse_compile::compile_atoms_with_meter(source, strict, meter.clone())
        }));
        if meter.exhausted() {
            return Err(ironhorse_vm::SourceCompileError::MeterAbort);
        }
        match compiled {
            Ok(Ok((bytecode, symbols))) => Ok(ironhorse_vm::CompiledSource {
                bytecode,
                symbols,
                parse_meter_raw: meter.raw(),
                parse_computrons: meter.computrons(),
            }),
            Ok(Err(e)) => {
                match e.kind {
                    ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                        kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                        ..
                    }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
                    ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                        kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                        ..
                    }) => Err(ironhorse_vm::SourceCompileError::MeterAbort),
                    ironhorse_compile::parser::ParseErrorKind::MeterLimit => {
                        Err(ironhorse_vm::SourceCompileError::MeterAbort)
                    }
                    ironhorse_compile::parser::ParseErrorKind::Unsupported => {
                        Err(ironhorse_vm::SourceCompileError::Unsupported(e.to_string()))
                    }
                    // Carry the bare diagnostic (`e.message`, no `line N:`
                    // prefix) so the bridge's realm-local `SyntaxError` renders
                    // with XS's exact wording — the pinned oracle's thrown
                    // `String(exception)` is `SyntaxError: <message>`, and the
                    // differential harness compares the whole string.
                    _ => Err(ironhorse_vm::SourceCompileError::Syntax(e.message)),
                }
            }
            Err(payload) => Err(ironhorse_vm::SourceCompileError::Unsupported(
                panic_message(payload.as_ref()),
            )),
        }
    }

    fn compile_source_units(
        &self,
        source: &[u16],
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        let meter = ironhorse_compile::ParseMeter::with_charge_callback(raw_budget, charge);
        let compiled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            ironhorse_compile::compile_atoms_units_with_meter(
                source,
                ironhorse_compile::Goal::Eval,
                strict,
                meter.clone(),
            )
        }));
        if meter.exhausted() {
            return Err(ironhorse_vm::SourceCompileError::MeterAbort);
        }
        match compiled {
            Ok(Ok((bytecode, symbols))) => Ok(ironhorse_vm::CompiledSource {
                bytecode,
                symbols,
                parse_meter_raw: meter.raw(),
                parse_computrons: meter.computrons(),
            }),
            Ok(Err(e)) => {
                match e.kind {
                    ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                        kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                        ..
                    }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
                    ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                        kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                        ..
                    }) => Err(ironhorse_vm::SourceCompileError::MeterAbort),
                    ironhorse_compile::parser::ParseErrorKind::MeterLimit => {
                        Err(ironhorse_vm::SourceCompileError::MeterAbort)
                    }
                    ironhorse_compile::parser::ParseErrorKind::Unsupported => {
                        Err(ironhorse_vm::SourceCompileError::Unsupported(e.to_string()))
                    }
                    // Carry the bare diagnostic (`e.message`, no `line N:`
                    // prefix) so the bridge's realm-local `SyntaxError` renders
                    // with XS's exact wording — the pinned oracle's thrown
                    // `String(exception)` is `SyntaxError: <message>`, and the
                    // differential harness compares the whole string.
                    _ => Err(ironhorse_vm::SourceCompileError::Syntax(e.message)),
                }
            }
            Err(payload) => Err(ironhorse_vm::SourceCompileError::Unsupported(
                panic_message(payload.as_ref()),
            )),
        }
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    let msg = if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic".to_string()
    };
    // One line AND length-bounded — this becomes part of a report reason string
    // published into report.json/HTML, so a panic payload embedding a minified
    // source cannot land unbounded in the artifact.
    let line = msg.lines().next().unwrap_or("panic").trim();
    line.chars().take(200).collect()
}
