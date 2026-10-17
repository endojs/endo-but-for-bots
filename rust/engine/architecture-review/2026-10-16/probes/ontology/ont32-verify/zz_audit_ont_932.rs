//! Verifier probe for ONT-32: does the VERS stamp bound the content the
//! reader accepts for formats 25/26, and is "several accepted stamps per
//! machine" specific to that content?
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
    ironhorse_snapshot::sha256::hex_sha256(b)[..16].to_string()
}

fn atoms(bytes: &[u8]) -> String {
    let mut v = Vec::new();
    for t in [b"WKRF", b"FNRG", b"ABUF", b"TARR", b"ASYN"] {
        if bytes.windows(4).any(|w| w == t) {
            v.push(String::from_utf8_lossy(t).to_string());
        }
    }
    v.join(",")
}

fn try_stamps(label: &str, src: &str, observe: &str, stamps: &[u32]) {
    println!("=== {label}");
    let m = machine(src);
    let bytes = m.write_snapshot(&sig()).expect("snapshot");
    println!("  writer stamp-26 sha256[..16]={} atoms=[{}]", hex8(&bytes), atoms(&bytes));
    for &v in stamps {
        let patched = restamp(&bytes, v);
        match read_machine(&patched, &sig()) {
            Ok(image) => {
                let mut resumed = from_snapshot_bytes(&patched, &sig()).expect("adopt");
                let obs = crank(&mut resumed, observe);
                println!(
                    "  stamp {v}: ACCEPTED (image.version={}, sha256[..16]={}) observe -> {:?} {:?}",
                    image.version.format_version,
                    hex8(&patched),
                    obs.1,
                    obs.2
                );
            }
            Err(e) => println!("  stamp {v}: refused: {e}"),
        }
    }
}

#[test]
fn zz_audit_ont_932() {
    try_stamps(
        "plain machine (no format-specific content)",
        "var x = { a: 1 }; 0",
        "x.a",
        &[15, 16, 20, 24, 25],
    );
    try_stamps(
        "control: suspended async generator (ASYN format 23 trailer)",
        "var never = new Promise(function () {}); \
         async function* g() { await never; } var it = g(); it.next(); 0",
        "typeof it",
        &[16, 22, 23],
    );
    try_stamps(
        "WeakRef only (WKRF, format 25)",
        "var t = {}; var w = new WeakRef(t); 0",
        "w.deref() === t",
        &[16, 24],
    );
    try_stamps(
        "FinalizationRegistry only (FNRG, format 25)",
        "var t = {}; var r = new FinalizationRegistry(function () {}); r.register(t, 1); 0",
        "typeof r.register",
        &[16, 24],
    );
    try_stamps(
        "resizable ArrayBuffer + length-tracking view (ABUF bit 2 / TARR sentinel, format 26)",
        "var b = new ArrayBuffer(4, { maxByteLength: 16 }); var u = new Uint8Array(b); 0",
        "b.resize(12); [b.resizable, b.maxByteLength, u.length].join()",
        &[16, 24, 25],
    );
}
