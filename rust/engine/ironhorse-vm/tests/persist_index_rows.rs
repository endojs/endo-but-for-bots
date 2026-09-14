//! Ordinary indexed properties must participate in the native-reference gate.
use ironhorse_vm::opcode::{instruction_len, Opcode};
use ironhorse_vm::{parse_symbols, Interp, Machine};

fn stored_native(source: &str) -> Interp {
    stored_native_opcode(source, Opcode::XS_CODE_FALSE)
}

fn stored_native_opcode(source: &str, placeholder: Opcode) -> Interp {
    let (code, symbols) = minted_native(source, placeholder);
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run_bounded(&code, 10_000);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert!(vm.is_quiescent());
    vm
}

/// Compile `source` with its one `placeholder` instruction replaced by
/// `COPY_OBJECT`, so the value under test is a native minted above the
/// boot floor: a function restore cannot rebuild.
fn minted_native(source: &str, placeholder: Opcode) -> (Vec<u8>, Vec<u8>) {
    let (mut code, symbols) = ironhorse_compile::compile_atoms(source).expect("compile");
    // COPY_OBJECT mints an internal native above the boot floor and pushes
    // one value. Preserve the original instruction width with ignored DEBUGGER
    // opcodes when replacing an integer, so branch offsets remain valid.
    let mut pc = 0;
    let mut replaced = 0;
    while pc < code.len() {
        let len = instruction_len(&code, pc).expect("valid instruction");
        if code[pc] == placeholder as u8 {
            assert!(len == 1 || (placeholder == Opcode::XS_CODE_INTEGER_2 && len == 3));
            code[pc] = Opcode::XS_CODE_COPY_OBJECT as u8;
            code[pc + 1..pc + len].fill(Opcode::XS_CODE_DEBUGGER as u8);
            replaced += 1;
        }
        pc += len;
    }
    assert_eq!(
        replaced, 1,
        "fixture must mint exactly one native: {source}"
    );
    (code, symbols)
}

#[test]
fn indexed_properties_refuse_non_persisted_natives() {
    assert_native_refused(false);
}

#[test]
fn checkpoint_indexed_properties_refuse_non_persisted_natives() {
    assert_native_refused(true);
}

fn assert_native_refused(checkpoint: bool) {
    for source in ["var box = [false]; 0;", "var box = {}; box[0] = false; 0;"] {
        let vm = stored_native(source);
        let refusal = Some("a stored reference to a non-persisted native function");
        let result = if checkpoint {
            vm.stored_unpersistable_row_at_checkpoint()
        } else {
            vm.stored_unpersistable_row()
        };
        assert_eq!(result, refusal, "{source}");
    }
}

#[test]
fn indexed_properties_allow_boot_and_guest_functions() {
    let (code, symbols) = ironhorse_compile::compile_atoms(
        "var box = {}; box[0] = Math.abs; box[1] = function () { return 7; }; 0;",
    )
    .expect("compile");
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run_bounded(&code, 10_000);
    assert!(outcome.completed, "{:?}", outcome.halt);
    assert!(vm.is_quiescent());
    assert!(vm
        .index_props_snapshot()
        .iter()
        .any(|(_, _, items)| items.len() == 2));
    assert_eq!(vm.stored_unpersistable_row(), None);
    assert_eq!(vm.stored_unpersistable_row_at_checkpoint(), None);
}

#[test]
fn carried_holders_refuse_non_persisted_natives() {
    for (holder, source) in [
        ("Map key", "var box = new Map([[false, 1]]); 0;"),
        ("Map value", "var box = new Map([[1, false]]); 0;"),
        ("Set member", "var box = new Set([false]); 0;"),
        (
            "accessor getter",
            "var box = {}; Object.defineProperty(box, 'x', {get: false}); 0;",
        ),
        (
            "accessor setter",
            "var box = {}; Object.defineProperty(box, 'x', {set: false}); 0;",
        ),
        ("bound target", "var box = false.bind(null); 0;"),
        ("bound this", "var box = (function () {}).bind(false); 0;"),
        (
            "bound argument",
            "var box = (function () {}).bind(null, false); 0;",
        ),
        ("proxy target", "var box = new Proxy(false, {}); 0;"),
        ("proxy handler", "var box = new Proxy({}, false); 0;"),
        (
            "private value",
            "class Box { #x; constructor(x) { this.#x = x; } } var box = new Box(false); 0;",
        ),
        ("promise result", "var box = Promise.resolve(false); 0;"),
        // The iterated object is an iterator's internal slot, mirrored by
        // no heap property: `ToObject(this)` of the generic array methods.
        (
            "array iterator receiver",
            "var box = Array.prototype.values.call(false); 0;",
        ),
        (
            "array entries iterator receiver",
            "var box = Array.prototype.entries.call(false); 0;",
        ),
    ] {
        let mut vm = stored_native(source);
        // Remove abandoned temporaries so only live holders can justify refusal.
        vm.collect_garbage().unwrap();
        let refusal = Some("a stored reference to a non-persisted native function");
        assert_eq!(vm.stored_unpersistable_row(), refusal, "{holder}");
        assert_eq!(
            vm.stored_unpersistable_row_at_checkpoint(),
            refusal,
            "{holder}"
        );
    }
}

