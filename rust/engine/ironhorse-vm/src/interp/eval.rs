//! Same-realm eval and dynamic function compilation.
use super::*;

impl Interp {
    /// The runtime source-execution bridge: compile `source` through the
    /// installed [`SourceCompiler`] and execute the resulting program in
    /// **this** realm, returning its completion value (the spec's eval /
    /// dynamic-function evaluation result).
    ///
    /// This replaces the former `eval:string-source` source-text boundary
    /// with a principled compiler/VM seam:
    /// - **Linkage ownership.** The unit is compiled with its own program-local
    ///   symbol numbering; [`Self::relink_program_symbols`] rewrites its ids
    ///   into the realm's shared symbol table, and
    ///   [`Self::install_intrinsic_bindings`] binds any intrinsic the outer
    ///   program never named — so `Object`, `Math`, … mean the realm's.
    /// - **Realm identity.** It runs on this same [`Interp`]: the same global
    ///   object, intrinsics, heap, and meter. Indirect eval and `Function`
    ///   evaluate in the realm's program (global) scope. A direct eval keeps
    ///   the caller's published environment chain, so parameters and lexical
    ///   cells remain live across the nested dispatch. Sloppy direct-eval
    ///   `var`/function declarations are instantiated in the nearest published
    ///   caller variable environment.
    /// - **Nested invocation / safe recursion.** The unit runs as an isolated
    ///   program activation: the caller's whole frame (scope, `this`, args,
    ///   target, catch-jump chain, call stack, result) is saved and a clean
    ///   one installed, so the nested program cannot corrupt the caller and
    ///   an uncaught throw re-raises into the caller's own `try`/catch.
    /// - **Catchable parse errors.** A [`SourceCompileError::Syntax`] is a
    ///   realm-local, catchable `SyntaxError`; an `Unsupported` construct is
    ///   an honest coverage gap, never a mis-execution.
    /// - **Job/meter behavior.** Execution accrues on the shared meter; the
    ///   eval unit's promise reactions drain with the outer program's job
    ///   pump (not a nested drain), matching a single host crank.
    pub(super) fn eval_source(&mut self, source: &[u16], strict: bool) -> Result<Slot, Step> {
        self.eval_source_in(source, strict, false)
    }

