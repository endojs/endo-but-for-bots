//! Cost-calibration instrumentation — stage C1 (design
//! `designs/ironhorse-meter-opcode-cost-instrumentation.md`).
//!
//! # Determinism firewall
//!
//! Everything that records or models cost lives behind the
//! `cost-calibration` Cargo feature, **off by default**. With the feature
//! off, [`CostRecorder`] is a zero-sized unit struct whose `on_*` methods
//! are `#[inline(always)]` empty bodies, so LLVM deletes every call and
//! [`crate::interp::Interp::dispatch_at`] stays instruction-identical to
//! the pre-instrumentation hot loop (acceptance bar C1: the object-code /
//! disassembly firewall proof; the cheaper structural proof landed here is
//! `size_of::<CostRecorder>() == 0` in the default build — see the
//! `firewall_off_tests::recorder_is_zero_sized_when_off` test).
//!
//! The recorder only ever **observes** interpreter state: it holds no
//! `&mut Meter` and exposes no method the meter, `RunOutcome`, or a
//! snapshot calls, so the data flow is strictly one-directional
//! (interpreter → recorder) and nondeterministic instrumentation can never
//! leak into a metered result or a snapshot. `meter.rs` names no type in
//! this module (grep invariant, exercised by
//! `interp::tests::meter_module_is_firewalled_from_cost`).
//!
//! # Stage C1 scope
//!
//! Only the deterministic-safe half lands here: the per-opcode and
//! per-builtin **histogram** wired at the existing `tick_code` /
//! native-dispatch seams, plus the [`CostModel`] work-function table (data
//! only — no wall-clock timing until stage C2). The opcode histogram is
//! `n_dispatched` generalized from a scalar to a per-opcode array; its
//! total reconciles with `n_dispatched` exactly.

// ------------------------------------------------------------------------
// Feature OFF: the zero-sized no-op recorder (the firewall's off side).
// ------------------------------------------------------------------------

#[cfg(not(feature = "cost-calibration"))]
mod off {
    use crate::interp::NativeMethod;
    use crate::opcode::Opcode;

    /// Zero-sized recorder. Every method is an inlined empty body, so the
    /// instrumentation calls in the interpreter hot loop compile away
    /// entirely and the metered path is byte-identical to the
    /// pre-instrumentation build.
    #[derive(Debug, Default, Clone)]
    pub struct CostRecorder;

    impl CostRecorder {
        /// One bytecode dispatch (paired with `meter.tick_code()` /
        /// `n_dispatched += 1`). No-op when the feature is off.
        #[inline(always)]
        pub fn on_dispatch(&mut self, _op: Opcode) {}

        /// One native builtin invocation, keyed by the dispatched method.
        /// No-op when the feature is off.
        #[inline(always)]
        pub fn on_builtin(&mut self, _method: NativeMethod) {}
    }
}

#[cfg(not(feature = "cost-calibration"))]
pub use off::CostRecorder;

// ------------------------------------------------------------------------
// Feature ON: the histogram recorder + the CostModel work-function table.
// ------------------------------------------------------------------------

#[cfg(feature = "cost-calibration")]
mod on {
    use crate::interp::NativeMethod;
    use crate::opcode::{Opcode, CODE_NAMES, XS_CODE_COUNT};

    /// The per-opcode + per-builtin histogram (stage C1). Deterministic-safe
    /// (no clock): a `u64` execution count per key, one increment on an
    /// array the interpreter already touches — `n_dispatched` proved the
    /// pattern; this generalizes that scalar to a per-key array. Boxed so
    /// the interpreter struct stays small and the two dense arrays land off
    /// the stack.
    #[derive(Debug, Clone)]
    pub struct CostRecorder {
        /// Execution count per opcode, indexed by the opcode discriminant
        /// (`op as usize`, dense over `0..XS_CODE_COUNT`). The opcode enum is
        /// `#[repr(u8)]` and field-less, so the dense array is exact.
        opcodes: Box<[u64; XS_CODE_COUNT]>,
        /// Invocation count per native prototype method. `NativeMethod` has
        /// three data-carrying variants (`Math(MathId)`, `DataViewGet(u8)`,
        /// `DataViewSet(u8)`), so it is not a field-less enum and cannot key a
        /// dense array by discriminant; a map keyed by the method value is the
        /// clean equivalent (each distinct `Math(id)` / `DataViewGet(n)` is its
        /// own key, which is the finer granularity the report wants anyway).
        builtins: std::collections::HashMap<NativeMethod, u64>,
    }

