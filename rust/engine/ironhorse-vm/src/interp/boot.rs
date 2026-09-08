//! Pristine, program-linked realm template. Never contains guest execution.
use super::*;

pub(crate) struct BootTemplate {
    inner: Interp,
    link_charge: u64,
}

impl BootTemplate {
    /// Carry compilation's live meter into a fresh realm. The caller charges
    /// linkage after releasing the template cache borrow, since a host callback
    /// may itself evaluate another compartment using that cache.
    pub(crate) fn instantiate_continuing_meter(
        &self,
        meter: Meter,
        host: Option<Box<dyn FnMut(u64) -> bool>>,
    ) -> (Interp, u64) {
        let mut interp = self.instantiate();
        interp.meter = meter;
        interp.meter_host = host;
        (interp, self.link_charge)
    }

    pub(crate) fn new(names: &[SymbolName]) -> Self {
        let mut inner = Interp::new();
        let before = inner.meter_index();
        inner.link_intrinsics(names);
        let link_charge = inner.meter_index() - before;
        // Only pristine construction reaches this type. These activation
        // types intentionally do not implement Clone; no guest frame or host
        // callback may enter the immutable template.
        assert!(inner.call_stack.is_empty());
        assert!(inner.gen_run_stack.is_empty());
        assert!(inner.async_run_stack.is_empty());
        assert!(inner.async_gen_run_stack.is_empty());
        assert!(inner.generators.is_empty());
        assert!(inner.async_instances.is_empty());
        assert!(inner.async_generators.is_empty());
        assert!(inner.meter_host.is_none());
        assert!(inner.source_compiler.is_none());
        Self { inner, link_charge }
    }

    pub(crate) fn instantiate_metered(
        &self,
        interval: u64,
        host: Box<dyn FnMut(u64) -> bool>,
    ) -> Interp {
        let mut interp = self.instantiate();
        interp.arm_meter(interval, host);
        // Match new -> arm -> link, including any linkage charges. Linking
        // does not dispatch guest code or consult the host callback.
        interp.meter.tick_raw(self.link_charge);
        interp
    }

