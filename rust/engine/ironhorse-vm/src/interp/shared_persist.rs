//! Shared Realm snapshot capture and transactional context restoration.
use super::persist::validate_restore_chain;
use super::*;

impl Interp {
    pub(super) fn snapshot_combinator_map(&self) -> std::collections::BTreeMap<u32, u32> {
        self.promises
            .values()
            .flat_map(|p| p.reactions.iter())
            .chain(self.promise_jobs.iter().filter_map(|job| match job {
                PromiseJob::Reaction { reaction, .. } => Some(reaction),
                _ => None,
            }))
            .filter_map(|r| match r.kind {
                ReactionKind::Combine(i, _) | ReactionKind::CombineDirect(i, _) => Some(i),
                _ => None,
            })
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .enumerate()
            .map(|(n, i)| (i, n as u32))
            .collect()
    }

    pub(super) fn shared_machine_snapshot(&self) -> Option<SharedMachineSnapshot> {
        if !self.shared_compartments {
            return None;
        }
        let comb = self.snapshot_combinator_map();
        let mut environments: Vec<_> = std::iter::once(&self.environment)
            .chain(self.inactive_environments.values())
            .map(|env| EnvironmentRow {
                global: env.global_obj.0,
                binding_names: env.binding_names.iter().copied().collect(),
                modules: env.modules.borrow().snapshot(),
                host_owned: env.owner.as_ref().is_some_and(|w| w.strong_count() != 0),
                compiler_required: env.compiler_required,
                unhandled_rejection: env.unhandled_rejection.map(|p| p.0),
            })
            .collect();
        environments.sort_by_key(|e| e.global);
        let sorted = |mut rows: Vec<(u32, u32)>| {
            rows.sort_unstable();
            rows
        };
        let mut evaluators: Vec<_> = self
            .functions
            .iter()
            .filter_map(|(owner, info)| {
                if owner.0 < self.boot_slot_count {
                    return None;
                }
                let kind = match info.native {
                    Some(Native::Eval) => 0,
                    Some(Native::Function) => 1,
                    _ => return None,
                };
                Some(EvaluatorRow {
                    owner: owner.0,
                    kind,
                    name_chunk: info.name_chunk.0,
                })
            })
            .collect();
        evaluators.sort_by_key(|r| r.owner);
        let mut roots: Vec<_> = self
            .identity_roots
            .iter()
            .filter(|(_, w)| w.strong_count() != 0)
            .map(|(i, _)| i.0)
            .collect();
        roots.sort_unstable();
        Some(SharedMachineSnapshot {
            default_global: self.realm.global_object().0,
            current_global: self.environment.global_obj.0,
            intrinsic_roots: self.realm.intrinsics().roots.iter().map(|r| r.0).collect(),
            environments,
            function_environments: sorted(
                self.functions
                    .iter()
                    .filter(|(_, i)| !i.global_env.is_null())
                    .map(|(o, i)| (o.0, i.global_env.0))
                    .collect(),
            ),
            generator_environments: sorted(
                self.generators
                    .iter()
                    .filter_map(|(o, g)| g.frame.as_ref().map(|f| (o.0, f.global_env.0)))
                    .collect(),
            ),
            async_environments: sorted(
                self.async_instances
                    .iter()
                    .filter_map(|(o, g)| g.frame.as_ref().map(|f| (o.0, f.global_env.0)))
                    .collect(),
            ),
            promise_environments: sorted(
                self.promises
                    .iter()
                    .map(|(o, p)| (o.0, p.global_env.0))
                    .collect(),
            ),
            host_functions: {
                let mut rows: Vec<_> = self
                    .functions
                    .iter()
                    .filter_map(|(owner, info)| {
                        info.host.as_ref().map(|host| HostFunctionRow {
                            owner: owner.0,
                            service: host.id.name.clone(),
                            abi: host.id.abi,
                            name: info.name.clone(),
                            arity: info.arity,
                            name_chunk: info.name_chunk.0,
                            captures: host.captures.clone(),
                        })
                    })
                    .collect();
                rows.sort_by_key(|row| row.owner);
                rows
            },
            evaluators,
            roots,
            jobs: self
                .promise_jobs
                .iter()
                .map(|job| match job {
                    PromiseJob::Reaction {
                        reaction,
                        value,
                        rejected,
                    } => PromiseJobRow {
                        thenable: false,
                        reaction: reaction_snapshot(reaction, &comb),
                        value: *value,
                        rejected: *rejected,
                    },
                    PromiseJob::Thenable {
                        then,
                        thenable,
                        resolve,
                        reject,
                    } => PromiseJobRow {
                        thenable: true,
                        reaction: PromiseReactionRow {
                            on_fulfilled: *then,
                            on_rejected: *thenable,
                            resolve: *resolve,
                            reject: *reject,
                            kind: 0,
                            a: 0,
                            b: 0,
                        },
                        value: Slot::undefined(),
                        rejected: false,
                    },
                })
                .collect(),
            pending_rejections: self.pending_rejections.iter().map(|p| p.0).collect(),
        })
    }

