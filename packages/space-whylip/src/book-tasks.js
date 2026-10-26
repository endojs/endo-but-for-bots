// @ts-check

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

const TaskInterface = M.interface('WhylipDraftTask', {
  getContext: M.call().returns(M.promise()),
  read: M.call(M.string()).returns(M.promise()),
  write: M.call(
    M.string(),
    M.string(harden({ stringLengthLimit: Infinity })),
  ).returns(M.promise()),
  edit: M.call(M.string(), M.string(), M.string()).returns(M.promise()),
  list: M.call().returns(M.promise()),
  complete: M.call().optional(M.string()).returns(M.promise()),
  fail: M.call(M.string()).returns(M.promise()),
  help: M.call().returns(M.string()),
});

export const bookTaskGuards = harden({
  startTask: M.call(M.string(), M.string()).returns(M.promise()),
  listTasks: M.call().returns(M.promise()),
  getTask: M.call(M.string()).returns(M.promise()),
  applyTask: M.call(M.string()).optional(M.string()).returns(M.promise()),
});
harden(bookTaskGuards);

/** @param {any} task */
export const taskSummary = task =>
  harden({
    id: task.id,
    title: task.title,
    status: task.status,
    summary: task.summary,
    baseSourceRevision: task.baseSourceRevision,
    files: task.outputFiles || Object.keys(task.files).sort(),
  });
harden(taskSummary);

/**
 * Restricted draft workers can never mutate the live scene or reader state.
 * All callbacks share the book's durable transaction queue.
 * @param {{getRecord: () => any, commit: (record: any) => Promise<any>, serialize: (job: () => Promise<any>) => Promise<any>, assertPath: (path: string) => void, launch?: (id: string) => Promise<void>, notify?: (summary: any) => Promise<void>}} options
 */
