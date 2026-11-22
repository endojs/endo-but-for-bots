//! The inline Integer half of `INCREMENT`/`DECREMENT` must leave the machine
//! exactly as `exec_increment`'s generic body does whenever it takes the step, and must hand
//! every other operand (the promotion boundaries, Numbers, BigInts, values
//! that need `ToNumeric`) to it untouched.
use super::*;

fn operands(vm: &mut Interp) -> Vec<Slot> {
    let mut slots: Vec<Slot> = [
        0,
        1,
        -1,
        2,
        -2,
        1000,
        i32::MAX,
        i32::MAX - 1,
        i32::MIN,
        i32::MIN + 1,
        i32::MIN + 2,
    ]
    .into_iter()
    .map(Slot::integer)
    .collect();
    slots.extend(
        [
            0.0,
            -0.0,
            0.5,
            -1.5,
            2_147_483_647.0,
            f64::NAN,
            f64::INFINITY,
        ]
        .into_iter()
        .map(Slot::number),
    );
    slots.extend([
        Slot::boolean(true),
        Slot::undefined(),
        Slot::null(),
        vm.new_string_metered(b"41"),
    ]);
    slots
}

#[test]
fn integer_step_matches_exec_increment() {
    for op in [Opcode::XS_CODE_INCREMENT, Opcode::XS_CODE_DECREMENT] {
        let inc = op == Opcode::XS_CODE_INCREMENT;
        let mut fast = Interp::new();
        let mut generic = Interp::new();
        let fast_operands = operands(&mut fast);
        assert_eq!(fast_operands, operands(&mut generic));
        for operand in fast_operands {
            for vm in [&mut fast, &mut generic] {
                vm.stack.clear();
                vm.push(Slot::boolean(false));
                // Distinct link/id/flag bits: the step must keep them.
                let mut tagged = operand;
                tagged.next = crate::value::SlotIndex(5);
                tagged.id = 7;
                tagged.flag = 3;
                vm.push(tagged);
            }
            let before = fast.stack.clone();
            if !fast.step_integer_in_place(inc) {
                assert_eq!(fast.stack, before, "{op:?} {operand:?} declined");
                let integer_inside = matches!(operand.value, Payload::Integer(v)
                    if v != i32::MIN && v != if inc { i32::MAX } else { i32::MIN + 1 });
                assert!(!integer_inside, "{op:?} {operand:?} should step inline");
                continue;
            }
            assert!(
                generic.increment_generic(&[], inc).is_ok(),
                "{op:?} {operand:?}"
            );
            assert_eq!(fast.stack, generic.stack, "{op:?} {operand:?}");
            assert_eq!(fast.stack.len(), 2);
            assert_eq!(fast.stack[1].kind, Kind::Integer, "{op:?} {operand:?}");
            assert_eq!(
                format!("{:?}", fast.meter_state()),
                format!("{:?}", generic.meter_state())
            );
        }
    }
    let mut empty = Interp::new();
    assert!(!empty.step_integer_in_place(true));
}

#[test]
fn guest_increments_promote_at_the_xs_boundaries() {
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "var a = 2147483646; a++; var b = a; a++; \
         var c = -2147483646; c--; var d = c; c--; \
         var e = 1.5; e++; var f = '4'; f--; var g = 10n; g++; \
         var i = 0, n = 0; for (i = -3; i < 3; i++) n++; \
         [b, typeof b, a, c === -2147483647, d, e, f, typeof f, g, n, i].join()",
    )
    .unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&crate::parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(
        outcome.result,
        "2147483647,number,2147483648,false,-2147483647,2.5,3,number,11,6,3"
    );
}
