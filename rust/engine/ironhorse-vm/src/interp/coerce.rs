//! Guest-observable coercion, comparison, and arithmetic operations.
use super::*;

impl Interp {
    /// Preserve the integer fast representation without losing negative zero
    /// or a non-integral/non-finite Number.
    pub(super) fn slot_from_number(value: f64) -> Slot {
        if value == (value as i32) as f64 && !(value == 0.0 && value.is_sign_negative()) {
            Slot::integer(value as i32)
        } else {
            Slot::number(value)
        }
    }

    /// `ToLength(Get(...))` for the array-like `length`, as a `u64` capped at
    /// 2^53 - 1 (the spec integer-index ceiling).
    pub(super) fn to_length_value(&mut self, code: &[u8], value: Slot) -> Result<u64, Step> {
        let n = self.to_number_f64(code, value)?;
        if n.is_nan() || n <= 0.0 {
            return Ok(0);
        }
        let capped = n.trunc().min(9_007_199_254_740_991.0);
        Ok(capped as u64)
    }

    /// Build a primitive-wrapper object (`new Boolean`/`Number`/`String`)
    /// around the already-computed primitive `prim`. Meters the native
    /// `Object` empty-object cost plus [`WRAPPER_CONSTRUCT_EXTRA`], chains the
    /// wrapper to the constructor's `%X.prototype%` (so it is `instanceof X`),
    /// and records the wrapped primitive so it stringifies as the primitive.
    /// `fxToInstance` boxing of a primitive for the `XS_CODE_TO_INSTANCE`
    /// opcode (`with(primitive)`, object-destructuring of a primitive RHS) —
    /// XS's `fxNewBooleanInstance`/`fxNewNumberInstance` (`xsType.c`
    /// `fxToInstance`). Distinct from [`Self::build_wrapper`], which is the
    /// `new Number()`/`new Boolean()` **constructor** path (a native dispatch
    /// plus the calibrated [`WRAPPER_CONSTRUCT_EXTRA`]): the bare coercion is
    /// two `fxNewSlot` allocations only — `fxNewObjectInstance` (the wrapper
    /// head) and `fxNext<Type>Property` (the internal `[[NumberData]]`/
    /// `[[BooleanData]]` slot) — with no constructor call frame, so it meters
    /// exactly `2 × SLOT_ALLOCATION_METERING` beyond the opcode dispatch. The
    /// wrapped primitive lives in [`Self::wrapper_data`] (where `valueOf`/
    /// `toString`/the bare completion read it); the wrapper carries no own
    /// enumerable property beyond String's derived indexed characters, so a
    /// name resolved against it (the `with` scopable walk) otherwise falls
    /// through to the corresponding intrinsic prototype and then outward,
    /// matching the oracle. In strict code XS stamps the
    /// wrapper `XS_DONT_PATCH_FLAG` (non-extensible); `with` is a strict-mode
    /// SyntaxError so that arm only matters to a strict destructuring temporary,
    /// but it is set faithfully. String's exotic `length` and indexed
    /// characters are derived from this side-table payload by the property and
    /// CopyDataProperties seams. BigInt remains the only primitive without a
    /// modeled realm wrapper.
    /// A ToObject of a primitive performed by the **language** rather than by a
    /// built-in: `XS_CODE_TO_INSTANCE` (a `with` head, an object-destructuring
    /// RHS) and the sloppy-callee `this` bind. Beyond the two allocations
    /// [`Self::box_primitive_wrapper`] meters, XS pays two `mxMeterOne` steps
    /// here — `fxToInstance` dispatching on the primitive's kind and calling
    /// the per-type `fxNew<Type>Instance`.
    ///
    /// Measured as exactly `1<<15` per box, uniform across
    /// Boolean/Number/String/Symbol/BigInt and across both constructs
    /// (`with (0) { … }`, `var {length: n} = 'ab'`, `f.call(1)`), and omitted
    /// entirely before.
    ///
    /// A ToObject performed *inside* a built-in — `CreateArrayIterator`'s
    /// coercion in `Array.prototype.values.call('a')`, `Object(primitive)`,
    /// `Object.getOwnPropertyDescriptor`'s receiver — does **not** pay it and
    /// calls [`Self::box_primitive_wrapper`] directly. Whether XS truly charges
    /// nothing on those paths or ironhorse has an offsetting gap elsewhere in
    /// them is not settled here; they are left exactly as they metered before
    /// this constant existed, so this moves only the two sites it measured.
    pub(super) fn box_primitive_to_instance(
        &mut self,
        native: Native,
        prim: Slot,
    ) -> crate::value::SlotIndex {
        let inst = self.box_primitive_wrapper(native, prim);
        self.meter.tick_builtin_some(2);
        inst
    }

