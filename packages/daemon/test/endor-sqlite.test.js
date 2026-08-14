// @ts-nocheck

// Tests for the better-sqlite3-compatible XsDatabase shim.
//
// `endor-sqlite.js` runs against the Rust supervisor's host
// SQLite functions when bundled into the XS daemon.  In Node we
// stub those host functions over a real `better-sqlite3` handle
// and exercise the shim's higher-level surface — pragma, prepare
// / run / get / all, exec, transaction (with throw -> ROLLBACK) —
// against the live engine.

// eslint-disable-next-line import/order
import '@endo/init/debug.js';

import test from 'ava';
import Database from 'better-sqlite3';

const STMT_REGISTRY = new Map();
const DB_REGISTRY = new Map();
let nextHandle = 1;

const installHostStubs = () => {
  globalThis.hostSqliteOpen = path => {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    const handle = nextHandle;
    nextHandle += 1;
    DB_REGISTRY.set(handle, db);
    return handle;
  };
  globalThis.hostSqliteClose = handle => {
    const db = DB_REGISTRY.get(handle);
    if (db) {
      db.close();
      DB_REGISTRY.delete(handle);
    }
  };
  globalThis.hostSqliteExec = (handle, sql) => {
    try {
      DB_REGISTRY.get(handle).exec(sql);
    } catch (e) {
      return `Error: ${e.message}`;
    }
    return undefined;
  };
  globalThis.hostSqlitePrepare = (handle, sql) => {
    try {
      const stmt = DB_REGISTRY.get(handle).prepare(sql);
      const stmtHandle = nextHandle;
      nextHandle += 1;
      STMT_REGISTRY.set(stmtHandle, stmt);
      return stmtHandle;
    } catch (e) {
      return `Error: ${e.message}`;
    }
  };
  // Params arrive as a JSON string from the shim.  Decode the same
  // tag protocol the Rust side uses (objects with $bigint / $bytes
  // are pre-encoded; positional / named arrays / objects fan out).
  const parseParams = paramsJson => {
    const params = JSON.parse(paramsJson);
    if (Array.isArray(params)) {
      return { positional: params };
    }
    return { named: params };
  };
  const bindArgs = (stmt, paramsJson) => {
    if (paramsJson === '[]' || paramsJson === '{}') return [];
    const { positional, named } = parseParams(paramsJson);
    return positional || [named];
  };
  globalThis.hostSqliteStmtRun = (stmtHandle, paramsJson) => {
    try {
      const stmt = STMT_REGISTRY.get(stmtHandle);
      const args = bindArgs(stmt, paramsJson);
      const info = stmt.run(...args);
      return JSON.stringify({
        changes: info.changes,
        last_insert_row_id: Number(info.lastInsertRowid),
      });
    } catch (e) {
      return `Error: ${e.message}`;
    }
  };
  globalThis.hostSqliteStmtGet = (stmtHandle, paramsJson) => {
    try {
      const stmt = STMT_REGISTRY.get(stmtHandle);
      const args = bindArgs(stmt, paramsJson);
      const row = stmt.get(...args);
      return JSON.stringify(row === undefined ? null : row);
    } catch (e) {
      return `Error: ${e.message}`;
    }
  };
  globalThis.hostSqliteStmtAll = (stmtHandle, paramsJson) => {
    try {
      const stmt = STMT_REGISTRY.get(stmtHandle);
      const args = bindArgs(stmt, paramsJson);
      const rows = stmt.all(...args);
      return JSON.stringify(rows);
    } catch (e) {
      return `Error: ${e.message}`;
    }
  };
  globalThis.hostSqliteStmtFinalize = stmtHandle => {
    STMT_REGISTRY.delete(stmtHandle);
  };
};

installHostStubs();

// Import after the host stubs are installed so module-init time
// host references (none here, but defensive) see them.
const { default: XsDatabase } = await import('../src/endor-sqlite.js');

