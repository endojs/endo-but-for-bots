//! The coder — a transliteration of `c/moddable/xs/sources/xsCode.c` at
//! the oracle pin (design § roadmap row 5; Design Decisions 4 and 5).
//! It is the last stratum of the stage-5 pipeline (lexer → parser →
//! scoper → **coder**) and the first that produces the byte-identity
//! evidence the stage bar is measured against: `compile(src)` must equal
//! `xs_oracle::run(src).bytecode` byte for byte.
//!
//! **Scope of this child (5/7).** The emitter *framework* is ported in
//! full and faithfully: the code-record list ([`Code`]), the `fxCoderAdd*`
//! constructors, targets/fixups, stack-depth accounting, and — the part
//! that visibly shapes the bytes — XS's exact **three-pass** serializer
//! (`fxParserCode`): pass 1 sizes every record with branches assumed
//! widest and accrues the `delta` slack; pass 2 chooses each branch's
//! `_1`/`_2`/`_4` width from the now-known target offsets, narrowing
//! `size`; pass 3 emits the bytes with the chosen widths and the
//! back-patched branch displacements. That is ported as the algorithm,
//! not an equivalent.
//!
//! The *node* surface ported here is the expression + simple-statement
//! half of `xsCode.c`: literals of every scalar kind, every
//! unary/binary/relational/logical/coalescing operator, the conditional,
//! sequence, expression statements, `if`/`else`, and blocks — the
//! constructs whose emission needs neither the scoper's per-access slot
//! resolution nor a nested function body. Identifier/property
//! loads-and-stores, `var`/lexical declarations, calls, `new`, member
//! access, object/array/template construction, and destructuring are the
//! back half, deferred to child 6; the honest fold is named in the
//! crate README and the completion report.
//!
//! **Child 6, first slice: symbol-free control flow.** The loop forms
//! (`while` / `do` / C-style `for`), labeled statements with break /
//! continue resolution (XS's `firstBreakTarget` / `firstContinueTarget`
//! label-target stacks and the environment/scope adjustments), `switch`,
//! `throw`, `debugger`, and `try` / `catch` / `finally` (including the
//! alias / finalize / jump target machinery that threads break / continue
//! / return out through a `finally` via the selector local) are ported
//! here. What each of these needs and *doesn't* yet have is a symbol
//! (atom) table: a declaring loop / block / `switch` scope, a `catch(e)`
//! binding, `for-in` / `for-of` / `for-await-of` (they emit `GET_PROPERTY
//! next` etc.), and `with` all reach a `NEW_LOCAL` / `SYMBOL` op keyed on
//! a source name, so they assert loudly and are deferred to the
//! atom-table slice. `for(let …)` / declaring cases are the same fold.

#![allow(clippy::too_many_arguments)]

use crate::ast::{Item, Node, Value};
use crate::opcodes::*;
use crate::scoper::{node_key, ScopeTree};
use crate::token::Token;
use std::collections::HashMap;

/// The payload a code record carries beside its mutable `id`. Mirrors the
/// `txByteCode` subtype union XS switches on: a plain byte, a branch to a
/// target, a placed target (`XS_NO_CODE`), an index/integer/number/string
/// operand, or a symbol/variable (deferred to child 6, modeled so the
/// framework compiles).
#[derive(Clone, Debug)]
enum Payload {
    /// A fixed opcode with no operand.
    Byte,
    /// A placed target (`XS_NO_CODE`): its `offset` is set each sizing
    /// pass. `tid` indexes the target arena.
    Target { tid: usize },
    /// A branch/`CODE`/`CATCH` record referencing target `tid`.
    Branch { tid: usize },
    /// A `u1`/`u2` index operand (`BEGIN_*`, `RESERVE_1`, `UNWIND_1`,
    /// `LINE`, `HOST`, `NEW_TEMPORARY`…). `plus_one` selects the
    /// local/closure family whose serialized value is `index + 1`.
    Index { index: i32, plus_one: bool },
    /// A signed integer operand (`INTEGER_1`, `RUN_1`, `RUN_TAIL_1`).
    Integer { value: i32 },
    /// An IEEE-754 double operand (`NUMBER`).
    Number { value: f64 },
    /// A string operand (`STRING_1`): `bytes` includes XS's trailing NUL,
    /// and `len` (== `bytes.len()`) is both the emitted length and the
    /// width selector.
    Str { bytes: Vec<u8>, len: i32 },
    /// A symbol operand (`GET_VARIABLE` / `GET_PROPERTY` / …). Carries the
    /// index of the interned symbol in the coder's atom table; the emitted
    /// 2-byte `txID` is resolved from that table's bucket-walk assignment
    /// once every emitted symbol's `usage` is known.
    Symbol { sym: usize },
    /// A BigInt operand (`BIGINT_1`): the value as XS stores it — a
    /// little-endian array of `txU4` limbs (`bigint->data`) — with
    /// `measure` (== `bytes.len()`, `bigint->size * 4`) the emitted
    /// length and width selector.
    BigInt { bytes: Vec<u8>, measure: i32 },
}

/// Encode UTF-16 code `units` as XS's CESU-8 string-literal payload,
/// byte-for-byte with `fxCESU8Encode` (`c/moddable/xs/sources/xsCommon.c`):
/// each code unit is its own 1–3 byte sequence, so a surrogate half is a
/// 3-byte unit (a lone surrogate survives; an astral scalar, stored as a
/// surrogate pair, is 6 bytes) and — the modified-UTF-8 corner — an embedded
/// NUL is the overlong `0xC0 0x80` rather than a raw `0x00`, so the coder's
/// own trailing `0x00` terminator stays unambiguous. This is the exact
/// inverse of the engine's `cesu8_to_units` decoder.
fn units_to_cesu8(units: &[u16]) -> Vec<u8> {
    let mut out = Vec::with_capacity(units.len());
    for &u in units {
        let c = u as u32;
        if c == 0 {
            out.push(0xC0);
            out.push(0x80);
        } else if c < 0x80 {
            out.push(c as u8);
        } else if c < 0x800 {
            out.push(0xC0 | (c >> 6) as u8);
            out.push(0x80 | (c & 0x3F) as u8);
        } else {
            out.push(0xE0 | (c >> 12) as u8);
            out.push(0x80 | ((c >> 6) & 0x3F) as u8);
            out.push(0x80 | (c & 0x3F) as u8);
        }
    }
    out
}

// ============================= atom table ==============================

/// XS's `parserTableModulo` at the oracle pin (the shim's creation record,
/// `xs_shim.c`). The symbol hash bucket count.
const SYMBOL_MODULO: u32 = 1993;

/// `XS_DONT_ENUM_FLAG` (`xsCommon.h`) — the attribute a plain function's
/// synthetic `caller` own property carries.
const XS_DONT_ENUM_FLAG: i32 = 4;

/// `XS_NAME_FLAG` (`xsCommon.h`) — the `NEW_PROPERTY` attribute bit that
/// tells the interpreter to infer an anonymous function/class value's
/// `.name` from the property key.
const XS_NAME_FLAG: i32 = 1;

/// The `MODULE` opcode's flag byte bits (`xsCommon.h`): a non-strict
/// (JSON) module, a module that uses dynamic `import(...)`, and one that
/// uses `import.meta`, respectively.
const XS_JSON_MODULE_FLAG: i32 = 16;
const XS_IMPORT_FLAG: i32 = 32;
const XS_IMPORT_META_FLAG: i32 = 64;

/// `XS_METHOD_FLAG` / `XS_GETTER_FLAG` / `XS_SETTER_FLAG` (`xsCommon.h`) —
/// the `NEW_PROPERTY` attribute bits marking a concise method or an
/// accessor (the runtime binds the value's home object and, for accessors,
/// installs it as a getter/setter).
const XS_METHOD_FLAG: i32 = 16;
const XS_GETTER_FLAG: i32 = 32;
const XS_SETTER_FLAG: i32 = 64;

/// One field's 1-based alias slots into its field-init function's own frame
/// — the `RETRIEVE` slot each captured class-scope closure lands in. A plain
/// data field captures nothing; a computed-key field captures `atAccess`; a
/// private field captures `symbolAccess`; a private method also captures
/// `valueAccess`.
#[derive(Clone, Copy, Default)]
struct FieldPlan {
    at: Option<i32>,
    symbol: Option<i32>,
    value: Option<i32>,
}

/// The built-in symbols `fxInitializeParser` interns *before* lexing, in
/// exact source order (`xsScript.c`). They occupy their hash buckets ahead
/// of every program symbol, so their position is part of the ID contract
/// whenever the program (or the coder) emits one of them.
const SEED_SYMBOLS: &[&str] = &[
    "Object", "__dirname", "__filename", "__jsx__", "__proto__", "*", "args",
    "arguments", "=>", "as", "async", "await", "call", "caller", "constructor",
    "default", "done", "eval", "exports", "fill", "freeze", "from", "get", "id",
    "include", "Infinity", "json", "length", "let", "meta", "module", "name",
    "NaN", "Native", "native", "next", "new.target", "of", "#constructor",
    "prototype", "RangeError", "raw", "return", "set", "slice", "SyntaxError",
    "static", "String", "target", "this", "throw", "toString", "undefined",
    "uri", "using", "value", "with", "yield",
];

/// One interned symbol — XS's `txSymbol` (the fields the coder reads).
#[derive(Clone, Debug)]
struct SymEntry {
    /// The interned spelling (kept for the atom-table dump / debugging).
    #[allow(dead_code)]
    string: String,
    /// `sum % symbolModulo`.
    bucket: u32,
    /// `usage & 1` — set when the symbol is actually emitted in code; only
    /// used symbols are assigned an ID.
    usage: bool,
    /// The assigned `txID` (1-based), or 0 until [`SymbolTable::assign_ids`].
    id: i32,
}

/// The parser/coder symbol table — a transliteration of `parser->symbolTable`
/// and the `fxNewParserSymbol` interning discipline: hash by
/// `sum = Σ (sum<<1 + ch)` masked to 31 bits, bucket `sum % modulo`, new
/// symbols **prepended** to their bucket. IDs are assigned by walking the
/// buckets in index order and, within a bucket, most-recent-first (prepend
/// order), numbering only the `usage` symbols — exactly `fxParserCode`'s
/// symbol-table walk. That order leaks into every symbol operand's bytes.
struct SymbolTable {
    /// Interned symbols in insertion (chronological) order.
    entries: Vec<SymEntry>,
    index: HashMap<String, usize>,
}

impl SymbolTable {
    /// A table pre-seeded with the built-in symbols, matching XS's
    /// `fxInitializeParser`.
    fn seeded() -> SymbolTable {
        let mut t = SymbolTable { entries: Vec::new(), index: HashMap::new() };
        for s in SEED_SYMBOLS {
            t.intern(s);
        }
        t
    }

    /// `fxNewParserSymbol`'s hash: `sum = (sum << 1) + ch` over the bytes
    /// (C promotes `char`, signed on the pin's platform, to `int`), masked
    /// to 31 bits.
    fn hash(s: &str) -> u32 {
        let mut sum: u32 = 0;
        for &b in s.as_bytes() {
            sum = sum.wrapping_shl(1).wrapping_add((b as i8 as i32) as u32);
        }
        sum & 0x7FFF_FFFF
    }

    /// Intern `s`, returning its stable index. New symbols get a bucket but
    /// no usage; re-interning returns the existing index.
    fn intern(&mut self, s: &str) -> usize {
        if let Some(&i) = self.index.get(s) {
            return i;
        }
        let bucket = SymbolTable::hash(s) % SYMBOL_MODULO;
        let i = self.entries.len();
        self.entries.push(SymEntry { string: s.to_string(), bucket, usage: false, id: 0 });
        self.index.insert(s.to_string(), i);
        i
    }

    /// Intern `s` and mark it emitted (`usage |= 1`), returning its index.
    fn use_symbol(&mut self, s: &str) -> usize {
        let i = self.intern(s);
        self.entries[i].usage = true;
        i
    }

    /// `fxParserCode`'s ID walk: buckets in index order, most-recent-first
    /// within each bucket, numbering only `usage` symbols from 1.
    fn assign_ids(&mut self) {
        // Per-bucket index lists in prepend (reverse-insertion) order.
        let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); SYMBOL_MODULO as usize];
        for i in 0..self.entries.len() {
            buckets[self.entries[i].bucket as usize].push(i);
        }
        let mut id: i32 = 1;
        for bucket in &buckets {
            for &i in bucket.iter().rev() {
                if self.entries[i].usage {
                    self.entries[i].id = id;
                    id += 1;
                }
            }
        }
    }

    /// The id-by-index table for emission.
    fn id_table(&self) -> Vec<i32> {
        self.entries.iter().map(|e| e.id).collect()
    }

    /// Serialize the used symbols into the XS **symbols atom** wire
    /// format — `fxParserCode`'s `script->symbolsBuffer` (`xsCode.c`),
    /// exactly what `xs_oracle::run(source).symbols` returns and what
    /// `ironhorse_vm::parse_symbols` decodes.
    ///
    /// Layout: a 2-byte little-endian count = `used + 1` (`mxEncodeID` with
    /// `sizeof(txID) == 2`; the `+1` reserves id 0 = `XS_NO_ID`), then, for
    /// every used symbol in **id order**, its bytes *including the trailing
    /// NUL* (XS's `symbol->length` counts the terminator, and `c_memcpy`
    /// copies it). The id-order walk is `fxParserCode`'s: buckets in index
    /// order, and within a bucket most-recent-first (the prepend order),
    /// numbering only `usage` symbols — the identical walk
    /// [`assign_ids`] uses, so the strings land in ascending id order.
    ///
    /// Even a symbol-free program yields a 2-byte `01 00` atom (`total`
    /// starts at `sizeof(txID)`), matching XS, which always allocates the
    /// count. Call after [`assign_ids`].
    fn symbols_atom(&self) -> Vec<u8> {
        let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); SYMBOL_MODULO as usize];
        for i in 0..self.entries.len() {
            buckets[self.entries[i].bucket as usize].push(i);
        }
        let mut used: u16 = 0;
        let mut body: Vec<u8> = Vec::new();
        for bucket in &buckets {
            for &i in bucket.iter().rev() {
                let e = &self.entries[i];
                if e.usage {
                    used = used.wrapping_add(1);
                    // The interned spelling verbatim, then the NUL XS's
                    // `symbol->length` includes.
                    body.extend_from_slice(e.string.as_bytes());
                    body.push(0);
                }
            }
        }
        // count = final `id` in `fxParserCode` = used + 1 (id starts at 1).
        let count = used.wrapping_add(1);
        let mut atom = Vec::with_capacity(2 + body.len());
        atom.extend_from_slice(&count.to_le_bytes());
        atom.append(&mut body);
        atom
    }
}

/// One code record — XS's `txByteCode` with its subtype fields. `id` is
/// the opcode byte value and is *mutated* across the sizing passes
/// exactly as `fxParserCode` mutates `code->id` (a contiguous `+1`/`+2`
/// widens `_1`→`_2`→`_4`).
#[derive(Clone, Debug)]
struct Code {
    id: i32,
    stack_level: i32,
    payload: Payload,
}

/// A branch target — XS's `txTargetCode`. `offset` is the byte position
/// the target resolves to, recomputed each sizing pass. The
/// `environment_level` / `scope_level` / `stack_level` snapshots and the
/// `labels` / `next_target` / `original` fields are the coder's live
/// target-stack machinery (`firstBreakTarget` / `firstContinueTarget` /
/// `returnTarget`), consumed by break/continue resolution and the `try`
/// finalizer.
#[derive(Clone, Debug, Default)]
struct Target {
    index: u32,
    offset: i32,
    used: bool,
    /// The environment (`with`) nesting the target was created at.
    environment_level: i32,
    /// The frame slot level the target was created at.
    scope_level: i32,
    /// The stack depth the target was created at.
    stack_level: i32,
    /// The label symbols a break/continue target answers to (XS's
    /// `target->label` `nextLabel` chain). `None` is the anonymous
    /// (loop / `switch`) label; a `Some(name)` is a labeled statement.
    labels: Vec<Option<String>>,
    /// The next target down the break/continue/return stack.
    next_target: Option<usize>,
    /// For a `try` alias, the original target it forwards to.
    original: Option<usize>,
}

/// The coder — XS's `txCoder`. Holds the record list, the target arena,
/// the running stack/scope counters, and the program/eval flags the node
/// emitters branch on.
pub struct Coder<'a> {
    codes: Vec<Code>,
    targets: Vec<Target>,
    stack_level: i32,
    scope_level: i32,
    environment_level: i32,
    target_index: u32,
    program_flag: bool,
    eval_flag: bool,
    /// XS's `coder->firstBreakTarget` / `firstContinueTarget` /
    /// `returnTarget` — heads of the target stacks the loop / `switch` /
    /// `try` / label coders push and pop.
    first_break_target: Option<usize>,
    first_continue_target: Option<usize>,
    return_target: Option<usize>,
    /// XS's `coder->chainTarget` — the short-circuit target of the
    /// enclosing optional chain (`a?.b?.c`). An `Option` link (`?.`) branches
    /// here with `BRANCH_CHAIN` when its base is `null`/`undefined`, leaving
    /// the whole chain's value `undefined`; the `Chain` wrapper creates and
    /// places it. `None` outside a chain.
    chain_target: Option<usize>,
    /// The atom table (`parser->symbolTable`), seeded with the built-ins.
    symbols: SymbolTable,
    tree: &'a ScopeTree,
    /// The frame slot each declaration was assigned during scope coding
    /// (XS writes `node->index` in `fxScopeCodingBlock`/`Eval`; a resolved
    /// access reads it back). Keyed by `(scope index, declare id)`.
    decl_index: HashMap<(usize, u32), i32>,
    /// `Define` nodes already coded (XS's `mxDefineNodeCodedFlag`): a
    /// function declaration is hoisted and emitted by `fxScopeCodeDefineNodes`
    /// at the top of its scope, so its second reach — the in-list statement
    /// — is a no-op. Keyed by node address.
    defined: std::collections::HashSet<usize>,
    /// The name inferred for the next anonymous function/class value from
    /// its binding/assignment target (XS sets `node->symbol` before the
    /// value is coded, so the name lands in the `CONSTRUCTOR_FUNCTION` /
    /// `FUNCTION` operand). Set by the naming site, consumed by
    /// `code_function`.
    pending_name: Option<String>,
    /// Staged for the next function value: it is an object/class accessor
    /// (getter/setter). XS marks the function node itself `mxGetterFlag`/
    /// `mxSetterFlag`, but the Rust parser stamps those on the *property*,
    /// so the naming site relays it here to pick the `FUNCTION`
    /// creation-op. Captured (and cleared) at the top of `code_function`.
    pending_accessor: bool,
    /// XS's `mxExpressionNoValue`, staged for the *next* dispatched node: a
    /// statement or `for` iteration discards its expression's value, so a
    /// trailing increment/decrement or short-circuit assignment skips
    /// producing one. Captured (and cleared) at the top of `code_node` so
    /// it applies only to the immediate expression, not nested ones.
    no_value: bool,
    /// XS's `mxTailRecursionFlag`, staged for the *next* dispatched node: a
    /// call in tail position (a strict, non-generator `return f()`, and the
    /// tail-position operands short-circuit/comma/`?:` threads down to) emits
    /// the `RUN_TAIL` / `EVAL_TAIL` family instead of `RUN` / `EVAL`. Set on
    /// the return expression by `code_return` and re-set on the tail-position
    /// child by each propagating operator; captured (and cleared) at the top
    /// of `code_node` so it applies only to the immediate expression.
    tail: bool,
    /// XS's `coder->importFlag` / `coder->importMetaFlag` — set when the
    /// module body codes a dynamic `import(...)` / `import.meta`, folded into
    /// the `MODULE` opcode's flag byte. Only meaningful while coding a
    /// module; `false` for the static import/export surface.
    import_flag: bool,
    import_meta_flag: bool,
    /// XS's `the->tag` — the per-machine counter `fxGenerateTag` reads to
    /// mint a tagged template's unique cache-site symbol (`#0`, `#1`, …).
    /// The oracle compiles each program on a fresh machine (tag 0) with no
    /// source path, so a tagged template's cache symbol is `#<tag>`; the
    /// counter bumps at each tagged-template code site, in code order.
    tag: i32,
    /// The enclosing class's `instanceInit` closure declare `(scope, id)`,
    /// set while coding a class's constructor so its base-flag body can find
    /// the capturing alias and call the field initializer on entry (XS's
    /// `coder->classNode->instanceInitAccess`). `None` outside a
    /// field-bearing class constructor.
    class_instance_init: Option<(usize, u32)>,
    /// The first code-time `fxReportParserError` this pass raised (XS
    /// longjmps out on the first; ironhorse's coder is infallible, so it
    /// records the first here and `compile`/`compile_module` surface it
    /// after the pass). Currently the `fxDeclareNodeCode` "invalid const"
    /// / "invalid using" rejection of a bare `const`/`using` declaration
    /// with no initializer — a code-time check, so a `for (const x of y)`
    /// binding (coded through the reference/assign path, never
    /// `code_declare`) is correctly exempt.
    error: Option<crate::parser::ParseError>,
    /// Tree levels currently on the native stack (see
    /// [`crate::scoper::TREE_DEPTH_LIMIT`] and [`Self::code_node`]).
    depth: u32,
}

impl<'a> Coder<'a> {
    fn new(tree: &'a ScopeTree) -> Coder<'a> {
        Coder {
            codes: Vec::new(),
            targets: Vec::new(),
            stack_level: 0,
            scope_level: 0,
            environment_level: 0,
            target_index: 0,
            program_flag: false,
            eval_flag: false,
            import_flag: false,
            import_meta_flag: false,
            class_instance_init: None,
            first_break_target: None,
            first_continue_target: None,
            return_target: None,
            chain_target: None,
            symbols: SymbolTable::seeded(),
            tree,
            decl_index: HashMap::new(),
            defined: std::collections::HashSet::new(),
            pending_name: None,
            pending_accessor: false,
            no_value: false,
            tail: false,
            tag: 0,
            error: None,
            depth: 0,
        }
    }

    /// Record the first code-time `fxReportParserError` (XS would longjmp
    /// out here); later ones are ignored, matching XS reporting only the
    /// first.
    fn report(&mut self, line: u32, message: &str) {
        if self.error.is_none() {
            self.error = Some(crate::parser::ParseError {
                line,
                kind: crate::parser::ParseErrorKind::Syntax,
                message: message.to_string(),
            });
        }
    }

    /// `fxGenerateTag(console, buffer, size, C_NULL)` — mint the next
    /// tagged-template cache symbol (`#<tag>`) and bump the counter. The
    /// oracle passes no path (no `//# sourceURL=` comment), so the tag has
    /// no `@path` suffix.
    fn generate_tag(&mut self) -> String {
        let s = format!("#{}", self.tag);
        self.tag += 1;
        s
    }

    /// The declaration `(scope, id)` a node's symbol binds to (XS's
    /// `access->declaration`), or `None` for the symbol path.
    fn resolution_of(&self, node: &Node) -> Option<(usize, u32)> {
        self.tree.resolutions.get(&node_key(node)).copied().flatten()
    }

    /// A resolved declaration's `flags` word (for the closure test).
    fn declare_flags(&self, scope: usize, id: u32) -> u32 {
        self.tree.scopes[scope]
            .declares
            .iter()
            .find(|d| d.id == id)
            .map(|d| d.flags)
            .unwrap_or(0)
    }

    /// Whether a resolved declaration lives in a closure slot
    /// (`mxDeclareNodeClosureFlag`).
    fn is_closure(&self, scope: usize, id: u32) -> bool {
        self.declare_flags(scope, id) & crate::scoper::dflags::CLOSURE != 0
    }

    /// The frame slot a resolved declaration was assigned in scope coding.
    fn declare_index(&self, scope: usize, id: u32) -> i32 {
        *self
            .decl_index
            .get(&(scope, id))
            .expect("declaration index assigned before access")
    }

    /// The frame slot a declaration was assigned, or `None` if it never got
    /// one. `fxScopeCodeStoreAll` keys on `node->declaration` being non-null
    /// (the declare was bound and slotted); a declare with an assigned frame
    /// index is exactly that, so this is the store-all eligibility test.
    fn declare_index_opt(&self, scope: usize, id: u32) -> Option<i32> {
        self.decl_index.get(&(scope, id)).copied()
    }

    /// Pre-intern every source symbol in AST pre-order, mirroring XS's
    /// lex-time interning so the atom table's insertion order (and thus the
    /// bucket-list order that decides within-bucket IDs) matches. Runs once
    /// before coding; usage is set later, as each symbol is emitted.
    ///
    /// Fold: AST pre-order equals XS's lex order for the ported surface
    /// (identifier refs, member property names). Constructs where the
    /// parser interns in an order that diverges from AST pre-order (e.g.
    /// numeric/computed property keys, some declaration positions) are a
    /// named edge for the declaration/object slices.
    fn intern_tree(&mut self, item: &Item) {
        match item {
            Item::Symbol(s) => {
                self.symbols.intern(s);
            }
            Item::Node(n) => {
                for c in &n.children {
                    self.intern_tree(c);
                }
            }
            Item::List(items) => {
                for c in items {
                    self.intern_tree(c);
                }
            }
            Item::Null => {}
        }
    }

    /// `fxCoderAddSymbol` — emit a symbol-operand op, marking the symbol
    /// used so it earns an ID.
    fn add_symbol(&mut self, delta: i32, id: i32, name: &str) {
        let sym = self.symbols.use_symbol(name);
        self.add(delta, Payload::Symbol { sym }, id);
    }

    /// `fxCoderAddSymbol` with a `NULL` symbol — an anonymous function's
    /// name operand. XS serializes a null `txSymbol*` as id 0; the emitter
    /// reads 0 for any non-`Symbol` payload, so a plain `Byte` payload on a
    /// symbol-operand opcode emits the two zero bytes.
    fn add_symbol_null(&mut self, delta: i32, id: i32) {
        self.add(delta, Payload::Byte, id);
    }

    /// `fxCoderAddSymbol` for an optional name (anonymous → null symbol).
    fn add_symbol_opt(&mut self, delta: i32, id: i32, name: Option<&str>) {
        match name {
            Some(n) => self.add_symbol(delta, id, n),
            None => self.add_symbol_null(delta, id),
        }
    }

    /// `fxCoderAddVariable` — a `NEW_LOCAL`/`NEW_CLOSURE` record. XS stores
    /// both the symbol and the frame `index`, but serializes only the
    /// symbol (the index is tracked separately in [`Coder::decl_index`]),
    /// so this is a symbol op. A slotless (`NEW_TEMPORARY`) declare never
    /// reaches here.
    fn add_variable(&mut self, delta: i32, id: i32, symbol: Option<&str>, _index: i32) {
        let name = symbol.expect("NEW_LOCAL/NEW_CLOSURE needs a symbol");
        self.add_symbol(delta, id, name);
    }

    // ---- fxCoderAdd* constructors -----------------------------------

    fn add(&mut self, delta: i32, payload: Payload, id: i32) {
        self.stack_level += delta;
        let stack_level = self.stack_level;
        self.codes.push(Code { id, stack_level, payload });
    }

    fn add_byte(&mut self, delta: i32, id: i32) {
        self.add(delta, Payload::Byte, id);
    }

    fn add_index(&mut self, delta: i32, id: i32, index: i32) {
        self.add(delta, Payload::Index { index, plus_one: false }, id);
    }

    fn add_integer(&mut self, delta: i32, id: i32, value: i32) {
        self.add(delta, Payload::Integer { value }, id);
    }

    fn add_number(&mut self, delta: i32, id: i32, value: f64) {
        self.add(delta, Payload::Number { value }, id);
    }

    /// `fxCoderAddString`: XS stores `length + 1` (the trailing NUL) and
    /// copies that many bytes. `bytes` here already carries the NUL.
    fn add_string(&mut self, delta: i32, id: i32, bytes: Vec<u8>) {
        let len = bytes.len() as i32;
        self.add(delta, Payload::Str { bytes, len }, id);
    }

    /// `fxCoderAddBigInt`.
    fn add_bigint(&mut self, delta: i32, id: i32, bytes: Vec<u8>) {
        let measure = bytes.len() as i32;
        self.add(delta, Payload::BigInt { bytes, measure }, id);
    }

    /// `fxCoderCreateTarget` — a fresh target snapshotting the coder's
    /// current environment/scope/stack levels (break/continue resolution
    /// and the `try` finalizer read these back).
    fn create_target(&mut self) -> usize {
        let index = self.target_index;
        self.target_index += 1;
        self.targets.push(Target {
            index,
            environment_level: self.environment_level,
            scope_level: self.scope_level,
            stack_level: self.stack_level,
            ..Target::default()
        });
        self.targets.len() - 1
    }

    fn add_branch(&mut self, delta: i32, id: i32, tid: usize) {
        self.targets[tid].used = true;
        self.add(delta, Payload::Branch { tid }, id);
    }

    /// `fxCoderAdd(self, delta, target)` — place a created target into
    /// the record stream (`XS_NO_CODE`).
    fn place_target(&mut self, delta: i32, tid: usize) {
        self.add(delta, Payload::Target { tid }, XS_NO_CODE);
    }

    /// `fxCoderUseTemporaryVariable` — allocate the next frame slot and
    /// emit a bare `NEW_TEMPORARY` (a 1-byte opcode; its index is coder
    /// bookkeeping, not serialized). Returns the slot.
    fn use_temporary(&mut self) -> i32 {
        let result = self.scope_level;
        self.scope_level += 1;
        self.add_index(0, XS_CODE_NEW_TEMPORARY, result);
        result
    }

    /// `fxCoderUnuseTemporaryVariables`.
    fn unuse_temporaries(&mut self, count: i32) {
        self.add_index(0, XS_CODE_UNWIND_1, count);
        self.scope_level -= count;
    }

    /// `fxCoderAdjustEnvironment` — pop `with` environments down to a
    /// break/continue target's level.
    fn adjust_environment(&mut self, tid: usize) {
        let mut count = self.environment_level - self.targets[tid].environment_level;
        while count != 0 {
            self.add_byte(0, XS_CODE_WITHOUT);
            count -= 1;
        }
    }

    /// `fxCoderAdjustScope` — unwind frame slots down to a target's level.
    fn adjust_scope(&mut self, tid: usize) {
        let count = self.scope_level - self.targets[tid].scope_level;
        if count != 0 {
            self.add_index(0, XS_CODE_UNWIND_1, count);
        }
    }

    // ---- scope helpers ----------------------------------------------

    /// The primary scope XS hung off `node`.
    fn scope_of(&self, node: &Node) -> usize {
        self.tree.node_scopes.get(&node_key(node)).expect("scope for node").0
    }

    /// The secondary scope XS hung off `node` (`statementScope` /
    /// `symbolScope`) — e.g. a `catch(e)` binding's block scope, reached
    /// by the deferred catch-parameter path.
    #[allow(dead_code)]
    fn scope_secondary(&self, node: &Node) -> usize {
        self.tree
            .node_scopes
            .get(&node_key(node))
            .expect("scope for node")
            .1
            .expect("secondary scope for node")
    }

    fn declare_count(&self, scope: usize) -> i32 {
        self.tree.scopes[scope].declare_count
    }

    // ---- scope coding -----------------------------------------------
    //
    // `fxScopeCodingBlock` / `fxScopeCoded` emit the `NEW_LOCAL` /
    // `NEW_CLOSURE` / `VAR_LOCAL` clusters that give each declaration its
    // frame slot (`node->index = coder->scopeLevel++`), and the matching
    // `UNWIND` teardown. `fxScopeCodeDefineNodes` (function/host defines)
    // stays deferred with the function slice.

    /// A snapshot of a scope's declare list — `(id, token, symbol, flags)`
    /// per declare, in XS's `firstDeclareNode`… order — taken so the
    /// coder can assign slots (a `&mut self` walk) without borrowing the
    /// immutable tree across the loop.
    fn declares_of(&self, scope: usize) -> Vec<(u32, Token, Option<crate::scoper::Sym>, u32)> {
        self.tree.scopes[scope]
            .declares
            .iter()
            .map(|d| (d.id, d.token, d.symbol.clone(), d.flags))
            .collect()
    }

    /// A declare symbol's name, or `None` for an anonymous (`Sym::Anon`) or
    /// absent symbol. An anonymous closure (XS's `symbol->ID == -1`, e.g. an
    /// `instanceInit` slot) still owns a frame slot — it serializes as the
    /// null symbol (`NEW_CLOSURE` with id 0) — but has no name.
    fn sym_name(s: &Option<crate::scoper::Sym>) -> Option<&str> {
        match s {
            Some(crate::scoper::Sym::Named(n)) => Some(n),
            _ => None,
        }
    }

    /// Assign one declaration its frame slot and remember it so a resolved
    /// access can read it back (`node->index = coder->scopeLevel++`).
    fn set_declare_index(&mut self, scope: usize, id: u32) -> i32 {
        let index = self.scope_level;
        self.scope_level += 1;
        self.decl_index.insert((scope, id), index);
        index
    }

    /// `fxScopeCodingBlock` — give every declaration in `scope` its frame
    /// slot and, for `var`, its `undefined` initialization; if the scope
    /// is a direct-`eval` scope, publish the slots into a `with`
    /// environment. Deferred: `Define`/`Private` declarations (the
    /// function/class slices) assert.
    fn scope_coding_block(&mut self, scope: usize) {
        if self.declare_count(scope) == 0 {
            return;
        }
        let is_eval = self.tree.scopes[scope].flags & crate::scoper::SCOPE_EVAL != 0;
        for (id, token, sym, flags) in self.declares_of(scope) {
            self.assert_declared_kind(token);
            let is_closure = flags & crate::scoper::dflags::CLOSURE != 0;
            if is_closure {
                if flags & crate::scoper::dflags::USE_CLOSURE == 0 {
                    let index = self.set_declare_index(scope, id);
                    // An anonymous closure (`instanceInit`) has a slot but no
                    // name — `NEW_CLOSURE` with the null symbol (id 0).
                    match Self::sym_name(&sym) {
                        Some(name) => self.add_variable(0, XS_CODE_NEW_CLOSURE, Some(name), index),
                        None => self.add_symbol_null(0, XS_CODE_NEW_CLOSURE),
                    }
                    if token == Token::Var {
                        self.add_byte(1, XS_CODE_UNDEFINED);
                        self.add_index(0, XS_CODE_VAR_CLOSURE_1, index);
                        self.add_byte(-1, XS_CODE_POP);
                    }
                }
            } else {
                let index = self.set_declare_index(scope, id);
                if let Some(name) = Self::sym_name(&sym) {
                    self.add_variable(0, XS_CODE_NEW_LOCAL, Some(name), index);
                } else {
                    self.add_index(0, XS_CODE_NEW_TEMPORARY, index);
                }
                if token == Token::Var {
                    self.add_byte(1, XS_CODE_UNDEFINED);
                    self.add_index(0, XS_CODE_VAR_LOCAL_1, index);
                    self.add_byte(-1, XS_CODE_POP);
                }
            }
        }
        if is_eval {
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(0, XS_CODE_WITH);
            for (id, _, _, _) in self.declares_of(scope) {
                let index = self.declare_index(scope, id);
                self.add_index(0, XS_CODE_STORE_1, index);
            }
            self.add_byte(-1, XS_CODE_POP);
            self.environment_level += 1;
        }
    }

    /// `fxScopeCoded` — the block teardown: a direct-`eval` block closes
    /// its `with` environment, then every scope unwinds its declared
    /// slots.
    fn scope_coded(&mut self, scope: usize) {
        let count = self.declare_count(scope);
        if count != 0 {
            if self.tree.scopes[scope].flags & crate::scoper::SCOPE_EVAL != 0 {
                self.environment_level -= 1;
                self.add_byte(0, XS_CODE_WITHOUT);
            }
            self.add_index(0, XS_CODE_UNWIND_1, count);
            self.scope_level -= count;
        }
    }

    /// The declaration kinds [`Coder::scope_coding_block`] codes. A `Define`
    /// (a hoisted function declaration's binding) allocates its slot here
    /// like any non-`var` declare — a `NEW_LOCAL`/`NEW_CLOSURE` with no
    /// value init (`fxScopeCodeDefineNodes` assigns the function value
    /// later). Class `Private`s remain the class slice and assert loudly.
    fn assert_declared_kind(&self, token: Token) {
        assert!(
            matches!(
                token,
                Token::Var
                    | Token::Let
                    | Token::Const
                    | Token::Using
                    | Token::Arg
                    | Token::Define
                    | Token::NoToken
            ),
            "declaration kind {:?} reached (function/class slice)",
            token
        );
    }

    /// `fxScopeCodeRefresh` — before a loop's test/update re-enters, rebind
    /// each declared slot to a fresh cell (`REFRESH_CLOSURE` for a captured
    /// binding, `REFRESH_LOCAL` for a plain one) so a closure formed in one
    /// iteration of `for (let i …)` does not alias the next iteration's `i`.
    /// A non-declaring scope emits nothing.
    fn scope_code_refresh(&mut self, scope: usize) {
        if self.declare_count(scope) == 0 {
            return;
        }
        for (id, _token, _sym, flags) in self.declares_of(scope) {
            let index = self.declare_index(scope, id);
            if flags & crate::scoper::dflags::CLOSURE != 0 {
                self.add_index(0, XS_CODE_REFRESH_CLOSURE_1, index);
            } else {
                self.add_index(0, XS_CODE_REFRESH_LOCAL_1, index);
            }
        }
    }

    /// `fxScopeCodeDefineNodes` for a scope with no define nodes (no-op).
    fn scope_code_define_nodes(&mut self, scope: usize) {
        assert!(
            self.tree.scopes[scope].defines.is_empty(),
            "define nodes reached in control-flow coder (function slice)"
        );
    }

    /// `fxScopeCodeDefineNodes` for a function's own scope: bind a named
    /// function expression's name to the running function (`CURRENT`) in a
    /// `const` slot, so the body can refer to itself. The slot was
    /// allocated in `scope_coding_params`; the reference is a no-op (the
    /// name resolves to its own slot).
    fn code_function_name(&mut self, scope: usize) {
        use crate::scoper::dflags;
        // A captured self-name (`fxDeclareNodeCodeAssign`'s `CONST` branch)
        // binds through the closure slot (`CONST_CLOSURE_1`); an uncaptured
        // one through the local slot (`CONST_LOCAL_1`).
        let names: Vec<(u32, bool)> = self.tree.scopes[scope]
            .declares
            .iter()
            .filter(|d| d.token == Token::Define)
            .map(|d| (d.id, d.flags & dflags::CLOSURE != 0))
            .collect();
        for (id, closure) in names {
            let index = self.declare_index(scope, id);
            self.add_byte(1, XS_CODE_CURRENT);
            let op = if closure { XS_CODE_CONST_CLOSURE_1 } else { XS_CODE_CONST_LOCAL_1 };
            self.add_index(0, op, index);
            self.add_byte(-1, XS_CODE_POP);
        }
    }
}

/// The public entry: compile `source` as a Script to XS bytecode, or
/// return the first parser/scoper early error. The returned bytes are
/// the `codeBuffer` half of XS's `txScript` — exactly what
/// `xs_oracle::run(source).bytecode` returns.
pub fn compile(source: &str) -> Result<Vec<u8>, crate::parser::ParseError> {
    compile_with(source, false)
}

/// [`compile`], additionally returning the XS **symbols atom**
/// (`(bytecode, symbols)`) ironhorse emits for the program — byte-identical to
/// `xs_oracle::run(source).symbols` whenever the bytecode is (the
/// stage-5 id contract). This is the entry the dual-run seam's `Ironhorse` arm
/// calls so it no longer has to borrow the oracle's SYMB payload.
pub fn compile_atoms(source: &str) -> Result<(Vec<u8>, Vec<u8>), crate::parser::ParseError> {
    compile_atoms_with(source, false)
}

/// `compile`, choosing the Script strictness (a bare `"use strict"`
/// program is strict).
pub fn compile_with(source: &str, strict: bool) -> Result<Vec<u8>, crate::parser::ParseError> {
    Ok(compile_atoms_with(source, strict)?.0)
}

/// [`compile_with`], additionally returning the symbols atom (the
/// atom-bearing counterpart of [`compile_atoms`]).
pub fn compile_atoms_with(
    source: &str,
    strict: bool,
) -> Result<(Vec<u8>, Vec<u8>), crate::parser::ParseError> {
    let mut parser = crate::parser::Parser::new(source, strict, false)?;
    let mut root = parser.parse_program(strict)?;
    // The oracle shim compiles the Script goal with `mxProgramFlag |
    // mxEvalFlag`, so the program node carries `mxEvalFlag`. The scoper
    // reads it to build an `Eval` (not `Program`) top scope — an eval
    // program's lexicals are plain locals, whereas `fxScopeBound` marks
    // every *program*-scope declaration `closure|useClosure`.
    if let Item::Node(n) = &mut root {
        n.flags |= crate::ast::flags::EVAL;
    }
    let tree = crate::scoper::run(&root)?;
    let mut coder = Coder::new(&tree);
    // Intern the program's symbols in lex order before coding so the atom
    // table's bucket lists match XS's.
    coder.intern_tree(&root);
    // The oracle shim compiles the *script* goal as an eval program
    // (`fxParseScript(..., mxProgramFlag | mxEvalFlag)`), so the program
    // header is coded through `fxScopeCodingEval`.
    coder.eval_flag = true;
    coder.code_program(node_of(&root));
    if let Some(e) = coder.error.take() {
        return Err(e);
    }
    Ok(coder.serialize_atoms())
}

fn node_of(item: &Item) -> &Node {
    match item {
        Item::Node(n) => n.as_ref(),
        _ => panic!("expected node"),
    }
}

/// Compile `source` as a **Module** goal to XS module bytecode, or return
/// the first parser/scoper early error. The returned bytes are the
/// `codeBuffer` half of XS's `txScript` for the Module goal — exactly what
/// `xs_oracle::compile_module(source).bytecode` returns (the module
/// counterpart of [`compile`]).
pub fn compile_module(source: &str) -> Result<Vec<u8>, crate::parser::ParseError> {
    Ok(compile_module_atoms(source)?.0)
}

/// [`compile_module`], additionally returning the module symbols atom
/// (`(bytecode, symbols)`) — the module-goal counterpart of
/// [`compile_atoms`], byte-identical to
/// `xs_oracle::compile_module(source).symbols` whenever the bytecode is.
pub fn compile_module_atoms(
    source: &str,
) -> Result<(Vec<u8>, Vec<u8>), crate::parser::ParseError> {
    // The module goal is strict and allows top-level await (the parser's
    // `module` flag), mirroring the oracle shim's fxParserTree module branch
    // (`mxStrictFlag | mxAsyncFlag`).
    let mut parser = crate::parser::Parser::new(source, true, true)?;
    let root = parser.parse_module()?;
    let tree = crate::scoper::run(&root)?;
    let mut coder = Coder::new(&tree);
    coder.intern_tree(&root);
    coder.code_module(node_of(&root));
    if let Some(e) = coder.error.take() {
        return Err(e);
    }
    Ok(coder.serialize_atoms())
}

// ============================ node dispatch ============================

impl Coder<'_> {
    /// `fxNodeDispatchCode` for one child slot. A real node dispatches by
    /// kind; the other `Item` shapes never appear where an expression/
    /// statement is expected in the ported surface.
    fn code(&mut self, item: &Item) {
        match item {
            Item::Node(n) => self.code_node(n),
            Item::Null => {}
            other => panic!("unexpected item in coder: {:?}", other),
        }
    }

