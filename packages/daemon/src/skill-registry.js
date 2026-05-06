// @ts-check

/**
 * Skill registry helpers.
 *
 * A skill registry is an EndoDirectory whose entries are skill descriptors.
 * Each skill descriptor is itself an EndoDirectory containing well-known
 * named entries. Per the `endoclaw-skill-registry` design, this module adds
 * no new daemon abstractions: it just interprets the existing directory
 * structure as a skill index.
 *
 * Conventional descriptor entries (all optional except `code`):
 * - `code`: guest module reference (formula identifier)
 * - `description`: short human prose
 * - `version`: version string
 * - `author`: author or publisher string
 * - `homepage`: URL string
 * - `requires`: sub-directory enumerating capability requirements as
 *   pet-name keys with string values for scope hints
 *
 * The helpers `readSkillDescriptor`, `listSkills`, and `publishSkill`
 * compose existing directory operations (`list`, `lookup`, `makeDirectory`,
 * `writeText`) and return plain JS-shaped data so callers can present a
 * registry to a user without hand-rolling the same lookups everywhere.
 */

import harden from '@endo/harden';
import { E } from '@endo/far';
import { makeError, q, X } from '@endo/errors';

/**
 * Names of the well-known string-value entries on a skill descriptor
 * directory. Listed here so a single source of truth governs both the
 * publish path and the read path.
 */
export const skillMetadataNames = harden([
  'description',
  'version',
  'author',
  'homepage',
]);

/**
 * The pet name of the sub-directory enumerating capability requirements.
 */
export const skillRequiresName = 'requires';

/**
 * The pet name of the entry pointing at the installable guest module.
 */
export const skillCodeName = 'code';

/**
 * Read a string-valued entry from a directory, returning `undefined` if the
 * entry is absent.
 *
 * @param {any} directory - An EndoDirectory presence.
 * @param {string} name - The pet name to look up.
 * @returns {Promise<string | undefined>}
 */
const readOptionalText = async (directory, name) => {
  const present = await E(directory).has(name);
  if (!present) {
    return undefined;
  }
  return E(directory).readText(name);
};

/**
 * List the skill names published in a registry.
 *
 * @param {any} registry - An EndoDirectory presence acting as a skill
 *   registry.
 * @returns {Promise<Array<string>>}
 */
export const listSkills = async registry => {
  return E(registry).list();
};
harden(listSkills);

/**
 * @typedef {object} SkillDescriptor
 * @property {string} name - The pet name of the skill in the registry.
 * @property {string | undefined} description
 * @property {string | undefined} version
 * @property {string | undefined} author
 * @property {string | undefined} homepage
 * @property {Record<string, string>} requires - Pet-name to scope-hint
 *   mapping enumerated from the descriptor's `requires` sub-directory. An
 *   empty object means the descriptor has no `requires` directory or the
 *   directory is empty.
 * @property {boolean} hasCode - Whether the descriptor exposes a `code`
 *   entry. The presence is reported but the value is not resolved here;
 *   callers fetch it via `E(skillDescriptor).lookup('code')`.
 */

/**
 * Read the metadata fields of one skill descriptor.
 *
 * @param {any} registry - An EndoDirectory presence acting as a skill
 *   registry.
 * @param {string} name - The pet name of the skill to read.
 * @returns {Promise<SkillDescriptor>}
 */