    impl Default for CostRecorder {
        fn default() -> Self {
            CostRecorder {
                opcodes: Box::new([0u64; XS_CODE_COUNT]),
                builtins: std::collections::HashMap::new(),
            }
        }
    }

    impl CostRecorder {
        /// Record one bytecode dispatch. Called at the `tick_code` /
        /// `n_dispatched += 1` seam, so `opcode_total()` reconciles with
        /// `n_dispatched` exactly.
        #[inline]
        pub fn on_dispatch(&mut self, op: Opcode) {
            self.opcodes[op as usize] += 1;
        }

        /// Record one native builtin invocation, keyed by the dispatched
        /// prototype method. Called at the `call_native_method` dispatch
        /// seam.
        #[inline]
        pub fn on_builtin(&mut self, method: NativeMethod) {
            *self.builtins.entry(method).or_insert(0) += 1;
        }

        /// Total opcode dispatches recorded — reconciles with the
        /// interpreter's `n_dispatched` (the C1 acceptance check).
        pub fn opcode_total(&self) -> u64 {
            self.opcodes.iter().sum()
        }

        /// Total native builtin invocations recorded.
        pub fn builtin_total(&self) -> u64 {
            self.builtins.values().sum()
        }

        /// Raw execution count for one opcode.
        pub fn opcode_count(&self, op: Opcode) -> u64 {
            self.opcodes[op as usize]
        }

        /// A self-describing report keyed by human-readable opcode / builtin
        /// names — opcodes from the same generated `CODE_NAMES` table the
        /// meter uses, builtins from the `NativeMethod` variant name (derived
        /// `Debug`), so no second name list drifts. The C2 driver serializes
        /// this to the JSON report; C1 uses it for inspection and the
        /// reconciliation test. Only non-zero keys are emitted, so a report
        /// over a small program is small.
        pub fn report(&self) -> CostReport {
            let opcodes = self
                .opcodes
                .iter()
                .enumerate()
                .filter(|(_, &c)| c != 0)
                .map(|(i, &count)| HistogramEntry {
                    key: CODE_NAMES[i].to_string(),
                    work_model: CostModel::opcode_work(
                        Opcode::from_u8(i as u8).expect("dense opcode index"),
                    ),
                    count,
                })
                .collect();
            let mut builtins: Vec<HistogramEntry> = self
                .builtins
                .iter()
                .map(|(&m, &count)| HistogramEntry {
                    key: format!("{:?}", m),
                    work_model: CostModel::builtin_work(m),
                    count,
                })
                .collect();
            // Deterministic order (a `HashMap`'s iteration order is not):
            // most-invoked first, ties broken by key name.
            builtins.sort_by(|a, b| b.count.cmp(&a.count).then(a.key.cmp(&b.key)));
            CostReport { opcodes, builtins }
        }
    }

