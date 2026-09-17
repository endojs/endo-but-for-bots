//! Derived closure-site allocation templates.
//!
//! A template contains only fixed slot shapes and bytecode metadata. Every
//! arena reference is patched after the fragment is copied, so this cache is
//! neither a GC root nor snapshot state. Free-list reuse, an interrupt point
//! inside the sequence, malformed sequence state, or disabled templates leave
//! the scalar opcode handlers authoritative.

use super::*;

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub(super) enum ClosureFunctionKind {
    Constructor,
    Function,
    Generator,
    Asynchronous,
    AsynchronousGenerator,
}

impl ClosureFunctionKind {
    fn from_opcode(opcode: Opcode) -> Option<Self> {
        Some(match opcode {
            Opcode::XS_CODE_CONSTRUCTOR_FUNCTION => Self::Constructor,
            Opcode::XS_CODE_FUNCTION => Self::Function,
            Opcode::XS_CODE_GENERATOR_FUNCTION => Self::Generator,
            Opcode::XS_CODE_ASYNC_FUNCTION => Self::Asynchronous,
            Opcode::XS_CODE_ASYNC_GENERATOR_FUNCTION => Self::AsynchronousGenerator,
            _ => return None,
        })
    }

    fn retains_default_prototype(self) -> bool {
        matches!(
            self,
            Self::Constructor | Self::Generator | Self::AsynchronousGenerator
        )
    }

    fn installs_prototype_property(self) -> bool {
        self.retains_default_prototype()
    }

    fn is_generator(self) -> bool {
        matches!(self, Self::Generator | Self::AsynchronousGenerator)
    }
}

#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct ClosureSiteKey {
    segment: usize,
    definition_offset: usize,
    function_kind: ClosureFunctionKind,
    constructor_key: Option<u16>,
    prototype_key: Option<u16>,
}

#[derive(Clone, Debug)]
pub(super) enum ClosureSiteTemplateEntry {
    Template(std::rc::Rc<ClosureSiteTemplate>),
    Unsupported,
}

#[derive(Clone, Debug)]
pub(super) struct ClosureSiteTemplate {
    records: std::rc::Rc<[Slot]>,
    function_kind: ClosureFunctionKind,
    function_relative: u32,
    default_prototype_relative: u32,
    constructor_property_relative: Option<u32>,
    function_prototype_property_relative: Option<u32>,
    environment_relative: u32,
    behavior_relative: u32,
    first_capture_relative: Option<u32>,
    capture_indices: std::rc::Rc<[usize]>,
    code_offset: usize,
    environment_offset: usize,
    body_start: usize,
    body_length: usize,
    arity: u32,
    local_count: usize,
    remaining_dispatches: u64,
}

#[derive(Clone, Debug)]
pub(super) struct ActiveClosureAllocation {
    environment: crate::value::SlotIndex,
    first_capture: Option<crate::value::SlotIndex>,
    capture_indices: std::rc::Rc<[usize]>,
    next_capture: usize,
    code_offset: usize,
    environment_offset: usize,
    body_start: usize,
    body_length: usize,
    arity: u32,
    local_count: usize,
}

/// Diagnostic counters used by the differential, fallback, and restore locks.
#[doc(hidden)]
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct ClosureTemplateStatistics {
    pub derived_sites: u64,
    pub template_allocations: u64,
    pub scalar_fallbacks: u64,
}