    /// [`Self::eval_source`], told whether a direct eval's caller is a class
    /// field initializer (`field`).
    ///
    /// A direct eval compiles in its caller's [`EvalContext`], as XS's
    /// `fxRunEval` parses: `new.target` when the caller can construct,
    /// `super` property access when it has a home object, and the caller's
    /// private names through its environment. The unit runs with the
    /// caller's function and `new.target`, which those reads consult.
    pub(super) fn eval_source_in(
        &mut self,
        source: &[u16],
        strict: bool,
        field: bool,
    ) -> Result<Slot, Step> {
        // Whether this is a direct eval (its declaration instantiation observes
        // the caller's lexical environment). Captured before the nested-frame
        // setup clears `eval_direct`.
        let is_direct = self.eval_direct;
        let context = if is_direct {
            let caller = self.cur_func;
            let home = self
                .functions
                .get(&caller)
                .map(|info| info.home)
                .unwrap_or(crate::value::SlotIndex::NULL);
            EvalContext {
                strict,
                new_target: !caller.is_null() && self.slot_is_constructor(caller),
                super_property: !home.is_null(),
                field,
                private_environment: true,
            }
        } else {
            EvalContext {
                strict,
                ..EvalContext::default()
            }
        };
        let compiler = match self.environment.source_compiler.clone().or_else(|| {
            self.environment
                .shared_compiler
                .as_ref()
                .and_then(std::rc::Weak::upgrade)
        }) {
            Some(compiler) => compiler,
            None => return Err(Step::Host(Halt::NotImplemented("eval:no-compiler"))),
        };
        self.charge_and_check(0)?;
        let raw_budget = u64::MAX - self.meter_index();
        let mut charged = 0u64;
        let mut refused = false;
        let result = compiler.compile_eval_units(source, &context, raw_budget, &mut |raw| {
            if refused {
                return false;
            }
            let Some(next) = charged.checked_add(raw).filter(|next| *next <= raw_budget) else {
                refused = true;
                return false;
            };
            charged = next;
            refused = !self.charge_compilation(raw);
            !refused
        });
        // Refusal wins even if an embedding compiler mistakenly returns
        // successful output or a syntax error after its callback said stop.
        if refused {
            return Err(Step::Host(Halt::MeterAbort));
        }
        let compiled = match result {
            Err(SourceCompileError::HeapExhausted) => return Err(Step::Host(Halt::HeapExhausted)),
            Ok(compiled) => compiled,
            Err(SourceCompileError::MeterAbort) => return Err(Step::Host(Halt::MeterAbort)),
            Err(SourceCompileError::Syntax(message)) => {
                return Err(self.catchable_syntax_error_with_message(message))
            }
            Err(SourceCompileError::Unsupported(_)) => {
                return Err(Step::Host(Halt::NotImplemented(
                    "eval:compiler-unimplemented",
                )))
            }
            // An engine fault, kept apart from the coverage gap above. The
            // detail is deliberately dropped: a panic message is arbitrary
            // text from inside the compiler and a guest must not read it.
            Err(SourceCompileError::Invariant(_)) => {
                return Err(Step::Host(Halt::EngineInvariant("eval:compiler-invariant")))
            }
        };
        if compiled.parse_meter_raw != charged {
            return Err(Step::Host(Halt::EngineInvariant(
                "eval:compile-charge-receipt",
            )));
        }
        let eval_names =
            crate::symbols::parse_symbols_checked(&compiled.symbols).map_err(Step::Host)?;
        let code = self.relink_program_symbols(&compiled.bytecode, &eval_names)?;
        // The symbol table and intrinsic prototypes are machine-wide, but
        // globals are per environment. Catch this global up from its binding
        // history even when a sibling advanced the shared surface floor first.
        self.install_pending_intrinsics();
        // The unit may reference a well-known property name (`length`, `name`,
        // `then`, a RegExp getter, …) the outer program never used; its id is
        // now in the realm table, so refresh the exotic-property id caches that
        // gate on it, else e.g. `Function('...r', 'return r.length')` would read
        // an absent own `length` instead of the array's exotic length.
        self.refresh_special_ids_from_symbols();

        // Persist this unit's bytecode for the realm's lifetime and run it
        // under its own segment id, so a function it defines that escapes the
        // eval (the completion, a stored global, the `Function` result) still
        // dispatches over the right bytes when called later.
        let segment = self.code_segments.len();
        let buf: std::rc::Rc<[u8]> = code.into();
        self.code_segments.push(buf.clone());

        // Save the caller's activation and install a clean program frame for
        // the nested unit (indirect / top-level-direct eval runs in the realm
        // program scope). `call_stack` and `jumps` are emptied so the unit's
        // `BEGIN` takes the top-level-program branch and an uncaught throw
        // cannot unwind into the caller's catch targets mid-nested-dispatch.
        let saved_locals = std::mem::take(&mut self.locals);
        let saved_id_map = std::mem::take(&mut self.id_map);
        let saved_args = std::mem::take(&mut self.args);
        let saved_call_stack = std::mem::take(&mut self.call_stack);
        let saved_held_total = std::mem::take(&mut self.held_total);
        let saved_jumps = std::mem::take(&mut self.jumps);
        let saved_env = self.env;
        let saved_result = self.result;
        let saved_strict = self.strict;
        let saved_this = self.this_val;
        let saved_cur_func = self.cur_func;
        let saved_cur_target = self.cur_target;
        let saved_target_func = self.target_func;
        let saved_pending_new_target = self.pending_new_target;
        let saved_frame_slots = self.frame_slots;
        let saved_eval_direct = self.eval_direct;
        let saved_direct_eval_hoist = self.direct_eval_hoist;
        let saved_eval_program_hoist = self.eval_program_hoist;
        let saved_active_segment = self.active_segment;
        let saved_stack_len = self.stack.len();

        self.result = Slot::undefined();
        self.strict = false;
        // A direct eval runs as its caller's function, so `super` finds the
        // caller's home object and `new.target` its target (XS hands both to
        // `fxRunScript`). An indirect eval runs as the realm's program.
        if !is_direct {
            self.cur_func = crate::value::SlotIndex::NULL;
            self.cur_target = false;
            self.target_func = crate::value::SlotIndex::NULL;
        }
        self.pending_new_target = None;
        self.frame_slots = 0;
        self.eval_direct = false;
        // A direct eval resolves through the caller's compiler-published
        // closure environments. An indirect eval always starts at the realm
        // global and must not inherit an enclosing function's dynamic chain.
        if !is_direct {
            self.env = Slot::undefined();
        }
        // The unit's declaration-instantiation hoist observes the direct/indirect
        // distinction (only a direct eval sees the caller's global lexicals).
        self.direct_eval_hoist = is_direct;
        // EvalDeclarationInstantiation passes `D = true` for a direct *and* an
        // indirect eval, so a global `var` this unit creates is configurable
        // (deletable) — unlike a Script's, which is not.
        self.eval_program_hoist = true;
        self.active_segment = Some(segment);

        let halt = self.dispatch_at(&buf[..], 0, 0);
        let completion = self.result;
        self.active_segment = saved_active_segment;
        self.direct_eval_hoist = saved_direct_eval_hoist;
        self.eval_program_hoist = saved_eval_program_hoist;

        // Restore the caller's activation. Drop any residue the nested unit
        // left on the shared value stack (a well-formed program is balanced;
        // this is the lifetime backstop).
        self.stack.truncate(saved_stack_len);
        self.locals = saved_locals;
        self.id_map = saved_id_map;
        self.args = saved_args;
        self.call_stack = saved_call_stack;
        // The unit's loop released what its frames held as it exited.
        debug_assert_eq!(self.held_total, 0, "an eval unit's frames hold units");
        self.held_total = saved_held_total;
        self.jumps = saved_jumps;
        self.env = saved_env;
        self.result = saved_result;
        self.strict = saved_strict;
        self.this_val = saved_this;
        self.cur_func = saved_cur_func;
        self.cur_target = saved_cur_target;
        self.target_func = saved_target_func;
        self.pending_new_target = saved_pending_new_target;
        self.frame_slots = saved_frame_slots;
        self.eval_direct = saved_eval_direct;

        match halt {
            Step::Returned => Ok(completion),
            // An uncaught throw inside the eval unit: `self.exception` holds
            // the realm error value. Re-raise it into the *caller's* frame so
            // the caller's `try`/catch (its restored jump chain) observes it —
            // exactly as a native helper's `catchable_*` does.
            Step::Threw { value, .. } => Err(self.raise_js(value)),
            // A coverage gap, meter abort, step-limit, or decode fault the
            // nested unit hit: propagate as-is (honest, non-result outcome).
            other => Err(other),
        }
    }

