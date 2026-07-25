// @ts-check
// Floot's built-in capability tools, factored out of agent.js so the exact
// same toolset backs both the API-provider agent loop AND the per-session MCP
// bridge that exposes them to a Claude Code CLI session (src/mcp-bridge.js).
//
// The tools are bound to one guest's `powers`: `exec` runs arbitrary JS with
// that guest's authority, the petstore ops (list/lookup/store/remove) act on
// that guest's directory, and the mail ops (listMessages/adopt/send/reply)
// speak for that guest. Caplet tools dropped into the guest's `tools/`
// directory are discovered on top of these each turn (see @endo/fae's
// discoverTools), so the surface grows at runtime. Keeping construction here —
// rather than duplicated per consumer — guarantees a CLI session sees exactly
// the authority a non-CLI Floot session does.

import { E } from '@endo/eventual-send';

import {
  makeExecTool,
  makeListPetnamesTool,
  makeLookupTool,
  makeStoreTool,
  makeRemoveTool,
  makeAdoptTool,
  makeSendTool,
  makeReplyTool,
} from '@endo/fae/src/tool-makers.js';

/**
 * fae's stock listMessages tool returns raw records whose `number` is a BigInt
 * (and so does not stringify cleanly for a model). Floot formats a readable
 * summary — number, sender, type, text, and the edge names of any attached
 * objects — so `adopt` has everything it needs from one call.
 *
 * @param {any} powers - a guest's powers (mailbox surface).
 * @returns {import('@endo/fae/src/tool-makers.js').FaeTool}
 */
export const makeListMessagesSummaryTool = powers =>
  harden({
    schema: () =>
      harden({
        type: 'function',
        function: {
          name: 'listMessages',
          description:
            'List messages in your inbox. Each entry has its number, sender, ' +
            'type, text, and the edge names of any attached objects. Use an ' +
            'edge name together with the message number to adopt an object.',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      }),
    execute: async () => {
      const msgs = await E(powers).listMessages();
      const summary = (Array.isArray(msgs) ? msgs : []).map(m => ({
        number: Number(m.number),
        from: m.from,
        type: m.type,
        text: Array.isArray(m.strings) ? m.strings.join('') : undefined,
        edgeNames: Array.isArray(m.names) ? m.names : [],
      }));
      return JSON.stringify(summary, null, 2);
    },
    help: () => 'List inbox messages with their numbers and edge names.',
  });
harden(makeListMessagesSummaryTool);

/**
 * Build the map of Floot's built-in tools bound to one guest's `powers`.
 * `exec` is the most general (arbitrary JS with `powers`); the rest are
 * explicit petstore/mail operations.
 *
 * @param {any} powers - a guest's powers.
 * @returns {Map<string, import('@endo/fae/src/tool-makers.js').FaeTool>}
 */
export const makeFlootLocalTools = powers => {
  /** @type {Map<string, any>} */
  const localTools = new Map();
  localTools.set('exec', makeExecTool(powers));
  localTools.set('list', makeListPetnamesTool(powers));
  localTools.set('lookup', makeLookupTool(powers));
  localTools.set('store', makeStoreTool(powers));
  localTools.set('remove', makeRemoveTool(powers));
  localTools.set('listMessages', makeListMessagesSummaryTool(powers));
  localTools.set('adopt', makeAdoptTool(powers));
  localTools.set('send', makeSendTool(powers));
  localTools.set('reply', makeReplyTool(powers));
  return localTools;
};
harden(makeFlootLocalTools);
