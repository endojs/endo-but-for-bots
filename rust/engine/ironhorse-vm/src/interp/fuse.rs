//! Derived dispatch buffers: the host-side switch.
//!
//! Dispatch fusion (round-2 plan, `PORFFOR-ROUND2-PLAN.md` A.4 and B.4)
//! keeps every bytecode buffer exactly as the compiler and linker produced
//! it and derives, beside it, a dispatch buffer of the same length. The
//! switch below lets a differential test run the same program with and
//! without the derived buffers; nothing observable may depend on it.
use super::Interp;

impl Interp {
    /// Allow (`true`, the default) or forbid dispatch over derived dispatch
    /// buffers. Results, computrons, the meter host's check sequence, slot
    /// and chunk allocation and snapshot bytes are identical either way; the
    /// switch exists so a test can prove that. It is host state: it is not
    /// persisted, and a restored machine starts with the default.
    pub fn set_dispatch_fusion(&mut self, enabled: bool) {
        self.dispatch_fusion = enabled;
    }

    /// Whether dispatch may use derived dispatch buffers
    /// ([`Self::set_dispatch_fusion`]).
    pub fn dispatch_fusion(&self) -> bool {
        self.dispatch_fusion
    }
}
