//! String `+` joins two String operands on their stored UTF-16BE payloads.
//! The joined chunk, the charge and the rest of the machine must match the
//! generic decode/re-encode path for every input, lone surrogates included.
use super::*;

fn string(vm: &mut Interp, units: &[u16]) -> Slot {
    let off = vm.chunks.alloc(&units_to_be16(units));
    Slot::of(Kind::String, Payload::String(off))
}

/// The general path of `concat_add`, which the payload join replaces for
/// two Strings: decode both, charge the joined length, re-encode, allocate.
fn general_concat(vm: &mut Interp, a: Slot, b: Slot) {
    let ua = vm.to_string_units_metered(a);
    let ub = vm.to_string_units_metered(b);
    vm.meter.tick_string((ua.len() + ub.len()) as u64);
    let joined: Vec<u16> = ua.into_iter().chain(ub).collect();
    let off = vm.chunks.alloc(&units_to_be16(&joined));
    vm.push(Slot::of(Kind::String, Payload::String(off)));
}

#[test]
fn payload_concat_matches_the_generic_path_byte_for_byte() {
    let operands: &[&[u16]] = &[
        &[],
        &[0x61],
        &[0x61, 0x62, 0x63],
        &[0x0000, 0x00ff, 0x0100, 0xfffe, 0xffff],
        // A lone high surrogate and a lone low surrogate: the joined value is
        // the pair U+1F600 in either path.
        &[0x61, 0xd83d],
        &[0xde00, 0x62],
        &[0xd83d],
        &[0xde00],
        &[0xd83d, 0xde00],
    ];
    for a_units in operands {
        for b_units in operands {
            let mut fast = Interp::new();
            let mut generic = Interp::new();
            let (a, b) = (string(&mut fast, a_units), string(&mut fast, b_units));
            assert_eq!(string(&mut generic, a_units), a);
            assert_eq!(string(&mut generic, b_units), b);
            fast.concat_add(a, b);
            general_concat(&mut generic, a, b);
            let (Some(x), Some(y)) = (fast.stack.last(), generic.stack.last()) else {
                panic!("no result");
            };
            assert_eq!(x, y, "{a_units:x?} + {b_units:x?}");
            let Payload::String(off) = x.value else {
                panic!("not a string");
            };
            let joined: Vec<u16> = a_units.iter().chain(b_units.iter()).copied().collect();
            assert_eq!(fast.str_units(off), joined);
            assert_eq!(fast.chunks.raw_vec(), generic.chunks.raw_vec());
            assert_eq!(
                format!("{:?}", fast.meter_state()),
                format!("{:?}", generic.meter_state())
            );
        }
    }
}

#[test]
fn split_surrogates_join_into_one_code_point() {
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "var h = '\\uD83D', l = '\\uDE00'; var s = h + l; \
         [s === '\\uD83D\\uDE00', s.length, s.codePointAt(0), ('a' + h) + (l + 'b') === 'a\\uD83D\\uDE00b'].join()",
    )
    .unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&crate::parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert_eq!(outcome.result, "true,2,128512,true");
}
