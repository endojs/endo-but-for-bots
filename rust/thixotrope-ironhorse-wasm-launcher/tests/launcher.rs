use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{mpsc, Mutex},
    time::{Duration, Instant},
};
use thixotrope_ironhorse_lease::{lock_file, FlockOperation};

const LAUNCHER: &str = env!("CARGO_BIN_EXE_thixotrope-ironhorse-wasm-worker");
const PARTS: [&str; 3] = [
    "thixotrope-ironhorse-wasm-shell.mjs",
    "host-abi.mjs",
    "thixotrope_ironhorse_wasm.wasm",
];
/// Longer than the helper's own 10 s wait for `active.lock`.
const TIMEOUT: Duration = Duration::from_secs(30);

/// Held while writing an executable and while forking. A child forked while
/// another thread still has a freshly written executable open for writing
/// inherits that descriptor until it execs, and exec of the file then fails
/// with ETXTBSY.
static FORK: Mutex<()> = Mutex::new(());

fn fork_lock() -> std::sync::MutexGuard<'static, ()> {
    FORK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "thixotrope-wasm-launcher-{tag}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        // current_exe() reports a resolved path; compare against the same.
        Self(path.canonicalize().unwrap())
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Kills and reaps the child however the test ends.
struct Guard(Child);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Guard {
    fn wait(&mut self) -> ExitStatus {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            if let Some(status) = self.0.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "child did not exit in time");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    fn stdin(&mut self) -> &mut ChildStdin {
        self.0.stdin.as_mut().unwrap()
    }
}

fn spawn(command: &mut Command) -> Guard {
    let _fork = fork_lock();
    Guard(command.spawn().unwrap())
}

fn write_executable(path: &Path, contents: &[u8]) {
    let _fork = fork_lock();
    fs::write(path, contents).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
}

/// Copies the launcher into `dir` with the named stand-in parts beside it.
fn stage(dir: &Path, parts: &[&str]) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let launcher = dir.join("thixotrope-ironhorse-wasm-worker");
    write_executable(&launcher, &fs::read(LAUNCHER).unwrap());
    for part in parts {
        fs::write(dir.join(part), b"// stand-in\n").unwrap();
    }
    launcher
}

/// Streams lines from a reader so that a silent child fails the test instead
/// of blocking it.
fn lines(reader: impl Read + Send + 'static) -> mpsc::Receiver<String> {
    let (send, receive) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            if send.send(line).is_err() {
                break;
            }
        }
    });
    receive
}

fn next(lines: &mpsc::Receiver<String>) -> String {
    lines
        .recv_timeout(TIMEOUT)
        .expect("expected a line in time")
}

fn rest(lines: &mpsc::Receiver<String>) -> Vec<String> {
    let deadline = Instant::now() + TIMEOUT;
    let mut out = Vec::new();
    loop {
        match lines.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(line) => out.push(line),
            Err(mpsc::RecvTimeoutError::Disconnected) => return out,
            Err(mpsc::RecvTimeoutError::Timeout) => panic!("stream did not close in time"),
        }
    }
}

fn open_rw(path: &Path) -> File {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .unwrap()
}

fn busy(path: &Path, operation: FlockOperation) -> bool {
    match lock_file(path, operation) {
        Ok(_) => false,
        Err(error) => {
            assert!(error.contains("state directory is busy"), "{error}");
            true
        }
    }
}

struct Helper {
    child: Guard,
    stderr: mpsc::Receiver<String>,
}

/// Starts the lock helper the way the host does: fd 1 is the supervisor's
/// own open of `supervisor.lock`.
fn helper(launcher: &Path, state: &Path, supervisor: &File) -> Helper {
    let mut child = spawn(
        Command::new(launcher)
            .arg("--lock-state")
            .arg(state)
            .stdin(Stdio::piped())
            .stdout(supervisor.try_clone().unwrap())
            .stderr(Stdio::piped()),
    );
    let stderr = lines(child.0.stderr.take().unwrap());
    Helper { child, stderr }
}

