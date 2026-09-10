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
