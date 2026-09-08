//! Version-2 costs for the forwarding, key collection, and JSON fixtures.
//! Keep oracle result checks at each call site; these pins replace only the
//! obsolete version-1/XS cost expectation.
pub fn assert_raw(source: &str, raw: u64) {
    assert_eq!(ironhorse_vm::COST_TABLE_VERSION, "ironhorse-meter-5");
    let matches: Vec<_> = include_str!("raw.tsv")
        .lines()
        .filter_map(|line| {
            let (value, fixture) = line.split_once('\t').expect("raw<TAB>source fixture");
            (fixture == source).then_some(value)
        })
        .collect();
    assert_eq!(matches.len(), 1, "exactly one version-4 pin for {source}");
    let expected = matches[0].parse::<u64>().expect("raw u64 pin");
    assert_eq!(raw, expected, "version-4 raw meter: {source}");
}