    fn code_node(&mut self, node: &Node) {
        // The scoper has already refused any tree deeper than
        // [`crate::scoper::TREE_DEPTH_LIMIT`] before coding starts; this
        // backstop keeps the coder's own recursion bounded regardless of how
        // it is driven. `report` records the first error and the node is
        // skipped — the output is discarded once an error is recorded, as
        // for every other code-time `fxReportParserError`.
        if self.depth >= crate::scoper::TREE_DEPTH_LIMIT {
            self.report(node.line, "stack overflow");
            return;
        }
        self.depth += 1;
        self.code_node_inner(node);
        self.depth -= 1;
    }

    fn code_node_inner(&mut self, node: &Node) {
        use Token::*;
        // XS's `mxExpressionNoValue` is staged for exactly this (the
        // statement/for-iteration) expression; capture and clear it so it
        // never leaks into nested expressions.
        let no_value = std::mem::take(&mut self.no_value);
        // XS's `mxTailRecursionFlag`, staged for exactly this node; capture
        // and clear it so it reaches only the propagators/consumers below and
        // never leaks into a nested expression.
        let tail = std::mem::take(&mut self.tail);
        match node.token {
            Program => self.code_program(node),
            Module => self.code_module(node),
            Statements => self.code_statements(node),
            Statement => self.code_statement(node),
            Block => self.code_block(node),
            If => self.code_if(node),
            // value leaves (`fxValueNodeCode`: push the description code)
            True | False | Null | Undefined => {
                self.add_byte(1, value_code(node.token));
            }
            Integer => {
                let v = match node.value {
                    Value::Integer(v) => v,
                    _ => panic!("Integer node without integer value"),
                };
                self.add_integer(1, XS_CODE_INTEGER_1, v);
            }
            Number => {
                let v = match node.value {
                    Value::Number(v) => v,
                    _ => panic!("Number node without number value"),
                };
                self.add_number(1, XS_CODE_NUMBER, v);
            }
            String => {
                let units = match &node.value {
                    Value::Str(units) => units,
                    _ => panic!("String node without string value"),
                };
                let mut bytes = units_to_cesu8(units);
                bytes.push(0);
                self.add_string(1, XS_CODE_STRING_1, bytes);
            }
            Bigint => {
                let lit = match &node.value {
                    Value::BigInt(b) => b,
                    _ => panic!("BigInt node without bigint value"),
                };
                let bytes = bigint_limbs_le(&lit.digits, lit.radix as u32);
                self.add_bigint(1, XS_CODE_BIGINT_1, bytes);
            }
            // unary (`fxUnaryExpressionNodeCode`): operand then op, delta 0
            Void | Not | BitNot | Minus | Plus | Typeof => {
                self.code(&node.children[0]);
                self.add_byte(0, unary_code(node.token));
            }
            // binary (`fxBinaryExpressionNodeCode`): left, right, op, delta -1
            Add | Subtract | Multiply | Divide | Modulo | Exponentiation | BitAnd | BitOr
            | BitXor | LeftShift | SignedRightShift | UnsignedRightShift | Equal | NotEqual
            | StrictEqual | StrictNotEqual | Less | LessEqual | More | MoreEqual | Instanceof
            | In => {
                self.code(&node.children[0]);
                self.code(&node.children[1]);
                self.add_byte(-1, binary_code(node.token));
            }
            And => self.code_and(node, tail),
            Or => self.code_or(node, tail),
            Coalesce => self.code_coalesce(node, tail),
            QuestionMark => self.code_question_mark(node, tail),
            Expressions => self.code_expressions(node, tail),
            // control flow (symbol-free surface)
            Label => self.code_label(node),
            While => self.code_while(node),
            Do => self.code_do(node),
            For => self.code_for(node),
            ForIn | ForOf | ForAwaitOf => self.code_for_in_of(node),
            Break | Continue => self.code_break_continue(node),
            Throw => self.code_throw(node),
            Debugger => self.add_byte(0, XS_CODE_DEBUGGER),
            With => self.code_with(node),
            Switch => self.code_switch(node),
            Try => self.code_try(node),
            Catch => self.code_catch(node),
            // `this` (`fxThisNodeCode`): a derived-constructor `this` reads
            // the frame slot; otherwise the plain `THIS` opcode. Both are
            // symbol-free.
            This => {
                if node.flags & crate::ast::flags::DERIVED != 0 {
                    self.add_byte(1, XS_CODE_GET_THIS);
                } else {
                    self.add_byte(1, XS_CODE_THIS);
                }
            }
            // `new.target` (`fxValueNodeCode` for a `Target` node): the
            // running frame's target constructor (`undefined` when the frame
            // was not entered as a construct). A single stack-pushing byte.
            Target => self.add_byte(1, XS_CODE_TARGET),
            Regexp => self.code_regexp(node),
            Template => self.code_template(node, tail),
            Access => self.code_access(node),
            Chain => self.code_chain(node),
            Option => self.code_option(node, tail),
            Member => self.code_member(node),
            PrivateMember => self.code_private_member(node),
            PrivateIdentifier => self.code_private_identifier(node),
            MemberAt => self.code_member_at(node),
            Call => self.code_call(node, tail),
            New => self.code_new(node),
            Params => self.code_params(node, false, false),
            Assign => self.code_assign_node(node),
            AddAssign | SubtractAssign | MultiplyAssign | DivideAssign | ModuloAssign
            | ExponentiationAssign | BitAndAssign | BitOrAssign | BitXorAssign
            | LeftShiftAssign | SignedRightShiftAssign | UnsignedRightShiftAssign
            | AndAssign | OrAssign | CoalesceAssign => self.code_compound(node, no_value),
            Increment | Decrement => self.code_postfix(node, no_value),
            Delete => self.code_delete(&node.children[0]),
            Object => self.code_object(node),
            Array => self.code_array(node),
            Binding => self.code_binding(node),
            Var | Let | Const | Using => self.code_declare(node),
            Function | Generator => self.code_function(node),
            Define => self.code_define(node),
            Body => self.code_body(node),
            Return => self.code_return(node),
            ParamsBinding => self.code_params_binding(node),
            Yield => self.code_yield(node),
            Await => self.code_await(node),
            Delegate => self.code_delegate(node),
            Class => self.code_class(node),
            Super => self.code_super(node),
            ImportCall => self.code_import_call(node),
            ImportMeta => self.code_import_meta(node),
            // `fxImportNodeCode` / `fxExportNodeCode` are both empty in XS:
            // the module's import/export *linkage* is emitted from the
            // module scope's declares (`fxScopeCodeSpecifierNodes`), so the
            // declaration statements themselves code to nothing.
            Import | Export => {}
            other => panic!("coder: unsupported node kind {:?}", other),
        }
    }

    /// `fxProgramNodeCode`.
    fn code_program(&mut self, node: &Node) {
        self.program_flag = true;
        if node.flags & crate::ast::flags::STRICT != 0 {
            self.add_index(0, XS_CODE_BEGIN_STRICT, 0);
        } else {
            self.add_index(0, XS_CODE_BEGIN_SLOPPY, 0);
        }
        // The oracle compiles with `mxEvalFlag`, so the header is the
        // eval shape (`fxScopeCodingEval`).
        self.code_scope_eval(node);
        // `coder->returnTarget` — the program's implicit return point.
        // It must live on the coder so a `try`/`return` inside the body
        // can alias it (the alias count feeds the `try` selector, so a
        // missing return target skews every `try` selection by one).
        let return_target = self.create_target();
        self.return_target = Some(return_target);
        // `fxScopeCodeDefineNodes` — hoist function declarations to the top
        // of the program before the ordinary statements.
        self.code_define_nodes(&node.children[0]);
        self.code(&node.children[0]);
        let rt = self.return_target.take().expect("program return target");
        self.place_target(0, rt);
        self.add_byte(0, XS_CODE_RETURN);
    }

    /// `fxScopeCodingEval` for the program scope — the eval program
    /// header. Strict and sloppy differ sharply:
    ///
    /// * **strict**: reserve `scopeCount` slots up front, then
    ///   `fxScopeCodingBlock` gives every declaration its slot (`Private`
    ///   eval-closures are the function/class slice).
    /// * **sloppy**: `var`/`Define` hoist first (each a `NEW_LOCAL` +
    ///   `undefined`/`null` `VAR_LOCAL`), then `EVAL_ENVIRONMENT` resets
    ///   the frame; the lexical (`let`/`const`) declarations then get
    ///   their slots (and, in a direct `eval`, a `with` publish).
    fn code_scope_eval(&mut self, node: &Node) {
        let scope = self.scope_of(node);
        let strict = self.tree.scopes[scope].flags & crate::ast::flags::STRICT != 0;
        let is_eval = self.tree.scopes[scope].flags & crate::scoper::SCOPE_EVAL != 0;
        let scope_count = *self.tree.scope_counts.get(&scope).unwrap_or(&0);
        let declares = self.declares_of(scope);
        if strict {
            if scope_count != 0 {
                self.add_index(0, XS_CODE_RESERVE_1, scope_count);
                self.scope_coding_block(scope);
                for (_, token, _, _) in &declares {
                    assert_ne!(*token, Token::Private, "eval private closure (class slice)");
                }
            }
        } else {
            // The `var`/`Define` hoist prelude, counted for the reserve.
            let count = declares
                .iter()
                .filter(|(_, t, _, _)| matches!(t, Token::Var | Token::Define))
                .count() as i32;
            if count != 0 {
                self.add_index(0, XS_CODE_RESERVE_1, count);
                for (id, token, sym, _) in &declares {
                    match token {
                        Token::Define => {
                            let index = self.set_declare_index(scope, *id);
                            self.add_variable(0, XS_CODE_NEW_LOCAL, Self::sym_name(sym), index);
                            self.add_byte(1, XS_CODE_NULL);
                            self.add_index(0, XS_CODE_VAR_LOCAL_1, index);
                            self.add_byte(-1, XS_CODE_POP);
                        }
                        Token::Var => {
                            let index = self.set_declare_index(scope, *id);
                            self.add_variable(0, XS_CODE_NEW_LOCAL, Self::sym_name(sym), index);
                            self.add_byte(1, XS_CODE_UNDEFINED);
                            self.add_index(0, XS_CODE_VAR_LOCAL_1, index);
                            self.add_byte(-1, XS_CODE_POP);
                        }
                        _ => {}
                    }
                }
            }
            self.add_byte(0, XS_CODE_EVAL_ENVIRONMENT);
            self.scope_level = 0;
            if scope_count != 0 {
                self.add_index(0, XS_CODE_RESERVE_1, scope_count);
                if self.declare_count(scope) != 0 {
                    for (id, token, sym, flags) in &declares {
                        if matches!(token, Token::Define | Token::Var) {
                            continue;
                        }
                        self.assert_declared_kind(*token);
                        let index = self.set_declare_index(scope, *id);
                        if flags & crate::scoper::dflags::CLOSURE != 0 {
                            self.add_variable(0, XS_CODE_NEW_CLOSURE, Self::sym_name(sym), index);
                        } else {
                            self.add_variable(0, XS_CODE_NEW_LOCAL, Self::sym_name(sym), index);
                        }
                    }
                    if is_eval {
                        self.add_byte(1, XS_CODE_UNDEFINED);
                        self.add_byte(0, XS_CODE_WITH);
                        for (id, token, _, _) in &declares {
                            if matches!(token, Token::Define | Token::Var) {
                                continue;
                            }
                            let index = self.declare_index(scope, *id);
                            self.add_index(0, XS_CODE_STORE_1, index);
                        }
                        self.add_byte(-1, XS_CODE_POP);
                        self.environment_level += 1;
                    }
                }
            }
        }
    }

    /// `fxModuleNodeCode` — the Module goal's top-level coder. Emits the
    /// module-body function (a second `var`/function-hoist wrapper first
    /// when the module declares any `var`/function), then the per-binding
    /// `TRANSFER` linkage from `fxScopeCodeSpecifierNodes`, and closes with
    /// the `MODULE` opcode that assembles the module record. No debug
    /// metering (`LINE`/`PROFILE`) — the oracle module entry compiles with
    /// no `mxDebugFlag`, exactly like the script entry.
    fn code_module(&mut self, node: &Node) {
        use crate::ast::flags as f;
        let scope = self.scope_of(node);
        let awaiting = node.flags & f::AWAITING != 0;
        let strict = node.flags & f::STRICT != 0;
        let scope_count = *self.tree.scope_counts.get(&scope).unwrap_or(&0);

        let mut target = self.create_target();
        self.program_flag = false;
        self.scope_level = 0;
        self.first_break_target = None;
        self.first_continue_target = None;

        // `var`/function-declaration hoist prelude: emitted as a first
        // wrapper function when the module scope declares any `Var`/`Define`.
        let var_define_count = self.tree.scopes[scope]
            .declares
            .iter()
            .filter(|d| matches!(d.token, Token::Var | Token::Define))
            .count();
        if var_define_count != 0 {
            self.add_symbol_null(1, XS_CODE_FUNCTION);
            self.add_branch(0, XS_CODE_CODE_1, target);
            self.add_index(0, XS_CODE_BEGIN_STRICT, 0);
            if scope_count != 0 {
                self.add_index(0, XS_CODE_RESERVE_1, scope_count);
            }
            self.scope_code_retrieve(scope);
            // Each module-scope `var` gets an `undefined` closure slot.
            let vars: Vec<u32> = self.tree.scopes[scope]
                .declares
                .iter()
                .filter(|d| d.token == Token::Var)
                .map(|d| d.id)
                .collect();
            for id in vars {
                let index = self.declare_index(scope, id);
                self.add_byte(1, XS_CODE_UNDEFINED);
                self.add_index(0, XS_CODE_VAR_CLOSURE_1, index);
                self.add_byte(-1, XS_CODE_POP);
            }
            self.code_define_nodes(&node.children[0]);
            self.add_byte(0, XS_CODE_END);
            self.place_target(0, target);
            self.add_byte(1, XS_CODE_ENVIRONMENT);
            self.add_byte(-1, XS_CODE_POP);

            target = self.create_target();
            self.program_flag = false;
            self.scope_level = 0;
            self.first_break_target = None;
            self.first_continue_target = None;
        } else {
            self.add_byte(1, XS_CODE_NULL);
        }

        // The module-body function (async when the module top-level awaits).
        let create_op = if awaiting { XS_CODE_ASYNC_FUNCTION } else { XS_CODE_FUNCTION };
        self.add_symbol_null(1, create_op);
        self.add_branch(0, XS_CODE_CODE_1, target);
        self.add_index(0, XS_CODE_BEGIN_STRICT, 0);
        if scope_count != 0 {
            self.add_index(0, XS_CODE_RESERVE_1, scope_count);
        }
        self.scope_code_retrieve(scope);
        if awaiting {
            self.add_byte(0, XS_CODE_START_ASYNC);
        }
        self.return_target = Some(self.create_target());
        if self.tree.scopes[scope].disposable_count > 0 {
            let context = self.scope_code_using(scope);
            self.code(&node.children[0]);
            self.scope_code_used(scope, context);
        } else {
            self.code(&node.children[0]);
        }
        let rt = self.return_target.take().expect("module return target");
        self.place_target(0, rt);
        self.add_byte(0, XS_CODE_END);
        self.place_target(0, target);
        self.add_byte(1, XS_CODE_ENVIRONMENT);
        self.add_byte(-1, XS_CODE_POP);

        // The import/export linkage, one `TRANSFER` per module binding.
        let count = 2 + self.scope_code_specifier_nodes(scope);
        self.add_integer(1, XS_CODE_INTEGER_1, count);
        let mut flag = 0;
        if !strict {
            flag |= XS_JSON_MODULE_FLAG;
        }
        if self.import_flag {
            flag |= XS_IMPORT_FLAG;
        }
        if self.import_meta_flag {
            flag |= XS_IMPORT_META_FLAG;
        }
        self.add_index(-count, XS_CODE_MODULE, flag);
        self.add_byte(-1, XS_CODE_SET_RESULT);
        self.add_byte(0, XS_CODE_END);
    }

    /// `fxScopeCodeSpecifierNodes` — for each module-scope declaration that
    /// is a closure (`useClosure`) binding, push the `TRANSFER` operands the
    /// `MODULE` opcode consumes: the local name, the import specifier
    /// (`from` module + imported name, or two `NULL`s for a plain local),
    /// then each exported name. Returns the transfer count.
    fn scope_code_specifier_nodes(&mut self, scope: usize) -> i32 {
        use crate::scoper::dflags;
        let declares = self.tree.scopes[scope].declares.clone();
        let mut count = 0;
        for d in &declares {
            if d.flags & dflags::USE_CLOSURE == 0 {
                continue;
            }
            let mut index = 3;
            // The local name (`node->symbol`), or NULL for a re-export slot.
            match &d.symbol {
                Some(crate::scoper::Sym::Named(s)) => self.add_symbol(1, XS_CODE_SYMBOL, s),
                _ => self.add_byte(1, XS_CODE_NULL),
            }
            // The import specifier: `from` module string + imported name.
            match &d.import_spec {
                Some(imp) => {
                    let mut bytes = units_to_cesu8(&imp.from);
                    bytes.push(0);
                    self.add_string(1, XS_CODE_STRING_1, bytes);
                    match &imp.symbol {
                        Some(s) => self.add_symbol(1, XS_CODE_SYMBOL, s),
                        None => self.add_byte(1, XS_CODE_NULL),
                    }
                }
                None => {
                    self.add_byte(1, XS_CODE_NULL);
                    self.add_byte(1, XS_CODE_NULL);
                }
            }
            // Each exported name this binding answers to.
            for e in &d.export_specs {
                match &e.name {
                    Some(s) => self.add_symbol(1, XS_CODE_SYMBOL, s),
                    None => self.add_byte(1, XS_CODE_NULL),
                }
                index += 1;
            }
            self.add_integer(1, XS_CODE_INTEGER_1, index);
            let with = d.import_spec.as_ref().map(|i| i.with).unwrap_or(false);
            if with {
                self.add_byte(-index, XS_CODE_TRANSFER_JSON);
            } else {
                self.add_byte(-index, XS_CODE_TRANSFER);
            }
            count += 1;
        }
        count
    }

    /// `fxStatementsNodeCode`.
    fn code_statements(&mut self, node: &Node) {
        if let Some(Item::List(items)) = node.children.first() {
            for item in items {
                self.code(item);
            }
        }
    }

    /// `fxStatementNodeCode`. A program-level statement sets the program
    /// result; a function-body statement discards its value with a `POP`,
    /// except that a trailing `SET_LOCAL`/`SET_CLOSURE` is rewritten in
    /// place to the fused `PULL_LOCAL`/`PULL_CLOSURE` (store-and-pop).
    fn code_statement(&mut self, node: &Node) {
        if self.program_flag {
            self.code(&node.children[0]);
            self.add_byte(-1, XS_CODE_SET_RESULT);
        } else {
            // `self->expression->flags |= mxExpressionNoValue`.
            self.no_value = true;
            self.code(&node.children[0]);
            match self.codes.last().map(|c| c.id) {
                Some(XS_CODE_SET_CLOSURE_1) => self.fuse_pull(XS_CODE_PULL_CLOSURE_1),
                Some(XS_CODE_SET_LOCAL_1) => self.fuse_pull(XS_CODE_PULL_LOCAL_1),
                _ => self.add_byte(-1, XS_CODE_POP),
            }
        }
    }

    /// The `fxStatementNodeCode` store-and-pop fusion: retag the last
    /// record (`SET_LOCAL`→`PULL_LOCAL`, `SET_CLOSURE`→`PULL_CLOSURE`) and
    /// account for the popped value.
    fn fuse_pull(&mut self, pull_id: i32) {
        self.stack_level -= 1;
        let sl = self.stack_level;
        let last = self.codes.last_mut().expect("fuse_pull needs a last record");
        last.id = pull_id;
        last.stack_level = sl;
    }

    /// `fxBlockNodeCode` — a lexical block: code its scope's
    /// declarations, dispatch the body, then unwind the block's slots.
    /// `fxScopeCodeDefineNodes` (function/host defines) is deferred, and
    /// `fxScopeCodeUsingStatement` with no disposables is just the
    /// statement dispatch.
    fn code_block(&mut self, node: &Node) {
        let scope = self.scope_of(node);
        self.scope_coding_block(scope);
        self.code_define_nodes(&node.children[0]);
        if self.tree.scopes[scope].disposable_count > 0 {
            let context = self.scope_code_using(scope);
            self.code(&node.children[0]);
            self.scope_code_used(scope, context);
        } else {
            self.code(&node.children[0]);
        }
        self.scope_coded(scope);
    }

    /// `fxWithNodeCode` — `with (expression) statement`. Push the object
    /// as a `with` environment, run the body with the eval flag forced on
    /// (so its free accesses take the symbol path), then pop the
    /// environment. `with` is a syntax error in strict mode, so only the
    /// sloppy path is reached. Children `[expression, statement]`.
    fn code_with(&mut self, node: &Node) {
        self.code(&node.children[0]);
        self.add_byte(0, XS_CODE_TO_INSTANCE);
        self.add_byte(0, XS_CODE_WITH);
        self.add_byte(-1, XS_CODE_POP);
        let eval_flag = self.eval_flag;
        self.environment_level += 1;
        self.eval_flag = true;
        if self.program_flag {
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(-1, XS_CODE_SET_RESULT);
        }
        self.code(&node.children[1]);
        self.eval_flag = eval_flag;
        self.environment_level -= 1;
        self.add_byte(0, XS_CODE_WITHOUT);
    }

