//! Stored Slot visitation. Every image and slot-bearing row is destructured
//! exhaustively: adding a field requires an explicit visit/metadata decision.
//! Owners, handles, code bytes and scalar metadata are not Slot records.
use crate::image::{ArrayImage, CollectionImage, IndexPropsImage, MachineImage, WrapperImage};
use crate::store::SmallState;
use ironhorse_vm::snapshot_api::{
    AccessorRow, AsyncRow, BoundFunctionRow, CombinatorRow, DisposableStackRow, DisposalRecordRow,
    FunctionStateSnapshot, GeneratorRow, PrivateAccessorRow, PrivateElementSnapshot,
    PrivateValueRow, PromiseClusterSnapshot, PromiseReactionRow, PromiseRow, SavedFrameRow,
    SavedJumpRow,
};
use ironhorse_vm::Slot;

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
    ironhorse_vm::snapshot_api::CollatorData,
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
    ironhorse_vm::snapshot_api::DateTimeFormatData,
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
    ironhorse_vm::snapshot_api::FunctionRow,
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
    ironhorse_vm::snapshot_api::IntlBoundFunctionRow,
    [kind, function, owner, name, name_chunk, arity]
);
metadata_row!(
    ironhorse_vm::snapshot_api::IntlTables,
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
    ironhorse_vm::snapshot_api::IteratorRow,
    [owner, kind, iterable, index, done, result, enum_keys, str_bytes]
);
metadata_row!(
    ironhorse_vm::snapshot_api::ListFormatData,
    [locale, kind, style]
);
metadata_row!(
    ironhorse_vm::snapshot_api::LocaleData,
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
    ironhorse_vm::snapshot_api::NumberFormatData,
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
    ironhorse_vm::snapshot_api::PluralRulesData,
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
    ironhorse_vm::snapshot_api::PromiseFnRow,
    [function, promise, reject, guard, name_chunk]
);
metadata_row!(
    ironhorse_vm::snapshot_api::ProxyRevokerRow,
    [owner, proxy, name_chunk]
);
metadata_row!(
    ironhorse_vm::snapshot_api::ProxyRow,
    [owner, target, handler, revoked]
);
metadata_row!(
    ironhorse_vm::snapshot_api::ProxyStateSnapshot,
    [proxies, revokers]
);
metadata_row!(
    crate::image::RegExpImage,
    [owner, source, flags, last_index_bits]
);
metadata_row!(crate::image::RegistryImage, [key, descriptor]);
metadata_row!(
    ironhorse_vm::snapshot_api::SegmentIteratorData,
    [segments_inst, pos]
);
metadata_row!(
    ironhorse_vm::snapshot_api::SegmenterData,
    [locale, granularity]
);
metadata_row!(
    ironhorse_vm::snapshot_api::SegmentsData,
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
    metadata: [
        native_names,
        segments,
        functions,
        ctor_prototypes,
        deleted_meta
    ]
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
        segment,
        stack_offset,
        locals_len,
        id_map,
        call_depth_offset,
        flag
    ]
});
row!(PromiseClusterSnapshot {
    slots: [async_instances, promises, combinators],
    metadata: [functions, guards, unhandled_rejection]
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

// Top-level field inventories come from the payload roster. Nested row
// classifications above remain independent, exhaustive compiler checks.
macro_rules! visit_payload {
    (slots, $value:expr, $f:ident) => {
        $value.visit($f);
    };
    (metadata, $value:expr, $f:ident) => {
        metadata($value);
    };
}

// Extension atoms do not own another copy of their primary field. Validate
// even rows that emit no visit, so a misspelled or misplaced policy is an error.
macro_rules! validate_visit_policy {
    (shared, [], []) => {};
    (slots, [$primary:ident], [$($bounds:ident)?]) => {};
    (metadata, [$primary:ident], [$($bounds:ident)?]) => {};
}

macro_rules! define_payload_visitors {
    ($($section:ident {
        image_field: $field:ident,
        builder: $builder:ident,
        live: [$($live:tt)*],
        bounds: [$($bounds_field:ident: $bounds_ty:ty = $bounds_empty:expr)?],
        gate: [$($gate:tt)*],
        restore: [$($restore:tt)*],
        initialize: [$($next:ident; $(#[$attr:meta])* $init_field:ident: $ty:ty = $init:expr)?],
        legacy_label: $label:literal,
        decode_legacy($decoded:ident, $input:ident): $decode:block,
        decode_container: [$($container:tt)*],
        atom: $atom:expr,
        present($image:ident): $present:expr,
        encode($state:ident): $encode:block,
        canonicalize($bytes:ident): $canonicalize:block,
        slot_visit: $visit:ident,
    })*) => {
        $(validate_visit_policy!($visit, [$($init_field)?], [$($bounds_field)?]);)*
        impl VisitSlots for SmallState {
            fn visit(&self, f: &mut dyn FnMut(&Slot)) {
                let Self { $($($init_field,)?) * } = self;
                $($(visit_payload!($visit, $init_field, f);)?) *
            }
        }

        pub(crate) fn visit_image_slots(image: &MachineImage, f: &mut dyn FnMut(&Slot)) {
            let MachineImage {
                slots, version, signature, creation, chunks, slot_live,
                $($($init_field,)?) *
            } = image;
            metadata(version);
            metadata(signature);
            metadata(creation);
            metadata(chunks);
            metadata(slot_live);
            // The arena is outside the small-state payload roster. Its free
            // records are opaque bytes and must not become admission witnesses.
            let free: std::collections::BTreeSet<_> = image.slot_free.iter().copied().collect();
            for (index, slot) in slots.iter().enumerate() {
                if !free.contains(&(index as u32)) {
                    slot.visit(f);
                }
            }
            $($(visit_payload!($visit, $init_field, f);)?) *
        }

        impl VisitSlots for crate::image::BoundsTables<'_> {
            fn visit(&self, f: &mut dyn FnMut(&Slot)) {
                let Self { $($($bounds_field,)?) * } = self;
                $($(visit_payload!($visit, *$bounds_field, f);)?) *
            }
        }
    };
}
crate::snapshot_roster::snapshot_payloads!(define_payload_visitors);

#[cfg(test)]
mod tests {
    use super::*;

    fn marker(id: u16) -> Slot {
        let mut slot = Slot::integer(i32::from(id));
        slot.id = id;
        slot
    }

    #[test]
    fn generated_roots_preserve_witness_order_and_skip_free_heap_records() {
        use crate::image::SymbolKeyImage;
        use crate::Signature;
        use ironhorse_vm::{ChunkArena, SlotArena};

        let mut image = MachineImage::from_arenas(
            Signature::new("root-visitor-order"),
            &SlotArena::new(),
            &ChunkArena::new(),
            &[],
            vec![],
            vec![],
            SymbolKeyImage::default(),
        );
        image.stack.push(marker(1));
        image.arrays.push(ArrayImage {
            owner: 0,
            length: 1,
            items: vec![(0, marker(2))],
        });
        image.index_props.push(IndexPropsImage {
            owner: 0,
            high_water: 1,
            items: vec![(0, marker(3))],
        });
        image.collections.push(CollectionImage {
            owner: 0,
            kind: 0,
            table_length: 4,
            entries: vec![(marker(4), Slot::undefined())],
        });
        image.wrappers.push(WrapperImage {
            owner: 0,
            value: marker(5),
        });
        image.function_state.bound_functions.push(BoundFunctionRow {
            owner: Default::default(),
            target: Default::default(),
            this_arg: marker(6),
            args: vec![],
        });
        image.accessors.push(AccessorRow {
            owner: Default::default(),
            id: 0,
            get: Some(marker(7)),
            set: None,
        });
        image.private_elements.values.push(PrivateValueRow {
            receiver: Default::default(),
            brand: Default::default(),
            value: marker(8),
        });
        image.disposable_stacks.push(DisposableStackRow {
            owner: Default::default(),
            disposed: false,
            asynchronous: false,
            records: vec![DisposalRecordRow {
                resource: marker(9),
                method: Slot::undefined(),
                pass_resource: false,
            }],
        });
        image.generators.push(GeneratorRow {
            state: 0,
            owner: Default::default(),
            frame: Some(SavedFrameRow {
                locals: vec![marker(10)],
                id_map: vec![],
                args: vec![],
                this_val: Slot::undefined(),
                env: Slot::undefined(),
                cur_func: Default::default(),
                cur_target: Default::default(),
                target_func: Default::default(),
                strict: false,
                result: Slot::undefined(),
                stack_slice: vec![],
                jumps: vec![],
                resume_pc: 0,
            }),
        });
        image.promise_cluster.promises.push(PromiseRow {
            owner: Default::default(),
            state: 0,
            result: marker(11),
            ever_handled: false,
            reactions: vec![],
        });
        image.slots = vec![marker(12), marker(13)];
        image.slot_live = 1;
        image.slot_free = vec![1];

        // The historical witness order is heap, stack, then the ten table
        // families above. Markers distinguish it from atom-independent order
        // changes, repeated shared payloads, or a dropped root family.
        let mut visited = Vec::new();
        visit_image_slots(&image, &mut |slot| {
            if slot.id != 0 {
                visited.push(slot.id);
            }
        });
        assert_eq!(visited, [vec![12], (1..=11).collect()].concat());
        visited.clear();
        let small = crate::snapshot_roster::small_from_image(&image);
        small.visit(&mut |slot| {
            if slot.id != 0 {
                visited.push(slot.id);
            }
        });
        assert_eq!(visited, (1..=11).collect::<Vec<_>>());
        visited.clear();
        small.bounds_tables().visit(&mut |slot| {
            if slot.id != 0 {
                visited.push(slot.id);
            }
        });
        assert_eq!(visited, (2..=11).collect::<Vec<_>>());
    }
}