    pub(crate) fn instantiate(&self) -> Interp {
        let state = &self.inner;
        let classes = state.classes.fork();
        // Copy BULK through its counted mutators: the new arenas own these
        // references independently, and no bare Clone can bypass accounting.
        let mut side_refs = SideRefCounts::new();
        let arrays = copy_arrays(&state.arrays, &mut side_refs);
        let index_props = copy_arrays(&state.index_props, &mut side_refs);
        let collections = state
            .collections
            .iter()
            .map(|(&owner, data)| {
                let mut copy = CollectionData::new(data.kind, data.table_length);
                for &(key, value) in data.live_entries() {
                    copy.push_entry(key, value, &mut side_refs);
                }
                (owner, copy)
            })
            .collect();
        // Exhaustive initializer: a new interpreter field forces a deliberate
        // template decision rather than silently inheriting a fresh default.
        Interp {
            classes: classes.clone(),
            snapshot_baseline_identity: std::rc::Rc::new(()),
            stack: state.stack.clone(),
            locals: state.locals.clone(),
            id_map: state.id_map.clone(),
            global_obj: state.global_obj,
            global_props: state.global_props.clone(),
            direct_eval_hoist: state.direct_eval_hoist,
            eval_program_hoist: state.eval_program_hoist,
            result: state.result,
            strict: state.strict,
            meter: state.meter.clone(),
            cost: state.cost.clone(),
            meter_host: None,
            step_limit: state.step_limit,
            slots: SlotArena::from_image(
                (0..state.slots.capacity())
                    .map(|i| state.slots.get(crate::value::SlotIndex(i)))
                    .collect(),
                state.slots.free_list().to_vec(),
                state.slots.live_count(),
            ),
            chunks: ChunkArena::from_image(state.chunks.raw_vec()),
            static_str: state.static_str,
            n_dispatched: state.n_dispatched,
            boot_slot_count: state.boot_slot_count,
            native_depth: state.native_depth,
            source_compiler: state.source_compiler.clone(),
            code_segments: state.code_segments.copy_to(classes.1.clone()),
            active_segment: state.active_segment,
            top_level_code: state.top_level_code.clone(),
            func_segments: state.func_segments.copy_to(classes.1.clone()),
            eval_direct: state.eval_direct,
            functions: state.functions.copy_to(classes.clone()),
            bound_functions: state.bound_functions.copy_to(classes.clone()),
            proxies: state.proxies.copy_to(classes.clone()),
            array_iterator_proxy_get_context: state.array_iterator_proxy_get_context,
            proxy_revokers: state.proxy_revokers.copy_to(classes.1.clone()),
            call_stack: Vec::new(),
            args: state.args.clone(),
            this_val: state.this_val,
            this_captures: state.this_captures.clone(),
            env: state.env,
            cur_func: state.cur_func,
            cur_target: state.cur_target,
            target_func: state.target_func,
            pending_new_target: state.pending_new_target,
            exception: state.exception,
            frame_slots: state.frame_slots,
            intrinsics: state.intrinsics.clone(),
            intl_object: state.intl_object,
            locale_proto: state.locale_proto,
            collator_proto: state.collator_proto,
            list_format_proto: state.list_format_proto,
            plural_rules_proto: state.plural_rules_proto,
            segmenter_proto: state.segmenter_proto,
            segments_proto: state.segments_proto,
            segment_iterator_proto: state.segment_iterator_proto,
            segments_iterator_method: state.segments_iterator_method,
            segment_iterator_identity: state.segment_iterator_identity,
            date_time_format_proto: state.date_time_format_proto,
            number_format_proto: state.number_format_proto,
            locales: state.locales.copy_to(classes.clone()),
            collators: state.collators.copy_to(classes.clone()),
            list_formats: state.list_formats.copy_to(classes.1.clone()),
            plural_rules: state.plural_rules.copy_to(classes.1.clone()),
            number_formats: state.number_formats.copy_to(classes.1.clone()),
            segmenters: state.segmenters.copy_to(classes.1.clone()),
            segments: state.segments.copy_to(classes.1.clone()),
            segment_iterators: state.segment_iterators.copy_to(classes.1.clone()),
            date_time_formats: state.date_time_formats.copy_to(classes.1.clone()),
            temporal_object: state.temporal_object,
            temporal_instant_proto: state.temporal_instant_proto,
            temporal_duration_proto: state.temporal_duration_proto,
            temporal_plain_protos: state.temporal_plain_protos,
            temporal_zoned_proto: state.temporal_zoned_proto,
            temporal_now_object: state.temporal_now_object,
            temporal_instants: state.temporal_instants.copy_to(classes.clone()),
            temporal_durations: state.temporal_durations.copy_to(classes.clone()),
            temporal_plains: state.temporal_plains.copy_to(classes.clone()),
            temporal_zoneds: state.temporal_zoneds.copy_to(classes.clone()),
            collator_compare_functions: state.collator_compare_functions.copy_to(classes.1.clone()),
            number_format_bound_functions: state
                .number_format_bound_functions
                .copy_to(classes.1.clone()),
            deleted_fn_meta: state.deleted_fn_meta.copy_to(classes.1.clone()),
            object_proto: state.object_proto,
            function_proto: state.function_proto,
            function_has_instance_method: state.function_has_instance_method,
            template_cache: state.template_cache,
            ctor_prototype: state.ctor_prototype.copy_to(classes.1.clone()),
            private_values: state.private_values.copy_to(classes.1.clone()),
            private_accessors: state.private_accessors.copy_to(classes.1.clone()),
            proto_methods: state.proto_methods.clone(),
            proto_data: state.proto_data.clone(),
            proto_accessors: state.proto_accessors.clone(),
            well_known_symbols: state.well_known_symbols.clone(),
            symbol_ids: state.symbol_ids.clone(),
            default_keys: state.default_keys.clone(),
            next_symbol_key_id: state.next_symbol_key_id,
            installed_names_len: state.installed_names_len,
            installing_intrinsics: state.installing_intrinsics,
            id_space_exhausted: state.id_space_exhausted,
            last_crank_completed: state.last_crank_completed,
            symbol_names: state.symbol_names.copy_to(classes.1.clone()),
            error_data: state.error_data.copy_to(classes.1.clone()),
            wrapper_data: state.wrapper_data.copy_to(classes.clone()),
            array_proto: state.array_proto,
            arrays: ClassMap::from_rows(arrays, ExoticKind::ARRAYS, classes.clone()),
            index_props: Tracked::new(
                index_props,
                classes.1.clone(),
                SnapshotSection::IndexProperties.mask(),
            ),
            arguments_objects: state.arguments_objects.copy_to(classes.1.clone()),
            disposable_stacks: state.disposable_stacks.copy_to(classes.clone()),
            collections: ClassMap::from_rows(collections, ExoticKind::COLLECTIONS, classes.clone()),
            side_refs,
            map_proto: state.map_proto,
            set_proto: state.set_proto,
            weakmap_proto: state.weakmap_proto,
            weakset_proto: state.weakset_proto,
            array_buffers: state.array_buffers.copy_to(classes.clone()),
            detached_buffers: state.detached_buffers.copy_to(classes.1.clone()),
            shared_buffers: state.shared_buffers.copy_to(classes.1.clone()),
            arraybuffer_proto: state.arraybuffer_proto,
            byte_length_id: state.byte_length_id,
            typed_arrays: state.typed_arrays.copy_to(classes.clone()),
            byte_offset_id: state.byte_offset_id,
            buffer_id: state.buffer_id,
            data_views: state.data_views.copy_to(classes.clone()),
            dataview_proto: state.dataview_proto,
            size_id: state.size_id,
            length_id: state.length_id,
            name_id: state.name_id,
            array_iterator_proto: state.array_iterator_proto,
            iterator_proto: state.iterator_proto,
            iterator_wrapper_proto: state.iterator_wrapper_proto,
            map_iterator_proto: state.map_iterator_proto,
            set_iterator_proto: state.set_iterator_proto,
            regexp_string_iterator_proto: state.regexp_string_iterator_proto,
            math_object: state.math_object,
            string_proto: state.string_proto,
            string_iterator_method: state.string_iterator_method,
            number_proto: state.number_proto,
            boolean_proto: state.boolean_proto,
            date_proto: state.date_proto,
            date_to_primitive_method: state.date_to_primitive_method,
            dates: state.dates.copy_to(classes.1.clone()),
            symbol_proto: state.symbol_proto,
            symbol_to_primitive_method: state.symbol_to_primitive_method,
            bigint_proto: state.bigint_proto,
            symbol_registry: state.symbol_registry.copy_to(classes.1.clone()),
            symbol_registry_keys: state.symbol_registry_keys.clone(),
            symbol_key_ids: state.symbol_key_ids.copy_to(classes.1.clone()),
            accessors: state.accessors.copy_to(classes.1.clone()),
            proto_value_data: state.proto_value_data.clone(),
            iterators: state.iterators.copy_to(classes.1.clone()),
            value_id: state.value_id,
            done_id: state.done_id,
            promises: state.promises.copy_to(classes.1.clone()),
            promise_proto: state.promise_proto,
            generators: Tracked::new(
                std::collections::HashMap::new(),
                classes.1.clone(),
                SnapshotSection::Generators.mask(),
            ),
            generator_proto: state.generator_proto,
            generator_function_proto: state.generator_function_proto,
            gen_run_stack: Vec::new(),
            async_instances: Tracked::new(
                std::collections::HashMap::new(),
                classes.1.clone(),
                SnapshotSection::Promises.mask() | SnapshotSection::AsyncInstances.mask(),
            ),
            async_function_proto: state.async_function_proto,
            async_run_stack: Vec::new(),
            async_generators: std::collections::HashMap::new(),
            async_generator_proto: state.async_generator_proto,
            async_generator_function_proto: state.async_generator_function_proto,
            async_iterator_identity: state.async_iterator_identity,
            iterator_identity: state.iterator_identity,
            async_gen_run_stack: Vec::new(),
            resume_status: state.resume_status,
            promise_functions: state.promise_functions.copy_to(classes.clone()),
            promise_guards: state.promise_guards.copy_to(classes.1.clone()),
            promise_jobs: state.promise_jobs.clone(),
            combinators: state.combinators.copy_to(classes.1.clone()),
            from_async: state.from_async.clone(),
            then_id: state.then_id,
            constructor_id: state.constructor_id,
            error_stack_accessor: state.error_stack_accessor,
            prototype_key_id: state.prototype_key_id,
            regexps: state.regexps.copy_to(classes.clone()),
            regexp_proto: state.regexp_proto,
            regexp_replace_method: state.regexp_replace_method,
            regexp_match_method: state.regexp_match_method,
            regexp_match_all_method: state.regexp_match_all_method,
            regexp_search_method: state.regexp_search_method,
            regexp_split_method: state.regexp_split_method,
            last_index_id: state.last_index_id,
            regexp_getter_ids: state.regexp_getter_ids,
            regexp_result_ids: state.regexp_result_ids,
            jumps: state.jumps.clone(),
        }
    }
}

fn copy_arrays(
    tables: &std::collections::HashMap<crate::value::SlotIndex, ArrayData>,
    refs: &mut SideRefCounts,
) -> std::collections::HashMap<crate::value::SlotIndex, ArrayData> {
    tables
        .iter()
        .map(|(&owner, data)| {
            let mut copy = ArrayData::default();
            copy.length = data.length;
            for (&index, &value) in data.items() {
                copy.insert_item(index, value, refs);
            }
            (owner, copy)
        })
        .collect()
}
