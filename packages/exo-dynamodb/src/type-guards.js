// @ts-check

import { M } from '@endo/patterns';

/**
 * The records crossing this interface are checked in the broker with explicit,
 * versioned limits. M.any() avoids silently inheriting pattern default limits.
 */
export const DynamoCapabilityInterface = M.interface('DynamoCapability', {
  derive: M.call(M.any()).optional(M.any()).returns(M.promise()),
  get: M.call(M.any()).optional(M.any()).returns(M.promise()),
  put: M.call(M.any()).optional(M.any()).returns(M.promise()),
  update: M.call(M.any(), M.any()).optional(M.any()).returns(M.promise()),
  delete: M.call(M.any()).optional(M.any()).returns(M.promise()),
  query: M.call(M.any()).returns(M.promise()),
  transactGet: M.call(M.any()).returns(M.promise()),
  transactWrite: M.call(M.any()).optional(M.any()).returns(M.promise()),
});