    /// `fxIfNodeCode` (program-flag branch: each arm sets the result to
    /// `undefined` first, per XS).
    fn code_if(&mut self, node: &Node) {
        self.code(&node.children[0]);
        if self.program_flag {
            let else_target = self.create_target();
            let end_target = self.create_target();
            self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, else_target);
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(-1, XS_CODE_SET_RESULT);
            self.code(&node.children[1]);
            self.add_branch(0, XS_CODE_BRANCH_1, end_target);
            self.place_target(0, else_target);
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(-1, XS_CODE_SET_RESULT);
            if !matches!(node.children[2], Item::Null) {
                self.code(&node.children[2]);
            }
            self.place_target(0, end_target);
        } else {
            let has_else = !matches!(node.children[2], Item::Null);
            if has_else {
                let else_target = self.create_target();
                let end_target = self.create_target();
                self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, else_target);
                self.code(&node.children[1]);
                self.add_branch(0, XS_CODE_BRANCH_1, end_target);
                self.place_target(0, else_target);
                self.code(&node.children[2]);
                self.place_target(0, end_target);
            } else {
                let end_target = self.create_target();
                self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, end_target);
                self.code(&node.children[1]);
                self.place_target(0, end_target);
            }
        }
    }

    /// `fxAndExpressionNodeCode`.
    fn code_and(&mut self, node: &Node, tail: bool) {
        let end_target = self.create_target();
        self.code(&node.children[0]);
        self.add_byte(1, XS_CODE_DUB);
        self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, end_target);
        self.add_byte(-1, XS_CODE_POP);
        // `a && b()`: the right operand is the tail-position value.
        self.tail = tail;
        self.code(&node.children[1]);
        self.place_target(0, end_target);
    }

    /// `fxOrExpressionNodeCode`.
    fn code_or(&mut self, node: &Node, tail: bool) {
        let end_target = self.create_target();
        self.code(&node.children[0]);
        self.add_byte(1, XS_CODE_DUB);
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, end_target);
        self.add_byte(-1, XS_CODE_POP);
        self.tail = tail;
        self.code(&node.children[1]);
        self.place_target(0, end_target);
    }

    /// `fxCoalesceExpressionNodeCode`.
    fn code_coalesce(&mut self, node: &Node, tail: bool) {
        let end_target = self.create_target();
        self.code(&node.children[0]);
        self.add_branch(-1, XS_CODE_BRANCH_COALESCE_1, end_target);
        self.tail = tail;
        self.code(&node.children[1]);
        self.place_target(0, end_target);
    }

    /// `fxQuestionMarkNodeCode`.
    fn code_question_mark(&mut self, node: &Node, tail: bool) {
        let else_target = self.create_target();
        let end_target = self.create_target();
        self.code(&node.children[0]);
        self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, else_target);
        // Both arms are tail-position values (`return c ? f() : g()`).
        self.tail = tail;
        self.code(&node.children[1]);
        self.add_branch(0, XS_CODE_BRANCH_1, end_target);
        self.place_target(-1, else_target);
        self.tail = tail;
        self.code(&node.children[2]);
        self.place_target(0, end_target);
    }

    /// `fxExpressionsNodeCode` (sequence): each item but the first is
    /// preceded by a `POP` of the previous value.
    fn code_expressions(&mut self, node: &Node, tail: bool) {
        if let Some(Item::List(items)) = node.children.first() {
            let last = items.len().saturating_sub(1);
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    self.add_byte(-1, XS_CODE_POP);
                }
                // Only the final expression of a comma sequence is the
                // tail-position value.
                if i == last {
                    self.tail = tail;
                }
                self.code(item);
            }
        }
    }

    // ------------------------- control flow --------------------------

    /// `fxLabelNodeCode`. A `Label` wraps its statement (loops carry an
    /// anonymous label). Nested labels are collapsed into one break /
    /// continue target answering to the whole symbol chain, exactly as XS
    /// folds `former->nextLabel = self`.
    fn code_label(&mut self, node: &Node) {
        // Descend the label chain to the wrapped statement, collecting the
        // label symbols. XS's collapsed `nextLabel` order is innermost
        // first, so we reverse the outermost-first descent.
        let mut labels: Vec<Option<String>> = Vec::new();
        let mut cur = node;
        loop {
            labels.push(match &cur.children[0] {
                Item::Symbol(s) => Some(s.clone()),
                _ => None,
            });
            match &cur.children[1] {
                Item::Node(n) if n.token == Token::Label => cur = n.as_ref(),
                _ => break,
            }
        }
        labels.reverse();

        // `fxLabelNodeCode`'s two duplicate-label checks (`ContainsDuplicateLabels`).
        // (1) The collapse loop folds a directly-nested label chain (`L1: L2:
        // stmt`) into one target and rejects a repeat within it. (2) It then
        // walks the enclosing break-target stack and rejects a label that
        // re-declares one already in scope across an intervening statement
        // (`L: { L: 0; }`). XS compares each enclosing target's HEAD label
        // (the innermost after collapse — our `labels[0]`) against every
        // label of this statement.
        for (i, outer) in labels.iter().enumerate() {
            if let Some(o) = outer {
                if labels[i + 1..].iter().any(|inner| inner.as_deref() == Some(o.as_str())) {
                    self.report(node.line, &format!("duplicate label {}", o));
                }
            }
        }
        let mut bt = self.first_break_target;
        while let Some(t) = bt {
            if let Some(head) = self.targets[t].labels.first().and_then(|o| o.as_deref()) {
                if labels.iter().any(|l| l.as_deref() == Some(head)) {
                    self.report(node.line, &format!("duplicate label {}", head));
                }
            }
            bt = self.targets[t].next_target;
        }

        // Dispatch the wrapped statement by reference — the scoper keys
        // scopes by node address, so a clone would miss its registration.
        let statement = &cur.children[1];
        // `self->symbol` after the collapse is the innermost label's.
        let inner_has_symbol = labels[0].is_some();

        let break_target = self.create_target();
        self.targets[break_target].labels = labels.clone();
        self.targets[break_target].next_target = self.first_break_target;
        self.first_break_target = Some(break_target);

        if inner_has_symbol {
            self.code(statement);
        } else {
            let continue_target = self.create_target();
            self.targets[continue_target].labels = labels;
            self.targets[continue_target].next_target = self.first_continue_target;
            self.first_continue_target = Some(continue_target);
            self.code(statement);
            self.first_continue_target = self.targets[continue_target].next_target;
        }
        self.place_target(0, break_target);
        self.first_break_target = self.targets[break_target].next_target;
    }

    /// `fxWhileNodeCode`. Children `[expression, statement]`; break /
    /// continue targets come from the enclosing `Label`.
    fn code_while(&mut self, node: &Node) {
        let cont = self.first_continue_target.expect("while continue target");
        let brk = self.first_break_target.expect("while break target");
        if self.program_flag {
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(-1, XS_CODE_SET_RESULT);
        }
        self.place_target(0, cont);
        self.code(&node.children[0]);
        self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, brk);
        self.code(&node.children[1]);
        self.add_branch(0, XS_CODE_BRANCH_1, cont);
    }

    /// `fxDoNodeCode`. Children `[statement, expression]`.
    fn code_do(&mut self, node: &Node) {
        let cont = self.first_continue_target.expect("do continue target");
        let loop_target = self.create_target();
        if self.program_flag {
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(-1, XS_CODE_SET_RESULT);
        }
        self.place_target(0, loop_target);
        self.code(&node.children[0]);
        self.place_target(0, cont);
        self.code(&node.children[1]);
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, loop_target);
    }

    /// `fxForNodeCode` — the C-style loop. Children `[initialization,
    /// expression, iteration, statement]` (any of the first three may be
    /// `Null`).
    fn code_for(&mut self, node: &Node) {
        let scope = self.scope_of(node);
        // Detach the loop's own continue target from the stack for the
        // header, re-inserting it around the body (XS's swap).
        let continue_target = self.first_continue_target.expect("for continue target");
        self.first_continue_target = self.targets[continue_target].next_target;
        self.targets[continue_target].next_target = None;

        self.scope_coding_block(scope);
        self.scope_code_define_nodes(scope);
        let using_context = (self.tree.scopes[scope].disposable_count > 0)
            .then(|| self.scope_code_using(scope));
        let next_target = self.create_target();
        let done_target = self.create_target();
        if !matches!(node.children[0], Item::Null) {
            self.code(&node.children[0]);
        }
        if self.program_flag {
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(-1, XS_CODE_SET_RESULT);
        }
        self.scope_code_refresh(scope);
        self.place_target(0, next_target);
        if !matches!(node.children[1], Item::Null) {
            self.code(&node.children[1]);
            self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, done_target);
        }

        self.targets[continue_target].environment_level = self.environment_level;
        self.targets[continue_target].scope_level = self.scope_level;
        self.targets[continue_target].stack_level = self.stack_level;
        self.targets[continue_target].next_target = self.first_continue_target;
        self.first_continue_target = Some(continue_target);
        self.code(&node.children[3]);
        self.place_target(0, continue_target);
        self.first_continue_target = self.targets[continue_target].next_target;
        self.targets[continue_target].next_target = None;

        if !matches!(node.children[2], Item::Null) {
            self.scope_code_refresh(scope);
            // `self->iteration->flags |= mxExpressionNoValue`.
            self.no_value = true;
            self.code(&node.children[2]);
            self.add_byte(-1, XS_CODE_POP);
        }
        self.add_branch(0, XS_CODE_BRANCH_1, next_target);
        self.place_target(0, done_target);
        if let Some(context) = using_context {
            self.scope_code_used(scope, context);
        }
        self.scope_coded(scope);

        self.targets[continue_target].next_target = self.first_continue_target;
        self.first_continue_target = Some(continue_target);
    }

    /// `fxForInForOfNodeCode` — the `for (ref in|of expr) body` iteration
    /// protocol. Children `[reference, expression, statement]`. Drives the
    /// iterator (`FOR_IN`/`FOR_OF`/`FOR_AWAIT_OF` seeds it, then a `next()`
    /// loop) inside a `try`/`finally` that closes the iterator (`.return()`)
    /// on break/continue/return/throw, using the same selector/alias/
    /// finalize/jump machinery as `try`. Declaring heads (`for (let x …)`)
    /// and `using` are deferred (the scope is asserted non-declaring).
    fn code_for_in_of(&mut self, node: &Node) {
        let is_async = node.token == Token::ForAwaitOf;
        let iter_op = match node.token {
            Token::ForOf => XS_CODE_FOR_OF,
            Token::ForIn => XS_CODE_FOR_IN,
            Token::ForAwaitOf => XS_CODE_FOR_AWAIT_OF,
            _ => unreachable!(),
        };
        let iterator = self.use_temporary();
        let next = self.use_temporary();
        let done = self.use_temporary();
        let result = self.use_temporary();
        let exception = self.use_temporary();
        let selector = self.use_temporary();

        // Take the continue target the enclosing (anonymous) label pushed.
        let continue_target = self.first_continue_target.expect("for-in/of needs a continue target");
        self.first_continue_target = self.targets[continue_target].next_target;
        self.targets[continue_target].next_target = None;

        let scope = self.scope_of(node);
        self.scope_coding_block(scope);
        self.scope_code_define_nodes(scope);

        if self.program_flag {
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(-1, XS_CODE_SET_RESULT);
        }
        self.code(&node.children[1]); // expression
        self.add_byte(0, iter_op);
        self.add_index(0, XS_CODE_SET_LOCAL_1, iterator);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "next");
        self.add_index(0, XS_CODE_PULL_LOCAL_1, next);

        self.first_break_target = self.alias_targets(self.first_break_target);
        self.first_continue_target = self.alias_targets(self.first_continue_target);
        self.return_target = self.alias_targets(self.return_target);
        let mut catch_target = self.create_target();
        let mut normal_target = self.create_target();
        self.add_branch(0, XS_CODE_CATCH_1, catch_target);

        // --- loop ---
        let next_target = self.create_target();
        self.place_target(0, next_target);
        self.add_byte(1, XS_CODE_TRUE);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, done);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_index(1, XS_CODE_GET_LOCAL_1, next);
        self.add_byte(1, XS_CODE_CALL);
        self.add_integer(-2, XS_CODE_RUN_1, 0);
        if is_async {
            self.add_byte(0, XS_CODE_AWAIT);
            self.add_byte(0, XS_CODE_THROW_STATUS);
        }
        self.add_byte(0, XS_CODE_CHECK_INSTANCE);
        self.add_index(0, XS_CODE_SET_LOCAL_1, result);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "done");
        self.add_index(0, XS_CODE_SET_LOCAL_1, done);
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, normal_target);

        self.scope_code_reset(scope);
        self.code_reference(&node.children[0], 0);
        self.add_byte(1, XS_CODE_TRUE);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, done);
        self.add_index(1, XS_CODE_GET_LOCAL_1, result);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "value");
        self.add_byte(1, XS_CODE_FALSE);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, done);
        self.code_assign(&node.children[0], 0);
        self.add_byte(-1, XS_CODE_POP);

        self.targets[continue_target].environment_level = self.environment_level;
        self.targets[continue_target].scope_level = self.scope_level;
        self.targets[continue_target].stack_level = self.stack_level;
        self.targets[continue_target].next_target = self.first_continue_target;
        self.first_continue_target = Some(continue_target);
        self.code(&node.children[2]); // statement
        self.place_target(0, continue_target);
        self.first_continue_target = self.targets[continue_target].next_target;
        self.targets[continue_target].next_target = None;

        self.scope_code_used_reverse(scope, exception, selector);

        self.add_branch(0, XS_CODE_BRANCH_1, next_target);

        // --- pre finally ---
        let uncatch_target = self.create_target();
        let finally_target = self.create_target();
        self.place_target(0, catch_target);
        self.add_byte(1, XS_CODE_EXCEPTION);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, exception);
        self.add_integer(1, XS_CODE_INTEGER_1, 0);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, selector);
        self.add_branch(0, XS_CODE_BRANCH_1, finally_target);
        let mut selection = 1;
        self.first_break_target =
            self.finalize_targets(self.first_break_target, selector, &mut selection, uncatch_target);
        self.first_continue_target = self.finalize_targets(
            self.first_continue_target,
            selector,
            &mut selection,
            uncatch_target,
        );
        self.return_target =
            self.finalize_targets(self.return_target, selector, &mut selection, uncatch_target);
        self.place_target(0, normal_target);
        self.add_integer(1, XS_CODE_INTEGER_1, selection);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, selector);
        self.place_target(0, uncatch_target);
        self.add_byte(0, XS_CODE_UNCATCH);
        self.place_target(0, finally_target);

        // --- finally: close the iterator ---
        catch_target = self.create_target();
        normal_target = self.create_target();
        self.add_branch(0, XS_CODE_CATCH_1, catch_target);
        let done_target = self.create_target();
        let return_target = self.create_target();
        self.add_index(1, XS_CODE_GET_LOCAL_1, done);
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, done_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "return");
        self.add_branch(0, XS_CODE_BRANCH_CHAIN_1, return_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_byte(0, XS_CODE_SWAP);
        self.add_byte(1, XS_CODE_CALL);
        self.add_integer(-2, XS_CODE_RUN_1, 0);
        if is_async {
            self.add_byte(0, XS_CODE_AWAIT);
            self.add_byte(0, XS_CODE_THROW_STATUS);
        }
        self.add_byte(0, XS_CODE_CHECK_INSTANCE);
        self.place_target(0, return_target);
        self.add_byte(-1, XS_CODE_POP);
        self.place_target(0, done_target);
        self.add_byte(0, XS_CODE_UNCATCH);
        self.add_branch(0, XS_CODE_BRANCH_1, normal_target);
        self.place_target(0, catch_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, selector);
        self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, normal_target);
        self.add_byte(1, XS_CODE_EXCEPTION);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, exception);
        self.add_integer(1, XS_CODE_INTEGER_1, 0);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, selector);
        self.place_target(0, normal_target);

        self.scope_code_used_reverse(scope, exception, selector);

        // --- post finally ---
        let else_target = self.create_target();
        self.add_index(1, XS_CODE_GET_LOCAL_1, selector);
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, else_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, exception);
        self.add_byte(-1, XS_CODE_THROW);
        self.place_target(0, else_target);
        let mut selection = 1;
        let bt = self.first_break_target;
        self.jump_targets(bt, selector, &mut selection);
        let ct = self.first_continue_target;
        self.jump_targets(ct, selector, &mut selection);
        let rt = self.return_target;
        self.jump_targets(rt, selector, &mut selection);

        self.scope_coded(scope);
        self.targets[continue_target].next_target = self.first_continue_target;
        self.first_continue_target = Some(continue_target);

        self.unuse_temporaries(6);
    }

    /// `fxScopeCodeReset` — reset each per-iteration binding to its
    /// initial (uninitialized `let`/`const`) state at the top of each
    /// `for`-loop iteration, so a fresh binding is captured per iteration.
    fn scope_code_reset(&mut self, scope: usize) {
        for (id, _, sym, flags) in self.declares_of(scope) {
            let index = self.declare_index(scope, id);
            if flags & crate::scoper::dflags::CLOSURE != 0 {
                self.add_index(0, XS_CODE_RESET_CLOSURE_1, index);
            } else if sym.is_some() {
                self.add_index(0, XS_CODE_RESET_LOCAL_1, index);
            } else {
                self.add_byte(1, XS_CODE_UNDEFINED);
                self.add_index(-1, XS_CODE_PULL_LOCAL_1, index);
            }
        }
    }

    /// `fxScopeCodeUsedReverse` — run `using` disposers in reverse at scope
    /// exit. Only `using` declarations emit disposers; plain `let`/`const`
    /// heads are a no-op. `using` in a `for`-head is deferred.
    fn scope_code_used_reverse(&mut self, scope: usize, _exception: i32, selector: i32) {
        let declares = self.declares_of(scope);
        for (position, (id, token, _, flags)) in declares.iter().enumerate().rev() {
            if *token != Token::Using {
                continue;
            }
            let disposal_id = declares
                .get(position + 1)
                .map(|d| d.0)
                .expect("using declaration has a disposal slot");
            let resource_index = self.declare_index(scope, *id);
            let disposal_index = self.declare_index(scope, disposal_id);
            let catch_target = self.create_target();
            let chain_target = self.create_target();
            let normal_target = self.create_target();

            self.add_index(1, XS_CODE_GET_LOCAL_1, disposal_index);
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(-1, XS_CODE_STRICT_EQUAL);
            self.add_branch(-1, XS_CODE_BRANCH_IF_1, normal_target);
            self.add_branch(0, XS_CODE_CATCH_1, catch_target);
            let get = if flags & crate::scoper::dflags::CLOSURE != 0 {
                XS_CODE_GET_CLOSURE_1
            } else {
                XS_CODE_GET_LOCAL_1
            };
            self.add_index(1, get, resource_index);
            self.add_branch(0, XS_CODE_BRANCH_CHAIN_1, chain_target);
            self.add_index(1, XS_CODE_GET_LOCAL_1, disposal_index);
            self.add_byte(1, XS_CODE_CALL);
            self.add_integer(-2, XS_CODE_RUN_1, 0);
            self.place_target(0, chain_target);
            // Await-using declarations await the disposer result before
            // continuing the unwind.
            if flags & crate::scoper::dflags::ASYNC_DISPOSABLE != 0 {
                self.add_byte(0, XS_CODE_AWAIT);
                self.add_byte(0, XS_CODE_THROW_STATUS);
            }
            self.add_byte(-1, XS_CODE_POP);
            self.add_byte(0, XS_CODE_UNCATCH);
            self.add_branch(0, XS_CODE_BRANCH_1, normal_target);
            self.place_target(0, catch_target);
            self.add_index(1, XS_CODE_USED_1, selector);
            self.place_target(0, normal_target);
        }
    }

    /// Open the implicit try region protecting a disposal scope.
    fn scope_code_using(&mut self, scope: usize) -> (i32, i32, usize) {
        if self.tree.scopes[scope].token == Token::Module {
            let disposable_ids: Vec<u32> = self.tree.scopes[scope]
                .declares
                .iter()
                .filter(|d| d.flags & crate::scoper::dflags::DISPOSABLE != 0)
                .map(|d| d.id)
                .collect();
            for id in disposable_ids {
                if self.declare_index_opt(scope, id).is_none() {
                    let index = self.set_declare_index(scope, id);
                    self.add_index(0, XS_CODE_NEW_TEMPORARY, index);
                }
            }
        }
        let exception = self.use_temporary();
        let selector = self.use_temporary();
        self.first_break_target = self.alias_targets(self.first_break_target);
        self.first_continue_target = self.alias_targets(self.first_continue_target);
        self.return_target = self.alias_targets(self.return_target);
        let catch_target = self.create_target();
        self.add_branch(0, XS_CODE_CATCH_1, catch_target);
        (exception, selector, catch_target)
    }

    /// Close a disposal scope, preserving abrupt-completion ordering and
    /// routing disposer throws through `USED` for SuppressedError chaining.
    fn scope_code_used(&mut self, scope: usize, context: (i32, i32, usize)) {
        let (exception, selector, catch_target) = context;
        let normal_target = self.create_target();
        let uncatch_target = self.create_target();
        let finally_target = self.create_target();
        let else_target = self.create_target();
        self.add_branch(0, XS_CODE_BRANCH_1, normal_target);
        self.place_target(0, catch_target);
        self.add_byte(1, XS_CODE_EXCEPTION);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, exception);
        self.add_integer(1, XS_CODE_INTEGER_1, 0);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, selector);
        self.add_branch(0, XS_CODE_BRANCH_1, finally_target);
        let mut selection = 1;
        self.first_break_target =
            self.finalize_targets(self.first_break_target, selector, &mut selection, uncatch_target);
        self.first_continue_target = self.finalize_targets(
            self.first_continue_target,
            selector,
            &mut selection,
            uncatch_target,
        );
        self.return_target =
            self.finalize_targets(self.return_target, selector, &mut selection, uncatch_target);
        self.place_target(0, normal_target);
        self.add_integer(1, XS_CODE_INTEGER_1, selection);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, selector);
        self.place_target(0, uncatch_target);
        self.add_byte(0, XS_CODE_UNCATCH);
        self.place_target(0, finally_target);
        self.scope_code_used_reverse(scope, exception, selector);
        self.add_index(1, XS_CODE_GET_LOCAL_1, selector);
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, else_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, exception);
        self.add_byte(-1, XS_CODE_THROW);
        self.place_target(0, else_target);
        let mut selection = 1;
        self.jump_targets(self.first_break_target, selector, &mut selection);
        self.jump_targets(self.first_continue_target, selector, &mut selection);
        self.jump_targets(self.return_target, selector, &mut selection);
        self.unuse_temporaries(2);
    }

    /// `fxBreakContinueNodeCode`. Child `[symbol-or-null]`.
    fn code_break_continue(&mut self, node: &Node) {
        let symbol = match node.children.first() {
            Some(Item::Symbol(s)) => Some(s.clone()),
            _ => None,
        };
        let is_break = node.token == Token::Break;
        let mut target = if is_break {
            self.first_break_target
        } else {
            self.first_continue_target
        };
        while let Some(t) = target {
            if self.targets[t].labels.iter().any(|l| *l == symbol) {
                self.adjust_environment(t);
                self.adjust_scope(t);
                self.add_branch(0, XS_CODE_BRANCH_1, t);
                return;
            }
            target = self.targets[t].next_target;
        }
        // No enclosing target carries this (label, kind): XS's
        // `fxBreakContinueNodeCode` reports "invalid break"/"invalid continue"
        // here (a code-time `fxReportParserError`, i.e. a parse-phase early
        // error). Record it as a structured rejection instead of panicking so
        // the front end declines the source exactly as XS does.
        self.report(
            node.line,
            if is_break { "invalid break" } else { "invalid continue" },
        );
    }

    /// `fxThrowNodeCode`. Child `[expression]`.
    fn code_throw(&mut self, node: &Node) {
        self.code(&node.children[0]);
        self.add_byte(-1, XS_CODE_THROW);
    }

    /// `fxYieldNodeCode` (synchronous). Child `[expression]`. Builds the
    /// `{ value, done: false }` result object, `YIELD`s it, and — until the
    /// generator is resumed with `.next()` (the `BRANCH_STATUS` fall-through
    /// to `target`) — threads a `.return()`/`.throw()` completion out to the
    /// function's return target. The async form (`await`/`THROW_STATUS`) and
    /// `yield*` (`Delegate`) are deferred.
    fn code_yield(&mut self, node: &Node) {
        let is_async = node.flags & crate::ast::flags::ASYNC != 0;
        let target = self.create_target();
        if is_async {
            // Async generators yield the raw value; the async runtime wraps
            // and awaits it.
            self.code(&node.children[0]);
        } else {
            self.add_byte(1, XS_CODE_OBJECT);
            self.add_byte(1, XS_CODE_DUB);
            self.code(&node.children[0]);
            self.add_symbol(-2, XS_CODE_NEW_PROPERTY, "value");
            self.add_integer(0, XS_CODE_INTEGER_1, 0);
            self.add_byte(1, XS_CODE_DUB);
            self.add_byte(1, XS_CODE_FALSE);
            self.add_symbol(-2, XS_CODE_NEW_PROPERTY, "done");
            self.add_integer(0, XS_CODE_INTEGER_1, 0);
        }
        self.add_byte(0, XS_CODE_YIELD);
        self.add_branch(1, XS_CODE_BRANCH_STATUS_1, target);
        if is_async {
            self.add_byte(0, XS_CODE_AWAIT);
            self.add_byte(0, XS_CODE_THROW_STATUS);
        }
        self.add_byte(-1, XS_CODE_SET_RESULT);
        let rt = self.return_target.expect("yield outside a function");
        self.adjust_environment(rt);
        self.adjust_scope(rt);
        self.add_branch(0, XS_CODE_BRANCH_1, rt);
        self.place_target(0, target);
    }

    /// `fxDelegateNodeCode` — `yield* expr`. Drives the delegate iterator's
    /// `next`/`return`/`throw` protocol, forwarding results out via
    /// `YIELD_STAR` and re-entering on resume, with the `async` variant
    /// awaiting each step. A faithful transliteration of XS's four-section
    /// (loop / return / throw / normal) state machine.
    fn code_delegate(&mut self, node: &Node) {
        let is_async = node.flags & crate::ast::flags::ASYNC != 0;
        let next_target = self.create_target();
        let catch_target = self.create_target();
        let rethrow_target = self.create_target();
        let return_target = self.create_target();
        let normal_target = self.create_target();
        let done_target = self.create_target();
        let iterator = self.use_temporary();
        let method = self.use_temporary();
        let next = self.use_temporary();
        let result = self.use_temporary();

        self.code(&node.children[0]);
        self.add_byte(0, if is_async { XS_CODE_FOR_AWAIT_OF } else { XS_CODE_FOR_OF });
        self.add_index(0, XS_CODE_SET_LOCAL_1, iterator);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "next");
        self.add_index(0, XS_CODE_SET_LOCAL_1, next);
        self.add_byte(-1, XS_CODE_POP);

        self.add_byte(1, XS_CODE_UNDEFINED);
        self.add_index(0, XS_CODE_SET_LOCAL_1, result);
        self.add_byte(-1, XS_CODE_POP);
        self.add_branch(0, XS_CODE_CATCH_1, catch_target);
        self.add_branch(0, XS_CODE_BRANCH_1, normal_target);

        // LOOP
        self.place_target(0, next_target);
        if is_async {
            self.add_symbol(0, XS_CODE_GET_PROPERTY, "value");
        }
        self.add_byte(0, XS_CODE_YIELD_STAR);
        self.add_index(0, XS_CODE_SET_LOCAL_1, result);
        self.add_byte(-1, XS_CODE_POP);
        self.add_branch(0, XS_CODE_CATCH_1, catch_target);
        self.add_branch(1, XS_CODE_BRANCH_STATUS_1, normal_target);

        // RETURN
        self.add_byte(0, XS_CODE_UNCATCH);
        if is_async {
            self.add_index(1, XS_CODE_GET_LOCAL_1, result);
            self.add_byte(0, XS_CODE_AWAIT);
            self.add_byte(0, XS_CODE_THROW_STATUS);
            self.add_index(0, XS_CODE_SET_LOCAL_1, result);
            self.add_byte(-1, XS_CODE_POP);
        }
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "return");
        self.add_branch(0, XS_CODE_BRANCH_CHAIN_1, return_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_byte(0, XS_CODE_SWAP);
        self.add_byte(1, XS_CODE_CALL);
        self.add_index(1, XS_CODE_GET_LOCAL_1, result);
        self.add_integer(-3, XS_CODE_RUN_1, 1);
        if is_async {
            self.add_byte(0, XS_CODE_AWAIT);
            self.add_byte(0, XS_CODE_THROW_STATUS);
        }
        self.add_byte(0, XS_CODE_CHECK_INSTANCE);
        self.add_byte(1, XS_CODE_DUB);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "done");
        self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, next_target);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "value");
        self.add_index(0, XS_CODE_SET_LOCAL_1, result);
        self.place_target(0, return_target);
        self.add_byte(-1, XS_CODE_POP);
        self.add_index(1, XS_CODE_GET_LOCAL_1, result);
        if is_async {
            self.add_byte(0, XS_CODE_AWAIT);
            self.add_byte(0, XS_CODE_THROW_STATUS);
        }
        self.add_byte(-1, XS_CODE_SET_RESULT);
        let rt = self.return_target.expect("yield* outside a function");
        self.adjust_environment(rt);
        self.adjust_scope(rt);
        self.add_branch(0, XS_CODE_BRANCH_1, rt);

        // THROW
        self.place_target(0, catch_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "throw");
        self.add_index(0, XS_CODE_SET_LOCAL_1, method);
        self.add_branch(-1, XS_CODE_BRANCH_COALESCE_1, done_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "return");
        self.add_branch(-1, XS_CODE_BRANCH_CHAIN_1, rethrow_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_byte(0, XS_CODE_SWAP);
        self.add_byte(1, XS_CODE_CALL);
        self.add_integer(-2, XS_CODE_RUN_1, 0);
        if is_async {
            self.add_byte(0, XS_CODE_AWAIT);
            self.add_byte(0, XS_CODE_THROW_STATUS);
        }
        self.add_byte(0, XS_CODE_CHECK_INSTANCE);
        self.place_target(0, rethrow_target);
        self.add_byte(-1, XS_CODE_POP);
        self.add_byte(1, XS_CODE_UNDEFINED);
        self.add_byte(0, XS_CODE_CHECK_INSTANCE);
        self.add_byte(-1, XS_CODE_POP);

        // NORMAL
        self.place_target(0, normal_target);
        self.add_byte(0, XS_CODE_UNCATCH);
        self.add_index(1, XS_CODE_GET_LOCAL_1, next);
        self.add_index(0, XS_CODE_SET_LOCAL_1, method);
        self.place_target(1, done_target);
        self.add_byte(-1, XS_CODE_POP);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_index(1, XS_CODE_GET_LOCAL_1, method);
        self.add_byte(1, XS_CODE_CALL);
        self.add_index(1, XS_CODE_GET_LOCAL_1, result);
        self.add_integer(-3, XS_CODE_RUN_1, 1);
        if is_async {
            self.add_byte(0, XS_CODE_AWAIT);
            self.add_byte(0, XS_CODE_THROW_STATUS);
        }
        self.add_byte(0, XS_CODE_CHECK_INSTANCE);
        self.add_byte(1, XS_CODE_DUB);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "done");
        self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, next_target);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "value");

        self.unuse_temporaries(4);
    }

    /// `fxAwaitNodeCode`. Child `[expression]`. Evaluate the awaited value,
    /// `AWAIT`, and (until the async job resumes — `BRANCH_STATUS`
    /// fall-through) thread the rejection/completion out to the return
    /// target.
    fn code_await(&mut self, node: &Node) {
        let target = self.create_target();
        self.code(&node.children[0]);
        self.add_byte(0, XS_CODE_AWAIT);
        self.add_branch(1, XS_CODE_BRANCH_STATUS_1, target);
        self.add_byte(-1, XS_CODE_SET_RESULT);
        let rt = self.return_target.expect("await outside a function");
        self.adjust_environment(rt);
        self.adjust_scope(rt);
        self.add_branch(0, XS_CODE_BRANCH_1, rt);
        self.place_target(0, target);
    }

    /// The symbol name in an `Item::Symbol` child slot.
    fn symbol_of(item: &Item) -> &str {
        match item {
            Item::Symbol(s) => s.as_str(),
            _ => panic!("expected symbol slot"),
        }
    }

    /// A name slot that may be `NULL` (an anonymous function/class).
    fn symbol_opt(item: &Item) -> Option<String> {
        match item {
            Item::Symbol(s) => Some(s.clone()),
            _ => None,
        }
    }

    /// `fxNodeCodeName` — whether coding `value` in a naming position (a
    /// binding/assignment/property whose target supplies a name) would
    /// infer a name for an anonymous function/class. Name inference is a
    /// deferred slice, so callers assert a `false` here rather than emit a
    /// wrongly-anonymous function.
    fn infers_name(item: &Item) -> bool {
        let node = match item {
            Item::Node(n) => n,
            _ => return false,
        };
        match node.token {
            // a single-item parenthesized expression forwards to its item
            Token::Expressions => {
                if let Some(Item::List(items)) = node.children.first() {
                    if items.len() == 1 {
                        return Self::infers_name(&items[0]);
                    }
                }
                false
            }
            Token::Function | Token::Generator => {
                matches!(node.children.first(), Some(Item::Null))
            }
            Token::Class => matches!(node.children.first(), Some(Item::Null)),
            _ => false,
        }
    }

    /// `fxAccessNodeCode`. Child `[symbol]`. At program scope every
    /// identifier is a free (global) reference, so the coder takes the
    /// unresolved path: an `EVAL_REFERENCE` (the program is coded with the
    /// eval flag) then `GET_VARIABLE`. Resolved (local/closure) access
    /// needs the scoper's per-node declaration and arrives with the
    /// declaration slices.
    fn code_access(&mut self, node: &Node) {
        // fxAccessNodeCode: a resolved access loads its frame slot; a free
        // reference falls back to the symbol path.
        if let Some((scope, id)) = self.resolution_of(node) {
            let index = self.declare_index(scope, id);
            let op = if self.is_closure(scope, id) { XS_CODE_GET_CLOSURE_1 } else { XS_CODE_GET_LOCAL_1 };
            self.add_index(1, op, index);
            return;
        }
        let name = Self::symbol_of(&node.children[0]).to_string();
        // fxAccessNodeCodeReference (unresolved, evalFlag branch)
        if self.eval_flag {
            self.add_symbol(1, XS_CODE_EVAL_REFERENCE, &name);
        } else {
            self.add_symbol(1, XS_CODE_PROGRAM_REFERENCE, &name);
        }
        self.add_symbol(0, XS_CODE_GET_VARIABLE, &name);
    }

    /// `fxBindingNodeCode` — `target = initializer` in a declaration
    /// (`var`/`let`/`const` with an initializer). A `Binding` reaching the
    /// value-coding path with an `Access` target is a CoverInitializedName
    /// used as a real expression (`({ a = 1 })` / `[a = 1]`) that was never
    /// refined to a destructuring pattern — a Syntax Error (`invalid
    /// initializer`). A pattern context codes the binding through the
    /// Assign/Reference path instead, which never lands here.
    fn code_binding(&mut self, node: &Node) {
        if let Item::Node(t) = &node.children[0] {
            if t.token == Token::Access {
                panic!("coder: invalid initializer");
            }
        }
        // Name inference: `var/let/const f = function(){}` names the
        // anonymous value `f` (its name lands in the function-creation
        // operand). Only a simple identifier target supplies a name.
        self.set_pending_name(&node.children[0], &node.children[1]);
        self.code_reference(&node.children[0], 0);
        self.code(&node.children[1]);
        self.code_assign(&node.children[0], 0);
        self.add_byte(-1, XS_CODE_POP);
    }

    /// `fxImportCallNodeCode` — a dynamic `import(specifier[, options])`.
    /// Code the specifier, then the options (or `UNDEFINED` when absent),
    /// mark the module header's `mxImportFlag`, and emit `IMPORT`.
    fn code_import_call(&mut self, node: &Node) {
        self.code(&node.children[0]);
        match &node.children[1] {
            Item::Node(_) => self.code(&node.children[1]),
            _ => self.add_byte(1, XS_CODE_UNDEFINED),
        }
        self.import_flag = true;
        self.add_byte(-1, XS_CODE_IMPORT);
    }

    /// `fxImportMetaNodeCode` — `import.meta`: mark the header's
    /// `mxImportMetaFlag` and push the meta object.
    fn code_import_meta(&mut self, _node: &Node) {
        self.import_meta_flag = true;
        self.add_byte(1, XS_CODE_IMPORT_META);
    }

    /// If `value` is an anonymous function/class and `target` is a simple
    /// identifier (a declaration or an `Access`), stage the target's name
    /// for the function-creation operand; otherwise assert that no name
    /// inference is needed (the class / object-method / `NAME`-op paths are
    /// deferred).
    fn set_pending_name(&mut self, target: &Item, value: &Item) {
        if !Self::infers_name(value) {
            return;
        }
        // An anonymous function or class takes the target identifier as its
        // name: a function via its creation operand, an anonymous class via
        // its constructor's creation operand (`code_class` leaves
        // `pending_name` for the constructor `code_function` to consume, and
        // emits no `NAME` op since the class itself is unnamed).
        // Only a simple identifier (a declaration or a bare `Access`) names
        // the value; a member / computed / pattern target leaves the value
        // anonymous (ES `IsAnonymousFunctionDefinition` + `NamedEvaluation`
        // apply only to identifier LHS — `o.m = function(){}` stays unnamed).
        let name = match target {
            Item::Node(n) => match n.token {
                Token::Var | Token::Let | Token::Const | Token::Using | Token::Arg => {
                    Self::symbol_opt(&n.children[0])
                }
                Token::Access => Self::symbol_opt(&n.children[0]),
                _ => None,
            },
            _ => None,
        };
        self.pending_name = name;
    }

    /// `fxDeclareNodeCode` — a bare declaration with no initializer. `var`
    /// emits nothing (its slot was set up in the scope header); `let`
    /// initializes its slot to `undefined`; `const`/`using` without an
    /// initializer are SyntaxErrors reported here — a *code-time* check, so
    /// a `for (const x of y)` iteration binding (coded through the
    /// reference/assign path, never dispatched here) is exempt exactly as
    /// in XS.
    fn code_declare(&mut self, node: &Node) {
        match node.token {
            Token::Const => self.report(node.line, "invalid const"),
            Token::Using => self.report(node.line, "invalid using"),
            Token::Let => {
                self.code_declare_reference(node);
                self.add_byte(1, XS_CODE_UNDEFINED);
                self.code_declare_assign(node);
                self.add_byte(-1, XS_CODE_POP);
            }
            _ => {}
        }
    }

    /// `fxDeclareNodeCodeReference` — a resolved declaration needs no
    /// reference; an unresolved one (a sloppy-eval `var`) takes the symbol
    /// path.
    fn code_declare_reference(&mut self, node: &Node) {
        if self.resolution_of(node).is_some() {
            return;
        }
        let name = Self::symbol_of(&node.children[0]).to_string();
        if self.eval_flag {
            self.add_symbol(1, XS_CODE_EVAL_REFERENCE, &name);
        } else {
            self.add_symbol(1, XS_CODE_PROGRAM_REFERENCE, &name);
        }
    }

    /// `fxDeclareNodeCodeAssign` — store the initializer into the
    /// declaration's slot with the token's binding op (`VAR_LOCAL` /
    /// `LET_LOCAL` / `CONST_LOCAL`, or the `*_CLOSURE` variants), or
    /// `SET_VARIABLE` on the symbol path.
    fn code_declare_assign(&mut self, node: &Node) {
        match self.resolution_of(node) {
            None => {
                let name = Self::symbol_of(&node.children[0]).to_string();
                self.add_symbol(-1, XS_CODE_SET_VARIABLE, &name);
            }
            Some((scope, id)) => {
                let index = self.declare_index(scope, id);
                let closure = self.is_closure(scope, id);
                let op = match node.token {
                    Token::Const | Token::Using => {
                        if closure { XS_CODE_CONST_CLOSURE_1 } else { XS_CODE_CONST_LOCAL_1 }
                    }
                    Token::Let => {
                        if closure { XS_CODE_LET_CLOSURE_1 } else { XS_CODE_LET_LOCAL_1 }
                    }
                    _ => {
                        if closure { XS_CODE_VAR_CLOSURE_1 } else { XS_CODE_VAR_LOCAL_1 }
                    }
                };
                self.add_index(0, op, index);
                if node.token == Token::Using {
                    self.add_byte(
                        0,
                        if node.flags & crate::ast::flags::AWAITING != 0 {
                            XS_CODE_USING_ASYNC
                        } else {
                            XS_CODE_USING
                        },
                    );
                    let declares = &self.tree.scopes[scope].declares;
                    let position = declares.iter().position(|d| d.id == id).unwrap();
                    let disposal_id = declares[position + 1].id;
                    let disposal_index = self.declare_index(scope, disposal_id);
                    self.add_index(0, XS_CODE_SET_LOCAL_1, disposal_index);
                }
            }
        }
    }

    /// `fxDefineNodeCode` — a function/host declaration statement (`(Define
    /// #name value)`). Reference the declaration, code its initializer (a
    /// function value), store, and pop. A define is coded once (XS's
    /// `mxDefineNodeCodedFlag`): it is hoisted to the top of its scope by
    /// [`Coder::code_define_nodes`], so the in-list statement is a no-op.
    fn code_define(&mut self, node: &Node) {
        if !self.defined.insert(node_key(node)) {
            return;
        }
        self.code_declare_reference(node);
        // Name inference for an anonymous initializer: `export default
        // function(){}` builds a `Define(default)` whose initializer is an
        // anonymous function, which takes the define's `default` name (XS
        // stamps `parser->defaultSymbol` on the node; the value's creation
        // operand carries it). A named function declaration supplies its own
        // name, so `infers_name` is false and this is a no-op.
        if Self::infers_name(&node.children[1]) {
            self.pending_name = Self::symbol_opt(&node.children[0]);
        }
        self.code(&node.children[1]);
        self.code_declare_assign(node);
        self.add_byte(-1, XS_CODE_POP);
    }

    /// `fxScopeCodeDefineNodes` — hoist and code the function-declaration
    /// (`Define`) statements at the top of a scope's body, in source order,
    /// before the ordinary statements. Marks each coded so its in-list
    /// occurrence is skipped.
    fn code_define_nodes(&mut self, body: &Item) {
        for item in Self::statement_items(body) {
            if let Item::Node(n) = item {
                if n.token == Token::Define {
                    self.code_define(n);
                }
            }
        }
    }

    /// The ordered statement items of a body: a `Statements` node's list,
    /// or the single statement itself.
    fn statement_items(body: &Item) -> Vec<&Item> {
        if let Item::Node(n) = body {
            if n.token == Token::Statements {
                if let Some(Item::List(items)) = n.children.first() {
                    return items.iter().collect();
                }
            }
        }
        vec![body]
    }

    /// `fxCoderCountParameters` — the leading simple/pattern parameter
    /// count (stops at the first rest binding or non-parameter slot).
    fn count_parameters(&self, params: &Item) -> i32 {
        let Item::Node(p) = params else { return 0 };
        let Some(Item::List(items)) = p.children.first() else { return 0 };
        let mut count = 0;
        for it in items {
            match it {
                Item::Node(n)
                    if matches!(n.token, Token::Arg | Token::ArrayBinding | Token::ObjectBinding) =>
                {
                    count += 1;
                }
                _ => break,
            }
        }
        count
    }

    /// `fxFunctionNodeCode` — emit a function value. Children `[name?,
    /// ParamsBinding, Body]`. This slice covers plain
    /// (`CONSTRUCTOR_FUNCTION`) and arrow (`FUNCTION`) functions; async,
    /// generator, method, getter/setter, and class field/base/derived
    /// constructors assert (later slices), as do parameters and captured
    /// closures.
    /// `fxClassNodeCode` — a class value. Children `[name, heritage, items,
    /// constructorInit, instanceInit, constructor]`. This slice covers a
    /// base class (no `extends`) with a synthesized/explicit constructor and
    /// concise method / accessor members. Deferred (assert): a named class
    /// (needs the symbol scope), `extends`, instance/static **fields** and
    /// **private** members, static blocks, and computed method keys — all of
    /// which the scoper's class-hoisting fold has not set up yet.
    /// `fxSuperNodeCode` — a `super(...)` call in a derived constructor:
    /// invoke the parent constructor (`SUPER` + the argument list) and
    /// install its result as `this` (`SET_THIS`). Child `[params]`. The
    /// instance-field-init call after `super(...)` is deferred with fields;
    /// a `@host` heritage is a deferred (native) form.
    fn code_super(&mut self, node: &Node) {
        self.add_byte(3, XS_CODE_SUPER);
        self.code(&node.children[0]);
        self.add_byte(0, XS_CODE_SET_THIS);
        // A derived class with instance fields calls its `instanceInit` field
        // initializer here, once `super(...)` has installed `this`
        // (`fxSuperNodeCode`): `this`, the captured closure, a zero-arg run.
        if let Some(&(ascope, aid)) = self.tree.super_instance_init.get(&node_key(node)) {
            let idx = self.declare_index(ascope, aid);
            self.add_byte(1, XS_CODE_GET_THIS);
            self.add_index(1, XS_CODE_GET_CLOSURE_1, idx);
            self.add_byte(1, XS_CODE_CALL);
            self.add_integer(-2, XS_CODE_RUN_1, 0);
            self.add_byte(-1, XS_CODE_POP);
        }
    }

    fn code_class(&mut self, node: &Node) {
        use crate::ast::flags as f;
        assert!(matches!(node.children[3], Item::Null), "class field/static-block init deferred");
        assert!(matches!(node.children[4], Item::Null), "class instance-field init deferred");

        let name = Self::symbol_opt(&node.children[0]);
        let class_scope = self.scope_of(node);
        let symbol_scope = self.tree.node_scopes.get(&node_key(node)).and_then(|s| s.1);
        // The synthesized `instanceInit` closure declare, present when the
        // class has instance data fields (see `class_has_instance_field`).
        let instance_init = self.tree.class_instance_init.get(&node_key(node)).copied();

        let prototype = self.use_temporary();
        let constructor = self.use_temporary();

        // NamedEvaluation: an anonymous class assigned to `D` (`var D =
        // class extends E {}`) names its **constructor** "D" through the
        // constructor's creation operand, not the heritage expression.
        // Hold the inferred `pending_name` across the heritage evaluation
        // so a heritage `function(){}` (itself a `CONSTRUCTOR_FUNCTION`
        // that would consume the pending name) stays anonymous, then
        // restore it for the constructor's `code_function`.
        let inferred_name = self.pending_name.take();

        // A named class binds its name to a `const` closure slot visible in
        // the body (`NEW_CLOSURE`).
        if let Some(ss) = symbol_scope {
            self.scope_coding_block(ss);
        }

        // Heritage: `extends E` derives the prototype from `E` (`EXTEND`);
        // no heritage builds a fresh prototype with a null parent. A `@host`
        // heritage is a deferred (native) form.
        if let Item::Node(h) = &node.children[1] {
            assert_ne!(h.token, Token::Host, "class `extends @host` deferred");
            self.code(&node.children[1]);
            self.add_byte(1, XS_CODE_EXTEND);
        } else {
            self.add_byte(1, XS_CODE_NULL);
            self.add_byte(1, XS_CODE_OBJECT);
        }
        self.add_index(0, XS_CODE_SET_LOCAL_1, prototype);

        // The class body scope (private/field declares are deferred; empty
        // for the method-only surface).
        self.scope_coding_block(class_scope);

        // The constructor function, then bind the prototype/constructor pair.
        // A base constructor of a field-bearing class captures the
        // `instanceInit` closure and calls it on entry; expose the target so
        // `code_function` can find the constructor's capturing alias.
        let saved_instance_init = self.class_instance_init;
        self.class_instance_init = instance_init;
        self.pending_name = inferred_name;
        self.code(&node.children[5]);
        self.class_instance_init = saved_instance_init;
        self.add_byte(0, XS_CODE_TO_INSTANCE);
        self.add_index(0, XS_CODE_SET_LOCAL_1, constructor);
        self.add_byte(-3, XS_CODE_CLASS);
        self.add_index(1, XS_CODE_GET_LOCAL_1, constructor);
        if let Some(n) = name.as_deref() {
            self.add_symbol(0, XS_CODE_NAME, n);
        }

        // Members: concise **public** methods / accessors emit inline; data
        // fields, computed-key fields, and **private** members (fields and
        // methods) are collected for the synthesized init functions. A
        // computed-key field evaluates its key once here (`AT` +
        // `CONST_CLOSURE` into `atAccess`); a private member binds its brand
        // (and, for a private method, its value) into the class-scope
        // `symbolAccess` / `valueAccess` closures.
        // XS's parser (`fxClassExpression`) fills the init-function field
        // lists in TWO passes: private methods/accessors first (in source
        // order), then data fields + `static { … }` blocks (in source
        // order). The member-loop `CONST_CLOSURE` emission below stays in
        // source order; only the collected field order is two-pass.
        let mut static_methods: Vec<&Node> = Vec::new();
        let mut static_data: Vec<&Node> = Vec::new();
        let mut instance_methods: Vec<&Node> = Vec::new();
        let mut instance_data: Vec<&Node> = Vec::new();
        if let Some(Item::List(items)) = node.children.get(2) {
            for item in items {
                let p = node_of(item);
                let is_method = p.flags & (f::METHOD | f::GETTER | f::SETTER) != 0;
                let is_static = p.flags & f::STATIC != 0;
                let is_public_method = is_method && p.token != Token::PrivateProperty;
                if is_public_method {
                    // The member target: the constructor (static) or the
                    // prototype (instance).
                    if is_static {
                        self.add_byte(1, XS_CODE_DUB);
                    } else {
                        self.add_index(1, XS_CODE_GET_LOCAL_1, prototype);
                    }
                    let flag = XS_DONT_ENUM_FLAG | Self::property_flag(p);
                    self.pending_accessor = p.flags & (f::GETTER | f::SETTER) != 0;
                    match p.token {
                        Token::Property => {
                            let key = Self::symbol_of(&p.children[0]).to_string();
                            self.code(&p.children[1]);
                            self.add_symbol(-2, XS_CODE_NEW_PROPERTY, &key);
                        }
                        Token::PropertyAt => {
                            // A computed key `[e]`: evaluate the key, `AT`,
                            // then the method value.
                            self.code(&p.children[0]);
                            self.add_byte(0, XS_CODE_AT);
                            self.code(&p.children[1]);
                            self.add_byte(-3, XS_CODE_NEW_PROPERTY_AT);
                        }
                        other => panic!("coder: unsupported class member {:?}", other),
                    }
                    self.add_integer(0, XS_CODE_INTEGER_1, flag);
                    continue;
                }
                // A field / private member: emit its class-scope closure
                // binding(s), then collect it for the init function.
                let access = self.tree.class_member_access.get(&node_key(p)).copied();
                match p.token {
                    Token::PropertyAt => {
                        // Computed-key field: `at`, `AT`, store the key into
                        // the `atAccess` closure (kept for the field function).
                        let at = access.and_then(|a| a.at).expect("computed field atAccess");
                        self.code(&p.children[0]);
                        self.add_byte(0, XS_CODE_AT);
                        let idx = self.declare_index(class_scope, at);
                        self.add_index(0, XS_CODE_CONST_CLOSURE_1, idx);
                        self.add_byte(-1, XS_CODE_POP);
                    }
                    Token::PrivateProperty => {
                        // Bind the private brand (`symbolAccess`) from the
                        // constructor already on the stack; a private
                        // method/accessor also stashes its value.
                        let a = access.expect("private member access");
                        let sidx = self.declare_index(class_scope, a.symbol.expect("symbolAccess"));
                        self.add_index(0, XS_CODE_CONST_CLOSURE_1, sidx);
                        if is_method {
                            self.pending_accessor = p.flags & (f::GETTER | f::SETTER) != 0;
                            self.code(&p.children[1]);
                            let vidx = self.declare_index(class_scope, a.value.expect("valueAccess"));
                            self.add_index(0, XS_CODE_CONST_CLOSURE_1, vidx);
                            self.add_byte(-1, XS_CODE_POP);
                        }
                    }
                    Token::Property | Token::Body => {}
                    other => panic!("coder: unsupported class field {:?}", other),
                }
                let private_method = is_method; // (public methods took the branch above)
                match (is_static, private_method) {
                    (true, true) => static_methods.push(p),
                    (true, false) => static_data.push(p),
                    (false, true) => instance_methods.push(p),
                    (false, false) => instance_data.push(p),
                }
            }
        }
        // Private methods first, then data fields / static blocks.
        let instance_fields: Vec<&Node> =
            instance_methods.into_iter().chain(instance_data).collect();
        let static_fields: Vec<&Node> =
            static_methods.into_iter().chain(static_data).collect();

        // Instance data fields run through the synthesized `instanceInit`
        // field function stored in the class-body closure. A base constructor
        // calls it on entry; a derived class calls it after `super(...)`
        // installs `this`.
        if !instance_fields.is_empty() {
            assert!(
                instance_init.is_some(),
                "instance fields present but no instanceInit declare (scoper)"
            );
        }

        // Store the class into its own name's closure slot (visible in the
        // body).
        if let Some(ss) = symbol_scope {
            let id = self.tree.scopes[ss].declares[0].id;
            let idx = self.declare_index(ss, id);
            self.add_index(0, XS_CODE_CONST_CLOSURE_1, idx);
        }

        // Instance fields: the `instanceInit` field function, homed on the
        // prototype and stored in the class-body closure the constructor
        // captures (`fxClassNodeCode`'s `instanceInit` block).
        if !instance_fields.is_empty() {
            let (iscope, iid) = instance_init.expect("instance-init declare");
            let fi = self.tree.class_field_init_inst.get(&node_key(node)).copied();
            self.code_field_init_function(&instance_fields, class_scope, fi);
            self.add_index(1, XS_CODE_GET_LOCAL_1, prototype);
            self.add_byte(-1, XS_CODE_SET_HOME);
            let idx = self.declare_index(iscope, iid);
            self.add_index(0, XS_CODE_CONST_CLOSURE_1, idx);
            self.add_byte(-1, XS_CODE_POP);
        }

        // Static fields run through a synthesized `constructorInit` field
        // function invoked with the constructor as `this`/home.
        if !static_fields.is_empty() {
            let ci = self.tree.class_field_init_static.get(&node_key(node)).copied();
            self.add_index(1, XS_CODE_GET_LOCAL_1, constructor);
            self.code_field_init_function(&static_fields, class_scope, ci);
            self.add_index(1, XS_CODE_GET_LOCAL_1, constructor);
            self.add_byte(-1, XS_CODE_SET_HOME);
            self.add_byte(1, XS_CODE_CALL);
            self.add_integer(-2, XS_CODE_RUN_1, 0);
            self.add_byte(-1, XS_CODE_POP);
        }

        self.scope_coded(class_scope);
        if let Some(ss) = symbol_scope {
            self.scope_coded(ss);
        }
        self.unuse_temporaries(2);
    }

    /// Emit the synthesized field-initializer function (XS's
    /// `instanceInit` / `constructorInit`): a `CONSTRUCTOR_FUNCTION` whose
    /// `BEGIN_STRICT_FIELD` body runs `fxFieldNodeCode` for each field with
    /// `this` bound to the target (constructor for static, instance for
    /// instance fields). Mirrors `code_function`'s wrapper (save/restore,
    /// `CODE`/`END`, environment store). Computed-key and private fields
    /// capture their class-scope closures (`atAccess` / `symbolAccess` /
    /// `valueAccess`) as use-closure aliases in this function's own frame:
    /// XS's field function is a real `mxFieldFlag` function with a scope, so
    /// it `RESERVE`s the alias slots, `RETRIEVE`s the closures at entry, and
    /// `STORE`s them from the enclosing class frame after creation.
    fn code_field_init_function(&mut self, fields: &[&Node], class_scope: usize, fi: Option<usize>) {
        use crate::ast::flags as f;
        let saved_return = self.return_target;
        let saved_scope_level = self.scope_level;
        let saved_program = self.program_flag;
        let saved_break = self.first_break_target;
        let saved_continue = self.first_continue_target;
        let saved_env = self.environment_level;
        let saved_eval = self.eval_flag;

        // Capture plan: class-scope declare ids in alias order (first
        // reference wins — a private method reads `valueAccess` before
        // `symbolAccess`), plus each field's 1-based alias slots.
        let mut caps: Vec<u32> = Vec::new();
        let mut plans: Vec<FieldPlan> = Vec::with_capacity(fields.len());
        // XS's `fxScopeLookup` resolves every `symbolAccess` for one private
        // name to the *first* class-scope declare of that name (a symbol-
        // pointer match), so a `get #x`/`set #x` accessor pair captures ONE
        // shared brand slot — not two — in the field-init function's frame
        // (`fxScopeGetDeclareNode(functionScope, symbol)` dedups the
        // use-closure). Dedup the brand cap by private name here; each
        // member's `valueAccess` stays a distinct per-member cap.
        let mut brand_slot: std::collections::HashMap<String, i32> = std::collections::HashMap::new();
        // The **member-closure** (static / `fi`-less) path builds the capture
        // plan by hand — class-scope declare ids in alias order and each
        // field's 0-based alias slot. The **field-function-scope** (`fi`) path
        // instead reads the scope's recorded member-access use-closure aliases
        // and resolves them to frame slots *after* `RETRIEVE` assigns indices
        // (see below), so its plans are built there.
        if fi.is_none() {
            for field in fields {
                let access = self.tree.class_member_access.get(&node_key(field)).copied();
                let is_method = field.flags & (f::METHOD | f::GETTER | f::SETTER) != 0;
                let mut plan = FieldPlan::default();
                // Alias slots are 0-based (the `index + 1` serialization family
                // adds the one): the slot is the frame position *before* the
                // push.
                match field.token {
                    Token::PropertyAt => {
                        plan.at = Some(caps.len() as i32);
                        caps.push(access.and_then(|a| a.at).expect("computed field atAccess"));
                    }
                    Token::PrivateProperty => {
                        let a = access.expect("private member access");
                        if is_method {
                            plan.value = Some(caps.len() as i32);
                            caps.push(a.value.expect("valueAccess"));
                        }
                        let sym_id = a.symbol.expect("symbolAccess");
                        // The private name of this brand declare (a `Named` sym).
                        let name = self.tree.scopes[class_scope]
                            .declares
                            .iter()
                            .find(|d| d.id == sym_id)
                            .and_then(|d| match &d.symbol {
                                Some(crate::scoper::Sym::Named(n)) => Some(n.clone()),
                                _ => None,
                            });
                        let slot = match name {
                            Some(n) => *brand_slot.entry(n).or_insert_with(|| {
                                let s = caps.len() as i32;
                                caps.push(sym_id);
                                s
                            }),
                            None => {
                                let s = caps.len() as i32;
                                caps.push(sym_id);
                                s
                            }
                        };
                        plan.symbol = Some(slot);
                    }
                    Token::Body => {
                        // A `static { … }` block with its own lexical
                        // declarations needs those slots reserved in this
                        // function's frame — the remaining class-tail fold.
                        // (XS RESERVEs them in the constructorInit function via
                        // its `scopeMaximum`; the inline-synthesized field-init
                        // function here has no such precomputed count yet.)
                        let bscope = self.tree.node_scopes.get(&node_key(field)).map(|s| s.0);
                        assert!(
                            bscope.map(|s| self.declare_count(s)).unwrap_or(0) == 0,
                            "static block with lexical declarations deferred"
                        );
                    }
                    _ => {}
                }
                plans.push(plan);
            }
        }
        let k = caps.len() as i32;

        let target = self.create_target();
        self.program_flag = false;
        self.scope_level = 0;
        self.first_break_target = None;
        self.first_continue_target = None;

        self.add_symbol_opt(1, XS_CODE_CONSTRUCTOR_FUNCTION, None);
        self.add_branch(0, XS_CODE_CODE_1, target);
        self.add_index(0, XS_CODE_BEGIN_STRICT_FIELD, 0);
        // A field-bearing class binds its initializers inside a real
        // `instanceInit` function scope (`fi`): its use-closure aliases —
        // computed-key / private-brand / private-value member closures AND
        // outer bindings a field value captures — drive the frame
        // `RESERVE`/`RETRIEVE` (`scopeCount == scopeMaximum` = closures + peak
        // value-temporary depth) and the closure-slot access indices. The
        // static member-closure path reserves `k` member-closure slots.
        if let Some(fi) = fi {
            // A field-init function scope holds only member-access / value
            // use-closure aliases; a real (non-alias) declare means a
            // `static { … }` block hoisted a lexical declaration into it (its
            // own frame reservation + block coding is the remaining class-tail
            // fold). Keep it a loud, named fold rather than a mis-emit.
            if self.tree.scopes[fi]
                .declares
                .iter()
                .any(|d| d.flags & crate::scoper::dflags::USE_CLOSURE == 0)
            {
                panic!("static block with lexical declarations deferred");
            }
            let reserve = *self.tree.scope_counts.get(&fi).unwrap_or(&0);
            if reserve != 0 {
                self.add_index(0, XS_CODE_RESERVE_1, reserve);
            }
            self.scope_code_retrieve(fi);
            // Each field's member accesses now have assigned frame slots; read
            // them back as the field body's `GET_CLOSURE` / `NEW_PRIVATE`
            // operands (a get/set pair shares one brand slot via the scoper's
            // use-closure dedup).
            for field in fields {
                let slots =
                    self.tree.class_member_fi.get(&node_key(field)).copied().unwrap_or_default();
                let plan = FieldPlan {
                    at: slots.at.map(|id| self.declare_index(fi, id)),
                    symbol: slots.symbol.map(|id| self.declare_index(fi, id)),
                    value: slots.value.map(|id| self.declare_index(fi, id)),
                };
                plans.push(plan);
            }
            // `fxScopeCodingParams` (xsCode.c: fxFunctionNodeCode calls it
            // right after `fxScopeCodeRetrieve`): a field-init function whose
            // initializer contains a direct `eval` is reached by the scope's
            // `mxEvalFlag` (set on `fi` during the hoist-time poison walk, now
            // that sibling 1 creates the field-init scope at hoist), so it
            // publishes its (empty) parameter set into a `with` environment —
            // the strict-mode `undefined; with; pop` eval prelude. A field-init
            // scope declares only closure aliases, so this is the sole effect.
            self.scope_coding_params(fi);
        } else if k != 0 {
            self.add_index(0, XS_CODE_RESERVE_1, k);
            self.add_index(0, XS_CODE_RETRIEVE_1, k);
        }
        self.return_target = Some(self.create_target());
        for (field, plan) in fields.iter().zip(plans.iter()) {
            self.code_field(field, plan);
        }
        let rt = self.return_target.expect("field-init return target");
        self.place_target(0, rt);
        self.add_byte(0, XS_CODE_END);
        self.place_target(0, target);

        // Store the captured closures into the new function's environment,
        // running in the enclosing class frame (`fxScopeCodeStore`). At eval
        // scope the environment is a `FUNCTION_ENVIRONMENT`; otherwise a
        // captured field function needs a plain `ENVIRONMENT`.
        if let Some(fi) = fi {
            let has_captures = self.tree.scopes[fi].closure_count != 0;
            if saved_eval {
                self.add_byte(1, XS_CODE_FUNCTION_ENVIRONMENT);
                self.scope_code_store(fi);
                self.add_byte(-1, XS_CODE_POP);
            } else if has_captures {
                self.add_byte(1, XS_CODE_ENVIRONMENT);
                self.scope_code_store(fi);
                self.add_byte(-1, XS_CODE_POP);
            }
        } else if saved_eval {
            self.add_byte(1, XS_CODE_FUNCTION_ENVIRONMENT);
            for &cap in &caps {
                let idx = self.declare_index(class_scope, cap);
                self.add_index(0, XS_CODE_STORE_1, idx);
            }
            self.add_byte(-1, XS_CODE_POP);
        } else if k != 0 {
            self.add_byte(1, XS_CODE_ENVIRONMENT);
            for &cap in &caps {
                let idx = self.declare_index(class_scope, cap);
                self.add_index(0, XS_CODE_STORE_1, idx);
            }
            self.add_byte(-1, XS_CODE_POP);
        }

        self.return_target = saved_return;
        self.first_continue_target = saved_continue;
        self.first_break_target = saved_break;
        self.scope_level = saved_scope_level;
        self.program_flag = saved_program;
        self.eval_flag = saved_eval;
        self.environment_level = saved_env;
    }

    /// `fxFieldNodeCode`: `this`, the value (or a captured private-method
    /// value), then the property-installing op with the inferred-name flag.
    /// A `Property` is a plain data field; a `PropertyAt` reads its captured
    /// `atAccess` key (`NEW_PROPERTY_AT`); a `PrivateProperty` installs a
    /// private (`NEW_PRIVATE`) whose brand is the captured `symbolAccess`.
    fn code_field(&mut self, p: &Node, plan: &FieldPlan) {
        use crate::ast::flags as f;
        // A `static { … }` block runs its statements directly (no
        // `this`/property install), with `this` bound to the constructor.
        if p.token == Token::Body {
            self.code(&p.children[0]);
            return;
        }
        self.add_byte(1, XS_CODE_THIS);
        match p.token {
            Token::Property => {
                let key = Self::symbol_of(&p.children[0]).to_string();
                self.code(&p.children[1]);
                self.add_symbol(-2, XS_CODE_NEW_PROPERTY, &key);
                let flag = if Self::infers_name(&p.children[1]) { XS_NAME_FLAG } else { 0 };
                self.add_integer(0, XS_CODE_INTEGER_1, flag);
            }
            Token::PropertyAt => {
                self.add_index(1, XS_CODE_GET_CLOSURE_1, plan.at.expect("atAccess alias"));
                self.code(&p.children[1]);
                self.add_byte(-3, XS_CODE_NEW_PROPERTY_AT);
                let flag = if Self::infers_name(&p.children[1]) { XS_NAME_FLAG } else { 0 };
                self.add_integer(0, XS_CODE_INTEGER_1, flag);
            }
            Token::PrivateProperty => {
                let is_method = p.flags & (f::METHOD | f::GETTER | f::SETTER) != 0;
                if is_method {
                    self.add_index(1, XS_CODE_GET_CLOSURE_1, plan.value.expect("valueAccess alias"));
                } else {
                    self.code(&p.children[1]);
                }
                self.add_index(-2, XS_CODE_NEW_PRIVATE_1, plan.symbol.expect("symbolAccess alias"));
                let flag = if p.flags & f::METHOD != 0 {
                    XS_NAME_FLAG | XS_METHOD_FLAG
                } else if p.flags & f::GETTER != 0 {
                    XS_NAME_FLAG | XS_METHOD_FLAG | XS_GETTER_FLAG
                } else if p.flags & f::SETTER != 0 {
                    XS_NAME_FLAG | XS_METHOD_FLAG | XS_SETTER_FLAG
                } else if Self::infers_name(&p.children[1]) {
                    XS_NAME_FLAG
                } else {
                    0
                };
                self.add_integer(0, XS_CODE_INTEGER_1, flag);
            }
            other => panic!("coder: unsupported field node {:?}", other),
        }
    }

    fn code_function(&mut self, node: &Node) {
        use crate::ast::flags as f;
        let flags = node.flags;
        let scope = self.scope_of(node);
        // The function scope may declare positional parameters (`Arg`,
        // possibly captured) and closure aliases (a `NoToken` use-closure
        // declare for a variable an inner function captures). Deferred
        // features add other declares: a named function expression adds a
        // `Define` (the `CURRENT` name binding) and an `arguments`
        // reference adds a `Var`. Guard those as named gaps.
        for d in &self.tree.scopes[scope].declares {
            let is_alias = d.token == Token::NoToken
                && d.flags & crate::scoper::dflags::USE_CLOSURE != 0;
            // `Arg`: a parameter. `Define`: a named function expression's
            // own name. `Var`: the synthetic `arguments` object.
            assert!(
                matches!(d.token, Token::Arg | Token::Define | Token::Var) || is_alias,
                "function-scope declare {:?} deferred",
                d.token
            );
        }
        // Control-flow and declaring function bodies now code correctly
        // (the ported branch-threading optimizer + the store-and-pop
        // fusion handle them), so no body-shape guard is needed.
        let is_arrow = flags & f::ARROW != 0;
        let is_strict = flags & f::STRICT != 0;
        let scope_count = *self.tree.scope_counts.get(&scope).unwrap_or(&0);
        let scope_eval = self.tree.scopes[scope].flags & crate::scoper::SCOPE_EVAL != 0;

        // A direct `eval` inside a **parameter default** poisons the
        // parameter scope (`fxScopeCodingParams` publishes the parameters into
        // a `with` environment) but not the body scope; the enclosing `with`
        // frames are unwound by `fxScopeCodedBody` (see [`Coder::code_body`],
        // keyed on the function node's eval flag).

        // Save the coder's per-function state.
        let saved_env = self.environment_level;
        let saved_eval = self.eval_flag;
        let saved_program = self.program_flag;
        let saved_scope_level = self.scope_level;
        let saved_break = self.first_break_target;
        let saved_continue = self.first_continue_target;
        let saved_return = self.return_target;

        // An anonymous function takes the name inferred from its
        // binding/assignment target (XS sets `node->symbol` before coding);
        // always clear the pending name so it never leaks to a later value.
        let inferred = self.pending_name.take();
        let name = Self::symbol_opt(&node.children[0]).or(inferred);
        let target = self.create_target();

        if flags & f::EVAL != 0 && !is_strict {
            self.eval_flag = true;
        }
        self.program_flag = false;
        self.scope_level = 0;
        self.first_break_target = None;
        self.first_continue_target = None;

        // Function-creation op: arrows, methods, and accessors are plain
        // `FUNCTION`; everything else a `CONSTRUCTOR_FUNCTION`. The accessor
        // flag rides on the property in the Rust AST, so it arrives as a
        // staged hint from the object/class coder.
        let is_accessor = std::mem::take(&mut self.pending_accessor);
        let plain_function =
            is_accessor || flags & (f::ARROW | f::METHOD | f::GETTER | f::SETTER) != 0;
        // Create-op precedence matches XS's flag order: async (generator or
        // not) first, then generator, then the plain/constructor split.
        let create_op = if flags & f::ASYNC != 0 {
            if flags & f::GENERATOR != 0 {
                XS_CODE_ASYNC_GENERATOR_FUNCTION
            } else {
                XS_CODE_ASYNC_FUNCTION
            }
        } else if flags & f::GENERATOR != 0 {
            XS_CODE_GENERATOR_FUNCTION
        } else if plain_function {
            XS_CODE_FUNCTION
        } else {
            XS_CODE_CONSTRUCTOR_FUNCTION
        };
        self.add_symbol_opt(1, create_op, name.as_deref());
        self.add_branch(0, XS_CODE_CODE_1, target);

        // BEGIN_* with the leading parameter count. A class constructor uses
        // `BEGIN_STRICT_BASE` / `BEGIN_STRICT_DERIVED`.
        let count_params = self.count_parameters(&node.children[1]);
        // XS's begin-op order: field-initializer value, then derived/base
        // constructor, then the strict/sloppy split. A `= initializer`
        // (or arrow) parsed in a class field context carries `mxFieldFlag`,
        // so its function value opens with `BEGIN_STRICT_FIELD`.
        let begin = if flags & f::FIELD != 0 {
            XS_CODE_BEGIN_STRICT_FIELD
        } else if flags & f::BASE != 0 {
            XS_CODE_BEGIN_STRICT_BASE
        } else if flags & f::DERIVED != 0 {
            XS_CODE_BEGIN_STRICT_DERIVED
        } else if is_strict {
            XS_CODE_BEGIN_STRICT
        } else {
            XS_CODE_BEGIN_SLOPPY
        };
        self.add_index(0, begin, count_params);

        if scope_count != 0 {
            self.add_index(0, XS_CODE_RESERVE_1, scope_count);
        }
        self.scope_code_retrieve(scope);
        self.scope_coding_params(scope);
        // An async (non-generator) function suspends into its async job at
        // entry (`START_ASYNC`), before the parameter bindings.
        if flags & f::ASYNC != 0 && flags & f::GENERATOR == 0 {
            self.add_byte(0, XS_CODE_START_ASYNC);
        }
        // A base class constructor calls the class's `instanceInit` field
        // initializer on entry (`fxFunctionNodeCode`'s `mxBaseFlag` branch):
        // `this`, the captured closure, then a zero-argument run.
        if flags & f::BASE != 0 {
            if let Some(target) = self.class_instance_init {
                let aid = self.tree.scopes[scope]
                    .declares
                    .iter()
                    .find(|d| {
                        d.flags & crate::scoper::dflags::USE_CLOSURE != 0
                            && d.alias == Some(target)
                    })
                    .map(|d| d.id)
                    .expect("base constructor instanceInit capture alias");
                let idx = self.declare_index(scope, aid);
                self.add_byte(1, XS_CODE_THIS);
                self.add_index(1, XS_CODE_GET_CLOSURE_1, idx);
                self.add_byte(1, XS_CODE_CALL);
                self.add_integer(-2, XS_CODE_RUN_1, 0);
                self.add_byte(-1, XS_CODE_POP);
            }
        }
        self.code_arguments_object(scope, node, is_strict);
        self.code(&node.children[1]); // ParamsBinding
        self.code_function_name(scope);

        self.return_target = Some(self.create_target());
        // A generator body opens by suspending at its start
        // (`START_GENERATOR`, or `START_ASYNC_GENERATOR` for an async
        // generator).
        if flags & f::GENERATOR != 0 {
            let op = if flags & f::ASYNC != 0 {
                XS_CODE_START_ASYNC_GENERATOR
            } else {
                XS_CODE_START_GENERATOR
            };
            self.add_byte(0, op);
        }
        self.code(&node.children[2]); // Body
        let rt = self.return_target.expect("function return target");
        self.place_target(0, rt);
        let end = if is_arrow {
            XS_CODE_END_ARROW
        } else if flags & f::BASE != 0 {
            XS_CODE_END_BASE
        } else if flags & f::DERIVED != 0 {
            XS_CODE_END_DERIVED
        } else {
            XS_CODE_END
        };
        self.add_byte(0, end);
        self.place_target(0, target);

        // Environment storing for captured closures / eval.
        if scope_eval || self.eval_flag {
            self.add_byte(1, XS_CODE_FUNCTION_ENVIRONMENT);
            self.scope_code_store(scope);
            self.add_byte(-1, XS_CODE_POP);
        } else if self.tree.scopes[scope].closure_count != 0
            || (is_arrow && self.tree.scopes[scope].arrow_default)
        {
            self.add_byte(1, XS_CODE_ENVIRONMENT);
            self.scope_code_store(scope);
            self.add_byte(-1, XS_CODE_POP);
        }

        // A plain (non-arrow/base/derived/generator/strict/method) function
        // gets a non-enumerable `caller` own property.
        if flags & (f::ARROW | f::BASE | f::DERIVED | f::GENERATOR | f::STRICT | f::METHOD) == 0 {
            self.add_byte(1, XS_CODE_DUB);
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_symbol(-2, XS_CODE_NEW_PROPERTY, "caller");
            self.add_integer(0, XS_CODE_INTEGER_1, XS_DONT_ENUM_FLAG);
        }

        // Restore the coder's per-function state.
        self.return_target = saved_return;
        self.first_continue_target = saved_continue;
        self.first_break_target = saved_break;
        self.scope_level = saved_scope_level;
        self.program_flag = saved_program;
        self.eval_flag = saved_eval;
        self.environment_level = saved_env;
    }

    /// `fxScopeCodeRetrieve` — retrieve captured closures into frame slots.
    /// This slice has no captured closures and no arrow-default, so it is a
    /// no-op; the closure and arrow-default paths assert.
    fn scope_code_retrieve(&mut self, scope: usize) {
        // Give each captured variable (a use-closure alias with a name) a
        // fresh frame slot and count them; `RETRIEVE_1` pulls that many
        // closures from the function's environment into the frame.
        let mut count = 0;
        for (id, _, sym, flags) in self.declares_of(scope) {
            if flags & crate::scoper::dflags::USE_CLOSURE != 0 && sym.is_some() {
                self.set_declare_index(scope, id);
                count += 1;
            }
        }
        // An arrow that transitively uses `this`/`super`/`target` (the
        // `mxDefaultFlag` half) OR whose own scope is direct-`eval`-poisoned
        // (the `mxEvalFlag` half) retrieves the captured receiver and target —
        // and always emits the `RETRIEVE_1`, even for a zero closure count.
        // XS: `(node->flags & mxArrowFlag) && ((node->flags & mxDefaultFlag) ||
        // (self->flags & mxEvalFlag))`.
        if self.arrow_receiver_capture(scope) {
            self.add_index(0, XS_CODE_RETRIEVE_1, count);
            self.add_byte(0, XS_CODE_RETRIEVE_TARGET);
            self.add_byte(0, XS_CODE_RETRIEVE_THIS);
        } else if count != 0 {
            self.add_index(0, XS_CODE_RETRIEVE_1, count);
        }
    }

    /// The XS receiver-capture condition shared by `fxScopeCodeRetrieve`
    /// (`RETRIEVE_TARGET`/`RETRIEVE_THIS`) and `fxScopeCodeStore`
    /// (`STORE_ARROW`): the scope's node is an arrow AND it either transitively
    /// uses `this`/`super`/`target` (`mxDefaultFlag`, tracked as
    /// `arrow_default`) or its own scope is `eval`-poisoned (`mxEvalFlag`). The
    /// eval half is why a bare `arrow_default` check is insufficient: a
    /// `() => { let x; eval(...); }` arrow captures no receiver by use, yet a
    /// direct eval in a body with a distinct lexical environment still forces
    /// the receiver into the arrow's environment.
    fn arrow_receiver_capture(&self, scope: usize) -> bool {
        let sc = &self.tree.scopes[scope];
        sc.is_arrow && (sc.arrow_default || sc.flags & crate::scoper::SCOPE_EVAL != 0)
    }

    /// `fxScopeCodeStore` — store captured closures back. Runs in the
    /// enclosing scope's frame, where every target slot is already assigned.
    fn scope_code_store(&mut self, scope: usize) {
        // For each captured variable, `STORE_1` the *defining* scope's slot
        // (the alias's target) into the freshly created function's
        // environment. XS also marks each stored target with `mxEvalFlag`
        // (`node->declaration->flags |= flags`) so the follow-on
        // `fxScopeCodeStoreAll` walk skips it; we track the same set here.
        let aliases: Vec<(usize, u32)> = self.tree.scopes[scope]
            .declares
            .iter()
            .filter(|d| d.flags & crate::scoper::dflags::USE_CLOSURE != 0)
            .map(|d| d.alias.expect("use-closure declare has an alias target"))
            .collect();
        let mut stored: std::collections::HashSet<(usize, u32)> = std::collections::HashSet::new();
        for (ascope, aid) in aliases {
            let index = self.declare_index(ascope, aid);
            self.add_index(0, XS_CODE_STORE_1, index);
            stored.insert((ascope, aid));
        }
        // Store the captured receiver/target into a `this`/`super`/`target`
        // (or `eval`-poisoned) arrow's environment — same condition as the
        // `RETRIEVE_TARGET`/`RETRIEVE_THIS` retrieve above.
        if self.arrow_receiver_capture(scope) {
            self.add_byte(0, XS_CODE_STORE_ARROW);
        }
        // An **eval** function captures its entire enclosing lexical frame:
        // `fxScopeCodeStoreAll` walks the enclosing scopes up to (and
        // including) the nearest function/module, storing every already-slotted
        // declaration that was not already stored as a use-closure alias, so a
        // name the direct `eval` reads at runtime resolves to the live slot.
        if self.tree.scopes[scope].flags & crate::scoper::SCOPE_EVAL != 0 {
            if let Some(parent) = self.tree.scopes[scope].parent {
                self.scope_code_store_all(parent, &mut stored);
            }
        }
    }

    /// `fxScopeCodeStoreAll` — the enclosing-frame capture an eval function
    /// performs. Walk outward from `scope`; in each scope store every declare
    /// that (a) is not itself a use-closure alias, (b) has an assigned frame
    /// slot (`node->declaration` in XS), and (c) was not already stored as a
    /// use-closure target of this function (the `stored` set stands in for
    /// XS's transient `mxEvalFlag` mark, cleared on the walk). Break at a
    /// `with` scope (its object shadows the frame) and stop after the first
    /// function/module scope.
    fn scope_code_store_all(
        &mut self,
        scope: usize,
        stored: &mut std::collections::HashSet<(usize, u32)>,
    ) {
        let mut cursor = Some(scope);
        while let Some(si) = cursor {
            if self.tree.scopes[si].token == Token::With {
                break;
            }
            let declares: Vec<(u32, u32, bool)> = self.tree.scopes[si]
                .declares
                .iter()
                .map(|d| (d.id, d.flags, d.bound))
                .collect();
            for (id, flags, bound) in declares {
                if stored.remove(&(si, id)) {
                    // Already stored as a use-closure alias target — XS clears
                    // the transient eval mark and moves on.
                    continue;
                }
                if flags & crate::scoper::dflags::USE_CLOSURE != 0 {
                    continue;
                }
                // `node->declaration` must be non-null: a synthesized slot (the
                // injected `arguments` `Var`, a class's anonymous field-init
                // closures) or a `var`/`Define` that resolved to nothing in a
                // sloppy `Eval`/`Program` scope was never bound, so it has no
                // frame slot for an `eval` to reach.
                if !bound {
                    continue;
                }
                if let Some(index) = self.declare_index_opt(si, id) {
                    self.add_index(0, XS_CODE_STORE_1, index);
                }
            }
            let token = self.tree.scopes[si].token;
            if matches!(token, Token::Function | Token::Module) {
                break;
            }
            cursor = self.tree.scopes[si].parent;
        }
    }

    /// `fxScopeCodingParams` — give each positional parameter (`Arg`) its
    /// frame slot with a `NEW_LOCAL`. Captured parameters (`NEW_CLOSURE`),
    /// `arguments` (`Var`), and — for a function that contains a direct
    /// `eval` (an `SCOPE_EVAL` parameter scope) — the `with`/`STORE`
    /// parameter-publish dance that hands the parameters to the eval
    /// environment. Sloppy eval opens a `null` `with` first (so unresolved
    /// eval-created names fall through to the enclosing frame), then a
    /// second `undefined` `with` into which each parameter's slot is
    /// `STORE`d; strict eval skips the leading `null` `with` (no name
    /// creation) but still publishes the parameters.
    fn scope_coding_params(&mut self, scope: usize) {
        use crate::scoper::dflags;
        for (id, token, sym, flags) in self.declares_of(scope) {
            // Closure aliases are handled by `fxScopeCodeRetrieve`, not here.
            if token == Token::NoToken {
                continue;
            }
            // A named function expression's own name is a `Define` bound to
            // `CURRENT`; give it a slot here, initialized in the define pass.
            // When a nested function captures the name (`function f(){ g =
            // ()=>f; }`), `fxScopeCodingBlock` promotes the `Define` to a
            // closure slot (`NEW_CLOSURE`); a use-closure `Define` (its own
            // alias) gets no slot here — `fxScopeCodeRetrieve` handles it.
            if token == Token::Define {
                if flags & dflags::CLOSURE != 0 {
                    if flags & dflags::USE_CLOSURE == 0 {
                        let index = self.set_declare_index(scope, id);
                        self.add_variable(0, XS_CODE_NEW_CLOSURE, Self::sym_name(&sym), index);
                    }
                } else {
                    let index = self.set_declare_index(scope, id);
                    self.add_variable(0, XS_CODE_NEW_LOCAL, Self::sym_name(&sym), index);
                }
                continue;
            }
            // `fxScopeCodingParams` slots `Arg`/`Var`/`Const` declares —
            // the parameters plus the synthetic `arguments` `Var`.
            assert!(
                matches!(token, Token::Arg | Token::Var | Token::Const),
                "non-parameter declare {token:?} deferred (params slice)"
            );
            let index = self.set_declare_index(scope, id);
            if flags & dflags::CLOSURE != 0 {
                // A captured parameter lives in a closure slot.
                assert!(
                    flags & dflags::USE_CLOSURE == 0,
                    "argument that use-closures itself deferred"
                );
                self.add_variable(0, XS_CODE_NEW_CLOSURE, Self::sym_name(&sym), index);
            } else {
                self.add_variable(0, XS_CODE_NEW_LOCAL, Self::sym_name(&sym), index);
            }
        }
        // The eval parameter-publish dance (`fxScopeCodingParams`' eval
        // branch): only when this parameter scope is reached by a direct
        // `eval`.
        if self.tree.scopes[scope].flags & crate::scoper::SCOPE_EVAL != 0 {
            let strict = self.tree.scopes[scope].flags & crate::ast::flags::STRICT != 0;
            if !strict {
                self.add_byte(1, XS_CODE_NULL);
                self.add_byte(0, XS_CODE_WITH);
                self.add_byte(-1, XS_CODE_POP);
                self.environment_level += 1;
            }
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(0, XS_CODE_WITH);
            for (id, token, _, _) in self.declares_of(scope) {
                // XS publishes every `ARG`/`VAR`/`CONST` declare into the eval
                // `with` environment. A named function expression's own name is
                // one of those: XS declares it `fxDefineNodeNew(…,
                // XS_TOKEN_CONST)` — a define entry whose declare token is
                // `CONST`, so the publish loop stores it. ironhorse models the
                // self-name as the sole `Define` in a function param scope
                // (body function declarations live in the body/block scope),
                // so it publishes on the same footing — otherwise a direct eval
                // in a named function expression (`(function fun(){ eval(…) })`)
                // would not see `fun`, emitting one fewer `STORE_1`.
                if matches!(token, Token::Arg | Token::Var | Token::Const | Token::Define) {
                    let index = self.declare_index(scope, id);
                    self.add_index(0, XS_CODE_STORE_1, index);
                }
            }
            self.add_byte(-1, XS_CODE_POP);
            self.environment_level += 1;
        }
    }

    /// `fxParamsBindingNodeCode` — bind each positional parameter: pull
    /// `ARGUMENT i` and store it into the parameter's slot. Defaults
    /// (a `Binding` item), destructuring (`ArrayBinding`/`ObjectBinding`),
    /// rest (`RestBinding`), and the `arguments` object are deferred.
    /// `fxArrayBindingNodeCodeAssign` — array destructuring. Seeds an
    /// iterator over the value (`FOR_OF`), pulls each element from
    /// `next()` into its target (skipping holes, collecting a `...rest`
    /// into an array), and closes the iterator (`.return()`) on early exit,
    /// inside the selector/alias/finalize/jump `try`/`finally` machinery
    /// (only the return target crosses it — array patterns are not loops).
    fn code_array_binding_assign(&mut self, node: &Node, _flag: i32) {
        let items: &[Item] = match node.children.first() {
            Some(Item::List(v)) => v,
            _ => &[],
        };
        let iterator = self.use_temporary();
        let next = self.use_temporary();
        let done = self.use_temporary();
        let selector = self.use_temporary();
        let rest = self.use_temporary();
        let result = self.use_temporary();

        self.return_target = self.alias_targets(self.return_target);
        let catch_target = self.create_target();
        let normal_target = self.create_target();
        let finally_target = self.create_target();

        self.add_byte(1, XS_CODE_DUB);
        self.add_byte(0, XS_CODE_FOR_OF);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, iterator);
        self.add_byte(1, XS_CODE_FALSE);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, done);
        self.add_integer(1, XS_CODE_INTEGER_1, 0);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, selector);
        self.add_branch(0, XS_CODE_CATCH_1, catch_target);

        let n = items.len();
        // The index of a trailing rest binding, if any.
        let rest_at = items
            .iter()
            .position(|it| matches!(it, Item::Node(x) if x.token == Token::RestBinding));
        if n > 0 {
            self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
            self.add_symbol(0, XS_CODE_GET_PROPERTY, "next");
            self.add_index(0, XS_CODE_PULL_LOCAL_1, next);

            let regular_end = rest_at.unwrap_or(n);
            for item in &items[..regular_end] {
                let step_target = self.create_target();
                let el = node_of(item);
                if el.token == Token::SkipBinding {
                    self.add_index(1, XS_CODE_GET_LOCAL_1, done);
                    self.add_branch(-1, XS_CODE_BRANCH_IF_1, step_target);
                    self.add_byte(1, XS_CODE_TRUE);
                    self.add_index(-1, XS_CODE_PULL_LOCAL_1, done);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, next);
                    self.add_byte(1, XS_CODE_CALL);
                    self.add_integer(-2, XS_CODE_RUN_1, 0);
                    self.add_byte(0, XS_CODE_CHECK_INSTANCE);
                    self.add_symbol(0, XS_CODE_GET_PROPERTY, "done");
                    self.add_index(0, XS_CODE_PULL_LOCAL_1, done);
                    self.place_target(1, step_target);
                } else {
                    let done_target = self.create_target();
                    let next_target = self.create_target();
                    self.code_reference(item, 1);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, done);
                    self.add_branch(-1, XS_CODE_BRANCH_IF_1, step_target);
                    self.add_byte(1, XS_CODE_TRUE);
                    self.add_index(-1, XS_CODE_PULL_LOCAL_1, done);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, next);
                    self.add_byte(1, XS_CODE_CALL);
                    self.add_integer(-2, XS_CODE_RUN_1, 0);
                    self.add_byte(0, XS_CODE_CHECK_INSTANCE);
                    self.add_byte(1, XS_CODE_DUB);
                    self.add_symbol(0, XS_CODE_GET_PROPERTY, "done");
                    self.add_index(0, XS_CODE_SET_LOCAL_1, done);
                    self.add_branch(-1, XS_CODE_BRANCH_IF_1, done_target);
                    self.add_symbol(0, XS_CODE_GET_PROPERTY, "value");
                    self.add_branch(0, XS_CODE_BRANCH_1, next_target);
                    self.place_target(1, done_target);
                    self.add_byte(-1, XS_CODE_POP);
                    self.place_target(1, step_target);
                    self.add_byte(1, XS_CODE_UNDEFINED);
                    self.place_target(1, next_target);
                    self.code_assign(item, 1);
                    self.add_byte(-1, XS_CODE_POP);
                }
            }
            if let Some(ri) = rest_at {
                let rest_node = node_of(&items[ri]);
                let binding = &rest_node.children[0];
                let next_target = self.create_target();
                let done_target = self.create_target();

                self.code_reference(binding, 1);
                self.add_byte(1, XS_CODE_ARRAY);
                self.add_index(-1, XS_CODE_PULL_LOCAL_1, rest);

                self.add_index(1, XS_CODE_GET_LOCAL_1, done);
                self.add_branch(-1, XS_CODE_BRANCH_IF_1, done_target);

                self.place_target(0, next_target);
                self.add_byte(1, XS_CODE_TRUE);
                self.add_index(-1, XS_CODE_PULL_LOCAL_1, done);
                self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
                self.add_index(1, XS_CODE_GET_LOCAL_1, next);
                self.add_byte(1, XS_CODE_CALL);
                self.add_integer(-2, XS_CODE_RUN_1, 0);
                self.add_byte(0, XS_CODE_CHECK_INSTANCE);
                self.add_index(1, XS_CODE_SET_LOCAL_1, result);
                self.add_symbol(0, XS_CODE_GET_PROPERTY, "done");
                self.add_index(0, XS_CODE_SET_LOCAL_1, done);
                self.add_branch(-1, XS_CODE_BRANCH_IF_1, done_target);

                self.add_index(1, XS_CODE_GET_LOCAL_1, rest);
                self.add_byte(1, XS_CODE_DUB);
                self.add_symbol(0, XS_CODE_GET_PROPERTY, "length");
                self.add_byte(0, XS_CODE_AT);
                self.add_index(1, XS_CODE_GET_LOCAL_1, result);
                self.add_symbol(0, XS_CODE_GET_PROPERTY, "value");
                self.add_byte(-2, XS_CODE_SET_PROPERTY_AT);
                self.add_byte(-1, XS_CODE_POP);

                self.add_branch(0, XS_CODE_BRANCH_1, next_target);
                self.place_target(1, done_target);

                self.add_index(0, XS_CODE_GET_LOCAL_1, rest);
                self.code_assign(binding, 1);
                self.add_byte(-1, XS_CODE_POP);
            }
        }
        self.add_branch(0, XS_CODE_BRANCH_1, normal_target);

        let mut selection = 1;
        self.return_target =
            self.finalize_targets(self.return_target, selector, &mut selection, finally_target);
        self.place_target(0, normal_target);
        self.add_integer(1, XS_CODE_INTEGER_1, selection);
        self.add_index(0, XS_CODE_SET_LOCAL_1, selector);
        self.add_byte(-1, XS_CODE_POP);
        self.place_target(0, finally_target);
        self.add_byte(0, XS_CODE_UNCATCH);
        self.place_target(0, catch_target);

        let next_target = self.create_target();
        self.add_index(1, XS_CODE_GET_LOCAL_1, selector);
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, next_target);
        self.add_byte(1, XS_CODE_EXCEPTION);
        self.add_index(0, XS_CODE_SET_LOCAL_1, result);
        self.add_byte(-1, XS_CODE_POP);
        let catch_target2 = self.create_target();
        self.add_branch(0, XS_CODE_CATCH_1, catch_target2);
        self.place_target(0, next_target);

        let done_target = self.create_target();
        let return_target = self.create_target();
        self.add_index(1, XS_CODE_GET_LOCAL_1, done);
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, done_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "return");
        self.add_branch(0, XS_CODE_BRANCH_CHAIN_1, return_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_byte(0, XS_CODE_SWAP);
        self.add_byte(1, XS_CODE_CALL);
        self.add_integer(-2, XS_CODE_RUN_1, 0);
        self.add_byte(0, XS_CODE_CHECK_INSTANCE);
        self.place_target(0, return_target);
        self.add_byte(-1, XS_CODE_POP);
        self.place_target(0, done_target);

        let next_target2 = self.create_target();
        self.add_index(1, XS_CODE_GET_LOCAL_1, selector);
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, next_target2);
        self.add_byte(0, XS_CODE_UNCATCH);
        self.place_target(0, catch_target2);
        self.add_index(1, XS_CODE_GET_LOCAL_1, result);
        self.add_byte(-1, XS_CODE_THROW);
        self.place_target(0, next_target2);

        let mut selection = 1;
        let rt = self.return_target;
        self.jump_targets(rt, selector, &mut selection);

        self.unuse_temporaries(6);
    }

    /// `fxObjectBindingNodeCodeAssign` — object destructuring. The value on
    /// the stack is `TO_INSTANCE`'d into a temporary, then each
    /// `PropertyBinding` reads its named property and assigns it into the
    /// binding target. Deferred: object rest (`{...r}`), computed keys
    /// (`PropertyBindingAt`), and `= default` inside a pattern element are
    /// handled by the target's own coder, but the spread / at branches
    /// assert.
    fn code_object_binding_assign(&mut self, node: &Node, _flag: i32) {
        let items: &[Item] = match node.children.first() {
            Some(Item::List(v)) => v,
            _ => &[],
        };
        let spread = node.flags & crate::ast::flags::SPREAD != 0;
        let object = self.use_temporary();
        let at = self.use_temporary();
        let mut c = 0;
        self.add_byte(1, XS_CODE_DUB);
        self.add_byte(0, XS_CODE_TO_INSTANCE);
        self.add_index(-1, XS_CODE_PULL_LOCAL_1, object);
        if spread {
            // Build the rest object: `Object.assign`-style copy of the
            // source minus the explicitly-bound keys, which are pushed as
            // exclusion arguments.
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(1, XS_CODE_COPY_OBJECT);
            self.add_byte(1, XS_CODE_CALL);
            self.add_byte(1, XS_CODE_OBJECT);
            self.add_index(1, XS_CODE_GET_LOCAL_1, object);
            c = 2;
        }
        // The property-binding items, up to a trailing rest binding.
        let regular_end = items
            .iter()
            .position(|it| matches!(it, Item::Node(x) if x.token == Token::RestBinding))
            .unwrap_or(items.len());
        for item in &items[..regular_end] {
            let p = node_of(item);
            match p.token {
                Token::PropertyBinding => {
                    if spread {
                        self.add_index(1, XS_CODE_GET_LOCAL_1, object);
                        let key = Self::symbol_of(&p.children[0]).to_string();
                        self.add_symbol(1, XS_CODE_SYMBOL, &key);
                        self.add_byte(0, XS_CODE_AT);
                        self.add_byte(0, XS_CODE_SWAP);
                        self.add_byte(-1, XS_CODE_POP);
                        c += 1;
                    }
                    let key = Self::symbol_of(&p.children[0]).to_string();
                    let binding = &p.children[1];
                    self.code_reference(binding, 1);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, object);
                    self.add_symbol(0, XS_CODE_GET_PROPERTY, &key);
                    self.code_assign(binding, 1);
                }
                Token::PropertyBindingAt => {
                    self.add_index(1, XS_CODE_GET_LOCAL_1, object);
                    self.code(&p.children[0]);
                    self.add_byte(0, XS_CODE_AT);
                    if spread {
                        self.add_index(0, XS_CODE_SET_LOCAL_1, at);
                        self.add_byte(0, XS_CODE_SWAP);
                        self.add_byte(-1, XS_CODE_POP);
                        c += 1;
                    } else {
                        self.add_index(-1, XS_CODE_PULL_LOCAL_1, at);
                        self.add_byte(-1, XS_CODE_POP);
                    }
                    let binding = &p.children[1];
                    self.code_reference(binding, 1);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, object);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, at);
                    self.add_byte(-1, XS_CODE_GET_PROPERTY_AT);
                    self.code_assign(binding, 1);
                }
                other => panic!("coder: unsupported object-binding item {other:?}"),
            }
            self.add_byte(-1, XS_CODE_POP);
        }
        if spread {
            let rest_node = node_of(&items[regular_end]);
            let binding = &rest_node.children[0];
            self.add_integer(-2 - c, XS_CODE_RUN_1, c);
            self.add_index(-1, XS_CODE_PULL_LOCAL_1, object);
            self.code_reference(binding, 1);
            self.add_index(1, XS_CODE_GET_LOCAL_1, object);
            self.code_assign(binding, 1);
            self.add_byte(-1, XS_CODE_POP);
        }
        self.unuse_temporaries(2);
    }

    /// `fxParamsBindingNodeCode`'s `arguments`-object prelude. When a
    /// function references `arguments`, its scope carries a synthetic
    /// `arguments` `Var`; build the object (`ARGUMENTS_SLOPPY` for a mapped
    /// sloppy simple-parameter function, else `ARGUMENTS_STRICT`, operand =
    /// the parameter count) and store it into that slot. Emitted between
    /// `fxScopeCodingParams` and the parameter binding loop.
    fn code_arguments_object(&mut self, scope: usize, func: &Node, is_strict: bool) {
        // Emit the object only when the function references `arguments` —
        // i.e. `fxFunctionNodeHoist` injected the synthetic `arguments` `Var`
        // (XS's `mxArgumentsFlag`, the gate `fxParamsBindingNodeBind` uses to
        // set `self->declaration`, and `fxParamsBindingNodeCode` guards the
        // object on). A parameter merely *named* `arguments` in a function
        // that never reads it injects no `Var`, so no object is stored.
        let has_var = self.tree.scopes[scope].declares.iter().any(|d| {
            d.token == Token::Var
                && matches!(&d.symbol, Some(crate::scoper::Sym::Named(s)) if s == "arguments")
        });
        if !has_var {
            return;
        }
        // XS materializes the object only when the function node carries
        // `mxArgumentsFlag` (`fxParamsBindingNodeBind` sets `self->declaration`
        // — the object's slot — under that gate; `fxParamsBindingNodeCode`
        // emits `ARGUMENTS_*` only when it is set). The synthetic `arguments`
        // `Var` also exists for an `mxEvalFlag`-only function (`xsScope.c:730`),
        // but that one is a *materialization-free* capture closure the eval
        // `with`-publish stores into — it must NOT build the object. The flag
        // is set two ways: `arguments` was referenced (parse ⇒ `flags::ARGUMENTS`
        // on the node) or the function *directly* contains a direct `eval`
        // (hoist ⇒ the scope's `direct_eval`). An enclosing function that only
        // *encloses* an arrow's direct eval gets `mxEvalFlag` but neither, so
        // its injected `Var` stays materialization-free.
        let has_arguments_flag = func.flags & crate::ast::flags::ARGUMENTS != 0
            || self.tree.scopes[scope].direct_eval;
        if !has_arguments_flag {
            return;
        }
        // The `arguments` slot the object stores into: XS's
        // `fxParamsBindingNodeCode` writes to `self->declaration`, which
        // `fxParamsBindingNodeBind` set to `fxScopeGetDeclareNode(functionScope,
        // arguments)` — the **first** `arguments`-named declare in the scope.
        // Normally that is the synthetic `arguments` `Var`; but a parameter
        // literally named `arguments` is hoisted *before* the injected `Var`
        // (`fxFunctionNodeHoist`), so it comes first and, in the mapped case,
        // carries the closure slot the object aliases (`var_closure`, not the
        // `Var`'s `var_local`). Match first-in-list, any token.
        let args = self.tree.scopes[scope]
            .declares
            .iter()
            .find(|d| {
                matches!(&d.symbol, Some(crate::scoper::Sym::Named(s)) if s == "arguments")
            })
            .map(|d| (d.id, d.flags));
        let Some((id, flags)) = args else { return };
        let index = self.declare_index(scope, id);
        let count = self.count_binding_items(&func.children[1]);
        // Mapped only when sloppy with a simple parameter list (the scoper
        // then closure-marks the parameters so the object can alias them).
        let mapped =
            !is_strict && func.flags & crate::ast::flags::NOT_SIMPLE_PARAMETERS == 0;
        let op = if mapped { XS_CODE_ARGUMENTS_SLOPPY } else { XS_CODE_ARGUMENTS_STRICT };
        self.add_index(1, op, count);
        let store = if flags & crate::scoper::dflags::CLOSURE != 0 {
            XS_CODE_VAR_CLOSURE_1
        } else {
            XS_CODE_VAR_LOCAL_1
        };
        self.add_index(0, store, index);
        self.add_byte(-1, XS_CODE_POP);
    }

    /// The `items->length` of a `ParamsBinding` (its parameter count),
    /// which the `ARGUMENTS_*` opcode carries.
    fn count_binding_items(&self, params: &Item) -> i32 {
        match params {
            Item::Node(p) => match p.children.first() {
                Some(Item::List(items)) => items.len() as i32,
                _ => 0,
            },
            _ => 0,
        }
    }

    fn code_params_binding(&mut self, node: &Node) {
        let Some(Item::List(items)) = node.children.first() else { return };
        for (index, item) in items.iter().enumerate() {
            let Item::Node(arg) = item else {
                panic!("coder: unexpected parameter slot {item:?}");
            };
            // A plain `Arg` (`[symbol]`), an `= default` param (a `Binding`
            // wrapping an `Arg`), or a `...rest` param (`RestBinding`
            // wrapping its target, bound from `ARGUMENTS i`). Destructuring
            // (`ArrayBinding`/`ObjectBinding`) targets are deferred.
            if arg.token == Token::RestBinding {
                let target = &arg.children[0];
                self.code_reference(target, 0);
                self.add_index(1, XS_CODE_ARGUMENTS, index as i32);
                self.code_assign(target, 0);
                self.add_byte(-1, XS_CODE_POP);
            } else {
                // A plain `Arg`, an `= default` (`Binding`), or a
                // destructuring parameter (`ArrayBinding`/`ObjectBinding`) —
                // each pulls `ARGUMENT i` and binds it through the target's
                // own reference/assign coder.
                assert!(
                    matches!(
                        arg.token,
                        Token::Arg | Token::Binding | Token::ArrayBinding | Token::ObjectBinding
                    ),
                    "parameter pattern {:?} deferred (params slice)",
                    arg.token
                );
                self.code_reference(item, 0);
                self.add_index(1, XS_CODE_ARGUMENT, index as i32);
                self.code_assign(item, 0);
                self.add_byte(-1, XS_CODE_POP);
            }
        }
    }

    /// `fxBodyNodeCode` — a function body block. The strict / non-eval body
    /// scope-codes the block like any block (`fxScopeCodingBody`'s `else`
    /// arm is `fxScopeCodingBlock`, whose eval `with`-publish already ports);
    /// a **sloppy direct-`eval` body** takes the two-`with` dance
    /// (`fxScopeCodingBody`): the `var`/function declarations publish into a
    /// `null` `with`, then the lexical declarations into an `undefined` one,
    /// so an eval-created name resolves to the right frame. Child
    /// `[statement]`.
    fn code_body(&mut self, node: &Node) {
        let scope = self.scope_of(node);
        // `fxScopeCodingBody`/`fxScopeCodedBody` key on the body *node*'s
        // `mxEvalFlag`, which the parser/hoister sets only for a **direct
        // `eval`** in this function — not on a `with`-poisoned scope (which
        // sets the *scope* flag but leaves the node clean). Keying on the
        // node flag keeps a `with`-only body on the ordinary block path,
        // where the parameter-scope `with` dance already suffices.
        let body_eval = self.tree.scopes[scope].direct_eval;
        let strict = self.tree.scopes[scope].flags & crate::ast::flags::STRICT != 0;
        // `fxScopeCodingBody` keys the body's own two-`with` publish on the
        // BODY node's direct eval.
        if body_eval && !strict {
            self.scope_coding_body_eval(scope);
        } else {
            self.scope_coding_block(scope);
        }
        self.code_define_nodes(&node.children[0]);
        if self.tree.scopes[scope].disposable_count > 0 {
            let context = self.scope_code_using(scope);
            self.code(&node.children[0]);
            self.scope_code_used(scope, context);
        } else {
            self.code(&node.children[0]);
        }
        // `fxScopeCodedBody` keys the two-`WITHOUT` teardown on the enclosing
        // FUNCTION node's eval flag, not the body's — so the `with` frames
        // `fxScopeCodingParams`' eval branch pushed unwind even though the body
        // itself is not eval-scoped. The function-node eval flag (not the
        // scope's `direct_eval`) is the faithful key: it is set for a direct
        // `eval` in the function AND — via `fxArrowExpression`'s bubble — for a
        // function that merely encloses an arrow whose body holds the eval, the
        // enclosing-function synthetic capture-closure case.
        let function_eval = self.tree.scopes[scope]
            .parent
            .map(|p| self.tree.scopes[p].node_has_eval() || self.tree.scopes[p].direct_eval)
            .unwrap_or(false);
        if function_eval && !strict {
            self.scope_coded_body_eval(scope);
        } else {
            self.scope_coded(scope);
        }
    }

    /// `fxScopeCodingBody` — the sloppy direct-`eval` function-body prelude.
    /// Every declaration in an eval scope is closure-marked (so eval can
    /// reach it), so the `var`/function declarations get a `NEW_CLOSURE`
    /// slot and initialize (`null` for a hoisted function `Define`,
    /// `undefined` for a `var`), then publish into a `null` `with`
    /// environment; the lexical (`let`/`const`) declarations then get their
    /// own `NEW_CLOSURE`/`NEW_TEMPORARY` slots and publish into an
    /// `undefined` `with`. Two `with` frames are pushed (`environment_level`
    /// += 2), unwound by [`Coder::scope_coded_body_eval`].
    fn scope_coding_body_eval(&mut self, scope: usize) {
        // Pass 1: `var` / function-declaration (`Define`) slots.
        for (id, token, sym, _) in self.declares_of(scope) {
            match token {
                Token::Define => {
                    let index = self.set_declare_index(scope, id);
                    self.add_variable(0, XS_CODE_NEW_CLOSURE, Self::sym_name(&sym), index);
                    self.add_byte(1, XS_CODE_NULL);
                    self.add_index(0, XS_CODE_VAR_CLOSURE_1, index);
                    self.add_byte(-1, XS_CODE_POP);
                }
                Token::Var => {
                    let index = self.set_declare_index(scope, id);
                    self.add_variable(0, XS_CODE_NEW_CLOSURE, Self::sym_name(&sym), index);
                    self.add_byte(1, XS_CODE_UNDEFINED);
                    self.add_index(0, XS_CODE_VAR_CLOSURE_1, index);
                    self.add_byte(-1, XS_CODE_POP);
                }
                _ => {}
            }
        }
        // The `var`/function publish into a `null` `with`.
        self.add_byte(1, XS_CODE_NULL);
        self.add_byte(0, XS_CODE_WITH);
        for (id, token, _, _) in self.declares_of(scope) {
            if matches!(token, Token::Define | Token::Var) {
                let index = self.declare_index(scope, id);
                self.add_index(0, XS_CODE_STORE_1, index);
            }
        }
        self.add_byte(-1, XS_CODE_POP);
        self.environment_level += 1;
        // Pass 2: lexical (`let`/`const`) slots.
        for (id, token, sym, _) in self.declares_of(scope) {
            if matches!(token, Token::Define | Token::Var) {
                continue;
            }
            let index = self.set_declare_index(scope, id);
            match Self::sym_name(&sym) {
                Some(name) => self.add_variable(0, XS_CODE_NEW_CLOSURE, Some(name), index),
                None => self.add_index(0, XS_CODE_NEW_TEMPORARY, index),
            }
        }
        // The lexical publish into an `undefined` `with`.
        self.add_byte(1, XS_CODE_UNDEFINED);
        self.add_byte(0, XS_CODE_WITH);
        for (id, token, sym, _) in self.declares_of(scope) {
            if matches!(token, Token::Define | Token::Var) {
                continue;
            }
            if Self::sym_name(&sym).is_some() {
                let index = self.declare_index(scope, id);
                self.add_index(0, XS_CODE_STORE_1, index);
            }
        }
        self.add_byte(-1, XS_CODE_POP);
        self.environment_level += 1;
    }

    /// `fxScopeCodedBody` — teardown for the sloppy direct-`eval` body:
    /// unwind the two `with` frames that [`Coder::scope_coding_body_eval`]
    /// pushed, then the declared slots.
    fn scope_coded_body_eval(&mut self, scope: usize) {
        let count = self.declare_count(scope);
        self.environment_level -= 1;
        self.add_byte(0, XS_CODE_WITHOUT);
        self.environment_level -= 1;
        self.add_byte(0, XS_CODE_WITHOUT);
        if count != 0 {
            self.add_index(0, XS_CODE_UNWIND_1, count);
            self.scope_level -= count;
        }
    }

    /// `fxReturnNodeCode` — `return [expr];` inside a function. Code the
    /// value (or `undefined`), set the result, unwind to the return
    /// target, and branch to it (the branch is elided when the target is
    /// the next instruction).
    fn code_return(&mut self, node: &Node) {
        assert!(!self.program_flag, "return at program scope is a syntax error");
        let rt = self.return_target.expect("return target");
        // XS `fxReturnNodeCode`: mark the return expression for tail-call
        // emission when the return is strict, non-generator, and its target
        // is a direct branch (not a `try`/`finally` alias that reroutes the
        // return through a finalizer). `code_node` consumes the flag on the
        // immediate expression; the short-circuit / `?:` / comma operators
        // thread it to their tail-position operand.
        use crate::ast::flags as f;
        let tail = node.flags & f::STRICT != 0
            && node.flags & f::GENERATOR == 0
            && self.targets[rt].original.is_none();
        // An async-generator (`async function*`) awaits and status-checks the
        // returned value: XS emits `AWAIT; THROW_STATUS` before `SET_RESULT`,
        // and a bare `return;` emits nothing (the resume machine supplies the
        // result) rather than the usual `UNDEFINED; SET_RESULT`.
        let is_async_gen = node.flags & f::ASYNC != 0 && node.flags & f::GENERATOR != 0;
        match node.children.first() {
            Some(item) if !matches!(item, Item::Null) => {
                self.tail = tail;
                self.code(item);
                if is_async_gen {
                    self.add_byte(0, XS_CODE_AWAIT);
                    self.add_byte(0, XS_CODE_THROW_STATUS);
                }
                self.add_byte(-1, XS_CODE_SET_RESULT);
            }
            _ if !is_async_gen => {
                self.add_byte(1, XS_CODE_UNDEFINED);
                self.add_byte(-1, XS_CODE_SET_RESULT);
            }
            _ => {}
        }
        self.adjust_environment(rt);
        self.adjust_scope(rt);
        self.add_branch(0, XS_CODE_BRANCH_1, rt);
    }

    /// `fxMemberNodeCode`. Children `[reference, symbol]` → the reference
    /// then a `GET_PROPERTY` (or `GET_SUPER` for a `super.x` reference;
    /// `super` is deferred with classes).
    /// `fxChainNodeCode` — the wrapper of an optional chain (`a?.b?.c`).
    /// Child `[expression]`. Install a fresh short-circuit target, code the
    /// chain expression (its `Option` links branch here when a base is
    /// nullish), then place the target so a taken branch lands with the
    /// nullish base as the chain's `undefined`/`null` value. The saved outer
    /// chain target is restored (chains can nest through call arguments).
    fn code_chain(&mut self, node: &Node) {
        let saved = self.chain_target;
        let target = self.create_target();
        self.chain_target = Some(target);
        self.code(&node.children[0]);
        self.place_target(0, target);
        self.chain_target = saved;
    }

    /// `fxOptionNodeCode` — one `?.` link. Child `[base]`. Code the base,
    /// then `BRANCH_CHAIN` to the enclosing chain's short-circuit target: the
    /// branch is taken (leaving the nullish base as the result) exactly when
    /// the base is `null`/`undefined`, otherwise the access continues.
    fn code_option(&mut self, node: &Node, tail: bool) {
        self.tail = tail;
        self.code(&node.children[0]);
        let target = self.chain_target.expect("optional `?.` outside a chain");
        self.add_branch(0, XS_CODE_BRANCH_CHAIN_1, target);
    }

    /// `fxChainNodeCodeThis` — the call-reference variant of
    /// [`Coder::code_chain`]: install a fresh short-circuit target, code the
    /// chain's `this`/value pair, place the target, restore the outer target.
    fn code_chain_this(&mut self, node: &Node, flag: i32) -> i32 {
        let saved = self.chain_target;
        let target = self.create_target();
        self.chain_target = Some(target);
        let flag = self.code_this(&node.children[0], flag);
        self.place_target(0, target);
        self.chain_target = saved;
        flag
    }

    /// `fxOptionNodeCodeThis` — one `?.` link whose value is a call callee.
    /// Unlike the plain [`Coder::code_option`], the callee left a
    /// receiver/value pair on the stack, so a nullish base must drop the
    /// receiver (`SWAP`/`POP`) before short-circuiting the whole chain to
    /// `undefined`; a present base skips that dance and continues the call.
    fn code_option_this(&mut self, node: &Node, flag: i32) -> i32 {
        let swap_target = self.create_target();
        let skip_target = self.create_target();
        let flag = self.code_this(&node.children[0], flag);
        let chain_target = self.chain_target.expect("optional `?.` outside a chain");
        self.add_branch(0, XS_CODE_BRANCH_CHAIN_1, swap_target);
        self.add_branch(1, XS_CODE_BRANCH_1, skip_target);
        self.place_target(0, swap_target);
        self.add_byte(0, XS_CODE_SWAP);
        self.add_byte(-1, XS_CODE_POP);
        self.add_branch(0, XS_CODE_BRANCH_1, chain_target);
        self.place_target(0, skip_target);
        flag
    }

    fn code_member(&mut self, node: &Node) {
        self.code(&node.children[0]);
        let is_super = self.node_is_super(&node.children[0]);
        let name = Self::symbol_of(&node.children[1]).to_string();
        let op = if is_super { XS_CODE_GET_SUPER } else { XS_CODE_GET_PROPERTY };
        self.add_symbol(0, op, &name);
    }

    /// The resolved private-declaration frame index for a `PrivateMember` /
    /// `PrivateIdentifier` node (XS's `self->declaration->index`): the
    /// scoper resolved the `#name` through the class-scope `symbolAccess`
    /// closure (or its use-closure alias in the accessing function).
    fn private_index(&self, node: &Node) -> i32 {
        let (scope, id) = self.resolution_of(node).expect("private member resolution");
        self.declare_index(scope, id)
    }

    /// `fxPrivateMemberNodeCode` — `obj.#x` read: code the reference, then
    /// `GET_PRIVATE` by the resolved brand index. Children `[symbol,
    /// reference]`.
    fn code_private_member(&mut self, node: &Node) {
        self.code(&node.children[1]);
        let index = self.private_index(node);
        self.add_index(0, XS_CODE_GET_PRIVATE_1, index);
    }

    /// `fxPrivateIdentifierNodeCode` — the `#x in obj` brand check: code the
    /// reference, then `HAS_PRIVATE` by the resolved brand index.
    fn code_private_identifier(&mut self, node: &Node) {
        self.code(&node.children[1]);
        let index = self.private_index(node);
        self.add_index(0, XS_CODE_HAS_PRIVATE_1, index);
    }

    /// Whether a reference child carries `mxSuperFlag` (a `super.x` base).
    fn node_is_super(&self, item: &Item) -> bool {
        matches!(item, Item::Node(n) if n.flags & crate::ast::flags::SUPER != 0)
    }

    /// `fxMemberAtNodeCode` — computed access `ref[at]`. Children
    /// `[reference, at]`. Symbol-free (`AT` + `GET_PROPERTY_AT`); the
    /// subexpressions carry any symbols.
    fn code_member_at(&mut self, node: &Node) {
        let is_super = self.node_is_super(&node.children[0]);
        self.code(&node.children[0]);
        self.code(&node.children[1]);
        self.add_byte(0, if is_super { XS_CODE_SUPER_AT } else { XS_CODE_AT });
        self.add_byte(-1, if is_super { XS_CODE_GET_SUPER_AT } else { XS_CODE_GET_PROPERTY_AT });
    }

    /// `fxCallNodeCode`. Children `[reference, params]`: set up the callee
    /// and its `this`, `CALL`, then the argument list + `RUN`.
    fn code_call(&mut self, node: &Node, tail: bool) {
        // A syntactic `eval(...)` call (the callee is the identifier
        // `eval` — XS keys on the name, not resolution) closes with the
        // `EVAL` intrinsic instead of `RUN`; the scoper has already
        // poisoned the surrounding scopes.
        let is_eval = Self::is_direct_eval(&node.children[0]);
        self.code_this(&node.children[0], 0);
        self.add_byte(1, XS_CODE_CALL);
        // XS: `fxCallNodeCode` relays the tail-recursion flag to the params
        // node, whose `RUN` / `EVAL` becomes the `RUN_TAIL` / `EVAL_TAIL`
        // variant. The callee reference is coded above, out of tail position.
        self.code_params(node_of(&node.children[1]), is_eval, tail);
    }

    /// Whether a call's reference is the `eval` identifier
    /// (`fxCallNodeHoist`'s syntactic test).
    fn is_direct_eval(item: &Item) -> bool {
        matches!(item, Item::Node(n) if n.token == Token::Access
            && matches!(n.children.first(), Some(Item::Symbol(s)) if s == "eval"))
    }

    /// `fxObjectNodeCode`, the data-property surface. Children
    /// `[List(items)]` where each item is a `Property` (`k: v`, key an
    /// interned symbol) or `PropertyAt` (`[e]: v`). The object lives in a
    /// temporary; each property is `NEW_PROPERTY`/`NEW_PROPERTY_AT`'d onto
    /// it with a `0` attribute flag (data value).
    ///
    /// Folds: `...spread`, `__proto__:` (the `INSTANTIATE` prelude),
    /// shorthand, and method / getter / setter shorthand all reach the
    /// function/spread surface and are deferred; they assert here.
    /// Whether a member is a written `__proto__:` property (the prototype
    /// setter): a non-shorthand `Property` whose key is `__proto__`.
    fn is_proto_property(p: &Node) -> bool {
        p.token == Token::Property
            && p.flags & crate::ast::flags::SHORTHAND == 0
            && matches!(&p.children[0], Item::Symbol(s) if s == "__proto__")
    }

    /// The `NEW_PROPERTY` attribute for an object literal member: a concise
    /// method / getter / setter carries the method (+ accessor) bits; a data
    /// property whose value is an anonymous function/class infers its name
    /// from the key (`XS_NAME_FLAG`); a plain data property is `0`.
    fn property_flag(p: &Node) -> i32 {
        use crate::ast::flags as f;
        if p.flags & f::METHOD != 0 {
            XS_NAME_FLAG | XS_METHOD_FLAG
        } else if p.flags & f::GETTER != 0 {
            XS_NAME_FLAG | XS_METHOD_FLAG | XS_GETTER_FLAG
        } else if p.flags & f::SETTER != 0 {
            XS_NAME_FLAG | XS_METHOD_FLAG | XS_SETTER_FLAG
        } else if Self::infers_name(&p.children[1]) {
            XS_NAME_FLAG
        } else {
            0
        }
    }

    fn code_object(&mut self, node: &Node) {
        let object = self.use_temporary();
        let items: &[Item] = match node.children.first() {
            Some(Item::List(v)) => v,
            _ => &[],
        };
        // A written `__proto__: v` (not shorthand) makes `v` the object's
        // prototype via `INSTANTIATE` in place of the plain `OBJECT`; it is
        // then skipped in the property loop.
        let mut proto = false;
        for item in items {
            if Self::is_proto_property(node_of(item)) {
                self.code(&node_of(item).children[1]);
                self.add_byte(0, XS_CODE_INSTANTIATE);
                proto = true;
            }
        }
        if !proto {
            self.add_byte(1, XS_CODE_OBJECT);
        }
        self.add_index(0, XS_CODE_SET_LOCAL_1, object);
        {
            for item in items {
                let p = node_of(item);
                if Self::is_proto_property(p) {
                    continue;
                }
                // `...spread`: `Object.assign`-style copy of `expr`'s own
                // enumerable properties onto the object (the `COPY_OBJECT`
                // intrinsic invoked with the object as `this`).
                if p.token == Token::Spread {
                    self.add_byte(1, XS_CODE_UNDEFINED);
                    self.add_byte(1, XS_CODE_COPY_OBJECT);
                    self.add_byte(1, XS_CODE_CALL);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, object);
                    self.code(&p.children[0]);
                    self.add_integer(-4, XS_CODE_RUN_1, 2);
                    self.add_byte(-1, XS_CODE_POP);
                    continue;
                }
                let is_accessor = p.flags & (crate::ast::flags::GETTER | crate::ast::flags::SETTER) != 0;
                match p.token {
                    Token::Property => {
                        let key = Self::symbol_of(&p.children[0]).to_string();
                        self.add_index(1, XS_CODE_GET_LOCAL_1, object);
                        self.pending_accessor = is_accessor;
                        self.code(&p.children[1]);
                        self.add_symbol(-2, XS_CODE_NEW_PROPERTY, &key);
                        let flag = Self::property_flag(p);
                        self.add_integer(0, XS_CODE_INTEGER_1, flag);
                    }
                    Token::PropertyAt => {
                        self.add_index(1, XS_CODE_GET_LOCAL_1, object);
                        self.code(&p.children[0]);
                        self.add_byte(0, XS_CODE_AT);
                        self.pending_accessor = is_accessor;
                        self.code(&p.children[1]);
                        self.add_byte(-3, XS_CODE_NEW_PROPERTY_AT);
                        let flag = Self::property_flag(p);
                        self.add_integer(0, XS_CODE_INTEGER_1, flag);
                    }
                    other => panic!("coder: unsupported object member {:?}", other),
                }
            }
        }
        self.unuse_temporaries(1);
    }

    /// `fxArrayNodeCode`. Children `[List(items)]` (expressions, `Elision`
    /// holes, and `...Spread`). The array lives in a temporary. Without a
    /// spread, `length` is set to the item count and each non-elided
    /// element is `NEW_PROPERTY_AT`'d at its index. With a spread, a
    /// running `counter` slot indexes appends and each `...expr` is
    /// iterated with the `for-of` protocol (`FOR_OF` + a `next()`/`done`
    /// loop) into the array.
    fn code_array(&mut self, node: &Node) {
        let array = self.use_temporary();
        self.add_byte(1, XS_CODE_ARRAY);
        self.add_index(0, XS_CODE_SET_LOCAL_1, array);
        let Some(Item::List(items)) = node.children.first() else {
            self.unuse_temporaries(1);
            return;
        };
        if node.flags & crate::ast::flags::SPREAD != 0 {
            let counter = self.use_temporary();
            self.add_integer(1, XS_CODE_INTEGER_1, 0);
            self.add_index(-1, XS_CODE_PULL_LOCAL_1, counter);
            for item in items {
                let n = node_of(item);
                if n.token == Token::Spread {
                    let iterator = self.use_temporary();
                    let result = self.use_temporary();
                    let next_target = self.create_target();
                    let done_target = self.create_target();
                    self.code(&n.children[0]);
                    self.add_byte(0, XS_CODE_FOR_OF);
                    self.add_index(0, XS_CODE_SET_LOCAL_1, iterator);
                    self.add_byte(-1, XS_CODE_POP);
                    self.place_target(0, next_target);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
                    self.add_byte(1, XS_CODE_DUB);
                    self.add_symbol(0, XS_CODE_GET_PROPERTY, "next");
                    self.add_byte(1, XS_CODE_CALL);
                    self.add_integer(-2, XS_CODE_RUN_1, 0);
                    self.add_index(0, XS_CODE_SET_LOCAL_1, result);
                    self.add_symbol(0, XS_CODE_GET_PROPERTY, "done");
                    self.add_branch(-1, XS_CODE_BRANCH_IF_1, done_target);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, array);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, counter);
                    self.add_byte(0, XS_CODE_AT);
                    self.add_index(0, XS_CODE_GET_LOCAL_1, result);
                    self.add_symbol(0, XS_CODE_GET_PROPERTY, "value");
                    self.add_byte(-2, XS_CODE_SET_PROPERTY_AT);
                    self.add_byte(-1, XS_CODE_POP);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, counter);
                    self.add_byte(0, XS_CODE_INCREMENT);
                    self.add_index(-1, XS_CODE_PULL_LOCAL_1, counter);
                    self.add_branch(0, XS_CODE_BRANCH_1, next_target);
                    self.place_target(1, done_target);
                    self.unuse_temporaries(2);
                } else if n.token != Token::Elision {
                    self.add_index(1, XS_CODE_GET_LOCAL_1, array);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, counter);
                    self.add_byte(0, XS_CODE_AT);
                    self.code(item);
                    self.add_byte(-2, XS_CODE_SET_PROPERTY_AT);
                    self.add_byte(-1, XS_CODE_POP);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, counter);
                    self.add_byte(0, XS_CODE_INCREMENT);
                    self.add_index(-1, XS_CODE_PULL_LOCAL_1, counter);
                } else {
                    self.add_index(1, XS_CODE_GET_LOCAL_1, array);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, counter);
                    self.add_byte(0, XS_CODE_INCREMENT);
                    self.add_index(0, XS_CODE_SET_LOCAL_1, counter);
                    self.add_symbol(-1, XS_CODE_SET_PROPERTY, "length");
                    self.add_byte(-1, XS_CODE_POP);
                }
            }
            self.unuse_temporaries(1);
        } else {
            let count = items.len() as i32;
            self.add_index(1, XS_CODE_GET_LOCAL_1, array);
            self.add_integer(1, XS_CODE_INTEGER_1, count);
            self.add_symbol(-1, XS_CODE_SET_PROPERTY, "length");
            self.add_byte(-1, XS_CODE_POP);
            let mut index: i32 = 0;
            for item in items {
                let is_elision = matches!(item, Item::Node(n) if n.token == Token::Elision);
                if !is_elision {
                    self.add_index(1, XS_CODE_GET_LOCAL_1, array);
                    self.add_integer(1, XS_CODE_INTEGER_1, index);
                    self.add_byte(0, XS_CODE_AT);
                    self.code(item);
                    self.add_byte(-3, XS_CODE_NEW_PROPERTY_AT);
                    self.add_integer(0, XS_CODE_INTEGER_1, 0);
                }
                index += 1;
            }
        }
        self.unuse_temporaries(1);
    }

    /// `fxPostfixExpressionNodeCode` — codes both `x++`/`x--` and the
    /// prefix `++x`/`--x` (which the parser flags `EXPRESSION_NO_VALUE` to
    /// skip the old-value save/restore, yielding the new value). Child
    /// `[reference]`.
    fn code_postfix(&mut self, node: &Node, stmt_no_value: bool) {
        let no_value = stmt_no_value || node.flags & crate::ast::flags::EXPRESSION_NO_VALUE != 0;
        self.code_this(&node.children[0], 1);
        let mut value = 0;
        if !no_value {
            value = self.use_temporary();
            self.add_byte(0, XS_CODE_TO_NUMERIC);
            self.add_index(0, XS_CODE_SET_LOCAL_1, value);
        }
        self.add_byte(0, if node.token == Token::Increment { XS_CODE_INCREMENT } else { XS_CODE_DECREMENT });
        self.code_assign(&node.children[0], 0);
        if !no_value {
            self.add_byte(-1, XS_CODE_POP);
            self.add_index(1, XS_CODE_GET_LOCAL_1, value);
            self.unuse_temporaries(1);
        }
    }

    /// `fxDeleteNodeCode` → the `codeDelete` family.
    fn code_delete(&mut self, item: &Item) {
        match item {
            Item::Node(n) => match n.token {
                Token::Access => {
                    // fxAccessNodeCodeDelete: deleting a resolved binding
                    // yields `false`; an unresolved one references then
                    // DELETE_PROPERTY. (strict `delete ident` is a parser
                    // early error, not reached here.)
                    if self.resolution_of(n).is_some() {
                        self.add_byte(1, XS_CODE_FALSE);
                        return;
                    }
                    let name = Self::symbol_of(&n.children[0]).to_string();
                    if self.eval_flag {
                        self.add_symbol(1, XS_CODE_EVAL_REFERENCE, &name);
                    } else {
                        self.add_symbol(1, XS_CODE_PROGRAM_REFERENCE, &name);
                    }
                    self.add_symbol(0, XS_CODE_DELETE_PROPERTY, &name);
                }
                Token::Member => {
                    let is_super = self.node_is_super(&n.children[0]);
                    self.code(&n.children[0]);
                    let name = Self::symbol_of(&n.children[1]).to_string();
                    self.add_symbol(0, if is_super { XS_CODE_DELETE_SUPER } else { XS_CODE_DELETE_PROPERTY }, &name);
                }
                Token::MemberAt => {
                    let is_super = self.node_is_super(&n.children[0]);
                    // fxMemberAtNodeCodeReference(super?1:0)
                    self.code(&n.children[0]);
                    self.code(&n.children[1]);
                    if !is_super {
                        self.add_byte(0, XS_CODE_AT);
                    }
                    self.add_byte(-1, if is_super { XS_CODE_DELETE_SUPER_AT } else { XS_CODE_DELETE_PROPERTY_AT });
                }
                Token::Expressions => {
                    // Single-item sequence delegates; else the value form.
                    if let Some(Item::List(items)) = n.children.first() {
                        if items.len() == 1 {
                            self.code_delete(&items[0]);
                            return;
                        }
                    }
                    self.code_delete_value(item);
                }
                // fxNodeCodeDelete: evaluate, discard, push `true`.
                _ => self.code_delete_value(item),
            },
            _ => self.code_delete_value(item),
        }
    }

    /// `fxNodeCodeDelete` — the non-reference `delete expr`: run it for
    /// effect then yield `true`.
    fn code_delete_value(&mut self, item: &Item) {
        self.code(item);
        self.add_byte(-1, XS_CODE_POP);
        self.add_byte(1, XS_CODE_TRUE);
    }

    /// `fxNewNodeCode`. Children `[reference, params]`: the constructor,
    /// `NEW`, then the argument list + `RUN`.
    fn code_new(&mut self, node: &Node) {
        self.code(&node.children[0]);
        self.add_byte(2, XS_CODE_NEW);
        // `new` is never a direct-`eval` call, and never a tail call (XS's
        // `fxCallNewNodeCode` does not relay the tail-recursion flag).
        self.code_params(node_of(&node.children[1]), false, false);
    }

    /// `fxParamsNodeCode`, the non-spread / non-eval branch. Children
    /// `[List(items)]`; each arg is pushed then a single `RUN_1 count`
    /// pops callee+this+args and leaves the result. Spread arguments and
    /// direct-`eval` parameter passing (the `EVAL` opcode) are deferred.
    fn code_params(&mut self, node: &Node, is_eval: bool, tail: bool) {
        let items: &[Item] = match node.children.first() {
            Some(Item::List(v)) => v,
            _ => &[],
        };
        if node.flags & crate::ast::flags::SPREAD != 0 {
            // A `...spread` argument makes the count dynamic: a `counter`
            // slot accumulates the argument count (bumped per fixed arg and
            // per spread element). The call closes with `GET_LOCAL counter`
            // then `RUN` (or `EVAL` for a direct `eval(...)`).
            let counter = self.use_temporary();
            self.add_integer(1, XS_CODE_INTEGER_1, 0);
            self.add_index(0, XS_CODE_SET_LOCAL_1, counter);
            self.add_byte(-1, XS_CODE_POP);
            let mut c: i32 = 0;
            for item in items {
                let n = node_of(item);
                if n.token == Token::Spread {
                    self.code_spread(&n.children[0], counter);
                } else {
                    c += 1;
                    self.code(item);
                    self.add_index(1, XS_CODE_GET_LOCAL_1, counter);
                    self.add_integer(1, XS_CODE_INTEGER_1, 1);
                    self.add_byte(-1, XS_CODE_ADD);
                    self.add_index(0, XS_CODE_SET_LOCAL_1, counter);
                    self.add_byte(-1, XS_CODE_POP);
                }
            }
            self.add_index(1, XS_CODE_GET_LOCAL_1, counter);
            let op = match (is_eval, tail) {
                (true, true) => XS_CODE_EVAL_TAIL,
                (true, false) => XS_CODE_EVAL,
                (false, true) => XS_CODE_RUN_TAIL,
                (false, false) => XS_CODE_RUN,
            };
            self.add_byte(-3 - c, op);
            self.unuse_temporaries(1);
        } else {
            let mut c: i32 = 0;
            for item in items {
                self.code(item);
                c += 1;
            }
            if is_eval {
                // The arg count is pushed, then `EVAL` consumes it.
                self.add_integer(1, XS_CODE_INTEGER_1, c);
                self.add_byte(-3 - c, if tail { XS_CODE_EVAL_TAIL } else { XS_CODE_EVAL });
            } else {
                self.add_integer(-2 - c, if tail { XS_CODE_RUN_TAIL_1 } else { XS_CODE_RUN_1 }, c);
            }
        }
    }

    /// `fxSpreadNodeCode` — iterate `...expr` with the `for-of` protocol,
    /// pushing each `value` as a call argument and bumping `counter`.
    fn code_spread(&mut self, expr: &Item, counter: i32) {
        let next_target = self.create_target();
        let done_target = self.create_target();
        self.code(expr);
        self.add_byte(0, XS_CODE_FOR_OF);
        let iterator = self.use_temporary();
        self.add_index(0, XS_CODE_SET_LOCAL_1, iterator);
        self.add_byte(-1, XS_CODE_POP);
        self.place_target(0, next_target);
        self.add_index(1, XS_CODE_GET_LOCAL_1, iterator);
        self.add_byte(1, XS_CODE_DUB);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "next");
        self.add_byte(1, XS_CODE_CALL);
        self.add_integer(-2, XS_CODE_RUN_1, 0);
        self.add_byte(1, XS_CODE_DUB);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "done");
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, done_target);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, "value");
        self.add_index(1, XS_CODE_GET_LOCAL_1, counter);
        self.add_integer(1, XS_CODE_INTEGER_1, 1);
        self.add_byte(-1, XS_CODE_ADD);
        self.add_index(0, XS_CODE_SET_LOCAL_1, counter);
        self.add_byte(-1, XS_CODE_POP);
        self.add_branch(0, XS_CODE_BRANCH_1, next_target);
        self.place_target(1, done_target);
        self.add_byte(-1, XS_CODE_POP);
        self.unuse_temporaries(1);
    }

    // ---- the `codeThis` family (callee + receiver setup) ------------

    /// `fxNodeDispatchCodeThis` — dispatch a callee reference in
    /// receiver-setup mode, returning the residual `flag`.
    fn code_this(&mut self, item: &Item, flag: i32) -> i32 {
        match item {
            Item::Node(n) => match n.token {
                Token::Access => self.code_access_this(n, flag),
                Token::Member => self.code_member_this(n, flag),
                Token::PrivateMember => self.code_private_member_this(n, flag),
                Token::MemberAt => self.code_member_at_this(n, flag),
                Token::Expressions => self.code_expressions_this(n, flag),
                // An optional call (`fn?.(…)`, `a?.b()`): the callee is a
                // `Chain`/`Option` in call-reference position, so it must code
                // the `this`/value pair and short-circuit the whole chain when
                // a base is nullish — not fall through to the plain-value
                // fallback (which would drop the receiver dance).
                Token::Chain => self.code_chain_this(n, flag),
                Token::Option => self.code_option_this(n, flag),
                _ => self.code_node_this(item, flag),
            },
            _ => self.code_node_this(item, flag),
        }
    }

    /// `fxNodeCodeThis` — the fallback: push `undefined` as the receiver,
    /// then the value.
    fn code_node_this(&mut self, item: &Item, _flag: i32) -> i32 {
        self.add_byte(1, XS_CODE_UNDEFINED);
        self.code(item);
        1
    }

    /// `fxAccessNodeCodeThis`. A resolved local pushes its slot (with no
    /// separate receiver); a free reference pushes `undefined` as the
    /// receiver then loads the value by symbol.
    fn code_access_this(&mut self, node: &Node, flag: i32) -> i32 {
        if flag == 0 {
            self.add_byte(1, XS_CODE_UNDEFINED);
        }
        if let Some((scope, id)) = self.resolution_of(node) {
            let index = self.declare_index(scope, id);
            let op = if self.is_closure(scope, id) { XS_CODE_GET_CLOSURE_1 } else { XS_CODE_GET_LOCAL_1 };
            self.add_index(1, op, index);
            return 0;
        }
        let name = Self::symbol_of(&node.children[0]).to_string();
        // unresolved: reference then GET_THIS_VARIABLE
        if self.eval_flag {
            self.add_symbol(1, XS_CODE_EVAL_REFERENCE, &name);
        } else {
            self.add_symbol(1, XS_CODE_PROGRAM_REFERENCE, &name);
        }
        if flag != 0 {
            self.add_byte(1, XS_CODE_DUB);
        }
        self.add_symbol(0, XS_CODE_GET_THIS_VARIABLE, &name);
        flag
    }

    /// `fxMemberNodeCodeThis` — the object is the receiver (`DUB`'d).
    fn code_member_this(&mut self, node: &Node, _flag: i32) -> i32 {
        self.code(&node.children[0]);
        let is_super = self.node_is_super(&node.children[0]);
        let name = Self::symbol_of(&node.children[1]).to_string();
        self.add_byte(1, XS_CODE_DUB);
        self.add_symbol(0, if is_super { XS_CODE_GET_SUPER } else { XS_CODE_GET_PROPERTY }, &name);
        1
    }

    /// `fxPrivateMemberNodeCodeThis` — `obj.#m(...)` callee: the object is
    /// the receiver (`DUB`'d), then the private value is read by brand.
    fn code_private_member_this(&mut self, node: &Node, _flag: i32) -> i32 {
        self.code(&node.children[1]);
        self.add_byte(1, XS_CODE_DUB);
        let index = self.private_index(node);
        self.add_index(0, XS_CODE_GET_PRIVATE_1, index);
        1
    }

    /// `fxMemberAtNodeCodeThis`.
    fn code_member_at_this(&mut self, node: &Node, flag: i32) -> i32 {
        let is_super = self.node_is_super(&node.children[0]);
        let mut flag = flag;
        if flag != 0 {
            // fxMemberAtNodeCodeReference(flag=0): reference, at, then AT.
            self.code(&node.children[0]);
            self.code(&node.children[1]);
            self.add_byte(0, if is_super { XS_CODE_SUPER_AT } else { XS_CODE_AT });
            self.add_byte(2, XS_CODE_DUB_AT);
            flag = 2;
        } else {
            self.code(&node.children[0]);
            self.add_byte(1, XS_CODE_DUB);
            self.code(&node.children[1]);
            self.add_byte(0, if is_super { XS_CODE_SUPER_AT } else { XS_CODE_AT });
        }
        self.add_byte(-1, if is_super { XS_CODE_GET_SUPER_AT } else { XS_CODE_GET_PROPERTY_AT });
        flag
    }

    /// `fxExpressionsNodeCodeThis` — a single-item sequence forwards to its
    /// item's `codeThis`; otherwise the fallback (`undefined` receiver +
    /// the sequence's value), dispatched on the original node so scope
    /// keying stays intact.
    fn code_expressions_this(&mut self, node: &Node, flag: i32) -> i32 {
        if let Some(Item::List(items)) = node.children.first() {
            if items.len() == 1 {
                return self.code_this(&items[0], flag);
            }
        }
        let _ = flag;
        self.add_byte(1, XS_CODE_UNDEFINED);
        self.code_node(node);
        1
    }

    // ---- assignment: the codeReference / codeAssign families --------

    /// `fxAssignNodeCode` — plain `=`. Children `[reference, value]`:
    /// prepare the reference, evaluate the value, store.
    fn code_assign_node(&mut self, node: &Node) {
        // Name inference: `x = function(){}` names the anonymous value `x`.
        self.set_pending_name(&node.children[0], &node.children[1]);
        self.code_reference(&node.children[0], 1);
        self.code(&node.children[1]);
        self.code_assign(&node.children[0], 1);
    }

    /// `fxCompoundExpressionNodeCode` — `+=`, `-=`, … and the short-circuit
    /// `&&=` / `||=` / `??=`. Children `[reference, value]`.
    fn code_compound(&mut self, node: &Node, stmt_no_value: bool) {
        use Token::*;
        let no_value = stmt_no_value || node.flags & crate::ast::flags::EXPRESSION_NO_VALUE != 0;
        let token = node.token;
        let shortcut = matches!(token, AndAssign | OrAssign | CoalesceAssign);
        let else_target = if shortcut { Some(self.create_target()) } else { None };
        let end_target = if shortcut { Some(self.create_target()) } else { None };
        let swap = self.code_this(&node.children[0], 1);
        match token {
            AndAssign => {
                self.add_byte(1, XS_CODE_DUB);
                self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, else_target.unwrap());
                self.add_byte(-1, XS_CODE_POP);
                self.code(&node.children[1]);
                self.code_compound_name(node);
            }
            CoalesceAssign => {
                self.add_branch(-1, XS_CODE_BRANCH_COALESCE_1, else_target.unwrap());
                self.code(&node.children[1]);
                self.code_compound_name(node);
            }
            OrAssign => {
                self.add_byte(1, XS_CODE_DUB);
                self.add_branch(-1, XS_CODE_BRANCH_IF_1, else_target.unwrap());
                self.add_byte(-1, XS_CODE_POP);
                self.code(&node.children[1]);
                self.code_compound_name(node);
            }
            _ => {
                self.code(&node.children[1]);
                self.add_byte(-1, compound_op(token));
            }
        }
        self.code_assign(&node.children[0], 0);
        if shortcut {
            self.add_branch(0, XS_CODE_BRANCH_1, end_target.unwrap());
            self.place_target(0, else_target.unwrap());
            let mut swap = swap;
            while swap > 0 {
                if !no_value {
                    self.add_byte(0, XS_CODE_SWAP);
                }
                self.add_byte(-1, XS_CODE_POP);
                swap -= 1;
            }
            self.place_target(0, end_target.unwrap());
        }
    }

    /// `fxCompoundExpressionNodeCodeName` — name an anonymous function /
    /// class assigned to a plain identifier. Its trigger nodes (function /
    /// class values) are not in the ported surface, so it is a no-op here.
    fn code_compound_name(&mut self, node: &Node) {
        if let Item::Node(r) = &node.children[0] {
            if r.token == Token::Access && node_code_name(&node.children[1]) {
                let name = Self::symbol_of(&r.children[0]).to_string();
                self.add_symbol(0, XS_CODE_NAME, &name);
            }
        }
    }

    /// `fxNodeDispatchCodeReference` — prepare a store target.
    fn code_reference(&mut self, item: &Item, flag: i32) {
        match item {
            Item::Node(n) => match n.token {
                // fxDeclareNodeCodeReference: a declaration target (a
                // `var`/`let`/`const` binding) — nothing when resolved.
                Token::Var | Token::Let | Token::Const | Token::Using | Token::Arg => {
                    self.code_declare_reference(n);
                }
                // fxBindingNodeCodeReference: an `= default` target
                // references its inner target.
                Token::Binding => {
                    self.code_reference(&n.children[0], flag);
                }
                Token::Access => {
                    // fxAccessNodeCodeReference: resolved locals need no
                    // reference; a free reference takes the symbol path.
                    if self.resolution_of(n).is_some() {
                        return;
                    }
                    let name = Self::symbol_of(&n.children[0]).to_string();
                    if self.eval_flag {
                        self.add_symbol(1, XS_CODE_EVAL_REFERENCE, &name);
                    } else {
                        self.add_symbol(1, XS_CODE_PROGRAM_REFERENCE, &name);
                    }
                }
                Token::Member => {
                    // fxMemberNodeCodeReference: just the object.
                    self.code(&n.children[0]);
                }
                Token::PrivateMember => {
                    // fxPrivateMemberNodeCodeReference: just the object.
                    self.code(&n.children[1]);
                }
                Token::MemberAt => {
                    let is_super = self.node_is_super(&n.children[0]);
                    self.code(&n.children[0]);
                    self.code(&n.children[1]);
                    if flag == 0 {
                        self.add_byte(0, if is_super { XS_CODE_SUPER_AT } else { XS_CODE_AT });
                    }
                }
                // fxNodeCodeReference: nothing.
                _ => {}
            },
            _ => {}
        }
    }

    /// `fxNodeDispatchCodeAssign` — store into the prepared reference.
    fn code_assign(&mut self, item: &Item, flag: i32) {
        match item {
            Item::Node(n) => match n.token {
                // fxDeclareNodeCodeAssign: a declaration target stores with
                // its binding op (`VAR_LOCAL`/`LET_LOCAL`/`CONST_LOCAL`).
                Token::Var | Token::Let | Token::Const | Token::Using | Token::Arg => {
                    self.code_declare_assign(n);
                }
                Token::Access => {
                    // fxAccessNodeCodeAssign: resolved → SET_LOCAL/SET_CLOSURE
                    // by slot; unresolved (global) → SET_VARIABLE by symbol.
                    if let Some((scope, id)) = self.resolution_of(n) {
                        let index = self.declare_index(scope, id);
                        let op = if self.is_closure(scope, id) { XS_CODE_SET_CLOSURE_1 } else { XS_CODE_SET_LOCAL_1 };
                        self.add_index(0, op, index);
                    } else {
                        let name = Self::symbol_of(&n.children[0]).to_string();
                        self.add_symbol(-1, XS_CODE_SET_VARIABLE, &name);
                    }
                }
                Token::Member => {
                    let is_super = self.node_is_super(&n.children[0]);
                    let name = Self::symbol_of(&n.children[1]).to_string();
                    self.add_symbol(-1, if is_super { XS_CODE_SET_SUPER } else { XS_CODE_SET_PROPERTY }, &name);
                }
                Token::PrivateMember => {
                    // fxPrivateMemberNodeCodeAssign: store into the brand.
                    let index = self.private_index(n);
                    self.add_index(-1, XS_CODE_SET_PRIVATE_1, index);
                }
                Token::MemberAt => {
                    let is_super = self.node_is_super(&n.children[0]);
                    if flag != 0 {
                        self.add_byte(0, if is_super { XS_CODE_SUPER_AT_2 } else { XS_CODE_AT_2 });
                    }
                    self.add_byte(-2, if is_super { XS_CODE_SET_SUPER_AT } else { XS_CODE_SET_PROPERTY_AT });
                }
                // fxBindingNodeCodeAssign: an `= default` target. Use the
                // supplied value unless it is `undefined`, in which case
                // evaluate the initializer, then store into the inner target.
                Token::Binding => {
                    let target = self.create_target();
                    self.add_byte(1, XS_CODE_DUB);
                    self.add_byte(1, XS_CODE_UNDEFINED);
                    self.add_byte(-1, XS_CODE_STRICT_NOT_EQUAL);
                    self.add_branch(-1, XS_CODE_BRANCH_IF_1, target);
                    self.add_byte(-1, XS_CODE_POP);
                    // NamedEvaluation: a destructuring default `{ x = () => {} }`
                    // names the anonymous initializer after the pattern's bound
                    // identifier. XS applies this at bind time
                    // (`fxBindingNodeBind` → `fxFunctionNodeRename`, keyed on the
                    // target being an Access/Arg/Var/Let/Const/Using node); we
                    // stage it here so the initializer's function-creation
                    // operand consumes the name, exactly as the declaration and
                    // plain-assignment paths already do.
                    self.set_pending_name(&n.children[0], &n.children[1]);
                    self.code(&n.children[1]);
                    self.place_target(0, target);
                    self.code_assign(&n.children[0], flag);
                }
                // fxObjectBindingNodeCodeAssign: destructure the value's own
                // properties into each target.
                Token::ObjectBinding => self.code_object_binding_assign(n, flag),
                // fxArrayBindingNodeCodeAssign: iterate the value and
                // destructure each element into its target.
                Token::ArrayBinding => self.code_array_binding_assign(n, flag),
                other => panic!("coder: no reference for assignment target {:?}", other),
            },
            _ => panic!("coder: no reference for assignment target"),
        }
    }

    /// `fxTemplateNodeCode`. Children `[reference, List(items)]`; the items
    /// alternate `TemplateMiddle` (a cooked + raw string pair) with
    /// substitution expressions. A `Null` reference is an untagged template
    /// (string concatenation); a real reference is a tagged template — a
    /// call `tag(strings, ...substitutions)` where `strings` is the frozen
    /// template object (`strings.raw` the raw array), cached per call site.
    fn code_template(&mut self, node: &Node, tail: bool) {
        let items = match &node.children[1] {
            Item::List(v) => v,
            _ => panic!("template without items list"),
        };
        if !matches!(node.children[0], Item::Null) {
            self.code_tagged_template(node, items, tail);
            return;
        }
        // Untagged: the first item is always a `TemplateMiddle`; emit its
        // cooked string, then fold each following part in with `+`.
        self.code(&node_of(&items[0]).children[0]);
        for item in &items[1..] {
            let n = node_of(item);
            if n.token == Token::TemplateMiddle {
                self.code(&n.children[0]);
            } else {
                self.code(item);
                self.add_byte(1, XS_CODE_TO_STRING);
            }
            self.add_byte(-1, XS_CODE_ADD);
        }
    }

    /// `fxTemplateNodeCode`, tagged branch. Builds (once per call site,
    /// guarded by a `TEMPLATE_CACHE.#<tag>` lookup) the frozen template
    /// object: a `strings` array of the cooked values (`undefined` for an
    /// illegal escape), a `raws` array of the raw values, `strings.raw =
    /// raws`, then `TEMPLATE` to freeze. The cached object is argument 0 of
    /// the tag call, followed by each substitution expression.
    fn code_tagged_template(&mut self, node: &Node, items: &[Item], tail: bool) {
        let cache_target = self.create_target();
        // Number of `TemplateMiddle` items = (items.length / 2) + 1.
        let string_count = (items.len() as i32 / 2) + 1;
        let raws = self.use_temporary();
        let strings = self.use_temporary();
        // XS_DONT_DELETE_FLAG (2) | XS_DONT_SET_FLAG (8): each cooked/raw
        // slot is a frozen own property.
        let prop_flag: i32 = 2 | 8;

        self.code_this(&node.children[0], 0);
        self.add_byte(1, XS_CODE_CALL);

        let symbol = self.generate_tag();
        self.add_byte(1, XS_CODE_TEMPLATE_CACHE);
        self.add_symbol(0, XS_CODE_GET_PROPERTY, &symbol);
        self.add_branch(0, XS_CODE_BRANCH_COALESCE_1, cache_target);
        self.add_byte(1, XS_CODE_TEMPLATE_CACHE);

        self.add_byte(1, XS_CODE_ARRAY);
        self.add_index(0, XS_CODE_SET_LOCAL_1, strings);
        self.add_integer(1, XS_CODE_INTEGER_1, string_count);
        self.add_symbol(-1, XS_CODE_SET_PROPERTY, "length");
        self.add_byte(-1, XS_CODE_POP);
        self.add_byte(1, XS_CODE_ARRAY);
        self.add_index(0, XS_CODE_SET_LOCAL_1, raws);
        self.add_integer(1, XS_CODE_INTEGER_1, string_count);
        self.add_symbol(-1, XS_CODE_SET_PROPERTY, "length");
        self.add_byte(-1, XS_CODE_POP);

        let mut i: i32 = 0;
        for item in items {
            let n = node_of(item);
            if n.token != Token::TemplateMiddle {
                continue;
            }
            self.add_index(1, XS_CODE_GET_LOCAL_1, strings);
            self.add_integer(1, XS_CODE_INTEGER_1, i);
            self.add_byte(0, XS_CODE_AT);
            // An illegal escape makes the cooked slot `undefined`; the raw
            // slot is still emitted verbatim.
            if node_of(&n.children[0]).flags & crate::ast::flags::STRING_ERROR != 0 {
                self.add_byte(1, XS_CODE_UNDEFINED);
            } else {
                self.code(&n.children[0]);
            }
            self.add_byte(-3, XS_CODE_NEW_PROPERTY_AT);
            self.add_integer(0, XS_CODE_INTEGER_1, prop_flag);

            self.add_index(1, XS_CODE_GET_LOCAL_1, raws);
            self.add_integer(1, XS_CODE_INTEGER_1, i);
            self.add_byte(0, XS_CODE_AT);
            self.code(&n.children[1]);
            self.add_byte(-3, XS_CODE_NEW_PROPERTY_AT);
            self.add_integer(0, XS_CODE_INTEGER_1, prop_flag);

            i += 1;
        }
        self.add_index(1, XS_CODE_GET_LOCAL_1, strings);
        self.add_index(1, XS_CODE_GET_LOCAL_1, raws);
        self.add_symbol(-1, XS_CODE_SET_PROPERTY, "raw");
        self.add_byte(-1, XS_CODE_POP);
        self.add_index(1, XS_CODE_GET_LOCAL_1, strings);
        self.add_byte(0, XS_CODE_TEMPLATE);

        self.add_symbol(-1, XS_CODE_SET_PROPERTY, &symbol);

        self.place_target(0, cache_target);

        // The template object is argument 0; each substitution expression
        // follows.
        let mut count: i32 = 1;
        for item in items {
            if node_of(item).token != Token::TemplateMiddle {
                self.code(item);
                count += 1;
            }
        }
        self.add_integer(-2 - count, if tail { XS_CODE_RUN_TAIL_1 } else { XS_CODE_RUN_1 }, count);
        self.unuse_temporaries(2);
    }

    /// `fxRegexpNodeCode`. A `new RegExp(pattern, flags)` via the
    /// dedicated `REGEXP` intrinsic (no `RegExp` symbol lookup). XS
    /// dispatches `self->modifier` (the pattern string) then `self->value`
    /// (the flags string); those land in child slots `[1, 0]` here (the
    /// slot order is the reverse of XS's field order, as the byte stream
    /// pins: pattern first, flags second).
    fn code_regexp(&mut self, node: &Node) {
        self.add_byte(1, XS_CODE_REGEXP);
        self.add_byte(2, XS_CODE_NEW);
        self.code(&node.children[1]);
        self.code(&node.children[0]);
        self.add_integer(-4, XS_CODE_RUN_1, 2);
    }

    /// `fxSwitchNodeCode`. Children `[expression, List(cases)]`; each
    /// `Case` is `[test-or-null, body-or-null]`.
    fn code_switch(&mut self, node: &Node) {
        let scope = self.scope_of(node);
        self.code(&node.children[0]);
        self.scope_coding_block(scope);
        let using_context = (self.tree.scopes[scope].disposable_count > 0)
            .then(|| self.scope_code_using(scope));
        let break_target = self.create_target();
        // XS gives the switch break target a zeroed (anonymous) label so a
        // bare `break;` matches it.
        self.targets[break_target].labels = vec![None];
        self.targets[break_target].next_target = self.first_break_target;
        self.first_break_target = Some(break_target);
        if self.program_flag {
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(-1, XS_CODE_SET_RESULT);
        }
        // Reference the case nodes in place (the scoper keys scopes by
        // node address, so cloning would miss registrations).
        let cases: Vec<&Node> = match &node.children[1] {
            Item::List(items) => items.iter().map(node_of).collect(),
            _ => Vec::new(),
        };
        let mut case_targets = Vec::with_capacity(cases.len());
        let mut default_target: Option<usize> = None;
        for case in &cases {
            let t = self.create_target();
            case_targets.push(t);
            if !matches!(case.children[0], Item::Null) {
                self.add_byte(1, XS_CODE_DUB);
                self.code(&case.children[0]);
                self.add_byte(-1, XS_CODE_STRICT_EQUAL);
                self.add_branch(-1, XS_CODE_BRANCH_IF_1, t);
            } else {
                default_target = Some(t);
            }
        }
        match default_target {
            Some(dt) => self.add_branch(0, XS_CODE_BRANCH_1, dt),
            None => self.add_branch(0, XS_CODE_BRANCH_1, break_target),
        }
        for (i, case) in cases.iter().enumerate() {
            self.place_target(0, case_targets[i]);
            if !matches!(case.children[1], Item::Null) {
                self.code(&case.children[1]);
            }
        }
        self.place_target(0, break_target);
        self.first_break_target = self.targets[break_target].next_target;
        if let Some(context) = using_context {
            self.scope_code_used(scope, context);
        }
        self.scope_coded(scope);
        self.add_byte(-1, XS_CODE_POP);
    }

    /// `fxCatchNodeCode`. Children `[parameter-or-null, statements]`. The
    /// parameter-binding branch emits `NEW_LOCAL` (a symbol op) and is
    /// deferred to the atom-table child; the bare `catch {}` form is here.
    fn code_catch(&mut self, node: &Node) {
        if matches!(node.children[0], Item::Null) {
            // No parameter: the primary scope is the body block.
            let statement_scope = self.scope_of(node);
            self.scope_coding_block(statement_scope);
            self.scope_code_define_nodes(statement_scope);
            if self.tree.scopes[statement_scope].disposable_count > 0 {
                let context = self.scope_code_using(statement_scope);
                self.code(&node.children[1]);
                self.scope_code_used(statement_scope, context);
            } else {
                self.code(&node.children[1]);
            }
            self.scope_coded(statement_scope);
        } else {
            // `catch (e) { … }`: the primary scope binds the parameter, the
            // secondary is the body block. Store the caught `EXCEPTION` into
            // the parameter slot, then code the body.
            let param_scope = self.scope_of(node);
            let statement_scope = self.scope_secondary(node);
            self.scope_coding_block(param_scope);
            self.code_reference(&node.children[0], 0);
            self.add_byte(1, XS_CODE_EXCEPTION);
            self.code_assign(&node.children[0], 0);
            self.add_byte(-1, XS_CODE_POP);
            self.scope_coding_block(statement_scope);
            self.scope_code_define_nodes(statement_scope);
            if self.tree.scopes[statement_scope].disposable_count > 0 {
                let context = self.scope_code_using(statement_scope);
                self.code(&node.children[1]);
                self.scope_code_used(statement_scope, context);
            } else {
                self.code(&node.children[1]);
            }
            self.scope_coded(statement_scope);
            self.scope_coded(param_scope);
        }
    }

    /// `fxTryNodeCode`. Children `[tryBlock, catch-or-null, finally-or-null]`.
    fn code_try(&mut self, node: &Node) {
        let exception = self.use_temporary();
        let selector = self.use_temporary();
        let result = self.use_temporary();

        self.first_break_target = self.alias_targets(self.first_break_target);
        self.first_continue_target = self.alias_targets(self.first_continue_target);
        self.return_target = self.alias_targets(self.return_target);
        let mut catch_target = self.create_target();
        let normal_target = self.create_target();
        let finally_target = self.create_target();

        self.add_integer(1, XS_CODE_INTEGER_1, 0);
        self.add_index(0, XS_CODE_SET_LOCAL_1, selector);
        self.add_byte(-1, XS_CODE_POP);

        self.add_branch(0, XS_CODE_CATCH_1, catch_target);
        if self.program_flag {
            self.add_byte(1, XS_CODE_UNDEFINED);
            self.add_byte(-1, XS_CODE_SET_RESULT);
        }
        self.code(&node.children[0]);
        self.add_branch(0, XS_CODE_BRANCH_1, normal_target);
        if !matches!(node.children[1], Item::Null) {
            self.add_byte(0, XS_CODE_UNCATCH);
            self.place_target(0, catch_target);
            catch_target = self.create_target();
            self.add_branch(0, XS_CODE_CATCH_1, catch_target);
            if self.program_flag {
                self.add_byte(1, XS_CODE_UNDEFINED);
                self.add_byte(-1, XS_CODE_SET_RESULT);
            }
            self.code(&node.children[1]);
            self.add_branch(0, XS_CODE_BRANCH_1, normal_target);
        }

        let mut selection = 1;
        self.first_break_target =
            self.finalize_targets(self.first_break_target, selector, &mut selection, finally_target);
        self.first_continue_target = self.finalize_targets(
            self.first_continue_target,
            selector,
            &mut selection,
            finally_target,
        );
        self.return_target =
            self.finalize_targets(self.return_target, selector, &mut selection, finally_target);
        self.place_target(0, normal_target);
        self.add_integer(1, XS_CODE_INTEGER_1, selection);
        self.add_index(0, XS_CODE_SET_LOCAL_1, selector);
        self.add_byte(-1, XS_CODE_POP);
        self.place_target(0, finally_target);
        self.add_byte(0, XS_CODE_UNCATCH);
        self.place_target(0, catch_target);
        self.add_byte(1, XS_CODE_EXCEPTION);
        self.add_index(0, XS_CODE_SET_LOCAL_1, exception);
        self.add_byte(-1, XS_CODE_POP);
        if !matches!(node.children[2], Item::Null) {
            if self.program_flag {
                self.add_byte(1, XS_CODE_GET_RESULT);
                self.add_index(-1, XS_CODE_PULL_LOCAL_1, result);
                self.add_byte(1, XS_CODE_UNDEFINED);
                self.add_byte(-1, XS_CODE_SET_RESULT);
            }
            self.code(&node.children[2]);
            if self.program_flag {
                self.add_index(1, XS_CODE_GET_LOCAL_1, result);
                self.add_byte(-1, XS_CODE_SET_RESULT);
            }
        }
        let end_catch = self.create_target();
        self.add_index(1, XS_CODE_GET_LOCAL_1, selector);
        self.add_branch(-1, XS_CODE_BRANCH_IF_1, end_catch);
        self.add_index(1, XS_CODE_GET_LOCAL_1, exception);
        self.add_byte(-1, XS_CODE_THROW);
        self.place_target(0, end_catch);
        let mut selection = 1;
        let bt = self.first_break_target;
        self.jump_targets(bt, selector, &mut selection);
        let ct = self.first_continue_target;
        self.jump_targets(ct, selector, &mut selection);
        let rt = self.return_target;
        self.jump_targets(rt, selector, &mut selection);
        self.unuse_temporaries(3);
    }

    /// `fxCoderAliasTargets` — parallel alias chain for the `try` unwind.
    fn alias_targets(&mut self, head: Option<usize>) -> Option<usize> {
        let mut result = None;
        let mut prev: Option<usize> = None;
        let mut cur = head;
        while let Some(t) = cur {
            let a = self.create_target();
            self.targets[a].labels = self.targets[t].labels.clone();
            self.targets[a].original = Some(t);
            if prev.is_none() {
                result = Some(a);
            } else {
                self.targets[prev.unwrap()].next_target = Some(a);
            }
            prev = Some(a);
            cur = self.targets[t].next_target;
        }
        result
    }

    /// `fxCoderFinalizeTargets`.
    fn finalize_targets(
        &mut self,
        alias: Option<usize>,
        selector: i32,
        selection: &mut i32,
        finally_target: usize,
    ) -> Option<usize> {
        let mut result = None;
        if let Some(first) = alias {
            result = self.targets[first].original;
            let mut a = alias;
            while let Some(al) = a {
                if self.targets[al].used {
                    self.place_target(0, al);
                    self.add_integer(1, XS_CODE_INTEGER_1, *selection);
                    self.add_index(-1, XS_CODE_PULL_LOCAL_1, selector);
                    self.add_branch(0, XS_CODE_BRANCH_1, finally_target);
                    let orig = self.targets[al].original.unwrap();
                    self.targets[orig].used = true;
                }
                a = self.targets[al].next_target;
                *selection += 1;
            }
        }
        result
    }

    /// `fxCoderJumpTargets`.
    fn jump_targets(&mut self, target: Option<usize>, selector: i32, selection: &mut i32) {
        let mut t = target;
        while let Some(tt) = t {
            if self.targets[tt].used {
                let else_target = self.create_target();
                self.add_integer(1, XS_CODE_INTEGER_1, *selection);
                self.add_index(1, XS_CODE_GET_LOCAL_1, selector);
                self.add_byte(-1, XS_CODE_STRICT_EQUAL);
                self.add_branch(-1, XS_CODE_BRANCH_ELSE_1, else_target);
                self.adjust_environment(tt);
                self.adjust_scope(tt);
                self.add_branch(0, XS_CODE_BRANCH_1, tt);
                self.place_target(0, else_target);
            }
            t = self.targets[tt].next_target;
            *selection += 1;
        }
    }
}

