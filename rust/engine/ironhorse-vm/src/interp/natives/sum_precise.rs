//! `Math.sumPrecise(items)` (ES2026 21.3.2.34, XS's `fx_Math_sumPrecise`).
//!
//! XS sums with Radford Neal's `xsum` small accumulator. Ironhorse keeps the
//! exact sum in a fixed-point integer instead: every finite double is an
//! integer multiple of 2^-1074, so the sum of any count of them is too, and
//! one correctly rounded conversion at the end gives the specified result.
//! The accumulator is integer-only, so the answer is the same on every host.
use super::super::*;

/// Limbs of the accumulator, least significant first. A double scaled by
/// 2^1074 needs at most 2098 bits; 2^53 of them (the specification's item
/// limit) need 2151; the top limb's high bit is the two's-complement sign.
const LIMBS: usize = 35;

/// The exact running sum of finite doubles, scaled by 2^1074.
struct ExactSum {
    limbs: [u64; LIMBS],
}

impl ExactSum {
    fn new() -> Self {
        ExactSum { limbs: [0; LIMBS] }
    }

    /// Add a finite double. Returns the number of limbs a carry or borrow
    /// touched, which bounds the work done.
    fn add(&mut self, value: f64) -> u64 {
        let bits = value.to_bits();
        let biased = ((bits >> 52) & 0x7ff) as u32;
        let fraction = bits & ((1 << 52) - 1);
        // `value` is `mantissa * 2^(shift - 1074)`.
        let (mantissa, shift) = if biased == 0 {
            (fraction, 0)
        } else {
            (fraction | (1 << 52), biased - 1)
        };
        if mantissa == 0 {
            return 0;
        }
        let limb = (shift / 64) as usize;
        let offset = shift % 64;
        let low = mantissa << offset;
        let high = if offset == 0 {
            0
        } else {
            mantissa >> (64 - offset)
        };
        let negative = bits >> 63 != 0;
        let mut index = limb;
        let mut carry = false;
        for (position, part) in [low, high].into_iter().enumerate() {
            index = limb + position;
            let (next, overflow) = if negative {
                let (a, b) = self.limbs[index].overflowing_sub(part);
                let (c, d) = a.overflowing_sub(carry as u64);
                (c, b || d)
            } else {
                let (a, b) = self.limbs[index].overflowing_add(part);
                let (c, d) = a.overflowing_add(carry as u64);
                (c, b || d)
            };
            self.limbs[index] = next;
            carry = overflow;
        }
        while carry && index + 1 < LIMBS {
            index += 1;
            let (next, overflow) = if negative {
                self.limbs[index].overflowing_sub(1)
            } else {
                self.limbs[index].overflowing_add(1)
            };
            self.limbs[index] = next;
            carry = overflow;
        }
        (index - limb + 1) as u64
    }

    /// The sum rounded to the nearest double, ties to even. An exact zero
    /// is +0: the caller answers -0 itself when every item was -0.
    fn round(&self) -> f64 {
        let negative = self.limbs[LIMBS - 1] >> 63 != 0;
        let mut magnitude = self.limbs;
        if negative {
            let mut carry = true;
            for limb in magnitude.iter_mut() {
                let (next, overflow) = (!*limb).overflowing_add(carry as u64);
                *limb = next;
                carry = overflow;
            }
        }
        let Some(top) = magnitude.iter().rposition(|&limb| limb != 0) else {
            return 0.0;
        };
        let high_bit = top as u32 * 64 + (63 - magnitude[top].leading_zeros());
        let bit = |at: u32| magnitude[(at / 64) as usize] >> (at % 64) & 1;
        let result = if high_bit < 53 {
            // Below 2^53 * 2^-1074 every multiple of 2^-1074 is a double, and
            // its bit pattern is the multiple itself.
            f64::from_bits(magnitude[0])
        } else {
            let shift = high_bit - 52;
            let mut mantissa = 0u64;
            for at in (shift..=high_bit).rev() {
                mantissa = mantissa << 1 | bit(at);
            }
            let half = bit(shift - 1) != 0;
            let sticky = (0..shift - 1).any(|at| bit(at) != 0);
            let mut biased = u64::from(shift) + 1;
            if half && (sticky || mantissa & 1 != 0) {
                mantissa += 1;
                if mantissa == 1 << 53 {
                    mantissa >>= 1;
                    biased += 1;
                }
            }
            if biased >= 0x7ff {
                f64::INFINITY
            } else {
                f64::from_bits(biased << 52 | (mantissa & ((1 << 52) - 1)))
            }
        };
        if negative {
            -result
        } else {
            result
        }
    }
}