fn assert_locked_line(line: &str, dir: &Path) {
    let value: Value = serde_json::from_str(line).unwrap();
    let expected: Vec<Value> = PARTS
        .iter()
        .map(|part| Value::String(dir.join(part).to_str().unwrap().to_owned()))
        .collect();
    assert_eq!(
        value,
        serde_json::json!({"op": "locked", "heapFormat": "do-v1", "parts": expected})
    );
}

fn error_message(line: &str) -> String {
    let value: Value = serde_json::from_str(line).unwrap();
    let message = value["message"].as_str().unwrap().to_owned();
    assert_eq!(
        line,
        format!(r#"{{"op":"error","message":{}}}"#, value["message"])
    );
    message
}

#[test]
fn lock_helper_prepares_and_holds() {
    let tmp = TempDir::new("prepare");
    let launcher = stage(&tmp.0.join("bin"), &PARTS);
    let state = tmp.0.join("state");
    let stale = state.join("heaps").join("incarnations").join("stale");
    fs::create_dir_all(stale.parent().unwrap()).unwrap();
    fs::write(&stale, b"old").unwrap();
    let supervisor_path = tmp.0.join("supervisor.lock");
    let supervisor = open_rw(&supervisor_path);
    let active = state.join("heaps").join("active.lock");

    let mut helper = helper(&launcher, &state, &supervisor);
    let line = next(&helper.stderr);
    assert_locked_line(&line, &tmp.0.join("bin"));
    let parts =
        serde_json::to_string(&serde_json::from_str::<Value>(&line).unwrap()["parts"]).unwrap();
    assert_eq!(
        line,
        format!(r#"{{"op":"locked","heapFormat":"do-v1","parts":{parts}}}"#)
    );
    assert!(busy(
        &supervisor_path,
        FlockOperation::NonBlockingLockExclusive
    ));
    assert!(busy(&active, FlockOperation::NonBlockingLockExclusive));

    helper.child.stdin().write_all(b"prepare\n").unwrap();
    assert_eq!(next(&helper.stderr), r#"{"op":"ready"}"#);
    let incarnations = state.join("heaps").join("incarnations");
    assert!(incarnations.is_dir());
    assert_eq!(fs::read_dir(&incarnations).unwrap().count(), 0);
    assert!(!busy(&active, FlockOperation::NonBlockingLockExclusive));
    assert!(busy(
        &supervisor_path,
        FlockOperation::NonBlockingLockExclusive
    ));

    drop(helper.child.0.stdin.take());
    assert!(helper.child.wait().success());
    assert!(rest(&helper.stderr).is_empty());
}

#[test]
fn lock_helper_without_prepare_exits_cleanly() {
    let tmp = TempDir::new("noprepare");
    let launcher = stage(&tmp.0.join("bin"), &PARTS);
    let state = tmp.0.join("state");
    let supervisor = open_rw(&tmp.0.join("supervisor.lock"));
    let mut helper = helper(&launcher, &state, &supervisor);
    assert_locked_line(&next(&helper.stderr), &tmp.0.join("bin"));
    helper.child.stdin().write_all(b"abandon\n").unwrap();
    assert!(helper.child.wait().success());
    assert!(rest(&helper.stderr).is_empty());
    assert!(state.join("heaps").is_dir());
    assert!(!state.join("heaps").join("incarnations").exists());
}

#[test]
fn lock_helper_reports_busy_state() {
    let tmp = TempDir::new("busy");
    let launcher = stage(&tmp.0.join("bin"), &PARTS);
    let supervisor_path = tmp.0.join("supervisor.lock");
    let _held = lock_file(&supervisor_path, FlockOperation::LockExclusive).unwrap();
    let mut helper = helper(&launcher, &tmp.0.join("state"), &open_rw(&supervisor_path));
    let message = error_message(&next(&helper.stderr));
    assert!(message.starts_with("state directory is busy"), "{message}");
    assert_eq!(helper.child.wait().code(), Some(1));
    assert!(rest(&helper.stderr).is_empty());
}

#[test]
fn lock_helper_refuses_missing_part() {
    let tmp = TempDir::new("missing");
    let launcher = stage(&tmp.0.join("bin"), &PARTS[..2]);
    let state = tmp.0.join("state");
    let supervisor_path = tmp.0.join("supervisor.lock");
    let mut helper = helper(&launcher, &state, &open_rw(&supervisor_path));
    let message = error_message(&next(&helper.stderr));
    assert!(message.contains(PARTS[2]), "{message}");
    assert_eq!(helper.child.wait().code(), Some(1));
    assert!(!state.exists());
    assert!(!busy(
        &supervisor_path,
        FlockOperation::NonBlockingLockExclusive
    ));
}

#[test]
fn lock_helper_escapes_awkward_directory() {
    let tmp = TempDir::new("quote");
    let bin = tmp.0.join("odd \"dir\\ name");
    let launcher = stage(&bin, &PARTS);
    let supervisor = open_rw(&tmp.0.join("supervisor.lock"));
    let mut helper = helper(&launcher, &tmp.0.join("state"), &supervisor);
    assert_locked_line(&next(&helper.stderr), &bin);
    drop(helper.child.0.stdin.take());
    assert!(helper.child.wait().success());
}

/// Reports what the launcher handed to Node, then waits so the test can
/// probe the lease while the worker is alive.
const STAND_IN: &str = r#"#!/bin/sh
echo "pid $$"
for arg in "$@"; do
  echo "arg $arg"
  case "$arg" in --lease-fd=*) fd="${arg#--lease-fd=}" ;; esac
done
if [ -e "/proc/$$/fd/$fd" ]; then
  echo "fd $(readlink "/proc/$$/fd/$fd")"
fi
echo "NODE_OPTIONS ${NODE_OPTIONS-unset}"
echo "UNRELATED ${THIXOTROPE_TEST_UNRELATED-unset}"
echo waiting
read -r _line
"#;

fn worker_args(lease: &Path) -> Vec<std::ffi::OsString> {
    vec![
        "heap.sqlite".into(),
        "PROFILE".into(),
        lease.into(),
        r#"{"crankBudget":"7"}"#.into(),
        "boot one.js".into(),
        "two.js".into(),
    ]
}

#[test]
fn worker_execs_node_with_lease() {
    let tmp = TempDir::new("exec");
    let bin = tmp.0.join("bin");
    let launcher = stage(&bin, &PARTS);
    let node = tmp.0.join("fake-node");
    write_executable(&node, STAND_IN.as_bytes());
    let lease = tmp.0.join("active.lock");
    let args = worker_args(&lease);

    let mut child = spawn(
        Command::new(&launcher)
            .args(&args)
            .env("THIXOTROPE_NODE", &node)
            .env("NODE_OPTIONS", "--require=/nonexistent")
            .env("THIXOTROPE_TEST_UNRELATED", "kept")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );
    let stdout = lines(child.0.stdout.take().unwrap());
    let stderr = lines(child.0.stderr.take().unwrap());
    let mut seen = Vec::new();
    while seen.last().map(String::as_str) != Some("waiting") {
        seen.push(next(&stdout));
    }

    assert_eq!(seen[0], format!("pid {}", child.0.id()));
    let shell = bin.join(PARTS[0]);
    let fd_arg = seen
        .iter()
        .find_map(|line| line.strip_prefix("arg --lease-fd="))
        .unwrap()
        .to_owned();
    fd_arg.parse::<u32>().unwrap();
    let mut expected = vec![
        "arg --disable-warning=ExperimentalWarning".to_owned(),
        format!("arg {}", shell.display()),
        format!("arg --lease-fd={fd_arg}"),
    ];
    expected.extend(
        args.iter()
            .map(|arg| format!("arg {}", arg.to_str().unwrap())),
    );
    #[cfg(target_os = "linux")]
    expected.push(format!("fd {}", lease.display()));
    // NODE_OPTIONS is dropped; the rest of the environment passes through.
    expected.push("NODE_OPTIONS unset".to_owned());
    expected.push("UNRELATED kept".to_owned());
    expected.push("waiting".to_owned());
    // Everything on stdout came from the stand-in: the launcher wrote nothing.
    assert_eq!(seen[1..], expected[..]);

    assert!(busy(&lease, FlockOperation::NonBlockingLockExclusive));
    assert!(!busy(&lease, FlockOperation::NonBlockingLockShared));
    child.stdin().write_all(b"\n").unwrap();
    assert!(child.wait().success());
    assert!(rest(&stdout).is_empty());
    assert!(rest(&stderr).is_empty());
    assert!(!busy(&lease, FlockOperation::NonBlockingLockExclusive));
}

/// Runs the launcher to completion with no stdin.
fn run(command: &mut Command) -> (ExitStatus, Vec<u8>, String) {
    let mut child = spawn(
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped()),
    );
    let stdout = child.0.stdout.take().unwrap();
    let stderr = lines(child.0.stderr.take().unwrap());
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        BufReader::new(stdout).read_to_end(&mut bytes).unwrap();
        bytes
    });
    let status = child.wait();
    let stderr = rest(&stderr).join("\n");
    (status, reader.join().unwrap(), stderr)
}

