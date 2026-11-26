//! Native front for the WebAssembly Ironhorse worker. It accepts exactly the
//! native worker's two invocations so the host picks an engine by binary path
//! alone: as `--lock-state` it is the lock helper itself (Node resets the
//! inherited `SIG_IGN` dispositions the host relies on), and as a worker it
//! takes the shared lease and replaces itself with Node, so the pid the host
//! spawned and later kills is the pid running the worker.
//!
//! Trust boundary: the Node binary (`THIXOTROPE_NODE`, else `node` on `PATH`)
//! is not part of the pinned runtime identity, so whoever controls the
//! daemon's environment controls which Node runs the worker. `NODE_OPTIONS` is
//! dropped so that the environment cannot add code to that Node by accident.
//! For the same reason Node runs with `--disable-sigusr1` (Node 22.14.0 and
//! later): without it, anyone who may signal the worker's pid can send
//! SIGUSR1 and make Node start its inspector on 127.0.0.1:9229, a debugger
//! into the worker's heap. With it, Node keeps SIGUSR1 blocked in every
//! thread, so the signal stays pending and does nothing: no inspector
//! starts and the worker keeps serving. (It ends the native worker.)
#![forbid(unsafe_code)]
#[cfg(not(unix))]
compile_error!("thixotrope-ironhorse-wasm-launcher relies on flock(2) and exec(2); Unix only");

use std::{
    ffi::OsString,
    os::unix::{io::AsRawFd, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
};
use thixotrope_ironhorse_lease::{lock_file, supervise_lock, FlockOperation};

// Expected beside this executable. The staging script that installs them and
// the JS host that reads them back from the `locked` line both rely on these
// exact names, so renaming one means changing all three places.
const SHELL: &str = "thixotrope-ironhorse-wasm-shell.mjs";
const HOST_ABI: &str = "host-abi.mjs";
const MODULE: &str = "thixotrope_ironhorse_wasm.wasm";
const PARTS: [&str; 3] = [SHELL, HOST_ABI, MODULE];

/// Absolute paths of the parts in `PARTS` order, each verified to be a
/// regular file.
fn parts() -> Result<Vec<PathBuf>, String> {
    let exe = std::env::current_exe().map_err(|e| format!("locate executable: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| format!("executable {} has no directory", exe.display()))?;
    PARTS
        .iter()
        .map(|name| {
            let path = dir.join(name);
            match std::fs::metadata(&path) {
                Ok(meta) if meta.is_file() => Ok(path),
                Ok(_) => Err(format!("{} is not a regular file", path.display())),
                Err(e) => Err(format!("missing {}: {e}", path.display())),
            }
        })
        .collect()
}

fn lock_state(state: Option<OsString>) -> Result<(), String> {
    let state = state.ok_or("state directory required")?;
    let state = state
        .to_str()
        .ok_or("state directory path must be UTF-8")?
        .to_owned();
    let parts = parts()?
        .into_iter()
        .map(|path| {
            path.into_os_string()
                .into_string()
                .map_err(|path| format!("part path {path:?} must be UTF-8"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    // Spelled out so the keys keep this order; serde_json sorts maps.
    let parts = serde_json::to_string(&parts).map_err(|e| e.to_string())?;
    let line = format!(r#"{{"op":"locked","heapFormat":"do-v1","parts":{parts}}}"#);
    supervise_lock(&state, &line)
}

/// Returns only on failure; on success the process image is Node's.
fn exec_worker(mut args: impl Iterator<Item = OsString>) -> Result<(), String> {
    let heap = args.next().ok_or(
        "usage: thixotrope-ironhorse-wasm-worker heap.sqlite profile lease limits-json [boot.js ...]",
    )?;
    let profile = args.next().ok_or("runtime profile required")?;
    let lease_path = args.next().ok_or("worker lease path required")?;
    let limits = args.next().ok_or("worker limits required")?;
    let shell = parts()?.swap_remove(0);
    let lease = lock_file(Path::new(&lease_path), FlockOperation::LockShared)?;
    // std opens files close-on-exec; the lease must outlive this image so the
    // supervisor cannot take it exclusively while the Node worker writes.
    let flags = rustix::io::fcntl_getfd(&lease).map_err(|e| format!("lease flags: {e}"))?;
    rustix::io::fcntl_setfd(&lease, flags - rustix::io::FdFlags::CLOEXEC)
        .map_err(|e| format!("lease flags: {e}"))?;
    let node = std::env::var_os("THIXOTROPE_NODE")
        .filter(|node| !node.is_empty())
        .unwrap_or_else(|| "node".into());
    let error = Command::new(&node)
        // `--require`, `--import`, `--loader` or `--inspect` in NODE_OPTIONS
        // would load or expose code the pinned runtime identity never saw.
        .env_remove("NODE_OPTIONS")
        // SIGUSR1 would otherwise start the inspector; see the crate docs.
        .arg("--disable-sigusr1")
        .arg("--disable-warning=ExperimentalWarning")
        .arg(shell)
        .arg(format!("--lease-fd={}", lease.as_raw_fd()))
        .args([heap, profile, lease_path, limits])
        .args(args)
        .exec();
    Err(format!("exec {}: {error}", Path::new(&node).display()))
}

fn main() {
    let mut args = std::env::args_os().skip(1);
    let first = args.next();
    if first.as_deref() == Some("--lock-state".as_ref()) {
        if let Err(message) = lock_state(args.next()) {
            let message = serde_json::Value::String(message);
            eprintln!(r#"{{"op":"error","message":{message}}}"#);
            std::process::exit(1);
        }
    } else if let Err(message) = exec_worker(first.into_iter().chain(args)) {
        eprintln!("worker failed: {message}");
        std::process::exit(1);
    }
}
