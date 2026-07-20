import { constants } from 'node:fs';

/**
 * @returns {typeof import('node:fs').constants.F_OK}
 */
export function bambalam() {
  return constants.F_OK;
}
