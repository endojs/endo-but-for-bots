//! Increasing-complexity probes. Direct image edits below are lab recipes,
//! deliberately NOT supported SQL patch operations or general upgrade APIs.
use super::*;
use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::MachineSnapshot;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::snapshot_api::FunctionRow;
use ironhorse_vm::{parse_symbols, Interp, Slot};

#[path = "../../tests/common/mod.rs"]
mod common;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn crank(m: &mut Interp, text: &str) -> String {
    let (code, names) = ironhorse_compile::compile_atoms(text).unwrap();
    let code = m.relink_crank(&code, &parse_symbols(&names)).unwrap();
    let out = m.run(&code);
    assert!(out.completed, "{text}: {:?}", out.halt);
    out.result
}

fn fixture(text: &str) -> Vec<u8> {
    let (code, names) = ironhorse_compile::compile_atoms(text).unwrap();
    let mut m = Interp::new();
    m.link_intrinsics(&parse_symbols(&names));
    let out = m.run(&code);
    assert!(out.completed, "fixture: {:?}", out.halt);
    m.write_snapshot(&sig()).unwrap()
}

fn named_slot(image: &MachineImage, name: &str) -> usize {
    let id = image.names.iter().position(|n| n == name).unwrap() + 1;
    let hits: Vec<_> = image
        .slots
        .iter()
        .enumerate()
        .filter(|(i, s)| s.id as usize == id && !image.slot_free.contains(&(*i as u32)))
        .map(|(i, _)| i)
        .collect();
    assert_eq!(
        hits.len(),
        1,
        "fixture name {name} must be unique: {hits:?}"
    );
    hits[0]
}

fn owner(image: &MachineImage, name: &str) -> u32 {
    match image.slots[named_slot(image, name)].value {
        Payload::Reference(r) => r.0,
        _ => panic!("{name} must be a reference"),
    }
}

fn donor_plan(db: &Connection, image: &MachineImage, target: &str, donor: &str) {
    let target = named_slot(image, target);
    let donor = named_slot(image, donor);
    db.execute(
        "INSERT INTO donor_edits VALUES (?1, ?2, ?3, ?4)",
        params![
            target as u32,
            record(&image.slots[target]),
            donor as u32,
            record(&image.slots[donor])
        ],
    )
    .unwrap();
}

fn candidate(image: &MachineImage) -> Vec<u8> {
    let bytes = write_machine_unchecked(image);
    validated_source(&bytes, &sig()).unwrap();
    bytes
}

fn cycle(mut m: Interp) -> Interp {
    m.collect_garbage().unwrap();
    store_cycle(m)
}

fn store_cycle(m: Interp) -> Interp {
    let dir = common::TempDir::new("vat-upgrades");
    let path = dir.join("heap.sqlite");
    let mut store = SqliteHeapStore::open(&path).unwrap();
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .unwrap();
    assert_eq!(crank(session.machine_mut(), "1"), "1");
    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    drop(session);
    store.close().unwrap();
    let store = SqliteHeapStore::open(&path).unwrap();
    let m = resume_from_store(&store, &sig()).unwrap().into_machine();
    store.close().unwrap();
    m
}

fn survives(bytes: &[u8], expression: &str, expected: &str) {
    let mut m = from_snapshot_bytes(bytes, &sig()).unwrap();
    assert_eq!(crank(&mut m, expression), expected);
    let mut m = cycle(m);
    assert_eq!(crank(&mut m, expression), expected);
}

fn function(image: &MachineImage, owner: u32) -> &FunctionRow {
    image
        .function_state
        .functions
        .iter()
        .find(|f| f.owner == owner)
        .unwrap()
}

// Mechanical body relinking only; the caller must establish semantic layout
// compatibility. Kept test-only because current validation cannot establish it.
fn transplant_body(image: &mut MachineImage, target: u32, donor: u32) {
    let donor = function(image, donor).clone();
    let target = image
        .function_state
        .functions
        .iter_mut()
        .find(|f| f.owner == target)
        .unwrap();
    target.segment = donor.segment;
    target.body_start = donor.body_start;
    target.body_len = donor.body_len;
}

fn future_only(image: &mut MachineImage, target: u32, donor: u32) -> Result<()> {
    if image
        .generators
        .iter()
        .filter_map(|g| g.frame.as_ref())
        .any(|f| f.cur_func == target)
        || image
            .promise_cluster
            .async_instances
            .iter()
            .any(|a| a.frame.cur_func == target)
    {
        return Err(refuse("affected saved frame requires continuation policy"));
    }
    transplant_body(image, target, donor);
    Ok(())
}

