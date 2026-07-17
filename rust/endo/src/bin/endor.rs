//! Unified Endo binary.
//!
//! A single executable that can act as the top-level endo daemon
//! (the capability bus that routes envelopes among its children),
//! a worker, or a standalone archive runner. The subcommand picks
//! the role; the `-e` / `--engine` flag picks which engine runs
//! inside this process. XS is the default engine for every
//! child-facing subcommand.
//!
//!   endor daemon                # daemon / capability bus (foreground)
//!   endor start                 # detached daemon
//!   endor stop                  # graceful shutdown
//!   endor ping                  # liveness check
//!
//!   endor worker  [-e xs]       # supervised worker child
//!   endor run     [-e xs] <archive.zip>
//!                               # standalone archive runner
//!   endor run     [--offline] <entry.js>
//!                               # fetch npm deps into the CAS, run over XS
//!
//! The manager is hosted in-process by `endor daemon` on a
//! dedicated `std::thread`; there is no separate `manager`
//! subcommand. Set `ENDO_MANAGER_NODE=1` to fall back to the
//! legacy Node.js daemon child for one release.
//!
//! The optional `-e <engine>` flag makes the engine explicit. Future
//! engines (`-e wasm`, `-e native`) slot in without changing the
//! subcommand vocabulary.

use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::ExitCode;

use endo::error::EndoError;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let subcommand = match args.get(1) {
        Some(s) => s.as_str(),
        None => {
            print_help();
            return ExitCode::from(2);
        }
    };
    let rest = &args[2..];

    // All child-facing subcommands default to the XS engine;
    // `-e <engine>` makes it explicit.
    let engine = parse_engine(rest).unwrap_or("xs");

    match subcommand {
        "daemon" => match engine {
            "xs" => result_to_exit("endor", cmd_daemon()),
            other => unknown_engine(other),
        },
        "manager" => {
            // The `manager` subcommand has been removed. The daemon
            // now hosts the manager in-process on a dedicated
            // thread. Keep a one-line deprecation message for the
            // benefit of stale scripts; delete this arm in the next
            // release.
            eprintln!(
                "endor: the `manager` subcommand has been removed; \
                 `endor daemon` now hosts the manager in-process"
            );
            ExitCode::SUCCESS
        }
        "worker" => match engine {
            "xs" => xsnap_result_to_exit(unsafe { xsnap::run_xs_worker() }),
            other => unknown_engine(other),
        },
        "run" => {
            let cas_hash = parse_flag_value(rest, "--cas");
            let no_cas = rest.iter().any(|a| a == "--no-cas");
            let offline = rest.iter().any(|a| a == "--offline");
            let path = parse_positional_path(rest);
            match engine {
                "xs" => {
                    if let Some(hash) = cas_hash {
                        // Run from CAS root hash.
                        result_to_exit("endor", cmd_run_from_cas(&hash))
                    } else if let Some(ref p) = path {
                        if is_entry_module(p) {
                            result_to_exit("endor", cmd_run_entry(p, offline))
                        } else if no_cas {
                            xsnap_result_to_exit(xsnap::run_xs_archive(p))
                        } else {
                            result_to_exit("endor", cmd_run_with_cas(p))
                        }
                    } else {
                        eprintln!(
                            "usage: endor run [-e xs] [--cas <hash>] [--no-cas] [--offline] <archive.zip | entry.js>"
                        );
                        ExitCode::from(2)
                    }
                }
                other => unknown_engine(other),
            }
        }
        "start" => result_to_exit("endor", cmd_start()),
        "stop" => result_to_exit("endor", cmd_stop()),
        "ping" => result_to_exit("endor", cmd_ping()),
        "gc" => result_to_exit("endor", cmd_gc()),
        "-h" | "--help" => {
            print_help();
            ExitCode::SUCCESS
        }
        "help" => {
            match rest.first().map(|s| s.as_str()) {
                Some(sub) => print_subcommand_help(sub),
                None => print_help(),
            }
            ExitCode::SUCCESS
        }
        _ => {
            print_help();
            ExitCode::from(2)
        }
    }
}

fn print_help() {
    eprintln!("Usage: endor <command> [options]");
    eprintln!();
    eprintln!("Daemon commands (the daemon is the capability bus):");
    eprintln!("  daemon              Run the daemon in foreground");
    eprintln!("  start               Spawn the daemon in a detached session");
    eprintln!("  stop                Gracefully stop a running daemon");
    eprintln!("  ping                Verify daemon responsiveness");
    eprintln!();
    eprintln!("Child-facing commands (XS engine by default):");
    eprintln!("  worker  [-e xs]                Run a supervised worker child");
    eprintln!("  run     [-e xs] <archive.zip>  Run a compartment-map archive");
    eprintln!("  run     [--offline] <entry.js> Run an entry module, npm deps");
    eprintln!("                                 fetched via the CAS, over XS");
    eprintln!();
    eprintln!("Maintenance:");
    eprintln!("  gc                             Garbage-collect the CAS");
}

