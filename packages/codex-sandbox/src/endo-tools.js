// @ts-check

import { Fail } from '@endo/errors';

/** Keep the guest JavaScript tool distinct from Codex's native exec tool.
 * The versioned catalog identity forces old threads to rotate instead of
 * silently changing what a previously named tool means.
 * @param {{dynamicTools:Array<any>, toolSetId:string}} catalog
 */
export const adaptEndoTools = catalog => {
  !catalog.dynamicTools.some(tool => tool.name === 'endo_exec') ||
    Fail`Endo tool name endo_exec is reserved by the Codex adapter`;
  return harden({
    dynamicTools: catalog.dynamicTools.map(tool =>
      tool.name === 'exec' ? { ...tool, name: 'endo_exec' } : tool,
    ),
    toolSetId: JSON.stringify(['CodexEndoToolsV1', catalog.toolSetId]),
    originalName: name => (name === 'endo_exec' ? 'exec' : name),
  });
};
harden(adaptEndoTools);

/** Apply the adapter instruction after choosing the caller's per-turn prompt.
 * @param {Record<string, any>} [options]
 * @param {string} [fallback]
 * @returns {Record<string, any> & {systemPrompt:string}}
 */
export const withEndoToolInstructions = (options = {}, fallback = '') =>
  harden({
    ...options,
    systemPrompt: `${options.systemPrompt || options.developerInstructions || fallback}\nFor Endo guest JavaScript, call endo_exec with a code string. It provides E and powers; Codex's native exec does not.`,
  });
harden(withEndoToolInstructions);
