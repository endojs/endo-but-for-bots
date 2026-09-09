//! The computation meter (design § Metering; requirement 1a).
//!
//! Ironhorse owns a frozen release-versioned table of XS-derived weights.
//! Oracle computrons are advisory; result agreement and the local golden
//! corpus are the gates. Raw units use 16 fractional bits; hosts see `>> 16`.
//! The shared `ironhorse_meter` crate owns weights, parse costs, default keys,
//! and their digest. Increment-point changes also require a release bump.
//! Check points determine interruption, independently of accumulated cost.

/// The frozen, release-versioned id of the meter's cost table (design
/// `designs/ironhorse-engine.md` § roadmap row 6: "meter state across
/// suspend"). Ironhorse's meter is its **own** frozen cost table, not a
/// back-fit of the oracle's; a snapshot records which table produced its
/// computrons ([`crate::meter::MeterState`] carried in the `METR` atom),
/// and a resume under a **different** cost-table version fails closed
/// rather than silently continuing a meter whose weights changed — the
/// metering analogue of the callback-table `SIGN` signature. Bump the
/// trailing number whenever anything that changes WHAT a program is
/// charged changes: a metering weight, or an increment point. The
/// points at which the host is CONSULTED (the loop-closing checks, and
/// the in-match stride [`ironhorse_regexp::MATCH_CHECK_STRIDE`]) are
/// release-defined constants outside this gate: they decide where an
/// armed crank can be interrupted, never how many computrons it has
/// spent, so a resumed meter continues exactly across a change to them
/// (design § Metering, "Check points and abort": the abort point is a
/// release-defined outcome, not a cost-table fact).
pub use ironhorse_meter::COST_TABLE_VERSION;

/// `XS_BIGINT_METERING`.
pub use ironhorse_meter::BIGINT_METERING;
/// `XS_BUILTIN_METERING`: one built-in operation step (`mxMeterOne` /
/// `mxMeterSome(k)`). The property-set path meters one of these per
/// `SET_VARIABLE`/`SET_PROPERTY`, so allocation-free code can incur it too.
pub use ironhorse_meter::BUILTIN_METERING;
/// `XS_CHUNK_ALLOCATION_METERING`: added per byte of chunk allocated
/// (`fxNewChunk`/`fxRenewChunk`), so a string or bytecode allocation
/// meters its length.
pub use ironhorse_meter::CHUNK_ALLOCATION_METERING;
/// `XS_CODE_METERING`: one bytecode dispatch.
pub use ironhorse_meter::CODE_METERING;
/// `XS_SLOT_ALLOCATION_METERING`: added by `fxNewSlot` on **every** slot
/// allocation during a run (`xsMemory.c`). Once a program allocates at
/// run time (a `var` environment, an
/// object literal, a closure cell), its computron count depends on the
/// exact number of slots the engine allocates, so **computron parity
/// requires the allocation-faithful object heap**, not just dispatch
/// counting. A `var` declaration, for instance, meters
/// `1<<14` (the set's `mxMeterOne`) + `2 * (1<<8)` (a closure cell + a
/// property slot, per `fxRunEvalEnvironment`) + the property-name chunk
/// bytes — the "16920 per var" the differential probe measured.
pub use ironhorse_meter::SLOT_ALLOCATION_METERING;
/// `XS_STRING_METERING` / `XS_BIGINT_METERING`: one code unit of string
/// concatenation / one BigInt digit step (`xsString.c`, `xsBigInt.c`).
pub use ironhorse_meter::STRING_METERING;

/// Outcome of a metering check at a loop-closing point.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum MeterCheck {
    /// Keep running.
    Continue,
    /// The host refused more computation: abort the crank with
    /// `XS_TOO_MUCH_COMPUTATION_EXIT` semantics.
    Abort,
}

/// The serializable projection of a [`Meter`] carried across a suspend
/// (design row 6). The three fixed-point counters that make a resumed
/// machine continue its meter **exactly** — `index` (`the->meterIndex`),
/// `interval` (`the->meterInterval`, scaled raw units), and `count`
/// (`the->meterCount`, the next check threshold). `last_reported` is
/// diagnostic only (it re-derives from `index` on the next check), so it
/// is deliberately not part of the carried state. The cost-table version
/// travels alongside in the snapshot's `METR` atom, not here.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Default)]
pub struct MeterState {
    pub index: u64,
    pub interval: u64,
    pub count: u64,
}

