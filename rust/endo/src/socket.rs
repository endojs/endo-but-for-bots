//! Unix socket listener for bridging CLI client connections to
//! the XS daemon via the envelope protocol.
//!
//! The supervisor owns the socket and bridges client CapTP traffic into
//! envelopes addressed to the daemon.
//!
//! Clients frame CapTP messages with either netstrings or cbor-frame
//! (a CBOR tag-24-wrapped byte-string head, as `@endo/cbor-frame`
//! writes). The two grammars are disjoint at the first byte of a
//! connection, so the supervisor classifies each connection by its
//! first byte and mirrors the client's framing on outbound frames. See
//! `designs/daemon-cbor-frame-migration.md`.
//!
//! Protocol:
//!   1. Daemon sends `[0, "listen-path", {path: sockPath}, nonce]`
//!   2. Supervisor binds the Unix socket, responds `[0, "listening-path", {}, nonce]`
//!   3. Client connects → supervisor assigns handle C, sends
//!      `[C, "connect", {}, 0]` to daemon
//!   4. Client CapTP traffic bridged:
//!      - Client → daemon: read frame, wrap in
//!        `[C, "deliver", payload, 0]`
//!      - Daemon → client: daemon sends `[C, "deliver", payload, 0]`,
//!        supervisor writes a frame in the client's framing
//!   5. Client disconnect → `[C, "disconnect", {}, 0]`

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt,
};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;

