//! Property ordinary operations.
use crate::interp::*;

impl Interp {
    pub(in crate::interp) fn new_object(&mut self) -> crate::value::SlotIndex {
        self.meter.tick_builtin();
        self.meter.tick_slot_alloc();
        // Ordinary objects chain to %Object.prototype% (the payload holds the
        // prototype). Property lookup stays own-only, so this is invisible to
        // reads; it exists for the `instanceof` prototype-chain walk.
        self.slots.alloc(Slot::instance(self.object_proto))
    }

    /// Find an own property slot of `inst` by key `id`, walking its
    /// `next`-linked property list. Every slot in the list is a property
    /// (XS's property slots hold the value directly, keyed by `id`), so
    /// the match is by `id` alone — a property slot's `kind` is the
    /// value's kind, not a separate marker.
    /// `Get(inst, @@toStringTag)` followed by the string check from
    /// `Object.prototype.toString`. The ordinary MOP lookup is load-bearing:
    /// `%TypedArray%.prototype` supplies the tag through a native accessor, and
    /// guest accessors must likewise run and propagate abrupt completions.
    pub(in crate::interp) fn string_to_string_tag(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
    ) -> Result<Option<Vec<u16>>, Step> {
        let Some(tag_id) = self.well_known_symbol_property_id("toStringTag") else {
            return Ok(None);
        };
        let receiver = Slot::of(Kind::Reference, Payload::Reference(inst));
        let value = self.mop_get(code, inst, tag_id, receiver)?;
        Ok(match value {
            Slot {
                kind: Kind::String,
                value: Payload::String(off),
                ..
            } => Some(self.str_units(off)),
            _ => None,
        })
    }

