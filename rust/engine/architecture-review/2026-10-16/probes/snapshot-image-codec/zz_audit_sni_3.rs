//! TEMPORARY audit probe (SNI region, part 3). Delete after the audit.
#[path = "common/compile.rs"]
mod guest_compile;
use guest_compile::compile;

use ironhorse_snapshot::atom::AtomReader;
use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn machine(src: &str) -> Interp {
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(o.completed, "fixture: {:?}", o.halt);
    m
}

#[test]
fn sni_part3() {
    // P9: a container restamped to format 15 skips the canonical-bytes gate,
    // so the reserved byte of every slot record becomes free payload.
    let m = machine("var o = {a: 1}; var t = 2; t");
    let honest = m.write_snapshot(&sig()).unwrap();
    let mut image = read_machine(&honest, &sig()).unwrap();
    image.version.format_version = 15;
    // A native-name suffix forces the writer to stamp format 18; a legacy
    // (pre-18) FUNC payload has none.
    image.function_state.native_names = None;
    let mut crafted = write_machine_unchecked(&image);
    {
        let r = AtomReader::parse(&crafted).unwrap();
        let v = r.find(ironhorse_snapshot::VERS).unwrap();
        println!("[P9] written VERS format = {}", u32::from_be_bytes(v.payload[4..8].try_into().unwrap()));
    }
    let clean15 = crafted.clone();
    println!(
        "[P9] clean format-15 restamp: {:?}",
        from_snapshot_bytes(&clean15, &sig()).err().map(|e| e.to_string())
    );
    // Locate HEAP and set every record's reserved byte (offset 9) to 0xA5.
    let (heap_at, heap_len) = {
        let r = AtomReader::parse(&crafted).unwrap();
        let heap = r.find(ironhorse_snapshot::HEAP).unwrap();
        let at = heap.payload.as_ptr() as usize - crafted.as_ptr() as usize;
        (at, heap.payload.len())
    };
    let slot_count = u32::from_be_bytes(crafted[heap_at..heap_at + 4].try_into().unwrap()) as usize;
    let free = u32::from_be_bytes(crafted[heap_at + 4..heap_at + 8].try_into().unwrap()) as usize;
    let records = heap_at + 12 + 4 * free;
    for i in 0..slot_count {
        crafted[records + i * 20 + 9] = 0xA5;
    }
    let _ = heap_len;
    match from_snapshot_bytes(&crafted, &sig()) {
        Ok(r) => {
            let again = r.write_snapshot(&sig()).unwrap();
            println!(
                "[P9] format-15 restamp with {slot_count} dirty reserved bytes ACCEPTED; rewrite==crafted:{} rewrite==honest:{}",
                again == crafted,
                again == honest
            );
        }
        Err(e) => println!("[P9] refused: {e}"),
    }
    // The same patch on the current format is refused (control).
    let mut current = honest.clone();
    let (heap_at, _) = {
        let r = AtomReader::parse(&current).unwrap();
        let heap = r.find(ironhorse_snapshot::HEAP).unwrap();
        (heap.payload.as_ptr() as usize - current.as_ptr() as usize, 0)
    };
    let free = u32::from_be_bytes(current[heap_at + 4..heap_at + 8].try_into().unwrap()) as usize;
    current[heap_at + 12 + 4 * free + 9] = 0xA5;
    println!(
        "[P9 control] format-26 dirty reserved byte: {:?}",
        from_snapshot_bytes(&current, &sig()).err().map(|e| e.to_string())
    );

    // P10: freed slots stay in the container forever (arena never shrinks).
    let mut m = machine(
        "var a = []; for (var i = 0; i < 50000; i++) { a.push({x: i}); } a.length",
    );
    let before = m.write_snapshot(&sig()).unwrap().len();
    let (b, n) = compile("a = 0; 1");
    let code = m.relink_crank(&b, &n).unwrap();
    assert!(m.run(&code).completed);
    let stats = m.collect_garbage().expect("gc");
    let after = m.write_snapshot(&sig()).unwrap();
    let image = read_machine(&after, &sig()).unwrap();
    println!(
        "[P10] container before drop={before} B; after GC={} B; slots={} free={} live={} (free records+list on wire = {} B); stats={stats:?}",
        after.len(),
        image.slots.len(),
        image.slot_free.len(),
        image.slot_live,
        image.slot_free.len() * 24
    );
}