#[test]
fn donor_values_preserve_float_bits_and_reuse_variable_length_string_chunks() {
    let source = fixture("var surgeryBool = false, donorBool = true; var surgeryNumber = 1.5, donorNumber = -0.0; var surgeryString = 'short', donorString = 'a much longer replacement';");
    let image = validated_source(&source, &sig()).unwrap();
    let db = inspect(&source, &sig()).unwrap();
    for (target, donor) in [
        ("surgeryBool", "donorBool"),
        ("surgeryNumber", "donorNumber"),
        ("surgeryString", "donorString"),
    ] {
        donor_plan(&db, &image, target, donor);
    }
    let bytes = apply(&source, &sig(), &db).unwrap();
    let edited = validated_source(&bytes, &sig()).unwrap();
    assert_eq!(
        edited.chunks, image.chunks,
        "reuse an existing chunk; no arena allocation"
    );
    survives(
        &bytes,
        "surgeryBool && Object.is(surgeryNumber, -0) && surgeryString === donorString",
        "true",
    );
}

#[test]
fn reference_retargeting_changes_one_edge_not_every_alias() {
    let source = fixture(
        "var surgeryRef = {count: 1}; var retainedAlias = surgeryRef; var donorRef = {count: 9};",
    );
    let image = validated_source(&source, &sig()).unwrap();
    let db = inspect(&source, &sig()).unwrap();
    donor_plan(&db, &image, "surgeryRef", "donorRef");
    let bytes = apply(&source, &sig(), &db).unwrap();
    survives(&bytes, "surgeryRef === donorRef && retainedAlias !== surgeryRef && retainedAlias.count === 1 && surgeryRef.count === 9", "true");
}

#[test]
fn donor_swaps_are_simultaneous_and_conflicting_edits_are_refused() {
    let source = fixture("var surgeryLeft = 101; var surgeryRight = 202;");
    let image = validated_source(&source, &sig()).unwrap();
    let db = inspect(&source, &sig()).unwrap();
    donor_plan(&db, &image, "surgeryLeft", "surgeryRight");
    donor_plan(&db, &image, "surgeryRight", "surgeryLeft");
    survives(
        &apply(&source, &sig(), &db).unwrap(),
        "surgeryLeft === 202 && surgeryRight === 101",
        "true",
    );
    let slot = named_slot(&image, "surgeryLeft");
    db.execute(
        "INSERT INTO integer_edits VALUES (?1, ?2, 303)",
        params![slot as u32, record(&image.slots[slot])],
    )
    .unwrap();
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("duplicate"));
}

#[test]
fn side_state_array_growth_and_map_value_repair_need_no_new_heap_slots() {
    let source = fixture("var surgeryArray = [1, 2]; var arrayAlias = surgeryArray; var surgeryMap = new Map([['key', 3]]); var mapAlias = surgeryMap;");
    let mut image = validated_source(&source, &sig()).unwrap();
    let slots = image.slots.clone();
    let array_owner = owner(&image, "surgeryArray");
    let map_owner = owner(&image, "surgeryMap");
    let array = image
        .arrays
        .iter_mut()
        .find(|a| a.owner == array_owner)
        .unwrap();
    array.length = 5;
    array.items.push((4, Slot::integer(99)));
    let map = image
        .collections
        .iter_mut()
        .find(|m| m.owner == map_owner)
        .unwrap();
    assert_eq!(map.entries.len(), 1);
    map.entries[0].1 = Slot::integer(88);
    assert_eq!(image.slots, slots);
    survives(&candidate(&image), "arrayAlias === surgeryArray && arrayAlias.length === 5 && !(2 in arrayAlias) && arrayAlias[4] === 99 && mapAlias === surgeryMap && mapAlias.get('key') === 88", "true");
}

