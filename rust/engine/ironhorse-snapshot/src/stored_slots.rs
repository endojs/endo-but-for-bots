//! Stored Slot visitation. Every image and slot-bearing row is destructured
//! exhaustively: adding a field requires an explicit visit/metadata decision.
//! Owners, handles, code bytes and scalar metadata are not Slot records.
use crate::image::{ArrayImage, CollectionImage, IndexPropsImage, MachineImage, WrapperImage};
use crate::store::SmallState;
use ironhorse_vm::{
    AccessorRow, AsyncRow, BoundFunctionRow, CombinatorRow, DisposableStackRow, DisposalRecordRow,
    FunctionStateSnapshot, GeneratorRow, PrivateAccessorRow, PrivateElementSnapshot,
    PrivateValueRow, PromiseClusterSnapshot, PromiseReactionRow, PromiseRow, SavedFrameRow,
    SavedJumpRow, Slot,
};

// A sealed, compile-time classification. There is deliberately no impl for
// Slot: metadata fields (including nested rows) cannot silently acquire one.
pub(crate) trait Metadata {}
pub(crate) fn metadata<T: Metadata + ?Sized>(_: &T) {}
macro_rules! leaves {
    ($($ty:ty),* $(,)?) => { $(impl Metadata for $ty {})* };
}
// SymbolName is the text crate's opaque WTF-8 string. SlotIndex is an arena
// handle, validated separately from full Slot records at the image boundary.
leaves!(
    bool,
    u8,
    u16,
    u32,
    u64,
    u128,
    usize,
    i8,
    i16,
    i32,
    i64,
    i128,
    f32,
    f64,
    String,
    &str,
    ironhorse_vm::SymbolName,
    ironhorse_vm::SlotIndex
);
impl<T: Metadata> Metadata for Vec<T> {}
impl<T: Metadata> Metadata for [T] {}
impl<T: Metadata> Metadata for Option<T> {}
impl<T: Metadata, const N: usize> Metadata for [T; N] {}
impl<K: Metadata, V: Metadata> Metadata for std::collections::BTreeMap<K, V> {}
macro_rules! tuple_metadata {
    ($($t:ident),+) => { impl<$($t: Metadata),+> Metadata for ($($t,)+) {} };
}
tuple_metadata!(A, B);
tuple_metadata!(A, B, C);
tuple_metadata!(A, B, C, D);
macro_rules! metadata_row {
    ($ty:path, [$($field:ident),* $(,)?]) => {
        impl Metadata for $ty {}
        // Type-check every field even though metadata needs no runtime walk.
        const _: fn(&$ty) = |value| {
            let $ty { $($field,)* } = value;
            $(metadata($field);)*
        };
    };
}
metadata_row!(crate::image::BufferImage, [owner, data, length, flags]);
metadata_row!(
    ironhorse_vm::interp::CollatorData,
    [
        locale,
        usage,
        sensitivity,
        collation,
        numeric,
        case_first,
        ignore_punctuation
    ]
);
metadata_row!(
    crate::image::CreationParams,
    [initial_slot_count, initial_chunk_bytes]
);
metadata_row!(crate::image::DataViewImage, [owner, buffer, offset, size]);
metadata_row!(crate::image::DateImage, [owner, value_bits]);
metadata_row!(
    ironhorse_vm::interp::DateTimeFormatData,
    [
        locale,
        calendar,
        numbering_system,
        time_zone,
        offset_minutes,
        hour_cycle,
        components,
        date_style,
        time_style
    ]
);
metadata_row!(crate::image::ErrorImage, [owner, name, message, frames]);
metadata_row!(
    ironhorse_vm::interp::FunctionRow,
    [
        owner,
        segment,
        body_start,
        body_len,
        closures,
        name,
        arity,
        name_chunk,
        is_generator,
        home,
        class_derived
    ]
);
metadata_row!(
    ironhorse_vm::interp::IntlBoundFunctionRow,
    [kind, function, owner, name, name_chunk, arity]
);
metadata_row!(
    ironhorse_vm::interp::IntlTables,
    [
        locales,
        collators,
        list_formats,
        plural_rules,
        number_formats,
        segmenters,
        segments,
        segment_iterators,
        date_time_formats
    ]
);
metadata_row!(
    ironhorse_vm::interp::IteratorRow,
    [owner, kind, iterable, index, done, result, enum_keys, str_bytes]
);
metadata_row!(ironhorse_vm::interp::ListFormatData, [locale, kind, style]);
metadata_row!(
    ironhorse_vm::interp::LocaleData,
    [tag, language, script, region, variants, unicode]
);
metadata_row!(
    crate::image::MeterImage,
    [
        cost_table_version,
        cost_table_digest,
        index,
        interval,
        count
    ]
);
metadata_row!(
    ironhorse_vm::interp::NumberFormatData,
    [
        locale,
        numbering_system,
        style,
        notation,
        compact_display,
        sign_display,
        use_grouping,
        currency,
        currency_display,
        currency_sign,
        unit,
        unit_display,
        minimum_integer_digits,
        minimum_fraction_digits,
        maximum_fraction_digits,
        minimum_significant_digits,
        maximum_significant_digits,
        rounding_type,
        rounding_priority,
        rounding_mode,
        rounding_increment,
        trailing_zero_display,
        bound_format
    ]
);
metadata_row!(
    ironhorse_vm::interp::PluralRulesData,
    [
        locale,
        kind,
        notation,
        minimum_integer_digits,
        minimum_fraction_digits,
        maximum_fraction_digits,
        minimum_significant_digits,
        maximum_significant_digits,
        rounding_type,
        rounding_priority,
        rounding_mode,
        rounding_increment,
        trailing_zero_display
    ]
);
metadata_row!(
    ironhorse_vm::interp::PromiseFnRow,
    [function, promise, reject, guard, name_chunk]
);
metadata_row!(
    ironhorse_vm::interp::ProxyRevokerRow,
    [owner, proxy, name_chunk]
);
metadata_row!(
    ironhorse_vm::interp::ProxyRow,
    [owner, target, handler, revoked]
);
metadata_row!(
    ironhorse_vm::interp::ProxyStateSnapshot,
    [proxies, revokers]
);
metadata_row!(
    crate::image::RegExpImage,
    [owner, source, flags, last_index_bits]
);
metadata_row!(crate::image::RegistryImage, [key, descriptor]);
metadata_row!(
    ironhorse_vm::interp::SegmentIteratorData,
    [segments_inst, pos]
);
metadata_row!(ironhorse_vm::interp::SegmenterData, [locale, granularity]);
metadata_row!(
    ironhorse_vm::interp::SegmentsData,
    [units, segments, granularity]
);
metadata_row!(crate::image::SymbolKeyImage, [next_id, pairs]);
metadata_row!(
    crate::image::TemporalImage,
    [instants, durations, plains, zoneds]
);
metadata_row!(
    crate::image::TypedArrayImage,
    [owner, kind, buffer, offset, length]
);
metadata_row!(crate::format::Version, [format_version, slot_width, endian]);

