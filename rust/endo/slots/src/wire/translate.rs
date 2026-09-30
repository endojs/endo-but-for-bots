//! Descriptor translation through the [`SlotMachine`].
//!
//! Every inbound descriptor is in the *sender's* frame: when a
//! worker sends a message with a descriptor marked `Direction::Local`
//! at position N, that means "I allocated N in my session."  To
//! translate for an outbound recipient, we:
//!
//! 1. Reconstruct the sender's vref from the descriptor.
//! 2. Look up (or allocate, via [`SlotMachine::receive`]) the kref.
//! 3. Ask the slot machine for the recipient's vref via
//!    [`SlotMachine::send`].
//! 4. Emit a descriptor in the *recipient's* frame (direction +
//!    position derived from the new vref).

use crate::error::Result;
use crate::session::SessionId;
use crate::table::SlotMachine;
use crate::wire::descriptor::Descriptor;
use crate::wire::payload::{
    DeliverPayload, DropDelta, DropPayload, GetPayload, IndexPayload, ResolvePayload, UntagPayload,
};

fn translate_one(
    sm: &SlotMachine,
    from: SessionId,
    to: SessionId,
    desc: &Descriptor,
) -> Result<Descriptor> {
    let vref = desc.to_vref();
    let kref = sm.receive(from, &vref)?;
    let out = sm.send(to, kref)?;
    Ok(Descriptor::from_vref(&out.vref))
}

fn translate_slice(
    sm: &SlotMachine,
    from: SessionId,
    to: SessionId,
    descs: &[Descriptor],
) -> Result<Vec<Descriptor>> {
    descs.iter().map(|d| translate_one(sm, from, to, d)).collect()
}

/// Translate a `deliver` payload from its sender's frame into the
/// recipient's frame.  Body bytes are copied verbatim; only the
/// descriptor slots are rewritten.
pub fn translate_deliver(
    sm: &SlotMachine,
    from: SessionId,
    to: SessionId,
    inbound: &[u8],
) -> Result<Vec<u8>> {
    let p = DeliverPayload::decode(inbound)?;
    let out = DeliverPayload {
        target: translate_one(sm, from, to, &p.target)?,
        body: p.body,
        targets: translate_slice(sm, from, to, &p.targets)?,
        promises: translate_slice(sm, from, to, &p.promises)?,
        reply: match p.reply {
            Some(d) => Some(translate_one(sm, from, to, &d)?),
            None => None,
        },
    };
    Ok(out.encode())
}

/// Translate a `resolve` payload (same mechanics as deliver, minus
/// the reply descriptor).
pub fn translate_resolve(
    sm: &SlotMachine,
    from: SessionId,
    to: SessionId,
    inbound: &[u8],
) -> Result<Vec<u8>> {
    let p = ResolvePayload::decode(inbound)?;
    let out = ResolvePayload {
        target: translate_one(sm, from, to, &p.target)?,
        is_reject: p.is_reject,
        body: p.body,
        targets: translate_slice(sm, from, to, &p.targets)?,
        promises: translate_slice(sm, from, to, &p.promises)?,
    };
    Ok(out.encode())
}

/// Translate a `get` payload from its sender's frame into the
/// recipient's frame.  Only the `target` and `reply` descriptors are
/// rewritten; the scalar field name is copied verbatim.  A malformed
/// payload is an error the caller must treat as fatal — the data lanes
/// never fall through to opaque byte forwarding.
pub fn translate_get(
    sm: &SlotMachine,
    from: SessionId,
    to: SessionId,
    inbound: &[u8],
) -> Result<Vec<u8>> {
    let p = GetPayload::decode(inbound)?;
    let out = GetPayload {
        target: translate_one(sm, from, to, &p.target)?,
        field_name: p.field_name,
        reply: translate_one(sm, from, to, &p.reply)?,
    };
    Ok(out.encode())
}

/// Translate an `index` payload (same mechanics as `get`, with a
/// numeric operand).
pub fn translate_index(
    sm: &SlotMachine,
    from: SessionId,
    to: SessionId,
    inbound: &[u8],
) -> Result<Vec<u8>> {
    let p = IndexPayload::decode(inbound)?;
    let out = IndexPayload {
        target: translate_one(sm, from, to, &p.target)?,
        index: p.index,
        reply: translate_one(sm, from, to, &p.reply)?,
    };
    Ok(out.encode())
}

/// Translate an `untag` payload (same mechanics as `get`, with a tag
/// operand).
pub fn translate_untag(
    sm: &SlotMachine,
    from: SessionId,
    to: SessionId,
    inbound: &[u8],
) -> Result<Vec<u8>> {
    let p = UntagPayload::decode(inbound)?;
    let out = UntagPayload {
        target: translate_one(sm, from, to, &p.target)?,
        tag: p.tag,
        reply: translate_one(sm, from, to, &p.reply)?,
    };
    Ok(out.encode())
}

