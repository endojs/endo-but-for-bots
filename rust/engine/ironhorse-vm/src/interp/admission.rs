//! Meter checks and fallible admission for temporary allocations.
use super::*;

impl Interp {
    /// A loop-closing metering check (`mxCheckMeter`). Consults the host
    /// when one is installed; a fresh, never-armed machine (the default
    /// the differential harness uses) keeps running. Adds nothing to
    /// `meterIndex`.
    ///
    /// Fail-closed: a meter that is ARMED
    /// (`interval != 0`, which a snapshot carries) but has no host
    /// attached — a restored machine whose embedder skipped every arm
    /// form — aborts at its first check point instead of running
    /// unbounded while reporting itself metered. The host callback
    /// cannot travel in a snapshot, so the only correct resume of an
    /// armed machine reattaches one; anything else is a configuration
    /// error, and the run halts [`Halt::MeterAbort`] rather than
    /// silently disabling the bound the snapshot says is in force. The
    /// rule fires only where checks fire: a crank with no loop-closing
    /// point (straight-line code) still completes on such a machine,
    /// exactly as an armed crank the host never refuses would.
    #[inline]
    pub(super) fn check_meter(&mut self) -> MeterCheck {
        match self.meter_host.as_mut() {
            Some(host) => self.meter.check(host),
            None if self.meter.is_armed() => MeterCheck::Abort,
            None => MeterCheck::Continue,
        }
    }

    /// Admission inside a built-in, including the restored/armed/no-host
    /// fail-closed case. Call before allocating or doing the charged work.
    pub(super) fn charge_and_check(&mut self, raw: u64) -> Result<(), Step> {
        let check = match self.meter_host.as_mut() {
            Some(host) => self.meter.charge_and_check(raw, host),
            None if self.meter.is_armed() => MeterCheck::Abort,
            None => self.meter.charge_and_check(raw, &mut |_| true),
        };
        if check == MeterCheck::Abort {
            Err(Step::Host(Halt::MeterAbort))
        } else {
            Ok(())
        }
    }

    pub(super) fn charge_builtin_work(&mut self, count: u64) -> Result<(), Step> {
        let raw = count
            .checked_mul(crate::meter::BUILTIN_METERING)
            .ok_or(Step::Host(Halt::MeterAbort))?;
        self.charge_and_check(raw)
    }

    pub(super) fn charge_chunk_work(&mut self, bytes: u64) -> Result<(), Step> {
        let aligned = bytes
            .checked_add(ironhorse_meter::CHUNK_ALIGNMENT - 1)
            .map(|n| n & !(ironhorse_meter::CHUNK_ALIGNMENT - 1))
            .and_then(|n| n.checked_add(ironhorse_meter::CHUNK_HEADER_BYTES))
            .and_then(|n| n.checked_mul(crate::meter::CHUNK_ALLOCATION_METERING))
            .ok_or(Step::Host(Halt::MeterAbort))?;
        self.charge_and_check(aligned)
    }

    /// Bound and prepay a UTF-16 result before its scratch buffer is created.
    /// The format ceiling is independent of the configurable heap policy.
    /// Finish with `new_reserved_string_units`, so the charge is paid once.
    pub(super) fn reserve_units(&mut self, units: u64) -> Result<usize, Step> {
        self.reserve_units_growth(0, units)
    }

    /// Grow an already prepaid string result, charging only the additional
    /// chunk cost. Every previous unit is still present in the result.
    pub(super) fn reserve_units_growth(
        &mut self,
        previous: u64,
        units: u64,
    ) -> Result<usize, Step> {
        if units > 0x7fff_ffff {
            return Err(self.catchable_range_error_msg("result too large".into()));
        }
        let units = units as usize;
        if !self.chunks.can_allocate(units * 2) {
            return Err(Step::Host(Halt::HeapExhausted));
        }
        let charge = |length: u64| {
            if length == 0 {
                0
            } else {
                string_chunk_cost(length)
            }
        };
        self.charge_and_check(charge(units as u64) - charge(previous))?;
        Ok(units)
    }

