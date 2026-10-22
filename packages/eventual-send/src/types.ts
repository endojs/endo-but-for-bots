// spell-out-exempt -- preserves established public callable parameter names
/* eslint-disable import/export */

// Module Types //////////////////////////////////////////////////////
//
//   Types exposed from modules.
//

// @ts-ignore TS1383: Only named exports may use 'export type'.
export type * from './E.js';
// @ts-ignore TS1383: Only named exports may use 'export type'.
export type * from './handled-promise.js';
// @ts-ignore TS1383: Only named exports may use 'export type'.
export type * from './track-turns.js';

// Utility Types /////////////////////////////////////////////////////
//
//   Types exposed to modules.
//

export type Callable = (...args: any[]) => any;

// TODO(https://github.com/endojs/endo/issues/2979): We likely want to merge
// the RemotableObject symbol shape into this type to reduce confusion about
// why both exist, but all kinds of things blow up when trying to do that.

/**
 * Nominal type to carry the local and remote interfaces of a Remotable.
 *
 * Note: this type does not currently include the structural aspect of the
 * {@link RemotableObject} type, and as such is not suitable to represent a
 * "remotable" for APIs that expect an object with a pass-style symbol.
 */
declare const RemotableBrandSymbol: unique symbol;

export type RemotableBrand<Local, Remote> = {
  readonly [RemotableBrandSymbol]: {
    /** The local properties of the object. */
    readonly local: Local;

    /** The type of all the remotely-callable functions. */
    readonly remote: Remote;
  };
};
