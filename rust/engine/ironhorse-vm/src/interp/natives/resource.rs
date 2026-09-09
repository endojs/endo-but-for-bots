//! VM-facing resource builtin algorithms.
use super::super::*;

impl Interp {
    /// Reject a promise for disposeAsync receiver-validation errors;
    /// throw synchronously for other resource-management methods.
    fn explicit_resource_error(
        &mut self,
        code: &[u8],
        method: NativeMethod,
        name: &'static str,
        message: String,
    ) -> Result<Slot, Step> {
        let error = self.internal_error(name, message);
        if method == NativeMethod::AsyncDisposableStackDisposeAsync {
            let promise = self.new_promise_instance();
            self.settle_promise(code, promise, error, true)?;
            Ok(Slot::of(Kind::Reference, Payload::Reference(promise)))
        } else {
            Err(self.raise_js(error))
        }
    }

    pub(in crate::interp) fn explicit_resource_method(
        &mut self,
        method: NativeMethod,
        this: Slot,
        base: usize,
        _argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let is_async = matches!(
            method,
            NativeMethod::AsyncDisposableStackUse
                | NativeMethod::AsyncDisposableStackAdopt
                | NativeMethod::AsyncDisposableStackDefer
                | NativeMethod::AsyncDisposableStackMove
                | NativeMethod::AsyncDisposableStackDisposeAsync
        );
        let brand = if is_async {
            "AsyncDisposableStack"
        } else {
            "DisposableStack"
        };
        let inst = match (this.kind, this.value) {
            (Kind::Reference, Payload::Reference(inst))
                if self
                    .disposable_stacks
                    .get(&inst)
                    .is_some_and(|data| data.asynchronous == is_async) =>
            {
                inst
            }
            _ => {
                return self.explicit_resource_error(
                    code,
                    method,
                    "TypeError",
                    format!("this: not a {brand} instance"),
                )
            }
        };
        let disposing = matches!(
            method,
            NativeMethod::DisposableStackDispose | NativeMethod::AsyncDisposableStackDisposeAsync
        );
        if !disposing && self.disposable_stacks[&inst].disposed {
            return self.explicit_resource_error(
                code,
                method,
                "ReferenceError",
                format!("this: disposed {brand} instance"),
            );
        }
        let arg = |n: usize| {
            self.stack
                .get(base + 4 + n)
                .copied()
                .unwrap_or_else(Slot::undefined)
        };
        if matches!(
            method,
            NativeMethod::DisposableStackUse | NativeMethod::AsyncDisposableStackUse
        ) {
            let resource = arg(0);
            if matches!(resource.kind, Kind::Null | Kind::Undefined) {
                return Ok(resource);
            }
            let resource_object = self.array_to_object(resource)?;
            let Payload::Reference(resource_inst) = resource_object.value else {
                unreachable!("ToObject result")
            };
            let symbol_name = if is_async { "asyncDispose" } else { "dispose" };
            let mut disposer = match self.well_known_symbol_property_id(symbol_name) {
                Some(id) => self.mop_get(code, resource_inst, id, resource)?,
                None => Slot::undefined(),
            };
            // The pinned XS falls back on every non-callable async method.
            if is_async && !self.is_callable_value(disposer) {
                disposer = match self.well_known_symbol_property_id("dispose") {
                    Some(id) => self.mop_get(code, resource_inst, id, resource)?,
                    None => Slot::undefined(),
                };
            }
            if !self.is_callable_value(disposer) {
                return Err(self.catchable_type_error_msg(
                    if is_async {
                        "dispose: no a function"
                    } else {
                        "dispose: not a function"
                    }
                    .into(),
                ));
            }
            // Measured add-record residue (see the constant).
            self.meter.tick_raw(DISPOSABLE_STACK_ADD_METERING);
            let data = self
                .disposable_stacks
                .get_mut(&inst)
                .expect("brand checked");
            data.records.push(DisposalRecord {
                resource,
                method: disposer,
                pass_resource: false,
            });
            return Ok(resource);
        }
        if matches!(
            method,
            NativeMethod::DisposableStackAdopt | NativeMethod::AsyncDisposableStackAdopt
        ) {
            let resource = arg(0);
            let disposer = arg(1);
            if !self.is_callable_value(disposer) {
                return Err(self.catchable_type_error_msg(
                    if is_async {
                        "dispose: no a function"
                    } else {
                        "dispose: not a function"
                    }
                    .into(),
                ));
            }
            self.meter.tick_raw(DISPOSABLE_STACK_ADD_METERING);
            let data = self
                .disposable_stacks
                .get_mut(&inst)
                .expect("brand checked");
            data.records.push(DisposalRecord {
                resource,
                method: disposer,
                pass_resource: true,
            });
            return Ok(resource);
        }
        if matches!(
            method,
            NativeMethod::DisposableStackDefer | NativeMethod::AsyncDisposableStackDefer
        ) {
            let disposer = arg(0);
            if !self.is_callable_value(disposer) {
                return Err(self.catchable_type_error_msg(
                    if is_async {
                        "dispose: no a function"
                    } else {
                        "dispose: not a function"
                    }
                    .into(),
                ));
            }
            self.meter.tick_raw(DISPOSABLE_STACK_ADD_METERING);
            let data = self
                .disposable_stacks
                .get_mut(&inst)
                .expect("brand checked");
            data.records.push(DisposalRecord {
                resource: Slot::undefined(),
                method: disposer,
                pass_resource: false,
            });
            return Ok(Slot::undefined());
        }
        if matches!(
            method,
            NativeMethod::DisposableStackMove | NativeMethod::AsyncDisposableStackMove
        ) {
            self.meter.tick_raw(DISPOSABLE_STACK_ADD_METERING);
            let data = self
                .disposable_stacks
                .get_mut(&inst)
                .expect("brand checked");
            data.disposed = true;
            let records = std::mem::take(&mut data.records);
            let proto = match self.slots.get(inst).value {
                Payload::Reference(proto) => proto,
                _ => self.object_proto,
            };
            let moved = self.slots.alloc(Slot::instance(proto));
            self.disposable_stacks.insert(
                moved,
                DisposableStackData {
                    disposed: false,
                    asynchronous: is_async,
                    records,
                },
            );
            return Ok(Slot::of(Kind::Reference, Payload::Reference(moved)));
        }

        let data = self
            .disposable_stacks
            .get_mut(&inst)
            .expect("brand checked");
        if data.disposed {
            if is_async {
                let promise = self.new_promise_instance();
                self.settle_promise(code, promise, Slot::undefined(), false)?;
                return Ok(Slot::of(Kind::Reference, Payload::Reference(promise)));
            }
            return Ok(Slot::undefined());
        }
        data.disposed = true;
        let mut records = std::mem::take(&mut data.records);
        let mut pending_error: Option<Slot> = None;
        while let Some(record) = records.pop() {
            let args = if record.pass_resource {
                vec![record.resource]
            } else {
                Vec::new()
            };
            let this_arg = if record.pass_resource {
                Slot::undefined()
            } else {
                record.resource
            };
            // A `use` record (this-bound @@dispose; `defer` records
            // carry an undefined resource, `adopt` passes it as the
            // argument) meters one extra dispatch unit at disposal.
            if !record.pass_resource && record.resource.kind != Kind::Undefined {
                self.meter.tick_raw(DISPOSE_USE_RECORD_METERING);
            }
            if let Err(error) =
                self.run_callback_catching_throw(code, record.method, this_arg, &args)?
            {
                pending_error = Some(match pending_error {
                    Some(suppressed) => self.build_suppressed_error(error, suppressed, None),
                    None => error,
                });
            }
        }
        if is_async {
            let promise = self.new_promise_instance();
            self.settle_promise(
                code,
                promise,
                pending_error.unwrap_or_else(Slot::undefined),
                pending_error.is_some(),
            )?;
            Ok(Slot::of(Kind::Reference, Payload::Reference(promise)))
        } else if let Some(error) = pending_error {
            Err(self.raise_js(error))
        } else {
            Ok(Slot::undefined())
        }
    }
}