// ======================= three-pass serializer =========================

impl Coder<'_> {
    /// `fxCoderOptimize` — the four peephole rewrites XS runs before
    /// sizing, in order. Ported faithfully over the record `Vec`
    /// (`Payload::Target` records are XS's `XS_NO_CODE` placeholders).
    fn optimize(&mut self) {
        let is_end = |id: i32| (XS_CODE_END..=XS_CODE_END_DERIVED).contains(&id);
        let skippable = |id: i32| id == XS_NO_CODE || id == XS_CODE_UNWIND_1;

        // Pass 1: branch to (target | unwind)* end => end. A `BRANCH_1`
        // whose target, after skipping placeholders/unwinds, reaches an
        // `END*` becomes that `END*` inline (replaced in place).
        let mut i = 0;
        while i < self.codes.len() {
            if self.codes[i].id == XS_CODE_BRANCH_1 {
                if let Payload::Branch { tid } = self.codes[i].payload {
                    if let Some(p) = self.target_pos(tid) {
                        let mut j = p + 1;
                        while j < self.codes.len() && skippable(self.codes[j].id) {
                            j += 1;
                        }
                        if j < self.codes.len() && is_end(self.codes[j].id) {
                            let end_id = self.codes[j].id;
                            self.codes[i].id = end_id;
                            self.codes[i].payload = Payload::Byte;
                        }
                    }
                }
            }
            i += 1;
        }

        // Pass 2: unwind (target | unwind)* end => (target | unwind)* end.
        // An `UNWIND_1` that reaches an `END*` (over placeholders/unwinds)
        // is dropped — the frame teardown at `END*` subsumes it.
        let mut i = 0;
        while i < self.codes.len() {
            if self.codes[i].id == XS_CODE_UNWIND_1 {
                let mut j = i + 1;
                while j < self.codes.len() && skippable(self.codes[j].id) {
                    j += 1;
                }
                if j < self.codes.len() && is_end(self.codes[j].id) {
                    self.codes.remove(i);
                    continue;
                }
            }
            i += 1;
        }

        // Pass 3: end target* end => target* end. A dead `END*` followed
        // (over placeholders) by the same `END*` is dropped.
        let mut i = 0;
        while i < self.codes.len() {
            if is_end(self.codes[i].id) {
                let mut j = i + 1;
                while j < self.codes.len() && self.codes[j].id == XS_NO_CODE {
                    j += 1;
                }
                if j < self.codes.len() && self.codes[j].id == self.codes[i].id {
                    self.codes.remove(i);
                    continue;
                }
            }
            i += 1;
        }

        // Pass 4: branch to next =>. A `BRANCH_1` whose target is the
        // immediately following record is dropped.
        let mut i = 0;
        while i < self.codes.len() {
            if self.codes[i].id == XS_CODE_BRANCH_1 {
                if let Payload::Branch { tid } = self.codes[i].payload {
                    if let Some(Payload::Target { tid: ntid }) =
                        self.codes.get(i + 1).map(|c| c.payload.clone())
                    {
                        if ntid == tid {
                            self.codes.remove(i);
                            continue;
                        }
                    }
                }
            }
            i += 1;
        }
    }

    /// The record index of a placed target (`Payload::Target { tid }`).
    fn target_pos(&self, tid: usize) -> Option<usize> {
        self.codes
            .iter()
            .position(|c| matches!(c.payload, Payload::Target { tid: t } if t == tid))
    }

    /// `fxParserCode`'s three passes, producing **both** the `codeBuffer`
    /// bytes and the `symbolsBuffer` atom (`(bytecode, symbols)`) — the two
    /// halves of XS's `txScript` the oracle shim hands back. The symbols
    /// atom is emitted from the same [`assign_ids`] walk the bytecode's
    /// symbol operands were numbered by, so ironhorse's SYMB payload is
    /// byte-identical to the oracle's whenever the operands are (the
    /// stage-5 id contract), letting the `Ironhorse` seam stop borrowing the
    /// oracle's atom.
    fn serialize_atoms(&mut self) -> (Vec<u8>, Vec<u8>) {
        self.optimize();

        // ---- pass 1: size with branches assumed widest, accrue delta --
        let mut size: i32 = 0;
        let mut delta: i32 = 0;
        for c in &mut self.codes {
            match c.id {
                XS_NO_CODE => {
                    if let Payload::Target { tid } = c.payload {
                        // set later; record offset now
                        let _ = tid;
                    }
                }
                _ => {}
            }
            size1_step(c, &mut size, &mut delta, &mut self.targets);
        }

        // ---- pass 2: choose branch widths from target offsets ---------
        size = 0;
        for c in &mut self.codes {
            size2_step(c, &mut size, &mut delta, &mut self.targets);
        }

        // Assign symbol IDs from the now-complete usage marks (XS does the
        // bucket walk here, between sizing and emission).
        self.symbols.assign_ids();
        let sym_ids = self.symbols.id_table();
        // The SYMB atom is dumped from the same walk, so its strings are in
        // the ids' order (`fxParserCode` emits `symbolsBuffer` right here).
        let symbols = self.symbols.symbols_atom();

        // ---- pass 3: emit ---------------------------------------------
        let mut out: Vec<u8> = Vec::with_capacity(size.max(0) as usize);
        for c in &self.codes {
            emit_step(c, &mut out, &self.targets, &sym_ids);
        }
        (out, symbols)
    }
}