fn print_subcommand_help(sub: &str) {
    match sub {
        "daemon" => {
            eprintln!("Usage: endor daemon");
            eprintln!();
            eprintln!("Run the Endo daemon in the foreground.");
            eprintln!();
            eprintln!("The daemon is the capability bus that routes envelopes among");
            eprintln!("workers. It hosts the JS manager in-process on a dedicated");
            eprintln!("thread (set ENDO_MANAGER_NODE=1 to use the legacy Node.js");
            eprintln!("daemon child instead).");
            eprintln!();
            eprintln!("Environment:");
            eprintln!("  ENDO_WORKER_THREADS   Tokio worker thread count (default: 4)");
            eprintln!("  ENDO_MANAGER_NODE     If set, use Node.js manager child");
            eprintln!("  ENDO_DAEMON_PATH      Path to Node.js daemon script (with ENDO_MANAGER_NODE)");
            eprintln!("  ENDO_DEFAULT_PLATFORM Default worker platform: separate, shared, node");
            eprintln!("  ENDO_TRACE            Enable trace logging");
        }
        "start" => {
            eprintln!("Usage: endor start");
            eprintln!();
            eprintln!("Spawn the daemon in a detached session.");
            eprintln!();
            eprintln!("If a daemon is already running (PID file exists and process is");
            eprintln!("alive), this is a no-op. Otherwise, forks a new daemon process");
            eprintln!("with setsid and waits up to 10 seconds for the Unix socket to");
            eprintln!("accept connections.");
        }
        "stop" => {
            eprintln!("Usage: endor stop");
            eprintln!();
            eprintln!("Gracefully stop a running daemon.");
            eprintln!();
            eprintln!("Sends SIGINT to the daemon process and waits up to 5 seconds");
            eprintln!("for it to exit.");
        }
        "ping" => {
            eprintln!("Usage: endor ping");
            eprintln!();
            eprintln!("Verify daemon responsiveness.");
            eprintln!();
            eprintln!("Connects to the daemon's Unix socket and immediately");
            eprintln!("disconnects. Prints \"pong\" on success; exits non-zero if");
            eprintln!("the daemon is not running or the socket is unreachable.");
        }
        "worker" => {
            eprintln!("Usage: endor worker [-e xs]");
            eprintln!();
            eprintln!("Run a supervised worker child.");
            eprintln!();
            eprintln!("This is not invoked directly — the daemon spawns worker");
            eprintln!("processes as needed. The worker communicates with the daemon");
            eprintln!("over fd 3 (read) and fd 4 (write) using CBOR-framed envelopes.");
            eprintln!();
            eprintln!("Options:");
            eprintln!("  -e, --engine <engine>  Engine to use (default: xs)");
        }
        "run" => {
            eprintln!("Usage: endor run [-e xs] [--offline] <archive.zip | entry.js>");
            eprintln!();
            eprintln!("Run a compartment-map archive standalone.");
            eprintln!();
            eprintln!("Executes the given .zip archive in an XS machine without a");
            eprintln!("running daemon. Useful for testing and one-off execution.");
            eprintln!();
            eprintln!("A .js/.mjs/.cjs entry module instead resolves the entry");
            eprintln!("package's npm dependencies (Go-like minimal version");
            eprintln!("selection), fetches them content-addressed into the CAS,");
            eprintln!("assembles the compartment map binding them, and executes");
            eprintln!("the entry module over XS — no npm CLI, no node_modules,");
            eprintln!("no lockfile.");
            eprintln!();
            eprintln!("Options:");
            eprintln!("  -e, --engine <engine>  Engine to use (default: xs)");
            eprintln!("  --offline              Resolve only from the local CAS and");
            eprintln!("                         registry table; no network access");
        }
        "gc" => {
            eprintln!("Usage: endor gc");
            eprintln!();
            eprintln!("Garbage-collect the content-addressed store.");
            eprintln!();
            eprintln!("Removes CAS entries that have zero retained references and");
            eprintln!("are not transitively referenced by any live tree root.");
            eprintln!("Safe to run while the daemon is stopped.");
        }
        "help" => {
            eprintln!("Usage: endor help [command]");
            eprintln!();
            eprintln!("Show help for a command. Without arguments, prints general usage.");
        }
        _ => {
            eprintln!("endor: unknown command '{sub}'");
            eprintln!();
            print_help();
        }
    }
}

