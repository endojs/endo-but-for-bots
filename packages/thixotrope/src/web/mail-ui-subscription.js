// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * One upstream projection per service, shared by its browser connections.
 * Old durable objects retain their original interfaces and use the legacy path.
 * @param {object} options
 * @param {any} options.mailbox
 * @param {any} options.inventory
 * @param {any} options.contacts
 * @param {(state: any) => any} options.project
 * @param {(onState: (state: any) => void, onError: (error: Error) => void) => Promise<() => Promise<void>>} options.legacySubscribe
 */
export const makeMailUiSubscription = ({
  mailbox,
  inventory,
  contacts,
  project,
  legacySubscribe,
}) => {
  /** @type {any} */
  let current;
  /**
   * @param {(state: any) => void} onState
   * @param {(error: Error) => void} onError
   */
  const subscribe = async (onState, onError) => {
    let cohort = current;
    if (cohort === undefined) {
      cohort = {
        clients: new Set(),
        latest: undefined,
        opening: undefined,
        active: true,
      };
      current = cohort;
    }
    const client = { onState, onError };
    cohort.clients.add(client);
    const publish = state => {
      if (!cohort.active) return;
      cohort.latest = state;
      for (const observer of cohort.clients) observer.onState(state);
    };
    const fail = reason => {
      if (!cohort.active) return;
      cohort.active = false;
      if (current === cohort) current = undefined;
      for (const observer of cohort.clients) observer.onError(reason);
    };
    if (cohort.latest !== undefined) onState(cohort.latest);
    cohort.opening ??= (async () => {
      const methods = await Promise.all(
        [mailbox, inventory, contacts].map(ref =>
          // eslint-disable-next-line no-underscore-dangle -- CapTP introspection.
          E(ref).__getMethodNames__(),
        ),
      );
      if (
        !methods[0].includes('subscribeInboxEntries') ||
        !methods[0].includes('subscribeOutboxEntries') ||
        !methods[1].includes('subscribeEntries') ||
        !methods[2].includes('subscribeEntries')
      ) {
        return legacySubscribe(publish, fail);
      }
      const state = {
        inbox: new Map(),
        outbox: new Map(),
        inventory: new Map(),
        contacts: new Map(),
        statuses: new Map(),
      };
      const initialized = new Set();
      /** @type {any[]} */
      const handles = [];
      /** @type {Map<any, {active: boolean, handle?: any}>} */
      const contactHandles = new Map();
      let active = true;
      const emit = () => {
        if (
          active &&
          initialized.size === 4 &&
          [...state.contacts.values()].every(ref => state.statuses.has(ref))
        ) {
          publish(project(state));
        }
      };
      const close = async () => {
        active = false;
        for (const record of contactHandles.values()) {
          record.active = false;
          if (record.handle) handles.push(record.handle);
        }
        contactHandles.clear();
        for (const entries of Object.values(state)) entries.clear();
        await Promise.allSettled(
          handles.splice(0).map(handle => E(handle).unsubscribe()),
        );
      };
      const failed = reason => {
        fail(reason);
        void close();
      };
      const reconcile = () => {
        const wanted = new Set(state.contacts.values());
        for (const [ref, record] of contactHandles) {
          if (!wanted.has(ref)) {
            record.active = false;
            contactHandles.delete(ref);
            state.statuses.delete(ref);
            if (record.handle) {
              void Promise.allSettled([E(record.handle).unsubscribe()]);
            }
          }
        }
        for (const ref of wanted) {
          // eslint-disable-next-line no-continue -- Already observing this contact.
          if (contactHandles.has(ref)) continue;
          const record = { active: true, handle: undefined };
          contactHandles.set(ref, record);
          void (async () => {
            // eslint-disable-next-line no-underscore-dangle -- CapTP introspection.
            const names = await E(ref).__getMethodNames__();
            if (!active || !record.active) return;
            if (!names.includes('subscribeStatus')) {
              const status = await E(ref).status();
              if (active && record.active) {
                state.statuses.set(ref, status);
                emit();
              }
              return;
            }
            const listener = Far('MailContactStatus', {
              changed: status => {
                if (active && record.active) {
                  state.statuses.set(ref, status);
                  emit();
                }
              },
            });
            const handle = await E(ref).subscribeStatus(listener);
            if (active && record.active) record.handle = handle;
            else await E(handle).unsubscribe();
          })().catch(reason => {
            if (active && record.active) failed(reason);
          });
        }
      };
      /** @param {'inbox' | 'outbox' | 'inventory' | 'contacts'} name */
      const listenerFor = name =>
        Far('MailEntries', {
          changed: update => {
            if (!active) return;
            const entries = state[name];
            if (update.reset) entries.clear();
            for (const key of update.deleted) entries.delete(key);
            for (const [key, value] of update.entries) {
              // Names use latest-set precedence; message outcome changes must
              // retain their original position in the conversation.
              if (name === 'inventory' || name === 'contacts') {
                entries.delete(key);
              }
              entries.set(key, value);
            }
            initialized.add(name);
            if (name === 'contacts') reconcile();
            emit();
          },
        });
      try {
        const openings = [
          E(mailbox).subscribeInboxEntries(listenerFor('inbox'), true),
          E(mailbox).subscribeOutboxEntries(listenerFor('outbox'), true),
          E(inventory).subscribeEntries(listenerFor('inventory'), true),
          E(contacts).subscribeEntries(listenerFor('contacts'), true),
        ];
        const results = await Promise.allSettled(openings);
        for (const result of results) {
          if (result.status === 'fulfilled') handles.push(result.value);
        }
        const rejected = results.find(result => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        if (!active) await close();
        return close;
      } catch (reason) {
        await close();
        throw reason;
      }
    })();
    try {
      await cohort.opening;
    } catch (reason) {
      cohort.clients.delete(client);
      fail(reason);
      throw reason;
    }
    let closed = false;
    return harden(async () => {
      if (closed) return;
      closed = true;
      cohort.clients.delete(client);
      if (cohort.clients.size === 0) {
        cohort.active = false;
        if (current === cohort) current = undefined;
        const close = await cohort.opening;
        await close();
      }
    });
  };
  return harden(subscribe);
};
harden(makeMailUiSubscription);
