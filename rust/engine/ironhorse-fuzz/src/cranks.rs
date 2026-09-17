//! The **multi-crank differential** fuzz arm.
//!
//! [`ironhorse_262::dual_run_cranks`] is the harness's only window onto
//! cross-crank semantics — state one crank creates and a *later* crank
//! observes, on one live machine per engine, with ironhorse relinking each
//! crank's oracle-emitted bytecode through the managed-lifecycle path. The
//! wave-6 retrospective identified the single-crank oracle as the structural
//! cause of a whole family of missed defects, and its live specimen (an error
//! constructor's own `message`, compiled by one crank and read by another) is
//! invisible to every single-crank test.
//!
//! The response to that retrospective was a file of hand-written scenarios.
//! Hand-written scenarios are *cases*; the single-crank path has a generator,
//! a corpus and a libFuzzer lane, and multi-crank coverage did not scale with
//! it (F041). This module is the generalization: it folds fuzzer bytes into a
//! crank **sequence** rather than a program, so the multi-crank differential
//! searches like the single-crank one does.
//!
//! The generator is deliberately *reference-bearing*. A sequence of unrelated
//! programs run on one machine is barely more than n single-crank runs; what
//! makes a sequence worth running is that later cranks read names, functions,
//! closures and objects that earlier cranks defined. Every sequence therefore
//! carries at least one definition crank, and observation cranks only cite
//! names a previous crank actually bound.

use ironhorse_262::{dual_run_cranks, Agreement};

use crate::{
    comparison::results_agree, gen_program, gen_stage2b_program, gen_stage3_arrays_program,
};

/// A per-crank divergence between ironhorse and the XS oracle.
#[derive(Debug)]
pub struct CrankDivergence {
    /// Which crank of the sequence diverged.
    pub crank: usize,
    /// The whole sequence, so a trophy reproduces without the seed.
    pub sequence: Vec<String>,
    pub detail: String,
}

/// The largest sequence the generator emits. Each crank is a full
/// machine-resident run on both engines, so the bound is a budget decision:
/// long enough that a definition crank and several observers fit, short
/// enough that a libFuzzer iteration stays cheap.
const MAX_CRANKS: usize = 6;

/// The `n`th byte of `slice`, or zero. Used to steer a choice from the
/// input rather than from a property of the input's length.
fn pick(slice: &[u8], n: usize) -> usize {
    slice.get(n).copied().unwrap_or(0) as usize
}

/// Fold fuzzer bytes into a sequence of cranks for one machine.
///
/// The first crank always *defines* something, and later cranks may observe
/// what earlier ones bound, so the sequence exercises the cross-crank seam
/// rather than being n unrelated programs that happen to share a machine.
pub fn gen_crank_sequence(data: &[u8]) -> Vec<String> {
    if data.is_empty() {
        return Vec::new();
    }
    let n = 2 + (data[0] as usize % (MAX_CRANKS - 1));
    let body = &data[1..];
    // Give each crank its own slice of the input, so a libFuzzer edit to one
    // region perturbs one crank rather than reshuffling the whole sequence.
    let width = (body.len() / n).max(1);

    let mut sequence = Vec::with_capacity(n);
    // Names a previous crank actually bound, so an observation crank never
    // cites an undefined one (which would make every sequence a shared
    // ReferenceError and hide everything behind it).
    let mut values: Vec<String> = Vec::new();
    let mut functions: Vec<String> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    for i in 0..n {
        let start = (i * width).min(body.len());
        let end = ((i + 1) * width).min(body.len());
        let slice = &body[start..end];
        let shape = slice.first().copied().unwrap_or(0);
        // Crank 0 must define, so there is something for later cranks to see.
        let arm = if i == 0 { shape % 3 } else { shape % 7 };
        let crank = match arm {
            // --- definition cranks ---
            0 => {
                let name = format!("v{i}");
                let program = format!("var {name} = ({}); {name}", gen_program(slice));
                values.push(name);
                program
            }
            1 => {
                let name = format!("f{i}");
                // A closure over a crank-local binding: the defining crank's
                // bytecode has to be retained for a later crank to call it.
                let program = format!(
                    "var c{i} = ({}); function {name}(a) {{ return a + c{i}; }} {name}(1)",
                    gen_program(slice)
                );
                functions.push(name);
                program
            }
            2 => {
                let name = format!("e{i}");
                // The wave-6 live specimen's exact shape: an error
                // constructed in one crank whose own `message` a later crank
                // reads. The constructing crank never compiles the name.
                let program = format!("var {name} = new TypeError('boom{i}'); typeof {name}");
                errors.push(name);
                program
            }
            // --- observation cranks, only over names already bound ---
            3 if !values.is_empty() => {
                // Draw the target from the INPUT, not from `slice.len()`:
                // the slice width is the same constant for every crank but
                // the last, so a length-derived index always picked the same
                // binding and the fuzzer could not steer which earlier crank
                // is observed.
                let name = &values[pick(slice, 1) % values.len()];
                format!("{name} + 0")
            }
            4 if !functions.is_empty() => {
                let name = &functions[pick(slice, 1) % functions.len()];
                format!("{name}({})", gen_program(slice))
            }
            5 if !errors.is_empty() => {
                let name = &errors[pick(slice, 1) % errors.len()];
                // Reading `.message` and `.name` from a later crank is the
                // specimen; `String(e)` exercises the same seam through
                // `toString`.
                match shape % 3 {
                    0 => format!("{name}.message"),
                    1 => format!("{name}.name"),
                    _ => format!("String({name})"),
                }
            }
            // --- plain cranks, for sequences that also carry ordinary work ---
            _ => match shape % 3 {
                0 => gen_stage2b_program(slice),
                1 => gen_stage3_arrays_program(slice),
                _ => gen_program(slice),
            },
        };
        sequence.push(crank);
    }
    sequence
}