fn assert_fails(command: &mut Command, needle: &str) {
    let (status, stdout, stderr) = run(command);
    assert_eq!(status.code(), Some(1), "{stderr}");
    assert!(stdout.is_empty(), "stdout: {stdout:?}");
    assert!(stderr.starts_with("worker failed: "), "{stderr}");
    assert!(stderr.contains(needle), "{stderr}");
    assert_eq!(stderr.lines().count(), 1, "{stderr}");
}

#[test]
fn worker_usage_errors() {
    let tmp = TempDir::new("usage");
    let launcher = stage(&tmp.0.join("bin"), &PARTS);
    let lease = tmp.0.join("active.lock");
    let args = worker_args(&lease);
    let cases = [
        "usage: thixotrope-ironhorse-wasm-worker heap.sqlite profile lease limits-json [boot.js ...]",
        "runtime profile required",
        "worker lease path required",
        "worker limits required",
    ];
    for (count, needle) in cases.iter().enumerate() {
        assert_fails(
            Command::new(&launcher)
                .args(&args[..count])
                .env("THIXOTROPE_NODE", "/bin/true"),
            needle,
        );
    }
    assert!(!lease.exists());
}

#[test]
fn worker_reports_missing_node() {
    let tmp = TempDir::new("nonode");
    let launcher = stage(&tmp.0.join("bin"), &PARTS);
    let lease = tmp.0.join("active.lock");
    let absent = tmp.0.join("no-such-node");
    assert_fails(
        Command::new(&launcher)
            .args(worker_args(&lease))
            .env("THIXOTROPE_NODE", &absent),
        &format!("exec {}", absent.display()),
    );
    assert!(!busy(&lease, FlockOperation::NonBlockingLockExclusive));
}