    /// One histogram row: a key, its expected work model (for the C2
    /// normalization), and its execution count. Timing (`normalized_ns_per_unit`
    /// in the design's JSON) is deliberately absent — C1 is histogram-only.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct HistogramEntry {
        pub key: String,
        pub work_model: WorkModel,
        pub count: u64,
    }

    /// The stage-C1 report: the two histograms, non-zero keys only. The C2
    /// driver extends this with the `reference_platform` and per-key
    /// normalized-timing distributions; C1 emits counts + the work model.
    #[derive(Debug, Clone, PartialEq, Eq, Default)]
    pub struct CostReport {
        pub opcodes: Vec<HistogramEntry>,
        pub builtins: Vec<HistogramEntry>,
    }

    /// The expected-work-function family for an opcode or builtin (design §
    /// "The complexity model"). `w(args)` is a polynomial in the operand
    /// **size** (lengths, byte/element counts) or **magnitude** (numeric
    /// value, iteration/allocation counts); normalized time is
    /// `t_measured / w(args)`, so a well-modeled family's normalized time is
    /// flat across inputs. This enum is the *classification* (data only in
    /// C1); [`WorkModel::evaluate`] turns it into work units once C2 feeds
    /// the per-dispatch operand sizes.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum WorkModel {
        /// `w = 1`. O(1) arithmetic/logic, stack & register moves, control
        /// transfer per dispatch, O(1) builtins (`Math.*`, scalar getters).
        Constant,
        /// `w = n`, the total code-unit length of the string operands
        /// touched (string concat / compare / index; linear `String.prototype`
        /// and structured-walk builtins where `n` is the code-unit/byte count).
        StringLength,
        /// `w = d`, the operand digit count (`≈ 1 + log₂(value)/32`) for the
        /// BigInt wide path.
        BigIntDigits,
        /// `w = 1 + p`, the prototype-chain hops walked to resolve a property
        /// (XS has no shapes; lookup is a linked-list scan, so a later
        /// refinement adds `+ o`, the own-property index of the hit).
        PropertyChain,
        /// `w = s + b`, slots allocated plus chunk bytes, for object/array
        /// construction (the allocation-faithful metering already ties this
        /// to construction size).
        AllocSize,
        /// `w = 1 + a`, the argument count copied into the frame, for call &
        /// return.
        CallArgs,
        /// `w = k`, elements iterated/produced (iteration protocol; linear
        /// collection builtins where `k` is the element count).
        IterCount,
        /// `w = n·log₂ n` — the explicit non-linear term for `sort`.
        NLogN,
        /// `w = b`, adjusted chunk bytes (the `fxNewChunk` allocation seam).
        ChunkBytes,
    }

    /// The operand sizes/magnitudes a work function reads. Every field is
    /// already in hand at the metering seam (design § "Where the operand
    /// sizes/magnitudes come from"); C1 defines the shape, C2 populates and
    /// consumes it. Unused fields default to zero.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    pub struct WorkInputs {
        /// String code-unit length (`StringLength`).
        pub code_units: u64,
        /// BigInt digit count (`BigIntDigits`).
        pub digits: u64,
        /// Prototype-chain hops walked (`PropertyChain`).
        pub proto_hops: u64,
        /// Slots allocated (`AllocSize`).
        pub slots: u64,
        /// Chunk bytes allocated (`AllocSize`, `ChunkBytes`).
        pub bytes: u64,
        /// Argument count (`CallArgs`).
        pub argc: u64,
        /// Elements iterated/processed (`IterCount`, `NLogN`).
        pub elements: u64,
    }

    impl WorkModel {
        /// Evaluate the expected work units for these operand sizes. A
        /// family whose normalized time `t / evaluate(..)` is flat across
        /// inputs is well-modeled; C2 divides each timed sample by this.
        /// Never returns zero (a zero work unit would make normalized time
        /// infinite), clamping to 1.
        pub fn evaluate(self, args: &WorkInputs) -> u64 {
            let w = match self {
                WorkModel::Constant => 1,
                WorkModel::StringLength => args.code_units,
                WorkModel::BigIntDigits => args.digits,
                WorkModel::PropertyChain => 1 + args.proto_hops,
                WorkModel::AllocSize => args.slots + args.bytes,
                WorkModel::CallArgs => 1 + args.argc,
                WorkModel::IterCount => args.elements,
                WorkModel::NLogN => {
                    let n = args.elements;
                    // n·⌊log₂ n⌋, floored at n so a 0/1-element sort is n.
                    // `63 - leading_zeros` is the index of the highest set bit
                    // = ⌊log₂⌋; `n | 1` keeps n=0 well-defined.
                    let log2 = 63u64.saturating_sub((n | 1).leading_zeros() as u64);
                    n.saturating_mul(log2.max(1))
                }
                WorkModel::ChunkBytes => args.bytes,
            };
            w.max(1)
        }

        /// A short human label for the report's `work_model` field.
        pub fn label(self) -> &'static str {
            match self {
                WorkModel::Constant => "1",
                WorkModel::StringLength => "n:code-units",
                WorkModel::BigIntDigits => "d:digits",
                WorkModel::PropertyChain => "1+p:proto-hops",
                WorkModel::AllocSize => "s+b:slots+bytes",
                WorkModel::CallArgs => "1+a:argc",
                WorkModel::IterCount => "k:elements",
                WorkModel::NLogN => "n·log n",
                WorkModel::ChunkBytes => "b:bytes",
            }
        }
    }

    /// The reviewable work-function table (design § "Families and their
    /// expected work functions"). Data only: it maps each opcode / builtin to
    /// its expected [`WorkModel`], the *initial hypothesis* the C2 timing run
    /// validates (a non-flat family is a modeling finding, not a calibration
    /// constant). Nothing in the interpreter hot loop consults it; it is
    /// editable without touching dispatch.
    pub struct CostModel;

    impl CostModel {
        /// The expected work model for one opcode. Unlisted opcodes are
        /// `Constant` (the O(1) arithmetic / stack-move / control-transfer
        /// bulk of the ISA); the non-constant families the design calls out
        /// are enumerated explicitly.
        pub fn opcode_work(op: Opcode) -> WorkModel {
            use Opcode::*;
            match op {
                // String-content ops (STRING_METERING path). `ADD` is dual —
                // the string-concat path is O(n); the numeric path is O(1).
                // The model names the size-driven path (C2 splits the sample
                // by operand kind); a numeric-only `ADD` reads `code_units=0`
                // and `evaluate` clamps to 1.
                XS_CODE_ADD => WorkModel::StringLength,
                // Numeric wide path (BIGINT_METERING) — decode of BigInt
                // literals scales with digit count.
                XS_CODE_BIGINT_1 | XS_CODE_BIGINT_2 => WorkModel::BigIntDigits,
                // Property access — linked-list scan of the prototype chain.
                XS_CODE_GET_PROPERTY
                | XS_CODE_SET_PROPERTY
                | XS_CODE_GET_PROPERTY_AT
                | XS_CODE_SET_PROPERTY_AT
                | XS_CODE_DELETE_PROPERTY
                | XS_CODE_DELETE_PROPERTY_AT
                | XS_CODE_IN
                | XS_CODE_GET_SUPER
                | XS_CODE_GET_SUPER_AT => WorkModel::PropertyChain,
                // Object / array construction — slots + chunk bytes.
                XS_CODE_OBJECT
                | XS_CODE_ARRAY
                | XS_CODE_NEW_PROPERTY
                | XS_CODE_NEW_PROPERTY_AT
                | XS_CODE_COPY_OBJECT
                | XS_CODE_NEW => WorkModel::AllocSize,
                // Call & return — argument count copied into the frame. The
                // `RUN*` family drives the callee frame; `CALL` resolves the
                // callee.
                XS_CODE_CALL | XS_CODE_RUN | XS_CODE_RUN_1 | XS_CODE_RUN_2 | XS_CODE_RUN_4
                | XS_CODE_RUN_TAIL | XS_CODE_RUN_TAIL_1 | XS_CODE_RUN_TAIL_2
                | XS_CODE_RUN_TAIL_4 => WorkModel::CallArgs,
                // Iteration protocol — elements produced (aggregate; the
                // per-element cost is the loop body's own opcodes).
                XS_CODE_FOR_OF | XS_CODE_FOR_IN | XS_CODE_FOR_AWAIT_OF => WorkModel::IterCount,
                // Everything else — stack/register moves, O(1) arithmetic &
                // logic, branches, literals — is constant work per dispatch.
                _ => WorkModel::Constant,
            }
        }

        /// The expected work model for one native builtin. Linear-collection
        /// methods scale with the element/code-unit count; `sort` is the
        /// explicit `n·log n`; structured walks (`JSON`) scale with input
        /// size; the scalar `Math.*` / getters are O(1).
        pub fn builtin_work(m: NativeMethod) -> WorkModel {
            use NativeMethod::*;
            match m {
                // Linear collection sweeps — element or code-unit count.
                ArrayMap | ArrayForEach | ArrayFilter | ArrayReduce | ArrayJoin | ArrayIndexOf
                | ArrayLastIndexOf | ArraySlice | ArrayConcat | ArrayIncludes | ArrayFill
                | ArrayReverse | ArrayValues | ArrayKeys | ArrayEntries => WorkModel::IterCount,
                // Explicit non-linear term.
                ArraySort => WorkModel::NLogN,
                // String linear sweeps — code-unit count.
                StringSlice | StringIndexOf | StringLastIndexOf | StringRepeat | StringConcat
                | StringSubstring | StringIncludes | StringStartsWith | StringEndsWith
                | StringTrim | StringTrimStart | StringTrimEnd | StringToLowerCase
                | StringToUpperCase => WorkModel::StringLength,
                // Structured walks — input byte / output node count.
                JsonParse | JsonStringify => WorkModel::StringLength,
                // Everything else — scalar `Math.*`, getters, `valueOf`,
                // `Symbol` ops, O(1) array mutators — is constant.
                _ => WorkModel::Constant,
            }
        }
    }
}

