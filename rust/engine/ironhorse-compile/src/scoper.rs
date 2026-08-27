//! The scoper — a transliteration of the AST pass in
//! `c/moddable/xs/sources/xsScope.c` at the oracle pin (design § roadmap
//! row 5; Design Decisions 4 and 5). It runs between the parser
//! ([`crate::parser`], stage-5 children 2–3) and the coder (a later
//! child), performing XS's two dispatch passes over the tree:
//!
//!   * **hoist** ([`fxParserHoist`]): builds the scope tree
//!     (global/eval/function/module/block/`with`/`catch` scopes), hoists
//!     `var` / function declarations, records lexical (`let` / `const` /
//!     `using`) declarations with their duplicate-declaration early
//!     errors, and poisons scopes reached by direct `eval` / `with`.
//!   * **bind** ([`fxParserBind`]): resolves every identifier access to
//!     its declaration up the scope chain, marks captured declarations as
//!     **closure** slots, and computes each function's `scopeCount` — the
//!     frame slot count the coder consumes.
//!
//! **Why this shape is normative.** The coder downstream assigns each
//! declaration its final frame index by walking a scope's declare list in
//! order (`node->index = coder->scopeLevel++`, `xsCode.c` `fxScopeCoded`);
//! bytecode embeds those indices, so the *order and count* of declare
//! nodes in each scope, the closure flags, and the per-function
//! `scopeCount` are a byte-identity contract. This module reproduces XS's
//! exact declare ordering, counter arithmetic, and closure marking; the
//! fixture tests ([`tests`]) pin them as the contract for the coder child.
//!
//! **Representation.** XS mutates the AST in place, hanging a `txScope*`
//! off each scope-creating node and an `access->declaration` off each
//! identifier. The ironhorse AST ([`crate::ast`]) is an immutable value tree,
//! so instead this module keeps a scope **arena** ([`Scope`]) and keys the
//! per-node associations it needs (a node's scope, a node's hoist-time
//! extra flags) by the node's stable address. The observable result — the
//! scope tree, declare lists, counts, closure flags, `scopeCount`, and
//! access resolutions — is the same.
//!
//! Fold (named for the coder child, byte-identity is its bar): `using` /
//! `await using` are parser-folded at the pin already; class member →
//! init-function desugaring is likewise deferred to the coder, so class
//! scoping here covers the binding/heritage/`this` structure but not the
//! synthesized `constructorInit` / `instanceInit` bodies.

#![allow(clippy::needless_range_loop)]

use crate::ast::{flags, node_name, Item, Node};
use crate::parser::{ParseError, Parser};
use crate::token::Token;
use std::collections::HashMap;

// ============================ declare flags ============================

/// The `txDeclareNode`/`txScope` flag bits the scoper sets, at XS's exact
/// bit positions (`xsScript.h` enum) so a declare's flag word matches.
pub mod dflags {
    /// `mxDeclareNodeClosureFlag` — the declaration is captured by an
    /// inner function and lives in a closure slot, not a plain local.
    pub const CLOSURE: u32 = 1 << 12;
    /// `mxDeclareNodeUseClosureFlag` — an access reaches it through a
    /// closure alias.
    pub const USE_CLOSURE: u32 = 1 << 13;
    /// `mxDeclareNodeDisposableFlag` — the synthetic `const` slot a
    /// `using` declaration adds for its disposal record.
    pub const DISPOSABLE: u32 = 1 << 14;
    /// Ironhorse-only carry bit: the source declaration was `await using`.
    /// XS keeps this on the declaration AST node; the flattened scope tree
    /// needs it on the corresponding declare so reverse cleanup can emit
    /// `AWAIT` after invoking the disposer.
    pub const ASYNC_DISPOSABLE: u32 = 1 << 16;
    /// `mxDefineNodeBoundFlag` — a define node was already bound (guards
    /// the declare-list vs define-list double reach). Reserved for the
    /// deferred host-define scoping.
    #[allow(dead_code)]
    pub const BOUND: u32 = 1 << 15;
}

/// `mxEvalFlag` on a scope's own `flags` word (a scope reached by direct
/// `eval` / `with`). Same bit as [`flags::EVAL`].
pub const SCOPE_EVAL: u32 = flags::EVAL;
/// `mxStrictFlag` on a scope's `flags` word.
const SCOPE_STRICT: u32 = flags::STRICT;

// =============================== symbols ===============================

/// A declaration/access name. XS interns identifiers to `txSymbol*` and
/// compares by pointer; equal spellings share a pointer, so [`String`]
/// equality is faithful. [`Sym::Anon`] models XS's `symbol->ID == -1`
/// synthetic slots (class computed keys, init records) which never equal
/// a source name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Sym {
    Named(String),
    Anon(u32),
}

// ============================ declare node =============================

/// The module linkage a declaration carries when it is an import binding
/// or a re-export slot — a transliteration of the `txSpecifierNode` the
/// hoist pass hangs off `txDeclareNode.importSpecifier`. The coder reads
/// it in `fxScopeCodeSpecifierNodes` to emit the `TRANSFER` operands.
#[derive(Clone, Debug)]
pub struct ImportSpec {
    /// `specifier->from` — the module-specifier string (`from "m"`), as
    /// UTF-16 code units so the coder emits XS's CESU-8 `STRING_1`.
    pub from: Vec<u16>,
    /// `specifier->symbol` — the *imported* name (a named import's source
    /// name, or `*default*`), or `None` for a namespace / bare import.
    pub symbol: Option<String>,
    /// `specifier->with` — an import-attributes (`with { … }`) form, which
    /// selects `TRANSFER_JSON` over `TRANSFER`.
    pub with: bool,
}

/// One exported name a module-scope declaration answers to — a
/// transliteration of an entry on `txDeclareNode.firstExportSpecifier`.
/// The coder emits the export name (`asSymbol ? asSymbol : symbol`, or
/// `NULL`) per entry.
#[derive(Clone, Debug)]
pub struct ExportSpec {
    /// The exported name: `asSymbol ? asSymbol : symbol`, or `None` for an
    /// anonymous (`export *`) slot.
    pub name: Option<String>,
}

/// One declaration in a scope's declare list — a transliteration of the
/// `txDeclareNode` fields the scoper reads and writes. Carries a stable
/// `id` so define-list entries, closure aliases, and access resolutions
/// can reference it across the index shifts an `eval`-scope prepend or a
/// block placeholder removal cause.
#[derive(Clone, Debug)]
pub struct Declare {
    /// A scope-stable identity, unique within its owning [`Scope`].
    pub id: u32,
    /// `description->token`: `Arg` / `Var` / `Let` / `Const` / `Using` /
    /// `Define` / `Private` / `Specifier`, or [`Token::NoToken`] for the
    /// intermediate-block var placeholder and the function-scope closure
    /// alias.
    pub token: Token,
    /// The declared name, or `None` for an anonymous specifier slot.
    pub symbol: Option<Sym>,
    /// `node->flags` — closure / useClosure / disposable / bound bits.
    pub flags: u32,
    /// 1-based source line.
    pub line: u32,
    /// For a closure alias (`NoToken` in a function scope) the ancestor
    /// declaration it forwards to: `(scope, declare id)`.
    pub alias: Option<(usize, u32)>,
    /// `node->declaration != NULL` — set when this declaration was bound by a
    /// real declaration-statement self-lookup (`fxDeclareNodeBind` /
    /// `fxDefineNodeBind`). A synthesized slot (the injected `arguments`
    /// `Var`, a class's anonymous `instanceInit`/`constructorInit` closures) is
    /// never bind-dispatched, so it stays `false` and `fxScopeCodeStoreAll`
    /// does not capture it. Also `false` for a `var`/`Define` that resolved to
    /// nothing in a sloppy `Eval`/`Program` scope.
    pub bound: bool,
    /// `node->importSpecifier` — the import/re-export linkage when this is a
    /// module-scope import binding (`None` for a plain local).
    pub import_spec: Option<ImportSpec>,
    /// `node->firstExportSpecifier` — the exported names this declaration is
    /// bound to, in coder-emit order (XS prepends, so this is the reverse of
    /// source order across repeated exports of the same local).
    pub export_specs: Vec<ExportSpec>,
}

/// A define-list entry (`firstDefineNode`…). In XS the define node is the
/// same object as its declare-list entry, but a define covered by an
/// `arg` / `var` slot is in the define list yet absent from the declare
/// list, so the two lists are modeled separately. This list is coder
/// output (initializer emission order); the scoper binds each initializer
/// during the tree walk.
#[derive(Clone, Debug)]
pub struct DefineEntry {
    pub symbol: Option<Sym>,
    pub line: u32,
}

// ================================ scope ================================

/// One scope in the tree — a transliteration of `sxScope`.
#[derive(Clone, Debug)]
pub struct Scope {
    pub parent: Option<usize>,
    /// The scope kind: `Block` / `Function` / `Program` / `Eval` /
    /// `Module` / `With`.
    pub token: Token,
    /// `scope->flags`: `mxStrictFlag` (seeded from the node) plus
    /// `mxEvalFlag` if poisoned.
    pub flags: u32,
    /// The creating node's address, so `self->node->flags` can be read
    /// *live* (its `mxEvalFlag`/`mxArgumentsFlag` are set after creation).
    node_ptr: usize,
    /// The creating node's parse-time `flags` word (before hoist extras).
    node_base_flags: u32,
    /// The declare list, in XS's order (`firstDeclareNode`…). Removals in
    /// [`fx_scope_hoisted`] are applied here.
    pub declares: Vec<Declare>,
    /// The define list, in define order (coder output).
    pub defines: Vec<DefineEntry>,
    /// The next declare id to hand out in this scope.
    next_id: u32,
    /// `declareNodeCount` — the counter, which diverges from
    /// `declares.len()` after the program/eval `var`/define discount.
    pub declare_count: i32,
    /// `closureNodeCount`.
    pub closure_count: i32,
    /// `defineNodeCount`.
    pub define_count: i32,
    /// `disposableNodeCount`.
    pub disposable_count: i32,
    /// `mxDefaultFlag` was propagated here by [`fx_scope_arrow`] — an
    /// arrow function that transitively uses `this` / `super` / `target`.
    pub arrow_default: bool,
    /// Whether this scope's creating node carries `mxArrowFlag`. Read by the
    /// coder's `fxScopeCodeRetrieve`/`fxScopeCodeStore` mirror, whose
    /// receiver-capture (`RETRIEVE_TARGET`/`RETRIEVE_THIS`/`STORE_ARROW`)
    /// condition is `arrow && (default || eval)`; the eval half needs the
    /// bare arrow-ness, not just the `arrow_default` conjunction.
    pub is_arrow: bool,
    /// Whether this scope's node carries the **direct-`eval`** hoist extra
    /// (`hoist_call`'s `add_extra`), as opposed to a `with`-poisoned scope
    /// (which sets [`SCOPE_EVAL`] on `flags` but leaves the node clean). The
    /// coder's `fxScopeCodingBody`/`fxScopeCodedBody` key on this, not on the
    /// poisoned `flags`. Computed once the node's extras are populated
    /// ([`fx_scope_hoisted`]).
    pub direct_eval: bool,
}

impl Scope {
    /// The creating node's own `mxEvalFlag` — set at *parse* on a function
    /// that contains a direct `eval`, and (per `fxArrowExpression`) bubbled
    /// out of an enclosing arrow onto the nearest non-arrow function node.
    /// `fxScopeCodedBody` keys its two-`WITHOUT` teardown on this node flag
    /// (not the `with`-poisoned scope flag, and not `direct_eval` — which
    /// misses the enclosing-function case where the eval sits in a nested
    /// arrow). A `with`-poisoned scope leaves the node flag clean, so the
    /// teardown correctly stays off there.
    pub fn node_has_eval(&self) -> bool {
        self.node_base_flags & flags::EVAL != 0
    }

    fn new(parent: Option<usize>, token: Token, node_ptr: usize, node_base_flags: u32) -> Scope {
        Scope {
            parent,
            token,
            flags: node_base_flags & SCOPE_STRICT,
            node_ptr,
            node_base_flags,
            declares: Vec::new(),
            defines: Vec::new(),
            next_id: 0,
            declare_count: 0,
            closure_count: 0,
            define_count: 0,
            disposable_count: 0,
            arrow_default: false,
            is_arrow: node_base_flags & flags::ARROW != 0,
            direct_eval: false,
        }
    }
}

// ============================ access record ============================

/// The resolution the bind pass records for one identifier access, for
/// the fixture dump. XS writes `access->declaration`; here we log the
/// resolved `(scope, index)` or `None` for a global / `with` / eval
/// non-binding.
#[derive(Clone, Debug)]
pub struct AccessRecord {
    pub symbol: String,
    pub line: u32,
    pub resolved: Option<(usize, u32)>,
}

// =========================== scoper output ============================

