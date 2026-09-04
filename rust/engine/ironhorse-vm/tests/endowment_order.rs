//! Wave-6 W6-8: compartment endowments must seed in ID order, not
//! per-process HashMap order — seeding writes the global object's
//! property CHAIN (`create_global_property` prepends) and the slot
//! allocation order, so `for-in` enumeration and snapshot bytes were a
//! function of SipHash seeding the moment a compartment carried two or
//! more endowments. (Every in-tree caller seeded zero, which is why no
//! suite ever tripped it.)

use ironhorse_vm::{CompartmentOptions, Machine, Slot};

const NAMES: [&str; 12] = [
    "ea", "eb", "ec", "ed", "ee", "ef", "eg", "eh", "ei", "ej", "ek", "el",
];

#[test]
fn endowments_seed_in_id_order_not_map_order() {
    // The program declares the twelve endowed names (so they live in
    // its symbol atom and enumerate resolvably) and walks `this`.
    let src = "var ea; var eb; var ec; var ed; var ee; var ef; var eg; \
               var eh; var ei; var ej; var ek; var el; \
               var out = ''; var k; for (k in this) { out += k + ','; } out";
    let (b, syms) = ironhorse_compile::compile_atoms(src).expect("compiles");
    let names = ironhorse_vm::parse_symbols(&syms);
    let id_of = |n: &str| names.iter().position(|x| x == n).expect(n) as u16 + 1;

    let run = |insertion: &[&str]| {
        let mut opts = CompartmentOptions::default();
        for n in insertion {
            opts.endowments_by_id.insert(id_of(n), Slot::undefined());
        }
        let c = Machine::new().compartment(opts);
        let out = c.evaluate_with_symbols(&b, &syms);
        assert!(out.completed, "{:?}", out.halt);
        // The endowed subsequence of the enumeration, in order.
        out.result
            .split(',')
            .filter(|k| NAMES.contains(k))
            .map(str::to_string)
            .collect::<Vec<_>>()
    };

    // Ids ascend with first appearance and id-ordered seeding lands
    // them enumerating ASCENDING — one fixed answer regardless of map
    // insertion history. Under HashMap-order seeding this is a
    // per-process permutation (odds of matching: 1/12!).
    let expected: Vec<String> = NAMES.iter().map(|s| s.to_string()).collect();
    assert_eq!(
        run(&NAMES),
        expected,
        "endowment seeding must be a function of ids"
    );
    let reversed: Vec<&str> = NAMES.iter().rev().copied().collect();
    assert_eq!(
        run(&reversed),
        expected,
        "map insertion history must not reach enumeration order"
    );
}
