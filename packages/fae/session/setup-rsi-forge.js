// @ts-check
import { E } from '@endo/eventual-send';
import { stableModuleSpecifier } from '../src/module-specifier.js';

const owner = harden(['@pins', 'installations', 'rsi']);
const forgePath = harden([...owner, 'forge']);
const accessPath = harden([...owner, 'forge-access']);
const secretPath = harden(['secrets', 'rsi-forgejo-password']);
const specifier = stableModuleSpecifier('./rsi-forge.js', import.meta.url);

/** @param {any} host @param {readonly string[]} path */
const hasPath = async (host, path) => {
  for (let n = 1; n <= path.length; n += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await E(host).has(...path.slice(0, n)))) return false;
  }
  return true;
};

/** @param {any} host @param {any} profile @param {Record<string,string|undefined>} env */
export const provisionRsiForge = async (host, profile, env) => {
  const enabled =
    env.ENDO_FORGEJO_URL === 'https://git.goooooo.ooo' &&
    (await hasPath(host, secretPath));
  const grant = 'rsi-pull-requests';
  const installed = await hasPath(host, owner);
  if (!enabled && !installed) {
    if (await E(profile).has(grant))
      throw Error('Conflicting RSI Forgejo grant');
    return;
  }
  if (enabled && !installed) {
    await E(host).provideDirectory(owner.slice(0, 2));
    await E(host).provideDirectory(owner);
  }
  const existing = await E(host).identify(...forgePath);
  const granted = await E(profile).identify(grant);
  const conflictingGrant = granted && granted !== existing;
  if (enabled && conflictingGrant) throw Error('Conflicting RSI Forgejo grant');
  let accessId = await E(host).identify(...accessPath);
  const diagnostics = await E(host).diagnostics();
  const settings = harden({ RSI_FORGEJO_USER: 'floot-rsi' });
  if (existing) {
    const formula = await E(diagnostics).getFormula(existing);
    const retained = await E(host).getFormulaEnvironment(existing);
    if (
      !accessId ||
      formula.type !== 'make-unconfined' ||
      formula.properties.specifier?.value !== specifier ||
      formula.properties.worker?.identifier !==
        (await E(host).identify('@main')) ||
      formula.properties.powers?.identifier !== accessId ||
      Object.keys(retained).length !== 1 ||
      retained.RSI_FORGEJO_USER !== settings.RSI_FORGEJO_USER
    )
      throw Error('Unexpected RSI Forgejo installation');
  }
  if (!accessId && enabled) {
    await E(host).provideDirectory(accessPath);
    accessId = await E(host).identify(...accessPath);
  }
  if (
    accessId &&
    (await E(diagnostics).getFormula(accessId)).type !== 'directory'
  )
    throw Error('Invalid RSI credential directory');
  const binding = harden([...accessPath, 'credential']);
  if (!enabled) {
    // Previously granted formula references can reincarnate. Withdrawing the
    // private binding makes further requests fail even through those references.
    if (accessId && (await E(host).has(...binding)))
      await E(host).remove(...binding);
    // A foreign alias cannot keep previously issued RSI capabilities alive.
    if (conflictingGrant) throw Error('Conflicting RSI Forgejo grant');
    if (granted) await E(profile).remove(grant);
    return;
  }
  if (!accessId) throw Error('Missing RSI credential directory');
  await E(host).copy(secretPath, binding);
  if (!existing)
    await E(host).makeUnconfined('@main', specifier, {
      powersName: accessPath,
      resultName: forgePath,
      env: settings,
    });
  if (!granted)
    await E(profile).storeLocator(grant, await E(host).locate(...forgePath));
};
harden(provisionRsiForge);