/// The 16.16 fixed-point meter.
#[derive(Debug, Clone)]
pub struct Meter {
    /// `the->meterIndex`.
    index: u64,
    /// `the->meterInterval`. Zero disables checks (but the index still
    /// accumulates, exactly as under `mxMetering`).
    interval: u64,
    /// `the->meterCount`: the next threshold a check compares against.
    count: u64,
    /// The last computron value the host callback was shown, for
    /// reporting.
    last_reported: u64,
}

impl Default for Meter {
    fn default() -> Self {
        Meter::new()
    }
}

/// Scale a host **computron** interval to raw 16.16 units without
/// truncation (architecture review F013). A plain `interval << 16` drops
/// the high 16 bits of any interval at or above `2^48`, and an interval
/// that is an exact multiple of `2^48` scales to `0`, which
/// [`Meter::check`] reads as "metering disabled": a supervisor asking for
/// an effectively unlimited but *armed* window would silently get an
/// un-armed machine. Saturating keeps a non-zero interval non-zero, so
/// the armed/un-armed distinction is never flipped by arithmetic.
///
/// A saturated interval is a meter that is armed but whose window
/// (`count == u64::MAX`) the index can never pass, so the host is never
/// consulted — which is exactly what a host asking to be consulted every
/// `2^48` or more computrons asked for (the raw index cannot reach `2^64`).
/// Every such interval scales to the same value, so
/// `Interp::attach_meter_host` treats them as one configuration. An
/// embedder that means "no bound" says so by not arming at all rather
/// than by an astronomically large interval.
#[inline]
pub(crate) fn scale_interval(interval: u64) -> u64 {
    interval.saturating_mul(1 << 16)
}

impl Meter {
    pub fn new() -> Meter {
        Meter {
            index: 0,
            interval: 0,
            count: 0,
            last_reported: 0,
        }
    }

    /// `fxBeginMetering` (`xsRun.c:4459`): install an interval and arm
    /// the first check. XS scales the host's interval by `<<16`
    /// (computrons to raw 16.16 units), resets `meterIndex` to 0, and
    /// sets `meterCount = meterInterval = interval << 16`. `interval` is
    /// therefore a **computron** count, matching the xsnap embedder API;
    /// a caller that wants a raw-unit window must scale it itself.
    /// `begin_scales_and_resets_like_fx_begin_metering` checks this contract.
    pub fn begin(&mut self, interval: u64) {
        let scaled = scale_interval(interval);
        self.interval = scaled;
        self.count = scaled;
        self.index = 0;
    }

    /// Re-arm on a resumed machine: install a fresh
    /// check window without destroying the restored `index` — the
    /// accumulated computron count that [`Self::restore`] just
    /// reinstated. [`Self::begin`] is the fresh-machine form and zeroes
    /// it by design. NOTE this deliberately REPLACES the restored
    /// `count` (the next-check threshold) — the interval-change form —
    /// so a resume that wants the deadline to survive untouched must
    /// not call it at all: [`Self::restore`] already reinstated all
    /// three counters, and the interp's `reattach_meter_host` installs
    /// the host without touching them. Snapshot `meter_fail_closed.rs`
    /// checks both forms.
    pub fn rearm(&mut self, interval: u64) {
        let scaled = scale_interval(interval);
        self.interval = scaled;
        self.count = self.index.saturating_add(scaled);
    }

    /// Whether checks are armed (`interval != 0`). The armed/un-armed
    /// distinction is carried by the snapshot ([`MeterState::interval`]),
    /// so a restored machine reports armed exactly as it was suspended;
    /// the host callback does not travel with it, which is why the
    /// interpreter's check point fails closed on an armed meter with no
    /// host attached (architecture review F014).
    #[inline]
    pub fn is_armed(&self) -> bool {
        self.interval != 0
    }

    /// The armed check interval in raw 16.16 units (`0` when un-armed).
    #[inline]
    pub fn interval_raw(&self) -> u64 {
        self.interval
    }

    /// Reset the raw index to zero (the oracle shim does this after
    /// parse so the run-only count is comparable).
    pub fn reset(&mut self) {
        self.index = 0;
        self.count = self.interval;
    }

    /// Add one bytecode dispatch (`the->meterIndex += XS_CODE_METERING`
    /// in `mxBreak`).
    #[inline]
    pub fn tick_code(&mut self) {
        self.index += CODE_METERING;
    }