    pub(super) fn restore_shared_machine(
        &mut self,
        state: Option<SharedMachineSnapshot>,
    ) -> Result<(), RestoreError> {
        let Some(state) = state else {
            return Ok(());
        };
        let refuse = |reason| RestoreError {
            row: "shared_machine",
            reason,
        };
        // The profile is an engine-owned boot identity. Never trust serialized roots
        // to pick arbitrary guest objects to stand in for the shared primordials.
        if self.environment.unhandled_rejection.is_some() {
            return Err(refuse("shared report duplicated in standalone promise row"));
        }
        let boot = Self::new_shared_realm_machine();
        if state.default_global != boot.realm.global_object().0
            || state.intrinsic_roots
                != boot
                    .realm
                    .intrinsics()
                    .roots
                    .iter()
                    .map(|r| r.0)
                    .collect::<Vec<_>>()
        {
            return Err(refuse("shared primordial profile mismatch"));
        }
        self.validate_restore_owners(
            state.environments.iter().map(|e| e.global),
            "shared_machine",
        )?;
        let env_ids: std::collections::BTreeSet<_> =
            state.environments.iter().map(|e| e.global).collect();
        if !env_ids.contains(&state.default_global) || !env_ids.contains(&state.current_global) {
            return Err(refuse("missing default or current environment"));
        }
        for &root in &state.intrinsic_roots {
            self.validate_restore_owner(root, "shared_machine")?;
            let root = crate::SlotIndex(root);
            validate_restore_chain(&self.slots, root, &mut Default::default())?;
            if self.proxies.contains_key(&root)
                || self.slots.get(root).flag & XS_DONT_PATCH_FLAG == 0
            {
                return Err(refuse("shared primordial is extensible or proxied"));
            }
            let mut property = self.slots.get(root).next;
            while !property.is_null() {
                let slot = self.slots.get(property);
                if slot.flag & XS_DONT_DELETE_FLAG == 0
                    || (slot.flag & (XS_GETTER_FLAG | XS_SETTER_FLAG) == 0
                        && slot.flag & XS_DONT_SET_FLAG == 0)
                {
                    return Err(refuse("shared primordial property is mutable"));
                }
                property = slot.next;
            }
        }
        for row in &state.environments {
            let global = crate::SlotIndex(row.global);
            if self.functions.contains_key(&global) || self.proxies.contains_key(&global) {
                return Err(refuse("environment global is not an ordinary object"));
            }
            validate_restore_chain(
                &self.slots,
                crate::SlotIndex(row.global),
                &mut Default::default(),
            )?;
            if row.unhandled_rejection.is_some_and(|p| {
                !self
                    .promises
                    .get(&crate::SlotIndex(p))
                    .is_some_and(|p| p.state == PromiseState::Rejected)
            }) {
                return Err(refuse("environment report is not a rejected promise"));
            }
        }
        let check_pairs = |rows: &[(u32, u32)]| -> Result<(), RestoreError> {
            if rows.windows(2).any(|r| r[0].0 >= r[1].0)
                || rows.iter().any(|(_, e)| !env_ids.contains(e))
            {
                return Err(refuse("invalid environment association"));
            }
            Ok(())
        };
        for rows in [
            &state.function_environments,
            &state.generator_environments,
            &state.async_environments,
            &state.promise_environments,
        ] {
            check_pairs(rows)?;
        }
        for row in &state.host_functions {
            let owner = crate::SlotIndex(row.owner);
            if self.proxies.contains_key(&owner)
                || self.arrays.contains_key(&owner)
                || self.collections.contains_key(&owner)
                || self.typed_arrays.contains_key(&owner)
                || self.data_views.contains_key(&owner)
                || self.wrapper_data.contains_key(&owner)
                || self.promises.contains_key(&owner)
                || self.generators.contains_key(&owner)
                || self.async_instances.contains_key(&owner)
                || self.iterators.contains_key(&owner)
                || self.regexps.contains_key(&owner)
                || self.disposable_stacks.contains_key(&owner)
                || self.bound_functions.contains_key(&owner)
                || self.array_buffers.contains_key(&owner)
                || self.dates.contains_key(&owner)
                || self.temporal_instants.contains_key(&owner)
                || self.temporal_durations.contains_key(&owner)
                || self.temporal_plains.contains_key(&owner)
                || self.temporal_zoneds.contains_key(&owner)
                || self.number_formats.contains_key(&owner)
                || self.collators.contains_key(&owner)
                || self.date_time_formats.contains_key(&owner)
                || self.list_formats.contains_key(&owner)
                || self.plural_rules.contains_key(&owner)
                || self.segmenters.contains_key(&owner)
                || self.segments.contains_key(&owner)
                || self.segment_iterators.contains_key(&owner)
                || self.locales.contains_key(&owner)
                || self.error_data.contains_key(&owner)
                || self.arguments_objects.contains(&owner)
            {
                return Err(refuse("host function owner has conflicting metadata"));
            }
        }
        // Every guest function/evaluator must carry its defining environment;
        // omission must not silently turn into the standalone NULL policy.
        let function_env: std::collections::BTreeMap<_, _> =
            state.function_environments.iter().copied().collect();
        for (owner, info) in &self.functions {
            if (info.host.is_some()
                || info.body_start.is_some()
                || matches!(
                    info.native,
                    Some(
                        Native::Eval
                            | Native::Function
                            | Native::GeneratorFunction
                            | Native::AsyncFunction
                            | Native::AsyncGeneratorFunction
                    )
                ))
                && !function_env.contains_key(&owner.0)
            {
                return Err(refuse("missing function environment"));
            }
        }
        for &(o, e) in &state.function_environments {
            let Some(info) = self.functions.get_mut(&crate::SlotIndex(o)) else {
                return Err(refuse("unknown function environment owner"));
            };
            if matches!(
                info.native,
                Some(
                    Native::GeneratorFunction
                        | Native::AsyncFunction
                        | Native::AsyncGeneratorFunction
                )
            ) && e != state.default_global
            {
                return Err(refuse("shared constructor requires default environment"));
            }
            if boot
                .functions
                .get(&crate::SlotIndex(o))
                .is_some_and(|original| original.global_env.0 != e)
            {
                return Err(refuse("boot callable environment mismatch"));
            }
            info.global_env = crate::SlotIndex(e);
        }
        if state.generator_environments.len()
            != self
                .generators
                .values()
                .filter(|g| g.frame.is_some())
                .count()
            || state.async_environments.len()
                != self
                    .async_instances
                    .values()
                    .filter(|g| g.frame.is_some())
                    .count()
            || state.promise_environments.len() != self.promises.len()
        {
            return Err(refuse("incomplete environment associations"));
        }
        for (o, e) in state.generator_environments {
            let f = self
                .generators
                .get_mut(&crate::SlotIndex(o))
                .and_then(|g| g.frame.as_mut())
                .ok_or_else(|| refuse("unknown generator environment owner"))?;
            if function_env.get(&f.cur_func.0) != Some(&e) {
                return Err(refuse("generator defining environment mismatch"));
            }
            f.global_env = crate::SlotIndex(e);
        }
        for (o, e) in state.async_environments {
            let f = self
                .async_instances
                .get_mut(&crate::SlotIndex(o))
                .and_then(|g| g.frame.as_mut())
                .ok_or_else(|| refuse("unknown async environment owner"))?;
            if function_env.get(&f.cur_func.0) != Some(&e) {
                return Err(refuse("async defining environment mismatch"));
            }
            f.global_env = crate::SlotIndex(e);
        }
        for (o, e) in state.promise_environments {
            self.promises
                .get_mut(&crate::SlotIndex(o))
                .ok_or_else(|| refuse("unknown promise environment owner"))?
                .global_env = crate::SlotIndex(e);
        }
        for row in &state.environments {
            if row
                .unhandled_rejection
                .is_some_and(|id| self.promises[&crate::SlotIndex(id)].global_env.0 != row.global)
            {
                return Err(refuse("environment report belongs to another environment"));
            }
        }
        if state.roots.windows(2).any(|r| r[0] >= r[1]) {
            return Err(refuse("host roots not ascending"));
        }
        for root in state.roots {
            let index = crate::SlotIndex(root);
            if root >= self.slots.capacity() || self.slots.is_free_index(index) {
                return Err(refuse("invalid host root"));
            }
            let slot = self.slots.get(index);
            if slot.kind == Kind::Instance {
                self.validate_restore_owner(root, "shared_machine")?;
                validate_restore_chain(&self.slots, index, &mut Default::default())?;
            } else {
                self.validate_restore_value_shape(slot, "shared_machine")?;
                if slot.id != 0 || slot.flag != 0 || !slot.next.is_null() {
                    return Err(refuse("invalid host value root metadata"));
                }
            }
            let lease = self.pin_identity(index);
            self.restored_leases.insert(index, lease);
        }
        let mut environments = std::collections::HashMap::new();
        for row in state.environments {
            let global = crate::SlotIndex(row.global);
            if row.binding_names.windows(2).any(|r| r[0] >= r[1])
                || row
                    .binding_names
                    .iter()
                    .any(|id| *id == 0 || usize::from(*id) > self.symbol_names.len())
            {
                return Err(refuse("invalid considered intrinsic name"));
            }
            let mut env = CompartmentEnvironment::new(global);
            env.binding_names = row.binding_names.into_iter().collect();
            env.modules = std::rc::Rc::new(std::cell::RefCell::new(
                crate::ModuleGraph::from_snapshot(row.modules)?,
            ));
            env.compiler_required = row.compiler_required;
            env.unhandled_rejection = row.unhandled_rejection.map(crate::SlotIndex);
            if row.global != state.default_global {
                let lease = std::rc::Rc::new(());
                env.owner = Some(std::rc::Rc::downgrade(&lease));
                if row.host_owned {
                    self.restored_environment_leases.insert(global, lease);
                }
            }
            // The property chain is authoritative; rebuild the index independently.
            let mut prop = self.slots.get(global).next;
            while !prop.is_null() {
                let slot = self.slots.get(prop);
                if slot.id != 0 && env.global_props.insert(slot.id, prop).is_some() {
                    return Err(refuse("duplicate global property"));
                }
                prop = slot.next;
            }
            environments.insert(global, env);
        }
        self.environment = environments
            .remove(&crate::SlotIndex(state.current_global))
            .unwrap();
        self.inactive_environments = environments;
        self.realm = std::rc::Rc::clone(&boot.realm);
        self.shared_compartments = true;
        self.restore_shared_jobs(state.jobs)?;
        let mut seen = std::collections::HashSet::new();
        for p in state.pending_rejections {
            let p = crate::SlotIndex(p);
            if !seen.insert(p)
                || !self
                    .promises
                    .get(&p)
                    .is_some_and(|p| p.state == PromiseState::Rejected)
            {
                return Err(refuse("invalid pending rejection"));
            }
            self.pending_rejections.push(p);
        }
        Ok(())
    }
}