/// The whole scoper result: the scope arena plus the access log and the
/// root scope index.
#[derive(Clone, Debug)]
pub struct ScopeTree {
    pub scopes: Vec<Scope>,
    pub root: usize,
    pub accesses: Vec<AccessRecord>,
    /// `scopeCount` per function/program/module scope, keyed by scope
    /// index (the coder's frame slot count).
    pub scope_counts: HashMap<usize, i32>,
    /// A scope-creating node's address → its scope(s): `.0` primary
    /// (`self->scope`), `.1` secondary (`statementScope`/`symbolScope`).
    /// The coder walks the *same* parsed tree the scoper walked, so a
    /// node's address keys back to the scope XS hung off it in place
    /// (`self->scope`, `xsScope.c`). Keyed with [`node_key`].
    pub node_scopes: HashMap<usize, (usize, Option<usize>)>,
    /// Per-node access resolution (see [`Scoper::resolutions`]): an
    /// `Access` / declaration / `Define` node address → the `(scope,
    /// declare id)` its symbol binds to, or `None` for the symbol path.
    /// Keyed with [`node_key`].
    pub resolutions: HashMap<usize, Option<(usize, u32)>>,
    /// A class node address → its synthesized `instanceInit` closure
    /// declare `(scope, id)` when the class has instance data fields.
    /// Keyed with [`node_key`].
    pub class_instance_init: HashMap<usize, (usize, u32)>,
    /// A `super(...)` node address → the capturing alias `(scope, id)` for
    /// the enclosing derived class's `instanceInit` closure. Keyed with
    /// [`node_key`].
    pub super_instance_init: HashMap<usize, (usize, u32)>,
    /// A class member node address (`PropertyAt` computed field /
    /// `PrivateProperty`) → the class-scope closure declares XS's
    /// `fxClassNodeHoist` creates for it (`atAccess` / `symbolAccess` /
    /// `valueAccess`). The coder reads these to emit the member-loop
    /// `CONST_CLOSURE` and the field function's `GET_CLOSURE` / `NEW_PRIVATE`.
    /// Keyed with [`node_key`].
    pub class_member_access: HashMap<usize, MemberAccess>,
    /// A class node address → the synthesized **instance** field-init
    /// function scope (XS's `instanceInit` function node scope) when the
    /// class's instance data fields are all plain (literal-keyed) data
    /// fields. The field initializers are bound inside this Function scope
    /// so a value that captures an outer binding promotes it to a closure
    /// (`fxClassNodeHoist`/`fxFunctionNodeBind`), and the coder reads the
    /// scope's use-closure aliases to `RESERVE`/`RETRIEVE`/`STORE` and to
    /// resolve each captured value access as a `GET_CLOSURE`. Absent when
    /// the class has a computed-key or private instance field (that path
    /// keeps the member-closure-only field function). Keyed with [`node_key`].
    pub class_field_init_inst: HashMap<usize, usize>,
    /// A class **member** node address (`PropertyAt` / `PrivateProperty`) →
    /// the **field-init function scope** use-closure alias declares its
    /// `atAccess` / `symbolAccess` / `valueAccess` resolve to (XS's
    /// `fxFieldNodeBind` looking each access up from inside the `instanceInit`
    /// function scope). Present only for a member bound inside a real
    /// field-init scope ([`ScopeTree::class_field_init_inst`]); the coder
    /// reads these to emit the field body's `GET_CLOSURE` / `NEW_PRIVATE`
    /// with the function-frame retrieve slot (not the class-scope index). A
    /// get/set accessor pair shares one brand slot (the `symbolAccess`
    /// use-closure dedups by symbol). Keyed with [`node_key`].
    pub class_member_fi: HashMap<usize, MemberAccess>,
    /// A class node address → its synthesized **static** field-init function
    /// scope (XS's `constructorInit` function node scope), when the class has
    /// static fields / `static { … }` blocks. Analogous to
    /// [`ScopeTree::class_field_init_inst`]; the coder reads it to drive the
    /// static field function's `RESERVE`/`RETRIEVE`/`STORE`. Keyed with
    /// [`node_key`].
    pub class_field_init_static: HashMap<usize, usize>,
}

/// The class-scope closure declares XS synthesizes for one computed-key /
/// private member (`atAccess`, `symbolAccess`, `valueAccess`). Each id
/// indexes the owning class's body scope.
#[derive(Clone, Copy, Debug, Default)]
pub struct MemberAccess {
    /// `PropertyAt.atAccess` — the computed key's `const` closure.
    pub at: Option<u32>,
    /// `PrivatePropertyNode.symbolAccess` — the private brand `const` closure.
    pub symbol: Option<u32>,
    /// `PrivatePropertyNode.valueAccess` — a private method/accessor's value
    /// `const` closure (absent for a private data field).
    pub value: Option<u32>,
}

/// The stable identity the scoper/coder use to associate a scope (and,
/// later, an access resolution) with a node: the node's address in the
/// parsed tree. Faithful to XS hanging `txScope*`/`access->declaration`
/// off the node in place — valid only while that tree is alive, which it
/// is for the whole compile.
pub fn node_key(n: &Node) -> usize {
    n as *const Node as usize
}

// ============================ entry points ============================

/// Parse `source` as a Script and run the scoper, returning the scope
/// tree or the first parser/scoper early error.
pub fn scope_program(source: &str, strict: bool) -> Result<ScopeTree, ParseError> {
    let mut parser = Parser::new(source, strict, false)?;
    let root = parser.parse_program(strict)?;
    run(&root)
}

/// Parse `source` as a Module and run the scoper.
pub fn scope_module(source: &str) -> Result<ScopeTree, ParseError> {
    let mut parser = Parser::new(source, true, true)?;
    let root = parser.parse_module()?;
    run(&root)
}

/// Run the two scoper passes over an already-parsed root node.
pub fn run(root: &Item) -> Result<ScopeTree, ParseError> {
    let root_node = match root {
        Item::Node(n) => n.as_ref(),
        _ => return Err(err(1, "invalid root")),
    };
    let mut s = Scoper::default();
    // fxParserHoist
    s.hoist_dispatch(root_node)?;
    // fxParserBind
    s.bind_dispatch(root_node)?;
    let root_scope = *s.node_scope.get(&node_ptr(root_node)).ok_or_else(|| err(root_node.line, "no root scope"))?;
    Ok(ScopeTree {
        scopes: s.scopes,
        root: root_scope.0,
        accesses: s.accesses,
        scope_counts: s.scope_counts,
        node_scopes: s.node_scope,
        resolutions: s.resolutions,
        class_instance_init: s.class_instance_init,
        super_instance_init: s.super_instance_init,
        class_member_access: s.class_member_access,
        class_field_init_inst: s.class_field_init_inst,
        class_member_fi: s.class_member_fi,
        class_field_init_static: s.class_field_init_static,
    })
}

// ============================ scoper state ============================

/// Ambient hoister/binder state threaded through the passes, plus the
/// arena and the by-address side tables the immutable AST needs.
#[derive(Default)]
struct Scoper {
    scopes: Vec<Scope>,
    /// `hoister->scope` / `binder->scope` — the current scope.
    scope: Option<usize>,
    /// `hoister->functionScope`.
    function_scope: Option<usize>,
    /// `hoister->bodyScope`.
    body_scope: Option<usize>,
    /// `hoister->environmentNode` (a node address).
    environment_node: Option<usize>,
    /// `binder->classNode` — the class node whose members are binding.
    /// (Reserved for the deferred class-scoping pass.)
    #[allow(dead_code)]
    class_node: Option<usize>,
    /// node address → its scope(s): `.0` primary (`self->scope`), `.1`
    /// secondary (`statementScope` / `symbolScope`).
    node_scope: HashMap<usize, (usize, Option<usize>)>,
    /// Hoist-time extra flags OR-ed onto a node (`self->node->flags |=`).
    node_extra: HashMap<usize, u32>,
    /// The binder frame counters.
    scope_level: i32,
    scope_maximum: i32,
    scope_counts: HashMap<usize, i32>,
    accesses: Vec<AccessRecord>,
    /// Per-node access resolution, keyed by the node's address: an
    /// `Access` / declaration / `Define` node → the `(scope, declare id)`
    /// its symbol binds to (XS's `access->declaration`), or `None` for a
    /// global / sloppy-eval-var / `with` access. The coder reads this to
    /// choose a slot op (`GET_LOCAL`/`LET_LOCAL`/…) over the symbol path.
    resolutions: HashMap<usize, Option<(usize, u32)>>,
    /// `hoister->firstExportLink` — the exported names seen so far, for
    /// duplicate-export detection.
    export_links: Vec<Sym>,
    /// Next anonymous-symbol id. (Reserved for class computed-key slots.)
    anon: u32,
    /// A class node address → its synthesized `instanceInit` closure
    /// declare `(scope, id)`, when the class has instance data fields
    /// (`self->instanceInitAccess->declaration`). The coder reads it to
    /// store the field function (`CONST_CLOSURE`) and the base constructor
    /// reads its capturing alias to call it after entry.
    class_instance_init: HashMap<usize, (usize, u32)>,
    /// A `super(...)` node address → the capturing alias `(scope, id)` for
    /// the enclosing derived class's `instanceInit` closure (XS's
    /// `superNode->instanceInitAccess->declaration`). The coder reads it to
    /// call the field initializer after `super(...)` installs `this`.
    super_instance_init: HashMap<usize, (usize, u32)>,
    /// A class member node address → its synthesized class-scope closure
    /// declares (`atAccess` / `symbolAccess` / `valueAccess`).
    class_member_access: HashMap<usize, MemberAccess>,
    /// A class node address → its synthesized instance field-init function
    /// scope (see [`ScopeTree::class_field_init_inst`]).
    class_field_init_inst: HashMap<usize, usize>,
    /// A class member node address → its field-init-function-scope member
    /// access aliases (see [`ScopeTree::class_member_fi`]).
    class_member_fi: HashMap<usize, MemberAccess>,
    /// A class node address → the instance field-init function scope created
    /// at **hoist** time (XS's `instanceInit` function node scope). The
    /// instance field VALUES are hoisted inside it so their nested
    /// function/class scopes chain through it (a value's inner function that
    /// reads an outer binding — or a private brand — captures via the field
    /// function, not the class scope). The bind pass re-enters this scope to
    /// bind the values and create the member-access use-closure aliases.
    class_field_init_hoist: HashMap<usize, usize>,
    /// A class node address → the **static** field-init function scope (XS's
    /// `constructorInit`) created at hoist time, holding the static field
    /// values and `static { … }` block bodies.
    class_field_init_static_hoist: HashMap<usize, usize>,
    /// A class node address → its bind-time static field-init function scope
    /// (see [`ScopeTree::class_field_init_static`]).
    class_field_init_static: HashMap<usize, usize>,
}

fn node_ptr(n: &Node) -> usize {
    n as *const Node as usize
}

fn err(line: u32, msg: &str) -> ParseError {
    ParseError { line, kind: crate::parser::ParseErrorKind::Syntax, message: msg.to_string() }
}

/// Whether a `delete` operand's reference target is a private member (so
/// `delete` of it is an early error). Unwraps a single-item parenthesized
/// sequence (`Expressions` with one item) recursively, mirroring the
/// coder's `codeDelete` dispatch; a multi-item sequence is a value-delete.
fn delete_target_is_private(item: &Item) -> bool {
    match item {
        Item::Node(n) => match n.token {
            Token::PrivateMember | Token::PrivateIdentifier => true,
            Token::Expressions => match n.children.first() {
                Some(Item::List(items)) if items.len() == 1 => delete_target_is_private(&items[0]),
                _ => false,
            },
            _ => false,
        },
        _ => false,
    }
}

// --------- child-slot accessors (positional, per the struct layout) ---------

fn child<'a>(n: &'a Node, i: usize) -> Option<&'a Item> {
    n.children.get(i)
}
fn child_node<'a>(n: &'a Node, i: usize) -> Option<&'a Node> {
    match n.children.get(i) {
        Some(Item::Node(b)) => Some(b.as_ref()),
        _ => None,
    }
}
fn child_sym(n: &Node, i: usize) -> Option<String> {
    match n.children.get(i) {
        Some(Item::Symbol(s)) => Some(s.clone()),
        _ => None,
    }
}
/// The UTF-16 units of a `String`-node child (a module specifier `from`
/// string), or `None` if the slot is not a string node.
fn child_str_units(n: &Node, i: usize) -> Option<Vec<u16>> {
    match n.children.get(i) {
        Some(Item::Node(b)) if b.token == Token::String => match &b.value {
            crate::ast::Value::Str(u) => Some(u.clone()),
            _ => None,
        },
        _ => None,
    }
}
/// Whether a class node (`children[2]` = member list) declares at least one
/// **instance** data field — a member with neither `static` nor a
/// method/getter/setter flag. Drives the `instanceInit` synthesis.
fn class_has_instance_field(class: &Node) -> bool {
    use crate::ast::flags as f;
    let members = match class.children.get(2) {
        Some(Item::List(v)) => v,
        _ => return false,
    };
    // XS's `instanceInitCount`: a non-static **data** field (no method flag)
    // OR a non-static **private** method/accessor (which desugars to an
    // instance-init field installing the private on `this`). A public
    // method/accessor and a `static { … }` block do not count.
    members.iter().any(|item| match item {
        Item::Node(m) => {
            let is_accessor = m.flags & (f::METHOD | f::GETTER | f::SETTER) != 0;
            let is_static = m.flags & f::STATIC != 0;
            if is_static {
                false
            } else if !is_accessor {
                m.token != Token::Body
            } else {
                m.token == Token::PrivateProperty
            }
        }
        _ => false,
    })
}
/// Whether the class has ≥1 member XS moves into the `constructorInit` field
/// function (`constructorInitCount`): a **static** data field, a **static**
/// private method/accessor, or a `static { … }` block. A public static method
/// does not count.
fn class_has_constructor_init_member(class: &Node) -> bool {
    use crate::ast::flags as f;
    let members = match class.children.get(2) {
        Some(Item::List(v)) => v,
        _ => return false,
    };
    members.iter().any(|item| match item {
        Item::Node(m) => {
            if m.token == Token::Body {
                return true; // static block
            }
            let is_accessor = m.flags & (f::METHOD | f::GETTER | f::SETTER) != 0;
            let is_static = m.flags & f::STATIC != 0;
            if !is_static {
                false
            } else if !is_accessor {
                true // static data field
            } else {
                m.token == Token::PrivateProperty // static private method
            }
        }
        _ => false,
    })
}
#[allow(dead_code)]
fn child_list<'a>(n: &'a Node, i: usize) -> Option<&'a [Item]> {
    match n.children.get(i) {
        Some(Item::List(v)) => Some(v.as_slice()),
        _ => None,
    }
}