pub(crate) trait VisitSlots {
    fn visit(&self, f: &mut dyn FnMut(&Slot));
}
impl VisitSlots for Slot {
    fn visit(&self, f: &mut dyn FnMut(&Slot)) {
        f(self);
    }
}
impl<T: VisitSlots> VisitSlots for [T] {
    fn visit(&self, f: &mut dyn FnMut(&Slot)) {
        for value in self {
            value.visit(f);
        }
    }
}

/// Run a fallible slot check over the same enumeration used by key admission.
pub(crate) fn check_slots<E>(
    visit: impl FnOnce(&mut dyn FnMut(&Slot)),
    check: &impl Fn(&Slot) -> Result<(), E>,
) -> Result<(), E> {
    let mut result = Ok(());
    visit(&mut |slot| {
        if result.is_ok() {
            result = check(slot);
        }
    });
    result
}

impl<T: VisitSlots> VisitSlots for Vec<T> {
    fn visit(&self, f: &mut dyn FnMut(&Slot)) {
        for value in self {
            value.visit(f);
        }
    }
}
impl<T: VisitSlots> VisitSlots for Option<T> {
    fn visit(&self, f: &mut dyn FnMut(&Slot)) {
        if let Some(value) = self {
            value.visit(f);
        }
    }
}
impl VisitSlots for (u32, Slot) {
    fn visit(&self, f: &mut dyn FnMut(&Slot)) {
        self.1.visit(f);
    }
}
impl VisitSlots for (Slot, Slot) {
    fn visit(&self, f: &mut dyn FnMut(&Slot)) {
        self.0.visit(f);
        self.1.visit(f);
    }
}