fn reaction_snapshot(
    r: &PromiseReaction,
    comb: &std::collections::BTreeMap<u32, u32>,
) -> PromiseReactionRow {
    let (kind, a, b) = match r.kind {
        ReactionKind::User => (0, 0, 0),
        ReactionKind::FinallyReturn => (1, 0, 0),
        ReactionKind::Combine(i, e) => (2, comb[&i], e),
        ReactionKind::CombineDirect(i, e) => (12, comb[&i], e),
        ReactionKind::AsyncAwait(i) => (3, i.0, 0),
        ReactionKind::FinallyAwait(r) => (11, r as u32, 0),
        _ => unreachable!("persist gate rejects unsupported suspended machinery"),
    };
    PromiseReactionRow {
        on_fulfilled: r.on_fulfilled,
        on_rejected: r.on_rejected,
        resolve: r.resolve,
        reject: r.reject,
        kind,
        a,
        b,
    }
}

impl Interp {
    fn restore_shared_jobs(&mut self, rows: Vec<PromiseJobRow>) -> Result<(), RestoreError> {
        let refuse = |reason| RestoreError {
            row: "shared_machine",
            reason,
        };
        let mut elements = std::collections::BTreeSet::new();
        let mut pending = vec![0u32; self.combinators.len()];
        let mut awaits = std::collections::HashSet::new();
        for reaction in self.promises.values().flat_map(|p| &p.reactions) {
            match reaction.kind {
                ReactionKind::Combine(i, e) | ReactionKind::CombineDirect(i, e) => {
                    elements.insert((i, e));
                    pending[i as usize] += 1;
                }
                ReactionKind::AsyncAwait(i) => {
                    awaits.insert(i);
                }
                _ => {}
            }
        }
        for row in rows {
            let r = row.reaction;
            for v in [
                row.value,
                r.on_fulfilled,
                r.on_rejected,
                r.resolve,
                r.reject,
            ] {
                self.validate_restore_value_shape(v, "shared_machine")?;
            }
            let undef = |v: Slot| v == Slot::undefined();
            let capability = self.is_callable_value(r.resolve) && self.is_callable_value(r.reject);
            if row.thenable {
                if row.rejected
                    || !undef(row.value)
                    || r.kind != 0
                    || r.a != 0
                    || r.b != 0
                    || !self.is_callable_value(r.on_fulfilled)
                    || r.on_rejected.kind != Kind::Reference
                    || !capability
                {
                    return Err(refuse("invalid thenable job"));
                }
                let pair = match (r.resolve.value, r.reject.value) {
                    (Payload::Reference(resolve), Payload::Reference(reject)) => self
                        .promise_functions
                        .get(&resolve)
                        .zip(self.promise_functions.get(&reject)),
                    _ => None,
                };
                if !pair.is_some_and(|(resolve, reject)| {
                    !resolve.reject
                        && reject.reject
                        && resolve.promise == reject.promise
                        && resolve.guard == reject.guard
                        && self.promise_guards.get(resolve.guard as usize) == Some(&false)
                }) {
                    return Err(refuse("invalid thenable resolving pair"));
                }
                self.promise_jobs.push_back(PromiseJob::Thenable {
                    then: r.on_fulfilled,
                    thenable: r.on_rejected,
                    resolve: r.resolve,
                    reject: r.reject,
                });
                continue;
            }
            let no_slots = [r.on_fulfilled, r.on_rejected, r.resolve, r.reject]
                .into_iter()
                .all(undef);
            let kind = match r.kind {
                0 if r.a == 0 && r.b == 0 && capability => ReactionKind::User,
                1 if r.a == 0
                    && r.b == 0
                    && capability
                    && self.is_constructor_value(r.on_rejected)
                    && self.is_callable_value(r.on_fulfilled) =>
                {
                    ReactionKind::FinallyReturn
                }
                11 if r.a <= 1 && r.b == 0 && capability && undef(r.on_rejected) => {
                    ReactionKind::FinallyAwait(r.a != 0)
                }
                3 if r.b == 0
                    && no_slots
                    && self.async_instances.contains_key(&crate::SlotIndex(r.a))
                    && awaits.insert(crate::SlotIndex(r.a)) =>
                {
                    ReactionKind::AsyncAwait(crate::SlotIndex(r.a))
                }
                2 if no_slots
                    && self.combinators.get(r.a as usize).is_some_and(|c| {
                        self.arrays.get(&c.results).is_some_and(|a| r.b < a.length)
                    })
                    && elements.insert((r.a, r.b)) =>
                {
                    pending[r.a as usize] += 1;
                    ReactionKind::Combine(r.a, r.b)
                }
                _ => return Err(refuse("invalid reaction job")),
            };
            self.promise_jobs.push_back(PromiseJob::Reaction {
                reaction: PromiseReaction {
                    on_fulfilled: r.on_fulfilled,
                    on_rejected: r.on_rejected,
                    resolve: r.resolve,
                    reject: r.reject,
                    kind,
                },
                value: row.value,
                rejected: row.rejected,
            });
        }
        if self
            .combinators
            .iter()
            .zip(pending)
            .any(|(c, n)| c.kind != CombinatorKind::Race && c.remaining < n)
        {
            return Err(refuse("queued combinator count exceeds remaining elements"));
        }
        Ok(())
    }
}