#[test]
fn suspended_generator_refuses_a_non_persisted_native() {
    // Generator scaffolding emits its own FALSE and NULL instructions. A
    // unique two-byte integer operand identifies the value under test.
    let mut vm = stored_native_opcode(
        "function* f() { let x = 12345; yield 1; return x; } var box = f(); box.next(); 0;",
        Opcode::XS_CODE_INTEGER_2,
    );
    vm.collect_garbage().unwrap();
    let refusal = Some("a stored reference to a non-persisted native function");
    assert_eq!(vm.stored_unpersistable_row(), refusal);
    assert_eq!(vm.stored_unpersistable_row_at_checkpoint(), refusal);
}

#[test]
fn pending_shared_compartment_jobs_refuse_a_non_persisted_native() {
    // Under shared compartments the boundary admits a queued job (the host
    // pumps between cranks), so the job queue reaches the gate as a
    // persisted holder: its reaction handlers and settled value travel in
    // no heap property.
    for (holder, source) in [
        ("reaction handler", "Promise.resolve(1).then(false); 0;"),
        (
            "reaction value",
            "Promise.resolve(false).then(function (v) { return v; }); 0;",
        ),
        (
            "thenable job receiver",
            "(function () { var t = false; t.then = function (r) { r(1); }; Promise.resolve(t); })(); 0;",
        ),
    ] {
        let (code, symbols) = minted_native(source, Opcode::XS_CODE_FALSE);
        let machine = Machine::new();
        let compartment = machine.new_compartment();
        let outcome = compartment.evaluate_with_symbols(&code, &symbols);
        assert!(outcome.completed, "{holder}: {:?}", outcome.halt);
        // Remove abandoned temporaries so only the queued job can justify
        // the refusal.
        machine.collect().expect("collect at the shared boundary");
        let (quiescent, pending, full, checkpoint) = machine
            .with_persistence(|vm| {
                (
                    vm.is_quiescent(),
                    vm.has_pending_jobs(),
                    vm.stored_unpersistable_row(),
                    vm.stored_unpersistable_row_at_checkpoint(),
                )
            })
            .expect("persistence borrow");
        assert!(quiescent && pending, "{holder}: the gate must see a queued job");
        let refusal = Some("a stored reference to a non-persisted native function");
        assert_eq!(full, refusal, "{holder}");
        assert_eq!(checkpoint, refusal, "{holder}");
    }
}

#[test]
fn suspended_async_generator_refuses_a_non_persisted_native() {
    // An async generator instance (architecture review F127) holds a
    // suspended frame and a request queue; each is a stored-reference
    // holder the gate must walk now that the table persists.
    let gate = "var gate = new Promise(function () {});";
    for (holder, source) in [
        (
            "frame local",
            "async function* f() { let x = 12345; yield 1; return x; } var box = f(); box.next(); 0;",
        ),
        (
            "active request value",
            "async function* f() { await gate; } var box = f(); box.next(12345); 0;",
        ),
        (
            "queued request value",
            "async function* f() { await gate; } var box = f(); box.next(); box.next(12345); 0;",
        ),
    ] {
        let mut vm = stored_native_opcode(&format!("{gate} {source}"), Opcode::XS_CODE_INTEGER_2);
        vm.collect_garbage().unwrap();
        let refusal = Some("a stored reference to a non-persisted native function");
        assert_eq!(vm.stored_unpersistable_row(), refusal, "{holder}");
        assert_eq!(
            vm.stored_unpersistable_row_at_checkpoint(),
            refusal,
            "{holder}"
        );
    }
}
