//! Additional carried-state families identified in the PR #1262 review.
//! The shared twin checks values and exact costs across eager/lazy store resume,
//! then checkpoints and validates both continuations. Also exercise blob restore.
#[path = "common/twin.rs"]
mod carry;

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::{store::MemoryStore, Signature};
use ironhorse_vm::Interp;

#[test]
fn additional_state_families_preserve_values_and_costs() {
    for (label, setup, advance, observe, expected) in [
        ("index properties", "var o = {}; o[0] = 'a'; o[7] = 'b'; 0", "delete o[0]; o[3] = 'c'; 0", "Object.keys(o).join(',') + ':' + o[3] + o[7]", "3,7:cb"),
        ("symbol registry", "var s = Symbol.for('key'); var o = {}; o[s] = 41; 0", "o[Symbol.for('key')]++; 0", "Symbol.keyFor(s) + ':' + (s === Symbol.for('key')) + ':' + o[s]", "key:true:42"),
        ("error data", "var e = new TypeError('boom'); 0", "e.message = 'changed'; 0", "Object.prototype.toString.call(e) + ':' + e.name + ':' + e.message", "[object Error]:TypeError:changed"),
        ("error stack", "function fail() { return new Error('boom'); } var e = fail(); var stack = e.stack; 0", "0", "(e.stack === stack) + ':' + typeof e.stack", "true:string"),
        ("DataView", "var buffer = new ArrayBuffer(16); var view = new DataView(buffer, 4, 8); var bytes = new Uint8Array(buffer); view.setUint16(0, 258, true); 0", "bytes[5] = 3; 0", "view.byteOffset + ':' + view.byteLength + ':' + view.getUint16(0, true)", "4:8:770"),
        ("primitive wrappers", "var n = new Number(41); var s = new String('hi'); n.extra = 1; 0", "n.extra++; 0", "n.valueOf() + ':' + s.valueOf() + ':' + n.extra", "41:hi:2"),
        ("mapped arguments", "var args, read; (function (x) { args = arguments; read = () => x; })(10); 0", "args[0] = 42; 0", "args.length + ':' + read()", "1:42"),
    ] {
        let observations = [advance, observe];
        let twins = carry::twin(setup, &observations, &mut MemoryStore::new());
        assert!(twins.iter().all(|outcome| outcome.0), "{label}");
        assert_eq!(twins.last().unwrap().2, expected, "{label}");
        let (code, names) = carry::compile(setup);
        let mut machine = Interp::new();
        machine.link_intrinsics(&names);
        assert!(machine.run(&code).completed, "{label}");
        let signature = Signature::new("additional-carried-state");
        let bytes = machine.write_snapshot(&signature).unwrap();
        let mut resumed = from_snapshot_bytes(&bytes, &signature).unwrap();
        for (source, expected) in observations.into_iter().zip(twins) {
            assert_eq!(carry::crank(&mut resumed, source), expected, "{label}");
        }
    }
}
