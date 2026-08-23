// examples.test.js — smoke tests that keep the worked examples runnable.
import { h } from 'preact';
import { renderConfined, unmount } from '@endo/preact-container/renderer';
import { confineComponent } from '@endo/preact-container/compartment';
import { makeAgentOutputExample } from '../examples/agent-output-petnames.js';
import { makeGrantCardExample } from '../examples/grant-card.js';
import { makeThreadExample } from '../examples/multi-party-thread.js';
import { derivePattern } from '../src/pattern-badge.js';
import { setupScratch, teardown } from './_util/helpers.js';

describe('examples', () => {
  /** @type {HTMLDivElement} */
  let scratch;
  beforeEach(() => {
    scratch = setupScratch();
  });
  afterEach(() => {
    unmount(scratch);
    teardown(scratch);
  });

  it('agent-output-petnames renders local names and an unnamed party', () => {
    const { AgentMessage, props } = makeAgentOutputExample();
    renderConfined(h(AgentMessage, props), scratch);
    expect(scratch.textContent).to.contain('Alexa');
    expect(scratch.textContent).to.contain('Bram');
    expect(scratch.textContent).to.contain('unnamed');
  });

  it('grant-card renders the badge, confirms with a validated amount, owns its handler', () => {
    const confirmed = [];
    const { GrantCard } = makeGrantCardExample({
      secret: 'grant-secret',
      onConfirm: amount => confirmed.push(amount),
    });
    // an untrusted chat places the grant card inline
    const Chat = confineComponent(({ h: ch }, props) =>
      ch('div', null, 'System: ', ch(props.GrantCard, { amount: '10 USD' })),
    );
    renderConfined(h(Chat, { GrantCard }), scratch);
    expect(scratch.textContent).to.contain('Approve sending 10 USD');
    const button = scratch.querySelector('.grant-confirm');
    expect(button).to.not.equal(null);
    button.click();
    expect(confirmed).to.deep.equal(['10 USD']);
  });

  it('multi-party-thread composes two attributed regions under a frame badge', () => {
    const secret = 'thread-secret';
    const { tree } = makeThreadExample({ secret });
    renderConfined(tree, scratch);
    expect(scratch.textContent).to.contain('Alexa');
    expect(scratch.textContent).to.contain('Bram');
    expect(scratch.textContent).to.contain('Shall we ship Friday?');
    expect(scratch.textContent).to.contain('Agreed — after CI is green.');
    expect(scratch.textContent).to.contain(derivePattern(secret).phrase);
    expect(scratch.querySelectorAll('.party-region')).to.have.length(2);
  });
});
