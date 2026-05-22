// Seccomp-bpf filter for the runtime-agent (DESIGN.md §5.4, §10 M4).
//
// Block-list strategy: deny the documented-dangerous syscalls
// (ptrace, kernel keyring, BPF, perf_event_open, kexec, module
// loading) plus a few others that have no business inside the guest
// agent. Everything else is allowed — this is a defense-in-depth
// layer on top of the unprivileged-uid drop, NOT a tight allow-list.
//
// Enabling: compile with `--features seccomp`. The filter is installed
// once at agent startup, just after the initial Ready is sent on the
// control channel. PR_SET_NO_NEW_PRIVS is set first so the filter
// applies to any future execve as well.
//
// A tight allow-list is roadmap and depends on inventorying what
// `claude -p` actually uses at runtime; over-restricting it would
// kill the agent during normal operation.

#[cfg(feature = "seccomp")]
mod imp {
    use seccompiler::{
        BpfProgram, SeccompAction, SeccompFilter, SeccompRule, TargetArch,
    };
    use std::collections::BTreeMap;

    /// Syscall numbers we explicitly deny. Linux assigns syscall
    /// numbers per arch; we resolve them at compile time via libc
    /// constants. Arch-specific entries (`ioperm`, `iopl`) are gated
    /// — they're x86-only and don't exist as syscalls on aarch64.
    fn deny_list() -> Vec<i64> {
        #[allow(unused_mut)]
        let mut v = vec![
            libc::SYS_ptrace as i64,
            libc::SYS_add_key as i64,
            libc::SYS_request_key as i64,
            libc::SYS_keyctl as i64,
            libc::SYS_bpf as i64,
            libc::SYS_perf_event_open as i64,
            libc::SYS_kexec_load as i64,
            libc::SYS_init_module as i64,
            libc::SYS_finit_module as i64,
            libc::SYS_delete_module as i64,
            libc::SYS_mount as i64,
            libc::SYS_umount2 as i64,
            libc::SYS_pivot_root as i64,
            libc::SYS_swapon as i64,
            libc::SYS_swapoff as i64,
            libc::SYS_reboot as i64,
            libc::SYS_settimeofday as i64,
            libc::SYS_adjtimex as i64,
        ];
        // `ioperm` / `iopl` are direct-hardware-port-IO syscalls; the
        // kernel only exposes them on x86 family arches. Including
        // them unconditionally fails to compile for aarch64 guests.
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        {
            v.push(libc::SYS_ioperm as i64);
            v.push(libc::SYS_iopl as i64);
        }
        v
    }

    pub fn install() -> Result<(), String> {
        // PR_SET_NO_NEW_PRIVS so the filter survives execve.
        let rc = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
        if rc != 0 {
            return Err(format!("PR_SET_NO_NEW_PRIVS failed: {}", std::io::Error::last_os_error()));
        }

        // The filter: default-allow, deny each entry in deny_list().
        let mut rules: BTreeMap<i64, Vec<SeccompRule>> = BTreeMap::new();
        for sysno in deny_list() {
            rules.insert(sysno, vec![]);
        }
        let filter = SeccompFilter::new(
            rules,
            // Mismatch action: ALLOW (everything not in the deny list).
            SeccompAction::Allow,
            // Match action: KILL_PROCESS for a hard fail.
            SeccompAction::KillProcess,
            #[cfg(target_arch = "x86_64")]
            TargetArch::x86_64,
            #[cfg(target_arch = "aarch64")]
            TargetArch::aarch64,
        )
        .map_err(|e| format!("seccomp filter build: {e}"))?;

        let program: BpfProgram = filter
            .try_into()
            .map_err(|e| format!("seccomp compile: {e}"))?;
        seccompiler::apply_filter(&program)
            .map_err(|e| format!("seccomp apply: {e}"))?;
        Ok(())
    }
}

#[cfg(not(feature = "seccomp"))]
mod imp {
    pub fn install() -> Result<(), String> {
        Ok(())
    }
}

pub use imp::install;

// Behavioural tests. These exercise the actual filter by forking a
// child, installing it, then attempting a denied syscall in the
// child and observing that the kernel kills it with `SIGSYS`.
//
// Gated:
//   - `target_os = "linux"`: seccomp is a linux-only kernel feature.
//   - `feature = "seccomp"`: the filter implementation only exists
//     when the feature is on. The default feature set is empty
//     (so host-side `cargo check` / rust-analyzer on macOS+Windows
//     works without the Linux-only deps); these tests run only when
//     `cargo test --features seccomp` is in effect. The CI
//     `rust-test` job opts in; the guest build path
//     (`scripts/build-image.sh`, `scripts/smoke-boot.sh`) also
//     opts in, so the shipping `claude-agent` always carries the
//     filter.
//
// The tests fork rather than mutating the test runner process, so
// they're safe to run in parallel with the rest of the suite.
#[cfg(all(test, target_os = "linux", feature = "seccomp"))]
mod tests {
    use super::install;
    use std::os::unix::process::ExitStatusExt;