    /// Undo one bytecode dispatch's metering (`meterIndex -=
    /// XS_CODE_METERING`). Used on the uncaught-throw host-escape path: the
    /// escaping `throw`/`rethrow` opcode's `mxBreak` is bypassed by the
    /// `fxJump` longjmp into the host, so XS never meters it, whereas
    /// ironhorse's dispatch loop pre-meters every opcode. See
    /// [`crate::interp::THROW_HOST_ESCAPE_METERING`].
    #[inline]
    pub fn untick_code(&mut self) {
        self.index -= CODE_METERING;
    }

    /// Add `n` bytecode-equivalent units in one step (the explicit
    /// `meterIndex += k * XS_CODE_METERING` sites, e.g. the computed
    /// element-access path).
    #[inline]
    pub fn tick_code_n(&mut self, n: u64) {
        self.index += n * CODE_METERING;
    }

    /// Add one built-in step (`mxMeterOne`).
    #[inline]
    pub fn tick_builtin(&mut self) {
        self.index += BUILTIN_METERING;
    }

    /// Add `k` built-in steps (`mxMeterSome(k)`).
    #[inline]
    pub fn tick_builtin_some(&mut self, k: u64) {
        self.index += k * BUILTIN_METERING;
    }

    /// Meter one slot allocation (`fxNewSlot`'s
    /// `meterIndex += XS_SLOT_ALLOCATION_METERING`). The faithful object
    /// heap calls this on every slot it allocates during a run, which is
    /// what makes computrons allocation-dependent.
    #[inline]
    pub fn tick_slot_alloc(&mut self) {
        self.index += SLOT_ALLOCATION_METERING;
    }

    /// Meter a chunk allocation of `size` bytes (`fxNewChunk`'s
    /// `meterIndex += size * XS_CHUNK_ALLOCATION_METERING`).
    #[inline]
    pub fn tick_chunk_alloc(&mut self, size: u64) {
        self.index += size * CHUNK_ALLOCATION_METERING;
    }

    /// Meter one `fxNewChunk(size)` allocation **faithfully**: XS meters
    /// the *adjusted* chunk size, not the requested `size`.
    /// `fxAdjustChunkSize` (`xsMemory.c`) rounds the payload up to
    /// `sizeof(size_t)` (8-byte) alignment and adds the `sizeof(txChunk)`
    /// header — 16 bytes on the 64-bit oracle target
    /// (`{ txSize size; txS4 dummy; txByte* temporary; }`). So a 5-byte
    /// function-body chunk meters `round_up_8(5) + 16 = 24`, not 5. This is
    /// what makes a function's computron count depend on its exact body
    /// length in the way XS's does.
    #[inline]
    pub fn tick_chunk_new(&mut self, size: u64) {
        self.tick_raw(ironhorse_meter::chunk_cost(size));
    }

    /// Charge a string chunk by UTF-16 code-unit length, including the terminator.
    #[inline]
    pub fn tick_string(&mut self, units: u64) {
        self.tick_raw(ironhorse_meter::string_chunk_cost(units));
    }

    /// Accrue `n` raw 16.16-fixed-point units directly. Used for the
    /// program-frame + eval-environment setup aggregate XS meters
    /// during program entry (a bundle of `fxNewSlot`/`fxNewChunk`
    /// allocations building the program's environment instance and frame
    /// that this stage models as a measured constant rather than
    /// individually — see [`crate::interp`] § Allocation-faithful
    /// metering), and by the callers that meter a property-creation slot
    /// cluster.
    #[inline]
    pub fn tick_raw(&mut self, n: u64) {
        self.index += n;
    }

    /// Admit work before it allocates or executes. `n` is a raw 16.16
    /// charge, using the same weights as the corresponding `tick_*` call.
    /// An unrepresentable total fails closed, even when checks are disabled;
    /// wrapping it would let guest work erase its accrued cost.
    #[inline]
    pub fn charge_and_check<F: FnMut(u64) -> bool>(&mut self, n: u64, host: &mut F) -> MeterCheck {
        let Some(index) = self.index.checked_add(n) else {
            return MeterCheck::Abort;
        };
        self.index = index;
        self.check(host)
    }

