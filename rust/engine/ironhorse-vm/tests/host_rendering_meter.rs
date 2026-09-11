//! F050: host exception rendering stays unmetered without an XS cost pin.
use ironhorse_vm::{parse_symbols, Halt, Interp};

#[test]
fn exception_rendering_work_does_not_change_run_cost() {
    // Both loop limits use the same-width integer operand, keeping function
    // allocation/bytecode-size charges equal while rendering work differs.
    let mut costs = Vec::new();
    for body in [
        "var n=0; for(var i=0;i<2;i++){n+=i} return 'done'",
        "var n=0; for(var i=0;i<100;i++){n+=i} return 'done'",
    ] {
        let source = format!("throw {{toString(){{{body}}}}}");
        let (code, symbols) = ironhorse_compile::compile_atoms(&source).unwrap();
        let mut vm = Interp::new();
        vm.link_intrinsics(&parse_symbols(&symbols));
        let outcome = vm.run(&code);
        assert!(
            matches!(&outcome.halt, Halt::Throw { rendered, .. } if rendered == "[object Object]")
        );
        costs.push((vm.meter_index(), outcome.computrons));
    }
    assert_eq!(costs[0], costs[1]);
}

#[test]
fn diagnostic_rendering_does_not_execute_guest_work_past_the_meter_ceiling() {
    use std::{cell::Cell, rc::Rc};

    let source = "throw {toString(){var i=0;while(i<100000)i++;return 'done'}}";
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut plain = Interp::new();
    plain.link_intrinsics(&parse_symbols(&symbols));
    let baseline = plain.run(&code);
    assert_eq!(baseline.halt.thrown_rendering(), Some("[object Object]"));
    // A ceiling above the script receipt would refuse inside toString if
    // diagnostic rendering incorrectly resumed guest execution.
    let limit = baseline.computrons + 100;
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let refused_at = Rc::new(Cell::new(None));
    let observed = refused_at.clone();
    vm.arm_meter(
        1,
        Box::new(move |spent| {
            if spent > limit {
                observed.set(Some(spent));
                false
            } else {
                true
            }
        }),
    );
    let outcome = vm.run(&code);
    assert_eq!(outcome.halt.thrown_rendering(), Some("[object Object]"));
    assert!(!outcome.completed);
    assert!(!vm.is_quiescent());
    assert_eq!(refused_at.get(), None);
    assert_eq!(outcome.meter_raw, baseline.meter_raw);
    assert_eq!(outcome.meter_raw, vm.meter_index());
}

#[test]
fn diagnostic_rendering_does_not_execute_guest_allocations() {
    let (code, symbols) =
        ironhorse_compile::compile_atoms("throw {toString(){return 'x'.repeat(1000000)}}").unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    vm.set_chunk_ceiling(vm.chunks().byte_size() + 4096);
    let outcome = vm.run(&code);
    assert_eq!(outcome.halt.thrown_rendering(), Some("[object Object]"));
    assert!(!outcome.completed);
    assert!(!vm.is_quiescent());
}
