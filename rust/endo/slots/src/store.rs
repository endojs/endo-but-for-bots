//! SQLite-backed durable store for slot-machine state.
//!
//! The schema is a straightforward 1:1 capture of [`SlotMachine`]'s
//! mutable state.  All writes happen inside a single transaction at
//! [`SlotStore::checkpoint`] time so the daemon's durability barrier
//! is atomic: either every c-list row survives a crash, or none do.
//!
//! Schema (see `SCHEMA_SQL` for the authoritative SQL):
//!
//! ```text
//! meta                (key TEXT PRIMARY KEY, value BLOB)
//! krefs               (kref INTEGER PK, kind INT, formula_id TEXT NULL, owner BLOB NULL)
//! refcounts           (kref INTEGER, pillar INT, count INTEGER, PK(kref, pillar))
//! sessions            (session_id BLOB PK, label TEXT, next_object/promise/answer/device INT)
//! clist               (session_id BLOB, vref TEXT, kref INT, PK(session_id, vref))
//! promises            (kref INTEGER PK, decider BLOB NULL, state INT, blob BLOB NULL)
//! ```

use std::path::Path;

use rusqlite::{params, Connection, OpenFlags};

use crate::error::{Result, SlotError};
use crate::kref::Kref;
use crate::promise::{PromiseResolution, PromiseState};
use crate::refcount::{Pillar, RefCounts};
use crate::session::{NextCounters, SessionId};
use crate::table::{KrefEntry, KrefKind, SlotMachine, StoreSnapshot};

