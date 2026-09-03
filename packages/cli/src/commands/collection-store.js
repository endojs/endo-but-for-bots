import os from 'os';
import { E } from '@endo/eventual-send';
import { withEndoAgent } from '../context.js';
import { parsePetNamePath } from '../pet-name.js';

/**
 * @param {string} text
 * @param {boolean} asJson
 */
const parsePassable = (text, asJson) => (asJson ? JSON.parse(text) : text);

/** @param {unknown} value */
const printPassable = value => {
  const text = JSON.stringify(value, (_key, nested) =>
    typeof nested === 'bigint' ? `${nested}n` : nested,
  );
  console.log(text === undefined ? String(value) : text);
};

/**
 * Drive a named strong map or set. Both kinds use the same command shape:
 * `<kind> <name> <verb> [key] [value]`, so a verb that exists on both kinds
 * always takes the name and key in the same positions.
 *
 * @param {object} options
 * @param {'map' | 'set'} options.kind
 * @param {string} options.name
 * @param {string} options.verb
 * @param {string[]} options.argumentsList
 * @param {boolean} options.asJson
 * @param {string | undefined} options.resultName
 * @param {string | undefined} options.agentNames
 */
export const collectionStore = async ({
  kind,
  name,
  verb,
  argumentsList,
  asJson,
  resultName,
  agentNames,
}) =>
  withEndoAgent(agentNames, { os, process }, async ({ agent }) => {
    await null;
    const store = E(agent).lookup(parsePetNamePath(name));
    const values = argumentsList.map(argument =>
      parsePassable(argument, asJson),
    );
    const requireArguments = count => {
      if (values.length !== count) {
        throw new Error(
          `${kind} ${verb} requires ${count} argument${count === 1 ? '' : 's'}`,
        );
      }
    };

    if (verb === 'has') {
      requireArguments(1);
      printPassable(await E(store).has(values[0]));
    } else if (verb === 'delete' || verb === 'rm') {
      requireArguments(1);
      await E(store).delete(values[0]);
    } else if (verb === 'size') {
      requireArguments(0);
      printPassable(await E(store).getSize());
    } else if (verb === 'keys' || verb === 'values' || verb === 'entries') {
      requireArguments(0);
      printPassable(await E(store)[verb]());
    } else if (verb === 'snapshot') {
      requireArguments(0);
      if (resultName === undefined) {
        throw new Error(`${kind} snapshot requires --name`);
      }
      const snapshot = await E(store).snapshot();
      await E(agent).storeValue(snapshot, parsePetNamePath(resultName));
    } else if (kind === 'map' && verb === 'init') {
      requireArguments(2);
      await E(store).init(values[0], values[1]);
    } else if (kind === 'map' && verb === 'set') {
      requireArguments(2);
      await E(store).set(values[0], values[1]);
    } else if (kind === 'map' && verb === 'get') {
      requireArguments(1);
      printPassable(await E(store).get(values[0]));
    } else if (kind === 'set' && verb === 'add') {
      requireArguments(1);
      await E(store).add(values[0]);
    } else {
      throw new Error(`Unknown ${kind} verb ${verb}`);
    }
  });
