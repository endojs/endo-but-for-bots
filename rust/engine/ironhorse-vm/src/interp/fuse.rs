//! Derived dispatch buffers: layout-preserving superinstructions.
//!
//! Round 2 of the performance campaign (`PORFFOR-ROUND2-PLAN.md` A.4 and
//! B.4). Every bytecode buffer stays exactly as the compiler and linker
//! produced it: operands, relink walks, look-ahead readers, catch-target
//! identity checks, persistence and restore validation all keep reading the
//! canonical bytes. Beside a buffer, [`derive`] builds a **dispatch buffer**
//! of the same length that differs only at selected instruction starts,
//! where the opcode byte is replaced by a tag from the range XS leaves
//! unused (`246..=255`, above `XS_CODE_COUNT`). The dispatch loop decodes
//! the canonical bytes as always; only the arm of an opcode that can head a
//! sequence (today `GET_LOCAL`) asks [`Interp::fused_tag`] whether the
//! dispatch buffer carries a tag at its pc, so every other opcode's
//! dispatch is unchanged. A tag at `A` names a short straight-line sequence
//! `A, B, ...`; after the loop has checked, charged and counted `A` as
//! usual, [`Interp::run_fused`] runs `A` and the members after it as one
//! step.
//!
//! # Why every entry pc stays correct
//!
//! The non-head instructions of a fused sequence keep their canonical
//! opcode bytes in the dispatch buffer, so a pc that lands on one (a branch
//! target, a catch target, a generator's or async function's `resume_pc`,
//! a callback's `body_start`) dispatches that instruction normally: no pc
//! anywhere changes meaning. A sequence's members run in straight line
//! (only the last may branch), so reaching its head and running every
//! member is exactly what sequential dispatch from the head does, however
//! the head was reached. A tag is written only where the canonical byte is
//! an opcode, so a canonical byte that is itself out of the opcode range
//! (corrupt code) is never taken for a tag.
//!
//! # Why computrons and meter checks stay identical
//!
//! [`Interp::run_fused`] runs a sequence of `k` instructions only when none
//! of the `k - 1` loop tops it skips would have done anything:
//!
//! 1. no skipped top would run the 4096-dispatch meter check or reach the
//!    step limit (they would see the dispatch counts `n ..= n + k - 2`,
//!    `n` counting the head); the bounded-mode slot ceiling and the
//!    id-space latch cannot change, because no member allocates or interns;
//! 2. every member is total once its guards pass: no member can call guest
//!    code, allocate, intern, suspend, read the meter or throw, and every
//!    guard (operand kinds, Integer range, binding initialised and mutable)
//!    is evaluated before any effect;
//! 3. with the head's own unit it charges `k` code units, adds `k`
//!    dispatches, records each member in the cost-calibration histogram, and performs a closing backward
//!    branch's meter check after all `k` ticks, which is where sequential
//!    dispatch performs it;
//! 4. under `cfg(test)`, the `GC_AT_STEP`/`PANIC_AT_STEP` hooks see every
//!    count: fusion stands aside while either is armed.
//!
//! When any condition fails it answers [`Fused::Plain`] and the head's arm
//! runs as usual, continuing at the next canonical pc. Correctness never depends on a dispatch buffer existing:
//! a buffer without one dispatches over its canonical bytes.
//!
//! # Lifetime
//!
//! Dispatch buffers are host state, like `property_index`: never persisted,
//! never charged (their size equals the bytecode they shadow), rebuilt when
//! a buffer is installed (crank entry, an `eval` or `Function` unit, the
//! promotion of a crank's buffer to a segment, and restore). Bytecode
//! buffers are immutable `Rc<[u8]>`s, and relinking produces a new buffer,
//! so a dispatch buffer can never describe stale bytes. Each entry holds
//! its canonical `Rc`, which keeps the address it is keyed by from being
//! reused while the entry exists; the one-entry cache the arms consult
//! holds a dispatch buffer only while its entry exists.
use std::rc::Rc;

use super::numeric::apply_arith;
use super::{branch_target, ArithOp, BitOp, Interp, Kind, MeterCheck, Opcode, Payload, Slot};
use crate::opcode::encoded_instruction_len;

/// The first tag value: one past the last XS opcode.
pub(super) const FIRST_TAG: u8 = crate::opcode::XS_CODE_COUNT as u8;