export const makeBookTaskManager = ({
  getRecord,
  commit,
  serialize,
  assertPath,
  launch,
  notify,
}) => {
  /** @type {Map<string, any>} */
  const capabilities = new Map();
  /** @param {string} id */
  const find = id => {
    const task = getRecord().tasks.find(item => item.id === id);
    if (!task) throw makeError(X`Unknown book task ${q(id)}`);
    return task;
  };
  /** @param {any} task */
  const save = task =>
    commit({
      ...getRecord(),
      tasks: getRecord().tasks.map(item => (item.id === task.id ? task : item)),
    });
  const notifications = new Set();
  /** @param {string} id */
  const notifyCompletion = id => {
    if (!notify || notifications.has(id)) return;
    notifications.add(id);
    const work = serialize(async () => {
      const task = find(id);
      if (task.notified !== false || !task.notificationStatus) return null;
      return harden({ ...taskSummary(task), status: task.notificationStatus });
    }).then(async summary => {
      await null;
      if (!summary) return;
      await notify(summary);
      await serialize(async () => {
        await null;
        const task = find(id);
        if (task.notified === false) await save({ ...task, notified: true });
      });
    });
    // A failed send remains in the durable outbox and is retried on resume.
    work.catch(() => {}).finally(() => notifications.delete(id));
  };
  /** @param {any} task */
  const assertWritable = task => {
    if (!['queued', 'running'].includes(task.status))
      throw makeError(X`This draft task is already closed`);
  };
  /**
   * @param {string} id
   * @param {'completed' | 'failed'} status
   * @param {string} summary
   */
  const finish = (id, status, summary) =>
    serialize(async () => {
      if (summary.length > 8192) throw makeError(X`Task summary is too long`);
      const task = find(id);
      if (!['queued', 'running'].includes(task.status)) {
        notifyCompletion(id);
        return taskSummary(task);
      }
      const next =
        status === 'failed'
          ? {
              ...task,
              status,
              summary,
              notified: false,
              notificationStatus: status,
              baseFiles: {},
              baseState: {},
              files: {},
              instructions: '',
            }
          : {
              ...task,
              status,
              summary,
              notified: false,
              notificationStatus: status,
            };
      await save(next);
      const result = taskSummary(next);
      notifyCompletion(id);
      return result;
    });
  /** @param {string} id */
  const run = id => {
    if (!launch) return;
    const pending = serialize(async () => {
      const task = find(id);
      if (!['queued', 'running'].includes(task.status)) return false;
      await save({ ...task, status: 'running' });
      return true;
    }).then(async shouldLaunch => {
      await null;
      if (shouldLaunch) await launch(id);
    });
    pending.catch(error =>
      finish(
        id,
        'failed',
        `Could not start helper: ${String(error).slice(0, 1000)}`,
      ).catch(() => {}),
    );
  };
  /** @param {string} id */
  const getTask = id => {
    find(id);
    if (capabilities.has(id)) return capabilities.get(id);
    /**
     * @param {string} path
     * @param {string} text
     */
    const write = async (path, text) => {
      assertPath(path);
      const task = find(id);
      assertWritable(task);
      if (text.length > 1024 * 1024)
        throw makeError(X`Draft file is too large`);
      /** @type {Record<string,string>} */
      const files = { ...task.files, [path]: text };
      if (
        Object.keys(files).length > 32 ||
        Object.values(files).reduce(
          (sum, content) => sum + String(content).length,
          0,
        ) >
          2 * 1024 * 1024
      )
        throw makeError(X`Draft storage limit exceeded`);
      await save({ ...task, files });
      return harden({ id, path, status: task.status });
    };
    const cap = makeExo('WhylipDraftTask', TaskInterface, {
      getContext() {
        return serialize(async () => {
          const task = find(id);
          return harden({
            ...taskSummary(task),
            instructions: task.instructions,
            source: task.baseFiles['scene.js'] || '',
            state: task.baseState,
            assetPaths: task.baseAssetPaths,
          });
        });
      },
      read(path) {
        assertPath(path);
        return serialize(async () => {
          const task = find(id);
          if (Object.hasOwn(task.files, path)) return task.files[path];
          if (Object.hasOwn(task.baseFiles, path)) return task.baseFiles[path];
          throw makeError(X`No draft file ${q(path)}`);
        });
      },
      write(path, text) {
        return serialize(() => write(path, text));
      },
      edit(path, oldText, newText) {
        assertPath(path);
        if (!oldText) throw makeError(X`An edit must match nonempty text`);
        return serialize(async () => {
          const task = find(id);
          const current = task.files[path] ?? task.baseFiles[path];
          if (current === undefined)
            throw makeError(X`No draft file ${q(path)}`);
          const index = current.indexOf(oldText);
          if (index === -1 || current.indexOf(oldText, index + 1) !== -1)
            throw makeError(X`Draft edit must match exactly once`);
          return write(
            path,
            current.slice(0, index) +
              newText +
              current.slice(index + oldText.length),
          );
        });
      },
      list() {
        return serialize(async () =>
          harden(
            [
              ...new Set([
                ...Object.keys(find(id).baseFiles),
                ...Object.keys(find(id).files),
              ]),
            ].sort(),
          ),
        );
      },
      complete(summary = '') {
        return finish(id, 'completed', summary);
      },
      fail(reason) {
        return finish(id, 'failed', reason);
      },
      help() {
        return 'Restricted story draft: getContext() gives your assignment and frozen base scene/state. read/write/edit/list operate only on your draft. Write illustrations as assets/<unique-name>.svg. complete(summary) alerts the main storyteller; fail(reason) reports failure. You cannot change the live book, reader state, or other drafts.';
      },
    });
    capabilities.set(id, cap);
    return cap;
  };
  return harden({
    resume() {
      for (const task of getRecord().tasks) {
        if (['queued', 'running'].includes(task.status)) run(task.id);
        else if (task.notified === false) notifyCompletion(task.id);
      }
    },
    methods: {
      /**
       * @param {string} title
       * @param {string} instructions
       */
      startTask(title, instructions) {
        if (
          !title ||
          title.length > 200 ||
          !instructions ||
          instructions.length > 64 * 1024
        )
          throw makeError(X`Invalid draft task assignment`);
        return serialize(async () => {
          const record = getRecord();
          /** @type {any[]} */
          const previousTasks = record.tasks;
          if (
            previousTasks.filter(task =>
              ['queued', 'running'].includes(task.status),
            ).length >= 2
          )
            throw makeError(X`Two story helpers are already working`);
          let tasks = previousTasks;
          if (tasks.length >= 8) {
            const disposable = tasks.find(
              task =>
                ['failed', 'applied'].includes(task.status) &&
                task.notified !== false,
            );
            if (!disposable)
              throw makeError(
                X`Apply completed drafts before starting more helpers`,
              );
            tasks = tasks.filter(task => task.id !== disposable.id);
            capabilities.delete(disposable.id);
          }
          const task = harden({
            id: String(record.nextTask),
            title,
            instructions,
            status: 'queued',
            summary: '',
            notified: true,
            notificationStatus: '',
            baseSourceRevision: String(record.sourceRevision),
            baseFiles: { 'scene.js': record.files['scene.js'] || '' },
            baseAssetPaths: Object.keys(record.files).filter(path =>
              path.startsWith('assets/'),
            ),
            baseState: record.state,
            files: {},
          });
          await commit({
            ...record,
            nextTask: record.nextTask + 1n,
            tasks: [...tasks, task],
          });
          run(task.id);
          return taskSummary(task);
        });
      },
      listTasks() {
        return serialize(async () =>
          harden(getRecord().tasks.map(taskSummary)),
        );
      },
      getTask(id) {
        return serialize(async () => getTask(id));
      },
      applyTask(id, expectedSourceRevision) {
        return serialize(async () => {
          const record = getRecord();
          const task = find(id);
          if (task.status === 'applied')
            return harden({
              id,
              status: 'applied',
              sourceRevision: String(record.sourceRevision),
              revision: String(record.revision),
            });
          if (task.status !== 'completed')
            throw makeError(X`Only a completed draft can be applied`);
          const changesScene =
            Object.hasOwn(task.files, 'scene.js') &&
            task.files['scene.js'] !== record.files['scene.js'];
          if (
            changesScene &&
            (expectedSourceRevision !== String(record.sourceRevision) ||
              task.baseSourceRevision !== String(record.sourceRevision))
          )
            throw makeError(
              X`The live scene changed since this draft began; read the draft and rebase its changes`,
            );
          for (const [path, text] of Object.entries(task.files)) {
            if (
              path !== 'scene.js' &&
              Object.hasOwn(record.files, path) &&
              record.files[path] !== text
            )
              throw makeError(
                X`Draft would overwrite live asset ${q(path)}; use a new asset path`,
              );
          }
          await commit({
            ...record,
            files: { ...record.files, ...task.files },
            sourceRevision: changesScene
              ? record.sourceRevision + 1n
              : record.sourceRevision,
            tasks: record.tasks.map(item =>
              item.id === id
                ? {
                    ...task,
                    status: 'applied',
                    outputFiles: Object.keys(task.files).sort(),
                    baseFiles: {},
                    baseState: {},
                    files: {},
                    instructions: '',
                  }
                : item,
            ),
          });
          return harden({
            id,
            status: 'applied',
            sourceRevision: String(getRecord().sourceRevision),
            revision: String(getRecord().revision),
          });
        });
      },
    },
  });
};
harden(makeBookTaskManager);