/// Run a crank sequence on one live machine per engine and compare per crank.
///
/// The bar is the one [`crate::differential_check`] holds for a single crank,
/// applied to every crank of the sequence: the engines agree on whether the
/// crank completed, on the completion value when both did, and on the thrown
/// value when both aborted. Computrons are *not* compared here — the
/// generator reaches allocating surfaces whose fractional metering is pinned
/// against the engine's own release ledger rather than against XS, the same
/// division [`crate::differential_check_result_only`] makes.
pub fn differential_check_cranks(sequence: &[String]) -> Result<usize, CrankDivergence> {
    if sequence.is_empty() {
        return Ok(0);
    }
    let borrowed: Vec<&str> = sequence.iter().map(String::as_str).collect();
    // `None` means the oracle machine itself failed to start, which is a
    // harness condition rather than a divergence.
    let Some(runs) = dual_run_cranks(&borrowed) else {
        // The oracle machine failed to start: a harness condition, not a
        // divergence, and zero cranks compared. A caller that counts
        // non-divergences as agreements would count this as one, which is
        // why the count comes back rather than a bare `()`.
        return Ok(0);
    };
    for (i, run) in runs.iter().enumerate() {
        let detail = match run.agreement {
            // Use the same exact-double rendering policy as the single-crank
            // fuzzer. DualRun's raw string comparison also reports known XS
            // dtoa spelling differences; it is not a numeric value mismatch.
            Agreement::BothComplete
                if !results_agree(&run.oracle_result, &run.ironhorse_result) =>
            {
                Some(format!(
                    "crank result divergence: oracle {:?} against ironhorse {:?}",
                    run.oracle_result, run.ironhorse_result
                ))
            }
            Agreement::BothAbort if !run.error_agrees => Some(format!(
                "crank abort divergence: oracle {:?} against ironhorse {:?} ({:?})",
                run.oracle_error, run.ironhorse_error, run.ironhorse_halt
            )),
            Agreement::IronhorseOnlyComplete => Some(format!(
                "ironhorse completed a crank the oracle aborted: {:?}",
                run.oracle_error
            )),
            Agreement::OracleOnlyComplete => Some(format!(
                "ironhorse aborted a crank the oracle completed: {:?}",
                run.ironhorse_halt
            )),
            _ => None,
        };
        if let Some(detail) = detail {
            return Err(CrankDivergence {
                crank: i,
                sequence: sequence.to_vec(),
                detail,
            });
        }
    }
    // How many cranks actually ran. `dual_run_cranks` stops at the first
    // crank either engine fails to complete, so this can be short of the
    // sequence; a caller that wants to know its multi-crank coverage did not
    // collapse has to measure it rather than assume it.
    Ok(runs.len())
}