const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value BLOB
);
CREATE TABLE IF NOT EXISTS krefs (
    kref INTEGER PRIMARY KEY,
    kind INTEGER NOT NULL,
    formula_id TEXT,
    owner BLOB
);
CREATE TABLE IF NOT EXISTS refcounts (
    kref INTEGER NOT NULL,
    pillar INTEGER NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (kref, pillar)
);
CREATE TABLE IF NOT EXISTS sessions (
    session_id BLOB PRIMARY KEY,
    label TEXT NOT NULL,
    next_object INTEGER NOT NULL DEFAULT 0,
    next_promise INTEGER NOT NULL DEFAULT 0,
    next_answer INTEGER NOT NULL DEFAULT 0,
    next_device INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clist (
    session_id BLOB NOT NULL,
    vref TEXT NOT NULL,
    kref INTEGER NOT NULL,
    PRIMARY KEY (session_id, vref),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS clist_by_kref ON clist(kref);
CREATE TABLE IF NOT EXISTS promises (
    kref INTEGER PRIMARY KEY,
    decider BLOB,
    state INTEGER NOT NULL,
    blob BLOB
);
"#;

fn kind_code(k: KrefKind) -> i64 {
    match k {
        KrefKind::Object => 0,
        KrefKind::Promise => 1,
        KrefKind::Answer => 2,
        KrefKind::Device => 3,
    }
}

fn kind_from_code(c: i64) -> Result<KrefKind> {
    match c {
        0 => Ok(KrefKind::Object),
        1 => Ok(KrefKind::Promise),
        2 => Ok(KrefKind::Answer),
        3 => Ok(KrefKind::Device),
        _ => Err(SlotError::Invariant(format!("unknown kind code {c}"))),
    }
}

fn resolution_code(r: &PromiseResolution) -> i64 {
    match r {
        PromiseResolution::Pending => 0,
        PromiseResolution::Fulfilled(_) => 1,
        PromiseResolution::Rejected(_) => 2,
    }
}

fn resolution_from(code: i64, blob: Option<Vec<u8>>) -> Result<PromiseResolution> {
    match code {
        0 => Ok(PromiseResolution::Pending),
        1 => Ok(PromiseResolution::Fulfilled(blob.unwrap_or_default())),
        2 => Ok(PromiseResolution::Rejected(blob.unwrap_or_default())),
        _ => Err(SlotError::Invariant(format!("unknown resolution code {code}"))),
    }
}

pub struct SlotStore {
    conn: Connection,
}

impl SlotStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA_SQL)?;
        Ok(SlotStore { conn })
    }

    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(SCHEMA_SQL)?;
        Ok(SlotStore { conn })
    }

    /// Read the kref allocator's next value from `meta` or return 1.
    fn read_next_kref(&self) -> Result<u64> {
        let mut stmt = self
            .conn
            .prepare("SELECT value FROM meta WHERE key = 'next_kref'")?;
        let mut rows = stmt.query([])?;
        if let Some(row) = rows.next()? {
            let v: Vec<u8> = row.get(0)?;
            if v.len() == 8 {
                let mut b = [0u8; 8];
                b.copy_from_slice(&v);
                return Ok(u64::from_le_bytes(b));
            }
        }
        Ok(1)
    }

    /// Commit the full slot-machine state in one transaction.
    pub fn checkpoint(&mut self, machine: &SlotMachine) -> Result<()> {
        let snap = machine.snapshot_for_store();
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM clist", [])?;
        tx.execute("DELETE FROM sessions", [])?;
        tx.execute("DELETE FROM refcounts", [])?;
        tx.execute("DELETE FROM krefs", [])?;
        tx.execute("DELETE FROM promises", [])?;
        tx.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('next_kref', ?1)",
            params![&snap.allocator_next.to_le_bytes()[..]],
        )?;
        for (entry, counts) in &snap.krefs {
            tx.execute(
                "INSERT INTO krefs (kref, kind, formula_id, owner) VALUES (?1, ?2, ?3, ?4)",
                params![
                    entry.kref.0 as i64,
                    kind_code(entry.kind),
                    entry.formula_id.as_deref(),
                    entry.owner.map(|s| s.0.to_vec())
                ],
            )?;
            for pillar in [Pillar::Ram, Pillar::CList, Pillar::Export] {
                let c = counts.get(pillar);
                if c > 0 {
                    tx.execute(
                        "INSERT INTO refcounts (kref, pillar, count) VALUES (?1, ?2, ?3)",
                        params![entry.kref.0 as i64, pillar.code() as i64, c as i64],
                    )?;
                }
            }
        }
        for (id, label, counters, entries) in &snap.sessions {
            tx.execute(
                "INSERT INTO sessions (session_id, label, next_object, next_promise, next_answer, next_device)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    &id.0[..],
                    label,
                    counters.object as i64,
                    counters.promise as i64,
                    counters.answer as i64,
                    counters.device as i64,
                ],
            )?;
            for (vref, k) in entries {
                tx.execute(
                    "INSERT INTO clist (session_id, vref, kref) VALUES (?1, ?2, ?3)",
                    params![&id.0[..], vref, k.0 as i64],
                )?;
            }
        }
        for (k, s) in &snap.promises {
            let (code, blob) = match &s.resolution {
                PromiseResolution::Pending => (0, None),
                PromiseResolution::Fulfilled(b) => (1, Some(b.clone())),
                PromiseResolution::Rejected(b) => (2, Some(b.clone())),
            };
            let _ = resolution_code(&s.resolution);
            tx.execute(
                "INSERT INTO promises (kref, decider, state, blob) VALUES (?1, ?2, ?3, ?4)",
                params![k.0 as i64, s.decider.map(|x| x.0.to_vec()), code, blob],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Load state from SQLite into a fresh [`SlotMachine`].
    pub fn restore(&self) -> Result<SlotMachine> {
        let next = self.read_next_kref()?;
        let mut krefs: Vec<(KrefEntry, RefCounts)> = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT kref, kind, formula_id, owner FROM krefs ORDER BY kref",
            )?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let kref_i: i64 = row.get(0)?;
                let kind_i: i64 = row.get(1)?;
                let formula_id: Option<String> = row.get(2)?;
                let owner_blob: Option<Vec<u8>> = row.get(3)?;
                let owner = owner_blob.and_then(|v| {
                    if v.len() == 32 {
                        let mut b = [0u8; 32];
                        b.copy_from_slice(&v);
                        Some(SessionId(b))
                    } else {
                        None
                    }
                });
                let entry = KrefEntry {
                    kref: Kref(kref_i as u64),
                    kind: kind_from_code(kind_i)?,
                    formula_id,
                    owner,
                };
                krefs.push((entry, RefCounts::default()));
            }
        }
        // Fill refcounts.
        {
            let mut stmt = self
                .conn
                .prepare("SELECT kref, pillar, count FROM refcounts")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let kref_i: i64 = row.get(0)?;
                let pillar_i: i64 = row.get(1)?;
                let count_i: i64 = row.get(2)?;
                if let Some(pillar) = Pillar::from_code(pillar_i as u8) {
                    for (entry, counts) in krefs.iter_mut() {
                        if entry.kref.0 as i64 == kref_i {
                            counts.set(pillar, count_i as u64);
                            break;
                        }
                    }
                }
            }
        }
        // Sessions + c-lists.
        let mut sessions: Vec<(SessionId, String, NextCounters, Vec<(String, Kref)>)> = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT session_id, label, next_object, next_promise, next_answer, next_device FROM sessions",
            )?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let id_blob: Vec<u8> = row.get(0)?;
                if id_blob.len() != 32 {
                    return Err(SlotError::Invariant("session_id length != 32".into()));
                }
                let mut id_bytes = [0u8; 32];
                id_bytes.copy_from_slice(&id_blob);
                let id = SessionId(id_bytes);
                let label: String = row.get(1)?;
                let counters = NextCounters {
                    object: row.get::<_, i64>(2)? as u64,
                    promise: row.get::<_, i64>(3)? as u64,
                    answer: row.get::<_, i64>(4)? as u64,
                    device: row.get::<_, i64>(5)? as u64,
                };
                sessions.push((id, label, counters, Vec::new()));
            }
        }
        {
            let mut stmt = self
                .conn
                .prepare("SELECT session_id, vref, kref FROM clist")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let id_blob: Vec<u8> = row.get(0)?;
                let vref: String = row.get(1)?;
                let kref_i: i64 = row.get(2)?;
                for (id, _, _, entries) in sessions.iter_mut() {
                    if id.0[..] == id_blob[..] {
                        entries.push((vref.clone(), Kref(kref_i as u64)));
                        break;
                    }
                }
            }
        }
        let mut promises: Vec<(Kref, PromiseState)> = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT kref, decider, state, blob FROM promises")?;
            let mut rows = stmt.query([])?;
            while let Some(row) = rows.next()? {
                let kref_i: i64 = row.get(0)?;
                let decider_blob: Option<Vec<u8>> = row.get(1)?;
                let state_i: i64 = row.get(2)?;
                let blob: Option<Vec<u8>> = row.get(3)?;
                let decider = decider_blob.and_then(|v| {
                    if v.len() == 32 {
                        let mut b = [0u8; 32];
                        b.copy_from_slice(&v);
                        Some(SessionId(b))
                    } else {
                        None
                    }
                });
                let state = PromiseState {
                    decider,
                    resolution: resolution_from(state_i, blob)?,
                };
                promises.push((Kref(kref_i as u64), state));
            }
        }
        let snap = StoreSnapshot {
            allocator_next: next,
            krefs,
            sessions,
            promises,
        };
        let machine = SlotMachine::new();
        machine.install_snapshot(snap);
        Ok(machine)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::KrefKind;
    use crate::vref::Vref;

    #[test]
    fn roundtrip_empty() {
        let mut store = SlotStore::in_memory().unwrap();
        let m = SlotMachine::new();
        store.checkpoint(&m).unwrap();
        let restored = store.restore().unwrap();
        assert_eq!(restored.sessions_holding(Kref(1)), Vec::<SessionId>::new());
    }

    #[test]
    fn roundtrip_with_sessions() {
        let mut store = SlotStore::in_memory().unwrap();
        let m = SlotMachine::new();
        let a = SessionId::from_label("a");
        let b = SessionId::from_label("b");
        m.open_session(a, "a").unwrap();
        m.open_session(b, "b").unwrap();
        let v = Vref::object_local(1);
        let k = m.receive(a, &v).unwrap();
        let out = m.send(b, k).unwrap();
        store.checkpoint(&m).unwrap();

        let restored = store.restore().unwrap();
        assert_eq!(restored.kref_entry(k).unwrap().kind, KrefKind::Object);
        let mut holders = restored.sessions_holding(k);
        holders.sort();
        let mut expect = vec![a, b];
        expect.sort();
        assert_eq!(holders, expect);
        // Counters preserved: allocating another local in B must not
        // collide with the existing export.
        let next = restored.send(b, k).unwrap();
        assert_eq!(next.vref, out.vref);
        assert!(!next.newly_exported);
    }

    #[test]
    fn roundtrip_formula_binding() {
        let mut store = SlotStore::in_memory().unwrap();
        let m = SlotMachine::new();
        let k = m.intern_formula("abc:def", KrefKind::Object);
        store.checkpoint(&m).unwrap();
        let restored = store.restore().unwrap();
        let entry = restored.kref_entry(k).unwrap();
        assert_eq!(entry.formula_id.as_deref(), Some("abc:def"));
    }
}