fn result_to_exit(prog: &str, result: Result<(), EndoError>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{prog}: {e}");
            ExitCode::from(1)
        }
    }
}

fn xsnap_result_to_exit(result: Result<(), xsnap::XsnapError>) -> ExitCode {
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("endor: {e}");
            ExitCode::from(1)
        }
    }
}

fn unknown_engine(engine: &str) -> ExitCode {
    eprintln!("endor: unknown engine: {engine}");
    ExitCode::from(2)
}

/// Returns the value of `-e <engine>` / `--engine=<engine>` if present
/// in `args`, else None. The flag may appear anywhere after the
/// subcommand.
fn parse_engine(args: &[String]) -> Option<&str> {
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "-e" || a == "--engine" {
            if i + 1 < args.len() {
                return Some(args[i + 1].as_str());
            }
            return None;
        }
        if let Some(rest) = a.strip_prefix("--engine=") {
            return Some(rest);
        }
        if let Some(rest) = a.strip_prefix("-e=") {
            return Some(rest);
        }
        i += 1;
    }
    None
}

/// Returns the first positional argument (non-flag, non-flag-value).
fn parse_positional_path(args: &[String]) -> Option<PathBuf> {
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "-e" || a == "--engine" || a == "--cas" || a == "--cas-dir" {
            // skip the flag value as well
            i += 2;
            continue;
        }
        if a.starts_with("--engine=") || a.starts_with("-e=")
            || a.starts_with("--cas=") || a.starts_with("--cas-dir=")
        {
            i += 1;
            continue;
        }
        if a.starts_with('-') {
            i += 1;
            continue;
        }
        return Some(PathBuf::from(a));
    }
    None
}

/// Parse a flag with a value (e.g., --cas <hash>).
fn parse_flag_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            if i + 1 < args.len() {
                return Some(&args[i + 1]);
            }
            return None;
        }
        let prefix = format!("{flag}=");
        if let Some(rest) = args[i].strip_prefix(&prefix) {
            return Some(rest);
        }
        i += 1;
    }
    None
}

fn cmd_daemon() -> Result<(), EndoError> {
    let worker_threads = std::env::var("ENDO_WORKER_THREADS")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(4);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(worker_threads)
        .enable_all()
        .build()
        .map_err(|e| EndoError::Config(format!("tokio runtime: {e}")))?;

    runtime.block_on(async {
        let mut e = endo::endo::Endo::start()?;
        e.serve().await?;
        e.stop().await;
        Ok(())
    })
}

fn cmd_start() -> Result<(), EndoError> {
    let executable = std::env::current_exe()
        .map_err(|e| EndoError::Config(format!("current exe: {e}")))?
        .to_string_lossy()
        .to_string();
    let paths = endo::endo::start_detached(&executable)?;
    eprintln!("endor: started (log {})", paths.log_path.display());
    Ok(())
}