/// The libFuzzer target body: generate a crank sequence and hold the
/// per-crank differential over it.
pub fn crank_sequence_differential_is_clean(data: &[u8]) -> Result<usize, CrankDivergence> {
    differential_check_cranks(&gen_crank_sequence(data))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn finding_3bb7e699_multi_crank_number_rendering_agrees() {
        // PR #1302's CI input (crash-3bb7e6991dcd74161f22920b2311a4e9e336e7e3).
        // Preserve the input as well as the reduced, generator-independent
        // sequence: crank 4 calls a function retained from crank 0 and yields
        // 0x4370740000000000. XS renders that as 74098287619080190;
        // IronHorse's shortest round-trip spelling is 74098287619080200.
        let input = [
            234, 94, 130, 218, 102, 218, 254, 86, 226, 86, 122, 210, 94, 47, 9, 177, 48, 207, 207,
            207, 234, 94, 130, 218, 102, 218, 254, 86, 226, 86, 122, 210, 94, 210, 246, 78, 218,
            78, 114, 202, 86, 202, 238, 217, 217, 217, 217, 217, 217, 217, 217, 217, 217, 217, 217,
            76, 76, 76, 76, 76, 76, 76, 76, 76, 76, 217, 217, 217, 217, 217, 186, 70, 186, 222, 55,
            194, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207,
            207, 207, 207, 54, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207, 207,
            207, 207, 207, 207, 207, 90,
        ];
        let reduced = vec![
            "function f(a){return a;} f(0)".to_string(),
            "f(377487360 / (377487360 / (377487360 / (5 / 981467136))))".to_string(),
        ];
        for sequence in [reduced, gen_crank_sequence(&input)] {
            assert_eq!(
                differential_check_cranks(&sequence).expect("same double must agree"),
                sequence.len(),
                "every crank must actually run"
            );
        }
    }

    fn seed_bytes(seed: u32, salt: u8) -> Vec<u8> {
        let s = seed.to_le_bytes();
        let mut buf = Vec::new();
        for k in 0..(48 + (seed % 96)) {
            buf.push(
                s[(k as usize) % 4]
                    .wrapping_add((k as u8).wrapping_mul(29))
                    .wrapping_add((seed as u8).wrapping_mul(salt)),
            );
        }
        buf
    }

    /// The deterministic sweep that stands in for the libFuzzer lane in
    /// ordinary CI: the same body the target calls, over a fixed seed
    /// spread, so a cross-crank regression fails `cargo test` without a
    /// nightly toolchain.
    #[test]
    fn crank_sequences_agree_with_the_oracle() {
        // Count the cranks the ORACLE ran, not the sequences that failed to
        // diverge. `differential_check_cranks` returns `Ok` when the oracle
        // machine cannot start, so counting non-divergences would read a
        // missing `c/moddable` checkout as 150 agreements.
        let mut compared = 0usize;
        let mut offered = 0usize;
        for seed in 0..150u32 {
            let sequence = gen_crank_sequence(&seed_bytes(seed, 17));
            offered += sequence.len();
            match differential_check_cranks(&sequence) {
                Ok(ran) => compared += ran,
                Err(d) => panic!("seed {seed}: {d:?}"),
            }
        }
        assert!(
            compared * 10 > offered * 9,
            "only {compared} of {offered} generated cranks reached a \
             comparison; sequences are being truncated, or the oracle is not \
             running at all"
        );
    }

    /// The sweep must be real coverage rather than the same sequence 150
    /// times, and it must actually reach the cross-crank seam: a sequence of
    /// unrelated programs would not be worth the machine.
    #[test]
    fn the_sweep_is_varied_and_reference_bearing() {
        let mut distinct = BTreeSet::new();
        let mut lengths = BTreeSet::new();
        let mut observes_value = false;
        let mut observes_function = false;
        let mut observes_error = false;
        for seed in 0..150u32 {
            let sequence = gen_crank_sequence(&seed_bytes(seed, 17));
            lengths.insert(sequence.len());
            for (i, crank) in sequence.iter().enumerate() {
                if i > 0 {
                    // Anchored on the exact shapes the observation arms emit,
                    // so an unrelated generated crank cannot satisfy the
                    // witness by coincidence. `f{n}(` with a leading `f` and
                    // a digit is the call arm; a bare `gen_stage2b_program`
                    // crank does not start that way.
                    observes_value |= crank.ends_with(" + 0");
                    observes_function |= crank.starts_with('f')
                        && crank[1..].starts_with(|c: char| c.is_ascii_digit())
                        && crank.contains('(');
                    observes_error |= crank.ends_with(".message")
                        || crank.ends_with(".name")
                        || (crank.starts_with("String(e") && crank.ends_with(')'));
                }
            }
            distinct.insert(sequence);
        }
        assert!(
            distinct.len() > 100,
            "crank sweep too uniform: {} distinct",
            distinct.len()
        );
        assert!(lengths.len() > 1, "every sequence is the same length");
        assert!(observes_value, "no crank observes an earlier value binding");
        assert!(
            observes_function,
            "no crank calls a function an earlier crank defined"
        );
        assert!(
            observes_error,
            "no crank reads an error an earlier crank constructed"
        );
    }

    /// The degenerate inputs libFuzzer starts from.
    #[test]
    fn degenerate_input_generates_a_runnable_sequence() {
        assert!(gen_crank_sequence(b"").is_empty());
        for data in [b"\0".as_slice(), b"\xff".as_slice(), &[0x41; 8]] {
            let sequence = gen_crank_sequence(data);
            assert!(sequence.len() >= 2, "a sequence is at least two cranks");
            let ran =
                differential_check_cranks(&sequence).expect("degenerate sequences must agree");
            assert!(ran > 0, "a degenerate sequence must still reach the oracle");
        }
    }
}
