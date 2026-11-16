// @ts-check
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { parseId } from '@endo/daemon/formula-identifier.js';
import { makeMarshal } from '@endo/marshal';

const FACTORY_PATH = harden(['@pins', 'installations', 'whylip', 'factory']);
/** @type {WeakMap<object, Promise<unknown>>} */
const jobs = new WeakMap();

export const WHYLIP_SYSTEM_PROMPT = `You are The Whylip Primer, an illustrated primer that teaches through stories and clear examples.
Respond to incoming messages using the reply tool. Its strings parameter must contain a single JSON string with this shape:
{"narrative":"Markdown explanation","scene":{"title":"Scene title","html":"<figure><p>A simple text diagram</p><figcaption>Explanation</figcaption></figure>"}}
Use scene:null when an illustration is unnecessary. The JSON is the only reply content, without code fences. After replying, dismiss the message and stop.
Scene markup is sanitized and rendered inside the confined Preact UI. Use static semantic HTML such as headings, paragraphs, lists, tables, figures, and preformatted text diagrams. The host supplies the styling: inline styles and stylesheets are stripped. Scripts, event handlers, iframes, canvas code, external resources, and network requests are unavailable. Do not promise interactions that the renderer cannot execute. The reader can ask another question to change the scene.`;
harden(WHYLIP_SYSTEM_PROMPT);

/**
 * @param {any} host
 * @param {string[]} path
 */
const identify = async (host, path) => {
  await null;
  for (let i = 1; i <= path.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await E(host).has(...path.slice(0, i)))) return undefined;
  }
  return E(host).identify(...path);
};

/**
 * Create a book using an ordinary Fae factory. Only the book profile is public;
 * handles, pins, and recovery references stay in its installation directory.
 * A completed agent reference is retained before later host creation, allowing
 * those later steps to retry without creating another agent.
 * @param {any} root
 * @param {any} factory
 * @param {string} name
 */
