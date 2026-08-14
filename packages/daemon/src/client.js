// @ts-check
/* global process */

import net from 'net';
import { makeNodeReader, makeNodeWriter } from '@endo/stream-node';
import { makeNetstringCapTP, makeNetstringSlots } from './connection.js';

/**
 * @template TBootstrap
 * @param {string} name
 * @param {string} sockPath
 * @param {Promise<void>} cancelled
 * @param {TBootstrap} [bootstrap]
 * @param {import('@endo/captp').CapTPOptions} [capTpOptions]
 */
export const makeEndoClient = async (
  name,
  sockPath,
  cancelled,
  bootstrap,
  capTpOptions = undefined,
) => {
  const conn = net.connect(sockPath);
  await new Promise((resolve, reject) => {
    conn.on('connect', resolve);
    conn.on('error', (/** @type {any} */ error) => {
      if (error.code === 'ENOENT') {
        reject(
          new Error(
            `Cannot connect to Endo. Is Endo running? ${error.message}`,
          ),
        );
      } else {
        reject(error);
      }
    });
  });

  // Under ENDO_USE_SLOT_MACHINE=1 the daemon's external listener
  // speaks slot-machine on its private socket; clients must speak
  // the same wire protocol.  Otherwise default to CapTP.
  if (
    typeof process !== 'undefined' &&
    process.env.ENDO_USE_SLOT_MACHINE === '1'
  ) {
    return makeNetstringSlots(
      name,
      makeNodeWriter(conn),
      makeNodeReader(conn),
      cancelled,
      bootstrap,
    );
  }

  return makeNetstringCapTP(
    name,
    makeNodeWriter(conn),
    makeNodeReader(conn),
    cancelled,
    bootstrap,
    capTpOptions,
  );
};
