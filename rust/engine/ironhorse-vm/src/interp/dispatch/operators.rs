//! Operators opcode semantics.
//! Return transfers unchanged; only the dispatch loop owns catch resumption.
use super::super::*;

impl Interp {
    pub(super) fn dispatch_to_string(&mut self, code: &[u8]) -> Result<(), Step> {
        let top = *self.stack.last().unwrap_or(&Slot::undefined());
        let primitive = (self.to_primitive(code, top, true))?;
        if primitive.kind == Kind::Symbol {
            return Err(Step::Host(Halt::NotImplemented("to_string:symbol")));
        }
        let value = self.to_string_slot_metered(primitive);
        if let Some(top) = self.stack.last_mut() {
            *top = value;
        }
        Ok(())
    }

    pub(super) fn dispatch_exponentiation(&mut self, code: &[u8]) -> Result<(), Step> {
        let n = self.stack.len();
        if n < 2 {
            return Err(Step::Host(Halt::EngineInvariant(
                "exponentiation:stack-underflow",
            )));
        }
        let left = self.stack[n - 2];
        let right = self.stack[n - 1];
        let a = (self.to_number_value(code, left))?;
        let b = (self.to_number_value(code, right))?;
        self.stack.truncate(n - 2);
        match (a.kind, b.kind) {
            (Kind::BigInt, Kind::BigInt) => {
                let result = (self.bigint_pow(a, b))?;
                self.push(result);
            }
            (Kind::BigInt, _) | (_, Kind::BigInt) => {
                let error = self.internal_error(
                    "TypeError",
                    if a.kind == Kind::BigInt {
                        "cannot coerce right operand to bigint"
                    } else {
                        "cannot coerce left operand to bigint"
                    }
                    .into(),
                );
                return Err(self.raise_js(error));
            }
            _ => self.push(Slot::number(fx_pow(to_number(&a), to_number(&b)))),
        }
        Ok(())
    }

    pub(super) fn dispatch_instanceof(&mut self, code: &[u8]) -> Result<(), Step> {
        let right = self.pop();
        let left = self.pop();
        let result = (self.instanceof_operator(code, left, right))?;
        self.push(Slot::boolean(result));
        Ok(())
    }

    pub(super) fn dispatch_in(&mut self, code: &[u8]) -> Result<(), Step> {
        let obj = self.pop();
        let key = self.pop();
        let objref = match obj.value {
            // A primitive symbol is NOT an object, however much its
            // `Payload::Reference(desc)` looks like one: the target
            // would be the description slot, so `k in sym` answered
            // over an object handed to `Symbol()`. It joins the
            // other primitives below.
            Payload::Reference(r) if obj.kind != Kind::Symbol => r,
            // `k in 5` / `k in null` / `k in Symbol()`:
            // `mxRunDebug(XS_TYPE_ERROR, "in: not an object")`.
            _ => return Err(self.catchable_type_error_msg("in: not an object".into())),
        };
        // The spec checks that the RHS is an object before
        // coercing the LHS. In particular, an object key's
        // `@@toPrimitive` must not run for `key in null`.
        let key = (self.to_property_key(code, key))?;
        // `k in p`: the proxy `has` trap (ECMA-262 10.5.7). No index /
        // boot-default gate applies — a proxy honors any string key.
        if self.proxies.contains_key(&objref) {
            // An uninterned canonical index reaches the trap with a
            // key spelled from the index, minting nothing.
            let index = match (key.kind, key.value) {
                (Kind::String, Payload::String(off)) => {
                    let name = self.str_text(off);
                    string_to_index(&name).filter(|_| !self.symbol_ids.contains_key(&name))
                }
                _ => None,
            };
            let present = (match index {
                Some(index) => self.uninterned_index_proxy_has(code, objref, index),
                None => match self.property_key_id(key, false) {
                    Some(id) => self.proxy_has(code, objref, id),
                    None => return Err(Step::Host(Halt::EngineInvariant("in:proxy-key"))),
                },
            })?;
            self.meter.tick_raw(IN_METERING);
            self.push(Slot::boolean(present));
            return Ok(());
        }
        // `k in sample`: the integer-indexed exotic `[[HasProperty]]`
        // (10.4.5.3). A canonical numeric index is present iff it is
        // a valid integer index; any other key walks the chain.
        if let Some(&ta) = self.typed_arrays.get(&objref) {
            if let Some(n) = self.ta_numeric_index(key) {
                self.meter.tick_raw(IN_METERING);
                self.push(Slot::boolean(self.ta_valid_index(ta, n).is_some()));
                return Ok(());
            }
        }
        // Computed non-index keys also need the create-only intrinsic
        // linking seam used by Reflect.has (including SES permits).
        // A canonical index string is what XS's `fxAt` turns into
        // `(XS_NO_ID, index)`; uninterned, it stays an index here
        // and mints nothing, so `for (i…) i in o` cannot walk the
        // id space into its saturation guard.
        let read_key = if let (Kind::String, Payload::String(off)) = (key.kind, key.value) {
            let name = self.str_text(off);
            match string_to_index(&name).filter(|_| !self.symbol_ids.contains_key(&name)) {
                Some(index) => ReadKey::Index(index),
                None => ReadKey::Id((self.to_property_id(code, key))?),
            }
        } else {
            ReadKey::Id((self.to_property_id(code, key))?)
        };
        // Answer with the metered chain walk: `fxRunIn` calls
        // `fxHasAt` once and does not re-enter per level, so the
        // per-level cost is the same `fxOrdinaryHasProperty` frame
        // the `with` scopable walk pays — half a code unit, not the
        // whole one this site charged per prototype *hop* before.
        // That ran long by `1<<15` per level on a deep chain and
        // short by the same on a null-prototype receiver; the
        // shallow objects the tests used descend no level, so
        // nothing caught either. `IN_METERING` is unchanged: it was
        // fixed by the own-hit case, which runs no frame.
        let (present, frames) = (self.mop_has_read_with_recursions(code, objref, read_key))?;
        self.meter.tick_raw(IN_METERING);
        self.meter
            .tick_raw(frames * ORDINARY_HAS_PROPERTY_FRAME_METERING);
        self.push(Slot::boolean(present));
        Ok(())
    }
}
