//! Environment opcode semantics.
//! Return transfers unchanged; only the dispatch loop owns catch resumption.
use super::super::*;

impl Interp {
    pub(super) fn dispatch_eval_reference(&mut self, code: &[u8], name: u16) -> Result<(), Step> {
        // Additive `with`/eval environment walk: consult the active
        // environment chain first (XS's `mxEnvironment` walk). When
        // an object environment binds `name` (scopable), push a real
        // `Reference` to that object so `GET_VARIABLE`/`SET_VARIABLE`
        // resolve against it (and, for a `GET_THIS_VARIABLE` callee,
        // the `DUB`'d copy becomes the receiver). When no environment
        // is active this returns `None` without metering, so the
        // empty-chain sentinel path below is byte-identical. A
        // `with` object's trap or accessor may throw during the
        // walk; that throw is a catchable guest error.
        let resolved = (self.resolve_env_reference(code, name))?;
        if let Some(target) = resolved {
            self.push(Slot::of(Kind::Reference, Payload::Reference(target)));
            return Ok(());
        }
        let env = if self.id_map.contains_key(&name) {
            // Frame scope: NULL sentinel reference.
            Slot::of(
                Kind::EnvReference,
                Payload::Reference(crate::value::SlotIndex::NULL),
            )
        } else {
            // Global object: a distinct non-null sentinel.
            Slot::of(
                Kind::EnvReference,
                Payload::Reference(crate::value::SlotIndex(0)),
            )
        };
        self.push(env);
        Ok(())
    }

    pub(super) fn dispatch_get_variable(
        &mut self,
        code: &[u8],
        name: u16,
        next_opcode: Option<u8>,
    ) -> Result<(), Step> {
        // Consume the environment reference EVAL_REFERENCE
        // pushed and resolve the name.
        let envref = self.pop_checked()?;
        // A real `Reference` (not the `EnvReference` sentinel) means
        // `EVAL_REFERENCE` resolved the name to a live `with`/eval
        // object environment; do a full `[[Get]]` on it
        // (`mxBehaviorGetProperty`, metered exactly like
        // `GET_PROPERTY` — no built-in step for a data property, the
        // getter's `mxMeterOne` for an accessor). The `with` object
        // may be a Proxy, so this is the `mop_*` seam, not the
        // ordinary-object fast path, and a trap or getter throw is a
        // catchable guest error.
        if envref.kind == Kind::Reference {
            if let Payload::Reference(inst) = envref.value {
                if self.is_environment_instance(inst) {
                    let Some(v) = self.environment_get(inst, name) else {
                        let error = self.internal_error(
                            "ReferenceError",
                            format!("get {}: undefined variable", self.id_name(name)),
                        );
                        return Err(self.raise_js(error));
                    };
                    self.push(v);
                    return Ok(());
                }
                let v = (self.mop_get(code, inst, name, envref))?;
                self.push(v);
                return Ok(());
            }
        }
        let v = if self.id_map.contains_key(&name) {
            self.resolve_frame_get(name)
        } else if self.global_props.contains_key(&name) {
            // A global object binding is an Object Environment
            // Record binding. Read it through the object's full
            // [[Get]] path so a descriptor installed with
            // Object.defineProperty(globalThis, ...) observes an
            // accessor (and its abrupt completion), rather than
            // exposing the accessor's backing placeholder slot.
            let global = Slot::of(Kind::Reference, Payload::Reference(self.global_obj));
            Some((self.mop_get(code, self.global_obj, name, global))?)
        } else if self.mop_has(code, self.object_proto, name)? {
            // `global_props` is the OWN-property index of the
            // global object, but a bare name resolves through
            // `HasProperty`, which walks the prototype chain: every
            // `%Object.prototype%` member (`toString`, `valueOf`,
            // `hasOwnProperty`, …) is a resolvable global name, so
            // reading one answers its inherited VALUE rather than
            // faulting — XS answers `typeof toString` with
            // `"function"`. This is the read-side twin of the
            // `SET_VARIABLE` unresolvable guard below, asked and
            // answered the same way: ironhorse's global object
            // carries a NULL prototype (a separate, pre-existing
            // divergence: `Object.getPrototypeOf(globalThis)` is
            // `null` here and `%Object.prototype%` in XS), so the
            // inherited half of the question is put to
            // `%Object.prototype%` directly. The `instance_has`
            // probe is read-only and unmetered — XS's own chain
            // walk is already folded into this arm's measured cost
            // — and the value comes back through the same full
            // `[[Get]]` the own-global read uses, receiver still
            // the global object, so an inherited accessor runs
            // with the `this` XS gives it and its abrupt
            // completion is observed.
            let global = Slot::of(Kind::Reference, Payload::Reference(self.global_obj));
            Some((self.mop_get(code, self.object_proto, name, global))?)
        } else {
            None
        };
        match v {
            Some(s) => self.push(s),
            // An unresolvable reference — reading a name bound in no
            // reachable environment — is a **catchable** ReferenceError
            // (ECMA-262 `GetValue` 6.2.5.5 → `ResolveBinding`), not an
            // uncatchable host abort. Raise it through the jump-buffer
            // chain so a `try`/`catch` observes a realm-correct
            // `ReferenceError`; an uncaught throw still escapes to the
            // host as `Halt::Throw` (former behavior).
            //
            // The one exception is a `typeof` on a bare, **unbound**
            // name: `typeof undeclaredName` is `"undefined"`, never a
            // throw (ECMA-262 13.5.3.1 `typeof` step 3.a — an
            // unresolvable reference short-circuits to `"undefined"`).
            // XS encodes this by peeking the opcode following
            // `GET_VARIABLE`: when it is `TYPEOF` and the name resolves
            // in no environment, it pushes `undefined` rather than
            // faulting. A name that *is* bound but sits in its temporal
            // dead zone is not unresolvable — `typeof` of a TDZ binding
            // still throws — so this tolerance is gated on the name
            // being absent from every scope (`resolve_get` returns
            // `None` for both, but only the truly-unbound case is a
            // typeof-undefined). An inherited-only global name is
            // not unresolvable either: the resolution above answers
            // it with `Some(inherited value)`, so it never reaches
            // this arm and `typeof toString` reads the inherited
            // function rather than short-circuiting. That is what
            // keeps this predicate and the resolution above
            // agreeing on the one question they both ask.
            None if next_opcode == Some(Opcode::XS_CODE_TYPEOF as u8)
                && !self.id_map.contains_key(&name)
                && !self.global_props.contains_key(&name) =>
            {
                // Returns successfully to the dispatch loop;
                // the following `TYPEOF` reads this `undefined`.
                self.push(Slot::undefined());
            }
            None => {
                let error = self.internal_error(
                    "ReferenceError",
                    format!("get {}: undefined variable", self.id_name(name)),
                );
                return Err(self.raise_js(error));
            }
        }
        Ok(())
    }

