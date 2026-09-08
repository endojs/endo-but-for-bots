//! Literal release vectors, shared unchanged by debug/release and both CI hosts.
use ironhorse_compile::{compile_atoms_budgeted, compile_atoms_with, parse_computrons, Goal};

#[test]
fn frozen_lexical_and_compilation_computrons() {
    assert_eq!(ironhorse_meter::COST_TABLE_VERSION, "ironhorse-meter-3");
    let corpus = include_str!("fixtures/computrons.tsv");
    assert!(corpus.starts_with("# ironhorse-meter-3 "));
    let mut count = 0;
    for line in corpus.lines().skip(1) {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 4);
        let source = fields[0];
        let lexical: u64 = fields[1].parse().unwrap();
        let raw: u64 = fields[2].parse().unwrap();
        let whole: u64 = fields[3].parse().unwrap();
        let expected_atoms = compile_atoms_with(source, false).unwrap();
        for _ in 0..3 {
            let mut charged = 0;
            let compiled = compile_atoms_budgeted(source, Goal::Eval, false, &mut |delta| {
                charged += delta;
                true
            })
            .unwrap();
            assert_eq!(parse_computrons(source, false), Some(lexical), "{source}");
            assert_eq!(compiled.parse_meter_raw, raw, "{source}");
            assert_eq!(compiled.parse_computrons, whole, "{source}");
            assert_eq!(charged, raw, "reported cost is already charged");
            assert_eq!(
                (&compiled.bytecode, &compiled.symbols),
                (&expected_atoms.0, &expected_atoms.1)
            );
        }
        count += 1;
    }
    assert_eq!(count, 15);
}