    /// Run `body` in a forked child after `install()`-ing the
    /// seccomp filter. Returns the child's exit status as observed
    /// by the parent.
    fn fork_with_filter<F: FnOnce()>(body: F) -> std::process::ExitStatus {
        use libc::{c_int, fork, waitpid, WEXITED};

        match unsafe { fork() } {
            -1 => panic!("fork failed: {}", std::io::Error::last_os_error()),
            0 => {
                // Child: install filter, run body. If we make it back
                // here without being killed, exit cleanly so the
                // parent can distinguish "ran to completion" from
                // "killed by SIGSYS".
                if install().is_err() {
                    // If installation itself fails, exit 2 so the
                    // test can fail with a useful message rather
                    // than getting a confusing SIGSYS report.
                    std::process::exit(2);
                }
                body();
                std::process::exit(0);
            }
            pid => {
                let mut status: c_int = 0;
                let r = unsafe { waitpid(pid, &mut status, 0) };
                assert_ne!(r, -1, "waitpid failed");
                // Decode into ExitStatus via from_raw — the libc
                // status word maps directly.
                let _ = WEXITED; // referenced to silence dead-code
                std::process::ExitStatus::from_raw(status)
            }
        }
    }

    #[test]
    fn install_succeeds_under_default_user() {
        // Installing a seccomp filter doesn't require any
        // capability; the kernel allows any process to add
        // restrictions to itself. If this test fails we have a
        // bigger problem.
        let status = fork_with_filter(|| {});
        assert!(
            status.success(),
            "child should exit cleanly: {status:?}"
        );
    }

    #[test]
    fn ptrace_kills_the_child() {
        // ptrace is on the deny list (the documented top entry —
        // blocks debugger-style memory peeking). The child should
        // be killed by SIGSYS the moment it attempts the syscall.
        let status = fork_with_filter(|| {
            unsafe {
                libc::ptrace(libc::PTRACE_TRACEME, 0, 0, 0);
            }
            // Unreachable on a correctly-installed filter.
        });
        assert_eq!(
            status.signal(),
            Some(libc::SIGSYS),
            "child should have been killed by SIGSYS, got {status:?}"
        );
    }

    #[test]
    fn keyctl_kills_the_child() {
        // Kernel keyring side-channel. Same expectation.
        let status = fork_with_filter(|| {
            unsafe {
                libc::syscall(libc::SYS_keyctl, 0, 0, 0, 0, 0);
            }
        });
        assert_eq!(status.signal(), Some(libc::SIGSYS));
    }

    #[test]
    fn perf_event_open_kills_the_child() {
        let status = fork_with_filter(|| {
            unsafe {
                libc::syscall(libc::SYS_perf_event_open, 0, 0, 0, 0, 0);
            }
        });
        assert_eq!(status.signal(), Some(libc::SIGSYS));
    }

    #[test]
    fn bpf_kills_the_child() {
        // bpf() is on the list because the eBPF subsystem is a
        // recurring privilege-escalation surface. We pass 0 args
        // so the syscall would normally EINVAL without privileges;
        // seccomp turns the policy violation into SIGSYS before
        // the kernel gets there.
        let status = fork_with_filter(|| {
            unsafe {
                libc::syscall(libc::SYS_bpf, 0, 0, 0);
            }
        });
        assert_eq!(status.signal(), Some(libc::SIGSYS));
    }

    #[test]
    fn getpid_still_works_after_install() {
        // Negative test: confirm we haven't accidentally inverted
        // the default action. `getpid` isn't on any deny list and
        // must succeed after the filter is in place.
        let status = fork_with_filter(|| {
            let _pid = unsafe { libc::getpid() };
            // Reaching here without SIGSYS means the filter is
            // default-allow as intended.
        });
        assert!(status.success(), "getpid must remain allowed: {status:?}");
    }

    #[test]
    fn no_new_privs_is_set() {
        // PR_GET_NO_NEW_PRIVS returns 1 after install(). This is
        // load-bearing: without it the filter would be stripped on
        // any future execve, defeating the whole point.
        let status = fork_with_filter(|| {
            let v = unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) };
            if v != 1 {
                std::process::exit(3);
            }
        });
        assert!(
            status.success(),
            "PR_GET_NO_NEW_PRIVS should report 1 after install: {status:?}"
        );
    }
}
