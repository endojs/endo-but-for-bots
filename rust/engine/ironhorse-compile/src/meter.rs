//! The parse meter — ironhorse's own deterministic, release-versioned cost
//! table for compilation, threaded through the lexer from the first
//! token (design § Metering; the accuracy-over-parity doctrine,
//! maintainer-directed 2026-07-04).
//!
//! DOCTRINE: the meter is ironhorse's own frozen cost table, not a back-fit
//! of XS's `XS_PARSE_CODE_METERING`. The oracle certifies RESULTS (and
//! in stage 5, BYTES); computron-vs-oracle telemetry stays advisory. So
//! the constants below are ironhorse's to freeze per release
//! (`ironhorse-meter-N`); XS's `1 << 16`-per-parse-unit weight is recorded
//! only as the historical reference that motivated a per-unit shape.
//!
//! Threading the hook now — one counter bump per scanned token — is
//! cheap; retrofitting a meter into a finished lexer/parser is not. The
//! calibrated weights arrive with the frozen release table; until then
//! the shape (a monotone per-unit counter in 16.16 fixed point, read as
//! whole computrons via `>> 16`) is what matters and is what later
//! stages build on.

/// The frozen parse-meter release this table belongs to. Bump the suffix
/// (and re-freeze the constants) only at a deliberate release boundary.
pub const PARSE_METER_RELEASE: &str = "ironhorse-meter-0";

/// Cost charged per token the lexer produces, in 16.16 fixed point.
/// ironhorse's own constant (advisory calibration; see module doc).
pub const PARSE_TOKEN_METERING: u64 = 1 << 16;

/// A monotone parse-cost counter in 16.16 fixed point. Bumped once per
/// scanned token; never reset mid-parse (a fresh [`ParseMeter::new`] per
/// compilation is the reset).
#[derive(Debug, Default, Clone)]
pub struct ParseMeter {
    index: u64,
}

impl ParseMeter {
    /// A zeroed meter for one compilation.
    #[inline]
    pub fn new() -> Self {
        ParseMeter { index: 0 }
    }

    /// Charge one token. Called by the lexer for every token it emits,
    /// including [`crate::token::Token::Eof`].
    #[inline]
    pub fn charge_token(&mut self) {
        self.index = self.index.saturating_add(PARSE_TOKEN_METERING);
    }

    /// The raw 16.16 fixed-point index (for diagnostics / telemetry).
    #[inline]
    pub fn raw(&self) -> u64 {
        self.index
    }

    /// Whole computrons spent so far (`index >> 16`), the host-visible
    /// figure, mirroring how XS surfaces `meterIndex`.
    #[inline]
    pub fn computrons(&self) -> u64 {
        self.index >> 16
    }
}