/// `GET_LOCAL k; INTEGER c; LESS|LESS_EQUAL|MORE|MORE_EQUAL; BRANCH_ELSE`:
/// a loop test against a constant, on an Integer local.
const TAG_LOCAL_CONST_TEST: u8 = FIRST_TAG;
/// `GET_LOCAL k; INCREMENT|DECREMENT; SET_LOCAL k'; POP`: a `for` update.
const TAG_LOCAL_STEP: u8 = FIRST_TAG + 1;
/// [`TAG_LOCAL_STEP`] followed by `BRANCH`: `i++` closing a loop.
const TAG_LOCAL_STEP_BRANCH: u8 = FIRST_TAG + 2;
/// `GET_LOCAL k; INTEGER c; <arithmetic or bitwise operator>`.
const TAG_LOCAL_CONST_OP: u8 = FIRST_TAG + 3;
/// `GET_LOCAL a; GET_LOCAL b`.
const TAG_LOCAL_PAIR: u8 = FIRST_TAG + 4;
/// `GET_LOCAL a; GET_LOCAL b; <arithmetic or bitwise operator>`.
const TAG_LOCAL_LOCAL_OP: u8 = FIRST_TAG + 5;
/// `GET_LOCAL a; GET_LOCAL b; <relational operator>; BRANCH_ELSE`.
const TAG_LOCAL_LOCAL_TEST: u8 = FIRST_TAG + 6;
/// `INTEGER c; <arithmetic or bitwise operator>` on the stack top.
const TAG_CONST_OP: u8 = FIRST_TAG + 7;
/// `INTEGER c; <relational operator>; BRANCH_ELSE` on the stack top.
const TAG_CONST_TEST: u8 = FIRST_TAG + 8;
/// `<relational operator>; BRANCH_ELSE` on the top two stack slots.
const TAG_TEST: u8 = FIRST_TAG + 9;

/// What [`Interp::run_fused`] did.
pub(super) enum Fused {
    /// Ran the whole sequence; continue here.
    Next(usize),
    /// Ran the whole sequence, and its closing branch's meter check refused.
    MeterAbort,
    /// Declined: dispatch the head's canonical opcode as usual.
    Plain,
}

/// The dispatch buffers of the installed bytecode buffers, keyed by the
/// canonical buffer's address.
#[derive(Default)]
pub(super) struct DispatchBuffers {
    /// Canonical buffer address to (canonical buffer, dispatch buffer). The
    /// entry's canonical `Rc` keeps that address from being reused.
    entries: crate::int_hash::IntMap<usize, (Rc<[u8]>, Rc<[u8]>)>,
    /// The canonical buffer address the arms last asked about, and its
    /// dispatch buffer. A `Some` is always the dispatch buffer of an entry of
    /// `entries`, so the address cannot have been reused; a `None` only
    /// costs fusion until the next refresh. Address `0` names no buffer.
    current: (usize, Option<Rc<[u8]>>),
    /// Entries left after the last sweep, which sets the next one's size.
    swept: usize,
}

impl DispatchBuffers {
    /// Drop entries whose canonical buffer nothing else holds, once the
    /// table has doubled since the last sweep (amortised constant per
    /// install).
    fn sweep(&mut self) {
        if self.entries.len() < 2 * self.swept.max(16) {
            return;
        }
        self.current = (0, None);
        self.entries
            .retain(|_, (canonical, _)| Rc::strong_count(canonical) > 1);
        self.swept = self.entries.len();
    }
}

impl Interp {
    /// Allow (`true`, the default) or forbid dispatch over derived dispatch
    /// buffers. Results, computrons, the meter host's check sequence, slot
    /// and chunk allocation and snapshot bytes are identical either way; the
    /// switch exists so a test can prove that. It is host state: it is not
    /// persisted, and a restored machine starts with the default. Buffers
    /// installed while it is off have no dispatch buffer and dispatch over
    /// their canonical bytes.
    pub fn set_dispatch_fusion(&mut self, enabled: bool) {
        self.dispatch_fusion = enabled;
        if !enabled {
            self.dispatch_buffers = DispatchBuffers::default();
        }
    }

    /// Whether dispatch may use derived dispatch buffers
    /// ([`Self::set_dispatch_fusion`]).
    pub fn dispatch_fusion(&self) -> bool {
        self.dispatch_fusion
    }

