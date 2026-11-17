// @ts-check
/**
 * The hub's write-ahead log store (`src/store/hub-log-store.js`, harness core
 * candidate C-2): one append per commit of what changed, an image it
 * compacts into, recovery as image plus log replay with the torn-tail rule,
 * and migration from the whole-file `hub.json`.
 *
 * The store is driven over an in-memory file system with faults: every
 * prefix of a log, a torn or failed operation at every point, an
 * interrupted compaction and an interrupted migration. The SIGKILL tests
 * with the real file system and real traffic are in
 * `hub-crash-consistency.test.js`.
 */
import test from '@endo/ses-ava/test.js';

import { restoreHubState } from '../src/net/hub-state.js';
import { makeHubLogStore } from '../src/store/hub-log-store.js';
import { makeMemorySyncFiles } from './_memory-sync-files.js';

const paths = {
  imagePath: '/s/hub-image.json',
  logPath: '/s/hub-log.jsonl',
  legacyPath: '/s/hub.json',
};

/** A small deterministic generator (Park-Miller). */
const makeRandom = (seed = 7) => {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
};

/**
 * A sequence of hub-shaped states: rows added, changed and removed, a row
 * removed and added again (it moves to the end, as in a Map), a table that
 * goes away and comes back, and commits that change nothing.
 * @param {number} count
 */
const makeStates = (count, seed = 7) => {
  const random = makeRandom(seed);
  /** @type {Array<any>} */
  const states = [];
  /** @type {any} */
  let state = {
    version: 2,
    refs: {},
    sessions: {},
    publications: {},
    gifts: {},
    giftWaiters: {},
  };
  for (let i = 0; i < count; i += 1) {
    state = JSON.parse(JSON.stringify(state));
    const changes = Math.floor(random() * 4);
    for (let j = 0; j < changes; j += 1) {
      const key = `w#0:${Math.floor(random() * 20)}`;
      if (random() < 0.3) delete state.refs[key];
      else state.refs[key] = { epoch: 0, position: String(i), listeners: [j] };
    }
    if (random() < 0.3) {
      const key = `s${Math.floor(random() * 5)}`;
      state.sessions[key] = {
        queue: ['00'.repeat(i)],
        ourExports: { [String(i)]: 'x', 2: 'y' },
      };
    }
    if (random() < 0.1) {
      const [key] = Object.keys(state.sessions);
      if (key !== undefined) {
        const session = state.sessions[key];
        delete state.sessions[key];
        state.sessions[key] = session;
      }
    }
    if (random() < 0.05) delete state.gifts;
    else if (!state.gifts) state.gifts = {};
    states.push(state);
  }
  return states;
};

/** @param {any} value */
const text = value => JSON.stringify(value);

test('every commit reads back with its entry order, and so does a reopened store', t => {
  const { syncFiles, operations } = makeMemorySyncFiles();
  const store = makeHubLogStore(syncFiles, paths, {
    compactChars: 2000,
    compactRatio: 0,
  });
  t.is(store.getState(), undefined, 'a fresh directory has no state');
  for (const state of makeStates(80)) {
    store.setState(state);
    t.is(text(store.getState()), text(state));
    t.is(
      text(makeHubLogStore(syncFiles, paths).getState()),
      text(state),
      'reopened',
    );
  }
  const stats = store.stats();
  t.true(Number(stats.appends) > 40, 'most commits are appends');
  t.true(Number(stats.compactions) > 1, 'the log compacted');
  t.true(Number(stats.unchanged) > 0, 'a commit with no change writes nothing');
  t.true(Number(stats.replacedTables) > 0, 'a moved row replaced its table');
  t.true(
    operations.every(op => op.op === 'append' || op.op === 'replace'),
    'only appends and atomic replacements',
  );
});