const provisionBook = async (root, factory, name) => {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(name))
    throw Error('Invalid Whylip book name');
  const publicPath = ['whylip', name];
  const privatePath = ['@pins', 'installations', 'whylip', 'books', name];
  const handlePath = [...privatePath, 'handle'];
  const pinsPath = [...privatePath, 'pins'];
  const agentPath = [...privatePath, 'agent'];
  const factoryRecord = [...privatePath, 'factory'];
  const diagnostics = await E(root).diagnostics();
  const factoryId = await identify(root, FACTORY_PATH);
  if (!factoryId) throw Error('Whylip Fae factory is not installed');
  if ((await E(root).lookup(FACTORY_PATH)) !== factory)
    throw Error('Whylip factory ownership changed');
  // Refuse arbitrary namespaces before provisioning anything.
  for (const path of [
    ['whylip'],
    ...privatePath.map((_, i) => privatePath.slice(0, i + 1)),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const id = await identify(root, path);
    // eslint-disable-next-line no-await-in-loop
    if (id && (await E(diagnostics).getFormula(id)).type !== 'directory')
      throw Error('Whylip book directory conflicts with an existing object');
  }
  const existingFactory = await identify(root, factoryRecord);
  const existingAgent = await identify(root, agentPath);
  let hostId = await identify(root, publicPath);
  let handleId = await identify(root, handlePath);
  const pinsId = await identify(root, pinsPath);
  if (existingFactory && existingFactory !== factoryId)
    throw Error('Whylip book belongs to another factory');
  if (existingAgent && !existingFactory)
    throw Error('Whylip book ownership is incomplete');
  if (
    existingAgent &&
    (await E(diagnostics).getFormula(existingAgent)).type !== 'handle'
  )
    throw Error('Whylip book agent is not a mail handle');
  if (await identify(root, privatePath)) {
    const names = await E(root).list(...privatePath);
    if (
      names.some(item => !['handle', 'pins', 'agent', 'factory'].includes(item))
    )
      throw Error('Whylip book directory contains unrelated objects');
  }
  if (Boolean(hostId) !== Boolean(handleId))
    throw Error('Whylip book profile conflicts with an existing object');
  if (hostId) {
    const f = await E(diagnostics).getFormula(hostId);
    if (
      !existingAgent ||
      f.type !== 'host' ||
      f.properties.handle?.identifier !== handleId ||
      f.properties.pins?.identifier !== pinsId
    )
      throw Error('Whylip book ownership conflicts');
  }
  if (pinsId && (await E(diagnostics).getFormula(pinsId)).type !== 'directory')
    throw Error('Whylip book pins conflict');
  if (!hostId && pinsId && (await E(root).list(...pinsPath)).length)
    throw Error('Whylip book pins contain unrelated objects');
  if (hostId) {
    const book = await E(root).lookup(publicPath);
    if (
      (await E(book).has('fae')) &&
      (await E(book).identify('fae')) !== existingAgent
    )
      throw Error('Whylip book agent conflicts');
  }
  // eslint-disable-next-line no-underscore-dangle
  if (!(await E(factory).__getMethodNames__()).includes('provideAgentLocator'))
    throw Error('Update the Fae factory to support private agent locators');
  await E(root).provideDirectory(privatePath);
  if (!existingFactory) await E(root).copy(FACTORY_PATH, factoryRecord);
  const locator = await E(factory).provideAgentLocator(
    `${name}-agent`,
    harden({ systemPrompt: WHYLIP_SYSTEM_PROMPT, pin: true }),
  );
  if (existingAgent) {
    if ((await E(root).locate(...agentPath)) !== locator)
      throw Error('Whylip book agent no longer belongs to its factory');
  } else {
    if (await identify(root, agentPath))
      throw Error('Whylip book agent changed during creation');
    await E(root).storeLocator(agentPath, locator);
  }
  await E(root).provideDirectory(['whylip']);
  await E(root).provideDirectory(pinsPath);
  if (!hostId) {
    if (
      (await identify(root, publicPath)) ||
      (await identify(root, handlePath))
    )
      throw Error('Whylip book profile changed during creation');
    await E(root).provideHost(handlePath, {
      agentName: publicPath,
      pins: await E(root).lookup(pinsPath),
    });
    hostId = await identify(root, publicPath);
    handleId = await identify(root, handlePath);
  }
  const formula = await E(diagnostics).getFormula(hostId);
  if (
    formula.type !== 'host' ||
    formula.properties.handle?.identifier !== handleId ||
    formula.properties.pins?.identifier !== (await identify(root, pinsPath))
  )
    throw Error('Whylip book profile ownership changed');
  const book = await E(root).lookup(publicPath);
  const agentId = await identify(root, agentPath);
  if (await E(book).has('fae')) {
    if ((await E(book).identify('fae')) !== agentId)
      throw Error('Whylip book agent conflicts');
  } else await E(book).storeLocator('fae', await E(root).locate(...agentPath));
  return harden(publicPath);
};
harden(provisionBook);

/**
 * Serialize the complete book transaction in its daemon worker, across calls
 * and service incarnations. Browser refreshes cannot abandon a client lock.
 * @param {any} root
 * @param {() => Promise<any>} operation
 */
const serially = (root, operation) => {
  const previous = jobs.get(root) || Promise.resolve();
  const job = previous.catch(() => {}).then(operation);
  jobs.set(root, job);
  const release = () => {
    if (jobs.get(root) === job) jobs.delete(root);
  };
  void job.then(release, release);
  return job;
};
/**
 * @param {any} root
 * @param {any} factory
 * @param {string} name
 */
export const createWhylipBook = (root, factory, name) =>
  serially(root, () => provisionBook(root, factory, name));
harden(createWhylipBook);

/**
 * Reopen a saved view without replacing its preferences. Serialization and
 * live directory reads make stale browser maps and lost save acknowledgements
 * harmless. Numeric legacy views are reused; new canonical books use one key.
 * @param {any} root
 * @param {any} factory
 * @param {any} config
 */
