/* global process */
import os from 'os';
import { E } from '@endo/far';
import { withEndoAgent } from '../context.js';

/**
 * `endo http mk <controller-name> <client-name> --origin <url> ...`
 *
 * Phase 1 of designs/cli-http-client.md.  Constructs a paired HTTP
 * controller + client capability and registers the two facets under
 * the given pet names.  Further `endo http` verbs (`allow`, `deny`,
 * `revoke`, `inspect`) and the per-policy controls land in later
 * phases.
 *
 * @param {object} args
 * @param {string} args.controllerName
 * @param {string} args.clientName
 * @param {string[]} args.allowedOrigins
 * @param {string[] | undefined} args.agentNames
 */
export const httpMk = async ({
  controllerName,
  clientName,
  allowedOrigins,
  agentNames,
}) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
      throw new Error(
        'endo http mk requires at least one --origin <url> entry',
      );
    }
    await E(agent).makeHttpClient(controllerName, clientName, allowedOrigins);
    console.log(controllerName);
    console.log(clientName);
  });
