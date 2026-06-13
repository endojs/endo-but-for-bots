// @ts-check
//
// Builder Mode: the `define` plane. A template is a saved, powerless agent
// definition — prompt, cap SHAPE (declared, not bound), model, compaction. The
// garden's roles become templates (designs/garden-cockpit.md § Template). The
// store seeds three garden roles so the cockpit opens with a usable library;
// persistence (data-in-repo vs registry) is design open-question 3 and is left
// in memory for the MVP.

import { READ_ONLY, READ_WRITE } from './caps.js';

/** @typedef {{ name: string, kind: string, mode?: string }} CapShapeEntry */
/** @typedef {{ name: string, prompt: string, capShape: CapShapeEntry[], model: string, compaction: string }} Template */

const SEED = [
  {
    name: 'builder',
    prompt: 'Implement the change and open a draft PR.',
    capShape: [
      { name: 'workspace', kind: 'workspace', mode: READ_WRITE },
      { name: 'git', kind: 'git', mode: READ_WRITE },
    ],
    model: 'mock',
    compaction: 'none',
  },
  {
    name: 'investigator',
    prompt: 'Inspect the repository and report findings. Read only.',
    capShape: [
      { name: 'workspace', kind: 'workspace', mode: READ_ONLY },
      { name: 'git', kind: 'git', mode: READ_ONLY },
    ],
    model: 'mock',
    compaction: 'none',
  },
  {
    name: 'liaison',
    prompt: 'Orchestrate. Delegate to children with attenuated authority.',
    capShape: [
      { name: 'workspace', kind: 'workspace', mode: READ_WRITE },
      { name: 'git', kind: 'git', mode: READ_WRITE },
    ],
    model: 'mock',
    compaction: 'none',
  },
];

const freeze = Object.freeze;

/**
 * @param {{ name: string, prompt?: string, capShape?: CapShapeEntry[], model?: string, compaction?: string }} spec
 * @returns {Template}
 */
const normalize = ({ name, prompt = '', capShape = [], model = 'mock', compaction = 'none' }) => {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('template name required');
  }
  return freeze({
    name,
    prompt: String(prompt),
    capShape: freeze(
      capShape.map(c => freeze({ name: c.name, kind: c.kind, mode: c.mode })),
    ),
    model: String(model),
    compaction: String(compaction),
  });
};

export const makeTemplateStore = () => {
  /** @type {Map<string, Template>} */
  const templates = new Map();
  /** @param {Parameters<typeof normalize>[0]} spec */
  const define = spec => {
    const tpl = normalize(spec);
    templates.set(tpl.name, tpl);
    return tpl;
  };
  for (const seed of SEED) define(seed);
  return {
    define,
    get: name => templates.get(name),
    list: () => [...templates.values()],
    remove: name => templates.delete(name),
  };
};
