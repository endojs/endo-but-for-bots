//! Host services have stable identities; call-scoped values never expose arena coordinates.
use super::*;
use std::{cell::RefCell, collections::BTreeMap, marker::PhantomData, rc::Rc};

/// Stable service identity. Changing implementation semantics or billing requires
/// a new ABI version and explicit reattachment of that version on restore.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HostCallableId {
    pub name: String,
    pub abi: u32,
}

pub(crate) type HostRegistry = RefCell<BTreeMap<HostCallableId, Rc<dyn HostCallable>>>;

#[derive(Clone, Debug)]
pub(super) struct HostFunctionData {
    pub id: HostCallableId,
    pub captures: Vec<Slot>,
}

/// A value valid only during its originating host call. It cannot escape that
/// call or be constructed from an unbranded Slot.
///
/// ```compile_fail
/// use ironhorse_vm::{HostCallable, HostCallContext, HostResult, HostValue};
/// struct Escape;
/// impl HostCallable for Escape {
///     fn call<'s>(&self, cx: &mut HostCallContext<'s>) -> HostResult<'s> {
///         let escaped: HostValue<'static> = cx.argument(0);
///         Ok(escaped)
///     }
/// }
/// ```
#[derive(Clone, Copy)]
pub struct HostValue<'scope> {
    slot: Slot,
    scope: PhantomData<fn(&'scope ()) -> &'scope ()>,
}
impl HostValue<'_> {
    pub fn as_integer(self) -> Option<i32> {
        match self.slot.value {
            Payload::Integer(v) if self.slot.kind == Kind::Integer => Some(v),
            _ => None,
        }
    }
    pub fn as_number(self) -> Option<f64> {
        match self.slot.value {
            Payload::Integer(v) if self.slot.kind == Kind::Integer => Some(v as f64),
            Payload::Number(v) if self.slot.kind == Kind::Number => Some(v),
            _ => None,
        }
    }
    pub fn as_boolean(self) -> Option<bool> {
        match self.slot.value {
            Payload::Boolean(v) if self.slot.kind == Kind::Boolean => Some(v),
            _ => None,
        }
    }
    pub fn is_undefined(self) -> bool {
        self.slot.kind == Kind::Undefined
    }
}

/// Guest exceptions remain branded values. Refusal can never forge an engine
/// Return or inject an unbranded thrown Slot. Resource stops are sticky.
pub enum HostCallError<'scope> {
    Throw(HostValue<'scope>),
    Refuse,
    Stopped,
}
pub type HostResult<'scope> = Result<HostValue<'scope>, HostCallError<'scope>>;

/// Explicitly registered embedding service. The ABI contract includes the host's
/// external effects and billing policy. Rust closures themselves are never stored.
pub trait HostCallable {
    fn call<'scope>(&self, context: &mut HostCallContext<'scope>) -> HostResult<'scope>;
}

/// One native activation. Guest-call reentry uses a native try fence; ordinary
/// Machine reentry remains excluded by its execution borrow.
pub struct HostCallContext<'scope> {
    interp: &'scope mut Interp,
    code: &'scope [u8],
    args: Vec<Slot>,
    this: Slot,
    captures: Vec<Slot>,
    stopped: Option<Step>,
}
impl<'scope> HostCallContext<'scope> {
    fn value(&self, slot: Slot) -> HostValue<'scope> {
        HostValue {
            slot,
            scope: PhantomData,
        }
    }
    pub fn argument_count(&self) -> usize {
        self.args.len()
    }
    pub fn argument(&self, index: usize) -> HostValue<'scope> {
        self.value(
            self.args
                .get(index)
                .copied()
                .unwrap_or_else(Slot::undefined),
        )
    }
    pub fn receiver(&self) -> HostValue<'scope> {
        self.value(self.this)
    }
    pub fn capture(&self, index: usize) -> Option<HostValue<'scope>> {
        self.captures.get(index).map(|v| self.value(*v))
    }
    pub fn undefined(&self) -> HostValue<'scope> {
        self.value(Slot::undefined())
    }
    pub fn integer(&self, value: i32) -> HostValue<'scope> {
        self.value(Slot::integer(value))
    }
    pub fn number(&self, value: f64) -> HostValue<'scope> {
        self.value(Slot::of(Kind::Number, Payload::Number(value)))
    }
    pub fn boolean(&self, value: bool) -> HostValue<'scope> {
        self.value(Slot::of(Kind::Boolean, Payload::Boolean(value)))
    }
    pub fn string_units(&self, value: HostValue<'scope>) -> Option<Vec<u16>> {
        match value.slot.value {
            Payload::String(offset) if value.slot.kind == Kind::String => {
                Some(self.interp.str_units(offset))
            }
            _ => None,
        }
    }

    /// Bill host-defined work in the Machine's continuing raw meter. Ignoring a
    /// denial cannot turn the crank back into a successful completion.
    pub fn charge(&mut self, raw: u64) -> Result<(), HostCallError<'scope>> {
        if self.stopped.is_some() {
            return Err(HostCallError::Stopped);
        }
        if self.interp.meter_index().checked_add(raw).is_none() {
            self.stopped = Some(Step::Host(Halt::Refused("host:meter-overflow")));
            return Err(HostCallError::Stopped);
        }
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.interp.charge_and_check(raw)
        }));
        match outcome {
            Ok(Ok(())) => {}
            Ok(Err(step)) => {
                self.stopped = Some(step);
                return Err(HostCallError::Stopped);
            }
            Err(payload) => {
                self.stopped = Some(Step::Host(Halt::EngineInvariant("host:meter-panicked")));
                std::panic::resume_unwind(payload);
            }
        }
        Ok(())
    }

    /// Create a lossless UTF-16 guest string, including lone surrogates. The
    /// engine's existing string-allocation charge is applied before allocation.
    pub fn string(&mut self, units: &[u16]) -> HostResult<'scope> {
        self.charge(string_chunk_cost(units.len() as u64))?;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.interp.chunks.alloc(&units_to_be16(units))
        }));
        match result {
            Ok(offset) => Ok(self.value(Slot::of(Kind::String, Payload::String(offset)))),
            Err(payload) if payload.is::<crate::value::HeapExhausted>() => {
                self.stopped = Some(Step::Host(Halt::HeapExhausted));
                Err(HostCallError::Stopped)
            }
            Err(payload) => {
                self.stopped = Some(Step::Host(Halt::EngineInvariant(
                    "host:string-allocation-panicked",
                )));
                std::panic::resume_unwind(payload)
            }
        }
    }

    /// Call a scoped guest value. Catchable guest throws are returned to this
    /// host activation; resource/engine stops remain latched until it exits.
    pub fn call(
        &mut self,
        callee: HostValue<'scope>,
        this: HostValue<'scope>,
        args: &[HostValue<'scope>],
    ) -> HostResult<'scope> {
        if self.stopped.is_some() {
            return Err(HostCallError::Stopped);
        }
        let args: Vec<_> = args.iter().map(|v| v.slot).collect();
        let native_depth = self.interp.native_depth;
        let jumps = self.interp.jumps.clone();
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.interp
                .run_callback_catching_throw(self.code, callee.slot, this.slot, &args)
        }));
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(payload) => {
                self.interp.native_depth = native_depth;
                self.interp.jumps = jumps;
                self.stopped = Some(Step::Host(if payload.is::<crate::value::HeapExhausted>() {
                    Halt::HeapExhausted
                } else {
                    Halt::EngineInvariant("host:guest-call-panicked")
                }));
                if payload.is::<crate::value::HeapExhausted>() {
                    return Err(HostCallError::Stopped);
                }
                std::panic::resume_unwind(payload);
            }
        };
        match outcome {
            Ok(Ok(value)) => Ok(self.value(value)),
            Ok(Err(value)) => Err(HostCallError::Throw(self.value(value))),
            Err(step) => {
                self.stopped = Some(step);
                Err(HostCallError::Stopped)
            }
        }
    }
}

