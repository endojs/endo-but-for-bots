//! VM-facing reflect builtin algorithms.
use super::super::*;

impl Interp {
    /// Dispatch a `Reflect.*` reflective built-in (`xsProxy.c` `fx_Reflect_*`
    /// → the `mxBehavior*` object-behavior primitives). Every property operation
    /// routes through the complete internal-method MOP, so arrays, String
    /// wrappers, TypedArrays, and proxies retain their exotic semantics. The
    /// result is oracle-certified; the metering is the advisory native-frame
    /// residual (accuracy-over-parity: the `Reflect` corpus is result-gated).
    pub(in crate::interp) fn call_reflect(
        &mut self,
        m: NativeMethod,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let _ = argc;
        let arg0 = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let arg1 = self
            .stack
            .get(base + 5)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let arg2 = self
            .stack
            .get(base + 6)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let arg3 = self
            .stack
            .get(base + 7)
            .copied()
            .unwrap_or_else(Slot::undefined);
        match m {
            // `Reflect.getPrototypeOf(target)` calls the target's
            // `[[GetPrototypeOf]]`, including proxy behavior.
            NativeMethod::ReflectGetPrototypeOf => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                self.mop_get_prototype(code, inst)
            }
            // `Reflect.setPrototypeOf(target, proto)`: invoke the target's
            // `[[SetPrototypeOf]]` with an object or `null`, returning success.
            NativeMethod::ReflectSetPrototypeOf => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                if !matches!(arg1.kind, Kind::Null | Kind::Reference) {
                    return Err(self.catchable_type_error_msg("invalid prototype".into()));
                }
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                Ok(Slot::boolean(self.mop_set_prototype(code, inst, arg1)?))
            }
            NativeMethod::ReflectIsExtensible => {
                let object = match arg0.value {
                    Payload::Reference(object) if arg0.kind == Kind::Reference => object,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                Ok(Slot::boolean(self.mop_is_extensible(code, object)?))
            }
            NativeMethod::ReflectPreventExtensions => {
                let object = match arg0.value {
                    Payload::Reference(object) if arg0.kind == Kind::Reference => object,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                Ok(Slot::boolean(self.mop_prevent_extensions(code, object)?))
            }
            // Return the own data or accessor descriptor, or undefined.
            // A non-object target throws TypeError without coercion.
            NativeMethod::ReflectGetOwnPropertyDescriptor => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let key = self.to_read_key(code, arg1)?;
                match self.mop_get_own_property_read(code, inst, key)? {
                    Some(descriptor) => {
                        self.meter.tick_raw(GOPD_PRESENT_RESIDUAL_METERING);
                        Ok(self.descriptor_object(descriptor))
                    }
                    None => {
                        self.meter.tick_raw(GOPD_ABSENT_RESIDUAL_METERING);
                        Ok(Slot::undefined())
                    }
                }
            }
            // `Reflect.defineProperty(target, key, descriptor)`: convert the
            // key before the descriptor, then invoke `[[DefineOwnProperty]]`.
            // Rejection is returned as `false`, not promoted to a throw.
            NativeMethod::ReflectDefineProperty => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let id = self.to_property_id(code, arg1)?;
                let descriptor_object = match arg2.value {
                    Payload::Reference(d) if arg2.kind == Kind::Reference => d,
                    _ => return Err(self.catchable_type_error_msg("invalid descriptor".into())),
                };
                let descriptor = self.descriptor_from_object(code, descriptor_object)?;
                self.meter.tick_raw(DEFINE_PROPERTY_NEW_RESIDUAL_METERING);
                Ok(Slot::boolean(
                    self.mop_define_own_property(code, inst, id, descriptor)?,
                ))
            }
            // `Reflect.ownKeys(target)`: a fresh Array containing the target's
            // complete `[[OwnPropertyKeys]]` result, including exotic indices,
            // non-enumerable strings, symbols, and proxy trap results.
            NativeMethod::ReflectOwnKeys => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let keys = self.mop_own_keys(code, inst)?;
                let n = keys.len() as u32;
                self.meter.tick_raw(OBJECT_KEYS_FRAME_METERING);
                self.charge_and_check(self.array_chunk_size_metering(n))?;
                for _ in 0..n {
                    self.meter.tick_slot_alloc();
                }
                Ok(self.array_from_slots(&keys))
            }
            // `Reflect.has(target, key)` calls the target's [[HasProperty]]
            // with the converted property key.
            NativeMethod::ReflectHas => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let key = self.to_read_key(code, arg1)?;
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                Ok(Slot::boolean(
                    self.mop_has_read_with_recursions(code, inst, key)?.0,
                ))
            }
            // `Reflect.get(target, key[, receiver])`: dispatch the target's
            // full `[[Get]]`, including exotic objects and accessors that use
            // the explicit receiver.
            NativeMethod::ReflectGet => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let key = self.to_read_key(code, arg1)?;
                let receiver = if argc >= 3 { arg2 } else { arg0 };
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                self.mop_get_read(code, inst, key, receiver)
            }
            // `Reflect.set(target, key, value[, receiver])`: the target's
            // complete `[[Set]]`, returning whether it was accepted.
            NativeMethod::ReflectSet => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let id = self.to_property_id(code, arg1)?;
                let receiver = if argc >= 4 { arg3 } else { arg0 };
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                Ok(Slot::boolean(self.mop_set(code, inst, id, arg2, receiver)?))
            }
            // `Reflect.deleteProperty(target, key)`: the target's `[[Delete]]`
            // result (`false` for a non-configurable own property).
            NativeMethod::ReflectDeleteProperty => {
                let inst = match arg0.value {
                    Payload::Reference(o) if arg0.kind == Kind::Reference => o,
                    _ => return Err(self.catchable_type_error_msg("target: not an object".into())),
                };
                let key = self.to_read_key(code, arg1)?;
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                Ok(Slot::boolean(self.mop_delete_read(code, inst, key)?))
            }
            // `Reflect.apply(target, thisArgument, argumentsList)` calls the
            // target with the expanded array-like argument list.
            NativeMethod::ReflectApply => {
                if !self.is_callable_value(arg0) {
                    return Err(self.catchable_type_error_msg("target: not a function".into()));
                }
                if arg2.kind != Kind::Reference {
                    return Err(
                        self.catchable_type_error_msg("argumentsList: not an object".into())
                    );
                }
                let args = self.arraylike_to_vec(code, arg2)?;
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                self.invoke_value(code, arg0, arg1, &args)
            }
            // `Reflect.construct(target, argumentsList[, newTarget])` (ECMA-262
            // 28.1.2): `Construct(target, args, newTarget)`.
            NativeMethod::ReflectConstruct => {
                // ECMA-262 28.1.2: both the target and the (defaulted) newTarget
                // must be **constructors**, not merely callable — a native
                // prototype method (the `format` getter, its bound function)
                // has no `[[Construct]]`, so `Reflect.construct(fn, [], getter)`
                // throws, and the harness `isConstructor(getter)` is `false`.
                if !self.is_constructor_value(arg0) {
                    return Err(self.catchable_type_error_msg("target: not a constructor".into()));
                }
                let new_target = if argc >= 3 { arg2 } else { arg0 };
                if !self.is_constructor_value(new_target) {
                    return Err(
                        self.catchable_type_error_msg("newTarget: not a constructor".into())
                    );
                }
                if arg1.kind != Kind::Reference {
                    return Err(
                        self.catchable_type_error_msg("argumentsList: not an object".into())
                    );
                }
                let args = self.arraylike_to_vec(code, arg1)?;
                self.meter.tick_raw(REFLECT_FRAME_METERING);
                self.construct_value(code, arg0, &args, new_target)
            }
            _ => Err(Step::Host(Halt::EngineInvariant("Reflect:unexpected"))),
        }
    }
}