    /// Whether the running function is a class field initializer, which
    /// opens with `BEGIN_STRICT_FIELD` (XS's `XS_FIELD_FLAG` frame).
    pub(super) fn running_field_initializer(&self) -> bool {
        let Some(start) = self
            .functions
            .get(&self.cur_func)
            .and_then(|info| info.body_start)
        else {
            return false;
        };
        self.func_segments
            .get(&self.cur_func)
            .and_then(|&segment| self.code_segments.get(segment))
            .and_then(|code| code.get(start))
            .is_some_and(|&op| op == crate::Opcode::XS_CODE_BEGIN_STRICT_FIELD as u8)
    }

    /// The closure cell a direct eval's caller publishes for the private name
    /// `id` (XS's `XS_CODE_EVAL_PRIVATE` walk of `mxEnvironment`), or `None`
    /// when no enclosing class declares it.
    pub(super) fn eval_private_brand(&self, id: u16) -> Option<crate::value::SlotIndex> {
        let mut env = match (self.env.kind, self.env.value) {
            (Kind::Reference, Payload::Reference(env)) => env,
            _ => return None,
        };
        while !env.is_null() {
            if let Some(property) = self.environment_property(env, id) {
                let slot = self.slots.get(property);
                if let (Kind::Closure, Payload::Reference(cell)) = (slot.kind, slot.value) {
                    return Some(cell);
                }
            }
            env = self.instance_prototype(env);
        }
        None
    }

