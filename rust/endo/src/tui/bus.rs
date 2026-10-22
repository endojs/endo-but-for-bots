//! Async bus client for `endor tui` (designs/endor-tui.md § Relationship
//! to the Daemon Bus). Speaks the existing CBOR envelope framing from
//! `codec`; the TUI verbs themselves (`inbox.follow`, `inventory.follow`,
//! `send`, `command.submit`) are specified by designs/endor-bus-tui.md,
//! which the daemon does not serve yet. Until it does, payloads are
//! provisional JSON objects and the client simply sees no events.

use std::path::PathBuf;
use std::time::Duration;

use tokio::net::UnixStream;
use tokio::sync::mpsc;

use super::state::Message;
use crate::codec::{async_read_frame, async_write_frame, decode_envelope, encode_envelope};
use crate::types::Envelope;

/// Daemon → TUI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BusEvent {
    Connected,
    Disconnected {
        attempt: u32,
        retry_ms: u64,
    },
    MessageAdded(Message),
    /// `message.dismissed` and `message.resolved` both drop the message
    /// from the inbox transcript.
    MessageRemoved {
        number: u64,
    },
    InventoryAdded {
        name: String,
    },
    InventoryRemoved {
        name: String,
    },
    CommandSettled {
        id: u64,
        ok: bool,
        text: String,
    },
}

/// TUI → daemon.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BusRequest {
    Send {
        to: String,
        body: String,
    },
    Submit {
        id: u64,
        command: String,
    },
    /// Drop any backoff and dial now (`:reconnect`).
    Reconnect,
}

const BACKOFF_BASE_MS: u64 = 250;
const BACKOFF_MAX_MS: u64 = 10_000;

/// Exponential reconnect backoff, capped.
pub fn backoff_ms(attempt: u32) -> u64 {
    BACKOFF_BASE_MS
        .saturating_mul(1u64 << attempt.min(16))
        .min(BACKOFF_MAX_MS)
}

fn envelope(verb: &str, payload: serde_json::Value, nonce: i64) -> Envelope {
    Envelope {
        handle: 0,
        verb: verb.to_string(),
        payload: serde_json::to_vec(&payload).unwrap_or_default(),
        nonce,
    }
}

/// Envelopes sent on every (re)connect to subscribe the active profile.
pub fn subscriptions() -> Vec<Envelope> {
    vec![
        envelope("inbox.follow", serde_json::json!({}), 0),
        envelope("inventory.follow", serde_json::json!({}), 0),
    ]
}

pub fn encode_request(req: &BusRequest) -> Option<Envelope> {
    match req {
        BusRequest::Send { to, body } => Some(envelope(
            "send",
            serde_json::json!({ "to": to, "strings": [body] }),
            0,
        )),
        BusRequest::Submit { id, command } => Some(envelope(
            "command.submit",
            serde_json::json!({ "command": command }),
            *id as i64,
        )),
        BusRequest::Reconnect => None,
    }
}

pub fn decode_event(env: &Envelope) -> Option<BusEvent> {
    let v: serde_json::Value = serde_json::from_slice(&env.payload).ok()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
    let n = |k: &str| v.get(k).and_then(|x| x.as_u64());
    match env.verb.as_str() {
        "message.added" => Some(BusEvent::MessageAdded(Message {
            number: n("number")?,
            date: s("date").unwrap_or_default(),
            from: s("from")?,
            to: s("to"),
            body: s("body").unwrap_or_default(),
        })),
        "message.dismissed" | "message.resolved" => Some(BusEvent::MessageRemoved {
            number: n("number")?,
        }),
        "inventory.added" => Some(BusEvent::InventoryAdded { name: s("name")? }),
        "inventory.removed" => Some(BusEvent::InventoryRemoved { name: s("name")? }),
        "command.settled" => Some(BusEvent::CommandSettled {
            id: u64::try_from(env.nonce).ok()?,
            ok: v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
            text: s("text").unwrap_or_default(),
        }),
        _ => None,
    }
}

/// Runs the connection loop until `requests` closes: dial, subscribe,
/// pump frames both ways, and on loss report `Disconnected` and retry
/// with backoff.
pub async fn run(
    sock_path: PathBuf,
    events: mpsc::UnboundedSender<BusEvent>,
    mut requests: mpsc::UnboundedReceiver<BusRequest>,
) {
    let mut attempt: u32 = 0;
    loop {
        if let Ok(stream) = UnixStream::connect(&sock_path).await {
            attempt = 0;
            if events.send(BusEvent::Connected).is_err() {
                return;
            }
            match session(stream, &events, &mut requests).await {
                SessionEnd::Closed => return,
                SessionEnd::Lost => {}
            }
        }
        let retry_ms = backoff_ms(attempt);
        attempt = attempt.saturating_add(1);
        if events
            .send(BusEvent::Disconnected { attempt, retry_ms })
            .is_err()
        {
            return;
        }
        let sleep = tokio::time::sleep(Duration::from_millis(retry_ms));
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                req = requests.recv() => match req {
                    None => return,
                    Some(BusRequest::Reconnect) => break,
                    Some(BusRequest::Submit { id, .. }) => {
                        let _ = events.send(BusEvent::CommandSettled {
                            id,
                            ok: false,
                            text: "not connected".to_string(),
                        });
                    }
                    Some(BusRequest::Send { .. }) => {}
                },
            }
        }
    }
}

