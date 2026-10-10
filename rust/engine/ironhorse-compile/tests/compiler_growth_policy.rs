#[path = "common/compiler_growth.rs"]
mod compiler_growth;
const ROSTER: [usize; 4] = [4000, 8000, 16000, 32000];

#[test]
fn approximately_linear_shapes_pass() {
    for time in [
        |n: usize| n as f64,
        |n: usize| 10000.0 + n as f64,
        |n: usize| n as f64 * if n >= 16000 { 1.5 } else { 1.0 },
        |n: usize| n as f64 * (n as f64).log2(),
    ] {
        let samples: Vec<_> = ROSTER.into_iter().map(|n| (n, time(n))).collect();
        let growth = compiler_growth::check(&ROSTER, &samples).unwrap();
        assert!(growth.full_ratio < growth.limit);
    }
}

#[test]
fn superlinear_powers_and_exact_boundary_fail() {
    for exponent in [1.5, 2.0] {
        let samples: Vec<_> = ROSTER
            .into_iter()
            .map(|n| (n, (n as f64).powf(exponent)))
            .collect();
        assert!(compiler_growth::check(&ROSTER, &samples).is_err());
    }
    let boundary = [(4000, 1.0), (8000, 2.5), (16000, 6.25), (32000, 15.625)];
    assert!(compiler_growth::check(&ROSTER, &boundary).is_err());
}

#[test]
fn incomplete_duplicate_unordered_and_invalid_samples_fail() {
    let good: Vec<_> = ROSTER.into_iter().map(|n| (n, n as f64)).collect();
    assert!(compiler_growth::check(&ROSTER, &good[..3]).is_err());
    let mut extra = good.clone();
    extra.push((64000, 64000.0));
    assert!(compiler_growth::check(&ROSTER, &extra).is_err());
    for n in [8000, 64000] {
        let mut bad = good.clone();
        bad[2].0 = n;
        assert!(compiler_growth::check(&ROSTER, &bad).is_err());
    }
    let mut reversed = good.clone();
    reversed.swap(0, 1);
    assert!(compiler_growth::check(&ROSTER, &reversed).is_err());
    for invalid in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        for at in 0..good.len() {
            let mut bad = good.clone();
            bad[at].1 = invalid;
            assert!(compiler_growth::check(&ROSTER, &bad).is_err());
        }
    }
    for roster in [&[][..], &[0, 0][..], &[1, 1][..], &[2, 1][..], &[1, 3][..]] {
        assert!(compiler_growth::check(roster, &[]).is_err());
    }
}
