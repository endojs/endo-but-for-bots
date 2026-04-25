// @ts-nocheck
// Filesystem-based DaemonicPersistencePowers used by the XS bus
// daemon.  The llm-side interface grew SQLite-only methods
// (listFormulaNumbersByNode, writeAgentKey, retention tables);
// this module predates that migration and is known to not satisfy
// the full type.  Re-enable @ts-check once the XS daemon carries
// a SQLite-backed implementation.

/**
 * Pure-JS factory for DaemonicPersistencePowers.
 *
 * Extracted from daemon-node-powers.js so that the XS daemon bundle
 * can import it without pulling in Node.js-specific dependencies
 * (@endo/stream-node, node:fs, child_process).
 */

import harden from '@endo/harden';
import { q } from '@endo/errors';
import { makeSnapshotStore } from '@endo/platform/fs/lite';

import { makeReaderRef } from './reader-ref.js';
import { toHex, fromHex } from './hex.js';

/** @import { Config, CryptoPowers, DaemonicPersistencePowers, FilePowers, Formula, FormulaNumber } from './types.js' */

/**
 * @param {FilePowers} filePowers
 * @param {CryptoPowers} cryptoPowers
 * @param {Config} config
 * @returns {DaemonicPersistencePowers}
 */
export const makeDaemonicPersistencePowers = (
  filePowers,
  cryptoPowers,
  config,
) => {
  const initializePersistence = async () => {
    const { statePath, ephemeralStatePath, cachePath } = config;
    const statePathP = filePowers.makePath(statePath);
    const ephemeralStatePathP = filePowers.makePath(ephemeralStatePath);
    const cachePathP = filePowers.makePath(cachePath);
    await Promise.all([statePathP, cachePathP, ephemeralStatePathP]);
    // Load durable replacements for the SQLite-only tables.
    // eslint-disable-next-line no-use-before-define
    await loadDurableState();
  };

  /** @type {DaemonicPersistencePowers['provideRootNonce']} */
  const provideRootNonce = async () => {
    const noncePath = filePowers.joinPath(config.statePath, 'nonce');
    const existingNonce = await filePowers.maybeReadFileText(noncePath);
    if (existingNonce === undefined) {
      const rootNonce = /** @type {FormulaNumber} */ (
        await cryptoPowers.randomHex256()
      );
      await filePowers.writeFileText(noncePath, `${rootNonce}\n`);
      return { rootNonce, isNewlyCreated: true };
    } else {
      const rootNonce = /** @type {FormulaNumber} */ (existingNonce.trim());
      return { rootNonce, isNewlyCreated: false };
    }
  };

  /** @type {DaemonicPersistencePowers['provideRootKeypair']} */
  const provideRootKeypair = async () => {
    const keypairPath = filePowers.joinPath(config.statePath, 'keypair');
    const existingKeypair = await filePowers.maybeReadFileText(keypairPath);
    if (existingKeypair === undefined) {
      const keypair = await cryptoPowers.generateEd25519Keypair();
      const publicHex = toHex(keypair.publicKey);
      const privateHex = toHex(keypair.privateKey);
      await filePowers.writeFileText(
        keypairPath,
        `${publicHex}\n${privateHex}\n`,
      );
      return { keypair, isNewlyCreated: true };
    } else {
      const lines = existingKeypair.trim().split('\n');
      const pubHex = lines[0];
      const privHex = lines[1];
      // Use getters to avoid storing Uint8Array directly on the
      // hardened object — in XS, Uint8Array indexed elements are
      // non-configurable so harden/freeze fails.
      return {
        keypair: harden({
          get publicKey() {
            return fromHex(pubHex);
          },
          get privateKey() {
            return fromHex(privHex);
          },
          sign: message => cryptoPowers.ed25519Sign(fromHex(privHex), message),
        }),
        isNewlyCreated: false,
      };
    }
  };

  const makeContentStore = () => {
    const { statePath } = config;
    const storageDirectoryPath = filePowers.joinPath(statePath, 'store-sha256');

    /** @type {import('@endo/platform/fs/lite/types').ContentStore} */
    const rawStore = harden({
      /**
       * @param {AsyncIterable<Uint8Array>} readable
       * @returns {Promise<string>}
       */
      async store(readable) {
        const digester = cryptoPowers.makeSha256();
        const storageId256 = await cryptoPowers.randomHex256();
        const temporaryStoragePath = filePowers.joinPath(
          storageDirectoryPath,
          storageId256,
        );

        // Stream to temporary file and calculate hash.
        await filePowers.makePath(storageDirectoryPath);
        const fileWriter = filePowers.makeFileWriter(temporaryStoragePath);
        // eslint-disable-next-line no-await-in-loop
        for await (const chunk of readable) {
          digester.update(chunk);
          // eslint-disable-next-line no-await-in-loop
          await fileWriter.next(chunk);
        }
        await fileWriter.return(undefined);

        // Calculate hash.
        const sha256 = digester.digestHex();
        // Finish with an atomic rename.
        const storagePath = filePowers.joinPath(storageDirectoryPath, sha256);
        await filePowers.renamePath(temporaryStoragePath, storagePath);
        return sha256;
      },
      /**
       * @param {string} sha256
       */
      fetch(sha256) {
        const storagePath = filePowers.joinPath(storageDirectoryPath, sha256);
        const streamBase64 = () => {
          const reader = filePowers.makeFileReader(storagePath);
          return makeReaderRef(reader);
        };
        const text = async () => {
          return filePowers.readFileText(storagePath);
        };
        const json = async () => {
          const jsonSrc = await text();
          return JSON.parse(jsonSrc);
        };
        return harden({ streamBase64, text, json });
      },
      /**
       * @param {string} sha256
       * @returns {Promise<boolean>}
       */
      async has(sha256) {
        const storagePath = filePowers.joinPath(storageDirectoryPath, sha256);
        try {
          await filePowers.readFileText(storagePath);
          return true;
        } catch (_e) {
          return false;
        }
      },
    });

    return makeSnapshotStore(rawStore);
  };

  /**
   * @param {string} formulaNumber
   */
  const makeFormulaPath = formulaNumber => {
    const { statePath } = config;
    if (formulaNumber.length < 3) {
      throw new TypeError(`Invalid formula number ${q(formulaNumber)}`);
    }
    const head = formulaNumber.slice(0, 2);
    const tail = formulaNumber.slice(2);
    const directory = filePowers.joinPath(statePath, 'formulas', head);
    const file = filePowers.joinPath(directory, `${tail}.json`);
    return harden({ directory, file });
  };

  /**
   * @param {string} formulaNumber
   * @returns {Promise<{ node: string, formula: Formula }>}
   */
  const readFormula = async formulaNumber => {
    const { file: formulaPath } = makeFormulaPath(formulaNumber);
    const formulaText = await filePowers.maybeReadFileText(formulaPath);
    if (formulaText === undefined) {
      throw new ReferenceError(`No reference exists at path ${formulaPath}`);
    }
    const formula = (() => {
      try {
        return JSON.parse(formulaText);
      } catch (error) {
        throw new TypeError(
          `Corrupt description for reference in file ${formulaPath}: ${/** @type {Error} */ (error).message}`,
        );
      }
    })();
    // The filesystem layout does not store per-formula node information.
    // Callers that need a node number fall back to the local node when
    // this returns the empty string.
    return { node: '', formula };
  };

  // Persist instructions for revival (this can be collected).
  /** @type {DaemonicPersistencePowers['writeFormula']} */
  const writeFormula = async (formulaNumber, nodeNumber, formula) => {
    const { directory, file } = makeFormulaPath(formulaNumber);
    // Atomic write so that a partial write cannot leave a half-
    // formed JSON file that wedges later reads.
    await filePowers.makePath(directory);
    const tmp = `${file}.tmp`;
    await filePowers.writeFileText(tmp, `${q(formula)}\n`);
    await filePowers.renamePath(tmp, file);
    if (nodeNumber) {
      let bucket = formulasByNode.get(nodeNumber);
      if (bucket === undefined) {
        bucket = new Set();
        formulasByNode.set(nodeNumber, bucket);
      }
      bucket.add(formulaNumber);
      // eslint-disable-next-line no-use-before-define
      persistFormulasByNode(nodeNumber);
    }
  };

  /** @type {DaemonicPersistencePowers['deleteFormula']} */
  const deleteFormula = async formulaNumber => {
    const { file } = makeFormulaPath(formulaNumber);
    await filePowers.removePath(file);
    // Drop from any per-node bucket that contains it.  (We don't
    // know which without scanning; the indexes are small so a linear
    // scan over node-number keys is fine.)
    for (const [nodeNumber, bucket] of formulasByNode) {
      if (bucket.delete(formulaNumber)) {
        // eslint-disable-next-line no-use-before-define
        persistFormulasByNode(nodeNumber);
      }
    }
  };

  /** @type {DaemonicPersistencePowers['listFormulas']} */
  const listFormulas = async () => {
    const formulasPath = filePowers.joinPath(config.statePath, 'formulas');
    const heads = await filePowers.readDirectory(formulasPath).catch(error => {
      if (error.message.startsWith('ENOENT: ')) {
        return [];
      }
      throw error;
    });
    /** @type {Array<{ number: string, node: string }>} */
    const records = [];
    await Promise.all(
      heads.map(async head => {
        const headPath = filePowers.joinPath(formulasPath, head);
        const files = await filePowers.readDirectory(headPath).catch(error => {
          if (
            error.message.startsWith('ENOTDIR: ') ||
            error.message.startsWith('ENOENT: ')
          ) {
            return [];
          }
          throw error;
        });
        for (const file of files) {
          if (file.endsWith('.json')) {
            const tail = file.slice(0, -'.json'.length);
            // Filesystem layout has no per-formula node directory; the
            // caller fills in localNodeNumber when node is empty.
            records.push({ number: `${head}${tail}`, node: '' });
          }
        }
      }),
    );
    return records;
  };

  // Filesystem-backed replacements for the SQLite-only tables.
  // Caches in memory for synchronous access; writes are serialised
  // per-file through a promise chain.  Callers' mutators stay
  // synchronous (matching the SQLite contract); the disk write is
  // scheduled and chained.  Failures land on the promise chain
  // (logged to stderr) but the cache stays consistent.
  const { statePath } = config;
  const agentKeysPath = filePowers.joinPath(statePath, 'agent-keys.json');
  const remoteAgentKeysPath = filePowers.joinPath(
    statePath,
    'remote-agent-keys.json',
  );
  const retentionDir = filePowers.joinPath(statePath, 'retention');
  const formulasByNodeDir = filePowers.joinPath(statePath, 'formulas-by-node');

  /** @type {Map<string, { publicKey: string, privateKey: string, agentId: string }>} */
  const agentKeys = new Map();
  /** @type {Map<string, string>} */
  const remoteAgentKeys = new Map();
  /** @type {Map<string, Set<string>>} */
  const retention = new Map();
  /** @type {Map<string, Set<string>>} */
  const formulasByNode = new Map();

  /**
   * Per-file write chain.  Each enqueued task runs after the prior
   * one settles.  Failures propagate to a single sink that logs but
   * does not stall the chain.
   *
   * @returns {(task: () => Promise<void>) => void}
   */
  const makeWriteChain = () => {
    /** @type {Promise<void>} */
    let last = Promise.resolve();
    const enqueue = task => {
      last = last
        .then(() => task())
        .catch(err => {
          console.error('Persistence write failed:', err);
        });
    };
    return enqueue;
  };
  const writeAgentKeysChain = makeWriteChain();
  const writeRemoteAgentKeysChain = makeWriteChain();
  /** @type {Map<string, (task: () => Promise<void>) => void>} */
  const retentionChains = new Map();
  /** @type {Map<string, (task: () => Promise<void>) => void>} */
  const byNodeChains = new Map();

  /** @param {string} path @param {string} text */
  const atomicWriteText = async (path, text) => {
    const tmp = `${path}.tmp`;
    await filePowers.writeFileText(tmp, text);
    await filePowers.renamePath(tmp, path);
  };

  const persistAgentKeys = () => {
    writeAgentKeysChain(async () => {
      const arr = Array.from(agentKeys.values());
      await atomicWriteText(agentKeysPath, JSON.stringify(arr));
    });
  };
  const persistRemoteAgentKeys = () => {
    writeRemoteAgentKeysChain(async () => {
      const obj = Object.fromEntries(remoteAgentKeys);
      await atomicWriteText(remoteAgentKeysPath, JSON.stringify(obj));
    });
  };
  /** @param {string} guestPublicKey */
  const persistRetention = guestPublicKey => {
    let chain = retentionChains.get(guestPublicKey);
    if (chain === undefined) {
      chain = makeWriteChain();
      retentionChains.set(guestPublicKey, chain);
    }
    const file = filePowers.joinPath(retentionDir, `${guestPublicKey}.json`);
    chain(async () => {
      const set = retention.get(guestPublicKey);
      await filePowers.makePath(retentionDir);
      if (set === undefined || set.size === 0) {
        await filePowers.removePath(file).catch(err => {
          // eslint-disable-next-line no-use-before-define
          if (!isNotFoundError(err)) throw err;
        });
        return;
      }
      await atomicWriteText(file, JSON.stringify(Array.from(set)));
    });
  };
  /** @param {string} nodeNumber */
  const persistFormulasByNode = nodeNumber => {
    let chain = byNodeChains.get(nodeNumber);
    if (chain === undefined) {
      chain = makeWriteChain();
      byNodeChains.set(nodeNumber, chain);
    }
    const file = filePowers.joinPath(formulasByNodeDir, `${nodeNumber}.json`);
    chain(async () => {
      const set = formulasByNode.get(nodeNumber);
      await filePowers.makePath(formulasByNodeDir);
      if (set === undefined || set.size === 0) {
        await filePowers.removePath(file).catch(err => {
          // eslint-disable-next-line no-use-before-define
          if (!isNotFoundError(err)) throw err;
        });
        return;
      }
      await atomicWriteText(file, JSON.stringify(Array.from(set)));
    });
  };

  /**
   * Recognize "file does not exist" across both Node's filePowers
   * (which throws Error with code 'ENOENT' and a message starting
   * "ENOENT: ...") and the Rust supervisor's filePowers (which
   * throws plain Error with "No such file or directory (os error 2)").
   *
   * @param {any} err
   */
  const isNotFoundError = err => {
    if (err && err.code === 'ENOENT') return true;
    const msg = String((err && err.message) || err || '');
    return (
      msg.startsWith('ENOENT: ') || msg.includes('No such file or directory')
    );
  };

  /**
   * Try to JSON.parse a state file's contents, swallowing parse
   * errors with a console warning.  A corrupt durability file
   * should never wedge daemon startup; the safer behavior is to
   * boot with empty state and let the next mutation rewrite the
   * file atomically.
   *
   * @template T
   * @param {string} label
   * @param {string} text
   * @param {T} fallback
   * @returns {T}
   */
  const safeParseJson = (label, text, fallback) => {
    try {
      return JSON.parse(text);
    } catch (err) {
      console.error(
        `Persistence: ignoring corrupt ${label}; starting empty:`,
        err,
      );
      return fallback;
    }
  };

  const loadDurableState = async () => {
    const agentKeysText = await filePowers.maybeReadFileText(agentKeysPath);
    if (agentKeysText !== undefined) {
      const arr = safeParseJson(
        'agent-keys.json',
        agentKeysText,
        /** @type {Array<{publicKey: string, privateKey: string, agentId: string}>} */ ([]),
      );
      for (const record of arr) {
        if (record && typeof record.publicKey === 'string') {
          agentKeys.set(record.publicKey, record);
        }
      }
    }
    const remoteText = await filePowers.maybeReadFileText(remoteAgentKeysPath);
    if (remoteText !== undefined) {
      const obj = safeParseJson(
        'remote-agent-keys.json',
        remoteText,
        /** @type {Record<string, string>} */ ({}),
      );
      for (const [pk, node] of Object.entries(obj)) {
        remoteAgentKeys.set(pk, /** @type {string} */ (node));
      }
    }
    // Eagerly load retention buckets and per-node indexes — they're
    // small and the queries are synchronous.  Per-file failures are
    // tolerated: a corrupt one logs and is dropped, the rest load.
    const retentionFiles = await filePowers
      .readDirectory(retentionDir)
      .catch(err => {
        if (isNotFoundError(err)) return [];
        throw err;
      });
    await Promise.all(
      retentionFiles.map(async fileName => {
        if (!fileName.endsWith('.json')) return;
        const guestPublicKey = fileName.slice(0, -'.json'.length);
        try {
          const text = await filePowers.readFileText(
            filePowers.joinPath(retentionDir, fileName),
          );
          const arr = safeParseJson(
            `retention/${fileName}`,
            text,
            /** @type {string[]} */ ([]),
          );
          retention.set(guestPublicKey, new Set(arr));
        } catch (err) {
          console.error(
            `Persistence: failed to load retention/${fileName}:`,
            err,
          );
        }
      }),
    );
    const byNodeFiles = await filePowers
      .readDirectory(formulasByNodeDir)
      .catch(err => {
        if (isNotFoundError(err)) return [];
        throw err;
      });
    await Promise.all(
      byNodeFiles.map(async fileName => {
        if (!fileName.endsWith('.json')) return;
        const nodeNumber = fileName.slice(0, -'.json'.length);
        try {
          const text = await filePowers.readFileText(
            filePowers.joinPath(formulasByNodeDir, fileName),
          );
          const arr = safeParseJson(
            `formulas-by-node/${fileName}`,
            text,
            /** @type {string[]} */ ([]),
          );
          formulasByNode.set(nodeNumber, new Set(arr));
        } catch (err) {
          console.error(
            `Persistence: failed to load formulas-by-node/${fileName}:`,
            err,
          );
        }
      }),
    );
  };

  /** @param {string} nodeNumber */
  const listFormulaNumbersByNode = nodeNumber => {
    const set = formulasByNode.get(nodeNumber);
    return set ? Array.from(set) : [];
  };
  const writeAgentKey = (publicKey, privateKey, agentId) => {
    agentKeys.set(publicKey, { publicKey, privateKey, agentId });
    persistAgentKeys();
  };
  const getAgentKey = publicKey => agentKeys.get(publicKey);
  const hasAgentKey = publicKey => agentKeys.has(publicKey);
  const listAgentKeys = () => Array.from(agentKeys.values());
  const deleteAgentKey = publicKey => {
    agentKeys.delete(publicKey);
    persistAgentKeys();
  };
  const writeRemoteAgentKey = (publicKey, daemonNode) => {
    remoteAgentKeys.set(publicKey, daemonNode);
    persistRemoteAgentKeys();
  };
  const getRemoteAgentKey = publicKey => remoteAgentKeys.get(publicKey);
  const retentionBucket = guestPublicKey => {
    let s = retention.get(guestPublicKey);
    if (s === undefined) {
      s = new Set();
      retention.set(guestPublicKey, s);
    }
    return s;
  };
  const writeRetention = (guestPublicKey, formulaNumber) => {
    retentionBucket(guestPublicKey).add(formulaNumber);
    persistRetention(guestPublicKey);
  };
  const deleteRetention = (guestPublicKey, formulaNumber) => {
    retentionBucket(guestPublicKey).delete(formulaNumber);
    persistRetention(guestPublicKey);
  };
  const listRetention = guestPublicKey =>
    Array.from(retentionBucket(guestPublicKey), formulaNumber => ({
      formulaNumber,
    }));
  const replaceRetention = (guestPublicKey, formulaNumbers) => {
    retention.set(guestPublicKey, new Set(formulaNumbers));
    persistRetention(guestPublicKey);
  };
  const deleteAllRetention = guestPublicKey => {
    retention.delete(guestPublicKey);
    persistRetention(guestPublicKey);
  };

  return harden({
    statePath: config.statePath,
    initializePersistence,
    provideRootNonce,
    provideRootKeypair,
    makeContentStore,
    readFormula,
    writeFormula,
    deleteFormula,
    listFormulas,
    listFormulaNumbersByNode,
    writeAgentKey,
    getAgentKey,
    hasAgentKey,
    listAgentKeys,
    deleteAgentKey,
    writeRemoteAgentKey,
    getRemoteAgentKey,
    writeRetention,
    deleteRetention,
    listRetention,
    replaceRetention,
    deleteAllRetention,
  });
};
harden(makeDaemonicPersistencePowers);