use crate::supervisor::Supervisor;
use crate::types::{Envelope, Handle, Message};

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
    eprintln!("endor: socket listener started on {}", sock_path.display());

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
                    wire_client_tasks(stream, conn_handle, daemon_handle, sup_for_client, inbox);
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
/// Client CapTP is framed with netstrings or cbor-frame, classified
/// from the client's first byte. We bridge this into the envelope
/// protocol for the daemon.
fn wire_client_tasks(
    stream: UnixStream,
    conn_handle: Handle,
    daemon_handle: Handle,
    sup: Arc<Supervisor>,
    mut inbox: crate::mailbox::MailboxReceiver,
) {
    let (read_half, write_half) = stream.into_split();

    let sup_read = Arc::clone(&sup);

    // The read task settles the framing when the client's first byte
    // arrives; the write task waits on it so an outbound frame never
    // guesses. Dropping the sender (EOF or an unrecognized first byte)
    // stops the write task.
    let (framing_tx, framing_rx) = oneshot::channel::<Framing>();

    let disconnect = move |sup: &Supervisor| {
        sup.deliver(Message {
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
        sup.unregister(conn_handle);
    };

    // Read task: client → daemon
    // Reads framed CapTP messages from the client and wraps them in
    // deliver envelopes to the daemon.
    tokio::spawn(async move {
        let mut reader = tokio::io::BufReader::new(read_half);
        let framing = match sniff_framing(&mut reader).await {
            Ok(Some(framing)) => framing,
            Ok(None) => {
                // Client disconnected before its first frame.
                disconnect(&sup_read);
                return;
            }
            Err(e) => {
                eprintln!("endor: client {conn_handle} read error: {e}");
                disconnect(&sup_read);
                return;
            }
        };
        let _ = framing_tx.send(framing);
        loop {
            match read_frame(framing, &mut reader).await {
                Ok(Some(data)) => {
                    sup_read.deliver(Message {
                        from: conn_handle,
                        to: daemon_handle,
                        envelope: Envelope {
                            handle: conn_handle,
                            verb: "deliver".to_string(),
                            payload: data,
                            nonce: 0,
                        },
                        response_tx: None,
                    });
                }
                Ok(None) => {
                    // Client disconnected.
                    disconnect(&sup_read);
                    return;
                }
                Err(e) => {
                    eprintln!("endor: client {conn_handle} read error: {e}");
                    disconnect(&sup_read);
                    return;
                }
            }
        }
    });

    // Write task: daemon → client
    // Receives deliver envelopes from the daemon and writes them to the
    // client in the client's framing.
    tokio::spawn(async move {
        let mut writer = write_half;
        let mut framing_rx = Some(framing_rx);
        let mut framing = None;
        loop {
            match inbox.recv().await {
                Some(msg) => {
                    let framing = match framing {
                        Some(framing) => framing,
                        None => match framing_rx.take() {
                            Some(rx) => match rx.await {
                                Ok(chosen) => {
                                    framing = Some(chosen);
                                    chosen
                                }
                                Err(_) => return,
                            },
                            None => return,
                        },
                    };
                    if msg.envelope.verb == "deliver" {
                        if let Err(e) =
                            write_frame(framing, &mut writer, &msg.envelope.payload).await
                        {
                            eprintln!("endor: client {conn_handle} write error: {e}");
                            return;
                        }
                    }
                    // Drain any queued messages.
                    for msg in inbox.drain() {
                        if msg.envelope.verb == "deliver" {
                            if let Err(e) =
                                write_frame(framing, &mut writer, &msg.envelope.payload).await
                            {
                                eprintln!("endor: client {conn_handle} write error: {e}");
                                return;
                            }
                        }
                    }
                }
                None => return,
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Framing classification
// ---------------------------------------------------------------------------

/// The framing a client chose for its connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Framing {
    /// `<length>:<data>,`
    Netstring,
    /// Tag 24, then a CBOR byte-string head, then the data.
    CborFrame,
}

/// The first byte of every cbor-frame frame: the initial byte of the
/// mandatory tag-24 wrapper (major type 6, one-byte argument).
const CBOR_TAG_24_INITIAL: u8 = 0xd8;
/// The argument byte of the tag-24 wrapper.
const CBOR_TAG_24_ARG: u8 = 0x18;
/// Initial byte of a CBOR byte string (major type 2) with the
/// additional-info bits cleared.
const CBOR_MAJOR_2_BASE: u8 = 0x40;

/// Same ceiling as the netstring reader.
const MAX_FRAME_SIZE: usize = 16 * 1024 * 1024;

/// Classify a connection's framing from its first byte.
pub(crate) fn classify_first_byte(byte: u8) -> io::Result<Framing> {
    if byte.is_ascii_digit() {
        Ok(Framing::Netstring)
    } else if byte == CBOR_TAG_24_INITIAL {
        Ok(Framing::CborFrame)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "unrecognized framing: first byte 0x{byte:02x} is neither a netstring length digit nor the cbor-frame tag-24 prefix"
            ),
        ))
    }
}

/// Peek the first byte of a connection without consuming it.
///
/// Returns None on EOF before any byte.
async fn sniff_framing<R: AsyncBufRead + Unpin>(reader: &mut R) -> io::Result<Option<Framing>> {
    let buf = reader.fill_buf().await?;
    match buf.first() {
        None => Ok(None),
        Some(&byte) => classify_first_byte(byte).map(Some),
    }
}

async fn read_frame<R: AsyncRead + Unpin>(
    framing: Framing,
    reader: &mut R,
) -> io::Result<Option<Vec<u8>>> {
    match framing {
        Framing::Netstring => read_netstring(reader).await,
        Framing::CborFrame => read_cbor_frame(reader).await,
    }
}

async fn write_frame<W: AsyncWrite + Unpin>(
    framing: Framing,
    writer: &mut W,
    data: &[u8],
) -> io::Result<()> {
    match framing {
        Framing::Netstring => write_netstring(writer, data).await,
        Framing::CborFrame => write_cbor_frame(writer, data).await,
    }
}

// ---------------------------------------------------------------------------
// cbor-frame codec
// ---------------------------------------------------------------------------

/// Encode the tag-24 wrapper and the shortest canonical (RFC 8949
/// section 4.2.1) byte-string head for a payload of `len` bytes.
pub(crate) fn encode_cbor_frame_head(len: usize) -> Vec<u8> {
    let mut head = vec![CBOR_TAG_24_INITIAL, CBOR_TAG_24_ARG];
    let len = len as u64;
    if len <= 23 {
        head.push(CBOR_MAJOR_2_BASE + len as u8);
    } else if len <= 0xff {
        head.push(CBOR_MAJOR_2_BASE + 24);
        head.push(len as u8);
    } else if len <= 0xffff {
        head.push(CBOR_MAJOR_2_BASE + 25);
        head.extend_from_slice(&(len as u16).to_be_bytes());
    } else if len <= 0xffff_ffff {
        head.push(CBOR_MAJOR_2_BASE + 26);
        head.extend_from_slice(&(len as u32).to_be_bytes());
    } else {
        head.push(CBOR_MAJOR_2_BASE + 27);
        head.extend_from_slice(&len.to_be_bytes());
    }
    head
}

/// Read one cbor-frame frame: tag 24, a byte-string head, the data.
///
/// Returns None on EOF at a frame boundary.
async fn read_cbor_frame<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut tag = [0u8; 1];
    match reader.read_exact(&mut tag).await {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    if tag[0] != CBOR_TAG_24_INITIAL {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "cbor-frame: expected tag-24 initial byte 0xd8, got 0x{:02x}",
                tag[0]
            ),
        ));
    }
    let mut arg_and_initial = [0u8; 2];
    reader.read_exact(&mut arg_and_initial).await?;
    let [arg, initial] = arg_and_initial;
    if arg != CBOR_TAG_24_ARG {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("cbor-frame: only tag 24 is accepted, got tag argument byte 0x{arg:02x}"),
        ));
    }
    if !(CBOR_MAJOR_2_BASE..CBOR_MAJOR_2_BASE + 0x20).contains(&initial) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("cbor-frame: expected a byte-string head inside tag 24, got initial byte 0x{initial:02x}"),
        ));
    }
    let info = initial - CBOR_MAJOR_2_BASE;
    let follow = match info {
        0..=23 => 0,
        24 => 1,
        25 => 2,
        26 => 4,
        27 => 8,
        31 => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "cbor-frame: indefinite-length byte strings are not accepted",
            ))
        }
        _ => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("cbor-frame: reserved additional-info {info} in byte-string head"),
            ))
        }
    };
    let len: u64 = if follow == 0 {
        u64::from(info)
    } else {
        let mut buf = [0u8; 8];
        reader.read_exact(&mut buf[8 - follow..]).await?;
        u64::from_be_bytes(buf)
    };
    if len > MAX_FRAME_SIZE as u64 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("cbor-frame: size {len} exceeds maximum"),
        ));
    }
    let mut data = vec![0u8; len as usize];
    if len > 0 {
        reader.read_exact(&mut data).await?;
    }
    Ok(Some(data))
}

