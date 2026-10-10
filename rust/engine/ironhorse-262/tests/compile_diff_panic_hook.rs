//! F185: batch helpers must leave process-wide panic diagnostics to the caller.
use std::panic;
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use ironhorse_262::compile_diff::{
    compile_diff_programs, module_compile_diff_programs, symbols_diff_programs,
};

#[test]
fn batch_helpers_leave_the_callers_hook_intact() {
    const CHILD: &str = "IRONHORSE_PANIC_HOOK_CHILD";
    if std::env::var_os(CHILD).is_none() {
        // Isolate the test-owned hook and any regression's double-panic abort
        // from other tests. No oracle execution is needed for empty batches.
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "batch_helpers_leave_the_callers_hook_intact"])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "child failed: {}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }

    static CALLS: AtomicUsize = AtomicUsize::new(0);
    panic::set_hook(Box::new(|_| {
        // take_hook/set_hook panic from a panicking thread. Calling the batch
        // helpers here detects even a temporary hook replacement, deterministically.
        assert_eq!(compile_diff_programs(&[]).total, 0);
        assert_eq!(module_compile_diff_programs(&[]).total, 0);
        assert_eq!(symbols_diff_programs(&[]).checked, 0);
        CALLS.fetch_add(1, Ordering::SeqCst);
    }));
    for expected in 1..=2 {
        assert!(panic::catch_unwind(|| panic!("caller diagnostic")).is_err());
        assert_eq!(CALLS.load(Ordering::SeqCst), expected);
    }
}
