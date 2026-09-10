//! VM-facing bigint builtin algorithms.
use super::super::*;

impl Interp {
    /// `ToBigInt(value)` reduced to the low 64 bits a BigInt64/BigUint64 store
    /// keeps (two's complement). Runs `ToPrimitive(number)` on an object first,
    /// then: a BigInt takes its low limbs; a Boolean is `1n`/`0n`; a String
    /// parses as a `StringIntegerLiteral` (a non-integer body throws
    /// `SyntaxError`); a Number/Symbol/`undefined`/`null` throws `TypeError`.
    pub(in crate::interp) fn to_bigint_low64(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<u64, Step> {
        let primitive = self.to_primitive(code, value, false)?;
        match primitive.kind {
            Kind::BigInt => Ok(self
                .slot_to_bigint_u64(primitive)
                .expect("a BigInt primitive reduces to its low 64 bits")),
            Kind::Boolean => Ok(matches!(primitive.value, Payload::Boolean(true)) as u64),
            Kind::String => {
                let text = match primitive.value {
                    Payload::String(off) => self
                        .str_scalar_text(off)
                        .ok_or_else(|| self.catchable_syntax_error())?,
                    _ => return Err(Step::Host(Halt::EngineInvariant("to-bigint:string"))),
                };
                // `StringToBigInt`: an integer body (decimal or `0x`/`0o`/`0b`,
                // empty ⇒ `0n`) reduced to the low 64 bits; a non-integer body
                // (a fraction, exponent, `n` suffix, or junk) is a SyntaxError.
                match parse_bigint_string_u64(&text) {
                    Some(u) => Ok(u),
                    None => Err(self.catchable_syntax_error_with_message(
                        "cannot coerce string to bigint".into(),
                    )),
                }
            }
            // A Number, a Symbol, undefined, and null are each a TypeError.
            _ => Err(self.catchable_type_error_msg(
                match primitive.kind {
                    Kind::Integer | Kind::Number => "cannot coerce number to bigint",
                    Kind::Symbol => "cannot coerce symbol to bigint",
                    _ => "cannot coerce to bigint",
                }
                .into(),
            )),
        }
    }

    /// `ToBigInt(value)` reduced to its low 64 bits (the value modulo 2^64,
    /// two's complement — what a BigInt64/BigUint64 store keeps). A BigInt
    /// takes its two low limbs (negated for a negative value); a Boolean is
    /// `1n`/`0n`. Returns `None` for a type that needs general coercion (a
    /// Number `TypeError`, a String parse, an object `ToPrimitive`), so the
    /// caller self-names a skip.
    pub(in crate::interp) fn slot_to_bigint_u64(&self, value: Slot) -> Option<u64> {
        match value.value {
            Payload::BigInt(off) => {
                let (neg, mag) = self.read_bigint(off);
                let mut u: u64 = 0;
                if let Some(&l0) = mag.first() {
                    u |= l0 as u64;
                }
                if let Some(&l1) = mag.get(1) {
                    u |= (l1 as u64) << 32;
                }
                Some(if neg { u.wrapping_neg() } else { u })
            }
            Payload::Boolean(b) => Some(b as u64),
            _ => None,
        }
    }

    /// Read a BigInt chunk into `(negative, little-endian u32 limbs)`.
    pub(in crate::interp) fn read_bigint(
        &self,
        off: crate::value::ChunkOffset,
    ) -> (bool, Vec<u32>) {
        let bytes = self.chunks.payload(off);
        let neg = bytes.first().copied().unwrap_or(0) == 1;
        let mut mag = Vec::with_capacity(bytes.len() / 4);
        let mut i = 1;
        while i + 4 <= bytes.len() {
            mag.push(u32::from_le_bytes([
                bytes[i],
                bytes[i + 1],
                bytes[i + 2],
                bytes[i + 3],
            ]));
            i += 4;
        }
        if mag.is_empty() {
            mag.push(0);
        }
        (neg, bi_trim(mag))
    }

    /// Convert a BigInt magnitude to the nearest IEEE-754 binary64 value,
    /// using round-to-nearest, ties-to-even. Reading only the leading 53 bits
    /// and the discarded round/sticky bits avoids an intermediate `f64`
    /// accumulation (and therefore avoids double rounding for wide values).
    pub(in crate::interp) fn bigint_to_f64(&self, off: crate::value::ChunkOffset) -> f64 {
        let (negative, magnitude) = self.read_bigint(off);
        if bi_is_zero(&magnitude) {
            return 0.0;
        }

        let top = *magnitude.last().expect("a BigInt has at least one limb");
        let bit_length = (magnitude.len() - 1) * 32 + (32 - top.leading_zeros() as usize);
        let mut exponent = bit_length - 1;
        let discarded = bit_length.saturating_sub(53);

        let bit = |position: usize| -> bool {
            magnitude
                .get(position / 32)
                .is_some_and(|limb| limb & (1u32 << (position % 32)) != 0)
        };
        let mut significand = 0u64;
        for position in (discarded..bit_length).rev() {
            significand = (significand << 1) | u64::from(bit(position));
        }
        if bit_length < 53 {
            significand <<= 53 - bit_length;
        }

        if discarded > 0 {
            let round = bit(discarded - 1);
            let sticky = (0..discarded - 1).any(bit);
            if round && (sticky || significand & 1 != 0) {
                significand += 1;
                if significand == 1u64 << 53 {
                    significand >>= 1;
                    exponent += 1;
                }
            }
        }

        if exponent > 1023 {
            return if negative {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            };
        }
        let sign = u64::from(negative) << 63;
        let biased = (exponent as u64 + 1023) << 52;
        let fraction = significand - (1u64 << 52);
        f64::from_bits(sign | biased | fraction)
    }

    /// The BigInt primitive carried by a primitive or boxed receiver.
    pub(in crate::interp) fn bigint_this_value(&mut self, this: Slot) -> Result<Slot, Step> {
        if this.kind == Kind::BigInt {
            return Ok(this);
        }
        match this.value {
            Payload::Reference(owner) => self
                .wrapper_data
                .get(&owner)
                .copied()
                .filter(|value| value.kind == Kind::BigInt)
                .ok_or_else(|| self.catchable_type_error_msg("this: not a bigint".into())),
            _ => Err(self.catchable_type_error_msg("this: not a bigint".into())),
        }
    }

    /// `ToIndex(bits)` for `BigInt.asIntN` / `BigInt.asUintN`.
    pub(in crate::interp) fn to_bigint_width(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<u64, Step> {
        let n = self.to_number_f64(code, value)?;
        let integer = if n.is_nan() { 0.0 } else { n.trunc() };
        if integer < 0.0 {
            return Err(self.catchable_range_error_msg("index < 0".into()));
        }
        if !integer.is_finite() || integer > 9_007_199_254_740_991.0 {
            return Err(self.catchable_range_error_msg("invalid index".into()));
        }
        Ok(integer as u64)
    }

    /// The general `ToBigInt` operation used by the width-limiting statics.
    /// Unlike the public `BigInt()` constructor, this rejects Number values.
    pub(in crate::interp) fn to_bigint_value(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<Slot, Step> {
        let primitive = self.to_primitive(code, value, false)?;
        match primitive.kind {
            Kind::BigInt => Ok(primitive),
            Kind::Boolean => Ok(self.make_bigint(
                false,
                vec![u32::from(matches!(primitive.value, Payload::Boolean(true)))],
            )),
            Kind::String => {
                let text = match primitive.value {
                    Payload::String(off) => self
                        .str_scalar_text(off)
                        .ok_or_else(|| self.catchable_syntax_error())?,
                    _ => return Err(self.catchable_syntax_error()),
                };
                let (negative, magnitude) = parse_bigint_string(&text).ok_or_else(|| {
                    self.catchable_syntax_error_with_message(
                        "cannot coerce string to bigint".into(),
                    )
                })?;
                Ok(self.make_bigint(negative, magnitude))
            }
            _ => Err(self.catchable_type_error_msg(
                match primitive.kind {
                    Kind::Integer | Kind::Number => "cannot coerce number to bigint",
                    Kind::Symbol => "cannot coerce symbol to bigint",
                    _ => "cannot coerce to bigint",
                }
                .into(),
            )),
        }
    }

    /// Reduce `value` modulo `2**bits`, interpreting the retained high bit as
    /// a sign bit for `asIntN`. Widths that would require an adversarially
    /// large positive result are named unsupported; widths wider than an
    /// already-representable value return that value without allocation.
    pub(in crate::interp) fn bigint_as_n(
        &mut self,
        value: Slot,
        bits: u64,
        signed: bool,
    ) -> Result<Slot, Step> {
        const MAX_BIGINT_WIDTH_BITS: u64 = 64 * 1024;

        let Payload::BigInt(off) = value.value else {
            return Err(self.catchable_type_error_msg(
                "BigInt width conversion requires a BigInt value".into(),
            ));
        };
        let (negative, magnitude) = self.read_bigint(off);
        if bits == 0 || bi_is_zero(&magnitude) {
            return Ok(self.make_bigint(false, vec![0]));
        }
        let top = *magnitude
            .last()
            .expect("a non-zero BigInt has a leading limb");
        let magnitude_bits =
            (magnitude.len() as u64 - 1) * 32 + u64::from(32 - top.leading_zeros());

        if !negative && ((!signed && magnitude_bits <= bits) || (signed && magnitude_bits < bits)) {
            return Ok(value);
        }
        if negative && signed {
            let minimum_at_width = magnitude_bits == bits
                && magnitude
                    .iter()
                    .take(magnitude.len() - 1)
                    .all(|&limb| limb == 0)
                && top.is_power_of_two();
            if magnitude_bits < bits || minimum_at_width {
                return Ok(value);
            }
        }
        if bits > MAX_BIGINT_WIDTH_BITS {
            return Err(Step::Host(Halt::Refused("BigInt.asN:result-too-large")));
        }

        let limb_count = bits.div_ceil(32) as usize;
        let mut unsigned = vec![0u32; limb_count];
        let copied = limb_count.min(magnitude.len());
        unsigned[..copied].copy_from_slice(&magnitude[..copied]);
        if negative {
            for limb in &mut unsigned {
                *limb = !*limb;
            }
            bi_add_one_in_place(&mut unsigned);
        }
        bi_mask_width(&mut unsigned, bits);

        if signed {
            let sign_index = (bits - 1) as usize;
            let sign_set = unsigned[sign_index / 32] & (1u32 << (sign_index % 32)) != 0;
            if sign_set {
                for limb in &mut unsigned {
                    *limb = !*limb;
                }
                bi_add_one_in_place(&mut unsigned);
                bi_mask_width(&mut unsigned, bits);
                return Ok(self.make_bigint(true, unsigned));
            }
        }
        Ok(self.make_bigint(false, unsigned))
    }

    /// BigInt exponentiation (`base ** exponent`) using exponentiation by
    /// squaring. Negative exponents are a RangeError. The constant-result
    /// bases `0`, `1`, and `-1` accept arbitrarily wide positive exponents;
    /// other bases are bounded by projected result bits so adversarial source
    /// cannot turn one opcode into an unbounded host allocation.
    pub(in crate::interp) fn bigint_pow(
        &mut self,
        base: Slot,
        exponent: Slot,
    ) -> Result<Slot, Step> {
        // `bi_mul_mag` is the straightforward quadratic limb multiply. Keep
        // the largest admitted result small enough that one guest opcode
        // cannot monopolize the host before the next meter check.
        const MAX_BIGINT_POW_BITS: usize = 64 * 1024;

        let (Payload::BigInt(base_off), Payload::BigInt(exponent_off)) =
            (base.value, exponent.value)
        else {
            return Err(self.catchable_type_error_msg(if base.kind == Kind::BigInt {
                "cannot coerce right operand to bigint".into()
            } else {
                "cannot coerce left operand to bigint".into()
            }));
        };
        let (base_negative, base_magnitude) = self.read_bigint(base_off);
        let (exponent_negative, exponent_magnitude) = self.read_bigint(exponent_off);
        if exponent_negative {
            return Err(self.catchable_range_error_msg("negative exponent".into()));
        }
        if bi_is_zero(&exponent_magnitude) {
            return Ok(self.make_bigint(false, vec![1]));
        }
        if bi_is_zero(&base_magnitude) {
            return Ok(self.make_bigint(false, vec![0]));
        }
        if base_magnitude == [1] {
            let odd = exponent_magnitude[0] & 1 != 0;
            return Ok(self.make_bigint(base_negative && odd, vec![1]));
        }

        let exponent = if exponent_magnitude.len() == 1 {
            exponent_magnitude[0]
        } else {
            return Err(Step::Host(Halt::Refused("exponentiation:result-too-large")));
        };
        let top = *base_magnitude
            .last()
            .expect("a non-zero BigInt has a leading limb");
        let base_bits = (base_magnitude.len() - 1) * 32 + (32 - top.leading_zeros() as usize);
        let projected_bits = base_bits
            .checked_mul(exponent as usize)
            .ok_or(Step::Host(Halt::Refused("exponentiation:result-too-large")))?;
        if projected_bits > MAX_BIGINT_POW_BITS {
            return Err(Step::Host(Halt::Refused("exponentiation:result-too-large")));
        }

        let mut power = base_magnitude;
        let mut result = vec![1u32];
        let mut remaining = exponent;
        while remaining != 0 {
            if remaining & 1 != 0 {
                result = bi_mul_mag(&result, &power);
            }
            remaining >>= 1;
            if remaining != 0 {
                power = bi_mul_mag(&power, &power);
            }
        }
        let negative = base_negative && exponent & 1 != 0;
        // The allocation meter is charged at the retained result size. Exact
        // XS repeated-squaring work metering remains advisory in dual-run
        // coverage; the semantic result and allocation bound are enforced.
        Ok(self.make_bigint(negative, result))
    }

    /// Build a BigInt value from `(negative, limbs)`, allocating the digit
    /// chunk `[sign: u8][LE u32 limbs]` (trimmed; a `-0` normalizes to `+0`)
    /// and charging the allocation at the value's own size
    /// (`fxNewChunk(size * 4)`). Used where XS allocates exactly `bigint.size`
    /// limbs — a literal (`fxNewBigInt`) and a negation (`fxBigInt_neg` →
    /// `fxBigInt_alloc(a->size)`). An arithmetic result instead allocates its
    /// (pre-trim) working size and meters the chunk itself
    /// ([`Self::store_bigint`]).
    pub(in crate::interp) fn make_bigint(&mut self, neg: bool, mag: Vec<u32>) -> Slot {
        let mag = bi_trim(mag);
        self.meter.tick_chunk_new((mag.len() * 4) as u64);
        self.store_bigint(neg, mag)
    }

    /// Build a BigInt value without metering the chunk allocation (the caller
    /// meters it — at XS's allocation size, which for an arithmetic result is
    /// the pre-trim working size rather than the trimmed `bigint.size`).
    fn store_bigint(&mut self, neg: bool, mag: Vec<u32>) -> Slot {
        let mag = bi_trim(mag);
        let neg = if bi_is_zero(&mag) { false } else { neg };
        let mut bytes = Vec::with_capacity(1 + mag.len() * 4);
        bytes.push(neg as u8);
        for limb in &mag {
            bytes.extend_from_slice(&limb.to_le_bytes());
        }
        let off = self.chunks.alloc(&bytes);
        Slot::of(Kind::BigInt, Payload::BigInt(off))
    }

    /// Loose `==`/`!=` between a BigInt (`big`) and a Number/Integer (`num`),
    /// XS's `fxBigIntCompare` number path: a finite Number is coerced to a
    /// BigInt (`fxNumberToBigInt`, its `fxNewChunk(size*4)` the only metered
    /// residual) then compared by mathematical value, so a non-integral Number
    /// is never equal; a non-finite Number (`NaN`/`±Infinity`) is never equal
    /// and allocates no chunk. Returns the equality boolean.
    pub(in crate::interp) fn bigint_num_loose_eq(&mut self, big: Slot, num: Slot) -> bool {
        let n = match num.value {
            Payload::Integer(v) => v as f64,
            Payload::Number(v) => v,
            _ => return false,
        };
        if !n.is_finite() {
            return false;
        }
        let (nneg, nmag) = number_to_bigint(n);
        // fxNumberToBigInt allocates `size` limbs regardless of the fraction.
        self.meter.tick_chunk_new((nmag.len() * 4) as u64);
        if n.trunc() != n {
            return false; // a fractional Number is never == a BigInt
        }
        let off = match big.value {
            Payload::BigInt(o) => o,
            _ => return false,
        };
        let (bneg, bmag) = self.read_bigint(off);
        bneg == nneg && bmag == nmag
    }

    /// BigInt `+`/`-`/`*` (`fxBigInt_add`/`_sub`/`_mul`). Meters, in XS's order:
    /// the result digit chunk at XS's **allocation** size (`fxBigInt_alloc`,
    /// pre-trim) — a magnitude add allocates `max(a,b)+1` limbs, a magnitude
    /// subtract `max(a,b)`, a multiply `a.size+b.size`; then the digit step
    /// `mxBigInt_meter(result_size)` = `(result_size - 1) * XS_BIGINT_METERING`
    /// over the trimmed result size (XS trims `rr->size` in `uadd`/`usub`/
    /// `umul`); then the calibrated frame residual. Division and remainder use
    /// limb long division, truncate the quotient toward zero, and give the
    /// remainder the dividend's sign. Their retained-result allocation is
    /// metered here; exact XS long-division work calibration remains advisory.
    fn bigint_arith(
        &mut self,
        op: ArithOp,
        a_off: crate::value::ChunkOffset,
        b_off: crate::value::ChunkOffset,
    ) -> Result<Slot, Step> {
        let (na, ma) = self.read_bigint(a_off);
        let (nb, mb) = self.read_bigint(b_off);
        let (neg, mag) = match op {
            ArithOp::Add => bi_add(na, &ma, nb, &mb),
            ArithOp::Sub => bi_add(na, &ma, !nb, &mb),
            ArithOp::Mul => bi_mul(na, &ma, nb, &mb),
            ArithOp::Div | ArithOp::Mod => {
                if bi_is_zero(&mb) {
                    return Err(self.catchable_range_error_msg("zero divider".into()));
                }
                let (quotient, remainder) = bi_div_rem_mag(&ma, &mb);
                if op == ArithOp::Div {
                    (na != nb && !bi_is_zero(&quotient), quotient)
                } else {
                    (na && !bi_is_zero(&remainder), remainder)
                }
            }
        };
        // XS's per-op allocation size (`fxBigInt_alloc` limb count), which is
        // what `fxNewChunk` meters — distinct from the trimmed `bigint.size`.
        let max = ma.len().max(mb.len()) as u64;
        let alloc_limbs = match op {
            // `a + b`: magnitudes add when the signs agree (`uadd`, max+1), else
            // subtract (`usub`, max). `a - b`: the reverse.
            ArithOp::Add => {
                if na == nb {
                    max + 1
                } else {
                    max
                }
            }
            ArithOp::Sub => {
                if na != nb {
                    max + 1
                } else {
                    max
                }
            }
            ArithOp::Mul => (ma.len() + mb.len()) as u64,
            ArithOp::Div | ArithOp::Mod => mag.len() as u64,
        };
        self.meter.tick_chunk_new(alloc_limbs * 4);
        let size = mag.len() as u64; // trimmed to XS's post-op `rr->size`
        self.meter
            .tick_raw((size - 1) * crate::meter::BIGINT_METERING);
        self.meter.tick_raw(BIGINT_ARITH_FRAME_METERING);
        Ok(self.store_bigint(neg, mag))
    }

    /// BigInt `++`/`--` (`fxBigInt_inc`/`fxBigInt_dec`), which delegate to
    /// addition/subtraction with XS's static `gxBigIntOne`. The constant does
    /// not allocate; only the arithmetic result and digit work are charged.
    pub(in crate::interp) fn bigint_update(
        &mut self,
        value: crate::value::ChunkOffset,
        increment: bool,
    ) -> Slot {
        let (negative, magnitude) = self.read_bigint(value);
        let one = [1u32];
        let (result_negative, result_magnitude) = if increment {
            bi_add(negative, &magnitude, false, &one)
        } else {
            bi_add(negative, &magnitude, true, &one)
        };
        let max = magnitude.len().max(one.len()) as u64;
        let allocation_limbs = if increment {
            if negative {
                max
            } else {
                max + 1
            }
        } else if negative {
            max + 1
        } else {
            max
        };
        self.meter.tick_chunk_new(allocation_limbs * 4);
        self.meter
            .tick_raw((result_magnitude.len() as u64 - 1) * crate::meter::BIGINT_METERING);
        self.meter.tick_raw(BIGINT_ARITH_FRAME_METERING);
        self.store_bigint(result_negative, result_magnitude)
    }

    /// If `a`/`b` involve a BigInt, dispatch the op: both BigInt → BigInt
    /// arithmetic; a BigInt mixed with any non-BigInt → catchable TypeError.
    /// Returns `Ok(None)` when neither is a BigInt.
    pub(in crate::interp) fn try_bigint_binop(
        &mut self,
        op: ArithOp,
        a: Slot,
        b: Slot,
    ) -> Result<Option<Slot>, Step> {
        if a.kind != Kind::BigInt && b.kind != Kind::BigInt {
            return Ok(None);
        }
        match (a.value, b.value) {
            (Payload::BigInt(x), Payload::BigInt(y)) => Ok(Some(self.bigint_arith(op, x, y)?)),
            _ => Err(self.catchable_type_error_msg(if a.kind == Kind::BigInt {
                "cannot coerce right operand to bigint".into()
            } else {
                "cannot coerce left operand to bigint".into()
            })),
        }
    }

    /// Compare an exact BigInt with an IEEE-754 Number without converting the
    /// BigInt to f64. `None` represents the abstract relational comparison's
    /// undefined result for NaN.
    pub(in crate::interp) fn compare_bigint_number(
        &self,
        bigint: crate::value::ChunkOffset,
        number: f64,
    ) -> Option<std::cmp::Ordering> {
        use std::cmp::Ordering;
        if number.is_nan() {
            return None;
        }
        if number == f64::INFINITY {
            return Some(Ordering::Less);
        }
        if number == f64::NEG_INFINITY {
            return Some(Ordering::Greater);
        }

        let (bigint_negative, bigint_magnitude) = self.read_bigint(bigint);
        let truncated = number.trunc();
        let (number_negative, number_magnitude) = number_to_bigint(truncated);
        let ordering = bi_cmp(
            bigint_negative,
            &bigint_magnitude,
            number_negative,
            &number_magnitude,
        );
        if ordering != Ordering::Equal || number == truncated {
            return Some(ordering);
        }
        // The BigInt equals trunc(number). A positive fractional Number lies
        // just above it; a negative fractional Number lies just below it.
        Some(if number.is_sign_positive() {
            Ordering::Less
        } else {
            Ordering::Greater
        })
    }

    /// BigInt `&`/`|`/`^` over the spec's infinite two's-complement values.
    /// One extra high limb preserves sign extension while the operation runs;
    /// the result is converted back to canonical sign+magnitude form.
    pub(in crate::interp) fn bigint_bitwise(
        &mut self,
        op: BitOp,
        a: crate::value::ChunkOffset,
        b: crate::value::ChunkOffset,
    ) -> Slot {
        let (a_negative, a_magnitude) = self.read_bigint(a);
        let (b_negative, b_magnitude) = self.read_bigint(b);
        let width = a_magnitude.len().max(b_magnitude.len()) + 1;
        let a_twos = bi_to_twos_complement(a_negative, &a_magnitude, width);
        let b_twos = bi_to_twos_complement(b_negative, &b_magnitude, width);
        let result = a_twos
            .into_iter()
            .zip(b_twos)
            .map(|(a_limb, b_limb)| match op {
                BitOp::And => a_limb & b_limb,
                BitOp::Or => a_limb | b_limb,
                BitOp::Xor => a_limb ^ b_limb,
                _ => unreachable!("only the three logical BigInt ops call this helper"),
            })
            .collect();
        let (negative, magnitude) = bi_from_twos_complement(result);
        self.make_bigint(negative, magnitude)
    }

    /// BigInt signed shifts. A negative BigInt count reverses direction. Right
    /// shift is arithmetic (floor division by a power of two); a shift beyond
    /// the value's bit length therefore saturates to `0n` or `-1n`. Left shifts
    /// are bounded to keep one guest opcode from forcing an unbounded host
    /// allocation.
    pub(in crate::interp) fn bigint_shift(
        &mut self,
        op: BitOp,
        value: crate::value::ChunkOffset,
        count: crate::value::ChunkOffset,
    ) -> Result<Slot, Step> {
        const MAX_BIGINT_SHIFT_RESULT_BITS: usize = 64 * 1024;

        let (negative, magnitude) = self.read_bigint(value);
        let (count_negative, count_magnitude) = self.read_bigint(count);
        if bi_is_zero(&magnitude) {
            return Ok(self.make_bigint(false, vec![0]));
        }
        let shifts_left = (op == BitOp::Shl) != count_negative;
        let value_bits = bi_bit_length(&magnitude);
        if shifts_left {
            let max_shift = MAX_BIGINT_SHIFT_RESULT_BITS.saturating_sub(value_bits);
            let shift = bi_usize_up_to(&count_magnitude, max_shift)
                .ok_or(Step::Host(Halt::Refused("bigint-shift:result-too-large")))?;
            return Ok(self.make_bigint(negative, bi_shl_bits(&magnitude, shift)));
        }

        let Some(shift) = bi_usize_up_to(&count_magnitude, value_bits) else {
            return Ok(if negative {
                self.make_bigint(true, vec![1])
            } else {
                self.make_bigint(false, vec![0])
            });
        };
        let (mut shifted, discarded) = bi_shr_mag(&magnitude, shift);
        if negative && discarded {
            shifted = bi_add_mag(&shifted, &[1]);
        }
        Ok(self.make_bigint(negative, shifted))
    }

    /// BigInt bitwise complement: `~x === -x - 1n`, expressed directly over
    /// sign+magnitude limbs to avoid constructing an intermediate BigInt.
    pub(in crate::interp) fn bigint_bit_not(&mut self, value: crate::value::ChunkOffset) -> Slot {
        let (negative, magnitude) = self.read_bigint(value);
        if negative {
            self.make_bigint(false, bi_sub_mag(&magnitude, &[1]))
        } else {
            self.make_bigint(true, bi_add_mag(&magnitude, &[1]))
        }
    }
}
