//! VM-facing number builtin algorithms.
use super::super::*;

impl Interp {
    /// Dispatch a `Math.*` static (`xsMath.c`). Reads the positional
    /// arguments off the call frame (`stack[base + 4 + i]`), coerces each to a
    /// number (`fxToNumber`, including observable object-to-primitive
    /// conversion, complete string-number parsing, and catchable Symbol/BigInt
    /// errors), and
    /// meters the single native host frame ([`MATH_FRAME_METERING`]). No
    /// `mxMeterSome` and no chunk — the pin's bodies carry neither. A NaN
    /// result is the canonical `f64::NAN`.
    ///
    /// Provider-sensitive operations use the selected `crate::math` provider.
    /// Cross-platform bit identity is not established by same-host oracle
    /// agreement: a last-bit difference can affect guest branches and receipts.
    /// `math_determinism.rs` checks known answers and exports platform vectors.
    /// `deterministic-math` selects software libm; default platform builds
    /// retain their narrower guarantee. The decision and coverage are recorded in
    /// `designs/ironhorse-w6-decisions.md`, section 4.
    pub(in crate::interp) fn call_math(
        &mut self,
        id: MathId,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        use MathId::*;
        self.meter.tick_raw(MATH_FRAME_METERING);
        let r = match id {
            Abs => self.math_unary(code, base, argc, f64::abs)?,
            Acos => self.math_unary(code, base, argc, crate::math::acos)?,
            Acosh => self.math_unary(code, base, argc, crate::math::acosh)?,
            Asin => self.math_unary(code, base, argc, crate::math::asin)?,
            Asinh => self.math_unary(code, base, argc, crate::math::asinh)?,
            Atan => self.math_unary(code, base, argc, crate::math::atan)?,
            Atanh => self.math_unary(code, base, argc, crate::math::atanh)?,
            Cbrt => self.math_unary(code, base, argc, crate::math::cbrt)?,
            Ceil => self.math_unary(code, base, argc, f64::ceil)?,
            Cos => self.math_unary(code, base, argc, crate::math::cos)?,
            Cosh => self.math_unary(code, base, argc, crate::math::cosh)?,
            Exp => self.math_unary(code, base, argc, crate::math::exp)?,
            Expm1 => self.math_unary(code, base, argc, crate::math::expm1)?,
            Floor => self.math_unary(code, base, argc, f64::floor)?,
            Log => self.math_unary(code, base, argc, crate::math::log)?,
            Log1p => self.math_unary(code, base, argc, crate::math::log1p)?,
            Log10 => self.math_unary(code, base, argc, crate::math::log10)?,
            // The pin computes `log2` as `c_log(x) / c_log(2)` only under
            // `mxNoFunctionLength`-style configs it does not enable here; the
            // default build calls `c_log2`, so ironhorse uses `f64::log2`.
            Log2 => self.math_unary(code, base, argc, crate::math::log2)?,
            Sin => self.math_unary(code, base, argc, crate::math::sin)?,
            Sinh => self.math_unary(code, base, argc, crate::math::sinh)?,
            Sqrt => self.math_unary(code, base, argc, f64::sqrt)?,
            Tan => self.math_unary(code, base, argc, crate::math::tan)?,
            Tanh => self.math_unary(code, base, argc, crate::math::tanh)?,
            Atan2 => match (self.math_arg(base, argc, 0), self.math_arg(base, argc, 1)) {
                (Some(y), Some(x)) => {
                    let y = self.to_number_f64(code, y)?;
                    let x = self.to_number_f64(code, x)?;
                    Slot::number(crate::math::atan2(y, x))
                }
                _ => Slot::number(f64::NAN),
            },
            // `fx_Math_pow` → `fx_pow`: `(±1) ** ±Infinity` is NaN (the pin's
            // explicit special-case), otherwise `c_pow`.
            Pow => match (self.math_arg(base, argc, 0), self.math_arg(base, argc, 1)) {
                (Some(x), Some(y)) => {
                    let x = self.to_number_f64(code, x)?;
                    let y = self.to_number_f64(code, y)?;
                    let v = if !y.is_finite() && x.abs() == 1.0 {
                        f64::NAN
                    } else {
                        crate::math::pow(x, y)
                    };
                    Slot::number(v)
                }
                _ => Slot::number(f64::NAN),
            },
            // `fx_Math_hypot`: no arg → 0; XS special-cases the 2-argument
            // `c_hypot`, else sums the squares and takes the sqrt.
            Hypot => {
                let mut vals = self.reserve_scratch(argc)?;
                for i in 0..argc {
                    let value = self.math_arg(base, argc, i).unwrap();
                    vals.push(self.to_number_f64(code, value)?);
                }
                let v = match vals.len() {
                    0 => 0.0,
                    2 => crate::math::hypot(vals[0], vals[1]),
                    _ => vals.iter().map(|x| x * x).sum::<f64>().sqrt(),
                };
                Slot::number(v)
            }
            // `fx_Math_sign`: NaN→NaN, <0→-1, >0→1, else the argument (±0),
            // then `fx_Math_toInteger` folds an exact integer to integer kind.
            Sign => match self.math_arg(base, argc, 0) {
                None => Slot::number(f64::NAN),
                Some(s) => {
                    let a = self.to_number_f64(code, s)?;
                    let r = if a.is_nan() {
                        f64::NAN
                    } else if a < 0.0 {
                        -1.0
                    } else if a > 0.0 {
                        1.0
                    } else {
                        a
                    };
                    math_to_integer(r)
                }
            },
            // `fx_Math_round`: an integer argument passes through; otherwise
            // XS rounds half-up (`floor(x + 0.5)`) inside the ±(2^52-1) normal
            // window, with the ±0 corners, then folds to integer kind.
            Round => match self.math_arg(base, argc, 0) {
                None => Slot::number(f64::NAN),
                Some(s) if s.kind == Kind::Integer => s,
                Some(s) => {
                    let mut a = self.to_number_f64(code, s)?;
                    if a.is_normal() && (-4503599627370495.0 < a) && (a < 4503599627370495.0) {
                        if a < -0.5 || 0.5 <= a {
                            a = (a + 0.5).floor();
                        } else if a < 0.0 {
                            a = -0.0;
                        } else if a > 0.0 {
                            a = 0.0;
                        }
                    }
                    math_to_integer(a)
                }
            },
            // `fx_Math_trunc`: `c_trunc`, then fold to integer kind.
            Trunc => match self.math_arg(base, argc, 0) {
                None => Slot::number(f64::NAN),
                Some(s) => math_to_integer(self.to_number_f64(code, s)?.trunc()),
            },
            // `fx_Math_fround`: an integer passes through; otherwise round to
            // the nearest `f32` and widen back.
            Fround => match self.math_arg(base, argc, 0) {
                None => Slot::number(f64::NAN),
                Some(s) if s.kind == Kind::Integer => s,
                Some(s) => Slot::number(self.to_number_f64(code, s)? as f32 as f64),
            },
            // `fx_Math_clz32`: count leading zeros of ToUint32(arg); 32 for 0.
            Clz32 => {
                let x = match self.math_arg(base, argc, 0) {
                    None => 0u32,
                    Some(s) => to_int32(self.to_number_f64(code, s)?) as u32,
                };
                Slot::integer(x.leading_zeros() as i32)
            }
            // `fx_Math_imul`: (ToInt32(a) * ToInt32(b)) as a 32-bit product.
            Imul => {
                let a = match self.math_arg(base, argc, 0) {
                    Some(value) => to_int32(self.to_number_f64(code, value)?),
                    None => 0,
                };
                let b = match self.math_arg(base, argc, 1) {
                    Some(value) => to_int32(self.to_number_f64(code, value)?),
                    None => 0,
                };
                Slot::integer(a.wrapping_mul(b))
            }
            Max => self.math_extremum(code, argc, base, true)?,
            Min => self.math_extremum(code, argc, base, false)?,
        };
        Ok(r)
    }