    /// Subtract `n` raw 16.16 units (reverse a prior [`Self::tick_raw`]). Used
    /// to undo a speculatively-charged host-escape residual when a throw is
    /// actually caught by a native `mxTry` (a promise reaction handler / a
    /// thenable `then` that throws — XS never leaves the machine, so the
    /// host-escape adjustment must be unwound). Every `Halt::Throw` the engine
    /// produces has paid that residual exactly once (`raise_js` and the loop's
    /// inline unwinds are the only constructors), so the reversal is always
    /// covered; the saturation is a floor against a future unpaired reversal
    /// wrapping the index to `u64::MAX` rather than a case that occurs.
    #[inline]
    pub fn untick_raw(&mut self, n: u64) {
        debug_assert!(
            self.index >= n,
            "untick_raw({n}) below the index {}",
            self.index
        );
        self.index = self.index.saturating_sub(n);
    }

    /// Raw fixed-point index (`the->meterIndex`).
    #[inline]
    pub fn raw(&self) -> u64 {
        self.index
    }

    /// The serializable metering state (design row 6, snapshot support):
    /// the counters a suspend must carry so a resume continues the meter
    /// exactly. See [`MeterState`].
    #[inline]
    pub fn state(&self) -> MeterState {
        MeterState {
            index: self.index,
            interval: self.interval,
            count: self.count,
        }
    }

    /// Reinstate a metering state read from a snapshot ([`Self::state`]'s
    /// inverse). The armed/un-armed distinction rides in `interval` (zero
    /// ⇒ the un-armed differential-harness meter, which accumulates but
    /// never checks), so a resumed machine re-arms exactly as it was.
    /// `last_reported` is re-seeded from `index` for diagnostics; it feeds
    /// no computation.
    #[inline]
    pub fn restore(&mut self, s: MeterState) {
        self.index = s.index;
        self.interval = s.interval;
        self.count = s.count;
        self.last_reported = s.index >> 16;
    }

    /// Computrons (`meterIndex >> 16`), what the host callback sees.
    #[inline]
    pub fn computrons(&self) -> u64 {
        self.index >> 16
    }

    /// `mxCheckMeter`: at a loop-closing point, if metering is armed and
    /// the index passed the threshold, consult `host`. Mirrors
    /// `fxCheckMetering`: on continue, advance `meterCount` by the
    /// interval; on refusal, signal an abort.
    #[inline]
    pub fn check<F: FnMut(u64) -> bool>(&mut self, host: &mut F) -> MeterCheck {
        self.check_inner(host, false)
    }

    /// Compilation receipts require a monotone accumulated index. Saturate
    /// the next deadline instead of adopting XS's execution-window wrap/reset.
    pub(crate) fn check_compilation<F: FnMut(u64) -> bool + ?Sized>(
        &mut self,
        host: &mut F,
    ) -> MeterCheck {
        self.check_inner(host, true)
    }

    /// Charge compiler work before a realm exists, using the same monotone
    /// checkpoint policy as runtime compilation. Move this meter and its host
    /// into the evaluator afterward; do not replay already delivered charges.
    pub fn charge_compilation(
        &mut self,
        raw: u64,
        host: Option<&mut dyn FnMut(u64) -> bool>,
    ) -> bool {
        let Some(next) = self.index.checked_add(raw) else {
            return false;
        };
        self.index = next;
        if next == u64::MAX {
            return false;
        }
        match host {
            Some(host) => self.check_compilation(host) == MeterCheck::Continue,
            None => !self.is_armed(),
        }
    }

