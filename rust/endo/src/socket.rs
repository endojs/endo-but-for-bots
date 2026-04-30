//! Unix socket listener for bridging CLI client connections to
//! the XS daemon via the envelope protocol.
//!
//! The supervisor owns the socket and bridges client netstring-framed
//! CapTP traffic into envelopes addressed to the daemon.
//!
//! Protocol:
//!   1. Daemon sends `[0, "listen-path", {path: sockPath}, nonce]`
//!   2. Supervisor binds the Unix socket, responds `[0, "listening-path", {}, nonce]`
//!   3. Client connects → supervisor assigns handle C, sends
//!      `[C, "connect", {}, 0]` to daemon
//!   4. Client CapTP traffic bridged:
//!      - Client → daemon: read netstring frame, wrap in
//!        `[C, "deliver", payload, 0]`
//!      - Daemon → client: daemon sends `[C, "deliver", payload, 0]`,
//!        supervisor writes netstring frame to client
//!   5. Client disconnect → `[C, "disconnect", {}, 0]`

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use crate::codec;
use crate::supervisor::Supervisor;
use crate::types::{Envelope, Handle, Message};

fn slot_machine_mode() -> bool {
    std::env::var("ENDO_USE_SLOT_MACHINE").as_deref() == Ok("1")
}

/// Start a Unix socket listener that bridges client connections to
/// the daemon process identified by `daemon_handle`.
///
/// Each accepted connection gets a unique handle from the supervisor.
/// Client traffic is bridged via envelope deliver messages.
pub fn start_socket_listener(
    sup: Arc<Supervisor>,
    daemon_handle: Handle,
    sock_path: PathBuf,
) -> io::Result<()> {
    // Remove stale socket file if it exists.
    let _ = std::fs::remove_file(&sock_path);

    let listener = UnixListener::bind(&sock_path)?;
    eprintln!(
        "endor: socket listener started on {}",
        sock_path.display()
    );

    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let conn_handle = sup.alloc_handle();
                    let inbox = sup.register(conn_handle, None);

                    // Notify daemon of new connection.
                    sup.deliver(Message {
                        from: conn_handle,
                        to: daemon_handle,
                        envelope: Envelope {
                            handle: conn_handle,
                            verb: "connect".to_string(),
                            payload: Vec::new(),
                            nonce: 0,
                        },
                        response_tx: None,
                    });

                    let sup_for_client = Arc::clone(&sup);
                    wire_client_tasks(
                        stream,
                        conn_handle,
                        daemon_handle,
                        sup_for_client,
                        inbox,
                    );
                }
                Err(e) => {
                    eprintln!("endor: socket accept error: {e}");
                    break;
                }
            }
        }
    });

    Ok(())
}