    /// Build and remember the dispatch buffer of an installed bytecode
    /// buffer. Idempotent; a buffer with nothing to fuse gets no entry.
    pub(super) fn install_dispatch_buffer(&mut self, canonical: &Rc<[u8]>) {
        if !self.dispatch_fusion || canonical.is_empty() {
            return;
        }
        let key = canonical.as_ptr() as usize;
        if self.dispatch_buffers.entries.contains_key(&key) {
            return;
        }
        if let Some(derived) = derive(canonical) {
            self.dispatch_buffers.sweep();
            // A negative cache for this address must not outlive the entry.
            self.dispatch_buffers.current = (0, None);
            self.dispatch_buffers
                .entries
                .insert(key, (canonical.clone(), derived));
        }
    }

    /// The tag the dispatch buffer of `code` carries at `pc`, if `pc` heads
    /// a fused sequence there. Called only from the arms of opcodes that
    /// can head one.
    #[inline(always)]
    pub(super) fn fused_tag(&mut self, code: &[u8], pc: usize) -> Option<u8> {
        if self.dispatch_buffers.current.0 != code.as_ptr() as usize {
            self.refresh_dispatch_buffer(code);
        }
        let tag = *self.dispatch_buffers.current.1.as_deref()?.get(pc)?;
        (tag >= FIRST_TAG).then_some(tag)
    }

    /// Point the arms' one-entry cache at `code`'s dispatch buffer, or at
    /// none when it has none.
    #[inline(never)]
    fn refresh_dispatch_buffer(&mut self, code: &[u8]) {
        let key = code.as_ptr() as usize;
        let derived = self
            .dispatch_buffers
            .entries
            .get(&key)
            .filter(|(canonical, _)| canonical.len() == code.len())
            .map(|(_, derived)| derived.clone());
        self.dispatch_buffers.current = (key, derived);
    }

    /// Run the rest of the fused sequence whose head, at `pc`, carries
    /// `tag` in the dispatch buffer (module documentation). The loop has
    /// already checked, charged and counted the head.
    #[inline(always)]
    pub(super) fn run_fused(&mut self, code: &[u8], pc: usize, tag: u8) -> Fused {
        #[cfg(test)]
        {
            if super::tests::GC_AT_STEP.with(|step| step.get().is_some())
                || super::tests::PANIC_AT_STEP.with(|step| step.get().is_some())
            {
                return Fused::Plain;
            }
        }
        match tag {
            TAG_LOCAL_CONST_TEST => self.fused_local_const_test(code, pc),
            TAG_LOCAL_STEP => self.fused_local_step(code, pc, false),
            TAG_LOCAL_STEP_BRANCH => self.fused_local_step(code, pc, true),
            TAG_LOCAL_CONST_OP => self.fused_local_const_op(code, pc),
            TAG_LOCAL_PAIR => self.fused_local_pair(code, pc),
            TAG_LOCAL_LOCAL_OP => self.fused_local_local_op(code, pc),
            TAG_LOCAL_LOCAL_TEST => self.fused_local_local_test(code, pc),
            TAG_CONST_OP => self.fused_const_op(code, pc),
            TAG_CONST_TEST => self.fused_const_test(code, pc),
            TAG_TEST => self.fused_test(code, pc),
            _ => Fused::Plain,
        }
    }

    /// Whether a `k`-instruction sequence whose head has just been counted
    /// can run its other members without skipping a loop top that would
    /// have checked the meter or hit the step limit: the skipped tops see
    /// the dispatch counts `n ..= n + k - 2`.
    #[inline(always)]
    fn fusion_admits(&self, k: u64) -> bool {
        let n = self.n_dispatched;
        let phase = n & 4095;
        // The head's loop top checked `n - 1 < step_limit`, so `n <=
        // step_limit` and the subtraction cannot wrap.
        phase != 0 && phase + (k - 2) < 4096 && self.step_limit - n > k - 2
    }

    /// Charge and count the `k` members that follow the head, the first at
    /// `pc`, as the loop would, one per member.
    #[inline(always)]
    fn tick_fused(&mut self, code: &[u8], pc: usize, k: u64) {
        self.meter.tick_code_n(k);
        self.n_dispatched += k;
        #[cfg(feature = "cost-calibration")]
        {
            let mut at = pc;
            for _ in 0..k {
                let (Some(op), Some(len)) =
                    (Opcode::from_u8(code[at]), encoded_instruction_len(code, at))
                else {
                    return;
                };
                self.cost.on_dispatch(op);
                self.cost.on_sequence(at, len);
                at += len;
            }
        }
        #[cfg(not(feature = "cost-calibration"))]
        let _ = (code, pc);
    }

