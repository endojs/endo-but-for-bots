// @ts-check

import { makeError, q, X } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { makeReaderPump } from '@endo/exo-stream/reader-pump.js';
import { M } from '@endo/patterns';

import {
  bookTaskGuards,
  makeBookTaskManager,
  taskSummary,
} from './book-tasks.js';

const MAX_FILE_LENGTH = 1024 * 1024;
const MAX_BOOK_LENGTH = 8 * MAX_FILE_LENGTH;
const MAX_EVENT_LENGTH = 64 * 1024;

/** @typedef {Record<string, any>} JsonRecord */
/** @typedef {{id: string, name: string, detail: any, state: JsonRecord, revision: string, sourceRevision: string}} BookEvent */
/** @typedef {{version: 1, revision: bigint, sourceRevision: bigint, nextEvent: bigint, nextTask: bigint, tasks: any[], files: Record<string,string>, state: JsonRecord, pendingEvents: BookEvent[], activeEvents: BookEvent[], failedEvents: any[], activeEventIds: string[], completedEventIds: string[], messages: {id:string,role:string,content:string}[]}} BookRecord */
/** @typedef {{source: string, assets: Record<string,string>, tasks: any[], state: JsonRecord, revision: string, sourceRevision: string, initialized: boolean, pendingEvents: BookEvent[], failedEvents: any[], activeEventIds: string[], completedEventIds: string[], messages: {id:string,role:string,content:string}[]}} BookSnapshot */

/** Validate JSON data without silently discarding capabilities or undefined. */
/** @param {any} value */
const assertJson = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    value.forEach(assertJson);
    return;
  }
  if (
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    Object.values(value).forEach(assertJson);
    return;
  }
  throw makeError(X`Book data must contain only JSON values`);
};

/** @param {any} value */
const assertRecord = value => {
  assertJson(value);
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw makeError(X`Book state must be a JSON record`);
  }
};

/** @param {string} path */
const assertPath = path => {
  if (
    !path ||
    path.length > 1024 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    throw makeError(X`Invalid book file path ${q(path)}`);
  }
};

// Enforce source length in methods so rejection does not print a megabyte
// of generated code through the generic string matcher diagnostic.
const SourceText = M.string(harden({ stringLengthLimit: Infinity }));

const BookInterface = M.interface('WhylipBook', {
  ...bookTaskGuards,
  initialize: M.call(SourceText).optional(M.record()).returns(M.promise()),
  getSnapshot: M.call().returns(M.promise()),
  getContext: M.call().returns(M.promise()),
  getFiles: M.call().returns(M.remotable()),
  followChanges: M.call().returns(M.promise()),
  updateState: M.call(M.record()).returns(M.promise()),
  patchState: M.call(M.record()).returns(M.promise()),
  act: M.call(M.string()).optional(M.any()).returns(M.promise()),
  pendingEvents: M.call().returns(M.promise()),
  ackEvent: M.call(M.string()).returns(M.promise()),
  finishEvent: M.call(M.string()).optional(M.string()).returns(M.promise()),
  failEvent: M.call(M.string(), M.string()).returns(M.promise()),
  retryEvent: M.call(M.string()).returns(M.promise()),
  recordMessage: M.call(M.string(), M.string(), M.string()).returns(
    M.promise(),
  ),
  help: M.call().returns(M.string()),
});
const FilesInterface = M.interface('WhylipBookFiles', {
  read: M.call(M.string()).returns(M.promise()),
  write: M.call(M.string(), SourceText).returns(M.promise()),
  edit: M.call(M.string(), SourceText, SourceText).returns(M.promise()),
  list: M.call().returns(M.promise()),
  remove: M.call(M.string()).returns(M.promise()),
  help: M.call().returns(M.string()),
});
const ReaderInterface = M.interface('WhylipBookReader', {
  readPattern: M.call().returns(M.any()),
  readReturnPattern: M.call().returns(M.any()),
  stream: M.call(M.any()).returns(M.promise()),
  cancel: M.call().returns(M.undefined()),
});

/**
 * A single durable writer for one book. The daemon retains this caplet's
 * identity; every browser and the agent share it. All writes persist one
 * complete record before publishing, so source, state, and events agree.
 * Storage powers are never exposed through either returned capability.
 *
 * @param {{list: () => Promise<string[]>, lookup: (name: string) => Promise<any>, storeValue: (value: any, name: string) => Promise<any>}} powers
 * @param {string} storageName
 * @param {{launchTask?: (id: string) => Promise<void>, notifyTask?: (summary: any) => Promise<void>}} [options]
 */