    /// Copy one positional Math argument out of the native call frame.
    fn math_arg(&self, base: usize, argc: usize, index: usize) -> Option<Slot> {
        (index < argc).then(|| {
            self.stack
                .get(base + 4 + index)
                .copied()
                .unwrap_or_else(Slot::undefined)
        })
    }

    /// A one-argument Math operation, including the no-argument NaN case and
    /// the shared observable ToNumber conversion.
    fn math_unary(
        &mut self,
        code: &[u8],
        base: usize,
        argc: usize,
        operation: fn(f64) -> f64,
    ) -> Result<Slot, Step> {
        match self.math_arg(base, argc, 0) {
            None => Ok(Slot::number(f64::NAN)),
            Some(value) => Ok(Slot::number(operation(self.to_number_f64(code, value)?))),
        }
    }

    /// `fx_Math_max`/`fx_Math_min`: the running extremum over the arguments,
    /// preserving XS's integer-kind fast path (an all-integer argument list
    /// stays integer) and its ±0 tie-break (`max(+0,-0)===+0`,
    /// `min(+0,-0)===-0`), with a NaN argument poisoning the result (after
    /// still coercing the remaining arguments, so a later abrupt completion
    /// takes precedence). `max` seeds `-Infinity`, `min` seeds `+Infinity`.
    fn math_extremum(
        &mut self,
        code: &[u8],
        argc: usize,
        base: usize,
        is_max: bool,
    ) -> Result<Slot, Step> {
        if argc == 0 {
            return Ok(Slot::number(if is_max {
                f64::NEG_INFINITY
            } else {
                f64::INFINITY
            }));
        }
        // Integer fast path while every argument seen so far is an integer.
        let first = self.math_arg(base, argc, 0).unwrap();
        let mut int_acc: Option<i32> = if first.kind == Kind::Integer {
            match first.value {
                Payload::Integer(v) => Some(v),
                _ => None,
            }
        } else {
            None
        };
        let mut acc: f64 = if is_max {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
        let start = if int_acc.is_some() { 1 } else { 0 };
        let mut saw_nan = false;
        for i in start..argc {
            let s = self.math_arg(base, argc, i).unwrap();
            if let Some(iv) = int_acc {
                if s.kind == Kind::Integer {
                    if let Payload::Integer(v) = s.value {
                        int_acc = Some(if is_max { iv.max(v) } else { iv.min(v) });
                        continue;
                    }
                }
                // Leaving the integer path: seed the float accumulator.
                acc = iv as f64;
                int_acc = None;
            }
            let n = self.to_number_f64(code, s)?;
            if n.is_nan() {
                // Math.max/min still ToNumber-coerce every later argument, so
                // a subsequent abrupt completion must outrank the NaN result.
                saw_nan = true;
                continue;
            }
            if is_max {
                if acc < n {
                    acc = n;
                } else if acc == 0.0 && n == 0.0 && acc.is_sign_negative() && n.is_sign_positive() {
                    acc = 0.0;
                }
            } else if acc > n {
                acc = n;
            } else if acc == 0.0 && n == 0.0 && acc.is_sign_positive() && n.is_sign_negative() {
                acc = -0.0;
            }
        }
        Ok(if saw_nan {
            Slot::number(f64::NAN)
        } else {
            match int_acc {
                Some(v) => Slot::integer(v),
                None => Slot::number(acc),
            }
        })
    }

    /// XS `fxToInteger` uses distinct diagnostics and wraps to signed 32 bits.
    pub(in crate::interp) fn number_radix_integer(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<i32, Step> {
        let value = self.to_primitive(code, value, false)?;
        if value.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to integer".into()));
        }
        if value.kind == Kind::BigInt {
            return Err(self.catchable_type_error_msg("cannot coerce to integer".into()));
        }
        Ok(to_int32(self.to_number_f64(code, value)?))
    }

    /// Dispatch a `Number` static / `Number.prototype.toString` / numeric
    /// global (`parseInt`/`parseFloat`/`isNaN`/`isFinite`). The `xsNumber.c`
    /// bodies carry no `mxMeterSome`; `toString` allocates its result chunk,
    /// the rest return a number/boolean (no chunk). A NaN result is the
    /// canonical `f64::NAN`.
    pub(in crate::interp) fn call_number(
        &mut self,
        m: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let arg0 = if argc > 0 {
            Some(
                self.stack
                    .get(base + 4)
                    .copied()
                    .unwrap_or_else(Slot::undefined),
            )
        } else {
            None
        };
        use NativeMethod::*;
        // The kind-inspecting predicates (no coercion).
        let predicate = |s: Option<Slot>, kind: NativeMethod| -> bool {
            let s = match s {
                Some(s) => s,
                None => return false,
            };
            match s.kind {
                Kind::Integer => !matches!(kind, NumberIsNaN),
                Kind::Number => {
                    let n = to_number(&s);
                    match kind {
                        NumberIsNaN => n.is_nan(),
                        NumberIsFinite => n.is_finite(),
                        NumberIsInteger => n.is_finite() && n.trunc() == n,
                        NumberIsSafeInteger => {
                            n.is_finite()
                                && n.trunc() == n
                                && (-9007199254740991.0..=9007199254740991.0).contains(&n)
                        }
                        _ => false,
                    }
                }
                _ => false,
            }
        };
        self.meter.tick_raw(NUMBER_FRAME_METERING);
        let result = match m {
            NumberIsFinite | NumberIsInteger | NumberIsNaN | NumberIsSafeInteger => {
                Slot::boolean(predicate(arg0, m))
            }
            NumberToLocaleString => {
                let prim = match this.value {
                    Payload::Integer(_) | Payload::Number(_) => this,
                    Payload::Reference(r) => match self.wrapper_data.get(&r).copied() {
                        Some(s) if matches!(s.value, Payload::Integer(_) | Payload::Number(_)) => s,
                        _ => return Err(self.catchable_type_error_msg("this: not a number".into())),
                    },
                    _ => return Err(self.catchable_type_error_msg("this: not a number".into())),
                };
                let locale = arg0.unwrap_or_else(Slot::undefined);
                let options = if argc > 1 {
                    self.stack
                        .get(base + 5)
                        .copied()
                        .unwrap_or_else(Slot::undefined)
                } else {
                    Slot::undefined()
                };
                let data = self.build_number_format(code, locale, options)?;
                let resolved = self.nf_resolved(&data);
                let rendered = crate::intl_number::format_to_string(&resolved, to_number(&prim));
                self.intl_string(&rendered)
            }
            // Number.prototype.toString([radix]) — radix 10 renders through the
            // metered `fxNumberToString`; a radix in [2,36] runs the digit
            // conversion. The non-decimal path covers the finite integral
            // domain plus the three non-finite/zero spellings; a fractional
            // finite value keeps an honest named skip until its shortest-round-
            // trip digit generation is modeled.
            NumberToString => {
                let prim = match this.value {
                    Payload::Integer(_) | Payload::Number(_) => this,
                    Payload::Reference(r) => match self.wrapper_data.get(&r).copied() {
                        Some(s) if matches!(s.value, Payload::Integer(_) | Payload::Number(_)) => s,
                        _ => return Err(self.catchable_type_error_msg("this: not a number".into())),
                    },
                    _ => return Err(self.catchable_type_error_msg("this: not a number".into())),
                };
                let radix = match arg0 {
                    Some(s) if s.kind != Kind::Undefined => {
                        let r = self.number_radix_integer(code, s)? as f64;
                        if !(2.0..=36.0).contains(&r) {
                            return Err(self.catchable_range_error_msg("invalid radix".into()));
                        }
                        r as u32
                    }
                    _ => 10,
                };
                if radix == 10 {
                    // `fx_Number_prototype_toString` routes radix-10 through
                    // `fxToString`/`fxNumberToString`, which carries the same
                    // fixed 33280-raw host residual as the `mxMeterSome`-path
                    // built-ins (measured against the pin) beyond the metered
                    // `fxNumberToString` step + result chunk.
                    self.meter.tick_raw(STRING_METERSOME_FRAME_METERING);
                    self.to_string_slot_metered(prim)
                } else {
                    let n = to_number(&prim);
                    let bytes = match number_to_radix_string(n, radix) {
                        Some(bytes) => bytes,
                        None => {
                            return Err(Step::Host(Halt::NotImplemented(
                                "Number.toString:fractional-non-decimal-radix",
                            )));
                        }
                    };
                    self.meter.tick_builtin();
                    let off = self.alloc_str_text_metered(&bytes)?;
                    Slot::of(Kind::String, Payload::String(off))
                }
            }
            // parseInt(string[,radix]) — ToString followed by the integer
            // prefix parse.
            GlobalParseInt => {
                let units = self.to_string_units(code, arg0.unwrap_or_else(Slot::undefined))?;
                let bytes = scalar_numeric_prefix(&units).into_bytes();
                let radix_arg = self.stack.get(base + 5).copied();
                let radix = match radix_arg {
                    Some(s) if argc > 1 && s.kind != Kind::Undefined => {
                        let r = self.number_radix_integer(code, s)? as f64;
                        if r != 0.0 && !(2.0..=36.0).contains(&r) {
                            return Ok(Slot::number(f64::NAN));
                        }
                        r as i32
                    }
                    _ => 0,
                };
                parse_int(&bytes, radix)
            }
            // parseFloat(string) — ToString followed by the float prefix parse
            // (`fxStringToNumber`, whole = 0).
            GlobalParseFloat => {
                let units = self.to_string_units(code, arg0.unwrap_or_else(Slot::undefined))?;
                let bytes = scalar_numeric_prefix(&units).into_bytes();
                Slot::number(string_to_number(&bytes, false))
            }
            // isNaN(x)/isFinite(x) — ToNumber then the fpclassify test. A
            // string routes through the whole-string parse; objects use the
            // shared re-entrant ToPrimitive/ToNumber machinery.
            GlobalIsNaN | GlobalIsFinite => {
                let n = match arg0 {
                    None => f64::NAN,
                    Some(s) => self.to_number_f64(code, s)?,
                };
                Slot::boolean(if m == GlobalIsNaN {
                    n.is_nan()
                } else {
                    n.is_finite()
                })
            }
            _ => return Err(Step::Host(Halt::NotImplemented("number:unmodeled"))),
        };
        Ok(result)
    }
}

// A non-scalar code unit ends either numeric prefix grammar. Preserve the
// scalar prefix exactly instead of inventing a replacement character.
fn scalar_numeric_prefix(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied())
        .map_while(Result::ok)
        .collect()
}
