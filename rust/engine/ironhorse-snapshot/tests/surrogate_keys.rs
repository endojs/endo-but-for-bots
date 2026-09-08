//! F016: literal and runtime symbol names survive both persistence paths.
use ironhorse_snapshot::machine::{
    begin_store_session, from_snapshot_bytes, resume_from_store, MachineSnapshot,
};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn legacy_names(names: &[ironhorse_vm::SymbolName]) -> Vec<u8> {
    let mut bytes = (names.len() as u32).to_be_bytes().to_vec();
    for name in names {
        let text = name.to_text().unwrap();
        bytes.extend_from_slice(&(text.len() as u32).to_be_bytes());
        bytes.extend_from_slice(text.as_bytes());
    }
    bytes
}

fn replace_name_section(small: &[u8], names: &[u8]) -> Vec<u8> {
    let mut cursor = 0;
    let mut result = Vec::new();
    for section in 0..4 {
        let len = u32::from_be_bytes(small[cursor..cursor + 4].try_into().unwrap()) as usize;
        let end = cursor + 4 + len;
        if section == 3 {
            result.extend_from_slice(&(names.len() as u32).to_be_bytes());
            result.extend_from_slice(names);
        } else {
            result.extend_from_slice(&small[cursor..end]);
        }
        cursor = end;
    }
    result.extend_from_slice(&small[cursor..]);
    result
}