#[cfg(feature = "cost-calibration")]
pub use on::{CostModel, CostRecorder, CostReport, HistogramEntry, WorkInputs, WorkModel};

// ------------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------------

/// Firewall proof (off side): the recorder is zero-sized, so the `cost`
/// field adds no storage to `Interp` and its `on_*` calls in the hot loop
/// have nothing to touch — LLVM deletes them, keeping `dispatch_at`
/// instruction-identical to the pre-instrumentation build (the disassembly
/// diff the C1 acceptance bar calls for; this is the cheap structural
/// counterpart, checkable without objdump).
#[cfg(all(test, not(feature = "cost-calibration")))]
mod firewall_off_tests {
    use super::CostRecorder;

    #[test]
    fn recorder_is_zero_sized_when_off() {
        assert_eq!(
            std::mem::size_of::<CostRecorder>(),
            0,
            "the off-configuration recorder must be zero-sized so it adds \
             nothing to the metered hot loop"
        );
    }
}

#[cfg(all(test, feature = "cost-calibration"))]
mod on_tests {
    use super::*;
    use crate::interp::NativeMethod;
    use crate::opcode::Opcode;

    #[test]
    fn histogram_counts_totals_and_per_key() {
        let mut r = CostRecorder::default();
        r.on_dispatch(Opcode::XS_CODE_ADD);
        r.on_dispatch(Opcode::XS_CODE_ADD);
        r.on_dispatch(Opcode::XS_CODE_RETURN);
        r.on_builtin(NativeMethod::ArrayPush);
        r.on_builtin(NativeMethod::ArrayPush);
        r.on_builtin(NativeMethod::ArraySort);

        assert_eq!(r.opcode_total(), 3);
        assert_eq!(r.builtin_total(), 3);
        assert_eq!(r.opcode_count(Opcode::XS_CODE_ADD), 2);
        assert_eq!(r.opcode_count(Opcode::XS_CODE_RETURN), 1);
        assert_eq!(r.opcode_count(Opcode::XS_CODE_SUBTRACT), 0);
    }