/// Absorb a `drop` payload: the sender is decrementing pillars on
/// krefs it holds.  No outbound payload; side effects land in the
/// [`SlotMachine`].
pub fn absorb_drop(sm: &SlotMachine, from: SessionId, inbound: &[u8]) -> Result<()> {
    let p = DropPayload::decode(inbound)?;
    for DropDelta { target, ram, clist, export } in p.deltas {
        let vref = target.to_vref();
        // Look up the kref without allocating.  If the sender is
        // dropping a vref it never registered, we silently ignore
        // the entry — strict mode could return an error here.
        let kref = match sm
            .kref_for_session_vref(from, &vref)
        {
            Some(k) => k,
            None => continue,
        };
        if ram > 0 {
            sm.drop_ram(from, kref, ram)?;
        }
        if clist > 0 || export > 0 {
            sm.drop_clist(from, kref, export)?;
            // drop_clist decrements CList by 1 internally; extra
            // CList deltas (rare) would need a dedicated API.
            let _ = clist;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::SessionId;
    use crate::wire::descriptor::{Direction, Kind};

    fn open_two(sm: &SlotMachine) -> (SessionId, SessionId) {
        let a = SessionId::from_label("a");
        let b = SessionId::from_label("b");
        sm.open_session(a, "a").unwrap();
        sm.open_session(b, "b").unwrap();
        (a, b)
    }

    #[test]
    fn deliver_translates_target_through_kref() {
        let sm = SlotMachine::new();
        let (a, b) = open_two(&sm);
        let inbound = DeliverPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 7),
            body: b"args".to_vec(),
            targets: vec![],
            promises: vec![],
            reply: None,
        }
        .encode();
        let outbound_bytes = translate_deliver(&sm, a, b, &inbound).unwrap();
        let outbound = DeliverPayload::decode(&outbound_bytes).unwrap();
        // In B's frame, the target was allocated by the daemon (us),
        // so from B's perspective it's Local (B's local export —
        // meaning "I, B, have a local slot for this").
        assert_eq!(outbound.target.direction, Direction::Local);
        assert_eq!(outbound.target.kind, Kind::Object);
        assert!(outbound.body == b"args");
    }

    #[test]
    fn deliver_body_passes_through_unchanged() {
        let sm = SlotMachine::new();
        let (a, b) = open_two(&sm);
        let body: Vec<u8> = (0..250).map(|n| (n % 256) as u8).collect();
        let inbound = DeliverPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 1),
            body: body.clone(),
            targets: vec![Descriptor::new(Direction::Local, Kind::Object, 1)],
            promises: vec![],
            reply: None,
        }
        .encode();
        let outbound_bytes = translate_deliver(&sm, a, b, &inbound).unwrap();
        let outbound = DeliverPayload::decode(&outbound_bytes).unwrap();
        assert_eq!(outbound.body, body);
    }

    #[test]
    fn resolve_translates() {
        let sm = SlotMachine::new();
        let (a, b) = open_two(&sm);
        let inbound = ResolvePayload {
            target: Descriptor::new(Direction::Local, Kind::Promise, 3),
            is_reject: false,
            body: b"result".to_vec(),
            targets: vec![Descriptor::new(Direction::Local, Kind::Object, 5)],
            promises: vec![],
        }
        .encode();
        let outbound_bytes = translate_resolve(&sm, a, b, &inbound).unwrap();
        let outbound = ResolvePayload::decode(&outbound_bytes).unwrap();
        assert_eq!(outbound.is_reject, false);
        assert_eq!(outbound.body, b"result");
        assert_eq!(outbound.targets.len(), 1);
    }

    #[test]
    fn get_translates_target_and_reply() {
        let sm = SlotMachine::new();
        let (a, b) = open_two(&sm);
        let inbound = GetPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 7),
            field_name: "field".into(),
            reply: Descriptor::new(Direction::Local, Kind::Promise, 3),
        }
        .encode();
        let outbound_bytes = translate_get(&sm, a, b, &inbound).unwrap();
        let outbound = GetPayload::decode(&outbound_bytes).unwrap();
        assert_eq!(outbound.field_name, "field");
        assert_eq!(outbound.target.kind, Kind::Object);
        assert_eq!(outbound.reply.kind, Kind::Promise);
    }

    #[test]
    fn index_and_untag_translate() {
        let sm = SlotMachine::new();
        let (a, b) = open_two(&sm);
        let index_in = IndexPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 2),
            index: 9,
            reply: Descriptor::new(Direction::Local, Kind::Promise, 4),
        }
        .encode();
        let index_out = IndexPayload::decode(&translate_index(&sm, a, b, &index_in).unwrap())
            .unwrap();
        assert_eq!(index_out.index, 9);
        assert_eq!(index_out.reply.kind, Kind::Promise);

        let untag_in = UntagPayload {
            target: Descriptor::new(Direction::Local, Kind::Object, 5),
            tag: "example".into(),
            reply: Descriptor::new(Direction::Local, Kind::Promise, 6),
        }
        .encode();
        let untag_out = UntagPayload::decode(&translate_untag(&sm, a, b, &untag_in).unwrap())
            .unwrap();
        assert_eq!(untag_out.tag, "example");
    }

    #[test]
    fn translate_get_rejects_malformed() {
        // Fail-closed: a malformed data-lane payload is an error, never
        // opaque pass-through.
        let sm = SlotMachine::new();
        let (a, b) = open_two(&sm);
        let bogus = vec![0x83, 0x00, 0x00, 0x00];
        assert!(translate_get(&sm, a, b, &bogus).is_err());
    }

    #[test]
    fn absorb_drop_decrements() {
        let sm = SlotMachine::new();
        let (a, _b) = open_two(&sm);
        // Register a kref in session A.
        let v = crate::vref::Vref::object_local(1);
        let kref = sm.receive(a, &v).unwrap();
        let payload = DropPayload {
            deltas: vec![DropDelta {
                target: Descriptor::from_vref(&v),
                ram: 1,
                clist: 0,
                export: 0,
            }],
        }
        .encode();
        absorb_drop(&sm, a, &payload).unwrap();
        // Ram pillar should now be 0, putting the kref on possibly-dead.
        let dead = sm.drain_possibly_dead();
        assert!(dead.contains(&kref));
    }
}