    /// A taken branch at `at` closing a fused sequence: XS's `mxBranch`
    /// checks the meter when the offset is negative.
    #[inline(always)]
    fn fused_branch(&mut self, at: usize, size: usize, offset: i32) -> Fused {
        if offset < 0 && self.check_meter() == MeterCheck::Abort {
            return Fused::MeterAbort;
        }
        Fused::Next(branch_target(at, size as i8, offset))
    }

    /// [`TAG_LOCAL_CONST_TEST`].
    #[inline(never)]
    fn fused_local_const_test(&mut self, code: &[u8], pc: usize) -> Fused {
        if !self.fusion_admits(4) {
            return Fused::Plain;
        }
        let (k, after_head) = local_operand(code, pc);
        let at = after_head;
        let Some((Kind::Integer, Payload::Integer(x))) =
            self.get_local(k).map(|s| (s.kind, s.value))
        else {
            return Fused::Plain;
        };
        let (c, at) = integer_operand(code, at);
        self.tick_fused(code, after_head, 3);
        self.fused_branch_else(code, at, relate(code[at], x, c))
    }

    /// The `<relational operator>; BRANCH_ELSE` tail at `at`, its test
    /// already computed: BRANCH_ELSE falls through on `true` with no meter
    /// check and branches on `false`.
    #[inline(always)]
    fn fused_branch_else(&mut self, code: &[u8], at: usize, test: bool) -> Fused {
        let branch = at + 1;
        let (offset, size) = branch_operand(code, branch);
        if test {
            Fused::Next(branch + size)
        } else {
            self.fused_branch(branch, size, offset)
        }
    }

    /// [`TAG_LOCAL_PAIR`]: both pushes, as `GET_LOCAL` makes them.
    #[inline(never)]
    fn fused_local_pair(&mut self, code: &[u8], pc: usize) -> Fused {
        if !self.fusion_admits(2) {
            return Fused::Plain;
        }
        let (a, after_head) = local_operand(code, pc);
        let (b, after) = local_operand(code, after_head);
        let (Some(first), Some(second)) = (self.get_local(a), self.get_local(b)) else {
            return Fused::Plain;
        };
        self.push(first);
        self.push(second);
        self.tick_fused(code, after_head, 1);
        Fused::Next(after)
    }

    /// [`TAG_LOCAL_LOCAL_OP`]: the operator's Number fast path on two
    /// locals.
    #[inline(never)]
    fn fused_local_local_op(&mut self, code: &[u8], pc: usize) -> Fused {
        if !self.fusion_admits(3) {
            return Fused::Plain;
        }
        let (a, after_head) = local_operand(code, pc);
        let (b, at) = local_operand(code, after_head);
        let (Some(first), Some(second)) = (self.get_local(a), self.get_local(b)) else {
            return Fused::Plain;
        };
        let Some(result) = number_operator(code[at], &first, &second) else {
            return Fused::Plain;
        };
        self.push(result);
        self.tick_fused(code, after_head, 2);
        Fused::Next(at + 1)
    }

    /// [`TAG_LOCAL_LOCAL_TEST`], on two Integer locals.
    #[inline(never)]
    fn fused_local_local_test(&mut self, code: &[u8], pc: usize) -> Fused {
        if !self.fusion_admits(4) {
            return Fused::Plain;
        }
        let (a, after_head) = local_operand(code, pc);
        let (b, at) = local_operand(code, after_head);
        let (Some(first), Some(second)) = (self.get_local(a), self.get_local(b)) else {
            return Fused::Plain;
        };
        let (Payload::Integer(x), Payload::Integer(y)) = (first.value, second.value) else {
            return Fused::Plain;
        };
        if first.kind != Kind::Integer || second.kind != Kind::Integer {
            return Fused::Plain;
        }
        self.tick_fused(code, after_head, 3);
        self.fused_branch_else(code, at, relate(code[at], x, y))
    }

