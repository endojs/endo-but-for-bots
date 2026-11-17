// AUDIT PROBE (temporary), round 2: (a) which generated programs the shipped
// compiler rejects although XS accepts them; (b) whether running IronHorse's
// OWN bytecode (ironhorse_262::dual_run, Compiler::Ironhorse) agrees with XS on
// every fuzz surface, where the fuzz targets only ever run the ORACLE's bytes.
use std::collections::BTreeSet;

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

#[test]
fn probe() {
    let mut gens: Vec<(&str, fn(&[u8]) -> String)> = vec![
        ("gen_program", ironhorse_fuzz::gen_program),
        ("gen_compile_program", ironhorse_fuzz::gen_compile_program),
        ("gen_stage2b_program", ironhorse_fuzz::gen_stage2b_program),
    ];
    for (name, g, _) in ironhorse_fuzz::STAGE3_SURFACES {
        gens.push((name, *g));
    }
    for (name, g) in gens {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        let mut distinct = BTreeSet::new();
        for _ in 0..20_000 {
            distinct.insert(g(&rng.bytes()));
        }
        let (mut agree, mut differ, mut reject_examples) = (0, 0, Vec::new());
        let mut examples = Vec::new();
        for src in distinct.iter().take(200) {
            if let Err(e) = ironhorse_compile::compile_atoms_with(src, false) {
                if reject_examples.len() < 2 {
                    reject_examples.push(format!("{:?} -> {}", &src[..src.len().min(80)], e));
                }
            }
            let Some(own) = ironhorse_262::dual_run(src) else { continue };
            let Some(oracle_bytes) =
                ironhorse_262::dual_run_with(src, ironhorse_262::Compiler::Oracle)
            else {
                continue;
            };
            let same = own.agreement == oracle_bytes.agreement
                && own.ironhorse_result == oracle_bytes.ironhorse_result
                && own.ironhorse_error == oracle_bytes.ironhorse_error;
            if same {
                agree += 1
            } else {
                differ += 1;
                if examples.len() < 2 {
                    examples.push(format!(
                        "{:?}: own={:?}/{:?}/{:?} oracle-bytes={:?}/{:?}/{:?} xs={:?}",
                        &src[..src.len().min(80)],
                        own.agreement,
                        own.ironhorse_result,
                        own.ironhorse_error,
                        oracle_bytes.agreement,
                        oracle_bytes.ironhorse_result,
                        oracle_bytes.ironhorse_error,
                        own.oracle_result
                    ));
                }
            }
        }
        println!("{name:45} own-vs-oracle-bytes same={agree:3} differ={differ:3}");
        for e in reject_examples {
            println!("    ih-compile-reject: {e}");
        }
        for e in examples {
            println!("    behaviour-differs: {e}");
        }
    }
}
