//! In-process XS peer bootstrap.
//!
//! Hosts the XS manager on a dedicated `std::thread` inside the
//! daemon process. A tokio ↔ blocking-thread bridge forwards CBOR
//! envelope bytes between the supervisor mailbox and the XS
//! machine's channel transport. The bytes on the channel are
//! byte-identical to what a pipe peer would see, so the daemon
//! routing layer is oblivious to the peer's location.
//!
//! Lifecycle:
//!  1. Allocate a handle, register the inbox with the supervisor,
//!     record WorkerInfo.
//!  2. Create two `std::sync::mpsc` channels — one supervisor →
//!     machine, one machine → supervisor — carrying raw CBOR
//!     envelope frames.
//!  3. Pre-seed the machine-bound channel with an `init` envelope
//!     carrying the parent handle so `init_handshake()` returns
//!     immediately.
//!  4. Spawn a tokio task bridging the supervisor inbox to the
//!     machine-bound channel (encoding envelopes along the way).
//!  5. Spawn a `tokio::task::spawn_blocking` bridge that drains
//!     the machine-to-supervisor channel and calls
//!     `sup.deliver(...)` for each envelope.
//!  6. Spawn a dedicated `std::thread` that installs the
//!     `ChannelTransport`, calls `xsnap::run_xs_manager_inproc`,
//!     and notifies the daemon shutdown on exit.

use std::io;
use std::sync::mpsc as std_mpsc;
use std::sync::Arc;
use std::time::SystemTime;

use tokio::sync::Notify;

use crate::cas::{ContentStore, TreeManifest};
use crate::codec;
use crate::fetch::{HttpClient, OfflineClient, UreqClient};
use crate::npmrc::NpmConfig;
use crate::paths::EndoPaths;
use crate::registry::RegistryTable;
use crate::registry_tree::{EndorRegistryTreeAdapter, RegistryTreeError, RegistryVersionLeaf};
use crate::supervisor::Supervisor;
use crate::types::{Envelope, Handle, Message, WorkerInfo};

use xsnap::powers::registry::{
    RegistryHost, RegistryHostError, RegistryHostErrorKind, RegistryPackageLeaf, RegistryTreeEntry,
};

struct EndorRegistryHost {
    http: Box<dyn HttpClient + Send>,
    cas: ContentStore,
    table: RegistryTable,
    config: NpmConfig,
}

impl EndorRegistryHost {
    fn adapter(&self) -> EndorRegistryTreeAdapter<'_, dyn HttpClient + Send> {
        EndorRegistryTreeAdapter::with_config(
            self.http.as_ref(),
            &self.cas,
            &self.table,
            self.config.clone(),
        )
    }

    fn backend_error(message: impl Into<String>) -> RegistryHostError {
        RegistryHostError {
            kind: RegistryHostErrorKind::Backend,
            message: message.into(),
        }
    }

    fn load_tree(&self, hash: &str) -> Result<TreeManifest, RegistryHostError> {
        let bytes = self
            .cas
            .fetch(hash)
            .map_err(|error| Self::backend_error(format!("read tree {hash}: {error}")))?;
        serde_json::from_slice(&bytes)
            .map_err(|error| Self::backend_error(format!("decode tree {hash}: {error}")))
    }
}

fn map_registry_error(error: RegistryTreeError) -> RegistryHostError {
    let kind = match &error {
        RegistryTreeError::NotFound(_) => RegistryHostErrorKind::NotFound,
        RegistryTreeError::Offline(_) => RegistryHostErrorKind::Offline,
        RegistryTreeError::Tampered(_) => RegistryHostErrorKind::Tampered,
        RegistryTreeError::Backend(_) => RegistryHostErrorKind::Backend,
    };
    RegistryHostError {
        kind,
        message: error.to_string(),
    }
}

impl RegistryHost for EndorRegistryHost {
    fn has_package(&self, name: &str) -> bool {
        self.adapter().has_package(name)
    }

    fn list_versions(&self, name: &str) -> Result<Vec<String>, RegistryHostError> {
        self.adapter()
            .list_versions(name)
            .map_err(map_registry_error)
    }

    fn provide_package_tree(
        &self,
        name: &str,
        version: &str,
    ) -> Result<RegistryPackageLeaf, RegistryHostError> {
        let RegistryVersionLeaf {
            tree_hash,
            integrity,
        } = self
            .adapter()
            .provide_package_tree(name, version)
            .map_err(map_registry_error)?;
        Ok(RegistryPackageLeaf {
            tree_hash,
            integrity,
        })
    }

    fn list_tree(&self, tree_hash: &str) -> Result<Vec<String>, RegistryHostError> {
        Ok(self.load_tree(tree_hash)?.entries.keys().cloned().collect())
    }