#[test]
fn worker_reports_missing_shell() {
    let tmp = TempDir::new("noshell");
    let launcher = stage(&tmp.0.join("bin"), &PARTS[1..]);
    let lease = tmp.0.join("active.lock");
    assert_fails(
        Command::new(&launcher)
            .args(worker_args(&lease))
            .env("THIXOTROPE_NODE", "/bin/true"),
        PARTS[0],
    );
}

#[test]
fn worker_reports_unopenable_lease() {
    let tmp = TempDir::new("nolease");
    let launcher = stage(&tmp.0.join("bin"), &PARTS);
    assert_fails(
        Command::new(&launcher)
            .args(worker_args(&tmp.0.join("absent").join("active.lock")))
            .env("THIXOTROPE_NODE", "/bin/true"),
        "lock file: ",
    );
}

#[test]
fn worker_falls_back_to_node_on_path() {
    let tmp = TempDir::new("path");
    let launcher = stage(&tmp.0.join("bin"), &PARTS);
    let path = tmp.0.join("path");
    fs::create_dir(&path).unwrap();
    // Only shell builtins: PATH holds nothing else.
    write_executable(&path.join("node"), b"#!/bin/sh\necho \"node $1\"\n");
    let lease = tmp.0.join("active.lock");
    for node in [None, Some("")] {
        let mut command = Command::new(&launcher);
        command.args(worker_args(&lease)).env("PATH", &path);
        match node {
            Some(value) => command.env("THIXOTROPE_NODE", value),
            None => command.env_remove("THIXOTROPE_NODE"),
        };
        let (status, stdout, stderr) = run(&mut command);
        assert!(status.success(), "{stderr}");
        assert_eq!(stdout, b"node --disable-warning=ExperimentalWarning\n");
    }
}