    /// Extend a string output only after admitting its complete new size.
    pub(super) fn extend_reserved_units<T: Copy>(
        &mut self,
        output: &mut Vec<T>,
        addition: &[T],
    ) -> Result<(), Step> {
        let length = output
            .len()
            .checked_add(addition.len())
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        let bytes = length
            .checked_mul(std::mem::size_of::<T>())
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        if !self.chunks.can_allocate(bytes) {
            return Err(Step::Host(Halt::HeapExhausted));
        }
        self.reserve_units_growth(output.len() as u64, length as u64)?;
        output
            .try_reserve(addition.len())
            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
        output.extend_from_slice(addition);
        Ok(())
    }

    /// Admit UTF-8 scratch bytes while pricing the stored UTF-16 code units.
    /// The running unit count avoids rescanning the accumulated result.
    pub(super) fn extend_reserved_text(
        &mut self,
        output: &mut Vec<u8>,
        addition: &[u8],
        units: &mut u64,
    ) -> Result<(), Step> {
        let added = String::from_utf8_lossy(addition).encode_utf16().count() as u64;
        let next = units
            .checked_add(added)
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        self.reserve_units_growth(*units, next)?;
        self.extend_prepaid_scratch(output, addition)?;
        *units = next;
        Ok(())
    }

    /// Bound an unmetered temporary by the heap profile before reserving it.
    /// Its caller prepays the operation's existing work charge first.
    pub(super) fn reserve_scratch<T>(&mut self, capacity: usize) -> Result<Vec<T>, Step> {
        self.admit_scratch::<T>(capacity)?;
        Self::reserved_vec(capacity)
    }

    /// Admit new element-wise scratch work, charged once before collecting it.
    /// Unlike `reserve_scratch`, the caller has no existing prepaid loop cost.
    pub(super) fn reserve_work_scratch<T>(&mut self, capacity: usize) -> Result<Vec<T>, Step> {
        self.admit_scratch::<T>(capacity)?;
        let raw = (capacity as u64)
            .checked_mul(crate::meter::BUILTIN_METERING)
            .ok_or(Step::Host(Halt::MeterAbort))?;
        self.charge_and_check(raw)?;
        Self::reserved_vec(capacity)
    }

    /// Bound each output expansion before copying, including `$` substitutions
    /// whose expansion can be much larger than the replacement template.
    pub(super) fn extend_work_scratch<T: Copy>(
        &mut self,
        output: &mut Vec<T>,
        addition: &[T],
    ) -> Result<(), Step> {
        let length = output
            .len()
            .checked_add(addition.len())
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        self.admit_scratch::<T>(length)?;
        let charge = (addition.len() as u64)
            .checked_mul(crate::meter::BUILTIN_METERING)
            .ok_or(Step::Host(Halt::MeterAbort))?;
        self.charge_and_check(charge)?;
        output
            .try_reserve(addition.len())
            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
        output.extend_from_slice(addition);
        Ok(())
    }

    pub(super) fn extend_prepaid_scratch<T: Copy>(
        &mut self,
        output: &mut Vec<T>,
        addition: &[T],
    ) -> Result<(), Step> {
        let length = output
            .len()
            .checked_add(addition.len())
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        self.admit_scratch::<T>(length)?;
        output
            .try_reserve(addition.len())
            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
        output.extend_from_slice(addition);
        Ok(())
    }

    pub(super) fn push_prepaid_scratch<T>(
        &mut self,
        output: &mut Vec<T>,
        value: T,
    ) -> Result<(), Step> {
        let length = output
            .len()
            .checked_add(1)
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        self.admit_scratch::<T>(length)?;
        output
            .try_reserve(1)
            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
        output.push(value);
        Ok(())
    }

    /// Fill an already admitted buffer without permitting a hidden resize.
    pub(super) fn fill_scratch<T>(
        mut buffer: Vec<T>,
        values: impl IntoIterator<Item = T>,
    ) -> Vec<T> {
        for value in values {
            if buffer.len() == buffer.capacity() {
                crate::value::heap_exhausted();
            }
            buffer.push(value);
        }
        buffer
    }