    /// [`TAG_CONST_OP`]: the operator's Number fast path on the stack top
    /// and the literal, which replace the top as the unfused pair would.
    #[inline(never)]
    fn fused_const_op(&mut self, code: &[u8], pc: usize) -> Fused {
        if !self.fusion_admits(2) {
            return Fused::Plain;
        }
        let (c, at) = integer_operand(code, pc);
        let Some(&top) = self.stack.last() else {
            return Fused::Plain;
        };
        let Some(result) = number_operator(code[at], &top, &Slot::integer(c)) else {
            return Fused::Plain;
        };
        if let Some(slot) = self.stack.last_mut() {
            *slot = result;
        }
        self.tick_fused(code, at, 1);
        Fused::Next(at + 1)
    }

    /// [`TAG_CONST_TEST`]: an Integer stack top against the literal; the
    /// top is consumed as BRANCH_ELSE consumes the comparison.
    #[inline(never)]
    fn fused_const_test(&mut self, code: &[u8], pc: usize) -> Fused {
        if !self.fusion_admits(3) {
            return Fused::Plain;
        }
        let (c, at) = integer_operand(code, pc);
        let Some(&top) = self.stack.last() else {
            return Fused::Plain;
        };
        let (Kind::Integer, Payload::Integer(x)) = (top.kind, top.value) else {
            return Fused::Plain;
        };
        self.stack.pop();
        self.tick_fused(code, at, 2);
        self.fused_branch_else(code, at, relate(code[at], x, c))
    }

    /// [`TAG_TEST`]: two Integer stack slots, both consumed.
    #[inline(never)]
    fn fused_test(&mut self, code: &[u8], pc: usize) -> Fused {
        if !self.fusion_admits(2) {
            return Fused::Plain;
        }
        let [.., first, second] = self.stack[..] else {
            return Fused::Plain;
        };
        let (Kind::Integer, Payload::Integer(x), Kind::Integer, Payload::Integer(y)) =
            (first.kind, first.value, second.kind, second.value)
        else {
            return Fused::Plain;
        };
        let n = self.stack.len();
        self.stack.truncate(n - 2);
        self.tick_fused(code, pc + 1, 1);
        self.fused_branch_else(code, pc, relate(code[pc], x, y))
    }

    /// [`TAG_LOCAL_STEP`] and [`TAG_LOCAL_STEP_BRANCH`].
    #[inline(never)]
    fn fused_local_step(&mut self, code: &[u8], pc: usize, closes: bool) -> Fused {
        if !self.fusion_admits(if closes { 5 } else { 4 }) {
            return Fused::Plain;
        }
        let (k, after_head) = local_operand(code, pc);
        let Some((Kind::Integer, Payload::Integer(v))) =
            self.get_local(k).map(|s| (s.kind, s.value))
        else {
            return Fused::Plain;
        };
        // `step_integer_in_place`'s Integer half: XS promotes at INT_MAX for
        // increment and at -INT_MAX for decrement; both stay unfused.
        let stepped = if code[after_head] == Opcode::XS_CODE_INCREMENT as u8 {
            v.checked_add(1)
        } else {
            v.checked_sub(1)
        };
        let stepped = match stepped {
            Some(n) if n != i32::MIN => n,
            _ => return Fused::Plain,
        };
        let (target, at) = local_operand(code, after_head + 1);
        // An immutable or uninitialised target is SET_LOCAL's guarded write.
        if self.local_write_is_guarded(target) {
            return Fused::Plain;
        }
        self.set_local(target, Slot::integer(stepped));
        let after_pop = at + 1;
        if !closes {
            self.tick_fused(code, after_head, 3);
            return Fused::Next(after_pop);
        }
        let (offset, size) = branch_operand(code, after_pop);
        self.tick_fused(code, after_head, 4);
        self.fused_branch(after_pop, size, offset)
    }

    /// [`TAG_LOCAL_CONST_OP`]: the operator's own Number fast path, which
    /// is what the unfused operator runs on two Number operands.
    #[inline(never)]
    fn fused_local_const_op(&mut self, code: &[u8], pc: usize) -> Fused {
        if !self.fusion_admits(3) {
            return Fused::Plain;
        }
        let (k, after_head) = local_operand(code, pc);
        let at = after_head;
        let Some(local) = self.get_local(k) else {
            return Fused::Plain;
        };
        let (c, at) = integer_operand(code, at);
        let Some(result) = number_operator(code[at], &local, &Slot::integer(c)) else {
            return Fused::Plain;
        };
        self.push(result);
        self.tick_fused(code, after_head, 2);
        Fused::Next(at + 1)
    }
}

