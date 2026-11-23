//! The computation meter (design § Metering; requirement 1a).
//!
//! Ironhorse owns a frozen release-versioned table of XS-derived weights.
//! Oracle computrons are advisory; result agreement and the local golden
//! corpus are the gates. Raw units use 16 fractional bits; hosts see `>> 16`.
//! The shared `ironhorse_meter` crate owns weights, parse costs, default keys,
//! and their digest. Increment-point changes also require a release bump.
//! Check points determine interruption, independently of accumulated cost.
//!
//! Every accumulation saturates. `index == u64::MAX` is the **exhausted**
//! state: the accrued total is no longer representable, so every check and
//! admission from it refuses ([`MeterCheck::Abort`]), armed or not, and no
//! refund leaves it; only [`Meter::begin`] or [`Meter::restore`] do. A
//! restored snapshot can carry any `MeterState`, so this is what keeps a
//! crafted `METR` atom from panicking (`overflow-checks` are on in release)
//! or from erasing accrued cost. Reaching it honestly takes about `2^48`
//! computrons. The proofs are MTR-1 … MTR-6 in `rust/engine/VERIFICATION.md`.

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
/// exact number of slots the engine allocates, so a **cost model faithful
/// to allocation work requires the allocation-faithful object heap**, not
/// just dispatch counting. (This is about the fidelity of Iron Horse's own
/// meter to real work — XS-computron parity is a non-goal.) A `var`
/// declaration, for instance, meters
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
/// truncation. A plain `interval << 16` drops
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
    /// host attached.
    #[inline]
    pub fn is_armed(&self) -> bool {
        self.interval != 0
    }

    /// The armed check interval in raw 16.16 units (`0` when un-armed).
    #[inline]
    pub fn interval_raw(&self) -> u64 {
        self.interval
    }

    /// Add one bytecode dispatch (`the->meterIndex += XS_CODE_METERING`
    /// in `mxBreak`).
    #[inline]
    pub fn tick_code(&mut self) {
        self.tick_raw(CODE_METERING);
    }

    /// Undo one bytecode dispatch's metering (`meterIndex -=
    /// XS_CODE_METERING`). Used on the uncaught-throw host-escape path: the
    /// escaping `throw`/`rethrow` opcode's `mxBreak` is bypassed by the
    /// `fxJump` longjmp into the host, so XS never meters it, whereas
    /// ironhorse's dispatch loop pre-meters every opcode. See
    /// `crate::interp::THROW_HOST_ESCAPE_METERING`. A paired refund, with
    /// [`Self::untick_raw`]'s contract.
    #[inline]
    pub fn untick_code(&mut self) {
        self.untick_raw(CODE_METERING);
    }

    /// Add `n` bytecode-equivalent units in one step (the explicit
    /// `meterIndex += k * XS_CODE_METERING` sites, e.g. the computed
    /// element-access path).
    #[inline]
    pub fn tick_code_n(&mut self, n: u64) {
        self.tick_raw(n.saturating_mul(CODE_METERING));
    }

    /// Add one built-in step (`mxMeterOne`).
    #[inline]
    pub fn tick_builtin(&mut self) {
        self.tick_raw(BUILTIN_METERING);
    }

    /// Add `k` built-in steps (`mxMeterSome(k)`).
    #[inline]
    pub fn tick_builtin_some(&mut self, k: u64) {
        self.tick_raw(k.saturating_mul(BUILTIN_METERING));
    }

    /// Meter one slot allocation (`fxNewSlot`'s
    /// `meterIndex += XS_SLOT_ALLOCATION_METERING`). The faithful object
    /// heap calls this on every slot it allocates during a run, which is
    /// what makes computrons allocation-dependent.
    #[inline]
    pub fn tick_slot_alloc(&mut self) {
        self.tick_raw(SLOT_ALLOCATION_METERING);
    }

    /// Meter a chunk allocation of `size` bytes (`fxNewChunk`'s
    /// `meterIndex += size * XS_CHUNK_ALLOCATION_METERING`).
    #[inline]
    pub fn tick_chunk_alloc(&mut self, size: u64) {
        self.tick_raw(size.saturating_mul(CHUNK_ALLOCATION_METERING));
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
    /// individually — see `crate::interp` § Allocation-faithful
    /// metering), and by the callers that meter a property-creation slot
    /// cluster. Every `tick_*` accrues through here, saturating: a total
    /// past `u64::MAX` leaves the meter exhausted (module docs) rather than
    /// wrapping or panicking.
    #[inline]
    pub fn tick_raw(&mut self, n: u64) {
        self.index = self.index.saturating_add(n);
    }

    /// Admit work before it allocates or executes. `n` is a raw 16.16
    /// charge, using the same weights as the corresponding `tick_*` call.
    /// An unrepresentable total fails closed, even when checks are disabled;
    /// wrapping it would let guest work erase its accrued cost. A total
    /// past `u64::MAX` is refused with the index unchanged; a total of
    /// exactly `u64::MAX` is admitted into the exhausted state and refused
    /// there by the check.
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
    ///
    /// The `debug_assert!` states that pairing precondition, `index ≥ n`, as
    /// an internal invariant of the engine's call sequences (a refund follows
    /// its charge within one step, and a snapshot is never taken between
    /// them), not as a property of restored states: the proofs assume it
    /// (MTR-1), and release builds, which a crafted snapshot reaches, rely
    /// on the saturation. A refund never leaves the exhausted state: the
    /// total it would refund from is unknown, so it stays refused.
    #[inline]
    pub fn untick_raw(&mut self, n: u64) {
        if self.index == u64::MAX {
            return;
        }
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
    /// interval; on refusal, signal an abort. An exhausted meter
    /// (`index == u64::MAX`) aborts without consulting `host`, armed or not.
    ///
    /// Where XS departs: when the next deadline `index + interval` is not
    /// representable, `fxCheckMetering` wraps `meterCount` and restarts the
    /// window by resetting `meterIndex` to 0, which would erase the accrued
    /// cost. Ironhorse fails closed instead and aborts (with `index`
    /// unchanged). An honest run reaches that only after about `2^48`
    /// computrons; a restored raw `interval` can reach it at once.
    #[inline]
    pub fn check<F: FnMut(u64) -> bool>(&mut self, host: &mut F) -> MeterCheck {
        self.check_inner(host, false)
    }

    /// Compilation receipts require a monotone accumulated index. Saturate
    /// an unrepresentable next deadline at `u64::MAX` and continue, where
    /// [`Self::check`] aborts; the exhausted state still refuses once the
    /// index reaches the ceiling.
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
        if self.index == u64::MAX {
            // Exhausted (module docs): the total is unrepresentable, and a
            // saturated window (`count == u64::MAX`) would otherwise never
            // see `index > count`.
            return MeterCheck::Abort;
        }
        if self.interval != 0 && self.index > self.count {
            self.last_reported = self.computrons();
            if !host(self.last_reported) {
                return MeterCheck::Abort;
            }
            match self.index.checked_add(self.interval) {
                Some(next) => self.count = next,
                // Compilation keeps its monotone receipt: saturate.
                None if monotone => self.count = u64::MAX,
                // Execution fails closed rather than adopting
                // `fxCheckMetering`'s wrap-and-reset (xsRun.c:4475),
                // which would erase the accrued cost.
                None => return MeterCheck::Abort,
            }
        }
        MeterCheck::Continue
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
    fn check_fails_closed_when_the_next_deadline_wraps() {
        // `fxCheckMetering` would wrap `meterCount` here and reset
        // `meterIndex` to 0, erasing the accrued cost. A restored raw
        // `interval` reaches this at once: index(8) > count(4) fires the
        // check, and 8 + (u64::MAX - 2) overflows. Ironhorse aborts with
        // the index and window untouched, even though the host approved.
        let mut m = Meter::new();
        m.index = 8;
        m.count = 4;
        m.interval = u64::MAX - 2;
        let mut consulted = 0;
        let out = m.check(&mut |_| {
            consulted += 1;
            true
        });
        assert_eq!(out, MeterCheck::Abort);
        assert_eq!(consulted, 1, "the host is still consulted first");
        assert_eq!(m.index, 8, "the accrued cost is kept");
        assert_eq!(m.count, 4);
        // A refusing host aborts as before.
        assert_eq!(m.check(&mut |_| false), MeterCheck::Abort);
        // The compilation check keeps its monotone receipt: it saturates
        // the deadline and continues.
        assert_eq!(m.check_compilation(&mut |_| true), MeterCheck::Continue);
        assert_eq!((m.index, m.count), (8, u64::MAX));
    }

    /// A meter restored to `index` with checks un-armed.
    fn restored(index: u64) -> Meter {
        let mut m = Meter::new();
        m.restore(MeterState {
            index,
            interval: 0,
            count: 0,
        });
        m
    }

    // Kani counterexamples (MTR-1) from before accumulation saturated: each
    // of these panicked with "attempt to add/multiply with overflow" in
    // release builds, which set `overflow-checks = true`.
    #[test]
    fn ticks_saturate_at_the_ceiling() {
        let ticks: [fn(&mut Meter); 9] = [
            Meter::tick_code,
            Meter::tick_builtin,
            Meter::tick_slot_alloc,
            |m| m.tick_raw(1),
            |m| m.tick_chunk_alloc(1),
            |m| m.tick_chunk_new(0),
            |m| m.tick_string(0),
            |m| m.tick_code_n(1),
            |m| m.tick_builtin_some(1),
        ];
        for (i, tick) in ticks.iter().enumerate() {
            let mut m = restored(u64::MAX);
            tick(&mut m);
            assert_eq!(m.raw(), u64::MAX, "tick {i} from the ceiling");
            let mut m = restored(u64::MAX - 1);
            tick(&mut m);
            assert_eq!(m.raw(), u64::MAX, "tick {i} onto the ceiling");
        }
    }

    #[test]
    fn wide_tick_multiplications_saturate() {
        let mut m = restored(0);
        m.tick_code_n(1 << 63);
        assert_eq!(m.raw(), u64::MAX, "n * CODE_METERING overflows");
        let mut m = restored(1 << 63);
        m.tick_code_n(1 << 47);
        assert_eq!(m.raw(), u64::MAX, "index + n * CODE_METERING overflows");
        let mut m = restored(0);
        m.tick_builtin_some(u64::MAX);
        assert_eq!(m.raw(), u64::MAX);
        let mut m = restored(0);
        m.tick_chunk_alloc(u64::MAX);
        assert_eq!(m.raw(), u64::MAX);
        // Below the ceiling the charges are exact.
        let mut m = restored(5);
        m.tick_code_n(3);
        m.tick_builtin_some(2);
        assert_eq!(m.raw(), 5 + 3 * CODE_METERING + 2 * BUILTIN_METERING);
    }

    /// An unpaired refund breaks the engine's pairing invariant, which
    /// debug builds assert; release builds (which a crafted snapshot can
    /// reach) saturate at zero instead of underflowing.
    #[test]
    #[cfg_attr(debug_assertions, should_panic(expected = "below the index"))]
    fn unpaired_untick_code_saturates_in_release() {
        let mut m = restored(0);
        m.untick_code();
        assert_eq!(m.raw(), 0);
        let mut m = restored(5);
        m.untick_raw(9);
        assert_eq!(m.raw(), 0);
    }

    #[test]
    fn the_exhausted_meter_is_absorbing() {
        let mut m = restored(u64::MAX - 1);
        m.tick_code();
        assert_eq!(m.raw(), u64::MAX);
        // A refund does not leave the exhausted state.
        m.untick_code();
        m.untick_raw(1 << 15);
        assert_eq!(m.raw(), u64::MAX);
        // Every check and admission refuses, un-armed and armed, without
        // consulting the host.
        assert_eq!(m.check(&mut |_| panic!("consulted")), MeterCheck::Abort);
        assert_eq!(
            m.check_compilation(&mut |_| panic!("consulted")),
            MeterCheck::Abort
        );
        assert_eq!(
            m.charge_and_check(0, &mut |_| panic!("consulted")),
            MeterCheck::Abort
        );
        assert!(!m.charge_compilation(0, None));
        m.restore(MeterState {
            index: u64::MAX,
            interval: u64::MAX,
            count: u64::MAX,
        });
        assert!(m.is_armed());
        assert_eq!(m.check(&mut |_| panic!("consulted")), MeterCheck::Abort);
        // Only begin (or restore) leaves it.
        m.begin(1);
        assert_eq!(m.raw(), 0);
        assert_eq!(m.check(&mut |_| false), MeterCheck::Continue);
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

/// Kani proofs of the meter guarantees MTR-1 … MTR-6 (`VERIFICATION.md`;
/// manifest `verification/proofs.toml`). Every harness starts from an
/// arbitrary restored [`MeterState`], which is what a snapshot's `METR`
/// atom can carry, and models the host callback as a symbolic answer.
#[cfg(kani)]
mod proofs {
    use super::*;

    /// A meter restored from an arbitrary snapshot state.
    fn any_meter() -> Meter {
        let mut meter = Meter::new();
        meter.restore(MeterState {
            index: kani::any(),
            interval: kani::any(),
            count: kani::any(),
        });
        meter
    }

    /// A host callback with a symbolic answer that records how it was
    /// consulted.
    #[derive(Copy, Clone)]
    struct Host {
        answer: bool,
        calls: u32,
        seen: u64,
    }

    impl Host {
        fn any() -> Host {
            Host {
                answer: kani::any(),
                calls: 0,
                seen: 0,
            }
        }

        fn consult(&mut self, computrons: u64) -> bool {
            self.calls += 1;
            self.seen = computrons;
            self.answer
        }
    }

    /// The result of one operation, comparable across meters.
    #[derive(Copy, Clone, PartialEq, Eq)]
    enum Outcome {
        Unit,
        Check(MeterCheck),
        Admitted(bool),
        Value(u64),
    }

    /// The operations a guest-driven crank can apply to a restored meter,
    /// with arbitrary arguments; `op` selects one. `begin`, `rearm` and
    /// `restore` are host-side configuration, handled separately. The
    /// unticks are applied paired with their tick (the only way the
    /// engine issues them; see [`Meter::untick_raw`]).
    const CHARGING_OPS: u8 = 15;

    fn apply(meter: &mut Meter, op: u8, arg: u64, host: &mut Host) -> Outcome {
        match op {
            0 => meter.tick_code(),
            1 => meter.tick_code_n(arg),
            2 => meter.tick_builtin(),
            3 => meter.tick_builtin_some(arg),
            4 => meter.tick_slot_alloc(),
            5 => meter.tick_chunk_alloc(arg),
            6 => meter.tick_chunk_new(arg),
            7 => meter.tick_string(arg),
            8 => meter.tick_raw(arg),
            9 => return Outcome::Check(meter.check(&mut |c| host.consult(c))),
            10 => return Outcome::Check(meter.check_compilation(&mut |c| host.consult(c))),
            11 => return Outcome::Check(meter.charge_and_check(arg, &mut |c| host.consult(c))),
            12 => {
                let mut consult = |c| host.consult(c);
                return Outcome::Admitted(meter.charge_compilation(arg, Some(&mut consult)));
            }
            13 => return Outcome::Admitted(meter.charge_compilation(arg, None)),
            14 => return Outcome::Value(meter.computrons()),
            15 => {
                meter.tick_code();
                meter.untick_code();
            }
            _ => {
                meter.tick_raw(arg);
                meter.untick_raw(arg);
            }
        }
        Outcome::Unit
    }

    /// The exact (unbounded) total of a tick, for the saturation claim.
    fn exact_tick(index: u64, op: u8, arg: u64) -> Option<u128> {
        let i = u128::from(index);
        let a = u128::from(arg);
        let cost = match op {
            0 => u128::from(CODE_METERING),
            1 => a * u128::from(CODE_METERING),
            2 => u128::from(BUILTIN_METERING),
            3 => a * u128::from(BUILTIN_METERING),
            4 => u128::from(SLOT_ALLOCATION_METERING),
            5 => a * u128::from(CHUNK_ALLOCATION_METERING),
            6 => u128::from(ironhorse_meter::chunk_cost(arg)),
            7 => u128::from(ironhorse_meter::string_chunk_cost(arg)),
            8 => a,
            _ => return None,
        };
        Some(i + cost)
    }

    // ---- MTR-1: no panic from any restored state -------------------------

    #[kani::proof]
    fn mtr1_tick_code() {
        let mut m = any_meter();
        m.tick_code();
        kani::cover!(m.raw() == u64::MAX, "the tick reaches the ceiling");
    }

    #[kani::proof]
    fn mtr1_tick_code_n() {
        let mut m = any_meter();
        let before = m.raw();
        m.tick_code_n(kani::any());
        kani::cover!(
            before < u64::MAX && m.raw() == u64::MAX,
            "the tick saturates"
        );
    }

    #[kani::proof]
    fn mtr1_tick_builtin() {
        let mut m = any_meter();
        m.tick_builtin();
        kani::cover!(m.raw() == u64::MAX, "the tick reaches the ceiling");
    }

    #[kani::proof]
    fn mtr1_tick_builtin_some() {
        let mut m = any_meter();
        let before = m.raw();
        m.tick_builtin_some(kani::any());
        kani::cover!(
            before < u64::MAX && m.raw() == u64::MAX,
            "the tick saturates"
        );
    }

    #[kani::proof]
    fn mtr1_tick_slot_alloc() {
        let mut m = any_meter();
        m.tick_slot_alloc();
        kani::cover!(m.raw() == u64::MAX, "the tick reaches the ceiling");
    }

    #[kani::proof]
    fn mtr1_tick_chunk_alloc() {
        let mut m = any_meter();
        let before = m.raw();
        m.tick_chunk_alloc(kani::any());
        kani::cover!(
            before < u64::MAX && m.raw() == u64::MAX,
            "the tick saturates"
        );
    }

    #[kani::proof]
    fn mtr1_tick_chunk_new_and_string() {
        let mut m = any_meter();
        let before = m.raw();
        if kani::any() {
            m.tick_chunk_new(kani::any());
        } else {
            m.tick_string(kani::any());
        }
        kani::cover!(
            before < u64::MAX && m.raw() == u64::MAX,
            "the tick saturates"
        );
    }

    #[kani::proof]
    fn mtr1_tick_raw() {
        let mut m = any_meter();
        let before = m.raw();
        m.tick_raw(kani::any());
        kani::cover!(
            before < u64::MAX && m.raw() == u64::MAX,
            "the tick saturates"
        );
    }

    /// The unticks are refunds of a prior tick: the harness assumes the
    /// pairing precondition `index ≥ n` that [`Meter::untick_raw`]'s
    /// `debug_assert!` states (Kani builds with debug assertions on). The
    /// release-mode behaviour of an unpaired untick is a unit test.
    #[kani::proof]
    fn mtr1_untick_code() {
        let mut m = any_meter();
        kani::assume(m.raw() >= CODE_METERING);
        m.untick_code();
        kani::cover!(m.raw() == 0, "the refund empties the meter");
    }

    #[kani::proof]
    fn mtr1_untick_raw() {
        let mut m = any_meter();
        let n: u64 = kani::any();
        kani::assume(m.raw() >= n);
        m.untick_raw(n);
        kani::cover!(n > 0 && m.raw() == 0, "the refund empties the meter");
    }

    #[kani::proof]
    fn mtr1_checks_and_charges() {
        let mut m = any_meter();
        let mut host = Host::any();
        let op: u8 = kani::any();
        kani::assume((9..=13).contains(&op));
        let out = apply(&mut m, op, kani::any(), &mut host);
        kani::cover!(host.calls == 1, "the host is consulted");
        kani::cover!(
            out == Outcome::Check(MeterCheck::Continue) && host.calls == 1,
            "a consulted check continues"
        );
    }

    #[kani::proof]
    fn mtr1_configuration() {
        let mut m = any_meter();
        let interval: u64 = kani::any();
        if kani::any() {
            m.begin(interval);
        } else {
            m.rearm(interval);
        }
        let _ = (m.state(), m.computrons(), m.is_armed(), m.interval_raw());
        kani::cover!(
            m.is_armed() && m.state().count == u64::MAX,
            "the window saturates"
        );
    }

    /// Four arbitrary operations in sequence, from an arbitrary state.
    #[kani::proof]
    #[kani::unwind(5)]
    fn mtr1_sequence_of_four() {
        let mut m = any_meter();
        let mut host = Host::any();
        for _ in 0..4 {
            let op: u8 = kani::any();
            kani::assume(op <= CHARGING_OPS + 1);
            apply(&mut m, op, kani::any(), &mut host);
        }
        kani::cover!(host.calls >= 3, "the host is consulted three times");
    }

    // ---- MTR-2: charging fails closed ------------------------------------

    /// Every tick leaves exactly `min(index + cost, u64::MAX)`.
    #[kani::proof]
    fn mtr2_ticks_saturate_exactly() {
        let mut m = any_meter();
        let before = m.raw();
        let op: u8 = kani::any();
        kani::assume(op <= 8);
        let arg: u64 = kani::any();
        let mut host = Host::any();
        apply(&mut m, op, arg, &mut host);
        let exact = exact_tick(before, op, arg).unwrap();
        assert_eq!(u128::from(m.raw()), exact.min(u128::from(u64::MAX)));
        kani::cover!(exact > u128::from(u64::MAX), "the exact total overflows");
    }

    /// An unrepresentable admission aborts and leaves the index unchanged;
    /// one that lands exactly on the ceiling aborts at the ceiling.
    #[kani::proof]
    fn mtr2_charge_and_check_fails_closed() {
        let mut m = any_meter();
        let before = m.raw();
        let n: u64 = kani::any();
        let mut host = Host::any();
        let out = m.charge_and_check(n, &mut |c| host.consult(c));
        match before.checked_add(n) {
            None => {
                assert!(out == MeterCheck::Abort);
                assert_eq!(m.raw(), before);
                assert_eq!(host.calls, 0);
            }
            Some(u64::MAX) => {
                assert!(out == MeterCheck::Abort);
                assert_eq!(m.raw(), u64::MAX);
                assert_eq!(host.calls, 0);
            }
            Some(total) => assert_eq!(m.raw(), total),
        }
        kani::cover!(
            before.checked_add(n).is_none(),
            "the total is unrepresentable"
        );
        kani::cover!(
            !m.is_armed() && out == MeterCheck::Abort,
            "aborts while un-armed"
        );
    }

    #[kani::proof]
    fn mtr2_charge_compilation_fails_closed() {
        let mut m = any_meter();
        let before = m.raw();
        let n: u64 = kani::any();
        let mut host = Host::any();
        let admitted = if kani::any() {
            let mut consult = |c| host.consult(c);
            m.charge_compilation(n, Some(&mut consult))
        } else {
            m.charge_compilation(n, None)
        };
        match before.checked_add(n) {
            None => {
                assert!(!admitted);
                assert_eq!(m.raw(), before);
            }
            Some(u64::MAX) => {
                assert!(!admitted);
                assert_eq!(m.raw(), u64::MAX);
            }
            Some(total) => assert_eq!(m.raw(), total),
        }
        kani::cover!(
            before.checked_add(n).is_none(),
            "the total is unrepresentable"
        );
    }

    /// `index == u64::MAX` is absorbing: no guest-driven operation leaves
    /// it, and every check or admission from it refuses, armed or not,
    /// without consulting the host.
    #[kani::proof]
    fn mtr2_exhausted_is_absorbing() {
        let mut m = any_meter();
        kani::assume(m.raw() == u64::MAX);
        let op: u8 = kani::any();
        kani::assume(op <= CHARGING_OPS + 1);
        let mut host = Host::any();
        let out = apply(&mut m, op, kani::any(), &mut host);
        assert_eq!(m.raw(), u64::MAX);
        assert_eq!(host.calls, 0);
        match out {
            Outcome::Check(c) => assert!(c == MeterCheck::Abort),
            Outcome::Admitted(a) => assert!(!a),
            Outcome::Unit | Outcome::Value(_) => {}
        }
        kani::cover!(!m.is_armed() && op == 9, "an un-armed check refuses");
        kani::cover!(op == CHARGING_OPS, "a paired refund stays exhausted");
    }

    // ---- MTR-3: limit enforcement cannot be bypassed ---------------------

    #[kani::proof]
    fn mtr3_check_consults_the_host_when_due() {
        let mut m = any_meter();
        let before = m.state();
        let monotone: bool = kani::any();
        let mut host = Host::any();
        let out = if monotone {
            m.check_compilation(&mut |c| host.consult(c))
        } else {
            m.check(&mut |c| host.consult(c))
        };
        let due = before.interval != 0 && before.index > before.count;
        if before.index == u64::MAX {
            assert!(out == MeterCheck::Abort);
            assert_eq!(host.calls, 0);
        } else if due {
            assert_eq!(host.calls, 1);
            assert_eq!(host.seen, before.index >> 16);
            if !host.answer {
                assert!(out == MeterCheck::Abort);
            } else if out == MeterCheck::Continue {
                assert!(m.state().count > m.state().index);
            } else {
                // Only an unrepresentable next deadline refuses an
                // approved check, and only on the execution path.
                assert!(!monotone);
                assert!(before.index.checked_add(before.interval).is_none());
            }
        } else {
            assert_eq!(host.calls, 0);
            assert!(out == MeterCheck::Continue);
            assert_eq!(m.state(), before);
        }
        assert_eq!(m.raw(), before.index);
        kani::cover!(
            due && host.answer && out == MeterCheck::Continue,
            "an approved check"
        );
        kani::cover!(
            due && host.answer && out == MeterCheck::Abort,
            "an approved check whose next deadline is unrepresentable"
        );
    }

    #[kani::proof]
    fn mtr3_unarmed_never_consults() {
        let mut m = any_meter();
        kani::assume(!m.is_armed());
        let op: u8 = kani::any();
        kani::assume((9..=12).contains(&op));
        let mut host = Host::any();
        apply(&mut m, op, kani::any(), &mut host);
        assert_eq!(host.calls, 0);
        kani::cover!(m.raw() > m.state().count, "the index is past the threshold");
    }

    // ---- MTR-4: unit relations -------------------------------------------

    #[kani::proof]
    fn mtr4_computrons_and_interval_scaling() {
        let m = any_meter();
        assert_eq!(m.computrons(), m.raw() >> 16);
        let i: u64 = kani::any();
        let scaled = scale_interval(i);
        assert_eq!(scaled != 0, i != 0);
        assert_eq!(
            u128::from(scaled),
            (u128::from(i) << 16).min(u128::from(u64::MAX))
        );
        let mut armed = Meter::new();
        armed.begin(i);
        assert_eq!(armed.is_armed(), i != 0);
        kani::cover!(
            i != 0 && i % (1 << 48) == 0,
            "a multiple of 2^48 stays armed"
        );
    }

    // ---- MTR-5: state and restore round trip -----------------------------

    #[kani::proof]
    fn mtr5_restore_state_round_trip() {
        let s = MeterState {
            index: kani::any(),
            interval: kani::any(),
            count: kani::any(),
        };
        let mut m = Meter::new();
        m.tick_raw(kani::any());
        m.restore(s);
        assert_eq!(m.state(), s);
        kani::cover!(
            s.index != 0 && s.interval != 0 && s.count != 0,
            "a full state"
        );
    }

    /// `last_reported` feeds no computation: two meters that differ only
    /// in it give equal results, states and host consultations.
    #[kani::proof]
    fn mtr5_last_reported_feeds_nothing() {
        let mut a = any_meter();
        let mut b = a.clone();
        b.last_reported = kani::any();
        let op: u8 = kani::any();
        kani::assume(op <= CHARGING_OPS + 1);
        let arg: u64 = kani::any();
        let mut host_a = Host::any();
        let mut host_b = host_a;
        let out_a = apply(&mut a, op, arg, &mut host_a);
        let out_b = apply(&mut b, op, arg, &mut host_b);
        assert!(out_a == out_b);
        assert_eq!(a.state(), b.state());
        assert_eq!((host_a.calls, host_a.seen), (host_b.calls, host_b.seen));
        kani::cover!(host_a.calls == 1, "the host is consulted");
    }

    // ---- MTR-6: monotonicity, with its exact exceptions ------------------

    /// No charging operation decreases the index; a paired refund returns
    /// it to at least its value before the paired tick, exactly that value
    /// unless the tick reached the exhausted ceiling.
    #[kani::proof]
    fn mtr6_index_is_monotone() {
        let mut m = any_meter();
        let before = m.raw();
        let op: u8 = kani::any();
        kani::assume(op <= CHARGING_OPS + 1);
        let arg: u64 = kani::any();
        let mut host = Host::any();
        apply(&mut m, op, arg, &mut host);
        assert!(m.raw() >= before);
        if op == CHARGING_OPS && before < u64::MAX - CODE_METERING {
            assert_eq!(m.raw(), before);
        }
        if op == CHARGING_OPS + 1 && before.checked_add(arg).is_some_and(|t| t < u64::MAX) {
            assert_eq!(m.raw(), before);
        }
        if (9..=10).contains(&op) {
            assert_eq!(m.raw(), before, "a check never moves the index");
        }
        kani::cover!(op == 9 && host.calls == 1, "a consulted check");
        kani::cover!(
            op == CHARGING_OPS + 1 && arg > 0 && m.raw() == before,
            "a paired refund"
        );
    }
}
