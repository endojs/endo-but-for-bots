//! ArrayBuffer, TypedArray, DataView, and Atomics native algorithms.
use super::super::*;

impl Interp {
    /// The ArrayBuffer instance a receiver names (XS's
    /// `fxCheckArrayBufferInstance`), or `None` when the receiver is not an
    /// ArrayBuffer.
    pub(in crate::interp) fn array_buffer_ref(
        &self,
        this: Slot,
    ) -> Option<crate::value::SlotIndex> {
        match this.value {
            Payload::Reference(r) if self.array_buffers.contains_key(&r) => Some(r),
            _ => None,
        }
    }

    /// Mark an ArrayBuffer detached and expose its zero byte length. The old
    /// chunk becomes reclaimable when the owning instance is collected or the
    /// chunk arena is compacted.
    pub(in crate::interp) fn detach_array_buffer(&mut self, buffer: crate::value::SlotIndex) {
        self.detached_buffers.insert(buffer);
        self.array_buffers
            .get_mut(&buffer)
            .expect("detached buffer is branded")
            .length = 0;
    }

    /// `SpeciesConstructor(buffer, %ArrayBuffer%)`. Constructor and
    /// `@@species` reads use the full object MOP, and an undefined constructor
    /// or nullish species selects the realm intrinsic.
    fn array_buffer_species_constructor(
        &mut self,
        code: &[u8],
        buffer: Slot,
        buffer_ref: crate::value::SlotIndex,
    ) -> Result<Slot, Step> {
        let default_ref = *self
            .intrinsics
            .get("ArrayBuffer")
            .expect("ArrayBuffer intrinsic is linked");
        let default = Slot::of(Kind::Reference, Payload::Reference(default_ref));
        let constructor_id = self.intern_static_key("constructor");
        let constructor = self.mop_get(code, buffer_ref, constructor_id, buffer)?;
        if constructor.kind == Kind::Undefined {
            return Ok(default);
        }
        let constructor_ref = match constructor.value {
            Payload::Reference(reference) if constructor.kind == Kind::Reference => reference,
            _ => return Err(self.catchable_type_error_msg("no constructor".into())),
        };
        let species_id = self
            .well_known_symbol_property_id("species")
            .expect("well-known species symbol");
        let species = self.mop_get(code, constructor_ref, species_id, constructor)?;
        let selected = if matches!(species.kind, Kind::Null | Kind::Undefined) {
            default
        } else {
            species
        };
        if !self.is_constructor_value(selected) {
            return Err(self.catchable_type_error_msg("no constructor".into()));
        }
        Ok(selected)
    }

    /// `ArrayBuffer.prototype.slice(start, end)`: clamp both relative indices,
    /// construct through `SpeciesConstructor`, validate the returned buffer,
    /// recheck source detachment after user code, and copy the surviving byte
    /// range into the result.
    pub(in crate::interp) fn array_buffer_slice(
        &mut self,
        code: &[u8],
        this: Slot,
        base: usize,
        argc: usize,
    ) -> Result<Slot, Step> {
        let source = self.array_buffer_ref(this).ok_or_else(|| {
            self.catchable_type_error_msg("this: not an ArrayBuffer instance".into())
        })?;
        if self.shared_buffers.contains(&source) {
            return Err(self.catchable_type_error_msg("this: not an ArrayBuffer instance".into()));
        }
        if self.detached_buffers.contains(&source) {
            return Err(self.catchable_type_error_msg("detached buffer".into()));
        }
        let length = self.array_buffers[&source].length;
        let start_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let end_arg = self
            .stack
            .get(base + 5)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let first = Self::typed_array_relative_index(
            self.array_to_integer_or_infinity(code, start_arg)?,
            length,
        );
        let final_index = if argc < 2 || end_arg.kind == Kind::Undefined {
            length
        } else {
            Self::typed_array_relative_index(
                self.array_to_integer_or_infinity(code, end_arg)?,
                length,
            )
        };
        let new_length = final_index.saturating_sub(first);

        let constructor = self.array_buffer_species_constructor(code, this, source)?;
        let result = self.construct_value(
            code,
            constructor,
            &[Slot::number(new_length as f64)],
            constructor,
        )?;
        let result_ref = self
            .array_buffer_ref(result)
            .ok_or_else(|| self.catchable_type_error_msg("not an ArrayBuffer instance".into()))?;
        if self.shared_buffers.contains(&result_ref) {
            return Err(self.catchable_type_error_msg("not an ArrayBuffer instance".into()));
        }
        if result_ref == source {
            return Err(self.catchable_type_error_msg("same ArrayBuffer instance".into()));
        }
        if self.array_buffers[&result_ref].length < new_length {
            return Err(self.catchable_type_error_msg("smaller ArrayBuffer instance".into()));
        }
        if self.detached_buffers.contains(&result_ref) {
            return Err(self.catchable_type_error_msg("detached buffer".into()));
        }
        if self.detached_buffers.contains(&source) {
            return Err(self.catchable_type_error_msg("detached buffer".into()));
        }

        let current_length = self.array_buffers[&source].length;
        let count = new_length.min(current_length.saturating_sub(first));
        if count > 0 {
            let source_buffer = self.array_buffers[&source];
            let bytes = self.chunks.payload(source_buffer.data)
                [first as usize..(first + count) as usize]
                .to_vec();
            let target_buffer = self.array_buffers[&result_ref];
            let out = self.chunks.slice_mut(target_buffer.data, count as usize);
            out[..count as usize].copy_from_slice(&bytes);
        }
        Ok(result)
    }

    /// `ArrayBufferCopyAndDetach` for the engine's fixed-length ArrayBuffer
    /// model. Both public transfer methods are identical until resizable
    /// buffers are introduced: allocate a realm-intrinsic fixed buffer, copy
    /// the common prefix, zero-fill any extension, then detach the source.
    pub(in crate::interp) fn array_buffer_transfer(
        &mut self,
        code: &[u8],
        this: Slot,
        new_length_arg: Slot,
    ) -> Result<Slot, Step> {
        let source = self.array_buffer_ref(this).ok_or_else(|| {
            self.catchable_type_error_msg("this: not an ArrayBuffer instance".into())
        })?;
        if self.shared_buffers.contains(&source) {
            return Err(self.catchable_type_error_msg("this: not an ArrayBuffer instance".into()));
        }
        let old_length = self.array_buffers[&source].length;
        let new_length = if new_length_arg.kind == Kind::Undefined {
            old_length
        } else {
            self.to_index_arg(code, new_length_arg)?
        };
        // `ToIndex` above is observable and can detach the source.
        if self.detached_buffers.contains(&source) {
            return Err(self.catchable_type_error_msg("detached buffer".into()));
        }

        let copy_length = old_length.min(new_length);
        let result = self.alloc_array_buffer(new_length)?;
        let source_buffer = self.array_buffers[&source];
        let mut bytes = Self::reserved_vec(copy_length as usize)?;
        bytes.extend_from_slice(&self.chunks.payload(source_buffer.data)[..copy_length as usize]);
        if copy_length > 0 {
            let target_buffer = self.array_buffers[&result];
            let out = self
                .chunks
                .slice_mut(target_buffer.data, new_length as usize);
            out[..copy_length as usize].copy_from_slice(&bytes);
        }
        self.detach_array_buffer(source);
        Ok(Slot::of(Kind::Reference, Payload::Reference(result)))
    }

    /// `ValidateTypedArray(this)`: enforce the receiver brand and reject a
    /// view whose backing ArrayBuffer has been detached.
    pub(in crate::interp) fn validate_typed_array(
        &mut self,
        this: Slot,
    ) -> Result<TypedArrayData, Step> {
        let ta = match this.value {
            Payload::Reference(r) if this.kind == Kind::Reference => {
                self.typed_arrays.get(&r).copied()
            }
            _ => None,
        }
        .ok_or_else(|| self.catchable_type_error_msg("this: not a TypedArray instance".into()))?;
        if self.detached_buffers.contains(&ta.buffer) {
            return Err(self.catchable_type_error_msg("detached buffer".into()));
        }
        Ok(ta)
    }

    fn typed_array_relative_index(n: f64, length: u32) -> u32 {
        if n == f64::NEG_INFINITY {
            return 0;
        }
        if n < 0.0 {
            return (length as f64 + n).max(0.0) as u32;
        }
        if n == f64::INFINITY {
            return length;
        }
        n.min(length as f64) as u32
    }

    /// Coerce a TypedArray method's relative-index argument in spec order.
    fn typed_array_index_arg(
        &mut self,
        code: &[u8],
        value: Slot,
        length: u32,
    ) -> Result<u32, Step> {
        let n = self.array_to_integer_or_infinity(code, value)?;
        Ok(Self::typed_array_relative_index(n, length))
    }

