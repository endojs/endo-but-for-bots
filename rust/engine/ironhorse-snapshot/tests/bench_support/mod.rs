//! Machine-readable measurements for `benches/run.py`.
//! Standalone invocations still print measurements; the runner supplies baselines.
pub fn report(name: &str, value: f64) {
    assert!(
        value.is_finite() && value > 0.0,
        "invalid measurement: {name}"
    );
    println!("\nBENCH_METRIC {name} {value:.9}");
    if let Ok(raw) = std::env::var(format!("IRONHORSE_BASELINE_{name}")) {
        let baseline: f64 = raw.parse().expect("numeric baseline");
        assert!(baseline.is_finite() && baseline > 0.0);
        println!("BENCH_RATIO {name} {:.6}", value / baseline);
    }
}