/// Pass 1 of `fxParserCode`: accumulate `size` assuming every branch is
/// the widest form (its slack tracked in `delta`), select the width of
/// value-bearing opcodes (`INTEGER`/`STRING`/index families) from their
/// payloads, and record each target's provisional offset.
fn size1_step(c: &mut Code, size: &mut i32, delta: &mut i32, targets: &mut [Target]) {
    match c.id {
        XS_NO_CODE => {
            if let Payload::Target { tid } = c.payload {
                targets[tid].offset = *size;
            }
        }
        // branch family (`_1` forms): widest-assumption size 2, delta 3
        XS_CODE_BRANCH_1 | XS_CODE_BRANCH_CHAIN_1 | XS_CODE_BRANCH_COALESCE_1
        | XS_CODE_BRANCH_ELSE_1 | XS_CODE_BRANCH_IF_1 | XS_CODE_BRANCH_STATUS_1
        | XS_CODE_CATCH_1 | XS_CODE_CODE_1 => {
            *size += 2;
            *delta += 3;
        }
        // 2-byte fixed (`BEGIN_*`, `ARGUMENT(S)*`, `MODULE`)
        XS_CODE_ARGUMENT | XS_CODE_ARGUMENTS | XS_CODE_ARGUMENTS_SLOPPY
        | XS_CODE_ARGUMENTS_STRICT | XS_CODE_BEGIN_SLOPPY | XS_CODE_BEGIN_STRICT
        | XS_CODE_BEGIN_STRICT_BASE | XS_CODE_BEGIN_STRICT_DERIVED
        | XS_CODE_BEGIN_STRICT_FIELD | XS_CODE_MODULE => {
            *size += 2;
        }
        XS_CODE_LINE => *size += 3,
        // string: string bytes then width-select on length
        XS_CODE_STRING_1 => {
            if let Payload::Str { len, .. } = &c.payload {
                *size += *len;
            }
            width_select_index_family(c, size);
        }
        XS_CODE_RESERVE_1 | XS_CODE_RETRIEVE_1 | XS_CODE_UNWIND_1 => {
            width_select_index_family(c, size);
        }
        XS_CODE_INTEGER_1 | XS_CODE_RUN_1 | XS_CODE_RUN_TAIL_1 => {
            width_select_integer_family(c, size);
        }
        XS_CODE_NUMBER => *size += 9,
        // bigint: width-select on the measure, then the limb bytes
        XS_CODE_BIGINT_1 => {
            let measure = match &c.payload {
                Payload::BigInt { measure, .. } => *measure,
                _ => 0,
            };
            if measure > 255 {
                c.id += 1;
                *size += 3;
            } else {
                *size += 2;
            }
            *size += measure;
        }
        XS_CODE_HOST => *size += 3,
        _ => {
            if is_symbol_op(c.id) {
                *size += 1 + ID_SIZE;
            } else if is_index_plus_one_1(c.id) {
                width_select_index_plus_one_family(c, size);
            } else {
                *size += 1;
            }
        }
    }
}