export const readSkillDescriptor = async (registry, name) => {
  const present = await E(registry).has(name);
  if (!present) {
    throw makeError(X`No skill named ${q(name)} in registry`);
  }
  const descriptor = await E(registry).lookup(name);
  const [description, version, author, homepage, hasCode, hasRequires] =
    await Promise.all([
      readOptionalText(descriptor, 'description'),
      readOptionalText(descriptor, 'version'),
      readOptionalText(descriptor, 'author'),
      readOptionalText(descriptor, 'homepage'),
      E(descriptor).has(skillCodeName),
      E(descriptor).has(skillRequiresName),
    ]);

  /** @type {Record<string, string>} */
  const requires = {};
  if (hasRequires) {
    const requiresDir = await E(descriptor).lookup(skillRequiresName);
    const reqNames = await E(requiresDir).list();
    await Promise.all(
      reqNames.map(async reqName => {
        const scope = await readOptionalText(requiresDir, reqName);
        // Capability requirements that omit a scope hint surface as the
        // empty string rather than undefined; the requirement itself is
        // still asserted by virtue of the entry's existence.
        requires[reqName] = scope === undefined ? '' : scope;
      }),
    );
  }

  return harden({
    name,
    description,
    version,
    author,
    homepage,
    requires,
    hasCode,
  });
};
harden(readSkillDescriptor);

/**
 * @typedef {object} PublishSkillFields
 * @property {string} [description]
 * @property {string} [version]
 * @property {string} [author]
 * @property {string} [homepage]
 * @property {Record<string, string>} [requires] - Pet-name to scope-hint
 *   mapping; each entry becomes a string value in the descriptor's
 *   `requires` sub-directory.
 */

/**
 * Validate a publish-skill input record. Rejects unknown top-level keys so
 * a typo on `descrtiption` does not silently drop the field.
 *
 * @param {PublishSkillFields} fields
 */
const assertPublishFields = fields => {
  if (typeof fields !== 'object' || fields === null) {
    throw makeError(X`Skill fields must be a record, got ${q(fields)}`);
  }
  const knownKeys = new Set([...skillMetadataNames, skillRequiresName]);
  for (const key of Object.keys(fields)) {
    if (!knownKeys.has(key)) {
      throw makeError(X`Unknown skill field ${q(key)}`);
    }
  }
};

/**
 * Publish (or replace) a skill descriptor in a registry. Creates a sub-
 * directory at `registry/name`, writes the metadata text values, and
 * populates the `requires` sub-directory if any requirements are given.
 *
 * The `code` entry is intentionally not handled here; callers stage the
 * installable module separately and `storeIdentifier` it onto the
 * descriptor under the `code` pet name. This keeps the helper free of the
 * archive/eval/unconfined ceremony and avoids implying a particular module
 * source format.
 *
 * @param {any} registry - An EndoDirectory presence acting as a skill
 *   registry. The caller must have write authority.
 * @param {string} name - The pet name to publish under.
 * @param {PublishSkillFields} fields - Descriptor fields.
 * @returns {Promise<void>}
 */
export const publishSkill = async (registry, name, fields) => {
  assertPublishFields(fields);
  if (typeof name !== 'string' || name.length === 0) {
    throw makeError(X`Skill name must be a non-empty string, got ${q(name)}`);
  }

  // Replace any prior descriptor under the same name; publishing is
  // idempotent from the caller's perspective.
  const existing = await E(registry).has(name);
  if (existing) {
    await E(registry).remove(name);
  }

  const descriptor = await E(registry).makeDirectory(name);

  await Promise.all(
    skillMetadataNames.map(async fieldName => {
      const value = /** @type {Record<string, string | undefined>} */ (fields)[
        fieldName
      ];
      if (value === undefined) {
        return;
      }
      if (typeof value !== 'string') {
        throw makeError(
          X`Skill field ${q(fieldName)} must be a string, got ${q(value)}`,
        );
      }
      await E(descriptor).writeText(fieldName, value);
    }),
  );

  const requires = fields.requires;
  if (requires !== undefined) {
    if (typeof requires !== 'object' || requires === null) {
      throw makeError(
        X`Skill field 'requires' must be a record, got ${q(requires)}`,
      );
    }
    const requiresDir = await E(descriptor).makeDirectory(skillRequiresName);
    await Promise.all(
      Object.entries(requires).map(async ([reqName, scope]) => {
        if (typeof scope !== 'string') {
          throw makeError(
            X`Requirement scope ${q(reqName)} must be a string, got ${q(
              scope,
            )}`,
          );
        }
        await E(requiresDir).writeText(reqName, scope);
      }),
    );
  }
};
harden(publishSkill);