#[test]
fn linked_function_body_upgrade_preserves_alias_bound_target_and_map_key() {
    let source = fixture("function surgeryFunction(x) { return x + 1; } var functionAlias = surgeryFunction; var boundAlias = surgeryFunction.bind(null); var functionKeys = new Map([[surgeryFunction, 'kept']]);");
    let mut m = from_snapshot_bytes(&source, &sig()).unwrap();
    // Compile/link donor in the SOURCE realm, so names and segments are valid.
    crank(&mut m, "function donorFunction(x) { return x + 100; }");
    let source = m.write_snapshot(&sig()).unwrap();
    let mut image = validated_source(&source, &sig()).unwrap();
    let target = owner(&image, "surgeryFunction");
    let donor = owner(&image, "donorFunction");
    future_only(&mut image, target, donor).unwrap();
    // The old segment can be left unreferenced; current format requires dense
    // live segment IDs. Compact and remap rather than silently retain an orphan.
    let used: BTreeSet<_> = image
        .function_state
        .functions
        .iter()
        .filter_map(|f| f.segment)
        .collect();
    let old = image.function_state.segments.clone();
    assert_eq!(old.len(), 2);
    assert_eq!(used.len(), 1);
    assert!(matches!(
        from_snapshot_bytes(&write_machine_unchecked(&image), &sig()),
        Err(ironhorse_snapshot::SnapshotError::Corrupt(
            "function state: segments not densely referenced"
        ))
    ));
    image.function_state.segments = used.iter().map(|i| old[*i as usize].clone()).collect();
    for f in &mut image.function_state.functions {
        f.segment = f
            .segment
            .map(|s| used.iter().position(|i| *i == s).unwrap() as u32);
    }
    survives(&candidate(&image), "surgeryFunction(2) === 102 && functionAlias === surgeryFunction && functionAlias(3) === 103 && boundAlias(4) === 104 && functionKeys.get(surgeryFunction) === 'kept'", "true");
}

#[test]
fn closure_environment_rebinding_preserves_function_identity_but_switches_state() {
    let source = fixture("function makeReader(a, b) { return function reader() { return a * 100 + b; }; } var surgeryReader = makeReader(1, 2); var donorReader = makeReader(7, 8); var readerAlias = surgeryReader;");
    let mut image = validated_source(&source, &sig()).unwrap();
    let target = owner(&image, "surgeryReader");
    let donor = owner(&image, "donorReader");
    let env = function(&image, donor).closures;
    image
        .function_state
        .functions
        .iter_mut()
        .find(|f| f.owner == target)
        .unwrap()
        .closures = env;
    survives(
        &candidate(&image),
        "readerAlias === surgeryReader && readerAlias() === 708 && donorReader() === 708",
        "true",
    );
}

#[test]
fn anonymous_function_body_upgrade_preserves_unnamed_identity_and_aliases() {
    // Creation in an array avoids even an inferred variable/property name.
    let source = fixture("var anonymousHolder = [function (x) { return x + 1; }]; var anonymousAlias = anonymousHolder[0]; var anonymousBound = anonymousAlias.bind(null); var donorAnonymous = function (x) { return x + 100; };");
    let mut image = validated_source(&source, &sig()).unwrap();
    let target = owner(&image, "anonymousAlias");
    let donor = owner(&image, "donorAnonymous");
    assert_eq!(function(&image, target).name, "");
    let old = function(&image, target).clone();
    future_only(&mut image, target, donor).unwrap();
    assert_eq!(function(&image, target).name, old.name);
    assert_eq!(function(&image, target).closures, old.closures);
    survives(&candidate(&image), "anonymousAlias === anonymousHolder[0] && anonymousAlias.name === '' && anonymousHolder[0](1) === 101 && anonymousAlias(2) === 102 && anonymousBound(3) === 103", "true");
}

#[test]
fn prototype_method_upgrade_reaches_existing_instances_and_preserves_home_object() {
    let source = fixture("class SurgeryBase { compute(x) { return this.seed + x; } } class SurgeryChild extends SurgeryBase { constructor(seed) { super(); this.seed = seed; } compute(x) { return super.compute(x) + 1; } } class DonorBase { compute(x) { return 9999; } } class DonorChild extends DonorBase { compute(x) { return super.compute(x) * 10; } } var firstInstance = new SurgeryChild(10); var secondInstance = new SurgeryChild(20); var prototypeAlias = SurgeryChild.prototype; var methodAlias = firstInstance.compute; var methodBound = methodAlias.bind(firstInstance); var donorMethod = DonorChild.prototype.compute;");
    let mut image = validated_source(&source, &sig()).unwrap();
    let target = owner(&image, "methodAlias");
    let donor = owner(&image, "donorMethod");
    let home = function(&image, target).home;
    assert_ne!(home, function(&image, donor).home);
    future_only(&mut image, target, donor).unwrap();
    assert_eq!(function(&image, target).home, home);
    // super must still resolve through SurgeryChild's original home object,
    // rather than the donor's base (which deliberately returns 9999).
    survives(&candidate(&image), "firstInstance.compute(1) === 110 && secondInstance.compute(2) === 220 && methodAlias === prototypeAlias.compute && methodAlias.call(secondInstance, 3) === 230 && methodBound(4) === 140", "true");
}