    #[test]
    fn report_is_self_describing_and_deterministically_ordered() {
        let mut r = CostRecorder::default();
        r.on_dispatch(Opcode::XS_CODE_ADD);
        r.on_builtin(NativeMethod::ArrayPush);
        r.on_builtin(NativeMethod::ArrayPush);
        r.on_builtin(NativeMethod::ArraySort);
        let rep = r.report();

        // Only non-zero opcode keys, named from CODE_NAMES, with the work
        // model attached.
        assert_eq!(rep.opcodes.len(), 1);
        // Opcode keys are the XS mnemonic from the generated `CODE_NAMES`
        // table (lowercase), the same names the meter's tables carry.
        assert_eq!(rep.opcodes[0].key, "add");
        assert_eq!(rep.opcodes[0].count, 1);
        assert_eq!(rep.opcodes[0].work_model, WorkModel::StringLength);

        // Builtins sorted most-invoked first, keyed by the variant name.
        assert_eq!(rep.builtins.len(), 2);
        assert_eq!(rep.builtins[0].key, "ArrayPush");
        assert_eq!(rep.builtins[0].count, 2);
        assert_eq!(rep.builtins[1].key, "ArraySort");
        assert_eq!(rep.builtins[1].work_model, WorkModel::NLogN);
    }