impl Scoper {
    fn node_flags(&self, n: &Node) -> u32 {
        n.flags | self.node_extra.get(&node_ptr(n)).copied().unwrap_or(0)
    }
    fn add_extra(&mut self, ptr: usize, bits: u32) {
        *self.node_extra.entry(ptr).or_insert(0) |= bits;
    }
    fn scope_node_flags(&self, si: usize) -> u32 {
        let sc = &self.scopes[si];
        sc.node_base_flags | self.node_extra.get(&sc.node_ptr).copied().unwrap_or(0)
    }

    // ===================== scope helpers (xsScope.c top) =====================

    /// `fxScopeNew`.
    fn scope_new(&mut self, node: &Node, token: Token) -> usize {
        let parent = self.scope;
        let sc = Scope::new(parent, token, node_ptr(node), self.node_flags(node));
        let id = self.scopes.len();
        self.scopes.push(sc);
        self.scope = Some(id);
        id
    }

    /// Create a field-init function scope (XS's `instanceInit` /
    /// `constructorInit`) at hoist time, parented to the current (class body)
    /// scope, and hoist each member's value (or, for a `static { … }` block,
    /// its body) inside it so their inner scopes chain through the field
    /// function. `is_static` members carry a `Body` static block whose body is
    /// child 0; a data field's value is child 1. Returns the scope index.
    fn hoist_field_init_scope(
        &mut self,
        members: &[&Node],
        is_static: bool,
    ) -> Result<usize, ParseError> {
        let parent = self.scope;
        let mut sc = Scope::new(parent, Token::Function, 0, SCOPE_STRICT);
        sc.flags |= SCOPE_STRICT;
        let fi = self.scopes.len();
        self.scopes.push(sc);
        self.scope = Some(fi);
        let fs = self.function_scope;
        let bs = self.body_scope;
        self.function_scope = Some(fi);
        self.body_scope = Some(fi);
        for m in members {
            if is_static && m.token == Token::Body {
                // A static block: hoist its statements (child 0) directly.
                if let Some(body) = m.children.first() {
                    self.hoist_item(body)?;
                }
            } else if let Some(v) = m.children.get(1) {
                self.hoist_item(v)?;
            }
        }
        self.function_scope = fs;
        self.body_scope = bs;
        self.fx_scope_hoisted(fi);
        Ok(fi)
    }

    /// Look a class-member closure (identified by its class-scope declare id
    /// `class_id`) up from inside the field-init function scope `fi`, creating
    /// (or, for a shared getter/setter brand, reusing) the use-closure alias
    /// `fxFieldNodeBind` would via `fxScopeLookup`. Returns the alias's declare
    /// id in `fi` (the retrieve slot the coder reads for `GET_CLOSURE` /
    /// `NEW_PRIVATE`).
    fn field_init_alias(&mut self, fi: usize, class_scope: usize, class_id: u32) -> Option<u32> {
        let d = self.declare_ref(class_scope, class_id);
        let symbol = d.symbol.clone()?;
        let line = d.line;
        self.scope_lookup(fi, &symbol, line, false, false).map(|(_, id)| id)
    }

    /// Build a fresh declare with a scope-stable id, without inserting it.
    fn new_declare(&mut self, si: usize, token: Token, symbol: Option<Sym>, line: u32) -> Declare {
        let id = self.scopes[si].next_id;
        self.scopes[si].next_id += 1;
        Declare {
            id,
            token,
            symbol,
            flags: 0,
            line,
            alias: None,
            bound: false,
            import_spec: None,
            export_specs: Vec::new(),
        }
    }

    /// `fxScopeAddDeclareNode` — append (or, for an eval scope, prepend)
    /// and, for a `using`, add the disposal `const`. Returns the id.
    fn scope_add_declare(&mut self, si: usize, decl: Declare) -> u32 {
        let is_using = decl.token == Token::Using;
        let id = decl.id;
        let sc = &mut self.scopes[si];
        sc.declare_count += 1;
        if sc.token == Token::Eval {
            sc.declares.insert(0, decl);
        } else {
            sc.declares.push(decl);
        }
        if is_using {
            let mut d = self.new_declare(si, Token::Const, None, 0);
            d.flags |= dflags::DISPOSABLE;
            self.scope_add_declare(si, d);
            self.scopes[si].disposable_count += 1;
        }
        id
    }

    /// `fxScopeAddDefineNode` — append a define-list entry (define-order).
    fn scope_add_define(&mut self, si: usize, symbol: Option<Sym>, line: u32) {
        let sc = &mut self.scopes[si];
        sc.define_count += 1;
        sc.defines.push(DefineEntry { symbol, line });
    }

    /// `fxScopeGetDeclareNode` — linear symbol lookup, returning the id.
    fn scope_get_declare(&self, si: usize, symbol: &Sym) -> Option<u32> {
        let sc = &self.scopes[si];
        sc.declares.iter().find(|d| d.symbol.as_ref() == Some(symbol)).map(|d| d.id)
    }

    fn declare_mut(&mut self, si: usize, id: u32) -> &mut Declare {
        self.scopes[si].declares.iter_mut().find(|d| d.id == id).expect("declare id present")
    }
    fn declare_ref(&self, si: usize, id: u32) -> &Declare {
        self.scopes[si].declares.iter().find(|d| d.id == id).expect("declare id present")
    }

    /// `fxScopeEval` — poison a scope and every ancestor with `mxEvalFlag`.
    fn scope_eval(&mut self, mut si: Option<usize>) {
        while let Some(i) = si {
            self.scopes[i].flags |= SCOPE_EVAL;
            si = self.scopes[i].parent;
        }
    }

    /// `fxScopeArrow` — propagate `mxDefaultFlag` up to the nearest arrow
    /// function that transitively uses `this` / `super` / `new.target`.
    fn scope_arrow(&mut self, si: Option<usize>) {
        let mut cur = si;
        while let Some(i) = cur {
            let tok = self.scopes[i].token;
            if tok == Token::Eval || tok == Token::Program {
                return;
            } else if tok == Token::Function {
                if self.scope_node_flags(i) & flags::ARROW != 0 {
                    self.scopes[i].arrow_default = true;
                    cur = self.scopes[i].parent;
                    continue;
                }
                return;
            } else {
                cur = self.scopes[i].parent;
            }
        }
    }

    /// `fxScopeHoisted` — the count fix-ups when a scope closes.
    fn fx_scope_hoisted(&mut self, si: usize) {
        // The node's direct-`eval` extra is now populated (a body-level
        // `eval` call was hoisted before this). Record it so the coder can
        // tell a genuine direct `eval` from a `with`-poisoned scope.
        let ptr = self.scopes[si].node_ptr;
        if self.node_extra.get(&ptr).copied().unwrap_or(0) & SCOPE_EVAL != 0 {
            self.scopes[si].direct_eval = true;
        }
        let tok = self.scopes[si].token;
        if tok == Token::Block {
            // Drop the NoToken var placeholders; fix declareNodeCount. Ids
            // are stable so the define list needs no remap.
            let sc = &mut self.scopes[si];
            let mut removed = 0;
            sc.declares.retain(|d| {
                if d.token == Token::NoToken {
                    removed += 1;
                    false
                } else {
                    true
                }
            });
            sc.declare_count -= removed;
        } else if tok == Token::Program {
            let sc = &mut self.scopes[si];
            for d in &sc.declares {
                if d.token == Token::Define || d.token == Token::Var {
                    sc.declare_count -= 1;
                }
            }
        } else if tok == Token::Eval {
            let sc = &mut self.scopes[si];
            if sc.flags & SCOPE_STRICT == 0 {
                for d in &sc.declares {
                    if d.token == Token::Define || d.token == Token::Var {
                        sc.declare_count -= 1;
                    }
                }
            }
        }
        self.scope = self.scopes[si].parent;
    }
}

// ============================ fxScopeLookup ============================

impl Scoper {
    /// `fxScopeLookup` — resolve `symbol` up the scope chain from scope
    /// `si`, creating function-scope closure aliases as XS does. Returns
    /// the resolved `(scope, declare id)` or `None` for a global / `with`
    /// / eval-shadowed access. `closure_flag` marks captures.
    fn scope_lookup(
        &mut self,
        si: usize,
        symbol: &Sym,
        sym_line: u32,
        is_private_member: bool,
        closure_flag: bool,
    ) -> Option<(usize, u32)> {
        match self.scopes[si].token {
            Token::Eval => {
                let mut found = self.scope_get_declare(si, symbol);
                if let Some(id) = found {
                    let strict = self.scopes[si].flags & SCOPE_STRICT != 0;
                    let dtok = self.declare_ref(si, id).token;
                    if !strict && (dtok == Token::Var || dtok == Token::Define) {
                        found = None;
                    } else if closure_flag {
                        self.declare_mut(si, id).flags |= dflags::CLOSURE;
                    }
                }
                // XS's `fxScopeLookup` synthesizes a `Private` brand declare
                // here for a strict eval scope (`XS_TOKEN_PRIVATE_MEMBER`),
                // deferring the "undefined private property" check to run time.
                // The static oracle-shim compile drives the whole assembled
                // program as one eval goal, so this Eval scope is the top-level
                // program with no enclosing class — an unresolved `#name` at
                // this point is the `AllPrivateNamesValid` early error and can
                // never resolve at run time. Leaving `found = None` lets
                // `bind_private_member` report "invalid private identifier" (a
                // parse-phase rejection), matching XS's own SyntaxError verdict
                // for these sources. A future direct-eval implementation must
                // resolve a private name against the *real* enclosing private
                // environment, never a synthesized top-level brand.
                let _ = is_private_member;
                found.map(|id| (si, id))
            }
            Token::Function => {
                if let Some(id) = self.scope_get_declare(si, symbol) {
                    if closure_flag {
                        self.declare_mut(si, id).flags |= dflags::CLOSURE;
                    }
                    Some((si, id))
                } else if (self.scope_node_flags(si) & SCOPE_EVAL != 0)
                    && (self.scope_node_flags(si) & SCOPE_STRICT == 0)
                {
                    // eval can create variables that override closures
                    None
                } else if let Some(parent) = self.scopes[si].parent {
                    let resolved = self.scope_lookup(parent, symbol, sym_line, is_private_member, true);
                    if let Some((rscope, rid)) = resolved {
                        let rline = self.declare_ref(rscope, rid).line;
                        let mut alias = self.new_declare(si, Token::NoToken, Some(symbol.clone()), rline);
                        alias.flags |= dflags::CLOSURE | dflags::USE_CLOSURE;
                        alias.alias = Some((rscope, rid));
                        let aid = self.scope_add_declare(si, alias);
                        self.scopes[si].closure_count += 1;
                        Some((si, aid))
                    } else {
                        None
                    }
                } else {
                    None
                }
            }
            Token::Program => {
                if let Some(id) = self.scope_get_declare(si, symbol) {
                    let dtok = self.declare_ref(si, id).token;
                    if dtok == Token::Var || dtok == Token::Define {
                        None
                    } else {
                        Some((si, id))
                    }
                } else {
                    None
                }
            }
            Token::With => {
                // a with object can shadow any variable
                None
            }
            _ => {
                if let Some(id) = self.scope_get_declare(si, symbol) {
                    if closure_flag {
                        self.declare_mut(si, id).flags |= dflags::CLOSURE;
                    }
                    Some((si, id))
                } else if let Some(parent) = self.scopes[si].parent {
                    self.scope_lookup(parent, symbol, sym_line, is_private_member, closure_flag)
                } else {
                    None
                }
            }
        }
    }
}

// ============================== hoist pass ==============================

impl Scoper {
    /// `fxNodeDispatchHoist` — dispatch one node's hoist.
    fn hoist_dispatch(&mut self, node: &Node) -> Result<(), ParseError> {
        match node.token {
            Token::Program => self.hoist_program(node),
            Token::Module => self.hoist_module(node),
            Token::Block => self.hoist_block(node),
            Token::Body => self.hoist_body(node),
            Token::Function | Token::Generator => self.hoist_function(node),
            Token::Call | Token::New => self.hoist_call(node),
            Token::Catch => self.hoist_catch(node),
            Token::Coalesce => self.hoist_coalesce(node),
            Token::Arg | Token::Var | Token::Let | Token::Const | Token::Using => self.hoist_declare(node),
            Token::Define => self.hoist_define(node),
            Token::For => self.hoist_for(node),
            Token::ForIn | Token::ForOf | Token::ForAwaitOf => self.hoist_for_in_of(node),
            Token::Switch => self.hoist_switch(node),
            Token::With => self.hoist_with(node),
            Token::String => self.hoist_string(node),
            Token::Import => self.hoist_import(node),
            Token::Export => self.hoist_export(node),
            Token::Class => self.hoist_class(node),
            // fold: Host — deferred (see report).
            _ => self.hoist_children(node),
        }
    }

