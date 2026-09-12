//! The realm: a per-compartment guest namespace over a shared machine.
//!
//! One [`Interp`] owns the slot/chunk arenas and the primordial intrinsic
//! graph. A `Realm` is the per-compartment namespace state — its global
//! object and property index, its program symbol table, and its host
//! configuration. Evaluating a realm swaps its namespace into the machine's
//! active fields ([`Interp::swap_realm`]) and back, so N realms share one
//! arena and therefore one `Object.prototype` while keeping distinct globals.
//!
//! Derived id caches and the eval code segments travel with the realm, so a
//! realm's second evaluation sees the same names and functions its first did.
//! Machine-wide boot state (the intrinsic name table, boot default keys, the
//! symbol-key namespace) stays on the interpreter.

use super::*;
use crate::value::SlotIndex;

/// The realm-scoped namespace of a machine.
pub struct Realm {
    global_obj: SlotIndex,
    global_props: std::collections::HashMap<u16, SlotIndex>,
    symbol_ids: SymbolIds,
    symbol_names: Tracked<Vec<SymbolName>>,
    installed_names_len: usize,
    source_compiler: Option<std::rc::Rc<dyn SourceCompiler>>,
    intrinsic_permit: Option<Vec<String>>,
    code_segments: Tracked<Vec<std::rc::Rc<[u8]>>>,
    func_segments: Tracked<std::collections::HashMap<crate::value::SlotIndex, usize>>,
    active_segment: Option<usize>,
    top_level_code: Option<std::rc::Rc<[u8]>>,
    eval_direct: bool,
    byte_length_id: Option<u16>,
    byte_offset_id: Option<u16>,
    buffer_id: Option<u16>,
    size_id: Option<u16>,
    length_id: Option<u16>,
    name_id: Option<u16>,
    value_id: Option<u16>,
    done_id: Option<u16>,
    then_id: Option<u16>,
    constructor_id: Option<u16>,
    prototype_key_id: Option<u16>,
    last_index_id: Option<u16>,
    regexp_getter_ids: RegExpGetterIds,
    regexp_result_ids: RegExpResultIds,
}

impl Realm {
    /// Allocate a fresh realm namespace on `interp`: a new global object in
    /// the shared arena, rooted for the machine's GC, with an empty symbol
    /// table and no host policy.
    pub fn new(interp: &mut Interp) -> Realm {
        // The active realm's global becomes inactive the moment this realm is
        // installed; root it too so collection cannot reclaim a parked realm.
        let current = interp.global_obj;
        if !interp.realm_roots.contains(&current) {
            interp.realm_roots.push(current);
        }
        let global_obj = interp
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));
        interp.realm_roots.push(global_obj);
        let snapshot_dirt = interp.snapshot_dirt.clone();
        Realm {
            global_obj,
            global_props: std::collections::HashMap::new(),
            symbol_ids: SymbolIds::default(),
            symbol_names: Tracked::new(
                Vec::new(),
                snapshot_dirt.clone(),
                SnapshotSection::Names.mask()
                    | SnapshotSection::NameFloor.mask()
                    | SnapshotSection::Accessors.mask(),
            ),
            installed_names_len: 0,
            source_compiler: None,
            intrinsic_permit: None,
            code_segments: Tracked::new(
                Vec::new(),
                snapshot_dirt.clone(),
                SnapshotSection::Functions.mask(),
            ),
            func_segments: Tracked::new(
                std::collections::HashMap::new(),
                snapshot_dirt.clone(),
                SnapshotSection::Functions.mask(),
            ),
            active_segment: None,
            top_level_code: None,
            eval_direct: false,
            byte_length_id: None,
            byte_offset_id: None,
            buffer_id: None,
            size_id: None,
            length_id: None,
            name_id: None,
            value_id: None,
            done_id: None,
            then_id: None,
            constructor_id: None,
            prototype_key_id: None,
            last_index_id: None,
            regexp_getter_ids: RegExpGetterIds::default(),
            regexp_result_ids: RegExpResultIds::default(),
        }
    }
}

impl Interp {
    /// Allocate a fresh realm namespace over this machine's shared graph.
    pub fn new_realm(&mut self) -> Realm {
        Realm::new(self)
    }

    /// Swap this machine's active namespace with `realm`'s. Call before a run
    /// to install a realm and after it to park the realm again; the machine's
    /// arena and primordial graph never move.
    pub fn swap_realm(&mut self, realm: &mut Realm) {
        std::mem::swap(&mut self.global_obj, &mut realm.global_obj);
        std::mem::swap(&mut self.global_props, &mut realm.global_props);
        std::mem::swap(&mut self.symbol_ids, &mut realm.symbol_ids);
        std::mem::swap(&mut self.symbol_names, &mut realm.symbol_names);
        std::mem::swap(
            &mut self.installed_names_len,
            &mut realm.installed_names_len,
        );
        std::mem::swap(&mut self.source_compiler, &mut realm.source_compiler);
        std::mem::swap(&mut self.intrinsic_permit, &mut realm.intrinsic_permit);
        std::mem::swap(&mut self.code_segments, &mut realm.code_segments);
        std::mem::swap(&mut self.func_segments, &mut realm.func_segments);
        std::mem::swap(&mut self.active_segment, &mut realm.active_segment);
        std::mem::swap(&mut self.top_level_code, &mut realm.top_level_code);
        std::mem::swap(&mut self.eval_direct, &mut realm.eval_direct);
        std::mem::swap(&mut self.byte_length_id, &mut realm.byte_length_id);
        std::mem::swap(&mut self.byte_offset_id, &mut realm.byte_offset_id);
        std::mem::swap(&mut self.buffer_id, &mut realm.buffer_id);
        std::mem::swap(&mut self.size_id, &mut realm.size_id);
        std::mem::swap(&mut self.length_id, &mut realm.length_id);
        std::mem::swap(&mut self.name_id, &mut realm.name_id);
        std::mem::swap(&mut self.value_id, &mut realm.value_id);
        std::mem::swap(&mut self.done_id, &mut realm.done_id);
        std::mem::swap(&mut self.then_id, &mut realm.then_id);
        std::mem::swap(&mut self.constructor_id, &mut realm.constructor_id);
        std::mem::swap(&mut self.prototype_key_id, &mut realm.prototype_key_id);
        std::mem::swap(&mut self.last_index_id, &mut realm.last_index_id);
        std::mem::swap(&mut self.regexp_getter_ids, &mut realm.regexp_getter_ids);
        std::mem::swap(&mut self.regexp_result_ids, &mut realm.regexp_result_ids);
    }
}