/// The `INTEGER`/`STRING`/`RESERVE` width selector when the width key is
/// the raw index/length (`value > 255` / `> 65535`).
fn width_select_index_family(c: &mut Code, size: &mut i32) {
    let value = match &c.payload {
        Payload::Index { index, .. } => *index,
        Payload::Str { len, .. } => *len,
        _ => 0,
    };
    if value > 65535 {
        c.id += 2;
        *size += 5;
    } else if value > 255 {
        c.id += 1;
        *size += 3;
    } else {
        *size += 2;
    }
}

/// The local/closure family (`GET_LOCAL_1`…) width selector: the key is
/// `index + 1`.
fn width_select_index_plus_one_family(c: &mut Code, size: &mut i32) {
    let value = match &c.payload {
        Payload::Index { index, .. } => *index + 1,
        _ => 0,
    };
    if value > 65535 {
        c.id += 2;
        *size += 5;
    } else if value > 255 {
        c.id += 1;
        *size += 3;
    } else {
        *size += 2;
    }
}

/// The signed-integer family (`INTEGER_1`/`RUN_1`) width selector.
fn width_select_integer_family(c: &mut Code, size: &mut i32) {
    let value = match &c.payload {
        Payload::Integer { value } => *value,
        _ => 0,
    };
    if value < -32768 || value > 32767 {
        c.id += 2;
        *size += 5;
    } else if value < -128 || value > 127 {
        c.id += 1;
        *size += 3;
    } else {
        *size += 2;
    }
}

