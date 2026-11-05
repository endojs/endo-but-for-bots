// @ts-check

import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
// The daemon does not depend on hosted-agent; its tests reach it by location.
// eslint-disable-next-line import/no-relative-packages
import { makeAnthropicApiKeyIssuerFactory } from '../../hosted-agent/src/anthropic-api-key-issuer.js';

const FakeIssuerInterface = M.interface('FakeAnthropicIssuer', {
  openEndpoint: M.callWhen(M.record(), M.remotable(), M.record()).returns(
    M.remotable(),
  ),
  disposeProvider: M.callWhen(M.string()).returns(M.undefined()),
  discoverModels: M.callWhen(M.record(), M.remotable()).returns(M.record()),
  setReply: M.call(M.string()).returns(M.undefined()),
  hold: M.call().returns(M.undefined()),
  release: M.call().returns(M.undefined()),
  observed: M.call().returns(M.record()),
});

const encoder = new TextEncoder();

/**
 * The real Anthropic adapter over a fake upstream, so refusals, settlement and
 * cancellation take their real path through the registry and broker. It lives
 * in the daemon's worker, and tests steer it over the same reference.
 */
export const make = async () => {
  let reply = 'fake answer';
  let holding = false;
  /** @type {Array<() => void>} */
  let releases = [];
  /** @type {{ requests: number, prompts: string[], aborted: number, keys: string[] }} */
  const seen = { requests: 0, prompts: [], aborted: 0, keys: [] };

  const streamOf = text => {
    const events = [
      {
        type: 'message_start',
        message: {
          id: 'message-1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 1 },
      },
      { type: 'message_stop' },
    ];
    return events
      .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      .join('');
  };

  const fetch = async (input, init) => {
    if (String(input).includes('/v1/models')) {
      return new Response(
        JSON.stringify({
          data: [{ type: 'model', id: 'claude-test', display_name: 'Test' }],
          has_more: false,
          last_id: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    seen.requests += 1;
    const body = JSON.parse(String(init.body));
    seen.prompts.push(JSON.stringify(body.messages.at(-1)));
    if (holding) {
      await new Promise((resolve, reject) => {
        releases.push(() => resolve(undefined));
        init.signal?.addEventListener('abort', () => {
          seen.aborted += 1;
          reject(Error('aborted'));
        });
      });
    }
    return new Response(encoder.encode(streamOf(reply)), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const made = makeAnthropicApiKeyIssuerFactory({ fetch });
  return makeExo('FakeAnthropicIssuer', FakeIssuerInterface, {
    openEndpoint: (provider, secret, spec) =>
      made.factory.openEndpoint(provider, secret, spec),
    disposeProvider: providerId => made.factory.disposeProvider(providerId),
    discoverModels: (provider, secret) =>
      made.factory.discoverModels(provider, secret),
    setReply: text => {
      reply = text;
    },
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const release of releases) release();
      releases = [];
    },
    observed: () =>
      harden({
        requests: seen.requests,
        prompts: [...seen.prompts],
        aborted: seen.aborted,
      }),
  });
};
harden(make);