test('recovery from every prefix of the log, a torn final record included', t => {
  const states = makeStates(40, 11);
  const { syncFiles, files } = makeMemorySyncFiles();
  const store = makeHubLogStore(syncFiles, paths, {
    compactChars: 1500,
    compactRatio: 0,
  });
  /** @type {Map<number, any>} */
  const bySeq = new Map();
  /** @type {Array<{ image: string, log: string }>} */
  const snapshots = [];
  for (const state of states) {
    store.setState(state);
    bySeq.set(/** @type {any} */ (store.stats()).seq, state);
    snapshots.push({
      image: /** @type {string} */ (files.get(paths.imagePath)),
      log: /** @type {string} */ (files.get(paths.logPath)),
    });
  }
  let prefixes = 0;
  let torn = 0;
  for (const { image, log } of snapshots) {
    const headerEnd = log.indexOf('\n') + 1;
    // The header is written atomically with the image: only cuts after it.
    for (let cut = headerEnd; cut <= log.length; cut += 1) {
      const prefix = log.slice(0, cut);
      const memory = makeMemorySyncFiles();
      memory.files.set(paths.imagePath, image);
      memory.files.set(paths.logPath, prefix);
      const reopened = makeHubLogStore(memory.syncFiles, paths);
      const complete = prefix.slice(0, prefix.lastIndexOf('\n') + 1);
      const records = complete.split('\n').filter(Boolean).slice(1);
      const last =
        records.length > 0
          ? JSON.parse(/** @type {string} */ (records.at(-1))).seq
          : JSON.parse(image).through;
      t.is(
        text(reopened.getState()),
        text(bySeq.get(last)),
        `cut at ${cut} of ${log.length} recovers commit ${last}`,
      );
      if (complete.length < prefix.length) torn += 1;
      // A commit after recovery never joins the torn bytes.
      const next = states[(last * 7) % states.length];
      reopened.setState(next);
      t.is(
        text(makeHubLogStore(memory.syncFiles, paths).getState()),
        text(next),
      );
      prefixes += 1;
    }
  }
  t.log(`${prefixes} prefixes, ${torn} with a torn final record`);
  t.true(torn > 100);
});

test('a failed or torn write at every point leaves a committed state, and the next commit repairs', t => {
  const states = makeStates(24, 5);
  const total = (() => {
    const { syncFiles, operations } = makeMemorySyncFiles();
    const store = makeHubLogStore(syncFiles, paths, {
      compactChars: 800,
      compactRatio: 0,
    });
    for (const state of states) store.setState(state);
    return operations.length;
  })();
  for (let at = 1; at <= total; at += 1) {
    let count = 0;
    const { syncFiles } = makeMemorySyncFiles({
      fault: (op, _path, written) => {
        count += 1;
        if (count !== at) return undefined;
        return op === 'append' ? Math.floor(written.length / 2) : 'throw';
      },
    });
    const store = makeHubLogStore(syncFiles, paths, {
      compactChars: 800,
      compactRatio: 0,
    });
    /** @type {any} */
    let committed;
    let failed = 0;
    for (const state of states) {
      try {
        store.setState(state);
        committed = state;
      } catch (error) {
        failed += 1;
        t.regex(/** @type {Error} */ (error).message, /injected/);
      }
      // What a crash now would recover: the last commit that returned, or
      // the one that failed (its bytes may all have reached the disk).
      const recovered = text(makeHubLogStore(syncFiles, paths).getState());
      t.true(
        recovered === text(committed) || recovered === text(state),
        `fault at operation ${at}`,
      );
    }
    t.is(failed, 1);
    // The hub retries with its next persist.
    store.setState(states.at(-1));
    t.is(
      text(makeHubLogStore(syncFiles, paths).getState()),
      text(states.at(-1)),
      `fault at operation ${at}: the retry commits`,
    );
  }
});

test('a compaction interrupted after its image skips the records the image holds', t => {
  const states = makeStates(30, 3);
  let compactions = 0;
  let stop = false;
  const { syncFiles, files } = makeMemorySyncFiles({
    fault: (op, path) => {
      if (op !== 'replace') return undefined;
      if (path === paths.imagePath) compactions += 1;
      // The crash: the second compaction's image is written, its log reset
      // is not.
      if (path === paths.logPath && compactions === 2) {
        stop = true;
        return 'throw';
      }
      return undefined;
    },
  });
  const store = makeHubLogStore(syncFiles, paths, {
    compactChars: 1000,
    compactRatio: 0,
  });
  /** @type {any} */
  let last;
  for (const state of states) {
    last = state;
    try {
      store.setState(state);
    } catch {
      break;
    }
  }
  t.true(stop, 'the compaction was interrupted');
  const image = JSON.parse(/** @type {string} */ (files.get(paths.imagePath)));
  const stale = /** @type {string} */ (files.get(paths.logPath))
    .split('\n')
    .filter(Boolean)
    .slice(1)
    .map(line => Number(JSON.parse(line).seq));
  t.true(stale.length > 0 && stale.every(seq => seq < Number(image.through)));
  const reopened = makeHubLogStore(syncFiles, paths);
  t.is(text(reopened.getState()), text(last), 'the image holds the commit');
  t.is(/** @type {any} */ (reopened.stats()).skippedRecords, stale.length);
  const next = states[0];
  reopened.setState(next);
  t.is(
    files.get(paths.logPath),
    '{"format":"thixotrope-hub-log","version":1}\n',
    'the next commit compacts the stale records away',
  );
  t.is(text(makeHubLogStore(syncFiles, paths).getState()), text(next));
});