export const provideWhylipSpace = (root, factory, config) =>
  serially(root, async () => {
    const path = config?.profilePath;
    const displayName = /** @type {string} */ (config?.name);
    const icon = /** @type {string} */ (config?.icon);
    if (
      config?.mode !== 'whylip' ||
      !Array.isArray(path) ||
      path.length !== 2 ||
      path[0] !== 'whylip' ||
      typeof path[1] !== 'string' ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(path[1]) ||
      typeof displayName !== 'string' ||
      !displayName ||
      displayName.length > 200 ||
      typeof icon !== 'string' ||
      icon.length > 100 ||
      ![
        'auto',
        'light',
        'dark',
        'high-contrast-light',
        'high-contrast-dark',
      ].includes(config.scheme ?? 'auto')
    )
      throw Error('Invalid Whylip saved space');
    await provisionBook(root, factory, path[1]);
    const { number } = parseId(await E(root).identify('@self'));
    const storage = ['@pins', 'installations', 'chat', number, 'spaces'];
    await E(root).provideDirectory(storage, { adoptFrom: ['spaces'] });
    const id = `whylip-${path[1]}`;
    const diagnostics = await E(root).diagnostics();
    const decode = makeMarshal().fromCapData;
    const names = await E(root).list(...storage);
    let existing;
    for (const key of [...names].sort()) {
      // Inspect inert records only, never instantiate an unknown saved capability.
      // eslint-disable-next-line no-await-in-loop
      const identity = await E(root).identify(...storage, key);
      // eslint-disable-next-line no-await-in-loop
      const formula = await E(diagnostics).getFormula(identity);
      const { body, slots } = formula.properties;
      if (
        formula.type !== 'marshal' ||
        body?.kind !== 'literal' ||
        typeof body.value !== 'string' ||
        slots?.kind !== 'reference-list' ||
        !slots.entries ||
        Object.keys(slots.entries).length
      )
        throw Error('Saved space is not inert configuration');
      const value = decode({ body: body.value, slots: [] });
      const matches =
        value?.mode === 'whylip' &&
        Array.isArray(value.profilePath) &&
        value.profilePath.length === 2 &&
        value.profilePath.every((part, index) => part === path[index]);
      if (key === id && !matches)
        throw Error('Whylip saved space key conflicts');
      if (matches) {
        if (value.id !== key)
          throw Error('Whylip saved space identity conflicts');
        existing ??= value;
      }
    }
    if (existing) return existing;
    const value = harden({
      id,
      name: config.name,
      icon: config.icon,
      profilePath: path,
      mode: 'whylip',
      scheme: config.scheme ?? 'auto',
    });
    await E(root).storeValue(value, [...storage, id]);
    return value;
  });
harden(provideWhylipSpace);

const BooksInterface = M.interface('WhylipBooks', {
  getOwnerIdentity: M.callWhen().returns(M.string()),
  createBook: M.callWhen(M.string()).returns(M.arrayOf(M.string())),
  provideSpace: M.callWhen(M.any()).returns(M.any()),
  help: M.call().returns(M.string()),
});
/** @param {any} powers */
export const make = async powers => {
  const root = await E(powers).lookup('root-host');
  const factory = await E(powers).lookup('factory');
  return makeExo('WhylipBooks', BooksInterface, {
    getOwnerIdentity: () => E(root).identify('@self'),
    createBook: name => createWhylipBook(root, factory, name),
    provideSpace: config => provideWhylipSpace(root, factory, config),
    help: () =>
      'createBook(name) — Create or reopen an illustrated Whylip primer with the installed ordinary Fae factory. Book names contain up to 80 letters, digits, hyphens or underscores and start with a letter. Retries reuse completed agent and profile identities; conflicting or incomplete ownership fails without replacement. provideSpace({name, icon, mode:"whylip", profilePath:["whylip", bookName], scheme?}) — Save one sidebar view, reusing any existing view and its preferences. New views use the stable key whylip-bookName.',
  });
};
harden(make);
