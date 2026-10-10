//! Release-selected Math provider, also used by numeric exponentiation.
//! Software libm avoids architecture-specific provider routines. IEEE basic
//! arithmetic and correctly rounded sqrt remain the language's f64 operations.

/// Execution Math provider identity. Platform builds only promise identity
/// within a release binary/platform; the pure-Rust provider carries the
/// cross-host configuration. Snapshots distinguish the two configurations.
#[cfg(feature = "deterministic-math")]
pub const MATH_PROVIDER: &str = "libm-0.2.16-soft";
#[cfg(not(feature = "deterministic-math"))]
pub const MATH_PROVIDER: &str = "platform";

#[cfg(feature = "deterministic-math")]
pub(crate) use libm::{
    acos, acosh, asin, asinh, atan, atan2, atanh, cbrt, cos, cosh, exp, expm1, hypot, log, log10,
    log1p, log2, pow, sin, sinh, tan, tanh,
};

#[cfg(not(feature = "deterministic-math"))]
mod platform {
    pub(crate) fn acos(x: f64) -> f64 {
        x.acos()
    }
    pub(crate) fn acosh(x: f64) -> f64 {
        x.acosh()
    }
    pub(crate) fn asin(x: f64) -> f64 {
        x.asin()
    }
    pub(crate) fn asinh(x: f64) -> f64 {
        x.asinh()
    }
    pub(crate) fn atan(x: f64) -> f64 {
        x.atan()
    }
    pub(crate) fn atanh(x: f64) -> f64 {
        x.atanh()
    }
    pub(crate) fn cbrt(x: f64) -> f64 {
        x.cbrt()
    }
    pub(crate) fn cos(x: f64) -> f64 {
        x.cos()
    }
    pub(crate) fn cosh(x: f64) -> f64 {
        x.cosh()
    }
    pub(crate) fn exp(x: f64) -> f64 {
        x.exp()
    }
    pub(crate) fn expm1(x: f64) -> f64 {
        x.exp_m1()
    }
    pub(crate) fn log(x: f64) -> f64 {
        x.ln()
    }
    pub(crate) fn log1p(x: f64) -> f64 {
        x.ln_1p()
    }
    pub(crate) fn log10(x: f64) -> f64 {
        x.log10()
    }
    pub(crate) fn log2(x: f64) -> f64 {
        x.log2()
    }
    pub(crate) fn sin(x: f64) -> f64 {
        x.sin()
    }
    pub(crate) fn sinh(x: f64) -> f64 {
        x.sinh()
    }
    pub(crate) fn tan(x: f64) -> f64 {
        x.tan()
    }
    pub(crate) fn tanh(x: f64) -> f64 {
        x.tanh()
    }
    pub(crate) fn atan2(x: f64, y: f64) -> f64 {
        x.atan2(y)
    }
    pub(crate) fn pow(x: f64, y: f64) -> f64 {
        x.powf(y)
    }
    pub(crate) fn hypot(x: f64, y: f64) -> f64 {
        x.hypot(y)
    }
}
#[cfg(not(feature = "deterministic-math"))]
pub(crate) use platform::*;