/// Wire up read/write tasks for a client connection.
///
/// Client CapTP uses netstring framing over the Unix socket.
/// We bridge this into the envelope protocol for the daemon.
fn wire_client_tasks(
    stream: UnixStream,
    conn_handle: Handle,
    daemon_handle: Handle,
    sup: Arc<Supervisor>,
    mut inbox: crate::mailbox::MailboxReceiver,
) {
    let (read_half, write_half) = stream.into_split();

    let sup_read = Arc::clone(&sup);

    // Read task: client → daemon
    //
    // CapTP mode: read netstring-framed CapTP messages from the
    // client and wrap them in `deliver` envelopes to the daemon.
    //
    // Slot-machine mode (ENDO_USE_SLOT_MACHINE=1): the netstring
    // payload is itself a CBOR-encoded envelope.  Decode it and
    // forward with the inner verb preserved, so slot verbs other
    // than `deliver` (resolve / drop / abort) reach the daemon.
    tokio::spawn(async move {
        let slot_mode = slot_machine_mode();
        let mut reader = tokio::io::BufReader::new(read_half);
        loop {
            match read_netstring(&mut reader).await {
                Ok(Some(data)) => {
                    let envelope = if slot_mode {
                        match codec::decode_envelope(&data) {
                            Ok(e) => Envelope {
                                handle: conn_handle,
                                verb: e.verb,
                                payload: e.payload,
                                nonce: e.nonce,
                            },
                            Err(err) => {
                                eprintln!(
                                    "endor: client {conn_handle} envelope decode error: {err}"
                                );
                                continue;
                            }
                        }
                    } else {
                        Envelope {
                            handle: conn_handle,
                            verb: "deliver".to_string(),
                            payload: data,
                            nonce: 0,
                        }
                    };
                    sup_read.deliver(Message {
                        from: conn_handle,
                        to: daemon_handle,
                        envelope,
                        response_tx: None,
                    });
                }
                Ok(None) => {
                    // Client disconnected.
                    sup_read.deliver(Message {
                        from: conn_handle,
                        to: daemon_handle,
                        envelope: Envelope {
                            handle: conn_handle,
                            verb: "disconnect".to_string(),
                            payload: Vec::new(),
                            nonce: 0,
                        },
                        response_tx: None,
                    });
                    sup_read.unregister(conn_handle);
                    return;
                }
                Err(e) => {
                    eprintln!("endor: client {conn_handle} read error: {e}");
                    sup_read.deliver(Message {
                        from: conn_handle,
                        to: daemon_handle,
                        envelope: Envelope {
                            handle: conn_handle,
                            verb: "disconnect".to_string(),
                            payload: Vec::new(),
                            nonce: 0,
                        },
                        response_tx: None,
                    });
                    sup_read.unregister(conn_handle);
                    return;
                }
            }
        }
    });

    // Write task: daemon → client
    //
    // CapTP mode: only `deliver` envelopes are forwarded; the
    // netstring frame contains the raw CapTP payload bytes.
    //
    // Slot-machine mode: every slot verb (deliver / resolve /
    // drop / abort) is forwarded as a re-encoded CBOR envelope
    // wrapped in a netstring frame.  The client's makeNetstringSlots
    // decodes the inner envelope and routes by verb.
    tokio::spawn(async move {
        let slot_mode = slot_machine_mode();
        let write_one = async |writer: &mut tokio::net::unix::OwnedWriteHalf, msg: Message| -> io::Result<()> {
            if slot_mode {
                let bytes = codec::encode_envelope(&msg.envelope);
                write_netstring(writer, &bytes).await
            } else if msg.envelope.verb == "deliver" {
                write_netstring(writer, &msg.envelope.payload).await
            } else {
                Ok(())
            }
        };
        let mut writer = write_half;
        loop {
            match inbox.recv().await {
                Some(msg) => {
                    if let Err(e) = write_one(&mut writer, msg).await {
                        eprintln!("endor: client {conn_handle} write error: {e}");
                        return;
                    }
                    for msg in inbox.drain() {
                        if let Err(e) = write_one(&mut writer, msg).await {
                            eprintln!("endor: client {conn_handle} write error: {e}");
                            return;
                        }
                    }
                }
                None => return,
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Netstring codec
// ---------------------------------------------------------------------------

/// Read one netstring frame: `<length>:<data>,`
///
/// Returns None on EOF.
async fn read_netstring(
    reader: &mut tokio::io::BufReader<tokio::net::unix::OwnedReadHalf>,
) -> io::Result<Option<Vec<u8>>> {
    // Read length digits until ':'.
    let mut len_buf = Vec::with_capacity(16);
    loop {
        let mut byte = [0u8; 1];
        match reader.read_exact(&mut byte).await {
            Ok(_) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => {
                if len_buf.is_empty() {
                    return Ok(None); // Clean EOF
                }
                return Err(e);
            }
            Err(e) => return Err(e),
        }
        if byte[0] == b':' {
            break;
        }
        if !byte[0].is_ascii_digit() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("netstring: expected digit or ':', got {}", byte[0]),
            ));
        }
        len_buf.push(byte[0]);
        if len_buf.len() > 10 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "netstring: length field too long",
            ));
        }
    }
    let len_str = std::str::from_utf8(&len_buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let len: usize = len_str
        .parse()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    const MAX_NETSTRING_SIZE: usize = 16 * 1024 * 1024;
    if len > MAX_NETSTRING_SIZE {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("netstring: size {len} exceeds maximum"),
        ));
    }

    // Read data.
    let mut data = vec![0u8; len];
    if len > 0 {
        reader.read_exact(&mut data).await?;
    }

    // Read trailing comma.
    let mut comma = [0u8; 1];
    reader.read_exact(&mut comma).await?;
    if comma[0] != b',' {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("netstring: expected ',', got {}", comma[0]),
        ));
    }

    Ok(Some(data))
}

/// Write one netstring frame: `<length>:<data>,`
async fn write_netstring(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    data: &[u8],
) -> io::Result<()> {
    let header = format!("{}:", data.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(data).await?;
    writer.write_all(b",").await?;
    writer.flush().await
}