    /// The wrapper allocation alone, with no `fxToInstance` dispatch cost: two
    /// `fxNewSlot`s and the side-table payload. The entry point for a ToObject
    /// performed *inside* a built-in, where XS reaches the wrapper without the
    /// metered dispatch [`Self::box_primitive_to_instance`] models.
    pub(super) fn box_primitive_wrapper(
        &mut self,
        native: Native,
        prim: Slot,
    ) -> crate::value::SlotIndex {
        // fxNewObjectInstance: one fxNewSlot for the wrapper head.
        let proto = self
            .intrinsics
            .get(native.display_name())
            .and_then(|&c| self.prototype_of(c))
            .unwrap_or(self.object_proto);
        let inst = self.slots.alloc(Slot::instance(proto));
        self.meter.tick_slot_alloc();
        // fxNext<Type>Property: one fxNewSlot for the internal [[XxxData]]
        // slot. ironhorse holds the wrapped primitive in the side table, so
        // the slot's cost is metered here explicitly.
        self.meter.tick_slot_alloc();
        self.wrapper_data.insert(inst, prim);
        if self.strict {
            self.slots.get_mut(inst).flag |= XS_DONT_PATCH_FLAG;
        }
        inst
    }

    /// `Object(primitive)` / `new Object(primitive)` creates an ordinary,
    /// extensible wrapper even when the call appears in strict code. The
    /// shared coercion boxer stamps strict temporary wrappers non-extensible
    /// to mirror XS internals, so the explicit constructor path clears only
    /// that internal stamp before exposing the object to guest mutation.
    pub(super) fn box_object_primitive(
        &mut self,
        native: Native,
        prim: Slot,
    ) -> crate::value::SlotIndex {
        let inst = self.box_primitive_wrapper(native, prim);
        self.slots.get_mut(inst).flag &= !XS_DONT_PATCH_FLAG;
        inst
    }

    pub(super) fn build_wrapper(&mut self, native: Native, prim: Slot) -> Slot {
        self.meter.tick_builtin();
        let inst = self.new_object();
        self.meter.tick_raw(WRAPPER_CONSTRUCT_EXTRA);
        if let Some(proto) = self
            .intrinsics
            .get(native.display_name())
            .and_then(|&c| self.prototype_of(c))
        {
            self.slots.get_mut(inst).value = Payload::Reference(proto);
        }
        self.wrapper_data.insert(inst, prim);
        Slot::of(Kind::Reference, Payload::Reference(inst))
    }

