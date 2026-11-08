// @ts-check
import { E } from '@endo/eventual-send';

/**
 * Verify the root's designated child host and its actual mail handle before
 * handing the host subscription or operator capabilities.
 * @param {any} host
 * @param {string | undefined} profileId
 * @param {string | undefined} handleId
 */
export const inspectSessionProfile = async (host, profileId, handleId) => {
  if (!profileId || !handleId)
    throw Error('Incomplete session controller profile');
  const diagnostics = await E(host).diagnostics();
  const [profile, handle, parent] = await Promise.all([
    E(diagnostics).getFormula(profileId),
    E(diagnostics).getFormula(handleId),
    E(host).identify('@self'),
  ]);
  if (
    !parent ||
    profile.type !== 'host' ||
    profile.properties.hostHandle?.identifier !== parent ||
    profile.properties.handle?.identifier !== handleId ||
    handle.type !== 'handle' ||
    handle.properties.agent?.identifier !== profileId
  )
    throw Error('Unexpected session controller profile or handle');
  return profileId;
};
harden(inspectSessionProfile);

/** @param {string} specifier @param {string} [previousSpecifier] */
export const sessionControllerSuffix = (specifier, previousSpecifier) => {
  const suffix = [
    '/packages/fae/session-factory.js',
    '/packages/floot/agent.js',
  ].find(path => specifier.startsWith('file:///') && specifier.endsWith(path));
  if (!suffix) throw Error('Unknown session factory module');
  if (
    previousSpecifier !== undefined &&
    (!previousSpecifier.startsWith('file:///') ||
      !previousSpecifier.endsWith(suffix))
  )
    throw Error('Unexpected prior session factory entry point');
  return suffix;
};
harden(sessionControllerSuffix);

/**
 * Verify a retained controller before resolving it or introducing capabilities
 * to its host. Release-directory substitutions apply only under the known
 * hosted state root. Local installations must name their exact checkout.
 * @param {any} host
 * @param {string} controllerId
 * @param {{profileId: string, specifier: string, localSpecifier?: string, previousSpecifier?: string}} expected
 */
export const inspectSessionController = async (
  host,
  controllerId,
  { profileId, specifier, localSpecifier, previousSpecifier },
) => {
  const suffix = sessionControllerSuffix(specifier, previousSpecifier);
  const diagnostics = await E(host).diagnostics();
  const [formula, worker] = await Promise.all([
    E(diagnostics).getFormula(controllerId),
    E(host).identify('@main'),
  ]);
  const stored = formula.properties.specifier?.value;
  const stable =
    typeof stored === 'string'
      ? stored.replace(
          /^file:\/\/\/var\/lib\/endo\/releases\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\//,
          'file:///var/lib/endo/current/',
        )
      : undefined;
  const local =
    localSpecifier || new URL(`../../..${suffix}`, import.meta.url).href;
  if (
    !profileId ||
    !worker ||
    formula.type !== 'make-unconfined' ||
    formula.properties.powers?.identifier !== profileId ||
    formula.properties.worker?.identifier !== worker ||
    typeof stored !== 'string' ||
    !(
      stored === specifier ||
      stored === local ||
      stored === previousSpecifier ||
      stable === `file:///var/lib/endo/current${suffix}`
    )
  )
    throw Error(
      'Unexpected Floot controller formula; preserve it for inspection',
    );
  return formula;
};
harden(inspectSessionController);
