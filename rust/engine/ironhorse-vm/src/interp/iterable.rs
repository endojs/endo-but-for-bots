//! Materialization of arraylike and iterable argument lists.
use super::*;

impl Interp {
    /// `CreateListFromArrayLike(value)` (ECMA-262 7.3.18) with the default
    /// element-type list (any) — read `length`, then each indexed element.
    pub(super) fn arraylike_to_vec(&mut self, code: &[u8], value: Slot) -> Result<Vec<Slot>, Step> {
        let inst = match value.value {
            Payload::Reference(i) if value.kind == Kind::Reference => i,
            _ => return Err(self.catchable_type_error()),
        };
        let length = self.arraylike_length(code, inst, value)?;
        let len = self.to_length_value(code, length)?;
        let capacity = usize::try_from(len).map_err(|_| Step::Host(Halt::HeapExhausted))?;
        let mut out = self.reserve_work_scratch(capacity)?;
        for i in 0..len {
            out.push(self.arraylike_index(code, inst, i, value)?);
        }
        Ok(out)
    }

    /// Residual for `Function.prototype.apply` after an observable
    /// CreateListFromArrayLike walk. Dense and sparse Arrays use XS's full
    /// array schedule. Ordinary objects and arguments objects have already
    /// paid part of that schedule through their property MOP paths.
    pub(super) fn apply_arraylike_metering(&self, value: Slot, len: usize) -> u64 {
        let full = APPLY_ARRAY_BASE_METERING + len as u64 * APPLY_ARRAY_PER_ELEMENT_METERING;
        let Payload::Reference(inst) = value.value else {
            return full;
        };
        if self.arguments_objects.contains(&inst) {
            return full.saturating_sub(APPLY_ARGUMENTS_ARRAYLIKE_CREDIT);
        }
        if self.arrays.contains_key(&inst) || self.proxies.contains_key(&inst) {
            return full;
        }
        full.saturating_sub(APPLY_GENERIC_ARRAYLIKE_CREDIT)
    }

    /// `IterableToList(items)` (ECMA-262 7.4.19): acquire the iterator and its
    /// `next` method once, then collect every IteratorStepValue result. An
    /// abrupt iterator step propagates directly; there is no later per-element
    /// operation requiring IteratorClose.
    pub(super) fn iterable_to_list(&mut self, code: &[u8], items: Slot) -> Result<Vec<Slot>, Step> {
        let outcome = self.run_guest_under_native_try(CallerHandlers::Isolate, |machine| {
            machine.iterable_to_list_inner(code, items)
        });
        match outcome {
            Ok(Ok(values)) => Ok(values),
            Ok(Err(error)) => Err(self.raise_js(error)),
            Err(halt) => Err(halt),
        }
    }

    pub(super) fn iterable_to_list_inner(
        &mut self,
        code: &[u8],
        items: Slot,
    ) -> Result<Result<Vec<Slot>, Slot>, Step> {
        if matches!(items.kind, Kind::Null | Kind::Undefined) {
            let message = if items.kind == Kind::Null {
                "cannot coerce null to object"
            } else {
                "cannot coerce undefined to object"
            };
            return Ok(Err(self.internal_error("TypeError", message.into())));
        }
        let value_id = self.intern_key("value");
        let done_id = self.intern_key("done");
        self.value_id = Some(value_id);
        self.done_id = Some(done_id);
        let iterator_id = self
            .well_known_symbol_property_id("iterator")
            .expect("well-known iterator symbol");
        let iterator_method = match items.value {
            Payload::Reference(object) if items.kind == Kind::Reference => {
                match self.array_from_try(|this| this.mop_get(code, object, iterator_id, items))? {
                    Ok(method) => method,
                    Err(error) => return Ok(Err(error)),
                }
            }
            _ => {
                let proto = match items.kind {
                    Kind::String => self.string_proto,
                    Kind::Integer | Kind::Number => self.number_proto,
                    Kind::Symbol => self.symbol_proto,
                    Kind::BigInt => self.bigint_proto,
                    Kind::Boolean => self
                        .intrinsics
                        .get("Boolean")
                        .and_then(|&constructor| self.ctor_prototype.get(&constructor).copied())
                        .unwrap_or(crate::value::SlotIndex::NULL),
                    _ => crate::value::SlotIndex::NULL,
                };
                if proto.is_null() {
                    Slot::undefined()
                } else {
                    match self
                        .array_from_try(|this| this.mop_get(code, proto, iterator_id, items))?
                    {
                        Ok(method) => method,
                        Err(error) => return Ok(Err(error)),
                    }
                }
            }
        };
        if !self.is_callable_value(iterator_method) {
            return Ok(Err(
                self.internal_error("TypeError", "call: not a function".into())
            ));
        }
        let iterator =
            match self.array_from_try(|this| this.call_any(code, iterator_method, items, &[]))? {
                Ok(iterator) => iterator,
                Err(error) => return Ok(Err(error)),
            };
        let iterator_inst = match iterator.value {
            Payload::Reference(iterator_inst) if iterator.kind == Kind::Reference => iterator_inst,
            _ => {
                return Ok(Err(
                    self.internal_error("TypeError", "iterator: not an object".into())
                ))
            }
        };
        let next_id = self.intern_key("next");
        let next = match self
            .array_from_try(|this| this.mop_get(code, iterator_inst, next_id, iterator))?
        {
            Ok(next) if self.is_callable_value(next) => next,
            Ok(_) => {
                return Ok(Err(
                    self.internal_error("TypeError", "call: not a function".into())
                ))
            }
            Err(error) => return Ok(Err(error)),
        };
        let mut values = Vec::new();
        for _ in 0..1_000_000u64 {
            let step = match self.array_from_try(|this| this.call_any(code, next, iterator, &[]))? {
                Ok(step) => step,
                Err(error) => return Ok(Err(error)),
            };
            let step_inst = match step.value {
                Payload::Reference(step_inst) if step.kind == Kind::Reference => step_inst,
                _ => {
                    return Ok(Err(self.internal_error(
                        "TypeError",
                        "iterator result: not an object".into(),
                    )))
                }
            };
            let done =
                match self.array_from_try(|this| this.mop_get(code, step_inst, done_id, step))? {
                    Ok(done) => done,
                    Err(error) => return Ok(Err(error)),
                };
            if self.truthy(&done) {
                return Ok(Ok(values));
            }
            let value =
                match self.array_from_try(|this| this.mop_get(code, step_inst, value_id, step))? {
                    Ok(value) => value,
                    Err(error) => return Ok(Err(error)),
                };
            self.charge_builtin_work(1)?;
            self.push_prepaid_scratch(&mut values, value)?;
        }
        Err(Step::Host(Halt::StepLimit(self.n_dispatched)))
    }
}
