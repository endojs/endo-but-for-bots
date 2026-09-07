// @ts-check

import { E } from '@endo/eventual-send';
import { matches, mustMatch } from '@endo/patterns';

/**
 * Typed mail settlements and the design handoff surface. Authority comes from
 * the guest's mail and an explicitly installed workflow factory, never from a
 * caller-supplied service/controller. Ordinary prose replies are not verdicts.
 * @param {any} powers
 * @param {{ settled?: Set<string> }} [options]
 */
export const makeWorkflowTools = (powers, { settled = new Set() } = {}) => {
  const tool = (name, description, properties, required, execute) =>
    harden({
      schema: () =>
        harden({
          type: 'function',
          function: {
            name,
            description,
            parameters: { type: 'object', properties, required },
          },
        }),
      execute,
      help: () => description,
    });
  const messageNumber = {
    type: 'string',
    description: 'Decimal inbox message number.',
  };
  const findMessage = async number => {
    if (!/^(0|[1-9][0-9]*)$/.test(number))
      throw Error('Expected a decimal message number');
    const message = (await E(powers).listMessages()).find(
      m => String(m.number) === number,
    );
    if (!message) throw Error('No such inbox message');
    return message;
  };
  const tools = new Map();
  tools.set(
    'resolveRequest',
    tool(
      'resolveRequest',
      'Answer a request with a typed JSON value. Use for developer submissions and reviewer verdicts; reply does not settle a request.',
      { messageNumber, value: {} },
      ['messageNumber', 'value'],
      async ({ messageNumber: number, value }) => {
        const message = await findMessage(number);
        if (message.type !== 'request')
          throw Error('Expected a request message');
        const name = `workflow-answer-${number}`;
        await E(powers).storeValue(harden(value), name);
        await E(powers).resolve(message.number, name);
        await E(powers).storeValue(true, `workflow-settled-${number}`);
        settled.add(number);
        return 'Request answered.';
      },
    ),
  );
  tools.set(
    'rejectRequest',
    tool(
      'rejectRequest',
      'Reject a request you cannot complete.',
      { messageNumber, reason: { type: 'string' } },
      ['messageNumber', 'reason'],
      async ({ messageNumber: number, reason }) => {
        const message = await findMessage(number);
        if (message.type !== 'request')
          throw Error('Expected a request message');
        await E(powers).reject(message.number, reason);
        await E(powers).storeValue(true, `workflow-settled-${number}`);
        settled.add(number);
        return 'Request rejected.';
      },
    ),
  );
  tools.set(
    'submitForm',
    tool(
      'submitForm',
      'Answer a form using typed field values. Supply bigint quantities as decimal strings.',
      { messageNumber, values: { type: 'object', additionalProperties: true } },
      ['messageNumber', 'values'],
      async ({ messageNumber: number, values }) => {
        const message = await findMessage(number);
        if (message.type !== 'form') throw Error('Expected a form message');
        const typed = {};
        for (const field of message.fields) {
          let value = values[field.name];
          if (
            !matches(harden(value), field.pattern) &&
            typeof value === 'string' &&
            /^-?[0-9]+$/.test(value)
          )
            value = BigInt(value);
          mustMatch(harden(value), field.pattern, field.name);
          typed[field.name] = value;
        }
        await E(powers).submit(message.number, harden(typed));
        await E(powers).storeValue(true, `workflow-settled-${number}`);
        settled.add(number);
        return 'Form submitted.';
      },
    ),
  );
  tools.set(
    'handoffDesign',
    tool(
      'handoffDesign',
      'After the user asks to implement an agreed design, hand it to the configured dev-review factory. Include the complete design and acceptance criteria. Returns a run to watch; readiness is delivered to the configured originating inbox. Do not use while still discussing the design.',
      {
        name: {
          type: 'string',
          description: 'Unique local name for this handoff.',
        },
        title: { type: 'string' },
        design: { type: 'string' },
        base: { type: 'string' },
        rounds: {
          type: 'string',
          description: 'Positive decimal review budget.',
        },
      },
      ['name', 'title', 'design', 'base', 'rounds'],
      async ({ name, title, design, base, rounds }) => {
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name))
          throw Error('Use a lowercase name with letters, digits, and hyphens');
        const receipt = `review-${name}`;
        if (!/^[1-9][0-9]*$/.test(rounds) || BigInt(rounds) > 0xffff_ffffn)
          throw Error('Invalid review budget');
        if (!design.trim()) throw Error('The agreed design must not be empty');
        const factory = await E(powers).lookup('dev-review');
        const result = await E(factory).start(
          harden({
            requestId: name,
            params: { title, summary: design, base, rounds: BigInt(rounds) },
          }),
        );
        await E(powers).storeValue(harden({ runId: result.runId }), receipt);
        return `Design handed off. Run ${result.runId}, stored as ${receipt}. You will be notified when review is ready or needs attention.`;
      },
    ),
  );
  tools.set(
    'reviewStatus',
    tool(
      'reviewStatus',
      'Inspect a previously handed-off design.',
      { name: { type: 'string' } },
      ['name'],
      async ({ name }) => {
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name))
          throw Error('Invalid handoff name');
        const { runId } = await E(powers).lookup(`review-${name}`);
        const connection = await E(powers).lookup('dev-review');
        const explanation = await E(connection).status(runId);
        return JSON.stringify(explanation, (_key, value) =>
          typeof value === 'bigint' ? String(value) : value,
        );
      },
    ),
  );
  const namedRun = async name => {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name))
      throw Error('Invalid handoff name');
    return E(powers).lookup(`review-${name}`);
  };
  tools.set(
    'setReviewBudget',
    tool(
      'setReviewBudget',
      'When the user asks to change the budget, set the absolute number of review rounds still available for their handoff.',
      { name: { type: 'string' }, remaining: { type: 'string' } },
      ['name', 'remaining'],
      async ({ name, remaining }) => {
        if (
          !/^(0|[1-9][0-9]*)$/.test(remaining) ||
          BigInt(remaining) > 0xffff_ffffn
        )
          throw Error('Invalid remaining budget');
        const { runId } = await namedRun(name);
        await E(await E(powers).lookup('dev-review')).setRemaining(
          runId,
          BigInt(remaining),
        );
        return 'Review budget updated.';
      },
    ),
  );
  tools.set(
    'cancelReview',
    tool(
      'cancelReview',
      'Cancel a handoff when the user asks to stop it.',
      { name: { type: 'string' }, reason: { type: 'string' } },
      ['name', 'reason'],
      async ({ name, reason }) => {
        const { runId } = await namedRun(name);
        await E(await E(powers).lookup('dev-review')).cancel(runId, reason);
        return 'Cancellation requested.';
      },
    ),
  );
  return tools;
};
harden(makeWorkflowTools);
