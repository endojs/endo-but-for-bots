//! One frozen compilation counter shared by every front-end phase.
//! Charges are raw 16.16 deltas, including failed compilation work.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

pub use ironhorse_meter::COST_TABLE_VERSION as PARSE_METER_RELEASE;
pub use ironhorse_meter::PARSE_TOKEN_METERING;

struct State<'a> {
    index: Cell<u64>,
    charge: RefCell<Option<&'a mut dyn FnMut(u64) -> bool>>,
}

/// A monotone compilation counter. Clones share the same compilation's cost.
/// Public constructors are unlimited; callback-bearing meters are confined to
/// `budgeted`, so the private refusal unwind cannot escape into a lexer caller.
#[derive(Clone)]
pub struct ParseMeter<'a> {
    state: Rc<State<'a>>,
}

impl std::fmt::Debug for ParseMeter<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ParseMeter")
            .field("index", &self.raw())
            .finish()
    }
}

impl Default for ParseMeter<'_> {
    fn default() -> Self {
        Self::new()
    }
}

impl<'a> ParseMeter<'a> {
    /// An unlimited zeroed counter.
    pub fn new() -> Self {
        Self {
            state: Rc::new(State {
                index: Cell::new(0),
                charge: RefCell::new(None),
            }),
        }
    }

    pub(crate) fn charge(&self, raw: u64) {
        self.state.index.set(self.raw().saturating_add(raw));
        // Take the callback out before calling user code. No RefCell borrow
        // survives the callback or a refusal unwind.
        let callback = self.state.charge.borrow_mut().take();
        if let Some(callback) = callback {
            let admitted = callback(raw);
            *self.state.charge.borrow_mut() = Some(callback);
            if !admitted {
                std::panic::resume_unwind(Box::new(Refused));
            }
        }
    }

    pub(crate) fn work(&self, units: usize) {
        self.charge((units as u64).saturating_mul(ironhorse_meter::COMPILE_WORK_METERING));
    }

    /// Charge a scanned token, including EOF.
    pub fn charge_token(&self) {
        self.charge(PARSE_TOKEN_METERING);
    }
    /// Raw 16.16 cost, including all phases that shared this meter.
    pub fn raw(&self) -> u64 {
        self.state.index.get()
    }
    /// Whole computrons.
    pub fn computrons(&self) -> u64 {
        self.raw() >> 16
    }
}

// The infallible coder has deeply nested loops. This private unwind stops them
// immediately without invoking the panic hook. Any future internal panic
// catcher MUST rethrow it. Only this boundary may translate it into an error.
struct Refused;

pub(crate) fn budgeted<'a, T>(
    charge: &'a mut dyn FnMut(u64) -> bool,
    run: impl FnOnce(ParseMeter<'a>) -> T,
) -> Result<T, ()> {
    let meter = ParseMeter {
        state: Rc::new(State {
            index: Cell::new(0),
            charge: RefCell::new(Some(charge)),
        }),
    };
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(meter))) {
        Ok(value) => Ok(value),
        Err(payload) if payload.is::<Refused>() => Err(()),
        Err(payload) => std::panic::resume_unwind(payload),
    }
}