    fn lookup_tree(
        &self,
        tree_hash: &str,
        name: &str,
    ) -> Result<RegistryTreeEntry, RegistryHostError> {
        let entry = self
            .load_tree(tree_hash)?
            .entries
            .get(name)
            .cloned()
            .ok_or_else(|| RegistryHostError {
                kind: RegistryHostErrorKind::NotFound,
                message: format!("tree {tree_hash} has no entry {name}"),
            })?;
        Ok(RegistryTreeEntry {
            kind: entry.entry_type,
            hash: entry.hash,
            size: entry.size,
        })
    }

    fn read_blob(&self, hash: &str) -> Result<Vec<u8>, RegistryHostError> {
        self.cas
            .fetch(hash)
            .map_err(|error| Self::backend_error(format!("read blob {hash}: {error}")))
    }
}

fn make_registry_host(paths: &EndoPaths) -> io::Result<EndorRegistryHost> {
    let project_dir = std::env::current_dir().ok();
    let home_dir = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let mut config = NpmConfig::load(project_dir.as_deref(), home_dir.as_deref());
    if let Ok(registry_url) = std::env::var("ENDO_REGISTRY_URL") {
        if !registry_url.trim().is_empty() {
            config.set_default_registry(&registry_url);
        }
    }
    let offline = std::env::var("ENDO_REGISTRY_OFFLINE")
        .map(|value| value == "1")
        .unwrap_or(false);
    let http: Box<dyn HttpClient + Send> = if offline {
        Box::new(OfflineClient)
    } else {
        Box::new(UreqClient::with_config(config.clone()))
    };
    let cas = ContentStore::open(&paths.state_path.join("store-sha256"))?;
    let table = RegistryTable::open(&paths.state_path.join("registry.db"))?;
    Ok(EndorRegistryHost {
        http,
        cas,
        table,
        config,
    })
}

/// Spawn the manager bundle inside this process.
///
/// Returns the handle the supervisor will use to address the
/// manager.
pub fn spawn_inproc_xs_manager(
    sup: &Arc<Supervisor>,
    shutdown_notify: Arc<Notify>,
    paths: &EndoPaths,
) -> io::Result<Handle> {
    // Configure the manager via env vars for its JS side to read
    // through getEnv(). Setting env vars here is safe because this
    // runs on the main thread before any worker thread is spawned;
    // glibc's setenv/getenv race only bites concurrent mutators.
    //
    // Follow-up: replace env-var config with an init-envelope
    // payload so the manager JS's getEnv() dependence disappears.
    std::env::set_var("ENDO_SOCK_PATH", &paths.sock_path);
    std::env::set_var("ENDO_STATE_PATH", &paths.state_path);
    std::env::set_var("ENDO_EPHEMERAL_STATE_PATH", &paths.ephemeral_path);
    std::env::set_var("ENDO_CACHE_PATH", &paths.cache_path);
    if std::env::var_os("ENDO_WORKER_BIN").is_none() {
        // Default to the same binary's `worker` subcommand if the
        // embedder hasn't configured one explicitly.
        if let Ok(exe) = std::env::current_exe() {
            std::env::set_var(
                "ENDO_WORKER_BIN",
                format!("{} worker", exe.display()),
            );
        }
    }

    let registry = make_registry_host(paths)?;
    spawn_inproc_xs_peer(
        sup,
        "<in-process manager>".to_string(),
        Some(shutdown_notify),
        Box::new(move |transport| xsnap::run_xs_manager_inproc(transport, Box::new(registry))),
    )
}

/// Spawn an in-process XS worker (platform "shared").
///
/// Thin wrapper around `spawn_inproc_xs_peer` that runs
/// `xsnap::run_xs_worker_inproc` on a dedicated thread.
pub fn spawn_shared_worker(
    sup: &Arc<Supervisor>,
    _parent_handle: Handle,
) -> io::Result<Handle> {
    spawn_inproc_xs_peer(
        sup,
        "<shared-worker>".to_string(),
        None,
        Box::new(|transport| xsnap::run_xs_worker_inproc(transport)),
    )
}