    fn check_inner<F: FnMut(u64) -> bool + ?Sized>(
        &mut self,
        host: &mut F,
        monotone: bool,
    ) -> MeterCheck {
        if self.interval != 0 && self.index > self.count {
            self.last_reported = self.computrons();
            if host(self.last_reported) {
                if monotone {
                    self.count = self.index.saturating_add(self.interval);
                    return MeterCheck::Continue;
                }
                // XS advances `meterCount` in unsigned (`txU8`)
                // arithmetic, which wraps on overflow; mirror that with a
                // wrapping add so the guard below can observe the wrap.
                self.count = self.index.wrapping_add(self.interval);
                // `fxCheckMetering`'s overflow-wrap guard (xsRun.c:4475):
                // if advancing `meterCount` wrapped it below `meterIndex`,
                // restart the window at zero. Practically unreachable at
                // u64 width, but parity is the whole premise.
                if self.count < self.index {
                    self.index = 0;
                    self.count = self.interval;
                }
                MeterCheck::Continue
            } else {
                MeterCheck::Abort
            }
        } else {
            MeterCheck::Continue
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn admission_charges_before_consulting_host() {
        let mut meter = Meter::new();
        meter.begin(1);
        let mut seen = None;
        assert_eq!(
            meter.charge_and_check(2 * CODE_METERING, &mut |spent| {
                seen = Some(spent);
                false
            }),
            MeterCheck::Abort
        );
        assert_eq!(seen, Some(2));
        assert_eq!(meter.raw(), 2 * CODE_METERING);
    }

    #[test]
    fn admission_preserves_unarmed_costs_without_consulting_host() {
        let mut meter = Meter::new();
        assert_eq!(
            meter.charge_and_check(123, &mut |_| panic!("unarmed host")),
            MeterCheck::Continue
        );
        assert_eq!(meter.raw(), 123);
    }

    #[test]
    fn admission_rejects_unrepresentable_total_without_wrapping() {
        let mut meter = Meter::new();
        meter.tick_raw(u64::MAX);
        assert_eq!(
            meter.charge_and_check(1, &mut |_| panic!("overflow host")),
            MeterCheck::Abort
        );
        assert_eq!(meter.raw(), u64::MAX);
    }

    #[test]
    fn check_disabled_when_interval_zero() {
        // The default (un-armed) meter never consults the host, even
        // once the index passes any plausible threshold: the
        // differential harness relies on this.
        let mut m = Meter::new();
        m.tick_code();
        let mut consulted = false;
        let out = m.check(&mut |_| {
            consulted = true;
            true
        });
        assert_eq!(out, MeterCheck::Continue);
        assert!(!consulted, "un-armed meter must not consult the host");
    }

    #[test]
    fn begin_scales_and_resets_like_fx_begin_metering() {
        // `fxBeginMetering` (xsRun.c:4459) scales the host's computron
        // interval `<<16` and resets the index:
        // begin(1) arms a one-computron window in raw units.
        let mut m = Meter::new();
        m.tick_code(); // dirty the index first, to prove begin resets it
        m.begin(1);
        assert_eq!(m.index, 0, "begin resets meterIndex to 0");
        assert_eq!(m.interval, 1 << 16, "interval scaled to raw units");
        assert_eq!(m.count, 1 << 16, "count armed at interval<<16");
    }

    #[test]
    fn begin_saturates_rather_than_truncating_a_wide_interval() {
        // F013: `interval << 16` silently loses the high bits at or
        // above 2^48, and an exact multiple of 2^48 scales to zero, which
        // `check` reads as "disabled". The armed distinction must survive
        // any host interval.
        let mut m = Meter::new();
        m.begin(1 << 48);
        assert!(m.is_armed(), "a 2^48 interval must stay armed");
        assert_eq!(m.interval, u64::MAX, "saturates instead of wrapping to 0");
        m.begin((1 << 48) + 5);
        assert!(m.is_armed());
        assert_eq!(m.interval, u64::MAX);
        let mut r = Meter::new();
        r.tick_code();
        r.rearm(1 << 50);
        assert!(r.is_armed(), "rearm saturates the same way");
        assert_eq!(r.count, u64::MAX, "count saturates past the index");
        // The un-armed default and the largest exactly representable
        // interval are untouched.
        let mut n = Meter::new();
        assert!(!n.is_armed());
        n.begin((1 << 48) - 1);
        assert_eq!(n.interval, ((1u64 << 48) - 1) << 16);
    }

    #[test]
    fn check_wrap_guard_restarts_window() {
        // Force `meterCount` to wrap: with the index already past the
        // count so the check fires, an interval large enough that
        // `index + interval` overflows u64 must reset the window to
        // `interval` rather than leave `count` below `index`.
        let mut m = Meter::new();
        m.index = 8; // index(8) > count(4): the check fires
        m.count = 4;
        m.interval = u64::MAX - 2; // advancing count by this overflows u64
        let out = m.check(&mut |_| true);
        assert_eq!(out, MeterCheck::Continue);
        assert_eq!(m.index, 0, "wrap guard resets meterIndex to 0");
        assert_eq!(
            m.count, m.interval,
            "wrap guard resets meterCount to interval"
        );
    }

    #[test]
    fn check_advances_window_without_wrap() {
        let mut m = Meter::new();
        m.index = 3; // > count(2): fires
        m.count = 2;
        m.interval = 2;
        let out = m.check(&mut |_| true);
        assert_eq!(out, MeterCheck::Continue);
        assert_eq!(m.count, 5, "count advances by interval: 3 + 2");
        assert_eq!(m.index, 3, "index untouched when no wrap");
    }
}