    pub(in crate::interp) fn typed_array_accessor(
        &mut self,
        method: NativeMethod,
        this: Slot,
    ) -> Result<Slot, Step> {
        let ta = match this.value {
            Payload::Reference(r) if this.kind == Kind::Reference => {
                self.typed_arrays.get(&r).copied()
            }
            _ => None,
        };
        if method == NativeMethod::TypedArrayToStringTagGetter {
            return Ok(match ta {
                Some(ta) => {
                    self.new_string_metered(TYPED_ARRAY_TYPES[ta.kind as usize].name.as_bytes())
                }
                None => Slot::undefined(),
            });
        }
        let ta = ta.ok_or_else(|| {
            self.catchable_type_error_msg("this: not a TypedArray instance".into())
        })?;
        self.meter.tick_raw(TYPED_ARRAY_LENGTH_GET_METERING);
        let out_of_bounds = self.detached_buffers.contains(&ta.buffer);
        Ok(match method {
            NativeMethod::TypedArrayLengthGetter => {
                Slot::integer(if out_of_bounds { 0 } else { ta.length as i32 })
            }
            NativeMethod::TypedArrayByteLengthGetter => {
                let shift = TYPED_ARRAY_TYPES[ta.kind as usize].shift as u32;
                Slot::integer(if out_of_bounds {
                    0
                } else {
                    (ta.length << shift) as i32
                })
            }
            NativeMethod::TypedArrayByteOffsetGetter => {
                Slot::integer(if out_of_bounds { 0 } else { ta.offset as i32 })
            }
            NativeMethod::TypedArrayBufferGetter => {
                Slot::of(Kind::Reference, Payload::Reference(ta.buffer))
            }
            _ => unreachable!("typed_array_accessor called for non-accessor"),
        })
    }

    /// `%TypedArray%.prototype.toLocaleString`: the Array algorithm with the
    /// validated view's internal length. Element reads stay live, so a buffer
    /// detached by an earlier element call contributes empty later fields.
    pub(in crate::interp) fn typed_array_to_locale_string(
        &mut self,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let ta = self.validate_typed_array(this)?;
        let locales = if argc > 0 {
            self.stack
                .get(base + 4)
                .copied()
                .unwrap_or_else(Slot::undefined)
        } else {
            Slot::undefined()
        };
        let options = if argc > 1 {
            self.stack
                .get(base + 5)
                .copied()
                .unwrap_or_else(Slot::undefined)
        } else {
            Slot::undefined()
        };
        let mut out = Vec::new();
        for index in 0..ta.length {
            if index > 0 {
                out.push(u16::from(b','));
            }
            if self.detached_buffers.contains(&ta.buffer) {
                continue;
            }
            let value = if ta.kind <= 1 {
                self.typed_array_element_get_bigint(ta, index)
            } else {
                self.typed_array_element_get(ta, index)
                    .expect("numeric TypedArray locale element decodes")
            };
            let rendered =
                self.invoke_value_method(code, value, "toLocaleString", &[locales, options])?;
            out.extend_from_slice(&self.to_string_units(code, rendered)?);
        }
        Ok(self.new_string_units(&out))
    }

    /// Construct the result for `%TypedArray%.from` / `%TypedArray%.of` and
    /// apply `TypedArrayCreate`'s minimum-length validation before any element
    /// write can reach the backing chunk.
    fn typed_array_static_create(
        &mut self,
        code: &[u8],
        constructor: Slot,
        length: u64,
        from: bool,
    ) -> Result<(Slot, TypedArrayData), Step> {
        let result = self.construct_value(
            code,
            constructor,
            &[Slot::number(length as f64)],
            constructor,
        )?;
        if from
            && !matches!(result.value, Payload::Reference(r) if result.kind == Kind::Reference && self.typed_arrays.contains_key(&r))
        {
            return Err(self.catchable_type_error_msg("result: not a TypedArray instance".into()));
        }
        let ta = self.validate_typed_array(result)?;
        if u64::from(ta.length) < length {
            return Err(
                self.catchable_type_error_msg("result: too small TypedArray instance".into())
            );
        }
        Ok((result, ta))
    }

    /// The inherited `%TypedArray%.from` / `%TypedArray%.of` statics. `from`
    /// uses the iterator protocol directly (never the mutable public
    /// `Array.from` property) and preserves the distinct iterable and
    /// array-like construction order. `of` constructs the exact final length
    /// and writes each argument through the element conversion path.
    pub(in crate::interp) fn typed_array_static(
        &mut self,
        method: NativeMethod,
        constructor: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        if !self.is_constructor_value(constructor) {
            return Err(self.catchable_type_error_msg(
                if method == NativeMethod::TypedArrayFrom {
                    "this: not a constructor"
                } else {
                    "new: not a constructor"
                }
                .into(),
            ));
        }
        let args: Vec<Slot> = (0..argc)
            .map(|i| {
                self.stack
                    .get(base + 4 + i)
                    .copied()
                    .unwrap_or_else(Slot::undefined)
            })
            .collect();
        if method == NativeMethod::TypedArrayFrom {
            let items = args.first().copied().unwrap_or_else(Slot::undefined);
            let mapfn = args.get(1).copied().unwrap_or_else(Slot::undefined);
            let this_arg = args.get(2).copied().unwrap_or_else(Slot::undefined);
            let mapping = if mapfn.kind == Kind::Undefined {
                false
            } else if self.is_callable_value(mapfn) {
                true
            } else {
                return Err(self.catchable_type_error_msg("map: not a function".into()));
            };
            if matches!(items.kind, Kind::Null | Kind::Undefined) {
                return Err(self.catchable_type_error_msg(
                    if items.kind == Kind::Null {
                        "cannot coerce null to object"
                    } else {
                        "cannot coerce undefined to object"
                    }
                    .into(),
                ));
            }

            let iterator_id = self
                .well_known_symbol_property_id("iterator")
                .expect("well-known iterator symbol");
            let iterator_method = match items.value {
                Payload::Reference(inst) if items.kind == Kind::Reference => {
                    self.mop_get(code, inst, iterator_id, items)?
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
                            .and_then(|&c| self.ctor_prototype.get(&c).copied())
                            .unwrap_or(crate::value::SlotIndex::NULL),
                        _ => crate::value::SlotIndex::NULL,
                    };
                    if proto.is_null() {
                        Slot::undefined()
                    } else {
                        self.mop_get(code, proto, iterator_id, items)?
                    }
                }
            };
            if iterator_method.kind != Kind::Undefined
                && iterator_method.kind != Kind::Null
                && !self.is_callable_value(iterator_method)
            {
                return Err(self.catchable_type_error_msg("call: not a function".into()));
            }

            if iterator_method.kind != Kind::Undefined && iterator_method.kind != Kind::Null {
                let iterator = self.call_any(code, iterator_method, items, &[])?;
                let iterator_inst = match iterator.value {
                    Payload::Reference(inst) if iterator.kind == Kind::Reference => inst,
                    _ => {
                        return Err(self.catchable_type_error_msg("iterator: not an object".into()))
                    }
                };
                let next_id = self.intern_static_key("next");
                let value_id = self.intern_static_key("value");
                let done_id = self.intern_static_key("done");
                self.value_id = Some(value_id);
                self.done_id = Some(done_id);
                let next = self.mop_get(code, iterator_inst, next_id, iterator)?;
                if !self.is_callable_value(next) {
                    return Err(self.catchable_type_error_msg("call: not a function".into()));
                }
                let mut values = Vec::new();
                for _ in 0..1_000_000u32 {
                    let step = self.call_any(code, next, iterator, &[])?;
                    let step_inst = match step.value {
                        Payload::Reference(inst) if step.kind == Kind::Reference => inst,
                        _ => {
                            return Err(self
                                .catchable_type_error_msg("iterator result: not an object".into()))
                        }
                    };
                    let done = self.mop_get(code, step_inst, done_id, step)?;
                    if self.truthy(&done) {
                        let length = values.len() as u64;
                        let (result, ta) = self.typed_array_static_create(
                            code,
                            constructor,
                            length,
                            method == NativeMethod::TypedArrayFrom,
                        )?;
                        for (index, mut value) in values.into_iter().enumerate() {
                            if mapping {
                                value = self.call_any(
                                    code,
                                    mapfn,
                                    this_arg,
                                    &[value, Slot::number(index as f64)],
                                )?;
                            }
                            self.typed_array_element_set(code, ta, index as u32, value)?;
                        }
                        return Ok(result);
                    }
                    values.push(self.mop_get(code, step_inst, value_id, step)?);
                }
                return Err(Step::Host(Halt::StepLimit(self.n_dispatched)));
            }

            let array_like = match items.value {
                Payload::Reference(_) if items.kind == Kind::Reference => items,
                _ => match self.from_async_box_primitive(items) {
                    Some(object) => Slot::of(Kind::Reference, Payload::Reference(object)),
                    None => return Err(self.catchable_type_error()),
                },
            };
            let array_like_inst = match array_like.value {
                Payload::Reference(inst) => inst,
                _ => unreachable!(),
            };
            let length_value = self.arraylike_length(code, array_like_inst, array_like)?;
            let length = self.to_length_value(code, length_value)?;
            let (result, ta) = self.typed_array_static_create(
                code,
                constructor,
                length,
                method == NativeMethod::TypedArrayFrom,
            )?;
            let length = u32::try_from(length)
                .expect("successful TypedArrayCreate length fits the internal view width");
            for index in 0..length {
                let mut value =
                    self.arraylike_index(code, array_like_inst, u64::from(index), array_like)?;
                if mapping {
                    value =
                        self.call_any(code, mapfn, this_arg, &[value, Slot::number(index as f64)])?;
                }
                self.typed_array_element_set(code, ta, index, value)?;
            }
            return Ok(result);
        }