#[test]
fn function_upgrade_reaches_an_already_registered_promise_reaction() {
    let source = reaction_fixture();
    let mut image = validated_source(&source, &sig()).unwrap();
    let target = owner(&image, "surgeryCallback");
    let donor = owner(&image, "donorCallback");
    future_only(&mut image, target, donor).unwrap();
    let mut m = cycle(from_snapshot_bytes(&candidate(&image), &sig()).unwrap());
    crank(&mut m, "settle(2)");
    assert_eq!(crank(&mut m, "callbackResult"), "102");
    // Repeated exact collection must preserve the upgraded saved reaction
    // through another checkpoint and reopen.
    let mut m = cycle(m);
    assert_eq!(crank(&mut m, "callbackResult"), "102");
}

fn reaction_fixture() -> Vec<u8> {
    fixture("function surgeryCallback(x) { return x + 1; } function donorCallback(x) { return x + 100; } var settle; var callbackResult = 0; var pendingUpgrade = new Promise(function (resolve) { settle = resolve; }); pendingUpgrade.then(surgeryCallback).then(function (x) { callbackResult = x; });")
}

#[test]
fn unedited_reaction_heap_repeated_gc_regression() {
    let mut m = cycle(from_snapshot_bytes(&reaction_fixture(), &sig()).unwrap());
    // Repeated collection remains valid after compact/checkpoint/reopen,
    // including before the saved reaction has settled.
    m.collect_garbage().unwrap();
    crank(&mut m, "settle(2)");
    assert_eq!(crank(&mut m, "callbackResult"), "3");
}

#[test]
fn future_only_guard_also_refuses_suspended_async_functions() {
    let source = fixture("var releaseAsync; var asyncGate = new Promise(function (r) { releaseAsync = r; }); async function surgeryAsync() { let saved = 10; await asyncGate; return saved + 1; } async function donorAsync() { let saved = 900; await asyncGate; return saved + 100; } var asyncResult = surgeryAsync();");
    let mut image = validated_source(&source, &sig()).unwrap();
    let target = owner(&image, "surgeryAsync");
    let donor = owner(&image, "donorAsync");
    assert!(!image.promise_cluster.async_instances.is_empty());
    let db = inspect(&source, &sig()).unwrap();
    let count: u32 = db
        .query_row(
            "SELECT count(*) FROM saved_frames WHERE family = 'async' AND function = ?1",
            [target],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert!(future_only(&mut image, target, donor)
        .unwrap_err()
        .to_string()
        .contains("saved frame"));
}

#[test]
fn same_capture_count_is_not_a_binding_layout_compatibility_proof() {
    let source = fixture("function makeOriginal(a, b) { return function original() { return a * 100 + b; }; } function makeReplacement(a, b) { return function replacement() { return b * 100 + a; }; } var surgeryCaptured = makeOriginal(1, 2); var donorCaptured = makeReplacement(7, 8);");
    let mut image = validated_source(&source, &sig()).unwrap();
    let target = owner(&image, "surgeryCaptured");
    let donor = owner(&image, "donorCaptured");
    future_only(&mut image, target, donor).unwrap();
    let bytes = candidate(&image);
    let mut m = from_snapshot_bytes(&bytes, &sig()).unwrap();
    let actual = crank(&mut m, "surgeryCaptured()");
    assert_eq!(actual, "102", "positional captures retain a,b while donor code expects b,a; a name-aware migration would return 201");
    survives(&bytes, "surgeryCaptured()", "102");
}

#[test]
fn donor_edits_refuse_stale_donors_types_free_rows_and_internal_links() {
    let source = fixture("var surgeryValue = 101; var donorValue = 202; var donorString = 'text'; var donorObject = {};");
    let image = validated_source(&source, &sig()).unwrap();
    let db = inspect(&source, &sig()).unwrap();
    donor_plan(&db, &image, "surgeryValue", "donorValue");
    db.execute(
        "UPDATE donor_edits SET expected_donor_record = zeroblob(20)",
        [],
    )
    .unwrap();
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("expected record"));
    db.execute("DELETE FROM donor_edits", []).unwrap();
    donor_plan(&db, &image, "surgeryValue", "donorString");
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("matching supported"));
    db.execute("DELETE FROM donor_edits", []).unwrap();
    let instance = owner(&image, "donorObject");
    db.execute(
        "INSERT INTO donor_edits VALUES (?1, ?2, ?1, ?2)",
        params![instance, record(&image.slots[instance as usize])],
    )
    .unwrap();
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("matching supported"));
    db.execute_batch("DROP TABLE donor_edits; CREATE TABLE donor_edits(slot, expected_record, donor, expected_donor_record)").unwrap();
    donor_plan(&db, &image, "surgeryValue", "donorValue");
    for bad in ["-1", "4294967296", "1.5", "NULL", "'bad'"] {
        db.execute(&format!("UPDATE donor_edits SET donor = {bad}"), [])
            .unwrap();
        assert!(apply(&source, &sig(), &db).is_err(), "{bad}");
    }
    db.execute("UPDATE snapshot SET workspace_version = 2", [])
        .unwrap();
    db.execute_batch(
        "DROP TABLE snapshot; CREATE TABLE snapshot(singleton, workspace_version, source_sha256)",
    )
    .unwrap();
    db.execute(
        "INSERT INTO snapshot VALUES (1, 1, ?1)",
        [hex_sha256(&source)],
    )
    .unwrap();
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("version"));

    let mut image = validated_source(&source, &sig()).unwrap();
    let free = ironhorse_vm::SlotIndex(image.slots.len() as u32);
    image.slots.push(Slot::integer(99));
    image.slot_free.push(free.0);
    let source = candidate(&image);
    let image = validated_source(&source, &sig()).unwrap();
    let db = inspect(&source, &sig()).unwrap();
    let target = named_slot(&image, "surgeryValue") as u32;
    db.execute(
        "INSERT INTO donor_edits VALUES (?1, ?2, ?3, ?4)",
        params![
            target,
            record(&image.slots[target as usize]),
            free.0,
            record(&image.slots[free.0 as usize])
        ],
    )
    .unwrap();
    assert!(apply(&source, &sig(), &db)
        .unwrap_err()
        .to_string()
        .contains("free"));
}