    #[test]
    fn work_model_evaluate_scales_and_clamps() {
        // Constant is input-independent.
        assert_eq!(WorkModel::Constant.evaluate(&WorkInputs::default()), 1);
        // StringLength scales with code units, and a zero-length operand
        // clamps to 1 (never a zero divisor).
        let s = |n| WorkInputs {
            code_units: n,
            ..Default::default()
        };
        assert_eq!(WorkModel::StringLength.evaluate(&s(10)), 10);
        assert_eq!(WorkModel::StringLength.evaluate(&s(0)), 1);
        // CallArgs is 1 + argc.
        let a = |argc| WorkInputs {
            argc,
            ..Default::default()
        };
        assert_eq!(WorkModel::CallArgs.evaluate(&a(3)), 4);
        // PropertyChain is 1 + hops.
        let p = |h| WorkInputs {
            proto_hops: h,
            ..Default::default()
        };
        assert_eq!(WorkModel::PropertyChain.evaluate(&p(2)), 3);
        // NLogN grows super-linearly: 8 elements → 8 * 3.
        let e = |k| WorkInputs {
            elements: k,
            ..Default::default()
        };
        assert_eq!(WorkModel::NLogN.evaluate(&e(8)), 24);
        assert!(WorkModel::NLogN.evaluate(&e(1024)) > WorkModel::IterCount.evaluate(&e(1024)));
    }

    #[test]
    fn cost_model_table_classifies_the_design_families() {
        use Opcode::*;
        // O(1) bulk defaults to constant work.
        assert_eq!(CostModel::opcode_work(XS_CODE_POP), WorkModel::Constant);
        assert_eq!(
            CostModel::opcode_work(XS_CODE_SUBTRACT),
            WorkModel::Constant
        );
        // The non-constant families the design calls out.
        assert_eq!(CostModel::opcode_work(XS_CODE_ADD), WorkModel::StringLength);
        assert_eq!(CostModel::opcode_work(XS_CODE_CALL), WorkModel::CallArgs);
        assert_eq!(
            CostModel::opcode_work(XS_CODE_GET_PROPERTY),
            WorkModel::PropertyChain
        );
        assert_eq!(CostModel::opcode_work(XS_CODE_OBJECT), WorkModel::AllocSize);
        assert_eq!(CostModel::opcode_work(XS_CODE_FOR_OF), WorkModel::IterCount);

        // Builtin families.
        assert_eq!(
            CostModel::builtin_work(NativeMethod::ArraySort),
            WorkModel::NLogN
        );
        assert_eq!(
            CostModel::builtin_work(NativeMethod::ArrayMap),
            WorkModel::IterCount
        );
        assert_eq!(
            CostModel::builtin_work(NativeMethod::StringSlice),
            WorkModel::StringLength
        );
        assert_eq!(
            CostModel::builtin_work(NativeMethod::JsonParse),
            WorkModel::StringLength
        );
        assert_eq!(
            CostModel::builtin_work(NativeMethod::ObjectValueOf),
            WorkModel::Constant
        );
    }
}