    pub(super) fn value_to_string(&mut self, code: &[u8], value: Slot) -> Result<String, Step> {
        let primitive = if value.kind == Kind::Reference {
            self.to_primitive(code, value, true)?
        } else {
            value
        };
        if primitive.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to string".into()));
        }
        Ok(String::from_utf8_lossy(&self.to_string_bytes_metered(primitive)).into_owned())
    }

    /// ECMAScript `ToString`, retaining UTF-16 code units when the primitive
    /// already is a String (so lone surrogates never pass through Rust's
    /// scalar-value `String`). Objects use the shared, re-entrant
    /// `ToPrimitive` machinery; null and undefined are allowed here because
    /// this helper is also used for ordinary arguments.
    pub(super) fn to_string_units(&mut self, code: &[u8], value: Slot) -> Result<Vec<u16>, Step> {
        let primitive = if value.kind == Kind::Reference {
            self.to_primitive(code, value, true)?
        } else {
            value
        };
        if primitive.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to string".into()));
        }
        if let Payload::String(off) = primitive.value {
            return Ok(self.str_units(off));
        }
        let bytes = self.to_string_bytes_metered(primitive);
        Ok(String::from_utf8_lossy(&bytes).encode_utf16().collect())
    }

    /// ECMAScript `ToString`, retaining the resulting primitive as a String
    /// slot so callers can pass it to user code without a lossy text roundtrip.
    pub(super) fn to_string_slot(&mut self, code: &[u8], value: Slot) -> Result<Slot, Step> {
        let primitive = if value.kind == Kind::Reference {
            self.to_primitive(code, value, true)?
        } else {
            value
        };
        if primitive.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to string".into()));
        }
        Ok(self.to_string_slot_metered(primitive))
    }

    /// `? ToPropertyKey(key)` reduced to the canonical property-key VALUE (a
    /// Symbol slot, or a String slot) rather than an interned id, so the bucket
    /// preserves the key for a later `CreateDataPropertyOrThrow`.
    pub(super) fn to_property_key_slot(&mut self, code: &[u8], key: Slot) -> Result<Slot, Step> {
        if key.kind == Kind::Symbol {
            return Ok(key);
        }
        let prim = self.to_primitive(code, key, true)?;
        if prim.kind == Kind::Symbol {
            return Ok(prim);
        }
        Ok(self.to_string_slot_metered(prim))
    }

    /// Strict equality (`===`) with chunk-aware string comparison: two heap
    /// strings are equal iff their UTF-16BE content matches (the free
    /// [`strict_equals`] compares only primitive/reference kinds and treats
    /// two strings as unequal because it cannot see the chunk arena).
    pub(super) fn strict_equal(&self, a: &Slot, b: &Slot) -> bool {
        match (a.value, b.value) {
            (Payload::String(x), Payload::String(y)) => {
                // Two-chunk read: only through the arena's guarded
                // comparison (lazy-heap borrow discipline).
                self.chunks.compare_payloads(x, y) == std::cmp::Ordering::Equal
            }
            // `bigint === bigint`: equal iff same sign and magnitude. A BigInt
            // is never `===` a non-BigInt (distinct type), which
            // `strict_equals` already gives.
            (Payload::BigInt(x), Payload::BigInt(y)) => {
                let (nx, mx) = self.read_bigint(x);
                let (ny, my) = self.read_bigint(y);
                nx == ny && mx == my
            }
            _ => strict_equals(a, b),
        }
    }

    /// SameValueZero (`includes`): strict equality except `NaN` equals `NaN`
    /// (and `+0`/`-0` are equal, which strict equality already gives).
    pub(super) fn same_value_zero(&self, a: &Slot, b: &Slot) -> bool {
        if let (Some(x), Some(y)) = (numeric_of(a), numeric_of(b)) {
            if x.is_nan() && y.is_nan() {
                return true;
            }
        }
        self.strict_equal(a, b)
    }

    /// XS's `fxArgToByteLength(argi, length)`: coerce call argument `argi`
    /// (at `stack[base + 4 + argi]`) to a non-negative byte length. Returns
    /// `Some(default)` when the argument is absent/`undefined`, `Some(v)` for
    /// a non-negative integer or a truncated in-range number (NaN → 0), and
    /// `None` when the value is negative/oversized (a RangeError in XS) or a
    /// kind needing general ToNumber coercion — an honest skip for the
    /// caller. The `default` is only returned for an absent/undefined arg.
    pub(super) fn arg_to_byte_length(&self, base: usize, argi: usize, default: u32) -> Option<u32> {
        let a = self
            .stack
            .get(base + 4 + argi)
            .copied()
            .unwrap_or_else(Slot::undefined);
        match a.kind {
            Kind::Undefined => Some(default),
            Kind::Integer => match a.value {
                Payload::Integer(i) if i >= 0 => Some(i as u32),
                _ => None,
            },
            Kind::Number => match a.value {
                Payload::Number(n) => {
                    let t = n.trunc();
                    if t.is_nan() {
                        Some(0)
                    } else if t < 0.0 || t > 0x7FFF_FFFFu32 as f64 {
                        None
                    } else {
                        Some(t as u32)
                    }
                }
                _ => None,
            },
            _ => None,
        }
    }

    /// `ToIndex(value)` (ECMA-262 7.1.22) for a buffer byte length that needs
    /// the **general** coercion path (a boolean / string / object argument,
    /// whose `valueOf`/`toString` must be observed). Distinct from the
    /// integer/number fast paths the constructors keep inline (whose exact
    /// metering the meter-exact corpus pins); this arm is reached only where the
    /// old code self-named an honest `coerce-length` skip. Raises realm-local,
    /// **catchable** errors exactly where XS does: a `Symbol`/`BigInt` argument
    /// throws `TypeError` (its `ToNumber` step), and a negative or
    /// over-`0x7FFFFFFF` result throws `RangeError` (XS's `fxToBigInt`/allocation
    /// ceiling — a byte length above the max chunk size cannot be a backing
    /// store). Returns the clamped `u32`, or a `Halt` (a `Resume` to the catch
    /// target, or an escaping `Throw`) the caller propagates with `?`.
    pub(super) fn to_index_arg(&mut self, code: &[u8], value: Slot) -> Result<u32, Step> {
        let n = self.to_number_f64(code, value)?;
        let t = if n.is_nan() { 0.0 } else { n.trunc() };
        if t < 0.0 {
            return Err(self.catchable_range_error_msg("byteLength < 0".into()));
        }
        if t > 0x7FFF_FFFFu32 as f64 {
            return Err(self.catchable_range_error_msg("byteLength too big".into()));
        }
        Ok(t as u32)
    }

    /// `fxArgToIndex`: the argument at `base`+`argi` coerced to a relative
    /// index in `[0, length]` (negative counts from the end, clamped). Absent
    /// or `undefined` uses `default`. The covered grammar passes small
    /// non-negative integers.
    pub(super) fn arg_to_index(&self, base: usize, argi: usize, default: u32, length: u32) -> u32 {
        let a = self.stack.get(base + 4 + argi).copied();
        let n = match a {
            None => return default,
            Some(s) if s.kind == Kind::Undefined => return default,
            Some(s) => match numeric_of(&s) {
                Some(n) => n,
                None => return default,
            },
        };
        if n.is_nan() {
            return 0;
        }
        let t = n.trunc();
        if t < 0.0 {
            let from_end = length as f64 + t;
            if from_end < 0.0 {
                0
            } else {
                from_end as u32
            }
        } else if t > length as f64 {
            length
        } else {
            t as u32
        }
    }

    /// ToBoolean with chunk access: a heap string is truthy iff its
    /// content is non-empty (XS's `mxStringLength != 0`); every other kind
    /// defers to the pure [`to_boolean`]. The empty-string case is why this
    /// must route through the machine — a bare `to_boolean` cannot see the
    /// chunk and would call `""` truthy.
    #[inline]
    pub(super) fn truthy(&self, s: &Slot) -> bool {
        match s.value {
            Payload::String(off) => !self.str_content(off).is_empty(),
            // ToBoolean(bigint): `0n` is falsy, every other BigInt truthy.
            Payload::BigInt(off) => {
                let (_, mag) = self.read_bigint(off);
                !bi_is_zero(&mag)
            }
            _ => to_boolean(s),
        }
    }

    // Binary numeric arithmetic, ported from the xsRun.c integer fast
    // paths with checked-overflow promotion to f64. A string operand needs
    // `ToNumber(string)` (string→number parsing), outside the covered
    // primitive subset, so it returns `Err` and the caller self-names
    // unsupported rather than producing a spurious `NaN`. (A reference
    // operand ToPrimitives to `NaN` for a plain object, which matches XS,
    // so it is left on the numeric path.)
    pub(super) fn binary_arith(&mut self, code: &[u8], op: ArithOp) -> Result<(), Step> {
        let n = self.stack.len();
        if n < 2 {
            return Err(Step::Host(Halt::EngineInvariant(
                "arithmetic:stack-underflow",
            )));
        }
        let a_value = self.stack[n - 2];
        let b_value = self.stack[n - 1];
        let a = self.to_number_value(code, a_value)?;
        let b = self.to_number_value(code, b_value)?;
        self.stack.truncate(n - 2);
        // ToNumeric has completed left-to-right above. Arithmetic with one
        // BigInt and one Number is a catchable TypeError; two BigInts stay in
        // the arbitrary-precision domain for every binary arithmetic op.
        if a.kind == Kind::BigInt || b.kind == Kind::BigInt {
            match self.try_bigint_binop(op, a, b)? {
                Some(r) => {
                    self.push(r);
                    return Ok(());
                }
                None => {}
            }
            return Err(Step::Host(Halt::EngineInvariant(
                "bigint:missing-binary-result",
            )));
        }
        self.push(apply_arith(op, &a, &b));
        Ok(())
    }

    pub(super) fn binary_bit(&mut self, code: &[u8], op: BitOp) -> Result<(), Step> {
        let n = self.stack.len();
        if n < 2 {
            return Err(Step::Host(Halt::EngineInvariant("bitwise:stack-underflow")));
        }
        let a_value = self.stack[n - 2];
        let b_value = self.stack[n - 1];
        let (a, b) = if op == BitOp::Shr {
            (
                self.to_number_value(code, a_value)?,
                self.to_number_value(code, b_value)?,
            )
        } else {
            (
                self.to_numeric_integer_value(code, a_value)?,
                self.to_numeric_integer_value(code, b_value)?,
            )
        };
        self.stack.truncate(n - 2);
        if a.kind == Kind::BigInt || b.kind == Kind::BigInt {
            let (Payload::BigInt(a_off), Payload::BigInt(b_off)) = (a.value, b.value) else {
                return Err(self.catchable_type_error_msg(if a.kind == Kind::BigInt {
                    "cannot coerce right operand to bigint".into()
                } else {
                    "cannot coerce left operand to bigint".into()
                }));
            };
            if op == BitOp::Shr {
                // BigInt has no unsigned-right-shift operation. Both operands
                // have nevertheless completed ToNumeric before this TypeError.
                return Err(self.catchable_type_error_msg("no such operation".into()));
            }
            let result = match op {
                BitOp::And | BitOp::Or | BitOp::Xor => self.bigint_bitwise(op, a_off, b_off),
                BitOp::Shl | BitOp::Sar => self.bigint_shift(op, a_off, b_off)?,
                BitOp::Shr => unreachable!(),
            };
            self.push(result);
            return Ok(());
        }
        let ai = to_int32(to_number(&a));
        let bi = to_int32(to_number(&b));
        let r = match op {
            BitOp::And => ai & bi,
            BitOp::Or => ai | bi,
            BitOp::Xor => ai ^ bi,
            BitOp::Shl => ((ai as u32) << (bi & 0x1f)) as i32,
            BitOp::Sar => ai >> (bi & 0x1f),
            BitOp::Shr => ((ai as u32) >> (bi & 0x1f)) as i32,
        };
        // Unsigned shift can exceed i32 range; XS keeps it a number
        // when the high bit is set.
        if let BitOp::Shr = op {
            let u = (ai as u32) >> (bi & 0x1f);
            if u > i32::MAX as u32 {
                self.push(Slot::number(u as f64));
                return Ok(());
            }
        }
        self.push(Slot::integer(r));
        Ok(())
    }

    /// Relational comparison (`<`/`<=`/`>`/`>=`). Two strings compare
    /// lexicographically by UTF-16BE byte (== code-unit order, XS's
    /// `c_strcmp`, and the ECMAScript abstract relational comparison on
    /// strings); two numerics compare as `f64` with NaN → false. A mixed
    /// string/numeric pair needs `ToNumber(string)` (or `ToPrimitive` of a
    /// reference), outside the covered subset, so it returns `Err` and the
    /// caller self-names unsupported.
    pub(super) fn relational(&mut self, code: &[u8], op: RelOp) -> Result<(), Step> {
        let n = self.stack.len();
        if n < 2 {
            return Err(Step::Host(Halt::EngineInvariant(
                "comparison:stack-underflow",
            )));
        }
        let a_value = self.stack[n - 2];
        let b_value = self.stack[n - 1];
        let a = self.to_primitive(code, a_value, false)?;
        let b = self.to_primitive(code, b_value, false)?;
        self.stack.truncate(n - 2);
        if a.kind == Kind::String && b.kind == Kind::String {
            if let (Payload::String(x), Payload::String(y)) = (a.value, b.value) {
                let r = {
                    // Two-chunk read: only through the arena's guarded
                    // comparison (lazy-heap borrow discipline).
                    let ord = self.chunks.compare_payloads(x, y);
                    match op {
                        RelOp::Less => ord.is_lt(),
                        RelOp::LessEqual => ord.is_le(),
                        RelOp::More => ord.is_gt(),
                        RelOp::MoreEqual => ord.is_ge(),
                    }
                };
                self.push(Slot::boolean(r));
                return Ok(());
            }
        }
        // A mixed string/numeric comparison converts both operands to numbers
        // after the primitive step below.
        // BigInt relational (`<`/`<=`/`>`/`>=`). String operands use
        // StringToBigInt (an invalid integer string makes the comparison
        // undefined/false); other primitives use ToNumeric and compare the
        // exact mathematical values. In particular, never round the BigInt to
        // f64 at this boundary: values around 2**53 depend on the Number's
        // fractional/integer position relative to the exact BigInt.
        if a.kind == Kind::BigInt || b.kind == Kind::BigInt {
            let ordering = match (a.value, b.value) {
                (Payload::BigInt(x), Payload::BigInt(y)) => {
                    let (nx, mx) = self.read_bigint(x);
                    let (ny, my) = self.read_bigint(y);
                    Some(bi_cmp(nx, &mx, ny, &my))
                }
                (Payload::BigInt(x), Payload::String(y)) => {
                    let text = self.str_text(y);
                    parse_bigint_string(&text).map(|(ny, my)| {
                        let (nx, mx) = self.read_bigint(x);
                        bi_cmp(nx, &mx, ny, &my)
                    })
                }
                (Payload::String(x), Payload::BigInt(y)) => {
                    let text = self.str_text(x);
                    parse_bigint_string(&text).map(|(nx, mx)| {
                        let (ny, my) = self.read_bigint(y);
                        bi_cmp(nx, &mx, ny, &my)
                    })
                }
                (Payload::BigInt(x), _) => {
                    let number = self.to_number_value(code, b)?;
                    if number.kind == Kind::BigInt {
                        unreachable!("the both-BigInt case was handled above");
                    }
                    self.compare_bigint_number(x, to_number(&number))
                }
                (_, Payload::BigInt(y)) => {
                    let number = self.to_number_value(code, a)?;
                    if number.kind == Kind::BigInt {
                        unreachable!("the both-BigInt case was handled above");
                    }
                    self.compare_bigint_number(y, to_number(&number))
                        .map(std::cmp::Ordering::reverse)
                }
                _ => unreachable!("a BigInt kind carries a BigInt payload"),
            };
            use std::cmp::Ordering;
            let r = ordering.is_some_and(|ord| match op {
                RelOp::Less => ord == Ordering::Less,
                RelOp::LessEqual => ord != Ordering::Greater,
                RelOp::More => ord == Ordering::Greater,
                RelOp::MoreEqual => ord != Ordering::Less,
            });
            self.push(Slot::boolean(r));
            return Ok(());
        }
        let x = to_number(&self.to_number_value(code, a)?);
        let y = to_number(&self.to_number_value(code, b)?);
        let r = if x.is_nan() || y.is_nan() {
            false
        } else {
            match op {
                RelOp::Less => x < y,
                RelOp::LessEqual => x <= y,
                RelOp::More => x > y,
                RelOp::MoreEqual => x >= y,
            }
        };
        self.push(Slot::boolean(r));
        Ok(())
    }

    /// Equality (`===`/`!==`/`==`/`!=`). String↔string compares content
    /// bytes; string↔{null,undefined,symbol} is unequal on both operators;
    /// loose string↔{number,boolean} applies `ToNumber` after any object
    /// operand has already gone through `ToPrimitive`. Non-string kinds keep
    /// the existing primitive/reference-identity comparison.
    pub(super) fn equality(&mut self, code: &[u8], strict: bool, negate: bool) -> Result<(), Step> {
        let mut b = self.pop();
        let mut a = self.pop();
        // Abstract Equality Comparison converts an object operand to a
        // primitive when the other operand is primitive. This is the ordinary
        // wrapper path (`Object(1) == 1`, `new Boolean(true) == true`) as well
        // as user objects with conversion methods. Two references still compare
        // by identity and strict equality never coerces either side.
        // `IsLooselyEqual` only converts an object operand when the other side
        // is a String, Number, BigInt or Symbol (steps 10-11). An Object
        // compared against `null`/`undefined` falls through to step 12 and is
        // `false` with no conversion at all, so running `ToPrimitive` there
        // would let the guest observe a `valueOf`/`toString`/`@@toPrimitive`
        // call the language guarantees does not happen -- and would propagate
        // an abrupt completion from a throwing one.
        let coercible = |other: &Slot| !matches!(other.kind, Kind::Null | Kind::Undefined);
        if !strict {
            if a.kind == Kind::Reference && b.kind != Kind::Reference && coercible(&b) {
                a = self.to_primitive_default(code, a)?;
            }
            if b.kind == Kind::Reference && a.kind != Kind::Reference && coercible(&a) {
                b = self.to_primitive_default(code, b)?;
            }
        }
        let eq = match (a.kind, b.kind) {
            (Kind::String, Kind::String) => match (a.value, b.value) {
                (Payload::String(x), Payload::String(y)) => {
                    // Two-chunk read: only through the arena's guarded
                    // comparison (lazy-heap borrow discipline).
                    self.chunks.compare_payloads(x, y) == std::cmp::Ordering::Equal
                }
                _ => false,
            },
            // A string is never `==`/`===` to null/undefined.
            (Kind::String, Kind::Null)
            | (Kind::String, Kind::Undefined)
            | (Kind::Null, Kind::String)
            | (Kind::Undefined, Kind::String) => false,
            (Kind::String, Kind::Integer | Kind::Number | Kind::Boolean) => {
                if strict {
                    false
                } else {
                    let x = match a.value {
                        Payload::String(off) => {
                            string_to_number(self.str_text(off).as_bytes(), true)
                        }
                        _ => f64::NAN,
                    };
                    let y = to_number(&b);
                    !x.is_nan() && !y.is_nan() && x == y
                }
            }
            (Kind::Integer | Kind::Number | Kind::Boolean, Kind::String) => {
                if strict {
                    false
                } else {
                    let x = to_number(&a);
                    let y = match b.value {
                        Payload::String(off) => {
                            string_to_number(self.str_text(off).as_bytes(), true)
                        }
                        _ => f64::NAN,
                    };
                    !x.is_nan() && !y.is_nan() && x == y
                }
            }
            (Kind::String, Kind::Symbol) | (Kind::Symbol, Kind::String) => false,
            (Kind::String, _) | (_, Kind::String) => {
                if strict {
                    false // `===` across types is false without coercion
                } else {
                    return Err(Step::Host(Halt::NotImplemented("equal"))); // `==` needs ToNumber(string)
                }
            }
            // BigInt `===`/`==`. Both BigInt: compare sign+magnitude
            // (`fxBigIntCompare` → `fxBigInt_comp`). The compare itself neither
            // allocates nor meters a digit step, so beyond the opcode dispatch
            // it carries no residual (measured raw-exact against the pin).
            (Kind::BigInt, Kind::BigInt) => self.strict_equal(&a, &b),
            // BigInt mixed with a Number/Integer. `===` across types is always
            // false with no residual (XS's strict path falls to `offset = 0`).
            // Loose `==` coerces the number to a BigInt (`fxNumberToBigInt`,
            // its digit chunk metered faithfully) and compares mathematical
            // values — a non-integral or non-finite Number is never equal.
            (Kind::BigInt, Kind::Integer) | (Kind::BigInt, Kind::Number) => {
                if strict {
                    false
                } else {
                    self.bigint_num_loose_eq(a, b)
                }
            }
            (Kind::Integer, Kind::BigInt) | (Kind::Number, Kind::BigInt) => {
                if strict {
                    false
                } else {
                    self.bigint_num_loose_eq(b, a)
                }
            }
            // BigInt is never `==`/`===` null/undefined.
            (Kind::BigInt, Kind::Null)
            | (Kind::Null, Kind::BigInt)
            | (Kind::BigInt, Kind::Undefined)
            | (Kind::Undefined, Kind::BigInt) => false,
            // Boolean first converts to Number, then takes the modeled
            // BigInt↔Number mathematical comparison. A Symbol is simply
            // incomparable. Reference operands have already gone through
            // ToPrimitive above.
            (Kind::BigInt, Kind::Boolean) => {
                if strict {
                    false
                } else {
                    let n = Slot::integer(if matches!(b.value, Payload::Boolean(true)) {
                        1
                    } else {
                        0
                    });
                    self.bigint_num_loose_eq(a, n)
                }
            }
            (Kind::Boolean, Kind::BigInt) => {
                if strict {
                    false
                } else {
                    let n = Slot::integer(if matches!(a.value, Payload::Boolean(true)) {
                        1
                    } else {
                        0
                    });
                    self.bigint_num_loose_eq(b, n)
                }
            }
            (Kind::BigInt, Kind::Symbol) | (Kind::Symbol, Kind::BigInt) => false,
            // BigInt↔String still needs arbitrary-precision StringToBigInt and
            // its allocation metering. Keep that boundary named rather than
            // round through an imprecise Number.
            (Kind::BigInt, _) | (_, Kind::BigInt) => {
                if strict {
                    false
                } else {
                    return Err(Step::Host(Halt::NotImplemented("equal")));
                }
            }
            _ => {
                if strict {
                    strict_equals(&a, &b)
                } else {
                    loose_equals(&a, &b)
                }
            }
        };
        self.push(Slot::boolean(eq ^ negate));
        Ok(())
    }

    /// Invoke one of the callable methods selected by `ToPrimitive` through
    /// the shared `Call` dispatcher.
    pub(super) fn call_primitive_method(
        &mut self,
        code: &[u8],
        method: Slot,
        receiver: Slot,
        args: &[Slot],
    ) -> Result<Slot, Step> {
        if !self.is_callable_value(method) {
            // GetMethod/Call requires a callable conversion hook. A present
            // non-callable `@@toPrimitive`, `valueOf`, or `toString` throws a
            // realm-local TypeError that surrounding JS can catch.
            return Err(self.catchable_type_error_msg("call: not a function".into()));
        }
        self.invoke_value(code, method, receiver, args)
    }

    /// ECMAScript `ToPrimitive`, including `@@toPrimitive` and the ordinary
    /// `valueOf`/`toString` fallback order.  The hint is `true` for string and
    /// `false` for number; default-hint callers use
    /// [`Self::to_primitive_default`].
    pub(super) fn to_primitive(
        &mut self,
        code: &[u8],
        value: Slot,
        string_hint: bool,
    ) -> Result<Slot, Step> {
        let hint = if string_hint {
            PrimitiveHint::String
        } else {
            PrimitiveHint::Number
        };
        self.to_primitive_with_hint(code, value, hint)
    }

    /// `ToPrimitive(value)` with the ECMAScript default hint. Date objects use
    /// the string fallback order; ordinary objects use the number order, and a
    /// guest `@@toPrimitive` observes the literal `"default"` hint.
    pub(super) fn to_primitive_default(&mut self, code: &[u8], value: Slot) -> Result<Slot, Step> {
        self.to_primitive_with_hint(code, value, PrimitiveHint::Default)
    }

    pub(super) fn to_primitive_with_hint(
        &mut self,
        code: &[u8],
        value: Slot,
        hint: PrimitiveHint,
    ) -> Result<Slot, Step> {
        let inst = match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => inst,
            _ => return Ok(value),
        };
        let string_hint = hint == PrimitiveHint::String
            || (hint == PrimitiveHint::Default && self.dates.contains_key(&inst));

        if let Some((_, symbol)) = self
            .well_known_symbols
            .iter()
            .find(|(name, _)| *name == "toPrimitive")
            .copied()
        {
            if let Payload::Reference(desc) = symbol.value {
                let id = self.intern_symbol_key(desc);
                // GetMethod begins with the object's full [[Get]], including
                // accessor invocation and proxy traps. A raw slot lookup would
                // return an accessor's placeholder value and lose an abrupt
                // completion from its getter.
                let exotic = self.mop_get(code, inst, id, value)?;
                // GetMethod: a `null` `@@toPrimitive` is absent exactly like an
                // `undefined` one and falls through to OrdinaryToPrimitive;
                // only a present non-nullish non-callable is the TypeError
                // (`fxToPrimitive` tests both `mxIsUndefined` and `mxIsNull`).
                if !matches!(exotic.kind, Kind::Undefined | Kind::Null) {
                    let hint = match hint {
                        PrimitiveHint::Default => b"default".as_slice(),
                        PrimitiveHint::Number => b"number".as_slice(),
                        PrimitiveHint::String => b"string".as_slice(),
                    };
                    let off = self.alloc_str_text(hint);
                    let result = self.call_primitive_method(
                        code,
                        exotic,
                        value,
                        &[Slot::of(Kind::String, Payload::String(off))],
                    )?;
                    if result.kind != Kind::Reference {
                        return Ok(result);
                    }
                    return Err(self.catchable_type_error_msg("cannot coerce to primitive".into()));
                }
            }
        }

        self.ordinary_to_primitive(code, value, string_hint)
    }

    /// OrdinaryToPrimitive over an object after the caller has selected the
    /// preferred method order. This deliberately does not consult
    /// `@@toPrimitive`; it is the shared fallback for `ToPrimitive` and the
    /// intrinsic Date exotic-to-primitive method itself.
    pub(super) fn ordinary_to_primitive(
        &mut self,
        code: &[u8],
        value: Slot,
        string_hint: bool,
    ) -> Result<Slot, Step> {
        let inst = match value.value {
            Payload::Reference(inst) if value.kind == Kind::Reference => inst,
            _ => return Err(self.catchable_type_error()),
        };
        let names = if string_hint {
            ["toString", "valueOf"]
        } else {
            ["valueOf", "toString"]
        };
        for name in names {
            let Some(&id) = self.symbol_ids.get(name) else {
                if !string_hint && name == "valueOf" {
                    if let Some(primitive) = self.wrapper_data.get(&inst).copied() {
                        return Ok(primitive);
                    }
                }
                continue;
            };
            let method = self.mop_get(code, inst, id, value)?;
            if method.kind == Kind::Undefined {
                if !string_hint && name == "valueOf" {
                    if let Some(primitive) = self.wrapper_data.get(&inst).copied() {
                        return Ok(primitive);
                    }
                }
                continue;
            }
            // OrdinaryToPrimitive calls only callable `valueOf`/`toString`
            // properties; a present non-callable property is skipped. This
            // differs from the `@@toPrimitive` GetMethod above, where a
            // present non-callable value is itself a TypeError.
            if !self.is_callable_value(method) {
                continue;
            }
            let result = self.call_primitive_method(code, method, value, &[])?;
            if result.kind != Kind::Reference {
                return Ok(result);
            }
        }
        Err(self.catchable_type_error_msg(if string_hint {
            "cannot coerce object to string".into()
        } else {
            "cannot coerce object to number".into()
        }))
    }

    /// `ToNumeric` after `ToPrimitive`, retaining XS's integer fast kind where
    /// possible, preserving BigInt, parsing a string as one complete
    /// ECMAScript number, and raising the required catchable TypeError for a
    /// Symbol. Callers whose abstract operation is specifically `ToNumber`
    /// reject the preserved BigInt at their boundary.
    pub(super) fn to_number_value(&mut self, code: &[u8], value: Slot) -> Result<Slot, Step> {
        let primitive = self.to_primitive(code, value, false)?;
        match primitive.kind {
            Kind::Integer | Kind::Number => Ok(primitive),
            Kind::String => match primitive.value {
                Payload::String(off) => Ok(math_to_integer(string_to_number(
                    self.str_text(off).as_bytes(),
                    true,
                ))),
                _ => unreachable!(),
            },
            Kind::Boolean | Kind::Null | Kind::Undefined => Ok(Slot::number(to_number(&primitive))),
            Kind::BigInt => Ok(primitive),
            Kind::Symbol => {
                Err(self.catchable_type_error_msg("cannot coerce symbol to number".into()))
            }
            _ => Err(Step::Host(Halt::EngineInvariant(
                "to_numeric:non-value-kind",
            ))),
        }
    }

    /// XS bitwise coercion uses ToInteger diagnostics while preserving BigInt.
    pub(super) fn to_numeric_integer_value(
        &mut self,
        code: &[u8],
        value: Slot,
    ) -> Result<Slot, Step> {
        let primitive = self.to_primitive(code, value, false)?;
        if primitive.kind == Kind::Symbol {
            return Err(self.catchable_type_error_msg("cannot coerce symbol to integer".into()));
        }
        self.to_number_value(code, primitive)
    }

    /// ECMAScript `ToNumber`: run the shared observable primitive conversion,
    /// then reject the BigInt value that `ToNumeric` deliberately preserves.
    pub(super) fn to_number_f64(&mut self, code: &[u8], value: Slot) -> Result<f64, Step> {
        let number = self.to_number_value(code, value)?;
        if number.kind == Kind::BigInt {
            return Err(self.catchable_type_error_msg("cannot coerce to number".into()));
        }
        Ok(to_number(&number))
    }

    /// `XS_CODE_ADD` with the string/reference cases (xsRun.c's
    /// `XS_CODE_ADD_GENERAL`): a reference operand needs `ToPrimitive`
    /// (unsupported); a string operand means concatenation
    /// ([`Self::concat_add`]); otherwise the numeric fast path
    /// ([`Self::binary_arith`]).
    pub(super) fn op_add(&mut self, code: &[u8]) -> Result<(), Step> {
        let n = self.stack.len();
        if n < 2 {
            return Err(Step::Host(Halt::EngineInvariant("add:stack-underflow")));
        }
        let a = self.to_primitive_default(code, self.stack[n - 2])?;
        let b = self.to_primitive_default(code, self.stack[n - 1])?;
        // After ToPrimitive, either String selects concatenation and ToString
        // accepts a BigInt. Otherwise two BigInts add, while a BigInt mixed
        // with a Number throws the catchable TypeError from ToNumeric.
        if a.kind == Kind::String || b.kind == Kind::String {
            if a.kind == Kind::Symbol || b.kind == Kind::Symbol {
                return Err(self.catchable_type_error_msg("cannot coerce symbol to string".into()));
            }
            self.stack.truncate(n - 2);
            self.concat_add(a, b);
            return Ok(());
        }
        if a.kind == Kind::BigInt || b.kind == Kind::BigInt {
            if let Some(r) = self.try_bigint_binop(ArithOp::Add, a, b)? {
                self.stack.truncate(n - 2);
                self.push(r);
                return Ok(());
            }
            return Err(Step::Host(Halt::EngineInvariant(
                "bigint:missing-binary-result",
            )));
        }
        self.stack.truncate(n - 2);
        self.push(a);
        self.push(b);
        self.binary_arith(code, ArithOp::Add)
    }

    /// The Symbol primitive carried by a primitive or boxed receiver.
    pub(super) fn symbol_this_value(&mut self, this: Slot) -> Result<Slot, Step> {
        if this.kind == Kind::Symbol {
            return Ok(this);
        }
        match this.value {
            Payload::Reference(owner) => self
                .wrapper_data
                .get(&owner)
                .copied()
                .filter(|value| value.kind == Kind::Symbol)
                .ok_or_else(|| self.catchable_type_error_msg("this: not a symbol".into())),
            _ => Err(self.catchable_type_error_msg("this: not a symbol".into())),
        }
    }
}
