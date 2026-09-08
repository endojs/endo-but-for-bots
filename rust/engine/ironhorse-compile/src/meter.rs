//! Compilation uses the same frozen XS-derived release table as the VM.
//! Oracle computrons are advisory. Every scanned token (including EOF)
//! charges the shared parse-token weight; golden pairs pin that accounting.

/// The frozen parse-meter release this table belongs to. Bump the suffix
/// (and re-freeze the constants) only at a deliberate release boundary.
pub use ironhorse_meter::COST_TABLE_VERSION as PARSE_METER_RELEASE;

/// Cost charged per token the lexer produces, in 16.16 fixed point.
/// ironhorse's own constant (advisory calibration; see module doc).
pub use ironhorse_meter::PARSE_TOKEN_METERING;

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