impl ClosureSiteTemplate {
    fn derive(
        code: &[u8],
        definition_offset: usize,
        function_kind: ClosureFunctionKind,
        constructor_key: Option<u16>,
        prototype_key: Option<u16>,
    ) -> Option<Self> {
        let definition_length = crate::opcode::instruction_len(code, definition_offset)?;
        let code_offset = definition_offset.checked_add(definition_length)?;
        let code_opcode = Opcode::from_u8(*code.get(code_offset)?)?;
        let body_length = match code_opcode {
            Opcode::XS_CODE_CODE_1 => *code.get(code_offset + 1)? as usize,
            Opcode::XS_CODE_CODE_2 => {
                u16::from_le_bytes([*code.get(code_offset + 1)?, *code.get(code_offset + 2)?])
                    as usize
            }
            Opcode::XS_CODE_CODE_4 => u32::from_le_bytes([
                *code.get(code_offset + 1)?,
                *code.get(code_offset + 2)?,
                *code.get(code_offset + 3)?,
                *code.get(code_offset + 4)?,
            ]) as usize,
            _ => return None,
        };
        let code_header_length = usize::try_from(code_opcode.size()).ok()?;
        let body_start = code_offset.checked_add(code_header_length)?;
        let environment_offset = body_start.checked_add(body_length)?;
        if Opcode::from_u8(*code.get(environment_offset)?)? != Opcode::XS_CODE_FUNCTION_ENVIRONMENT
        {
            return None;
        }

        let mut cursor = environment_offset.checked_add(1)?;
        let mut capture_indices = Vec::new();
        loop {
            let opcode = Opcode::from_u8(*code.get(cursor)?)?;
            let capture_index = match opcode {
                Opcode::XS_CODE_STORE_1 => *code.get(cursor + 1)? as usize,
                Opcode::XS_CODE_STORE_2 => {
                    u16::from_le_bytes([*code.get(cursor + 1)?, *code.get(cursor + 2)?]) as usize
                }
                Opcode::XS_CODE_POP => break,
                _ => return None,
            };
            capture_indices.push(capture_index);
            cursor = cursor.checked_add(crate::opcode::instruction_len(code, cursor)?)?;
        }

        let mut records = Vec::with_capacity(6 + capture_indices.len());
        let function_relative = records.len() as u32;
        records.push(Slot::instance(crate::value::SlotIndex::NULL));
        let default_prototype_relative = records.len() as u32;
        records.push(Slot::instance(crate::value::SlotIndex::NULL));
        let constructor_property_relative = constructor_key.map(|key| {
            let relative = records.len() as u32;
            let mut property = Slot::of(
                Kind::Reference,
                Payload::Reference(crate::value::SlotIndex::NULL),
            );
            property.id = key;
            property.flag = XS_DONT_ENUM_FLAG;
            records.push(property);
            relative
        });
        let function_prototype_property_relative = function_kind
            .installs_prototype_property()
            .then_some(prototype_key)
            .flatten()
            .map(|key| {
                let relative = records.len() as u32;
                let mut property = Slot::of(
                    Kind::Reference,
                    Payload::Reference(crate::value::SlotIndex::NULL),
                );
                property.id = key;
                property.flag = XS_DONT_ENUM_FLAG | XS_DONT_DELETE_FLAG;
                records.push(property);
                relative
            });
        let environment_relative = records.len() as u32;
        records.push(Slot::instance(crate::value::SlotIndex::NULL));
        let behavior_relative = records.len() as u32;
        records.push(Slot::uninitialized());
        let first_capture_relative = (!capture_indices.is_empty()).then_some(records.len() as u32);
        records.extend(std::iter::repeat_n(
            Slot::undefined(),
            capture_indices.len(),
        ));

        let capture_count = capture_indices.len();
        Some(Self {
            records: records.into(),
            function_kind,
            function_relative,
            default_prototype_relative,
            constructor_property_relative,
            function_prototype_property_relative,
            environment_relative,
            behavior_relative,
            first_capture_relative,
            capture_indices: capture_indices.into(),
            code_offset,
            environment_offset,
            body_start,
            body_length,
            arity: code.get(body_start + 1).copied().unwrap_or(0) as u32,
            local_count: count_new_locals(code, body_start, body_length),
            remaining_dispatches: 3 + u64::try_from(capture_count).ok()?,
        })
    }
}

impl Interp {
    fn closure_site_template(
        &mut self,
        code: &[u8],
        definition_offset: usize,
        opcode: Opcode,
    ) -> Option<std::rc::Rc<ClosureSiteTemplate>> {
        let function_kind = ClosureFunctionKind::from_opcode(opcode)?;
        let segment = self.ensure_active_code_segment(code);
        let key = ClosureSiteKey {
            segment,
            definition_offset,
            function_kind,
            constructor_key: self.constructor_id,
            prototype_key: self.prototype_key_id,
        };
        if let Some(entry) = self.closure_site_templates.get(&key) {
            return match entry {
                ClosureSiteTemplateEntry::Template(template) => Some(template.clone()),
                ClosureSiteTemplateEntry::Unsupported => None,
            };
        }
        let entry = match ClosureSiteTemplate::derive(
            code,
            definition_offset,
            function_kind,
            self.constructor_id,
            self.prototype_key_id,
        ) {
            Some(template) => {
                self.closure_template_statistics.derived_sites += 1;
                ClosureSiteTemplateEntry::Template(std::rc::Rc::new(template))
            }
            None => ClosureSiteTemplateEntry::Unsupported,
        };
        let result = match &entry {
            ClosureSiteTemplateEntry::Template(template) => Some(template.clone()),
            ClosureSiteTemplateEntry::Unsupported => None,
        };
        self.closure_site_templates.insert(key, entry);
        result
    }

