// @ts-check
/* eslint-disable no-await-in-loop */
import { E } from '@endo/eventual-send';
import { stableModuleSpecifier } from './src/module-specifier.js';
import { pullRequestCharts } from './review-charts.js';

const publicName = 'rsi-review-deploy';
const workflow = harden(['@pins', 'installations', 'workflow']);
const specifier = stableModuleSpecifier('./rsi-review.js', import.meta.url);
/** @param {any} root @param {readonly string[]} path */
const hasPath = async (root, path) => {
  for (let i = 1; i <= path.length; i += 1) {
    if (!(await E(root).has(...path.slice(0, i)))) return false;
  }
  return true;
};

/**
 * Publish a proposal-only connection whose private powers hold the installed
 * PR verifier and two fixed, independently reviewed deployment factories.
 * @param {any} root
 * @param {{dir:string,factoryHost:any}} options
 */
export const provisionRsiReview = async (root, { dir, factoryHost }) => {
  const path = ['@pins', 'installations', 'fae', 'reviewed-deployments', dir];
  const servicePath = [...workflow, 'service'];
  const powersPath = [...path, 'powers'];
  const connectionPath = [...path, 'connection'];
  if (
    !(await E(factoryHost).has('rsi-pull-requests')) ||
    !(await hasPath(root, servicePath)) ||
    !(await E(root).has('controller-for-nixos-admin'))
  ) {
    // Retract both new grants and previously issued facets on loss of a prerequisite.
    if (await hasPath(root, [...powersPath, 'settings']))
      await E(root).remove(...powersPath, 'settings');
    if (await E(factoryHost).has(publicName))
      await E(factoryHost).remove(publicName);
    return false;
  }
  const diagnostics = await E(root).diagnostics();
  const reviewerPath = [...workflow, 'rsi-reviewer'];
  const reviewerSource = (await hasPath(root, reviewerPath))
    ? reviewerPath
    : ['@self'];
  const reviewerId = await E(root).identify(...reviewerSource);
  if ((await E(diagnostics).getFormula(reviewerId)).type !== 'handle')
    throw Error('RSI reviewer must be a mail handle');

  const serviceId = await E(root).identify(...servicePath);
  const performerId = await E(root).identify('controller-for-nixos-admin');
  const operatorId = await E(root).identify('@self');
  const service = await E(root).lookupById(serviceId);
  const endowments = harden({
    reviewer: await E(root).lookupById(reviewerId),
    operator: await E(root).lookupById(operatorId),
    performer: await E(root).lookupById(performerId),
  });
  await E(root).provideDirectory(powersPath);
  if (await hasPath(root, connectionPath)) {
    const record = await E(diagnostics).getFormula(
      await E(root).identify(...connectionPath),
    );
    if (
      record.type !== 'make-unconfined' ||
      record.properties.specifier?.value !== specifier ||
      record.properties.powers?.identifier !==
        (await E(root).identify(...powersPath)) ||
      record.properties.worker?.identifier !== (await E(root).identify('@main'))
    )
      throw Error('RSI review connection ownership changed');
  }
  const directory = await E(root).lookup(powersPath);
  const factories = {};
  for (const [repo, chart] of Object.entries(pullRequestCharts)) {
    const key = await E(service).install(chart);
    const scope = [key, serviceId, performerId, operatorId, reviewerId];
    // Once a run starts, its own durable bindings settle that particular review.
    // A reviewer change affects subsequently submitted proposals.
    const previous =
      (await E(directory).has(repo)) && (await E(directory).lookup(repo));
    if (
      previous &&
      previous.scope.length === scope.length &&
      scope.every((id, i) => id === previous.scope[i])
    ) {
      const descriptor = await E(E(service).factory(previous.fid)).describe();
      if (
        descriptor.chartName === chart.name &&
        descriptor.chartVersion === chart.version &&
        !descriptor.revoked
      ) {
        factories[repo] = previous.fid;
        // eslint-disable-next-line no-continue -- This verified factory already exists.
        continue;
      }
    }
    const { fid } = await E(service).makeFactory(
      harden({ chart: key, params: { reviewers: ['reviewer'] }, endowments }),
    );
    await E(root).storeValue(harden({ scope, fid }), [...powersPath, repo]);
    factories[repo] = fid;
  }
  await E(root).storeValue(
    harden({
      broker: await E(factoryHost).lookup('rsi-pull-requests'),
      service,
      factories,
    }),
    [...powersPath, 'settings'],
  );
  if (!(await hasPath(root, connectionPath)))
    await E(root).makeUnconfined('@main', specifier, {
      powersName: powersPath,
      resultName: connectionPath,
    });
  await E(factoryHost).storeLocator(
    publicName,
    await E(root).locate(...connectionPath),
  );
  return true;
};
harden(provisionRsiReview);
