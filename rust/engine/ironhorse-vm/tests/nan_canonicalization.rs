//! F081: inspect bytes, not String(NaN), to detect NaN sign/payload divergence.
use ironhorse_vm::{parse_symbols, Interp, Kind, Payload, Slot};

#[test]
fn number_construction_canonicalizes_nan_only() {
    for bits in [
        0x7ff0_0000_0000_0001,
        0x7ff8_0000_0000_0042,
        0xfff0_0000_0000_0001,
        0xfff8_ffff_ffff_ffff,
        0,
        0x8000_0000_0000_0000,
        1,
        0x8000_0000_0000_0001,
        0x7ff0_0000_0000_0000,
        0xfff0_0000_0000_0000,
        0x7fef_ffff_ffff_ffff,
    ] {
        let n = f64::from_bits(bits);
        let expected = if n.is_nan() {
            0x7ff8_0000_0000_0000
        } else {
            bits
        };
        for slot in [
            Slot::number(n),
            Slot::of(Kind::Number, Payload::Number(n)),
            Slot::property(42, Payload::Number(n)),
        ] {
            let Payload::Number(actual) = slot.value else {
                panic!("expected number")
            };
            assert_eq!(actual.to_bits(), expected);
        }
    }
}

#[test]
fn guest_number_writes_have_canonical_bytes() {
    // DataView's explicit byte order makes this independent of host endianness.
    let source = include_str!("fixtures/nan-canonicalization.js");
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(
        outcome.result,
        format!(
            "{}4293918720:1,{}2143289344,2143289344,2147483648:0,2146435072:0,4293918720:0",
            "2146959360:0,".repeat(5),
            "2146959360:0,".repeat(4),
        )
    );
}
