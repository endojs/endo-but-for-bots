// AUDIT PROBE (temporary, integration-fuzz-oracle region). Deleted after use.
// Per differential surface: does the SHIPPED compiler (ironhorse-compile,
// eval goal = the oracle's goal) emit the same bytes the fuzz targets feed the
// VM (XS's)? Where it does not, the behavioural differential is exercising a
// bytecode stream the shipped pipeline never produces. Also: does running the
// SHIPPED bytes on the VM give the same result as XS?
use std::collections::BTreeSet;
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn bytes(&mut self) -> Vec<u8> { let len = (self.next() % 257) as usize; (0..len).map(|_| self.next() as u8).collect() }
}
#[test]
fn probe() {
    std::thread::Builder::new().stack_size(64 << 20).spawn(|| {
        let mut gens: Vec<(&str, fn(&[u8]) -> String)> = vec![
            ("gen_program", ironhorse_fuzz::gen_program),
            ("gen_statement_program", ironhorse_fuzz::gen_statement_program),
            ("gen_stage2b_program", ironhorse_fuzz::gen_stage2b_program),
        ];
        for (name, g, _) in ironhorse_fuzz::STAGE3_SURFACES { gens.push((name, *g)); }
        let (mut tot, mut tot_same, mut tot_beh) = (0, 0, 0);
        for (name, g) in gens {
            let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
            let progs: BTreeSet<String> = (0..20_000).map(|_| g(&rng.bytes())).collect();
            let (mut n, mut same, mut differ, mut reject, mut beh_diff, mut ex) = (0, 0, 0, 0, 0, None);
            for src in progs.iter().take(200) {
                let Some(oracle) = xs_oracle::run(src) else { continue };
                if oracle.bytecode.is_empty() { continue; }
                n += 1;
                match ironhorse_compile::compile_atoms_with(src, false) {
                    Ok((code, symbols)) => {
                        if code == oracle.bytecode { same += 1 } else {
                            differ += 1;
                            let own = ironhorse_vm::run_program_with_symbols(&code, &symbols);
                            if own.completed != oracle.completed || (oracle.completed && own.result != oracle.result) {
                                beh_diff += 1;
                                if ex.is_none() { ex = Some(format!("{:?}: xs={:?} shipped-pipeline={:?}/{:?}", &src[..src.len().min(80)], oracle.result, own.result, own.halt)); }
                            }
                        }
                    }
                    Err(_) => reject += 1,
                }
            }
            tot += n; tot_same += same; tot_beh += beh_diff;
            println!("{name:42} n={n:3} byte-identical={same:3} bytes-differ={differ:3} ih-reject={reject:2} shipped-pipeline-result-differs={beh_diff:2}");
            if let Some(e) = ex { println!("      e.g. {e}"); }
        }
        println!("TOTAL n={tot} byte-identical={tot_same} shipped-pipeline-result-differs={tot_beh}");
    }).unwrap().join().unwrap();
}
