// @ts-check

export { makeDynamoControl } from './src/control.js';
export { makeMemoryCursorSealer } from './src/cursor.js';
export {
  makeMemoryGrantStore,
  reincarnateDynamoControl,
} from './src/grant-store.js';
export { DynamoCapabilityInterface } from './src/type-guards.js';
export { marshalItem, unmarshalItem } from './src/marshal.js';
