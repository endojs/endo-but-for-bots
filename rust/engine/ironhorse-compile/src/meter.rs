//! Shared, monotone compilation accounting under the frozen engine cost table.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

pub use ironhorse_meter::COST_TABLE_VERSION as PARSE_METER_RELEASE;
pub use ironhorse_meter::COST_TABLE_VERSION as COMPILE_METER_RELEASE;
pub use ironhorse_meter::PARSE_TOKEN_METERING;

struct State<'a> {
    index: Cell<u64>,
    limit: u64,
    exhausted: Cell<bool>,
    consulting: Cell<bool>,
    charge: RefCell<Option<Box<dyn FnMut(u64) -> bool + 'a>>>,
}

/// Clones retain the same progress across errors and compiler unwinds.
/// Bounded meters enter the compiler through its retained-meter APIs; public
/// token charging returns refusal as data and never leaks a private unwind.
#[derive(Clone)]
pub struct ParseMeter<'a> {
    state: Rc<State<'a>>,
}
impl std::fmt::Debug for ParseMeter<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParseMeter")
            .field("raw", &self.raw())
            .field("exhausted", &self.exhausted())
            .finish()
    }
}
impl Default for ParseMeter<'_> {
    fn default() -> Self {
        Self::new()
    }
}
impl<'a> ParseMeter<'a> {
    pub fn new() -> Self {
        Self::with_budget(u64::MAX)
    }
    pub fn with_budget(raw_budget: u64) -> Self {
        Self {
            state: Rc::new(State {
                index: Cell::new(0),
                limit: raw_budget,
                exhausted: Cell::new(false),
                consulting: Cell::new(false),
                charge: RefCell::new(None),
            }),
        }
    }
    pub fn with_charge_callback(raw_budget: u64, charge: impl FnMut(u64) -> bool + 'a) -> Self {
        let meter = Self::with_budget(raw_budget);
        *meter.state.charge.borrow_mut() = Some(Box::new(charge));
        meter
    }
    fn try_charge(&self, requested: Option<u64>) -> bool {
        if self.exhausted() || self.state.consulting.get() {
            self.state.exhausted.set(true);
            return false;
        }
        let remaining = self.state.limit - self.raw();
        let admitted = requested.is_some_and(|raw| raw <= remaining);
        let delta = requested.unwrap_or(u64::MAX).min(remaining);
        self.state.index.set(self.raw() + delta);
        if !admitted {
            self.state.exhausted.set(true);
        }
        let callback = self.state.charge.borrow_mut().take();
        if let Some(mut callback) = callback {
            self.state.consulting.set(true);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback(delta)));
            self.state.consulting.set(false);
            *self.state.charge.borrow_mut() = Some(callback);
            match result {
                Ok(true) => {}
                Ok(false) => self.state.exhausted.set(true),
                Err(payload) => std::panic::resume_unwind(payload),
            }
        }
        !self.exhausted()
    }
    pub(crate) fn source(&self, bytes: usize) {
        if !self
            .try_charge((bytes as u64).checked_mul(ironhorse_meter::COMPILE_SOURCE_BYTE_METERING))
        {
            refuse();
        }
    }
    pub(crate) fn work(&self, units: usize) {
        if !self.try_charge((units as u64).checked_mul(ironhorse_meter::COMPILE_WORK_METERING)) {
            refuse();
        }
    }
    pub(crate) fn charge_raw(&self, raw: u64) -> bool {
        self.try_charge(Some(raw))
    }
    pub fn charge_token(&self) -> bool {
        self.try_charge(Some(PARSE_TOKEN_METERING))
    }
    pub fn raw(&self) -> u64 {
        self.state.index.get()
    }
    pub fn computrons(&self) -> u64 {
        self.raw() >> 16
    }
    pub fn exhausted(&self) -> bool {
        self.state.exhausted.get()
    }
}

struct Refused;
fn refuse() -> ! {
    std::panic::resume_unwind(Box::new(Refused))
}

pub(crate) fn catch_refusal<T>(run: impl FnOnce() -> T) -> Result<T, ()> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)) {
        Ok(value) => Ok(value),
        Err(payload) if payload.is::<Refused>() => Err(()),
        Err(payload) => std::panic::resume_unwind(payload),
    }
}
#[cfg(test)]
pub(crate) fn budgeted<'a, T>(
    charge: &'a mut dyn FnMut(u64) -> bool,
    run: impl FnOnce(ParseMeter<'a>) -> T,
) -> Result<T, ()> {
    let meter = ParseMeter::with_charge_callback(u64::MAX, charge);
    let progress = meter.clone();
    let result = catch_refusal(|| run(meter));
    if progress.exhausted() {
        Err(())
    } else {
        result
    }
}
pub(crate) fn limit_error() -> crate::parser::ParseError {
    crate::parser::ParseError {
        line: 0,
        kind: crate::parser::ParseErrorKind::MeterLimit,
        message: "compilation meter limit".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_allowance_is_accepted_until_further_work_is_requested() {
        let meter = ParseMeter::with_budget(7);
        assert!(meter.try_charge(Some(7)));
        assert!(!meter.exhausted());
        assert!(!meter.try_charge(Some(1)));
        assert!(!meter.try_charge(Some(0)));
        assert_eq!(meter.raw(), 7);
    }

    #[test]
    fn capped_charge_reports_only_remaining_raw_and_refuses_stickily() {
        let mut deltas = Vec::new();
        let meter = ParseMeter::with_charge_callback(7, |raw| {
            deltas.push(raw);
            true
        });
        assert!(meter.try_charge(Some(3)));
        assert!(!meter.try_charge(Some(9)));
        assert!(!meter.charge_token());
        assert_eq!(meter.raw(), 7);
        drop(meter);
        assert_eq!(deltas, [3, 4]);
    }

    #[test]
    fn unrepresentable_reservation_refuses_even_with_max_allowance() {
        let meter = ParseMeter::with_budget(u64::MAX);
        assert!(!meter.try_charge(None));
        assert!(meter.exhausted());
        assert_eq!(meter.raw(), u64::MAX);
    }

    #[test]
    fn reentrant_callback_cannot_bypass_host_admission() {
        let saved = Rc::new(RefCell::new(None::<ParseMeter<'_>>));
        let inner = saved.clone();
        let meter = ParseMeter::with_charge_callback(u64::MAX, move |_| {
            assert!(!inner.borrow().as_ref().unwrap().charge_token());
            true
        });
        *saved.borrow_mut() = Some(meter.clone());
        assert!(!meter.charge_token());
        assert_eq!(meter.raw(), PARSE_TOKEN_METERING);
        // Break the test's intentional callback/progress cycle.
        saved.borrow_mut().take();
    }

    #[test]
    fn callback_panic_retains_progress_and_restores_callback_state() {
        let mut calls = 0;
        let meter = ParseMeter::with_charge_callback(u64::MAX, |_| {
            calls += 1;
            assert!(calls != 1, "host panic");
            true
        });
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| meter.charge_token()))
                .is_err()
        );
        assert_eq!(meter.raw(), PARSE_TOKEN_METERING);
        assert!(meter.charge_token());
        assert_eq!(meter.raw(), PARSE_TOKEN_METERING * 2);
    }
}
