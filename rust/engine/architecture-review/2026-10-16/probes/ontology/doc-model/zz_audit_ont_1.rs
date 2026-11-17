// Temporary audit probe (doc-model). Deleted after the run.
// The SourceCompiler that rust/thixotrope-ironhorse-worker/src/main.rs:17-117
// installs, copied verbatim minus error-mapping arms that do not fire here:
// it implements compile_source and compile_source_units, and NOT
// compile_eval_units. Compare it with ironhorse-runtime's adapter.
use ironhorse_runtime::IronhorseSourceCompiler;
use ironhorse_vm::{CompiledSource, Interp, SourceCompileError, SourceCompiler};
use std::rc::Rc;

struct WorkerCompiler;
impl SourceCompiler for WorkerCompiler {
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
            Err(ironhorse_compile::CompileError::Invariant(d)) => Err(SourceCompileError::Invariant(d)),
            Err(ironhorse_compile::CompileError::Parse(e)) => Err(SourceCompileError::Syntax(e.message)),
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
            Err(ironhorse_compile::CompileError::Invariant(d)) => Err(SourceCompileError::Invariant(d)),
            Err(ironhorse_compile::CompileError::Parse(e)) => Err(SourceCompileError::Syntax(e.message)),
        }
    }
}

fn run(source: &str, compiler: Rc<dyn SourceCompiler>) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms_with(source, false).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    vm.set_source_compiler(compiler);
    let outcome = vm.run(&code);
    format!("completed={} result={:?} halt={:?}", outcome.completed, outcome.result, outcome.halt)
}

#[test]
fn zz_audit_worker_adapter_vs_runtime_adapter() {
    let programs = [
        "class A { #x = 7; m() { return eval('this.#x'); } } String(new A().m())",
        "class P { get v() { return 5; } } class C extends P { m() { return eval('super.v'); } } String(new C().m())",
        "function F() { return eval('new.target') === F; } String(new F() instanceof F)",
        "var r; try { r = eval('\"\\uD800\"').length } catch (e) { r = String(e) } String(r)",
    ];
    for p in programs {
        println!("PROGRAM {p}");
        println!("  runtime adapter: {}", run(p, Rc::new(IronhorseSourceCompiler)));
        println!("  worker adapter:  {}", run(p, Rc::new(WorkerCompiler)));
    }
}
