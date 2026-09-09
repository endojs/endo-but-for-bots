//! Oracle-free release vectors. These run unchanged on the debug/release,
//! Linux/x86-64 and macOS/arm64 CI lanes. Never regenerate pins in a test.
use ironhorse_vm::{Halt, Interp, COST_TABLE_VERSION};

#[test]
fn frozen_program_results_and_computrons() {
    let corpus = include_str!("fixtures/computrons.tsv");
    assert!(corpus
        .lines()
        .next()
        .unwrap()
        .starts_with(&format!("# {COST_TABLE_VERSION} ")));
    let mut labels = std::collections::BTreeSet::new();
    for line in corpus.lines().skip(1) {
        let fields: Vec<_> = line.split('\t').collect();
        assert_eq!(fields.len(), 6);
        let (label, source, halt, result) = (fields[0], fields[1], fields[2], fields[3]);
        assert!(labels.insert(label), "duplicate family: {label}");
        let raw: u64 = fields[4].parse().unwrap();
        let computrons: u64 = fields[5].parse().unwrap();
        for repeat in 0..3 {
            let (code, names) = ironhorse_compile::compile_atoms(source).unwrap();
            let mut machine = Interp::new();
            machine.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
            let outcome = machine.run(&code);
            let actual_halt = match &outcome.halt {
                Halt::Return => "return".to_string(),
                Halt::Throw { rendered, .. } => format!("throw:{rendered}"),
                other => panic!("{label} repeat {repeat}: {other:?}"),
            };
            assert_eq!(actual_halt, halt, "{label} repeat {repeat}");
            assert_eq!(outcome.result, result, "{label} repeat {repeat}");
            assert_eq!(machine.meter_index(), raw, "{label} repeat {repeat}");
            assert_eq!(outcome.computrons, computrons, "{label} repeat {repeat}");
        }
    }
    assert_eq!(
        labels.len(),
        52,
        "review family coverage when extending the corpus"
    );
}