const setUp = () => {
  const db = new XsDatabase(':memory:');
  db.exec(`
    CREATE TABLE pet (
      store_number TEXT NOT NULL,
      store_type TEXT NOT NULL,
      name TEXT NOT NULL,
      formula_id TEXT NOT NULL,
      PRIMARY KEY (store_number, store_type, name)
    );
  `);
  return db;
};

test('prepare/run/get/all round-trip through the shim', t => {
  const db = setUp();
  const ins = db.prepare(
    'INSERT INTO pet (store_number, store_type, name, formula_id) VALUES (?, ?, ?, ?)',
  );
  ins.run('store-1', 'pet', 'alice', 'id-alice');
  ins.run('store-1', 'pet', 'bob', 'id-bob');

  const one = db.prepare(
    'SELECT formula_id FROM pet WHERE store_number = ? AND store_type = ? AND name = ?',
  );
  t.is(one.get('store-1', 'pet', 'alice').formula_id, 'id-alice');
  t.is(one.get('store-1', 'pet', 'missing'), undefined);

  const list = db.prepare(
    'SELECT name, formula_id FROM pet WHERE store_number = ? AND store_type = ? ORDER BY name',
  );
  t.deepEqual(list.all('store-1', 'pet'), [
    { name: 'alice', formula_id: 'id-alice' },
    { name: 'bob', formula_id: 'id-bob' },
  ]);

  db.close();
});

test('transaction commits on normal return', t => {
  const db = setUp();
  const ins = db.prepare('INSERT INTO pet VALUES (?, ?, ?, ?)');
  const tx = db.transaction(entries => {
    for (const [sn, st, n, fid] of entries) ins.run(sn, st, n, fid);
  });
  tx([
    ['store-1', 'pet', 'alice', 'id-alice'],
    ['store-1', 'pet', 'bob', 'id-bob'],
  ]);
  const count = db.prepare('SELECT COUNT(*) AS c FROM pet').get().c;
  t.is(count, 2);
  db.close();
});

test('transaction rolls back on throw', t => {
  const db = setUp();
  const ins = db.prepare('INSERT INTO pet VALUES (?, ?, ?, ?)');
  const tx = db.transaction(() => {
    ins.run('store-1', 'pet', 'alice', 'id-alice');
    throw new Error('boom');
  });
  t.throws(() => tx(), { message: 'boom' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM pet').get().c;
  t.is(count, 0, 'rolled back');
  db.close();
});

test('nested transaction uses SAVEPOINT and rolls back inner only', t => {
  const db = setUp();
  const ins = db.prepare('INSERT INTO pet VALUES (?, ?, ?, ?)');
  const inner = db.transaction(() => {
    ins.run('store-1', 'pet', 'inner', 'id-inner');
    throw new Error('nested-boom');
  });
  const outer = db.transaction(() => {
    ins.run('store-1', 'pet', 'outer', 'id-outer');
    try {
      inner();
    } catch (_) {
      // swallow inside outer transaction
    }
  });
  outer();
  const rows = db
    .prepare('SELECT name FROM pet ORDER BY name')
    .all()
    .map(r => r.name);
  t.deepEqual(rows, ['outer'], 'inner SAVEPOINT rolled back; outer committed');
  db.close();
});

test('transaction modes are independently callable', t => {
  const db = setUp();
  const ins = db.prepare('INSERT INTO pet VALUES (?, ?, ?, ?)');
  const tx = db.transaction(name => {
    ins.run('store-1', 'pet', name, `id-${name}`);
  });
  // All three mode-suffix variants exist and run.
  tx.deferred('one');
  tx.immediate('two');
  tx.exclusive('three');
  const rows = db
    .prepare('SELECT name FROM pet ORDER BY name')
    .all()
    .map(r => r.name);
  t.deepEqual(rows, ['one', 'three', 'two']);
  db.close();
});
