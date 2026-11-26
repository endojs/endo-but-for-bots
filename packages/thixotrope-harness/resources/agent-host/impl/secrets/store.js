// @ts-check
/**
 * The Secrets store (M2 W2.3; architecture D-6; `designs/m2-interfaces.md`
 * section 9.1; spec R7-22..R7-28).
 *
 * Secret values live only here, in the agent-host adapter process, and in
 * one encrypted file of the state directory:
 *
 *   `<state>/agent-host/secrets.enc`: AES-256-GCM over the JSON of every
 *   entry `{ key, label, description, generation, state, value? }`, a fresh
 *   96-bit nonce per write, written `*.tmp` then fsync, rename, fsync of the
 *   directory, so a SIGKILL leaves the old file or the new one.
 *
 * The wrapping key is a 32-byte file outside the state directory
 * (`wrapping-key.js`: refused inside it, and refused when its mode lets the
 * group or others read it; created 0600 only on a state's first run, never
 * while a sealed file exists); the store takes the incarnation's one
 * `WrappingKey`. `findSecretsFiles` says where both are.
 *
 * The audit log (R7-24) is a second file, `secrets-audit.log`, one line per
 * event, each line sealed on its own with the same key (deviation from
 * section 9.1, which puts the log inside `secrets.enc`: a read is audited
 * twice per provider round, and rewriting the whole encrypted file per read
 * would cost far more than the 1 ms `secrets.read` budget; J-0441). Events
 * carry no value and no bytes: `{ at, label, op, outcome, code?,
 * generation? }`. The newest `AUDIT_KEEP` events are kept in memory; the
 * file is rewritten to them when it holds twice as many lines.
 *
 * Every failure is `textOf.secretFailed(code)` with a code of
 * `secretCodes`; nothing here ever puts a value, a key or file bytes into
 * an error, a log line or the audit.
 *
 * Node only (adapter). Entries are keyed by the manager vat's `k<n>` keys
 * (they never leave the manager-adapter pair, m2-interfaces 3.3).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { Buffer } from 'node:buffer';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { mkdir, readFile, truncate, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { textOf } from '../../../../guest/lib/interfaces.js';
import { limits } from '../../../../guest/lib/limits.js';
import { subscriptionLimits } from '../../../../guest/lib/subscription-limits.js';
/* eslint-enable import/no-relative-packages */
import { writeFileAtomic, writeFileAtomicSync } from '../files.js';
import { isCredentialPath } from './wrapping-key.js';

/** @import { WrappingKey } from './wrapping-key.js' */

/** The environment variable naming the wrapping key file (serve.mjs passes it). */
export const SECRETS_KEY_VARIABLE = 'THIX_HARNESS_SECRETS_KEY';
/** Audit events kept (m2-interfaces 9.1: the newest 10,000). */
export const AUDIT_KEEP = limits.auditKeepEvents;
const FILE_FORMAT = 'thix-secrets-1';
const AUDIT_FORMAT = 'thix-secrets-audit-1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * A failure with a fixed code (R7-24): the message is the fixed text, never
 * secret bytes; `code` lets callers branch without parsing.
 * @param {string} code
 */
export const secretError = code =>
  Object.assign(Error(textOf.secretFailed(code)), { code });
harden(secretError);

/**
 * Where the store keeps its files for a state directory, and where the
 * wrapping key is: `env[SECRETS_KEY_VARIABLE]` (absolute), else
 * `~/.config/thixotrope-harness/secrets-<first 16 hex of sha256(state)>.key`.
 * `keyReadOnly` is true when the key is a systemd credential (a path under
 * `env.CREDENTIALS_DIRECTORY`, e.g. `THIX_HARNESS_SECRETS_KEY=%d/wrapping-key`
 * in the unit): it is then only ever read.
 *
 * @param {object} options
 * @param {string} options.stateDir
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.home]
 */
export const findSecretsFiles = ({ stateDir, env = {}, home }) => {
  const state = resolve(stateDir);
  const named = env[SECRETS_KEY_VARIABLE];
  let keyFile;
  if (named !== undefined && named !== '') {
    if (!isAbsolute(named))
      throw Error(`${SECRETS_KEY_VARIABLE} must be an absolute path`);
    keyFile = named;
  } else {
    const tag = createHash('sha256').update(state).digest('hex').slice(0, 16);
    keyFile = join(
      home ?? homedir(),
      '.config',
      'thixotrope-harness',
      `secrets-${tag}.key`,
    );
  }
  return harden({
    stateDir: state,
    file: join(state, 'agent-host', 'secrets.enc'),
    auditFile: join(state, 'agent-host', 'secrets-audit.log'),
    keyFile,
    keyReadOnly: isCredentialPath(keyFile, env),
  });
};
harden(findSecretsFiles);

