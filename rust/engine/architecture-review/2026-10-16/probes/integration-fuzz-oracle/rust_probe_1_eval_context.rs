// AUDIT PROBE (temporary): the thixotrope worker's `Compiler` (copied from
// rust/thixotrope-ironhorse-worker/src/main.rs:17-116, which overrides only
// compile_source / compile_source_units) versus IronhorseSourceCompiler on a
// direct eval that needs its caller's EvalContext.
use ironhorse_runtime::IronhorseSourceCompiler;
use ironhorse_vm::{CompiledSource, Interp, SourceCompileError, SourceCompiler};
use std::rc::Rc;

struct ThixotropeCompiler;
impl SourceCompiler for ThixotropeCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        match ironhorse_compile::compile_atoms_budgeted_firewalled(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        ) {
            Ok(c) => Ok(CompiledSource {
                bytecode: c.bytecode,
                symbols: c.symbols,
                parse_meter_raw: c.parse_meter_raw,
                parse_computrons: c.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => Err(SourceCompileError::MeterAbort),
            Err(ironhorse_compile::CompileError::Invariant(d)) => {
                Err(SourceCompileError::Invariant(d))
            }
            Err(ironhorse_compile::CompileError::Parse(e)) => match e.kind {
                ironhorse_compile::ParseErrorKind::Unsupported => {
                    Err(SourceCompileError::Unsupported(e.to_string()))
                }
                _ => Err(SourceCompileError::Syntax(e.message)),
            },
        }
    }
    fn compile_source_units(
        &self,
        source: &[u16],
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        match ironhorse_compile::compile_atoms_units_budgeted_firewalled(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        ) {
            Ok(c) => Ok(CompiledSource {
                bytecode: c.bytecode,
                symbols: c.symbols,
                parse_meter_raw: c.parse_meter_raw,
                parse_computrons: c.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => Err(SourceCompileError::MeterAbort),
            Err(ironhorse_compile::CompileError::Invariant(d)) => {
                Err(SourceCompileError::Invariant(d))
            }
            Err(ironhorse_compile::CompileError::Parse(e)) => match e.kind {
                ironhorse_compile::ParseErrorKind::Unsupported => {
                    Err(SourceCompileError::Unsupported(e.to_string()))
                }
                _ => Err(SourceCompileError::Syntax(e.message)),
            },
        }
    }
}

fn run(source: &str, compiler: Rc<dyn SourceCompiler>) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms_with(source, false).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    vm.set_source_compiler(compiler);
    let out = vm.run(&code);
    format!("completed={} result={:?} halt={:?}", out.completed, out.result, out.halt)
}

#[test]
fn probe() {
    let cases = [
        "class B { get x() { return 42; } } class C extends B { m() { return eval('super.x'); } } String(new C().m())",
        "var r; function F() { r = eval('new.target') === F; } new F(); String(r)",
        "class P { #x = 7; m() { return eval('this.#x'); } } String(new P().m())",
        "try { class B { get x() { return 42; } } class C extends B { m() { return eval('super.x'); } } String(new C().m()) } catch (e) { 'caught ' + e }",
    ];
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            for c in cases {
                println!("CASE {c}");
                println!("  runtime    : {}", run(c, Rc::new(IronhorseSourceCompiler)));
                println!("  thixotrope : {}", run(c, Rc::new(ThixotropeCompiler)));
            }
        })
        .unwrap()
        .join()
        .unwrap();
}
