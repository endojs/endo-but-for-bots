//! Machine initialization and intrinsic construction.
use super::*;

// Constructor policies belong to the same declaration as GC and persistence
// policies. The initializer follows declaration order and retains its
// call and allocation boundaries.
macro_rules! define_boot_initializers {
    (($d:tt) $vis:vis struct $name:ident {
        $(#[boot_new($new:expr)]
          #[gc_root($root:ident)]
          #[quiescent($boundary:ident)]
          #[persist_refs($persist:ident)]
          #[runtime_keys($runtime_keys:ident)]
          #[gc_hook($phase:ident, $policy:ident)]
          #[gc_chunk($chunk:ident)]
          #[gc_slots($shape:ident, $row:ident)]
          #[gc_weak($weak:ident)]
          #[snapshot_table($($snapshot:tt)*)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } boot_context {
        fresh($new_dirt:ident, $slots:ident, $chunks:ident, $global:ident, $static:ident);
    } external_tables { $($external:tt)* }) => {
        macro_rules! boot_fresh {
            ($d snapshot_dirt:expr, $d slots:expr, $d chunks:expr, $d global:expr, $d strings:expr) => {{
                let $new_dirt = $d snapshot_dirt;
                let $slots = $d slots;
                let $chunks = $d chunks;
                let $global = $d global;
                let $static = $d strings;
                Interp { $($field: $new,)* }
            }};
        }
    };
}
interp_state!(define_boot_initializers, $);

mod tests;

impl Interp {
    pub fn new() -> Interp {
        let mut slots = SlotArena::new();
        // The global object is a real arena instance with a null
        // prototype (the intrinsic %Object.prototype% wiring lands with
        // the intrinsics seam); its allocation predates metering, so it
        // is not metered.
        let global_obj = slots.alloc(Slot::instance(crate::value::SlotIndex::NULL));
        // Intern the `typeof` result strings (XS's `mxUndefinedString`
        // &co. — preexisting `XS_STRING_X_KIND` slots), allocated into the
        // chunk arena *before* any run so `typeof` costs only its dispatch,
        // exactly as XS (no per-use allocation for an interned string).
        let mut chunks = ChunkArena::new();
        // Interned `typeof` result strings, stored in the UTF-16BE form all
        // string values use (`str_to_be16`).
        // These eight chunks form an always-live arena prefix. Order-preserving
        // compaction cannot relocate them, so restore may rederive their offsets.
        let static_str = StaticStrings {
            undefined: chunks.alloc(&str_to_be16("undefined")),
            object: chunks.alloc(&str_to_be16("object")),
            boolean: chunks.alloc(&str_to_be16("boolean")),
            number: chunks.alloc(&str_to_be16("number")),
            string: chunks.alloc(&str_to_be16("string")),
            function: chunks.alloc(&str_to_be16("function")),
            symbol: chunks.alloc(&str_to_be16("symbol")),
            bigint: chunks.alloc(&str_to_be16("bigint")),
        };
        let snapshot_dirt = SnapshotDirt::default();
        let mut interp = boot_fresh!(snapshot_dirt, slots, chunks, global_obj, static_str);
        interp.create_intrinsics();
        interp.boot_slot_count = interp.slots.capacity();
        interp
    }

    /// Fingerprint of this engine's boot layout, independently of host
    /// configuration. Computed once from a fresh boot, before guest mutation.
    pub fn boot_fingerprint() -> [u8; 32] {
        static FINGERPRINT: std::sync::OnceLock<[u8; 32]> = std::sync::OnceLock::new();
        *FINGERPRINT.get_or_init(|| Self::new().derive_boot_fingerprint())
    }

    pub(super) fn derive_boot_fingerprint(&self) -> [u8; 32] {
        use crate::sha256::Sha256;
        let mut hash = Sha256::new();
        hash.update(b"ironhorse-boot-layout-v1");
        // Length-delimit every term so a boundary cannot be shifted into
        // the next field. No pointers or randomized map iteration travel.
        let mut term = |bytes: &[u8]| {
            hash.update(&(bytes.len() as u64).to_be_bytes());
            hash.update(bytes);
        };
        // Preserve platform-profile compatibility; a deterministic provider
        // is a distinct execution release even when its boot slots are equal.
        if cfg!(feature = "deterministic-math") {
            term(crate::MATH_PROVIDER.as_bytes());
        }
        term(&self.boot_slot_count.to_be_bytes());
        for slot in self
            .slots
            .records()
            .iter()
            .take(self.boot_slot_count as usize)
        {
            term(format!("{slot:?}").as_bytes());
        }
        term(&self.chunks.raw_vec());
        let mut functions: Vec<_> = self.functions.iter().collect();
        functions.sort_by_key(|(index, _)| index.0);
        for (index, info) in functions {
            term(&index.0.to_be_bytes());
            // Derived Debug includes native/method variant names and their
            // payloads, name/name_chunk, arity, and every FuncInfo field.
            // A variant rename may conservatively refuse compatibility;
            // reordering variants cannot silently remap stored natives.
            term(format!("{info:?}").as_bytes());
        }
        let mut intrinsics: Vec<_> = self.intrinsics.iter().collect();
        intrinsics.sort_by_key(|(name, _)| **name);
        for (name, index) in intrinsics {
            term(name.as_bytes());
            term(&index.0.to_be_bytes());
        }
        term(format!("{:?}", self.proto_methods).as_bytes());
        term(format!("{:?}", self.proto_data).as_bytes());
        term(format!("{:?}", self.proto_accessors).as_bytes());
        term(format!("{:?}", self.proto_value_data).as_bytes());
        let mut default_keys: Vec<_> = self.default_keys.iter().copied().collect();
        default_keys.sort_unstable();
        term(format!("default_keys={default_keys:?}").as_bytes());
        term(format!("global_obj={:?}", self.realm.global_obj).as_bytes());
        term(format!("intl_object={:?}", self.intl_object).as_bytes());
        term(format!("temporal_object={:?}", self.temporal_object).as_bytes());
        term(format!("temporal_now_object={:?}", self.temporal_now_object).as_bytes());
        term(format!("math_object={:?}", self.math_object).as_bytes());
        term(format!("static_str={:?}", self.static_str).as_bytes());
        term(format!("well_known_symbols={:?}", self.well_known_symbols).as_bytes());
        term(format!("string_iterator_method={:?}", self.string_iterator_method).as_bytes());
        term(format!("async_iterator_identity={:?}", self.async_iterator_identity).as_bytes());
        term(
            format!(
                "function_has_instance_method={:?}",
                self.function_has_instance_method
            )
            .as_bytes(),
        );
        term(
            format!(
                "symbol_to_primitive_method={:?}",
                self.symbol_to_primitive_method
            )
            .as_bytes(),
        );
        term(
            format!(
                "date_to_primitive_method={:?}",
                self.date_to_primitive_method
            )
            .as_bytes(),
        );
        term(format!("iterator_identity={:?}", self.iterator_identity).as_bytes());
        term(
            format!(
                "segments_iterator_method={:?}",
                self.segments_iterator_method
            )
            .as_bytes(),
        );
        term(
            format!(
                "segment_iterator_identity={:?}",
                self.segment_iterator_identity
            )
            .as_bytes(),
        );
        term(format!("error_stack_accessor={:?}", self.error_stack_accessor).as_bytes());
        term(format!("template_cache={:?}", self.template_cache).as_bytes());
        term(format!("object_proto={:?}", self.object_proto).as_bytes());
        term(format!("function_proto={:?}", self.function_proto).as_bytes());
        term(format!("array_proto={:?}", self.array_proto).as_bytes());
        term(format!("map_proto={:?}", self.map_proto).as_bytes());
        term(format!("set_proto={:?}", self.set_proto).as_bytes());
        term(format!("weakmap_proto={:?}", self.weakmap_proto).as_bytes());
        term(format!("weakset_proto={:?}", self.weakset_proto).as_bytes());
        term(format!("arraybuffer_proto={:?}", self.arraybuffer_proto).as_bytes());
        term(format!("dataview_proto={:?}", self.dataview_proto).as_bytes());
        term(format!("array_iterator_proto={:?}", self.array_iterator_proto).as_bytes());
        term(format!("string_proto={:?}", self.string_proto).as_bytes());
        term(format!("number_proto={:?}", self.number_proto).as_bytes());
        term(format!("boolean_proto={:?}", self.boolean_proto).as_bytes());
        term(format!("symbol_proto={:?}", self.symbol_proto).as_bytes());
        term(format!("bigint_proto={:?}", self.bigint_proto).as_bytes());
        term(format!("promise_proto={:?}", self.promise_proto).as_bytes());
        term(format!("generator_proto={:?}", self.generator_proto).as_bytes());
        term(
            format!(
                "generator_function_proto={:?}",
                self.generator_function_proto
            )
            .as_bytes(),
        );
        term(format!("async_function_proto={:?}", self.async_function_proto).as_bytes());
        term(format!("async_generator_proto={:?}", self.async_generator_proto).as_bytes());
        term(
            format!(
                "async_generator_function_proto={:?}",
                self.async_generator_function_proto
            )
            .as_bytes(),
        );
        term(format!("regexp_proto={:?}", self.regexp_proto).as_bytes());
        term(format!("regexp_replace_method={:?}", self.regexp_replace_method).as_bytes());
        term(format!("regexp_match_method={:?}", self.regexp_match_method).as_bytes());
        term(format!("regexp_match_all_method={:?}", self.regexp_match_all_method).as_bytes());
        term(format!("regexp_search_method={:?}", self.regexp_search_method).as_bytes());
        term(format!("regexp_split_method={:?}", self.regexp_split_method).as_bytes());
        term(format!("iterator_proto={:?}", self.iterator_proto).as_bytes());
        term(format!("iterator_wrapper_proto={:?}", self.iterator_wrapper_proto).as_bytes());
        term(format!("map_iterator_proto={:?}", self.map_iterator_proto).as_bytes());
        term(format!("set_iterator_proto={:?}", self.set_iterator_proto).as_bytes());
        term(
            format!(
                "regexp_string_iterator_proto={:?}",
                self.regexp_string_iterator_proto
            )
            .as_bytes(),
        );
        term(format!("date_proto={:?}", self.date_proto).as_bytes());
        term(format!("locale_proto={:?}", self.locale_proto).as_bytes());
        term(format!("collator_proto={:?}", self.collator_proto).as_bytes());
        term(format!("list_format_proto={:?}", self.list_format_proto).as_bytes());
        term(format!("plural_rules_proto={:?}", self.plural_rules_proto).as_bytes());
        term(format!("segmenter_proto={:?}", self.segmenter_proto).as_bytes());
        term(format!("segments_proto={:?}", self.segments_proto).as_bytes());
        term(format!("segment_iterator_proto={:?}", self.segment_iterator_proto).as_bytes());
        term(format!("date_time_format_proto={:?}", self.date_time_format_proto).as_bytes());
        term(format!("number_format_proto={:?}", self.number_format_proto).as_bytes());
        term(format!("temporal_instant_proto={:?}", self.temporal_instant_proto).as_bytes());
        term(format!("temporal_duration_proto={:?}", self.temporal_duration_proto).as_bytes());
        term(format!("temporal_plain_protos={:?}", self.temporal_plain_protos).as_bytes());
        term(format!("temporal_zoned_proto={:?}", self.temporal_zoned_proto).as_bytes());
        term(format!("byte_length_id={:?}", self.byte_length_id).as_bytes());
        term(format!("byte_offset_id={:?}", self.byte_offset_id).as_bytes());
        term(format!("buffer_id={:?}", self.buffer_id).as_bytes());
        term(format!("size_id={:?}", self.size_id).as_bytes());
        term(format!("length_id={:?}", self.length_id).as_bytes());
        term(format!("name_id={:?}", self.name_id).as_bytes());
        term(format!("value_id={:?}", self.value_id).as_bytes());
        term(format!("done_id={:?}", self.done_id).as_bytes());
        term(format!("then_id={:?}", self.then_id).as_bytes());
        term(format!("constructor_id={:?}", self.constructor_id).as_bytes());
        term(format!("last_index_id={:?}", self.last_index_id).as_bytes());
        term(format!("prototype_key_id={:?}", self.prototype_key_id).as_bytes());
        term(format!("regexp_getter_ids={:?}", self.regexp_getter_ids).as_bytes());
        term(format!("regexp_result_ids={:?}", self.regexp_result_ids).as_bytes());
        hash.finalize()
    }

    /// Materialize the intrinsic (native) constructor instances once, at
    /// machine boot, before any guest bytecode runs — so, like XS's
    /// intrinsic construction, they carry **no** run-only metering. Each is
    /// a real arena instance registered in [`Self::functions`] with its
    /// [`Native`] marker (so `typeof` reads "function" and `run`/`new`
    /// dispatch to the native handler), and remembered by name in
    /// [`Self::intrinsics`] for per-program linking.
    fn create_intrinsics(&mut self) {
        // The prototype roots: %Object.prototype% (null proto) and
        // %Function.prototype% (chains to it). Every native constructor is a
        // callable whose own prototype is %Function.prototype%.
        let object_proto = self
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));
        self.object_proto = object_proto;
        self.template_cache = self.slots.alloc(Slot::instance(object_proto));
        let func_proto = self.slots.alloc(Slot::instance(object_proto));
        self.function_proto = func_proto;
        let function_proto_name = self.alloc_str_text("");
        self.functions.insert(
            func_proto,
            FuncInfo {
                method: Some(NativeMethod::FunctionPrototype),
                name_chunk: function_proto_name,
                ..FuncInfo::default()
            },
        );
        // Each Error type's `.prototype`: the base `%Error.prototype%` chains
        // to %Object.prototype%; each subtype's prototype chains to
        // %Error.prototype% (so `TypeError` `instanceof Error`).
        let error_proto = self.slots.alloc(Slot::instance(object_proto));
        // The non-global abstract `%TypedArray%` constructor and its prototype
        // are the shared intermediate links for every concrete TypedArray
        // family. `Object.getPrototypeOf(Int8Array)` exposes the constructor;
        // `Object.getPrototypeOf(Int8Array.prototype)` exposes the prototype.
        let typed_array_ctor = self.slots.alloc(Slot::instance(func_proto));
        let typed_array_name = self.alloc_str_text("TypedArray");
        self.functions.insert(
            typed_array_ctor,
            FuncInfo {
                native: Some(Native::TypedArrayBase),
                name: "TypedArray".to_string(),
                name_chunk: typed_array_name,
                arity: Native::TypedArrayBase.arity(),
                ..FuncInfo::default()
            },
        );
        let typed_array_proto = self.slots.alloc(Slot::instance(object_proto));
        self.ctor_prototype
            .insert(typed_array_ctor, typed_array_proto);
        self.proto_methods
            .push((typed_array_proto, "constructor", typed_array_ctor));
        self.proto_methods
            .push((typed_array_ctor, "prototype", typed_array_proto));
        for (name, native) in Native::intrinsics() {
            let f = self.slots.alloc(Slot::instance(func_proto));
            let name_chunk = self.alloc_str_text(&name);
            self.functions.insert(
                f,
                FuncInfo {
                    native: Some(native),
                    name: name.to_string(),
                    name_chunk,
                    arity: native.arity(),
                    ..FuncInfo::default()
                },
            );
            self.intrinsics.insert(name, f);
            if matches!(native, Native::TypedArray(_)) {
                self.slots.get_mut(f).value = Payload::Reference(typed_array_ctor);
            }
            // Wire the constructor's `.prototype` object (the `instanceof`
            // right-hand test / the `new` this-prototype). Object and
            // Function reuse the two prototype roots; the Error base reuses
            // `%Error.prototype%`; every subtype gets a prototype chaining to
            // it; the wrapper constructors get a plain `%X.prototype%`.
            let proto = match native {
                Native::Object => object_proto,
                Native::Function => func_proto,
                Native::Error => error_proto,
                Native::EvalError
                | Native::RangeError
                | Native::ReferenceError
                | Native::SyntaxError
                | Native::TypeError
                | Native::URIError
                | Native::AggregateError => self.slots.alloc(Slot::instance(error_proto)),
                Native::SuppressedError => self.slots.alloc(Slot::instance(error_proto)),
                Native::Boolean
                | Native::Symbol
                | Native::BigInt
                | Native::Number
                | Native::String
                | Native::Date => self.slots.alloc(Slot::instance(object_proto)),
                Native::DisposableStack | Native::AsyncDisposableStack => {
                    self.slots.alloc(Slot::instance(object_proto))
                }
                // `%Array.prototype%` is itself an (empty) exotic array in XS;
                // ironhorse models it as an ordinary boot object chaining to
                // %Object.prototype% (its own array-ness is unobservable to the
                // covered grammar, which never reads `Array.prototype.length`).
                Native::Array => self.slots.alloc(Slot::instance(object_proto)),
                // `%Map.prototype%` / `%Set.prototype%` / `%WeakMap.prototype%`
                // / `%WeakSet.prototype%`: plain boot objects chaining to
                // %Object.prototype%, carrying the collection methods bound
                // below. Their per-instance table lives in the `collections`
                // side table, not on the prototype.
                Native::Map | Native::Set | Native::WeakMap | Native::WeakSet => {
                    self.slots.alloc(Slot::instance(object_proto))
                }
                Native::Iterator => self.slots.alloc(Slot::instance(object_proto)),
                // `%ArrayBuffer.prototype%`: a plain boot object chaining to
                // %Object.prototype%, carrying the `byteLength` accessor and
                // the `slice` method bound below. The per-instance backing
                // store lives in the `array_buffers` side table.
                Native::ArrayBuffer => self.slots.alloc(Slot::instance(object_proto)),
                // `%SharedArrayBuffer.prototype%`: a plain boot object chaining
                // to %Object.prototype%, carrying the `byteLength` accessor
                // (special-cased by id, shared with ArrayBuffer). The backing
                // store lives in `array_buffers`, marked in `shared_buffers`.
                Native::SharedArrayBuffer => self.slots.alloc(Slot::instance(object_proto)),
                // `%Uint8Array.prototype%` &co. inherit the shared abstract
                // `%TypedArray.prototype%`; concrete instances carry their
                // per-view state in the `typed_arrays` side table.
                Native::TypedArray(_) => self.slots.alloc(Slot::instance(typed_array_proto)),
                // `%DataView.prototype%`: a plain boot object chaining to
                // %Object.prototype%, carrying the `get*`/`set*` methods and
                // the `byteLength`/`byteOffset`/`buffer` accessors (the latter
                // special-cased by id). The per-instance view state lives in
                // the `data_views` side table.
                Native::DataView => self.slots.alloc(Slot::instance(object_proto)),
                // `%Promise.prototype%`: a plain boot object chaining to
                // %Object.prototype%, carrying `then`/`catch`/`finally` bound
                // below. The per-instance settlement state lives in the
                // `promises` side table.
                Native::Promise => self.slots.alloc(Slot::instance(object_proto)),
                // `%RegExp.prototype%`: a plain boot object chaining to
                // %Object.prototype%, carrying `exec`/`test`/`toString` (bound
                // below) and the `source`/`flags`/per-flag accessor getters
                // (special-cased by id in `GET_PROPERTY`). The per-instance
                // compiled program lives in the `regexps` side table;
                // `lastIndex` is an ordinary own property of the instance.
                Native::RegExp => self.slots.alloc(Slot::instance(object_proto)),
                Native::Locale
                | Native::Collator
                | Native::ListFormat
                | Native::PluralRules
                | Native::Segmenter
                | Native::DateTimeFormat
                | Native::NumberFormat
                | Native::TemporalInstant
                | Native::TemporalDuration
                | Native::TemporalPlain(_)
                | Native::TemporalZonedDateTime => {
                    unreachable!("namespace constructors are registered separately")
                }
                // `Proxy` is registered separately (`create_proxy`) and never
                // iterated here — it has no `.prototype`. Unreachable in this loop.
                Native::Proxy => unreachable!("Proxy is not a create_intrinsics loop entry"),
                Native::Eval => unreachable!("eval is not a constructor-loop entry"),
                // `%GeneratorFunction%` / `%AsyncFunction%` /
                // `%AsyncGeneratorFunction%` are non-global and created
                // separately (below), never yielded by `intrinsics()`.
                Native::GeneratorFunction
                | Native::AsyncFunction
                | Native::AsyncGeneratorFunction => {
                    unreachable!("dynamic-function-family constructors are registered separately")
                }
                Native::TypedArrayBase => {
                    unreachable!("abstract TypedArray constructor is registered separately")
                }
            };
            self.ctor_prototype.insert(f, proto);
            // The two realm-local identity links required of every built-in
            // constructor.  They are installed only when the program names
            // the corresponding key, like the rest of the boot surface.
            // `%Iterator.prototype%.constructor` is the web-compat accessor
            // specified by ES2025, not the ordinary writable data property
            // shared by the other intrinsic prototypes. Its getter/setter are
            // installed below once the iterator prototype identity is known.
            if native != Native::Iterator {
                self.proto_methods.push((proto, "constructor", f));
            }
            self.proto_methods.push((f, "prototype", proto));
            // `<TypedArray>.BYTES_PER_ELEMENT` and its
            // `<TypedArray>.prototype.BYTES_PER_ELEMENT` twin: the element
            // size in bytes, a non-writable/non-enumerable/non-configurable
            // data property on both the concrete constructor and its prototype
            // (ECMA-262 23.2.6.2 / 23.2.7.2, XS's `fxBuildTypedArray` element
            // constants). Bound lazily like the other boot data properties, so
            // it stays invisible to programs that never name it. The harness's
            // `TA.BYTES_PER_ELEMENT` buffer-size arithmetic depends on it.
            if let Native::TypedArray(i) = native {
                let size = TYPED_ARRAY_TYPES[i as usize].size as i32;
                self.proto_value_data
                    .push((f, "BYTES_PER_ELEMENT", Slot::integer(size)));
                self.proto_value_data
                    .push((proto, "BYTES_PER_ELEMENT", Slot::integer(size)));
            }
        }
        // Remember `%Array.prototype%` — every array literal / `new Array`
        // instance chains to it so its methods resolve up the chain.
        self.array_proto = self
            .intrinsics
            .get("Array")
            .and_then(|&c| self.ctor_prototype.get(&c).copied())
            .unwrap_or(crate::value::SlotIndex::NULL);
        self.iterator_proto = self
            .intrinsics
            .get("Iterator")
            .and_then(|&c| self.ctor_prototype.get(&c).copied())
            .unwrap_or(crate::value::SlotIndex::NULL);
        if let Some(&iterator_ctor) = self.intrinsics.get("Iterator") {
            let constructor_getter = self.alloc_named_method(
                NativeMethod::IteratorConstructorGetter,
                "get constructor",
                0,
            );
            let constructor_setter = self.alloc_named_method(
                NativeMethod::IteratorConstructorSetter,
                "set constructor",
                1,
            );
            self.proto_accessors.push((
                self.iterator_proto,
                ProtoAccessorKey::String("constructor"),
                constructor_getter,
                Some(constructor_setter),
                "Iterator",
            ));
            let tag_getter = self.alloc_named_method(
                NativeMethod::IteratorToStringTagGetter,
                "get [Symbol.toStringTag]",
                0,
            );
            let tag_setter = self.alloc_named_method(
                NativeMethod::IteratorToStringTagSetter,
                "set [Symbol.toStringTag]",
                1,
            );
            self.proto_accessors.push((
                self.iterator_proto,
                ProtoAccessorKey::WellKnownSymbol("toStringTag"),
                tag_getter,
                Some(tag_setter),
                "Iterator",
            ));
            let from = self.alloc_named_method(NativeMethod::IteratorFrom, "from", 1);
            self.proto_methods.push((iterator_ctor, "from", from));
            // `%WrapForValidIteratorPrototype%` is shared by every generic
            // iterator wrapper, including calls inherited through a subclass
            // of `Iterator`. It is deliberately distinct from each built-in
            // iterator prototype while inheriting the helper surface from
            // `%Iterator.prototype%`.
            self.iterator_wrapper_proto = self.slots.alloc(Slot::instance(self.iterator_proto));
            let wrapper_next =
                self.alloc_named_method(NativeMethod::IteratorWrapperNext, "next", 0);
            let wrapper_return =
                self.alloc_named_method(NativeMethod::IteratorWrapperReturn, "return", 0);
            self.proto_methods
                .push((self.iterator_wrapper_proto, "next", wrapper_next));
            self.proto_methods
                .push((self.iterator_wrapper_proto, "return", wrapper_return));
            for (op, (name, arity)) in [
                ("map", 1u32),
                ("filter", 1),
                ("take", 1),
                ("drop", 1),
                ("flatMap", 1),
                ("reduce", 1),
                ("toArray", 0),
                ("forEach", 1),
                ("some", 1),
                ("every", 1),
                ("find", 1),
            ]
            .into_iter()
            .enumerate()
            {
                let method =
                    self.alloc_named_method(NativeMethod::IteratorHelper(op as u8), name, arity);
                self.proto_methods.push((self.iterator_proto, name, method));
            }
        }
        // The `Array.prototype` methods ironhorse models (dense fast paths), bound
        // as own properties of `%Array.prototype%` at link time only when the
        // program references the method name.
        for (name, m) in [
            ("push", NativeMethod::ArrayPush),
            ("pop", NativeMethod::ArrayPop),
            ("indexOf", NativeMethod::ArrayIndexOf),
            ("join", NativeMethod::ArrayJoin),
            ("values", NativeMethod::ArrayValues),
            ("keys", NativeMethod::ArrayKeys),
            ("entries", NativeMethod::ArrayEntries),
            ("includes", NativeMethod::ArrayIncludes),
            ("lastIndexOf", NativeMethod::ArrayLastIndexOf),
            ("fill", NativeMethod::ArrayFill),
            ("reverse", NativeMethod::ArrayReverse),
            ("slice", NativeMethod::ArraySlice),
            ("concat", NativeMethod::ArrayConcat),
            ("at", NativeMethod::ArrayAt),
            ("shift", NativeMethod::ArrayShift),
            ("unshift", NativeMethod::ArrayUnshift),
            ("copyWithin", NativeMethod::ArrayCopyWithin),
            ("with", NativeMethod::ArrayWith),
            ("forEach", NativeMethod::ArrayForEach),
            ("map", NativeMethod::ArrayMap),
            ("some", NativeMethod::ArraySome),
            ("every", NativeMethod::ArrayEvery),
            ("find", NativeMethod::ArrayFind),
            ("findIndex", NativeMethod::ArrayFindIndex),
            ("filter", NativeMethod::ArrayFilter),
            ("reduce", NativeMethod::ArrayReduce),
            ("reduceRight", NativeMethod::ArrayReduceRight),
            ("findLast", NativeMethod::ArrayFindLast),
            ("findLastIndex", NativeMethod::ArrayFindLastIndex),
            ("toReversed", NativeMethod::ArrayToReversed),
            ("splice", NativeMethod::ArraySplice),
            ("flat", NativeMethod::ArrayFlat),
            ("flatMap", NativeMethod::ArrayFlatMap),
            ("toSpliced", NativeMethod::ArrayToSpliced),
            ("toString", NativeMethod::ArrayToString),
            ("sort", NativeMethod::ArraySort),
            ("toSorted", NativeMethod::ArrayToSorted),
            ("toLocaleString", NativeMethod::ArrayToLocaleString),
        ] {
            let mf = match m {
                NativeMethod::ArraySort | NativeMethod::ArrayToSorted => {
                    self.alloc_named_method(m, name, 1)
                }
                NativeMethod::ArrayPush => self.alloc_named_method(m, name, 1),
                NativeMethod::ArrayPop => self.alloc_named_method(m, name, 0),
                NativeMethod::ArrayShift => self.alloc_named_method(m, name, 0),
                NativeMethod::ArrayUnshift => self.alloc_named_method(m, name, 1),
                NativeMethod::ArraySlice => self.alloc_named_method(m, name, 2),
                NativeMethod::ArrayConcat => self.alloc_named_method(m, name, 1),
                NativeMethod::ArrayWith | NativeMethod::ArrayToSpliced => {
                    self.alloc_named_method(m, name, 2)
                }
                NativeMethod::ArrayToReversed => self.alloc_named_method(m, name, 0),
                NativeMethod::ArrayFlat => self.alloc_named_method(m, name, 0),
                NativeMethod::ArrayFlatMap => self.alloc_named_method(m, name, 1),
                _ => self.alloc_method(m),
            };
            self.proto_methods.push((self.array_proto, name, mf));
        }
        // Shared `%TypedArray.prototype%` methods live on the abstract
        // intermediate prototype and are inherited by every concrete family.
        for (name, arity, method) in [
            ("copyWithin", 2, NativeMethod::TypedArrayCopyWithin),
            ("fill", 1, NativeMethod::TypedArrayFill),
            ("set", 1, NativeMethod::TypedArraySet),
            ("reverse", 0, NativeMethod::TypedArrayReverse),
            ("join", 1, NativeMethod::TypedArrayJoin),
            ("slice", 2, NativeMethod::TypedArraySlice),
            ("subarray", 2, NativeMethod::TypedArraySubarray),
            ("map", 1, NativeMethod::TypedArrayMap),
            ("filter", 1, NativeMethod::TypedArrayFilter),
            ("sort", 1, NativeMethod::TypedArraySort),
            ("toLocaleString", 0, NativeMethod::TypedArrayToLocaleString),
        ] {
            let mf = self.alloc_named_method(method, name, arity);
            self.proto_methods.push((typed_array_proto, name, mf));
        }
        for (name, method) in [
            ("values", NativeMethod::TypedArrayValues),
            ("keys", NativeMethod::TypedArrayKeys),
            ("entries", NativeMethod::TypedArrayEntries),
        ] {
            let method = self.alloc_named_method(method, name, 0);
            self.proto_methods.push((typed_array_proto, name, method));
        }
        for (operation, (name, arity)) in [
            ("forEach", 1u32),
            ("every", 1),
            ("some", 1),
            ("find", 1),
            ("findIndex", 1),
            ("includes", 1),
            ("indexOf", 1),
            ("lastIndexOf", 1),
            ("reduce", 1),
            ("reduceRight", 1),
        ]
        .into_iter()
        .enumerate()
        {
            let method = self.alloc_named_method(
                NativeMethod::TypedArrayReadonly(operation as u8),
                name,
                arity,
            );
            self.proto_methods.push((typed_array_proto, name, method));
        }
        // `%TypedArray%.prototype.toString%` is the exact same function object
        // as `%Array.prototype.toString%`, not a separately minted native.
        if let Some((_, _, to_string)) = self
            .proto_methods
            .iter()
            .find(|(holder, name, _)| *holder == self.array_proto && *name == "toString")
            .copied()
        {
            self.proto_methods
                .push((typed_array_proto, "toString", to_string));
        }
        for (name, method) in [
            ("length", NativeMethod::TypedArrayLengthGetter),
            ("byteLength", NativeMethod::TypedArrayByteLengthGetter),
            ("byteOffset", NativeMethod::TypedArrayByteOffsetGetter),
            ("buffer", NativeMethod::TypedArrayBufferGetter),
        ] {
            let getter = self.alloc_named_method(method, &format!("get {name}"), 0);
            self.proto_accessors.push((
                typed_array_proto,
                ProtoAccessorKey::String(name),
                getter,
                None,
                "TypedArray",
            ));
        }
        let from = self.alloc_named_method(NativeMethod::TypedArrayFrom, "from", 1);
        let of = self.alloc_named_method(NativeMethod::TypedArrayOf, "of", 0);
        self.proto_methods.push((typed_array_ctor, "from", from));
        self.proto_methods.push((typed_array_ctor, "of", of));
        // Allocated now and installed under the well-known symbol key during
        // intrinsic linking, once that realm-local key id is available.
        let _ = self.alloc_named_method(
            NativeMethod::TypedArrayToStringTagGetter,
            "get [Symbol.toStringTag]",
            0,
        );
        // `%Array Iterator.prototype%`: a boot object chaining to
        // %Object.prototype%, carrying `next` (the iterators produced by
        // `values`/`keys`/`entries` chain to it).
        let array_iter_proto = self.slots.alloc(Slot::instance(self.iterator_proto));
        self.array_iterator_proto = array_iter_proto;
        let next_mf = self.alloc_method(NativeMethod::ArrayIteratorNext);
        self.proto_methods.push((array_iter_proto, "next", next_mf));
        // Collection iterators have distinct intrinsic prototypes and `next`
        // function identities.  They share the iterator-state representation
        // with Array iterators, but the methods must reject an iterator of the
        // other collection family (the spec's [[Map]]/[[Set]] brand check).
        self.map_iterator_proto = self.slots.alloc(Slot::instance(self.iterator_proto));
        self.set_iterator_proto = self.slots.alloc(Slot::instance(self.iterator_proto));
        let map_next = self.alloc_named_method(NativeMethod::MapIteratorNext, "next", 0);
        let set_next = self.alloc_named_method(NativeMethod::SetIteratorNext, "next", 0);
        self.proto_methods
            .push((self.map_iterator_proto, "next", map_next));
        self.proto_methods
            .push((self.set_iterator_proto, "next", set_next));
        // `%RegExpStringIteratorPrototype%`: a distinct iterator prototype
        // whose `next` lazily drives the cloned matcher captured by
        // `RegExp.prototype[@@matchAll]`.
        self.regexp_string_iterator_proto = self.slots.alloc(Slot::instance(self.iterator_proto));
        let regexp_string_next =
            self.alloc_named_method(NativeMethod::RegExpStringIteratorNext, "next", 0);
        self.proto_methods.push((
            self.regexp_string_iterator_proto,
            "next",
            regexp_string_next,
        ));
        // `Array.isArray` — a static bound as an own property of the `Array`
        // constructor instance (not the prototype).
        if let Some(&array_ctor) = self.intrinsics.get("Array") {
            let mf = self.alloc_method(NativeMethod::ArrayIsArray);
            self.proto_methods.push((array_ctor, "isArray", mf));
            let of = self.alloc_named_method(NativeMethod::ArrayOf, "of", 0);
            self.proto_methods.push((array_ctor, "of", of));
            let from = self.alloc_named_method(NativeMethod::ArrayFrom, "from", 1);
            self.proto_methods.push((array_ctor, "from", from));
            let from_async = self.alloc_named_method(NativeMethod::ArrayFromAsync, "fromAsync", 1);
            self.proto_methods
                .push((array_ctor, "fromAsync", from_async));
        }
        // `%Symbol.prototype%`: the box target for a primitive symbol's method
        // access (`Symbol("x").toString()`), carrying `toString`/`valueOf`;
        // and the `Symbol.for`/`keyFor` registry statics on the constructor
        // instance. Bound at link time only for the names the program uses.
        if let Some(&symbol_ctor) = self.intrinsics.get("Symbol") {
            if let Some(p) = self.prototype_of(symbol_ctor) {
                self.symbol_proto = p;
                let t = self.alloc_method(NativeMethod::SymbolToString);
                self.proto_methods.push((p, "toString", t));
                let v = self.alloc_method(NativeMethod::SymbolValueOf);
                self.proto_methods.push((p, "valueOf", v));
                // The property id remains lazy because it is symbol-keyed,
                // but the function identity must be boot-minted so snapshot
                // resume can reconstruct the intrinsic exactly.
                self.symbol_to_primitive_method = self.alloc_named_method(
                    NativeMethod::SymbolToPrimitive,
                    "[Symbol.toPrimitive]",
                    1,
                );
                // `get Symbol.prototype.description`: a real accessor property
                // (`{get, set: undefined, enumerable: false, configurable:
                // true}`), so reflection sees what XS's does and the getter
                // runs with the reading symbol as its `this`.
                let description = self.alloc_named_method(
                    NativeMethod::SymbolDescriptionGetter,
                    "get description",
                    0,
                );
                self.proto_accessors.push((
                    p,
                    ProtoAccessorKey::String("description"),
                    description,
                    None,
                    "Symbol",
                ));
            }
            let f = self.alloc_method(NativeMethod::SymbolFor);
            self.proto_methods.push((symbol_ctor, "for", f));
            let k = self.alloc_method(NativeMethod::SymbolKeyFor);
            self.proto_methods.push((symbol_ctor, "keyFor", k));
        }
        // The collection prototypes (`%Map.prototype%` &co.), remembered so a
        // `new Map()`/`new Set()`/… instance chains to the right one and its
        // methods resolve. `set`/`get`/`has`/`delete` on Map and WeakMap share
        // the `MapSet`/`MapGet`/`MapHas`/`MapDelete` handlers (identical body
        // apart from the weak key check); `add`/`has`/`delete` on Set and
        // WeakSet share `SetAdd`/`SetHas`/`SetDelete`. Bound at link time only
        // when the program references the name (like every native method).
        for (name, cache) in [("Map", 0usize), ("Set", 1), ("WeakMap", 2), ("WeakSet", 3)] {
            let proto = self
                .intrinsics
                .get(name)
                .and_then(|&c| self.ctor_prototype.get(&c).copied())
                .unwrap_or(crate::value::SlotIndex::NULL);
            match cache {
                0 => self.map_proto = proto,
                1 => self.set_proto = proto,
                2 => self.weakmap_proto = proto,
                _ => self.weakset_proto = proto,
            }
            if cache < 2 {
                let method = if cache == 0 {
                    NativeMethod::MapSizeGetter
                } else {
                    NativeMethod::SetSizeGetter
                };
                let getter = self.alloc_named_method(method, "get size", 0);
                self.proto_accessors.push((
                    proto,
                    ProtoAccessorKey::String("size"),
                    getter,
                    None,
                    name,
                ));
            }
            let methods: &[(&'static str, u32, NativeMethod)] = match cache {
                0 => &[
                    ("set", 2, NativeMethod::MapSet),
                    ("get", 1, NativeMethod::MapGet),
                    ("has", 1, NativeMethod::MapHas),
                    ("delete", 1, NativeMethod::MapDelete),
                    ("forEach", 1, NativeMethod::CollForEach),
                    ("entries", 0, NativeMethod::CollEntries),
                    ("keys", 0, NativeMethod::CollKeys),
                    ("values", 0, NativeMethod::CollValues),
                    ("clear", 0, NativeMethod::CollClear),
                ],
                1 => &[
                    ("add", 1, NativeMethod::SetAdd),
                    ("has", 1, NativeMethod::SetHas),
                    ("delete", 1, NativeMethod::SetDelete),
                    ("forEach", 1, NativeMethod::CollForEach),
                    ("entries", 0, NativeMethod::CollEntries),
                    // Set's `keys`/`values` are bound after this loop as a
                    // single shared function object (see below).
                    ("clear", 0, NativeMethod::CollClear),
                ],
                2 => &[
                    ("set", 2, NativeMethod::WeakMapSet),
                    ("get", 1, NativeMethod::WeakMapGet),
                    ("has", 1, NativeMethod::WeakMapHas),
                    ("delete", 1, NativeMethod::WeakMapDelete),
                ],
                _ => &[
                    ("add", 1, NativeMethod::WeakSetAdd),
                    ("has", 1, NativeMethod::WeakSetHas),
                    ("delete", 1, NativeMethod::WeakSetDelete),
                ],
            };
            for &(m_name, arity, m) in methods {
                let mf = self.alloc_named_method(m, m_name, arity);
                self.proto_methods.push((proto, m_name, mf));
            }
            // The two upsert-proposal methods on `Map.prototype` (cache == 0)
            // carry a proper `.name`/`.length` (arity 2), so `verifyProperty`
            // reads the spec descriptor. Bound only on `Map.prototype`.
            if cache == 0 {
                for (m_name, m) in [
                    ("getOrInsert", NativeMethod::MapGetOrInsert),
                    ("getOrInsertComputed", NativeMethod::MapGetOrInsertComputed),
                ] {
                    let mf = self.alloc_named_method(m, m_name, 2);
                    self.proto_methods.push((proto, m_name, mf));
                }
            }
            // The same two upsert-proposal methods on `WeakMap.prototype`
            // (cache == 2). The proposal covers Map *and* WeakMap; the handler
            // is shared and branches on the receiver kind (weak-key validation,
            // no canonicalization). `.name`/`.length` (arity 2) as on Map.
            if cache == 2 {
                for (m_name, m) in [
                    ("getOrInsert", NativeMethod::WeakMapGetOrInsert),
                    (
                        "getOrInsertComputed",
                        NativeMethod::WeakMapGetOrInsertComputed,
                    ),
                ] {
                    let mf = self.alloc_named_method(m, m_name, 2);
                    self.proto_methods.push((proto, m_name, mf));
                }
            }
            // The seven ES2025 "new Set methods" carry a proper `.name`/`.length`
            // (arity 1), so `verifyProperty`/`propertyHelper` read the spec
            // descriptor. Bound only on `Set.prototype` (cache == 1).
            if cache == 1 {
                // `Set.prototype.keys` is the SAME function object as
                // `Set.prototype.values` (spec: the initial value of `keys` is
                // the initial value of `values`), so a single allocation is
                // bound under both keys — `built-ins/Set/prototype/keys/keys.js`
                // asserts `Set.prototype.keys === Set.prototype.values`. The
                // shared object carries the canonical `.name` (`"values"`) and
                // arity 0.
                let values = self.alloc_named_method(NativeMethod::CollValues, "values", 0);
                self.proto_methods.push((proto, "values", values));
                self.proto_methods.push((proto, "keys", values));
                for (m_name, m) in [
                    ("union", NativeMethod::SetUnion),
                    ("intersection", NativeMethod::SetIntersection),
                    ("difference", NativeMethod::SetDifference),
                    ("symmetricDifference", NativeMethod::SetSymmetricDifference),
                    ("isSubsetOf", NativeMethod::SetIsSubsetOf),
                    ("isSupersetOf", NativeMethod::SetIsSupersetOf),
                    ("isDisjointFrom", NativeMethod::SetIsDisjointFrom),
                ] {
                    let mf = self.alloc_named_method(m, m_name, 1);
                    self.proto_methods.push((proto, m_name, mf));
                }
            }
        }
        // `Map.groupBy` / `Object.groupBy` (array-grouping proposal) — statics
        // bound as own properties of their constructor instance (not the
        // prototype), each with a proper `.name`/`.length` (arity 2).
        if let Some(&map_ctor) = self.intrinsics.get("Map") {
            let mf = self.alloc_named_method(NativeMethod::MapGroupBy, "groupBy", 2);
            self.proto_methods.push((map_ctor, "groupBy", mf));
        }
        if let Some(&object_ctor) = self.intrinsics.get("Object") {
            let mf = self.alloc_named_method(NativeMethod::ObjectGroupBy, "groupBy", 2);
            self.proto_methods.push((object_ctor, "groupBy", mf));
        }
        // `%ArrayBuffer.prototype%`: the species-constructing `slice` method
        // plus the recognized-but-unimplemented methods bound so a reference
        // is an honest NAMED skip (`Halt::NotImplemented`) rather than a
        // completion divergence. `byteLength` also needs a real descriptor:
        // SES captures its getter through getOwnPropertyDescriptor at boot.
        self.arraybuffer_proto = self
            .intrinsics
            .get("ArrayBuffer")
            .and_then(|&c| self.ctor_prototype.get(&c).copied())
            .unwrap_or(crate::value::SlotIndex::NULL);
        let slice = self.alloc_named_method(NativeMethod::ArrayBufferSlice, "slice", 2);
        self.proto_methods
            .push((self.arraybuffer_proto, "slice", slice));
        let transfer = self.alloc_named_method(NativeMethod::ArrayBufferTransfer, "transfer", 0);
        self.proto_methods
            .push((self.arraybuffer_proto, "transfer", transfer));
        let transfer_to_fixed = self.alloc_named_method(
            NativeMethod::ArrayBufferTransferToFixedLength,
            "transferToFixedLength",
            0,
        );
        self.proto_methods.push((
            self.arraybuffer_proto,
            "transferToFixedLength",
            transfer_to_fixed,
        ));
        for (name, m) in [
            ("resize", NativeMethod::ArrayBufferResize),
            ("concat", NativeMethod::ArrayBufferConcat),
        ] {
            let mf = self.alloc_method(m);
            self.proto_methods.push((self.arraybuffer_proto, name, mf));
        }
        for (name, method) in [
            // All supported buffers are fixed length, so these getters have
            // the same receiver checks, detachment behavior, and result.
            ("byteLength", NativeMethod::ArrayBufferMaxByteLengthGetter),
            ("detached", NativeMethod::ArrayBufferDetachedGetter),
            (
                "maxByteLength",
                NativeMethod::ArrayBufferMaxByteLengthGetter,
            ),
            ("resizable", NativeMethod::ArrayBufferResizableGetter),
        ] {
            let getter = self.alloc_named_method(method, &format!("get {name}"), 0);
            self.proto_accessors.push((
                self.arraybuffer_proto,
                ProtoAccessorKey::String(name),
                getter,
                None,
                "ArrayBuffer",
            ));
        }
        // `ArrayBuffer.isView` — a static bound as an own property of the
        // `ArrayBuffer` constructor instance (not the prototype).
        if let Some(&ab_ctor) = self.intrinsics.get("ArrayBuffer") {
            let is_view = self.alloc_method(NativeMethod::ArrayBufferIsView);
            self.proto_methods.push((ab_ctor, "isView", is_view));
            // Installed under the well-known symbol key during the full
            // intrinsic-link pass, once that realm-local key id is available.
            let _ = self.alloc_named_method(
                NativeMethod::ArrayBufferSpeciesGetter,
                "get [Symbol.species]",
                0,
            );
        }
        // `%DataView.prototype%`: the endian-aware `get<Type>`/`set<Type>`
        // methods (each dispatching to the shared `fx_DataView_prototype_get`/
        // `_set` over the element type indexed into `TYPED_ARRAY_TYPES`). The
        // `byteLength`/`byteOffset`/`buffer` accessors are special-cased by id
        // in `GET_PROPERTY`. The BigInt64/BigUint64 get/set are bound so a
        // reference is an honest NAMED skip (BigInt coercion is a later
        // increment).
        self.dataview_proto = self
            .intrinsics
            .get("DataView")
            .and_then(|&c| self.ctor_prototype.get(&c).copied())
            .unwrap_or(crate::value::SlotIndex::NULL);
        for (index, name) in ["buffer", "byteLength", "byteOffset"].iter().enumerate() {
            let getter = self.alloc_named_method(
                NativeMethod::DataViewAccessor(index as u8),
                &format!("get {name}"),
                0,
            );
            self.proto_accessors.push((
                self.dataview_proto,
                ProtoAccessorKey::String(name),
                getter,
                None,
                "DataView",
            ));
        }
        // (get-method name, set-method name, element-type index into
        // TYPED_ARRAY_TYPES). Static names — no per-boot allocation. The
        // BigInt64/BigUint64 get/set are bound so a reference is an honest
        // NAMED skip (their BigInt coercion is a later increment).
        let dv_methods: &[(&'static str, &'static str, u8)] = &[
            ("getInt8", "setInt8", 4),
            ("getUint8", "setUint8", 7),
            ("getInt16", "setInt16", 5),
            ("getUint16", "setUint16", 8),
            ("getInt32", "setInt32", 6),
            ("getUint32", "setUint32", 9),
            ("getFloat32", "setFloat32", 2),
            ("getFloat64", "setFloat64", 3),
            ("getBigInt64", "setBigInt64", 0),
            ("getBigUint64", "setBigUint64", 1),
        ];
        for &(gname, sname, kind) in dv_methods {
            // Named + arity-carrying so `get<Type>.name`/`.length` (1) and
            // `set<Type>.name`/`.length` (2) are the spec's reflective own
            // data properties (`verifyProperty`/`propertyHelper` reads them).
            let getter = self.alloc_named_method(NativeMethod::DataViewGet(kind), gname, 1);
            let setter = self.alloc_named_method(NativeMethod::DataViewSet(kind), sname, 2);
            self.proto_methods
                .push((self.dataview_proto, gname, getter));
            self.proto_methods
                .push((self.dataview_proto, sname, setter));
        }
        // `%Promise.prototype%`: `then`/`catch`/`finally`, bound at link time
        // only when the program references the name. The per-instance
        // settlement state lives in the `promises` side table; the statics
        // (`resolve`/`reject`/`all`/`race`/…) bind on the `Promise`
        // constructor instance below.
        self.promise_proto = self
            .intrinsics
            .get("Promise")
            .and_then(|&c| self.ctor_prototype.get(&c).copied())
            .unwrap_or(crate::value::SlotIndex::NULL);
        for (name, m) in [
            ("then", NativeMethod::PromiseThen),
            ("catch", NativeMethod::PromiseCatch),
            ("finally", NativeMethod::PromiseFinally),
        ] {
            let arity = if name == "then" { 2 } else { 1 };
            let mf = self.alloc_named_method(m, name, arity);
            self.proto_methods.push((self.promise_proto, name, mf));
        }
        // `%GeneratorPrototype%` (`xsGenerator.c`'s `fxBuildGenerator`): a boot
        // object carrying `next`/`return`/`throw` and chaining to
        // `%Iterator.prototype%`. A generator function's `.prototype` chains
        // to this (see `new_generator_function`), so generator instances both
        // resolve their resume methods and inherit the standard Iterator
        // helpers through the ordinary prototype walk.
        let generator_proto = self.slots.alloc(Slot::instance(self.iterator_proto));
        self.generator_proto = generator_proto;
        for (name, m) in [
            ("next", NativeMethod::GeneratorNext),
            ("return", NativeMethod::GeneratorReturn),
            ("throw", NativeMethod::GeneratorThrow),
        ] {
            let mf = self.alloc_method(m);
            self.proto_methods.push((generator_proto, name, mf));
        }
        // `%AsyncFunction.prototype%` (XS's `mxAsyncFunctionPrototype`,
        // `fxBuildFunction`): a plain object off `%Function.prototype%`. An
        // async function's instance `[[Prototype]]` chains here rather than to
        // `%Function.prototype%` (see [`Self::new_async_function`]). The covered
        // surface only needs its identity (an `x instanceof (async()=>{})`
        // check reaches it); its own `Symbol.toStringTag` is unread and omitted.
        let async_function_proto = self.slots.alloc(Slot::instance(self.function_proto));
        self.async_function_proto = async_function_proto;
        // `%AsyncGeneratorPrototype%` and `%AsyncGeneratorFunction.prototype%`.
        // Async-generator instances expose the same three request methods as
        // generators, but each returns a promise and requests are serialized.
        // Async generators inherit the shared %AsyncIteratorPrototype%,
        // which in turn inherits Object.prototype. SES discovers both levels.
        let async_iterator_proto = self.slots.alloc(Slot::instance(self.object_proto));
        let async_generator_proto = self.slots.alloc(Slot::instance(async_iterator_proto));
        self.async_generator_proto = async_generator_proto;
        for (name, arity, m) in [
            ("next", 1, NativeMethod::AsyncGeneratorNext),
            ("return", 1, NativeMethod::AsyncGeneratorReturn),
            ("throw", 1, NativeMethod::AsyncGeneratorThrow),
        ] {
            let mf = self.alloc_named_method(m, name, arity);
            self.proto_methods.push((async_generator_proto, name, mf));
        }
        self.async_iterator_identity = self.alloc_method(NativeMethod::AsyncIteratorIdentity);
        self.iterator_identity =
            self.alloc_named_method(NativeMethod::AsyncIteratorIdentity, "[Symbol.iterator]", 0);
        self.async_generator_function_proto = self.slots.alloc(Slot::instance(self.function_proto));
        // `%AsyncGenerator%` (the common prototype of async-generator
        // functions) exposes `%AsyncGeneratorPrototype%` through its own
        // non-writable `prototype` property.  Per-function `.prototype`
        // objects still live in `ctor_prototype`; `ordinary_set` recognizes
        // those exotic own properties before consulting this inherited boot
        // property, so assigning `g.prototype` remains valid.
        self.proto_methods.push((
            self.async_generator_function_proto,
            "prototype",
            async_generator_proto,
        ));
        // `%GeneratorFunction.prototype%` (XS's `mxGeneratorFunctionPrototype`,
        // `fxBuildFunction`): a plain object off `%Function.prototype%`. A
        // generator function's instance `[[Prototype]]` chains here (see
        // [`Self::new_generator_function`]) so `(function*(){}).constructor`
        // resolves `%GeneratorFunction%` rather than plain `Function`.
        let generator_function_proto = self.slots.alloc(Slot::instance(self.function_proto));
        self.generator_function_proto = generator_function_proto;
        self.proto_methods
            .push((generator_function_proto, "prototype", generator_proto));
        // The three non-global dynamic-function constructors
        // `%GeneratorFunction%` / `%AsyncFunction%` / `%AsyncGeneratorFunction%`.
        // None is a global binding (they are reachable only through the
        // `.constructor` of a generator/async/async-generator function
        // instance), so they are created here rather than in the `intrinsics()`
        // global loop. Each carries the two realm-local identity links every
        // constructor has — `ctor.prototype` and `<proto>.constructor` — plus
        // the `name`/`length` a `FuncInfo` supplies; call/construct dispatch
        // runs CreateDynamicFunction ([`Self::create_dynamic_function`]).
        //
        // The `[[Prototype]]` of each constructor mirrors the pinned XS build
        // exactly (which is *not* uniform): `Object.getPrototypeOf` is
        // `%Function.prototype%` for `%GeneratorFunction%` and
        // `%AsyncGeneratorFunction%`, but the `%Function%` constructor itself
        // for `%AsyncFunction%`.
        let function_ctor = self
            .intrinsics
            .get("Function")
            .copied()
            .unwrap_or(crate::value::SlotIndex::NULL);
        for (native, ctor_proto, inst_proto) in [
            (
                Native::GeneratorFunction,
                self.function_proto,
                generator_function_proto,
            ),
            (
                Native::AsyncFunction,
                function_ctor,
                self.async_function_proto,
            ),
            (
                Native::AsyncGeneratorFunction,
                self.function_proto,
                self.async_generator_function_proto,
            ),
        ] {
            let name = native.display_name();
            let f = self.slots.alloc(Slot::instance(ctor_proto));
            let name_chunk = self.alloc_str_text(&name);
            self.functions.insert(
                f,
                FuncInfo {
                    native: Some(native),
                    name: name.to_string(),
                    name_chunk,
                    arity: native.arity(),
                    ..FuncInfo::default()
                },
            );
            // `%X.prototype%` <-> `%X%` identity links (installed when the
            // program names `constructor` / `prototype`, like every other boot
            // link). `prototype` is a mandatory own property regardless.
            //
            // The `%X.prototype%` object deliberately carries NO own forward
            // `prototype` -> `%[Async]GeneratorPrototype%` link. It is a
            // niche observable (`GF.prototype.prototype`), and installing it
            // non-writable — as XS's boot `prototype` slot is — makes it shadow
            // a generator/async-generator function *instance's* own writable
            // `.prototype` on the OrdinarySet chain walk, so a strict
            // `g.prototype = x` would wrongly reject (regressing
            // async-generator default-parameter cases). Omit it.
            self.proto_methods.push((inst_proto, "constructor", f));
            self.proto_methods.push((f, "prototype", inst_proto));
        }
        // `Promise.*` statics — own methods of the `Promise` constructor
        // instance (not the prototype).
        if let Some(&promise_ctor) = self.intrinsics.get("Promise") {
            for (name, m) in [
                ("resolve", NativeMethod::PromiseResolveStatic),
                ("reject", NativeMethod::PromiseRejectStatic),
                ("all", NativeMethod::PromiseAll),
                ("race", NativeMethod::PromiseRace),
                ("allSettled", NativeMethod::PromiseAllSettled),
                ("any", NativeMethod::PromiseAny),
            ] {
                let mf = self.alloc_named_method(m, name, 1);
                self.proto_methods.push((promise_ctor, name, mf));
            }
            // Installed under the well-known symbol key during the full
            // intrinsic-link pass, once that realm-local key id is available.
            let _ = self.alloc_named_method(
                NativeMethod::PromiseSpeciesGetter,
                "get [Symbol.species]",
                0,
            );
        }
        // `%RegExp.prototype%`: `exec`/`test`/`toString`, bound at link time
        // only when the program references the name. The per-instance compiled
        // program lives in the `regexps` side table; the `source`/`flags`/
        // per-flag accessor getters are special-cased by id in `GET_PROPERTY`.
        self.regexp_proto = self
            .intrinsics
            .get("RegExp")
            .and_then(|&c| self.ctor_prototype.get(&c).copied())
            .unwrap_or(crate::value::SlotIndex::NULL);
        for (name, m) in [
            ("exec", NativeMethod::RegExpExec),
            ("test", NativeMethod::RegExpTest),
            ("toString", NativeMethod::RegExpToString),
            ("compile", NativeMethod::RegExpCompile),
        ] {
            let mf = self.alloc_method(m);
            self.proto_methods.push((self.regexp_proto, name, mf));
        }
        self.regexp_replace_method =
            self.alloc_named_method(NativeMethod::RegExpReplace, "[Symbol.replace]", 2);
        self.regexp_match_method =
            self.alloc_named_method(NativeMethod::RegExpMatch, "[Symbol.match]", 1);
        self.regexp_match_all_method =
            self.alloc_named_method(NativeMethod::RegExpMatchAll, "[Symbol.matchAll]", 1);
        self.regexp_search_method =
            self.alloc_named_method(NativeMethod::RegExpSearch, "[Symbol.search]", 1);
        self.regexp_split_method =
            self.alloc_named_method(NativeMethod::RegExpSplit, "[Symbol.split]", 2);
        let _ =
            self.alloc_named_method(NativeMethod::RegExpSpeciesGetter, "get [Symbol.species]", 0);
        for (native, methods) in [
            (
                Native::DisposableStack,
                &[
                    ("use", NativeMethod::DisposableStackUse),
                    ("adopt", NativeMethod::DisposableStackAdopt),
                    ("defer", NativeMethod::DisposableStackDefer),
                    ("move", NativeMethod::DisposableStackMove),
                    ("dispose", NativeMethod::DisposableStackDispose),
                ][..],
            ),
            (
                Native::AsyncDisposableStack,
                &[
                    ("use", NativeMethod::AsyncDisposableStackUse),
                    ("adopt", NativeMethod::AsyncDisposableStackAdopt),
                    ("defer", NativeMethod::AsyncDisposableStackDefer),
                    ("move", NativeMethod::AsyncDisposableStackMove),
                    (
                        "disposeAsync",
                        NativeMethod::AsyncDisposableStackDisposeAsync,
                    ),
                ][..],
            ),
        ] {
            if let Some(&ctor) = self.intrinsics.get(native.display_name()) {
                if let Some(proto) = self.prototype_of(ctor) {
                    for &(name, method) in methods {
                        let function = self.alloc_method(method);
                        self.proto_methods.push((proto, name, function));
                    }
                }
            }
        }
        // Native prototype methods (bound to their prototype at link time,
        // only when the program references the method name). %Object.prototype%
        // carries toString/valueOf/hasOwnProperty/isPrototypeOf; each Error
        // prototype an `Error.prototype.toString`; each wrapper prototype a
        // `valueOf`/`toString` over the wrapped primitive; %Function.prototype%
        // a `toString`.
        let obj_methods = [
            ("toString", NativeMethod::ObjectToString),
            ("toLocaleString", NativeMethod::ObjectToLocaleString),
            ("valueOf", NativeMethod::ObjectValueOf),
            ("hasOwnProperty", NativeMethod::ObjectHasOwnProperty),
            ("isPrototypeOf", NativeMethod::ObjectIsPrototypeOf),
            (
                "propertyIsEnumerable",
                NativeMethod::ObjectPropertyIsEnumerable,
            ),
        ];
        for (name, m) in obj_methods {
            let mf = self.alloc_method(m);
            self.proto_methods.push((object_proto, name, mf));
        }
        // `Object.*` statics — own methods of the `Object` constructor
        // instance (not the prototype), bound at link time only when the
        // program references the name.
        if let Some(&object_ctor) = self.intrinsics.get("Object") {
            let assign = self.alloc_named_method(NativeMethod::ObjectAssign, "assign", 2);
            self.proto_methods.push((object_ctor, "assign", assign));
            let has_own = self.alloc_named_method(NativeMethod::ObjectHasOwn, "hasOwn", 2);
            self.proto_methods.push((object_ctor, "hasOwn", has_own));
            let is = self.alloc_named_method(NativeMethod::ObjectIs, "is", 2);
            self.proto_methods.push((object_ctor, "is", is));
            let from_entries =
                self.alloc_named_method(NativeMethod::ObjectFromEntries, "fromEntries", 1);
            self.proto_methods
                .push((object_ctor, "fromEntries", from_entries));
            let create = self.alloc_method(NativeMethod::ObjectCreate);
            self.proto_methods.push((object_ctor, "create", create));
            let keys = self.alloc_method(NativeMethod::ObjectKeys);
            self.proto_methods.push((object_ctor, "keys", keys));
            let gopd = self.alloc_method(NativeMethod::ObjectGetOwnPropertyDescriptor);
            self.proto_methods
                .push((object_ctor, "getOwnPropertyDescriptor", gopd));
            let get_own_property_names = self.alloc_method(NativeMethod::ObjectGetOwnPropertyNames);
            self.proto_methods
                .push((object_ctor, "getOwnPropertyNames", get_own_property_names));
            let defprop = self.alloc_method(NativeMethod::ObjectDefineProperty);
            self.proto_methods
                .push((object_ctor, "defineProperty", defprop));
            let defprops = self.alloc_method(NativeMethod::ObjectDefineProperties);
            self.proto_methods
                .push((object_ctor, "defineProperties", defprops));
            let gopds = self.alloc_method(NativeMethod::ObjectGetOwnPropertyDescriptors);
            self.proto_methods
                .push((object_ctor, "getOwnPropertyDescriptors", gopds));
            let gops = self.alloc_method(NativeMethod::ObjectGetOwnPropertySymbols);
            self.proto_methods
                .push((object_ctor, "getOwnPropertySymbols", gops));
            let values = self.alloc_method(NativeMethod::ObjectValues);
            self.proto_methods.push((object_ctor, "values", values));
            let entries = self.alloc_method(NativeMethod::ObjectEntries);
            self.proto_methods.push((object_ctor, "entries", entries));
            let prevext = self.alloc_method(NativeMethod::ObjectPreventExtensions);
            self.proto_methods
                .push((object_ctor, "preventExtensions", prevext));
            let seal = self.alloc_method(NativeMethod::ObjectSeal);
            self.proto_methods.push((object_ctor, "seal", seal));
            let freeze = self.alloc_method(NativeMethod::ObjectFreeze);
            self.proto_methods.push((object_ctor, "freeze", freeze));
            let isext = self.alloc_method(NativeMethod::ObjectIsExtensible);
            self.proto_methods
                .push((object_ctor, "isExtensible", isext));
            let issealed = self.alloc_method(NativeMethod::ObjectIsSealed);
            self.proto_methods.push((object_ctor, "isSealed", issealed));
            let isfrozen = self.alloc_method(NativeMethod::ObjectIsFrozen);
            self.proto_methods.push((object_ctor, "isFrozen", isfrozen));
            let getproto = self.alloc_method(NativeMethod::ObjectGetPrototypeOf);
            self.proto_methods
                .push((object_ctor, "getPrototypeOf", getproto));
            let setproto = self.alloc_method(NativeMethod::ObjectSetPrototypeOf);
            self.proto_methods
                .push((object_ctor, "setPrototypeOf", setproto));
        }
        let fp_tostring = self.alloc_method(NativeMethod::FunctionToString);
        self.proto_methods
            .push((func_proto, "toString", fp_tostring));
        let fp_call = self.alloc_method(NativeMethod::FunctionCall);
        self.proto_methods.push((func_proto, "call", fp_call));
        let fp_apply = self.alloc_method(NativeMethod::FunctionApply);
        self.proto_methods.push((func_proto, "apply", fp_apply));
        let fp_bind = self.alloc_method(NativeMethod::FunctionBind);
        self.proto_methods.push((func_proto, "bind", fp_bind));
        // Every Error prototype (base + each subtype) gets `toString`.
        let error_protos: Vec<crate::value::SlotIndex> = {
            let mut v = vec![error_proto];
            for (_, native) in Native::intrinsics() {
                if matches!(
                    native,
                    Native::EvalError
                        | Native::RangeError
                        | Native::ReferenceError
                        | Native::SyntaxError
                        | Native::TypeError
                        | Native::URIError
                        | Native::AggregateError
                ) {
                    if let Some(&c) = self.intrinsics.get(native.display_name()) {
                        if let Some(p) = self.prototype_of(c) {
                            v.push(p);
                        }
                    }
                }
            }
            v
        };
        for p in error_protos {
            let mf = self.alloc_method(NativeMethod::ErrorToString);
            self.proto_methods.push((p, "toString", mf));
        }
        // The inherited Error prototype `name` (per type) and `message` (""
        // on `%Error.prototype%`, inherited by subtypes). Placing `name` on
        // the prototype — not the instance — is what makes `err.name` resolve
        // up the chain while `err.hasOwnProperty('name')` is `false`, as XS.
        self.proto_data
            .push((error_proto, "name", "Error".to_string()));
        self.proto_data
            .push((error_proto, "message", String::new()));
        // `%Error.prototype%`'s `stack` host accessor pair
        // (`fxNextHostAccessorProperty` in `fxBuildError`), installed at
        // link time beside the other native accessors.
        let stack_getter = self.alloc_named_method(NativeMethod::ErrorStackGetter, "get stack", 0);
        let stack_setter = self.alloc_named_method(NativeMethod::ErrorStackSetter, "set stack", 1);
        self.error_stack_accessor = Some((error_proto, stack_getter, stack_setter));
        for (_, native) in Native::intrinsics() {
            if matches!(
                native,
                Native::EvalError
                    | Native::RangeError
                    | Native::ReferenceError
                    | Native::SyntaxError
                    | Native::TypeError
                    | Native::URIError
                    | Native::AggregateError
            ) {
                if let Some(&c) = self.intrinsics.get(native.display_name()) {
                    if let Some(p) = self.prototype_of(c) {
                        self.proto_data
                            .push((p, "name", native.display_name().to_string()));
                    }
                }
            }
        }
        // The well-known symbols: each a fixed `Kind::Symbol` value whose
        // descriptor slot holds its `Symbol.<name>` description, bound as own
        // properties of the `Symbol` constructor at link time.
        for name in [
            "iterator",
            "asyncIterator",
            "hasInstance",
            "isConcatSpreadable",
            "match",
            "matchAll",
            "replace",
            "search",
            "species",
            "split",
            "toPrimitive",
            "toStringTag",
            "unscopables",
            "asyncDispose",
            "dispose",
        ] {
            let desc = self.alloc_str_text(&format!("Symbol.{}", name));
            let d = self
                .slots
                .alloc(Slot::of(Kind::String, Payload::String(desc)));
            let value = Slot::of(Kind::Symbol, Payload::Reference(d));
            self.well_known_symbols.push((name, value));
        }
        // Mint `%Function.prototype%[@@hasInstance]` below `boot_slot_count`
        // so its native identity is reconstructed on resume. Its symbol-keyed
        // property is installed lazily when that well-known key is first used;
        // eagerly interning the key would turn an otherwise-empty persisted
        // symbol-key table into non-canonical state for legacy migrations.
        self.function_has_instance_method =
            self.alloc_named_method(NativeMethod::FunctionHasInstance, "[Symbol.hasInstance]", 1);
        // The wrapper prototypes carry valueOf + toString over the primitive.
        for native in [Native::Boolean, Native::Number, Native::String] {
            if let Some(&c) = self.intrinsics.get(native.display_name()) {
                if let Some(p) = self.prototype_of(c) {
                    if native == Native::String {
                        self.string_proto = p;
                    } else if native == Native::Number {
                        self.number_proto = p;
                    } else if native == Native::Boolean {
                        self.boolean_proto = p;
                    }
                    let v = self.alloc_method(NativeMethod::WrapperValueOf);
                    self.proto_methods.push((p, "valueOf", v));
                    let t = self.alloc_method(NativeMethod::WrapperToString);
                    self.proto_methods.push((p, "toString", t));
                }
            }
        }
        if let Some(&bigint_ctor) = self.intrinsics.get("BigInt") {
            if let Some(proto) = self.prototype_of(bigint_ctor) {
                self.bigint_proto = proto;
                let value_of = self.alloc_method(NativeMethod::BigIntValueOf);
                self.proto_methods.push((proto, "valueOf", value_of));
                let to_string = self.alloc_method(NativeMethod::BigIntToString);
                self.proto_methods.push((proto, "toString", to_string));
                let to_locale_string = self.alloc_named_method(
                    NativeMethod::BigIntToLocaleString,
                    "toLocaleString",
                    0,
                );
                self.proto_methods
                    .push((proto, "toLocaleString", to_locale_string));
            }
            let as_int_n = self.alloc_named_method(NativeMethod::BigIntAsIntN, "asIntN", 2);
            self.proto_methods.push((bigint_ctor, "asIntN", as_int_n));
            let as_uint_n = self.alloc_named_method(NativeMethod::BigIntAsUintN, "asUintN", 2);
            self.proto_methods.push((bigint_ctor, "asUintN", as_uint_n));
        }
        self.create_math();
        self.create_string_proto();
        self.create_number_globals();
        self.create_date();
        self.create_json();
        self.create_atomics();
        self.create_reflect();
        self.create_proxy();
        self.create_eval();
        self.create_intl();
        self.create_temporal();
        self.create_hardened_globals();
        // The test262 `$262` host object is NOT part of the boot: a hardened
        // realm's global surface must be auditable, and a host object
        // carrying an ArrayBuffer-detach primitive is exactly what lockdown
        // exists to keep out of a production machine. The conformance harness installs it explicitly through
        // [`Self::install_test262_host`] before linking.

        // Native function instances must inherit call/apply/bind through
        // Function.prototype just as guest functions do. alloc_method can run
        // before that prototype exists, so boot fixes null prototypes here.
        // Only null prototypes are touched; later guest changes are preserved.
        // This boot pass does not rewrite stored heap records during restore.
        if let Some(fp) = self
            .intrinsics
            .get("Function")
            .copied()
            .and_then(|c| self.prototype_of(c))
        {
            let native_fns: Vec<crate::value::SlotIndex> = self
                .functions
                .iter()
                .filter(|(f, fi)| (fi.method.is_some() || fi.native.is_some()) && **f != fp)
                .map(|(f, _)| *f)
                .collect();
            for f in native_fns {
                let s = self.slots.get_mut(f);
                if let Payload::Reference(p) = s.value {
                    if p.is_null() {
                        s.value = Payload::Reference(fp);
                    }
                }
            }
        }
    }

    fn alloc_named_native(&mut self, native: Native) -> crate::value::SlotIndex {
        let f = self.slots.alloc(Slot::instance(self.function_proto));
        let name = native.display_name();
        let name_chunk = self.alloc_str_text(&name);
        self.functions.insert(
            f,
            FuncInfo {
                native: Some(native),
                name: name.to_string(),
                name_chunk,
                arity: native.arity(),
                ..FuncInfo::default()
            },
        );
        f
    }

    /// Build the ECMA-402 namespace from a frozen in-tree data profile.
    fn create_intl(&mut self) {
        let intl = self.slots.alloc(Slot::instance(self.object_proto));
        self.intl_object = intl;
        self.intrinsics.insert("Intl", intl);

        let locale = self.alloc_named_native(Native::Locale);
        let locale_proto = self.slots.alloc(Slot::instance(self.object_proto));
        self.locale_proto = locale_proto;
        self.ctor_prototype.insert(locale, locale_proto);
        self.proto_methods.push((locale, "prototype", locale_proto));
        self.proto_methods
            .push((locale_proto, "constructor", locale));
        self.proto_methods.push((intl, "Locale", locale));

        let collator = self.alloc_named_native(Native::Collator);
        let collator_proto = self.slots.alloc(Slot::instance(self.object_proto));
        self.collator_proto = collator_proto;
        self.ctor_prototype.insert(collator, collator_proto);
        self.proto_methods
            .push((collator, "prototype", collator_proto));
        self.proto_methods
            .push((collator_proto, "constructor", collator));
        self.proto_methods.push((intl, "Collator", collator));

        for (name, method) in [
            ("getCanonicalLocales", NativeMethod::IntlGetCanonicalLocales),
            ("supportedValuesOf", NativeMethod::IntlSupportedValuesOf),
        ] {
            let f = self.alloc_method(method);
            self.proto_methods.push((intl, name, f));
        }
        let list_format = self.alloc_named_native(Native::ListFormat);
        let list_format_proto = self.slots.alloc(Slot::instance(self.object_proto));
        self.list_format_proto = list_format_proto;
        self.ctor_prototype.insert(list_format, list_format_proto);
        self.proto_methods
            .push((list_format, "prototype", list_format_proto));
        self.proto_methods
            .push((list_format_proto, "constructor", list_format));
        self.proto_methods.push((intl, "ListFormat", list_format));

        let plural_rules = self.alloc_named_native(Native::PluralRules);
        let plural_rules_proto = self.slots.alloc(Slot::instance(self.object_proto));
        self.plural_rules_proto = plural_rules_proto;
        self.ctor_prototype.insert(plural_rules, plural_rules_proto);
        self.proto_methods
            .push((plural_rules, "prototype", plural_rules_proto));
        self.proto_methods
            .push((plural_rules_proto, "constructor", plural_rules));
        self.proto_methods.push((intl, "PluralRules", plural_rules));

        let segmenter = self.alloc_named_native(Native::Segmenter);
        let segmenter_proto = self.slots.alloc(Slot::instance(self.object_proto));
        self.segmenter_proto = segmenter_proto;
        self.ctor_prototype.insert(segmenter, segmenter_proto);
        self.proto_methods
            .push((segmenter, "prototype", segmenter_proto));
        self.proto_methods
            .push((segmenter_proto, "constructor", segmenter));
        self.proto_methods.push((intl, "Segmenter", segmenter));
        // `%Segments.prototype%` and `%SegmentsIterator.prototype%` are
        // anonymous intrinsics reached only through `segment()`; they chain to
        // `%Object.prototype%` (the iterator ultimately to `%IteratorPrototype%`
        // for `[Symbol.iterator]`, installed in `link_intrinsics`).
        let segments_proto = self.slots.alloc(Slot::instance(self.object_proto));
        self.segments_proto = segments_proto;
        let segment_iterator_proto = self.slots.alloc(Slot::instance(self.object_proto));
        self.segment_iterator_proto = segment_iterator_proto;
        self.segments_iterator_method =
            self.alloc_named_method(NativeMethod::SegmentsIterator, "[Symbol.iterator]", 0);
        self.segment_iterator_identity = self.alloc_named_method(
            NativeMethod::SegmentIteratorSymbolIterator,
            "[Symbol.iterator]",
            0,
        );

        let date_time_format = self.alloc_named_native(Native::DateTimeFormat);
        let date_time_format_proto = self.slots.alloc(Slot::instance(self.object_proto));
        self.date_time_format_proto = date_time_format_proto;
        self.ctor_prototype
            .insert(date_time_format, date_time_format_proto);
        self.proto_methods
            .push((date_time_format, "prototype", date_time_format_proto));
        self.proto_methods
            .push((date_time_format_proto, "constructor", date_time_format));
        self.proto_methods
            .push((intl, "DateTimeFormat", date_time_format));

        let number_format = self.alloc_named_native(Native::NumberFormat);
        let number_format_proto = self.slots.alloc(Slot::instance(self.object_proto));
        self.number_format_proto = number_format_proto;
        self.ctor_prototype
            .insert(number_format, number_format_proto);
        self.proto_methods
            .push((number_format, "prototype", number_format_proto));
        self.proto_methods
            .push((number_format_proto, "constructor", number_format));
        self.proto_methods
            .push((intl, "NumberFormat", number_format));

        for ctor in [
            locale,
            collator,
            list_format,
            plural_rules,
            segmenter,
            date_time_format,
            number_format,
        ] {
            let f = self.alloc_named_method(
                NativeMethod::IntlSupportedLocalesOf,
                "supportedLocalesOf",
                1,
            );
            self.proto_methods.push((ctor, "supportedLocalesOf", f));
        }
        for (name, method) in [
            ("toString", NativeMethod::LocaleToString),
            ("maximize", NativeMethod::LocaleMaximize),
            ("minimize", NativeMethod::LocaleMinimize),
        ] {
            let f = self.alloc_method(method);
            self.proto_methods.push((locale_proto, name, f));
        }
        let resolved = self.alloc_method(NativeMethod::CollatorResolvedOptions);
        self.proto_methods
            .push((collator_proto, "resolvedOptions", resolved));
        for (name, method, arity) in [
            ("format", NativeMethod::ListFormatFormat, 1),
            ("formatToParts", NativeMethod::ListFormatFormatToParts, 1),
            (
                "resolvedOptions",
                NativeMethod::ListFormatResolvedOptions,
                0,
            ),
        ] {
            let f = self.alloc_named_method(method, name, arity);
            self.proto_methods.push((list_format_proto, name, f));
        }
        for (name, method, arity) in [
            ("select", NativeMethod::PluralRulesSelect, 1),
            ("selectRange", NativeMethod::PluralRulesSelectRange, 2),
            (
                "resolvedOptions",
                NativeMethod::PluralRulesResolvedOptions,
                0,
            ),
        ] {
            let f = self.alloc_named_method(method, name, arity);
            self.proto_methods.push((plural_rules_proto, name, f));
        }
        for (name, method, arity) in [
            ("segment", NativeMethod::SegmenterSegment, 1),
            ("resolvedOptions", NativeMethod::SegmenterResolvedOptions, 0),
        ] {
            let f = self.alloc_named_method(method, name, arity);
            self.proto_methods.push((segmenter_proto, name, f));
        }
        let containing = self.alloc_named_method(NativeMethod::SegmentsContaining, "containing", 1);
        self.proto_methods
            .push((segments_proto, "containing", containing));
        let seg_next = self.alloc_named_method(NativeMethod::SegmentIteratorNext, "next", 0);
        self.proto_methods
            .push((segment_iterator_proto, "next", seg_next));
        for (name, method, arity) in [
            ("format", NativeMethod::DateTimeFormatFormat, 1),
            (
                "formatToParts",
                NativeMethod::DateTimeFormatFormatToParts,
                1,
            ),
            ("formatRange", NativeMethod::DateTimeFormatFormatRange, 2),
            (
                "formatRangeToParts",
                NativeMethod::DateTimeFormatFormatRangeToParts,
                2,
            ),
            (
                "resolvedOptions",
                NativeMethod::DateTimeFormatResolvedOptions,
                0,
            ),
        ] {
            let f = self.alloc_named_method(method, name, arity);
            self.proto_methods.push((date_time_format_proto, name, f));
        }
        // `format` is an **accessor property** whose getter returns a cached
        // bound function (ECMA-402 `get Intl.NumberFormat.prototype.format`),
        // not a plain method: `getOwnPropertyDescriptor` must report
        // `{get, set: undefined, enumerable: false, configurable: true}` and a
        // `.format` read yields the same length-1 anonymous bound function each
        // time. Installed as a real native accessor via `proto_accessors`.
        let format_getter =
            self.alloc_named_method(NativeMethod::NumberFormatFormatGetter, "get format", 0);
        self.proto_accessors.push((
            number_format_proto,
            ProtoAccessorKey::String("format"),
            format_getter,
            None,
            "NumberFormat",
        ));
        for (name, method, arity) in [
            ("formatToParts", NativeMethod::NumberFormatFormatToParts, 1),
            ("formatRange", NativeMethod::NumberFormatFormatRange, 2),
            (
                "formatRangeToParts",
                NativeMethod::NumberFormatFormatRangeToParts,
                2,
            ),
            (
                "resolvedOptions",
                NativeMethod::NumberFormatResolvedOptions,
                0,
            ),
        ] {
            let f = self.alloc_named_method(method, name, arity);
            self.proto_methods.push((number_format_proto, name, f));
        }
        // Keep the profile version observable to regression tooling without
        // depending on a host database.
        self.proto_data.push((
            intl,
            "__ironhorseDataVersion",
            INTL_DATA_VERSION.to_string(),
        ));
    }

    /// Build the first Temporal intrinsic family.  The namespace and its
    /// constructors are boot objects, while instances are branded by the two
    /// exact side tables above.  Later Temporal families can extend this
    /// namespace without changing the record representation used here.
    fn create_temporal(&mut self) {
        let temporal = self.slots.alloc(Slot::instance(self.object_proto));
        self.temporal_object = temporal;
        self.intrinsics.insert("Temporal", temporal);

        let instant = self.alloc_named_native(Native::TemporalInstant);
        let ip = self.slots.alloc(Slot::instance(self.object_proto));
        self.temporal_instant_proto = ip;
        self.ctor_prototype.insert(instant, ip);
        self.proto_methods.push((instant, "prototype", ip));
        self.proto_methods.push((ip, "constructor", instant));
        self.proto_methods.push((temporal, "Instant", instant));
        for (name, method) in [
            ("from", NativeMethod::TemporalInstantFrom),
            (
                "fromEpochMilliseconds",
                NativeMethod::TemporalInstantFromEpochMilliseconds,
            ),
            (
                "fromEpochNanoseconds",
                NativeMethod::TemporalInstantFromEpochNanoseconds,
            ),
            ("compare", NativeMethod::TemporalInstantCompare),
        ] {
            let f = self.alloc_method(method);
            self.proto_methods.push((instant, name, f));
        }
        for (name, method) in [
            ("add", NativeMethod::TemporalInstantAdd),
            ("subtract", NativeMethod::TemporalInstantSubtract),
            ("until", NativeMethod::TemporalInstantUntil),
            ("since", NativeMethod::TemporalInstantSince),
            ("round", NativeMethod::TemporalInstantRound),
            ("equals", NativeMethod::TemporalInstantEquals),
            ("toString", NativeMethod::TemporalInstantToString),
            ("toJSON", NativeMethod::TemporalInstantToJSON),
            ("valueOf", NativeMethod::TemporalInstantValueOf),
        ] {
            let f = self.alloc_method(method);
            self.proto_methods.push((ip, name, f));
        }

        let duration = self.alloc_named_native(Native::TemporalDuration);
        let dp = self.slots.alloc(Slot::instance(self.object_proto));
        self.temporal_duration_proto = dp;
        self.ctor_prototype.insert(duration, dp);
        self.proto_methods.push((duration, "prototype", dp));
        self.proto_methods.push((dp, "constructor", duration));
        self.proto_methods.push((temporal, "Duration", duration));
        for (name, method) in [
            ("from", NativeMethod::TemporalDurationFrom),
            ("compare", NativeMethod::TemporalDurationCompare),
        ] {
            let f = self.alloc_method(method);
            self.proto_methods.push((duration, name, f));
        }
        for (name, method) in [
            ("with", NativeMethod::TemporalDurationWith),
            ("negated", NativeMethod::TemporalDurationNegated),
            ("abs", NativeMethod::TemporalDurationAbs),
            ("add", NativeMethod::TemporalDurationAdd),
            ("subtract", NativeMethod::TemporalDurationSubtract),
            ("round", NativeMethod::TemporalDurationRound),
            ("total", NativeMethod::TemporalDurationTotal),
            ("toString", NativeMethod::TemporalDurationToString),
            ("toJSON", NativeMethod::TemporalDurationToJSON),
            ("valueOf", NativeMethod::TemporalDurationValueOf),
        ] {
            let f = self.alloc_method(method);
            self.proto_methods.push((dp, name, f));
        }

        // ISO plain Temporal families.  They deliberately share a record and
        // method dispatcher: calendar arithmetic is one set of algorithms,
        // while each public brand exposes only its applicable conversions.
        for kind in 0u8..6 {
            let ctor = self.alloc_named_native(Native::TemporalPlain(kind));
            let proto = self.slots.alloc(Slot::instance(self.object_proto));
            self.temporal_plain_protos[kind as usize] = proto;
            self.ctor_prototype.insert(ctor, proto);
            self.proto_methods.push((ctor, "prototype", proto));
            self.proto_methods.push((proto, "constructor", ctor));
            self.proto_methods
                .push((temporal, TEMPORAL_PLAIN_NAMES[kind as usize], ctor));

            let from = self.alloc_named_method(NativeMethod::TemporalPlain(kind, 0), "from", 1);
            self.proto_methods.push((ctor, "from", from));
            if kind < 5 {
                let compare =
                    self.alloc_named_method(NativeMethod::TemporalPlain(kind, 1), "compare", 2);
                self.proto_methods.push((ctor, "compare", compare));
                for (name, op, arity) in [
                    ("with", 2, 1),
                    ("add", 3, 1),
                    ("subtract", 4, 1),
                    ("until", 5, 1),
                    ("since", 6, 1),
                    ("equals", 7, 1),
                    ("toString", 8, 0),
                    ("toJSON", 9, 0),
                    ("valueOf", 10, 0),
                ] {
                    let f =
                        self.alloc_named_method(NativeMethod::TemporalPlain(kind, op), name, arity);
                    self.proto_methods.push((proto, name, f));
                }
                if kind == 2 {
                    for (name, op) in [("toPlainDate", 11), ("toPlainTime", 12)] {
                        let f =
                            self.alloc_named_method(NativeMethod::TemporalPlain(kind, op), name, 0);
                        self.proto_methods.push((proto, name, f));
                    }
                } else if kind == 0 || kind == 1 {
                    let f = self.alloc_named_method(
                        NativeMethod::TemporalPlain(kind, 13),
                        "toPlainDateTime",
                        1,
                    );
                    self.proto_methods.push((proto, "toPlainDateTime", f));
                }
            } else {
                let to_string =
                    self.alloc_named_method(NativeMethod::TemporalPlain(kind, 8), "toString", 0);
                self.proto_methods.push((proto, "toString", to_string));
            }
        }

        // `Temporal.ZonedDateTime` — an exact instant carried with a fixed-offset
        // zone (see [`TemporalZonedRecord`]).  Its getters are dispatched by name
        // in `GET_PROPERTY`; only the callable statics/methods are bound here.
        let zoned = self.alloc_named_native(Native::TemporalZonedDateTime);
        let zp = self.slots.alloc(Slot::instance(self.object_proto));
        self.temporal_zoned_proto = zp;
        self.ctor_prototype.insert(zoned, zp);
        self.proto_methods.push((zoned, "prototype", zp));
        self.proto_methods.push((zp, "constructor", zoned));
        self.proto_methods.push((temporal, "ZonedDateTime", zoned));
        for (name, op, arity) in [("from", 0u8, 1u32), ("compare", 1, 2)] {
            let f = self.alloc_named_method(NativeMethod::TemporalZoned(op), name, arity);
            self.proto_methods.push((zoned, name, f));
        }
        for (name, op, arity) in [
            ("with", 2u8, 1u32),
            ("add", 3, 1),
            ("subtract", 4, 1),
            ("until", 5, 1),
            ("since", 6, 1),
            ("round", 7, 1),
            ("equals", 8, 1),
            ("startOfDay", 9, 0),
            ("getTimeZoneTransition", 10, 1),
            ("toInstant", 11, 0),
            ("toPlainDate", 12, 0),
            ("toPlainTime", 13, 0),
            ("toPlainDateTime", 14, 0),
            ("withPlainTime", 15, 0),
            ("withTimeZone", 16, 1),
            ("withCalendar", 17, 1),
            ("toString", 18, 0),
            ("toJSON", 19, 0),
            ("toLocaleString", 20, 0),
            ("valueOf", 21, 0),
        ] {
            let f = self.alloc_named_method(NativeMethod::TemporalZoned(op), name, arity);
            self.proto_methods.push((zp, name, f));
        }

        // `Temporal.Now` — a namespace object (like `Atomics`/`Reflect`), not a
        // constructor.  Its clock is a deterministic host hook (a fixed epoch and
        // the `"UTC"` system zone), so every reading is reproducible under the
        // metered VM.
        let now = self.slots.alloc(Slot::instance(self.object_proto));
        self.temporal_now_object = now;
        self.proto_methods.push((temporal, "Now", now));
        for (name, op) in [
            ("instant", 0u8),
            ("timeZoneId", 1),
            ("zonedDateTimeISO", 2),
            ("plainDateISO", 3),
            ("plainDateTimeISO", 4),
            ("plainTimeISO", 5),
        ] {
            let f = self.alloc_named_method(NativeMethod::TemporalNow(op), name, 0);
            self.proto_methods.push((now, name, f));
        }
    }

    /// Build `%eval%` as a special non-constructor native function. It has no
    /// `.prototype`; string-source execution is handled by `XS_CODE_EVAL`,
    /// while an indirect call reaches the same explicit evaluator gap.
    fn create_eval(&mut self) {
        let f = self.slots.alloc(Slot::instance(self.function_proto));
        let name_chunk = self.alloc_str_text("eval");
        self.functions.insert(
            f,
            FuncInfo {
                native: Some(Native::Eval),
                name: "eval".to_string(),
                name_chunk,
                arity: 1,
                ..FuncInfo::default()
            },
        );
        self.intrinsics.insert("eval", f);
    }

    /// Build the `Atomics` namespace object (XS's `mxAtomicsObject`,
    /// `xsAtomics.c`): a boot object chaining to `%Object.prototype%`, carrying
    /// the `Atomics.*` functions as own properties (bound at link time only for
    /// the names the program references). Registered in `intrinsics` under
    /// `"Atomics"` so [`Self::link_intrinsics`] binds it into the global object
    /// like `Math` — not a function, so `typeof Atomics === "object"`.
    fn create_atomics(&mut self) {
        let object_proto = self.object_proto;
        let atomics = self.slots.alloc(Slot::instance(object_proto));
        self.intrinsics.insert("Atomics", atomics);
        // (name, op-code) — the op-code indexes the dispatch in the
        // NativeMethod::Atomic arm.
        for (name, op) in [
            ("add", 0u8),
            ("and", 1),
            ("compareExchange", 2),
            ("exchange", 3),
            ("load", 4),
            ("or", 5),
            ("store", 6),
            ("sub", 7),
            ("xor", 8),
            ("isLockFree", 9),
            ("wait", 10),
            ("notify", 11),
            ("waitAsync", 12),
        ] {
            let mf = self.alloc_method(NativeMethod::Atomic(op));
            self.proto_methods.push((atomics, name, mf));
        }
    }

    /// Build the `Reflect` namespace object (XS's `mxReflectObject`,
    /// `xsProxy.c` `fxBuildReflect`): a boot object chaining to
    /// `%Object.prototype%`, carrying the reflective built-ins the SES shim and
    /// the boot bundles consume as own methods, bound into the global object
    /// under the program-local `Reflect` id at link time only when the program
    /// references the name. Not a function, so `typeof Reflect === "object"`.
    /// The re-entrant `apply`/`construct` are bound too, but self-name an
    /// honest skip on invocation (their spread-argument trampoline metering is
    /// a later increment) — a reference is a NAMED skip rather than a wrong
    /// `Reflect.M is not a function`.
    fn create_reflect(&mut self) {
        let object_proto = self.object_proto;
        let reflect = self.slots.alloc(Slot::instance(object_proto));
        self.intrinsics.insert("Reflect", reflect);
        for (name, m) in [
            ("getPrototypeOf", NativeMethod::ReflectGetPrototypeOf),
            ("setPrototypeOf", NativeMethod::ReflectSetPrototypeOf),
            ("isExtensible", NativeMethod::ReflectIsExtensible),
            ("preventExtensions", NativeMethod::ReflectPreventExtensions),
            (
                "getOwnPropertyDescriptor",
                NativeMethod::ReflectGetOwnPropertyDescriptor,
            ),
            ("defineProperty", NativeMethod::ReflectDefineProperty),
            ("ownKeys", NativeMethod::ReflectOwnKeys),
            ("has", NativeMethod::ReflectHas),
            ("get", NativeMethod::ReflectGet),
            ("set", NativeMethod::ReflectSet),
            ("deleteProperty", NativeMethod::ReflectDeleteProperty),
            ("apply", NativeMethod::ReflectApply),
            ("construct", NativeMethod::ReflectConstruct),
        ] {
            let mf = self.alloc_method(m);
            self.proto_methods.push((reflect, name, mf));
        }
    }

    /// Bind the Hardened-JavaScript global functions (`xsLockdown.c`) the
    /// embedder installs — `harden`/`petrify` — as native function instances in
    /// `intrinsics`, so [`Self::link_intrinsics`] binds them into the global
    /// object under the program-local id the XS compiler assigned each name
    /// (`typeof harden === "function"`). `lockdown` (transitively freezing the
    /// shared intrinsics, taming Date/Math, the idempotence throw) and
    /// `mutabilities` (the `fxVerify*` mutable-residue report) are the reported
    /// scope fold of this child — a program that references either self-names an
    /// honest `Halt::NotImplemented` rather than a wrong value (see their dispatch).
    fn create_hardened_globals(&mut self) {
        for (name, m) in [
            ("harden", NativeMethod::GlobalHarden),
            ("petrify", NativeMethod::GlobalPetrify),
        ] {
            let mf = self.alloc_method(m);
            self.intrinsics.insert(name, mf);
        }
    }

    /// Install the minimal test262 host object (`$262` with
    /// `detachArrayBuffer`) the binary-data conformance tests need. The XS
    /// oracle shim installs the same hook, so assembled tests exercise
    /// detached-buffer semantics on both engines.
    ///
    /// **Harness only.** A default machine has no `$262`: the host object
    /// carries a memory-detach primitive that a hardened realm must not
    /// expose, so `Interp::new` does not build it and only the conformance
    /// harness calls this. Idempotent.
    ///
    /// **Must be called BEFORE [`Self::link_intrinsics`]**, and now
    /// PANICS rather than merely documenting it. The link pass binds the
    /// names a program references by looking each one up in `intrinsics`;
    /// an entry inserted after that pass has run is never consulted
    /// again for the ids it already considered, so an inverted wiring
    /// order produced a machine whose `$262` was silently unreachable —
    /// `typeof $262` answered `"undefined"` on a harness machine, with
    /// no diagnostic and a whole conformance run's worth of wrong
    /// verdicts behind it. The assertion is unconditional: this runs once
    /// per machine at wiring time, and a debug-only check would leave the
    /// release harness — the only caller — unprotected.
    ///
    /// Minted above `boot_slot_count`, so it is a runtime native that no
    /// snapshot carries, and restore boots a default machine that
    /// installs no host. A machine carrying `$262` is therefore refused
    /// by the persist gate ([`Self::stored_unpersistable_row`]) on the
    /// host's PRESENCE — not merely when a guest stores the native — so
    /// "the harness never checkpoints" is enforced rather than assumed.
    /// Both contracts are locked by `tests/test262_host_gate.rs`.
    pub fn install_test262_host(&mut self) {
        if self.intrinsics.contains_key("$262") {
            return;
        }
        // `symbol_names` is empty on a fresh boot and populated by
        // `link_intrinsics` (through `bind_program_symbols`), so it is the
        // machine's "has been linked" signal. A program with NO names
        // leaves it empty after linking, but such a program references no
        // `$262` either, so the proxy never misses a case that matters.
        assert!(
            self.symbol_names.is_empty(),
            "install_test262_host must be called BEFORE link_intrinsics; \
             installing after the link pass leaves `$262` bound to nothing \
             and every conformance test that names it silently wrong"
        );
        let host = self.slots.alloc(Slot::instance(self.object_proto));
        let detach = self.alloc_named_method(
            NativeMethod::Test262DetachArrayBuffer,
            "detachArrayBuffer",
            1,
        );
        self.proto_methods.push((host, "detachArrayBuffer", detach));
        self.intrinsics.insert("$262", host);
    }

    /// Build the `Proxy` constructor (XS's `mxProxyConstructor`, `xsProxy.c`
    /// `fx_Proxy`). Unlike the ordinary intrinsic constructors it is registered
    /// here rather than through the `create_intrinsics` loop, because a proxy
    /// constructor is **special**: it has no `.prototype` property (so the loop's
    /// unconditional `constructor`/`prototype` link pair must not be installed).
    /// It is a callable whose own prototype is `%Function.prototype%`, dispatched
    /// as `Native::Proxy` in `call_native`. `Proxy.revocable` is its lone static.
    fn create_proxy(&mut self) {
        let func_proto = self.function_proto;
        let f = self.slots.alloc(Slot::instance(func_proto));
        let name_chunk = self.alloc_str_text("Proxy");
        self.functions.insert(
            f,
            FuncInfo {
                native: Some(Native::Proxy),
                name: "Proxy".to_string(),
                name_chunk,
                arity: Native::Proxy.arity(),
                ..FuncInfo::default()
            },
        );
        self.intrinsics.insert("Proxy", f);
        let revocable = self.alloc_method(NativeMethod::ProxyRevocable);
        let revocable_name = self.alloc_str_text("revocable");
        self.functions.update(&revocable, |info| {
            info.name = "revocable".to_string();
            info.name_chunk = revocable_name;
            info.arity = 2;
        });
        self.proto_methods.push((f, "revocable", revocable));
    }

    /// Build the `JSON` namespace object (XS's `mxJSONObject`, `xsJSON.c`): a
    /// boot object carrying `parse`/`stringify`, bound into the global object
    /// under the program-local `JSON` id at link time. Not a function, so
    /// `typeof JSON === "object"`.
    fn create_json(&mut self) {
        let object_proto = self.object_proto;
        let json = self.slots.alloc(Slot::instance(object_proto));
        self.intrinsics.insert("JSON", json);
        for (name, m, arity) in [
            ("stringify", NativeMethod::JsonStringify, 3),
            ("parse", NativeMethod::JsonParse, 2),
        ] {
            let mf = self.alloc_named_method(m, name, arity);
            self.proto_methods.push((json, name, mf));
        }
    }

    /// Register the `Number` statics + `Number.prototype.toString` and the
    /// numeric global functions (`parseInt`/`parseFloat`/`isNaN`/`isFinite`),
    /// each bound at link time only for the names the program references.
    fn create_number_globals(&mut self) {
        // `Number.isFinite`/`isInteger`/`isNaN`/`isSafeInteger` — statics on
        // the constructor instance; the numeric constants — its data props.
        if let Some(&ctor) = self.intrinsics.get("Number") {
            for (name, m) in [
                ("isFinite", NativeMethod::NumberIsFinite),
                ("isInteger", NativeMethod::NumberIsInteger),
                ("isNaN", NativeMethod::NumberIsNaN),
                ("isSafeInteger", NativeMethod::NumberIsSafeInteger),
            ] {
                let mf = self.alloc_method(m);
                self.proto_methods.push((ctor, name, mf));
            }
            for (name, v) in [
                ("EPSILON", f64::EPSILON),
                ("MAX_SAFE_INTEGER", 9007199254740991.0),
                ("MAX_VALUE", f64::MAX),
                ("MIN_SAFE_INTEGER", -9007199254740991.0),
                // The smallest positive value — the denormal 5e-324
                // (`Number.MIN_VALUE`), not the smallest *normal*
                // (`f64::MIN_POSITIVE`).
                ("MIN_VALUE", f64::from_bits(1)),
                ("NaN", f64::NAN),
                ("NEGATIVE_INFINITY", f64::NEG_INFINITY),
                ("POSITIVE_INFINITY", f64::INFINITY),
            ] {
                self.proto_value_data.push((ctor, name, Slot::number(v)));
            }
        }
        // `Number.prototype.toString` (radix-aware) overrides the wrapper's
        // plain `toString` on `%Number.prototype%`; a later push wins the
        // link-time set, so this must follow the wrapper registration.
        if !self.number_proto.is_null() {
            let mf = self.alloc_method(NativeMethod::NumberToString);
            self.proto_methods.push((self.number_proto, "toString", mf));
            let to_locale_string =
                self.alloc_named_method(NativeMethod::NumberToLocaleString, "toLocaleString", 0);
            self.proto_methods
                .push((self.number_proto, "toLocaleString", to_locale_string));
        }
        // The numeric global functions, bound into the global object by name
        // (a native function instance, so `typeof parseInt === "function"`).
        for (name, m) in [
            ("parseInt", NativeMethod::GlobalParseInt),
            ("parseFloat", NativeMethod::GlobalParseFloat),
            ("isNaN", NativeMethod::GlobalIsNaN),
            ("isFinite", NativeMethod::GlobalIsFinite),
        ] {
            let mf = self.alloc_method(m);
            self.intrinsics.insert(name, mf);
            // `Number.parseInt` and `Number.parseFloat` are aliases of the
            // corresponding global functions, including function identity.
            if matches!(name, "parseInt" | "parseFloat") {
                if let Some(&ctor) = self.intrinsics.get("Number") {
                    self.proto_methods.push((ctor, name, mf));
                }
            }
        }
    }

    /// Register the `Date` statics and the bounded, deterministic UTC profile
    /// of `%Date.prototype%`. The embedding supplies no time-zone database;
    /// local-time operations therefore use UTC, matching the engine's existing
    /// deterministic Intl/Temporal host profile.
    fn create_date(&mut self) {
        let Some(&ctor) = self.intrinsics.get("Date") else {
            return;
        };
        let Some(proto) = self.prototype_of(ctor) else {
            return;
        };
        self.date_proto = proto;
        for (name, op, arity) in [("parse", 0u8, 1u32), ("UTC", 1, 7), ("now", 2, 0)] {
            let f = self.alloc_named_method(NativeMethod::Date(op), name, arity);
            self.proto_methods.push((ctor, name, f));
        }
        for (name, op, arity) in [
            ("getTime", 10u8, 0u32),
            ("valueOf", 11, 0),
            ("getFullYear", 12, 0),
            ("getUTCFullYear", 12, 0),
            ("getMonth", 13, 0),
            ("getUTCMonth", 13, 0),
            ("getDate", 14, 0),
            ("getUTCDate", 14, 0),
            ("getDay", 15, 0),
            ("getUTCDay", 15, 0),
            ("getHours", 16, 0),
            ("getUTCHours", 16, 0),
            ("getMinutes", 17, 0),
            ("getUTCMinutes", 17, 0),
            ("getSeconds", 18, 0),
            ("getUTCSeconds", 18, 0),
            ("getMilliseconds", 19, 0),
            ("getUTCMilliseconds", 19, 0),
            ("getTimezoneOffset", 20, 0),
            ("toISOString", 21, 0),
            ("toUTCString", 22, 0),
            ("toGMTString", 22, 0),
            ("toString", 23, 0),
            ("toDateString", 24, 0),
            ("toTimeString", 25, 0),
            ("toLocaleString", 23, 0),
            ("toLocaleDateString", 24, 0),
            ("toLocaleTimeString", 25, 0),
            ("setTime", 26, 1),
            ("toJSON", 27, 1),
            ("setMilliseconds", 28, 1),
            ("setUTCMilliseconds", 28, 1),
            ("setSeconds", 29, 2),
            ("setUTCSeconds", 29, 2),
            ("setMinutes", 30, 3),
            ("setUTCMinutes", 30, 3),
            ("setHours", 31, 4),
            ("setUTCHours", 31, 4),
            ("setDate", 32, 1),
            ("setUTCDate", 32, 1),
            ("setMonth", 33, 2),
            ("setUTCMonth", 33, 2),
            ("setFullYear", 34, 3),
            ("setUTCFullYear", 34, 3),
        ] {
            let f = self.alloc_named_method(NativeMethod::Date(op), name, arity);
            self.proto_methods.push((proto, name, f));
        }
        // The symbol-key id is minted lazily, but this identity belongs to the
        // realm's boot graph so snapshots can rederive it at the same slot.
        self.date_to_primitive_method =
            self.alloc_named_method(NativeMethod::DateToPrimitive, "[Symbol.toPrimitive]", 1);
    }

    /// Register the modeled `String.prototype` methods (`xsString.c`) on
    /// `%String.prototype%`, bound at link time only for the names the program
    /// references. A primitive string's method access boxes to this prototype
    /// (see the `GET_PROPERTY` primitive-string route).
    fn create_string_proto(&mut self) {
        let p = self.string_proto;
        if p.is_null() {
            return;
        }
        use NativeMethod::*;
        self.string_iterator_method =
            self.alloc_named_method(StringIterator, "[Symbol.iterator]", 0);
        if let Some(&ctor) = self.intrinsics.get("String") {
            for (name, arity, m) in [
                ("fromCharCode", 1, StringFromCharCode),
                ("fromCodePoint", 1, StringFromCodePoint),
                ("raw", 1, StringRaw),
            ] {
                let mf = self.alloc_named_method(m, name, arity);
                self.proto_methods.push((ctor, name, mf));
            }
        }
        for (name, arity, m) in [
            ("charCodeAt", 1, StringCharCodeAt),
            ("codePointAt", 1, StringCodePointAt),
            ("charAt", 1, StringCharAt),
            ("at", 1, StringAt),
            ("slice", 2, StringSlice),
            ("substring", 2, StringSubstring),
            ("indexOf", 1, StringIndexOf),
            ("lastIndexOf", 1, StringLastIndexOf),
            ("includes", 1, StringIncludes),
            ("startsWith", 1, StringStartsWith),
            ("endsWith", 1, StringEndsWith),
            ("concat", 1, StringConcat),
            ("toLowerCase", 0, StringToLowerCase),
            ("toUpperCase", 0, StringToUpperCase),
            ("toLocaleLowerCase", 0, StringToLocaleLowerCase),
            ("toLocaleUpperCase", 0, StringToLocaleUpperCase),
            ("localeCompare", 1, StringLocaleCompare),
            ("normalize", 0, StringNormalize),
            ("repeat", 1, StringRepeat),
            ("trim", 0, StringTrim),
            ("padStart", 1, StringPadStart),
            ("padEnd", 1, StringPadEnd),
            ("isWellFormed", 0, StringIsWellFormed),
            ("toWellFormed", 0, StringToWellFormed),
            // The RegExp-consuming String methods (`xsString.c`
            // `fx_String_prototype_match`/`search`/`replace`/`split`), driving
            // `ironhorse_regexp` over a string-or-RegExp argument.
            ("match", 1, StringMatch),
            ("matchAll", 1, StringMatchAll),
            ("search", 1, StringSearch),
            ("replace", 2, StringReplace),
            ("replaceAll", 2, StringReplaceAll),
            ("split", 2, StringSplit),
        ] {
            let mf = self.alloc_named_method(m, name, arity);
            self.proto_methods.push((p, name, mf));
        }
        // `trimStart`/`trimEnd` and their Annex-B references
        // `trimLeft`/`trimRight` are the SAME function object per pair
        // (`String.prototype.trimLeft` IS `String.prototype.trimStart`, and
        // likewise for `trimRight`/`trimEnd`), so a single allocation is bound
        // under both keys — `Set.prototype.keys`/`values`-style aliasing. The
        // shared object carries the canonical `.name` (`"trimStart"`/`"trimEnd"`)
        // and arity 0, so `String.prototype.trimLeft.name === "trimStart"`
        // (annexB `.../trimLeft/name.js`) and the identity check
        // (`.../trimLeft/reference-trimStart.js`) both hold.
        for (canonical, alias, m) in [
            ("trimStart", "trimLeft", StringTrimStart),
            ("trimEnd", "trimRight", StringTrimEnd),
        ] {
            let mf = self.alloc_named_method(m, canonical, 0);
            self.proto_methods.push((p, canonical, mf));
            self.proto_methods.push((p, alias, mf));
        }
    }

    /// Build the `Math` namespace object (XS's `mxMathObject`, `xsMath.c`):
    /// a boot object chaining to `%Object.prototype%`, carrying every
    /// `Math.*` function and numeric constant as own properties (bound at
    /// link time only for the names the program references). Registered in
    /// `intrinsics` under `"Math"` so [`Self::link_intrinsics`] binds it into
    /// the global object like a constructor — but it is not a function, so
    /// `typeof Math === "object"`.
    fn create_math(&mut self) {
        let object_proto = self.object_proto;
        let math = self.slots.alloc(Slot::instance(object_proto));
        self.math_object = math;
        self.intrinsics.insert("Math", math);
        use MathId::*;
        for (name, id) in [
            ("abs", Abs),
            ("acos", Acos),
            ("acosh", Acosh),
            ("asin", Asin),
            ("asinh", Asinh),
            ("atan", Atan),
            ("atanh", Atanh),
            ("atan2", Atan2),
            ("cbrt", Cbrt),
            ("ceil", Ceil),
            ("clz32", Clz32),
            ("cos", Cos),
            ("cosh", Cosh),
            ("exp", Exp),
            ("expm1", Expm1),
            ("floor", Floor),
            ("fround", Fround),
            ("hypot", Hypot),
            ("imul", Imul),
            ("log", Log),
            ("log1p", Log1p),
            ("log10", Log10),
            ("log2", Log2),
            ("max", Max),
            ("min", Min),
            ("pow", Pow),
            ("round", Round),
            ("sign", Sign),
            ("sin", Sin),
            ("sinh", Sinh),
            ("sqrt", Sqrt),
            ("tan", Tan),
            ("tanh", Tanh),
            ("trunc", Trunc),
        ] {
            let mf = self.alloc_method(NativeMethod::Math(id));
            self.proto_methods.push((math, name, mf));
        }
        // The numeric constants (`fxNextNumberProperty`, XS's `C_M_*`): the
        // exact IEEE doubles from `math.h`, reproduced by Rust's
        // `std::f64::consts` (identical bit patterns).
        for (name, v) in [
            ("E", std::f64::consts::E),
            ("LN10", std::f64::consts::LN_10),
            ("LN2", std::f64::consts::LN_2),
            ("LOG10E", std::f64::consts::LOG10_E),
            ("LOG2E", std::f64::consts::LOG2_E),
            ("PI", std::f64::consts::PI),
            ("SQRT1_2", std::f64::consts::FRAC_1_SQRT_2),
            ("SQRT2", std::f64::consts::SQRT_2),
        ] {
            self.proto_value_data.push((math, name, Slot::number(v)));
        }
    }

    /// Allocate a native prototype-method function instance. Native methods
    /// are ordinary callable objects, so they inherit `%Function.prototype%`;
    /// test262's property helpers rely on that when they capture uncurried
    /// primordials with `Function.prototype.call.bind(nativeMethod)`.
    pub(super) fn alloc_method(&mut self, m: NativeMethod) -> crate::value::SlotIndex {
        let f = self.slots.alloc(Slot::instance(self.function_proto));
        let name_chunk = self.alloc_str_text("");
        self.functions.insert(
            f,
            FuncInfo {
                method: Some(m),
                name_chunk,
                ..FuncInfo::default()
            },
        );
        f
    }

    /// Like [`Self::alloc_method`] but with the specified `name` and `length`
    /// (arity), so the method's `.name`/`.length` own data properties match the
    /// specification — `verifyProperty`/`propertyHelper` reads these from
    /// [`FuncInfo`].
    pub(super) fn alloc_named_method(
        &mut self,
        m: NativeMethod,
        name: &str,
        arity: u32,
    ) -> crate::value::SlotIndex {
        let f = self.slots.alloc(Slot::instance(self.function_proto));
        let name_chunk = self.alloc_str_text(&name);
        self.functions.insert(
            f,
            FuncInfo {
                method: Some(m),
                name_chunk,
                arity,
                ..FuncInfo::default()
            },
        );
        f
    }
}
