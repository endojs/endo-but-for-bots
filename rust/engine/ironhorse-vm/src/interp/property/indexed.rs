//! Property indexed operations.
use crate::interp::*;

impl Interp {
    /// Project a compact array item into its observable ECMAScript value.
    /// Sloppy mapped arguments keep a closure-cell edge in the item so the
    /// parameter binding remains live; every other item is already a value.
    pub(in crate::interp) fn array_item_value(
        &self,
        inst: crate::value::SlotIndex,
        item: Slot,
    ) -> Slot {
        if self.arguments_objects.contains(&inst)
            && item.kind == Kind::Closure
            && matches!(item.value, Payload::Reference(_))
        {
            let Payload::Reference(cell) = item.value else {
                unreachable!()
            };
            let value = self.slots.get(cell);
            return Slot::of(value.kind, value.value);
        }
        Slot::of(item.kind, item.value)
    }

    /// Set array item `index = value` (XS's `fxSetIndexProperty` +
    /// `fxRunDefine`). Grows the item chunk when the index is new (metered by
    /// [`Self::array_item_grow_metering`]) and bumps `length` when the index
    /// reaches past the end; `define` adds the `fxRunDefine` built-in step.
    pub(in crate::interp) fn array_item_set(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
        value: Slot,
        define: bool,
    ) {
        if self.arguments_objects.contains(&inst) {
            if let Some(Slot {
                kind: Kind::Closure,
                value: Payload::Reference(cell),
                ..
            }) = self.arrays[&inst].items().get(&index).copied()
            {
                let target = self.slots.get_mut(cell);
                target.kind = value.kind;
                target.value = value.value;
                if define {
                    self.meter.tick_raw(ARRAY_ITEM_DEFINE_STEP_METERING);
                }
                return;
            }
        }
        let is_new = !self
            .arrays
            .get(&inst)
            .map(|a| a.items().contains_key(&index))
            .unwrap_or(false);
        if is_new {
            let present = self.arrays[&inst].items().len() as u64;
            self.meter.tick_raw(self.array_item_grow_metering(present));
        }
        if define {
            self.meter.tick_raw(ARRAY_ITEM_DEFINE_STEP_METERING);
        }
        if let Some(a) = self.arrays.get_mut(&inst) {
            let mut v = value;
            v.id = 0;
            v.next = crate::value::SlotIndex::NULL;
            // A write to an EXISTING item replaces its value and leaves its
            // attributes alone, as XS's `fxOrdinarySetProperty` writes
            // `kind`/`value` into the slot it found without touching `flag`.
            //
            // Taking the incoming value's flag (always the default 0) instead
            // is a SEAL BYPASS: `Object.seal` marks each element
            // non-configurable, and a sealed element is still writable, so
            // `a[1] = 9` would clear the very `XS_DONT_DELETE_FLAG` that seal
            // had just stamped and `delete a[1]` would then succeed —
            // `false|9` on XS, `true|undefined` here. It was unreachable
            // while sealing PROMOTED each element out of the item map; making
            // seal stamp items in place is what exposed it.
            v.flag = a.items().get(&index).map_or(v.flag, |item| item.flag);
            a.insert_item(index, v, &mut self.side_refs);
            if index + 1 > a.length {
                a.length = index + 1;
            }
        }
    }

    /// The raw 16.16 chunk-growth cost of appending one item to an array that
    /// already holds `present` items (XS's `fxNewChunk`/`fxRenewChunk` of the
    /// item chunk to `present + 1` slots). XS meters the *adjusted* requested
    /// size: `fxAdjustChunkSize((present+1) * sizeof(txSlot))` with
    /// `sizeof(txSlot) == 32` on the 64-bit oracle target, i.e.
    /// `round_up_8((present+1)*32) + sizeof(txChunk)` = `(present+1)*32 + 16`
    /// (the payload is already 8-aligned). Verified against the pin: an
    /// N-element literal's per-element chunk cost is 48, 80, 112, 144, ….
    ///
    /// Known sub-computron residual: a *spread* segment appending into an
    /// already-populated array carries a −8-raw-per-segment gap (ironhorse
    /// over-charges by 8) versus XS's item-chunk over-allocation
    /// (`fxNewGrowableChunk`/`fxSizeToCapacity`) growth path. It is well under
    /// one computron and never crosses a `>> 16` boundary in a bounded program,
    /// so the computron-level bar (and every corpus/fuzz/test262 check, which
    /// compare `meterIndex >> 16`) stays exact; modeling the over-allocation
    /// capacity to close the raw gap is a later refinement.
    pub(in crate::interp) fn array_item_grow_metering(&self, present: u64) -> u64 {
        let bytes = (present + 1) * ARRAY_ITEM_BYTES;
        // round up to 8 (already a multiple of 8) + 16-byte chunk header.
        (((bytes + CHUNK_ALIGNMENT - 1) & !(CHUNK_ALIGNMENT - 1)) + CHUNK_HEADER_BYTES)
            * CHUNK_ALLOCATION_METERING
    }

