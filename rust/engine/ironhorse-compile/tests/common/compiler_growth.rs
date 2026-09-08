//! Compiler elapsed-time policy: geometric mean across the entire fixed roster.
//! This deliberately relaxes sensitivity to individual cache-boundary steps.
//! Adjacent ratios remain diagnostic; metering keeps its separate adjacent gate.
#[derive(Debug)]
pub struct Growth {
    pub full_ratio: f64,
    pub limit: f64,
}

pub fn check(expected: &[usize], samples: &[(usize, f64)]) -> Result<Growth, String> {
    if expected.len() < 2
        || expected[0] == 0
        || !expected
            .windows(2)
            .all(|pair| pair[0].checked_mul(2) == Some(pair[1]))
    {
        return Err("expected roster must contain ordered positive doublings".into());
    }
    if samples.len() != expected.len()
        || samples
            .iter()
            .zip(expected)
            .any(|((n, seconds), expected_n)| {
                n != expected_n || !seconds.is_finite() || *seconds <= 0.0
            })
    {
        return Err(
            "samples must match the complete fixed roster with positive finite times".into(),
        );
    }
    // Exact roster validation makes this log2(last_n / first_n) without
    // rounding the integer sizes or accepting missing intermediate samples.
    let doublings = expected.len() - 1;
    let full_ratio = samples.last().unwrap().1 / samples[0].1;
    let limit = 2.5_f64.powi(doublings as i32);
    if !full_ratio.is_finite() || full_ratio >= limit {
        return Err(format!(
            "full-range elapsed growth {full_ratio:.6}x must be <{limit:.6}x across {doublings} doublings"
        ));
    }
    Ok(Growth { full_ratio, limit })
}
