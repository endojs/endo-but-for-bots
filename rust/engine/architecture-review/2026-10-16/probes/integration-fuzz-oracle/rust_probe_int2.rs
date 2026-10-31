// AUDIT PROBE (temporary, integration-fuzz-oracle region). Deleted after use.
//
// (1) What does `compile_differential_check` classify as IronhorseRejected
//     (which the `differential_compile` libFuzzer target IGNORES), and why?
// (2) On every differential surface, how often do BOTH engines abort while
//     disagreeing about WHAT was thrown? `compare_observations` compares only
//     the completion flag on the abort path, so each such case reads as
//     agreement.
use std::collections::{BTreeMap, BTreeSet};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn bytes(&mut self) -> Vec<u8> {
        let len = (self.next() % 257) as usize;
        (0..len).map(|_| self.next() as u8).collect()
    }
}

fn distinct(g: fn(&[u8]) -> String, n: usize) -> BTreeSet<String> {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    (0..n).map(|_| g(&rng.bytes())).collect()
}

fn part1() {
    for (name, g) in [
        ("gen_compile_program", ironhorse_fuzz::gen_compile_program as fn(&[u8]) -> String),
        ("gen_program", ironhorse_fuzz::gen_program),
    ] {
        let progs = distinct(g, 20_000);
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        let mut examples: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for src in progs.iter().take(1500) {
            let outcome = ironhorse_fuzz::compile_differential_check(src);
            let key = match &outcome {
                ironhorse_fuzz::CompileFuzzOutcome::IronhorseRejected { detail } => {
                    let d: String = detail.chars().take(110).collect();
                    let e = examples.entry("IronhorseRejected".into()).or_default();
                    if e.len() < 4 {
                        e.push(format!("{:?}  ->  {d}", &src[..src.len().min(70)]));
                    }
                    "IronhorseRejected".to_string()
                }
                ironhorse_fuzz::CompileFuzzOutcome::ByteDivergence { .. } => "ByteDivergence".into(),
                other => format!("{other:?}"),
            };
            *counts.entry(key).or_default() += 1;
        }
        println!("{name}: {} distinct, first 1500 classified: {counts:?}", progs.len());
        for (k, v) in examples {
            for e in v {
                println!("    {k}: {e}");
            }
        }
    }
}

fn ih_throw(src: &str, oracle: &xs_oracle::OracleOutcome) -> Option<String> {
    let o = ironhorse_vm::run_program_with_symbols(&oracle.bytecode, &oracle.symbols);
    if o.completed {
        return None;
    }
    Some(match &o.halt {
        ironhorse_vm::Halt::Throw { rendered, .. } => rendered.clone(),
        other => format!("<halt {other:?}>"),
    })
    .filter(|_| !src.is_empty())
}

fn part2() {
    let mut gens: Vec<(&str, fn(&[u8]) -> String)> = vec![
        ("gen_program", ironhorse_fuzz::gen_program),
        ("gen_statement_program", ironhorse_fuzz::gen_statement_program),
        ("gen_stage2b_program", ironhorse_fuzz::gen_stage2b_program),
    ];
    for (name, g, _) in ironhorse_fuzz::STAGE3_SURFACES {
        gens.push((name, *g));
    }
    let mut total_both_abort = 0;
    let mut total_mismatch = 0;
    for (name, g) in gens {
        let progs = distinct(g, 20_000);
        let (mut both_abort, mut mismatch, mut ex) = (0, 0, Vec::new());
        for src in progs.iter().take(400) {
            let Some(oracle) = xs_oracle::run(src) else { continue };
            if oracle.completed {
                continue;
            }
            let Some(ih) = ih_throw(src, &oracle) else { continue };
            both_abort += 1;
            if ih != oracle.error {
                mismatch += 1;
                if ex.len() < 2 {
                    ex.push(format!(
                        "{:?}\n        xs: {:?}\n        ih: {:?}\n        differential verdict: {:?}",
                        &src[..src.len().min(90)],
                        oracle.error,
                        ih,
                        ironhorse_fuzz::differential_check_with_symbols(src).map_err(|d| d.detail)
                    ));
                }
            }
        }
        total_both_abort += both_abort;
        total_mismatch += mismatch;
        if both_abort > 0 {
            println!("{name:42} both-abort={both_abort:3}  thrown-value differs={mismatch:3}");
            for e in ex {
                println!("    {e}");
            }
        }
    }
    println!("TOTAL both-abort={total_both_abort} thrown-value differs={total_mismatch}");
}

#[test]
fn probe() {
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(|| {
            part1();
            part2();
        })
        .unwrap()
        .join()
        .unwrap();
}