    /// `fxClassNodeHoist` — create the class's block scopes: a `symbolScope`
    /// binding the class name (a `const` closure visible in the body) when
    /// named, and the class body scope. The private / computed-key / field
    /// declares that populate the body scope are deferred; the method-only
    /// surface adds none. Children `[symbol, heritage, items, constructorInit,
    /// instanceInit, constructor]`.
    fn hoist_class(&mut self, node: &Node) -> Result<(), ParseError> {
        let former = self.class_node;
        let symbol = child_sym(node, 0);
        let mut symbol_scope = None;
        if let Some(sym) = &symbol {
            let ss = self.scope_new(node, Token::Block);
            let mut d = self.new_declare(ss, Token::Const, Some(Sym::Named(sym.clone())), node.line);
            d.flags |= dflags::CLOSURE;
            self.scope_add_declare(ss, d);
            symbol_scope = Some(ss);
        }
        if let Some(heritage) = child(node, 1) {
            self.hoist_item(heritage)?;
        }
        let si = self.scope_new(node, Token::Block);
        // Per-member class-scope closures (XS's `fxClassNodeHoist` member
        // loop): a computed-key **field** gets an anonymous `atAccess`
        // closure (its key, evaluated once at class-definition time); a
        // **private** member gets a named `symbolAccess` closure (the brand)
        // and, when it is a method/accessor, a second anonymous `valueAccess`
        // closure (the installed value). These precede the `instanceInit`
        // declare so the class-scope declare order — hence the `NEW_CLOSURE`
        // and `CONST_CLOSURE` slot order — matches XS.
        if let Some(Item::List(items)) = node.children.get(2) {
            for item in items {
                let Item::Node(m) = item else { continue };
                let is_accessor =
                    m.flags & (flags::METHOD | flags::GETTER | flags::SETTER) != 0;
                let mut access = MemberAccess::default();
                match m.token {
                    Token::PropertyAt if !is_accessor => {
                        let sym = Sym::Anon(self.anon);
                        self.anon += 1;
                        let mut d = self.new_declare(si, Token::Const, Some(sym), m.line);
                        d.flags |= dflags::CLOSURE;
                        access.at = Some(self.scope_add_declare(si, d));
                    }
                    Token::PrivateProperty => {
                        let name = child_sym(m, 0).map(Sym::Named);
                        // `fxClassNodeHoist`: PrivateBoundNames must not
                        // contain a duplicate, unless it is used exactly once
                        // as a (same-static) getter and once as a setter. The
                        // XOR of the two members' {static,getter,setter} bits
                        // is `getter|setter` in precisely that allowed case.
                        if let Some(sym_ref) = &name {
                            if let Some(existing_id) = self.scope_get_declare(si, sym_ref) {
                                let existing = self.declare_ref(si, existing_id).flags
                                    & (flags::STATIC | flags::GETTER | flags::SETTER);
                                let current =
                                    m.flags & (flags::STATIC | flags::GETTER | flags::SETTER);
                                if existing ^ current != (flags::GETTER | flags::SETTER) {
                                    return Err(err(m.line, "duplicate"));
                                }
                            }
                        }
                        let mut d = self.new_declare(si, Token::Const, name, m.line);
                        d.flags |= dflags::CLOSURE
                            | (m.flags & (flags::STATIC | flags::GETTER | flags::SETTER));
                        access.symbol = Some(self.scope_add_declare(si, d));
                        if is_accessor {
                            let sym = Sym::Anon(self.anon);
                            self.anon += 1;
                            let mut d = self.new_declare(si, Token::Const, Some(sym), m.line);
                            d.flags |= dflags::CLOSURE;
                            access.value = Some(self.scope_add_declare(si, d));
                        }
                    }
                    _ => continue,
                }
                self.class_member_access.insert(node_ptr(m), access);
            }
        }
        // A class with instance data fields synthesizes an `instanceInit`
        // closure (XS's `self->instanceInit` + `instanceInitAccess`): an
        // anonymous `const` closure declare in the class body scope, holding
        // the field-initializer function the constructor calls on entry.
        if class_has_instance_field(node) {
            let sym = Sym::Anon(self.anon);
            self.anon += 1;
            let mut d = self.new_declare(si, Token::Const, Some(sym), node.line);
            d.flags |= dflags::CLOSURE;
            let id = self.scope_add_declare(si, d);
            self.class_instance_init.insert(node_ptr(node), (si, id));
        }
        self.class_node = Some(node_ptr(node));
        if let Some(constructor) = child(node, 5) {
            self.hoist_item(constructor)?;
        }
        // Hoist each member's class-definition-time part under the class body
        // scope. XS moves every instance field's VALUE into the `instanceInit`
        // function and every static field's value / `static { … }` block into
        // the `constructorInit` function (`fxClassExpression`), so under the
        // class scope we hoist only the member stubs — a computed key, a
        // private method's function — and defer each field's value (and each
        // static block's body) to the matching field-init function scope. The
        // field values are collected in source order (XS's second-pass order;
        // private methods contribute no value).
        let engage = class_has_instance_field(node);
        let mut inst_data_values: Vec<&Node> = Vec::new();
        let mut static_ci_values: Vec<&Node> = Vec::new();
        if let Some(Item::List(items)) = node.children.get(2) {
            for item in items {
                let Item::Node(m) = item else {
                    self.hoist_item(item)?;
                    continue;
                };
                let is_accessor =
                    m.flags & (flags::METHOD | flags::GETTER | flags::SETTER) != 0;
                let is_static = m.flags & flags::STATIC != 0;
                let is_public_method = is_accessor && m.token != Token::PrivateProperty;
                if is_public_method {
                    self.hoist_item(item)?;
                    continue;
                }
                // A `static { … }` block's body runs inside the constructorInit
                // function scope.
                if m.token == Token::Body {
                    static_ci_values.push(m);
                    continue;
                }
                match m.token {
                    Token::PropertyAt => {
                        // Computed data field: hoist the key (child 0) under the
                        // class scope; the value moves to the field function.
                        if let Some(key) = m.children.first() {
                            self.hoist_item(key)?;
                        }
                        if is_static {
                            static_ci_values.push(m);
                        } else {
                            inst_data_values.push(m);
                        }
                    }
                    Token::PrivateProperty if is_accessor => {
                        // Private method: hoist its function under the class
                        // scope (no value moves to the field function).
                        if let Some(v) = m.children.get(1) {
                            self.hoist_item(v)?;
                        }
                    }
                    Token::PrivateProperty | Token::Property => {
                        // Private/plain data field: value moves to field fn.
                        if is_static {
                            static_ci_values.push(m);
                        } else {
                            inst_data_values.push(m);
                        }
                    }
                    _ => self.hoist_item(item)?,
                }
            }
        }
        // The instance field function scope (XS's `instanceInit`) and the
        // static field function scope (XS's `constructorInit`), hoisted after
        // the items. Created here so the field values' / static blocks' inner
        // scopes chain through them; the bind pass re-enters them. XS hoists
        // `constructorInit` before `instanceInit`.
        if class_has_constructor_init_member(node) {
            let ci = self.hoist_field_init_scope(&static_ci_values, true)?;
            self.class_field_init_static_hoist.insert(node_ptr(node), ci);
        }
        if engage {
            let fi = self.hoist_field_init_scope(&inst_data_values, false)?;
            self.class_field_init_hoist.insert(node_ptr(node), fi);
        }
        self.class_node = former;
        self.fx_scope_hoisted(si);
        if let Some(ss) = symbol_scope {
            self.fx_scope_hoisted(ss);
        }
        self.node_scope.insert(node_ptr(node), (si, symbol_scope));
        Ok(())
    }

