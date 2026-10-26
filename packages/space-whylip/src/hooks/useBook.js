// @ts-check
/* eslint-disable no-await-in-loop */

import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import { ensureBook } from '../book-client.js';
import { STARTER_SCENE, STARTER_STATE } from '../starter-scene.js';

const INITIAL = harden({
  source: STARTER_SCENE,
  state: STARTER_STATE,
  revision: '0',
  messages: [],
  activeEventIds: [],
  failedEvents: [],
});

/**
 * Connect the persistent book to the reader. Local patches render immediately;
 * the write queue preserves their order and overlays them on arriving snapshots
 * until the corresponding durable writes acknowledge them.
 * @param {any} powers
 */
export const useBook = powers => {
  const [view, setView] = useState(/** @type {any} */ (INITIAL));
  const [error, setError] = useState(/** @type {string | null} */ (null));
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const connection = useRef(/** @type {any} */ (null));

  useEffect(() => {
    let cancelled = false;
    let book;
    let changesReader;
    let changesIterator;
    let latest = /** @type {any} */ (INITIAL);
    /** @type {Array<{patch: Record<string, unknown>}>} */
    const pending = [];
    let writes = Promise.resolve();
    let delivering = false;

    setView(INITIAL);
    setReady(false);
    setError(null);

    const fail = err => {
      if (!cancelled)
        setError(err instanceof Error ? err.message : String(err));
    };

    const display = () => {
      if (cancelled) return;
      const state = pending.reduce(
        (value, entry) => ({ ...value, ...entry.patch }),
        { ...latest.state },
      );
      setView({ ...latest, state });
    };

    const accept = snapshot => {
      if (BigInt(snapshot.revision) >= BigInt(latest.revision))
        latest = snapshot;
      display();
    };

    const enqueue = job => {
      const result = writes.then(async () => {
        if (!cancelled) await job();
      });
      writes = result.catch(fail);
      return writes;
    };

    // A durable outbox gives reconnects at-least-once delivery. The event id
    // lets the agent recognize a replay after send succeeded but ack failed.
    const deliver = async () => {
      if (delivering || cancelled) return;
      delivering = true;
      try {
        while (!cancelled) {
          const events = await E(book).pendingEvents();
          if (!events.length) break;
          const event = events[0];
          await E(powers).send(
            'fae',
            [
              `WHYLIP_EVENT\n${JSON.stringify(event)}\n\n` +
                'Use E(powers).lookup("book"). For a quick response, getContext(), ' +
                'patchState(), finishEvent(event.id, optionalNarration), then dismiss. ' +
                'Do not read scene.js unless changing its structure. Use files.edit for small edits. ' +
                'If completedEventIds or failedEvents already contains this id, only dismiss it. ',
            ],
            [],
            [],
          );
          await E(book).ackEvent(event.id);
        }
      } finally {
        delivering = false;
      }
    };

    const updateState = patch => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        fail(Error('Scene updates must be objects.'));
        return;
      }
      let clean;
      try {
        clean = JSON.parse(JSON.stringify(patch));
      } catch {
        fail(Error('Scene updates must contain JSON data.'));
        return;
      }
      const entry = { patch: clean };
      pending.push(entry);
      display();
      enqueue(async () => {
        try {
          const snapshot = await E(book).updateState(harden(clean));
          if (snapshot) accept(snapshot);
        } finally {
          const index = pending.indexOf(entry);
          if (index !== -1) pending.splice(index, 1);
          display();
        }
      });
    };

    const act = (name, detail = {}) =>
      enqueue(async () => {
        setError(null);
        const event = await E(book).act(
          name,
          harden(JSON.parse(JSON.stringify(detail))),
        );
        const content =
          name === 'message'
            ? detail.text
            : typeof detail.choice === 'string'
              ? detail.choice
              : name;
        await E(book).recordMessage(
          'user',
          String(content),
          `event:${event.id}`,
        );
        await deliver();
      });

    const retryStory = id =>
      enqueue(async () => {
        setError(null);
        await E(book).retryEvent(id);
        await deliver();
      });

    const start = async () => {
      try {
        book = await ensureBook(powers);
        if (cancelled) return;
        // followChanges includes the current snapshot atomically with subscribe.
        changesReader = await E(book).followChanges();
        if (cancelled) {
          await E(changesReader).cancel();
          return;
        }
        accept(await E(book).getSnapshot());
        if (cancelled) return;
        connection.current = { updateState, act, retryStory };
        setReady(true);
        changesIterator = iterateReader(changesReader);
        const follow = async () => {
          for await (const snapshot of changesIterator) {
            if (cancelled) break;
            accept(snapshot);
          }
        };
        follow().catch(fail);

        await deliver();
      } catch (err) {
        fail(err);
      }
    };
    start();

    return () => {
      cancelled = true;
      connection.current = null;
      if (changesReader)
        E(changesReader)
          .cancel()
          .catch(() => {});
      if (changesIterator) changesIterator.return().catch(() => {});
    };
  }, [powers, attempt]);

  const updateState = useCallback(patch => {
    if (connection.current) connection.current.updateState(patch);
  }, []);
  const act = useCallback((name, detail) => {
    if (connection.current) return connection.current.act(name, detail);
    setError('The book is still connecting. Try again once it is ready.');
    return undefined;
  }, []);
  const send = useCallback(
    text => {
      if (text.trim()) return act('message', { text: text.trim() });
      return undefined;
    },
    [act],
  );
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const retryStory = useCallback(id => {
    if (connection.current) return connection.current.retryStory(id);
    return undefined;
  }, []);
  const storyFailure = view.failedEvents?.at(-1) || null;

  return {
    ...view,
    ready,
    error,
    storyFailure,
    status: error ? 'error' : view.activeEventIds.length ? 'thinking' : 'idle',
    updateState,
    act,
    send,
    retry,
    retryStory,
  };
};
harden(useBook);