    pub(in crate::interp) fn find_property(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<crate::value::SlotIndex> {
        self.slots.find_property(inst, id)
    }

    /// Whether `inst` is an *ordinary* object — one whose whole own-property
    /// set lives in the slot-arena property chain, with no exotic side table
    /// (array/typed-array/collection/buffer/view/wrapper). Error instances are
    /// ordinary objects for MOP purposes: their `message`/`cause` properties
    /// live entirely in this same slot chain; `error_data` retains construction
    /// metadata and captured stack frames.
    /// Callers use this only when they specifically require a slot-chain-only
    /// receiver; reflection and integrity operations instead route through the
    /// complete `mop_*` dispatchers.
    pub(in crate::interp) fn is_ordinary_object(&self, inst: crate::value::SlotIndex) -> bool {
        !(self.arrays.contains_key(&inst)
            || self.collections.contains_key(&inst)
            || self.typed_arrays.contains_key(&inst)
            || self.array_buffers.contains_key(&inst)
            || self.data_views.contains_key(&inst)
            || self.wrapper_data.contains_key(&inst)
            || self.regexps.contains_key(&inst)
            || self.proxies.contains_key(&inst))
    }

    /// The slot indices of every own property of `inst`, in creation
    /// (insertion) order — XS's `mxBehaviorOwnKeys` over the property chain,
    /// unfiltered (data and accessor, enumerable or not). Used by the
    /// integrity operations, which stamp/read a flag on *every* own property.
    pub(in crate::interp) fn own_property_slots(
        &self,
        inst: crate::value::SlotIndex,
    ) -> Vec<crate::value::SlotIndex> {
        let mut out = Vec::new();
        let mut cur = self.slots.get(inst).next;
        while !cur.is_null() {
            let slot = self.slots.get(cur);
            if slot.flag & XS_INTERNAL_FLAG == 0 {
                out.push(cur);
            }
            cur = slot.next;
        }
        // Newest-first chain → creation order.
        out.reverse();
        out
    }

    /// Whether instance `inst` is extensible (XS's `mxBehaviorIsExtensible`):
    /// its own `XS_INSTANCE_KIND` slot does not carry `XS_DONT_PATCH_FLAG`.
    pub(in crate::interp) fn instance_extensible(&self, inst: crate::value::SlotIndex) -> bool {
        self.slots.get(inst).flag & XS_DONT_PATCH_FLAG == 0
    }

    /// The ordinary-object behavior seam. Proxy and exotic-object support can
    /// dispatch around these methods; all ordinary property operations route
    /// through them so descriptor compatibility cannot drift between syntax,
    /// `Object.*`, and `Reflect.*`.
    /// A function's exotic `length`/`name` as an own **data** descriptor
    /// `{writable:false, enumerable:false, configurable:true}`, synthesized from
    /// the [`FuncInfo`] — XS builds these as real own slots at
    /// `fxNewFunctionInstance`, their allocation pre-paid in
    /// [`FUNCTION_DEFINE_METERING`], so ironhorse mirrors them without a slot
    /// (no allocation, no metering). Returns `None` for a non-function, a name
    /// other than `length`/`name`, a pair the guest has `delete`d
    /// ([`Self::deleted_fn_meta`]), or when an ordinary slot already shadows the
    /// id (a `defineProperty` override wins). This is the single view all the
    /// reflective MOP paths consult so `getOwnPropertyDescriptor` /
    /// `hasOwnProperty` / a non-writable set / `delete` / `for-in` agree.
    pub(in crate::interp) fn function_meta_own_descriptor(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<OrdinaryDescriptor> {
        let is_length = Some(id) == self.length_id;
        let is_name = Some(id) == self.name_id;
        if !(is_length || is_name) {
            return None;
        }
        let fi = self.functions.get(&inst)?;
        if self.deleted_fn_meta.contains(&(inst, id)) {
            return None;
        }
        let value = if is_length {
            Slot::integer(fi.arity as i32)
        } else {
            Slot::of(Kind::String, Payload::String(fi.name_chunk))
        };
        Some(OrdinaryDescriptor {
            value: Some(value),
            writable: Some(false),
            enumerable: Some(false),
            configurable: Some(true),
            ..OrdinaryDescriptor::default()
        })
    }

    pub(in crate::interp) fn ordinary_get_own_descriptor(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<OrdinaryDescriptor> {
        let property = match self.find_property(inst, id) {
            Some(property) => property,
            // No ordinary own slot. An index property lives in the index
            // store instead of the named chain, and most callers arrive here
            // having interned its name (`getOwnPropertyDescriptor(o, '0')`),
            // so the two storages are bridged here rather than at every
            // caller.
            None => {
                return self
                    .index_prop_descriptor_by_id(inst, id)
                    .or_else(|| self.function_meta_own_descriptor(inst, id))
            }
        };
        let slot = self.slots.get(property);
        let enumerable = Some(slot.flag & XS_DONT_ENUM_FLAG == 0);
        let configurable = Some(slot.flag & XS_DONT_DELETE_FLAG == 0);
        if slot.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) != 0 {
            let accessor = self.accessors.get(&(inst, id)).copied().unwrap_or_default();
            Some(OrdinaryDescriptor {
                get: Some(accessor.get.unwrap_or_else(Slot::undefined)),
                set: Some(accessor.set.unwrap_or_else(Slot::undefined)),
                enumerable,
                configurable,
                ..OrdinaryDescriptor::default()
            })
        } else {
            Some(OrdinaryDescriptor {
                value: Some(Slot::of(slot.kind, slot.value)),
                writable: Some(slot.flag & XS_DONT_SET_FLAG == 0),
                enumerable,
                configurable,
                ..OrdinaryDescriptor::default()
            })
        }
    }

    /// ECMAScript SameValue, including NaN equality and distinct signed zeros.
    pub(in crate::interp) fn same_value(&self, left: Slot, right: Slot) -> bool {
        match (numeric_of(&left), numeric_of(&right)) {
            (Some(a), Some(b)) => (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits(),
            _ => self.strict_equal(&left, &right),
        }
    }

    /// Give a function's synthesized exotic `length`/`name` a real backing slot
    /// (unmetered — XS holds it as a real slot whose allocation is pre-paid in
    /// [`FUNCTION_DEFINE_METERING`]) so a `[[DefineOwnProperty]]` has an ordinary
    /// slot to mutate. A no-op unless `id` is a live (non-tombstoned) function
    /// `length`/`name` with no ordinary slot yet. Idempotent.
    pub(in crate::interp) fn materialize_function_meta_slot(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) {
        if self.find_property(inst, id).is_some() {
            return;
        }
        if let Some(desc) = self.function_meta_own_descriptor(inst, id) {
            let value = desc.value.unwrap_or_else(Slot::undefined);
            self.set_own_unmetered_with_flag(inst, id, value, XS_DONT_ENUM_FLAG | XS_DONT_SET_FLAG);
        }
    }

    /// Validate and apply a partial property descriptor (ECMA-262
    /// ValidateAndApplyPropertyDescriptor) to an ordinary object.
    pub(in crate::interp) fn ordinary_define_own_property(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
        descriptor: OrdinaryDescriptor,
    ) -> bool {
        if descriptor.is_accessor() && descriptor.is_data() {
            return false;
        }
        // An index property on an ordinary object belongs in the index store.
        // Route it there when the store already holds it, or when this object
        // keeps indexes by index and has no named slot under this name — so a
        // `defineProperty` spelled by name lands in the same place a plain
        // write does, rather than creating a second, shadowing storage.
        if self.find_property(inst, id).is_none() {
            if let Some(index) = self
                .scalar_key_text(id)
                .as_deref()
                .and_then(string_to_index)
                .filter(|_| self.indexes_by_index(inst) || self.index_props.contains_key(&inst))
            {
                if let Some(accepted) = self.index_prop_define(inst, index, descriptor) {
                    return accepted;
                }
                // An accessor cannot live in the store, so the property
                // PROMOTES to a named slot. Carry its current value and
                // attributes across first: the define below validates against
                // whatever it finds, and finding nothing would treat a
                // redefinition as a creation and silently reset `enumerable`
                // and `configurable` to their absent-property defaults.
                if let Some(item) = self.index_prop_item(inst, index) {
                    self.index_prop_remove(inst, index);
                    let value = Slot::of(item.kind, item.value);
                    self.set_own_unmetered_with_flag(inst, id, value, item.flag);
                }
            }
        }
        // A function's `length`/`name` is synthesized from the `FuncInfo` with no
        // ordinary slot; redefining one must mutate a real slot (the update path
        // below unwraps `find_property`), so materialize it first. Then the
        // ordinary ValidateAndApply runs against the exotic descriptor's existing
        // attributes ({writable:false, configurable:true}), exactly as XS
        // redefines its real slot.
        self.materialize_function_meta_slot(inst, id);
        let current = self.ordinary_get_own_descriptor(inst, id);
        if current.is_none() {
            if !self.instance_extensible(inst) {
                return false;
            }
            let enumerable = descriptor.enumerable.unwrap_or(false);
            let configurable = descriptor.configurable.unwrap_or(false);
            let mut flag = 0u8;
            if !enumerable {
                flag |= XS_DONT_ENUM_FLAG;
            }
            if !configurable {
                flag |= XS_DONT_DELETE_FLAG;
            }
            let mut property = if descriptor.is_accessor() {
                flag |= XS_GETTER_FLAG | XS_SETTER_FLAG;
                self.accessors.insert(
                    (inst, id),
                    AccessorData {
                        get: descriptor.get.filter(|slot| slot.kind != Kind::Undefined),
                        set: descriptor.set.filter(|slot| slot.kind != Kind::Undefined),
                    },
                );
                Slot::undefined()
            } else {
                if !descriptor.writable.unwrap_or(false) {
                    flag |= XS_DONT_SET_FLAG;
                }
                descriptor.value.unwrap_or_else(Slot::undefined)
            };
            property.id = id;
            property.flag = flag;
            property.next = self.slots.get(inst).next;
            let index = self.slots.alloc(property);
            self.slots.get_mut(inst).next = index;
            if let Some(environment) = self.environment_context_mut(inst) {
                // The global object's property chain is also the backing set
                // for identifier resolution. Keep its fast index in lockstep
                // when an ordinary [[DefineOwnProperty]] creates a global via
                // `globalThis.x = value` or its computed equivalent.
                environment.global_props.insert(id, index);
                environment.binding_names.insert(id);
            }
            self.tick_property_create(id);
            return true;
        }

        let current = current.unwrap();
        let current_configurable = current.configurable.unwrap_or(false);
        if !current_configurable {
            if descriptor.configurable == Some(true)
                || descriptor
                    .enumerable
                    .is_some_and(|value| Some(value) != current.enumerable)
            {
                return false;
            }
        }
        let current_accessor = current.is_accessor();
        if (descriptor.is_accessor() || descriptor.is_data())
            && descriptor.is_accessor() != current_accessor
        {
            if !current_configurable {
                return false;
            }
        } else if !current_configurable {
            if !current_accessor && current.writable == Some(false) {
                if descriptor.writable == Some(true)
                    || descriptor
                        .value
                        .is_some_and(|value| !self.same_value(value, current.value.unwrap()))
                {
                    return false;
                }
            }
            if current_accessor {
                if descriptor
                    .get
                    .is_some_and(|value| !self.same_value(value, current.get.unwrap()))
                    || descriptor
                        .set
                        .is_some_and(|value| !self.same_value(value, current.set.unwrap()))
                {
                    return false;
                }
            }
        }

        let property = self.find_property(inst, id).unwrap();
        let old_flag = self.slots.get(property).flag;
        let target_accessor = if descriptor.is_accessor() || descriptor.is_data() {
            descriptor.is_accessor()
        } else {
            current_accessor
        };
        let enumerable = descriptor
            .enumerable
            .or(current.enumerable)
            .unwrap_or(false);
        let configurable = descriptor
            .configurable
            .or(current.configurable)
            .unwrap_or(false);
        let mut flag = old_flag
            & !(XS_DONT_ENUM_FLAG
                | XS_DONT_DELETE_FLAG
                | XS_DONT_SET_FLAG
                | XS_GETTER_FLAG
                | XS_SETTER_FLAG);
        if !enumerable {
            flag |= XS_DONT_ENUM_FLAG;
        }
        if !configurable {
            flag |= XS_DONT_DELETE_FLAG;
        }
        if target_accessor {
            flag |= XS_GETTER_FLAG | XS_SETTER_FLAG;
            let old = self.accessors.get(&(inst, id)).copied().unwrap_or_default();
            let get = descriptor
                .get
                .map(|slot| (slot.kind != Kind::Undefined).then_some(slot))
                .unwrap_or(old.get);
            let set = descriptor
                .set
                .map(|slot| (slot.kind != Kind::Undefined).then_some(slot))
                .unwrap_or(old.set);
            self.accessors.insert((inst, id), AccessorData { get, set });
            let slot = self.slots.get_mut(property);
            slot.kind = Kind::Undefined;
            slot.value = Payload::None;
            slot.flag = flag;
        } else {
            self.accessors.remove(&(inst, id));
            if !descriptor.writable.or(current.writable).unwrap_or(false) {
                flag |= XS_DONT_SET_FLAG;
            }
            let value = descriptor
                .value
                .or(current.value)
                .unwrap_or_else(Slot::undefined);
            let slot = self.slots.get_mut(property);
            slot.kind = value.kind;
            slot.value = value.value;
            slot.flag = flag;
        }
        true
    }

    /// Whether `id` resolves to an own or inherited property descriptor
    /// anywhere along `inst`'s prototype chain (used to distinguish a genuinely
    /// absent property from one bound to `undefined`). Proxies short-circuit to
    /// "present" — their `[[GetOwnProperty]]` trap decides, so the caller must
    /// not treat a proxy link as absence.
    pub(in crate::interp) fn chain_has_descriptor(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> bool {
        let mut owner = inst;
        while !owner.is_null() {
            if self.proxies.contains_key(&owner) {
                return true;
            }
            if self.ordinary_get_own_descriptor(owner, id).is_some() {
                return true;
            }
            owner = self.instance_prototype(owner);
        }
        false
    }

    /// Invoke an accessor `getter` with `receiver` as `this`. A user-function
    /// (or bound) getter runs through [`Self::run_callback`]; a **native-method**
    /// getter (the boot-installed `Intl.NumberFormat.prototype.format`) is
    /// dispatched directly through the native seam, since `run_callback`
    /// deliberately rejects native callees (`callback:non-user-function`). The
    /// native path builds the `[THIS, FUNCTION, RESULT, FRAME]` frame the call
    /// opcode would, dispatches with zero arguments, and pops the pushed result.
    pub(in crate::interp) fn invoke_getter(
        &mut self,
        code: &[u8],
        getter: Slot,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        if let Payload::Reference(f) = getter.value {
            // A `.call`/`.apply` or promise-resolving function used as an
            // accessor takes the abstract dispatcher, exactly as it does at
            // the `.call`/`.apply` trampolines: `call_native_method` refuses
            // those markers as "never reaches here".
            if self.needs_abstract_call(f, self.method_of(f)) {
                return self.invoke_value(code, getter, receiver, &[]);
            }
            if let Some(m) = self.method_of(f) {
                let base = self.stack.len();
                self.push(receiver);
                self.push(getter);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                // On success `call_native_method` truncates to `base` and
                // pushes the result; on a throw it returns early WITHOUT
                // truncating, so restore the stack to `base` before
                // propagating — else the leaked frame corrupts the value stack.
                return match self.call_native_method(m, base, 0, code) {
                    Ok(()) => self.pop_checked(),
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            }
        }
        self.run_callback(code, getter, receiver, &[])
    }

    /// Invoke an accessor setter with `receiver` as `this`. Boot accessors can
    /// carry native-method setters (the ES2025 Iterator prototype accessors),
    /// while guest accessors carry bytecode functions. Both paths deliberately
    /// discard the setter's return value.
    pub(in crate::interp) fn invoke_setter(
        &mut self,
        code: &[u8],
        setter: Slot,
        receiver: Slot,
        value: Slot,
    ) -> Result<(), Step> {
        if let Payload::Reference(f) = setter.value {
            // The getter's rule, for the same reason.
            if self.needs_abstract_call(f, self.method_of(f)) {
                self.invoke_value(code, setter, receiver, &[value])?;
                return Ok(());
            }
            if let Some(m) = self.method_of(f) {
                let base = self.stack.len();
                self.push(receiver);
                self.push(setter);
                self.push(Slot::undefined());
                self.push(Slot::of(Kind::Uninitialized, Payload::None));
                self.push(value);
                return match self.call_native_method(m, base, 1, code) {
                    Ok(()) => {
                        let _ = self.pop_checked()?;
                        Ok(())
                    }
                    Err(h) => {
                        self.stack.truncate(base);
                        Err(h)
                    }
                };
            }
        }
        let _ = self.run_callback(code, setter, receiver, &[value])?;
        Ok(())
    }

    pub(in crate::interp::property) fn ordinary_get(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        let mut current = inst;
        loop {
            if let Some(descriptor) = self.ordinary_get_own_descriptor(current, id) {
                if descriptor.is_accessor() {
                    let getter = descriptor.get.unwrap_or_else(Slot::undefined);
                    if getter.kind == Kind::Undefined {
                        return Ok(Slot::undefined());
                    }
                    return self.invoke_getter(code, getter, receiver);
                }
                return Ok(descriptor.value.unwrap_or_else(Slot::undefined));
            }
            // OrdinaryGet step 4 delegates to the parent's full `[[Get]]`, not
            // to another ordinary slot-chain scan. This matters when the
            // prototype is a Proxy or carries Array/String/TypedArray exotic
            // own properties.
            let parent = self.instance_prototype(current);
            if parent.is_null() {
                return Ok(Slot::undefined());
            }
            let iterator_context_aimed_at_parent = self
                .array_iterator_proxy_get_context
                .is_some_and(|context| {
                    context.target == parent
                        && self.refresh_read_key(context.key) == ReadKey::Id(id)
                });
            if self.proxies.contains_key(&parent) || iterator_context_aimed_at_parent {
                return self.mop_get(code, parent, id, receiver);
            }
            // Every other parent's `[[Get]]` is `mop_get`'s non-Proxy path —
            // its exotic own surface, then this very algorithm — so perform
            // it in place, as XS's `fxGetProperty` loop does, rather than
            // nesting one native frame per prototype level (a `for` loop of
            // `Object.create`, or of `class extends`, builds a chain deep
            // enough to overflow the host stack that way). The exotic surface
            // is the one `mop_get_with_proxy_metering_inner` consults: a
            // TypedArray's integer index, then the side-table own data of an
            // array, function or String wrapper when no ordinary own slot
            // shadows it.
            if self.find_property(parent, id).is_none() {
                if let Some(&typed_array) = self.typed_arrays.get(&parent) {
                    if let Some(index) = self.ta_numeric_index_at(id, 0) {
                        return Ok(self.ta_indexed_element_get(typed_array, index));
                    }
                }
                if let Some(d) = self.exotic_own_descriptor(parent, id) {
                    if d.is_data() {
                        return Ok(d.value.unwrap_or_else(Slot::undefined));
                    }
                }
            }
            current = parent;
        }
    }

    pub(in crate::interp::property) fn ordinary_set(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        value: Slot,
        receiver: Slot,
    ) -> Result<bool, Step> {
        let mut current = inst;
        loop {
            // Functions keep their `length`, `name`, and (when constructable)
            // `prototype` own properties in side tables.  They participate in
            // OrdinarySet exactly like materialized own descriptors and must be
            // considered before an inherited non-writable property.
            let own = self
                .ordinary_get_own_descriptor(current, id)
                .or_else(|| self.exotic_own_descriptor(current, id));
            if let Some(descriptor) = own {
                if descriptor.is_accessor() {
                    let setter = descriptor.set.unwrap_or_else(Slot::undefined);
                    if setter.kind == Kind::Undefined {
                        return Ok(false);
                    }
                    self.invoke_setter(code, setter, receiver, value)?;
                    return Ok(true);
                }
                if descriptor.writable == Some(false) {
                    return Ok(false);
                }
                break;
            }
            // OrdinarySet delegates an own-property miss to the immediate
            // parent's complete `[[Set]]`. Do not flatten this into a
            // descriptor scan: a Proxy or integer-indexed exotic prototype
            // has behavior even when its own descriptor is absent.
            let parent = self.instance_prototype(current);
            if parent.is_null() {
                break;
            }
            // `mop_set` differs from this algorithm only for a Proxy and for a
            // TypedArray's integer-indexed element.
            let typed_array_element = self.typed_arrays.contains_key(&parent)
                && !self.is_symbol_key_id(id)
                && self
                    .scalar_key_text(id)
                    .and_then(|name| canonical_numeric_index_string(&name))
                    .is_some();
            if self.proxies.contains_key(&parent) || typed_array_element {
                return self.mop_set(code, parent, id, value, receiver);
            }
            // Any other parent's `[[Set]]` is this very algorithm (`mop_set`
            // would arrive back here): continue the walk in place rather than
            // nesting one native frame per prototype level, as `ordinary_get`
            // does.
            current = parent;
        }
        let receiver_inst = match receiver.value {
            Payload::Reference(receiver_inst) if receiver.kind == Kind::Reference => receiver_inst,
            _ => return Ok(false),
        };
        // When the receiver is itself a proxy (a trap-absent `[[Set]]` forwarded
        // to the target with the original proxy as Receiver), the final
        // create/update runs the receiver's own `[[GetOwnProperty]]` /
        // `[[DefineOwnProperty]]` (ECMA-262 OrdinarySetWithOwnDescriptor), so it
        // reaches the proxy's target — not the proxy's own inert instance slot.
        if self.proxies.contains_key(&receiver_inst) {
            if let Some(existing) = self.mop_get_own_property(code, receiver_inst, id)? {
                if existing.is_accessor() || existing.writable == Some(false) {
                    return Ok(false);
                }
                return self.mop_define_own_property(
                    code,
                    receiver_inst,
                    id,
                    OrdinaryDescriptor {
                        value: Some(value),
                        ..OrdinaryDescriptor::default()
                    },
                );
            }
            return self.mop_define_own_property(
                code,
                receiver_inst,
                id,
                OrdinaryDescriptor {
                    value: Some(value),
                    writable: Some(true),
                    enumerable: Some(true),
                    configurable: Some(true),
                    ..OrdinaryDescriptor::default()
                },
            );
        }
        let receiver_own = self
            .ordinary_get_own_descriptor(receiver_inst, id)
            .or_else(|| self.exotic_own_descriptor(receiver_inst, id));
        if let Some(existing) = receiver_own {
            if existing.is_accessor() || existing.writable == Some(false) {
                return Ok(false);
            }
            // OrdinarySetWithOwnDescriptor updates only [[Value]]. Preserve
            // the receiver property's existing attributes (notably a sealed
            // property's configurable:false bit).
            return self.mop_define_own_property(
                code,
                receiver_inst,
                id,
                OrdinaryDescriptor {
                    value: Some(value),
                    ..OrdinaryDescriptor::default()
                },
            );
        }
        let descriptor = OrdinaryDescriptor {
            value: Some(value),
            writable: Some(true),
            enumerable: Some(true),
            configurable: Some(true),
            ..OrdinaryDescriptor::default()
        };
        self.mop_define_own_property(code, receiver_inst, id, descriptor)
    }

    /// Delete own property `id` from instance `inst` (XS's
    /// `mxBehaviorDeleteProperty` for an ordinary object): unlink the
    /// property slot from the owner's `next`-linked list and free it.
    /// Returns `true` when the property was configurable-and-removed or was
    /// absent (both are `true` for `delete`); the covered grammar creates
    /// only configurable own data properties, so this is always `true`. No
    /// allocation, so — like XS's ordinary delete — it meters only its
    /// dispatch.
    pub(in crate::interp) fn delete_own_property(
        &mut self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> bool {
        // A function's exotic `length`/`name` own data property is configurable
        // (`{configurable:true}`), but ironhorse synthesizes it from the
        // `FuncInfo` rather than an ordinary slot, so there is nothing in the
        // chain to unlink. When no ordinary slot shadows the id, record a
        // tombstone (XS unlinks the real slot) so the reflective paths report it
        // absent thereafter, and report the delete as succeeded.
        if self.functions.contains_key(&inst)
            && (Some(id) == self.length_id || Some(id) == self.name_id)
            && self.find_property(inst, id).is_none()
        {
            self.deleted_fn_meta.insert((inst, id));
            return true;
        }
        let deleted_index_limit = self
            .is_ordinary_object(inst)
            .then(|| {
                self.scalar_key_text(id)
                    .as_deref()
                    .and_then(string_to_index)
            })
            .flatten()
            .map(|index| index.saturating_add(1));
        let mut prev = inst;
        let mut cur = self.slots.get(inst).next;
        while !cur.is_null() {
            let s = self.slots.get(cur);
            if s.id == id {
                // A non-configurable own property (`XS_DONT_DELETE_FLAG` — the
                // state `seal`/`freeze`/`defineProperty(configurable:false)`
                // stamps) refuses deletion: `mxBehaviorDeleteProperty` returns
                // `false`, leaving the property in place (a strict `delete`
                // throws on the `false`; a sloppy one yields `false`).
                if s.flag & XS_DONT_DELETE_FLAG != 0 {
                    return false;
                }
                // XS retains an ordinary object's resident indexed-array
                // high-water mark after deleting a visible indexed property.
                // Reuse the deleted property slot as an internal numeric
                // tombstone: heap snapshots and SQLite pages then carry the
                // state without a new side-table/schema row. Ordinary
                // property enumeration filters internal slots.
                let retained_here = if let Some(limit) = deleted_index_limit {
                    let existing = self.internal_indexed_limit_slot(inst);
                    if let Some(tombstone) = existing {
                        let retained = self.internal_indexed_limit(inst).max(limit);
                        self.slots.get_mut(tombstone).value = Payload::Number(f64::from(retained));
                        false
                    } else {
                        let tombstone = self.slots.get_mut(cur);
                        tombstone.id = crate::value::XS_NO_ID;
                        tombstone.flag = XS_INTERNAL_FLAG;
                        tombstone.kind = Kind::Number;
                        tombstone.value = Payload::Number(f64::from(limit));
                        true
                    }
                } else {
                    false
                };
                if !retained_here {
                    // Unlink `cur` from the chain and free its slot.
                    self.slots.get_mut(prev).next = s.next;
                    self.slots.free(cur);
                }
                // Keep the global-object fast index one-to-one with the chain:
                // `delete globalThis.x` (or `delete` of a sloppy global) must
                // drop the `global_props` entry too, else identifier resolution
                // would keep reading the now-freed slot. Only the global object
                // carries a fast index; every other instance has none.
                if let Some(environment) = self.environment_context_mut(inst) {
                    environment.global_props.remove(&id);
                }
                self.accessors.remove(&(inst, id));
                return true;
            }
            prev = cur;
            cur = s.next;
        }
        true
    }

    /// Boot/restore inspection of an authoritative slot chain, without guest
    /// accessors or proxy dispatch. Guest property reads must use `mop_get`.
    pub(in crate::interp) fn boot_chain_get(&self, inst: crate::value::SlotIndex, id: u16) -> Slot {
        // Walk the prototype chain (XS's `mxBehaviorGetProperty`): own first,
        // then each prototype, to the root. Metering is unchanged — a chain
        // walk meters no built-in step, exactly as an own read. The prototype
        // objects carry data only for names the program references (the
        // linked intrinsic methods), so this stays invisible to reads of
        // ordinary objects with no matching inherited property.
        let mut cur = inst;
        while !cur.is_null() {
            if let Some(p) = self.find_property(cur, id) {
                let s = self.slots.get(p);
                return Slot::of(s.kind, s.value);
            }
            cur = self.instance_prototype(cur);
        }
        Slot::undefined()
    }
}
