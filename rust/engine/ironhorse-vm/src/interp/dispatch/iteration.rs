//! Iteration opcode semantics.
//! Return transfers unchanged; only the dispatch loop owns catch resumption.
use super::super::*;
use Opcode::*;

impl Interp {
    pub(super) fn dispatch_for_of(&mut self, code: &[u8], op: Opcode) -> Result<(), Step> {
        let iterable = self.pop();
        // A guest-defined `@@iterator` takes precedence over the
        // intrinsic dense fast paths below. Accessor lookup and a
        // user iterator method both re-enter the interpreter; the
        // returned object is then driven by the compiler-emitted
        // `next`/`done`/`value` loop.
        let custom_iterator = match iterable.value {
            Payload::Reference(instance) => {
                let symbol_name = if op == XS_CODE_FOR_AWAIT_OF {
                    "asyncIterator"
                } else {
                    "iterator"
                };
                let symbol_id = self
                    .well_known_symbol_property_id(symbol_name)
                    .unwrap_or(crate::value::XS_NO_ID);
                if symbol_id == crate::value::XS_NO_ID {
                    None
                } else {
                    let method = (self.ordinary_get(code, instance, symbol_id, iterable))?;
                    (method.kind != Kind::Undefined).then_some(method)
                }
            }
            _ => None,
        };
        if let Some(method) = custom_iterator {
            self.meter.tick_raw(FOR_OF_GET_ITERATOR_METERING);
            let iterator = (self.call_primitive_method(code, method, iterable, &[]))?;
            if iterator.kind != Kind::Reference {
                // GetIterator step 3 (`fxGetIterator`'s
                // "iterator: not an object"), raised in-frame
                // so a `try` in the SAME activation — a
                // generator body around `yield*` — observes it
                // (a returned halt would skip that handler).
                return Err(self.catchable_type_error_msg("iterator: not an object".into()));
            }
            self.push(iterator);
            return Ok(());
        }
        // `for await` falls back to the synchronous iterator and
        // awaits each compiler-emitted `next()` result/value.
        // Async generators themselves have no synchronous fallback.
        if op == XS_CODE_FOR_AWAIT_OF {
            let async_generator = match iterable.value {
                Payload::Reference(i) if self.async_generators.contains_key(&i) => Some(i),
                _ => None,
            };
            if let Some(instance) = async_generator {
                // XS falls back through fxGetIterator, whose call
                // of a missing synchronous method has this message.
                // A supplied sync method still needs the separate
                // AsyncFromSyncIterator semantic implementation;
                // do not claim that XS throws in that case.
                let sync_id = self
                    .well_known_symbol_property_id("iterator")
                    .unwrap_or(crate::value::XS_NO_ID);
                let sync_method = if sync_id == crate::value::XS_NO_ID {
                    Slot::undefined()
                } else {
                    (self.ordinary_get(code, instance, sync_id, iterable))?
                };
                if matches!(sync_method.kind, Kind::Undefined | Kind::Null) {
                    return Err(self.catchable_type_error_msg("call: not a function".into()));
                }
                return Err(self.catchable_type_error());
            }
        }
        match iterable.value {
            Payload::Reference(i) if self.arrays.contains_key(&i) => {
                self.meter.tick_raw(FOR_OF_GET_ITERATOR_METERING);
                let it = self.make_array_iterator(i, 0);
                self.push(it);
            }
            Payload::String(off) if iterable.kind == Kind::String => {
                // `for (x of str)` — the string iterator yields each
                // code point. The `fxGetIterator` get + call dispatch
                // is metered identically to the array case; the
                // iterator creation is metered inside the builder.
                let bytes = self.str_content(off).to_vec();
                self.meter.tick_raw(FOR_OF_GET_ITERATOR_METERING);
                let it = self.make_string_iterator(bytes);
                self.push(it);
            }
            Payload::Reference(i) if self.collections.contains_key(&i) => {
                // `for (x of map|set)` — the collection's
                // `Symbol.iterator` (Map: `entries` kind 7; Set:
                // `values` kind 6). WeakMap/WeakSet are not
                // iterable (TypeError in XS): self-name. The
                // `fxGetIterator` get + call dispatch is metered
                // identically to the array case; the iterator
                // creation is metered inside the builder.
                let it_kind = match self.collections[&i].kind {
                    CollKind::Map => 7u8,
                    CollKind::Set => 6u8,
                    _ => return Err(Step::Host(Halt::NotImplemented("for_of:weak-collection"))),
                };
                self.meter.tick_raw(FOR_OF_GET_ITERATOR_METERING);
                let it = self.make_collection_iterator(i, it_kind);
                self.push(it);
            }
            Payload::Reference(i) if self.generators.contains_key(&i) => {
                // `for (x of gen)` — `gen[Symbol.iterator]()` returns
                // the generator itself (%IteratorPrototype%'s
                // `[Symbol.iterator]` is identity); no new iterator is
                // built. The surrounding loop reads `.next` (→
                // `GeneratorNext` via the prototype chain) and drives
                // the {value,done} protocol. The `fxGetIterator`
                // get + identity-`Symbol.iterator` call dispatch is
                // metered as the array case.
                self.meter.tick_raw(FOR_OF_GET_ITERATOR_METERING);
                self.push(iterable);
            }
            // `for (x of null)` / `[...undefined]`: `fxGetIterator`'s
            // `mxToInstance` throws before any method lookup.
            _ if matches!(iterable.kind, Kind::Null | Kind::Undefined) => {
                return Err(self.catchable_type_error_msg(cannot_coerce_to_object(iterable.kind)))
            }
            _ => {
                // No iterator protocol at all: XS reaches the
                // call of the absent `Symbol.iterator` method
                // (`fxCallInstance`'s "call: not a function"),
                // raised in-frame so an enclosing `try` in the
                // same activation observes it.
                let error = self.internal_error("TypeError", "call: not a function".into());
                return Err(self.raise_js(error));
            }
        }
        Ok(())
    }