/// Pass 2: with pass-1 target offsets known, choose each branch's real
/// width (narrowing `size` and drawing down `delta`), and re-record
/// target offsets against the narrowed `size`.
fn size2_step(c: &mut Code, size: &mut i32, delta: &mut i32, targets: &mut [Target]) {
    match c.id {
        XS_NO_CODE => {
            if let Payload::Target { tid } = c.payload {
                targets[tid].offset = *size;
            }
        }
        XS_CODE_BRANCH_1 | XS_CODE_BRANCH_CHAIN_1 | XS_CODE_BRANCH_COALESCE_1
        | XS_CODE_BRANCH_ELSE_1 | XS_CODE_BRANCH_IF_1 | XS_CODE_BRANCH_STATUS_1
        | XS_CODE_CATCH_1 | XS_CODE_CODE_1 => {
            let tid = match c.payload {
                Payload::Branch { tid } => tid,
                _ => unreachable!(),
            };
            let offset = targets[tid].offset - (*size + 5);
            if offset < -32768 || offset + *delta > 32767 {
                c.id += 2;
                *size += 5;
            } else if offset < -128 || offset + *delta > 127 {
                c.id += 1;
                *delta -= 2;
                *size += 3;
            } else {
                *delta -= 3;
                *size += 2;
            }
        }
        XS_CODE_ARGUMENT | XS_CODE_ARGUMENTS | XS_CODE_ARGUMENTS_SLOPPY
        | XS_CODE_ARGUMENTS_STRICT | XS_CODE_BEGIN_SLOPPY | XS_CODE_BEGIN_STRICT
        | XS_CODE_BEGIN_STRICT_BASE | XS_CODE_BEGIN_STRICT_DERIVED
        | XS_CODE_BEGIN_STRICT_FIELD | XS_CODE_MODULE => {
            *size += 2;
        }
        XS_CODE_LINE => *size += 3,
        XS_CODE_INTEGER_1 | XS_CODE_RUN_1 | XS_CODE_RUN_TAIL_1 => *size += 2,
        XS_CODE_INTEGER_2 | XS_CODE_RUN_2 | XS_CODE_RUN_TAIL_2 => *size += 3,
        XS_CODE_INTEGER_4 | XS_CODE_RUN_4 | XS_CODE_RUN_TAIL_4 => *size += 5,
        XS_CODE_NUMBER => *size += 9,
        XS_CODE_STRING_1 => {
            if let Payload::Str { len, .. } = &c.payload {
                *size += 2 + *len;
            }
        }
        XS_CODE_STRING_2 => {
            if let Payload::Str { len, .. } = &c.payload {
                *size += 3 + *len;
            }
        }
        XS_CODE_STRING_4 => {
            if let Payload::Str { len, .. } = &c.payload {
                *size += 5 + *len;
            }
        }
        XS_CODE_BIGINT_1 => {
            if let Payload::BigInt { measure, .. } = &c.payload {
                *size += 2 + *measure;
            }
        }
        XS_CODE_BIGINT_2 => {
            if let Payload::BigInt { measure, .. } = &c.payload {
                *size += 3 + *measure;
            }
        }
        XS_CODE_HOST => *size += 3,
        _ => {
            if is_symbol_op(c.id) {
                *size += 1 + ID_SIZE;
            } else if is_index_1_fixed(c.id) {
                *size += 2;
            } else if is_index_2_fixed(c.id) {
                *size += 3;
            } else {
                *size += 1;
            }
        }
    }
}