#[test]
fn property_rename_reuses_an_interned_key_and_preserves_object_aliases() {
    let source = fixture("var surgeryRecord = {oldField: 11}; var recordAlias = surgeryRecord; var keySeed = {newField: 0};");
    let mut image = validated_source(&source, &sig()).unwrap();
    let property = named_slot(&image, "oldField");
    let new_id = image.slots[named_slot(&image, "newField")].id;
    image.slots[property].id = new_id;
    survives(&candidate(&image), "recordAlias === surgeryRecord && recordAlias.newField === 11 && !('oldField' in recordAlias)", "true");
}

#[test]
fn suspended_generator_needs_pc_mapping_and_keeps_old_locals_after_mapping() {
    let source = fixture("function* surgeryGenerator() { let saved = 10; yield saved; return saved + 1; } function* donorGenerator() { let saved = 900; yield saved; return saved + 100; } var suspended = surgeryGenerator(); var donorSuspended = donorGenerator(); suspended.next(); donorSuspended.next();");
    let mut image = validated_source(&source, &sig()).unwrap();
    let target = owner(&image, "surgeryGenerator");
    let donor = owner(&image, "donorGenerator");
    assert!(future_only(&mut image, target, donor)
        .unwrap_err()
        .to_string()
        .contains("saved frame"));
    transplant_body(&mut image, target, donor);
    assert!(
        from_snapshot_bytes(&write_machine_unchecked(&image), &sig()).is_err(),
        "old absolute PC should not belong to donor body"
    );
    let donor_pc = image
        .generators
        .iter()
        .filter_map(|g| g.frame.as_ref())
        .find(|f| f.cur_func == donor)
        .unwrap()
        .resume_pc;
    let frame = image
        .generators
        .iter_mut()
        .filter_map(|g| g.frame.as_mut())
        .find(|f| f.cur_func == target)
        .unwrap();
    frame.resume_pc = donor_pc; // Hand-mapped ONLY for this known, matching fixture layout.
    let bytes = candidate(&image);
    let mut m = cycle(from_snapshot_bytes(&bytes, &sig()).unwrap());
    assert_eq!(
        crank(&mut m, "suspended.next().value"),
        "110",
        "old local 10 under new +100 body, not donor initialization 900"
    );
    assert_eq!(crank(&mut m, "donorSuspended.next().value"), "1000");
    assert_eq!(crank(&mut m, "suspended.next().done"), "true");
}