    pub(super) fn allocate_closure_site_template(
        &mut self,
        code: &[u8],
        definition_offset: usize,
        opcode: Opcode,
        name: u16,
    ) -> Option<crate::value::SlotIndex> {
        if !self.closure_templates_enabled || self.active_closure_allocation.is_some() {
            return None;
        }
        let template = self.closure_site_template(code, definition_offset, opcode)?;
        if template
            .capture_indices
            .iter()
            .any(|&capture| self.local_index(capture).is_none())
        {
            self.closure_template_statistics.scalar_fallbacks += 1;
            return None;
        }
        let dispatched_remainder = self.n_dispatched % 4096;
        let dispatches_until_check = if dispatched_remainder == 0 {
            0
        } else {
            4096 - dispatched_remainder
        };
        let dispatches_until_limit = self.step_limit.saturating_sub(self.n_dispatched);
        if template.remaining_dispatches > dispatches_until_check
            || template.remaining_dispatches > dispatches_until_limit
        {
            self.closure_template_statistics.scalar_fallbacks += 1;
            return None;
        }
        let Some(start) = self.slots.allocate_tail_fragment(&template.records) else {
            self.closure_template_statistics.scalar_fallbacks += 1;
            return None;
        };
        let at = |relative: u32| crate::value::SlotIndex(start.0 + relative);
        let function = at(template.function_relative);
        let default_prototype = at(template.default_prototype_relative);
        let environment = at(template.environment_relative);
        let behavior = at(template.behavior_relative);
        let first_capture = template.first_capture_relative.map(at);

        let function_prototype = match template.function_kind {
            ClosureFunctionKind::Generator => self.generator_function_proto,
            ClosureFunctionKind::Asynchronous => self.async_function_proto,
            ClosureFunctionKind::AsynchronousGenerator => self.async_generator_function_proto,
            ClosureFunctionKind::Constructor | ClosureFunctionKind::Function => self.function_proto,
        };
        let default_prototype_parent = match template.function_kind {
            ClosureFunctionKind::Generator => self.generator_proto,
            ClosureFunctionKind::AsynchronousGenerator => self.async_generator_proto,
            ClosureFunctionKind::Constructor
            | ClosureFunctionKind::Function
            | ClosureFunctionKind::Asynchronous => self.object_proto,
        };
        self.slots.get_mut(function).value = Payload::Reference(function_prototype);
        self.slots.get_mut(default_prototype).value = Payload::Reference(default_prototype_parent);
        if let Some(relative) = template.constructor_property_relative {
            let property = at(relative);
            self.slots.get_mut(default_prototype).next = property;
            self.slots.get_mut(property).value = Payload::Reference(function);
        }
        if let Some(relative) = template.function_prototype_property_relative {
            let property = at(relative);
            self.slots.get_mut(function).next = property;
            self.slots.get_mut(property).value = Payload::Reference(default_prototype);
        }
        let enclosing_environment = if self.env.kind == Kind::Reference {
            match self.env.value {
                Payload::Reference(reference) => reference,
                _ => crate::value::SlotIndex::NULL,
            }
        } else {
            crate::value::SlotIndex::NULL
        };
        self.slots.get_mut(environment).value = Payload::Reference(enclosing_environment);
        self.slots.get_mut(environment).next = behavior;
        self.slots.get_mut(behavior).next = first_capture.unwrap_or(crate::value::SlotIndex::NULL);

        self.meter.tick_raw(FUNCTION_DEFINE_METERING);
        if name != crate::value::XS_NO_ID {
            self.meter.tick_builtin_some(2);
        }
        if template.function_kind.is_generator() {
            self.meter.tick_raw(GENERATOR_FUNCTION_EXTRA_METERING);
        } else if template.function_kind == ClosureFunctionKind::Asynchronous {
            self.meter.untick_raw(ASYNC_FUNCTION_DEFINE_DELTA);
        }
        let function_name = if name != crate::value::XS_NO_ID {
            self.symbol_names
                .get(name as usize - 1)
                .cloned()
                .unwrap_or_default()
        } else {
            SymbolName::default()
        };
        let name_chunk = self.chunks.alloc(&units_to_be16(&function_name.to_units()));
        let global_environment = self.capture_global_environment();
        self.functions.insert(
            function,
            FuncInfo {
                global_env: global_environment,
                body_start: Some(template.body_start),
                body_len: template.body_length,
                closures: environment,
                name: function_name.to_string(),
                arity: template.arity,
                name_chunk,
                is_generator: template.function_kind.is_generator(),
                ..FuncInfo::default()
            },
        );
        if template.function_kind.retains_default_prototype() {
            self.ctor_prototype.insert(function, default_prototype);
        }
        let segment = self
            .active_segment
            .expect("closure template owns a segment");
        self.func_segments.insert(function, segment);
        self.active_closure_allocation = Some(ActiveClosureAllocation {
            environment,
            first_capture,
            capture_indices: template.capture_indices.clone(),
            next_capture: 0,
            code_offset: template.code_offset,
            environment_offset: template.environment_offset,
            body_start: template.body_start,
            body_length: template.body_length,
            arity: template.arity,
            local_count: template.local_count,
        });
        self.closure_template_statistics.template_allocations += 1;
        Some(function)
    }