    /// Bind scope closure `k`, a direct eval's private name, to the class's
    /// brand cell, both in the frame and in the environment the eval already
    /// published, so a nested eval finds the same brand.
    pub(super) fn alias_eval_private(&mut self, k: usize, brand: crate::value::SlotIndex) {
        let id = self.local_index(k).map(|i| self.locals[i].id);
        self.repoint_closure(k, brand);
        let (Some(id), Kind::Reference, Payload::Reference(env)) =
            (id, self.env.kind, self.env.value)
        else {
            return;
        };
        if let Some(property) = self.environment_property(env, id) {
            let slot = self.slots.get_mut(property);
            if slot.kind == Kind::Closure {
                slot.value = Payload::Reference(brand);
            }
        }
    }

    /// CreateDynamicFunction (ECMA-262 20.2.1.1.1) for the whole
    /// dynamic-function constructor family. `native` selects the
    /// function-head grammar (`function` / `function*` / `async function` /
    /// `async function*`); the trailing argument is the body and the leading
    /// arguments the formal parameter list, each `ToString`-coerced (a
    /// `Symbol` argument throws a realm `TypeError`, any other non-string is
    /// stringified). The assembled
    /// `(<head> anonymous(<params>\n) {\n<body>\n})` source is compiled and run
    /// through the same runtime source bridge as `eval` ([`Self::eval_source`]),
    /// so the returned function persists in its own code segment and stays
    /// callable after this native returns. A parse failure (a bad parameter
    /// list, a `yield`/`await` outside the assembled grammar, a truncated body)
    /// surfaces as a catchable realm `SyntaxError`, exactly as the spec's
    /// early-error path throws. Call and construct are equivalent for the whole
    /// family, so the `new`-ness of the caller is not consulted here.
    pub(super) fn create_dynamic_function(
        &mut self,
        native: Native,
        base: usize,
        argc: usize,
        code: &[u8],
    ) -> Result<Slot, Step> {
        let mut params: Vec<Vec<u16>> = Vec::new();
        let mut body = Vec::new();
        for i in 0..argc {
            let slot = self
                .stack
                .get(base + 4 + i)
                .copied()
                .unwrap_or_else(Slot::undefined);
            // ToString each argument (the spec coerces every parameter chunk and
            // the body). A `Symbol` throws a realm `TypeError` from here.
            let piece = self.to_string_units(code, slot)?;
            if i + 1 == argc {
                body = piece;
            } else {
                params.push(piece);
            }
        }
        // The function-head grammar per kind. The trailing `anonymous` is the
        // spec's dynamic-function name; the `.name` the returned function
        // reports comes from compiling this head.
        let head = match native {
            Native::Function => "function anonymous",
            Native::GeneratorFunction => "function* anonymous",
            Native::AsyncFunction => "async function anonymous",
            Native::AsyncGeneratorFunction => "async function* anonymous",
            _ => unreachable!("create_dynamic_function on a non-family native"),
        };
        // The parameters are joined with `,` and the body wrapped in a block;
        // the whole is parenthesized so the Script's completion is the function
        // expression. The `\n` before `)` and after `{` are the spec's exact
        // separators (they defeat a trailing line comment in the parameter list
        // or a `//`-terminated body from swallowing the closing punctuation).
        let mut source: Vec<u16> = format!("({head}(").encode_utf16().collect();
        for (index, param) in params.into_iter().enumerate() {
            if index != 0 {
                source.push(u16::from(b','));
            }
            source.extend(param);
        }
        source.extend("\n) {\n".encode_utf16());
        source.extend(body);
        source.extend("\n})".encode_utf16());
        self.eval_source(&source, false)
    }
}
