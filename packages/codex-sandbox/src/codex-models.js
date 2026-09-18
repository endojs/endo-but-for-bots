// @ts-check
import { Fail } from '@endo/errors';
import { normalizeHostedModelDescriptor } from '@endo/hosted-agent';

/** @param {any} candidate */
export const normalizeCodexModelDescriptor = candidate => {
  (candidate && typeof candidate === 'object') ||
    Fail`Codex model descriptor must be a record`;
  Array.isArray(candidate.supportedReasoningEfforts) ||
    Fail`Codex model descriptor has invalid supported reasoning efforts`;
  const reasoningEfforts = candidate.supportedReasoningEfforts.map(entry => {
    (entry &&
      typeof entry === 'object' &&
      typeof entry.reasoningEffort === 'string') ||
      Fail`Codex model descriptor has invalid supported reasoning efforts`;
    return entry.reasoningEffort;
  });
  typeof candidate.isDefault === 'boolean' ||
    Fail`Codex model descriptor has invalid isDefault`;
  return normalizeHostedModelDescriptor({
    id: candidate.id,
    title: candidate.displayName,
    description: candidate.description || '',
    default: candidate.isDefault,
    defaultReasoningEffort: candidate.defaultReasoningEffort,
    reasoningEfforts,
  });
};
harden(normalizeCodexModelDescriptor);