impl Interp {
    /// Environment identifiers requiring explicit host policy after restore.
    pub fn shared_environment_ids(&self) -> Vec<u32> {
        if !self.shared_compartments {
            return Vec::new();
        }
        let mut ids: Vec<_> = self
            .live_environment_ids()
            .into_iter()
            .map(|i| i.0)
            .collect();
        ids.sort_unstable();
        ids
    }

    pub(crate) fn attach_environment_policy(
        &mut self,
        global: u32,
        permit: Option<&[String]>,
        compiler: Option<&std::rc::Rc<dyn SourceCompiler>>,
    ) -> Result<(), Halt> {
        let env = self
            .environment_context_mut(crate::SlotIndex(global))
            .ok_or(Halt::Refused("machine:unknown-restored-environment"))?;
        if env.compiler_required && compiler.is_none() {
            return Err(Halt::Refused("machine:missing-restored-compiler"));
        }
        env.intrinsic_permit =
            permit.map(|names| names.iter().map(|n| SymbolName::from(n.as_str())).collect());
        env.shared_compiler = compiler.map(std::rc::Rc::downgrade);
        env.compiler_required = compiler.is_some();
        Ok(())
    }

    pub(crate) fn claim_environment(&mut self, global: u32) -> Result<std::rc::Rc<()>, Halt> {
        let id = crate::SlotIndex(global);
        let lease = self
            .restored_environment_leases
            .remove(&id)
            .unwrap_or_default();
        let default = self.realm.global_object();
        let env = self
            .environment_context_mut(id)
            .ok_or(Halt::Refused("machine:unknown-restored-environment"))?;
        if id != default {
            env.owner = Some(std::rc::Rc::downgrade(&lease));
        }
        Ok(lease)
    }