/// The specification's summation states, after its items so far.
#[derive(Clone, Copy, PartialEq)]
enum SumState {
    MinusZero,
    Finite,
    PlusInfinity,
    MinusInfinity,
    NotANumber,
}

impl Interp {
    /// `Math.sumPrecise(items)`: iterate `items`, which must yield only
    /// Numbers, and answer their exact sum rounded once. A non-Number item
    /// closes the iterator and throws a TypeError.
    /// Out of line from the method dispatcher, whose frame every native
    /// re-entry carries (`benches/stack_height.py`).
    #[inline(never)]
    pub(in crate::interp) fn math_sum_precise(
        &mut self,
        code: &[u8],
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        self.meter.tick_raw(MATH_FRAME_METERING);
        let items = if argc > 0 {
            self.stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined)
        } else {
            Slot::undefined()
        };
        let outcome = self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            machine.math_sum_precise_inner(code, items)
        });
        match outcome {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(self.raise_js(error)),
            Err(halt) => Err(halt),
        }
    }

    fn math_sum_precise_inner(
        &mut self,
        code: &[u8],
        items: Slot,
    ) -> Result<Result<Slot, Slot>, Step> {
        let (iterator, next_method) = match self.get_iterator_sync(code, items)? {
            Ok(record) => record,
            Err(error) => return Ok(Err(error)),
        };
        let mut sum = ExactSum::new();
        let mut state = SumState::MinusZero;
        let mut count: u64 = 0;
        loop {
            let value = match self.helper_step_value(code, iterator, next_method)? {
                Ok(Some(value)) => value,
                Ok(None) => break,
                Err(error) => return Ok(Err(error)),
            };
            // Reaching 2^53 items is a RangeError that closes the iterator.
            count += 1;
            if count >= 1 << 53 {
                let error = self.internal_error("RangeError", "too many items".into());
                return Ok(Err(self.array_from_close(code, iterator, error)?));
            }
            let n = match value.kind {
                Kind::Integer | Kind::Number => to_number(&value),
                _ => {
                    let error = self
                        .internal_error("TypeError", format!("items[{}]: not a number", count - 1));
                    return Ok(Err(self.array_from_close(code, iterator, error)?));
                }
            };
            self.charge_builtin_work(1)?;
            if state == SumState::NotANumber {
                continue;
            }
            state = if n.is_nan() {
                SumState::NotANumber
            } else if n == f64::INFINITY {
                if state == SumState::MinusInfinity {
                    SumState::NotANumber
                } else {
                    SumState::PlusInfinity
                }
            } else if n == f64::NEG_INFINITY {
                if state == SumState::PlusInfinity {
                    SumState::NotANumber
                } else {
                    SumState::MinusInfinity
                }
            } else if (n != 0.0 || n.is_sign_positive())
                && matches!(state, SumState::MinusZero | SumState::Finite)
            {
                let touched = sum.add(n);
                self.charge_builtin_work(touched)?;
                SumState::Finite
            } else {
                state
            };
        }
        Ok(Ok(Slot::number(match state {
            SumState::NotANumber => f64::NAN,
            SumState::PlusInfinity => f64::INFINITY,
            SumState::MinusInfinity => f64::NEG_INFINITY,
            SumState::MinusZero => -0.0,
            SumState::Finite => sum.round(),
        })))
    }

    /// `GetIterator(obj, sync)` (ECMA-262 7.4.3): call `obj[@@iterator]`
    /// and read the result's `next` method once.
    pub(in crate::interp) fn get_iterator_sync(
        &mut self,
        code: &[u8],
        items: Slot,
    ) -> Result<Result<(Slot, Slot), Slot>, Step> {
        let Some(iterator_id) = self.well_known_symbol_property_id("iterator") else {
            return Err(Step::Host(Halt::EngineInvariant("GetIterator:symbol")));
        };
        let method = match items.value {
            Payload::Reference(inst) if items.kind == Kind::Reference => {
                match self.array_from_try(|this| this.mop_get(code, inst, iterator_id, items))? {
                    Ok(method) => method,
                    Err(error) => return Ok(Err(error)),
                }
            }
            _ => {
                let object = match self.array_from_try(|this| this.array_to_object(items))? {
                    Ok(object) => object,
                    Err(error) => return Ok(Err(error)),
                };
                let Payload::Reference(inst) = object.value else {
                    unreachable!("ToObject returns a reference")
                };
                match self.array_from_try(|this| this.mop_get(code, inst, iterator_id, items))? {
                    Ok(method) => method,
                    Err(error) => return Ok(Err(error)),
                }
            }
        };
        if !self.is_callable_value(method) {
            return Ok(Err(
                self.internal_error("TypeError", "call: not a function".into())
            ));
        }
        let iterator = match self.array_from_try(|this| this.call_any(code, method, items, &[]))? {
            Ok(iterator) => iterator,
            Err(error) => return Ok(Err(error)),
        };
        let Payload::Reference(iterator_inst) = iterator.value else {
            return Ok(Err(
                self.internal_error("TypeError", "iterator: not an object".into())
            ));
        };
        if iterator.kind != Kind::Reference {
            return Ok(Err(
                self.internal_error("TypeError", "iterator: not an object".into())
            ));
        }
        let next_id = self.intern_static_key("next");
        match self.array_from_try(|this| this.mop_get(code, iterator_inst, next_id, iterator))? {
            Ok(next_method) => Ok(Ok((iterator, next_method))),
            Err(error) => Ok(Err(error)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ExactSum;

    fn sum(values: &[f64]) -> f64 {
        let mut sum = ExactSum::new();
        for &value in values {
            sum.add(value);
        }
        sum.round()
    }

    #[test]
    fn exact_sums_round_once() {
        assert_eq!(sum(&[0.1, 0.2]), 0.30000000000000004);
        assert_eq!(sum(&[1e20, 0.1, -1e20]), 0.1);
        assert_eq!(sum(&[1.0, 1e100, 1.0, -1e100]), 2.0);
        assert_eq!(sum(&[f64::MAX, f64::MAX, -f64::MAX]), f64::MAX);
        assert_eq!(sum(&[f64::MAX, f64::MAX]), f64::INFINITY);
        assert_eq!(sum(&[-f64::MAX, -f64::MAX]), f64::NEG_INFINITY);
        assert_eq!(sum(&[5e-324, 5e-324]), 1e-323);
        assert_eq!(sum(&[5e-324, -5e-324]), 0.0);
        assert!(sum(&[5e-324, -5e-324]).is_sign_positive());
        assert_eq!(
            sum(&[f64::MIN_POSITIVE, -5e-324]),
            f64::MIN_POSITIVE - 5e-324
        );
    }

    #[test]
    fn ties_round_to_even() {
        // 2^53 + 1 is a tie between 2^53 and 2^53 + 2: even wins.
        assert_eq!(sum(&[9007199254740992.0, 1.0]), 9007199254740992.0);
        assert_eq!(sum(&[9007199254740994.0, 1.0]), 9007199254740996.0);
        // Anything past the tie rounds up.
        assert_eq!(sum(&[9007199254740992.0, 1.0, 5e-324]), 9007199254740994.0);
        // The largest finite double plus half its last place rounds to
        // infinity; a hair less does not.
        let half_ulp = 2f64.powi(970);
        assert_eq!(sum(&[f64::MAX, half_ulp]), f64::INFINITY);
        assert_eq!(sum(&[f64::MAX, half_ulp, -5e-324]), f64::MAX);
    }
}
