//! Literal release vectors, shared unchanged by debug/release and both CI hosts.
use ironhorse_compile::{compile_atoms_budgeted, compile_atoms_with, parse_computrons, Goal};

#[test]
fn frozen_lexical_and_compilation_computrons() {
    assert_eq!(ironhorse_meter::COST_TABLE_VERSION, "ironhorse-meter-5");
    let corpus = include_str!("fixtures/computrons.tsv");
    assert!(corpus.starts_with("# ironhorse-meter-5 "));
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

#[test]
#[ignore = "regenerates compiler charges after a reviewed meter policy change"]
fn regenerate_compilation_charges() {
    let corpus = include_str!("fixtures/computrons.tsv");
    let mut lines = corpus.lines();
    let mut output = format!("{}\n", lines.next().unwrap());
    for line in lines {
        let mut fields: Vec<String> = line.split('\t').map(str::to_owned).collect();
        assert_eq!(fields.len(), 4);
        assert_eq!(
            parse_computrons(&fields[0], false),
            Some(fields[1].parse().unwrap())
        );
        let compiled =
            compile_atoms_budgeted(&fields[0], Goal::Eval, false, &mut |_| true).unwrap();
        fields[2] = compiled.parse_meter_raw.to_string();
        fields[3] = compiled.parse_computrons.to_string();
        output.push_str(&fields.join("\t"));
        output.push('\n');
    }
    std::fs::write(
        concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/computrons.tsv"),
        output,
    )
    .unwrap();
}