/// A `GET_LOCAL`/`SET_LOCAL` scope index and the pc after the instruction.
#[inline(always)]
fn local_operand(code: &[u8], pc: usize) -> (usize, usize) {
    let byte = code[pc];
    if byte == Opcode::XS_CODE_GET_LOCAL_2 as u8 || byte == Opcode::XS_CODE_SET_LOCAL_2 as u8 {
        (u16::from_le_bytes(operand_bytes(code, pc)) as usize, pc + 3)
    } else {
        (code[pc + 1] as usize, pc + 2)
    }
}

/// An `INTEGER_1/2/4` literal and the pc after the instruction.
#[inline(always)]
fn integer_operand(code: &[u8], pc: usize) -> (i32, usize) {
    let byte = code[pc];
    if byte == Opcode::XS_CODE_INTEGER_1 as u8 {
        (code[pc + 1] as i8 as i32, pc + 2)
    } else if byte == Opcode::XS_CODE_INTEGER_2 as u8 {
        (i16::from_le_bytes(operand_bytes(code, pc)) as i32, pc + 3)
    } else {
        (i32::from_le_bytes(operand_bytes(code, pc)), pc + 5)
    }
}

/// A `BRANCH*_1/2/4` offset and the instruction's size.
#[inline(always)]
fn branch_operand(code: &[u8], pc: usize) -> (i32, usize) {
    let byte = code[pc];
    if byte == Opcode::XS_CODE_BRANCH_1 as u8 || byte == Opcode::XS_CODE_BRANCH_ELSE_1 as u8 {
        (code[pc + 1] as i8 as i32, 2)
    } else if byte == Opcode::XS_CODE_BRANCH_2 as u8 || byte == Opcode::XS_CODE_BRANCH_ELSE_2 as u8
    {
        (i16::from_le_bytes(operand_bytes(code, pc)) as i32, 3)
    } else {
        (i32::from_le_bytes(operand_bytes(code, pc)), 5)
    }
}

/// The `N` operand bytes after the opcode at `pc`, with one bounds check.
#[inline(always)]
fn operand_bytes<const N: usize>(code: &[u8], pc: usize) -> [u8; N] {
    let mut bytes = [0; N];
    bytes.copy_from_slice(&code[pc + 1..pc + 1 + N]);
    bytes
}

/// The result the unfused operator at `byte` computes on two operands
/// when both take its Number fast path, or `None` when one would not: an
/// arithmetic operator's fast path takes either Number representation
/// (`binary_arith`, `op_add`), a bitwise one is taken here only on two
/// Integers, whose `ToInt32` is the payload.
#[inline(always)]
fn number_operator(byte: u8, a: &Slot, b: &Slot) -> Option<Slot> {
    if let Some(op) = arith_operator(byte) {
        let numbers = matches!(a.kind, Kind::Integer | Kind::Number)
            && matches!(b.kind, Kind::Integer | Kind::Number);
        return numbers.then(|| apply_arith(op, a, b));
    }
    let op = bit_operator(byte)?;
    match (a.kind, a.value, b.kind, b.value) {
        (Kind::Integer, Payload::Integer(x), Kind::Integer, Payload::Integer(y)) => {
            Some(super::coerce::int32_bit_result(op, x, y))
        }
        _ => None,
    }
}

/// The relational operator at `byte` on two Integers: exact, as
/// `relational`'s Integer arm is. The builder admits only the four.
#[inline(always)]
fn relate(byte: u8, x: i32, y: i32) -> bool {
    if byte == Opcode::XS_CODE_LESS as u8 {
        x < y
    } else if byte == Opcode::XS_CODE_LESS_EQUAL as u8 {
        x <= y
    } else if byte == Opcode::XS_CODE_MORE as u8 {
        x > y
    } else {
        x >= y
    }
}

fn arith_operator(byte: u8) -> Option<ArithOp> {
    Some(match Opcode::from_u8(byte)? {
        Opcode::XS_CODE_ADD => ArithOp::Add,
        Opcode::XS_CODE_SUBTRACT => ArithOp::Sub,
        Opcode::XS_CODE_MULTIPLY => ArithOp::Mul,
        Opcode::XS_CODE_DIVIDE => ArithOp::Div,
        Opcode::XS_CODE_MODULO => ArithOp::Mod,
        _ => return None,
    })
}