    pub(super) fn active_closure_code(
        &self,
        code_offset: usize,
    ) -> Option<(usize, usize, u32, usize)> {
        let active = self.active_closure_allocation.as_ref()?;
        (active.code_offset == code_offset).then_some((
            active.body_start,
            active.body_length,
            active.arity,
            active.local_count,
        ))
    }

    pub(super) fn allocate_active_closure_environment(
        &mut self,
        environment_offset: usize,
    ) -> Option<crate::value::SlotIndex> {
        let active = self.active_closure_allocation.as_ref()?;
        if active.environment_offset != environment_offset {
            return None;
        }
        let environment = active.environment;
        let has_captures = !active.capture_indices.is_empty();
        self.meter.tick_raw(FUNCTION_ENVIRONMENT_METERING);
        if !has_captures {
            self.active_closure_allocation = None;
        }
        Some(environment)
    }

    pub(super) fn store_active_closure(
        &mut self,
        capture_index: usize,
    ) -> Option<Result<(), Step>> {
        let active = self.active_closure_allocation.as_ref()?;
        let expected = active.capture_indices.get(active.next_capture).copied();
        if expected != Some(capture_index) {
            return Some(Err(Step::Host(Halt::EngineInvariant(
                "closure-template:capture-sequence",
            ))));
        }
        let local_index = match self.local_index(capture_index) {
            Some(index) => index,
            None => {
                return Some(Err(Step::Host(Halt::EngineInvariant(
                    "closure-template:capture-index",
                ))))
            }
        };
        let source = self.locals[local_index];
        let first_capture = active.first_capture.expect("template capture start");
        let current_capture = active.next_capture;
        let capture_count = active.capture_indices.len();
        let target = crate::value::SlotIndex(first_capture.0 + current_capture as u32);
        let next_capture = current_capture + 1;
        let next = if next_capture < capture_count {
            crate::value::SlotIndex(first_capture.0 + next_capture as u32)
        } else {
            crate::value::SlotIndex::NULL
        };
        self.meter.tick_slot_alloc();
        let mut stored = Slot::of(source.kind, source.value);
        stored.id = source.id;
        stored.flag = source.flag;
        stored.next = next;
        *self.slots.get_mut(target) = stored;
        if next_capture == capture_count {
            self.active_closure_allocation = None;
        } else if let Some(active) = self.active_closure_allocation.as_mut() {
            active.next_capture = next_capture;
        }
        Some(Ok(()))
    }

    /// Disable the optimization while retaining the scalar allocator as a
    /// differential oracle. This hook is intentionally hidden from ordinary
    /// embedders; tests use it to compare complete machine outcomes.
    #[doc(hidden)]
    pub fn set_closure_templates_enabled(&mut self, enabled: bool) {
        self.closure_templates_enabled = enabled;
        self.active_closure_allocation = None;
    }

    #[doc(hidden)]
    pub fn closure_template_statistics(&self) -> ClosureTemplateStatistics {
        self.closure_template_statistics
    }
}
