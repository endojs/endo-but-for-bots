// @ts-check
/**
 * Texts and names of the preset editor (W5.8; R6-55, P-49).
 *
 * `presetTooLarge` and `presetTemplateNames` are browser copies of
 * `guest/lib/interfaces-m5-factory.js` values (the bundle cannot import
 * guest modules); `test/unit/m5-w58-copies.test.js` checks them equal. Every
 * other refusal the editor shows is the catalogue's own error message.
 */

/** Factory `texts.presetTooLarge`. */
export const presetTooLarge =
  'This preset is too large; shorten its instructions, description or labels, or remove objects';

/** `presetTemplateNames`, in order. */
export const presetTemplateNames = harden([
  'chat-only',
  'general',
  'development',
  'new-project',
]);

/** Network policies (`m5FactoryShapes.NetworkPolicyName`). */
export const networkPolicies = harden(['off', 'public-internet']);

export const presetTexts = harden({
  title: 'Assistant presets',
  loading: 'Loading presets…',
  builtIn: 'built-in',
  label: 'Name',
  description: 'Description',
  template: 'Template',
  backend: 'Provider',
  factoryDefault: 'Factory default',
  model: 'Model',
  effort: 'Reasoning effort',
  internet: 'Public internet',
  instructions: 'Additional instructions',
  objects: 'Default objects',
  templateObjects: 'Template objects',
  addObject: 'Add an object from the inventory…',
  removeObject: 'Remove',
  noObjects: 'No default objects',
  save: 'Save',
  saveAsNew: 'Save as new',
  delete: 'Delete',
  confirmDelete: 'Confirm delete',
  reset: 'Reset to built-in defaults',
  discard: 'Discard edits',
  reload: 'Reload',
  saved: 'Saved',
  created: 'Saved as a new preset',
  deleted: 'Preset deleted',
  resetDone: 'Reset to the built-in defaults',
  unavailable: 'Unavailable',
});