macro_rules! row {
    ($ty:ident { slots: [$($slot:ident),* $(,)?], metadata: [$($meta:ident),* $(,)?] }) => {
        impl VisitSlots for $ty {
            fn visit(&self, f: &mut dyn FnMut(&Slot)) {
                let Self { $($slot,)* $($meta,)* } = self;
                $(metadata($meta);)*
                $($slot.visit(f);)*
            }
        }
    };
}
row!(ArrayImage {
    slots: [items],
    metadata: [owner, length]
});
row!(SmallState {
    slots: [
        stack,
        arrays,
        index_props,
        collections,
        wrappers,
        function_state,
        accessors,
        private_elements,
        disposable_stacks,
        generators,
        promise_cluster
    ],
    metadata: [
        slot_free,
        keys,
        names,
        symbols,
        meter,
        registry,
        errors,
        buffers,
        typed_arrays,
        data_views,
        regexps,
        dates,
        proxy_state,
        intl_bound_functions,
        arguments_brands,
        temporal,
        intl,
        name_floor,
        iterators
    ]
});
row!(IndexPropsImage {
    slots: [items],
    metadata: [owner, high_water]
});
row!(CollectionImage {
    slots: [entries],
    metadata: [owner, kind, table_length]
});
row!(WrapperImage {
    slots: [value],
    metadata: [owner]
});
row!(FunctionStateSnapshot {
    slots: [bound_functions],
    metadata: [segments, functions, ctor_prototypes, deleted_meta]
});
row!(BoundFunctionRow {
    slots: [this_arg, args],
    metadata: [owner, target]
});
row!(AccessorRow {
    slots: [get, set],
    metadata: [owner, id]
});
row!(PrivateElementSnapshot {
    slots: [values, accessors],
    metadata: []
});
row!(PrivateValueRow {
    slots: [value],
    metadata: [receiver, brand]
});
row!(PrivateAccessorRow {
    slots: [get, set],
    metadata: [receiver, brand]
});
row!(DisposableStackRow {
    slots: [records],
    metadata: [owner, disposed, asynchronous]
});
row!(DisposalRecordRow {
    slots: [resource, method],
    metadata: [pass_resource]
});
row!(GeneratorRow {
    slots: [frame],
    metadata: [state, owner]
});
row!(SavedFrameRow {
    slots: [locals, args, this_val, env, result, stack_slice, jumps],
    metadata: [id_map, cur_func, cur_target, target_func, strict, resume_pc]
});
row!(SavedJumpRow {
    slots: [env],
    metadata: [
        target_pc,
        stack_offset,
        locals_len,
        id_map,
        call_depth_offset,
        flag
    ]
});
row!(PromiseClusterSnapshot {
    slots: [async_instances, promises, combinators],
    metadata: [functions, guards]
});
row!(PromiseRow {
    slots: [result, reactions],
    metadata: [owner, state, ever_handled]
});
row!(PromiseReactionRow {
    slots: [on_fulfilled, on_rejected, resolve, reject],
    metadata: [kind, a, b]
});
row!(CombinatorRow {
    slots: [resolve, reject],
    metadata: [kind, remaining, results]
});
row!(AsyncRow {
    slots: [frame, resolve, reject],
    metadata: [owner, result_promise]
});

pub(crate) fn visit_image_slots(image: &MachineImage, f: &mut dyn FnMut(&Slot)) {
    let MachineImage {
        slots,
        slot_free,
        stack,
        arrays,
        index_props,
        collections,
        wrappers,
        function_state,
        accessors,
        private_elements,
        disposable_stacks,
        generators,
        promise_cluster,
        // These fields contain no Slot records. Their owner/handle/geometry
        // validation remains at the snapshot boundary.
        version,
        signature,
        creation,
        chunks,
        slot_live,
        keys,
        names,
        symbols,
        meter,
        registry,
        errors,
        buffers,
        typed_arrays,
        data_views,
        regexps,
        dates,
        proxy_state,
        intl_bound_functions,
        arguments_brands,
        temporal,
        intl,
        iterators,
        name_floor,
    } = image;
    metadata(version);
    metadata(signature);
    metadata(creation);
    metadata(chunks);
    metadata(slot_live);
    metadata(keys);
    metadata(names);
    metadata(symbols);
    metadata(meter);
    metadata(registry);
    metadata(errors);
    metadata(buffers);
    metadata(typed_arrays);
    metadata(data_views);
    metadata(regexps);
    metadata(dates);
    metadata(proxy_state);
    metadata(intl_bound_functions);
    metadata(arguments_brands);
    metadata(temporal);
    metadata(intl);
    metadata(iterators);
    metadata(name_floor);

    let free: std::collections::BTreeSet<_> = slot_free.iter().copied().collect();
    for (index, slot) in slots.iter().enumerate() {
        if !free.contains(&(index as u32)) {
            slot.visit(f);
        }
    }
    stack.visit(f);
    arrays.visit(f);
    index_props.visit(f);
    collections.visit(f);
    wrappers.visit(f);
    function_state.visit(f);
    accessors.visit(f);
    private_elements.visit(f);
    disposable_stacks.visit(f);
    generators.visit(f);
    promise_cluster.visit(f);
}

impl VisitSlots for crate::image::BoundsTables<'_> {
    fn visit(&self, f: &mut dyn FnMut(&Slot)) {
        let Self {
            arrays,
            index_props,
            collections,
            registry,
            errors,
            buffers,
            typed_arrays,
            data_views,
            iterators,
            wrappers,
            regexps,
            dates,
            function_state,
            proxy_state,
            accessors,
            intl_bound_functions,
            private_elements,
            disposable_stacks,
            generators,
            promise_cluster,
            arguments_brands,
            temporal,
            intl,
        } = self;
        metadata(*registry);
        metadata(*errors);
        metadata(*buffers);
        metadata(*typed_arrays);
        metadata(*data_views);
        metadata(*iterators);
        metadata(*regexps);
        metadata(*dates);
        metadata(*proxy_state);
        metadata(*intl_bound_functions);
        metadata(*arguments_brands);
        metadata(*temporal);
        metadata(*intl);
        arrays.visit(f);
        index_props.visit(f);
        collections.visit(f);
        wrappers.visit(f);
        function_state.visit(f);
        accessors.visit(f);
        private_elements.visit(f);
        disposable_stacks.visit(f);
        generators.visit(f);
        promise_cluster.visit(f);
    }
}