    pub(crate) fn claim_value_root(&mut self, root: u32) -> Result<std::rc::Rc<()>, Halt> {
        let id = crate::SlotIndex(root);
        if !self.restored_leases.contains_key(&id) {
            return Err(Halt::Refused("machine:unknown-restored-root"));
        }
        self.validate_restore_value_shape(self.slots.get(id), "host_root")
            .map_err(|_| Halt::Refused("machine:invalid-restored-value-root"))?;
        Ok(self.restored_leases.remove(&id).unwrap())
    }

    pub(crate) fn claim_identity_root(&mut self, root: u32) -> Result<std::rc::Rc<()>, Halt> {
        let id = crate::SlotIndex(root);
        if !self.restored_leases.contains_key(&id) || self.slots.get(id).kind != Kind::Instance {
            return Err(Halt::Refused("machine:unknown-restored-identity"));
        }
        Ok(self.restored_leases.remove(&id).unwrap())
    }

    pub(crate) fn release_restored_roots(&mut self) {
        self.restored_leases.clear();
        self.restored_environment_leases.clear();
    }
}

impl Interp {
    pub(super) fn restore_shared_evaluators(
        &mut self,
        rows: &[EvaluatorRow],
    ) -> Result<(), RestoreError> {
        let refuse = |reason| RestoreError {
            row: "shared_machine",
            reason,
        };
        let boot = Self::new_shared_realm_machine();
        self.validate_restore_owners(rows.iter().map(|e| e.owner), "shared_machine")?;
        for row in rows {
            if self.functions.contains_key(&crate::SlotIndex(row.owner))
                || row.owner < self.boot_slot_count
            {
                return Err(refuse("evaluator owner collision"));
            }
            let native = match row.kind {
                0 => Native::Eval,
                1 => Native::Function,
                _ => return Err(refuse("invalid evaluator recipe")),
            };
            let mut info = boot
                .functions
                .values()
                .find(|i| i.native == Some(native))
                .ok_or_else(|| refuse("missing evaluator primordial"))?
                .clone();
            self.validate_restore_value_shape(
                Slot::of(
                    Kind::String,
                    Payload::String(crate::ChunkOffset(row.name_chunk)),
                ),
                "shared_machine",
            )?;
            info.name_chunk = crate::ChunkOffset(row.name_chunk);
            let original = boot
                .functions
                .iter()
                .find(|(_, i)| i.native == Some(native))
                .map(|(id, _)| *id)
                .unwrap();
            if let Some(prototype) = boot.ctor_prototype.get(&original) {
                self.ctor_prototype
                    .insert(crate::SlotIndex(row.owner), *prototype);
            }
            self.functions.insert(crate::SlotIndex(row.owner), info);
        }
        Ok(())
    }
}

