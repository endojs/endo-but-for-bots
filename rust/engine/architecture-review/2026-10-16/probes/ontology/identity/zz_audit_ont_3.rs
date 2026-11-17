//! Audit probe (ontology/identity): does the container's VERS stamp
//! identify the content the reader accepts? Format 23/24 trailers are
//! refused under an older stamp; are format 25/26 contents?
#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig};
use ironhorse_snapshot::image::read_machine;
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_vm::Interp;

fn machine(src: &str) -> Interp {
    let (bc, names) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let o = m.run(&bc);
    assert!(o.completed, "{:?}", o.halt);
    m
}

fn restamp(bytes: &[u8], version: u32) -> Vec<u8> {
    let vers = bytes.windows(4).position(|w| w == b"VERS").expect("VERS");
    let iron = vers + bytes[vers..].windows(4).position(|w| w == b"IRON").expect("IRON");
    let mut out = bytes.to_vec();
    out[iron + 4..iron + 8].copy_from_slice(&version.to_be_bytes());
    out
}

fn hex8(b: &[u8]) -> String {
    let d = ironhorse_snapshot::sha256::hex_sha256(b);
    d[..16].to_string()
}

fn try_stamps(label: &str, src: &str, observe: &str, stamps: &[u32]) {
    println!("=== {label}");
    let m = machine(src);
    let bytes = m.write_snapshot(&sig()).expect("snapshot");
    println!("  writer stamp 26 container sha256[..16] = {}", hex8(&bytes));
    for &v in stamps {
        let patched = restamp(&bytes, v);
        match read_machine(&patched, &sig()) {
            Ok(image) => {
                let mut resumed = from_snapshot_bytes(&patched, &sig()).expect("adopt");
                let obs = crank(&mut resumed, observe);
                let rewrite = resumed.write_snapshot(&sig()).unwrap();
                println!(
                    "  stamp {v}: ACCEPTED (image.version={}, sha256[..16]={}); observe {observe:?} -> {:?}; rewrite stamp-26 sha256[..16]={}",
                    image.version.format_version,
                    hex8(&patched),
                    obs.2,
                    hex8(&rewrite)
                );
            }
            Err(e) => println!("  stamp {v}: refused: {e}"),
        }
    }
}

#[test]
fn zz_audit_ont_3() {
    try_stamps(
        "control: async generator suspended (ASYN generator trailer, format 23)",
        "var never = new Promise(function () {}); \
         async function* g() { await never; } var it = g(); it.next(); 0",
        "typeof it",
        &[22, 23],
    );
    try_stamps(
        "WeakRef + resizable ArrayBuffer + length-tracking view (formats 25/26)",
        "var t = {}; var w = new WeakRef(t); \
         var b = new ArrayBuffer(4, { maxByteLength: 16 }); var u = new Uint8Array(b); 0",
        "b.resize(12); [w.deref() === t, b.resizable, b.maxByteLength, u.length].join()",
        &[20, 24, 25],
    );
}