/// Pass 3: emit the opcode byte and its operand with the chosen width.
fn emit_step(c: &Code, out: &mut Vec<u8>, targets: &[Target], sym_ids: &[i32]) {
    if c.id != XS_NO_CODE {
        out.push(c.id as u8);
    }
    match c.id {
        XS_NO_CODE => {}
        // branch _1/_2/_4: displacement from just past the operand
        XS_CODE_BRANCH_1 | XS_CODE_BRANCH_CHAIN_1 | XS_CODE_BRANCH_COALESCE_1
        | XS_CODE_BRANCH_ELSE_1 | XS_CODE_BRANCH_IF_1 | XS_CODE_BRANCH_STATUS_1
        | XS_CODE_CATCH_1 | XS_CODE_CODE_1 => {
            let tid = branch_tid(c);
            let offset = targets[tid].offset - (out.len() as i32 + 1);
            out.push(offset as i8 as u8);
        }
        XS_CODE_BRANCH_2 | XS_CODE_BRANCH_CHAIN_2 | XS_CODE_BRANCH_COALESCE_2
        | XS_CODE_BRANCH_ELSE_2 | XS_CODE_BRANCH_IF_2 | XS_CODE_BRANCH_STATUS_2
        | XS_CODE_CATCH_2 | XS_CODE_CODE_2 => {
            let tid = branch_tid(c);
            let offset = targets[tid].offset - (out.len() as i32 + 2);
            out.extend_from_slice(&(offset as i16).to_le_bytes());
        }
        XS_CODE_BRANCH_4 | XS_CODE_BRANCH_CHAIN_4 | XS_CODE_BRANCH_COALESCE_4
        | XS_CODE_BRANCH_ELSE_4 | XS_CODE_BRANCH_IF_4 | XS_CODE_BRANCH_STATUS_4
        | XS_CODE_CATCH_4 | XS_CODE_CODE_4 => {
            let tid = branch_tid(c);
            let offset = targets[tid].offset - (out.len() as i32 + 4);
            out.extend_from_slice(&offset.to_le_bytes());
        }
        // 2-byte fixed u1 (BEGIN_*, ARGUMENT(S), MODULE, RESERVE/RETRIEVE/UNWIND_1)
        XS_CODE_ARGUMENT | XS_CODE_ARGUMENTS | XS_CODE_ARGUMENTS_SLOPPY
        | XS_CODE_ARGUMENTS_STRICT | XS_CODE_BEGIN_SLOPPY | XS_CODE_BEGIN_STRICT
        | XS_CODE_BEGIN_STRICT_BASE | XS_CODE_BEGIN_STRICT_DERIVED
        | XS_CODE_BEGIN_STRICT_FIELD | XS_CODE_MODULE | XS_CODE_RESERVE_1
        | XS_CODE_RETRIEVE_1 | XS_CODE_UNWIND_1 => {
            out.push(index_value(c) as u8);
        }
        XS_CODE_LINE | XS_CODE_RESERVE_2 | XS_CODE_RETRIEVE_2 | XS_CODE_UNWIND_2 => {
            out.extend_from_slice(&(index_value(c) as u16).to_le_bytes());
        }
        XS_CODE_INTEGER_1 | XS_CODE_RUN_1 | XS_CODE_RUN_TAIL_1 => {
            out.push(integer_value(c) as i8 as u8);
        }
        XS_CODE_INTEGER_2 | XS_CODE_RUN_2 | XS_CODE_RUN_TAIL_2 => {
            out.extend_from_slice(&(integer_value(c) as i16).to_le_bytes());
        }
        XS_CODE_INTEGER_4 | XS_CODE_RUN_4 | XS_CODE_RUN_TAIL_4 => {
            out.extend_from_slice(&integer_value(c).to_le_bytes());
        }
        XS_CODE_NUMBER => {
            if let Payload::Number { value } = &c.payload {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
        XS_CODE_STRING_1 => {
            if let Payload::Str { bytes, len } = &c.payload {
                out.push(*len as u8);
                out.extend_from_slice(bytes);
            }
        }
        XS_CODE_STRING_2 => {
            if let Payload::Str { bytes, len } = &c.payload {
                out.extend_from_slice(&(*len as u16).to_le_bytes());
                out.extend_from_slice(bytes);
            }
        }
        XS_CODE_STRING_4 => {
            if let Payload::Str { bytes, len } = &c.payload {
                out.extend_from_slice(&len.to_le_bytes());
                out.extend_from_slice(bytes);
            }
        }
        XS_CODE_BIGINT_1 => {
            if let Payload::BigInt { bytes, measure } = &c.payload {
                out.push(*measure as u8);
                out.extend_from_slice(bytes);
            }
        }
        XS_CODE_BIGINT_2 => {
            if let Payload::BigInt { bytes, measure } = &c.payload {
                out.extend_from_slice(&(*measure as u16).to_le_bytes());
                out.extend_from_slice(bytes);
            }
        }
        XS_CODE_HOST => {
            out.extend_from_slice(&(index_value(c) as u16).to_le_bytes());
        }
        _ => {
            if is_symbol_op(c.id) {
                out.extend_from_slice(&(symbol_id(c, sym_ids) as u16).to_le_bytes());
            } else if is_index_1_fixed(c.id) {
                out.push((index_value(c) + 1) as u8);
            } else if is_index_2_fixed(c.id) {
                out.extend_from_slice(&((index_value(c) + 1) as u16).to_le_bytes());
            }
            // else: a plain 1-byte opcode, already pushed
        }
    }
}

// --------------------------- payload readers ---------------------------

fn branch_tid(c: &Code) -> usize {
    match c.payload {
        Payload::Branch { tid } => tid,
        _ => 0,
    }
}
fn index_value(c: &Code) -> i32 {
    match &c.payload {
        Payload::Index { index, .. } => *index,
        _ => 0,
    }
}
fn integer_value(c: &Code) -> i32 {
    match &c.payload {
        Payload::Integer { value } => *value,
        _ => 0,
    }
}
fn symbol_id(c: &Code, sym_ids: &[i32]) -> i32 {
    match &c.payload {
        Payload::Symbol { sym } => sym_ids[*sym],
        _ => 0,
    }
}

/// `sizeof(txID)` at the oracle pin (`mx32bitID` undefined → 2 bytes),
/// matching `ironhorse_vm::opcode::ID_SIZE`.
const ID_SIZE: i32 = 2;

/// XS stores a BigInt literal as `bigint->data`: an array of `txU4` limbs
/// in machine (little-endian) byte order, `bigint->size` of them, trimmed
/// of high zero limbs but never below one limb (so `0n` is one zero
/// limb). `fxBigIntEncode` memcpys those limb bytes; `fxBigIntMeasure` is
/// `size * 4`. The parse path (decimal `fxBigIntParse`, or the shift-based
/// hex/octal/binary parsers) all converge on the same canonical limbs, so
/// a radix-accumulate reproduces `data` exactly. Returns the limb bytes.
fn bigint_limbs_le(digits: &str, radix: u32) -> Vec<u8> {
    let mut limbs: Vec<u32> = vec![0];
    for ch in digits.chars() {
        let d = ch.to_digit(radix).expect("bigint digit in radix") as u64;
        // limbs = limbs * radix + d  (base 2^32, little-endian)
        let mut carry = d;
        for limb in limbs.iter_mut() {
            let v = (*limb as u64) * (radix as u64) + carry;
            *limb = v as u32;
            carry = v >> 32;
        }
        while carry > 0 {
            limbs.push(carry as u32);
            carry >>= 32;
        }
    }
    while limbs.len() > 1 && *limbs.last().unwrap() == 0 {
        limbs.pop();
    }
    let mut bytes = Vec::with_capacity(limbs.len() * 4);
    for l in limbs {
        bytes.extend_from_slice(&l.to_le_bytes());
    }
    bytes
}

// --------------------------- opcode classes ----------------------------

/// The symbol-operand opcodes (`1 + sizeof(txID)` bytes): the
/// `GET_VARIABLE`/`SET_PROPERTY`/`NEW_LOCAL`… set XS lists together.
fn is_symbol_op(id: i32) -> bool {
    matches!(
        id,
        XS_CODE_ASYNC_FUNCTION
            | XS_CODE_ASYNC_GENERATOR_FUNCTION
            | XS_CODE_CONSTRUCTOR_FUNCTION
            | XS_CODE_DELETE_PROPERTY
            | XS_CODE_DELETE_SUPER
            | XS_CODE_FILE
            | XS_CODE_FUNCTION
            | XS_CODE_GENERATOR_FUNCTION
            | XS_CODE_GET_PROPERTY
            | XS_CODE_GET_SUPER
            | XS_CODE_GET_THIS_VARIABLE
            | XS_CODE_GET_VARIABLE
            | XS_CODE_EVAL_PRIVATE
            | XS_CODE_EVAL_REFERENCE
            | XS_CODE_NAME
            | XS_CODE_NEW_CLOSURE
            | XS_CODE_NEW_LOCAL
            | XS_CODE_NEW_PROPERTY
            | XS_CODE_PROGRAM_REFERENCE
            | XS_CODE_SET_PROPERTY
            | XS_CODE_SET_SUPER
            | XS_CODE_SET_VARIABLE
            | XS_CODE_SYMBOL
            | XS_CODE_PROFILE
    )
}

/// The `_1` local/closure/private/store family whose serialized value is
/// `index + 1` and whose width is selected on that.
fn is_index_plus_one_1(id: i32) -> bool {
    matches!(
        id,
        XS_CODE_CONST_CLOSURE_1
            | XS_CODE_CONST_LOCAL_1
            | XS_CODE_GET_CLOSURE_1
            | XS_CODE_GET_LOCAL_1
            | XS_CODE_GET_PRIVATE_1
            | XS_CODE_HAS_PRIVATE_1
            | XS_CODE_LET_CLOSURE_1
            | XS_CODE_LET_LOCAL_1
            | XS_CODE_NEW_PRIVATE_1
            | XS_CODE_PULL_CLOSURE_1
            | XS_CODE_PULL_LOCAL_1
            | XS_CODE_REFRESH_CLOSURE_1
            | XS_CODE_REFRESH_LOCAL_1
            | XS_CODE_RESET_CLOSURE_1
            | XS_CODE_RESET_LOCAL_1
            | XS_CODE_SET_CLOSURE_1
            | XS_CODE_SET_LOCAL_1
            | XS_CODE_SET_PRIVATE_1
            | XS_CODE_STORE_1
            | XS_CODE_USED_1
            | XS_CODE_VAR_CLOSURE_1
            | XS_CODE_VAR_LOCAL_1
    )
}

/// Pass-2 fixed 2-byte forms: the `_1` local/closure family (already
/// width-selected in pass 1) plus `RESERVE_1`/`RETRIEVE_1`/`UNWIND_1`.
fn is_index_1_fixed(id: i32) -> bool {
    is_index_plus_one_1(id)
        || matches!(id, XS_CODE_RESERVE_1 | XS_CODE_RETRIEVE_1 | XS_CODE_UNWIND_1)
}

/// Pass-2 fixed 3-byte forms: the `_2` local/closure family plus
/// `RESERVE_2`/`RETRIEVE_2`/`UNWIND_2`.
fn is_index_2_fixed(id: i32) -> bool {
    matches!(
        id,
        XS_CODE_CONST_CLOSURE_2
            | XS_CODE_CONST_LOCAL_2
            | XS_CODE_GET_CLOSURE_2
            | XS_CODE_GET_LOCAL_2
            | XS_CODE_GET_PRIVATE_2
            | XS_CODE_HAS_PRIVATE_2
            | XS_CODE_LET_CLOSURE_2
            | XS_CODE_LET_LOCAL_2
            | XS_CODE_NEW_PRIVATE_2
            | XS_CODE_PULL_CLOSURE_2
            | XS_CODE_PULL_LOCAL_2
            | XS_CODE_REFRESH_CLOSURE_2
            | XS_CODE_REFRESH_LOCAL_2
            | XS_CODE_RESET_CLOSURE_2
            | XS_CODE_RESET_LOCAL_2
            | XS_CODE_SET_CLOSURE_2
            | XS_CODE_SET_LOCAL_2
            | XS_CODE_SET_PRIVATE_2
            | XS_CODE_STORE_2
            | XS_CODE_USED_2
            | XS_CODE_VAR_CLOSURE_2
            | XS_CODE_VAR_LOCAL_2
            | XS_CODE_RESERVE_2
            | XS_CODE_RETRIEVE_2
            | XS_CODE_UNWIND_2
    )
}

// --------------------------- token → opcode ----------------------------

/// `description->code` for the value leaves (`fxValueNodeCode`).
fn value_code(token: Token) -> i32 {
    match token {
        Token::True => XS_CODE_TRUE,
        Token::False => XS_CODE_FALSE,
        Token::Null => XS_CODE_NULL,
        Token::Undefined => XS_CODE_UNDEFINED,
        _ => unreachable!("not a value leaf: {:?}", token),
    }
}

/// `description->code` for the unary operators (`fxUnaryExpressionNodeCode`).
fn unary_code(token: Token) -> i32 {
    match token {
        Token::Void => XS_CODE_VOID,
        Token::Not => XS_CODE_NOT,
        Token::BitNot => XS_CODE_BIT_NOT,
        Token::Minus => XS_CODE_MINUS,
        Token::Plus => XS_CODE_PLUS,
        Token::Typeof => XS_CODE_TYPEOF,
        _ => unreachable!("not a unary op: {:?}", token),
    }
}

/// `fxNodeCodeName` — whether an assigned value is an anonymous
/// function / generator / class that should receive an inferred `.name`.
/// The trigger node kinds are not in the ported surface, so this is
/// always `false` for now (a named edge for the function/class slice).
fn node_code_name(_value: &Item) -> bool {
    false
}

/// The arithmetic opcode a compound assignment folds with
/// (`description->code` for the `*Assign` tokens).
fn compound_op(token: Token) -> i32 {
    match token {
        Token::AddAssign => XS_CODE_ADD,
        Token::SubtractAssign => XS_CODE_SUBTRACT,
        Token::MultiplyAssign => XS_CODE_MULTIPLY,
        Token::DivideAssign => XS_CODE_DIVIDE,
        Token::ModuloAssign => XS_CODE_MODULO,
        Token::ExponentiationAssign => XS_CODE_EXPONENTIATION,
        Token::BitAndAssign => XS_CODE_BIT_AND,
        Token::BitOrAssign => XS_CODE_BIT_OR,
        Token::BitXorAssign => XS_CODE_BIT_XOR,
        Token::LeftShiftAssign => XS_CODE_LEFT_SHIFT,
        Token::SignedRightShiftAssign => XS_CODE_SIGNED_RIGHT_SHIFT,
        Token::UnsignedRightShiftAssign => XS_CODE_UNSIGNED_RIGHT_SHIFT,
        _ => unreachable!("not a compound-assign op: {:?}", token),
    }
}

/// `description->code` for the binary operators (`fxBinaryExpressionNodeCode`),
/// exactly `gxTokenDescriptions`' `code` column.
fn binary_code(token: Token) -> i32 {
    match token {
        Token::Add => XS_CODE_ADD,
        Token::Subtract => XS_CODE_SUBTRACT,
        Token::Multiply => XS_CODE_MULTIPLY,
        Token::Divide => XS_CODE_DIVIDE,
        Token::Modulo => XS_CODE_MODULO,
        Token::Exponentiation => XS_CODE_EXPONENTIATION,
        Token::BitAnd => XS_CODE_BIT_AND,
        Token::BitOr => XS_CODE_BIT_OR,
        Token::BitXor => XS_CODE_BIT_XOR,
        Token::LeftShift => XS_CODE_LEFT_SHIFT,
        Token::SignedRightShift => XS_CODE_SIGNED_RIGHT_SHIFT,
        Token::UnsignedRightShift => XS_CODE_UNSIGNED_RIGHT_SHIFT,
        Token::Equal => XS_CODE_EQUAL,
        Token::NotEqual => XS_CODE_NOT_EQUAL,
        Token::StrictEqual => XS_CODE_STRICT_EQUAL,
        Token::StrictNotEqual => XS_CODE_STRICT_NOT_EQUAL,
        Token::Less => XS_CODE_LESS,
        Token::LessEqual => XS_CODE_LESS_EQUAL,
        Token::More => XS_CODE_MORE,
        Token::MoreEqual => XS_CODE_MORE_EQUAL,
        Token::Instanceof => XS_CODE_INSTANCEOF,
        Token::In => XS_CODE_IN,
        _ => unreachable!("not a binary op: {:?}", token),
    }
}