        let length = args.len() as u64;
        let (result, ta) = self.typed_array_static_create(
            code,
            constructor,
            length,
            method == NativeMethod::TypedArrayFrom,
        )?;
        for (index, value) in args.into_iter().enumerate() {
            self.typed_array_element_set(code, ta, index as u32, value)?;
        }
        Ok(result)
    }

    /// `%TypedArray%.prototype.join`: validate the branded view before
    /// coercing the separator, read the fixed internal length, and stringify
    /// each numeric/BigInt element in index order. A buffer detached by
    /// separator coercion makes subsequent integer-index reads `undefined`,
    /// hence empty fields, as required by IntegerIndexedElementGet.
    pub(in crate::interp) fn typed_array_join(
        &mut self,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let ta = self.validate_typed_array(this)?;
        let separator = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let sep = if argc == 0 || separator.kind == Kind::Undefined {
            vec![u16::from(b',')]
        } else {
            self.to_string_units(code, separator)?
        };
        let mut out = Vec::new();
        for index in 0..ta.length {
            if index > 0 {
                out.extend_from_slice(&sep);
            }
            if self.detached_buffers.contains(&ta.buffer) {
                continue;
            }
            let value = if ta.kind <= 1 {
                self.typed_array_element_get_bigint(ta, index)
            } else {
                self.typed_array_element_get(ta, index)
                    .expect("numeric TypedArray element decodes")
            };
            out.extend_from_slice(&self.to_string_units_metered(value));
        }
        Ok(self.new_string_units(&out))
    }

    /// `TypedArraySpeciesCreate(exemplar, argumentsList)`: resolve an own or
    /// inherited `constructor[Symbol.species]`, fall back to the exemplar's
    /// concrete intrinsic constructor, construct a branded attached view, and
    /// validate the resulting view. A one-length construction
    /// also requires the result to be at least that long (`TypedArrayCreate`).
    fn typed_array_species_create(
        &mut self,
        code: &[u8],
        exemplar: crate::value::SlotIndex,
        source: TypedArrayData,
        args: &[Slot],
        minimum_length: Option<u32>,
    ) -> Result<(Slot, TypedArrayData), Step> {
        let default_constructor = self
            .intrinsics
            .get(TYPED_ARRAY_TYPES[source.kind as usize].name)
            .copied()
            .expect("concrete TypedArray constructor");
        let default_constructor =
            Slot::of(Kind::Reference, Payload::Reference(default_constructor));
        let exemplar_slot = Slot::of(Kind::Reference, Payload::Reference(exemplar));
        let constructor_id = self.intern_static_key("constructor");
        let mut constructor = self.mop_get(code, exemplar, constructor_id, exemplar_slot)?;
        if constructor.kind == Kind::Undefined {
            constructor = default_constructor;
        } else {
            let constructor_ref = match constructor.value {
                Payload::Reference(reference) if constructor.kind == Kind::Reference => reference,
                _ => return Err(self.catchable_type_error_msg("no constructor".into())),
            };
            let species_id = self
                .well_known_symbol_property_id("species")
                .ok_or(Step::Host(Halt::NotImplemented(
                    "typed-array-species:symbol",
                )))?;
            let species = self.mop_get(code, constructor_ref, species_id, constructor)?;
            constructor = if species.kind == Kind::Null || species.kind == Kind::Undefined {
                default_constructor
            } else {
                species
            };
        }
        if !self.is_constructor_value(constructor) {
            return Err(self.catchable_type_error_msg("no constructor".into()));
        }
        let result = self.construct_value(code, constructor, args, constructor)?;
        let result_ref = match result.value {
            Payload::Reference(reference) if result.kind == Kind::Reference => reference,
            _ => return Err(self.catchable_type_error()),
        };
        let target = self.validate_typed_array(result)?;
        // Preserve the spec content-domain guard. Pinned XS defers this to
        // element coercion, so empty/mapped cross-domain species can succeed;
        // there is no corresponding XS diagnostic for this earlier error.
        if (source.kind <= 1) != (target.kind <= 1) {
            return Err(self.catchable_type_error());
        }
        if minimum_length.is_some_and(|minimum| target.length < minimum) {
            return Err(
                self.catchable_type_error_msg("result: too small TypedArray instance".into())
            );
        }
        debug_assert!(self.typed_arrays.contains_key(&result_ref));
        Ok((result, target))
    }

    /// The two range-copying shared TypedArray methods. `slice` allocates a
    /// species result and copies values (raw bytes for the same element type,
    /// preserving NaN payloads); `subarray` constructs a species view over the
    /// original buffer and therefore shares subsequent writes.
    pub(in crate::interp) fn typed_array_slice_or_subarray(
        &mut self,
        method: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let exemplar = match this.value {
            Payload::Reference(reference)
                if this.kind == Kind::Reference && self.typed_arrays.contains_key(&reference) =>
            {
                reference
            }
            _ => {
                return Err(self.catchable_type_error_msg("this: not a TypedArray instance".into()))
            }
        };
        // `subarray` intentionally performs its begin/end coercions even for a
        // detached branded view; construction over the detached buffer is the
        // later operation that throws. `slice` uses ValidateTypedArray up front.
        let source = if method == NativeMethod::TypedArraySubarray {
            self.typed_arrays[&exemplar]
        } else {
            self.validate_typed_array(this)?
        };
        let begin_arg = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let end_arg = self
            .stack
            .get(base + 5)
            .copied()
            .unwrap_or_else(Slot::undefined);
        // IntegerIndexedObjectLength returns zero for a detached view. Keep
        // the stored byte offset (the species constructor must still observe
        // it), but calculate both relative indices against that effective
        // zero length rather than the pre-detachment internal slot.
        let source_length = if method == NativeMethod::TypedArraySubarray
            && self.detached_buffers.contains(&source.buffer)
        {
            0
        } else {
            source.length
        };
        let begin = Self::typed_array_relative_index(
            self.array_to_integer_or_infinity(code, begin_arg)?,
            source_length,
        );
        let end = if argc < 2 || end_arg.kind == Kind::Undefined {
            source_length
        } else {
            Self::typed_array_relative_index(
                self.array_to_integer_or_infinity(code, end_arg)?,
                source_length,
            )
        };
        let count = end.saturating_sub(begin);

        if method == NativeMethod::TypedArraySubarray {
            let element_size = TYPED_ARRAY_TYPES[source.kind as usize].size as u32;
            let byte_offset = source
                .offset
                .checked_add(begin.saturating_mul(element_size))
                .ok_or_else(|| self.catchable_range_error())?;
            let buffer = Slot::of(Kind::Reference, Payload::Reference(source.buffer));
            let args = [
                buffer,
                Slot::number(byte_offset as f64),
                Slot::number(count as f64),
            ];
            let (result, _) =
                self.typed_array_species_create(code, exemplar, source, &args, None)?;
            return Ok(result);
        }

        let args = [Slot::number(count as f64)];
        let (result, target) =
            self.typed_array_species_create(code, exemplar, source, &args, Some(count))?;
        if count == 0 {
            return Ok(result);
        }
        if self.detached_buffers.contains(&source.buffer) {
            return Err(self.catchable_type_error_msg("detached buffer".into()));
        }
        if source.kind == target.kind {
            let size = TYPED_ARRAY_TYPES[source.kind as usize].size as usize;
            let source_buffer = self.array_buffers[&source.buffer];
            let source_start = source.offset as usize + begin as usize * size;
            let byte_count = count as usize * size;
            let bytes = self.chunks.payload(source_buffer.data)
                [source_start..source_start + byte_count]
                .to_vec();
            let target_buffer = self.array_buffers[&target.buffer];
            let target_start = target.offset as usize;
            let out = self
                .chunks
                .slice_mut(target_buffer.data, target_start + byte_count);
            out[target_start..target_start + byte_count].copy_from_slice(&bytes);
        } else {
            for offset in 0..count {
                let value = if source.kind <= 1 {
                    self.typed_array_element_get_bigint(source, begin + offset)
                } else {
                    self.typed_array_element_get(source, begin + offset)
                        .expect("numeric TypedArray slice source decodes")
                };
                self.typed_array_element_set(code, target, offset, value)?;
            }
        }
        Ok(result)
    }

    /// The allocating callback pair on `%TypedArray%.prototype`. `map`
    /// creates its species result before invoking callbacks and writes each
    /// mapped value immediately; `filter` first records the selected source
    /// values, then creates an exactly-sized species result and copies them.
    pub(in crate::interp) fn typed_array_map_filter(
        &mut self,
        method: NativeMethod,
        this: Slot,
        base: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let source = self.validate_typed_array(this)?;
        let exemplar = match this.value {
            Payload::Reference(reference) => reference,
            _ => unreachable!(),
        };
        let callback = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let this_arg = self
            .stack
            .get(base + 5)
            .copied()
            .unwrap_or_else(Slot::undefined);
        if !self.is_callable_value(callback) {
            return Err(self.catchable_type_error_msg("callback: not a function".into()));
        }

        if method == NativeMethod::TypedArrayMap {
            let args = [Slot::number(source.length as f64)];
            let (result, target) = self.typed_array_species_create(
                code,
                exemplar,
                source,
                &args,
                Some(source.length),
            )?;
            for index in 0..source.length {
                let value = self.ta_indexed_element_get(source, index as f64);
                let mapped = self.run_callback(
                    code,
                    callback,
                    this_arg,
                    &[value, Slot::integer(index as i32), this],
                )?;
                self.ta_indexed_element_set(code, target, index as f64, mapped)?;
            }
            return Ok(result);
        }

        let mut kept = Vec::new();
        for index in 0..source.length {
            let value = self.ta_indexed_element_get(source, index as f64);
            let selected = self.run_callback(
                code,
                callback,
                this_arg,
                &[value, Slot::integer(index as i32), this],
            )?;
            if self.truthy(&selected) {
                kept.push(value);
            }
        }
        let length = kept.len() as u32;
        let args = [Slot::number(length as f64)];
        let (result, target) =
            self.typed_array_species_create(code, exemplar, source, &args, Some(length))?;
        for (index, value) in kept.into_iter().enumerate() {
            self.ta_indexed_element_set(code, target, index as f64, value)?;
        }
        Ok(result)
    }

    /// `%TypedArray%.prototype.sort`: stable numeric/BigInt ordering, with an
    /// optional guest comparator whose result is ToNumber-coerced. A comparator
    /// that detaches the receiver triggers the required TypeError immediately
    /// after its result is ToNumber-coerced, before another comparison or any
    /// write-back.
    pub(in crate::interp) fn typed_array_sort(
        &mut self,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let typed_array = self.validate_typed_array(this)?;
        let compare = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let custom = argc > 0 && compare.kind != Kind::Undefined;
        if custom && !self.is_callable_value(compare) {
            return Err(self.catchable_type_error_msg("compare: not a function".into()));
        }
        let mut values = self.reserve_work_scratch(typed_array.length as usize)?;
        for index in 0..typed_array.length {
            values.push(if typed_array.kind <= 1 {
                self.typed_array_element_get_bigint(typed_array, index)
            } else {
                self.typed_array_element_get(typed_array, index)
                    .expect("numeric TypedArray sort element decodes")
            });
        }

        // Stable insertion sort keeps comparator calls sequenced and fallible
        // without laundering guest exceptions through a Rust comparator.
        for index in 1..values.len() {
            let value = values[index];
            let mut destination = index;
            while destination > 0 {
                let previous = values[destination - 1];
                let ordering = if custom {
                    let result =
                        self.run_callback(code, compare, Slot::undefined(), &[value, previous])?;
                    let number = self.to_number_f64(code, result)?;
                    if self.detached_buffers.contains(&typed_array.buffer) {
                        return Err(self.catchable_type_error_msg("detached buffer".into()));
                    }
                    if number < 0.0 {
                        std::cmp::Ordering::Less
                    } else if number > 0.0 {
                        std::cmp::Ordering::Greater
                    } else {
                        std::cmp::Ordering::Equal
                    }
                } else if typed_array.kind <= 1 {
                    let (Payload::BigInt(left), Payload::BigInt(right)) =
                        (value.value, previous.value)
                    else {
                        unreachable!("BigInt TypedArray sort values")
                    };
                    let (left_negative, left_magnitude) = self.read_bigint(left);
                    let (right_negative, right_magnitude) = self.read_bigint(right);
                    bi_cmp(
                        left_negative,
                        &left_magnitude,
                        right_negative,
                        &right_magnitude,
                    )
                } else {
                    let left = numeric_of(&value).unwrap_or(f64::NAN);
                    let right = numeric_of(&previous).unwrap_or(f64::NAN);
                    if left.is_nan() {
                        if right.is_nan() {
                            std::cmp::Ordering::Equal
                        } else {
                            std::cmp::Ordering::Greater
                        }
                    } else if right.is_nan() {
                        std::cmp::Ordering::Less
                    } else if left == 0.0 && right == 0.0 {
                        right.is_sign_negative().cmp(&left.is_sign_negative())
                    } else {
                        left.partial_cmp(&right)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    }
                };
                if ordering != std::cmp::Ordering::Less {
                    break;
                }
                values[destination] = previous;
                destination -= 1;
            }
            values[destination] = value;
        }
        for (index, value) in values.into_iter().enumerate() {
            self.typed_array_element_set(code, typed_array, index as u32, value)?;
        }
        Ok(this)
    }

    /// The non-allocating `%TypedArray%.prototype` iteration/search/fold
    /// family. These algorithms validate the integer-indexed receiver once,
    /// capture its internal length, and then `Get` every index (TypedArrays
    /// have no holes). If a callback detaches the buffer, later indexed reads
    /// become `undefined` while the captured iteration range remains fixed.
    pub(in crate::interp) fn typed_array_readonly(
        &mut self,
        operation: u8,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let ta = self.validate_typed_array(this)?;
        let length = ta.length;
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

        if matches!(operation, 0..=4 | 8..=9) && !self.is_callable_value(arg0) {
            return Err(self.catchable_type_error_msg("callback: not a function".into()));
        }

        match operation {
            // forEach / every / some
            0..=2 => {
                let mut answer = operation == 1;
                for index in 0..length {
                    let value = self.ta_indexed_element_get(ta, index as f64);
                    let result = self.run_callback(
                        code,
                        arg0,
                        arg1,
                        &[value, Slot::integer(index as i32), this],
                    )?;
                    if operation == 1 && !self.truthy(&result) {
                        answer = false;
                        break;
                    }
                    if operation == 2 && self.truthy(&result) {
                        answer = true;
                        break;
                    }
                }
                Ok(if operation == 0 {
                    Slot::undefined()
                } else {
                    Slot::boolean(answer)
                })
            }
            // find / findIndex
            3..=4 => {
                for index in 0..length {
                    let value = self.ta_indexed_element_get(ta, index as f64);
                    let result = self.run_callback(
                        code,
                        arg0,
                        arg1,
                        &[value, Slot::integer(index as i32), this],
                    )?;
                    if self.truthy(&result) {
                        return Ok(if operation == 3 {
                            value
                        } else {
                            Slot::integer(index as i32)
                        });
                    }
                }
                Ok(if operation == 3 {
                    Slot::undefined()
                } else {
                    Slot::integer(-1)
                })
            }
            // includes / indexOf
            5..=6 => {
                if length == 0 {
                    return Ok(if operation == 5 {
                        Slot::boolean(false)
                    } else {
                        Slot::integer(-1)
                    });
                }
                let start = if argc >= 2 {
                    let relative = self.array_to_integer_or_infinity(code, arg1)?;
                    Self::typed_array_relative_index(relative, length)
                } else {
                    0
                };
                for index in start..length {
                    let value = self.ta_indexed_element_get(ta, index as f64);
                    let equal = if operation == 5 {
                        self.same_value_zero(&arg0, &value)
                    } else {
                        self.strict_equal(&arg0, &value)
                    };
                    if equal {
                        return Ok(if operation == 5 {
                            Slot::boolean(true)
                        } else {
                            Slot::integer(index as i32)
                        });
                    }
                }
                Ok(if operation == 5 {
                    Slot::boolean(false)
                } else {
                    Slot::integer(-1)
                })
            }
            // lastIndexOf
            7 => {
                if length == 0 {
                    return Ok(Slot::integer(-1));
                }
                let relative = if argc >= 2 {
                    self.array_to_integer_or_infinity(code, arg1)?
                } else {
                    f64::INFINITY
                };
                if relative == f64::NEG_INFINITY {
                    return Ok(Slot::integer(-1));
                }
                let mut index = if relative >= 0.0 {
                    (relative as i128).min(length as i128 - 1)
                } else {
                    length as i128 + relative as i128
                };
                while index >= 0 {
                    let value = self.ta_indexed_element_get(ta, index as f64);
                    if self.strict_equal(&arg0, &value) {
                        return Ok(Slot::integer(index as i32));
                    }
                    index -= 1;
                }
                Ok(Slot::integer(-1))
            }
            // reduce / reduceRight
            8..=9 => {
                let right = operation == 9;
                let mut cursor = 0u32;
                let index_at = |cursor: u32| {
                    if right {
                        length - 1 - cursor
                    } else {
                        cursor
                    }
                };
                let mut accumulator = if argc >= 2 {
                    arg1
                } else if length == 0 {
                    return Err(self.catchable_type_error_msg("no initial value".into()));
                } else {
                    let value = self.ta_indexed_element_get(ta, index_at(cursor) as f64);
                    cursor += 1;
                    value
                };
                while cursor < length {
                    let index = index_at(cursor);
                    cursor += 1;
                    let value = self.ta_indexed_element_get(ta, index as f64);
                    accumulator = self.run_callback(
                        code,
                        arg0,
                        Slot::undefined(),
                        &[accumulator, value, Slot::integer(index as i32), this],
                    )?;
                }
                Ok(accumulator)
            }
            _ => Err(Step::Host(Halt::NotImplemented(
                "TypedArray.prototype:readonly-operation",
            ))),
        }
    }

    /// The four in-place `%TypedArray.prototype%` mutators. All receiver and
    /// detachment failures are realm-local TypeErrors; argument coercions run
    /// in specification order and may execute guest code.
    pub(in crate::interp) fn typed_array_mutator(
        &mut self,
        method: NativeMethod,
        this: Slot,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let arg = |this: &Self, i: usize| {
            this.stack
                .get(base + 4 + i)
                .copied()
                .unwrap_or_else(Slot::undefined)
        };
        let ta = self.validate_typed_array(this)?;
        let size = TYPED_ARRAY_TYPES[ta.kind as usize].size as usize;

        match method {
            NativeMethod::TypedArrayCopyWithin => {
                let to = self.typed_array_index_arg(code, arg(self, 0), ta.length)?;
                let from = self.typed_array_index_arg(code, arg(self, 1), ta.length)?;
                let end = if argc < 3 || arg(self, 2).kind == Kind::Undefined {
                    ta.length
                } else {
                    self.typed_array_index_arg(code, arg(self, 2), ta.length)?
                };
                if self.detached_buffers.contains(&ta.buffer) {
                    return Err(self.catchable_type_error_msg("detached buffer".into()));
                }
                let count = end.saturating_sub(from).min(ta.length.saturating_sub(to));
                if count > 0 {
                    let buffer = self.array_buffers[&ta.buffer];
                    let src = ta.offset as usize + from as usize * size;
                    let dst = ta.offset as usize + to as usize * size;
                    let byte_count = count as usize * size;
                    let snapshot = self.chunks.payload(buffer.data)[src..src + byte_count].to_vec();
                    let out = self.chunks.slice_mut(buffer.data, dst + byte_count);
                    out[dst..dst + byte_count].copy_from_slice(&snapshot);
                }
                Ok(this)
            }
            NativeMethod::TypedArrayFill => {
                // The element value is coerced once, before start/end.
                let bytes = self.typed_array_element_bytes(code, ta.kind, arg(self, 0))?;
                let start = if argc < 2 || arg(self, 1).kind == Kind::Undefined {
                    0
                } else {
                    self.typed_array_index_arg(code, arg(self, 1), ta.length)?
                };
                let end = if argc < 3 || arg(self, 2).kind == Kind::Undefined {
                    ta.length
                } else {
                    self.typed_array_index_arg(code, arg(self, 2), ta.length)?
                };
                if self.detached_buffers.contains(&ta.buffer) {
                    return Err(self.catchable_type_error_msg("detached buffer".into()));
                }
                let buffer = self.array_buffers[&ta.buffer];
                for i in start..end {
                    let pos = ta.offset as usize + i as usize * size;
                    let out = self.chunks.slice_mut(buffer.data, pos + size);
                    out[pos..pos + size].copy_from_slice(&bytes);
                }
                Ok(this)
            }
            NativeMethod::TypedArrayReverse => {
                if ta.length > 1 {
                    let buffer = self.array_buffers[&ta.buffer];
                    let mut lo = 0u32;
                    let mut hi = ta.length - 1;
                    while lo < hi {
                        let lpos = ta.offset as usize + lo as usize * size;
                        let hpos = ta.offset as usize + hi as usize * size;
                        let left = self.chunks.payload(buffer.data)[lpos..lpos + size].to_vec();
                        let right = self.chunks.payload(buffer.data)[hpos..hpos + size].to_vec();
                        let out = self.chunks.slice_mut(buffer.data, hpos + size);
                        out[lpos..lpos + size].copy_from_slice(&right);
                        out[hpos..hpos + size].copy_from_slice(&left);
                        lo += 1;
                        hi -= 1;
                    }
                }
                Ok(this)
            }
            NativeMethod::TypedArraySet => {
                let offset_number = self.array_to_integer_or_infinity(code, arg(self, 1))?;
                if offset_number < 0.0 {
                    return Err(self.catchable_range_error_msg("byteLength < 0".into()));
                }
                if offset_number > i32::MAX as f64 {
                    return Err(self.catchable_range_error_msg("byteLength too big".into()));
                }
                let offset = offset_number as u32;
                if self.detached_buffers.contains(&ta.buffer) {
                    return Err(self.catchable_type_error_msg("detached buffer".into()));
                }
                let source = arg(self, 0);

                if let Payload::Reference(src_ref) = source.value {
                    if source.kind == Kind::Reference && self.typed_arrays.contains_key(&src_ref) {
                        let src = self.validate_typed_array(source)?;
                        // Keep the spec's content-domain guard; pinned XS only
                        // rejects when an element conversion encounters the mismatch.
                        if (ta.kind <= 1) != (src.kind <= 1) {
                            return Err(self.catchable_type_error());
                        }
                        if src.length > ta.length.saturating_sub(offset) || offset > ta.length {
                            return Err(self.catchable_range_error_msg("invalid offset".into()));
                        }
                        if ta.kind == src.kind {
                            // Same element type copies raw bytes, preserving NaN
                            // payloads, and snapshots before an overlapping write.
                            let src_size = TYPED_ARRAY_TYPES[src.kind as usize].size as usize;
                            let src_buffer = self.array_buffers[&src.buffer];
                            let src_start = src.offset as usize;
                            let byte_count = src.length as usize * src_size;
                            let snapshot = self.chunks.payload(src_buffer.data)
                                [src_start..src_start + byte_count]
                                .to_vec();
                            let target_buffer = self.array_buffers[&ta.buffer];
                            let target_start = ta.offset as usize + offset as usize * size;
                            let out = self
                                .chunks
                                .slice_mut(target_buffer.data, target_start + byte_count);
                            out[target_start..target_start + byte_count].copy_from_slice(&snapshot);
                        } else {
                            // Different element types convert source values. Read
                            // the complete list first so overlapping views behave
                            // as if the source bytes were cloned.
                            let mut values = self.reserve_work_scratch(src.length as usize)?;
                            for i in 0..src.length {
                                let value = if src.kind <= 1 {
                                    self.typed_array_element_get_bigint(src, i)
                                } else {
                                    self.typed_array_element_get(src, i).unwrap()
                                };
                                values.push(value);
                            }
                            for (i, value) in values.into_iter().enumerate() {
                                self.typed_array_element_set(code, ta, offset + i as u32, value)?;
                            }
                        }
                        return Ok(Slot::undefined());
                    }

                    if source.kind == Kind::Reference {
                        let raw_len = self.arraylike_length(code, src_ref, source)?;
                        let src_len = to_length_u64(self.to_number_f64(code, raw_len)?);
                        if src_len > ta.length.saturating_sub(offset) as u64 || offset > ta.length {
                            return Err(self.catchable_range_error_msg("invalid offset".into()));
                        }
                        for i in 0..src_len {
                            let value = self.arraylike_index(code, src_ref, i, source)?;
                            let bytes = self.typed_array_element_bytes(code, ta.kind, value)?;
                            if self.detached_buffers.contains(&ta.buffer) {
                                return Err(self.catchable_type_error_msg("detached buffer".into()));
                            }
                            let target_buffer = self.array_buffers[&ta.buffer];
                            let pos = ta.offset as usize + (offset as usize + i as usize) * size;
                            let out = self.chunks.slice_mut(target_buffer.data, pos + size);
                            out[pos..pos + size].copy_from_slice(&bytes);
                        }
                        return Ok(Slot::undefined());
                    }
                }
                // `ToObject(source)`: null/undefined reject. A primitive
                // string's boxed exotic object exposes UTF-16 indices and a
                // `length`; every other primitive wrapper has length 0.
                if matches!(source.kind, Kind::Null | Kind::Undefined) {
                    return Err(self.catchable_type_error_msg(
                        if source.kind == Kind::Null {
                            "cannot coerce null to object"
                        } else {
                            "cannot coerce undefined to object"
                        }
                        .into(),
                    ));
                }
                if let Payload::String(string) = source.value {
                    let src_len = self.str_len(string) as u32;
                    if src_len > ta.length.saturating_sub(offset) || offset > ta.length {
                        return Err(self.catchable_range_error_msg("invalid offset".into()));
                    }
                    for i in 0..src_len {
                        let value = self.string_index_get(string, i);
                        self.typed_array_element_set(code, ta, offset + i, value)?;
                    }
                } else if offset > ta.length {
                    return Err(self.catchable_range_error_msg("invalid offset".into()));
                }
                Ok(Slot::undefined())
            }
            _ => unreachable!("typed_array_mutator called for a non-mutator"),
        }
    }

    /// Decode a numeric TypedArray element from little-endian backing bytes.
    /// The caller validates bounds. BigInt-element kinds return `None`;
    /// [`Self::typed_array_element_get_bigint`] allocates their BigInt result.
    pub(in crate::interp) fn typed_array_element_get(
        &self,
        ta: TypedArrayData,
        index: u32,
    ) -> Option<Slot> {
        let size = TYPED_ARRAY_TYPES[ta.kind as usize].size as usize;
        let buf = self.array_buffers[&ta.buffer];
        let base = ta.offset as usize + index as usize * size;
        let bytes = self.chunks.payload(buf.data);
        decode_element_le(ta.kind, &bytes[base..base + size])
    }

    /// The decimal string of a BigInt64/BigUint64 TypedArray element (kinds
    /// 0/1), for the `%TypedArray%.prototype.toString`/`join` completion render
    /// (`String(0n)` is `"0"`, no `n` suffix). A read-only (`&self`) sibling of
    /// [`Self::typed_array_element_get_bigint`] that formats the value directly
    /// rather than allocating a BigInt value. Storage is little-endian.
    pub(in crate::interp) fn typed_array_element_bigint_decimal(
        &self,
        ta: TypedArrayData,
        index: u32,
    ) -> String {
        let buf = self.array_buffers[&ta.buffer];
        let base = ta.offset as usize + index as usize * 8;
        let bytes = self.chunks.payload(buf.data);
        let mut b = [0u8; 8];
        b.copy_from_slice(&bytes[base..base + 8]);
        let u = u64::from_le_bytes(b);
        // kind 0 = BigInt64Array (signed two's complement), 1 = BigUint64Array.
        if ta.kind == 0 {
            (u as i64).to_string()
        } else {
            u.to_string()
        }
    }

    /// Coerce one value to the exact bytes stored by a TypedArray element.
    /// Keeping coercion separate from the write lets `fill` coerce once, as
    /// required, and then repeat the resulting element bytes.
    fn typed_array_element_bytes(
        &mut self,
        code: &[u8],
        kind: u8,
        value: Slot,
    ) -> Result<Vec<u8>, Step> {
        if kind <= 1 {
            let primitive = self.to_primitive(code, value, false)?;
            let u = match primitive.value {
                Payload::BigInt(_) | Payload::Boolean(_) => {
                    self.slot_to_bigint_u64(primitive).unwrap()
                }
                Payload::String(off) => {
                    parse_bigint_string_u64(&self.str_text(off)).ok_or_else(|| {
                        self.catchable_syntax_error_with_message(
                            "cannot coerce string to bigint".into(),
                        )
                    })?
                }
                _ => {
                    return Err(self.catchable_type_error_msg(
                        match primitive.kind {
                            Kind::Integer | Kind::Number => "cannot coerce number to bigint",
                            Kind::Symbol => "cannot coerce symbol to bigint",
                            _ => "cannot coerce to bigint",
                        }
                        .into(),
                    ))
                }
            };
            return Ok(u.to_le_bytes().to_vec());
        }
        let primitive = self.to_primitive(code, value, false)?;
        let number = match primitive.kind {
            Kind::Integer | Kind::Number => primitive,
            Kind::String => match primitive.value {
                Payload::String(off) => {
                    Slot::number(string_to_number(self.str_text(off).as_bytes(), true))
                }
                _ => unreachable!(),
            },
            Kind::Boolean | Kind::Null | Kind::Undefined => Slot::number(to_number(&primitive)),
            Kind::BigInt | Kind::Symbol => {
                let target = match kind {
                    4..=6 => "integer",
                    7..=9 => "unsigned",
                    _ => "number",
                };
                let symbol = if primitive.kind == Kind::Symbol {
                    " symbol"
                } else {
                    ""
                };
                return Err(
                    self.catchable_type_error_msg(format!("cannot coerce{symbol} to {target}"))
                );
            }
            _ => return Err(self.catchable_type_error()),
        };
        let n = numeric_of(&number).unwrap_or(f64::NAN);
        encode_element_le(kind, n).ok_or(Step::Host(Halt::NotImplemented("typed-array-set:bigint")))
    }

    /// Coerce `value` to this element type and write TypedArray element
    /// `index` (XS's per-type setter). `index` must be in bounds.
    pub(in crate::interp) fn typed_array_element_set(
        &mut self,
        code: &[u8],
        ta: TypedArrayData,
        index: u32,
        value: Slot,
    ) -> Result<(), Step> {
        let le = self.typed_array_element_bytes(code, ta.kind, value)?;
        let size = le.len();
        let buf = self.array_buffers[&ta.buffer];
        let base = ta.offset as usize + index as usize * size;
        let out = self.chunks.slice_mut(buf.data, base + size);
        out[base..base + size].copy_from_slice(&le);
        Ok(())
    }

    /// Read a BigInt64/BigUint64 TypedArray element (kinds 0/1) into a freshly
    /// allocated BigInt (the exotic index [[Get]] BigInt path), reading
    /// little-endian storage.
    pub(in crate::interp) fn typed_array_element_get_bigint(
        &mut self,
        ta: TypedArrayData,
        index: u32,
    ) -> Slot {
        let buf = self.array_buffers[&ta.buffer];
        let base = ta.offset as usize + index as usize * 8;
        let mut b = [0u8; 8];
        {
            let bytes = self.chunks.payload(buf.data);
            b.copy_from_slice(&bytes[base..base + 8]);
        }
        let u = u64::from_le_bytes(b);
        let (neg, mag) = u64_to_signed_limbs(ta.kind == 0, u);
        self.make_bigint(neg, mag)
    }

    /// `IsValidIntegerIndex(O, index)` (ECMA-262 10.4.5.14) for the numeric
    /// index `n` a canonical numeric index string named: `Some(index)` when
    /// `n` is an integral non-negative value (`-0` excluded) strictly below
    /// the view length and the viewed buffer is attached, else `None`. The
    /// integer/number fast kinds keep this on the inline arithmetic path so the
    /// meter-exact corpus is untouched.
    pub(in crate::interp) fn ta_valid_index(&self, ta: TypedArrayData, n: f64) -> Option<u32> {
        if self.detached_buffers.contains(&ta.buffer) {
            return None;
        }
        // Integral, finite, not -0, and in `[0, length)`.
        if !n.is_finite() || n.fract() != 0.0 {
            return None;
        }
        if n == 0.0 && n.is_sign_negative() {
            return None;
        }
        if n < 0.0 || n >= ta.length as f64 {
            return None;
        }
        Some(n as u32)
    }

    /// `CanonicalNumericIndexString(P)` for a property-key `Slot`: `Some(n)`
    /// iff `key` is a **String** value that canonically names the number `n`
    /// (10.4.5.1). A Symbol key — or any non-string — is never a numeric
    /// index (`None`), routing the integer-indexed MOP to ordinary behavior.
    pub(in crate::interp) fn ta_numeric_index(&self, key: Slot) -> Option<f64> {
        if key.kind != Kind::String {
            return None;
        }
        match key.value {
            Payload::String(off) => canonical_numeric_index_string(&self.str_text(off)),
            _ => None,
        }
    }

    /// `CanonicalNumericIndexString(P)` for an `AT`-encoded key `(id, index)`:
    /// reconstruct the property name string and canonicalize it. A plain
    /// integer index (`id == XS_NO_ID`) is its own canonical decimal; a named
    /// key resolves through the intern table (a symbol key is never numeric).
    pub(in crate::interp) fn ta_numeric_index_at(&self, id: u16, index: u32) -> Option<f64> {
        if id == crate::value::XS_NO_ID {
            return Some(index as f64);
        }
        if self.is_symbol_key_id(id) {
            return None;
        }
        let name = self.scalar_key_text(id)?;
        canonical_numeric_index_string(&name)
    }

    /// `IntegerIndexedElementGet(O, index)` (ECMA-262 10.4.5.15): the element
    /// value the canonical numeric index `n` reads, or `undefined` when `n` is
    /// not a valid integer index (out of range / non-integral / detached).
    /// Meters one built-in step exactly as the plain `sample[i]` read does.
    pub(in crate::interp) fn ta_indexed_element_get(&mut self, ta: TypedArrayData, n: f64) -> Slot {
        match self.ta_valid_index(ta, n) {
            None => Slot::undefined(),
            Some(index) => {
                let v = if ta.kind <= 1 {
                    self.typed_array_element_get_bigint(ta, index)
                } else {
                    self.typed_array_element_get(ta, index)
                        .unwrap_or_else(Slot::undefined)
                };
                self.meter.tick_raw(TYPED_ARRAY_ELEMENT_METERING);
                v
            }
        }
    }

    /// `IntegerIndexedElementSet(O, index, value)` (ECMA-262 10.4.5.16): coerce
    /// `value` to the element type — `ToBigInt` for a BigInt view, `ToNumber`
    /// otherwise — which runs any `valueOf`/`toString`/`Symbol.toPrimitive`
    /// (observable side effects, and a possible throw) **before** the validity
    /// test, then store only when `n` is a valid integer index. A write to an
    /// invalid index is a coercion-only no-op (the coercion still runs). The
    /// spec's completion is always the unused `true`.
    pub(in crate::interp) fn ta_indexed_element_set(
        &mut self,
        code: &[u8],
        ta: TypedArrayData,
        n: f64,
        value: Slot,
    ) -> Result<(), Step> {
        if ta.kind <= 1 {
            // ToBigInt(value) — the low 64 bits are the two's-complement store.
            let u = self.to_bigint_low64(code, value)?;
            if let Some(index) = self.ta_valid_index(ta, n) {
                let base = ta.offset as usize + index as usize * 8;
                let buf = self.array_buffers[&ta.buffer];
                let out = self.chunks.slice_mut(buf.data, base + 8);
                out[base..base + 8].copy_from_slice(&u.to_le_bytes());
                self.meter.tick_raw(TYPED_ARRAY_ELEMENT_METERING);
            }
            return Ok(());
        }
        // ToNumber(value): objects run ToPrimitive(number); a BigInt or Symbol
        // is a (catchable) TypeError — a Number-typed element accepts neither.
        // Mirrors [`Self::typed_array_element_set`]'s coercion so the two
        // element-write paths agree on the error surface.
        let primitive = self.to_primitive(code, value, false)?;
        let num = match primitive.kind {
            Kind::Integer | Kind::Number => numeric_of(&primitive).unwrap_or(f64::NAN),
            Kind::String => match primitive.value {
                Payload::String(off) => string_to_number(self.str_text(off).as_bytes(), true),
                _ => unreachable!(),
            },
            Kind::Boolean | Kind::Null | Kind::Undefined => to_number(&primitive),
            Kind::BigInt | Kind::Symbol => {
                let target = match ta.kind {
                    4..=6 => "integer",
                    7..=9 => "unsigned",
                    _ => "number",
                };
                let symbol = if primitive.kind == Kind::Symbol {
                    " symbol"
                } else {
                    ""
                };
                return Err(
                    self.catchable_type_error_msg(format!("cannot coerce{symbol} to {target}"))
                );
            }
            _ => return Err(self.catchable_type_error()),
        };
        if let Some(index) = self.ta_valid_index(ta, n) {
            let size = TYPED_ARRAY_TYPES[ta.kind as usize].size as usize;
            let base = ta.offset as usize + index as usize * size;
            let le = encode_element_le(ta.kind, num)
                .ok_or(Step::Host(Halt::NotImplemented("typed-array-set:bigint")))?;
            let buf = self.array_buffers[&ta.buffer];
            let out = self.chunks.slice_mut(buf.data, base + size);
            out[base..base + size].copy_from_slice(&le);
            self.meter.tick_raw(TYPED_ARRAY_ELEMENT_METERING);
        }
        Ok(())
    }

    /// The integer-indexed exotic `[[GetOwnProperty]]` (ECMA-262 10.4.5.1):
    /// `Some(descriptor)` for the numeric index `n` when it is a valid integer
    /// index — a `{ value, writable: true, enumerable: true, configurable:
    /// true }` data descriptor holding the element — and `None` (undefined)
    /// for an invalid canonical numeric index. Only meaningful for a key that
    /// is a canonical numeric index.
    pub(in crate::interp) fn ta_index_own_descriptor(
        &mut self,
        ta: TypedArrayData,
        n: f64,
    ) -> Option<OrdinaryDescriptor> {
        let index = self.ta_valid_index(ta, n)?;
        let value = if ta.kind <= 1 {
            self.typed_array_element_get_bigint(ta, index)
        } else {
            self.typed_array_element_get(ta, index)
                .unwrap_or_else(Slot::undefined)
        };
        self.meter.tick_raw(TYPED_ARRAY_ELEMENT_METERING);
        Some(OrdinaryDescriptor {
            value: Some(value),
            writable: Some(true),
            enumerable: Some(true),
            configurable: Some(true),
            ..OrdinaryDescriptor::default()
        })
    }

    /// The integer-indexed exotic `[[DefineOwnProperty]]` (ECMA-262 10.4.5.3)
    /// for a canonical numeric index `n` and a (possibly partial) descriptor:
    /// `Ok(true)` when the define is accepted (a valid index whose descriptor
    /// is a data descriptor with no `configurable:false` / `enumerable:false`
    /// / `writable:false` clause, its `[[Value]]` — if present — coerced and
    /// stored), `Ok(false)` when rejected (an invalid index, an accessor
    /// descriptor, or a rejected attribute). The value coercion runs (and may
    /// throw) exactly as `[[Set]]`'s does.
    pub(in crate::interp) fn ta_index_define(
        &mut self,
        code: &[u8],
        ta: TypedArrayData,
        n: f64,
        desc: OrdinaryDescriptor,
    ) -> Result<bool, Step> {
        if self.ta_valid_index(ta, n).is_none() {
            return Ok(false);
        }
        if desc.configurable == Some(false)
            || desc.enumerable == Some(false)
            || desc.is_accessor()
            || desc.writable == Some(false)
        {
            return Ok(false);
        }
        if let Some(value) = desc.value {
            self.ta_indexed_element_set(code, ta, n, value)?;
        }
        Ok(true)
    }

    /// `Atomics.<op>(...)` for the single-agent runtime: read-modify-write uses
    /// ordinary byte operations on integer and BigInt-element views.
    /// Unsupported receivers, indices, and operand conversions return
    /// `Halt::NotImplemented`; wait/notify/waitAsync return `Halt::Refused`.
    /// `op`: 0 add, 1 and, 2 compareExchange, 3 exchange, 4 load, 5 or,
    /// 6 store, 7 sub, 8 xor, 9 isLockFree, >=10 wait/notify/waitAsync.
    pub(in crate::interp) fn atomics_dispatch(
        &mut self,
        op: u8,
        base: usize,
    ) -> Result<Slot, Step> {
        let a0 = self
            .stack
            .get(base + 4)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let a1 = self
            .stack
            .get(base + 5)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let a2 = self
            .stack
            .get(base + 6)
            .copied()
            .unwrap_or_else(Slot::undefined);
        let a3 = self
            .stack
            .get(base + 7)
            .copied()
            .unwrap_or_else(Slot::undefined);

        // `Atomics.isLockFree(size)`: a pure numeric query. XS
        // (`fx_Atomics_isLockFree`) reports lock-free only for the 4-byte
        // element (`(size == 4) ? 1 : 0`); match it exactly.
        if op == 9 {
            let lf = matches!(self.element_value_to_number(a0), Some(v) if v == 4.0);
            self.meter.tick_raw(ATOMICS_OP_METERING);
            return Ok(Slot::boolean(lf));
        }
        // `wait`/`notify`/`waitAsync` take the explicit host-refusal path.
        if op >= 10 {
            return Err(Step::Host(Halt::Refused("atomics:wait-notify")));
        }

        // ValidateIntegerTypedArray: an integer-element TypedArray receiver.
        let inst = match a0.value {
            Payload::Reference(r) if self.typed_arrays.contains_key(&r) => r,
            _ => return Err(Step::Host(Halt::NotImplemented("atomics:non-typedarray"))),
        };
        let ta = self.typed_arrays[&inst];
        // Int8/16/32 (4/5/6), Uint8/16/32 (7/8/9), and BigInt64/BigUint64
        // (0/1). Uint8Clamped (10) and float views (2/3) return NotImplemented.
        if !((4..=9).contains(&ta.kind) || ta.kind <= 1) {
            return Err(Step::Host(Halt::NotImplemented(
                "atomics:non-integer-typedarray",
            )));
        }
        // ValidateAtomicAccess: ToIndex(index) in `[0, length)`.
        let idx = match self.element_value_to_number(a1) {
            Some(v) if v >= 0.0 && v.fract() == 0.0 && (v as u64) < ta.length as u64 => v as u32,
            _ => return Err(Step::Host(Halt::NotImplemented("atomics:access-index"))),
        };
        let size = TYPED_ARRAY_TYPES[ta.kind as usize].size as usize;
        let data = self.array_buffers[&ta.buffer].data;
        let bpos = ta.offset as usize + idx as usize * size;

        // The BigInt64/BigUint64 element domain: the read-modify-write runs in
        // u64 (modulo 2^64, matching the 64-bit element), returning a BigInt.
        if ta.kind <= 1 {
            return self.atomics_dispatch_bigint(op, ta.kind, data, bpos, a2, a3);
        }

        // The current element (an integer view always decodes).
        let mut old_storage = [0u8; 8];
        let old_bytes = &mut old_storage[..size];
        {
            let bytes = self.chunks.payload(data);
            old_bytes.copy_from_slice(&bytes[bpos..bpos + size]);
        }
        let old_slot = decode_element_le(ta.kind, old_bytes)
            .ok_or(Step::Host(Halt::NotImplemented("atomics:decode")))?;

        // `load(ta, idx)`: no write.
        if op == 4 {
            self.meter.tick_raw(ATOMICS_OP_METERING);
            return Ok(old_slot);
        }

        // `compareExchange(ta, idx, expected, replacement)`: replace iff the
        // stored bytes equal `expected` coerced to the element type.
        if op == 2 {
            let expected = self
                .element_value_to_number(a2)
                .ok_or(Step::Host(Halt::NotImplemented("atomics:coerce")))?;
            let replacement = self
                .element_value_to_number(a3)
                .ok_or(Step::Host(Halt::NotImplemented("atomics:coerce")))?;
            let exp_bytes = encode_element_le(ta.kind, expected.trunc())
                .ok_or(Step::Host(Halt::NotImplemented("atomics:encode")))?;
            if exp_bytes == old_bytes {
                let le = encode_element_le(ta.kind, replacement.trunc())
                    .ok_or(Step::Host(Halt::NotImplemented("atomics:encode")))?;
                let out = self.chunks.slice_mut(data, bpos + size);
                out[bpos..bpos + size].copy_from_slice(&le);
            }
            self.meter.tick_raw(ATOMICS_OP_METERING);
            return Ok(old_slot);
        }

        // The single-operand ops. `store` returns the coerced value; every
        // other op returns the prior element value.
        let v = self
            .element_value_to_number(a2)
            .ok_or(Step::Host(Halt::NotImplemented("atomics:coerce")))?;
        let v_i = v.trunc() as i64;
        let old_i = element_slot_to_i64(old_slot);
        let (new_i, ret): (i64, Slot) = match op {
            0 => (old_i.wrapping_add(v_i), old_slot),
            1 => (old_i & v_i, old_slot),
            3 => (v_i, old_slot),
            5 => (old_i | v_i, old_slot),
            6 => (v_i, Slot::number(v.trunc())),
            7 => (old_i.wrapping_sub(v_i), old_slot),
            8 => (old_i ^ v_i, old_slot),
            _ => return Err(Step::Host(Halt::NotImplemented("atomics:op"))),
        };
        let le = encode_element_le(ta.kind, new_i as f64)
            .ok_or(Step::Host(Halt::NotImplemented("atomics:encode")))?;
        let out = self.chunks.slice_mut(data, bpos + size);
        out[bpos..bpos + size].copy_from_slice(&le);
        self.meter.tick_raw(ATOMICS_OP_METERING);
        Ok(ret)
    }

    /// The BigInt64/BigUint64 domain of [`Self::atomics_dispatch`]: the
    /// read-modify-write runs in u64 (two's complement, modulo 2^64 — the exact
    /// 64-bit element wrap), the operand is `ToBigInt(value)`'s low 64 bits, and
    /// the result is a freshly allocated BigInt (`store` returns the coerced
    /// value, every other op the prior element). Values that
    /// `slot_to_bigint_u64` cannot convert return `Halt::NotImplemented`.
    fn atomics_dispatch_bigint(
        &mut self,
        op: u8,
        kind: u8,
        data: crate::value::ChunkOffset,
        bpos: usize,
        a2: Slot,
        a3: Slot,
    ) -> Result<Slot, Step> {
        let mut old_b = [0u8; 8];
        {
            let bytes = self.chunks.payload(data);
            old_b.copy_from_slice(&bytes[bpos..bpos + 8]);
        }
        let old_u = u64::from_le_bytes(old_b);

        // `load`: no write.
        if op == 4 {
            self.meter.tick_raw(ATOMICS_OP_METERING);
            let (neg, mag) = u64_to_signed_limbs(kind == 0, old_u);
            return Ok(self.make_bigint(neg, mag));
        }

        // `compareExchange(ta, idx, expected, replacement)`.
        if op == 2 {
            let expected = self
                .slot_to_bigint_u64(a2)
                .ok_or(Step::Host(Halt::NotImplemented("atomics:coerce")))?;
            let replacement = self
                .slot_to_bigint_u64(a3)
                .ok_or(Step::Host(Halt::NotImplemented("atomics:coerce")))?;
            if old_u == expected {
                let out = self.chunks.slice_mut(data, bpos + 8);
                out[bpos..bpos + 8].copy_from_slice(&replacement.to_le_bytes());
            }
            self.meter.tick_raw(ATOMICS_OP_METERING);
            let (neg, mag) = u64_to_signed_limbs(kind == 0, old_u);
            return Ok(self.make_bigint(neg, mag));
        }

        let v = self
            .slot_to_bigint_u64(a2)
            .ok_or(Step::Host(Halt::NotImplemented("atomics:coerce")))?;
        let new_u: u64 = match op {
            0 => old_u.wrapping_add(v),
            1 => old_u & v,
            3 => v,
            5 => old_u | v,
            6 => v,
            7 => old_u.wrapping_sub(v),
            8 => old_u ^ v,
            _ => return Err(Step::Host(Halt::NotImplemented("atomics:op"))),
        };
        let out = self.chunks.slice_mut(data, bpos + 8);
        out[bpos..bpos + 8].copy_from_slice(&new_u.to_le_bytes());
        self.meter.tick_raw(ATOMICS_OP_METERING);

        // `store` returns the coerced value (the original BigInt, or `1n`/`0n`
        // for a Boolean); every other op returns the prior element.
        if op == 6 {
            return Ok(match a2.value {
                Payload::BigInt(_) => a2,
                Payload::Boolean(b) => self.make_bigint(false, vec![b as u32]),
                _ => a2,
            });
        }
        let (neg, mag) = u64_to_signed_limbs(kind == 0, old_u);
        Ok(self.make_bigint(neg, mag))
    }

    /// Coerce a primitive element write value to the `f64` the element
    /// encoders take (a number/integer identity, a boolean 0/1, `undefined`
    /// → NaN). An object value (needing `ToPrimitive`/`valueOf`) or a BigInt
    /// returns `None`. Atomic access and operand conversions map that to
    /// `Halt::NotImplemented`; `Atomics.isLockFree` returns false instead.
    fn element_value_to_number(&self, value: Slot) -> Option<f64> {
        match value.kind {
            Kind::Integer => match value.value {
                Payload::Integer(i) => Some(i as f64),
                _ => None,
            },
            Kind::Number => match value.value {
                Payload::Number(v) => Some(v),
                _ => None,
            },
            Kind::Boolean => match value.value {
                Payload::Boolean(bv) => Some(if bv { 1.0 } else { 0.0 }),
                _ => None,
            },
            Kind::Undefined => Some(f64::NAN),
            _ => None,
        }
    }

    /// Whether call argument `argi` (at `stack[base + 4 + argi]`) is truthy
    /// (XS's `fxToBoolean`) — the DataView `littleEndian` flag.
    pub(in crate::interp) fn arg_is_truthy(&self, base: usize, argi: usize) -> bool {
        let a = self
            .stack
            .get(base + 4 + argi)
            .copied()
            .unwrap_or_else(Slot::undefined);
        self.truthy(&a)
    }

    /// Read a DataView element of type `kind` at absolute byte offset `abs`
    /// in `buffer`'s backing store, honoring `little` endianness (XS's
    /// per-type getter with the `endian` argument). A big-endian read
    /// reverses the element bytes before the little-endian decode. BigInt
    /// reads use [`Self::data_view_read_bigint`]; this numeric decoder returns
    /// `Halt::NotImplemented` if passed a BigInt element kind.
    pub(in crate::interp) fn data_view_read(
        &self,
        buffer: crate::value::SlotIndex,
        abs: u32,
        kind: u8,
        little: bool,
    ) -> Result<Slot, Step> {
        let size = TYPED_ARRAY_TYPES[kind as usize].size as usize;
        let buf = self.array_buffers[&buffer];
        let bytes = self.chunks.payload(buf.data);
        let mut b = bytes[abs as usize..abs as usize + size].to_vec();
        if !little {
            b.reverse();
        }
        decode_element_le(kind, &b).ok_or(Step::Host(Halt::NotImplemented("data-view-get:bigint")))
    }

    /// Coerce `value` to the raw endianness-ordered bytes of a numeric
    /// DataView element of type `kind`, honoring `little` endianness. Runs
    /// `ToPrimitive`/`ToNumber` (which may execute a user `valueOf`/
    /// `Symbol.toPrimitive` that detaches the backing buffer), so `SetViewValue`
    /// performs this coercion BEFORE the `IsDetachedBuffer` and range tests —
    /// the caller keeps that order.
    pub(in crate::interp) fn data_view_encode(
        &mut self,
        code: &[u8],
        kind: u8,
        value: Slot,
        little: bool,
    ) -> Result<Vec<u8>, Step> {
        let mut le = self.typed_array_element_bytes(code, kind, value)?;
        if !little {
            le.reverse();
        }
        Ok(le)
    }

    /// Store already-coerced element `le` bytes at absolute byte offset `abs`.
    pub(in crate::interp) fn data_view_store(
        &mut self,
        buffer: crate::value::SlotIndex,
        abs: u32,
        le: &[u8],
    ) {
        let size = le.len();
        let buf = self.array_buffers[&buffer];
        let out = self.chunks.slice_mut(buf.data, abs as usize + size);
        out[abs as usize..abs as usize + size].copy_from_slice(le);
    }

    /// Read a `getBigInt64`/`getBigUint64` element (`kind` 0 signed, 1
    /// unsigned) at absolute byte offset `abs`, honoring `little` endianness,
    /// into a freshly allocated BigInt (XS's `fx_DataView_prototype_get`
    /// BigInt path → `fxNewBigInt` from the 64-bit value). A big-endian read
    /// reverses the eight element bytes before the little-endian decode.
    pub(in crate::interp) fn data_view_read_bigint(
        &mut self,
        buffer: crate::value::SlotIndex,
        abs: u32,
        kind: u8,
        little: bool,
    ) -> Slot {
        let buf = self.array_buffers[&buffer];
        let mut b = [0u8; 8];
        {
            let bytes = self.chunks.payload(buf.data);
            b.copy_from_slice(&bytes[abs as usize..abs as usize + 8]);
        }
        if !little {
            b.reverse();
        }
        let u = u64::from_le_bytes(b);
        let (neg, mag) = u64_to_signed_limbs(kind == 0, u);
        self.make_bigint(neg, mag)
    }

    /// Coerce `value` to a BigInt and return the endianness-ordered bytes of a
    /// `setBigInt64`/`setBigUint64` element (XS's `fx_DataView_prototype_set`
    /// BigInt path: `ToBigInt(value)` then the low 64 bits, two's complement).
    /// `ToBigInt` accepts a BigInt, a Boolean, or a numeric String; a Number or
    /// a Symbol is a `TypeError`. Run before the detached/range tests so a
    /// `Symbol.toPrimitive` that detaches is observed in `SetViewValue` order.
    pub(in crate::interp) fn data_view_encode_bigint(
        &mut self,
        code: &[u8],
        value: Slot,
        little: bool,
    ) -> Result<[u8; 8], Step> {
        let u = self.to_bigint_low64(code, value)?;
        let mut le = u.to_le_bytes();
        if !little {
            le.reverse();
        }
        Ok(le)
    }

    /// Allocate a fresh zero-filled `ArrayBuffer` of `byte_length` bytes
    /// (`fxNewArrayBufferInstance` + `fxNewChunk`), metering **only** the
    /// backing-store chunk (`fxNewChunk(byteLength)` at XS's 8-byte-aligned
    /// adjusted size). The caller meters the native construct frame. Returns
    /// the buffer instance slot. Shared by the `ArrayBuffer` constructor and
    /// a length-form TypedArray construct (whose inner `new ArrayBuffer` this
    /// mirrors).
    pub(in crate::interp) fn alloc_array_buffer(
        &mut self,
        byte_length: u32,
    ) -> Result<crate::value::SlotIndex, Step> {
        if !self.chunks.can_allocate(byte_length as usize) {
            return Err(Step::Host(Halt::HeapExhausted));
        }
        self.charge_and_check(((byte_length as u64 + 7) & !7) + 16)?;
        let mut bytes = Self::reserved_vec(byte_length as usize)?;
        bytes.resize(byte_length as usize, 0);
        let data = self.chunks.alloc(&bytes);
        let inst = self.slots.alloc(Slot::instance(self.arraybuffer_proto));
        self.array_buffers.insert(
            inst,
            ArrayBufferData {
                data,
                length: byte_length,
            },
        );
        Ok(inst)
    }
}
