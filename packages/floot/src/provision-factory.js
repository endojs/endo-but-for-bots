// @ts-check

import { E } from '@endo/eventual-send';

/**
 * Keep one registry writer across setup reruns. Reuse a matching formula;
 * cancellation and its disposal drain must finish before replacing one.
 * @param {object} options
 * @param {any} options.agent
 * @param {string[]} options.controllerPath
 * @param {string[]} options.pinPath
 * @param {string | string[]} options.powersName
 * @param {string} options.specifier
 * @param {Record<string, string>} options.env
 */
export const provisionFlootFactory = async ({
  agent,
  controllerPath,
  pinPath,
  powersName,
  specifier,
  env,
}) => {
  const path = typeof powersName === 'string' ? [powersName] : powersName;
  const powersId = await E(agent).identify(...path);
  const controllerId = await E(agent).identify(...controllerPath);
  const pinId = await E(agent).identify(...pinPath);
  /** @param {string} id */
  const inspect = async id => {
    const formula = await E(agent).getFormula(id);
    if (
      formula.type !== 'make-unconfined' ||
      formula.properties.powers?.identifier !== powersId ||
      typeof formula.properties.specifier?.value !== 'string' ||
      !formula.properties.specifier.value.endsWith('/floot/agent.js')
    ) {
      throw Error(
        'Unexpected Floot controller formula; preserve it for inspection',
      );
    }
    return formula;
  };
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