impl Interp {
    pub(super) fn call_host(
        &mut self,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let owner = match self.stack[base + 1].value {
            Payload::Reference(owner) => owner,
            _ => return Err(Step::Host(Halt::EngineInvariant("host:missing-function"))),
        };
        let data = self
            .functions
            .get(&owner)
            .and_then(|f| f.host.as_ref())
            .cloned()
            .ok_or(Step::Host(Halt::EngineInvariant("host:missing-metadata")))?;
        let registry = self
            .host_callbacks
            .upgrade()
            .ok_or(Step::Host(Halt::Refused("host:service-owner-dropped")))?;
        let callback = registry
            .borrow()
            .get(&data.id)
            .cloned()
            .ok_or(Step::Host(Halt::Refused("host:missing-service")))?;
        let args = self.stack[base + 4..base + 4 + argc].to_vec();
        let this = self.stack[base];
        let mut context = HostCallContext {
            interp: self,
            code,
            args,
            this,
            captures: data.captures,
            stopped: None,
        };
        let result = callback
            .call(&mut context)
            .map(|v| v.slot)
            .map_err(|error| match error {
                HostCallError::Throw(v) => Some(v.slot),
                HostCallError::Refuse | HostCallError::Stopped => None,
            });
        if let Some(stopped) = context.stopped {
            return Err(stopped);
        }
        match result {
            Ok(value) => Ok(value),
            Err(Some(value)) => Err(self.raise_js(value)),
            Err(None) => Err(Step::Host(Halt::Refused("host:callback-refused"))),
        }
    }
}

impl Interp {
    pub(crate) fn attach_host_registry(&mut self, registry: &Rc<HostRegistry>) {
        self.host_callbacks = Rc::downgrade(registry);
    }
    pub fn required_host_callables(&self) -> Vec<HostCallableId> {
        self.functions
            .values()
            .filter_map(|f| f.host.as_ref().map(|h| h.id.clone()))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }
    pub(crate) fn create_host_function(
        &mut self,
        id: HostCallableId,
        name: &str,
        arity: u32,
        captures: Vec<Slot>,
    ) -> Result<(crate::SlotIndex, Rc<()>), Halt> {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let name_chunk = self.alloc_str_text(name);
            let owner = self.slots.alloc(Slot::instance(self.function_proto));
            self.functions.insert(
                owner,
                FuncInfo {
                    host: Some(HostFunctionData { id, captures }),
                    native: Some(Native::Host),
                    name: name.to_owned(),
                    name_chunk,
                    arity,
                    global_env: self.environment.global_obj,
                    ..FuncInfo::default()
                },
            );
            self.root_value(Slot::of(Kind::Reference, Payload::Reference(owner)))
        }));
        match result {
            Ok(result) => result,
            Err(payload) if payload.is::<crate::value::HeapExhausted>() => Err(Halt::HeapExhausted),
            Err(payload) => std::panic::resume_unwind(payload),
        }
    }
}
