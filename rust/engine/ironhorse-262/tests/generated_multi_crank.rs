//! Deterministic multi-crank comparison over every converted corpus program.
//! Each case gets fresh machines, then runs twice in the retained realm.
use ironhorse_262::{compile_diff::corpora_programs, dual_run_cranks, Agreement};

#[test]
fn converted_corpus_runs_as_crank_sequences() {
    let programs = corpora_programs();
    assert!(programs.len() >= 1700, "converted corpus must be present");
    let marker = "__ironhorse_sequence_witness";
    let setup = format!("var {marker} = {{n: 73}}; 0");
    let observation = format!("{marker}.n");
    let mut failures = Vec::new();
    let mut comparisons = 0;
    let mut continued = 0;
    for (id, source) in &programs {
        assert!(!source.contains(marker), "witness name collides: {id}");
        let sources = [&*setup, source.as_str(), source.as_str(), &*observation];
        let runs = dual_run_cranks(&sources).expect("XS reference must start");
        assert!(runs.len() >= 2, "corpus crank must run: {id}");
        comparisons += runs.len();
        for (i, run) in runs.iter().enumerate() {
            if !run.observables_agree() {
                failures.push(format!("{id} crank {i}: {run:?}"));
            }
        }
        if runs.last().unwrap().agreement == Agreement::BothComplete {
            assert_eq!(runs.len(), sources.len(), "truncated sequence: {id}");
            assert_eq!(runs.last().unwrap().ironhorse_result, "73", "{id}");
            continued += 1;
        }
    }
    eprintln!(
        "{} programs, {comparisons} comparisons, {continued} final observations",
        programs.len()
    );
    assert!(
        continued > 1000,
        "continuation coverage unexpectedly collapsed"
    );
    assert!(
        failures.is_empty(),
        "{} disagreements:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