    /// Whether an Array exotic's non-configurable `length` data property is
    /// writable. The instance slot's property-only `XS_DONT_SET_FLAG` bit is
    /// otherwise unused on instances, travels in the ordinary slot snapshot,
    /// and therefore keeps this bit of exotic state durable without another
    /// side-table/schema row.
    pub(in crate::interp) fn array_length_writable(&self, inst: crate::value::SlotIndex) -> bool {
        self.slots.get(inst).flag & XS_DONT_SET_FLAG == 0
    }

    pub(in crate::interp) fn set_array_length_writable(
        &mut self,
        inst: crate::value::SlotIndex,
        writable: bool,
    ) {
        if writable {
            self.slots.get_mut(inst).flag &= !XS_DONT_SET_FLAG;
        } else {
            self.slots.get_mut(inst).flag |= XS_DONT_SET_FLAG;
        }
    }

    /// Freeze one compiler-created template array in place. Template
    /// elements stay in the compact array table, whose `Slot::flag` carries
    /// the same non-writable/non-configurable bits as an XS item slot; the
    /// exotic `length` writable bit lives on the instance slot.
    pub(in crate::interp) fn freeze_template_array(
        &mut self,
        inst: crate::value::SlotIndex,
    ) -> bool {
        let Some(array) = self.arrays.get_mut(&inst) else {
            return false;
        };
        self.slots.get_mut(inst).flag |= XS_DONT_PATCH_FLAG | XS_DONT_SET_FLAG;
        array.or_all_item_flags(XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG);
        for property in self.own_property_slots(inst) {
            let slot = self.slots.get_mut(property);
            slot.flag |= XS_DONT_DELETE_FLAG;
            if slot.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) == 0 {
                slot.flag |= XS_DONT_SET_FLAG;
            }
        }
        true
    }

    /// `XS_CODE_TEMPLATE`: freeze the cooked array, its non-enumerable `raw`
    /// property, and the raw array. The compiler has already created every
    /// element with the final descriptor flags; this closes extensibility and
    /// the two exotic `length` properties just as XS's handler does.
    pub(in crate::interp) fn freeze_template_object(
        &mut self,
        cooked: crate::value::SlotIndex,
    ) -> bool {
        let Some(raw_id) = self.symbol_ids.get("raw").copied() else {
            return false;
        };
        let Some(raw_property) = self.find_property(cooked, raw_id) else {
            return false;
        };
        let raw = match self.slots.get(raw_property).value {
            Payload::Reference(raw) => raw,
            _ => return false,
        };
        if !self.freeze_template_array(raw) || !self.freeze_template_array(cooked) {
            return false;
        }
        let property = self.slots.get_mut(raw_property);
        property.flag |= XS_DONT_DELETE_FLAG | XS_DONT_ENUM_FLAG | XS_DONT_SET_FLAG;
        true
    }

    /// Set an array's `length` after the caller has performed the observable
    /// numeric coercion (XS's `fxArrayLengthSetter` → `fxSetArrayLength`).
    /// Growing past the current length adds holes; shrinking drops compact
    /// items and any materialized configurable index descriptors at or above
    /// the new length. A non-configurable materialized index stops the shrink
    /// at `index + 1`, as ArraySetLength requires. Returns the internal-method
    /// boolean; assignment decides whether a false result throws from strict
    /// code.
    pub(in crate::interp) fn array_set_length(
        &mut self,
        inst: crate::value::SlotIndex,
        value: Slot,
    ) -> bool {
        self.meter.tick_raw(ARRAY_LENGTH_SET_METERING);
        let Some(new_len) = self.checked_array_length(value) else {
            return false;
        };
        let old_len = self.arrays[&inst].length;
        if new_len != old_len && !self.array_length_writable(inst) {
            return false;
        }
        if new_len < old_len {
            let mut indices: Vec<(u32, Option<u16>)> = self
                .own_property_slots(inst)
                .into_iter()
                .filter_map(|property| {
                    let id = self.slots.get(property).id;
                    self.scalar_key_text(id)
                        .and_then(|name| string_to_index(&name))
                        .filter(|index| *index >= new_len)
                        .map(|index| (index, Some(id)))
                })
                .collect();
            indices.extend(
                self.arrays[&inst]
                    .items()
                    .range(new_len..)
                    .map(|(&index, _)| (index, None)),
            );
            indices.sort_unstable_by_key(|(index, _)| std::cmp::Reverse(*index));
            for (index, ordinary_id) in indices {
                if let Some(id) = ordinary_id {
                    if !self.delete_own_property(inst, id) {
                        self.arrays.get_mut(&inst).unwrap().length = index + 1;
                        return false;
                    }
                } else {
                    // An item can be non-configurable now that
                    // `array_define_index` stamps attributes onto the item
                    // slot instead of promoting it to a named property, so
                    // this branch has to refuse the same way the named branch
                    // above does. `ArraySetLength` (ECMA-262 10.4.2.4) stops
                    // at the first index it cannot delete, leaves `length` one
                    // past it, and returns false — without this,
                    // `Object.seal(a); a.length = 1` silently truncated a
                    // sealed array.
                    if self.arrays[&inst].items()[&index].flag & XS_DONT_DELETE_FLAG != 0 {
                        self.arrays.get_mut(&inst).unwrap().length = index + 1;
                        return false;
                    }
                    self.arrays
                        .get_mut(&inst)
                        .unwrap()
                        .remove_item(&index, &mut self.side_refs);
                }
            }
        }
        self.arrays.get_mut(&inst).unwrap().length = new_len;
        true
    }

    /// A valid array length (`fxCheckArrayLength`): a non-negative integer in
    /// `[0, 2^32-1]`. Returns `None` for a fractional or out-of-range number
    /// (XS throws a `RangeError` there — out of the covered set).
    pub(in crate::interp) fn checked_array_length(&self, value: Slot) -> Option<u32> {
        match value.value {
            Payload::Integer(i) if i >= 0 => Some(i as u32),
            Payload::Number(n) if n >= 0.0 && n.fract() == 0.0 && n <= 4294967295.0 => {
                Some(n as u32)
            }
            _ => None,
        }
    }

    /// `ArraySetLength` for a property descriptor. `ToUint32`/`ToNumber` is
    /// represented by the shared observable `ToNumber` path followed by the
    /// exact array-length range/integrality check; a mismatch is the spec's
    /// catchable `RangeError`. Attribute checks happen after value coercion.
    pub(in crate::interp) fn array_define_length(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        descriptor: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        let requested_nonwritable = descriptor.writable == Some(false);
        let new_length = if let Some(value) = descriptor.value {
            // ArraySetLength performs ToUint32(value) and then ToNumber(value)
            // as two distinct observable coercions. For an object value this
            // deliberately invokes valueOf/toString twice, in that order.
            let primitive = self.to_primitive(code, value, false)?;
            if primitive.kind == Kind::Symbol {
                return Err(
                    self.catchable_type_error_msg("cannot coerce symbol to unsigned".into())
                );
            }
            if primitive.kind == Kind::BigInt {
                return Err(self.catchable_type_error_msg("cannot coerce to unsigned".into()));
            }
            let uint32_number = self.to_number_f64(code, primitive)?;
            let new_len = if !uint32_number.is_finite() || uint32_number == 0.0 {
                0
            } else {
                uint32_number.trunc().rem_euclid(4_294_967_296.0) as u32
            };
            let number = self.to_number_f64(code, value)?;
            if !number.is_finite()
                || number < 0.0
                || number != new_len as f64
                || number.fract() != 0.0
            {
                return Err(self.catchable_range_error_msg("invalid length".into()));
            }
            Some((new_len, number))
        } else {
            None
        };

        if descriptor.is_accessor()
            || descriptor.configurable == Some(true)
            || descriptor.enumerable == Some(true)
            || (!self.array_length_writable(inst) && descriptor.writable == Some(true))
        {
            return Ok(false);
        }

        if let Some((new_len, number)) = new_length {
            let old_len = self.arrays[&inst].length;
            if new_len != old_len && !self.array_length_writable(inst) {
                return Ok(false);
            }
            if !self.array_set_length(inst, Slot::number(number)) {
                if requested_nonwritable {
                    self.set_array_length_writable(inst, false);
                }
                return Ok(false);
            }
        }
        if requested_nonwritable {
            self.set_array_length_writable(inst, false);
        }
        Ok(true)
    }

    /// Array exotic `[[DefineOwnProperty]]` for an integer index. Compact
    /// elements carry data-descriptor restrictions in `Slot::flag`. On an
    /// accessor redefinition, move that element into the ordinary property
    /// chain so the existing descriptor, accessor, snapshot, and GC machinery
    /// carries the full shape. The side item is removed, making array
    /// algorithms select their generic MOP path.
    ///
    /// `id` is the index's interned name, or `None` when the name table has
    /// never held it. `None` is not a weaker form of the same call: a name
    /// that was never minted cannot key an ordinary shadow slot or an
    /// `accessors` entry, so the two lookups it would serve provably miss, and
    /// only the accessor path below — which genuinely creates a named
    /// property — has to mint one.
    pub(in crate::interp) fn array_define_index(
        &mut self,
        inst: crate::value::SlotIndex,
        id: Option<u16>,
        index: u32,
        descriptor: OrdinaryDescriptor,
    ) -> bool {
        let old_len = self.arrays[&inst].length;
        if index >= old_len && !self.array_length_writable(inst) {
            return false;
        }

        if let Some(id) = id {
            if let Some(current) = self.ordinary_get_own_descriptor(inst, id) {
                if !self.is_compatible_descriptor(
                    self.instance_extensible(inst),
                    &descriptor,
                    Some(&current),
                ) {
                    return false;
                }
                let accepted = self.ordinary_define_own_property(inst, id, descriptor);
                if accepted && index >= old_len {
                    self.arrays.get_mut(&inst).unwrap().length = index + 1;
                }
                return accepted;
            }
        }

        if let Some(value) = self.arrays[&inst].items().get(&index).copied() {
            let observable_value = self.array_item_value(inst, value);
            let current = OrdinaryDescriptor {
                value: Some(observable_value),
                writable: Some(value.flag & XS_DONT_SET_FLAG == 0),
                enumerable: Some(value.flag & XS_DONT_ENUM_FLAG == 0),
                configurable: Some(value.flag & XS_DONT_DELETE_FLAG == 0),
                ..OrdinaryDescriptor::default()
            };
            if !self.is_compatible_descriptor(true, &descriptor, Some(&current)) {
                return false;
            }
            let mapped_cell = match (value.kind, value.value) {
                (Kind::Closure, Payload::Reference(cell))
                    if self.arguments_objects.contains(&inst) =>
                {
                    Some(cell)
                }
                _ => None,
            };
            if let Some(cell) = mapped_cell {
                if !descriptor.is_accessor() {
                    if let Some(new_value) = descriptor.value {
                        let target = self.slots.get_mut(cell);
                        target.kind = new_value.kind;
                        target.value = new_value.value;
                    }
                    let mut flag = value.flag;
                    if let Some(writable) = descriptor.writable {
                        if writable {
                            flag &= !XS_DONT_SET_FLAG;
                        } else {
                            flag |= XS_DONT_SET_FLAG;
                        }
                    }
                    if let Some(enumerable) = descriptor.enumerable {
                        if enumerable {
                            flag &= !XS_DONT_ENUM_FLAG;
                        } else {
                            flag |= XS_DONT_ENUM_FLAG;
                        }
                    }
                    if let Some(configurable) = descriptor.configurable {
                        if configurable {
                            flag &= !XS_DONT_DELETE_FLAG;
                        } else {
                            flag |= XS_DONT_DELETE_FLAG;
                        }
                    }
                    if descriptor.writable == Some(false) {
                        let current = self.slots.get(cell);
                        let mut replacement = Slot::of(current.kind, current.value);
                        replacement.flag = flag;
                        self.arrays.get_mut(&inst).unwrap().insert_item(
                            index,
                            replacement,
                            &mut self.side_refs,
                        );
                    } else {
                        self.arrays
                            .get_mut(&inst)
                            .unwrap()
                            .set_item_flag(index, flag);
                    }
                    return true;
                }
            }
            // XS stamps the ITEM SLOT in place. `fxArrayDefineOwnProperty`
            // hands an index straight to `fxOrdinaryDefineOwnProperty`
            // (`xsType.c`), which takes `mxBehaviorGetProperty(…, id, index,
            // XS_OWN)` — the slot living inside the array's item chunk — and
            // writes that slot's flag and value. Nothing is promoted to a
            // named property, so nothing is interned.
            //
            // Ironhorse cannot follow XS for an ACCESSOR: `self.accessors` is
            // keyed by `(instance, id)`, so a getter/setter on an index needs
            // a real name and still promotes below. Every DATA descriptor,
            // though — including the `{writable: false, configurable: false}`
            // that `Object.freeze` stamps on each element — is exactly the
            // item slot's three flags plus its value.
            //
            // Promoting each element instead made `Object.freeze` on a
            // 70,000-element array mint a key per element, walking the `u16`
            // id space into the saturation guard that POISONS the machine
            // (`harden`, which Hardened JS is built on, is `Object.freeze`
            // over a graph). It also made the freeze quadratic: each promoted
            // element lengthened the named chain the next element's
            // `find_property` has to scan.
            if !descriptor.is_accessor() {
                let mut flag = value.flag;
                if let Some(writable) = descriptor.writable {
                    if writable {
                        flag &= !XS_DONT_SET_FLAG;
                    } else {
                        flag |= XS_DONT_SET_FLAG;
                    }
                }
                if let Some(enumerable) = descriptor.enumerable {
                    if enumerable {
                        flag &= !XS_DONT_ENUM_FLAG;
                    } else {
                        flag |= XS_DONT_ENUM_FLAG;
                    }
                }
                if let Some(configurable) = descriptor.configurable {
                    if configurable {
                        flag &= !XS_DONT_DELETE_FLAG;
                    } else {
                        flag |= XS_DONT_DELETE_FLAG;
                    }
                }
                match descriptor.value {
                    // A new value replaces the item, so the side-reference
                    // counts move with it.
                    Some(mut replacement) => {
                        replacement.id = 0;
                        replacement.flag = flag;
                        replacement.next = crate::value::SlotIndex::NULL;
                        self.arrays.get_mut(&inst).unwrap().insert_item(
                            index,
                            replacement,
                            &mut self.side_refs,
                        );
                    }
                    // Attributes only: the value and its reference topology
                    // are untouched, so stamp the flag where it lies.
                    None => {
                        self.arrays
                            .get_mut(&inst)
                            .unwrap()
                            .set_item_flag(index, flag);
                    }
                }
                return true;
            }
            // An accessor on an index: `self.accessors` is keyed by
            // `(instance, id)`, so this one genuinely needs a name.
            let id = self.array_index_promotion_id(id, index);
            self.arrays
                .get_mut(&inst)
                .unwrap()
                .remove_item(&index, &mut self.side_refs);
            self.set_own_unmetered_with_flag(inst, id, current.value.unwrap(), value.flag);
            return self.ordinary_define_own_property(inst, id, descriptor);
        }

        if !self.instance_extensible(inst) {
            return false;
        }
        let id = self.array_index_promotion_id(id, index);
        let accepted = self.ordinary_define_own_property(inst, id, descriptor);
        if accepted && index >= old_len {
            self.arrays.get_mut(&inst).unwrap().length = index + 1;
        }
        accepted
    }

    /// The name id for an array index that is about to become a real ordinary
    /// property, minting one only if the table has never held it.
    ///
    /// Unmetered, because XS charges nothing for it: XS never interns an index
    /// name at all (`fxOrdinaryDefineOwnProperty` addresses the item slot by
    /// `(XS_NO_ID, index)`), so a `tick_slot_alloc` here would be an
    /// overcharge, not parity.
    pub(in crate::interp) fn array_index_promotion_id(
        &mut self,
        id: Option<u16>,
        index: u32,
    ) -> u16 {
        match id {
            Some(id) => id,
            None => self.intern_key_unmetered(index.to_string()),
        }
    }

    /// Array exotic `[[DefineOwnProperty]]` (ECMA-262 10.4.2.1): dispatch
    /// `length`, array-index strings, and ordinary expandos to their respective
    /// storage/validation paths.
    pub(in crate::interp) fn array_define_own_property(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        id: u16,
        descriptor: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        let name = self.scalar_key_text(id);
        if name.as_deref() == Some("length") && !self.arguments_objects.contains(&inst) {
            return self.array_define_length(code, inst, descriptor);
        }
        if let Some(index) = name.as_deref().and_then(string_to_index) {
            return Ok(self.array_define_index(inst, Some(id), index, descriptor));
        }
        Ok(self.ordinary_define_own_property(inst, id, descriptor))
    }

    /// Whether `inst` stores its integer-indexed properties by INDEX, in
    /// [`Self::index_props`], rather than by name.
    ///
    /// True for an object whose `[[Set]]`/`[[DefineOwnProperty]]` is the
    /// ordinary one. An Array, TypedArray, `arguments` object, String wrapper
    /// or Proxy all answer an index through their own exotic behaviour and are
    /// excluded; so, for now, are the remaining side-table shapes that
    /// `is_ordinary_object` excludes, which keep naming their index expandos.
    pub(in crate::interp) fn indexes_by_index(&self, inst: crate::value::SlotIndex) -> bool {
        self.is_ordinary_object(inst)
    }

    /// The value stored at `index` on `inst`, if `inst` keeps index properties
    /// by index and holds one there.
    pub(in crate::interp) fn index_prop_item(
        &self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<Slot> {
        self.index_props
            .get(&inst)
            .and_then(|props| props.items().get(&index).copied())
    }

    /// Store `value` at `index` on `inst`, creating the store on first use —
    /// XS's `fxOrdinarySetProperty` growing its `XS_ARRAY_KIND` slot.
    pub(in crate::interp) fn index_prop_set(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
        value: Slot,
    ) {
        // XS's `fxOrdinarySetProperty` (`xsType.c:727`) grows the instance's
        // `XS_ARRAY_KIND` slot: `fxNewSlot` for the holder on first use, then
        // `fxSetIndexProperty` → `fxSetIndexSize`, whose cost is the item
        // chunk's — the same resize `array_item_grow_metering` already models
        // for an exotic array's items, since it is the same XS function.
        // Replacing an item in place resizes nothing.
        if self.index_prop_item(inst, index).is_none() {
            let props = self.index_props.get(&inst);
            let present = props.map_or(0, |props| props.items().len() as u64);
            if props.is_none() {
                self.meter.tick_slot_alloc();
            }
            let grow = self.array_item_grow_metering(present);
            self.meter.tick_raw(grow);
        }
        self.index_prop_store(inst, index, value);
    }

    /// [`Self::index_prop_set`] without the growth metering — the resume path,
    /// which rebuilds a store that was already paid for when the guest built
    /// it. Charging here would make a resumed machine's meter diverge from the
    /// uninterrupted one it must agree with.
    pub(in crate::interp) fn index_prop_store(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
        mut value: Slot,
    ) {
        value.id = crate::value::XS_NO_ID;
        value.next = crate::value::SlotIndex::NULL;
        let refs = &mut self.side_refs;
        let props = self.index_props.entry(inst).or_default();
        props.insert_item(index, value, refs);
        // `ArrayData::length` is this store's HIGH-WATER mark, not an array
        // `length` (an ordinary object has none). It only ever rises, so a
        // deleted index keeps the cursor domain it opened — XS's resident
        // indexed-array slot does not shrink when an element is deleted, and
        // `resident_indexed_limit` reads this as the tombstone it documents.
        props.length = props.length.max(index.saturating_add(1));
    }

    /// Remove the property at `index`. The store itself STAYS once it has held
    /// anything: its high-water mark is the tombstone
    /// [`Self::resident_indexed_limit`] relies on, so an object that no longer
    /// keeps an index property is deliberately distinguishable from one that
    /// never did.
    pub(in crate::interp) fn index_prop_remove(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<Slot> {
        let refs = &mut self.side_refs;
        let removed = self
            .index_props
            .get_mut(&inst)
            .and_then(|props| props.remove_item(&index, refs));
        if self
            .index_props
            .get(&inst)
            .is_some_and(|props| props.items().is_empty() && props.length == 0)
        {
            self.index_props.remove(&inst);
        }
        removed
    }

    /// Every index this object holds, ascending — the order
    /// `fxQueueIndexKeys` produces, which is the order `[[OwnPropertyKeys]]`
    /// and `for-in` both need.
    pub(in crate::interp) fn index_prop_indices(&self, inst: crate::value::SlotIndex) -> Vec<u32> {
        self.index_props
            .get(&inst)
            .map(|props| props.items().keys().copied().collect())
            .unwrap_or_default()
    }

    /// The own descriptor of the index property at `index` on `inst`, read out
    /// of the index store. Item flags carry the attributes exactly as an
    /// array's items do.
    pub(in crate::interp) fn index_prop_descriptor(
        &self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<OrdinaryDescriptor> {
        let item = self.index_prop_item(inst, index)?;
        Some(OrdinaryDescriptor {
            value: Some(Slot::of(item.kind, item.value)),
            writable: Some(item.flag & XS_DONT_SET_FLAG == 0),
            enumerable: Some(item.flag & XS_DONT_ENUM_FLAG == 0),
            configurable: Some(item.flag & XS_DONT_DELETE_FLAG == 0),
            ..OrdinaryDescriptor::default()
        })
    }

    /// `OrdinarySet(O, ToString(index), V, Receiver)` keyed by INDEX.
    ///
    /// The same walk as [`Self::ordinary_set`], reading each level's own
    /// descriptor by index instead of by name, so a write to a novel index on
    /// an ordinary object neither needs nor mints a property name.
    ///
    /// Returns `Ok(None)` when the walk reaches a prototype whose `[[Set]]` is
    /// not this algorithm — a Proxy, or a TypedArray answering an integer
    /// index — because delegating to those requires the key the trap or the
    /// exotic will be handed. The caller resolves a name for that narrow shape
    /// and retries by id, which keeps the trap observable at the cost of one
    /// name.
    pub(in crate::interp) fn ordinary_index_set(
        &mut self,
        code: &[u8],
        inst: crate::value::SlotIndex,
        index: u32,
        value: Slot,
        receiver: Slot,
    ) -> Result<Option<bool>, Step> {
        let mut current = inst;
        loop {
            let own = self
                .index_prop_descriptor(current, index)
                .or_else(|| self.named_index_descriptor(current, index))
                .or_else(|| self.exotic_index_own_descriptor(current, index));
            if let Some(descriptor) = own {
                if descriptor.is_accessor() {
                    let setter = descriptor.set.unwrap_or_else(Slot::undefined);
                    if setter.kind == Kind::Undefined {
                        return Ok(Some(false));
                    }
                    self.invoke_setter(code, setter, receiver, value)?;
                    return Ok(Some(true));
                }
                if descriptor.writable == Some(false) {
                    return Ok(Some(false));
                }
                break;
            }
            let parent = self.instance_prototype(current);
            if parent.is_null() {
                break;
            }
            // A Proxy's `set` trap and a TypedArray's integer-indexed
            // `[[Set]]` are observable behaviour, not a descriptor read, so
            // they cannot be flattened into this walk.
            if self.proxies.contains_key(&parent) || self.typed_arrays.contains_key(&parent) {
                return Ok(None);
            }
            current = parent;
        }
        let receiver_inst = match receiver.value {
            Payload::Reference(receiver_inst) if receiver.kind == Kind::Reference => receiver_inst,
            _ => return Ok(Some(false)),
        };
        if receiver_inst != inst || !self.indexes_by_index(receiver_inst) {
            // A different or non-ordinary receiver completes through the
            // general path, which knows that receiver's own storage.
            return Ok(None);
        }
        // CreateDataProperty / update, on the receiver.
        match self.index_prop_item(receiver_inst, index) {
            Some(existing) => {
                if existing.flag & XS_DONT_SET_FLAG != 0 {
                    return Ok(Some(false));
                }
                let mut replacement = value;
                replacement.flag = existing.flag;
                self.index_prop_set(receiver_inst, index, replacement);
            }
            None => {
                if !self.instance_extensible(receiver_inst) {
                    return Ok(Some(false));
                }
                self.index_prop_set(receiver_inst, index, value);
            }
        }
        Ok(Some(true))
    }

    /// The index store's descriptor for a property arrived at by NAME.
    ///
    /// Guarded on the store existing at all, so an object that has never held
    /// an index property pays one hash lookup and never the reverse name
    /// resolution.
    pub(in crate::interp) fn index_prop_descriptor_by_id(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<OrdinaryDescriptor> {
        if !self.index_props.contains_key(&inst) {
            return None;
        }
        let index = string_to_index(&self.scalar_key_text(id)?)?;
        self.index_prop_descriptor(inst, index)
    }

    /// The index this `id` names, when `inst` actually keeps an index store.
    pub(in crate::interp) fn index_prop_index_of_id(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<u32> {
        if !self.index_props.contains_key(&inst) {
            return None;
        }
        let index = string_to_index(&self.scalar_key_text(id)?)?;
        self.index_prop_item(inst, index).map(|_| index)
    }

    /// `ValidateAndApplyPropertyDescriptor` against the index store.
    ///
    /// `None` means this store cannot represent the definition and the caller
    /// must resolve a name: an ACCESSOR (whose getter/setter live in
    /// `self.accessors`, keyed by `(instance, id)`), or an index that already
    /// has an ordinary named slot, which stays where it is.
    pub(in crate::interp) fn index_prop_define(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
        descriptor: OrdinaryDescriptor,
    ) -> Option<bool> {
        if descriptor.is_accessor() {
            return None;
        }
        if self
            .index_read_key_id(index)
            .is_some_and(|id| self.find_property(inst, id).is_some())
        {
            return None;
        }
        match self.index_prop_item(inst, index) {
            Some(item) => {
                let current = self.index_prop_descriptor(inst, index)?;
                if !self.is_compatible_descriptor(
                    self.instance_extensible(inst),
                    &descriptor,
                    Some(&current),
                ) {
                    return Some(false);
                }
                let mut flag = item.flag;
                if let Some(writable) = descriptor.writable {
                    if writable {
                        flag &= !XS_DONT_SET_FLAG;
                    } else {
                        flag |= XS_DONT_SET_FLAG;
                    }
                }
                if let Some(enumerable) = descriptor.enumerable {
                    if enumerable {
                        flag &= !XS_DONT_ENUM_FLAG;
                    } else {
                        flag |= XS_DONT_ENUM_FLAG;
                    }
                }
                if let Some(configurable) = descriptor.configurable {
                    if configurable {
                        flag &= !XS_DONT_DELETE_FLAG;
                    } else {
                        flag |= XS_DONT_DELETE_FLAG;
                    }
                }
                let mut replacement = descriptor
                    .value
                    .unwrap_or_else(|| Slot::of(item.kind, item.value));
                replacement.flag = flag;
                self.index_prop_set(inst, index, replacement);
                Some(true)
            }
            None => {
                if !self.instance_extensible(inst) {
                    return Some(false);
                }
                // An absent property takes `false` for every attribute the
                // descriptor omits.
                let mut flag = 0u8;
                if !descriptor.writable.unwrap_or(false) {
                    flag |= XS_DONT_SET_FLAG;
                }
                if !descriptor.enumerable.unwrap_or(false) {
                    flag |= XS_DONT_ENUM_FLAG;
                }
                if !descriptor.configurable.unwrap_or(false) {
                    flag |= XS_DONT_DELETE_FLAG;
                }
                let mut item = descriptor.value.unwrap_or_else(Slot::undefined);
                item.flag = flag;
                self.index_prop_set(inst, index, item);
                Some(true)
            }
        }
    }

    /// The own descriptor for `index` spelled as a NAME, when the name is
    /// already interned and the object carries an ordinary slot under it.
    ///
    /// An index property created before this store existed — or by a
    /// `defineProperty` that needed a name, such as an accessor — lives in the
    /// named chain, and both storages have to be consulted.
    pub(in crate::interp) fn named_index_descriptor(
        &self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<OrdinaryDescriptor> {
        let id = self.index_read_key_id(index)?;
        self.ordinary_get_own_descriptor(inst, id)
    }

    /// The own descriptor an EXOTIC receiver synthesizes for `index` — a
    /// String wrapper's unit, a function's synthetic own names, and so on.
    pub(in crate::interp) fn exotic_index_own_descriptor(
        &mut self,
        inst: crate::value::SlotIndex,
        index: u32,
    ) -> Option<OrdinaryDescriptor> {
        let id = self.index_read_key_id(index)?;
        self.exotic_own_descriptor(inst, id)
    }

    /// The exotic-array own descriptor for `id` (`length` or an in-range index),
    /// or `None` when the id is neither — so `mop_get_own_property` /
    /// `mop_own_keys` see an array target's exotic own properties.
    pub(in crate::interp) fn array_own_descriptor(
        &self,
        inst: crate::value::SlotIndex,
        id: u16,
    ) -> Option<OrdinaryDescriptor> {
        let a = self.arrays.get(&inst)?;
        if self.scalar_key_text(id).as_deref() == Some("length")
            && !self.arguments_objects.contains(&inst)
        {
            return Some(OrdinaryDescriptor {
                value: Some(Self::array_index_number(u64::from(a.length))),
                writable: Some(self.array_length_writable(inst)),
                enumerable: Some(false),
                configurable: Some(false),
                ..OrdinaryDescriptor::default()
            });
        }
        let idx = self.scalar_key_text(id).and_then(|n| string_to_index(&n))?;
        let s = a.items().get(&idx).copied()?;
        let value = self.array_item_value(inst, s);
        Some(OrdinaryDescriptor {
            value: Some(value),
            writable: Some(s.flag & XS_DONT_SET_FLAG == 0),
            enumerable: Some(s.flag & XS_DONT_ENUM_FLAG == 0),
            configurable: Some(s.flag & XS_DONT_DELETE_FLAG == 0),
            ..OrdinaryDescriptor::default()
        })
    }

    /// Find the internal ordinary-indexed-storage high-water tombstone.
    /// `XS_NO_ID + XS_INTERNAL_FLAG + Number` is unobservable as a property
    /// and mirrors the internal slot shape XS itself keeps on indexed objects.
    pub(in crate::interp) fn internal_indexed_limit_slot(
        &self,
        inst: crate::value::SlotIndex,
    ) -> Option<crate::value::SlotIndex> {
        let mut cur = self.slots.get(inst).next;
        while !cur.is_null() {
            let slot = self.slots.get(cur);
            if slot.id == crate::value::XS_NO_ID
                && slot.flag & XS_INTERNAL_FLAG != 0
                && slot.kind == Kind::Number
            {
                return Some(cur);
            }
            cur = slot.next;
        }
        None
    }

    pub(in crate::interp) fn internal_indexed_limit(&self, inst: crate::value::SlotIndex) -> u32 {
        self.internal_indexed_limit_slot(inst)
            .and_then(|slot| match self.slots.get(slot).value {
                Payload::Number(limit) if limit >= 0.0 && limit <= f64::from(u32::MAX) => {
                    Some(limit as u32)
                }
                _ => None,
            })
            .unwrap_or(0)
    }

    /// Read a **named** property `id` of a primitive string (XS's string
    /// behavior boxing to `%String.prototype%`): `.length` is the UTF-16
    /// code-unit count (an unmetered accessor, like `arr.length`); any other
    /// name is the full `[[Get]]` up the `%String.prototype%` chain, with the
    /// primitive `receiver` as the accessor's `this` (see [`Interp::
    /// ordinary_get`]). A getter that throws returns `Err`, which the callers
    /// route to the enclosing `catch`.
    pub(in crate::interp) fn string_property_get(
        &mut self,
        code: &[u8],
        off: crate::value::ChunkOffset,
        id: u16,
        receiver: Slot,
    ) -> Result<Slot, Step> {
        if Some(id) == self.length_id {
            // `length` is O(1) over UTF-16 storage: half the stored byte payload.
            return Ok(Slot::integer(self.str_len(off) as i32));
        }
        let proto = self.string_proto;
        if proto.is_null() {
            return Ok(Slot::undefined());
        }
        self.ordinary_get(code, proto, id, receiver)
    }

    /// Read a computed index of a primitive string (`str[i]`): the one-unit
    /// string at UTF-16 code-unit index `index` (direct, O(1) — no boundary
    /// walk), or `undefined` past the end. Allocates the one-unit result chunk
    /// (`fxStringGetProperty` → `fxNewChunk`), metered via
    /// [`Interp::new_string_units`].
    pub(in crate::interp) fn string_index_get(
        &mut self,
        off: crate::value::ChunkOffset,
        index: u32,
    ) -> Slot {
        match self.str_unit_at(off, index) {
            Some(unit) => self.new_string_units(&[unit]),
            None => Slot::undefined(),
        }
    }
}