test('a whole-file hub.json migrates, and an older reader refuses the marker it leaves', t => {
  const [first, second] = makeStates(2, 9);
  const { syncFiles, files } = makeMemorySyncFiles();
  files.set(paths.legacyPath, `${text(first)}\n`);
  const store = makeHubLogStore(syncFiles, paths);
  t.is(text(store.getState()), text(first));
  t.is(/** @type {any} */ (store.stats()).migrated, 1);
  const marker = JSON.parse(
    /** @type {string} */ (files.get(paths.legacyPath)),
  );
  t.is(marker.version, 'hub-log');
  // What a build without the log store does with the hub.json it finds.
  t.throws(
    () =>
      restoreHubState(marker, {
        refs: new Map(),
        provideSessionState: () => ({}),
        publications: new Map(),
        gifts: new Map(),
        giftWaiters: new Map(),
      }),
    { message: /Incompatible hub state/ },
  );
  store.setState(second);
  t.is(text(makeHubLogStore(syncFiles, paths).getState()), text(second));
});

test('a migration interrupted after its image finishes at the next open', t => {
  const [first] = makeStates(1, 13);
  let replaced = 0;
  const { syncFiles, files } = makeMemorySyncFiles({
    fault: (op, path) => {
      if (op === 'replace') replaced += 1;
      return path === paths.legacyPath && replaced <= 3 ? 'throw' : undefined;
    },
  });
  files.set(paths.legacyPath, `${text(first)}\n`);
  t.throws(() => makeHubLogStore(syncFiles, paths).getState(), {
    message: /injected/,
  });
  t.true(files.has(paths.imagePath), 'the image was written');
  t.deepEqual(
    JSON.parse(/** @type {string} */ (files.get(paths.legacyPath))),
    first,
    'hub.json still has the state it was made from',
  );
  const reopened = makeHubLogStore(syncFiles, paths);
  t.is(text(reopened.getState()), text(first), 'the image wins');
  t.is(
    JSON.parse(/** @type {string} */ (files.get(paths.legacyPath))).version,
    'hub-log',
    'the marker is written again',
  );
});

test('damage refuses to open rather than guess', t => {
  const states = makeStates(6, 17);
  const build = () => {
    const memory = makeMemorySyncFiles();
    const store = makeHubLogStore(memory.syncFiles, paths, {
      compactChars: 1_000_000,
    });
    for (const state of states) store.setState(state);
    return memory;
  };
  {
    const { syncFiles, files } = build();
    const lines = /** @type {string} */ (files.get(paths.logPath)).split('\n');
    lines[2] = lines[2].slice(0, -3);
    files.set(paths.logPath, lines.join('\n'));
    t.throws(() => makeHubLogStore(syncFiles, paths).getState(), {
      message: /record 2 is damaged/,
    });
  }
  {
    const { syncFiles, files } = build();
    const lines = /** @type {string} */ (files.get(paths.logPath)).split('\n');
    lines.splice(2, 1);
    files.set(paths.logPath, lines.join('\n'));
    t.throws(() => makeHubLogStore(syncFiles, paths).getState(), {
      message: /skips from commit/,
    });
  }
  {
    const { syncFiles, files } = build();
    files.delete(paths.imagePath);
    t.throws(() => makeHubLogStore(syncFiles, paths).getState(), {
      message: /has no image/,
    });
  }
  {
    const { syncFiles, files } = build();
    files.delete(paths.imagePath);
    files.delete(paths.logPath);
    files.set(paths.legacyPath, '{"version":"hub-log"}\n');
    t.throws(() => makeHubLogStore(syncFiles, paths).getState(), {
      message: /moved to the hub log/,
    });
  }
  {
    const { syncFiles, files } = build();
    files.set(
      paths.logPath,
      `{"format":"thixotrope-hub-log","version":2}\n${files.get(paths.logPath)}`,
    );
    t.throws(() => makeHubLogStore(syncFiles, paths).getState(), {
      message: /does not start with this build's header/,
    });
  }
});

test('a commit appends only the rows that changed', t => {
  const { syncFiles, operations } = makeMemorySyncFiles();
  const store = makeHubLogStore(syncFiles, paths);
  /** @type {any} */
  const state = { version: 2, refs: {}, sessions: {} };
  for (let i = 0; i < 500; i += 1)
    state.refs[`w#0:${i}`] = { position: String(i), pad: 'x'.repeat(100) };
  store.setState(state);
  const imageChars = /** @type {any} */ (store.stats()).imageChars;
  const next = JSON.parse(JSON.stringify(state));
  next.refs['w#0:7'].position = 'moved';
  delete next.refs['w#0:8'];
  next.refs['w#0:new'] = { position: 'new' };
  const written = store.setState(next);
  t.is(operations.at(-1)?.op, 'append');
  t.true(
    written < 400,
    `${written} characters for a ${imageChars}-character state`,
  );
  t.is(text(makeHubLogStore(syncFiles, paths).getState()), text(next));
});
