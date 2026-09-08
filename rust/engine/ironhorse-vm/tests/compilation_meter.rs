use ironhorse_vm::{CompiledSource, Halt, Interp, SourceCompileError, SourceCompiler};
use std::{cell::Cell, rc::Rc};

struct Compiler {
    charge_vm: bool,
    spent: Rc<Cell<u64>>,
    compiling: Rc<Cell<bool>>,
}
impl SourceCompiler for Compiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<CompiledSource, SourceCompileError> {
        self.compiling.set(true);
        let result = ironhorse_compile::compile_atoms_budgeted(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            &mut |raw| {
                self.spent.set(self.spent.get() + raw);
                !self.charge_vm || charge(raw)
            },
        );
        self.compiling.set(false);
        match result {
            Ok(c) => Ok(CompiledSource {
                bytecode: c.bytecode,
                symbols: c.symbols,
                parse_meter_raw: c.parse_meter_raw,
                parse_computrons: c.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => Err(SourceCompileError::MeterAbort),
            Err(ironhorse_compile::CompileError::Parse(e)) => {
                Err(SourceCompileError::Syntax(e.message))
            }
        }
    }
}

fn run(source: &str, charge_vm: bool, refuse: bool) -> (ironhorse_vm::RunOutcome, u64, u64, usize) {
    let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
    let spent = Rc::new(Cell::new(0));
    let compiling = Rc::new(Cell::new(false));
    let calls = Rc::new(Cell::new(0));
    let mut m = Interp::new();
    m.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
    m.set_source_compiler(Rc::new(Compiler {
        charge_vm,
        spent: spent.clone(),
        compiling: compiling.clone(),
    }));
    let calls_clone = calls.clone();
    m.arm_meter(
        1,
        Box::new(move |_| {
            if compiling.get() {
                calls_clone.set(calls_clone.get() + 1);
            }
            !(refuse && compiling.get())
        }),
    );
    let outcome = m.run(&code);
    (outcome, m.meter_index(), spent.get(), calls.get())
}

#[test]
fn eval_function_and_failed_parse_debit_once() {
    for source in [
        "eval('1+2')",
        "Function('x', 'return x+2')(1)",
        "try { eval('var ='); } catch(e) { 3; }",
    ] {
        let (plain, baseline, expected, _) = run(source, false, false);
        let (charged, raw, spent, _) = run(source, true, false);
        assert!(plain.completed && charged.completed, "{source}");
        assert_eq!(charged.result, plain.result);
        assert!(spent > 0);
        assert_eq!(spent, expected);
        assert_eq!(
            raw - baseline,
            spent,
            "{source}: reported cost must not debit again"
        );
    }
}

#[test]
fn compilation_refusal_bypasses_guest_catch() {
    for source in [
        "try { eval('1+2'); } catch(e) { 999; }",
        "try { Function('return 3')(); } catch(e) { 999; }",
    ] {
        let (outcome, _, spent, calls) = run(source, true, true);
        assert_eq!(outcome.halt, Halt::MeterAbort, "{source}");
        assert!(!outcome.completed);
        assert!(spent > 0);
        assert_eq!(calls, 1, "compiler stopped on the first host refusal");
    }
}

#[test]
fn compilation_can_span_many_host_consultations() {
    let (outcome, _, _, calls) = run("eval('var x=0; x++; x++; x++; x++; x')", true, false);
    assert!(outcome.completed);
    assert_eq!(outcome.result, "4");
    assert!(
        calls > 3,
        "an interval is a check cadence, not the total budget"
    );
}
