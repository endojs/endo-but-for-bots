//! TEMPORARY audit probe (SNI region, part 4). Delete after the audit.
#[path = "common/compile.rs"]
mod guest_compile;
use guest_compile::compile;

use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

#[test]
fn sni_part4_meter_counters() {
    let (b, n) = compile("var t = 1; t");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    assert!(m.run(&b).completed);
    let honest = m.write_snapshot(&sig()).unwrap();
    let mut image = read_machine(&honest, &sig()).unwrap();
    println!(
        "[P11] honest METR index={} interval={} count={}",
        image.meter.index, image.meter.interval, image.meter.count
    );
    image.meter.index = u64::MAX - 3;
    let crafted = write_machine_unchecked(&image);
    match from_snapshot_bytes(&crafted, &sig()) {
        Ok(mut r) => {
            println!("[P11] METR index=u64::MAX-3 ACCEPTED");
            let (b2, n2) = compile("t + 1");
            let code = r.relink_crank(&b2, &n2).unwrap();
            let out = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let o = r.run(&code);
                format!("completed={} result={} halt={:?}", o.completed, o.result, o.halt)
            }));
            match out {
                Ok(s) => println!("[P11] crank returned: {s}"),
                Err(e) => println!(
                    "[P11] HOST PANIC: {}",
                    e.downcast_ref::<String>()
                        .cloned()
                        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_default()
                ),
            }
        }
        Err(e) => println!("[P11] refused: {e}"),
    }
}