/// Write one cbor-frame frame: tag 24, a byte-string head, the data.
async fn write_cbor_frame<W: AsyncWrite + Unpin>(writer: &mut W, data: &[u8]) -> io::Result<()> {
    writer
        .write_all(&encode_cbor_frame_head(data.len()))
        .await?;
    writer.write_all(data).await?;
    writer.flush().await
}

// ---------------------------------------------------------------------------
// Netstring codec
// ---------------------------------------------------------------------------

/// Read one netstring frame: `<length>:<data>,`
///
/// Returns None on EOF.
async fn read_netstring<R: AsyncRead + Unpin>(reader: &mut R) -> io::Result<Option<Vec<u8>>> {
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
    let len_str =
        std::str::from_utf8(&len_buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    let len: usize = len_str
        .parse()
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    if len > MAX_FRAME_SIZE {
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
async fn write_netstring<W: AsyncWrite + Unpin>(writer: &mut W, data: &[u8]) -> io::Result<()> {
    let header = format!("{}:", data.len());
    writer.write_all(header.as_bytes()).await?;
    writer.write_all(data).await?;
    writer.write_all(b",").await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_every_first_byte() {
        for byte in 0..=255u8 {
            match classify_first_byte(byte) {
                Ok(Framing::Netstring) => assert!(byte.is_ascii_digit(), "0x{byte:02x}"),
                Ok(Framing::CborFrame) => assert_eq!(byte, 0xd8),
                Err(e) => {
                    assert!(!byte.is_ascii_digit() && byte != 0xd8, "0x{byte:02x}");
                    assert_eq!(e.kind(), io::ErrorKind::InvalidData);
                }
            }
        }
    }

    /// Pins the same specimen bytes as `packages/daemon/test/framing.test.js`.
    #[tokio::test]
    async fn writes_specimen_frames() {
        let mut out = Vec::new();
        write_frame(Framing::Netstring, &mut out, b"hello")
            .await
            .unwrap();
        assert_eq!(out, b"5:hello,");
        let mut out = Vec::new();
        write_frame(Framing::CborFrame, &mut out, b"hello")
            .await
            .unwrap();
        assert_eq!(out, [0xd8, 0x18, 0x45, b'h', b'e', b'l', b'l', b'o']);
    }

    #[test]
    fn encodes_canonical_heads() {
        assert_eq!(encode_cbor_frame_head(0), [0xd8, 0x18, 0x40]);
        assert_eq!(encode_cbor_frame_head(23), [0xd8, 0x18, 0x57]);
        assert_eq!(encode_cbor_frame_head(24), [0xd8, 0x18, 0x58, 24]);
        assert_eq!(
            encode_cbor_frame_head(0x100),
            [0xd8, 0x18, 0x59, 0x01, 0x00]
        );
        assert_eq!(
            encode_cbor_frame_head(0x1_0000),
            [0xd8, 0x18, 0x5a, 0x00, 0x01, 0x00, 0x00]
        );
    }

    #[tokio::test]
    async fn sniffs_and_round_trips_both_framings() {
        for framing in [Framing::Netstring, Framing::CborFrame] {
            let mut wire = Vec::new();
            for payload in [&b""[..], b"hello", &[7u8; 300][..]] {
                write_frame(framing, &mut wire, payload).await.unwrap();
            }
            let mut reader = tokio::io::BufReader::new(&wire[..]);
            assert_eq!(sniff_framing(&mut reader).await.unwrap(), Some(framing));
            assert_eq!(
                read_frame(framing, &mut reader).await.unwrap(),
                Some(Vec::new())
            );
            assert_eq!(
                read_frame(framing, &mut reader).await.unwrap(),
                Some(b"hello".to_vec())
            );
            assert_eq!(
                read_frame(framing, &mut reader).await.unwrap(),
                Some(vec![7u8; 300])
            );
            assert_eq!(read_frame(framing, &mut reader).await.unwrap(), None);
        }
    }

    #[tokio::test]
    async fn sniff_reports_eof_and_rejects_unknown_bytes() {
        let mut empty = tokio::io::BufReader::new(&b""[..]);
        assert_eq!(sniff_framing(&mut empty).await.unwrap(), None);
        let mut json = tokio::io::BufReader::new(&b"{}"[..]);
        assert!(sniff_framing(&mut json).await.is_err());
    }

    #[tokio::test]
    async fn cbor_frame_rejects_malformed_heads() {
        for wire in [
            &[0xd8, 0x19, 0x40][..],                     // tag 25, not 24
            &[0xd8, 0x18, 0x60],                         // text string, not byte string
            &[0xd8, 0x18, 0x5f],                         // indefinite length
            &[0xd8, 0x18, 0x5c],                         // reserved additional info
            &[0xd8, 0x18, 0x5a, 0x7f, 0xff, 0xff, 0xff], // over the ceiling
        ] {
            let mut reader = wire;
            assert!(read_cbor_frame(&mut reader).await.is_err(), "{wire:02x?}");
        }
    }
}
