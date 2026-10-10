//! C7: exact, bounded divergence inventory for the 30 existing Math specimens.
//! Preserve their platform assertions. No harness-wide skip or epsilon is added.
use ironhorse_vm::{parse_symbols, Interp, MATH_PROVIDER};
use std::{collections::BTreeMap, path::Path};

#[test]
fn original_corpus_assertions_have_only_the_recorded_provider_divergences() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/test262-runner/test262/test/ironhorse/built-ins/stage3-math");
    let names: Vec<_> = include_str!("fixtures/math-known.tsv")
        .lines()
        .filter(|line| !line.starts_with('#'))
        .map(|line| format!("Math.{}(", line.split('\t').next().unwrap()))
        .collect();
    let cases: BTreeMap<_, _> = std::fs::read_dir(root)
        .unwrap()
        .map(|entry| {
            let entry = entry.unwrap();
            (
                entry.file_name().into_string().unwrap(),
                std::fs::read_to_string(entry.path()).unwrap(),
            )
        })
        .filter(|(_, source)| names.iter().any(|name| source.contains(name)))
        .collect();
    let expected: BTreeMap<_, _> = include_str!("fixtures/math-corpus-libm.tsv")
        .lines()
        .filter(|line| !line.starts_with('#'))
        .map(|line| line.split_once('\t').unwrap())
        .collect();
    assert_eq!(cases.len(), 30);
    assert_eq!(
        cases.keys().map(String::as_str).collect::<Vec<_>>(),
        expected.keys().copied().collect::<Vec<_>>()
    );
    for (name, source) in cases {
        // Keep the original assertion expression. Record exact numeric
        // disagreement instead of throwing its generic assertion exception.
        // A boolean/range assertion failure remains an unaccepted failure.
        let script = format!(
            r#"
            var observation = 'pass';
            var assertionCount = 0;
            var assert = {{sameValue(actual, expected) {{
                assertionCount++;
                if (!Object.is(actual, expected)) {{
                    if (typeof actual !== 'number' || typeof expected !== 'number') {{
                        observation = 'non-numeric assertion failure'; return;
                    }}
                    var d = new DataView(new ArrayBuffer(8));
                    d.setFloat64(0, actual);
                    observation = d.getUint32(0) + ',' + d.getUint32(4);
                    d.setFloat64(0, expected);
                    observation += ',' + d.getUint32(0) + ',' + d.getUint32(4);
                }}
            }}}};
            {source}
            assertionCount === 1 ? observation : 'unexpected assertion count'
        "#
        );
        let (code, symbols) = ironhorse_compile::compile_atoms(&script).unwrap();
        let mut vm = Interp::new();
        vm.link_intrinsics(&parse_symbols(&symbols));
        let outcome = vm.run(&code);
        assert!(outcome.completed, "{name}: {:?}", outcome.halt);
        let want = if MATH_PROVIDER == "platform" {
            "pass"
        } else {
            expected[name.as_str()]
        };
        let got = if outcome.result.contains(',') {
            let words: Vec<u64> = outcome
                .result
                .split(',')
                .map(|w| w.parse().unwrap())
                .collect();
            assert_eq!(words.len(), 4);
            format!(
                "{:016x}:{:016x}",
                (words[0] << 32) | words[1],
                (words[2] << 32) | words[3]
            )
        } else {
            outcome.result
        };
        assert_eq!(got, want, "{name}: {MATH_PROVIDER}");
    }
}
