// @ts-check

import { E } from '@endo/eventual-send';
import {
  inspectSessionController,
  sessionControllerSuffix,
} from '@endo/hosted-agent/session-consumer.js';

/**
 * Keep one registry writer across setup reruns. Reuse a matching formula;
 * cancellation and its disposal drain must finish before replacing one.
 * @param {object} options
 * @param {any} options.agent
 * @param {string[]} options.controllerPath
 * @param {string[]} options.pinPath
 * @param {string | string[]} options.powersName
 * @param {string} options.specifier
 * @param {string} [options.validatedProfileId]
 * @param {string} [options.previousSpecifier] Exact origin authorized for replacement after a local checkout moves.
 * @param {Record<string, string>} options.env
 */
export const provisionFlootFactory = async ({
  agent,
  controllerPath,
  pinPath,
  powersName,
  specifier,
  previousSpecifier,
  validatedProfileId,
  env,
}) => {
  sessionControllerSuffix(specifier, previousSpecifier);
  const path = typeof powersName === 'string' ? [powersName] : powersName;
  const powersId = await E(agent).identify(...path);
  const controllerId = await E(agent).identify(...controllerPath);
  const pinId = await E(agent).identify(...pinPath);
  if (
    !powersId ||
    (validatedProfileId !== undefined && powersId !== validatedProfileId)
  )
    throw Error('Session controller profile changed during setup');
  const inspect = id =>
    inspectSessionController(agent, id, {
      profileId: powersId,
      specifier,
      previousSpecifier,
    });
  const controller = controllerId ? await inspect(controllerId) : undefined;
  if (pinId && pinId !== controllerId) {
    await inspect(pinId);
    await E(agent).cancel(pinPath);
    await E(agent).remove(...pinPath);
  }
  const priorEnv = controllerId
    ? await E(agent).getFormulaEnvironment(controllerId)
    : undefined;
  const matchingEnv =
    priorEnv &&
    Object.keys(priorEnv).length === Object.keys(env).length &&
    Object.entries(env).every(([name, value]) => priorEnv[name] === value);
  if (controller?.properties.specifier.value === specifier && matchingEnv) {
    await E(agent).copy(controllerPath, pinPath);
    return harden({ reused: true });
  }
  if (controllerId) {
    await E(agent).cancel(controllerPath);
    await E(agent).remove(...controllerPath);
  }
  if (pinId === controllerId && pinId) {
    await E(agent).remove(...pinPath);
  }
  await E(agent).makeUnconfined('@main', specifier, {
    powersName,
    resultName: controllerPath,
    env,
  });
  await E(agent).copy(controllerPath, pinPath);
  return harden({ reused: false });
};
harden(provisionFlootFactory);
