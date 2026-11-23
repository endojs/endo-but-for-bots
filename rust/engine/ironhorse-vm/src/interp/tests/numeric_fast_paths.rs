//! The inline Number fast paths of `+`, the other arithmetic operators, the
//! bitwise operators and the relational comparisons must leave the machine
//! exactly as their generic paths do: the same value stack, slot for slot
//! (kind, payload bits, link, id and flag), and the same meter state.
use super::*;

/// Number operands in both XS slot kinds, chosen around the edges the
/// operators care about: zero and negative zero, the Int32 limits and their
/// overflow, shift counts past 31 and negative, NaN, the infinities, values
/// that `ToInt32` wraps, and an integral value held as a Number.
fn operands() -> Vec<Slot> {
    let mut slots: Vec<Slot> = [
        0,
        1,
        -1,
        2,
        3,
        -3,
        7,
        -7,
        31,
        32,
        33,
        -33,
        46_341,
        65_536,
        i32::MAX,
        i32::MAX - 1,
        i32::MIN,
        i32::MIN + 1,
    ]
    .into_iter()
    .map(Slot::integer)
    .collect();
    slots.extend(
        [
            0.0,
            -0.0,
            0.5,
            -0.5,
            1.5,
            -1.5,
            3.0,
            -3.0,
            32.0,
            2_147_483_647.0,
            2_147_483_648.0,
            -2_147_483_648.0,
            -2_147_483_649.0,
            4_294_967_295.0,
            4_294_967_296.0,
            4_294_967_301.0,
            9_007_199_254_740_993.0,
            1e300,
            -1e300,
            f64::MIN_POSITIVE,
            5e-324,
            f64::NAN,
            -f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ]
        .into_iter()
        .map(Slot::number),
    );
    slots
}

/// Run `fast` and `generic` on the same operand pair in two machines and
/// require identical outcomes, stacks and meter states. A sentinel below the
/// operands checks that neither path disturbs the rest of the stack.
fn assert_same(
    label: &str,
    fast: impl Fn(&mut Interp) -> Result<(), Step>,
    generic: impl Fn(&mut Interp) -> Result<(), Step>,
) {
    let mut fast_vm = Interp::new();
    let mut generic_vm = Interp::new();
    let operands = operands();
    for a in &operands {
        for b in &operands {
            for vm in [&mut fast_vm, &mut generic_vm] {
                vm.stack.clear();
                vm.push(Slot::boolean(true));
                vm.push(*a);
                vm.push(*b);
            }
            let fast_ok = fast(&mut fast_vm).is_ok();
            let generic_ok = generic(&mut generic_vm).is_ok();
            assert!(fast_ok && generic_ok, "{label} {a:?} {b:?}");
            assert_eq!(fast_vm.stack, generic_vm.stack, "{label} {a:?} {b:?}");
            assert_eq!(fast_vm.stack.len(), 2, "{label} {a:?} {b:?}");
        }
    }
    assert_eq!(
        format!("{:?}", fast_vm.meter_state()),
        format!("{:?}", generic_vm.meter_state()),
        "{label}"
    );
}

#[test]
fn number_arithmetic_fast_path_matches_the_generic_path() {
    for (label, op) in [
        ("sub", ArithOp::Sub),
        ("mul", ArithOp::Mul),
        ("div", ArithOp::Div),
        ("mod", ArithOp::Mod),
        ("add", ArithOp::Add),
    ] {
        assert_same(
            label,
            |vm| vm.binary_arith(&[], op),
            |vm| vm.binary_arith_generic(&[], op),
        );
    }
}

#[test]
fn number_addition_fast_path_matches_the_generic_path() {
    assert_same("op_add", |vm| vm.op_add(&[]), |vm| vm.op_add_generic(&[]));
}

#[test]
fn number_bitwise_fast_path_matches_the_generic_path() {
    for (label, op) in [
        ("and", BitOp::And),
        ("or", BitOp::Or),
        ("xor", BitOp::Xor),
        ("shl", BitOp::Shl),
        ("sar", BitOp::Sar),
        ("shr", BitOp::Shr),
    ] {
        assert_same(
            label,
            |vm| vm.binary_bit(&[], op),
            |vm| vm.binary_bit_generic(&[], op),
        );
    }
}

#[test]
fn number_relational_fast_path_matches_the_generic_path() {
    for (label, op) in [
        ("less", RelOp::Less),
        ("less_equal", RelOp::LessEqual),
        ("more", RelOp::More),
        ("more_equal", RelOp::MoreEqual),
    ] {
        assert_same(
            label,
            |vm| vm.relational(&[], op),
            |vm| vm.relational_generic(&[], op),
        );
    }
}

/// The slot kind of a fast-path result is part of the machine image, so pin
/// the normalisations the generic path makes: Integer while the result is an
/// exact Int32 other than `-0`, Number otherwise.
#[test]
fn number_fast_path_results_keep_the_generic_slot_kinds() {
    let mut vm = Interp::new();
    let mut run = |a: Slot, b: Slot, f: &dyn Fn(&mut Interp) -> Result<(), Step>| {
        vm.stack.clear();
        vm.push(a);
        vm.push(b);
        f(&mut vm).unwrap();
        vm.stack.pop().unwrap()
    };
    let int = Slot::integer;
    let num = Slot::number;
    let add = |vm: &mut Interp| vm.op_add(&[]);
    let mul = |vm: &mut Interp| vm.binary_arith(&[], ArithOp::Mul);
    let modulo = |vm: &mut Interp| vm.binary_arith(&[], ArithOp::Mod);
    let shr = |vm: &mut Interp| vm.binary_bit(&[], BitOp::Shr);
    let or = |vm: &mut Interp| vm.binary_bit(&[], BitOp::Or);
    let less = |vm: &mut Interp| vm.relational(&[], RelOp::Less);
    assert_eq!(run(int(1), int(2), &add), int(3));
    assert_eq!(run(int(i32::MAX), int(1), &add), num(2_147_483_648.0));
    // A Number operand keeps the result a Number even when it is integral.
    assert_eq!(run(num(1.0), int(2), &add), num(3.0));
    assert_eq!(run(int(0), int(-5), &mul), num(-0.0));
    assert_eq!(run(int(-4), int(2), &modulo), num(-0.0));
    assert_eq!(run(int(-5), int(3), &modulo), int(-2));
    assert_eq!(run(int(5), int(0), &modulo), num(f64::NAN));
    assert_eq!(run(int(-1), int(0), &shr), num(4_294_967_295.0));
    assert_eq!(run(int(-1), int(1), &shr), int(i32::MAX));
    assert_eq!(run(num(4_294_967_301.0), num(0.5), &or), int(5));
    assert_eq!(run(num(f64::NAN), int(0), &less), Slot::boolean(false));
    assert_eq!(run(int(-1), num(-0.5), &less), Slot::boolean(true));
}