#[test]
fn legacy_utf8_names_migrate_without_changing_ids_or_epoch() {
    use ironhorse_snapshot::atom::{AtomReader, AtomWriter};
    use ironhorse_snapshot::format::{Version, NAME, VERS};
    use ironhorse_snapshot::machine::checkpoint_to_store;
    use ironhorse_snapshot::store::{
        compute_root, leaf_hash, migrate_store, seal_commit, HeapStore, LEAF_SMALL,
    };

    let signature = Signature::new("surrogate-migration");
    let mut machine = Interp::new();
    machine.link_intrinsics(&[]);
    crank(&mut machine, r#"var o={"😀":2,"\0":3}; 0"#);
    let names = machine.program_symbol_names().to_vec();
    let old_names = legacy_names(&names);
    let current = machine.write_snapshot(&signature).unwrap();
    let mut writer = AtomWriter::new();
    for atom in AtomReader::parse(&current).unwrap().atoms() {
        if atom.tag == VERS {
            let mut version = Version::current();
            version.format_version = 14;
            writer.atom(VERS, &version.encode());
        } else if atom.tag == NAME {
            writer.atom(NAME, &old_names);
        } else {
            writer.atom(atom.tag, atom.payload);
        }
    }
    let mut legacy = from_snapshot_bytes(&writer.finish(), &signature).unwrap();
    assert_eq!(legacy.program_symbol_names(), names);
    assert_eq!(crank(&mut legacy, r#"o["😀"]+o["\0"]"#).0, "5");

    let mut store = MemoryStore::new();
    drop(
        begin_store_session(machine, &signature, &mut store)
            .map_err(|(_, e)| e)
            .unwrap(),
    );
    let small = replace_name_section(&store.read_small_state().unwrap(), &old_names);
    let mut manifest = store.manifest().unwrap();
    manifest.store_schema = 25;
    manifest.version.format_version = 14;
    let (pages, extents) = store.leaf_hashes().unwrap();
    manifest.root = compute_root(
        &manifest,
        &leaf_hash(LEAF_SMALL, 0, &small),
        &pages,
        &extents,
        &store.free_leaf_hashes().unwrap(),
        &store.page_edges().unwrap(),
    );
    store
        .replace_manifest_and_small_for_migration(&manifest, &small)
        .unwrap();
    assert!(migrate_store(&mut store, &signature).unwrap());
    let migrated = store.manifest().unwrap();
    assert_eq!(
        migrated.store_schema,
        ironhorse_snapshot::store::STORE_SCHEMA_VERSION
    );
    assert_eq!(migrated.epoch, manifest.epoch);
    // Migration stamps both schema 27 and schema 28. The final parent is
    // the authenticated schema-27 seal, whose parent is the legacy seal.
    let mut intermediate = migrated.clone();
    intermediate.store_schema = 27;
    intermediate.parent_seal = manifest.seal.clone();
    intermediate.root = compute_root(
        &intermediate,
        &leaf_hash(LEAF_SMALL, 0, &store.read_small_state().unwrap()),
        &pages,
        &extents,
        &store.free_leaf_hashes().unwrap(),
        &store.page_edges().unwrap(),
    );
    let intermediate_seal = seal_commit(
        &intermediate.parent_seal,
        &intermediate,
        &[],
        &[],
        &[],
        &[],
        &[],
    );
    assert_eq!(migrated.parent_seal, intermediate_seal);
    assert_ne!(migrated.seal, manifest.seal);
    assert!(!migrate_store(&mut store, &signature).unwrap());
    let mut resumed = resume_from_store(&mut store, &signature).unwrap();
    assert_eq!(resumed.machine().program_symbol_names(), names);
    assert_eq!(crank(resumed.machine_mut(), r#"o["😀"]+o["\0"]"#).0, "5");
    checkpoint_to_store(&mut resumed, &signature, &mut store).unwrap();
    assert_eq!(store.manifest().unwrap().epoch, manifest.epoch + 1);
}

#[test]
fn current_name_sections_reject_noncanonical_bytes() {
    use ironhorse_snapshot::atom::{AtomReader, AtomWriter};
    use ironhorse_snapshot::format::NAME;
    use ironhorse_snapshot::store::{HeapStore, SmallState};
    let signature = Signature::new("bad-names");
    let mut machine = Interp::new();
    machine.link_intrinsics(&[]);
    let current = machine.write_snapshot(&signature).unwrap();
    let mut store = MemoryStore::new();
    drop(
        begin_store_session(machine, &signature, &mut store)
            .map_err(|(_, e)| e)
            .unwrap(),
    );
    // Count zero with trailing slack, and one entry with a noncanonical NUL.
    for bad in [&[0, 0, 0, 0, 42][..], &[0, 0, 0, 1, 0, 0, 0, 1, 0]] {
        let mut writer = AtomWriter::new();
        for atom in AtomReader::parse(&current).unwrap().atoms() {
            writer.atom(atom.tag, if atom.tag == NAME { bad } else { atom.payload });
        }
        assert!(from_snapshot_bytes(&writer.finish(), &signature).is_err());
        assert!(SmallState::decode(&replace_name_section(
            &store.read_small_state().unwrap(),
            bad
        ))
        .is_err());
    }
}

fn crank(machine: &mut Interp, source: &str) -> (String, u64) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let code = machine
        .relink_crank(&code, &parse_symbols(&symbols))
        .unwrap();
    let outcome = machine.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    (outcome.result, outcome.computrons)
}

#[test]
fn names_survive_container_and_store_then_relink() {
    let signature = Signature::new("surrogate-keys");
    let mut machine = Interp::new();
    machine.link_intrinsics(&[]);
    crank(
        &mut machine,
        r#"var o={"\uD800":1,"😀":2,"\0":3};
        o[String.fromCharCode(55297)]=4; 0"#,
    );
    let bytes = machine.write_snapshot(&signature).unwrap();
    let mut restored = from_snapshot_bytes(&bytes, &signature).unwrap();
    assert!(
        bytes == restored.write_snapshot(&signature).unwrap(),
        "snapshot bytes differ"
    );
    let mut store = MemoryStore::new();
    drop(
        begin_store_session(restored, &signature, &mut store)
            .map_err(|(_, e)| e)
            .unwrap(),
    );
    let mut session = resume_from_store(&mut store, &signature).unwrap();
    restored = from_snapshot_bytes(&bytes, &signature).unwrap();
    for source in [
        r#"o["\uD800"]+o["\uD801"]+o["😀"]+o["\0"]"#,
        r#"Object.keys(o).map(k=>k.charCodeAt(0)).join(',')"#,
        r#"o["\uD802"]=5; Object.keys(o).length"#,
    ] {
        let expected = crank(&mut machine, source);
        assert_eq!(crank(&mut restored, source), expected);
        assert_eq!(crank(session.machine_mut(), source), expected);
    }
}
