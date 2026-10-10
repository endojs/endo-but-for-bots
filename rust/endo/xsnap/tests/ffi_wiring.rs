//! Regression coverage for the installed guards, including callbacks outside
//! worker_io. The source invariant covers every production callback; the live
//! XS call proves that catching a panic really survives the C/Rust boundary.

use std::fs;
use std::path::Path;
use xsnap::{worker_io, JsValue, Machine, DEFAULT_CREATION};

fn check_callbacks(path: &Path, count: &mut usize) {
    if path.is_dir() {
        for entry in fs::read_dir(path).unwrap() {
            check_callbacks(&entry.unwrap().path(), count);
        }
        return;
    }
    if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
        return;
    }
    let source = fs::read_to_string(path).unwrap();
    // Production callbacks are top-level declarations. Test-only callbacks
    // deliberately exercise raw XS APIs and are outside this invariant.
    let production = source.split("mod tests {").next().unwrap();
    let lines: Vec<_> = production.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        let line = line.trim();
        if !(line.starts_with("pub ")
            || line.starts_with("unsafe extern ")
            || line.starts_with("extern "))
            || !line.contains("extern \"C\" fn ")
        {
            continue;
        }
        *count += 1;
        let declaration = lines[index..].join("\n");
        let (_, body) = declaration.split_once('{').expect("callback body");
        let first_statement = body
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with("//"))
            .expect("nonempty callback body");
        assert!(
            [
                "guard_ffi(",
                "guard_ffi_ret(",
                "worker_io::guard_ffi(",
                "worker_io::guard_ffi_ret(",
                "crate::worker_io::guard_ffi(",
                "crate::worker_io::guard_ffi_ret("
            ]
            .iter()
            .any(|guard| first_statement.starts_with(guard)),
            "{}:{}: {line} must guard its entire body; found {first_statement}",
            path.display(),
            index + 1,
        );
    }
}

#[test]
fn every_production_c_callback_starts_with_a_panic_guard() {
    let mut count = 0;
    check_callbacks(
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut count,
    );
    assert!(
        count >= 70,
        "source scan unexpectedly skipped callbacks: {count}"
    );
}

#[test]
fn panic_from_a_real_xs_callback_is_confined_to_its_worker() {
    xsnap::ensure_shared_cluster();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    let (panicked_tx, panicked_rx) = std::sync::mpsc::channel();
    let sibling = std::thread::spawn(move || {
        let machine = Machine::new(&DEFAULT_CREATION, "healthy sibling").unwrap();
        ready_tx.send(()).unwrap();
        panicked_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(!worker_io::ffi_panicked());
        assert!(matches!(machine.eval("6 * 7"), Some(JsValue::Integer(42))));
    });
    ready_rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap();
    std::thread::spawn(|| {
        let machine = Machine::new(&DEFAULT_CREATION, "panicking callback").unwrap();
        assert!(worker_io::take_ffi_panic().is_none());
        // No transport is installed: the actual recvFrame host implementation
        // panics before accessing the transport. XS invokes it through its
        // native C callback frame, with a valid machine and JS call frame.
        machine.define_function("recvFrame", worker_io::host_recv_frame, 0);
        machine.eval("recvFrame()");
        assert!(worker_io::ffi_panicked());
        let panic = worker_io::take_ffi_panic().expect("callback panic recorded");
        assert!(panic.message.contains("WorkerTransport"), "{}", panic.message);
    })
    .join()
    .expect("guard must prevent a process abort or thread unwind");
    panicked_tx.send(()).unwrap();
    sibling.join().unwrap();
}