export const makeBookSession = async (powers, storageName, options = {}) => {
  // Distinguish absence from an I/O failure. A failed lookup must never reset
  // an existing book to its initial contents.
  const names = await E(powers).list();
  /** @type {BookRecord} */
  let record = names.includes(storageName)
    ? await E(powers).lookup(storageName)
    : harden({
        version: 1,
        revision: 0n,
        sourceRevision: 0n,
        nextEvent: 0n,
        nextTask: 0n,
        tasks: [],
        files: {},
        state: {},
        pendingEvents: [],
        activeEvents: [],
        failedEvents: [],
        activeEventIds: [],
        completedEventIds: [],
        messages: [],
      });
  record = harden({
    ...record,
    nextTask: record.nextTask ?? 0n,
    tasks: record.tasks ?? [],
    activeEvents:
      record.activeEvents ??
      record.pendingEvents.filter(event =>
        record.activeEventIds.includes(event.id),
      ),
    failedEvents: record.failedEvents ?? [],
  });
  if (record.version !== 1)
    throw makeError(X`Unsupported book storage version`);

  /** @type {Set<(snapshot: BookSnapshot) => void>} */
  const listeners = new Set();
  let tail = Promise.resolve();
  /** @returns {BookSnapshot} */
  const snapshot = () =>
    harden({
      source: record.files['scene.js'] || '',
      assets: Object.fromEntries(
        Object.entries(record.files).filter(
          ([path]) => path.startsWith('assets/') && path.endsWith('.svg'),
        ),
      ),
      tasks: record.tasks.map(taskSummary),
      state: record.state,
      revision: String(record.revision),
      sourceRevision: String(record.sourceRevision),
      initialized: Object.hasOwn(record.files, 'scene.js'),
      pendingEvents: record.pendingEvents,
      activeEventIds: record.activeEventIds,
      failedEvents: record.failedEvents.map(({ id, reason }) => ({
        id,
        reason,
      })),
      completedEventIds: record.completedEventIds,
      messages: record.messages,
    });
  const receipt = () =>
    harden({
      revision: String(record.revision),
      sourceRevision: String(record.sourceRevision),
    });
  const context = () =>
    harden({
      ...receipt(),
      state: record.state,
      activeEventIds: record.activeEventIds,
      failedEvents: record.failedEvents.map(({ id, reason }) => ({
        id,
        reason,
      })),
      completedEventIds: record.completedEventIds,
      assetPaths: Object.keys(record.files).filter(
        path => path.startsWith('assets/') && path.endsWith('.svg'),
      ),
      tasks: record.tasks.map(taskSummary),
    });
  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const serialize = operation => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  /** @param {BookRecord} next */
  const commit = async next => {
    // Bound memory and the durable single-record write cost.
    const size = Object.values(next.files).reduce(
      (sum, file) => sum + file.length,
      0,
    );
    const eventSize = JSON.stringify([
      next.pendingEvents,
      next.activeEvents,
      next.failedEvents,
    ]).length;
    if (eventSize > MAX_BOOK_LENGTH)
      throw makeError(
        X`Story event storage limit exceeded; finish or retry existing events`,
      );
    const draftSize = JSON.stringify(next.tasks).length;
    if (draftSize > MAX_BOOK_LENGTH)
      throw makeError(
        X`Background draft storage limit exceeded; apply or finish existing tasks`,
      );
    if (
      Object.keys(next.files).length > 256 ||
      size > MAX_BOOK_LENGTH ||
      JSON.stringify(next.state).length > MAX_EVENT_LENGTH
    ) {
      throw makeError(X`Book storage limit exceeded`);
    }
    const value = harden({ ...next, revision: record.revision + 1n });
    await E(powers).storeValue(value, storageName);
    record = value;
    const current = snapshot();
    for (const listener of listeners) listener(current);
    return current;
  };

  const files = makeExo('WhylipBookFiles', FilesInterface, {
    read(path) {
      assertPath(path);
      return serialize(async () => {
        if (!Object.hasOwn(record.files, path))
          throw makeError(X`No book file ${q(path)}`);
        return record.files[path];
      });
    },
    write(path, text) {
      assertPath(path);
      if (text.length > MAX_FILE_LENGTH)
        throw makeError(X`Book file is too large`);
      return serialize(async () => {
        if (record.files[path] === text && Object.hasOwn(record.files, path))
          return receipt();
        await commit({
          ...record,
          files: { ...record.files, [path]: text },
          sourceRevision:
            path === 'scene.js'
              ? record.sourceRevision + 1n
              : record.sourceRevision,
        });
        return receipt();
      });
    },
    edit(path, oldText, newText) {
      assertPath(path);
      if (oldText.length > MAX_FILE_LENGTH || newText.length > MAX_FILE_LENGTH)
        throw makeError(X`Book edit is too large`);
      if (!oldText) throw makeError(X`An edit must match nonempty text`);
      return serialize(async () => {
        if (!Object.hasOwn(record.files, path))
          throw makeError(X`No book file ${q(path)}`);
        const current = record.files[path];
        const start = current.indexOf(oldText);
        if (start === -1)
          throw makeError(X`Edit text was not found; read the latest file`);
        if (current.indexOf(oldText, start + 1) !== -1)
          throw makeError(
            X`Edit text is ambiguous; include more surrounding text`,
          );
        const text =
          current.slice(0, start) +
          newText +
          current.slice(start + oldText.length);
        if (text.length > MAX_FILE_LENGTH)
          throw makeError(X`Book file is too large`);
        if (text === current) return receipt();
        await commit({
          ...record,
          files: { ...record.files, [path]: text },
          sourceRevision:
            path === 'scene.js'
              ? record.sourceRevision + 1n
              : record.sourceRevision,
        });
        return receipt();
      });
    },
    list() {
      return serialize(async () => harden(Object.keys(record.files).sort()));
    },
    remove(path) {
      assertPath(path);
      if (path === 'scene.js')
        throw makeError(
          X`The active scene cannot be removed; write a replacement`,
        );
      return serialize(async () => {
        const nextFiles = { ...record.files };
        delete nextFiles[path];
        return commit({ ...record, files: nextFiles });
      });
    },
    help() {
      return 'Scoped persistent text files: read(path), write(path, text), edit(path, oldText, newText) (one exact match), list(), remove(path). Write scene.js to publish a complete confined Preact scene. Writes are atomic and live; use book.patchState for fast presentation changes. write/edit return compact revision receipts.';
    },
  });

  const taskManager = makeBookTaskManager({
    getRecord: () => record,
    commit,
    serialize,
    assertPath,
    launch: options.launchTask,
    notify: options.notifyTask,
  });
  const book = makeExo('WhylipBook', BookInterface, {
    ...taskManager.methods,
    initialize(source, state = {}) {
      assertRecord(state);
      if (!source || source.length > MAX_FILE_LENGTH)
        throw makeError(X`Invalid initial scene source`);
      return serialize(async () => {
        if (Object.hasOwn(record.files, 'scene.js')) return snapshot();
        return commit({
          ...record,
          files: { ...record.files, 'scene.js': source },
          state,
          sourceRevision: record.sourceRevision + 1n,
        });
      });
    },
    getSnapshot() {
      return serialize(async () => snapshot());
    },
    getContext() {
      return serialize(async () => context());
    },
    getFiles() {
      return files;
    },
    followChanges() {
      return serialize(async () => {
        // Coalesce an idle subscriber to the newest full snapshot. There is no
        // gap between the first snapshot and registering its listener.
        /** @type {BookSnapshot | undefined} */
        let pending = snapshot();
        /** @type {((value: IteratorResult<BookSnapshot, undefined>) => void) | undefined} */
        let resolveNext;
        let closed = false;
        let started = false;
        const offer = current => {
          if (resolveNext) {
            const resolve = resolveNext;
            resolveNext = undefined;
            resolve({ done: false, value: current });
          } else {
            pending = current;
          }
        };
        const cancel = () => {
          closed = true;
          pending = undefined;
          listeners.delete(offer);
          if (resolveNext) resolveNext({ done: true, value: undefined });
          resolveNext = undefined;
        };
        listeners.add(offer);
        const iterator = {
          [Symbol.asyncIterator]() {
            return this;
          },
          /** @returns {Promise<IteratorResult<BookSnapshot, undefined>>} */
          next() {
            if (closed)
              return Promise.resolve({ done: true, value: undefined });
            if (pending) {
              const value = pending;
              pending = undefined;
              return Promise.resolve({ done: false, value });
            }
            return new Promise(resolve => {
              resolveNext = resolve;
            });
          },
          /** @returns {Promise<IteratorReturnResult<undefined>>} */
          async return() {
            cancel();
            return { done: true, value: undefined };
          },
        };
        const pump = makeReaderPump(iterator);
        return makeExo('WhylipBookReader', ReaderInterface, {
          readPattern() {
            return M.record();
          },
          readReturnPattern() {
            return M.undefined();
          },
          stream(syn) {
            if (started)
              throw makeError(X`A book subscription can only be consumed once`);
            started = true;
            return pump(syn);
          },
          cancel,
        });
      });
    },
    updateState(patch) {
      assertRecord(patch);
      return serialize(async () =>
        commit({ ...record, state: { ...record.state, ...patch } }),
      );
    },
    patchState(patch) {
      assertRecord(patch);
      return serialize(async () => {
        await commit({ ...record, state: { ...record.state, ...patch } });
        return receipt();
      });
    },
    act(name, detail = null) {
      if (!name || name.length > 200)
        throw makeError(X`Invalid story event name`);
      assertJson(detail);
      if (JSON.stringify(detail).length > MAX_EVENT_LENGTH)
        throw makeError(X`Story event is too large`);
      return serialize(async () => {
        if (
          record.pendingEvents.length >= 100 ||
          record.activeEventIds.length >= 100
        )
          throw makeError(
            X`Story event queue is full; wait for the storyteller`,
          );
        const event = harden({
          id: String(record.nextEvent),
          name,
          detail,
          state: record.state,
          revision: String(record.revision),
          sourceRevision: String(record.sourceRevision),
        });
        await commit({
          ...record,
          nextEvent: record.nextEvent + 1n,
          pendingEvents: [...record.pendingEvents, event],
          activeEventIds: [...record.activeEventIds, event.id],
          activeEvents: [...record.activeEvents, event],
        });
        return event;
      });
    },
    finishEvent(id, narrative = '') {
      if (narrative.length > MAX_EVENT_LENGTH)
        throw makeError(X`Book message is too large`);
      return serialize(async () => {
        if (!record.activeEventIds.includes(id)) return receipt();
        await commit({
          ...record,
          pendingEvents: record.pendingEvents.filter(event => event.id !== id),
          activeEvents: record.activeEvents.filter(event => event.id !== id),
          activeEventIds: record.activeEventIds.filter(
            activeId => activeId !== id,
          ),
          completedEventIds: [...record.completedEventIds, id].slice(-100),
          messages: narrative
            ? [
                ...record.messages,
                { id: `event-${id}`, role: 'assistant', content: narrative },
              ].slice(-100)
            : record.messages,
        });
        return receipt();
      });
    },
    failEvent(id, reason) {
      if (!reason || reason.length > 8192)
        throw makeError(X`Invalid story failure reason`);
      return serialize(async () => {
        if (!record.activeEventIds.includes(id)) return receipt();
        const event =
          record.activeEvents.find(item => item.id === id) ||
          record.pendingEvents.find(item => item.id === id) ||
          null;
        await commit({
          ...record,
          pendingEvents: record.pendingEvents.filter(item => item.id !== id),
          activeEvents: record.activeEvents.filter(item => item.id !== id),
          activeEventIds: record.activeEventIds.filter(
            activeId => activeId !== id,
          ),
          completedEventIds: [...record.completedEventIds, id].slice(-100),
          failedEvents: [...record.failedEvents, { id, reason, event }].slice(
            -100,
          ),
        });
        return receipt();
      });
    },
    retryEvent(id) {
      return serialize(async () => {
        const failure = record.failedEvents.find(item => item.id === id);
        if (!failure?.event)
          throw makeError(
            X`This failed story event cannot be retried; send a new message`,
          );
        if (
          record.pendingEvents.length >= 100 ||
          record.activeEventIds.length >= 100
        )
          throw makeError(
            X`Story event queue is full; wait for the storyteller`,
          );
        const event = harden({
          id: String(record.nextEvent),
          name: failure.event.name,
          detail: failure.event.detail,
          state: record.state,
          revision: String(record.revision),
          sourceRevision: String(record.sourceRevision),
        });
        await commit({
          ...record,
          nextEvent: record.nextEvent + 1n,
          pendingEvents: [...record.pendingEvents, event],
          activeEvents: [...record.activeEvents, event],
          activeEventIds: [...record.activeEventIds, event.id],
          failedEvents: record.failedEvents.filter(item => item.id !== id),
        });
        return event;
      });
    },
    pendingEvents() {
      return serialize(async () => record.pendingEvents);
    },
    recordMessage(role, content, id) {
      if (
        !['user', 'assistant', 'system'].includes(role) ||
        !id ||
        id.length > 1024 ||
        content.length > MAX_EVENT_LENGTH
      )
        throw makeError(X`Invalid book message`);
      return serialize(async () => {
        if (record.messages.some(message => message.id === id))
          return receipt();
        await commit({
          ...record,
          messages: [...record.messages, { id, role, content }].slice(-100),
        });
        return receipt();
      });
    },
    ackEvent(id) {
      return serialize(async () => {
        if (!record.pendingEvents.some(event => event.id === id))
          return receipt();
        await commit({
          ...record,
          pendingEvents: record.pendingEvents.filter(event => event.id !== id),
        });
        return receipt();
      });
    },
    help() {
      return 'Persistent interactive storybook. getContext() (lightweight), getSnapshot() (full source and history), getFiles(), patchState(patch) (compact revision receipt), updateState(patch) (shallow merge), act(name, detail) records a reader story moment, ackEvent(id) acknowledges delivery, followChanges() streams full snapshots (cancel on disconnect). startTask(title, instructions) delegates a background draft helper; listTasks(), getTask(id), applyTask(id, expectedSourceRevision) manage drafts. scene.js is a confined Preact component expression. Keep source stable for state-only changes.';
    },
  });
  taskManager.resume();
  return book;
};
harden(makeBookSession);