    pub(super) fn dispatch_for_in(&mut self) -> Result<(), Step> {
        let obj = self.pop();
        let inst = match obj.value {
            // A primitive symbol carries `Payload::Reference(desc)`
            // — its description slot, NOT an instance — so this
            // must precede the generic arm, or the loop enumerates
            // an object handed to `Symbol()` and hands the guest
            // its keys. XS boxes the primitive (`fxToInstance`) and
            // enumerates the wrapper: no own properties, so the
            // enumerable set is exactly `%Symbol.prototype%`'s
            // chain (empty, since every built-in there is
            // `XS_DONT_ENUM` — but a guest-added enumerable
            // property on it does show up, as the spec says).
            // Enumerating that prototype directly gets the same
            // keys without the wrapper allocation XS pre-pays for
            // in the enumerator's own cost.
            Payload::Reference(_) if obj.kind == Kind::Symbol && !self.symbol_proto.is_null() => {
                self.symbol_proto
            }
            // `undefined`/`null` for-in is a legal empty loop, but
            // its zero-key enumerator setup is a later increment;
            // an object receiver is the covered case.
            Payload::Reference(i) if obj.kind != Kind::Symbol => i,
            _ => {
                return Err(Step::Host(Halt::NotImplemented(
                    "for_in:non-object-receiver",
                )))
            }
        };
        let it = self.make_enumerator(inst);
        self.push(it);
        Ok(())
    }

    pub(super) fn dispatch_to_instance(&mut self) -> Result<(), Step> {
        let top = *self.stack.last().unwrap_or(&Slot::undefined());
        match top.kind {
            // Already an object — ToObject is identity, no allocation.
            Kind::Reference | Kind::Instance => {}
            // null / undefined → catchable TypeError.
            Kind::Null | Kind::Undefined => {
                return Err(self.catchable_type_error_msg(cannot_coerce_to_object(top.kind)))
            }
            // A `Number`/`Integer`/`Boolean` primitive's ToObject
            // boxes to its `%Number.prototype%`/`%Boolean.prototype%`
            // wrapper. These wrappers carry **no exotic own
            // property** (the wrapped primitive is the internal
            // `[[NumberData]]`/`[[BooleanData]]` slot), so a name
            // resolved against the wrapper — the `with(primitive)`
            // scopable walk — finds nothing own, falls through the
            // prototype chain outward, and matches the oracle
            // exactly. Boxing meters `fxToInstance`'s two `fxNewSlot`
            // allocations (see [`Self::box_primitive_to_instance`]).
            // The opcode replaces the top-of-stack primitive with the
            // wrapper reference in place (XS's `mxToInstance(mxStack)`).
            Kind::Boolean => {
                let inst = self.box_primitive_to_instance(Native::Boolean, top);
                let head = Slot::of(Kind::Reference, Payload::Reference(inst));
                if let Some(t) = self.stack.last_mut() {
                    *t = head;
                } else {
                    self.push(head);
                }
            }
            Kind::Integer | Kind::Number => {
                let inst = self.box_primitive_to_instance(Native::Number, top);
                let head = Slot::of(Kind::Reference, Payload::Reference(inst));
                if let Some(t) = self.stack.last_mut() {
                    *t = head;
                } else {
                    self.push(head);
                }
            }
            // String exotic indices/length are derived from the
            // existing wrapper-data side table by the property and
            // CopyDataProperties seams; they need not be
            // materialized as arena properties. A Symbol wrapper
            // has no exotic own string keys.
            Kind::String => {
                let inst = self.box_primitive_to_instance(Native::String, top);
                let head = Slot::of(Kind::Reference, Payload::Reference(inst));
                if let Some(t) = self.stack.last_mut() {
                    *t = head;
                } else {
                    self.push(head);
                }
            }
            Kind::Symbol => {
                let inst = self.box_primitive_to_instance(Native::Symbol, top);
                let head = Slot::of(Kind::Reference, Payload::Reference(inst));
                if let Some(t) = self.stack.last_mut() {
                    *t = head;
                } else {
                    self.push(head);
                }
            }
            Kind::BigInt => {
                let inst = self.box_primitive_to_instance(Native::BigInt, top);
                let head = Slot::of(Kind::Reference, Payload::Reference(inst));
                if let Some(t) = self.stack.last_mut() {
                    *t = head;
                } else {
                    self.push(head);
                }
            }
            _ => {
                return Err(Step::Host(Halt::NotImplemented(
                    "to_instance:primitive-box",
                )))
            }
        }
        Ok(())
    }
}
