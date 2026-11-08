// @ts-check
import { M } from '@endo/patterns';
import { makeSessionTurn as makeAgentTurn } from '@endo/fae/session/session-turn.js';
import { speakTurn } from './turn-speech.js';

export const spokenTurnView = harden({
  guards: {
    speak: M.callWhen(M.await(M.any()))
      .optional(M.record())
      .returns(M.remotable()),
  },
  methods: (/** @type {() => any} */ watch) => ({
    speak: (ttsServer, ttsOptions = {}) =>
      speakTurn({ watch, ttsServer, ttsOptions }),
  }),
});
harden(spokenTurnView);

/** @param {Parameters<typeof makeAgentTurn>[0]} options */
export const makeSessionTurn = options =>
  makeAgentTurn(options, spokenTurnView);
harden(makeSessionTurn);
