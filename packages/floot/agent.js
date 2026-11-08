// @ts-check
// Retained Floot controller URL. Fae owns execution and storage; Floot
// supplies the speech view and persists the user's presentation preferences.
import { M } from '@endo/patterns';
import { make as makeSessionFactory } from '@endo/fae/session-factory.js';
import { makeVoicePreferences } from './src/voice-preferences.js';
import { flootIntroduction } from './src/voice-prompt.js';
import { spokenTurnView } from './src/session-turn.js';

export {
  makeStreamingAgent,
  getPreset,
  composeSessionSystemPrompt,
} from '@endo/fae/session-factory.js';

/** @param {any} powers @param {any} [context] @param {any} [options] */
export const make = (powers, context, options) => {
  const preferences = makeVoicePreferences(powers);
  return makeSessionFactory(powers, context, options, {
    drain: preferences.drain,
    introduction: flootIntroduction,
    factoryHelp:
      ' Use createAssistantSession() to start the selected voice preset. createSession({spoken: true}) adds instructions for a spoken reply. Use turn.speak(ttsServer, options?) to hear a response, and getVoicePreferences()/setVoicePreferences(prefs) for speech settings.',
    help: {
      createAssistantSession:
        'createAssistantSession() starts a new spoken session with the selected voice preset.',
      setVoicePreset:
        'setVoicePreset(id,revision) selects the preset used by the voice shortcut.',
      getVoicePreferences:
        'getVoicePreferences() returns saved speech settings across devices.',
      setVoicePreferences:
        'setVoicePreferences(prefs) updates the voice, speed, noiseScale, noiseW or sentenceSilence.',
    },
    turnView: spokenTurnView,
    guards: {
      createAssistantSession: M.callWhen().returns(M.remotable()),
      setVoicePreset: M.callWhen(M.string(), M.string()).returns(M.record()),
      getVoicePreferences: M.callWhen().returns(M.record()),
      setVoicePreferences: M.callWhen(M.record()).returns(M.record()),
    },
    methods: ({ presetCatalog, createFromPreset }) => ({
      createAssistantSession: async () =>
        createFromPreset(await presetCatalog.voice(), {
          spoken: true,
          userInitiated: true,
        }),
      setVoicePreset: (id, revision) => presetCatalog.selectVoice(id, revision),
      getVoicePreferences: preferences.get,
      setVoicePreferences: preferences.set,
    }),
  });
};
harden(make);