/// Generalized in-process XS peer spawn.
///
/// Today only `spawn_inproc_xs_manager` calls this; the scaffolding
/// is here for a future iteration in which the JS spawn payload
/// carries an `engine` field and the daemon dispatches to this
/// function for XS in-process workers.
///
/// `run`: closure invoked on the dedicated machine thread after
/// the `ChannelTransport` is installed. It is handed ownership of
/// the transport so the XS runner can drive it directly.
pub fn spawn_inproc_xs_peer(
    sup: &Arc<Supervisor>,
    label: String,
    shutdown_notify: Option<Arc<Notify>>,
    run: Box<
        dyn FnOnce(
                Box<dyn xsnap::worker_io::WorkerTransport>,
            ) -> Result<(), xsnap::XsnapError>
            + Send,
    >,
) -> io::Result<Handle> {
    // Allocate handle and register with supervisor — this mirrors
    // the child-process spawn path so route_message is oblivious.
    let handle = sup.alloc_handle();
    let info = WorkerInfo {
        handle,
        platform: "shared".to_string(),
        cmd: "<in-process>".to_string(),
        args: Vec::new(),
        pid: std::process::id(),
        started: SystemTime::now(),
    };
    let mut inbox = sup.register(handle, Some(info));

    // Build the two std::mpsc channels that carry raw CBOR frames.
    // Use std::mpsc (not tokio mpsc) so the blocking machine thread
    // does not need a tokio runtime context. Bridge tasks on the
    // tokio side translate between the async inbox mailbox and
    // these blocking channels.
    let (sup_to_machine_tx, sup_to_machine_rx) = std_mpsc::channel::<Vec<u8>>();
    let (machine_to_sup_tx, machine_to_sup_rx) = std_mpsc::channel::<Vec<u8>>();

    // Pre-seed the machine-bound channel with an init envelope so
    // that `init_handshake()` returns the parent handle without a
    // round-trip. Use handle 0 (the daemon / capability bus) as
    // the parent.
    let parent_handle: Handle = 0;
    let init_bytes = codec::encode_envelope(&Envelope {
        handle: parent_handle,
        verb: "init".to_string(),
        payload: Vec::new(),
        nonce: 0,
    });
    sup_to_machine_tx
        .send(init_bytes)
        .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "machine channel closed"))?;

    // Inbound bridge: tokio inbox → machine-bound channel.
    //
    // Reads Message from the supervisor inbox, encodes as a CBOR
    // envelope, and pushes the bytes into the machine channel. The
    // encoding is byte-identical to what the pipe path would write
    // on the child's fd 4, so the machine sees no difference.
    let sup_to_machine_tx_bridge = sup_to_machine_tx;
    tokio::spawn(async move {
        loop {
            match inbox.recv().await {
                Some(msg) => {
                    let mut env = msg.envelope;
                    // Pipe-path semantics: rewrite handle to msg.from
                    // unless this is an init envelope (which we do
                    // not receive here, but the rule is consistent
                    // with proc.rs::write_message).
                    if env.verb != "init" {
                        env.handle = msg.from;
                    }
                    let bytes = codec::encode_envelope(&env);
                    if sup_to_machine_tx_bridge.send(bytes).is_err() {
                        return;
                    }
                    for msg in inbox.drain() {
                        let mut env = msg.envelope;
                        if env.verb != "init" {
                            env.handle = msg.from;
                        }
                        let bytes = codec::encode_envelope(&env);
                        if sup_to_machine_tx_bridge.send(bytes).is_err() {
                            return;
                        }
                    }
                }
                None => return,
            }
        }
    });

    // Outbound bridge: machine-to-sup channel → supervisor deliver.
    //
    // The std::mpsc recv is blocking, so run it in a blocking
    // task. Supervisor::deliver is sync (non-blocking tokio mpsc
    // send) so we can call it from a blocking context.
    let sup_outbound = Arc::clone(sup);
    tokio::task::spawn_blocking(move || {
        loop {
            match machine_to_sup_rx.recv() {
                Ok(bytes) => match codec::decode_envelope(&bytes) {
                    Ok(env) => {
                        let to = env.handle;
                        // Outbound: machine → supervisor routing.
                        sup_outbound.deliver(Message {
                            from: handle,
                            to,
                            envelope: env,
                            response_tx: None,
                        });
                    }
                    Err(e) => {
                        eprintln!("inproc: decode error: {e}");
                    }
                },
                Err(_) => return,
            }
        }
    });

    // Dedicated machine thread. Cannot use tokio::spawn_blocking
    // because xsnap::Machine is !Send + !Sync and the blocking pool
    // may reuse its threads across tasks. One std::thread per
    // machine is the correct lifetime.
    let sup_for_exit = Arc::clone(sup);
    // 32 MiB stack: the manager bundle is ~1.2 MB and SES bootstrap +
    // XS recursive eval can run deep enough to overflow the default
    // 2 MiB std::thread stack on glibc.
    let thread_builder = std::thread::Builder::new()
        .name(label.clone())
        .stack_size(32 * 1024 * 1024);
    let label_for_thread = label.clone();
    thread_builder.spawn(move || {
        // Drive the XS runner. The transport carries bytes that
        // match the pipe path exactly.
        let transport: Box<dyn xsnap::worker_io::WorkerTransport> =
            Box::new(xsnap::worker_io::ChannelTransport::new(
                sup_to_machine_rx,
                machine_to_sup_tx,
            ));
        let result = run(transport);
        if let Err(e) = result {
            eprintln!("inproc: {label_for_thread} exited with error: {e}");
        } else {
            eprintln!("inproc: {label_for_thread} exited cleanly");
        }
        // Notify the daemon that the peer has stopped and withdraw
        // the inbox so route_message drops new deliveries cleanly.
        sup_for_exit.unregister(handle);
        if let Some(n) = shutdown_notify {
            n.notify_one();
            sup_for_exit.stop();
        }
    })?;

    Ok(handle)
}
