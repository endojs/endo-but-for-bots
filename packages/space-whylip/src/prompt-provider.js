// @ts-check

import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import { WHYLIP_SYSTEM_PROMPT } from './prompt.js';

const PromptProviderI = M.interface('WhylipPromptProvider', {
  chat: M.callWhen(M.arrayOf(M.record()), M.arrayOf(M.record())).returns(
    M.record(),
  ),
  getInfo: M.callWhen().returns(M.record()),
});

/**
 * Foreground-only provider adapter. Rebinding a live driver's llm-provider to
 * this capability refreshes its instructions without discarding the stored
 * user, assistant, or tool transcript. Helpers have their own task instructions
 * and must continue to use the upstream provider directly.
 *
 * The namespace needs only `upstream-provider`, a chat/getInfo capability.
 * It never receives a credential or a secret manager. Resolve the upstream per
 * call so the host can switch providers without replacing this adapter.
 *
 * @param {any} powers
 */
export const make = powers =>
  makeExo('WhylipPromptProvider', PromptProviderI, {
    async chat(messages, tools) {
      const upstream = await E(powers).lookup('upstream-provider');
      const currentMessages = harden([
        { role: 'system', content: WHYLIP_SYSTEM_PROMPT },
        ...messages.filter(message => message.role !== 'system'),
      ]);
      return E(upstream).chat(currentMessages, tools);
    },
    async getInfo() {
      const upstream = await E(powers).lookup('upstream-provider');
      return E(upstream).getInfo();
    },
  });
harden(make);
