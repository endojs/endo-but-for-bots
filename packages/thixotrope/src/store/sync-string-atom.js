// @ts-check
/**
 * A synchronously durable string slot. An absent value reads as undefined.
 * A successful write transfers responsibility for recovering the exact string
 * to the implementation before the caller may perform its next effect.
 * @typedef {object} SyncStringAtom
 * @property {() => string | undefined} read
 * @property {(value: string) => void} write
 */
export {};