/**
 * AES-256-GCM: nonce | ciphertext | tag.
 * @param {Buffer} key
 * @param {Buffer} plain
 * @param {string} aad
 */
export const encrypt = (key, plain, aad) => {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
};
harden(encrypt);

/**
 * @param {Buffer} key
 * @param {Buffer} sealed
 * @param {string} aad
 */
export const decrypt = (key, sealed, aad) => {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw Error('sealed too short');
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
};
harden(decrypt);

/**
 * R7-25: 1-200 characters, no newline.
 * @param {unknown} description
 */
export const assertDescription = description => {
  if (
    typeof description !== 'string' ||
    description.length === 0 ||
    description.length > limits.secretDescriptionUnits ||
    description.includes('\n') ||
    description.includes('\r')
  )
    throw secretError('INVALID_DESCRIPTION');
};
harden(assertDescription);

/**
 * @typedef {'active' | 'revoked'} SecretState
 * @typedef {{ label: string, description: string, generation: number, state: SecretState, bytes: number, value?: string }} Entry
 * @typedef {{ at: number, key: string, label: string, op: 'create' | 'read' | 'replace' | 'revoke' | 'delete' | 'setDescription', outcome: 'attempted' | 'succeeded' | 'failed', code?: string, generation?: number }} StoredEvent
 * @typedef {{ at: number, label: string, op: StoredEvent['op'], outcome: StoredEvent['outcome'], code?: string, generation?: number }} AuditEvent
 *
 * @typedef {object} SecretStore
 * @property {(key: string, label: string, description: string) => Promise<void>} create
 * @property {(key: string, value: string, expectedGeneration?: number) => Promise<number>} replace
 *   the new generation; `GENERATION_CONFLICT` for a stale expectation,
 *   `REVOKED`, `UNKNOWN_SECRET`, `INVALID_SECRET_BYTES` (over 1 MiB)
 * @property {(key: string) => Promise<{ value: string, generation: number }>} read
 *   audited `attempted`, then `succeeded` or `failed` with its code
 * @property {(key: string) => { value: string, generation: number }} readNow
 *   the same once `ready()` has settled, synchronously (the providers'
 *   path; `secrets.read`)
 * @property {(key: string) => Promise<{ label: string, description: string, generation: number, state: SecretState, bytes: number }>} describe
 * @property {(key: string) => Promise<void>} revoke drops the value
 * @property {(key: string) => Promise<void>} delete only after revoke
 *   (`NOT_REVOKED`)
 * @property {(request: { key?: string, limit: number, before?: number }) => Promise<AuditEvent[]>} audit
 *   newest first, at most `auditPageEvents` (M2's bound); `before` (M4):
 *   only events older than that event time
 * @property {(request: { key?: string, limit: number, before?: number }) => Promise<AuditEvent[]>} auditPage
 *   as `audit`, at most `subscriptionLimits.auditReaderMax` (1,000; R7-63; M4 H-5):
 *   the adapter-local `AuditReader`'s path
 * @property {(key: string, description: string) => Promise<void>} setDescription
 *   M4 H-5: the entry's description (R7-25 rule, `INVALID_DESCRIPTION`);
 *   audited `setDescription` (`attempted`, then `succeeded` or `failed`;
 *   the event carries the label, never the description: J-9662 item 9)
 * @property {() => Promise<void>} ready loads the key and the files
 * @property {() => void} close closes the audit file
 * @property {() => Record<string, number>} stats
 */

/**
 * @param {object} options
 * @param {string} options.file `secrets.enc`
 * @param {WrappingKey} options.wrappingKey the incarnation's wrapping key
 *   (`makeWrappingKey`)
 * @param {string} [options.auditFile] default: `secrets-audit.log` next to
 *   `file`
 * @param {() => number} [options.now]
 * @param {number} [options.auditKeep]
 * @returns {SecretStore}
 */