    /// `fxNodeHoist` / `fxNodeDistribute` default — hoist every child node.
    fn hoist_children(&mut self, node: &Node) -> Result<(), ParseError> {
        for item in &node.children {
            self.hoist_item(item)?;
        }
        Ok(())
    }
    fn hoist_item(&mut self, item: &Item) -> Result<(), ParseError> {
        match item {
            Item::Node(n) => self.hoist_dispatch(n),
            Item::List(v) => {
                for it in v {
                    self.hoist_item(it)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn hoist_program(&mut self, node: &Node) -> Result<(), ParseError> {
        // XS: XS_TOKEN_EVAL when parser->flags has mxEvalFlag, else PROGRAM.
        let token = if self.node_flags(node) & SCOPE_EVAL != 0 { Token::Eval } else { Token::Program };
        let si = self.scope_new(node, token);
        self.function_scope = Some(si);
        self.body_scope = Some(si);
        self.node_scope.insert(node_ptr(node), (si, None));
        self.environment_node = Some(node_ptr(node));
        if let Some(body) = child(node, 0) {
            self.hoist_item(body)?;
        }
        self.environment_node = None;
        // self->variableCount = functionScope->declareNodeCount (coder use)
        self.fx_scope_hoisted(si);
        Ok(())
    }

    fn hoist_module(&mut self, node: &Node) -> Result<(), ParseError> {
        let si = self.scope_new(node, Token::Module);
        self.function_scope = Some(si);
        self.body_scope = Some(si);
        self.node_scope.insert(node_ptr(node), (si, None));
        self.environment_node = Some(node_ptr(node));
        if let Some(body) = child(node, 0) {
            self.hoist_item(body)?;
        }
        self.environment_node = None;
        self.fx_scope_hoisted(si);
        Ok(())
    }

    fn hoist_block(&mut self, node: &Node) -> Result<(), ParseError> {
        let si = self.scope_new(node, Token::Block);
        self.node_scope.insert(node_ptr(node), (si, None));
        if let Some(stmt) = child(node, 0) {
            self.hoist_item(stmt)?;
        }
        self.fx_scope_hoisted(si);
        Ok(())
    }

    fn hoist_body(&mut self, node: &Node) -> Result<(), ParseError> {
        let si = self.scope_new(node, Token::Block);
        self.body_scope = Some(si);
        self.node_scope.insert(node_ptr(node), (si, None));
        let env = self.environment_node;
        self.environment_node = Some(node_ptr(node));
        if let Some(stmt) = child(node, 0) {
            self.hoist_item(stmt)?;
        }
        self.environment_node = env;
        self.fx_scope_hoisted(si);
        Ok(())
    }

    fn hoist_function(&mut self, node: &Node) -> Result<(), ParseError> {
        let function_scope = self.function_scope;
        let body_scope = self.body_scope;
        let si = self.scope_new(node, Token::Function);
        self.function_scope = Some(si);
        self.body_scope = None;
        self.node_scope.insert(node_ptr(node), (si, None));
        // named function expression: a CONST self-binding define.
        if let Some(sym) = child_sym(node, 0) {
            let s = Sym::Named(sym);
            let d = self.new_declare(si, Token::Define, Some(s.clone()), node.line);
            self.scope_add_declare(si, d);
            self.scope_add_define(si, Some(s), node.line);
        }
        // params (children[1])
        if let Some(params) = child(node, 1) {
            self.hoist_item(params)?;
        }
        // `arguments` injection (`fxFunctionNodeHoist`, before the body).
        // A function that references or declares `arguments`, or that the
        // parser already marked as containing `eval`, has the flag *now* —
        // inject here, before the body's own `var arguments`/`arguments`
        // parameter is hoisted, so the two merge into one declare (XS relies
        // on the synthetic being present first).
        let injected = self.inject_arguments(si, node);
        // body (children[2])
        if let Some(body) = child(node, 2) {
            self.hoist_item(body)?;
        }
        // A *body-level direct `eval`* only marks the function node once its
        // call is hoisted (`hoist_call`'s `add_extra`), too late for the pass
        // above. Inject now if that discovery set the flag and nothing was
        // injected yet. Such a function has no `var arguments`/`arguments`
        // parameter (those would have set the flag at parse), so this never
        // double-injects; the body's declares live in the separate body
        // scope, so the `arguments` `Var` still follows the parameters.
        if !injected {
            self.inject_arguments(si, node);
        }
        self.fx_scope_hoisted(si);
        self.body_scope = body_scope;
        self.function_scope = function_scope;
        Ok(())
    }

    fn hoist_call(&mut self, node: &Node) -> Result<(), ParseError> {
        // children[0] = reference, children[1] = params
        if let Some(reference) = child_node(node, 0) {
            if reference.token == Token::Access {
                if let Some(sym) = child_sym(reference, 0) {
                    if sym == "eval" {
                        self.scope_eval(self.scope);
                        if let Some(fs) = self.function_scope {
                            let fptr = self.scopes[fs].node_ptr;
                            self.add_extra(fptr, flags::ARGUMENTS | SCOPE_EVAL);
                        }
                        if let Some(env) = self.environment_node {
                            self.add_extra(env, SCOPE_EVAL);
                        }
                        // params->flags |= mxEvalParametersFlag — coder use.
                    }
                }
            }
        }
        if let Some(reference) = child(node, 0) {
            self.hoist_item(reference)?;
        }
        if let Some(params) = child(node, 1) {
            self.hoist_item(params)?;
        }
        Ok(())
    }

    fn hoist_catch(&mut self, node: &Node) -> Result<(), ParseError> {
        // children[0] = parameter (or Null), children[1] = statement
        let has_param = matches!(child(node, 0), Some(Item::Node(_)));
        if has_param {
            let scope = self.scope_new(node, Token::Block);
            if let Some(param) = child(node, 0) {
                self.hoist_item(param)?;
            }
            let statement_scope = self.scope_new(node, Token::Block);
            if let Some(stmt) = child(node, 1) {
                self.hoist_item(stmt)?;
            }
            self.fx_scope_hoisted(statement_scope);
            self.fx_scope_hoisted(scope);
            self.node_scope.insert(node_ptr(node), (scope, Some(statement_scope)));
            // duplicate: a statementScope declare that also names a
            // parameter is a redeclaration error.
            let names: Vec<(Option<Sym>, u32)> = self.scopes[statement_scope]
                .declares
                .iter()
                .map(|d| (d.symbol.clone(), d.line))
                .collect();
            for (sym, line) in names {
                if let Some(s) = &sym {
                    if self.scope_get_declare(scope, s).is_some() {
                        return Err(err(line, "duplicate variable"));
                    }
                }
            }
        } else {
            let statement_scope = self.scope_new(node, Token::Block);
            if let Some(stmt) = child(node, 1) {
                self.hoist_item(stmt)?;
            }
            self.fx_scope_hoisted(statement_scope);
            self.node_scope.insert(node_ptr(node), (statement_scope, None));
        }
        Ok(())
    }

    fn hoist_coalesce(&mut self, node: &Node) -> Result<(), ParseError> {
        // early error: mixing ?? with && / || without parentheses
        if let Some(l) = child_node(node, 0) {
            if l.token == Token::And {
                return Err(err(node.line, "missing () around &&"));
            }
            if l.token == Token::Or {
                return Err(err(node.line, "missing () around ||"));
            }
        }
        if let Some(r) = child_node(node, 1) {
            if r.token == Token::And {
                return Err(err(node.line, "missing () around &&"));
            }
            if r.token == Token::Or {
                return Err(err(node.line, "missing () around ||"));
            }
        }
        self.hoist_children(node)
    }

    fn hoist_declare(&mut self, node: &Node) -> Result<(), ParseError> {
        let symbol = child_sym(node, 0).map(Sym::Named);
        let symbol = match symbol {
            Some(s) => s,
            None => return Ok(()),
        };
        let function_scope = self.function_scope.unwrap();
        let scope = self.scope.unwrap();
        if node.token == Token::Arg {
            if let Some(id) = self.scope_get_declare(function_scope, &symbol) {
                let dtok = self.declare_ref(function_scope, id).token;
                let fnf = self.scope_node_flags(function_scope);
                let dup_ctx = flags::ARROW | flags::ASYNC | flags::METHOD | flags::NOT_SIMPLE_PARAMETERS | flags::STRICT;
                if dtok == Token::Arg && (fnf & dup_ctx != 0) {
                    return Err(err(node.line, "duplicate argument"));
                }
            } else {
                let d = self.new_declare(function_scope, Token::Arg, Some(symbol), node.line);
                self.scope_add_declare(function_scope, d);
            }
        } else if node.token == Token::Const || node.token == Token::Let || node.token == Token::Using {
            let body_scope = self.body_scope.unwrap();
            let mut existing = self.scope_get_declare(scope, &symbol);
            if existing.is_none() && scope == body_scope {
                if let Some(id) = self.scope_get_declare(function_scope, &symbol) {
                    if self.declare_ref(function_scope, id).token != Token::Arg {
                        // arg-vs-lexical is a conflict; other tokens not
                    } else {
                        existing = Some(id);
                    }
                }
            }
            if existing.is_some() {
                return Err(err(node.line, "duplicate variable"));
            }
            let mut d = self.new_declare(scope, node.token, Some(symbol), node.line);
            if node.token == Token::Using && node.flags & flags::AWAITING != 0 {
                d.flags |= dflags::ASYNC_DISPOSABLE;
            }
            self.scope_add_declare(scope, d);
        } else {
            // VAR
            let body_scope = self.body_scope.unwrap();
            self.hoist_var(&symbol, node.line, scope, body_scope, function_scope)?;
        }
        Ok(())
    }

    fn hoist_var(
        &mut self,
        symbol: &Sym,
        line: u32,
        start_scope: usize,
        body_scope: usize,
        function_scope: usize,
    ) -> Result<(), ParseError> {
        let mut scope = start_scope;
        let mut conflict: Option<u32> = None;
        while scope != body_scope {
            if let Some(id) = self.scope_get_declare(scope, symbol) {
                let dtok = self.declare_ref(scope, id).token;
                if matches!(dtok, Token::Const | Token::Let | Token::Using | Token::Define) {
                    conflict = Some(id);
                    break;
                }
            }
            scope = self.scopes[scope].parent.unwrap_or(body_scope);
        }
        if conflict.is_none() {
            if let Some(id) = self.scope_get_declare(scope, symbol) {
                let dtok = self.declare_ref(scope, id).token;
                if matches!(dtok, Token::Const | Token::Let | Token::Using) {
                    conflict = Some(id);
                }
            }
        }
        if conflict.is_some() {
            return Err(err(line, "duplicate variable"));
        }
        // add to bodyScope unless already an arg/var in functionScope
        let cover = self
            .scope_get_declare(function_scope, symbol)
            .map(|id| self.declare_ref(function_scope, id).token)
            .map(|t| t == Token::Arg || t == Token::Var)
            .unwrap_or(false);
        if !cover {
            let d = self.new_declare(body_scope, Token::Var, Some(symbol.clone()), line);
            self.scope_add_declare(body_scope, d);
        }
        // placeholder NoToken in every intermediate block scope
        let mut sc = start_scope;
        while sc != body_scope {
            let d = self.new_declare(sc, Token::NoToken, Some(symbol.clone()), line);
            self.scope_add_declare(sc, d);
            sc = self.scopes[sc].parent.unwrap_or(body_scope);
        }
        Ok(())
    }

    fn hoist_define(&mut self, node: &Node) -> Result<(), ParseError> {
        // children[0] = symbol, children[1] = initializer (function)
        let symbol = match child_sym(node, 0) {
            Some(s) => Sym::Named(s),
            None => return Ok(()),
        };
        let scope = self.scope.unwrap();
        let body_scope = self.body_scope.unwrap();
        let function_scope = self.function_scope.unwrap();
        let strict = self.node_flags(node) & SCOPE_STRICT != 0;
        if strict {
            if let Sym::Named(s) = &symbol {
                if s == "arguments" || s == "eval" || s == "yield" {
                    return Err(err(node.line, "invalid definition"));
                }
            }
        }
        if scope == body_scope && self.scopes[scope].token != Token::Module {
            if let Some(id) = self.scope_get_declare(body_scope, &symbol) {
                let dtok = self.declare_ref(body_scope, id).token;
                if dtok == Token::Const || dtok == Token::Let {
                    return Err(err(node.line, "duplicate variable"));
                }
            } else {
                let mut have = false;
                if function_scope != body_scope {
                    have = self.scope_get_declare(function_scope, &symbol).is_some();
                }
                if !have {
                    let d = self.new_declare(body_scope, Token::Define, Some(symbol.clone()), node.line);
                    self.scope_add_declare(body_scope, d);
                }
            }
            self.scope_add_define(body_scope, Some(symbol.clone()), node.line);
        } else {
            if self.scope_get_declare(scope, &symbol).is_some() {
                return Err(err(node.line, "duplicate variable"));
            }
            let d = self.new_declare(scope, Token::Define, Some(symbol.clone()), node.line);
            self.scope_add_declare(scope, d);
            self.scope_add_define(scope, Some(symbol.clone()), node.line);
        }
        // dispatch the initializer (function), with its self-symbol nulled
        // (fxDefineNodeHoist nulls initializer->symbol so the function's
        // named-expression self-binding is not created for a declaration).
        if let Some(init) = child_node(node, 1) {
            self.hoist_function_no_self(init)?;
        }
        Ok(())
    }

    /// Hoist a function node but suppress the named-expression self CONST
    /// (used for a function *declaration*'s initializer).
    fn hoist_function_no_self(&mut self, node: &Node) -> Result<(), ParseError> {
        if node.token != Token::Function && node.token != Token::Generator {
            return self.hoist_dispatch(node);
        }
        let function_scope = self.function_scope;
        let body_scope = self.body_scope;
        let si = self.scope_new(node, Token::Function);
        self.function_scope = Some(si);
        self.body_scope = None;
        self.node_scope.insert(node_ptr(node), (si, None));
        if let Some(params) = child(node, 1) {
            self.hoist_item(params)?;
        }
        // See `hoist_function` for the two-phase `arguments` injection: once
        // before the body (references / parser-known `eval`) so a body
        // `var arguments` merges, and once after (body-level direct `eval`
        // discovered during the body walk).
        let injected = self.inject_arguments(si, node);
        if let Some(body) = child(node, 2) {
            self.hoist_item(body)?;
        }
        if !injected {
            self.inject_arguments(si, node);
        }
        self.fx_scope_hoisted(si);
        self.body_scope = body_scope;
        self.function_scope = function_scope;
        Ok(())
    }

    /// `fxFunctionNodeHoist`'s synthetic `arguments` `Var`: a non-arrow
    /// function that references `arguments` or contains a direct `eval` gets
    /// an `arguments` binding in its function scope. Returns whether it was
    /// injected (so the caller does not re-inject).
    fn inject_arguments(&mut self, si: usize, node: &Node) -> bool {
        let nf = self.node_flags(node);
        if (nf & (flags::ARGUMENTS | SCOPE_EVAL) != 0) && (nf & flags::ARROW == 0) {
            let d = self.new_declare(si, Token::Var, Some(Sym::Named("arguments".to_string())), node.line);
            self.scope_add_declare(si, d);
            true
        } else {
            false
        }
    }

    fn hoist_for(&mut self, node: &Node) -> Result<(), ParseError> {
        let si = self.scope_new(node, Token::Block);
        self.node_scope.insert(node_ptr(node), (si, None));
        for i in 0..4 {
            if let Some(c) = child(node, i) {
                self.hoist_item(c)?;
            }
        }
        self.fx_scope_hoisted(si);
        Ok(())
    }

    fn hoist_for_in_of(&mut self, node: &Node) -> Result<(), ParseError> {
        let si = self.scope_new(node, Token::Block);
        self.node_scope.insert(node_ptr(node), (si, None));
        for i in 0..3 {
            if let Some(c) = child(node, i) {
                self.hoist_item(c)?;
            }
        }
        self.fx_scope_hoisted(si);
        Ok(())
    }

    fn hoist_switch(&mut self, node: &Node) -> Result<(), ParseError> {
        // children[0] = expression, children[1] = items (list of Case)
        if let Some(expr) = child(node, 0) {
            self.hoist_item(expr)?;
        }
        let si = self.scope_new(node, Token::Block);
        self.node_scope.insert(node_ptr(node), (si, None));
        if let Some(items) = child(node, 1) {
            self.hoist_item(items)?;
        }
        self.fx_scope_hoisted(si);
        Ok(())
    }

    fn hoist_with(&mut self, node: &Node) -> Result<(), ParseError> {
        // children[0] = expression, children[1] = statement
        if let Some(expr) = child(node, 0) {
            self.hoist_item(expr)?;
        }
        let si = self.scope_new(node, Token::With);
        self.node_scope.insert(node_ptr(node), (si, None));
        self.scope_eval(self.scopes[si].parent);
        if let Some(stmt) = child(node, 1) {
            self.hoist_item(stmt)?;
        }
        self.fx_scope_hoisted(si);
        Ok(())
    }

    fn hoist_string(&mut self, node: &Node) -> Result<(), ParseError> {
        // `fxStringNodeHoist`: a string carrying `mxStringLegacyFlag` (a
        // legacy octal or `\8`/`\9`) inside a strict scope becomes
        // `mxStringErrorFlag`, which `fxStringNodeCode` then reports as an
        // "invalid escape sequence". XS defers the strict test to hoist
        // because a later `"use strict"` prologue can flip the enclosing
        // scope strict after the string was already scanned. Only plain
        // string literals reach here with the legacy flag — a template that
        // contains an octal escape is upgraded to `mxStringErrorFlag` at lex
        // time (and its untagged form already rejected in the parser), so
        // this never mis-fires on a tagged template's cooked slot.
        if node.flags & flags::STRING_LEGACY != 0 {
            let strict = self.scope.map_or(false, |si| self.scopes[si].flags & SCOPE_STRICT != 0);
            if strict {
                return Err(err(node.line, "invalid escape sequence"));
            }
        }
        Ok(())
    }

    /// `fxImportNodeHoist` — each import specifier declares a module-scope
    /// `let` that is an immutable indirect binding (closure|useClosure);
    /// a bare `import "m"` declares one anonymous slot. The `from`/`with`
    /// re-export attributes are coder-side. Modules are strict, so
    /// importing `arguments`/`eval` is an early error.
    fn hoist_import(&mut self, node: &Node) -> Result<(), ParseError> {
        let scope = self.scope.unwrap();
        let strict = self.node_flags(node) & SCOPE_STRICT != 0;
        // `from` string (children[1]) and `with` attributes (children[2])
        // are the import node's, shared by every specifier (`specifier->from
        // = self->from`, `fxImportNodeHoist`).
        let from = child_str_units(node, 1).unwrap_or_default();
        let with = matches!(child(node, 2), Some(Item::Node(_)));
        let specs = match child(node, 0) {
            Some(Item::List(v)) if !v.is_empty() => v.clone(),
            _ => {
                // bare `import "m"` — one anonymous indirect binding whose
                // TRANSFER still carries the module specifier.
                let mut d = self.new_declare(scope, Token::Let, None, node.line);
                d.flags |= dflags::CLOSURE | dflags::USE_CLOSURE;
                d.import_spec = Some(ImportSpec { from, symbol: None, with });
                self.scope_add_declare(scope, d);
                return Ok(());
            }
        };
        for spec in &specs {
            let Item::Node(spec) = spec else { continue };
            // spec children: [symbol (imported name), asSymbol (local alias)].
            // local = asSymbol ? asSymbol : symbol; imported = symbol.
            let imported = child_sym(spec, 0);
            let local = child_sym(spec, 1).or_else(|| imported.clone());
            let Some(local) = local else { continue };
            let sym = Sym::Named(local.clone());
            if strict && (local == "arguments" || local == "eval") {
                return Err(err(spec.line, "invalid import"));
            }
            if self.scope_get_declare(scope, &sym).is_some() {
                return Err(err(spec.line, "duplicate variable"));
            }
            let mut d = self.new_declare(scope, Token::Let, Some(sym), spec.line);
            d.flags |= dflags::CLOSURE | dflags::USE_CLOSURE;
            d.import_spec = Some(ImportSpec { from: from.clone(), symbol: imported, with });
            self.scope_add_declare(scope, d);
        }
        Ok(())
    }

    /// `fxExportNodeHoist` (the local-export half) — record each exported
    /// name in the export-link set, raising a duplicate-export early
    /// error. The `export … from` re-export indirection (which synthesizes
    /// indirect `let` bindings) is folded (see report).
    fn hoist_export(&mut self, node: &Node) -> Result<(), ParseError> {
        // `export … from "m"` — a re-export. XS synthesizes one anonymous
        // module-scope `let` per specifier (its `importSpecifier` *and*
        // `firstExportSpecifier` both point at the specifier), so the module
        // record links a fresh indirect binding to the source module.
        if let Some(from) = child_str_units(node, 1) {
            let scope = self.scope.unwrap();
            let with = matches!(child(node, 2), Some(Item::Node(_)));
            match child(node, 0) {
                Some(Item::List(specs)) if !specs.is_empty() => {
                    for spec in specs.clone() {
                        let Item::Node(spec) = spec else { continue };
                        // import symbol = spec->symbol (children[0]); export
                        // name = asSymbol ? asSymbol : symbol.
                        let imported = child_sym(&spec, 0);
                        let export_name = child_sym(&spec, 1).or_else(|| imported.clone());
                        let mut d = self.new_declare(scope, Token::Let, None, node.line);
                        d.flags |= dflags::CLOSURE | dflags::USE_CLOSURE;
                        d.import_spec =
                            Some(ImportSpec { from: from.clone(), symbol: imported, with });
                        d.export_specs.push(ExportSpec { name: export_name });
                        self.scope_add_declare(scope, d);
                    }
                }
                _ => {
                    // `export * from "m"` with no specifiers list.
                    let mut d = self.new_declare(scope, Token::Let, None, node.line);
                    d.flags |= dflags::CLOSURE | dflags::USE_CLOSURE;
                    d.import_spec = Some(ImportSpec { from, symbol: None, with });
                    self.scope_add_declare(scope, d);
                }
            }
            // Re-export names still join the export-link duplicate set.
            if let Some(Item::List(specs)) = child(node, 0) {
                for spec in specs {
                    let Item::Node(spec) = spec else { continue };
                    let name = child_sym(spec, 1).or_else(|| child_sym(spec, 0));
                    if let Some(name) = name {
                        let sym = Sym::Named(name);
                        if self.export_links.contains(&sym) {
                            return Err(err(spec.line, "duplicate export"));
                        }
                        self.export_links.push(sym);
                    }
                }
            }
            return Ok(());
        }
        if let Some(Item::List(specs)) = child(node, 0) {
            for spec in specs {
                let Item::Node(spec) = spec else { continue };
                // export name = asSymbol ? asSymbol : symbol
                let name = child_sym(spec, 1).or_else(|| child_sym(spec, 0));
                if let Some(name) = name {
                    let sym = Sym::Named(name);
                    if self.export_links.contains(&sym) {
                        return Err(err(spec.line, "duplicate export"));
                    }
                    self.export_links.push(sym);
                }
            }
        }
        Ok(())
    }
}

// ============================== bind pass ==============================

impl Scoper {
    // ---- binder frame counters (fxBinderPush/PopVariables) ----
    fn push_variables(&mut self, count: i32) {
        self.scope_level += count;
        if self.scope_maximum < self.scope_level {
            self.scope_maximum = self.scope_level;
        }
    }
    fn pop_variables(&mut self, count: i32) {
        self.scope_level -= count;
    }

    /// `fxScopeBinding` — enter a scope and reserve its declare slots.
    fn fx_scope_binding(&mut self, si: usize) {
        self.scope = Some(si);
        let count = self.scopes[si].declare_count;
        self.push_variables(count);
    }

    /// `fxScopeBound` — close a scope: eval/module/program closure marking,
    /// then the closure-slot and declare-slot frame arithmetic.
    fn fx_scope_bound(&mut self, si: usize) {
        let tok = self.scopes[si].token;
        let eval = self.scopes[si].flags & SCOPE_EVAL != 0;
        if eval {
            for d in &mut self.scopes[si].declares {
                d.flags |= dflags::CLOSURE;
            }
        }
        if tok == Token::Module {
            for d in &mut self.scopes[si].declares {
                if d.flags & dflags::DISPOSABLE == 0 {
                    d.flags |= dflags::CLOSURE | dflags::USE_CLOSURE;
                }
            }
        } else if tok == Token::Program {
            for d in &mut self.scopes[si].declares {
                d.flags |= dflags::CLOSURE | dflags::USE_CLOSURE;
            }
        }
        let closure = self.scopes[si].closure_count;
        let declare = self.scopes[si].declare_count;
        self.scope_level += closure;
        self.scope_maximum += closure;
        self.pop_variables(declare);
        self.scope = self.scopes[si].parent;
    }

    fn record_access(&mut self, symbol: &str, line: u32, resolved: Option<(usize, u32)>) {
        self.accesses.push(AccessRecord { symbol: symbol.to_string(), line, resolved });
    }

    /// `fxNodeDispatchBind`.
    fn bind_dispatch(&mut self, node: &Node) -> Result<(), ParseError> {
        match node.token {
            Token::Program => self.bind_program(node),
            Token::Module => self.bind_module(node),
            Token::Block | Token::Body => self.bind_block(node),
            Token::Function | Token::Generator => self.bind_function(node),
            Token::Access => self.bind_access(node),
            Token::Arg | Token::Var | Token::Let | Token::Const | Token::Using => self.bind_declare_node(node),
            Token::Define => self.bind_define(node),
            Token::Assign => self.bind_assign(node),
            Token::Binding => self.bind_binding(node),
            Token::Catch => self.bind_catch(node),
            Token::For => self.bind_for(node),
            Token::ForIn | Token::ForOf | Token::ForAwaitOf => self.bind_for_in_of(node),
            Token::Switch => self.bind_switch(node),
            Token::With => self.bind_with(node),
            Token::Try => self.bind_try(node),
            Token::Array => self.bind_array(node),
            Token::ArrayBinding => self.bind_array_binding(node),
            Token::Object => self.bind_object(node),
            Token::ObjectBinding => self.bind_object_binding(node),
            Token::Params => self.bind_params(node),
            Token::ParamsBinding => self.bind_params_binding(node),
            Token::Spread => self.bind_spread(node),
            Token::Delegate => self.bind_delegate(node),
            Token::Template => self.bind_template(node),
            Token::This | Token::Target => self.bind_this_target(node),
            Token::Super => self.bind_super(node),
            Token::Increment | Token::Decrement => self.bind_postfix(node),
            Token::Export => self.bind_export(node),
            Token::Class => self.bind_class(node),
            Token::PrivateMember | Token::PrivateIdentifier => self.bind_private_member(node),
            Token::Delete => self.bind_delete(node),
            // fold: Field — deferred.
            _ => self.bind_children(node),
        }
    }

    /// `fxClassNodeBind` — reserve the two frame slots the class coder uses
    /// for its prototype and constructor temporaries (so the enclosing
    /// scope's frame count includes them), then bind the heritage,
    /// constructor, and members. The class/symbol scopes (fields, private
    /// members, a named-class binding) are the deferred class-hoisting fold;
    /// a base class with methods needs only the two-slot reservation.
    fn bind_class(&mut self, node: &Node) -> Result<(), ParseError> {
        let former = self.class_node;
        self.push_variables(2);
        let (si, symbol_scope) = self.scope_of(node);
        if let Some(ss) = symbol_scope {
            self.fx_scope_binding(ss);
        }
        if let Some(heritage) = child(node, 1) {
            self.bind_item(heritage)?;
        }
        self.fx_scope_binding(si);
        self.class_node = Some(node_ptr(node));
        if let Some(constructor) = child(node, 5) {
            self.bind_item(constructor)?;
        }
        // Bind the instance field initializers inside a synthesized
        // `instanceInit` **function scope** (XS moves every instance field's
        // value into a real `mxFieldFlag` function whose scope isolates the
        // value expressions' temporaries and captures — `fxClassExpression`
        // splitting the values into `instanceInit` Field nodes). Engaged
        // whenever the class has any instance field (plain data, computed-key,
        // private data, or private method); a member's *class-definition-time*
        // part (a computed key, a private method function) stays bound at the
        // class scope, while its VALUE binds inside the field function.
        let engage = class_has_instance_field(node);
        // Field members split for each field function's two-pass order
        // (`fxClassExpression`: private methods/accessors first, then data
        // fields + `static { … }` blocks, both in source order), instance vs
        // static. A member's class-definition-time part (a computed key, a
        // private method function) binds at the class scope now; its value (or
        // a static block's body) defers to the field function pass. References
        // into the AST.
        let mut inst_methods: Vec<&Node> = Vec::new();
        let mut inst_data: Vec<&Node> = Vec::new();
        let mut static_methods: Vec<&Node> = Vec::new();
        let mut static_data: Vec<&Node> = Vec::new();
        if let Some(Item::List(items)) = node.children.get(2) {
            for item in items {
                let Item::Node(m) = item else {
                    self.bind_item(item)?;
                    continue;
                };
                let is_accessor =
                    m.flags & (flags::METHOD | flags::GETTER | flags::SETTER) != 0;
                let is_static = m.flags & flags::STATIC != 0;
                let is_public_method = is_accessor && m.token != Token::PrivateProperty;
                if is_public_method {
                    self.bind_item(item)?;
                    continue;
                }
                // A `static { … }` block: its body binds inside constructorInit.
                if m.token == Token::Body {
                    static_data.push(m);
                    continue;
                }
                let (methods, data) = if is_static {
                    (&mut static_methods, &mut static_data)
                } else {
                    (&mut inst_methods, &mut inst_data)
                };
                match m.token {
                    Token::PropertyAt => {
                        // Computed data field: bind the KEY (child 0) at class
                        // scope; its value binds in the field function.
                        if let Some(key) = m.children.first() {
                            self.bind_item(key)?;
                        }
                        data.push(m);
                    }
                    Token::PrivateProperty if is_accessor => {
                        // Private method/accessor: its function value binds at
                        // class scope; the field function only aliases the
                        // value/brand closures (no value bind).
                        if let Some(v) = m.children.get(1) {
                            self.bind_item(v)?;
                        }
                        methods.push(m);
                    }
                    Token::PrivateProperty | Token::Property => {
                        // Private/plain data field: value binds in the field
                        // function; the brand is class-hoisted.
                        data.push(m);
                    }
                    _ => self.bind_item(item)?,
                }
            }
        }
        if let Some(constructor_init) = child(node, 3) {
            self.bind_item(constructor_init)?;
        }
        if let Some(instance_init) = child(node, 4) {
            self.bind_item(instance_init)?;
        }
        // Bind the static field function (XS's `constructorInit`) first, then
        // the instance field function (`instanceInit`) — XS's `fxClassNodeBind`
        // order.
        if !static_methods.is_empty() || !static_data.is_empty() {
            let ci = *self
                .class_field_init_static_hoist
                .get(&node_ptr(node))
                .expect("static field function scope hoisted");
            let ordered: Vec<&Node> =
                static_methods.iter().chain(static_data.iter()).copied().collect();
            self.bind_field_init_scope(ci, si, &ordered)?;
            self.class_field_init_static.insert(node_ptr(node), ci);
        }
        if engage {
            let fi = *self
                .class_field_init_hoist
                .get(&node_ptr(node))
                .expect("instance field function scope hoisted");
            let ordered: Vec<&Node> =
                inst_methods.iter().chain(inst_data.iter()).copied().collect();
            self.bind_field_init_scope(fi, si, &ordered)?;
            self.class_field_init_inst.insert(node_ptr(node), fi);
        }
        self.class_node = former;
        self.fx_scope_bound(si);
        if let Some(ss) = symbol_scope {
            self.fx_scope_bound(ss);
        }
        self.pop_variables(2);
        Ok(())
    }

    /// Bind a field-init function scope (XS's `instanceInit` /
    /// `constructorInit`): enter the (hoist-created) scope `fi`, and per field
    /// in two-pass order look its member accesses (`atAccess` / `valueAccess` /
    /// `symbolAccess`) up from inside it — creating use-closure aliases in
    /// field order (`fxFieldNodeBind`) — then bind the value (whose own outer
    /// captures interleave), or, for a `static { … }` block, its body.
    /// `scopeCount == scopeMaximum` = the captured closures plus the peak
    /// temporary depth of the field values. Records each member's fi aliases.
    fn bind_field_init_scope(
        &mut self,
        fi: usize,
        class_scope: usize,
        ordered: &[&Node],
    ) -> Result<(), ParseError> {
        let saved_level = self.scope_level;
        let saved_maximum = self.scope_maximum;
        self.scope_level = 0;
        self.scope_maximum = 0;
        self.fx_scope_binding(fi);
        for m in ordered {
            // A `static { … }` block runs its body (child 0) directly inside
            // the field function — no member access, no value install.
            if m.token == Token::Body {
                if let Some(body) = m.children.first() {
                    self.bind_item(body)?;
                }
                continue;
            }
            let access = self.class_member_access.get(&node_ptr(m)).copied().unwrap_or_default();
            let is_accessor =
                m.flags & (flags::METHOD | flags::GETTER | flags::SETTER) != 0;
            let mut fi_slot = MemberAccess::default();
            match m.token {
                Token::PropertyAt => {
                    if let Some(cid) = access.at {
                        fi_slot.at = self.field_init_alias(fi, class_scope, cid);
                    }
                }
                Token::PrivateProperty => {
                    if is_accessor {
                        if let Some(cid) = access.value {
                            fi_slot.value = self.field_init_alias(fi, class_scope, cid);
                        }
                    }
                    if let Some(cid) = access.symbol {
                        fi_slot.symbol = self.field_init_alias(fi, class_scope, cid);
                    }
                }
                _ => {}
            }
            self.class_member_fi.insert(node_ptr(m), fi_slot);
            // A private method has no value in the field function (its function
            // bound at the class scope); every other field's value binds here.
            let private_method = m.token == Token::PrivateProperty && is_accessor;
            if !private_method {
                if let Some(v) = m.children.get(1) {
                    self.bind_item(v)?;
                }
            }
        }
        self.fx_scope_bound(fi);
        self.scope_counts.insert(fi, self.scope_maximum);
        self.scope_maximum = saved_maximum;
        self.scope_level = saved_level;
        Ok(())
    }

    fn bind_children(&mut self, node: &Node) -> Result<(), ParseError> {
        for item in &node.children {
            self.bind_item(item)?;
        }
        Ok(())
    }
    fn bind_item(&mut self, item: &Item) -> Result<(), ParseError> {
        match item {
            Item::Node(n) => self.bind_dispatch(n),
            Item::List(v) => {
                for it in v {
                    self.bind_item(it)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn scope_of(&self, node: &Node) -> (usize, Option<usize>) {
        *self.node_scope.get(&node_ptr(node)).expect("scope for node")
    }

    fn bind_program(&mut self, node: &Node) -> Result<(), ParseError> {
        let (si, _) = self.scope_of(node);
        self.fx_scope_binding(si);
        if let Some(body) = child(node, 0) {
            self.bind_item(body)?;
        }
        self.fx_scope_bound(si);
        self.scope_counts.insert(si, self.scope_maximum);
        Ok(())
    }

    fn bind_module(&mut self, node: &Node) -> Result<(), ParseError> {
        let (si, _) = self.scope_of(node);
        self.fx_scope_binding(si);
        if let Some(body) = child(node, 0) {
            self.bind_item(body)?;
        }
        self.fx_scope_bound(si);
        self.scope_counts.insert(si, self.scope_maximum);
        Ok(())
    }

    fn bind_block(&mut self, node: &Node) -> Result<(), ParseError> {
        let (si, _) = self.scope_of(node);
        self.fx_scope_binding(si);
        let disp = self.scopes[si].disposable_count > 0;
        if disp {
            self.push_variables(2);
        }
        if let Some(stmt) = child(node, 0) {
            self.bind_item(stmt)?;
        }
        if disp {
            self.pop_variables(2);
        }
        self.fx_scope_bound(si);
        Ok(())
    }

    fn bind_function(&mut self, node: &Node) -> Result<(), ParseError> {
        let (si, _) = self.scope_of(node);
        let level = self.scope_level;
        let maximum = self.scope_maximum;
        self.scope_level = 0;
        self.scope_maximum = 0;
        self.fx_scope_binding(si);
        if let Some(params) = child(node, 1) {
            self.bind_item(params)?;
        }
        // A base class constructor captures the class's `instanceInit`
        // closure (`fxFunctionNodeBind`'s `mxBaseFlag` branch) so it can
        // call the field initializer on entry — a use-closure alias in the
        // constructor scope targeting the class body scope's declare.
        if self.node_flags(node) & crate::ast::flags::BASE != 0 {
            if let Some(cnode) = self.class_node {
                if let Some(&(rscope, rid)) = self.class_instance_init.get(&cnode) {
                    let d = self.declare_ref(rscope, rid);
                    let (rline, rsym) = (d.line, d.symbol.clone());
                    let mut alias = self.new_declare(si, Token::NoToken, rsym, rline);
                    alias.flags |= dflags::CLOSURE | dflags::USE_CLOSURE;
                    alias.alias = Some((rscope, rid));
                    self.scope_add_declare(si, alias);
                    self.scopes[si].closure_count += 1;
                }
            }
        }
        if let Some(body) = child(node, 2) {
            self.bind_item(body)?;
        }
        self.fx_scope_bound(si);
        self.scope_counts.insert(si, self.scope_maximum);
        self.scope_maximum = maximum;
        self.scope_level = level;
        Ok(())
    }

    fn bind_access(&mut self, node: &Node) -> Result<(), ParseError> {
        if let Some(sym) = child_sym(node, 0) {
            let scope = self.scope.unwrap();
            let resolved = self.scope_lookup(scope, &Sym::Named(sym.clone()), node.line, false, false);
            self.record_access(&sym, node.line, resolved);
            self.resolutions.insert(node_ptr(node), resolved);
        }
        Ok(())
    }

    /// `delete` of a private member reference (`delete obj.#x`, including
    /// the parenthesized/covered form `delete (this.#x)`) is an early
    /// SyntaxError — XS reports it from `fxPrivateMemberNodeCodeDelete`.
    /// The target is found by unwrapping a single-item parenthesized
    /// sequence exactly as the coder's `codeDelete` dispatch does (a
    /// multi-item `delete (a, b.#x)` is a value-`delete`, not an error).
    fn bind_delete(&mut self, node: &Node) -> Result<(), ParseError> {
        if let Some(target) = node.children.first() {
            if delete_target_is_private(target) {
                return Err(err(node.line, "delete private property"));
            }
        }
        self.bind_children(node)
    }

    /// `fxPrivateMemberNodeBind` — a private member access (`obj.#x`,
    /// `obj.#m()`) and the `#x in obj` brand check (`PrivateIdentifier`)
    /// share this bind. The node's own `symbol` (child 0, the `#name`)
    /// resolves through the class-scope closures the declaration slice
    /// installed (`symbolAccess`), with the `is_private_member` flag set so a
    /// strict `eval` scope synthesizes the brand declare (mirroring
    /// `fxScopeLookup`'s `XS_TOKEN_PRIVATE_MEMBER` branch); an unresolved
    /// `#name` is XS's "invalid private identifier". The reference (child 1)
    /// binds after the lookup, matching `fxPrivateMemberNodeDistribute`.
    fn bind_private_member(&mut self, node: &Node) -> Result<(), ParseError> {
        // A private member accessed on `super` (`super.#x`, `super.#m()`)
        // is invalid syntax: the reference base carries the `super` flag.
        if let Some(Item::Node(reference)) = node.children.get(1) {
            if reference.flags & flags::SUPER != 0 {
                return Err(err(node.line, "invalid super private access"));
            }
        }
        if let Some(sym) = child_sym(node, 0) {
            let scope = self.scope.unwrap();
            let resolved = self.scope_lookup(scope, &Sym::Named(sym.clone()), node.line, true, false);
            if resolved.is_none() {
                return Err(err(node.line, "invalid private identifier"));
            }
            self.resolutions.insert(node_ptr(node), resolved);
        }
        if let Some(reference) = child(node, 1) {
            self.bind_item(reference)?;
        }
        Ok(())
    }

    /// `fxDeclareNodeBind` — a declaration node in the tree resolves its
    /// own symbol (so the coder learns its slot).
    fn bind_declare_node(&mut self, node: &Node) -> Result<(), ParseError> {
        if let Some(sym) = child_sym(node, 0) {
            let scope = self.scope.unwrap();
            let resolved = self.scope_lookup(scope, &Sym::Named(sym.clone()), node.line, false, false);
            // `self->declaration = declaration` — record that this declaration
            // binds (drives `fxScopeCodeStoreAll` eligibility).
            if let Some((rscope, rid)) = resolved {
                self.declare_mut(rscope, rid).bound = true;
            }
            self.record_access(&sym, node.line, resolved);
            self.resolutions.insert(node_ptr(node), resolved);
        }
        Ok(())
    }

    fn bind_define(&mut self, node: &Node) -> Result<(), ParseError> {
        if let Some(sym) = child_sym(node, 0) {
            let scope = self.scope.unwrap();
            let resolved = self.scope_lookup(scope, &Sym::Named(sym.clone()), node.line, false, false);
            if let Some((rscope, rid)) = resolved {
                self.declare_mut(rscope, rid).bound = true;
            }
            self.record_access(&sym, node.line, resolved);
            self.resolutions.insert(node_ptr(node), resolved);
        }
        if let Some(init) = child(node, 1) {
            self.bind_item(init)?;
        }
        Ok(())
    }

    fn bind_assign(&mut self, node: &Node) -> Result<(), ParseError> {
        // children[0]=reference, children[1]=value
        if let Some(reference) = child(node, 0) {
            self.bind_item(reference)?;
        }
        if let Some(value) = child(node, 1) {
            self.bind_item(value)?;
        }
        Ok(())
    }

    fn bind_binding(&mut self, node: &Node) -> Result<(), ParseError> {
        // children[0]=target, children[1]=initializer
        if let Some(target) = child(node, 0) {
            self.bind_item(target)?;
        }
        if let Some(init) = child(node, 1) {
            self.bind_item(init)?;
        }
        Ok(())
    }

    fn bind_catch(&mut self, node: &Node) -> Result<(), ParseError> {
        let (scope, statement_scope) = self.scope_of(node);
        let has_param = matches!(child(node, 0), Some(Item::Node(_)));
        if has_param {
            let st = statement_scope.unwrap();
            self.fx_scope_binding(scope);
            if let Some(param) = child(node, 0) {
                self.bind_item(param)?;
            }
            self.fx_scope_binding(st);
            let disp = self.scopes[st].disposable_count > 0;
            if disp {
                self.push_variables(2);
            }
            if let Some(stmt) = child(node, 1) {
                self.bind_item(stmt)?;
            }
            if disp {
                // NOTE: XS's fxCatchNodeBind pushes (not pops) here too;
                // transliterated faithfully.
                self.push_variables(2);
            }
            self.fx_scope_bound(st);
            self.fx_scope_bound(scope);
        } else {
            // `scope` holds the statementScope when there is no parameter.
            self.fx_scope_binding(scope);
            let disp = self.scopes[scope].disposable_count > 0;
            if disp {
                self.push_variables(2);
            }
            if let Some(stmt) = child(node, 1) {
                self.bind_item(stmt)?;
            }
            if disp {
                self.push_variables(2);
            }
            self.fx_scope_bound(scope);
        }
        Ok(())
    }

    fn bind_for(&mut self, node: &Node) -> Result<(), ParseError> {
        let (si, _) = self.scope_of(node);
        self.fx_scope_binding(si);
        let disp = self.scopes[si].disposable_count > 0;
        if disp {
            self.push_variables(2);
        }
        for i in 0..4 {
            if let Some(c) = child(node, i) {
                self.bind_item(c)?;
            }
        }
        if disp {
            self.pop_variables(2);
        }
        self.fx_scope_bound(si);
        Ok(())
    }

    fn bind_for_in_of(&mut self, node: &Node) -> Result<(), ParseError> {
        let (si, _) = self.scope_of(node);
        self.push_variables(6);
        self.fx_scope_binding(si);
        for i in 0..3 {
            if let Some(c) = child(node, i) {
                self.bind_item(c)?;
            }
        }
        self.fx_scope_bound(si);
        self.pop_variables(6);
        Ok(())
    }

    fn bind_switch(&mut self, node: &Node) -> Result<(), ParseError> {
        if let Some(expr) = child(node, 0) {
            self.bind_item(expr)?;
        }
        let (si, _) = self.scope_of(node);
        self.fx_scope_binding(si);
        let disp = self.scopes[si].disposable_count > 0;
        if disp {
            self.push_variables(2);
        }
        if let Some(items) = child(node, 1) {
            self.bind_item(items)?;
        }
        if disp {
            self.pop_variables(2);
        }
        self.fx_scope_bound(si);
        Ok(())
    }

    fn bind_with(&mut self, node: &Node) -> Result<(), ParseError> {
        if let Some(expr) = child(node, 0) {
            self.bind_item(expr)?;
        }
        let (si, _) = self.scope_of(node);
        self.fx_scope_binding(si);
        if let Some(stmt) = child(node, 1) {
            self.bind_item(stmt)?;
        }
        self.fx_scope_bound(si);
        Ok(())
    }

    fn bind_try(&mut self, node: &Node) -> Result<(), ParseError> {
        self.push_variables(3);
        for i in 0..3 {
            if let Some(c) = child(node, i) {
                self.bind_item(c)?;
            }
        }
        self.pop_variables(3);
        Ok(())
    }

    fn bind_array(&mut self, node: &Node) -> Result<(), ParseError> {
        self.push_variables(1);
        let spread = node.flags & flags::SPREAD != 0;
        if spread {
            self.push_variables(2);
        }
        self.bind_children(node)?;
        if spread {
            self.pop_variables(2);
        }
        self.pop_variables(1);
        Ok(())
    }

    fn bind_array_binding(&mut self, node: &Node) -> Result<(), ParseError> {
        self.push_variables(6);
        self.bind_children(node)?;
        self.pop_variables(6);
        Ok(())
    }

    fn bind_object(&mut self, node: &Node) -> Result<(), ParseError> {
        self.push_variables(1);
        // `fxObjectNodeBind`: copy each property's method/getter/setter flag
        // onto its value function node before binding it, so the parameter
        // arity early error (getter → 0 params, setter → 1 non-rest) fires
        // for object-literal accessors — whose parser leaves those flags on
        // the *property*, not the function. Recorded in `node_extra` (not the
        // AST) exactly as XS's binder mutates the node in place; the coder
        // relays the accessor bit from the property, so bytecode is unchanged.
        if let Some(Item::List(items)) = child(node, 0) {
            for item in items {
                let Item::Node(p) = item else { continue };
                if p.token != Token::Property && p.token != Token::PropertyAt {
                    continue;
                }
                if let Some(Item::Node(value)) = p.children.get(1) {
                    if value.token == Token::Function || value.token == Token::Generator {
                        let bits = p.flags & (flags::METHOD | flags::GETTER | flags::SETTER);
                        if bits != 0 {
                            self.add_extra(node_ptr(value), bits);
                        }
                    }
                }
            }
        }
        self.bind_children(node)?;
        self.pop_variables(1);
        Ok(())
    }

    fn bind_object_binding(&mut self, node: &Node) -> Result<(), ParseError> {
        self.push_variables(2);
        self.bind_children(node)?;
        self.pop_variables(2);
        Ok(())
    }

    fn bind_params(&mut self, node: &Node) -> Result<(), ParseError> {
        let spread = node.flags & flags::SPREAD != 0;
        if spread {
            self.push_variables(1);
            self.bind_children(node)?;
            self.pop_variables(1);
        } else {
            self.bind_children(node)?;
        }
        Ok(())
    }

    fn bind_params_binding(&mut self, node: &Node) -> Result<(), ParseError> {
        // `fxParamsBindingNodeBind`: getter/setter/plain parameter-count
        // early errors — a getter takes no parameters, a setter exactly one
        // non-rest parameter, and any other function at most 255.
        if let Some(fscope) = self.scope {
            let nf = self.scope_node_flags(fscope);
            let items: &[Item] = match child(node, 0) {
                Some(Item::List(items)) => items,
                _ => &[],
            };
            let count = items.len();
            if nf & flags::GETTER != 0 {
                if count != 0 {
                    return Err(err(node.line, "invalid getter arguments"));
                }
            } else if nf & flags::SETTER != 0 {
                let first_rest = matches!(
                    items.first(),
                    Some(Item::Node(n)) if n.token == Token::RestBinding
                );
                if count != 1 || first_rest {
                    return Err(err(node.line, "invalid setter arguments"));
                }
            } else if count > 255 {
                return Err(err(node.line, "too many arguments"));
            }
        }
        // `fxParamsBindingNodeBind`: a *mapped* `arguments` object (a sloppy
        // function that references `arguments` and has a simple parameter
        // list) aliases the named parameters, so each parameter is promoted
        // to a closure slot. Marking the declare (no count change, like a
        // capture) is enough; the coder then emits `NEW_CLOSURE`/
        // `VAR_CLOSURE`/`GET_CLOSURE` for it.
        if let Some(fscope) = self.scope {
            let nf = self.scope_node_flags(fscope);
            if nf & flags::ARGUMENTS != 0 && nf & flags::STRICT == 0 {
                if let Some(Item::List(items)) = child(node, 0) {
                    let all_arg = items
                        .iter()
                        .all(|it| matches!(it, Item::Node(n) if n.token == Token::Arg));
                    if all_arg {
                        let names: Vec<String> = items
                            .iter()
                            .filter_map(|it| match it {
                                Item::Node(arg) => child_sym(arg, 0),
                                _ => None,
                            })
                            .collect();
                        for name in names {
                            if let Some(id) = self.scope_get_declare(fscope, &Sym::Named(name)) {
                                self.declare_mut(fscope, id).flags |= dflags::CLOSURE;
                            }
                        }
                    }
                }
            }
        }
        self.bind_children(node)
    }

    fn bind_spread(&mut self, node: &Node) -> Result<(), ParseError> {
        self.push_variables(1);
        self.bind_children(node)?;
        self.pop_variables(1);
        Ok(())
    }

    fn bind_delegate(&mut self, node: &Node) -> Result<(), ParseError> {
        self.push_variables(5);
        if let Some(expr) = child(node, 0) {
            self.bind_item(expr)?;
        }
        self.pop_variables(5);
        Ok(())
    }

    fn bind_template(&mut self, node: &Node) -> Result<(), ParseError> {
        // children[0]=reference (Null for untagged), children[1]=items
        let tagged = matches!(child(node, 0), Some(Item::Node(_)));
        if tagged {
            self.push_variables(2);
            self.bind_children(node)?;
            self.pop_variables(2);
        } else {
            self.bind_children(node)?;
        }
        Ok(())
    }

    fn bind_this_target(&mut self, _node: &Node) -> Result<(), ParseError> {
        self.scope_arrow(self.scope);
        Ok(())
    }

    fn bind_super(&mut self, node: &Node) -> Result<(), ParseError> {
        self.scope_arrow(self.scope);
        if let Some(params) = child(node, 0) {
            self.bind_item(params)?;
        }
        // A `super(...)` in a derived class captures the class's `instanceInit`
        // closure (`fxSuperNodeBind`) so it can call the field initializer
        // once `this` exists. The lookup walks up from the current scope,
        // creating the function-boundary alias XS resolves to.
        if let Some(cnode) = self.class_node {
            if let Some(&(rscope, rid)) = self.class_instance_init.get(&cnode) {
                if let Some(sym) = self.declare_ref(rscope, rid).symbol.clone() {
                    let scope = self.scope.unwrap();
                    if let Some(resolved) = self.scope_lookup(scope, &sym, node.line, false, false) {
                        self.super_instance_init.insert(node_ptr(node), resolved);
                    }
                }
            }
        }
        Ok(())
    }

    fn bind_postfix(&mut self, node: &Node) -> Result<(), ParseError> {
        if let Some(left) = child(node, 0) {
            self.bind_item(left)?;
        }
        self.push_variables(1);
        self.pop_variables(1);
        Ok(())
    }

    /// `fxExportNodeBind` (the local-export half) — resolve each exported
    /// local name and mark its declaration a closure|useClosure indirect
    /// binding, or raise `unknown variable` if it does not resolve. A
    /// re-export (`export … from`) is bound at load time, not here.
    fn bind_export(&mut self, node: &Node) -> Result<(), ParseError> {
        if matches!(child(node, 1), Some(Item::Node(_))) {
            return Ok(());
        }
        let scope = self.scope.unwrap();
        // spec children: [symbol (local name), asSymbol (exported name)].
        // Resolve the local; the exported name (`asSymbol ? asSymbol :
        // symbol`) is linked onto the declaration's export chain.
        let specs: Vec<(String, Option<String>, u32)> = match child(node, 0) {
            Some(Item::List(v)) => v
                .iter()
                .filter_map(|it| match it {
                    Item::Node(spec) => {
                        child_sym(spec, 0).map(|s| (s, child_sym(spec, 1), spec.line))
                    }
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        for (name, as_name, line) in specs {
            let sym = Sym::Named(name.clone());
            let resolved = self.scope_lookup(scope, &sym, line, false, false);
            match resolved {
                Some((si, id)) => {
                    let export_name = as_name.or_else(|| Some(name.clone()));
                    let d = self.declare_mut(si, id);
                    d.flags |= dflags::CLOSURE | dflags::USE_CLOSURE;
                    // XS prepends the specifier onto `firstExportSpecifier`
                    // (`fxExportNodeBind`), so the emit order is the reverse
                    // of source order across repeated exports of one local.
                    d.export_specs.insert(0, ExportSpec { name: export_name });
                    self.record_access(&name, line, Some((si, id)));
                }
                None => return Err(err(line, "unknown variable")),
            }
        }
        Ok(())
    }
}

// ============================== dump ==============================

impl ScopeTree {
    /// Depth of scope `si` from the root, for indentation.
    fn depth(&self, mut si: usize) -> usize {
        let mut d = 0;
        while let Some(p) = self.scopes[si].parent {
            d += 1;
            si = p;
        }
        d
    }

    fn declare_pos(&self, si: usize, id: u32) -> Option<usize> {
        self.scopes[si].declares.iter().position(|x| x.id == id)
    }

    /// Render the scope tree and access log as a stable, readable dump —
    /// the fixture contract for the coder child. Scopes are labelled by
    /// arena index (`s0`, `s1`, …, creation order), indented by nesting;
    /// each declare shows its list position (the coder's slot order),
    /// kind, name, and flags; the access log shows each identifier's
    /// resolution.
    pub fn dump(&self) -> String {
        let mut out = String::new();
        for si in 0..self.scopes.len() {
            let sc = &self.scopes[si];
            let indent = "  ".repeat(self.depth(si));
            out.push_str(&format!("{}s{} {}", indent, si, scope_kind(sc.token)));
            if sc.flags & SCOPE_STRICT != 0 {
                out.push_str(" strict");
            }
            if sc.flags & SCOPE_EVAL != 0 {
                out.push_str(" eval");
            }
            if let Some(count) = self.scope_counts.get(&si) {
                out.push_str(&format!(" scopeCount={}", count));
            }
            out.push_str(&format!(" declareCount={}", sc.declare_count));
            if sc.closure_count != 0 {
                out.push_str(&format!(" closureCount={}", sc.closure_count));
            }
            if sc.arrow_default {
                out.push_str(" arrow-default");
            }
            out.push('\n');
            for (pos, d) in sc.declares.iter().enumerate() {
                out.push_str(&format!("{}  d{} {}", indent, pos, decl_kind(d.token)));
                match &d.symbol {
                    Some(Sym::Named(s)) => out.push_str(&format!(" {}", s)),
                    Some(Sym::Anon(n)) => out.push_str(&format!(" <anon{}>", n)),
                    None => out.push_str(" <null>"),
                }
                out.push_str(&decl_flags(d.flags));
                if let Some((asi, aid)) = d.alias {
                    let pos = self.declare_pos(asi, aid).unwrap_or(0);
                    out.push_str(&format!(" -> s{}:d{}", asi, pos));
                }
                out.push('\n');
            }
            for de in &sc.defines {
                let name = match &de.symbol {
                    Some(Sym::Named(s)) => s.clone(),
                    Some(Sym::Anon(n)) => format!("<anon{}>", n),
                    None => "<null>".to_string(),
                };
                out.push_str(&format!("{}  define {}\n", indent, name));
            }
        }
        if !self.accesses.is_empty() {
            out.push_str("--- accesses ---\n");
            for a in &self.accesses {
                match a.resolved {
                    Some((si, id)) => {
                        let pos = self.declare_pos(si, id).unwrap_or(0);
                        out.push_str(&format!("{} -> s{}:d{}\n", a.symbol, si, pos));
                    }
                    None => out.push_str(&format!("{} -> global\n", a.symbol)),
                }
            }
        }
        out
    }
}

/// The scope-kind spelling used in the dump.
fn scope_kind(token: Token) -> &'static str {
    match token {
        Token::Program => "PROGRAM",
        Token::Eval => "EVAL",
        Token::Module => "MODULE",
        Token::Function => "FUNCTION",
        Token::Block => "BLOCK",
        Token::With => "WITH",
        _ => node_name(token),
    }
}

/// The declare-kind spelling used in the dump.
fn decl_kind(token: Token) -> &'static str {
    match token {
        Token::Arg => "ARG",
        Token::Var => "VAR",
        Token::Let => "LET",
        Token::Const => "CONST",
        Token::Using => "USING",
        Token::Define => "DEFINE",
        Token::Private => "PRIVATE",
        Token::Specifier => "SPECIFIER",
        Token::NoToken => "alias",
        _ => node_name(token),
    }
}

fn decl_flags(flags: u32) -> String {
    let mut s = String::new();
    if flags & dflags::CLOSURE != 0 {
        s.push_str(" closure");
    }
    if flags & dflags::USE_CLOSURE != 0 {
        s.push_str(" useClosure");
    }
    if flags & dflags::DISPOSABLE != 0 {
        s.push_str(" disposable");
    }
    s
}

#[cfg(test)]
mod tests;