fn bit_operator(byte: u8) -> Option<BitOp> {
    Some(match Opcode::from_u8(byte)? {
        Opcode::XS_CODE_BIT_AND => BitOp::And,
        Opcode::XS_CODE_BIT_OR => BitOp::Or,
        Opcode::XS_CODE_BIT_XOR => BitOp::Xor,
        Opcode::XS_CODE_LEFT_SHIFT => BitOp::Shl,
        Opcode::XS_CODE_SIGNED_RIGHT_SHIFT => BitOp::Sar,
        Opcode::XS_CODE_UNSIGNED_RIGHT_SHIFT => BitOp::Shr,
        _ => return None,
    })
}

/// One decoded instruction of a canonical buffer: its opcode and length,
/// or `None` past the end, on an unknown opcode or a truncated instruction.
fn instruction(code: &[u8], pc: usize) -> Option<(Opcode, usize)> {
    let op = Opcode::from_u8(*code.get(pc)?)?;
    let len = encoded_instruction_len(code, pc).filter(|&len| len > 0)?;
    (pc.checked_add(len)? <= code.len()).then_some((op, len))
}

fn is_relational(op: Opcode) -> bool {
    use Opcode::*;
    matches!(
        op,
        XS_CODE_LESS | XS_CODE_LESS_EQUAL | XS_CODE_MORE | XS_CODE_MORE_EQUAL
    )
}

fn is_branch_else(op: Opcode) -> bool {
    use Opcode::*;
    matches!(
        op,
        XS_CODE_BRANCH_ELSE_1 | XS_CODE_BRANCH_ELSE_2 | XS_CODE_BRANCH_ELSE_4
    )
}

fn is_number_operator(op: Opcode) -> bool {
    arith_operator(op as u8).is_some() || bit_operator(op as u8).is_some()
}

/// The length of a `<relational operator>; BRANCH_ELSE` pair at `pc`.
fn test_at(code: &[u8], pc: usize) -> Option<usize> {
    let (relation, l0) = instruction(code, pc)?;
    let (branch, l1) = instruction(code, pc + l0)?;
    (is_relational(relation) && is_branch_else(branch)).then_some(l0 + l1)
}

/// The tag and length (bytes) of the fused sequence that starts at `pc`,
/// if any, the longest first. Pure in the canonical bytes.
fn fusion_at(code: &[u8], pc: usize) -> Option<(u8, usize)> {
    use Opcode::*;
    let (head, l0) = instruction(code, pc)?;
    match head {
        XS_CODE_GET_LOCAL_1 | XS_CODE_GET_LOCAL_2 => {}
        XS_CODE_INTEGER_1 | XS_CODE_INTEGER_2 | XS_CODE_INTEGER_4 => {
            if let Some(test) = test_at(code, pc + l0) {
                return Some((TAG_CONST_TEST, l0 + test));
            }
            let (second, l1) = instruction(code, pc + l0)?;
            return is_number_operator(second).then_some((TAG_CONST_OP, l0 + l1));
        }
        _ if is_relational(head) => return test_at(code, pc).map(|test| (TAG_TEST, test)),
        _ => return None,
    }
    let (second, l1) = instruction(code, pc + l0)?;
    let at = pc + l0 + l1;
    match second {
        XS_CODE_INTEGER_1 | XS_CODE_INTEGER_2 | XS_CODE_INTEGER_4 => {
            if let Some(test) = test_at(code, at) {
                return Some((TAG_LOCAL_CONST_TEST, l0 + l1 + test));
            }
            let (third, l2) = instruction(code, at)?;
            is_number_operator(third).then_some((TAG_LOCAL_CONST_OP, l0 + l1 + l2))
        }
        XS_CODE_GET_LOCAL_1 | XS_CODE_GET_LOCAL_2 => {
            if let Some(test) = test_at(code, at) {
                return Some((TAG_LOCAL_LOCAL_TEST, l0 + l1 + test));
            }
            match instruction(code, at) {
                Some((third, l2)) if is_number_operator(third) => {
                    Some((TAG_LOCAL_LOCAL_OP, l0 + l1 + l2))
                }
                _ => Some((TAG_LOCAL_PAIR, l0 + l1)),
            }
        }
        XS_CODE_INCREMENT | XS_CODE_DECREMENT => {
            let (third, l2) = instruction(code, at)?;
            if !matches!(third, XS_CODE_SET_LOCAL_1 | XS_CODE_SET_LOCAL_2) {
                return None;
            }
            let (fourth, l3) = instruction(code, at + l2)?;
            if fourth != XS_CODE_POP {
                return None;
            }
            let step = l0 + l1 + l2 + l3;
            match instruction(code, pc + step) {
                Some((XS_CODE_BRANCH_1 | XS_CODE_BRANCH_2 | XS_CODE_BRANCH_4, l4)) => {
                    Some((TAG_LOCAL_STEP_BRANCH, step + l4))
                }
                _ => Some((TAG_LOCAL_STEP, step)),
            }
        }
        _ => None,
    }
}

