// @ts-check
/* eslint-disable no-await-in-loop */
import { E } from '@endo/eventual-send';

/**
 * Retry a factory creation without adopting an unrelated pre-existing agent.
 * The factory's private request record precedes provisioning; a completed
 * publication can be recovered after its return value was lost. Incomplete
 * publications fail closed and retain their evidence for repair.
 * Call under the same owner lock used by createAgent.
 * @param {{ powers:any, host:any, name:string,
 * options:{systemPrompt?:string,pin:boolean,maxSubagentDepth:number},
 * create:Function, driverSpecifier:string, spawnerSpecifier:string,
 * workloadEnv:Record<string,string>, maxSubagents:number }} args
 */
export const provideAgentLocator = async ({
  powers,
  host,
  name,
  options,
  create,
  driverSpecifier,
  spawnerSpecifier,
  workloadEnv,
  maxSubagents,
}) => {
  const path = ['creation-requests', name];
  const record = [...path, 'request'];
  const signature = JSON.stringify({
    systemPrompt: options.systemPrompt || '',
    pin: options.pin ?? false,
    maxSubagentDepth: options.maxSubagentDepth,
    owner: await E(host).identify('@agent'),
    provider: await E(powers).identify('llm-provider'),
    auth: (await E(powers).has('llm-auth-secret'))
      ? await E(powers).identify('llm-auth-secret')
      : null,
  });
  const hasRequest =
    (await E(powers).has('creation-requests')) &&
    (await E(powers).has(...path)) &&
    (await E(powers).has(...record));
  if (hasRequest) {
    if ((await E(powers).lookup(record)) !== signature)
      throw Error('Fae creation request conflicts with the existing request');
  } else {
    // Do not reserve an existing agent made through another API/request.
    for (const alias of [
      name,
      `profile-for-${name}`,
      `${name}-driver`,
      `${name}-driver-handle`,
      `profile-for-${name}-driver-handle`,
      `${name}-spawner`,
      `${name}-spawner-handle`,
      `profile-for-${name}-spawner-handle`,
    ]) {
      if (await E(host).has(alias))
        throw Error('Fae agent name is already in use');
    }
    if (await E(host).has('@pins', `${name}-driver`))
      throw Error('Fae driver pin is already in use');
    if (!(await E(powers).has('creation-requests')))
      await E(powers).makeDirectory('creation-requests');
    if (!(await E(powers).has(...path))) await E(powers).makeDirectory(path);
    await E(powers).storeValue(signature, record);
  }

  const completionPath = [...path, 'completion'];
  if (!(await E(powers).has(...completionPath))) {
    if (await E(host).has(name))
      throw Error('Fae creation publication is incomplete; repair is required');
    const result = await create(name, options);
    await E(powers).storeValue(
      harden({
        handle: await E(host).identify(name),
        guest: await E(host).identify(`profile-for-${name}`),
        driver: await E(host).identify(`${name}-driver`),
      }),
      completionPath,
    );
    return result.locator;
  }
  const completed = await E(powers).lookup(completionPath);

  const diagnostics = await E(host).diagnostics();
  const ownerId = await E(host).identify('@agent');
  const guestId = await E(host).identify(`profile-for-${name}`);
  const handleId = await E(host).identify(name);
  if (
    completed.handle !== handleId ||
    completed.guest !== guestId ||
    completed.driver !== (await E(host).identify(`${name}-driver`))
  )
    throw Error('Fae completed creation identity changed');
  const checkGuest = async (id, handle) => {
    const formula = await E(diagnostics).getFormula(id);
    const handleFormula = await E(diagnostics).getFormula(handle);
    if (
      formula.type !== 'guest' ||
      formula.properties.hostAgent?.identifier !== ownerId ||
      formula.properties.handle?.identifier !== handle ||
      handleFormula.type !== 'handle' ||
      handleFormula.properties.agent?.identifier !== id
    )
      throw Error('Fae creation ownership is incomplete or changed');
  };
  await checkGuest(guestId, handleId);
  const driverId = await E(host).identify(`${name}-driver`);
  const driverPowersId = await E(host).identify(
    `profile-for-${name}-driver-handle`,
  );
  await checkGuest(
    driverPowersId,
    await E(host).identify(`${name}-driver-handle`),
  );
  const checkCaplet = async (id, guest, specifier, expectedEnv) => {
    const formula = await E(diagnostics).getFormula(id);
    if (
      formula.type !== 'make-unconfined' ||
      formula.properties.specifier?.value !== specifier ||
      formula.properties.powers?.identifier !== guest ||
      formula.properties.worker?.identifier !==
        (await E(host).identify('@main'))
    )
      throw Error('Fae creation runtime is incomplete or changed');
    const actualEnv = await E(host).getFormulaEnvironment(id);
    if (
      Object.keys(actualEnv).length !== Object.keys(expectedEnv).length ||
      Object.entries(expectedEnv).some(
        ([key, value]) => actualEnv[key] !== value,
      )
    )
      throw Error('Fae creation configuration changed');
  };
  await checkCaplet(driverId, driverPowersId, driverSpecifier, {
    FAE_SYSTEM_PROMPT: options.systemPrompt || '',
    FAE_SUBAGENT_PROMPT: '',
    ...workloadEnv,
  });
  const driver = await E(host).lookup(`profile-for-${name}-driver-handle`);
  const checkAuth = async guest => {
    const expected = await E(powers).has('llm-auth-secret');
    if (
      (await E(guest).has('llm-auth-secret')) !== expected ||
      (expected &&
        (await E(guest).identify('llm-auth-secret')) !==
          (await E(powers).identify('llm-auth-secret')))
    )
      throw Error('Fae creation authentication authority changed');
  };
  await checkAuth(driver);
  if (
    (await E(driver).identify('agent')) !== guestId ||
    (await E(driver).identify('llm-provider')) !==
      (await E(powers).identify('llm-provider'))
  )
    throw Error('Fae creation dependencies changed');
  if (
    typeof options.maxSubagentDepth === 'number' &&
    options.maxSubagentDepth > 0
  ) {
    const spawnerId = await E(host).identify(`${name}-spawner`);
    const spawnerPowersId = await E(host).identify(
      `profile-for-${name}-spawner-handle`,
    );
    await checkGuest(
      spawnerPowersId,
      await E(host).identify(`${name}-spawner-handle`),
    );
    await checkCaplet(spawnerId, spawnerPowersId, spawnerSpecifier, {
      SUBAGENT_PARENT: name,
      SUBAGENT_DEPTH: '1',
      SUBAGENT_MAX_DEPTH: `${options.maxSubagentDepth}`,
      SUBAGENT_MAX_COUNT: `${maxSubagents}`,
      ...workloadEnv,
      SUBAGENT_SYSTEM_PROMPT: options.systemPrompt || '',
    });
    if ((await E(driver).identify('subagent-spawner')) !== spawnerId)
      throw Error('Fae creation spawner changed');
    const spawner = await E(host).lookup(`profile-for-${name}-spawner-handle`);
    if (
      (await E(spawner).identify('host-agent')) !== ownerId ||
      (await E(spawner).identify('llm-provider')) !==
        (await E(powers).identify('llm-provider'))
    )
      throw Error('Fae creation spawner authority changed');
    await checkAuth(spawner);
  } else if (await E(driver).has('subagent-spawner')) {
    throw Error('Fae creation delegation changed');
  }
  if (options.pin) {
    if (
      (await E(host).identify('@pins', `${name}-driver`)) !== driverId ||
      (await E(host).identify(
        `profile-for-${name}`,
        '@pins',
        `${name}-driver`,
      )) !== driverId
    )
      throw Error('Fae creation recovery pins are incomplete or changed');
  }
  return E(host).locate(name);
};
harden(provideAgentLocator);
