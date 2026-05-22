// claude-orch-bootstrap-init
//
// PID 1 in the microVM guest. One-shot privileged setup:
//   1. Mount /proc, /sys, /dev, /dev/pts, /run, /tmp.
//   2. Parse /proc/cmdline for claude.session_id and claude.boot_nonce.
//   3. Open /dev/virtio-ports/orchestrator; send Hello; receive BootConfig.
//   4. Open /dev/virtio-ports/workspace; mount 9P at /workspace (trans=fd).
//   5. Write credentials to /home/claude/.claude/.credentials.json (0600).
//   6. Drop capabilities; setuid/setgid to the claude user.
//   7. exec /usr/local/bin/claude-agent.
//
// See packages/claude-container/DESIGN.md §5.3.

use std::fs;
use std::io::{Read, Write};
use std::os::fd::{IntoRawFd, RawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::process::Command;

use nix::mount::{mount, MsFlags};
use nix::unistd::{chown, setgid, setgroups, setuid, Gid, Uid};
use serde::{Deserialize, Serialize};

const CLAUDE_UID: u32 = 1000;
const CLAUDE_GID: u32 = 1000;
const CLAUDE_HOME: &str = "/home/claude";
const CREDS_DIR: &str = "/home/claude/.claude";
const CREDS_PATH: &str = "/home/claude/.claude/.credentials.json";
const CTL_PORT_NAME: &str = "orchestrator";
const WORKSPACE_PORT_NAME: &str = "workspace";
const WORKSPACE_MOUNT: &str = "/workspace";
const AGENT_BIN: &str = "/usr/local/bin/claude-agent";

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BootstrapOut {
    Hello {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "bootNonce")]
        boot_nonce: String,
        #[serde(rename = "agentVersion")]
        agent_version: String,
        hostname: String,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum BootstrapIn {
    BootConfig {
        credentials: serde_json::Value,
        #[serde(rename = "envExtra", default)]
        env_extra: std::collections::HashMap<String, String>,
        #[serde(rename = "initialPrompt")]
        initial_prompt: Option<String>,
        #[serde(rename = "agentControlPort")]
        agent_control_port: String,
    },
}

fn main() {
    if let Err(e) = run() {
        eprintln!("[bootstrap-init] FATAL: {e}");
        // Let the kernel observe stderr drain before exit; QEMU will print
        // it to the host log.
        std::thread::sleep(std::time::Duration::from_secs(2));
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    mount_filesystems()?;
    eprintln!("[bootstrap-init] mounts ok");

    let (session_id, boot_nonce) = parse_cmdline()?;
    eprintln!("[bootstrap-init] cmdline parsed, session_id={session_id}");
    let hostname = fs::read_to_string("/proc/sys/kernel/hostname")
        .unwrap_or_else(|_| "claude-vm".into())
        .trim()
        .to_string();

    let ctl_path = resolve_virtio_port(CTL_PORT_NAME)?;
    let mut ctl = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&ctl_path)
        .map_err(|e| format!("open {ctl_path}: {e}"))?;

    let hello = BootstrapOut::Hello {
        session_id: session_id.clone(),
        boot_nonce,
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        hostname,
    };
    let mut line = serde_json::to_vec(&hello).map_err(|e| e.to_string())?;
    line.push(b'\n');
    ctl.write_all(&line).map_err(|e| e.to_string())?;
    ctl.flush().map_err(|e| e.to_string())?;

    let mut buf = Vec::with_capacity(4096);
    read_line(&mut ctl, &mut buf)?;
    let BootstrapIn::BootConfig {
        credentials,
        env_extra,
        initial_prompt,
        agent_control_port,
    } = serde_json::from_slice::<BootstrapIn>(&buf).map_err(|e| e.to_string())?;

    drop(ctl); // bootstrap port done
    eprintln!("[bootstrap-init] boot_config received");

    mount_workspace()?;
    eprintln!("[bootstrap-init] 9p mounted");
    write_credentials(&credentials)?;
    write_initial_prompt(initial_prompt.as_deref())?;
    chown_home()?;

    // The orchestrator's BootConfig sends `agentControlPort` as either
    // a /dev/virtio-ports/<name> symlink (assumes udev) OR the raw
    // virtio-serial port name. We don't run udev, so translate the
    // symlink form into the canonical /dev/vportXpY path before
    // exec()ing claude-agent.
    let resolved_agent_port = match agent_control_port.strip_prefix("/dev/virtio-ports/") {
        Some(name) => resolve_virtio_port(name)?,
        None if agent_control_port.starts_with("/dev/") => agent_control_port.clone(),
        None => resolve_virtio_port(&agent_control_port)?,
    };
    eprintln!("[bootstrap-init] resolved agent port = {resolved_agent_port}");

    // virtio-port devices are created by the kernel as root:root mode 0600.
    // claude-agent runs as the unprivileged claude user, so chown the port
    // before we drop privileges or the agent can't open its own RPC channel.
    chown(
        resolved_agent_port.as_str(),
        Some(Uid::from_raw(CLAUDE_UID)),
        Some(Gid::from_raw(CLAUDE_GID)),
    )
    .map_err(|e| format!("chown {resolved_agent_port}: {e}"))?;

    drop_privileges()?;

    eprintln!("[bootstrap-init] exec {AGENT_BIN} --control-port={resolved_agent_port} --session-id={session_id}");
    let mut cmd = Command::new(AGENT_BIN);
    cmd.arg(format!("--control-port={resolved_agent_port}"));
    cmd.arg(format!("--session-id={session_id}"));
    for (k, v) in env_extra {
        cmd.env(k, v);
    }

    let err = cmd.exec();
    Err(format!("exec {AGENT_BIN}: {err}"))
}

fn mount_filesystems() -> Result<(), String> {
    for d in ["/proc", "/sys", "/dev", "/dev/pts", "/run", "/tmp"] {
        fs::create_dir_all(d).ok();
    }
    // The kernel may have auto-mounted some of these already (e.g.,
    // CONFIG_DEVTMPFS_MOUNT auto-mounts /dev at boot). Tolerate EBUSY
    // and treat it as "already mounted, fine, move on."
    mount_if_unmounted("proc", "/proc", "proc")?;
    mount_if_unmounted("sysfs", "/sys", "sysfs")?;
    mount_if_unmounted("devtmpfs", "/dev", "devtmpfs")?;
    mount_if_unmounted("devpts", "/dev/pts", "devpts")?;
    mount_if_unmounted("tmpfs", "/run", "tmpfs")?;
    mount_if_unmounted("tmpfs", "/tmp", "tmpfs")?;
    Ok(())
}

fn mount_if_unmounted(source: &str, target: &str, fstype: &str) -> Result<(), String> {
    match mount::<str, str, str, str>(Some(source), target, Some(fstype), MsFlags::empty(), None) {
        Ok(()) => Ok(()),
        Err(nix::errno::Errno::EBUSY) => Ok(()), // kernel auto-mounted it
        Err(e) => Err(format!("mount {target}: {e}")),
    }
}

fn mount_workspace() -> Result<(), String> {
    fs::create_dir_all(WORKSPACE_MOUNT).ok();
    let workspace_path = resolve_virtio_port(WORKSPACE_PORT_NAME)?;

    // The Linux virtio-console driver only exports user-space file_ops;
    // v9fs's trans=fd path issues kernel-mode vfs_read/vfs_write which the
    // driver rejects with "kernel write not supported for file /vport0pN".
    // Workaround: socketpair() gives us two SOCK_STREAM fds that DO support
    // kernel-mode read/write. A forked relay child bridges bytes between
    // the virtio-port fd and one end of the socket pair; v9fs mounts
    // against the other end via trans=fd. See ENDO-INTEGRATION.md §9 R2a.
    let port_fd = open_virtio_port(&workspace_path)?;
    let mount_fd = spawn_relay(port_fd)?;

    let opts = format!(
        "trans=fd,rfdno={mount_fd},wfdno={mount_fd},version=9p2000.L,msize=131072,access=any"
    );
    mount::<str, str, str, str>(
        Some("none"),
        WORKSPACE_MOUNT,
        Some("9p"),
        MsFlags::empty(),
        Some(&opts),
    )
    .map_err(|e| format!("mount 9p {WORKSPACE_MOUNT}: {e}"))?;
    // The mount_fd is now owned by the kernel mount; do not close in this
    // process. The relay child owns its peer fd.
    Ok(())
}

fn open_virtio_port(path: &str) -> Result<RawFd, String> {
    use nix::fcntl::{open, OFlag};
    use nix::sys::stat::Mode;
    open(path, OFlag::O_RDWR | OFlag::O_CLOEXEC, Mode::empty())
        .map_err(|e| format!("open {path}: {e}"))
}

/// Fork a relay child that bidirectionally bridges `port_fd` <-> one end
/// of a freshly-allocated SOCK_STREAM Unix socketpair. Returns the other
/// (kernel-bound) end's raw fd to the caller.
fn spawn_relay(port_fd: RawFd) -> Result<RawFd, String> {
    use nix::sys::socket::{socketpair, AddressFamily, SockFlag, SockType};
    use nix::unistd::{close, fork, ForkResult};

    let (kernel_end, relay_end) = socketpair(
        AddressFamily::Unix,
        SockType::Stream,
        None,
        SockFlag::empty(),
    )
    .map_err(|e| format!("socketpair: {e}"))?;
    let kernel_fd = kernel_end.into_raw_fd();
    let relay_fd = relay_end.into_raw_fd();

    // SAFETY: bootstrap-init is single-threaded at this point.
    match unsafe { fork() } {
        Ok(ForkResult::Parent { .. }) => {
            // Parent: kernel side. Close the relay-side fd; we don't use it.
            let _ = close(relay_fd);
            Ok(kernel_fd)
        }
        Ok(ForkResult::Child) => {
            // Child: bridge bytes between port_fd and relay_fd forever.
            let _ = close(kernel_fd);
            run_relay(port_fd, relay_fd);
        }
        Err(e) => Err(format!("fork relay: {e}")),
    }
}

fn run_relay(port_fd: RawFd, sock_fd: RawFd) -> ! {
    use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
    use nix::unistd::{read, write};
    use std::os::fd::BorrowedFd;

    let mut buf = [0u8; 8192];
    // SAFETY: caller-supplied raw fds remain open for the lifetime of
    // these BorrowedFds. The relay loops forever — we never return.
    let port = unsafe { BorrowedFd::borrow_raw(port_fd) };
    let sock = unsafe { BorrowedFd::borrow_raw(sock_fd) };
    loop {
        let mut pfds = [
            PollFd::new(port, PollFlags::POLLIN),
            PollFd::new(sock, PollFlags::POLLIN),
        ];
        match poll(&mut pfds, PollTimeout::NONE) {
            Ok(_) => {}
            Err(nix::errno::Errno::EINTR) => continue,
            Err(_) => std::process::exit(1),
        }
        if let Some(revents) = pfds[0].revents() {
            if revents.intersects(PollFlags::POLLIN) {
                match read(port_fd, &mut buf) {
                    Ok(0) => std::process::exit(0),
                    Ok(n) => {
                        let _ = write(sock, &buf[..n]);
                    }
                    Err(nix::errno::Errno::EINTR) => continue,
                    Err(_) => std::process::exit(1),
                }
            }
            if revents.intersects(PollFlags::POLLHUP | PollFlags::POLLERR) {
                std::process::exit(0);
            }
        }
        if let Some(revents) = pfds[1].revents() {
            if revents.intersects(PollFlags::POLLIN) {
                match read(sock_fd, &mut buf) {
                    Ok(0) => std::process::exit(0),
                    Ok(n) => {
                        let _ = write(port, &buf[..n]);
                    }
                    Err(nix::errno::Errno::EINTR) => continue,
                    Err(_) => std::process::exit(1),
                }
            }
            if revents.intersects(PollFlags::POLLHUP | PollFlags::POLLERR) {
                std::process::exit(0);
            }
        }
    }
}

/// Pure-string version of `parse_cmdline`, factored out so tests
/// don't depend on `/proc/cmdline` existing on the runner.
///
/// Last-write-wins for duplicate keys (Linux kernel cmdline parsing
/// has no canonical resolution rule, but giving the rightmost token
/// precedence matches how `init=...` etc. are typically expected to
/// behave when boot loaders append extras).
fn parse_cmdline_str(cmdline: &str) -> Result<(String, String), String> {
    let mut session_id = None;
    let mut boot_nonce = None;
    for part in cmdline.split_whitespace() {
        if let Some(v) = part.strip_prefix("claude.session_id=") {
            session_id = Some(v.to_string());
        } else if let Some(v) = part.strip_prefix("claude.boot_nonce=") {
            boot_nonce = Some(v.to_string());
        }
    }
    Ok((
        session_id.ok_or("missing claude.session_id on cmdline")?,
        boot_nonce.ok_or("missing claude.boot_nonce on cmdline")?,
    ))
}

fn parse_cmdline() -> Result<(String, String), String> {
    let cmdline = fs::read_to_string("/proc/cmdline").map_err(|e| format!("/proc/cmdline: {e}"))?;
    parse_cmdline_str(&cmdline)
}

/// Write `creds` to `path` as JSON with 0600 perms (parent dir
/// created at 0700 if missing). Factored out of `write_credentials`
/// so tests can target a tmpdir; the production code path passes
/// `CREDS_PATH`.
fn write_credentials_to(
    path: &std::path::Path,
    creds: &serde_json::Value,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .map_err(|e| format!("open {}: {e}", path.display()))?;
    let data = serde_json::to_vec(creds).map_err(|e| e.to_string())?;
    f.write_all(&data).map_err(|e| e.to_string())?;
    Ok(())
}

fn write_credentials(creds: &serde_json::Value) -> Result<(), String> {
    fs::create_dir_all(CREDS_DIR).ok();
    write_credentials_to(std::path::Path::new(CREDS_PATH), creds)
}

fn write_initial_prompt(prompt: Option<&str>) -> Result<(), String> {
    let Some(p) = prompt else { return Ok(()) };
    if p.is_empty() {
        return Ok(());
    }
    let path = format!("{CLAUDE_HOME}/.claude/initial-prompt.txt");
    fs::create_dir_all(CREDS_DIR).ok();
    // 0600 + owned by claude:claude — same threat model as the credentials
    // file: an attacker who can read this can see whatever the orchestrator
    // passed in initialPrompt.
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&path)
        .map_err(|e| format!("open {path}: {e}"))?;
    f.write_all(p.as_bytes())
        .map_err(|e| format!("write {path}: {e}"))?;
    chown(
        path.as_str(),
        Some(Uid::from_raw(CLAUDE_UID)),
        Some(Gid::from_raw(CLAUDE_GID)),
    )
    .map_err(|e| format!("chown {path}: {e}"))?;
    Ok(())
}