    pub(super) fn admit_scratch<T>(&mut self, capacity: usize) -> Result<(), Step> {
        let bytes = capacity
            .checked_mul(std::mem::size_of::<T>())
            .ok_or(Step::Host(Halt::HeapExhausted))?;
        if !self.chunks.can_allocate(bytes) {
            return Err(Step::Host(Halt::HeapExhausted));
        }
        self.charge_and_check(0)
    }

    /// Reserve a bounded representation copy for immutable host diagnostics.
    /// This helper cannot charge work; guest callers use their normal admission
    /// checkpoints. It is restricted to copies, never guest numeric lengths.
    pub(super) fn reserve_copy_scratch<T>(&self, capacity: usize) -> Vec<T> {
        let bytes = capacity
            .checked_mul(std::mem::size_of::<T>())
            .unwrap_or_else(|| crate::value::heap_exhausted());
        if !self.chunks.can_allocate(bytes) {
            crate::value::heap_exhausted();
        }
        Self::reserved_vec(capacity).unwrap_or_else(|_| crate::value::heap_exhausted())
    }

    /// Materialize a capacity already admitted by `reserve_units` or a chunk
    /// admission check. Host allocator refusal is also an execution halt.
    pub(super) fn reserved_vec<T>(capacity: usize) -> Result<Vec<T>, Step> {
        let mut buffer = Vec::new();
        buffer
            .try_reserve_exact(capacity)
            .map_err(|_| Step::Host(Halt::HeapExhausted))?;
        Ok(buffer)
    }

    pub(super) fn new_reserved_string_units(&mut self, units: &[u16]) -> Slot {
        let off = self.chunks.alloc(&units_to_be16(units));
        Slot::of(Kind::String, Payload::String(off))
    }

    /// Accrue the program-frame + eval-environment setup overhead, once,
    /// at the `BEGIN_*` program-entry opcode: the invocation baseline
    /// ([`PROGRAM_INVOCATION_COMPUTRONS`] dispatches XS meters in the
    /// caller frame before the captured bytecode) plus the measured
    /// environment-setup aggregate ([`PROGRAM_ENV_SETUP_METERING`]). Both
    /// are raw 16.16 units so they compose with the allocation metering
    /// through the carry into computrons. Synthetic bytecode that never
    /// executes a `BEGIN_*` (the meter unit tests) never accrues it.
    #[inline]
    pub(super) fn tick_program_overhead(&mut self) {
        self.meter
            .tick_raw(PROGRAM_INVOCATION_COMPUTRONS * crate::meter::CODE_METERING);
        self.meter.tick_raw(PROGRAM_ENV_SETUP_METERING);
    }

    /// Adjust the meter for an uncaught throw escaping to the host: the
    /// escaping opcode's dispatch metering (added at the top of the loop)
    /// is removed — XS never meters it, its `mxBreak` bypassed by the
    /// longjmp — and the fixed host-boundary constant
    /// [`THROW_HOST_ESCAPE_METERING`] is accrued instead.
    #[inline]
    pub(super) fn meter_host_escape(&mut self) {
        self.meter.untick_code();
        self.meter.tick_raw(THROW_HOST_ESCAPE_METERING);
    }

    /// Reverse [`Self::meter_host_escape`]: a throw that reached the host
    /// boundary of a re-entrant [`Self::run_callback`] was actually caught by a
    /// native `mxTry` (a promise reaction handler or a thenable `then`), so XS
    /// never left the machine — restore the escaping opcode's dispatch tick and
    /// remove the speculative host-boundary residual, leaving just the plain
    /// `throw` opcode metering XS's `fxJump`-to-`mxCatch` path incurs.
    #[inline]
    pub(super) fn unmeter_host_escape(&mut self) {
        self.meter.tick_code();
        self.meter.untick_raw(THROW_HOST_ESCAPE_METERING);
    }
}