fn cmd_stop() -> Result<(), EndoError> {
    let paths = endo::endo::ensure_running()?;

    if let Ok(conn) = UnixStream::connect(&paths.sock_path) {
        let _ = conn.shutdown(Shutdown::Both);
    }

    let pid = endo::pidfile::read_pid(&paths.ephemeral_path)?;
    if pid != 0 && endo::pidfile::is_process_running(pid) {
        unsafe {
            libc::kill(pid as i32, libc::SIGINT);
        }
        for _ in 0..100 {
            if !endo::pidfile::is_process_running(pid) {
                return Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        return Err(EndoError::Timeout(format!(
            "process {pid} did not exit within 5s"
        )));
    }

    Ok(())
}

fn cmd_ping() -> Result<(), EndoError> {
    let paths = endo::endo::ensure_running()?;
    let conn = UnixStream::connect(&paths.sock_path)?;
    let _ = conn.shutdown(Shutdown::Both);
    eprintln!("pong");
    Ok(())
}

/// A `.js`/`.mjs`/`.cjs` positional is an entry module for the
/// npm-registry-proxy path; anything else stays an archive.
fn is_entry_module(path: &std::path::Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("js") | Some("mjs") | Some("cjs")
    )
}

/// `endor run <entry.js>`: Phase 4 of
/// `designs/endor-npm-registry-proxy.md`, end to end. Resolves the
/// entry package's transitive npm dependencies (Go-like MVS),
/// fetches them content-addressed into the CAS (the registry table
/// as cache/lock file), ingests the entry package, stores the
/// compartment map binding them, then materialises that map from
/// the CAS and imports the entry module in an in-process XS
/// machine.
fn cmd_run_entry(entry_path: &std::path::Path, offline: bool) -> Result<(), EndoError> {
    // Standalone runs share the archive path's temporary CAS; the
    // registry table lives beside it (override: ENDOR_REGISTRY_DB).
    let cas_dir = std::env::temp_dir().join("endor-cas");
    let cas = endo::cas::ContentStore::open(&cas_dir)
        .map_err(|e| EndoError::Config(format!("CAS open: {e}")))?;
    let registry_db = std::env::var("ENDOR_REGISTRY_DB")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("endor-registry.sqlite"));
    let registry_table = endo::registry::RegistryTable::open(&registry_db)
        .map_err(|e| EndoError::Config(format!("registry table open: {e}")))?;

    let (package_root, _) = endo::assemble::find_package_root(entry_path)
        .map_err(|e| EndoError::Config(format!("{e}")))?;
    let home = std::env::var("HOME").ok().map(std::path::PathBuf::from);
    let mut config = endo::npmrc::NpmConfig::load(Some(&package_root), home.as_deref());
    if offline {
        config.set_offline(true);
    }

    let assembled = if config.offline() {
        endo::assemble::assemble_entry(
            &endo::fetch::OfflineClient,
            &cas,
            &registry_table,
            config,
            entry_path,
        )
    } else {
        let http = endo::fetch::UreqClient::with_config(config.clone());
        endo::assemble::assemble_entry(&http, &cas, &registry_table, config, entry_path)
    }
    .map_err(|e| EndoError::Config(format!("{e}")))?;

    eprintln!(
        "endor[run]: assembled {} ({} packages)",
        assembled.package_name,
        assembled.resolution.len()
    );
    for package in assembled.resolution.packages() {
        eprintln!(
            "endor[run]:   {}@{} {}",
            package.name, package.version, package.tree_hash
        );
    }
    eprintln!("endor[run]: entry tree {}", assembled.entry_tree_hash);
    eprintln!(
        "endor[run]: compartment map {}",
        assembled.compartment_map_hash
    );

    // The XS execution half of Phase 4: materialise the assembled
    // map into a runnable archive and import the entry module.
    let archive = endo::run_map::load_run_archive(&cas, &assembled.compartment_map_hash)
        .map_err(|e| EndoError::Config(format!("materialise run archive: {e}")))?;
    xsnap::run_xs_archive_loaded(&archive)
        .map_err(|e| EndoError::Config(format!("XS execution: {e}")))?;
    Ok(())
}

fn cmd_run_with_cas(archive_path: &std::path::Path) -> Result<(), EndoError> {
    // Create a temporary CAS for standalone runs.
    let cas_dir = std::env::temp_dir().join("endor-cas");
    let cas = endo::cas::ContentStore::open(&cas_dir)
        .map_err(|e| EndoError::Config(format!("CAS open: {e}")))?;

    let bytes = std::fs::read(archive_path)
        .map_err(|e| EndoError::Config(format!("cannot open {}: {e}", archive_path.display())))?;
    let cursor = std::io::Cursor::new(&bytes);

    let ingested = endo::cas_archive::ingest_archive(&cas, cursor)
        .map_err(|e| EndoError::Config(format!("CAS ingest: {e}")))?;

    eprintln!("endor[run]: archive root {}", ingested.root_hash);

    // Run the archive using the loaded archive (already in memory).
    xsnap::run_xs_archive_loaded(&ingested.archive)
        .map_err(|e| EndoError::Config(format!("run: {e}")))?;
    Ok(())
}

fn cmd_run_from_cas(root_hash: &str) -> Result<(), EndoError> {
    let cas_dir = std::env::temp_dir().join("endor-cas");
    let cas = endo::cas::ContentStore::open(&cas_dir)
        .map_err(|e| EndoError::Config(format!("CAS open: {e}")))?;

    let archive = endo::cas_archive::load_archive_from_cas(&cas, root_hash)
        .map_err(|e| EndoError::Config(format!("CAS load: {e}")))?;

    xsnap::run_xs_archive_loaded(&archive)
        .map_err(|e| EndoError::Config(format!("run: {e}")))?;
    Ok(())
}

fn cmd_gc() -> Result<(), EndoError> {
    let paths = endo::paths::resolve_paths()?;
    let cas_dir = paths.state_path.join("store-sha256");
    if !cas_dir.exists() {
        eprintln!("endor gc: no CAS directory at {}", cas_dir.display());
        return Ok(());
    }
    let cas = endo::cas::ContentStore::open(&cas_dir)?;
    let live_roots = std::collections::HashSet::new();
    let report = cas.gc(&live_roots)?;
    eprintln!(
        "endor gc: freed {} entries ({} bytes)",
        report.freed_count, report.freed_bytes
    );
    Ok(())
}