impl Interp {
    pub(crate) fn environment_modules(
        &self,
        id: crate::SlotIndex,
    ) -> Option<std::rc::Rc<std::cell::RefCell<crate::ModuleGraph>>> {
        let env = if self.environment.global_obj == id {
            &self.environment
        } else {
            self.inactive_environments.get(&id)?
        };
        Some(env.modules.clone())
    }
}

impl Interp {
    pub(super) fn restore_host_functions(
        &mut self,
        rows: &[HostFunctionRow],
    ) -> Result<(), RestoreError> {
        let refuse = |reason| RestoreError {
            row: "host_function",
            reason,
        };
        self.validate_restore_owners(rows.iter().map(|r| r.owner), "host_function")?;
        for row in rows {
            let owner = crate::SlotIndex(row.owner);
            if row.arity > i32::MAX as u32 {
                return Err(refuse("host function arity out of range"));
            }
            if owner.0 < self.boot_slot_count || self.functions.contains_key(&owner) {
                return Err(refuse("host function owner collision"));
            }
            self.validate_restore_values(
                [Slot::of(
                    Kind::String,
                    Payload::String(crate::ChunkOffset(row.name_chunk)),
                )],
                "host_function",
            )?;
            if self.str_units(crate::ChunkOffset(row.name_chunk))
                != row.name.encode_utf16().collect::<Vec<_>>()
            {
                return Err(refuse("host function name mismatch"));
            }
            self.validate_restore_values(row.captures.iter().copied(), "host_function")?;
            self.functions.insert(
                owner,
                FuncInfo {
                    host: Some(host::HostFunctionData {
                        id: crate::HostCallableId {
                            name: row.service.clone(),
                            abi: row.abi,
                        },
                        captures: row.captures.clone(),
                    }),
                    native: Some(Native::Host),
                    name: row.name.clone(),
                    arity: row.arity,
                    name_chunk: crate::ChunkOffset(row.name_chunk),
                    ..FuncInfo::default()
                },
            );
        }
        Ok(())
    }
}