export const makeSecretStore = ({
  file,
  wrappingKey,
  auditFile = join(dirname(file), 'secrets-audit.log'),
  now = () => Date.now(),
  auditKeep = AUDIT_KEEP,
}) => {
  /** @type {Map<string, Entry>} */
  const entries = new Map();
  /** @type {StoredEvent[]} newest last */
  let events = [];
  let auditLines = 0;
  /** @type {Buffer | undefined} */
  let wrapKey;
  /** @type {number | undefined} */
  let auditFd;
  /** @type {Promise<void> | undefined} */
  let loading;
  let loaded = false;
  /** Writes of `secrets.enc`, one at a time. */
  let chain = Promise.resolve();
  const counters = { writes: 0, reads: 0, auditLines: 0, auditRewrites: 0 };

  const keyOf = () => {
    if (wrapKey === undefined) throw Error('the secrets store is not ready');
    return wrapKey;
  };

  /** @param {StoredEvent} event */
  const sealEvent = event =>
    encrypt(keyOf(), Buffer.from(JSON.stringify(event), 'utf8'), AUDIT_FORMAT)
      .toString('base64')
      .concat('\n');

  const rewriteAudit = () => {
    const text = events.map(sealEvent).join('');
    if (auditFd !== undefined) closeSync(auditFd);
    auditFd = undefined;
    // No directory fsync: the log before the rename holds every event the
    // rewritten one does (a superset), so power loss that undoes the rename
    // loses nothing.
    writeFileAtomicSync(auditFile, text, { syncDirectory: false });
    auditLines = events.length;
    counters.auditRewrites += 1;
  };

  /** The newest event's time; event times strictly increase (M4 H-5). */
  let lastAt = -1;

  /**
   * Record one event: in memory, and one sealed line appended (not fsynced:
   * a SIGKILL may lose the newest lines; the value itself never depends on
   * the log). Times strictly increase (a second event in the same
   * millisecond is stamped one millisecond later), so an audit page can
   * continue from the time of its last event (`before`, M4 4.1) without
   * losing or repeating an event.
   * @param {Omit<StoredEvent, 'at'>} partial
   */
  const audit = partial => {
    const at = Math.max(now(), lastAt + 1);
    lastAt = at;
    /** @type {StoredEvent} */
    const event = harden({ at, ...partial });
    events.push(event);
    if (events.length > auditKeep) events = events.slice(-auditKeep);
    if (auditFd === undefined) auditFd = openSync(auditFile, 'a', 0o600);
    appendFileSync(auditFd, sealEvent(event));
    auditLines += 1;
    counters.auditLines += 1;
    if (auditLines >= 2 * auditKeep) rewriteAudit();
  };

  const load = async () => {
    // A load runs again after a failed one: start from nothing.
    entries.clear();
    events = [];
    wrapKey = await wrappingKey.get();
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await unlink(`${file}.tmp`).catch(() => {});
    await unlink(`${auditFile}.tmp`).catch(() => {});
    /** @type {Buffer | undefined} */
    let raw;
    try {
      raw = await readFile(file);
    } catch (error) {
      if (/** @type {any} */ (error).code !== 'ENOENT') throw error;
    }
    if (raw !== undefined) {
      const envelope = JSON.parse(raw.toString('utf8'));
      if (envelope.format !== FILE_FORMAT)
        throw Error('secrets.enc has an unknown format');
      let plain;
      try {
        plain = decrypt(
          wrapKey,
          Buffer.from(envelope.data, 'base64'),
          FILE_FORMAT,
        );
      } catch {
        // Never the bytes: a wrong key file or a damaged file.
        throw Error('secrets.enc cannot be opened with this key file');
      }
      const list = JSON.parse(plain.toString('utf8'));
      plain.fill(0);
      for (const { key, ...entry } of list) entries.set(key, entry);
    }
    let auditRaw = '';
    try {
      auditRaw = await readFile(auditFile, 'utf8');
    } catch (error) {
      if (/** @type {any} */ (error).code !== 'ENOENT') throw error;
    }
    const end = auditRaw.lastIndexOf('\n') + 1;
    if (end < auditRaw.length) {
      // A torn last line (power loss, a full disk; not a SIGKILL, which
      // cannot split one write): cut it, so the next append starts a line
      // of its own instead of being glued to it (J-9486). Base64 lines:
      // characters are bytes.
      await truncate(auditFile, end);
      auditRaw = auditRaw.slice(0, end);
    }
    const lines = auditRaw.split('\n').filter(line => line !== '');
    auditLines = lines.length;
    for (const line of lines.slice(-auditKeep)) {
      try {
        const plainEvent = decrypt(
          wrapKey,
          Buffer.from(line, 'base64'),
          AUDIT_FORMAT,
        );
        /** @type {StoredEvent} */
        const event = harden(JSON.parse(plainEvent.toString('utf8')));
        events.push(event);
        const { at } = event;
        if (typeof at === 'number' && at > lastAt) lastAt = at;
      } catch {
        // A torn last line (SIGKILL mid-append) or a foreign line: skipped.
      }
    }
    loaded = true;
  };

  /** Loads once; a failed load is not kept, the next call tries again. */
  const ready = () => {
    if (loading === undefined) {
      const attempt = load();
      loading = attempt;
      attempt.catch(() => {
        if (loading === attempt) loading = undefined;
      });
    }
    return loading;
  };

  /** Write every entry, encrypted, temp then rename (one at a time). */
  const persist = async () => {
    const list = [...entries].map(([key, entry]) => ({ key, ...entry }));
    const plain = Buffer.from(JSON.stringify(list), 'utf8');
    const sealed = encrypt(keyOf(), plain, FILE_FORMAT);
    plain.fill(0);
    const body = JSON.stringify({
      format: FILE_FORMAT,
      data: sealed.toString('base64'),
    });
    await writeFileAtomic(file, body, { chmod: true });
    counters.writes += 1;
  };

  /**
   * Run a mutation after the earlier ones; the entry map changes only once
   * the file holding the change is durable.
   * @template T
   * @param {() => { result: T, apply: () => void } } plan
   * @returns {Promise<T>}
   */
  const mutate = plan => {
    const run = chain.then(async () => {
      await ready();
      const { result, apply } = plan();
      const before = new Map(entries);
      apply();
      try {
        await persist();
      } catch (error) {
        entries.clear();
        for (const [key, entry] of before) entries.set(key, entry);
        throw error;
      }
      return result;
    });
    chain = run.then(
      () => {},
      () => {},
    );
    return run;
  };

  /** @param {string} key */
  const entryOf = key => {
    const entry = entries.get(key);
    if (entry === undefined) throw secretError('UNKNOWN_SECRET');
    return entry;
  };

  /**
   * Audit `attempted`, run, audit the outcome with the fixed code.
   * @template T
   * @param {string} key
   * @param {StoredEvent['op']} op
   * @param {string} failCode used for a failure that is not a fixed one
   * @param {() => Promise<T>} fn
   * @param {(result: T) => number | undefined} [generationOf]
   * @param {string} [givenLabel] the label of a secret being created
   */
  const audited = async (key, op, failCode, fn, generationOf, givenLabel) => {
    await ready();
    const label = entries.get(key)?.label ?? givenLabel ?? '';
    audit({ key, label, op, outcome: 'attempted' });
    try {
      const result = await fn();
      const generation = generationOf?.(result);
      audit({
        key,
        label: entries.get(key)?.label ?? label,
        op,
        outcome: 'succeeded',
        ...(generation === undefined ? {} : { generation }),
      });
      return result;
    } catch (error) {
      const fixed = /** @type {any} */ (error)?.code;
      const code =
        typeof fixed === 'string' && /^[A-Z_]+$/.test(fixed) ? fixed : failCode;
      audit({ key, label, op, outcome: 'failed', code });
      throw secretError(code);
    }
  };

  /** @param {string} key */
  const readNow = key => {
    if (!loaded) throw secretError('READ_FAILED');
    counters.reads += 1;
    const entry = entries.get(key);
    const label = entry?.label ?? '';
    audit({ key, label, op: 'read', outcome: 'attempted' });
    /** @type {string} */
    let code = 'READ_FAILED';
    if (entry === undefined) code = 'UNKNOWN_SECRET';
    else if (entry.state !== 'active') code = 'REVOKED';
    else if (entry.value !== undefined) {
      const { value, generation } = entry;
      audit({ key, label, op: 'read', outcome: 'succeeded', generation });
      return harden({ value, generation });
    }
    audit({
      key,
      label,
      op: 'read',
      outcome: 'failed',
      code,
      ...(entry === undefined ? {} : { generation: entry.generation }),
    });
    throw secretError(code);
  };

  /**
   * Events newest first, of one key or all, older than `before` (an event
   * time) when given; at most `limit` (<= `max`).
   * @param {{ key?: string, limit: number, before?: number }} request
   * @param {number} max
   * @returns {Promise<AuditEvent[]>}
   */
  const auditEvents = async ({ key, limit, before }, max) => {
    await ready();
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > max)
      throw secretError('INVALID_LIMIT');
    if (before !== undefined && !(typeof before === 'number' && before >= 0))
      throw secretError('INVALID_LIMIT');
    /** @type {AuditEvent[]} */
    const out = [];
    let i = events.length - 1;
    if (before !== undefined) {
      // Times strictly increase: binary search for the newest event < before.
      let lo = 0;
      let hi = events.length;
      while (lo < hi) {
        // eslint-disable-next-line no-bitwise
        const mid = (lo + hi) >>> 1;
        if (events[mid].at < before) lo = mid + 1;
        else hi = mid;
      }
      i = lo - 1;
    }
    for (; i >= 0 && out.length < limit; i -= 1) {
      const { key: eventKey, ...event } = events[i];
      if (key === undefined || eventKey === key) out.push(harden(event));
    }
    return harden(out);
  };

  /** @type {SecretStore} */
  const store = {
    ready,
    create: (key, label, description) =>
      audited(
        key,
        'create',
        'CREATE_FAILED',
        () => {
          assertDescription(description);
          // A create applied before the adapter died, sent again by the
          // manager's one retry (HR-SYN-8): keys are the manager's, never
          // reused, so an entry under this key as a create leaves it
          // (same label and description, never written to) is that create.
          // Answered without a second write; anything else is refused.
          const known = entries.get(key);
          if (known !== undefined) {
            if (
              known.label === label &&
              known.description === description &&
              known.generation === 0 &&
              known.state === 'active' &&
              known.value === undefined
            )
              return Promise.resolve(undefined);
            throw secretError('CREATE_FAILED');
          }
          return mutate(() => {
            if (entries.has(key)) throw secretError('CREATE_FAILED');
            return {
              result: undefined,
              apply: () => {
                entries.set(key, {
                  label,
                  description,
                  generation: 0,
                  state: 'active',
                  bytes: 0,
                });
              },
            };
          });
        },
        undefined,
        label,
      ),
    replace: (key, value, expectedGeneration) =>
      audited(
        key,
        'replace',
        'REPLACE_FAILED',
        () =>
          mutate(() => {
            const entry = entryOf(key);
            if (typeof value !== 'string')
              throw secretError('INVALID_SECRET_BYTES');
            const bytes = Buffer.byteLength(value, 'utf8');
            if (bytes > limits.secretValueBytes)
              throw secretError('INVALID_SECRET_BYTES');
            if (entry.state !== 'active') throw secretError('REVOKED');
            if (
              expectedGeneration !== undefined &&
              (!Number.isSafeInteger(expectedGeneration) ||
                expectedGeneration < 0)
            )
              throw secretError('INVALID_GENERATION');
            if (
              expectedGeneration !== undefined &&
              expectedGeneration !== entry.generation
            )
              throw secretError('GENERATION_CONFLICT');
            const generation = entry.generation + 1;
            return {
              result: generation,
              apply: () => {
                entries.set(key, { ...entry, generation, bytes, value });
              },
            };
          }),
        generation => generation,
      ),
    read: async key => {
      await ready();
      return readNow(key);
    },
    readNow,
    describe: async key => {
      await ready();
      const { label, description, generation, state, bytes } = entryOf(key);
      return harden({ label, description, generation, state, bytes });
    },
    revoke: key =>
      audited(key, 'revoke', 'REPLACE_FAILED', () =>
        mutate(() => {
          const entry = entryOf(key);
          return {
            result: undefined,
            apply: () => {
              const { value: _dropped, ...rest } = entry;
              entries.set(key, { ...rest, state: 'revoked' });
            },
          };
        }),
      ),
    delete: key =>
      audited(key, 'delete', 'DELETE_FAILED', () =>
        mutate(() => {
          const entry = entryOf(key);
          if (entry.state !== 'revoked') throw secretError('NOT_REVOKED');
          return {
            result: undefined,
            apply: () => {
              entries.delete(key);
            },
          };
        }),
      ),
    audit: request => auditEvents(request, limits.auditPageEvents),
    auditPage: request =>
      auditEvents(request, subscriptionLimits.auditReaderMax),
    setDescription: (key, description) =>
      audited(key, 'setDescription', 'INVALID_DESCRIPTION', () =>
        mutate(() => {
          assertDescription(description);
          const entry = entryOf(key);
          return {
            result: undefined,
            apply: () => {
              entries.set(key, { ...entry, description });
            },
          };
        }),
      ),
    close: () => {
      if (auditFd !== undefined) closeSync(auditFd);
      auditFd = undefined;
    },
    stats: () => harden({ ...counters, entries: entries.size }),
  };
  return harden(store);
};
harden(makeSecretStore);
