// @ts-check

/** @import { SessionRecordDirectory } from '../src/session-record-store.js' */

/**
 * Record directory semantics only: reference lookup would revive a formula,
 * while identify and list return stored IDs without doing so.
 * A named reference or text write fails after `pass…Writes` matching writes
 * have gone through, to interrupt a staged revision at a chosen write.
 * @param {{ failReference?: string, passReferenceWrites?: number, failPlan?: boolean, failText?: string, passTextWrites?: number, failRemove?: string }} [faults]
 */
export const makeDirectory = (faults = {}) => {
  let nextId = 0;
  const make = () => {
    /** @type {Map<string, { identifier: string, directory?: SessionRecordDirectory, text?: string }>} */
    const entries = new Map();
    const freshId = () => {
      nextId += 1;
      return `formula-${nextId}`;
    };
    /** @type {SessionRecordDirectory} */
    const directory = harden({
      identify: async name => entries.get(name)?.identifier,
      lookup: async name => {
        const found = entries.get(name);
        if (!found?.directory) throw Error('Unexpected formula activation');
        return found.directory;
      },
      makeDirectory: async name => {
        const child = make();
        entries.set(name, { identifier: freshId(), directory: child });
        return child;
      },
      storeIdentifier: async (name, identifier) => {
        if (faults.failReference === name) {
          const pass = faults.passReferenceWrites ?? 0;
          if (pass <= 0) throw Error('Reference write failed');
          faults.passReferenceWrites = pass - 1;
        }
        entries.set(name, { identifier });
      },
      list: async () => [...entries.keys()],
      maybeReadText: async name => entries.get(name)?.text,
      writeText: async (name, text) => {
        if (faults.failPlan) throw Error('Plan write failed');
        if (faults.failText === name) {
          const pass = faults.passTextWrites ?? 0;
          if (pass <= 0) throw Error(`Text write failed: ${name}`);
          faults.passTextWrites = pass - 1;
        }
        entries.set(name, { identifier: freshId(), text });
      },
      remove: async name => {
        if (faults.failRemove === name) throw Error('Directory removal failed');
        entries.delete(name);
      },
    });
    return directory;
  };
  return make();
};

harden(makeDirectory);