    pub(super) fn dispatch_set_variable(&mut self, code: &[u8], name: u16) -> Result<(), Step> {
        // Stack: [.., envref, value]. Keep the value, drop
        // the reference from under it (XS's SET_ALL pops the
        // reference and leaves the assigned value).
        let value = self.pop_checked()?;
        let envref = self.pop_checked()?;
        // A real `Reference` (not the `EnvReference` sentinel) means
        // the name resolved to a live `with`/eval object
        // environment; do a full `[[Set]]` on it. XS's
        // `SET_VARIABLE` runs `fxRunHas` before the store (its host
        // teardown is the one built-in step every `SET_VARIABLE`
        // meters, present here too) then `mxBehaviorSetProperty`
        // (metered like `SET_PROPERTY`). Both go through the
        // `mop_*` seam so a Proxy `with` object observes its `has`
        // and `set` traps and an accessor binding runs its setter
        // (ECMA-262 Object Environment Record `SetMutableBinding`);
        // a chain-only `instance_has`/`ordinary_set` would write
        // through the membrane to the target. A sloppy failed set
        // (frozen / non-writable) silently keeps the RHS as the
        // result; a strict one throws.
        //
        // A strict store against an object environment IS reachable,
        // though `with` is itself a strict-mode SyntaxError: `S` on
        // the Reference is the strictness of the code containing the
        // ASSIGNMENT, not of the `with` statement. Both routes are
        // live here — a strict function written in a sloppy `with`
        // body closes over the object environment (`enter_call`
        // installs the closure env), and a strict direct `eval`
        // inside one keeps the caller's `self.env`. XS throws a
        // TypeError on the rejected store in both; so do we.
        if envref.kind == Kind::Reference {
            if let Payload::Reference(inst) = envref.value {
                if self.is_environment_instance(inst) {
                    match self.environment_set(inst, name, value) {
                        EnvironmentSet::Written => {
                            self.push(value);
                            return Ok(());
                        }
                        EnvironmentSet::Uninitialized => {
                            let error = self.internal_error(
                                "ReferenceError",
                                format!(
                                    "set {}: not initialized yet",
                                    self.property_debug_name(name)
                                ),
                            );
                            return Err(self.raise_js(error));
                        }
                        EnvironmentSet::Const => {
                            let error = self.internal_error(
                                "TypeError",
                                format!("set {}: const", self.property_debug_name(name)),
                            );
                            return Err(self.raise_js(error));
                        }
                        EnvironmentSet::Missing => {}
                    }
                }
                // The `HasProperty` half of `SetMutableBinding`.
                // Its result is deliberately NOT consulted: step 3's
                // `stillExists` ReferenceError (the binding vanished
                // between `HasBinding` and the store) is a pinned
                // ORACLE-DEFECT EXCLUSION in this repo — see
                // `ironhorse-262/src/xst.rs` `oracle_loses_with_reference`,
                // which records XS's `ReferenceError: set x: undefined
                // property` as the divergence to exclude rather than
                // to reproduce. Implementing step 3 here would break
                // that pin deliberately, so the call is kept for its
                // observable trap and its metered chain walk only.
                let (_still_exists, frames) = (self.mop_has_with_recursions(code, inst, name))?;
                self.meter
                    .tick_raw(frames * ORDINARY_HAS_PROPERTY_FRAME_METERING);
                let accepted = (self.mop_set(code, inst, name, value, envref))?;
                if !accepted && self.strict {
                    // A rejected store (frozen or non-writable
                    // property, getter-only accessor, a `set` trap
                    // answering false) is a TypeError in strict code,
                    // exactly as the global arm below raises one.
                    return Err(self.failed_set_error(inst, name, "set"));
                }
                self.meter.tick_builtin();
                self.push(value);
                return Ok(());
            }
        }
        // A frame-local var writes its scope slot. A global name
        // writes through the global object's full [[Set]] path so
        // accessor/non-writable descriptors installed reflectively
        // remain binding-correct. An absent name is an unresolvable
        // reference: in strict code `PutValue` throws a
        // `ReferenceError` (ECMA-262 6.2.5.6 step 3.a) before the
        // global object is consulted; in sloppy code it becomes
        // `Set(globalThis, name, value, false)`, which creates the
        // ordinary writable global property only when the global
        // is still extensible and otherwise fails silently. A
        // frozen or sealed `globalThis` therefore never gains a
        // binding by bare assignment.
        if self.id_map.contains_key(&name) {
            if !self.resolve_set(name, value) {
                // An initialized `const` reached by name (a `with`
                // scope that does not carry it, or an eval-published
                // reference). Same TypeError SET_LOCAL/SET_CLOSURE
                // raise for the by-index forms.
                let error = self.internal_error(
                    "TypeError",
                    format!("set {}: const", self.property_debug_name(name)),
                );
                return Err(self.raise_js(error));
            }
        } else {
            // `global_props` is the OWN-property index of the global
            // object, but a bare name resolves through
            // `HasProperty`, which walks the prototype chain: every
            // `%Object.prototype%` member (`toString`, `valueOf`,
            // `hasOwnProperty`, …) is a resolvable global name, so a
            // strict assignment to one must NOT throw — XS answers
            // `toString = 1` with no error. ironhorse's global object
            // carries a NULL prototype (a separate, pre-existing
            // divergence: `Object.getPrototypeOf(globalThis)` is
            // `null` here and `%Object.prototype%` in XS), so the
            // inherited half of the question is asked of
            // `%Object.prototype%` directly. Read-only and
            // unmetered: XS's own chain walk is already folded into
            // this arm's measured cost, and both forms stay
            // bit-exact against the pin.
            let own_global = self.global_props.contains_key(&name);
            let resolvable = own_global || self.mop_has(code, self.object_proto, name)?;
            if !resolvable && self.strict {
                // XS's `SET_VARIABLE` strict arm:
                // `mxRunDebugID(XS_REFERENCE_ERROR, "set %s:
                // undefined property", ...)`, the write-side twin of
                // the `GET_VARIABLE` unresolved arm above. The noun
                // differs from the read side on purpose: XS words
                // the store-side miss `undefined property` while
                // `GET_VARIABLE`'s unresolved arm says `undefined
                // variable`, so do not unify the two.
                let error = self.internal_error(
                    "ReferenceError",
                    format!("set {}: undefined property", self.id_name(name)),
                );
                return Err(self.raise_js(error));
            }
            if !own_global {
                // The create is refused on a non-extensible global —
                // `Set(globalThis, name, value, false)` fails and no
                // binding appears — but XS charges the
                // `mxBehaviorSetProperty` code unit either way, so
                // the tick sits OUTSIDE the extensibility guard.
                if self.instance_extensible(self.global_obj) {
                    self.materialize_global_property(name);
                }
                // Creating a sloppy global through `SET_VARIABLE`
                // dispatches XS's setter machinery
                // (`mxBehaviorSetProperty` → the missing-property
                // define path), which meters one extra code unit
                // beyond the property allocation. Measured against
                // the pin: `y = 1` costs one create's 65536 raw more
                // than ironhorse's allocation model, and N fresh
                // globals cost exactly N of them (an overwrite costs
                // none). This is the `SET_VARIABLE`-create path
                // only; the declared-`var` hoist at
                // `EVAL_ENVIRONMENT` (already bit-exact) does not
                // carry it.
                self.meter.tick_code();
            }
            let global = Slot::of(Kind::Reference, Payload::Reference(self.global_obj));
            let accepted = (self.mop_set(code, self.global_obj, name, value, global))?;
            if !accepted && self.strict {
                return Err(self.failed_set_error(self.global_obj, name, "set"));
            }
        }
        // The property store itself is one built-in step
        // (`mxMeterOne`, `XS_BUILTIN_METERING` = 1<<14),
        // metered on every `SET_VARIABLE` whether the property
        // pre-existed or was just created.
        self.meter.tick_builtin();
        self.push(value);
        Ok(())
    }
}
