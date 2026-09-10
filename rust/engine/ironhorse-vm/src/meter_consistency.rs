// W4: independent runtime-cost laws, separate from oracle telemetry.
use super::{Halt, Interp, Opcode};

fn run(source: &str) -> (String, u64) {
    let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut machine = Interp::new();
    machine.link_intrinsics(&crate::parse_symbols(&names));
    let outcome = machine.run(&code);
    assert_eq!(outcome.halt, Halt::Return, "{source}");
    (outcome.result, machine.meter_index())
}

#[test]
fn string_allocation_price_uses_code_units_across_paths() {
    // Equal code-unit strings cross alignment boundaries at different UTF-8
    // lengths. Allocation cost must not depend on their text encoding.
    for template in [
        "['STRING','STRING'].join('')",
        "['STRING','STRING'].toString()",
        "'STRING'.repeat(2)",
        "JSON.parse('[\"STRING\"]')[0]",
        "JSON.stringify(['STRING'])",
    ] {
        let ascii = run(&template.replace("STRING", "abcdefgh"));
        let cjk = run(&template.replace("STRING", "日本語日本語日本"));
        assert_eq!(ascii.1, cjk.1, "{template}");
    }
}

fn operation_cost(operation: &str, proxied: bool) -> (String, u64) {
    let setup = "var o={x:1}; var p=new Proxy(o,{});";
    let (code, names) = ironhorse_compile::compile_atoms(setup).unwrap();
    let mut machine = Interp::new();
    machine.link_intrinsics(&crate::parse_symbols(&names));
    assert!(machine.run(&code).completed);
    let source = operation.replace("TARGET", if proxied { "p" } else { "o" });
    let (code, names) = ironhorse_compile::compile_atoms(&source).unwrap();
    let code = machine
        .relink_program_symbols(&code, &crate::parse_symbols(&names))
        .unwrap();
    let before = machine.meter_index();
    let outcome = machine.run(&code);
    assert_eq!(outcome.halt, Halt::Return);
    (outcome.result, machine.meter_index() - before)
}

#[test]
fn proxy_forwarding_read_costs_at_least_an_ordinary_read() {
    // Price just the read, after identical setup has allocated both objects.
    // Proxy construction cost cannot mask an unmetered property seam.
    let ordinary = operation_cost("TARGET.x", false);
    let proxy = operation_cost("TARGET.x", true);
    assert_eq!(ordinary.0, proxy.0);
    assert!(proxy.1 > ordinary.1);
}

#[test]
fn straight_line_code_consults_an_armed_host_before_end() {
    // DEBUGGER has no branch/call check point. A flat stream isolates the new
    // dispatch cadence from END and backward-branch checks.
    let mut code = vec![Opcode::XS_CODE_DEBUGGER as u8; 8192];
    code.push(Opcode::XS_CODE_END as u8);
    let mut machine = Interp::new();
    machine.arm_meter(1, Box::new(|_| false));
    let outcome = machine.run(&code);
    assert_eq!(outcome.halt, Halt::MeterAbort);
    assert_eq!(outcome.dispatched, 4096);

    let mut unarmed = Interp::new();
    let expected = unarmed.run(&code);
    let mut allowed = Interp::new();
    allowed.arm_meter(1, Box::new(|_| true));
    let actual = allowed.run(&code);
    assert_eq!(actual.halt, expected.halt);
    assert_eq!(actual.computrons, expected.computrons);
    assert_eq!(allowed.meter_index(), unarmed.meter_index());
}

#[test]
fn descriptor_paths_use_the_same_five_slot_allocation_price() {
    use super::{OrdinaryDescriptor, Slot};
    let mut machine = Interp::new();
    machine.link_intrinsics(&[]);
    // Intern before measuring, so field-name creation cannot mask slot costs.
    for name in [
        "get",
        "set",
        "value",
        "writable",
        "enumerable",
        "configurable",
    ] {
        machine.intern_key(name).unwrap();
    }
    for descriptor in [
        OrdinaryDescriptor {
            value: Some(Slot::integer(1)),
            ..Default::default()
        },
        OrdinaryDescriptor {
            get: Some(Slot::undefined()),
            ..Default::default()
        },
    ] {
        let before = machine.meter_index();
        machine.descriptor_object(descriptor);
        assert_eq!(
            machine.meter_index() - before,
            5 * ironhorse_meter::SLOT_ALLOCATION_METERING
        );
    }
}

#[test]
fn proxy_own_keys_duplicate_scan_checks_before_quadratic_work_finishes() {
    use super::{Payload, Step};
    fn setup() -> (Interp, Vec<u8>, crate::SlotIndex) {
        let source = "var keys=[]; for(var i=0;i<128;i++) keys.push('key'+i); \
                      var p=new Proxy({}, {ownKeys:function(){return keys;}});";
        let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
        let mut machine = Interp::new();
        machine.link_intrinsics(&crate::parse_symbols(&names));
        assert!(machine.run(&code).completed);
        let id = *machine.symbol_ids.get("p").unwrap();
        let prop = machine.find_property(machine.global_obj, id).unwrap();
        let Payload::Reference(proxy) = machine.slots.get(prop).value else {
            panic!("proxy")
        };
        (machine, code, proxy)
    }
    let (mut baseline, code, proxy) = setup();
    let before = baseline.meter_index();
    assert_eq!(baseline.proxy_own_keys(&code, proxy).unwrap().len(), 128);
    let full = (baseline.meter_index() - before) >> 16;
    let (mut bounded, code, proxy) = setup();
    bounded.arm_meter(1, Box::new(move |spent| spent < full));
    assert!(matches!(
        bounded.proxy_own_keys(&code, proxy),
        Err(Step::Host(Halt::MeterAbort))
    ));
}