enum SessionEnd {
    Closed,
    Lost,
}

async fn session(
    stream: UnixStream,
    events: &mpsc::UnboundedSender<BusEvent>,
    requests: &mut mpsc::UnboundedReceiver<BusRequest>,
) -> SessionEnd {
    let (mut rd, mut wr) = stream.into_split();
    for env in subscriptions() {
        if async_write_frame(&mut wr, &encode_envelope(&env))
            .await
            .is_err()
        {
            return SessionEnd::Lost;
        }
    }
    loop {
        tokio::select! {
            frame = async_read_frame(&mut rd) => match frame {
                Ok(Some(bytes)) => {
                    if let Some(ev) = decode_envelope(&bytes).ok().as_ref().and_then(decode_event) {
                        if events.send(ev).is_err() {
                            return SessionEnd::Closed;
                        }
                    }
                }
                _ => return SessionEnd::Lost,
            },
            req = requests.recv() => match req {
                None => return SessionEnd::Closed,
                Some(BusRequest::Reconnect) => return SessionEnd::Lost,
                Some(req) => {
                    if let Some(env) = encode_request(&req) {
                        if async_write_frame(&mut wr, &encode_envelope(&env)).await.is_err() {
                            return SessionEnd::Lost;
                        }
                    }
                }
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(backoff_ms(0), 250);
        assert_eq!(backoff_ms(1), 500);
        assert_eq!(backoff_ms(3), 2000);
        assert_eq!(backoff_ms(10), BACKOFF_MAX_MS);
        assert_eq!(backoff_ms(u32::MAX), BACKOFF_MAX_MS);
    }

    #[test]
    fn submit_carries_id_as_nonce_and_settles_back() {
        let env = encode_request(&BusRequest::Submit {
            id: 7,
            command: "dismiss 42".into(),
        })
        .unwrap();
        assert_eq!(env.verb, "command.submit");
        assert_eq!(env.nonce, 7);
        let back = envelope(
            "command.settled",
            serde_json::json!({ "ok": true, "text": "done" }),
            7,
        );
        assert_eq!(
            decode_event(&back),
            Some(BusEvent::CommandSettled {
                id: 7,
                ok: true,
                text: "done".into()
            })
        );
    }

    #[test]
    fn events_round_trip_through_cbor_envelope() {
        let env = envelope(
            "message.added",
            serde_json::json!({ "number": 42, "from": "alice", "body": "hi" }),
            0,
        );
        let decoded = decode_envelope(&encode_envelope(&env)).unwrap();
        match decode_event(&decoded) {
            Some(BusEvent::MessageAdded(m)) => {
                assert_eq!(m.number, 42);
                assert_eq!(m.from, "alice");
                assert_eq!(m.body, "hi");
            }
            other => panic!("unexpected {other:?}"),
        }
        let gone = envelope("message.resolved", serde_json::json!({ "number": 42 }), 0);
        assert_eq!(
            decode_event(&gone),
            Some(BusEvent::MessageRemoved { number: 42 })
        );
    }

    #[test]
    fn unknown_or_malformed_events_are_ignored() {
        assert_eq!(
            decode_event(&envelope("debug.output", serde_json::json!({}), 0)),
            None
        );
        let bad = Envelope {
            handle: 0,
            verb: "message.added".into(),
            payload: vec![0xff],
            nonce: 0,
        };
        assert_eq!(decode_event(&bad), None);
    }

    #[tokio::test]
    async fn reconnects_after_daemon_loss() {
        let dir = std::env::temp_dir().join(format!("endor-tui-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let sock = dir.join("b.sock");
        let _ = std::fs::remove_file(&sock);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let (req_tx, req_rx) = mpsc::unbounded_channel();
        let client = tokio::spawn(run(sock.clone(), ev_tx, req_rx));

        // No daemon yet: the client reports loss and retries.
        assert!(matches!(
            ev_rx.recv().await,
            Some(BusEvent::Disconnected { .. })
        ));

        let listener = tokio::net::UnixListener::bind(&sock).unwrap();
        req_tx.send(BusRequest::Reconnect).unwrap();
        let (mut conn, _) = listener.accept().await.unwrap();
        assert_eq!(ev_rx.recv().await, Some(BusEvent::Connected));
        let first = async_read_frame(&mut conn).await.unwrap().unwrap();
        assert_eq!(decode_envelope(&first).unwrap().verb, "inbox.follow");

        let ev = envelope("inventory.added", serde_json::json!({ "name": "alice" }), 0);
        async_write_frame(&mut conn, &encode_envelope(&ev))
            .await
            .unwrap();
        assert_eq!(
            ev_rx.recv().await,
            Some(BusEvent::InventoryAdded {
                name: "alice".into()
            })
        );

        drop(conn);
        assert!(matches!(
            ev_rx.recv().await,
            Some(BusEvent::Disconnected { attempt: 1, .. })
        ));
        req_tx.send(BusRequest::Reconnect).unwrap();
        let _conn = listener.accept().await.unwrap();
        assert_eq!(ev_rx.recv().await, Some(BusEvent::Connected));

        drop(req_tx);
        client.await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