fn chown_home() -> Result<(), String> {
    let uid = Uid::from_raw(CLAUDE_UID);
    let gid = Gid::from_raw(CLAUDE_GID);
    chown(CLAUDE_HOME, Some(uid), Some(gid))
        .map_err(|e| format!("chown {CLAUDE_HOME}: {e}"))?;
    chown(CREDS_DIR, Some(uid), Some(gid))
        .map_err(|e| format!("chown {CREDS_DIR}: {e}"))?;
    chown(CREDS_PATH, Some(uid), Some(gid))
        .map_err(|e| format!("chown {CREDS_PATH}: {e}"))?;
    Ok(())
}

fn drop_privileges() -> Result<(), String> {
    setgroups(&[Gid::from_raw(CLAUDE_GID)]).map_err(|e| format!("setgroups: {e}"))?;
    setgid(Gid::from_raw(CLAUDE_GID)).map_err(|e| format!("setgid: {e}"))?;
    setuid(Uid::from_raw(CLAUDE_UID)).map_err(|e| format!("setuid: {e}"))?;
    Ok(())
}

/// Resolve a named virtio-serial port to its /dev path by scanning
/// /sys/class/virtio-ports/*/name. The /dev/virtio-ports/<name> symlinks
/// the design doc assumes only exist after a udev runs; an explicit
/// resolver lets bootstrap-init work without any userspace daemon.
fn resolve_virtio_port(name: &str) -> Result<String, String> {
    let entries = fs::read_dir("/sys/class/virtio-ports")
        .map_err(|e| format!("read /sys/class/virtio-ports: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let dev_name = entry.file_name();
        let name_path = entry.path().join("name");
        let port_name = fs::read_to_string(&name_path)
            .map_err(|e| format!("read {}: {e}", name_path.display()))?;
        if port_name.trim() == name {
            return Ok(format!("/dev/{}", dev_name.to_string_lossy()));
        }
    }
    Err(format!(
        "virtio-serial port named {name:?} not found under /sys/class/virtio-ports"
    ))
}

fn read_line<R: Read>(r: &mut R, out: &mut Vec<u8>) -> Result<(), String> {
    out.clear();
    let mut byte = [0u8; 1];
    loop {
        let n = r.read(&mut byte).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("EOF before newline".into());
        }
        if byte[0] == b'\n' {
            return Ok(());
        }
        out.push(byte[0]);
        if out.len() > 1 << 20 {
            return Err("line too long".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_cmdline_str, write_credentials_to};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn parse_cmdline_accepts_documented_shape() {
        let line =
            "console=ttyS0 root=/dev/vda rw rootfstype=ext4 \
             claude.session_id=abc-123 claude.boot_nonce=AAAAAAAA";
        let (sid, nonce) = parse_cmdline_str(line).expect("parse ok");
        assert_eq!(sid, "abc-123");
        assert_eq!(nonce, "AAAAAAAA");
    }

    #[test]
    fn parse_cmdline_rejects_missing_session_id() {
        let line = "console=ttyS0 claude.boot_nonce=N";
        let err = parse_cmdline_str(line).unwrap_err();
        assert!(
            err.contains("session_id"),
            "expected session_id-missing message, got {err}"
        );
    }

    #[test]
    fn parse_cmdline_rejects_missing_boot_nonce() {
        let line = "console=ttyS0 claude.session_id=sess";
        let err = parse_cmdline_str(line).unwrap_err();
        assert!(
            err.contains("boot_nonce"),
            "expected boot_nonce-missing message, got {err}"
        );
    }

    #[test]
    fn parse_cmdline_rejects_empty() {
        let err = parse_cmdline_str("").unwrap_err();
        assert!(err.contains("session_id"));
    }

    #[test]
    fn parse_cmdline_last_write_wins_on_duplicate_keys() {
        // If a boot loader appends duplicates, the rightmost token
        // should determine the final value — matches how init=... and
        // other kernel cmdline parsers behave.
        let line =
            "claude.session_id=first claude.boot_nonce=NA \
             claude.session_id=second claude.boot_nonce=NB";
        let (sid, nonce) = parse_cmdline_str(line).expect("parse ok");
        assert_eq!(sid, "second");
        assert_eq!(nonce, "NB");
    }

    #[test]
    fn parse_cmdline_ignores_unrelated_tokens() {
        let line =
            "claude.session_id=ok claude.boot_nonce=ok2 \
             ignored.other=foo CLAUDE.SESSION_ID=wrong-case";
        let (sid, _) = parse_cmdline_str(line).expect("parse ok");
        // Case-sensitive match; the uppercased duplicate must not win.
        assert_eq!(sid, "ok");
    }

    #[test]
    fn write_credentials_to_writes_0600_and_correct_json() {
        let dir = tempdir();
        let path = dir.join(".credentials.json");
        let creds = serde_json::json!({
            "apiKey": "sk-ant-test",
            "rotatedAt": "2026-05-22T00:00:00Z"
        });
        write_credentials_to(&path, &creds).expect("write ok");

        let meta = fs::metadata(&path).expect("stat ok");
        // eslint-disable-next-line — Rust, not JS. Mask to file mode bits.
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "file mode must be 0600 at create time");

        let bytes = fs::read(&path).expect("read ok");
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["apiKey"], "sk-ant-test");
        assert_eq!(parsed["rotatedAt"], "2026-05-22T00:00:00Z");

        // Cleanup.
        fs::remove_file(&path).ok();
        fs::remove_dir(&dir).ok();
    }

    #[test]
    fn write_credentials_to_overwrites_existing_with_truncate() {
        let dir = tempdir();
        let path = dir.join(".credentials.json");
        // Seed with a longer payload than what we'll overwrite, so a
        // missing-truncate bug would leave trailing bytes.
        fs::write(&path, b"{\"old\":\"this-is-much-longer-than-the-next-payload\"}").unwrap();

        let next = serde_json::json!({ "apiKey": "k" });
        write_credentials_to(&path, &next).expect("write ok");

        let bytes = fs::read(&path).expect("read ok");
        let parsed: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(parsed["apiKey"], "k");
        assert!(parsed.get("old").is_none());

        fs::remove_file(&path).ok();
        fs::remove_dir(&dir).ok();
    }

    // Minimal tempdir helper — `tempfile` isn't a build dep and adding
    // one for two tests isn't worth the surface. PID + monotonic nonce
    // is unique enough for parallel `cargo test` runs.
    fn tempdir() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static NONCE: AtomicU64 = AtomicU64::new(0);
        let n = NONCE.fetch_add(1, Ordering::SeqCst);
        let pid = std::process::id();
        let p = std::env::temp_dir().join(format!("bootstrap-init-test-{pid}-{n}"));
        fs::create_dir_all(&p).expect("mkdir tempdir");
        p
    }
}