/// The dispatch buffer of `code`: a copy with each fused sequence's head
/// opcode replaced by its tag, or `None` when nothing fuses. Walks the
/// buffer as the disassembler and the relink walk do (function bodies
/// follow their `CODE` instruction inline) and stops at the first
/// instruction it cannot decode, leaving the rest canonical.
/// Whether the sequence `tag` at `pc` (first instruction `len` bytes,
/// `span` bytes in all) has only two members and a sequence of three or
/// more starts at its second member.
fn pair_gives_way(code: &[u8], pc: usize, len: usize, tag: u8, span: usize) -> bool {
    let pair = matches!(tag, TAG_LOCAL_PAIR | TAG_CONST_OP | TAG_TEST)
        && instruction(code, pc + len).is_some_and(|(_, second)| len + second == span);
    pair && fusion_at(code, pc + len)
        .is_some_and(|(next, _)| !matches!(next, TAG_LOCAL_PAIR | TAG_CONST_OP | TAG_TEST))
}

pub(super) fn derive(code: &[u8]) -> Option<Rc<[u8]>> {
    let mut derived: Option<Vec<u8>> = None;
    let mut pc = 0;
    while let Some((_, len)) = instruction(code, pc) {
        match fusion_at(code, pc) {
            // A two-instruction sequence gives way to a longer one that
            // starts at its second instruction (`a; b; c * 3` fuses as
            // `a`, then `b; 3; *`, not as `a; b`, then `3; *`).
            Some((tag, span)) if !pair_gives_way(code, pc, len, tag, span) => {
                derived.get_or_insert_with(|| code.to_vec())[pc] = tag;
                pc += span;
            }
            _ => pc += len,
        }
    }
    derived.map(Rc::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b(op: Opcode) -> u8 {
        op as u8
    }

    #[test]
    fn a_dispatch_buffer_differs_only_at_sequence_heads() {
        use Opcode::*;
        let code = [
            b(XS_CODE_GET_LOCAL_1),
            1,
            b(XS_CODE_INTEGER_4),
            0x40,
            0x42,
            0x0f,
            0,
            b(XS_CODE_LESS),
            b(XS_CODE_BRANCH_ELSE_1),
            9,
            b(XS_CODE_GET_LOCAL_1),
            1,
            b(XS_CODE_INCREMENT),
            b(XS_CODE_SET_LOCAL_1),
            1,
            b(XS_CODE_POP),
            b(XS_CODE_BRANCH_1),
            (-18i8) as u8,
            b(XS_CODE_END),
        ];
        let derived = derive(&code).expect("two sequences fuse");
        assert_eq!(derived.len(), code.len());
        let changed: Vec<usize> = (0..code.len()).filter(|&i| derived[i] != code[i]).collect();
        assert_eq!(changed, [0, 10]);
        assert_eq!(derived[0], TAG_LOCAL_CONST_TEST);
        assert_eq!(derived[10], TAG_LOCAL_STEP_BRANCH);
    }

    #[test]
    fn nothing_to_fuse_builds_nothing_and_corrupt_code_stops_the_walk() {
        use Opcode::*;
        assert!(derive(&[b(XS_CODE_UNDEFINED), b(XS_CODE_END)]).is_none());
        // An undecodable byte first: the walk stops before the sequence.
        let code = [
            250,
            b(XS_CODE_GET_LOCAL_1),
            1,
            b(XS_CODE_INTEGER_1),
            3,
            b(XS_CODE_ADD),
        ];
        assert!(derive(&code).is_none());
        // A sequence truncated by the end of the buffer does not fuse.
        assert!(derive(&code[1..5]).is_none());
        assert_eq!(derive(&code[1..]).unwrap()[0], TAG_LOCAL_CONST_OP);
    }
}
